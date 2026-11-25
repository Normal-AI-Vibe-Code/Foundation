/**
 * Who is where (2026-11-21, Josh: "show when people are in the boards and collaborating, as well as the agents").
 * - A person on a grid is there once, however many windows, and is who their sync socket signed in as, whatever
 *   name a window claims.
 * - An agent at work on a grid is there with its name, colour and what it's doing; when it leaves, it's gone.
 * - A restricted grid's people and agents reach only the people who can see that grid.
 * - Windows are told when who is where changes, once it settles, and not again for a cursor that only moved.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";

const { run } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { attachConnection, closeBoards, getBoard } = await import("../src/boards.ts");
const { joinCrew, leaveCrew, _resetCrew } = await import("../src/crew.ts");
const { whereOn, whereaboutsFor, setWhereTeller, whereMayHaveChanged, WHERE_SETTLE_MS } = await import("../src/whereabouts.ts");
const Y = await import("yjs");
const awarenessProtocol = await import("y-protocols/awareness");
const encoding = await import("lib0/encoding");

after(() => {
  setWhereTeller(null);
  _resetCrew();
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = upsertUser("kai@formindustries.com", "Kai");

/** a sync socket as the server sees one */
class FakeSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  binaryType = "arraybuffer";
  send() {}
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

/** a window on a grid: its socket, signed in as `userId`, and the presence it sends (the name it claims, its colour) */
function openWindow(boardId: string, userId: string, name: string, color = "#e0564f", extra: Record<string, unknown> = {}) {
  const ws = new FakeSocket();
  attachConnection(boardId, ws as never, false, userId);
  const doc = new Y.Doc();
  const aw = new awarenessProtocol.Awareness(doc);
  aw.setLocalState({ user: { name, color }, cursor: null, focus: null, ...extra });
  const sendPresence = () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(aw, [doc.clientID]));
    ws.emit("message", encoding.toUint8Array(enc));
  };
  sendPresence();
  return {
    move(x: number) {
      aw.setLocalStateField("cursor", { x, y: 0 });
      sendPresence();
    },
    close() {
      ws.close();
      aw.destroy();
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a person with two windows on a grid is there once; nobody on it, it isn't listed", () => {
  const a1 = openWindow("wa1", ada.id, "Ada Lovelace");
  const a2 = openWindow("wa1", ada.id, "Ada Lovelace");
  const k = openWindow("wa1", kai.id, "Kai", "#3f8f6b");
  const w = whereOn("wa1");
  assert.deepEqual(w.people.map((p) => p.id), [ada.id, kai.id]);
  assert.equal(w.people.find((p) => p.id === kai.id)?.color, "#3f8f6b");
  assert.deepEqual(w.agents, []);
  getBoard("wa1-empty");
  assert.equal(whereaboutsFor(ada)["wa1-empty"], undefined);
  a1.close();
  assert.deepEqual(whereOn("wa1").people.map((p) => p.id), [ada.id, kai.id]);
  a2.close();
  k.close();
  assert.deepEqual(whereOn("wa1").people, []);
  assert.equal(whereaboutsFor(ada).wa1, undefined);
});

test("who a person is comes from their socket, not from the name their window claims", () => {
  const w = openWindow("wa2", ada.id, "Kai");
  const people = whereOn("wa2").people;
  assert.equal(people.length, 1);
  assert.equal(people[0].id, ada.id);
  assert.equal(people[0].name, ada.name, "and named as her account is");
  w.close();
});

test("an agent at work is on the grid with its name, colour and what it's doing; when it leaves it's gone", () => {
  const m = joinCrew({ boardId: "wa3", userId: ada.id, userName: ada.name, runId: "run_w", task: "lay out the parts" });
  const agents = whereOn("wa3").agents;
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, m.name);
  assert.equal(agents[0].status, "working");
  assert.equal(agents[0].askerName, ada.name);
  assert.equal(agents[0].via, "claude");
  assert.ok(agents[0].hue >= 0 && agents[0].hue < 6);
  assert.ok(whereaboutsFor(kai).wa3, "anyone who can see the grid sees the agent");
  leaveCrew(m, "done", 0);
  assert.deepEqual(whereOn("wa3").agents, []);
});

test("a person's window that claims to be an agent isn't listed as one", () => {
  const w = openWindow("wa6", kai.id, "Wren", "#6b5bd6", { crew: { id: "crew_fake", hue: 1, via: "claude", status: "working", doing: "nothing real" } });
  const here = whereOn("wa6");
  assert.deepEqual(here.agents, []);
  assert.deepEqual(here.people.map((p) => p.id), [kai.id]);
  w.close();
});

test("a restricted grid's people and agents reach only those who can see it", () => {
  run("insert into board_members (board_id, user_id, role, source, added_at) values (?, ?, 'owner', 'test', ?)", "wa4", ada.id, Date.now());
  const w = openWindow("wa4", ada.id, "Ada Lovelace");
  const m = joinCrew({ boardId: "wa4", userId: ada.id, userName: ada.name, runId: "run_r", task: "secret" });
  assert.ok(whereaboutsFor(ada).wa4, "a member sees it");
  assert.equal(whereaboutsFor(kai).wa4, undefined, "someone outside it doesn't");
  leaveCrew(m, "done", 0);
  w.close();
});

test("windows are told when who is where changes, once it settles, and not for a cursor that only moved", async () => {
  const told: Array<Record<string, unknown>> = [];
  setWhereTeller((forUser) => told.push(forUser(kai)));
  const w = openWindow("wa5", ada.id, "Ada Lovelace");
  whereMayHaveChanged();
  await wait(WHERE_SETTLE_MS + 150);
  assert.equal(told.length, 1);
  assert.deepEqual((told[0].wa5 as { people: Array<{ id: string }> }).people.map((p) => p.id), [ada.id]);
  // the cursor moves: the same people on the same grids, nobody is told
  w.move(10);
  w.move(20);
  await wait(WHERE_SETTLE_MS + 150);
  assert.equal(told.length, 1);
  // she leaves: told again, and the grid is no longer listed
  w.close();
  await wait(WHERE_SETTLE_MS + 150);
  assert.equal(told.length, 2);
  assert.equal(told[1].wa5, undefined);
  setWhereTeller(null);
});

/**
 * The activity log says who really did what.
 * - A person's tool call (the HTTP door, from their browser) is theirs: role
 *   human, no agent ring. A bearer token at the same door is an agent acting
 *   for that person ("Ada's agent"), and a crew agent signs with its name and
 *   says whom it works for.
 * - A person's own grid edits (sections and cards added, removed, renamed,
 *   moved) are logged under their name, from their sync socket, coalesced: a
 *   drag of many frames or a name typed letter by letter is one line, a
 *   repeat replaces the line before it, add-then-remove is nothing, and many
 *   changes at once are one summary line. Typing in notes and cells, and the
 *   server's own writes, aren't logged as the person. The log stays bounded.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-activity-"));
process.env.FOUNDATION_ADMIN_EMAILS = "";
process.env.FOUNDATION_GRIDLOG_MS = "20";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";

const { upsertUser, createSession, isPerson } = await import("../src/auth.ts");
const { runTool, httpToolCtx } = await import("../src/tools.ts");
const { joinCrew, leaveCrew } = await import("../src/crew.ts");
const { attachConnection, getBoard, editBoard, closeBoards } = await import("../src/boards.ts");
const { startGridLog, flushGridLog } = await import("../src/gridlog.ts");
const { boardMaps, appendSection, setNoteText, setTableCells, uid } = await import("@foundation/protocol");
type ObjectDoc = import("@foundation/protocol").ObjectDoc;

startGridLog();
after(() => closeBoards());

const ada = upsertUser("ada@formindustries.com", "Ada");
const kai = upsertUser("kai@formindustries.com", "Kai");
const fakeReq = (headers: Record<string, string>) => ({ headers, query: new URLSearchParams() }) as never;
const acts = (board: string) => boardMaps(getBoard(board).doc).activity.toArray();
const last = (board: string) => acts(board).at(-1)!;

test("the HTTP door: a person's browser is the person; a bearer is their agent; a crew agent signs its name", async () => {
  const token = createSession(ada.id);
  assert.equal(isPerson(fakeReq({ cookie: `foundation_session=${token}` })), true);
  assert.equal(isPerson(fakeReq({ authorization: `Bearer ${token}` })), false);
  assert.equal(isPerson(fakeReq({ authorization: `Bearer ${token}`, cookie: `foundation_session=${token}` })), false);
  // the desktop app (a page on another origin) signs in for an app bearer: that is the person too,
  // while an agent's bearer stays an agent (feat/ws-ticket's session kinds meet this door here)
  assert.equal(isPerson(fakeReq({ authorization: `Bearer ${createSession(ada.id, undefined, "app")}` })), true);
  assert.equal(isPerson(fakeReq({ authorization: `Bearer ${createSession(ada.id, undefined, "agent")}` })), false);

  const board = getBoard("h1");
  await runTool(httpToolCtx("h1", ada, true), "add_section", { name: "By hand" });
  assert.deepEqual(
    (({ who, role, text }) => ({ who, role, text }))(last("h1")),
    { who: "Ada", role: "human", text: "added section “By hand”" },
  );
  assert.equal(last("h1").for, undefined);
  assert.equal(board.awareness.getLocalState(), null, "a person's call puts up no agent ring");

  await runTool(httpToolCtx("h1", ada, false), "add_note", { section: "By hand", title: "From a script", markdown: "hi" });
  assert.equal(last("h1").who, "Ada's agent");
  assert.equal(last("h1").role, "agent");
  assert.equal(last("h1").for, "Ada");
  assert.equal((board.awareness.getLocalState() as { user: { agent: boolean } }).user.agent, true);

  const m = joinCrew({ boardId: "h1", userId: kai.id, userName: "Kai", runId: "run_h1", task: "x" });
  await runTool({ boardId: "h1", actor: m.name, userId: kai.id, crew: m.id }, "add_note", { section: "By hand", title: "From the crew", markdown: "hi" });
  assert.deepEqual([last("h1").who, last("h1").role, last("h1").for], [m.name, "agent", "Kai"]);
  leaveCrew(m, "done", 0);
});

/** a person's browser on a board: edits made to its own copy reach the server over its sync socket */
function personOn(boardId: string, userId: string) {
  const server = getBoard(boardId).doc;
  const ws = Object.assign(new EventEmitter(), { readyState: 1, binaryType: "", send() {}, close() {} });
  attachConnection(boardId, ws as never, false, userId);
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
  const edit = (fn: (d: Y.Doc) => void) => {
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server, Y.encodeStateVector(local)));
    const sv = Y.encodeStateVector(server);
    local.transact(() => fn(local));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(local, sv));
    ws.emit("message", Buffer.from(encoding.toUint8Array(enc)));
  };
  const obj = (id: string) => boardMaps(local).objects.get(id)!;
  const put = (o: ObjectDoc) => edit((d) => boardMaps(d).objects.set(o.id, o));
  return { edit, obj, put, local };
}

function note(sectionId: string, name: string): ObjectDoc {
  return { id: uid("note"), kind: "note", sectionId, name, x: 0, y: 0, float: false, bornAt: Date.now(), w: 320, h: 200 } as ObjectDoc;
}

test("a person's grid edits are logged as theirs, one line per thing, not per frame or keystroke", () => {
  const B = "g1";
  const ada1 = personOn(B, ada.id);
  let secId = "";
  let noteId = "";
  // a section and a note in it, then the note's name typed letter by letter
  ada1.edit((d) => (secId = appendSection(d, "Supply").id));
  const n = note(secId, "P");
  noteId = n.id;
  ada1.put(n);
  for (const name of ["Pl", "Pla", "Plan"]) ada1.put({ ...ada1.obj(noteId), name });
  flushGridLog();
  const mine = acts(B).filter((a) => a.who === "Ada");
  assert.deepEqual(mine.map((a) => [a.role, a.text]), [
    ["human", "added a section “Supply”"],
    ["human", "added a note “Plan” in “Supply”"],
  ]);
  assert.equal(mine[1].objectId, noteId);

  // a drag of sixty frames is one line; dragging it again soon after replaces that line
  const before = acts(B).length;
  for (let i = 1; i <= 60; i++) ada1.put({ ...ada1.obj(noteId), x: i * 3, y: i, float: true });
  flushGridLog();
  for (let i = 1; i <= 30; i++) ada1.put({ ...ada1.obj(noteId), x: 200 - i, y: 60 + i });
  flushGridLog();
  assert.equal(acts(B).length, before + 1);
  assert.equal(last(B).text, "moved the note “Plan” in “Supply”");

  // renamed twice, a pause between: one line from the first name to the last
  ada1.put({ ...ada1.obj(noteId), name: "Plan B" });
  flushGridLog();
  ada1.put({ ...ada1.obj(noteId), name: "Plan C" });
  flushGridLog();
  assert.equal(last(B).text, "renamed the note “Plan” to “Plan C”");
  assert.equal(acts(B).length, before + 2);

  // moved to another section
  let ops = "";
  ada1.edit((d) => (ops = appendSection(d, "Ops").id));
  flushGridLog();
  ada1.put({ ...ada1.obj(noteId), sectionId: ops });
  flushGridLog();
  assert.equal(last(B).text, "moved the note “Plan C” to “Ops”");
});

test("what isn't logged as a person: typing, cells, make-and-unmake, the server's and agents' writes", async () => {
  const B = "g2";
  const ada1 = personOn(B, ada.id);
  let secId = "";
  ada1.edit((d) => (secId = appendSection(d, "Main").id));
  const n = note(secId, "Notes");
  ada1.put(n);
  flushGridLog();
  const before = acts(B).length;
  // typing in the note and in a table's cells
  ada1.edit((d) => setNoteText(d, n.id, "hello there"));
  const t = { id: uid("tbl"), kind: "table", sectionId: secId, name: "T", x: 0, y: 0, float: false, bornAt: Date.now(), cols: 3, rows: 3 } as ObjectDoc;
  // made and removed before the pause: nothing happened
  ada1.put(t);
  ada1.edit((d) => setTableCells(d, t.id, { "0,0": "1" }));
  ada1.edit((d) => boardMaps(d).objects.delete(t.id));
  // a resize isn't a move
  ada1.put({ ...ada1.obj(n.id), w: 500, h: 400 } as ObjectDoc);
  // the server's own write (an agent's tool, a machine's state) doesn't count as Ada's
  editBoard(B, "agent", (d) => boardMaps(d).objects.set("x1", { ...n, id: "x1", name: "server's" }));
  flushGridLog();
  assert.equal(acts(B).length, before, JSON.stringify(acts(B).slice(before)));
  // and an agent's tool call is the agent's
  await runTool(httpToolCtx(B, ada, false), "rename_section", { section: "Main", name: "Main board" });
  flushGridLog();
  assert.deepEqual(acts(B).slice(before).map((a) => a.who), ["Ada's agent"]);
});

test("many changes at once are one line; two people are two lines; the log stays bounded", () => {
  const B = "g3";
  const ada1 = personOn(B, ada.id);
  const kai1 = personOn(B, kai.id);
  let secId = "";
  ada1.edit((d) => (secId = appendSection(d, "Wall").id));
  flushGridLog();
  const before = acts(B).length;
  // six cards pasted in
  ada1.edit((d) => {
    for (let i = 0; i < 6; i++) boardMaps(d).objects.set(`n${i}`, { ...note(secId, `Card ${i}`), id: `n${i}` });
  });
  kai1.edit((d) => appendSection(d, "Kai's"));
  flushGridLog();
  const fresh = acts(B).slice(before);
  assert.deepEqual(fresh.map((a) => [a.who, a.text]).sort(), [
    ["Ada", "added 6 cards in “Wall”"],
    ["Kai", "added a section “Kai's”"],
  ]);
  // a thousand separate moves of different cards stay under the cap
  for (let i = 0; i < 300; i++) {
    const id = `n${i % 6}`;
    ada1.put({ ...ada1.obj(id), x: i });
    if (i % 2) kai1.edit((d) => boardMaps(d).sections.set(secId, { ...boardMaps(d).sections.get(secId)!, name: `Wall ${i}` }));
    flushGridLog();
  }
  assert.ok(acts(B).length <= 400, `bounded: ${acts(B).length}`);
});

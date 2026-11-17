/**
 * Carrying a card to another board (2026-11-10, Josh: "dragging should not
 * only be able to be dragged to other boards but it should create new
 * sections to be dropped in"). A person drops a card on another space's tab;
 * the server moves it in one step (send_to_board): it lands in a section named
 * for where it came from, with its note text, table cells and file, and the
 * board it left lets it go (and its wires). Writes name their board, are
 * idempotent by request_id, and a viewer of the other board can't send there.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";

const { one } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { runTool } = await import("../src/tools.ts");
const { createBoardRow, editBoard, getBoard, closeBoards } = await import("../src/boards.ts");
const { storeFile } = await import("../src/files.ts");
const { appendSection, boardMaps, noteTextOf, putNote, tableCellMap, setTableCells, tableCellsOf } = await import("@foundation/protocol");

after(() => closeBoards());

const boss = upsertUser("boss@formindustries.com", "Boss");
const ada = upsertUser("ada@formindustries.com", "Ada");
const from = createBoardRow("Design");
const to = createBoardRow("Studio");
const page = createBoardRow("Docs", { kind: "page", url: "https://example.com" });
const ctx = (boardId: string, userId = ada.id) => ({ boardId, actor: "Ada", userId, person: true });

const sec = editBoard(from, "test", (doc) => appendSection(doc, "Ideas"));
editBoard(from, "test", (doc) => {
  putNote(doc, { id: "note_c1", kind: "note", sectionId: sec.id, name: "Brief", x: 0, y: 0, float: false, bornAt: 1, w: 400, h: 300, text: "# Brief\n\nCarry me." });
  const m = boardMaps(doc);
  m.objects.set("tbl_c1", { id: "tbl_c1", kind: "table", sectionId: sec.id, name: "Parts", x: 0, y: 0, float: false, bornAt: 2, cols: 3, rows: 4 });
  tableCellMap(doc, "tbl_c1");
  setTableCells(doc, "tbl_c1", { "0,0": "Bolt", "1,0": "=2*3" });
  m.objects.set("pnl_a", { id: "pnl_a", kind: "panel", panel: "app", sectionId: sec.id, name: "App", x: 0, y: 0, float: false, bornAt: 3, w: 400, h: 300, ports: [] });
  m.links.set("lnk_1", { id: "lnk_1", from: { panel: "pnl_a", port: "o" }, to: { panel: "note_c1", port: "i" } } as never);
});

test("a note goes to the other board with its words, into a section named for where it came from", async () => {
  const out = (await runTool(ctx(from), "send_to_board", { id: "note_c1", to_board: to, request_id: "r1" })) as { section: string };
  assert.equal(out.section, "From Design");
  const there = getBoard(to).doc;
  const card = boardMaps(there).objects.get("note_c1")!;
  assert.equal(boardMaps(there).sections.get(card.sectionId)?.name, "From Design");
  assert.equal(noteTextOf(there, card), "# Brief\n\nCarry me.");
  const here = boardMaps(getBoard(from).doc);
  assert.equal(here.objects.get("note_c1"), undefined, "the board it left lets it go");
  assert.equal(here.noteText.get("note_c1"), undefined);
  assert.equal(here.links.get("lnk_1"), undefined, "its wires go with it");
  // asked again with the same request_id: the same answer, nothing done twice
  const again = await runTool(ctx(from), "send_to_board", { id: "note_c1", to_board: to, request_id: "r1" });
  assert.deepEqual(again, out);
});

test("a table takes its cells, and a second card joins the same section", async () => {
  await runTool(ctx(from), "send_to_board", { id: "tbl_c1", to_board: to });
  const there = getBoard(to).doc;
  assert.deepEqual(tableCellsOf(there, "tbl_c1"), { "0,0": "Bolt", "1,0": "=2*3" });
  const secs = [...boardMaps(there).sections.values()].filter((s) => s.name === "From Design");
  assert.equal(secs.length, 1);
  assert.equal(boardMaps(there).objects.get("tbl_c1")!.sectionId, secs[0].id);
  assert.equal(boardMaps(getBoard(from).doc).cells.get("tbl_c1"), undefined);
});

test("an image's file is the other board's too (same bytes, its own record), and the first stays", async () => {
  const f = await storeFile(Buffer.from("not really a png"), { name: "mark.png", mime: "image/png", boardId: from, userId: ada.id });
  editBoard(from, "test", (doc) =>
    boardMaps(doc).objects.set("media_c1", { id: "media_c1", kind: "media", sectionId: sec.id, name: "mark.png", x: 0, y: 0, float: false, bornAt: 4, w: 200, h: 100, src: `/files/${f.id}`, media: "image", autoplay: false, muted: true, invert: true }),
  );
  await runTool(ctx(from), "send_to_board", { id: "media_c1", to_board: to });
  const card = boardMaps(getBoard(to).doc).objects.get("media_c1") as { src: string; invert?: boolean };
  const id = card.src.replace("/files/", "");
  assert.notEqual(id, f.id);
  const row = one<{ board_id: string; sha256: string }>("select board_id, sha256 from files where id = ?", id)!;
  assert.equal(row.board_id, to);
  assert.equal(row.sha256, f.sha256);
  assert.equal(card.invert, true, "how it's shown goes with it");
  assert.ok(one("select id from files where id = ? and archived_at is null", f.id), "the source's file is never removed");
});

test("refused: a viewer of the other board, a board that isn't a grid, a machine, and the same board", async () => {
  editBoard(from, "test", (doc) => {
    boardMaps(doc).objects.set("pnl_m", { id: "pnl_m", kind: "panel", panel: "machine", sectionId: sec.id, name: "Box", x: 0, y: 0, float: false, bornAt: 5, w: 760, h: 520, ports: [], machine: { name: "box", state: "absent" } } as never);
  });
  setBoardRole(boss, to, ada.id, "viewer");
  await assert.rejects(runTool(ctx(from), "send_to_board", { id: "pnl_a", to_board: to }), /View only/);
  setBoardRole(boss, to, ada.id, null);
  await assert.rejects(runTool(ctx(from), "send_to_board", { id: "pnl_a", to_board: page }), /isn't a grid/);
  await assert.rejects(runTool(ctx(from), "send_to_board", { id: "pnl_m", to_board: to }), /stays on the board/);
  await assert.rejects(runTool(ctx(from), "send_to_board", { id: "pnl_a", to_board: from }), /already on this board/);
  await assert.rejects(runTool(ctx(from), "send_to_board", { id: "pnl_a", to_board: "nowhere" }), /no such board/);
  assert.ok(boardMaps(getBoard(from).doc).objects.get("pnl_a"), "a refused card stays where it was");
});

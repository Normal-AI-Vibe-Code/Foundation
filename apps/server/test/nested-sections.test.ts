/**
 * Sections are grids within themselves (2026-11-11): a section with a parent
 * sits in that section's own grid. Agents see the nesting in read_board; a
 * card they add to a section that holds sections goes to its first section
 * (it would be hidden otherwise); a section they add goes on the board's own
 * grid, whose tracks don't count the nested ones.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { createBoardRow, editBoard, getBoard, closeBoards } = await import("../src/boards.ts");
const { boardMaps, describeBoard, leafSectionOf, readTracks } = await import("@foundation/protocol");

after(() => closeBoards());

const ada = upsertUser("ada@formindustries.com", "Ada");
const board = createBoardRow("Nest");
const ctx = { boardId: board, actor: "Ada", userId: ada.id, person: true };

editBoard(board, "test", (doc) => {
  const m = boardMaps(doc);
  m.grid.set("tracks", { cols: [1560], rows: [1160] });
  m.sections.set("design", { id: "design", name: "Design", c0: 0, r0: 0, c1: 0, r1: 0, grid: { cols: [780, 780], rows: [1160] } });
  m.sections.set("sketch", { id: "sketch", name: "Sketches", c0: 1, r0: 0, c1: 1, r1: 0, parent: "design" });
  m.sections.set("brief", { id: "brief", name: "Brief", c0: 0, r0: 0, c1: 0, r1: 0, parent: "design" });
});

test("a card for a section that holds sections goes to its first one (top-left)", async () => {
  const out = (await runTool(ctx, "add_note", { section: "Design", title: "Plan", markdown: "# Plan" })) as { id: string };
  const doc = getBoard(board).doc;
  assert.equal(boardMaps(doc).objects.get(out.id)!.sectionId, "brief");
  assert.equal(leafSectionOf(doc, boardMaps(doc).sections.get("design")!).id, "brief");
});

test("read_board says where each section sits and which hold sections", () => {
  const text = describeBoard(getBoard(board).doc);
  assert.match(text, /## Section "Design" \(design\) — a grid of 2 sections/);
  assert.match(text, /## Section "Sketches" \(sketch\) — inside "Design"/);
});

test("a section an agent adds goes on the board's grid, beside the top-level ones only", async () => {
  await runTool(ctx, "add_section", { name: "Review" });
  const doc = getBoard(board).doc;
  const review = [...boardMaps(doc).sections.values()].find((s) => s.name === "Review")!;
  assert.equal(review.parent, undefined);
  assert.equal(review.c0, 1, "the next column of the board's own grid (the nested sections don't count)");
  assert.equal(readTracks(doc).cols.length, 2);
});

/**
 * Spaces: a board's row says what its canvas is (a grid, a deck, a web page)
 * and which project folder it sits in. Making one never lands on a space that
 * exists; a page space only takes an http(s) address; folders are cleaned.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { cleanFolder, cleanPageUrl, createBoardRow, ensureBoardRow, listBoards, updateBoardRow, closeBoards } = await import("../src/boards.ts");

after(() => closeBoards());

test("a new space never takes the id of one that exists", () => {
  const a = createBoardRow("Untitled grid");
  const b = createBoardRow("Untitled grid");
  const c = createBoardRow("Untitled grid");
  assert.equal(a, "untitled-grid");
  assert.equal(b, "untitled-grid-2");
  assert.equal(c, "untitled-grid-3");
  assert.equal(listBoards().filter((x) => x.name === "Untitled grid").length, 3);
});

test("kind, folder and address are kept; a row from before spaces reads as a loose grid", () => {
  ensureBoardRow("old", "Old board");
  const page = createBoardRow("Docs", { kind: "page", url: "https://example.com/", folder: "Fans/Rim drive" });
  const deck = createBoardRow("Review", { kind: "deck" });
  const rows = new Map(listBoards().map((b) => [b.id, b]));
  assert.deepEqual({ kind: rows.get("old")!.kind, folder: rows.get("old")!.folder, url: rows.get("old")!.url }, { kind: "grid", folder: null, url: null });
  assert.deepEqual({ kind: rows.get(page)!.kind, folder: rows.get(page)!.folder, url: rows.get(page)!.url }, { kind: "page", folder: "Fans/Rim drive", url: "https://example.com/" });
  assert.equal(rows.get(deck)!.kind, "deck");
});

test("rename and move: only what was asked changes", () => {
  const id = createBoardRow("Draft", { folder: "Fans" });
  updateBoardRow(id, { name: "Rim drive fan" });
  let row = listBoards().find((b) => b.id === id)!;
  assert.deepEqual([row.name, row.folder], ["Rim drive fan", "Fans"]);
  updateBoardRow(id, { folder: null });
  row = listBoards().find((b) => b.id === id)!;
  assert.deepEqual([row.name, row.folder], ["Rim drive fan", null]);
});

test("folders are trimmed, at most four deep; nothing is no folder", () => {
  assert.equal(cleanFolder("  Fans / Rim drive /"), "Fans/Rim drive");
  assert.equal(cleanFolder("a/b/c/d/e/f"), "a/b/c/d");
  assert.equal(cleanFolder(" / "), null);
  assert.equal(cleanFolder(undefined), null);
});

test("a page's address is http or https, nothing else", () => {
  assert.equal(cleanPageUrl("example.com/app"), "https://example.com/app");
  assert.equal(cleanPageUrl("http://localhost:3001"), "http://localhost:3001/");
  assert.equal(cleanPageUrl("javascript://alert(1)"), null);
  assert.equal(cleanPageUrl("file:///etc/passwd"), null);
  assert.equal(cleanPageUrl(""), null);
});

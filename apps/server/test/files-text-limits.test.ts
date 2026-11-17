/**
 * The cap on reading a document: one that takes too long is stopped (its
 * worker ended), marked failed, still found by its name, and the queue goes
 * on to the next. A 1 ms limit makes every document "too long".
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_EXTRACT_MS = "1";

const { one } = await import("../src/db.ts");
const { storeFile } = await import("../src/files.ts");
const { fileTextIdle } = await import("../src/filetext.ts");
const { searchLocal } = await import("../src/search.ts");
const { closeBoards } = await import("../src/boards.ts");

after(() => closeBoards());

const fixture = (name: string) => readFileSync(new URL(`./fixtures/docs/${name}`, import.meta.url));

test("a document that takes too long is stopped, found by name, and the next one still runs", async () => {
  const a = await storeFile(fixture("spec.pdf"), { name: "slow-spec.pdf", mime: "application/pdf", boardId: "lim", userId: "u" });
  const b = await storeFile(fixture("deck.pptx"), { name: "slow-deck.pptx", mime: "", boardId: "lim", userId: "u" });
  await fileTextIdle();
  for (const f of [a, b]) {
    const row = one<{ status: string; error: string }>("select status, error from file_text where sha256 = ?", f.sha256);
    assert.equal(row?.status, "failed");
    assert.match(row?.error ?? "", /took longer than/);
  }
  assert.ok(searchLocal("slow", "lim").some((h) => h.id === `file:${a.id}`));
  assert.ok(searchLocal("slow", "lim").some((h) => h.id === `file:${b.id}`));
  assert.equal(searchLocal("osterlund", "lim").length, 0);
});

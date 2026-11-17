/**
 * The plan board (docs/plan.json) stays sound: every card in a real column and
 * milestone, ids unique, and the board the Settings page draws holds every card once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain .mjs script with no types
import { checkPlan, readPlan } from "../../../scripts/plan.mjs";
import { ago, boardColumns, PLAN, syncSentence, waitingWords } from "../src/settings/plan";

test("docs/plan.json is sound", () => {
  assert.deepEqual(checkPlan(readPlan()), []);
});

test("the board shows every card once, in its column", () => {
  const cols = boardColumns(PLAN, {});
  const shown = cols.flatMap((c) => c.cards.map((card) => card.id));
  assert.equal(shown.length, PLAN.cards.length);
  assert.equal(new Set(shown).size, shown.length);
  for (const col of cols) for (const card of col.cards) assert.equal(card.status, col.id);
});

test("filters narrow by kind and milestone", () => {
  const bugs = boardColumns(PLAN, { kind: "bug" }).flatMap((c) => c.cards);
  assert.ok(bugs.length > 0 && bugs.every((c) => c.kind === "bug"));
  const crew = boardColumns(PLAN, { milestone: "crew" }).flatMap((c) => c.cards);
  assert.ok(crew.length > 0 && crew.every((c) => c.milestone === "crew"));
});

test("the board says when it synced and what's waiting, in plain words", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(ago("2026-11-09T11:59:40Z", now), "just now");
  assert.equal(ago("2026-11-09T11:56:00Z", now), "4 min ago");
  assert.equal(ago("2026-11-09T09:00:00Z", now), "3 h ago");
  assert.equal(ago("2026-11-08T00:00:00Z", now), "2 days ago");
  assert.equal(ago("2026-11-08T12:00:00Z", now), "24 h ago");
  assert.equal(syncSentence({ moved: 0, created: 0 }), "Synced: GitHub and this board agree.");
  assert.equal(syncSentence({ moved: 1, created: 2 }), "Synced: 1 move sent, 2 new cards are issues.");
  assert.equal(syncSentence({ moved: 2, created: 1 }), "Synced: 2 moves sent, 1 new card is an issue.");
  assert.equal(waitingWords(2, 0), "2 moved here");
  assert.equal(waitingWords(1, 3), "1 moved and 3 new here");
});

test("an issue filed with the GitHub form brings its area", async () => {
  // @ts-expect-error a plain .mjs script with no types
  const { formArea } = await import("../../../scripts/plan.mjs");
  assert.equal(formArea("### What happened\n\nWires jump.\n\n### Area\n\nWires\n"), "wires");
  assert.equal(formArea("### Area\r\n\r\nCrew Sheet\r\n"), "crew-sheet");
  assert.equal(formArea("### Area\n\n_No response_\n"), undefined);
  assert.equal(formArea("no form here"), undefined);
});

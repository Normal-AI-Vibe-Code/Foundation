/**
 * A council's silhouettes (2026-11-21, Josh: "the silhouettes should be closer to each other until an agent is added,
 * and then there should only be one silhouette to add new agents").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNCIL_PLACES, ghostCount } from "../src/characters/places.ts";

test("nobody on it: three silhouettes", () => {
  assert.equal(COUNCIL_PLACES, 3);
  assert.equal(ghostCount(0, true), 3);
});

test("from the first agent on, one silhouette to add another, however many there are", () => {
  for (const n of [1, 2, 3, 4, 9]) assert.equal(ghostCount(n, true), 1);
});

test("a viewer can't add an agent: no silhouettes", () => {
  assert.equal(ghostCount(0, false), 0);
  assert.equal(ghostCount(2, false), 0);
});

/**
 * A section that moves away leaves a hole; the neighbours that line up grow
 * into it (store.fillHole), rather than leave a void of empty cells.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fillHole, type Section } from "../src/state/store";

const sec = (id: string, c0: number, r0: number, c1 = c0, r1 = r0): Section => ({ id, name: id, c0, r0, c1, r1 });
const board = (...list: Section[]) => Object.fromEntries(list.map((s) => [s.id, s]));

test("one aligned neighbour takes the hole", () => {
  const s = board(sec("A", 0, 0), sec("B", 1, 0));
  assert.equal(fillHole(s, { c0: 2, c1: 2, r0: 0, r1: 0 }), true);
  assert.deepEqual([s.B.c0, s.B.c1], [1, 2]);
});

test("several neighbours that together cover a side grow in together", () => {
  // hole: columns 2–3, rows 0–2; on its left, D covers rows 0–1 and F covers row 2
  const s = board(sec("D", 1, 0, 1, 1), sec("F", 0, 2, 1, 2), sec("X", 2, 3, 3, 3), sec("Y", 4, 0));
  assert.equal(fillHole(s, { c0: 2, c1: 3, r0: 0, r1: 2 }), true);
  // below (X alone, one section) is tidier than the left (two): X grows up
  assert.deepEqual([s.X.r0, s.X.r1], [0, 3]);
});

test("the side needing fewest sections wins; a side that doesn't line up is never used", () => {
  const s = board(sec("L1", 0, 0), sec("L2", 0, 1), sec("R", 2, 0, 3, 0));
  // hole column 1, rows 0–1: the left is L1+L2 (lines up); the right (R spans only row 0, and wider) doesn't
  assert.equal(fillHole(s, { c0: 1, c1: 1, r0: 0, r1: 1 }), true);
  assert.deepEqual([s.L1.c1, s.L2.c1, s.R.c0], [1, 1, 2]);
});

test("nothing lines up: the hole stays", () => {
  const s = board(sec("A", 0, 0, 1, 0), sec("B", 3, 2)); // A only half covers the top; B is below-right, touching nothing
  assert.equal(fillHole(s, { c0: 1, c1: 2, r0: 1, r1: 1 }), false);
});

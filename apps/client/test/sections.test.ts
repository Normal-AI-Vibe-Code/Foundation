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

// ---------- the grab areas along the track boundaries (lib/gridLines.ts) ----------
import { gutterRuns, gutterSegments } from "../src/lib/gridLines";

test("a boundary's grab area is one stretch per pair of neighbours: a section's edge, top to bottom, and no further", () => {
  // three rows, two columns: A over B on the left, one tall C on the right; row 2 is one section D across both
  const grid = { cols: [500, 500], rows: [400, 400, 400] };
  const sections = [
    { c0: 0, c1: 0, r0: 0, r1: 0 }, // A
    { c0: 0, c1: 0, r0: 1, r1: 1 }, // B
    { c0: 1, c1: 1, r0: 0, r1: 1 }, // C
    { c0: 0, c1: 1, r0: 2, r1: 2 }, // D
  ];
  // the line itself runs as far as it divides sections: rows 0–1, then inside D
  assert.deepEqual(
    gutterRuns(grid, sections).filter((g) => g.axis === "col").map((g) => [g.from, g.to, g.interior]),
    [[0, 1, false], [2, 2, true]],
  );
  // what lights under the pointer: A|C, then B|C, then the stretch inside D
  assert.deepEqual(
    gutterSegments(grid, sections).filter((g) => g.axis === "col").map((g) => [g.from, g.to, g.interior]),
    [[0, 0, false], [1, 1, false], [2, 2, true]],
  );
  // a section spanning two tracks keeps one stretch along its whole edge
  const rows = gutterSegments(grid, sections).filter((g) => g.axis === "row" && g.index === 1);
  assert.deepEqual(rows.map((g) => [g.from, g.to]), [[0, 0], [1, 1]]);
  const tall = [{ c0: 0, c1: 0, r0: 0, r1: 2 }, { c0: 1, c1: 1, r0: 0, r1: 2 }];
  assert.deepEqual(gutterSegments(grid, tall).filter((g) => g.axis === "col").map((g) => [g.from, g.to]), [[0, 2]]);
});

test("a boundary inside merged sections is cut where the section changes", () => {
  const grid = { cols: [500, 500], rows: [400, 400] };
  const sections = [{ c0: 0, c1: 1, r0: 0, r1: 0 }, { c0: 0, c1: 1, r0: 1, r1: 1 }];
  assert.deepEqual(gutterRuns(grid, sections).filter((g) => g.axis === "col").map((g) => [g.from, g.to, g.interior]), [[0, 1, true]]);
  assert.deepEqual(gutterSegments(grid, sections).filter((g) => g.axis === "col").map((g) => [g.from, g.to, g.interior]), [[0, 0, true], [1, 1, true]]);
});

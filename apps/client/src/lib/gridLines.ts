/**
 * The grid's own lines and labels, shared by both renderers (the web grid in
 * components/GridViewport.tsx and the Rune scene in rune/scene.ts).
 */

/** a column's spreadsheet name: A, B … Z, AA … */
export function colName(col: number): string {
  let s = "";
  let n = col;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export interface GutterRun {
  axis: "col" | "row";
  index: number;
  from: number;
  to: number;
  interior: boolean;
}

/**
 * Each track boundary split into runs: where it divides two sections (or
 * empty cells) it is a real edge; where one merged section spans across it,
 * it is interior.
 */
export function gutterRuns(grid: { cols: number[]; rows: number[] }, sections: Array<{ c0: number; c1: number; r0: number; r1: number }>): GutterRun[] {
  const out: GutterRun[] = [];
  for (const axis of ["col", "row"] as const) {
    const bounds = (axis === "col" ? grid.cols : grid.rows).length - 1;
    const along = (axis === "col" ? grid.rows : grid.cols).length;
    for (let i = 0; i < bounds; i++) {
      let run: GutterRun | null = null;
      for (let k = 0; k < along; k++) {
        const interior = sections.some((s) =>
          axis === "col" ? s.c0 <= i && s.c1 >= i + 1 && s.r0 <= k && k <= s.r1 : s.r0 <= i && s.r1 >= i + 1 && s.c0 <= k && k <= s.c1,
        );
        if (run && run.interior === interior) run.to = k;
        else {
          run = { axis, index: i, from: k, to: k, interior };
          out.push(run);
        }
      }
    }
  }
  return out;
}

/**
 * The grab areas along the track boundaries: `gutterRuns`, with each real edge cut again wherever the
 * sections on either side of it change (2026-11-18, Josh: "it should just highlight the current grid size
 * that has been expanded to"). A boundary's line still runs as far as it divides sections, but what lights
 * under the pointer, and what the knob rides along, is the stretch between one pair of neighbours: from the
 * top of that section's edge to the bottom of it, and no further. A boundary running inside merged sections
 * is cut the same way, one stretch per section it crosses.
 */
export function gutterSegments(grid: { cols: number[]; rows: number[] }, sections: Array<{ c0: number; c1: number; r0: number; r1: number }>): GutterRun[] {
  const at = (c: number, r: number) => sections.findIndex((s) => s.c0 <= c && c <= s.c1 && s.r0 <= r && r <= s.r1);
  const out: GutterRun[] = [];
  for (const run of gutterRuns(grid, sections)) {
    let seg: GutterRun | null = null;
    let was = "";
    for (let k = run.from; k <= run.to; k++) {
      const pair = run.axis === "col" ? `${at(run.index, k)}|${at(run.index + 1, k)}` : `${at(k, run.index)}|${at(k, run.index + 1)}`;
      if (seg && pair === was) seg.to = k;
      else {
        seg = { ...run, from: k, to: k };
        out.push(seg);
        was = pair;
      }
    }
  }
  return out;
}

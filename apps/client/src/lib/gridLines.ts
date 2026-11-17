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

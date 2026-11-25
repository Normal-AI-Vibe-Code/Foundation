/**
 * Cutting a flat ground away from a picture's pixels (characters/cutout.ts says why). Pure: RGBA bytes in, the same
 * bytes with the ground's alpha cleared, so it runs the same in a worker (cutoutWorker.ts), on the page where there
 * is no worker, and in a test.
 *
 * The ground's colour is read from the corners and flooded away from the border inward (what the mesh avatar's own
 * cut-out does); a pixel beside the cut that is close to the ground's colour is left half there, so no halo and no
 * stair.
 */

/** the longest side a still is cut at */
export const CUTOUT_SIZE = 384;
/** how far from the ground's colour still counts as ground (RGB distance) */
export const CUTOUT_TOL = 30;

/** the size a picture is cut at: its longest side at most CUTOUT_SIZE, never enlarged */
export function cutoutSize(naturalWidth: number, naturalHeight: number, size = CUTOUT_SIZE): [number, number] {
  const k = Math.min(1, size / Math.max(1, naturalWidth, naturalHeight));
  return [Math.max(1, Math.round(naturalWidth * k)), Math.max(1, Math.round(naturalHeight * k))];
}

/**
 * Clear the flat ground in `d` (RGBA, `w` × `h`). Returns false, with `d` untouched, when there is nothing to cut:
 * a ground that's already clear, corners that disagree (a photograph, a scene), a figure that fills the frame, or a
 * pale figure on a pale ground (nearly everything would go).
 */
export function cutGround(d: Uint8ClampedArray, w: number, h: number, tol = CUTOUT_TOL): boolean {
  if (w < 4 || h < 4) return false;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)];
  if (corners.some((i) => d[i + 3] < 200)) return false;
  const r = corners.reduce((s, i) => s + d[i], 0) / 4;
  const g = corners.reduce((s, i) => s + d[i + 1], 0) / 4;
  const b = corners.reduce((s, i) => s + d[i + 2], 0) / 4;
  // squared distances: this runs for every pixel, several times
  const far2 = (i: number) => {
    const dr = d[i] - r;
    const dg = d[i + 1] - g;
    const db = d[i + 2] - b;
    return dr * dr + dg * dg + db * db;
  };
  const tol2 = tol * tol;
  if (corners.some((i) => far2(i) > tol2)) return false;

  const n = w * h;
  const gone = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const push = (p: number) => {
    if (gone[p] || far2(p * 4) > tol2) return;
    gone[p] = 1;
    stack[top++] = p;
  };
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x));
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1));
  let cleared = top;
  while (top) {
    const p = stack[--top];
    const x = p % w;
    const before = top;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < n - w) push(p + w);
    cleared += top - before;
  }
  if (cleared < n * 0.04 || cleared > n * 0.97) return false;

  for (let p = 0; p < n; p++) if (gone[p]) d[p * 4 + 3] = 0;
  const soft = tol * 2.2;
  const soft2 = soft * soft;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (gone[p] || !(gone[p - 1] || gone[p + 1] || gone[p - w] || gone[p + w])) continue;
      const f2 = far2(p * 4);
      if (f2 < soft2) d[p * 4 + 3] = Math.round(255 * Math.min(1, Math.sqrt(f2) / soft));
    }
  return true;
}

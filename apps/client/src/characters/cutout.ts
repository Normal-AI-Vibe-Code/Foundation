/**
 * A character's still, without its ground. The pipeline draws every sheet and portrait on a flat
 * ground (off-white, or mid-grey for a mesh avatar's portrait: docs/characters.md), which is right for
 * cutting a mesh avatar but wrong to look at: a card that isn't playing would show a grey rectangle,
 * and a seat's loading silhouette would be a box. So a still is keyed here, once per picture: the
 * ground's colour is read from the corners and flooded away from the border inward (what the mesh
 * avatar's own cut-out does), at 384 px, and kept as a PNG for the page's life.
 *
 * A picture that already has a clear ground, or one this can't read (another origin without CORS), is
 * used as it is.
 */

import { useEffect, useState } from "react";

const SIZE = 384;
const TOL = 30; // how far from the ground's colour still counts as ground (RGB distance)
const cache = new Map<string, Promise<string>>();

function key(img: HTMLImageElement): string | null {
  const k = Math.min(1, SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, w, h);
  const image = g.getImageData(0, 0, w, h);
  const d = image.data;
  const at = (x: number, y: number) => (y * w + x) * 4;
  // the ground: the corners' colour. A corner that's already clear means there is nothing to do
  const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)];
  if (corners.some((i) => d[i + 3] < 200)) return null;
  const bg = [0, 1, 2].map((c) => corners.reduce((s, i) => s + d[i + c], 0) / corners.length);
  // corners that disagree: not a flat ground (a photograph, a scene). Leave it alone
  if (corners.some((i) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) > TOL)) return null;
  const far = (i: number) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
  const gone = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (gone[p] || far(p * 4) > TOL) return;
    gone[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) (push(x, 0), push(x, h - 1));
  for (let y = 0; y < h; y++) (push(0, y), push(w - 1, y));
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  let cleared = 0;
  for (let p = 0; p < gone.length; p++) {
    if (!gone[p]) continue;
    d[p * 4 + 3] = 0;
    cleared++;
  }
  // nothing much to cut (the figure fills the frame), or nearly everything went (a pale figure on a pale ground): keep the picture
  if (cleared < w * h * 0.04 || cleared > w * h * 0.97) return null;
  // the edge: a pixel beside the cut that is close to the ground's colour is half there, so no halo and no stair
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (gone[p] || !(gone[p - 1] || gone[p + 1] || gone[p - w] || gone[p + w])) continue;
      const f = far(p * 4);
      if (f < TOL * 2.2) d[p * 4 + 3] = Math.round(255 * Math.min(1, f / (TOL * 2.2)));
    }
  g.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/** the picture at `src` with its flat ground cut away (or `src` itself when there's nothing to cut) */
export function cutout(src: string): Promise<string> {
  let p = cache.get(src);
  if (!p) {
    p = new Promise<string>((done) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          done(key(img) ?? src);
        } catch {
          done(src); // a picture the canvas may not read
        }
      };
      img.onerror = () => done(src);
      img.src = src;
    });
    cache.set(src, p);
  }
  return p;
}

/** `src` cut out, once it's ready (undefined until then: a beat, then cached) */
export function useCutout(src: string | undefined): string | undefined {
  const [out, setOut] = useState<{ of: string; url: string } | null>(null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    void cutout(src).then((url) => live && setOut({ of: src, url }));
    return () => {
      live = false;
    };
  }, [src]);
  return src && out?.of === src ? out.url : undefined;
}

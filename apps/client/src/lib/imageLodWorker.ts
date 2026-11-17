/// <reference lib="webworker" />
/**
 * Makes an image's levels off the main thread (lib/imageLod.ts): decode the
 * original once, then halve it down (2048, 1024, 512, 256 px wide, each from
 * the one above, so each step is a clean 2:1 filter), and read whether it has
 * see-through pixels from a 48 px sample of the smallest.
 */

export type LodRequest = { id: number; blob: Blob; widths: number[] };
export type LodReply =
  | { id: number; ok: true; natural: [number, number]; alpha: boolean; levels: { w: number; blob: Blob }[] }
  | { id: number; ok: false; error: string };

const post = (m: LodReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<LodRequest>) => {
  const { id, blob, widths } = e.data;
  try {
    const bmp = await createImageBitmap(blob);
    const natural: [number, number] = [bmp.width, bmp.height];
    const wanted = [...widths].filter((w) => w < bmp.width).sort((a, b) => b - a);
    const levels: { w: number; blob: Blob }[] = [];
    let from: CanvasImageSource = bmp;
    let fromW = bmp.width;
    let fromH = bmp.height;
    // see-through? (a 48 px sample: enough to know a drawing on a clear ground)
    const alpha = hasAlpha(blob.type, bmp);
    for (const w of wanted) {
      // halve until within 2× of the level, so no step filters more than 2:1
      while (fromW / 2 >= w) {
        const hw = Math.round(fromW / 2);
        const hh = Math.max(1, Math.round(fromH / 2));
        const c = new OffscreenCanvas(hw, hh);
        const g = c.getContext("2d")!;
        g.imageSmoothingQuality = "high";
        g.drawImage(from, 0, 0, hw, hh);
        from = c;
        fromW = hw;
        fromH = hh;
      }
      const h = Math.max(1, Math.round((w * bmp.height) / bmp.width));
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d")!;
      g.imageSmoothingQuality = "high";
      g.drawImage(from, 0, 0, w, h);
      // a clear picture keeps its clear pixels (WebP where it can be written, else PNG); a photo is a JPEG
      const out = alpha ? await c.convertToBlob({ type: "image/webp", quality: 0.88 }) : await c.convertToBlob({ type: "image/jpeg", quality: 0.86 });
      levels.push({ w, blob: out });
      from = c;
      fromW = w;
      fromH = h;
    }
    bmp.close();
    post({ id, ok: true, natural, alpha, levels });
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};

function hasAlpha(type: string, bmp: ImageBitmap): boolean {
  if (/jpe?g/i.test(type)) return false;
  const n = 48;
  const c = new OffscreenCanvas(n, n);
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return false;
  g.drawImage(bmp, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

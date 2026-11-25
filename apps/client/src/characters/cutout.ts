/**
 * A character's still, without its ground. The pipeline draws every sheet and portrait on a flat
 * ground (off-white, or mid-grey for a mesh avatar's portrait: docs/characters.md), which is right for
 * cutting a mesh avatar but wrong to look at: a card that isn't playing would show a grey rectangle,
 * and a seat's loading silhouette would be a box. So a still is keyed here, once per picture: the
 * ground's colour is read from the corners and flooded away from the border inward (cutoutCore.ts), at 384 px.
 *
 * Where and when (2026-11-25): the cut is made in a worker (cutoutWorker.ts), not on the page (reading the pixels
 * back, the flood and encoding a PNG, about 10 ms a picture on a fast desktop, once for every character as its
 * card came near). And a still that says which file it is (`stable`) is kept in the image cache, in memory and
 * between launches (lib/imageCache.ts loadDerivedImage), so it is cut once per file, not once per page, and one
 * already in memory is there on the first frame: a still used to show the agent's mark for a beat on every mount,
 * and a studio held 1.2 MB of data: addresses in its pictures.
 *
 * A picture that already has a clear ground, or one this can't read (another origin without CORS), is
 * used as it is.
 */

import { useEffect, useState } from "react";
import { derivedImageSrc, loadDerivedImage, peekExactImage, retainCachedImage, type CachedImageEntry, type DerivedImage } from "../lib/imageCache";
import { CUTOUT_SIZE, cutGround, cutoutSize } from "./cutoutCore";
import type { CutReply, CutRequest } from "./cutoutWorker";

// ---------- the worker ----------

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (r: CutReply) => void>();

function cutWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return null;
  try {
    const w = new Worker(new URL("./cutoutWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<CutReply>) => {
      const done = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      done?.(e.data);
    };
    // a worker that won't start: everything waiting keeps its picture, and the page does the next ones itself
    w.onerror = () => {
      worker = null;
      for (const [id, done] of waiting) done({ id, blob: null, width: 0, height: 0 });
      waiting.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** where there is no worker (an old WebKit): on the page, as it was */
function cutOnPage(img: HTMLImageElement, w: number, h: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return Promise.resolve(null);
  g.drawImage(img, 0, 0, w, h);
  const image = g.getImageData(0, 0, w, h);
  if (!cutGround(image.data, w, h)) return Promise.resolve(null);
  g.putImageData(image, 0, 0);
  return new Promise((done) => canvas.toBlob(done, "image/png"));
}

/** the picture at `src` cut out, as a PNG; `blob: null` when there's nothing to cut; null when it can't be read */
async function cut(src: string): Promise<{ blob: Blob | null; width: number; height: number } | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await img.decode();
    const [width, height] = cutoutSize(img.naturalWidth, img.naturalHeight);
    const w = cutWorker();
    if (!w) return { blob: await cutOnPage(img, width, height), width, height };
    const bitmap = await createImageBitmap(img, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
    const id = ++seq;
    const reply = await new Promise<CutReply>((done) => {
      waiting.set(id, done);
      w.postMessage({ id, bitmap } satisfies CutRequest, [bitmap]);
    });
    return { blob: reply.blob, width, height };
  } catch {
    return null; // a picture that didn't load, or one the canvas may not read
  }
}

// ---------- a still that names its file: kept in the image cache ----------

/** the cache's name for `stable` cut out (the file's own address with its version: Avatar.tsx) */
export const cutoutSrc = (stable: string) => derivedImageSrc("cutout", [stable, CUTOUT_SIZE]);

async function makeKept(src: string): Promise<DerivedImage | null> {
  const made = await cut(src);
  if (!made) return null;
  // nothing to cut: the picture itself is kept under the cut-out's name, so it isn't tried again each launch
  const blob = made.blob ?? (await fetch(src).then((r) => (r.ok ? r.blob() : null)).catch(() => null));
  if (!blob) return null;
  return { blob, width: made.width, natural: [made.width, made.height], alpha: made.blob ? true : null };
}

// ---------- a still that doesn't: kept for the page's life, as a data: address ----------

const cache = new Map<string, Promise<string>>();

const asDataUrl = (blob: Blob) =>
  new Promise<string>((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });

/** the picture at `src` with its flat ground cut away (or `src` itself when there's nothing to cut) */
export function cutout(src: string): Promise<string> {
  let p = cache.get(src);
  if (!p) {
    p = cut(src)
      .then((made) => (made?.blob ? asDataUrl(made.blob) : src))
      .catch(() => src);
    cache.set(src, p);
  }
  return p;
}

/**
 * `src` cut out, once it's ready (undefined until then: a beat, then cached). With `stable` (what the picture is,
 * whatever address it is drawn from: its path and file id), the cut is kept in the image cache: there on the first
 * frame when it's in memory, and read from disk on the next launch without waiting for the picture itself.
 */
export function useCutout(src: string | undefined, stable?: string): string | undefined {
  const [out, setOut] = useState<{ of: string; url: string } | null>(null);
  const kept = stable ? cutoutSrc(stable) : null;
  const hit = kept ? peekExactImage(kept, "orig") : null;
  useEffect(() => {
    let live = true;
    if (!kept) {
      if (!src) return;
      void cutout(src).then((url) => live && setOut({ of: src, url }));
      return () => {
        live = false;
      };
    }
    let release: (() => void) | null = null;
    const take = (entry: CachedImageEntry) => {
      if (!live) return;
      release?.();
      release = retainCachedImage(entry.key);
      setOut({ of: kept, url: entry.url });
    };
    void loadDerivedImage(kept, () => (src ? makeKept(src) : Promise.resolve(null))).then((entry) => {
      if (entry) take(entry);
      // it couldn't be cut (or read): the picture as it is
      else if (live && src) setOut({ of: kept, url: src });
    });
    return () => {
      live = false;
      release?.();
    };
  }, [src, kept]);
  if (kept) return out?.of === kept ? out.url : (hit?.url ?? undefined);
  return src && out?.of === src ? out.url : undefined;
}

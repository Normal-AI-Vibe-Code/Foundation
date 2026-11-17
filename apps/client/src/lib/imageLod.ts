/**
 * Image levels (2026-11-11): a picture on the grid is drawn from the smallest
 * copy that's still sharp at the size it's drawn, never the original unless
 * the camera is close enough to need it.
 *
 * Why: a board of photographs straight off a camera (4096 px, 1–13 MB each)
 * drawn at a few hundred pixels made the GPU filter every original on every
 * frame of a pan or zoom. On an RTX 5080 a heavy board (e2e/heavy.spec.ts)
 * dropped 21 % of its frames to 30 fps while panning at 35 %, with the main
 * thread idle.
 *
 * How: the first time an image is shown, its original is fetched once and a
 * worker (imageLodWorker.ts) halves it down to 2048, 1024, 512 and 256 px
 * wide. The levels are kept in Cache Storage (by the file's address, which is
 * content-addressed on the server, so a level never goes stale), so the next
 * visit loads a few kilobytes per picture and never the original. A card asks
 * for the level its drawn width needs (card width × zoom × the section's fit
 * × the screen's pixel ratio), moving up as soon as the camera settles and
 * down only when it's well past (so a pinch doesn't churn).
 *
 * Kept as they are: SVG (drawn as vectors), GIF (it may move), and pictures
 * from other sites the page can't read (no CORS); those load their original.
 */

import { fetchFile } from "./api";
import type { LodReply, LodRequest } from "./imageLodWorker";

export const LOD_WIDTHS = [256, 512, 1024, 2048];
const CACHE = "foundation-image-lod-v1";
const SKIP = /\.(svg|gif)(\?|#|$)|^data:image\/(svg|gif)/i;

export interface Levels {
  natural: [number, number];
  alpha: boolean;
  /** level width → an object URL (a blob in memory, not a request) */
  urls: Map<number, string>;
}

const entries = new Map<string, Promise<Levels | null>>();

/** the levels of an image (made once, then from the cache); null: show the original */
export function levelsOf(src: string, name = ""): Promise<Levels | null> {
  let p = entries.get(src);
  if (!p) {
    p = load(src, name).catch(() => null);
    entries.set(src, p);
  }
  return p;
}

/** what's already known about an image without waiting (so a card re-mounted mid-pan doesn't flash) */
const settled = new Map<string, Levels | null>();
export function levelsNow(src: string): Levels | null | undefined {
  return settled.get(src);
}

/** the URL a card shows: the smallest level at least `px` wide, or the original past the largest */
export function pick(levels: Levels | null, original: string, px: number): { url: string; w: number } {
  if (!levels) return { url: original, w: Infinity };
  const ws = [...levels.urls.keys()].sort((a, b) => a - b);
  for (const w of ws) if (w >= px) return { url: levels.urls.get(w)!, w };
  return { url: original, w: levels.natural[0] };
}

// ---------- the cache ----------

const key = (src: string, part: string | number) => `https://image-lod.foundation.local/${encodeURIComponent(src)}/${part}`;

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE);
  } catch {
    return null;
  }
}

/** `?nolod`: every picture loads its original, as before levels (for measuring the difference) */
const OFF = typeof location !== "undefined" && new URLSearchParams(location.search).has("nolod");

async function load(src: string, name: string): Promise<Levels | null> {
  if (OFF || SKIP.test(src) || SKIP.test(name)) {
    settled.set(src, null);
    return null;
  }
  const cache = await openCache();
  const fromCache = cache ? await readCache(cache, src) : null;
  if (fromCache) {
    settled.set(src, fromCache);
    return fromCache;
  }
  const made = await make(src);
  settled.set(src, made?.levels ?? null);
  if (made && cache) void writeCache(cache, src, made).catch(() => {});
  return made?.levels ?? null;
}

async function readCache(cache: Cache, src: string): Promise<Levels | null> {
  const meta = await cache.match(key(src, "meta"));
  if (!meta) return null;
  const m = (await meta.json()) as { natural: [number, number]; alpha: boolean; widths: number[] };
  const urls = new Map<number, string>();
  for (const w of m.widths) {
    const r = await cache.match(key(src, w));
    if (!r) return null; // a level went missing (storage pressure): make them again
    urls.set(w, URL.createObjectURL(await r.blob()));
  }
  return { natural: m.natural, alpha: m.alpha, urls };
}

async function writeCache(cache: Cache, src: string, made: { levels: Levels; blobs: { w: number; blob: Blob }[] }) {
  for (const { w, blob } of made.blobs) await cache.put(key(src, w), new Response(blob, { headers: { "content-type": blob.type } }));
  // the manifest last: a half-written set is never read as whole
  await cache.put(key(src, "meta"), new Response(JSON.stringify({ natural: made.levels.natural, alpha: made.levels.alpha, widths: made.blobs.map((b) => b.w) }), { headers: { "content-type": "application/json" } }));
}

// ---------- making levels (two at a time, in the order they're asked for) ----------

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: LodReply) => void>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
const PARALLEL = 2;

function pump() {
  while (running < PARALLEL && queue.length) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./imageLodWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<LodReply>) => {
      const done = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      done?.(e.data);
    };
    return worker;
  } catch {
    return null;
  }
}

function make(src: string): Promise<{ levels: Levels; blobs: { w: number; blob: Blob }[] } | null> {
  return new Promise((resolve) => {
    queue.push(async () => {
      try {
        const w = getWorker();
        if (!w) return resolve(null);
        const res = src.startsWith("/files/") ? await fetchFile(src) : await fetch(src, { mode: "cors", credentials: "omit" });
        if (!res.ok) return resolve(null);
        const blob = await res.blob();
        if (!blob.type.startsWith("image/") || /svg|gif/i.test(blob.type)) return resolve(null);
        const id = ++seq;
        const reply = await new Promise<LodReply>((r) => {
          waiting.set(id, r);
          w.postMessage({ id, blob, widths: LOD_WIDTHS } satisfies LodRequest);
        });
        if (!reply.ok) return resolve(null);
        const urls = new Map(reply.levels.map((l) => [l.w, URL.createObjectURL(l.blob)] as const));
        resolve({ levels: { natural: reply.natural, alpha: reply.alpha, urls }, blobs: reply.levels });
      } catch {
        resolve(null);
      }
    });
    pump();
  });
}

/**
 * Which level a drawn width needs, with hysteresis: up as soon as the drawn
 * width passes the current level, down only once it's under a third of it.
 */
export function nextLevel(current: number, px: number): number {
  const up = LOD_WIDTHS.find((w) => w >= px) ?? Infinity;
  if (up > current) return up;
  if (px * 3 < current) return up;
  return current;
}

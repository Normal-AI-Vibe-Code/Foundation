/**
 * Server-first progressive image loading + local worker fallback.
 *
 * How it works:
 *  - Server files (`/files/<id>`, `/api/characters/<id>/files/<role>`) ask the
 *    server directly for resized tiers via `?w=64|256|512|1024|2048`.
 *  - On a cold load, a tiny `w=64` micro-preview (< 2 KB) fetches in parallel
 *    with the needed tier (`256`/`512`/`1024`), revealing real image composition
 *    in ~20 ms instead of a grey box.
 *  - Every fetched tier lives in the unified two-tier cache (`imageCache.ts`:
 *    L1 ref-counted in-memory LRU + L2 persistent Cache Storage), so remounts,
 *    board switches, lightboxes and reloads hit memory or disk instantly.
 *  - Graceful fallback: if the server returns `X-Image-Level: original` on a
 *    large image (e.g. WebP/AVIF, or an older server without `?w=`), the blob
 *    is handed to `imageLodWorker.ts` to generate `[64, 256, 512, 1024, 2048]`
 *    off the main thread and populate `imageCache.ts`.
 *  - `?nolod` bypasses tiers and loads originals directly (A/B perf benchmarks
 *    in `e2e/heavy.spec.ts`).
 */

import { fetchFile, SERVER } from "./api";
import {
  cachedTiersFor,
  isLocalDataUrl,
  isServerImagePath,
  peekCachedImage,
  peekExactImage,
  putCachedImage,
  readL2Image,
  scheduleImageFetch,
  setImageCacheOrigin,
  supportsServerResize,
  withWidthParam,
  writeL2Image,
  type CachedImageEntry,
  type FetchPriority,
  type ImageTier,
} from "./imageCache";
import type { LodReply, LodRequest } from "./imageLodWorker";

export const PREVIEW_WIDTH = 64 as const;
export const LOD_WIDTHS = [256, 512, 1024, 2048];
const ALL_WORKER_WIDTHS = [PREVIEW_WIDTH, ...LOD_WIDTHS];

const SKIP = /\.(svg|gif)(\?|#|$)|^data:image\/(svg|gif)/i;
const WORKER_MIN_BYTES = 32 * 1024;

// Namespace L1/L2 keys by the active Foundation server origin (cookie or bearer)
if (typeof window !== "undefined") {
  setImageCacheOrigin(() => SERVER || window.location.origin);
}

/** `?nolod`: every picture loads its original (used by `e2e/heavy.spec.ts` A/B benchmarks). */
export function isLodDisabled(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).has("nolod");
}

export function isSkippableImage(src: string, name = ""): boolean {
  return SKIP.test(src) || SKIP.test(name);
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

export function levelToTier(level: number): ImageTier {
  if (!Number.isFinite(level) || level > 2048) return "orig";
  if (level <= 64) return 64;
  if (level <= 256) return 256;
  if (level <= 512) return 512;
  if (level <= 1024) return 1024;
  return 2048;
}

// ---------- Tier loading (L1 -> L2 -> Network -> Worker fallback) ----------

export interface LoadTierOptions {
  name?: string;
  priority?: FetchPriority;
  distance?: number;
  signal?: AbortSignal;
}

function satisfiesRequested(entry: CachedImageEntry, requested: ImageTier): boolean {
  if (entry.tier === requested) return true;
  if (entry.tier === "orig") {
    // Original satisfies any tier request if the image is already small or caller wants orig
    if (requested === "orig") return true;
    if (entry.natural && entry.natural[0] > 0 && entry.natural[0] <= requested) return true;
  }
  return false;
}

/**
 * Ensure `(src, tier)` is loaded into L1 and return its `CachedImageEntry`.
 * Checks L1 synchronously, then L2 Cache Storage, then schedules a prioritized
 * network fetch (with `?w=<tier>` for server files) and falls back to the local
 * LOD worker when the server returns an unresized large original.
 */
export async function loadImageTier(src: string, requestedTier: ImageTier, opts: LoadTierOptions = {}): Promise<CachedImageEntry | null> {
  if (!src || isLocalDataUrl(src)) return null;

  const noLod = isLodDisabled();
  const skip = isSkippableImage(src, opts.name);
  const canServerResize = supportsServerResize(src) && !noLod && !skip;
  const tier: ImageTier = noLod || skip ? "orig" : requestedTier;

  // 1. L1 exact or already-original-small hit
  const exact = peekExactImage(src, tier);
  if (exact) return exact;
  if (tier !== "orig") {
    const orig = peekExactImage(src, "orig");
    if (orig && satisfiesRequested(orig, tier)) return orig;
  }

  // 2. L2 persistent Cache Storage hit (works for both cookie and bearer transports)
  const l2 = await readL2Image(src, tier);
  if (l2) {
    return putCachedImage(src, tier, {
      blob: l2.blob,
      bytes: l2.bytes,
      width: l2.width,
      natural: l2.natural,
      alpha: l2.alpha,
    });
  }
  if (tier !== "orig") {
    const l2Orig = await readL2Image(src, "orig");
    if (l2Orig && l2Orig.natural && l2Orig.natural[0] > 0 && l2Orig.natural[0] <= tier) {
      return putCachedImage(src, "orig", {
        blob: l2Orig.blob,
        bytes: l2Orig.bytes,
        width: l2Orig.width,
        natural: l2Orig.natural,
        alpha: l2Orig.alpha,
      });
    }
  }

  if (opts.signal?.aborted) return null;

  // 3. Scheduled network fetch (deduplicated per (src, tier), prioritized, abortable)
  try {
    return await scheduleImageFetch(
      src,
      tier,
      async (signal) => {
        // Re-check L1 in case another parallel tier (e.g., worker fallback) populated us while queued
        const raced = peekExactImage(src, tier);
        if (raced) return raced;

        const reqUrl = canServerResize && tier !== "orig" ? withWidthParam(src, tier) : src;
        const res = isServerImagePath(src)
          ? await fetchFile(reqUrl, { signal })
          : await fetch(reqUrl, { mode: "cors", credentials: "omit", signal });
        if (!res.ok) return null;

        const blob = await res.blob();
        if (signal.aborted) return null;

        const levelHdr = res.headers.get("x-image-level");
        const natW = Number(res.headers.get("x-image-natural-width") || 0);
        const natH = Number(res.headers.get("x-image-natural-height") || 0);
        const imgW = Number(res.headers.get("x-image-width") || 0);
        const alphaHdr = res.headers.get("x-image-alpha");
        const natural: [number, number] | null = natW > 0 && natH > 0 ? [natW, natH] : null;
        const alpha: boolean | null = alphaHdr === "1" ? true : alphaHdr === "0" ? false : null;

        const isRaster = blob.type.startsWith("image/") && !/svg|gif/i.test(blob.type);
        const parsedLevel = levelHdr && /^\d+$/.test(levelHdr) ? Number(levelHdr) : null;

        // Server returned a resized tier!
        if (parsedLevel !== null && tier !== "orig") {
          const actualTier = levelToTier(parsedLevel);
          const entry = putCachedImage(src, actualTier, {
            blob,
            bytes: blob.size,
            width: imgW || parsedLevel,
            natural,
            alpha,
          });
          void writeL2Image(src, actualTier, { blob, width: entry.width, natural, alpha });
          return entry;
        }

        // Server returned original (either requested "orig", X-Image-Level: original, or older server without ?w=)
        const origEntry = putCachedImage(src, "orig", {
          blob,
          bytes: blob.size,
          width: imgW || natW || 0,
          natural,
          alpha,
        });
        void writeL2Image(src, "orig", { blob, width: origEntry.width, natural, alpha });

        // If a smaller tier was requested, the image is raster (e.g. WebP/AVIF or older server),
        // and the image is actually larger than the requested tier, generate local LODs in the worker.
        const needsLocalWorker =
          !noLod &&
          !skip &&
          isRaster &&
          tier !== "orig" &&
          (natural ? natural[0] > tier : blob.size >= WORKER_MIN_BYTES);

        if (needsLocalWorker) {
          const generated = await generateLocalLevels(src, blob);
          if (generated) {
            return peekExactImage(src, tier) ?? peekCachedImage(src, tier) ?? origEntry;
          }
        }

        return origEntry;
      },
      { priority: opts.priority, distance: opts.distance, signal: opts.signal },
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return null;
    return null;
  }
}

export interface ProgressiveLoadOptions extends LoadTierOptions {
  /** Whether to fetch the tiny w=64 micro-preview on cold loads (default true). */
  preview?: boolean;
  /** Called synchronously or asynchronously as each stage (preview, then target) lands. */
  onStage?: (entry: CachedImageEntry, isFinal: boolean) => void;
}

/**
 * Progressive two-step image load:
 *  - Instant L1 hit if already cached at `>= targetTier` (zero flicker).
 *  - Instant cached lower tier if present in L1 while upgrading to `targetTier`.
 *  - On cold load of a server image, fetches tiny `w=64` micro-preview in parallel
 *    with `targetTier` so the real image composition appears in ~20 ms.
 */
export async function loadProgressiveImage(
  src: string,
  targetTier: ImageTier,
  opts: ProgressiveLoadOptions = {},
): Promise<CachedImageEntry | null> {
  if (!src || isLocalDataUrl(src)) return null;

  const noLod = isLodDisabled();
  const effectiveTier: ImageTier = noLod || isSkippableImage(src, opts.name) ? "orig" : targetTier;
  const minWidth = effectiveTier === "orig" ? Infinity : effectiveTier;

  // 1. Check L1 synchronously
  const cached = peekCachedImage(src, minWidth);
  if (cached) {
    const isFinal = satisfiesRequested(cached, effectiveTier) || (effectiveTier !== "orig" && cached.tier !== "orig" && cached.tier >= effectiveTier);
    opts.onStage?.(cached, isFinal);
    if (isFinal) return cached;
  }

  // 2. Check L2 for exact target before firing a preview fetch (warm reload skips preview!)
  const l2Target = await readL2Image(src, effectiveTier);
  if (l2Target) {
    if (opts.signal?.aborted) return null;
    const entry = putCachedImage(src, effectiveTier, {
      blob: l2Target.blob,
      bytes: l2Target.bytes,
      width: l2Target.width,
      natural: l2Target.natural,
      alpha: l2Target.alpha,
    });
    opts.onStage?.(entry, true);
    return entry;
  }

  if (opts.signal?.aborted) return null;

  // 3. Cold load: fire w=64 micro-preview in parallel with targetTier when no placeholder is shown yet
  const wantPreview =
    opts.preview !== false &&
    !cached &&
    !noLod &&
    effectiveTier !== 64 &&
    supportsServerResize(src) &&
    !isSkippableImage(src, opts.name);

  let targetDone = false;

  if (wantPreview) {
    void loadImageTier(src, PREVIEW_WIDTH, {
      name: opts.name,
      priority: opts.priority ?? 0,
      distance: opts.distance,
      signal: opts.signal,
    }).then((previewEntry) => {
      if (!targetDone && !opts.signal?.aborted && previewEntry) {
        opts.onStage?.(previewEntry, false);
      }
    });
  }

  const finalEntry = await loadImageTier(src, effectiveTier, {
    name: opts.name,
    priority: opts.priority ?? 0,
    distance: opts.distance,
    signal: opts.signal,
  });

  targetDone = true;
  if (finalEntry && !opts.signal?.aborted) {
    opts.onStage?.(finalEntry, true);
  }
  return finalEntry;
}

// ---------- Local Web Worker fallback (for WebP/AVIF, external CORS images, or older servers) ----------

let worker: Worker | null = null;
let workerSeq = 0;
const workerWaiting = new Map<number, (r: LodReply) => void>();
const workerQueue: Array<() => Promise<void>> = [];
let workerRunning = 0;
const WORKER_PARALLEL = 2;
const workerInFlight = new Map<string, Promise<boolean>>();

function pumpWorker() {
  while (workerRunning < WORKER_PARALLEL && workerQueue.length > 0) {
    const job = workerQueue.shift()!;
    workerRunning++;
    void job().finally(() => {
      workerRunning--;
      pumpWorker();
    });
  }
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./imageLodWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<LodReply>) => {
      const done = workerWaiting.get(e.data.id);
      workerWaiting.delete(e.data.id);
      done?.(e.data);
    };
    return worker;
  } catch {
    return null;
  }
}

function generateLocalLevels(src: string, blob: Blob): Promise<boolean> {
  const existing = workerInFlight.get(src);
  if (existing) return existing;

  const p = new Promise<boolean>((resolve) => {
    workerQueue.push(async () => {
      try {
        const w = getWorker();
        if (!w) return resolve(false);
        const id = ++workerSeq;
        const reply = await new Promise<LodReply>((r) => {
          workerWaiting.set(id, r);
          w.postMessage({ id, blob, widths: ALL_WORKER_WIDTHS } satisfies LodRequest);
        });
        if (!reply.ok) return resolve(false);

        for (const lvl of reply.levels) {
          const t = levelToTier(lvl.w);
          putCachedImage(src, t, {
            blob: lvl.blob,
            bytes: lvl.blob.size,
            width: lvl.w,
            natural: reply.natural,
            alpha: reply.alpha,
          });
          void writeL2Image(src, t, {
            blob: lvl.blob,
            width: lvl.w,
            natural: reply.natural,
            alpha: reply.alpha,
          });
        }
        // Update original's metadata (natural size + alpha) now that the worker measured it
        putCachedImage(src, "orig", {
          bytes: blob.size,
          width: reply.natural[0],
          natural: reply.natural,
          alpha: reply.alpha,
        });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    pumpWorker();
  }).finally(() => {
    workerInFlight.delete(src);
  });

  workerInFlight.set(src, p);
  return p;
}

// ---------- Backward-compatible Levels facade (backed by imageCache.ts) ----------

export interface Levels {
  natural: [number, number];
  alpha: boolean;
  /** level width -> an object URL (a blob in memory, not a request) */
  urls: Map<number, string>;
}

/** Snapshot of whatever numeric tiers are already cached in L1 for `src`. */
export function levelsNow(src: string): Levels | null | undefined {
  if (isLodDisabled() || isSkippableImage(src)) return null;
  const tiers = cachedTiersFor(src);
  if (tiers.length === 0) return undefined;
  const urls = new Map<number, string>();
  let natural: [number, number] = [0, 0];
  let alpha = false;
  for (const t of tiers) {
    const e = peekExactImage(src, t);
    if (!e) continue;
    if (e.natural && e.natural[0] > 0) natural = e.natural;
    if (e.alpha !== null) alpha = e.alpha;
    if (typeof t === "number") urls.set(t, e.url);
  }
  return urls.size > 0 ? { natural, alpha, urls } : undefined;
}

/** Legacy helper: ensures at least tier 256 is loaded and returns a `Levels` snapshot. */
export async function levelsOf(src: string, name = ""): Promise<Levels | null> {
  if (isLodDisabled() || isSkippableImage(src, name)) return null;
  const entry = await loadImageTier(src, 256, { name });
  if (!entry) return null;
  return levelsNow(src) ?? null;
}

/** Legacy helper: smallest cached level at least `px` wide, or `original` past the largest. */
export function pick(levels: Levels | null, original: string, px: number): { url: string; w: number } {
  if (!levels) return { url: original, w: Infinity };
  const ws = [...levels.urls.keys()].sort((a, b) => a - b);
  for (const w of ws) if (w >= px) return { url: levels.urls.get(w)!, w };
  return { url: original, w: levels.natural[0] };
}

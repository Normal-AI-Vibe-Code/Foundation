/**
 * Unified two-tier image cache + viewport priority fetch scheduler.
 *
 * L1 (in-memory LRU):
 *   - Bounded by entry count (180) and byte budget (96 MB).
 *   - Keyed by `${origin}|${path}|${tier}` where tier is `64 | 256 | 512 | 1024 | 2048 | "orig"`.
 *   - Ref-counted (`refs`): mounted `<img>` elements retain their entry so an active
 *     `blob:` URL is never revoked out from under a painted element.
 *   - Synchronous `peekCachedImage(src, minWidth)` lets cards, chat pictures, lightboxes
 *     and thumbnails render on frame 1 with zero blank flash.
 *
 * L2 (persistent Cache Storage, `foundation-image-cache-v3`):
 *   - Stores image blobs with lightweight metadata headers (`x-f-nat-w`, `x-f-nat-h`,
 *     `x-f-alpha`, `x-f-bytes`, `x-f-at`, `x-f-w`) across reloads for BOTH cookie and
 *     bearer (`BEARER === true`) transports.
 *   - Bounded LRU pruning (max 400 entries / 120 MB) so browser storage quota stays healthy.
 *
 * Priority scheduler (`ImageFetchScheduler`):
 *   - Priority 0 = visible on screen (tie-break by distance from viewport center)
 *   - Priority 1 = near viewport / pre-warm
 *   - Priority 2 = background upgrade
 *   - Concurrency: max 5 small/medium server tiers (`w <= 1024`), max 2 large/original (`2048 | "orig"`).
 *   - Deduplicates concurrent requests for the same `(src, tier)` key and supports per-caller
 *     `AbortSignal` cancellation so panning off-screen immediately frees slots for visible cards.
 */

import { BYTE_CACHE_NAME, resetByteCache } from "./byteCache";

export const IMAGE_CACHE_NAME = "foundation-image-cache-v3";
/** v2 was opened per read and write: WebKit (the Mac app) made a new cache of the same name for each racing open */
export const SCATTERED_CACHE_NAME = "foundation-image-cache-v2";
export const LEGACY_LOD_CACHE_NAME = "foundation-image-lod-v1";

export const PREVIEW_TIER = 64 as const;
export const SERVER_TIERS = [64, 256, 512, 1024, 2048] as const;
export const LOD_TIERS = [256, 512, 1024, 2048] as const;

export type NumericImageTier = (typeof SERVER_TIERS)[number];
export type ImageTier = NumericImageTier | "orig";
export type FetchPriority = 0 | 1 | 2;

export const DEFAULT_L1_MAX_ENTRIES = 180;
export const DEFAULT_L1_MAX_BYTES = 96 * 1024 * 1024;
export const DEFAULT_L2_MAX_ENTRIES = 400;
export const DEFAULT_L2_MAX_BYTES = 120 * 1024 * 1024;

export const MAX_SMALL_CONCURRENCY = 5;
export const MAX_LARGE_CONCURRENCY = 2;

export interface CachedImageEntry {
  key: string;
  src: string;
  tier: ImageTier;
  url: string;
  bytes: number;
  width: number;
  natural: [number, number] | null;
  alpha: boolean | null;
  lastUsed: number;
  refs: number;
}

export interface PutImageInput {
  blob?: Blob;
  url?: string;
  bytes: number;
  width: number;
  natural: [number, number] | null;
  alpha: boolean | null;
}

export interface L2Payload {
  blob: Blob;
  bytes: number;
  width: number;
  natural: [number, number] | null;
  alpha: boolean | null;
  at: number;
}

export interface ImageCacheStats {
  l1Entries: number;
  l1Bytes: number;
  l1Pinned: number;
  l1Hits: number;
  l2Hits: number;
  networkFetches: number;
  inFlight: number;
  queued: number;
}

// ---------- origin & URL helpers ----------

let originResolver: () => string = () => (typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost");

/** Configured once by browser modules (e.g. fileSrc / imageLod) so cross-origin bearer servers have their own key namespace. */
export function setImageCacheOrigin(resolver: () => string) {
  originResolver = resolver;
}

export function currentImageOrigin(): string {
  try {
    return originResolver() || "http://localhost";
  } catch {
    return "http://localhost";
  }
}

export function imageCacheKey(src: string, tier: ImageTier, origin = currentImageOrigin()): string {
  return `${origin}|${src}|${tier}`;
}

function srcNamespace(src: string, origin = currentImageOrigin()): string {
  return `${origin}|${src}`;
}

export function isLocalDataUrl(src: string): boolean {
  return src.startsWith("data:") || src.startsWith("blob:");
}

export function isServerImagePath(src: string): boolean {
  return src.startsWith("/files/") || /^\/api\/characters\/[^/]+\/files\//.test(src) || /^\/api\/boards\/[^/]+\/pages\/[^/]+\/picture/.test(src);
}

/** Server paths that understand `?w=<tier>` resized image variants. */
export function supportsServerResize(src: string): boolean {
  return src.startsWith("/files/") || /^\/api\/characters\/[^/]+\/files\//.test(src);
}

/** Append `?w=<tier>` (or `&w=<tier>`) for numeric tiers; returns `src` unchanged for `"orig"`. */
export function withWidthParam(src: string, tier: ImageTier): string {
  if (tier === "orig") return src;
  const hashIdx = src.indexOf("#");
  const base = hashIdx >= 0 ? src.slice(0, hashIdx) : src;
  const hash = hashIdx >= 0 ? src.slice(hashIdx) : "";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}w=${tier}${hash}`;
}

/** Snap a requested pixel width to the smallest server tier `>= px` (including 64), or `"orig"` past 2048. */
export function snapServerTier(px: number): ImageTier {
  if (!Number.isFinite(px) || px <= 0) return "orig";
  for (const t of SERVER_TIERS) if (t >= px) return t;
  return "orig";
}

/** Snap a drawn pixel width to the smallest LOD tier `[256, 512, 1024, 2048]` `>= px`, or `"orig"` past 2048. */
export function snapLodTier(px: number): ImageTier {
  if (!Number.isFinite(px) || px <= 0) return 256;
  for (const t of LOD_TIERS) if (t >= px) return t;
  return "orig";
}

export function tierNumericWidth(tier: ImageTier, naturalWidth?: number | null): number {
  if (tier === "orig") return naturalWidth && naturalWidth > 0 ? naturalWidth : Infinity;
  return tier;
}

/**
 * Choose which cached tier an off-screen card should shed its displayed `<img>` down to
 * to free GPU texture VRAM without discarding L1/L2 cache entries.
 * Returns `null` if the card is already at a tiny tier (`<= 256` with no smaller tier available).
 */
export function pickShedTier(available: readonly ImageTier[], current: ImageTier): ImageTier | null {
  const curW = current === "orig" ? Infinity : current;
  // Prefer 64 if cached and we're currently larger; otherwise 256 if we're currently > 256
  if (available.includes(64) && curW > 64) return 64;
  if (available.includes(256) && curW > 256) return 256;
  return null;
}

/** Distance in CSS pixels from an element's center to the viewport center (tie-breaker for visible cards). */
export function viewportDistance(el: Element | null): number {
  if (!el || typeof window === "undefined" || typeof el.getBoundingClientRect !== "function") return 0;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const vx = (window.innerWidth || 1280) / 2;
  const vy = (window.innerHeight || 720) / 2;
  return Math.hypot(cx - vx, cy - vy);
}

// ---------- L1 In-Memory LRU ----------

export interface ImageLruOptions {
  maxEntries?: number;
  maxBytes?: number;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  now?: () => number;
}

interface InternalEntry extends CachedImageEntry {
  ns: string;
  detached?: boolean;
}

export class ImageLruCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly now: () => number;

  private readonly entries = new Map<string, InternalEntry>();
  private readonly bySrc = new Map<string, Map<ImageTier, InternalEntry>>();
  private readonly detached = new Map<string, InternalEntry>();
  private totalBytes = 0;
  private tick = 0;
  private hits = 0;

  constructor(opts: ImageLruOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_L1_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_L1_MAX_BYTES;
    this.createObjectUrl = opts.createObjectUrl ?? ((b) => URL.createObjectURL(b));
    this.revokeObjectUrl = opts.revokeObjectUrl ?? ((u) => URL.revokeObjectURL(u));
    this.now = opts.now ?? (() => Date.now());
  }

  private stamp(): number {
    // Combine monotonic tick with wall clock so rapid puts in the same ms keep strict LRU order
    const t = this.now() * 1000 + (++this.tick % 1000);
    return t;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get hitCount(): number {
    return this.hits;
  }

  pinnedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.refs > 0) n++;
    return n;
  }

  getExact(src: string, tier: ImageTier, origin = currentImageOrigin()): CachedImageEntry | null {
    const key = imageCacheKey(src, tier, origin);
    const e = this.entries.get(key);
    if (!e) return null;
    e.lastUsed = this.stamp();
    this.hits++;
    return e;
  }

  /**
   * Synchronous lookup: returns the smallest cached tier `>= minWidth`, or the
   * largest available cached tier as an instant placeholder.
   * When `minWidth` is omitted, returns the highest-resolution cached tier.
   */
  peek(src: string, minWidth?: number, origin = currentImageOrigin()): CachedImageEntry | null {
    const ns = srcNamespace(src, origin);
    const group = this.bySrc.get(ns);
    if (!group || group.size === 0) return null;

    const list = [...group.values()];
    let chosen: InternalEntry | null = null;

    if (minWidth === undefined) {
      // Highest available tier ("orig" preferred, else largest numeric tier)
      chosen = list.reduce((best, cur) => (entryRank(cur) > entryRank(best) ? cur : best));
    } else if (minWidth === Infinity) {
      const orig = group.get("orig");
      if (orig) {
        chosen = orig;
      } else {
        chosen = list.reduce((best, cur) => (entryRank(cur) > entryRank(best) ? cur : best));
      }
    } else {
      // Smallest tier that satisfies `>= minWidth`
      const ge = list.filter((e) => satisfiesWidth(e, minWidth));
      if (ge.length > 0) {
        chosen = ge.reduce((best, cur) => (entryRank(cur) < entryRank(best) ? cur : best));
      } else {
        // Otherwise largest available cached tier as instant placeholder
        chosen = list.reduce((best, cur) => (entryRank(cur) > entryRank(best) ? cur : best));
      }
    }

    if (chosen) {
      chosen.lastUsed = this.stamp();
      this.hits++;
    }
    return chosen;
  }

  /** Return all currently cached tiers for `src` (ordered smallest -> largest). */
  tiersFor(src: string, origin = currentImageOrigin()): ImageTier[] {
    const group = this.bySrc.get(srcNamespace(src, origin));
    if (!group) return [];
    return [...group.keys()].sort((a, b) => (a === "orig" ? Infinity : a) - (b === "orig" ? Infinity : b));
  }

  /** Return the best cached tier to shed to while off-screen, or null if none smaller exists. */
  peekShed(src: string, currentTier: ImageTier, origin = currentImageOrigin()): CachedImageEntry | null {
    const tiers = this.tiersFor(src, origin);
    const target = pickShedTier(tiers, currentTier);
    if (target === null) return null;
    return this.getExact(src, target, origin);
  }

  put(src: string, tier: ImageTier, data: PutImageInput, origin = currentImageOrigin()): CachedImageEntry {
    const key = imageCacheKey(src, tier, origin);
    const ns = srcNamespace(src, origin);
    const existing = this.entries.get(key);

    if (existing) {
      existing.lastUsed = this.stamp();
      if (data.natural && !existing.natural) existing.natural = data.natural;
      if (data.alpha !== null && existing.alpha === null) existing.alpha = data.alpha;
      if (data.width > 0 && existing.width <= 0) existing.width = data.width;
      // Never swap out the URL of a pinned entry; mounted elements keep their live URL
      if (existing.refs === 0 && (data.url || data.blob)) {
        const nextUrl = data.url ?? this.createObjectUrl(data.blob!);
        if (nextUrl !== existing.url) {
          this.safeRevoke(existing.url);
          existing.url = nextUrl;
          this.totalBytes = Math.max(0, this.totalBytes - existing.bytes + data.bytes);
          existing.bytes = data.bytes;
        }
      }
      this.evictIfNeeded(existing.key);
      return existing;
    }

    const url = data.url ?? (data.blob ? this.createObjectUrl(data.blob) : "");
    const entry: InternalEntry = {
      key,
      ns,
      src,
      tier,
      url,
      bytes: Math.max(0, data.bytes),
      width: data.width,
      natural: data.natural,
      alpha: data.alpha,
      lastUsed: this.stamp(),
      refs: 0,
    };

    this.entries.set(key, entry);
    let group = this.bySrc.get(ns);
    if (!group) {
      group = new Map();
      this.bySrc.set(ns, group);
    }
    group.set(tier, entry);
    this.totalBytes += entry.bytes;
    this.evictIfNeeded(entry.key);
    return entry;
  }

  /** Pin an entry so it will never be evicted/revoked while mounted. Returns an idempotent release function. */
  retain(key: string): () => void {
    const entry = this.entries.get(key) ?? this.detached.get(key);
    if (!entry) return () => {};
    entry.refs++;
    entry.lastUsed = this.stamp();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.detached && entry.refs === 0) {
        this.detached.delete(entry.key);
        this.safeRevoke(entry.url);
        return;
      }
      if (entry.refs === 0) this.evictIfNeeded();
    };
  }

  evictIfNeeded(protectKey?: string): number {
    let evicted = 0;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      let oldest: InternalEntry | null = null;
      for (const e of this.entries.values()) {
        if (e.refs > 0 || e.key === protectKey) continue;
        if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
      }
      if (!oldest) break; // Every other entry is currently pinned
      this.removeEntry(oldest);
      this.safeRevoke(oldest.url);
      evicted++;
    }
    return evicted;
  }

  /** Clear L1 map and revoke all unpinned object URLs; pinned URLs are deferred until released. */
  clear(): void {
    for (const e of this.entries.values()) {
      if (e.refs === 0) {
        this.safeRevoke(e.url);
      } else {
        e.detached = true;
        this.detached.set(e.key, e);
      }
    }
    this.entries.clear();
    this.bySrc.clear();
    this.totalBytes = 0;
  }

  private removeEntry(e: InternalEntry): void {
    this.entries.delete(e.key);
    this.totalBytes = Math.max(0, this.totalBytes - e.bytes);
    const group = this.bySrc.get(e.ns);
    if (group) {
      group.delete(e.tier);
      if (group.size === 0) this.bySrc.delete(e.ns);
    }
  }

  private safeRevoke(url: string): void {
    if (!url || !url.startsWith("blob:")) return;
    try {
      this.revokeObjectUrl(url);
    } catch {
      /* already revoked or non-browser */
    }
  }
}

function entryRank(e: CachedImageEntry): number {
  if (e.tier === "orig") return Infinity;
  return e.tier;
}

function satisfiesWidth(e: CachedImageEntry, minWidth: number): boolean {
  if (e.tier === "orig") return true;
  if (e.tier >= minWidth) return true;
  // If we know the image's natural width is <= this tier, this tier is already full resolution
  if (e.natural && e.natural[0] > 0 && e.natural[0] <= e.tier) return true;
  return false;
}

// ---------- L2 Persistent Cache Storage ----------

const L2_ORIGIN = "https://image-cache.foundation.local";

export function l2CacheUrl(src: string, tier: ImageTier, origin = currentImageOrigin()): string {
  return `${L2_ORIGIN}/${encodeURIComponent(origin)}/${encodeURIComponent(src)}/${tier}`;
}

/**
 * The one cache, opened once per page (2026-11-24). Opened per read and per write, the opens raced, and WebKit (the
 * Mac app's engine) answered each racing open with a new cache of the same name: a studio's load left 79 caches
 * called v2, its pictures spread over them, and the next launch opened an empty one and fetched everything again.
 * The scattered v2 is let go the first time (each delete takes one of them).
 */
let l2Open: Promise<Cache | null> | null = null;
function openL2Cache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return Promise.resolve(null);
  l2Open ??= (async () => {
    try {
      for (let i = 0; i < 200 && (await caches.has(SCATTERED_CACHE_NAME)); i++) await caches.delete(SCATTERED_CACHE_NAME);
    } catch {
      /* letting go of old copies is a nicety */
    }
    try {
      return await caches.open(IMAGE_CACHE_NAME);
    } catch {
      return null;
    }
  })();
  return l2Open;
}

let l2Hits = 0;
let l2WritesSincePrune = 0;
let pruneRunning = false;

export async function readL2Image(src: string, tier: ImageTier, origin = currentImageOrigin()): Promise<L2Payload | null> {
  const cache = await openL2Cache();
  if (!cache) return null;
  try {
    const res = await cache.match(l2CacheUrl(src, tier, origin));
    if (!res) return null;
    const blob = await res.blob();
    const natW = Number(res.headers.get("x-f-nat-w") || 0);
    const natH = Number(res.headers.get("x-f-nat-h") || 0);
    const alphaRaw = res.headers.get("x-f-alpha");
    const alpha = alphaRaw === "1" ? true : alphaRaw === "0" ? false : null;
    const bytes = Number(res.headers.get("x-f-bytes") || blob.size);
    const width = Number(res.headers.get("x-f-w") || (tier === "orig" ? natW : tier));
    const at = Number(res.headers.get("x-f-at") || 0);
    l2Hits++;
    return {
      blob,
      bytes: bytes || blob.size,
      width,
      natural: natW > 0 && natH > 0 ? [natW, natH] : null,
      alpha,
      at,
    };
  } catch {
    return null;
  }
}

export async function writeL2Image(
  src: string,
  tier: ImageTier,
  payload: { blob: Blob; width: number; natural: [number, number] | null; alpha: boolean | null },
  origin = currentImageOrigin(),
): Promise<void> {
  const cache = await openL2Cache();
  if (!cache) return;
  try {
    const headers: Record<string, string> = {
      "content-type": payload.blob.type || "application/octet-stream",
      "x-f-bytes": String(payload.blob.size),
      "x-f-w": String(payload.width || (tier === "orig" ? (payload.natural?.[0] ?? 0) : tier)),
      "x-f-at": String(Date.now()),
    };
    if (payload.natural) {
      headers["x-f-nat-w"] = String(payload.natural[0]);
      headers["x-f-nat-h"] = String(payload.natural[1]);
    }
    if (payload.alpha !== null) {
      headers["x-f-alpha"] = payload.alpha ? "1" : "0";
    }
    await cache.put(l2CacheUrl(src, tier, origin), new Response(payload.blob, { headers }));
    l2WritesSincePrune++;
    if (l2WritesSincePrune >= 20 && !pruneRunning) {
      l2WritesSincePrune = 0;
      void pruneL2Cache().catch(() => {});
    }
  } catch {
    /* storage quota exceeded or private browsing */
  }
}

export async function pruneL2Cache(maxEntries = DEFAULT_L2_MAX_ENTRIES, maxBytes = DEFAULT_L2_MAX_BYTES): Promise<number> {
  if (pruneRunning) return 0;
  const cache = await openL2Cache();
  if (!cache) return 0;
  pruneRunning = true;
  try {
    const keys = await cache.keys();
    if (keys.length === 0) return 0;
    const metas: Array<{ req: Request; at: number; bytes: number }> = [];
    let totalBytes = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      if (!res) continue;
      const bytes = Number(res.headers.get("x-f-bytes") || 0);
      const at = Number(res.headers.get("x-f-at") || 0);
      totalBytes += bytes;
      metas.push({ req, at, bytes });
    }
    if (metas.length <= maxEntries && totalBytes <= maxBytes) return 0;
    // Evict oldest-used first down to 85% watermark to avoid thrashing on every write
    metas.sort((a, b) => a.at - b.at);
    const targetEntries = Math.floor(maxEntries * 0.85);
    const targetBytes = Math.floor(maxBytes * 0.85);
    let count = metas.length;
    let removed = 0;
    for (const item of metas) {
      if (count <= targetEntries && totalBytes <= targetBytes) break;
      await cache.delete(item.req);
      count--;
      totalBytes = Math.max(0, totalBytes - item.bytes);
      removed++;
    }
    return removed;
  } catch {
    return 0;
  } finally {
    pruneRunning = false;
  }
}

export async function clearL2Caches(): Promise<void> {
  if (typeof caches === "undefined") return;
  l2Open = null;
  resetByteCache();
  await Promise.allSettled([caches.delete(IMAGE_CACHE_NAME), caches.delete(SCATTERED_CACHE_NAME), caches.delete(LEGACY_LOD_CACHE_NAME), caches.delete(BYTE_CACHE_NAME)]);
}

// ---------- Priority Fetch Scheduler ----------

export interface ScheduleOptions {
  priority?: FetchPriority;
  distance?: number;
  signal?: AbortSignal;
}

interface Caller<T> {
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ScheduledJob<T> {
  key: string;
  large: boolean;
  priority: FetchPriority;
  distance: number;
  seq: number;
  started: boolean;
  controller: AbortController;
  task: (signal: AbortSignal) => Promise<T>;
  callers: Set<Caller<T>>;
}

function abortError(): Error {
  const err = new Error("Image fetch aborted");
  err.name = "AbortError";
  return err;
}

export class ImageFetchScheduler {
  private readonly maxSmall: number;
  private readonly maxLarge: number;
  private readonly jobs = new Map<string, ScheduledJob<unknown>>();
  private readonly queue: ScheduledJob<unknown>[] = [];
  private runningSmall = 0;
  private runningLarge = 0;
  private seq = 0;
  private startedCount = 0;

  constructor(opts: { maxSmall?: number; maxLarge?: number } = {}) {
    this.maxSmall = opts.maxSmall ?? MAX_SMALL_CONCURRENCY;
    this.maxLarge = opts.maxLarge ?? MAX_LARGE_CONCURRENCY;
  }

  get inFlightCount(): number {
    return this.runningSmall + this.runningLarge;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get fetchCount(): number {
    return this.startedCount;
  }

  schedule<T>(key: string, tier: ImageTier, task: (signal: AbortSignal) => Promise<T>, opts: ScheduleOptions = {}): Promise<T> {
    const priority: FetchPriority = opts.priority ?? 1;
    const distance = Number.isFinite(opts.distance) ? Math.max(0, opts.distance!) : 0;

    if (opts.signal?.aborted) {
      return Promise.reject(abortError());
    }

    const existing = this.jobs.get(key) as ScheduledJob<T> | undefined;
    if (existing) {
      // Elevate priority / distance if a higher-priority caller needs the same (src, tier)
      if (!existing.started) {
        if (priority < existing.priority || (priority === existing.priority && distance < existing.distance)) {
          existing.priority = priority;
          existing.distance = distance;
        }
      }
      return this.attachCaller(existing, opts.signal);
    }

    const large = tier === "orig" || tier >= 2048;
    const job: ScheduledJob<T> = {
      key,
      large,
      priority,
      distance,
      seq: ++this.seq,
      started: false,
      controller: new AbortController(),
      task,
      callers: new Set(),
    };

    this.jobs.set(key, job as ScheduledJob<unknown>);
    this.queue.push(job as ScheduledJob<unknown>);
    const promise = this.attachCaller(job, opts.signal);
    this.pump();
    return promise;
  }

  clear(): void {
    for (const job of this.jobs.values()) {
      job.controller.abort();
      for (const c of job.callers) {
        if (c.signal && c.onAbort) c.signal.removeEventListener("abort", c.onAbort);
        c.reject(abortError());
      }
      job.callers.clear();
    }
    this.jobs.clear();
    this.queue.length = 0;
  }

  private attachCaller<T>(job: ScheduledJob<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const caller: Caller<T> = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          job.callers.delete(caller);
          signal.removeEventListener("abort", onAbort);
          reject(abortError());
          // Only cancel the shared job when EVERY caller waiting on it has aborted
          if (job.callers.size === 0) {
            this.cancelJob(job as ScheduledJob<unknown>);
          }
        };
        caller.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      job.callers.add(caller);
    });
  }

  private cancelJob(job: ScheduledJob<unknown>): void {
    if (!job.started) {
      const idx = this.queue.indexOf(job);
      if (idx >= 0) this.queue.splice(idx, 1);
      this.jobs.delete(job.key);
    }
    job.controller.abort();
  }

  private pump(): void {
    if (this.queue.length === 0) return;

    // Sort highest priority first (0 < 1 < 2), tie-break by center distance, then FIFO seq
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.seq - b.seq;
    });

    for (let i = 0; i < this.queue.length; ) {
      const job = this.queue[i];
      const hasSlot = job.large ? this.runningLarge < this.maxLarge : this.runningSmall < this.maxSmall;
      if (!hasSlot) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      if (job.callers.size === 0 || job.controller.signal.aborted) {
        this.jobs.delete(job.key);
        continue;
      }
      this.startJob(job);
    }
  }

  private startJob(job: ScheduledJob<unknown>): void {
    job.started = true;
    this.startedCount++;
    if (job.large) this.runningLarge++;
    else this.runningSmall++;

    let run: Promise<unknown>;
    try {
      run = Promise.resolve(job.task(job.controller.signal));
    } catch (err) {
      run = Promise.reject(err);
    }

    void run
      .then(
        (result) => {
          this.jobs.delete(job.key);
          for (const c of job.callers) {
            if (c.signal && c.onAbort) c.signal.removeEventListener("abort", c.onAbort);
            c.resolve(result);
          }
          job.callers.clear();
        },
        (err) => {
          this.jobs.delete(job.key);
          for (const c of job.callers) {
            if (c.signal && c.onAbort) c.signal.removeEventListener("abort", c.onAbort);
            c.reject(err);
          }
          job.callers.clear();
        },
      )
      .finally(() => {
        if (job.large) this.runningLarge = Math.max(0, this.runningLarge - 1);
        else this.runningSmall = Math.max(0, this.runningSmall - 1);
        this.pump();
      });
  }
}

// ---------- Default singletons & public API ----------

const defaultL1 = new ImageLruCache();
const defaultScheduler = new ImageFetchScheduler();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function subscribeImageCache(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Synchronous L1 lookup: smallest cached tier >= minWidth, or largest available cached tier as instant placeholder. */
export function peekCachedImage(src: string, minWidth?: number): CachedImageEntry | null {
  return defaultL1.peek(src, minWidth);
}

/** Synchronous exact-tier L1 lookup. */
export function peekExactImage(src: string, tier: ImageTier): CachedImageEntry | null {
  return defaultL1.getExact(src, tier);
}

/** Synchronous lookup of a smaller cached tier for off-screen VRAM shedding. */
export function peekShedImage(src: string, currentTier: ImageTier): CachedImageEntry | null {
  return defaultL1.peekShed(src, currentTier);
}

/** Store a decoded/fetched tier in L1 (and notify subscribers). */
export function putCachedImage(src: string, tier: ImageTier, data: PutImageInput): CachedImageEntry {
  const entry = defaultL1.put(src, tier, data);
  notify();
  return entry;
}

/** Pin an L1 entry so it cannot be revoked while an <img> renders it. Returns release(). */
export function retainCachedImage(key: string): () => void {
  return defaultL1.retain(key);
}

/** Return cached tiers currently resident in L1 for `src`. */
export function cachedTiersFor(src: string): ImageTier[] {
  return defaultL1.tiersFor(src);
}

/** Schedule a deduplicated, prioritized, abortable fetch for `(src, tier)`. */
export function scheduleImageFetch<T>(
  src: string,
  tier: ImageTier,
  task: (signal: AbortSignal) => Promise<T>,
  opts: ScheduleOptions = {},
): Promise<T> {
  const key = imageCacheKey(src, tier);
  return defaultScheduler.schedule(key, tier, task, opts);
}

// ---------- Versioned and derived pictures ----------

/**
 * `src` naming one version of what's behind it (`?v=<version>`): a character's picture is asked for by role
 * (`/api/characters/:id/files/front`), and the role's file changes when a stage is pressed again. The version (the
 * file's id) makes that a new key in L1 and L2, so nothing kept from before is shown for the new picture. The server
 * ignores the parameter.
 */
export function withVersion(src: string, version: string | null | undefined): string {
  if (!version || isLocalDataUrl(src)) return src;
  const hashIdx = src.indexOf("#");
  const base = hashIdx >= 0 ? src.slice(0, hashIdx) : src;
  const hash = hashIdx >= 0 ? src.slice(hashIdx) : "";
  if (/[?&]v=/.test(base)) return src;
  return `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}${hash}`;
}

/**
 * The key of a picture made here from something else (a still with its ground cut away, a 3D character drawn once):
 * `kind` says what was made, `parts` everything the result depends on (the file's id, the size, the framing), so a
 * change in any of them is a different picture and the old one is simply never asked for again (it ages out of the
 * LRU). Never a server path: nothing fetches it.
 */
export function derivedImageSrc(kind: string, parts: ReadonlyArray<string | number>): string {
  return `derived:${kind}/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
}

export function isDerivedImageSrc(src: string): boolean {
  return src.startsWith("derived:");
}

export interface DerivedImage {
  blob: Blob;
  width: number;
  natural: [number, number] | null;
  alpha: boolean | null;
}

const derivedInFlight = new Map<string, Promise<CachedImageEntry | null>>();

/**
 * A made picture, from memory, else from the persistent cache, else made now (once, however many ask) and kept in
 * both. `make` returning null means it can't be made here (no WebGL, no worker): nothing is kept and the caller shows
 * what it had.
 */
export function loadDerivedImage(src: string, make: () => Promise<DerivedImage | null>): Promise<CachedImageEntry | null> {
  const hit = defaultL1.getExact(src, "orig");
  if (hit) return Promise.resolve(hit);
  const key = imageCacheKey(src, "orig");
  let p = derivedInFlight.get(key);
  if (!p) {
    p = (async () => {
      const kept = await readL2Image(src, "orig");
      if (kept) return putCachedImage(src, "orig", { blob: kept.blob, bytes: kept.bytes, width: kept.width, natural: kept.natural, alpha: kept.alpha });
      const made = await make();
      if (!made) return null;
      const entry = putCachedImage(src, "orig", { blob: made.blob, bytes: made.blob.size, width: made.width, natural: made.natural, alpha: made.alpha });
      void writeL2Image(src, "orig", made);
      return entry;
    })()
      .catch(() => null)
      .finally(() => derivedInFlight.delete(key));
    derivedInFlight.set(key, p);
  }
  return p;
}

/** Current live diagnostics for `#/design` and debugging. */
export function getImageCacheStats(): ImageCacheStats {
  return {
    l1Entries: defaultL1.size,
    l1Bytes: defaultL1.bytes,
    l1Pinned: defaultL1.pinnedCount(),
    l1Hits: defaultL1.hitCount,
    l2Hits,
    networkFetches: defaultScheduler.fetchCount,
    inFlight: defaultScheduler.inFlightCount,
    queued: defaultScheduler.queuedCount,
  };
}

/**
 * Purge L1 + L2 caches and abort in-flight image fetches.
 * Called on `logout()` in `api.ts` so private images are never left on a shared device.
 */
export async function clearImageCache(): Promise<void> {
  defaultScheduler.clear();
  defaultL1.clear();
  await clearL2Caches();
  notify();
}

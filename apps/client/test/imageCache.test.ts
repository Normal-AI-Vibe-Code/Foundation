import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearImageCache,
  IMAGE_CACHE_NAME,
  ImageFetchScheduler,
  ImageLruCache,
  LEGACY_LOD_CACHE_NAME,
  peekCachedImage,
  pickShedTier,
  SCATTERED_CACHE_NAME,
  pruneL2Cache,
  putCachedImage,
  readL2Image,
  snapLodTier,
  snapServerTier,
  withWidthParam,
  writeL2Image,
} from "../src/lib/imageCache";

// ---------- L1 LRU & Ref-count protection ----------

test("L1 LRU evicts oldest unpinned entries by count and byte budget and revokes their URLs", () => {
  const revoked: string[] = [];
  let seq = 0;
  let clock = 1000;
  const cache = new ImageLruCache({
    maxEntries: 3,
    maxBytes: 1000,
    createObjectUrl: () => `blob:test/${++seq}`,
    revokeObjectUrl: (u) => revoked.push(u),
    now: () => ++clock,
  });

  const a = cache.put("/files/a", 256, { url: "blob:a", bytes: 300, width: 256, natural: [1000, 800], alpha: false });
  const b = cache.put("/files/b", 256, { url: "blob:b", bytes: 300, width: 256, natural: [1000, 800], alpha: false });
  const c = cache.put("/files/c", 256, { url: "blob:c", bytes: 300, width: 256, natural: [1000, 800], alpha: false });

  // Touch `a` so `b` becomes the least recently used
  assert.equal(cache.peek("/files/a", 256)?.url, a.url);

  // Adding `d` exceeds maxEntries (3) and maxBytes (1000) -> evicts `b` first, then `c` to fit under 1000 bytes
  cache.put("/files/d", 256, { url: "blob:d", bytes: 500, width: 256, natural: [1000, 800], alpha: false });

  assert.equal(cache.getExact("/files/b", 256), null, "oldest entry evicted");
  assert.equal(cache.getExact("/files/c", 256), null, "second oldest evicted for byte budget");
  assert.equal(cache.getExact("/files/a", 256)?.url, a.url, "recently touched entry retained");
  assert.equal(cache.getExact("/files/d", 256)?.url, "blob:d", "new entry retained");
  assert.deepEqual(revoked, [b.url, c.url]);
  assert.equal(cache.bytes, 800);
});

test("L1 ref-count protection never revokes a pinned URL until released", () => {
  const revoked: string[] = [];
  let clock = 2000;
  const cache = new ImageLruCache({
    maxEntries: 2,
    maxBytes: 500,
    revokeObjectUrl: (u) => revoked.push(u),
    now: () => ++clock,
  });

  const pinned = cache.put("/files/hero", 512, { url: "blob:hero", bytes: 400, width: 512, natural: [2000, 1200], alpha: false });
  const release = cache.retain(pinned.key);

  const o1 = cache.put("/files/o1", 256, { url: "blob:o1", bytes: 200, width: 256, natural: null, alpha: null });
  // Newly inserted o1 is protected during its own put(); pinned hero is protected by refs=1
  assert.equal(cache.getExact("/files/hero", 512)?.url, "blob:hero", "pinned hero stays alive");
  assert.equal(cache.getExact("/files/o1", 256)?.url, o1.url, "newly inserted entry survives its own put");
  assert.ok(!revoked.includes("blob:hero"), "pinned URL never revoked");

  // Putting o2 evicts unpinned o1 (never pinned hero!)
  cache.put("/files/o2", 256, { url: "blob:o2", bytes: 400, width: 256, natural: null, alpha: null });
  assert.equal(cache.getExact("/files/hero", 512)?.url, "blob:hero", "pinned hero still alive");
  assert.equal(cache.getExact("/files/o1", 256), null, "unpinned o1 evicted instead of pinned hero");
  assert.deepEqual(revoked, [o1.url]);

  // Touch o2 so hero is older than o2, then release hero while over byte budget (800 > 500)
  assert.equal(cache.getExact("/files/o2", 256)?.url, "blob:o2");
  release();
  release(); // idempotent second release must not throw or double-revoke
  assert.equal(cache.getExact("/files/hero", 512), null, "evicted once unpinned while over budget");
  assert.deepEqual(revoked, [o1.url, "blob:hero"], "revoked exactly once");
});

test("L1 clear() revokes unpinned immediately and defers pinned until released", () => {
  const revoked: string[] = [];
  const cache = new ImageLruCache({ revokeObjectUrl: (u) => revoked.push(u) });

  const unpinned = cache.put("/files/u", 256, { url: "blob:u", bytes: 100, width: 256, natural: null, alpha: null });
  const pinned = cache.put("/files/p", 256, { url: "blob:p", bytes: 100, width: 256, natural: null, alpha: null });
  const release = cache.retain(pinned.key);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.peek("/files/p"), null, "cleared from L1 map immediately");
  assert.deepEqual(revoked, [unpinned.url], "only unpinned revoked immediately");

  release();
  assert.deepEqual(revoked, [unpinned.url, pinned.url], "pinned revoked once component unmounts");
});

// ---------- Tier selection & VRAM shedding ----------

test("peek() picks smallest tier >= minWidth or largest available placeholder", () => {
  const cache = new ImageLruCache();
  cache.put("/files/pic", 64, { url: "blob:64", bytes: 1200, width: 64, natural: [4000, 3000], alpha: false });
  cache.put("/files/pic", 256, { url: "blob:256", bytes: 12000, width: 256, natural: [4000, 3000], alpha: false });
  cache.put("/files/pic", 1024, { url: "blob:1024", bytes: 90000, width: 1024, natural: [4000, 3000], alpha: false });

  assert.equal(cache.peek("/files/pic", 50)?.tier, 64);
  assert.equal(cache.peek("/files/pic", 200)?.tier, 256);
  assert.equal(cache.peek("/files/pic", 300)?.tier, 1024, "smallest tier >= 300 is 1024");
  assert.equal(cache.peek("/files/pic", 2048)?.tier, 1024, "largest available placeholder when 2048 not cached");
  assert.equal(cache.peek("/files/pic", Infinity)?.tier, 1024, "lightbox gets largest cached tier immediately");

  // Once original lands, Infinity returns orig
  cache.put("/files/pic", "orig", { url: "blob:orig", bytes: 900000, width: 4000, natural: [4000, 3000], alpha: false });
  assert.equal(cache.peek("/files/pic", Infinity)?.tier, "orig");
});

test("tier snapping, URL param building, and off-screen VRAM shedding logic", () => {
  assert.equal(snapServerTier(40), 64);
  assert.equal(snapServerTier(64), 64);
  assert.equal(snapServerTier(180), 256);
  assert.equal(snapServerTier(512), 512);
  assert.equal(snapServerTier(1400), 2048);
  assert.equal(snapServerTier(3000), "orig");

  assert.equal(snapLodTier(40), 256);
  assert.equal(snapLodTier(500), 512);
  assert.equal(snapLodTier(2500), "orig");

  assert.equal(withWidthParam("/files/abc", 256), "/files/abc?w=256");
  assert.equal(withWidthParam("/files/abc?v=1", 512), "/files/abc?v=1&w=512");
  assert.equal(withWidthParam("/files/abc?v=1#top", 64), "/files/abc?v=1&w=64#top");
  assert.equal(withWidthParam("/files/abc", "orig"), "/files/abc");

  // VRAM shedding prefers 64 when available, else 256 when currently > 256, else null
  assert.equal(pickShedTier([64, 256, 1024], 1024), 64);
  assert.equal(pickShedTier([64, 512], "orig"), 64);
  assert.equal(pickShedTier([256, 1024], 1024), 256);
  assert.equal(pickShedTier([256, 1024], 256), null);
  assert.equal(pickShedTier([64, 256], 64), null);

  // Shedding via L1 preserves high tier in cache for instant pan-back
  const cache = new ImageLruCache();
  cache.put("/files/board-img", 64, { url: "blob:64", bytes: 1000, width: 64, natural: [2000, 1500], alpha: false });
  cache.put("/files/board-img", 1024, { url: "blob:1024", bytes: 80000, width: 1024, natural: [2000, 1500], alpha: false });
  assert.equal(cache.peekShed("/files/board-img", 1024)?.tier, 64, "sheds displayed texture to 64");
  assert.equal(cache.peek("/files/board-img", 1024)?.tier, 1024, "1024 remains cached in L1 for zero-refetch return");
});

// ---------- Priority Fetch Scheduler & Cancellation ----------

test("PriorityQueue orders visible before background, tie-breaks by center distance, and honors AbortSignal", async () => {
  // Single slot so queued order is strictly deterministic
  const scheduler = new ImageFetchScheduler({ maxSmall: 1, maxLarge: 1 });
  const started: string[] = [];
  const gates = new Map<string, () => void>();

  const makeTask = (label: string) => () =>
    new Promise<string>((resolve) => {
      started.push(label);
      gates.set(label, () => resolve(label));
    });

  // 1. Occupy the single running slot
  const pBlocker = scheduler.schedule("k:blocker", 256, makeTask("blocker"), { priority: 0, distance: 0 });
  assert.deepEqual(started, ["blocker"]);

  // 2. Queue jobs in reverse priority/distance order
  const pBg = scheduler.schedule("k:bg", 256, makeTask("bg"), { priority: 2, distance: 10 });
  const pNear = scheduler.schedule("k:near", 256, makeTask("near"), { priority: 1, distance: 5 });
  const pFarVis = scheduler.schedule("k:far-vis", 256, makeTask("far-vis"), { priority: 0, distance: 420 });
  const pCloseVis = scheduler.schedule("k:close-vis", 256, makeTask("close-vis"), { priority: 0, distance: 45 });

  // 3. Queue a job that will be aborted before starting (card panned off-screen)
  const offscreenCtrl = new AbortController();
  const pOffscreen = scheduler.schedule("k:offscreen", 256, makeTask("offscreen"), {
    priority: 0,
    distance: 10,
    signal: offscreenCtrl.signal,
  });
  offscreenCtrl.abort();
  await assert.rejects(pOffscreen, { name: "AbortError" });

  // Drain jobs one by one
  const drain = async (label: string) => {
    await new Promise((r) => setTimeout(r, 0));
    const release = gates.get(label);
    assert.ok(release, `expected ${label} to have started; started=${started.join(",")}`);
    release();
  };

  await drain("blocker");
  await pBlocker;
  await drain("close-vis");
  await pCloseVis;
  await drain("far-vis");
  await pFarVis;
  await drain("near");
  await pNear;
  await drain("bg");
  await pBg;

  assert.deepEqual(started, ["blocker", "close-vis", "far-vis", "near", "bg"], "strict priority + distance ordering, aborted job skipped");
});

test("Scheduler deduplicates concurrent callers and only aborts in-flight fetch when all callers abort", async () => {
  const scheduler = new ImageFetchScheduler({ maxSmall: 5, maxLarge: 2 });
  let taskCalls = 0;
  let underlyingAborted = false;
  let finish!: (val: string) => void;

  const task = (signal: AbortSignal) => {
    taskCalls++;
    return new Promise<string>((resolve, reject) => {
      finish = resolve;
      signal.addEventListener("abort", () => {
        underlyingAborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  };

  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = scheduler.schedule("same-key", 512, task, { priority: 1, signal: c1.signal });
  const p2 = scheduler.schedule("same-key", 512, task, { priority: 0, signal: c2.signal });

  assert.equal(taskCalls, 1, "deduplicated to a single underlying fetch");

  // Abort caller 1: caller 2 still waits, so underlying fetch stays alive
  c1.abort();
  await assert.rejects(p1, { name: "AbortError" });
  assert.equal(underlyingAborted, false, "in-flight fetch stays alive for remaining caller");

  finish("ok-512");
  assert.equal(await p2, "ok-512");

  // Now verify aborting ALL callers aborts the underlying fetch
  underlyingAborted = false;
  const c3 = new AbortController();
  const p3 = scheduler.schedule("cancel-all", 512, task, { priority: 0, signal: c3.signal });
  c3.abort();
  await assert.rejects(p3, { name: "AbortError" });
  assert.equal(underlyingAborted, true, "underlying fetch aborted when last caller aborted");
});

test("Scheduler enforces separate concurrency limits (5 small vs 2 large)", async () => {
  const scheduler = new ImageFetchScheduler({ maxSmall: 5, maxLarge: 2 });
  let activeSmall = 0;
  let maxActiveSmall = 0;
  let activeLarge = 0;
  let maxActiveLarge = 0;

  const runSmall = (i: number) =>
    scheduler.schedule(`s:${i}`, 512, async () => {
      activeSmall++;
      maxActiveSmall = Math.max(maxActiveSmall, activeSmall);
      await new Promise((r) => setTimeout(r, 15));
      activeSmall--;
      return i;
    });

  const runLarge = (i: number) =>
    scheduler.schedule(`l:${i}`, "orig", async () => {
      activeLarge++;
      maxActiveLarge = Math.max(maxActiveLarge, activeLarge);
      await new Promise((r) => setTimeout(r, 15));
      activeLarge--;
      return i;
    });

  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => runSmall(i)),
    ...Array.from({ length: 5 }, (_, i) => runLarge(i)),
  ]);

  assert.ok(maxActiveSmall <= 5 && maxActiveSmall >= 4, `small concurrency bounded at 5 (saw ${maxActiveSmall})`);
  assert.equal(maxActiveLarge, 2, "large concurrency bounded at 2");
});

// ---------- L2 Cache Storage & clearImageCache ----------

test("L2 metadata round-trip, bounded LRU pruning, and clearImageCache() purge L1 + L2", async () => {
  // Minimal in-memory CacheStorage stub for Node test environment
  const stores = new Map<string, Map<string, Response>>();
  const deletedNames: string[] = [];

  const mockCaches = {
    async open(name: string) {
      let map = stores.get(name);
      if (!map) {
        map = new Map();
        stores.set(name, map);
      }
      return {
        async match(req: string | Request) {
          const k = typeof req === "string" ? req : req.url;
          const r = map!.get(k);
          return r ? r.clone() : undefined;
        },
        async put(req: string | Request, res: Response) {
          const k = typeof req === "string" ? req : req.url;
          map!.set(k, res.clone());
        },
        async delete(req: string | Request) {
          const k = typeof req === "string" ? req : req.url;
          return map!.delete(k);
        },
        async keys() {
          return [...map!.keys()].map((u) => new Request(u));
        },
      } as unknown as Cache;
    },
    async delete(name: string) {
      deletedNames.push(name);
      return stores.delete(name);
    },
  } as unknown as CacheStorage;

  const prevCaches = (globalThis as { caches?: CacheStorage }).caches;
  (globalThis as { caches?: CacheStorage }).caches = mockCaches;

  try {
    // Seed legacy cache too so we verify clearImageCache removes it
    await mockCaches.open(LEGACY_LOD_CACHE_NAME);

    // Write & read L2 with metadata headers
    const blob = new Blob([new Uint8Array(64)], { type: "image/jpeg" });
    await writeL2Image("/files/photo1", 512, { blob, width: 512, natural: [2048, 1536], alpha: false });
    const read = await readL2Image("/files/photo1", 512);
    assert.ok(read);
    assert.deepEqual(read.natural, [2048, 1536]);
    assert.equal(read.alpha, false);
    assert.equal(read.width, 512);
    assert.equal(read.bytes, 64);

    // Write a few more entries and verify bounded LRU pruning trims oldest entries
    for (let i = 2; i <= 6; i++) {
      await new Promise((r) => setTimeout(r, 2));
      await writeL2Image(`/files/photo${i}`, 256, { blob, width: 256, natural: [1000, 800], alpha: false });
    }
    const removed = await pruneL2Cache(4, 10_000);
    assert.ok(removed >= 2, `pruned oldest entries when over maxEntries (removed=${removed})`);

    // Put in L1 singleton, then clearImageCache()
    putCachedImage("/files/private", 256, { url: "blob:private", bytes: 500, width: 256, natural: [800, 600], alpha: false });
    assert.ok(peekCachedImage("/files/private", 256));

    await clearImageCache();

    assert.equal(peekCachedImage("/files/private", 256), null, "L1 cleared");
    assert.ok(deletedNames.includes(IMAGE_CACHE_NAME), "the image Cache Storage deleted");
    assert.ok(deletedNames.includes(LEGACY_LOD_CACHE_NAME), "legacy v1 Cache Storage deleted");
    assert.equal(stores.size, 0, "no caches remain after logout clear");
  } finally {
    if (prevCaches === undefined) delete (globalThis as { caches?: CacheStorage }).caches;
    else (globalThis as { caches?: CacheStorage }).caches = prevCaches;
  }
});

test("L2 is opened once per page: racing reads and writes all land in one cache, and WebKit's scattered v2 copies go (2026-11-24)", async () => {
  // WebKit's worst case: every open makes a new cache of that name; has/delete see the copies one at a time
  const copies: Array<{ name: string; map: Map<string, Response> }> = [];
  let opens = 0;
  const cacheOf = (map: Map<string, Response>) =>
    ({
      async match(req: string | Request) {
        const r = map.get(typeof req === "string" ? req : req.url);
        return r ? r.clone() : undefined;
      },
      async put(req: string | Request, res: Response) {
        map.set(typeof req === "string" ? req : req.url, res.clone());
      },
      async delete(req: string | Request) {
        return map.delete(typeof req === "string" ? req : req.url);
      },
      async keys() {
        return [...map.keys()].map((u) => new Request(u));
      },
    }) as unknown as Cache;
  const mockCaches = {
    async open(name: string) {
      opens++;
      const copy = { name, map: new Map<string, Response>() };
      copies.push(copy);
      return cacheOf(copy.map);
    },
    async has(name: string) {
      return copies.some((c) => c.name === name);
    },
    async delete(name: string) {
      const i = copies.findIndex((c) => c.name === name);
      if (i < 0) return false;
      copies.splice(i, 1);
      return true;
    },
  } as unknown as CacheStorage;
  const prevCaches = (globalThis as { caches?: CacheStorage }).caches;
  (globalThis as { caches?: CacheStorage }).caches = mockCaches;
  try {
    await clearImageCache(); // a fresh page: nothing opened yet
    for (let i = 0; i < 5; i++) copies.push({ name: SCATTERED_CACHE_NAME, map: new Map() });
    opens = 0;
    const blob = new Blob([new Uint8Array(32)], { type: "image/jpeg" });
    await Promise.all(Array.from({ length: 12 }, (_, i) => writeL2Image(`/files/p${i}`, 256, { blob, width: 256, natural: [900, 600], alpha: false })));
    const reads = await Promise.all(Array.from({ length: 12 }, (_, i) => readL2Image(`/files/p${i}`, 256)));
    assert.equal(opens, 1, "one open for every read and write");
    assert.ok(
      reads.every((r) => r && r.bytes === 32),
      "every picture written is read back",
    );
    assert.equal(copies.filter((c) => c.name === SCATTERED_CACHE_NAME).length, 0, "the scattered v2 copies are let go");
    assert.equal(copies.filter((c) => c.name === IMAGE_CACHE_NAME).length, 1, "one cache of the current name");
  } finally {
    await clearImageCache();
    if (prevCaches === undefined) delete (globalThis as { caches?: CacheStorage }).caches;
    else (globalThis as { caches?: CacheStorage }).caches = prevCaches;
  }
});

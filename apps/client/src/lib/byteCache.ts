/**
 * Bytes kept between launches (2026-11-24): a character's mesh avatar and clips, a megabyte or more each, fetched
 * again on every launch of the Mac app, whose WebKit didn't answer them from its HTTP cache though the server marks
 * them immutable. Kept in Cache Storage under a key that names the file's content (a new file is a new key), opened
 * once per page (WebKit makes a cache per racing open; imageCache.ts), at most MAX_ENTRIES and MAX_BYTES, oldest
 * first out, and wiped with the image cache when someone signs out (clearL2Caches).
 */

export const BYTE_CACHE_NAME = "foundation-byte-cache-v1";
const KEY_ORIGIN = "https://byte-cache.foundation.local";
const MAX_ENTRIES = 120;
const MAX_BYTES = 256 * 1024 * 1024;

let open: Promise<Cache | null> | null = null;
function openByteCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return Promise.resolve(null);
  open ??= caches.open(BYTE_CACHE_NAME).catch(() => null);
  return open;
}

/** forget the open cache (after it's deleted) */
export function resetByteCache() {
  open = null;
}

const keyUrl = (key: string) => `${KEY_ORIGIN}/${encodeURIComponent(key)}`;

/** the bytes under `key`: from the cache when they're there, else fetched once and kept */
export async function cachedBytes(key: string, fetchBytes: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  const cache = await openByteCache();
  if (cache) {
    try {
      const hit = await cache.match(keyUrl(key));
      if (hit) return await hit.arrayBuffer();
    } catch {
      /* a miss */
    }
  }
  const buf = await fetchBytes();
  if (cache) void keep(cache, key, buf);
  return buf;
}

let writes = 0;
async function keep(cache: Cache, key: string, buf: ArrayBuffer) {
  try {
    await cache.put(keyUrl(key), new Response(buf.slice(0), { headers: { "x-f-bytes": String(buf.byteLength) } }));
    if (++writes % 10 === 0) await prune(cache);
  } catch {
    /* over quota, or storage refused: it's only a cache */
  }
}

/** oldest first out (Cache Storage keeps keys in the order they were put) */
async function prune(cache: Cache) {
  const keys = await cache.keys();
  const sizes = await Promise.all(keys.map(async (k) => Number((await cache.match(k))?.headers.get("x-f-bytes") ?? 0)));
  let total = sizes.reduce((a, b) => a + b, 0);
  let count = keys.length;
  for (let i = 0; i < keys.length && (count > MAX_ENTRIES || total > MAX_BYTES); i++) {
    await cache.delete(keys[i]);
    count--;
    total -= sizes[i];
  }
}

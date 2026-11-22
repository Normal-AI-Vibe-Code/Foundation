/**
 * Server-side image probing, bounded downscaling (LOD pyramid), and LRU disk caching.
 *
 * Pure JS/TS (no child_process, worker_threads, or cluster) so the server bundles into
 * a single .mjs file via esbuild. Cached variants live under `<dataDir>/cache/images`
 * and never touch the content-addressed archive in `data/files/`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, open, readFile, rename, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import { config } from "./config.ts";

export const SERVER_LOD_WIDTHS = [64, 256, 512, 1024, 2048] as const;

const MAX_IMAGE_PIXELS = 64_000_000;
const MAX_IMAGE_DIM = 16_384;
const MAX_CONCURRENT_DECODES = 2;

export type ImageFormat = "jpeg" | "png" | "webp" | "gif";

export interface ImageProbe {
  width: number;
  height: number;
  alpha: boolean;
  format: ImageFormat;
}

export interface VariantResult {
  path: string;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  alpha: boolean;
  size: number;
  tier: number;
  cached: boolean;
}

/**
 * Snap a requested display width to a fixed server LOD tier so arbitrary `?w=`
 * query parameters cannot cause cache-busting DoS.
 */
export function snapWidth(requested: number): number | null {
  if (!Number.isFinite(requested) || requested <= 0) return null;
  for (const tier of SERVER_LOD_WIDTHS) {
    if (tier >= requested) return tier;
  }
  return SERVER_LOD_WIDTHS[SERVER_LOD_WIDTHS.length - 1];
}

function isSafeDimensions(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIM &&
    height <= MAX_IMAGE_DIM &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

/**
 * Fast header-only parser (< 0.1 ms, zero pixel decode) for PNG, JPEG, GIF, and WebP.
 * Returns null if the buffer doesn't match a supported raster header.
 */
export function probeImage(buf: Buffer, _mime?: string): ImageProbe | null {
  if (buf.length < 10) return null;

  // PNG: 8-byte signature + IHDR chunk (bytes 16..24 width/height, byte 25 colorType)
  if (
    buf.length >= 26 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    const ihdrLen = buf.readUInt32BE(8);
    if (ihdrLen < 13 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    const colorType = buf[25];
    let alpha = colorType === 4 || colorType === 6;
    if (!alpha) {
      // Check ancillary chunks before IDAT for tRNS transparency
      let offset = 8;
      while (offset + 8 <= buf.length) {
        const len = buf.readUInt32BE(offset);
        const type = buf.toString("ascii", offset + 4, offset + 8);
        if (type === "tRNS") {
          alpha = true;
          break;
        }
        if (type === "IDAT" || type === "IEND") break;
        if (len > 0x7fffffff) break;
        const next = offset + 12 + len;
        if (next <= offset || next > buf.length) break;
        offset = next;
      }
    }
    return { width, height, alpha, format: "png" };
  }

  // GIF: GIF87a / GIF89a + LE uint16 width/height at bytes 6..10
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    if (width <= 0 || height <= 0) return null;
    return { width, height, alpha: true, format: "gif" };
  }

  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (
    buf.length >= 25 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 " && buf.length >= 30) {
      // Lossy VP8 bitstream: keyframe has bit 0 of frame tag == 0 and start code 9d 01 2a at 23..26
      if ((buf[20] & 1) === 0 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        if (width > 0 && height > 0) return { width, height, alpha: false, format: "webp" };
      }
      return null;
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      if (buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      const alpha = Boolean((bits >> 28) & 1);
      if (width > 0 && height > 0) return { width, height, alpha, format: "webp" };
      return null;
    }
    if (chunk === "VP8X" && buf.length >= 30) {
      const flags = buf[20];
      const alpha = Boolean(flags & 0x10);
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      if (width > 0 && height > 0) return { width, height, alpha, format: "webp" };
      return null;
    }
    return null;
  }

  // JPEG: SOI (FF D8) + walk markers for SOF0/SOF1/SOF2/SOF3
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos < buf.length) {
      while (pos < buf.length && buf[pos] !== 0xff) pos++;
      while (pos < buf.length && buf[pos] === 0xff) pos++;
      if (pos >= buf.length) break;
      const marker = buf[pos++];
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (pos + 2 > buf.length) break;
      const segLen = buf.readUInt16BE(pos);
      if (segLen < 2 || pos + segLen > buf.length) break;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
        if (segLen >= 7 && pos + 7 <= buf.length) {
          const height = buf.readUInt16BE(pos + 3);
          const width = buf.readUInt16BE(pos + 5);
          if (width > 0 && height > 0) return { width, height, alpha: false, format: "jpeg" };
        }
        break;
      }
      pos += segLen;
    }
  }

  return null;
}

/** Read only the header of an image file on disk (64 KB first, full read only if a JPEG has large EXIF/ICC before SOF). */
export async function probeImageFile(filePath: string, mime?: string): Promise<ImageProbe | null> {
  try {
    const fh = await open(filePath, "r");
    try {
      const head = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      const slice = head.subarray(0, bytesRead);
      const probed = probeImage(slice, mime);
      if (probed) return probed;
      // Only retry full read if it starts like a JPEG whose SOF marker sits past 64 KB
      if (bytesRead === head.length && slice[0] === 0xff && slice[1] === 0xd8) {
        const st = await fh.stat();
        if (st.size <= 32 * 1024 * 1024) {
          const full = await readFile(filePath);
          return probeImage(full, mime);
        }
      }
      return null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

// ---------- cache paths & LRU ----------

const SHA256_RE = /^[0-9a-f]{64}$/i;

function normalizeSha256(sha256: string): string | null {
  return SHA256_RE.test(sha256) ? sha256.toLowerCase() : null;
}

function cacheRoot(): string {
  return join(config.dataDir, "cache", "images");
}

function cacheBudgetBytes(): number {
  const mb = Number(process.env.FOUNDATION_IMAGE_CACHE_MB || 512);
  return (Number.isFinite(mb) && mb > 0 ? mb : 512) * 1024 * 1024;
}

function variantPath(sha256: string, tier: number, ext: "jpg" | "png"): string {
  const safe = normalizeSha256(sha256);
  if (!safe) throw new Error("invalid sha256");
  return join(cacheRoot(), safe, `${tier}.${ext}`);
}

interface CacheEntry {
  path: string;
  dir: string;
  size: number;
  mtimeMs: number;
}

function collectCacheEntries(): { entries: CacheEntry[]; totalBytes: number } {
  const root = cacheRoot();
  if (!existsSync(root)) return { entries: [], totalBytes: 0 };
  const entries: CacheEntry[] = [];
  let totalBytes = 0;
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return { entries, totalBytes };
  }
  for (const d of dirs) {
    const dirPath = join(root, d);
    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".part")) continue;
      const p = join(dirPath, f);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        entries.push({ path: p, dir: dirPath, size: st.size, mtimeMs: st.mtimeMs });
        totalBytes += st.size;
      } catch {
        /* ignore disappearing files */
      }
    }
  }
  return { entries, totalBytes };
}

let trackedBytes: number | null = null;
let trackedRoot = "";
let prunePromise: Promise<void> | null = null;

function ensureTrackedBytes(): number {
  const root = cacheRoot();
  if (trackedBytes === null || trackedRoot !== root) {
    trackedRoot = root;
    trackedBytes = collectCacheEntries().totalBytes;
  }
  return trackedBytes;
}

async function pruneCacheIfNeeded(keepPath?: string): Promise<void> {
  if (prunePromise) await prunePromise;
  const budget = cacheBudgetBytes();
  if (ensureTrackedBytes() <= budget) return;
  prunePromise = (async () => {
    const { entries, totalBytes } = collectCacheEntries();
    trackedRoot = cacheRoot();
    trackedBytes = totalBytes;
    if (totalBytes <= budget) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let bytes = totalBytes;
    const touchedDirs = new Set<string>();
    for (const e of entries) {
      if (bytes <= budget) break;
      if (keepPath && e.path === keepPath) continue;
      try {
        await unlink(e.path);
        bytes -= e.size;
        touchedDirs.add(e.dir);
      } catch {
        /* already removed */
      }
    }
    trackedBytes = Math.max(0, bytes);
    for (const d of touchedDirs) {
      try {
        const rest = readdirSync(d);
        if (rest.length === 0) await rmdir(d);
      } catch {
        /* ignore non-empty or gone */
      }
    }
  })().finally(() => {
    prunePromise = null;
  });
  return prunePromise;
}

export function imageCacheStats(): {
  files: number;
  bytes: number;
  budgetBytes: number;
  inFlight: number;
  activeDecodes: number;
  queuedDecodes: number;
} {
  const { entries, totalBytes } = collectCacheEntries();
  return {
    files: entries.length,
    bytes: totalBytes,
    budgetBytes: cacheBudgetBytes(),
    inFlight: inFlight.size,
    activeDecodes,
    queuedDecodes: decodeQueue.length,
  };
}

// ---------- bounded decode queue & single-flight ----------

const inFlight = new Map<string, Promise<VariantResult | null>>();
let activeDecodes = 0;
const decodeQueue: Array<() => void> = [];

function acquireDecodeSlot(): Promise<void> {
  if (activeDecodes < MAX_CONCURRENT_DECODES) {
    activeDecodes++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    decodeQueue.push(() => {
      activeDecodes++;
      resolve();
    });
  });
}

function releaseDecodeSlot(): void {
  activeDecodes--;
  const next = decodeQueue.shift();
  if (next) next();
}

// ---------- pixel decoding & downscaling ----------

function pngToRgba(buf: Buffer): { width: number; height: number; data: Uint8Array; hasAlpha: boolean } {
  const decoded = decodePng(buf);
  const { width, height, channels, depth, palette, transparency } = decoded;
  const pxCount = width * height;
  const rgba = new Uint8Array(pxCount * 4);

  if (palette) {
    const rgbOrRgba = convertIndexedToRgb(decoded);
    const stride = palette[0]?.length === 4 ? 4 : 3;
    if (stride === 4) {
      rgba.set(rgbOrRgba);
    } else {
      for (let i = 0, s = 0, d = 0; i < pxCount; i++, s += 3, d += 4) {
        rgba[d] = rgbOrRgba[s];
        rgba[d + 1] = rgbOrRgba[s + 1];
        rgba[d + 2] = rgbOrRgba[s + 2];
        rgba[d + 3] = 255;
      }
    }
  } else if (depth < 8) {
    // Unpack 1-, 2-, or 4-bit grayscale samples per row
    const raw = decoded.data as Uint8Array;
    const rowBytes = Math.ceil((width * depth) / 8);
    const maxSample = (1 << depth) - 1;
    const mask = maxSample;
    const tGray = transparency && transparency.length >= 1 ? transparency[0] : -1;
    let d = 0;
    for (let y = 0; y < height; y++) {
      const rowOff = y * rowBytes;
      for (let x = 0; x < width; x++) {
        const bitPos = x * depth;
        const byte = raw[rowOff + (bitPos >> 3)];
        const shift = 8 - depth - (bitPos & 7);
        const sample = (byte >> shift) & mask;
        const v = Math.round((sample * 255) / maxSample);
        rgba[d] = v;
        rgba[d + 1] = v;
        rgba[d + 2] = v;
        rgba[d + 3] = sample === tGray ? 0 : 255;
        d += 4;
      }
    }
  } else {
    const raw = decoded.data;
    const shift16 = depth === 16 ? 8 : 0;
    if (channels === 4) {
      if (shift16 === 0 && raw instanceof Uint8Array) {
        rgba.set(raw);
      } else {
        for (let i = 0; i < rgba.length; i++) rgba[i] = raw[i] >> shift16;
      }
    } else if (channels === 3) {
      const tr = transparency && transparency.length >= 3 ? transparency[0] : -1;
      const tg = transparency && transparency.length >= 3 ? transparency[1] : -1;
      const tb = transparency && transparency.length >= 3 ? transparency[2] : -1;
      for (let i = 0, s = 0, d = 0; i < pxCount; i++, s += 3, d += 4) {
        const r = raw[s];
        const g = raw[s + 1];
        const b = raw[s + 2];
        rgba[d] = r >> shift16;
        rgba[d + 1] = g >> shift16;
        rgba[d + 2] = b >> shift16;
        rgba[d + 3] = r === tr && g === tg && b === tb ? 0 : 255;
      }
    } else if (channels === 2) {
      for (let i = 0, s = 0, d = 0; i < pxCount; i++, s += 2, d += 4) {
        const v = raw[s] >> shift16;
        rgba[d] = v;
        rgba[d + 1] = v;
        rgba[d + 2] = v;
        rgba[d + 3] = raw[s + 1] >> shift16;
      }
    } else {
      const tGray = transparency && transparency.length >= 1 ? transparency[0] : -1;
      for (let i = 0, d = 0; i < pxCount; i++, d += 4) {
        const rawV = raw[i];
        const v = rawV >> shift16;
        rgba[d] = v;
        rgba[d + 1] = v;
        rgba[d + 2] = v;
        rgba[d + 3] = rawV === tGray ? 0 : 255;
      }
    }
  }

  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 250) {
      hasAlpha = true;
      break;
    }
  }
  return { width, height, data: rgba, hasAlpha };
}

function halve2x(src: Uint8Array, w: number, h: number, hasAlpha: boolean): { data: Uint8Array; width: number; height: number } {
  const nextW = Math.floor(w / 2);
  const nextH = Math.floor(h / 2);
  const dst = new Uint8Array(nextW * nextH * 4);
  const rowStride = w * 4;

  for (let y = 0; y < nextH; y++) {
    const sy0 = y * 2 * rowStride;
    const sy1 = sy0 + rowStride;
    let d = y * nextW * 4;
    for (let x = 0; x < nextW; x++) {
      const sx = x * 8;
      const i00 = sy0 + sx;
      const i01 = i00 + 4;
      const i10 = sy1 + sx;
      const i11 = i10 + 4;
      if (!hasAlpha) {
        dst[d] = (src[i00] + src[i01] + src[i10] + src[i11] + 2) >> 2;
        dst[d + 1] = (src[i00 + 1] + src[i01 + 1] + src[i10 + 1] + src[i11 + 1] + 2) >> 2;
        dst[d + 2] = (src[i00 + 2] + src[i01 + 2] + src[i10 + 2] + src[i11 + 2] + 2) >> 2;
        dst[d + 3] = 255;
      } else {
        const a00 = src[i00 + 3];
        const a01 = src[i01 + 3];
        const a10 = src[i10 + 3];
        const a11 = src[i11 + 3];
        const aSum = a00 + a01 + a10 + a11;
        if (aSum === 0) {
          dst[d] = 0;
          dst[d + 1] = 0;
          dst[d + 2] = 0;
          dst[d + 3] = 0;
        } else {
          dst[d] = Math.round((src[i00] * a00 + src[i01] * a01 + src[i10] * a10 + src[i11] * a11) / aSum);
          dst[d + 1] = Math.round((src[i00 + 1] * a00 + src[i01 + 1] * a01 + src[i10 + 1] * a10 + src[i11 + 1] * a11) / aSum);
          dst[d + 2] = Math.round((src[i00 + 2] * a00 + src[i01 + 2] * a01 + src[i10 + 2] * a10 + src[i11 + 2] * a11) / aSum);
          dst[d + 3] = (aSum + 2) >> 2;
        }
      }
      d += 4;
    }
  }
  return { data: dst, width: nextW, height: nextH };
}

function areaDownscale(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number, hasAlpha: boolean): Uint8Array {
  if (srcW === dstW && srcH === dstH) return src;
  const dst = new Uint8Array(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * scaleY;
    const sy1 = (dy + 1) * scaleY;
    const yStart = Math.floor(sy0);
    const yEnd = Math.min(srcH - 1, Math.ceil(sy1) - 1);

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * scaleX;
      const sx1 = (dx + 1) * scaleX;
      const xStart = Math.floor(sx0);
      const xEnd = Math.min(srcW - 1, Math.ceil(sx1) - 1);

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let wTotal = 0;
      let waTotal = 0;

      for (let sy = yStart; sy <= yEnd; sy++) {
        const yOverlap = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (yOverlap <= 0) continue;
        const rowOff = sy * srcW * 4;
        for (let sx = xStart; sx <= xEnd; sx++) {
          const xOverlap = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (xOverlap <= 0) continue;
          const w = xOverlap * yOverlap;
          const i = rowOff + sx * 4;
          wTotal += w;
          if (!hasAlpha) {
            rSum += src[i] * w;
            gSum += src[i + 1] * w;
            bSum += src[i + 2] * w;
          } else {
            const a = src[i + 3];
            aSum += a * w;
            const wa = w * a;
            waTotal += wa;
            rSum += src[i] * wa;
            gSum += src[i + 1] * wa;
            bSum += src[i + 2] * wa;
          }
        }
      }

      const d = (dy * dstW + dx) * 4;
      if (wTotal <= 0) continue;
      if (!hasAlpha) {
        dst[d] = Math.round(rSum / wTotal);
        dst[d + 1] = Math.round(gSum / wTotal);
        dst[d + 2] = Math.round(bSum / wTotal);
        dst[d + 3] = 255;
      } else {
        const outA = Math.round(aSum / wTotal);
        dst[d + 3] = outA;
        if (waTotal > 0) {
          dst[d] = Math.round(rSum / waTotal);
          dst[d + 1] = Math.round(gSum / waTotal);
          dst[d + 2] = Math.round(bSum / waTotal);
        }
      }
    }
  }
  return dst;
}

function downscaleRgba(src: Uint8Array, srcW: number, srcH: number, targetW: number, targetH: number, hasAlpha: boolean): Uint8Array {
  let cur = src;
  let curW = srcW;
  let curH = srcH;
  while (Math.floor(curW / 2) >= targetW && Math.floor(curH / 2) >= targetH && Math.floor(curW / 2) >= 1 && Math.floor(curH / 2) >= 1) {
    const halved = halve2x(cur, curW, curH, hasAlpha);
    cur = halved.data;
    curW = halved.width;
    curH = halved.height;
  }
  return areaDownscale(cur, curW, curH, targetW, targetH, hasAlpha);
}

// ---------- public variant API ----------

async function findCachedVariant(sha256: string, tier: number, naturalWidth: number, naturalHeight: number): Promise<VariantResult | null> {
  for (const [ext, mime] of [
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
  ] as const) {
    const p = variantPath(sha256, tier, ext);
    if (!existsSync(p)) continue;
    try {
      const st = await stat(p);
      if (!st.isFile() || st.size <= 0) continue;
      const probed = await probeImageFile(p, mime);
      if (!probed) continue;
      // Touch mtime for LRU only if older than 1s to avoid unnecessary syscalls
      const now = Date.now();
      if (now - st.mtimeMs > 1000) {
        const t = new Date(now);
        void utimes(p, t, t).catch(() => {});
      }
      return {
        path: p,
        mime,
        width: probed.width,
        height: probed.height,
        naturalWidth,
        naturalHeight,
        alpha: ext === "png",
        size: st.size,
        tier,
        cached: true,
      };
    } catch {
      /* ignore corrupt or vanished cache entry */
    }
  }
  return null;
}

interface DecodedRgba {
  width: number;
  height: number;
  data: Uint8Array;
  hasAlpha: boolean;
}

async function decodeSourceRgba(sourcePath: string, probe: ImageProbe): Promise<DecodedRgba | null> {
  const raw = await readFile(sourcePath);
  if (probe.format === "jpeg") {
    const decoded = jpeg.decode(raw, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: 64,
      maxMemoryUsageInMB: 512,
    });
    if (!isSafeDimensions(decoded.width, decoded.height)) return null;
    return { width: decoded.width, height: decoded.height, data: decoded.data, hasAlpha: false };
  }
  if (probe.format === "png") {
    const decoded = pngToRgba(raw);
    if (!isSafeDimensions(decoded.width, decoded.height)) return null;
    return decoded;
  }
  return null;
}

async function writeVariantFromRgba(
  safeSha: string,
  tier: number,
  srcRgba: Uint8Array,
  srcW: number,
  srcH: number,
  natW: number,
  natH: number,
  hasAlpha: boolean,
): Promise<{ variant: VariantResult; resizedRgba: Uint8Array }> {
  const targetW = tier;
  const targetH = Math.max(1, Math.round((natH * targetW) / natW));
  const resized = downscaleRgba(srcRgba, srcW, srcH, targetW, targetH, hasAlpha);

  let outBuf: Uint8Array;
  let ext: "jpg" | "png";
  let outMime: "image/jpeg" | "image/png";
  if (hasAlpha) {
    outBuf = encodePng({ width: targetW, height: targetH, data: resized, channels: 4, depth: 8 });
    ext = "png";
    outMime = "image/png";
  } else {
    const quality = tier === 64 ? 72 : 84;
    outBuf = jpeg.encode({ width: targetW, height: targetH, data: resized }, quality).data;
    ext = "jpg";
    outMime = "image/jpeg";
  }

  const dir = join(cacheRoot(), safeSha);
  await mkdir(dir, { recursive: true });
  const dest = variantPath(safeSha, tier, ext);
  const tmp = `${dest}.${randomBytes(4).toString("hex")}.part`;
  ensureTrackedBytes();
  const prevSize = existsSync(dest) ? statSync(dest).size : 0;
  try {
    await writeFile(tmp, outBuf);
    await rename(tmp, dest);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  trackedBytes = Math.max(0, (trackedBytes ?? 0) + (outBuf.length - prevSize));
  await pruneCacheIfNeeded(dest);

  return {
    variant: {
      path: dest,
      mime: outMime,
      width: targetW,
      height: targetH,
      naturalWidth: natW,
      naturalHeight: natH,
      alpha: hasAlpha,
      size: outBuf.length,
      tier,
      cached: false,
    },
    resizedRgba: resized,
  };
}

async function buildVariant(safeSha: string, sourcePath: string, tier: number, probe: ImageProbe): Promise<VariantResult | null> {
  // Re-check cache after acquiring slot / in case another request wrote it
  const cached = await findCachedVariant(safeSha, tier, probe.width, probe.height);
  if (cached) return cached;

  await acquireDecodeSlot();
  try {
    const cached2 = await findCachedVariant(safeSha, tier, probe.width, probe.height);
    if (cached2) return cached2;

    const decoded = await decodeSourceRgba(sourcePath, probe);
    if (!decoded || decoded.width <= tier) return null;

    const { variant } = await writeVariantFromRgba(
      safeSha,
      tier,
      decoded.data,
      decoded.width,
      decoded.height,
      decoded.width,
      decoded.height,
      decoded.hasAlpha,
    );
    return variant;
  } catch {
    return null;
  } finally {
    releaseDecodeSlot();
  }
}

/**
 * Get (or generate & cache) a downscaled variant for `requestedW`.
 * Returns `null` if the sha256 is invalid, the format isn't supported for server resize,
 * the original is already <= the snapped tier, the decompression-bomb guard rejects it,
 * or decoding fails.
 */
export async function getImageVariant(sha256: string, sourcePath: string, mime: string, requestedW: number): Promise<VariantResult | null> {
  const safeSha = normalizeSha256(sha256);
  if (!safeSha) return null;
  const tier = snapWidth(requestedW);
  if (tier === null) return null;

  const probe = await probeImageFile(sourcePath, mime);
  if (!probe) return null;
  if (probe.format !== "jpeg" && probe.format !== "png") return null;
  if (!isSafeDimensions(probe.width, probe.height)) return null;
  if (probe.width <= tier) return null;

  const hit = await findCachedVariant(safeSha, tier, probe.width, probe.height);
  if (hit) return hit;

  const key = `${safeSha}:${tier}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = buildVariant(safeSha, sourcePath, tier, probe).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

/**
 * Pre-warm medium (512) and LQIP (64) tiers asynchronously off the request path for JPEG/PNG
 * using a single source decode cascaded from 512 down to 64, coordinated with `inFlight`.
 */
export function warmImageLevels(sha256: string, sourcePath: string, mime: string): void {
  const safeSha = normalizeSha256(sha256);
  if (!safeSha) return;
  if (mime !== "image/jpeg" && mime !== "image/png") return;
  queueMicrotask(() => {
    void (async () => {
      const pending = new Map<number, { resolve: (v: VariantResult | null) => void }>();
      try {
        const probe = await probeImageFile(sourcePath, mime);
        if (!probe || (probe.format !== "jpeg" && probe.format !== "png") || !isSafeDimensions(probe.width, probe.height)) return;

        // Descending order so 512 feeds directly into 64
        const tiers = [512, 64].filter((t) => probe.width > t);
        if (tiers.length === 0) return;

        const needed: number[] = [];
        for (const t of tiers) {
          const key = `${safeSha}:${t}`;
          if (inFlight.has(key)) continue;
          const hit = await findCachedVariant(safeSha, t, probe.width, probe.height);
          if (hit) continue;
          needed.push(t);
        }
        if (needed.length === 0) return;

        for (const t of needed) {
          const key = `${safeSha}:${t}`;
          let resolveFn!: (v: VariantResult | null) => void;
          const p = new Promise<VariantResult | null>((resolve) => {
            resolveFn = resolve;
          });
          inFlight.set(key, p);
          pending.set(t, { resolve: resolveFn });
        }

        await acquireDecodeSlot();
        try {
          // Re-check disk cache once inside slot
          const toBuild: number[] = [];
          for (const t of needed) {
            const hit = await findCachedVariant(safeSha, t, probe.width, probe.height);
            if (hit) {
              pending.get(t)?.resolve(hit);
              pending.delete(t);
              inFlight.delete(`${safeSha}:${t}`);
            } else {
              toBuild.push(t);
            }
          }
          if (toBuild.length === 0) return;

          const decoded = await decodeSourceRgba(sourcePath, probe);
          if (!decoded) return;

          let curRgba = decoded.data;
          let curW = decoded.width;
          let curH = decoded.height;
          for (const t of toBuild) {
            if (decoded.width <= t) {
              pending.get(t)?.resolve(null);
              pending.delete(t);
              inFlight.delete(`${safeSha}:${t}`);
              continue;
            }
            const { variant, resizedRgba } = await writeVariantFromRgba(
              safeSha,
              t,
              curRgba,
              curW,
              curH,
              decoded.width,
              decoded.height,
              decoded.hasAlpha,
            );
            curRgba = resizedRgba;
            curW = variant.width;
            curH = variant.height;
            pending.get(t)?.resolve(variant);
            pending.delete(t);
            inFlight.delete(`${safeSha}:${t}`);
          }
        } finally {
          releaseDecodeSlot();
        }
      } catch {
        /* best-effort background warm */
      } finally {
        for (const [t, entry] of pending) {
          entry.resolve(null);
          inFlight.delete(`${safeSha}:${t}`);
        }
      }
    })();
  });
}

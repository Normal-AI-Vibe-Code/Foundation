/**
 * Server image pipeline & LOD caching tests (imagelod.ts, files.ts, chat.ts).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { encode as encodePng } from "fast-png";
import type { ChatMessage } from "@foundation/protocol";

const tmp = mkdtempSync(join(tmpdir(), "foundation-imagelod-"));
process.env.FOUNDATION_DATA_DIR = join(tmp, "data");
process.env.FOUNDATION_ADMIN_EMAILS = "ada@formindustries.com";

const { one, run } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const { requireUser } = await import("../src/auth.ts");
const { serveFile, storeFile, uploadFile } = await import("../src/files.ts");
const chat = await import("../src/chat.ts");
const { SERVER_LOD_WIDTHS, getImageVariant, imageCacheStats, probeImage, snapWidth, warmImageLevels } = await import("../src/imagelod.ts");

const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const adaCookie = `foundation_session=${auth.createSession(ada.id)}`;

function makeNoiseRgba(width: number, height: number, alphaFn?: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const i = (y * width + x) * 4;
      data[i] = (x * 3 + (seed & 0x3f)) & 0xff;
      data[i + 1] = (y * 5 + ((seed >> 8) & 0x3f)) & 0xff;
      data[i + 2] = ((x + y) * 2 + ((seed >> 16) & 0x3f)) & 0xff;
      data[i + 3] = alphaFn ? alphaFn(x, y) : 255;
    }
  }
  return data;
}

function makeJpeg(width: number, height: number, quality = 90): Buffer {
  const rgba = makeNoiseRgba(width, height);
  return jpeg.encode({ width, height, data: rgba }, quality).data;
}

function makePng(width: number, height: number, alphaFn?: (x: number, y: number) => number): Buffer {
  const rgba = makeNoiseRgba(width, height, alphaFn);
  return Buffer.from(encodePng({ width, height, data: rgba, channels: 4, depth: 8 }));
}

function makeGifHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(14);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function makeWebpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[20] = 0x00; // keyframe
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(width & 0x3fff, 26);
  b.writeUInt16LE(height & 0x3fff, 28);
  return b;
}

function makeWebpVp8l(width: number, height: number, alpha: boolean): Buffer {
  const b = Buffer.alloc(25);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(17, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt32LE(5, 16);
  b[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}

function makeWebpVp8x(width: number, height: number, alpha: boolean): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[20] = alpha ? 0x10 : 0x00;
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  b[24] = wMinus1 & 0xff;
  b[25] = (wMinus1 >> 8) & 0xff;
  b[26] = (wMinus1 >> 16) & 0xff;
  b[27] = hMinus1 & 0xff;
  b[28] = (hMinus1 >> 8) & 0xff;
  b[29] = (hMinus1 >> 16) & 0xff;
  return b;
}

function makeCraftedPngIhdr(width: number, height: number, colorType = 2): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = colorType;
  return b;
}

let server: Server;
let base = "";

before(async () => {
  const r = new Router();
  r.post("/api/files", async (req) => {
    const u = requireUser(req);
    const f = await uploadFile(req, u.id);
    return { file: f };
  });
  r.get("/files/:id", (req, res) => {
    requireUser(req);
    return serveFile(req, res, req.params.id);
  });
  chat.chatRoutes(r);

  server = createServer(async (rawReq, res) => {
    const req = rawReq as Parameters<Parameters<typeof r.get>[1]>[0];
    const url = new URL(req.url ?? "/", "http://local");
    req.query = url.searchParams;
    try {
      const m = r.match(req.method ?? "GET", url.pathname);
      if (!m) throw new HttpError(404, "not found");
      req.params = m.params;
      const out = await m.handler(req, res);
      if (!res.headersSent && out !== undefined) json(res, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, { error: (e as Error).message }, status);
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.closeAllConnections();
  server?.close();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite WAL file handle until process exit */
  }
});

test("snapWidth quantizes requested widths to fixed LOD tiers and rejects invalid values", () => {
  assert.deepEqual([...SERVER_LOD_WIDTHS], [64, 256, 512, 1024, 2048]);
  assert.equal(snapWidth(0), null);
  assert.equal(snapWidth(-50), null);
  assert.equal(snapWidth(Number.NaN), null);
  assert.equal(snapWidth(Number.POSITIVE_INFINITY), null);
  assert.equal(snapWidth(1), 64);
  assert.equal(snapWidth(64), 64);
  assert.equal(snapWidth(65), 256);
  assert.equal(snapWidth(256), 256);
  assert.equal(snapWidth(300), 512);
  assert.equal(snapWidth(1000), 1024);
  assert.equal(snapWidth(1500), 2048);
  assert.equal(snapWidth(2048), 2048);
  assert.equal(snapWidth(9999), 2048);
});

test("probeImage parses real PNG, JPEG, WebP, and GIF headers without pixel decode", () => {
  const pngOpaque = Buffer.from(encodePng({ width: 320, height: 180, data: makeNoiseRgba(320, 180), channels: 4, depth: 8 }));
  assert.deepEqual(probeImage(pngOpaque), { width: 320, height: 180, alpha: true, format: "png" });

  const pngRgb = Buffer.from(encodePng({ width: 120, height: 90, data: new Uint8Array(120 * 90 * 3), channels: 3, depth: 8 }));
  assert.deepEqual(probeImage(pngRgb), { width: 120, height: 90, alpha: false, format: "png" });

  // PNG with tRNS chunk (colorType 3 indexed)
  const pngTrns = Buffer.concat([
    makeCraftedPngIhdr(77, 55, 3),
    Buffer.from([0, 0, 0, 2, 0x74, 0x52, 0x4e, 0x53, 0, 255, 0, 0, 0, 0]),
  ]);
  assert.deepEqual(probeImage(pngTrns), { width: 77, height: 55, alpha: true, format: "png" });

  const jpg = makeJpeg(640, 480);
  assert.deepEqual(probeImage(jpg), { width: 640, height: 480, alpha: false, format: "jpeg" });

  assert.deepEqual(probeImage(makeGifHeader(123, 456)), { width: 123, height: 456, alpha: true, format: "gif" });
  assert.deepEqual(probeImage(makeWebpVp8(800, 600)), { width: 800, height: 600, alpha: false, format: "webp" });
  assert.deepEqual(probeImage(makeWebpVp8l(512, 256, true)), { width: 512, height: 256, alpha: true, format: "webp" });
  assert.deepEqual(probeImage(makeWebpVp8x(1920, 1080, false)), { width: 1920, height: 1080, alpha: false, format: "webp" });
  assert.deepEqual(probeImage(makeWebpVp8x(1920, 1080, true)), { width: 1920, height: 1080, alpha: true, format: "webp" });

  assert.equal(probeImage(Buffer.from("not an image")), null);
});

test("decompression-bomb guard refuses to decode huge crafted PNG IHDR", async () => {
  const bombPath = join(tmp, "bomb.png");
  const bomb = makeCraftedPngIhdr(50000, 50000, 6);
  writeFileSync(bombPath, bomb);
  const sha = createHash("sha256").update(bomb).digest("hex");

  assert.deepEqual(probeImage(bomb), { width: 50000, height: 50000, alpha: true, format: "png" });
  const res = await getImageVariant(sha, bombPath, "image/png", 256);
  assert.equal(res, null);

  // Also reject > 16384 in one dimension and > 64M total pixels
  const widePath = join(tmp, "wide.png");
  const wide = makeCraftedPngIhdr(17000, 100, 2);
  writeFileSync(widePath, wide);
  assert.equal(await getImageVariant(createHash("sha256").update(wide).digest("hex"), widePath, "image/png", 256), null);

  const bigPxPath = join(tmp, "bigpx.png");
  const bigPx = makeCraftedPngIhdr(9000, 9000, 2);
  writeFileSync(bigPxPath, bigPx);
  assert.equal(await getImageVariant(createHash("sha256").update(bigPx).digest("hex"), bigPxPath, "image/png", 256), null);
});

test("resizes JPEG and PNG variants with aspect ratio, alpha detection, disk cache reuse, and single-flight dedup", async () => {
  // 1. Opaque 800x600 JPEG -> tier 256 (256x192 JPEG) & tier 64 LQIP
  const jpgBuf = makeJpeg(800, 600, 92);
  const jpgSha = createHash("sha256").update(jpgBuf).digest("hex");
  const jpgPath = join(tmp, "photo.jpg");
  writeFileSync(jpgPath, jpgBuf);

  const [v1, v2] = await Promise.all([
    getImageVariant(jpgSha, jpgPath, "image/jpeg", 200),
    getImageVariant(jpgSha, jpgPath, "image/jpeg", 256),
  ]);
  assert.ok(v1 && v2);
  assert.equal(v1.width, 256);
  assert.equal(v1.height, 192);
  assert.equal(v1.naturalWidth, 800);
  assert.equal(v1.naturalHeight, 600);
  assert.equal(v1.mime, "image/jpeg");
  assert.equal(v1.alpha, false);
  assert.equal(v1.cached, false, "single-flight shares initial generation");
  assert.equal(v2.cached, false);
  assert.ok(v1.size < jpgBuf.length, `expected variant (${v1.size}) < original (${jpgBuf.length})`);
  assert.ok(v1.path.includes(join("cache", "images", jpgSha, "256.jpg")));

  const v3 = await getImageVariant(jpgSha, jpgPath, "image/jpeg", 256);
  assert.ok(v3);
  assert.equal(v3.cached, true, "second call reuses disk cache");

  const lqip = await getImageVariant(jpgSha, jpgPath, "image/jpeg", 64);
  assert.ok(lqip);
  assert.equal(lqip.width, 64);
  assert.equal(lqip.height, 48);
  assert.ok(lqip.size < 2500, `LQIP should be tiny, got ${lqip.size} bytes`);

  // 2. RGBA PNG whose actual alpha values are all 255 -> encoded as opaque JPEG!
  const fakeAlphaPng = makePng(600, 400, () => 255);
  const fakeAlphaSha = createHash("sha256").update(fakeAlphaPng).digest("hex");
  const fakeAlphaPath = join(tmp, "opaque-rgba.png");
  writeFileSync(fakeAlphaPath, fakeAlphaPng);
  const fakeAlphaVar = await getImageVariant(fakeAlphaSha, fakeAlphaPath, "image/png", 256);
  assert.ok(fakeAlphaVar);
  assert.equal(fakeAlphaVar.mime, "image/jpeg");
  assert.equal(fakeAlphaVar.alpha, false);
  assert.equal(fakeAlphaVar.width, 256);
  assert.equal(fakeAlphaVar.height, 171);
  assert.ok(fakeAlphaVar.size < fakeAlphaPng.length);

  // 3. Truly transparent PNG -> stays PNG with alpha=true
  const transPng = makePng(600, 300, (x) => (x < 300 ? 0 : 255));
  const transSha = createHash("sha256").update(transPng).digest("hex");
  const transPath = join(tmp, "transparent.png");
  writeFileSync(transPath, transPng);
  const transVar = await getImageVariant(transSha, transPath, "image/png", 256);
  assert.ok(transVar);
  assert.equal(transVar.mime, "image/png");
  assert.equal(transVar.alpha, true);
  assert.equal(transVar.width, 256);
  assert.equal(transVar.height, 128);
  assert.ok(transVar.path.endsWith("256.png"));
});

test("serveFile serves ?w=256 with ETag, 304 Not Modified, nosniff, CSP sandbox, and original fallback", async () => {
  const img = makeJpeg(800, 600, 90);
  const up = await fetch(`${base}/api/files?name=landscape.jpg&board=company`, {
    method: "POST",
    headers: { cookie: adaCookie, "content-type": "image/jpeg" },
    body: img,
  });
  assert.equal(up.status, 200);
  const { file } = (await up.json()) as { file: { id: string; sha256: string; width: number; height: number } };
  assert.equal(file.width, 800);
  assert.equal(file.height, 600);

  // Request ?w=200 -> snapped to 256
  const r256 = await fetch(`${base}/files/${file.id}?w=200`, { headers: { cookie: adaCookie } });
  assert.equal(r256.status, 200);
  const body256 = Buffer.from(await r256.arrayBuffer());
  assert.equal(r256.headers.get("content-type"), "image/jpeg");
  assert.equal(r256.headers.get("x-content-type-options"), "nosniff");
  assert.match(r256.headers.get("content-security-policy") ?? "", /^sandbox;/);
  assert.equal(r256.headers.get("etag"), `"${file.sha256}-w256"`);
  assert.equal(r256.headers.get("x-image-level"), "256");
  assert.equal(r256.headers.get("x-image-natural-width"), "800");
  assert.equal(r256.headers.get("x-image-natural-height"), "600");
  assert.equal(r256.headers.get("x-image-width"), "256");
  assert.equal(r256.headers.get("x-image-height"), "192");
  assert.equal(r256.headers.get("x-image-alpha"), "0");
  assert.ok(body256.length < img.length);

  // Conditional 304 on variant
  const r304 = await fetch(`${base}/files/${file.id}?w=256`, {
    headers: { cookie: adaCookie, "if-none-match": `"${file.sha256}-w256"` },
  });
  assert.equal(r304.status, 304);
  assert.equal(r304.headers.get("etag"), `"${file.sha256}-w256"`);

  // Request ?w=2048 on 800px image -> falls back to original
  const rOrig = await fetch(`${base}/files/${file.id}?w=2048`, { headers: { cookie: adaCookie } });
  assert.equal(rOrig.status, 200);
  const bodyOrig = Buffer.from(await rOrig.arrayBuffer());
  assert.equal(rOrig.headers.get("etag"), `"${file.sha256}-orig"`);
  assert.equal(rOrig.headers.get("x-image-level"), "original");
  assert.equal(rOrig.headers.get("x-image-natural-width"), "800");
  assert.equal(rOrig.headers.get("x-image-natural-height"), "600");
  assert.ok(bodyOrig.equals(img));

  // Conditional 304 on original
  const rOrig304 = await fetch(`${base}/files/${file.id}`, {
    headers: { cookie: adaCookie, "if-none-match": `"${file.sha256}-orig"` },
  });
  assert.equal(rOrig304.status, 304);

  // Range request on original still returns 206
  const rRange = await fetch(`${base}/files/${file.id}`, {
    headers: { cookie: adaCookie, range: "bytes=0-15" },
  });
  assert.equal(rRange.status, 206);
  assert.equal(Buffer.from(await rRange.arrayBuffer()).length, 16);

  // Archived files in data/files/ were never modified or polluted with cache files
  const archived = readdirSync(join(process.env.FOUNDATION_DATA_DIR!, "files"));
  assert.ok(!archived.some((f) => f.includes(".")), "data/files/ contains only raw sha256 blobs");
});

test("LRU disk cache pruning stays within FOUNDATION_IMAGE_CACHE_MB budget", async () => {
  const prevBudget = process.env.FOUNDATION_IMAGE_CACHE_MB;
  const cacheDir = join(process.env.FOUNDATION_DATA_DIR!, "cache", "images");
  rmSync(cacheDir, { recursive: true, force: true });
  try {
    const img1 = makeJpeg(800, 600, 92);
    const sha1 = createHash("sha256").update(img1).digest("hex");
    const p1 = join(tmp, "lru1.jpg");
    writeFileSync(p1, img1);
    const v1 = await getImageVariant(sha1, p1, "image/jpeg", 256);
    assert.ok(v1);
    // Make v1 strictly older
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(v1.path, oldTime, oldTime);

    const img2 = makeJpeg(800, 600, 88);
    const sha2 = createHash("sha256").update(img2).digest("hex");
    const p2 = join(tmp, "lru2.jpg");
    writeFileSync(p2, img2);

    // Budget fits one 256px variant comfortably, but NOT two!
    process.env.FOUNDATION_IMAGE_CACHE_MB = String((v1.size + 4096) / (1024 * 1024));
    const v2 = await getImageVariant(sha2, p2, "image/jpeg", 256);
    assert.ok(v2);

    const stats = imageCacheStats();
    assert.ok(stats.bytes <= stats.budgetBytes, `cache bytes (${stats.bytes}) exceeded budget (${stats.budgetBytes})`);
    assert.equal(existsSync(v1.path), false, "oldest variant was evicted by LRU");
    assert.equal(existsSync(v2.path), true, "newest variant remains in cache");
  } finally {
    if (prevBudget === undefined) delete process.env.FOUNDATION_IMAGE_CACHE_MB;
    else process.env.FOUNDATION_IMAGE_CACHE_MB = prevBudget;
  }
});

test("ChatFile populates w and h when uploading an image to board=chat", async () => {
  const png = makePng(640, 360);
  const f = await storeFile(png, { name: "render.png", mime: "image/png", boardId: "chat", userId: ada.id });
  assert.equal(f.width, 640);
  assert.equal(f.height, 360);

  const ch = chat.ensureGeneral();
  const postRes = await fetch(`${base}/api/chat/channels/${ch.id}/messages`, {
    method: "POST",
    headers: { cookie: adaCookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "look at this render", files: [f.id] }),
  });
  assert.equal(postRes.status, 200);
  const { message } = (await postRes.json()) as { message: ChatMessage };
  assert.equal(message.files.length, 1);
  assert.deepEqual(message.files[0], {
    id: f.id,
    name: "render.png",
    mime: "image/png",
    size: png.length,
    w: 640,
    h: 360,
  });

  // Non-image chat upload omits w and h
  const txt = await storeFile(Buffer.from("hello"), { name: "notes.txt", mime: "text/plain", boardId: "chat", userId: ada.id });
  const txtRes = await fetch(`${base}/api/chat/channels/${ch.id}/messages`, {
    method: "POST",
    headers: { cookie: adaCookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "text file", files: [txt.id] }),
  });
  assert.equal(txtRes.status, 200);
  const { message: txtMsg } = (await txtRes.json()) as { message: ChatMessage };
  assert.equal(txtMsg.files[0].w, undefined);
  assert.equal(txtMsg.files[0].h, undefined);
  const dbRow = one<{ width: number | null; height: number | null }>("select width, height from files where id = ?", txt.id);
  assert.equal(dbRow?.width, null);
  assert.equal(dbRow?.height, null);
});

test("rejects non-sha256 cache keys and warmImageLevels cascades 512 and 64 tiers", async () => {
  const img = makeJpeg(800, 600, 86);
  const sha = createHash("sha256").update(img).digest("hex");
  const p = join(tmp, "warm.jpg");
  writeFileSync(p, img);

  assert.equal(await getImageVariant("../escape", p, "image/jpeg", 256), null);
  assert.equal(await getImageVariant("not-hex", p, "image/jpeg", 256), null);

  warmImageLevels(sha, p, "image/jpeg");
  const dir = join(process.env.FOUNDATION_DATA_DIR!, "cache", "images", sha);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (!existsSync(join(dir, "512.jpg")) || !existsSync(join(dir, "64.jpg")))) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(existsSync(join(dir, "512.jpg")), true, "warmImageLevels produced 512 tier");
  assert.equal(existsSync(join(dir, "64.jpg")), true, "warmImageLevels cascaded 64 tier");

  const v512 = await getImageVariant(sha, p, "image/jpeg", 512);
  const v64 = await getImageVariant(sha, p, "image/jpeg", 64);
  assert.equal(v512?.cached, true);
  assert.equal(v512?.width, 512);
  assert.equal(v64?.cached, true);
  assert.equal(v64?.width, 64);
});

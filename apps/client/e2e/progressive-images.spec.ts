/**
 * End-to-end verification of Progressive Cached Images & Server LODs:
 *   1. Server LOD byte savings (> 75% reduction), numeric `x-image-level` headers,
 *      alpha preservation, and `foundation-image-cache-v3` population on cold grid load.
 *   2. L1 synchronous instant remount (0 ms / 0 fetches) + persistent L2 Cache Storage
 *      across full `page.reload()` (0 network fetches) + cache wipe on `logout()`.
 *   3. ChatForm image attachment (`w`/`h` metadata on messages, `?w=512` progressive
 *      inline display, instant cached Lightbox open + background upgrade to original).
 *   4. `#/design` Day & Night visual verification + interactive specimen checks for
 *      "Progressive cached images" and "People on a hosted server".
 *
 *   E2E_SERVER_PORT=15430 E2E_CLIENT_PORT=15450 E2E_SLACK_PORT=15440 E2E_MESHY_PORT=15445 npm run e2e -w @foundation/client -- progressive-images.spec.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CLIENT, person, settle, waitLive } from "./helpers";

const EVIDENCE_DIR = fileURLToPath(new URL("../../../docs/evidence/2026-11-21_images-hosted-chat/", import.meta.url));

interface CapturedImageResponse {
  url: string;
  path: string;
  wParam: string | null;
  status: number;
  bytes: number;
  level: string | null;
  natW: string | null;
  natH: string | null;
  imgW: string | null;
  imgH: string | null;
  alpha: string | null;
}

interface ProgressiveMetrics {
  jpegOriginalBytes: number;
  pngOriginalBytes: number;
  totalOriginalBytes: number;
  coldTransferredBytes: number;
  byteSavingsPct: number;
  coldRequests: Array<{ path: string; w: string | null; level: string | null; bytes: number; alpha: string | null }>;
  l2CacheEntryCount: number;
  remountNetworkRequests: number;
  reloadNetworkRequests: number;
  cacheClearedOnLogout: boolean;
  chatImageNatural: [number, number];
  chatInlineTier: string;
  chatLightboxInitialPhase: string;
  chatLightboxFinalNatural: [number, number];
}

const metrics: Partial<ProgressiveMetrics> = {};

async function devSignIn(browser: Browser, name: string, email: string, scheme: "dark" | "light" = "dark"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
  });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  expect(res.ok(), `dev login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await context.addInitScript(() => {
    localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
    if (!localStorage.getItem("foundation-wheel")) localStorage.setItem("foundation-wheel", "pan");
  });
  const page = await context.newPage();
  return { context, page };
}

/** Generate a realistic, detail-rich JPEG in the browser (~600 KB–1.1 MB at 2048×1536). */
async function generateHighResJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h }) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "rgb(36, 72, 138)");
      grad.addColorStop(0.5, "rgb(218, 168, 98)");
      grad.addColorStop(1, "rgb(32, 92, 74)");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);

      // Deterministic pseudo-random photographic texture so JPEG DCT blocks stay > 500 KB
      const img = g.getImageData(0, 0, w, h);
      const d = img.data;
      let seed = 0x9e3779b9;
      for (let i = 0; i < d.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const n1 = ((seed >>> 16) & 0x3f) - 32;
        const n2 = ((seed >>> 8) & 0x3f) - 32;
        const n3 = (seed & 0x3f) - 32;
        d[i] = Math.max(0, Math.min(255, d[i] + n1));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n2));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n3));
      }
      g.putImageData(img, 0, 0);

      // Crisp geometric CAD markers on top so visual sharpness is obvious
      g.strokeStyle = "rgba(255, 255, 255, 0.85)";
      g.lineWidth = 6;
      g.strokeRect(80, 80, w - 160, h - 160);
      g.beginPath();
      g.arc(w / 2, h / 2, Math.min(w, h) * 0.28, 0, Math.PI * 2);
      g.stroke();

      const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.95 });
      const ab = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    },
    { w: width, h: height },
  );
  return Buffer.from(b64, "base64");
}

/** Generate a 1024×1024 PNG with genuine transparent background (alpha = 0) and detailed foreground. */
async function generateTransparentPng(page: Page, width = 1024, height = 1024): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h }) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, w, h);

      // Draw a concentric rotor diagram on a clear ground, leaving corners alpha=0
      const cx = w / 2;
      const cy = h / 2;
      g.fillStyle = "rgba(50, 91, 180, 0.92)";
      g.beginPath();
      g.arc(cx, cy, w * 0.36, 0, Math.PI * 2);
      g.fill();

      // Cut out inner ring so center is genuinely transparent too
      g.globalCompositeOperation = "destination-out";
      g.beginPath();
      g.arc(cx, cy, w * 0.16, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = "source-over";

      // Add deterministic fine grain on opaque pixels only so PNG is realistic in size while keeping alpha=0 outside
      const img = g.getImageData(0, 0, w, h);
      const d = img.data;
      let seed = 0x12345678;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const delta = ((seed >>> 24) & 0x1f) - 16;
          d[i] = Math.max(0, Math.min(255, d[i] + delta));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + delta));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + delta));
        }
      }
      g.putImageData(img, 0, 0);

      const blob = await c.convertToBlob({ type: "image/png" });
      const ab = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    },
    { w: width, h: height },
  );
  return Buffer.from(b64, "base64");
}

test.describe.configure({ mode: "serial" });

let boardId = "";
let jpegFile: { id: string; size: number; url: string };
let pngFile: { id: string; size: number; url: string };
let coldViewer: { context: BrowserContext; page: Page } | null = null;

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

test.afterAll(async () => {
  await coldViewer?.context.close();
  writeFileSync(join(EVIDENCE_DIR, "progressive-images-metrics.json"), JSON.stringify(metrics, null, 2));
});

test("1. Server LOD byte savings (> 75%) & progressive cold load on a grid", async ({ browser }) => {
  test.setTimeout(120_000);

  // Use a setup session to create the board and upload both high-res images so the viewer context performs a 100% cold load
  const setup = await devSignIn(browser, "Ada Setup", "admin@normal.dev", "dark");
  const made = await setup.context.request.post(`${CLIENT}/api/boards`, {
    data: { name: `Progressive Images ${Date.now().toString(36)}` },
  });
  expect(made.ok(), await made.text()).toBeTruthy();
  boardId = ((await made.json()) as { id: string }).id;

  await setup.page.goto(`/?rafshim&board=${encodeURIComponent(boardId)}`);
  await waitLive(setup.page);

  const jpegBuf = await generateHighResJpeg(setup.page, 2048, 1536);
  const pngBuf = await generateTransparentPng(setup.page, 1024, 1024);
  expect(jpegBuf.byteLength, "generated 2048x1536 JPEG should be >= 500 KB").toBeGreaterThanOrEqual(500 * 1024);
  expect(pngBuf.byteLength, "generated 1024x1024 transparent PNG should be sizable").toBeGreaterThan(80 * 1024);

  const upJpeg = await setup.context.request.post(`${CLIENT}/api/files?board=${encodeURIComponent(boardId)}&name=stator-2048x1536.jpg`, {
    headers: { "content-type": "image/jpeg" },
    data: jpegBuf,
  });
  expect(upJpeg.ok(), await upJpeg.text()).toBeTruthy();
  jpegFile = ((await upJpeg.json()) as { file: { id: string; size: number; url: string } }).file;

  const upPng = await setup.context.request.post(`${CLIENT}/api/files?board=${encodeURIComponent(boardId)}&name=rotor-alpha-1024.png`, {
    headers: { "content-type": "image/png" },
    data: pngBuf,
  });
  expect(upPng.ok(), await upPng.text()).toBeTruthy();
  pngFile = ((await upPng.json()) as { file: { id: string; size: number; url: string } }).file;

  // Place both images onto the board at normal card dimensions inside the visible section
  await setup.page.evaluate(
    ({ jpegUrl, pngUrl }) => {
      const sync = (
        window as unknown as {
          __foundationBoard: () => {
            doc: {
              transact(fn: () => void): void;
              getMap(n: string): { set(k: string, v: unknown): void; keys(): IterableIterator<string>; delete(k: string): void };
            };
          };
        }
      ).__foundationBoard();
      const doc = sync.doc;
      const sections = doc.getMap("sections");
      const objs = doc.getMap("objects");
      doc.transact(() => {
        for (const k of [...sections.keys()]) sections.delete(k);
        for (const k of [...objs.keys()]) objs.delete(k);
        doc.getMap("grid").set("tracks", { cols: [1100], rows: [720] });
        sections.set("sec_img", { id: "sec_img", name: "LOD Check", c0: 0, r0: 0, c1: 0, r1: 0 });
        objs.set("m_jpeg", {
          id: "m_jpeg",
          kind: "media",
          media: "image",
          sectionId: "sec_img",
          name: "stator-2048x1536.jpg",
          x: 48,
          y: 72,
          w: 360,
          h: 270,
          float: true,
          bornAt: 1,
          src: jpegUrl,
          autoplay: false,
          muted: true,
        });
        objs.set("m_png", {
          id: "m_png",
          kind: "media",
          media: "image",
          sectionId: "sec_img",
          name: "rotor-alpha-1024.png",
          x: 448,
          y: 72,
          w: 300,
          h: 300,
          float: true,
          bornAt: 2,
          src: pngUrl,
          autoplay: false,
          muted: true,
        });
      });
    },
    { jpegUrl: jpegFile.url, pngUrl: pngFile.url },
  );
  await settle(setup.page, 600);
  await setup.context.close();

  // Now open a completely fresh browser context to measure cold grid load from zero cache
  coldViewer = await devSignIn(browser, "Kai Viewer", "kai@normal.dev", "dark");
  const captured: CapturedImageResponse[] = [];
  const pendingBodies: Promise<void>[] = [];

  coldViewer.page.on("response", (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith("/files/")) return;
    pendingBodies.push(
      (async () => {
        const h = res.headers();
        const headerBytes = Number(h["content-length"] ?? 0);
        const body = headerBytes > 0 ? null : await res.body().catch(() => Buffer.alloc(0));
        const bytes = headerBytes > 0 ? headerBytes : (body?.byteLength ?? 0);
        captured.push({
          url: res.url(),
          path: u.pathname,
          wParam: u.searchParams.get("w"),
          status: res.status(),
          bytes,
          level: h["x-image-level"] ?? null,
          natW: h["x-image-natural-width"] ?? null,
          natH: h["x-image-natural-height"] ?? null,
          imgW: h["x-image-width"] ?? null,
          imgH: h["x-image-height"] ?? null,
          alpha: h["x-image-alpha"] ?? null,
        });
      })(),
    );
  });

  await coldViewer.page.goto(`/?rafshim&board=${encodeURIComponent(boardId)}`);
  await waitLive(coldViewer.page);

  // Wait until both MediaView cards render sharp tiers (>= 256px naturalWidth)
  await expect
    .poll(
      async () =>
        coldViewer!.page.evaluate(() => {
          const imgs = [...document.querySelectorAll<HTMLImageElement>(".media-card img")];
          return imgs.length === 2 && imgs.every((im) => im.complete && im.naturalWidth >= 256 && im.naturalWidth <= 512);
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

  await settle(coldViewer.page, 700);
  await Promise.all(pendingBodies);

  const ourResponses = captured.filter((r) => r.path === jpegFile.url || r.path === pngFile.url);
  expect(ourResponses.length, "grid should fetch progressive server tiers").toBeGreaterThanOrEqual(2);

  // Assert NO request fetched the full original (without ?w=) at normal card size
  const bareOriginalRequests = ourResponses.filter((r) => !r.wParam);
  expect(bareOriginalRequests, "normal card size must NOT download full original image").toEqual([]);

  // Assert every request asked for ?w=64, ?w=256, or ?w=512 and received a numeric x-image-level
  for (const r of ourResponses) {
    expect(r.status).toBe(200);
    expect(["64", "256", "512"]).toContain(r.wParam);
    expect(["64", "256", "512"]).toContain(r.level);
    expect(r.level).toBe(r.wParam);
  }

  // Verify natural dimensions and alpha detection headers from server
  const jpegRes = ourResponses.filter((r) => r.path === jpegFile.url);
  const pngRes = ourResponses.filter((r) => r.path === pngFile.url);
  expect(jpegRes.length).toBeGreaterThanOrEqual(1);
  expect(pngRes.length).toBeGreaterThanOrEqual(1);
  for (const r of jpegRes) {
    expect(r.natW).toBe("2048");
    expect(r.natH).toBe("1536");
    expect(r.alpha).toBe("0");
  }
  for (const r of pngRes) {
    expect(r.natW).toBe("1024");
    expect(r.natH).toBe("1024");
    expect(r.alpha).toBe("1");
  }

  // Transparent PNG card is marked `.is-clear` (offers Invert on dark in Night mode)
  await expect(coldViewer.page.locator('[data-obj-id="m_png"] .media-card.is-clear')).toBeVisible();

  const totalOriginalBytes = jpegFile.size + pngFile.size;
  const coldTransferredBytes = ourResponses.reduce((sum, r) => sum + r.bytes, 0);
  const byteSavingsPct = Math.round(((totalOriginalBytes - coldTransferredBytes) / totalOriginalBytes) * 1000) / 10;

  console.log(
    `[progressive-images] Original=${(totalOriginalBytes / 1024).toFixed(1)} KB (JPEG ${(jpegFile.size / 1024).toFixed(1)} KB + PNG ${(pngFile.size / 1024).toFixed(1)} KB) -> Transferred=${(coldTransferredBytes / 1024).toFixed(1)} KB (${byteSavingsPct}% reduction across ${ourResponses.length} tier responses)`,
  );
  expect(byteSavingsPct, "LOD byte reduction must exceed 75%").toBeGreaterThan(75);
  expect(coldTransferredBytes, "transferred bytes must be non-zero").toBeGreaterThan(1024);

  // Assert Cache Storage (`foundation-image-cache-v3`) holds the cached tiers
  await expect
    .poll(
      async () =>
        coldViewer!.page.evaluate(async () => {
          const has = await caches.has("foundation-image-cache-v3");
          if (!has) return 0;
          const cache = await caches.open("foundation-image-cache-v3");
          const keys = await cache.keys();
          return keys.length;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(2);

  const l2Keys = await coldViewer.page.evaluate(async () => {
    const cache = await caches.open("foundation-image-cache-v3");
    return (await cache.keys()).map((k) => k.url);
  });
  expect(l2Keys.some((u) => u.includes(jpegFile.id))).toBe(true);
  expect(l2Keys.some((u) => u.includes(pngFile.id))).toBe(true);

  metrics.jpegOriginalBytes = jpegFile.size;
  metrics.pngOriginalBytes = pngFile.size;
  metrics.totalOriginalBytes = totalOriginalBytes;
  metrics.coldTransferredBytes = coldTransferredBytes;
  metrics.byteSavingsPct = byteSavingsPct;
  metrics.coldRequests = ourResponses.map((r) => ({ path: r.path, w: r.wParam, level: r.level, bytes: r.bytes, alpha: r.alpha }));
  metrics.l2CacheEntryCount = l2Keys.length;
});

test("2. Persistent L2 cache across reload (0 network downloads), L1 instant remount, and logout cache wipe", async () => {
  expect(coldViewer, "coldViewer from test 1 must be active").toBeTruthy();
  const page = coldViewer!.page;

  // Part A: L1 synchronous remount (unmount both MediaView cards completely, then mount fresh cards pointing at the same src)
  const remountRequests: string[] = [];
  const onRemountReq = (req: { url(): string }) => {
    if (new URL(req.url()).pathname.startsWith("/files/")) remountRequests.push(req.url());
  };
  page.on("request", onRemountReq);

  const savedCards = await page.evaluate(() => {
    const sync = (
      window as unknown as {
        __foundationBoard: () => {
          doc: {
            transact(fn: () => void): void;
            getMap(n: string): { get(k: string): unknown; set(k: string, v: unknown): void; delete(k: string): void };
          };
        };
      }
    ).__foundationBoard();
    const objs = sync.doc.getMap("objects");
    const j = objs.get("m_jpeg");
    const p = objs.get("m_png");
    sync.doc.transact(() => {
      objs.delete("m_jpeg");
      objs.delete("m_png");
    });
    return { j, p };
  });
  await expect(page.locator(".media-card")).toHaveCount(0);

  await page.evaluate(({ j, p }) => {
    const sync = (
      window as unknown as {
        __foundationBoard: () => {
          doc: {
            transact(fn: () => void): void;
            getMap(n: string): { set(k: string, v: unknown): void };
          };
        };
      }
    ).__foundationBoard();
    const objs = sync.doc.getMap("objects");
    sync.doc.transact(() => {
      objs.set("m_jpeg_remount", { ...(j as object), id: "m_jpeg_remount" });
      objs.set("m_png_remount", { ...(p as object), id: "m_png_remount" });
    });
  }, savedCards);
  await expect(page.locator(".media-card img")).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>(".media-card img")];
        return imgs.length === 2 && imgs.every((im) => im.src.startsWith("blob:") && im.complete && im.naturalWidth >= 256);
      }),
    )
    .toBe(true);
  expect(remountRequests, "L1 remount must make 0 network requests").toEqual([]);
  page.off("request", onRemountReq);
  metrics.remountNetworkRequests = remountRequests.length;

  // Part B: Full `page.reload()` hits L2 `foundation-image-cache-v3` with 0 network downloads
  const reloadRequests: string[] = [];
  const onReloadReq = (req: { url(): string }) => {
    const p = new URL(req.url()).pathname;
    if (p === jpegFile.url || p === pngFile.url) reloadRequests.push(req.url());
  };
  page.on("request", onReloadReq);

  await page.reload();
  await waitLive(page);
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const imgs = [...document.querySelectorAll<HTMLImageElement>(".media-card img")];
          return imgs.length === 2 && imgs.every((im) => im.complete && im.naturalWidth >= 256);
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  await settle(page, 600);
  page.off("request", onReloadReq);

  console.log(`[progressive-images] Reload network requests for cached images: ${reloadRequests.length}`);
  expect(reloadRequests, "second load after reload must serve cached tiers from L2 with 0 network requests").toEqual([]);
  metrics.reloadNetworkRequests = reloadRequests.length;

  // Part C: Calling Sign out (`logout()`) wipes `foundation-image-cache-v3`
  expect(await page.evaluate(() => caches.has("foundation-image-cache-v3"))).toBe(true);
  await page.evaluate(() => {
    window.location.hash = "#/settings/general";
  });
  await expect(page.locator(".settings-space")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".login")).toBeVisible({ timeout: 20_000 });

  const hasCacheAfterLogout = await page.evaluate(() => caches.has("foundation-image-cache-v3"));
  expect(hasCacheAfterLogout, "logout() must delete foundation-image-cache-v3").toBe(false);
  metrics.cacheClearedOnLogout = !hasCacheAfterLogout;

  await coldViewer!.context.close();
  coldViewer = null;
});

test("3. ChatForm cached image attachment + aspect ratio (w/h) + Lightbox instant open & original upgrade", async ({ browser }) => {
  test.setTimeout(120_000);
  const ada = await person(browser, "Ada Chat", "admin@normal.dev");
  try {
    await ada.page.waitForFunction(
      () => (window as unknown as { __chatform?: () => { loaded: boolean } }).__chatform?.().loaded === true,
    );

    const fileRequests: Array<{ url: string; w: string | null }> = [];
    ada.page.on("request", (req) => {
      const u = new URL(req.url());
      if (u.pathname.startsWith("/files/")) {
        fileRequests.push({ url: req.url(), w: u.searchParams.get("w") });
      }
    });

    await ada.page.locator(".top-bar [data-top-chat]").click();
    await expect(ada.page.locator(".chatform")).toBeVisible();
    await expect(ada.page.locator(".chat-head-name")).toHaveText("general");

    const chatJpeg = await generateHighResJpeg(ada.page, 1600, 1200);
    await ada.page.locator('[data-chat-composer="channel"] input[type="file"]').setInputFiles({
      name: "housing-1600x1200.jpg",
      mimeType: "image/jpeg",
      buffer: chatJpeg,
    });
    await expect(ada.page.locator('[data-chat-composer="channel"] .chat-chip.is-done')).toBeVisible({ timeout: 15_000 });

    const composer = ada.page.locator('[data-chat-composer="channel"] textarea');
    const marker = `Housing inspection ${Date.now()}`;
    await composer.fill(marker);
    await composer.press("Enter");

    const msgLoc = ada.page.locator(".chat-timeline .chat-msg", { hasText: marker });
    await expect(msgLoc).toBeVisible({ timeout: 15_000 });

    // Verify GET /api/chat/channels/<generalId>/messages returns files[0].w === 1600 and files[0].h === 1200
    const generalId = await ada.page.evaluate(() => {
      const st = (window as unknown as { __chatform: () => { channels: Record<string, { id: string; name: string }> } }).__chatform();
      return Object.values(st.channels).find((c) => c.name === "general")?.id ?? "";
    });
    expect(generalId).toMatch(/^ch_/);

    const msgsRes = await ada.context.request.get(`${CLIENT}/api/chat/channels/${generalId}/messages`);
    expect(msgsRes.ok()).toBeTruthy();
    const msgsBody = (await msgsRes.json()) as {
      messages: Array<{ text: string; files?: Array<{ id: string; w?: number; h?: number }> }>;
    };
    const posted = msgsBody.messages.find((m) => m.text.includes(marker));
    expect(posted?.files?.length).toBe(1);
    const chatFile = posted!.files![0];
    expect(chatFile.w).toBe(1600);
    expect(chatFile.h).toBe(1200);
    metrics.chatImageNatural = [chatFile.w!, chatFile.h!];

    // Verify ChatForm renders <ProgressiveImage> at targetWidth=512 in a box of its own shape (1600 x 1200 fitted inside 360 x 280: 360 / 270)
    const picBtn = msgLoc.locator(".chat-picture");
    await expect(picBtn).toHaveAttribute("style", /aspect-ratio:\s*360\s*\/\s*270/);

    const progSpan = picBtn.locator(".f-prog");
    await expect(progSpan).toHaveAttribute("data-prog-phase", "sharp", { timeout: 15_000 });
    await expect(progSpan).toHaveAttribute("data-prog-tier", "512");
    metrics.chatInlineTier = (await progSpan.getAttribute("data-prog-tier")) ?? "";

    const inlineNatural = await picBtn.locator("img").evaluate((im: HTMLImageElement) => [im.naturalWidth, im.naturalHeight]);
    expect(inlineNatural).toEqual([512, 384]);

    // Before opening Lightbox, only ?w=64 / ?w=512 were fetched for this file (never bare original)
    const inlineReqs = fileRequests.filter((r) => r.url.includes(chatFile.id));
    expect(inlineReqs.length).toBeGreaterThanOrEqual(1);
    expect(inlineReqs.some((r) => r.w === "512")).toBe(true);
    expect(inlineReqs.filter((r) => r.w === null)).toEqual([]);

    // Click to open Lightbox: immediately shows cached 512 tier ("sharp", never blank "well"), then upgrades to "orig" (1600x1200)
    await picBtn.click();
    const lbProg = ada.page.locator(".chat-lightbox .f-prog");
    await expect(lbProg).toBeVisible();
    const initialPhase = (await lbProg.getAttribute("data-prog-phase")) ?? "";
    expect(initialPhase, "Lightbox must paint immediately from L1 cache without blank well").toBe("sharp");
    metrics.chatLightboxInitialPhase = initialPhase;

    await expect(lbProg).toHaveAttribute("data-prog-tier", "orig", { timeout: 15_000 });
    await expect
      .poll(
        async () =>
          ada.page.locator(".chat-lightbox img").evaluate((im: HTMLImageElement) => [im.naturalWidth, im.naturalHeight]),
        { timeout: 15_000 },
      )
      .toEqual([1600, 1200]);
    metrics.chatLightboxFinalNatural = [1600, 1200];

    expect(fileRequests.some((r) => r.url.includes(chatFile.id) && r.w === null)).toBe(true);

    await ada.page.keyboard.press("Escape");
    await expect(ada.page.locator(".chat-lightbox")).toHaveCount(0);
  } finally {
    await ada.context.close();
  }
});

test("4. #/design Day & Night visual verification + interactive specimen controls", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const page = await context.newPage();
  try {
    await page.goto("/?rafshim#/design");
    await expect(page.locator(".design-page")).toBeVisible({ timeout: 30_000 });

    const setScheme = async (wantNight: boolean) => {
      const cur = await page.evaluate(() => document.documentElement.classList.contains("is-night"));
      if (cur !== wantNight) {
        await page.locator(".design-head .night-orb, .night-orb").first().click();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.classList.contains("is-night")))
          .toBe(wantNight);
      }
      await settle(page, 1500);
    };

    // ---- Section A: Progressive cached images ----
    await setScheme(false);
    const imgSection = page.locator(".design-section", {
      has: page.locator("h2", { hasText: /^Progressive cached images$/ }),
    });
    await imgSection.scrollIntoViewIfNeeded();
    await expect(imgSection.locator("[data-design-progressive-image]")).toBeVisible();

    const badge = imgSection.locator("[data-prog-demo-badge]");
    await expect(badge).toHaveText("512w · 42 KB");

    // Verify "Shed off-screen VRAM" button
    await imgSection.getByRole("button", { name: "Shed off-screen VRAM" }).click();
    await expect(badge).toHaveText("shed -> 64w");

    // Verify "Simulate L1 hit" button
    await imgSection.getByRole("button", { name: "Simulate L1 hit" }).click();
    await expect(badge).toHaveText("L1 hit · 0 ms");

    // Verify "Replay cold load" progresses through stages back to 512w sharp
    await imgSection.getByRole("button", { name: "Replay cold load" }).click();
    await expect(badge).toHaveText(/well|64w/);
    await expect(badge).toHaveText("512w · 42 KB", { timeout: 5000 });

    await imgSection.scrollIntoViewIfNeeded();
    await settle(page, 600);
    await page.screenshot({ path: join(EVIDENCE_DIR, "01_design-images-day.png") });

    // Switch to Night via NightOrb and capture
    await setScheme(true);
    await imgSection.scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: join(EVIDENCE_DIR, "02_design-images-night.png") });

    // ---- Section B: People on a hosted server ----
    await setScheme(false);
    const peopleSection = page.locator(".design-section", {
      has: page.locator("h2", { hasText: /^People on a hosted server$/ }),
    });
    await peopleSection.scrollIntoViewIfNeeded();
    const kaiRow = peopleSection.locator('[data-person-email="kai@formindustries.co"]');
    const adaRow = peopleSection.locator('[data-person-email="ada@formindustries.co"]');
    await expect(kaiRow).toHaveAttribute("data-person-role", "member");
    await expect(adaRow).toHaveAttribute("data-person-role", "admin");

    // Last admin's role buttons are disabled when Ada is the sole admin
    await expect(adaRow.getByRole("radio", { name: "Member" })).toBeDisabled();

    // Promote Kai to Admin in PeopleSectionDemo -> Kai's role updates & Ada's control unlocks
    await kaiRow.getByRole("radio", { name: "Admin" }).click();
    await expect(kaiRow).toHaveAttribute("data-person-role", "admin");
    await expect(adaRow.getByRole("radio", { name: "Member" })).toBeEnabled();

    await peopleSection.scrollIntoViewIfNeeded();
    await settle(page, 600);
    await page.screenshot({ path: join(EVIDENCE_DIR, "03_design-people-day.png") });

    // Switch to Night via NightOrb and capture
    await setScheme(true);
    await peopleSection.scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: join(EVIDENCE_DIR, "04_design-people-night.png") });
  } finally {
    await context.close();
  }
});

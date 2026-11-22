/**
 * Self-contained end-to-end verification of Hosted Foundation + ChatForm + Bearer Image Caching
 * + Hosted Local-Feature Boundaries + Admin People Management (plan card `hosted-chat-check`, #230).
 *
 * Spins up:
 *   1. Stand-in Google OAuth server on a free loopback port.
 *   2. Real Foundation server in hosted mode (`FOUNDATION_PUBLIC_URL=http://foundation.localhost:<port>`),
 *      serving the built web client (`apps/client/dist`) with dev login turned off.
 *   3. Second origin (`http://localhost:<appPort>`) simulating the desktop app window (`BEARER === true`).
 *
 *   E2E_SERVER_PORT=15430 E2E_CLIENT_PORT=15450 E2E_SLACK_PORT=15440 E2E_MESHY_PORT=15445 npm run e2e -w @foundation/client -- hosted-chat.spec.ts
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_DIR = resolve(HERE, "..");
const SERVER_DIR = resolve(HERE, "../../server");
const REPO_ROOT = resolve(HERE, "../../..");
const DIST_DIR = join(CLIENT_DIR, "dist");
const EVIDENCE_DIR = join(REPO_ROOT, "docs/evidence/2026-11-21_images-hosted-chat");

const TEST_CLIENT_ID = "test-client.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-secret";

const PEOPLE: Record<string, { email: string; email_verified: boolean; name: string }> = {
  ada: { email: "ada@formindustries.co", email_verified: true, name: "Ada Lovelace" },
  kai: { email: "kai@formindustries.co", email_verified: true, name: "Kai Moreno" },
  outsider: { email: "someone@gmail.com", email_verified: true, name: "Someone Else" },
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

function hostBaseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

async function generateJpegBuffer(page: Page, width: number, height: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h }) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "rgb(48, 88, 172)");
      grad.addColorStop(1, "rgb(46, 125, 84)");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);

      const img = g.getImageData(0, 0, w, h);
      const d = img.data;
      let seed = 0x517cc1b7;
      for (let i = 0; i < d.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const delta = ((seed >>> 20) & 0x2f) - 24;
        d[i] = Math.max(0, Math.min(255, d[i] + delta));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + delta));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + delta));
      }
      g.putImageData(img, 0, 0);

      g.strokeStyle = "rgba(255, 255, 255, 0.9)";
      g.lineWidth = 6;
      g.strokeRect(64, 64, w - 128, h - 128);

      const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    },
    { w: width, h: height },
  );
  return Buffer.from(b64, "base64");
}

interface HostedMetrics {
  hostedOrigin: string;
  desktopOrigin: string;
  adaRoleInitial: string;
  kaiRoleInitial: string;
  kaiRolePromoted: string;
  deviceCodeFormatOk: boolean;
  bearerNeverInUrl: boolean;
  outsiderBlocked: boolean;
  chatImageCookieTier: string;
  chatImageBearerTier: string;
  bearerL2EntriesBeforeReload: number;
  bearerReloadImageRequests: number;
  offlineReconnectDelivered: boolean;
  capabilities: unknown;
  hostTerminalStatus: number;
  hostBrowserStatus: number;
}

const hostedMetrics: Partial<HostedMetrics> = {};

let googleServer: Server;
let desktopWindowServer: Server;
let foundationProc: ChildProcess | null = null;
let hostedDataDir = "";
let hostedPort = 0;
let hostedOrigin = "";
let desktopOrigin = "";

let adaCtx: BrowserContext | null = null;
let adaPage: Page | null = null;
let kaiCtx: BrowserContext | null = null;
let kaiPage: Page | null = null;
let kaiBearer = "";

test.describe.configure({ mode: "serial" });
// Override playwright.config.ts's `extraHTTPHeaders: { origin: CLIENT }` so Chromium sends genuine browser Origin headers
// for `http://foundation.localhost:<port>` and `http://localhost:<appPort>`.
test.use({ extraHTTPHeaders: {} });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // 1. Build web client (`apps/client/dist`) with VITE_E2E_HOOKS=1 so hosted server serves the exact current UI
  const viteBin = resolve(REPO_ROOT, "node_modules/vite/bin/vite.js");
  execFileSync(process.execPath, [viteBin, "build"], {
    cwd: CLIENT_DIR,
    env: { ...hostBaseEnv(), VITE_E2E_HOOKS: "1" },
    stdio: "pipe",
  });
  expect(existsSync(join(DIST_DIR, "index.html")), "apps/client/dist/index.html must exist after vite build").toBe(true);

  // 2. Start stand-in Google OAuth server
  googleServer = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/o/oauth2/v2/auth") {
      const back = u.searchParams.get("redirect_uri") ?? "";
      const state = u.searchParams.get("state") ?? "";
      const links = Object.entries(PEOPLE)
        .map(
          ([key, p]) =>
            `<p><a data-account="${escHtml(key)}" href="${escHtml(`${back}?code=code-${key}&state=${encodeURIComponent(state)}`)}">${escHtml(p.name)} · ${escHtml(p.email)}</a></p>`,
        )
        .join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Stand-in Google</title><body><h1>Choose an account</h1>${links}</body>`);
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (u.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(body);
        const who = (form.get("code") ?? "").replace(/^code-/, "");
        if (!PEOPLE[who] || form.get("client_secret") !== TEST_CLIENT_SECRET) {
          res.writeHead(400, { "content-type": "application/json" }).end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `at-${who}` }));
        return;
      }
      const who = (req.headers.authorization ?? "").replace(/^Bearer at-/, "");
      if (u.pathname === "/userinfo" && PEOPLE[who]) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(PEOPLE[who]));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((ok) => googleServer.listen(0, "127.0.0.1", ok));
  const googlePort = (googleServer.address() as AddressInfo).port;
  const googleBase = `http://127.0.0.1:${googlePort}`;

  // 3. Start simulated Desktop App window origin (`http://localhost:<appPort>`) serving `apps/client/dist`
  desktopWindowServer = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    let file = join(DIST_DIR, pathname);
    if (pathname.includes("..") || !existsSync(file) || !statSync(file).isFile()) {
      file = join(DIST_DIR, "index.html");
    }
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => desktopWindowServer.listen(0, "127.0.0.1", ok));
  const appPort = (desktopWindowServer.address() as AddressInfo).port;
  desktopOrigin = `http://localhost:${appPort}`;

  // 4. Start real Foundation server in hosted mode at `http://foundation.localhost:<hostedPort>`
  hostedPort = await freePort();
  hostedOrigin = `http://foundation.localhost:${hostedPort}`;
  hostedDataDir = mkdtempSync(join(tmpdir(), "foundation-hosted-e2e-"));

  foundationProc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...hostBaseEnv(),
      FOUNDATION_HOST: "127.0.0.1",
      FOUNDATION_PORT: String(hostedPort),
      FOUNDATION_PUBLIC_URL: hostedOrigin,
      FOUNDATION_CLIENT_DIR: DIST_DIR,
      FOUNDATION_CLIENT_URL: hostedOrigin,
      FOUNDATION_CORS_ORIGINS: desktopOrigin,
      FOUNDATION_DATA_DIR: hostedDataDir,
      FOUNDATION_ALLOWLIST: "@formindustries.co",
      FOUNDATION_ADMIN_EMAILS: "ada@formindustries.co",
      FOUNDATION_DEV_LOGIN: "0",
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
      GOOGLE_ACCOUNTS_BASE: googleBase,
      GOOGLE_OAUTH_BASE: googleBase,
      GOOGLE_USERINFO_URL: `${googleBase}/userinfo`,
      FOUNDATION_STARTER_DIR: "",
      FOUNDATION_AVATARS_REPO: "",
      FOUNDATION_CLAUDE_CLI: "/nonexistent/claude",
      T3_CLI: "/nonexistent/t3",
      T3_URL: "http://127.0.0.1:9",
      T3CODE_HOME: "/nonexistent/t3home",
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLogs = "";
  foundationProc.stdout?.on("data", (d) => (serverLogs += String(d)));
  foundationProc.stderr?.on("data", (d) => (serverLogs += String(d)));

  // Wait for hosted server `/api/health` to answer with `hosted: true`
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${hostedPort}/api/health`, {
        headers: { host: `foundation.localhost:${hostedPort}` },
      });
      if (r.ok) {
        const body = (await r.json()) as { ok: boolean; hosted: boolean };
        if (body.ok && body.hosted === true) {
          ready = true;
          break;
        }
      }
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(ready, `Hosted Foundation failed to boot on :${hostedPort}.\nLogs:\n${serverLogs}`).toBe(true);

  hostedMetrics.hostedOrigin = hostedOrigin;
  hostedMetrics.desktopOrigin = desktopOrigin;
});

test.afterAll(async () => {
  await adaCtx?.close();
  await kaiCtx?.close();
  if (foundationProc && !foundationProc.killed) {
    foundationProc.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
  googleServer?.close();
  desktopWindowServer?.close();
  if (hostedDataDir) {
    try {
      rmSync(hostedDataDir, { recursive: true, force: true });
    } catch {
      /* Windows SQLite lock release lag */
    }
  }
  writeFileSync(join(EVIDENCE_DIR, "hosted-chat-metrics.json"), JSON.stringify(hostedMetrics, null, 2));
});

test("1. Hosted sign-in: Ada in browser (cookie admin), outsider refused, Kai in desktop window (device code + bearer member)", async ({ browser }) => {
  test.setTimeout(120_000);

  // ---- Ada signs in via stand-in Google in browser cookie mode -> arrives as `admin` ----
  adaCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    extraHTTPHeaders: {},
  });
  await adaCtx.addInitScript(() => {
    localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
  });
  adaPage = await adaCtx.newPage();
  await adaPage.goto(`${hostedOrigin}/?rafshim`);
  await expect(adaPage.locator("a.login-btn")).toBeVisible({ timeout: 30_000 });
  // Dev login is off on hosted server
  await expect(adaPage.getByRole("button", { name: "Use your email" })).toHaveCount(0);

  await adaPage.locator("a.login-btn").click();
  await adaPage.locator('[data-account="ada"]').click();
  await adaPage.waitForURL(new RegExp(`foundation\\.localhost:${hostedPort}/(\\?arrive)?`));
  await expect(adaPage.locator(".top-bar").first()).toBeVisible({ timeout: 45_000 });

  const adaMe = (await adaPage.evaluate(() => fetch("/api/me").then((r) => r.json()))) as {
    user: { id: string; email: string; name: string; role: string };
  };
  expect(adaMe.user.email).toBe("ada@formindustries.co");
  expect(adaMe.user.role).toBe("admin");
  hostedMetrics.adaRoleInitial = adaMe.user.role;

  const adaCookie = (await adaCtx.cookies(hostedOrigin)).find((c) => c.name === "foundation_session");
  expect(adaCookie?.httpOnly).toBe(true);
  expect(adaCookie?.sameSite).toBe("Lax");

  // ---- Someone off the allowlist is refused with zero session ----
  const outCtx = await browser.newContext({ viewport: { width: 900, height: 640 }, extraHTTPHeaders: {} });
  const outPage = await outCtx.newPage();
  await outPage.goto(`${hostedOrigin}/?rafshim`);
  await outPage.locator("a.login-btn").click();
  await outPage.locator('[data-account="outsider"]').click();
  await expect(outPage.getByText("Sign-in didn't finish")).toBeVisible();
  await expect(outPage.locator("body")).toContainText(/not on Foundation's allowlist/);
  expect((await outCtx.cookies(hostedOrigin)).find((c) => c.name === "foundation_session")).toBeUndefined();
  hostedMetrics.outsiderBlocked = true;
  await outCtx.close();

  // ---- Kai signs in from simulated Tauri desktop window (`BEARER === true`) via device code + "This is me" ----
  kaiCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    extraHTTPHeaders: {},
  });
  await kaiCtx.addInitScript(
    ({ winOrigin, serverOrigin }) => {
      if (location.origin === winOrigin && !localStorage.getItem("foundation-server")) {
        localStorage.setItem("foundation-server", serverOrigin);
        localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
      }
    },
    { winOrigin: desktopOrigin, serverOrigin: hostedOrigin },
  );
  kaiPage = await kaiCtx.newPage();
  await kaiPage.goto(`${desktopOrigin}/?rafshim`);
  await expect(kaiPage.locator("button.login-btn").first()).toBeVisible({ timeout: 30_000 });
  await expect(kaiPage.locator("body")).toContainText(`Server · foundation.localhost:${hostedPort}`);

  const [confirmTab] = await Promise.all([
    kaiCtx.waitForEvent("page"),
    kaiPage.locator("button.login-btn").first().click(),
  ]);
  await confirmTab.locator('[data-account="kai"]').click();
  await expect(confirmTab.getByText("Sign in an app?")).toBeVisible();

  const code = (await confirmTab.locator(".code").innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  hostedMetrics.deviceCodeFormatOk = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
  await expect(kaiPage.getByText(code).first()).toBeVisible({ timeout: 10_000 });

  // Before pressing "This is me", desktop window holds NO bearer token
  await kaiPage.waitForTimeout(2000);
  expect(await kaiPage.evaluate((k) => localStorage.getItem(k), `foundation-bearer:${hostedOrigin}`)).toBeNull();

  await confirmTab.getByRole("button", { name: /This is me/ }).click();
  await expect(confirmTab.getByText("That app is signed in")).toBeVisible();
  const confirmTabUrl = confirmTab.url();
  await confirmTab.close();
  await kaiPage.bringToFront();

  await expect(kaiPage.locator(".top-bar").first()).toBeVisible({ timeout: 45_000 });

  kaiBearer = (await kaiPage.evaluate((k) => localStorage.getItem(k), `foundation-bearer:${hostedOrigin}`)) ?? "";
  expect(kaiBearer.length).toBeGreaterThan(20);
  expect((await kaiCtx.cookies(hostedOrigin)).find((c) => c.name === "foundation_session")).toBeUndefined();
  expect(kaiPage.url().includes(kaiBearer)).toBe(false);
  expect(confirmTabUrl.includes(kaiBearer)).toBe(false);
  hostedMetrics.bearerNeverInUrl = !kaiPage.url().includes(kaiBearer) && !confirmTabUrl.includes(kaiBearer);

  const kaiMe = (await kaiPage.evaluate(
    ([srv, b]) => fetch(`${srv}/api/me`, { headers: { authorization: `Bearer ${b}` } }).then((r) => r.json()),
    [hostedOrigin, kaiBearer],
  )) as { user: { id: string; email: string; role: string } };
  expect(kaiMe.user.email).toBe("kai@formindustries.co");
  expect(kaiMe.user.role).toBe("member");
  hostedMetrics.kaiRoleInitial = kaiMe.user.role;
});

test("2. Hosted ChatForm: #general live, unread badge, thread, reaction, DM, image ?w=512 + bearer L2 cache across reload, offline reconnect", async () => {
  test.setTimeout(180_000);
  expect(adaPage && kaiPage && kaiCtx).toBeTruthy();
  const ada = adaPage!;
  const kai = kaiPage!;

  const waitChatLoaded = (p: Page) =>
    p.waitForFunction(() => (window as unknown as { __chatform?: () => { loaded: boolean } }).__chatform?.().loaded === true, undefined, { timeout: 25_000 });
  await Promise.all([waitChatLoaded(ada), waitChatLoaded(kai)]);

  // Keep Kai on `#/today` so we can verify live unread badge on `.top-bar [data-top-chat]`
  await kai.evaluate(() => {
    window.location.hash = "#/today";
  });
  await expect(kai.locator(".chatform")).toHaveCount(0);

  // Ada opens ChatForm (`#general`) and mentions Kai
  await ada.locator(".top-bar [data-top-chat]").click();
  await expect(ada.locator(".chatform")).toBeVisible();
  await expect(ada.locator(".chat-head-name")).toHaveText("general");

  const composer = (p: Page, where: "channel" | "thread" = "channel") => p.locator(`[data-chat-composer="${where}"] textarea`);
  const message = (p: Page, text: string) => p.locator(".chat-timeline .chat-msg", { hasText: text });

  await composer(ada).fill("Morning @kai.moreno — hosted Foundation ChatForm is live!");
  await composer(ada).press("Enter");
  await expect(message(ada, "hosted Foundation ChatForm is live")).toBeVisible();

  // Verify Kai's top-bar unread badge updates live before opening ChatForm
  const kaiBadge = kai.locator(".top-bar [data-top-chat] [data-chat-badge]");
  await expect(kaiBadge).toHaveText("1", { timeout: 15_000 });

  // Kai opens ChatForm -> lands on #general, sees mention, and unread badge clears
  await kai.locator(".top-bar [data-top-chat]").click();
  await expect(kai.locator(".chatform")).toBeVisible();
  await expect(kai.locator(".chat-head-name")).toHaveText("general");
  await expect(message(kai, "hosted Foundation ChatForm is live")).toBeVisible();
  await expect(kai.locator(".chat-mention.is-me")).toHaveText("@kai.moreno");
  await expect(kaiBadge).toHaveCount(0, { timeout: 10_000 });

  // Kai replies in #general -> Ada sees it live
  await composer(kai).fill("Connected from the desktop bearer window — zero cookies needed.");
  await composer(kai).press("Enter");
  await expect(message(ada, "Connected from the desktop bearer window")).toBeVisible({ timeout: 15_000 });

  // Reply in a thread: Kai replies to Ada's message; Ada sees "1 reply" summary live
  const firstMsg = message(kai, "hosted Foundation ChatForm is live");
  await firstMsg.hover();
  await firstMsg.getByRole("button", { name: "Reply in thread" }).click();
  await expect(kai.locator("[data-thread-pane]")).toBeVisible();
  await composer(kai, "thread").fill("Thread check: thermal telemetry matches CAD.");
  await composer(kai, "thread").press("Enter");
  await expect(kai.locator("[data-thread-pane] .chat-msg", { hasText: "thermal telemetry matches CAD" })).toBeVisible();
  await expect(message(ada, "hosted Foundation ChatForm is live").locator("[data-thread-summary]")).toContainText("1 reply", { timeout: 15_000 });
  // Close thread pane on Kai and let layout settle so #general has full room
  await kai.locator("[data-thread-pane] .chat-head-btn").click();
  await expect(kai.locator("[data-thread-pane]")).toHaveCount(0);
  await kai.waitForTimeout(350);

  // Add a reaction: Ada reacts on Kai's message; Kai sees reaction pill live
  const secondMsg = message(ada, "Connected from the desktop bearer window");
  await secondMsg.scrollIntoViewIfNeeded();
  await secondMsg.hover();
  await secondMsg.locator(".chat-hoverbar-quick").first().click();
  const reactionPill = message(kai, "Connected from the desktop bearer window").locator(".chat-reaction").first();
  await expect(reactionPill).toContainText("1", { timeout: 15_000 });
  await expect(reactionPill).toHaveAttribute("data-tip", /Ada Lovelace reacted/);

  // Upload an image in #general -> verify BOTH browser (cookie) and desktop (bearer) render via `?w=512`
  const adaImgReqs: string[] = [];
  const kaiImgReqs: string[] = [];
  const onAdaReq = (req: { url(): string }) => {
    if (req.url().includes("/files/")) adaImgReqs.push(req.url());
  };
  const onKaiReq = (req: { url(): string }) => {
    if (req.url().includes("/files/")) kaiImgReqs.push(req.url());
  };
  ada.on("request", onAdaReq);
  kai.on("request", onKaiReq);

  const imgBuf = await generateJpegBuffer(ada, 1600, 1200);
  await ada.locator('[data-chat-composer="channel"] input[type="file"]').setInputFiles({
    name: "pthp-shroud-1600.jpg",
    mimeType: "image/jpeg",
    buffer: imgBuf,
  });
  await expect(ada.locator('[data-chat-composer="channel"] .chat-chip.is-done')).toBeVisible({ timeout: 15_000 });
  await composer(ada).fill("Here is the 1600×1200 shroud capture.");
  await composer(ada).press("Enter");

  const adaProg = message(ada, "shroud capture").locator(".chat-picture .f-prog");
  const kaiProg = message(kai, "shroud capture").locator(".chat-picture .f-prog");
  await expect(adaProg).toHaveAttribute("data-prog-phase", "sharp", { timeout: 20_000 });
  await expect(kaiProg).toHaveAttribute("data-prog-phase", "sharp", { timeout: 20_000 });
  await expect(adaProg).toHaveAttribute("data-prog-tier", "512");
  await expect(kaiProg).toHaveAttribute("data-prog-tier", "512");

  hostedMetrics.chatImageCookieTier = (await adaProg.getAttribute("data-prog-tier")) ?? "";
  hostedMetrics.chatImageBearerTier = (await kaiProg.getAttribute("data-prog-tier")) ?? "";

  expect(adaImgReqs.some((u) => u.includes("?w=512"))).toBe(true);
  expect(kaiImgReqs.some((u) => u.includes("?w=512"))).toBe(true);
  // Neither client downloaded the full 1600x1200 original for inline chat display
  expect(adaImgReqs.filter((u) => !u.includes("?w="))).toEqual([]);
  expect(kaiImgReqs.filter((u) => !u.includes("?w="))).toEqual([]);

  ada.off("request", onAdaReq);
  kai.off("request", onKaiReq);

  // Capture screenshots 05 (browser cookie) and 06 (desktop bearer)
  await ada.waitForTimeout(700);
  await kai.waitForTimeout(700);
  await ada.screenshot({ path: join(EVIDENCE_DIR, "05_hosted-chat-browser.png") });
  await kai.screenshot({ path: join(EVIDENCE_DIR, "06_hosted-chat-desktop-bearer.png") });

  // Verify desktop bearer window stored the image in `foundation-image-cache-v2` and survives reload with 0 network refetches!
  await expect
    .poll(
      async () =>
        kai.evaluate(async () => {
          if (!(await caches.has("foundation-image-cache-v2"))) return 0;
          const c = await caches.open("foundation-image-cache-v2");
          return (await c.keys()).length;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1);

  const l2KeysBefore = await kai.evaluate(async () => {
    const c = await caches.open("foundation-image-cache-v2");
    return (await c.keys()).map((k) => k.url);
  });
  hostedMetrics.bearerL2EntriesBeforeReload = l2KeysBefore.length;

  const kaiReloadImgReqs: string[] = [];
  const onKaiReloadReq = (req: { url(): string }) => {
    if (req.url().includes("/files/")) kaiReloadImgReqs.push(req.url());
  };
  kai.on("request", onKaiReloadReq);

  await kai.reload();
  await expect(kai.locator(".chatform")).toBeVisible({ timeout: 30_000 });
  const kaiProgAfterReload = message(kai, "shroud capture").locator(".chat-picture .f-prog");
  await expect(kaiProgAfterReload).toHaveAttribute("data-prog-phase", "sharp", { timeout: 15_000 });
  await expect(kaiProgAfterReload).toHaveAttribute("data-prog-tier", "512");
  await kai.waitForTimeout(600);
  kai.off("request", onKaiReloadReq);

  expect(kaiReloadImgReqs, "desktop bearer must serve cached image from foundation-image-cache-v2 across reload without refetching").toEqual([]);
  hostedMetrics.bearerReloadImageRequests = kaiReloadImgReqs.length;

  // ---- Start & exchange a DM + verify unread count ----
  await ada.locator('[data-side-section="direct"] .chat-side-add').click({ force: true });
  await ada.locator(".chat-modal .chat-people input").fill("Kai");
  await ada.locator('.chat-modal [data-person="Kai Moreno"]').click();
  await ada.locator("[data-new-direct-start]").click();
  await expect(ada.locator(".chat-head-name")).toHaveText("Kai Moreno");

  await composer(ada).fill("DM check: shipping crate arrives Tuesday morning.");
  await composer(ada).press("Enter");
  await expect(message(ada, "shipping crate arrives Tuesday")).toBeVisible();

  const dmId = await ada.evaluate(() => window.location.hash.split("/")[3] ?? "");
  expect(dmId).toMatch(/^ch_/);

  // Kai sees the new DM row with unread count `1`, opens it, and replies
  await expect(kai.locator(`[data-channel-row="${dmId}"]`).first()).toBeVisible({ timeout: 15_000 });
  await expect(kai.locator(`[data-channel-row="${dmId}"] .chat-count.is-accent`).first()).toHaveText("1");
  await kai.locator(`[data-channel-row="${dmId}"]`).first().click();
  await expect(kai.locator(".chat-head-name")).toHaveText("Ada Lovelace");
  await expect(message(kai, "shipping crate arrives Tuesday")).toBeVisible();

  await composer(kai).fill("Copy that — bay 2 is ready for Tuesday.");
  await composer(kai).press("Enter");
  await expect(message(ada, "bay 2 is ready for Tuesday")).toBeVisible({ timeout: 15_000 });

  // Return both to #general for offline drop & reconnect test
  await ada.locator('[data-channel-name="general"]').first().click();
  await kai.locator('[data-channel-name="general"]').first().click();
  await expect(ada.locator(".chat-head-name")).toHaveText("general");
  await expect(kai.locator(".chat-head-name")).toHaveText("general");

  // ---- Drop Kai's network (`setOffline(true)`), Ada sends a message, Kai reconnects (`setOffline(false)`) -> arrives without reload ----
  await kaiCtx!.setOffline(true);
  const offlineMsg = `Sent while Kai was offline ${Date.now()}`;
  await composer(ada).fill(offlineMsg);
  await composer(ada).press("Enter");
  await expect(message(ada, offlineMsg)).toBeVisible();
  await ada.waitForTimeout(2000);

  await kaiCtx!.setOffline(false);
  await expect(message(kai, offlineMsg)).toBeVisible({ timeout: 45_000 });
  hostedMetrics.offlineReconnectDelivered = true;
});

test("3. Hosted local-feature boundaries: capabilities API, 403 route guards even for admin, and [data-hosted-terminal] UI notice", async () => {
  expect(adaPage).toBeTruthy();
  const ada = adaPage!;

  // 1. Verify GET /api/capabilities
  const caps = (await ada.evaluate(() => fetch("/api/capabilities").then((r) => r.json()))) as {
    hosted: boolean;
    local: Record<string, boolean>;
  };
  expect(caps.hosted).toBe(true);
  expect(caps.local.terminal).toBe(false);
  expect(caps.local.browser).toBe(false);
  expect(caps.local.machines).toBe(false);
  expect(caps.local.vms).toBe(false);
  expect(caps.local.t3).toBe(false);
  expect(caps.local.places).toBe(false);
  hostedMetrics.capabilities = caps;

  // 2. Verify POST /api/host-terminal and POST /api/host-browser return 403 even for admin Ada
  const termRes = await ada.evaluate(async () => {
    const r = await fetch("/api/host-terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: r.status, body: (await r.json()) as { error?: string } };
  });
  expect(termRes.status).toBe(403);
  expect(termRes.body.error).toMatch(/turned off on a hosted Foundation server/);
  hostedMetrics.hostTerminalStatus = termRes.status;

  const browserRes = await ada.evaluate(async () => {
    const r = await fetch("/api/host-browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: r.status, body: (await r.json()) as { error?: string } };
  });
  expect(browserRes.status).toBe(403);
  expect(browserRes.body.error).toMatch(/turned off on a hosted Foundation server/);
  hostedMetrics.hostBrowserStatus = browserRes.status;

  // 3. Open the Terminal tool in the UI on `#/board` and verify `[data-hosted-terminal]` shows with zero auto-POST
  await ada.evaluate(() => {
    window.location.hash = "#/board";
  });
  await expect(ada.locator(".grid-viewport")).toBeVisible({ timeout: 20_000 });

  const autoTermPosts: string[] = [];
  const onTermPost = (req: { url(): string; method(): string }) => {
    if (req.method() === "POST" && req.url().includes("/api/host-terminal")) autoTermPosts.push(req.url());
  };
  ada.on("request", onTermPost);

  await ada.locator('[data-tool-open="terminal"]').click();
  const hostedNotice = ada.locator("[data-hosted-terminal]");
  await expect(hostedNotice).toBeVisible();
  await expect(hostedNotice).toContainText("turned off on a hosted Foundation server");
  await ada.waitForTimeout(600);
  ada.off("request", onTermPost);
  expect(autoTermPosts, "TerminalTool must not auto-fire POST /api/host-terminal when caps.local.terminal is false").toEqual([]);

  await ada.screenshot({ path: join(EVIDENCE_DIR, "07_hosted-tools-boundary.png") });
  await ada.locator(".tool-close").click();
});

test("4. Admin People management in Settings -> General: Ada sees Ada & Kai, promotes Kai to admin, and verifies persistence", async () => {
  expect(adaPage && kaiPage).toBeTruthy();
  const ada = adaPage!;
  const kai = kaiPage!;

  await ada.evaluate(() => {
    window.location.hash = "#/settings/general";
  });
  await expect(ada.locator(".settings-space[data-settings-tab='general']")).toBeVisible();

  const adaRow = ada.locator('[data-person-email="ada@formindustries.co"]');
  const kaiRow = ada.locator('[data-person-email="kai@formindustries.co"]');
  await expect(adaRow).toBeVisible({ timeout: 15_000 });
  await expect(kaiRow).toBeVisible({ timeout: 15_000 });
  await expect(adaRow).toHaveAttribute("data-person-role", "admin");
  await expect(kaiRow).toHaveAttribute("data-person-role", "member");

  // Sole admin cannot demote herself
  await expect(adaRow.getByRole("radio", { name: "Member" })).toBeDisabled();

  // Promote Kai to Admin
  await kaiRow.getByRole("radio", { name: "Admin" }).click();
  await expect(kaiRow).toHaveAttribute("data-person-role", "admin", { timeout: 10_000 });
  await expect(adaRow.getByRole("radio", { name: "Member" })).toBeEnabled();

  await kaiRow.scrollIntoViewIfNeeded();
  await ada.waitForTimeout(600);
  await ada.screenshot({ path: join(EVIDENCE_DIR, "08_hosted-people-settings.png") });

  // Reload Ada's Settings page and verify Kai's `admin` role persisted in SQLite
  await ada.reload();
  await expect(ada.locator('[data-person-email="kai@formindustries.co"]')).toHaveAttribute("data-person-role", "admin", { timeout: 15_000 });

  // Verify Kai's bearer `/api/me` also reflects `role: "admin"`
  const kaiMeAfter = (await kai.evaluate(
    ([srv, b]) => fetch(`${srv}/api/me`, { headers: { authorization: `Bearer ${b}` } }).then((r) => r.json()),
    [hostedOrigin, kaiBearer],
  )) as { user: { role: string } };
  expect(kaiMeAfter.user.role).toBe("admin");
  hostedMetrics.kaiRolePromoted = kaiMeAfter.user.role;
});

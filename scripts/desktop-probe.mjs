#!/usr/bin/env node
// Drive the running desktop window over WebView2's DevTools port and photograph it.
//
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222   (before starting the app)
//   node scripts/desktop-probe.mjs <out-dir> [--login "Name" email] [--server http://localhost:4410] [--fresh]
//
// Windows only (WebView2 is Chromium, so Playwright attaches over CDP). Prints the
// page's origin, whether the sync socket came up, and what the server answered.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [out = "probe", ...rest] = process.argv.slice(2);
const li = rest.indexOf("--login");
const login = li >= 0 ? { name: rest[li + 1], email: rest[li + 2] } : null;
mkdirSync(out, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages())[0];
if (!page) throw new Error("no page in the window");
const sockets = [];
page.on("websocket", (ws) => {
  const s = { url: ws.url(), frames: 0, closed: false };
  sockets.push(s);
  ws.on("framereceived", () => s.frames++);
  ws.on("close", () => (s.closed = true));
});
const failures = [];
page.on("requestfailed", (r) => failures.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => r.status() >= 400 && failures.push(`${r.status()} ${r.request().method()} ${r.url()}`));

console.log("origin", await page.evaluate(() => location.origin));
if (rest.includes("--fresh")) {
  // start signed out with no device copies: dev and packaged builds share one WebView2 profile
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Storage.clearDataForOrigin", { origin: await page.evaluate(() => location.origin), storageTypes: "all" });
  await page.reload();
}
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, "01_window.png") });

if (login) {
  const openEmail = page.locator("button.login-or");
  if (await openEmail.isVisible().catch(() => false)) await openEmail.click();
  await page.getByPlaceholder("Your name").fill(login.name);
  await page.getByPlaceholder("Work email").fill(login.email);
  await page.getByPlaceholder("Work email").press("Enter");
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(out, "02_signed-in.png") });
}

// the server the window talks to: same origin in dev (Vite proxies), localhost:4410 when packaged
const si = rest.indexOf("--server");
const server = si >= 0 ? rest[si + 1] : "";
const me = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/api/me`, { credentials: "include" });
  return { status: r.status, body: await r.text() };
}, server);
console.log(`me (${server || "same origin"})`, me.status, me.body.slice(0, 160));
console.log("sockets", JSON.stringify(sockets));
console.log("failures", JSON.stringify(failures.slice(0, 12)));
console.log("text", (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 400));
await browser.close().catch(() => {});

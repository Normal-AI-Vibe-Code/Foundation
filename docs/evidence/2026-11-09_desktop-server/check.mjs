#!/usr/bin/env node
// Drive the packaged desktop window over WebView2's DevTools port: what server it was told to use,
// sign in with dev login, open the company board, ask the crew for one thing, photograph each step.
//
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=19222   (before starting the app)
//   node check.mjs <out-dir> [--tag name] [--login "Name" email] [--ask "prompt" --expect "text on the board"]
//
// Windows only (WebView2 is Chromium, so Playwright attaches over CDP).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [out = ".", ...rest] = process.argv.slice(2);
const arg = (name, n = 1) => {
  const i = rest.indexOf(name);
  return i < 0 ? null : n === 1 ? rest[i + 1] : rest.slice(i + 1, i + 1 + n);
};
const tag = arg("--tag") ?? "window";
const login = arg("--login", 2);
const ask = arg("--ask");
const expectText = arg("--expect");
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(out, `${tag}_${name}.png`) });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT ?? 19222}`);
const page = browser.contexts().flatMap((c) => c.pages())[0];
if (!page) throw new Error("no page in the window");
const failures = [];
page.on("requestfailed", (r) => failures.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));

const told = await page.evaluate(() => ({ origin: location.origin, server: window.__FOUNDATION_SERVER__ ?? null, error: window.__FOUNDATION_SERVER_ERROR__ ?? null }));
console.log("page", JSON.stringify(told));
await page.waitForTimeout(1500);
await shot(page, "01_opened");

if (login && (await page.locator(".section-card").count()) === 0) {
  const openEmail = page.locator("button.login-or").first();
  if (!(await page.getByPlaceholder("Work email").isVisible().catch(() => false)) && (await openEmail.isVisible().catch(() => false))) await openEmail.click();
  await page.getByPlaceholder("Your name").fill(login[0]);
  await page.getByPlaceholder("Work email").fill(login[1]);
  await page.getByPlaceholder("Work email").press("Enter");
  // the board is open: its sections are on the floor (the production build has no dev hooks to ask)
  await page.locator(".section-card").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await shot(page, "02_signed-in-board");
}

// what the server itself says, asked from the page with the session the window holds
const server = await page.evaluate(async () => {
  const base = window.__FOUNDATION_SERVER__;
  const key = Object.keys(localStorage).find((k) => k.startsWith("foundation-bearer:"));
  const headers = key ? { authorization: `Bearer ${localStorage.getItem(key)}` } : {};
  const get = async (p) => {
    try {
      const r = await fetch(base + p, { headers });
      return r.ok ? r.json() : { status: r.status };
    } catch (e) {
      return { unreachable: String(e.message) };
    }
  };
  const me = await get("/api/me");
  const boards = await get("/api/boards");
  return { health: await get("/api/health"), me: me.user ? { name: me.user.name, role: me.user.role } : me, boards: boards.boards?.map((b) => b.id) ?? boards, bearerFor: key ?? null };
});
console.log("server", JSON.stringify(server));
console.log("board", JSON.stringify({ sections: await page.locator(".section-card").count() }));

if (ask) {
  const notesText = () => page.evaluate(() => document.body.innerText);
  const before = await notesText();
  await page.mouse.click(700, 80); // the floor has the keys
  await page.keyboard.press("Space");
  await page.locator('.talk-sheet[data-mode="typing"] .talk-field').waitFor({ timeout: 5000 });
  await page.keyboard.type(ask);
  await shot(page, "03_asking");
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.locator(".crew-row").first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "04_agent-working");
  let landed = false;
  while (Date.now() - t0 < 240_000) {
    const now = await notesText();
    if (expectText ? now.includes(expectText) : now !== before) {
      landed = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  console.log("agent", JSON.stringify({ landed, seconds: Math.round((Date.now() - t0) / 1000) }));
  await page.waitForTimeout(4000);
  await shot(page, "05_agent-done");
  console.log("crew", (await page.locator(".talk-sheet, .crew-row").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 600));
}

console.log("failures", JSON.stringify(failures.slice(0, 12)));
console.log("text", (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 500));
await browser.close().catch(() => {});

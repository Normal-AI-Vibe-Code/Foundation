// The check of a hosted Foundation, in real browsers, against deploy/compose.yml running locally
// (compose.check.yml: https://foundation.localhost, a stand-in Google on :15700).
//
//   node docs/evidence/2026-11-20_hosted/check.mjs <folder holding the image's /app/client>
//
// Ada signs in from a browser at the hosted address (the cookie). Kai signs in from the desktop app's
// page (the same client build served at http://localhost:31440, pointed at the hosted server: the bearer,
// a code and a press). Someone off the allowlist is turned away. Then the two chat in #general, live,
// and both are on the company board. Screenshots land beside this file.
import { chromium } from "@playwright/test";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HOSTED = "https://foundation.localhost";
const WINDOW = "http://localhost:31440";
const SHOTS = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2];
if (!dist || !existsSync(join(dist, "index.html"))) throw new Error("pass the folder holding the built client (docker cp <container>:/app/client <folder>)");

// the desktop app's window: the built client at its fixed origin (tauri-plugin-localhost does this in the app)
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png" };
const windowServer = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, WINDOW).pathname);
  let file = join(dist, path);
  if (path.includes("..") || !existsSync(file) || !statSync(file).isFile()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => windowServer.listen(31440, "127.0.0.1", ok));

const said = [];
const ok = (line) => (said.push(line), console.log(`  ✔ ${line}`));
const browser = await chromium.launch();
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const signedIn = (page) => page.locator(".top-bar").first().waitFor({ state: "visible", timeout: 45_000 });

try {
  // ---------- Ada: a browser at the hosted address ----------
  const adaCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const ada = await adaCtx.newPage();
  await ada.goto(HOSTED);
  await ada.locator("a.login-btn").waitFor({ state: "visible", timeout: 30_000 });
  await ada.waitForTimeout(1500);
  await shot(ada, "01_browser-sign-in-page");
  await ada.locator("a.login-btn").click();
  await ada.locator('[data-account="ada"]').click();
  await ada.waitForURL(/foundation\.localhost\/(\?arrive)?/);
  await signedIn(ada);
  const adaMe = await ada.evaluate(() => fetch("/api/me").then((r) => r.json()));
  assert.equal(adaMe.user.email, "ada@formindustries.co");
  assert.equal(adaMe.user.role, "admin");
  const cookie = (await adaCtx.cookies(HOSTED)).find((c) => c.name === "foundation_session");
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Lax", "the session cookie is Secure, HttpOnly, SameSite=Lax");
  ok(`browser: Ada signed in at ${HOSTED} through Google and arrived as an admin; her cookie is Secure, HttpOnly, SameSite=Lax`);
  await ada.waitForTimeout(2500);
  await shot(ada, "02_browser-signed-in");

  // ---------- someone off the allowlist ----------
  const outCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 600 } });
  const out = await outCtx.newPage();
  await out.goto(HOSTED);
  await out.locator("a.login-btn").click();
  await out.locator('[data-account="outsider"]').click();
  await out.getByText("Sign-in didn't finish").waitFor();
  assert.match(await out.locator("body").innerText(), /not on Foundation's allowlist/);
  assert.equal((await outCtx.cookies(HOSTED)).find((c) => c.name === "foundation_session"), undefined);
  const asked = await outCtx.newPage();
  await asked.goto(`${HOSTED}/api/me`);
  assert.equal(JSON.parse(await asked.locator("body").innerText()).user, null);
  await asked.close();
  ok("an address off the allowlist gets a page that says so, and no session");
  await shot(out, "03_off-the-allowlist");
  await outCtx.close();

  // ---------- Kai: the desktop app's page, pointed at the hosted server ----------
  const kaiCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await kaiCtx.addInitScript((server) => {
    if (location.origin === "http://localhost:31440") localStorage.setItem("foundation-server", server);
  }, HOSTED);
  const kai = await kaiCtx.newPage();
  await kai.goto(WINDOW);
  await kai.locator("button.login-btn").first().waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await kai.locator("body").innerText(), /Server · foundation\.localhost/);
  await kai.waitForTimeout(1500);
  await shot(kai, "04_app-sign-in-page");
  const [tab] = await Promise.all([kaiCtx.waitForEvent("page"), kai.locator("button.login-btn").first().click()]);
  await tab.locator('[data-account="kai"]').click();
  await tab.getByText("Sign in an app?").waitFor();
  const code = (await tab.locator(".code").innerText()).trim();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await kai.getByText(code).first().waitFor({ timeout: 10_000 });
  ok(`app: the window shows the code ${code} and the browser shows the same one back`);
  await shot(kai, "05_app-waiting-with-code");
  await tab.setViewportSize({ width: 900, height: 640 });
  await shot(tab, "06_browser-this-is-me");
  // not pressed yet: the app has nothing
  await kai.waitForTimeout(3500);
  assert.equal(await kai.evaluate((k) => localStorage.getItem(k), `foundation-bearer:${HOSTED}`), null, "no session before the press");
  await tab.getByRole("button", { name: /This is me/ }).click();
  await tab.getByText("That app is signed in").waitFor();
  await signedIn(kai);
  const bearer = await kai.evaluate((k) => localStorage.getItem(k), `foundation-bearer:${HOSTED}`);
  assert.ok(bearer, "the app holds a bearer for the hosted server");
  assert.equal((await kaiCtx.cookies(HOSTED)).find((c) => c.name === "foundation_session"), undefined, "and no session cookie was set for it");
  assert.ok(!kai.url().includes(bearer) && !tab.url().includes(bearer), "the bearer is in no URL");
  const kaiMe = await kai.evaluate(([server, b]) => fetch(`${server}/api/me`, { headers: { authorization: `Bearer ${b}` } }).then((r) => r.json()), [HOSTED, bearer]);
  assert.equal(kaiMe.user.email, "kai@formindustries.co");
  assert.equal(kaiMe.user.role, "member");
  ok("app: nothing reached the window before the press; after This is me Kai is signed in as a member with a bearer (no cookie, nothing in a URL)");
  await kai.waitForTimeout(2500);
  await shot(kai, "07_app-signed-in");

  // ---------- one board ----------
  const boardState = (page) =>
    page.evaluate(() => {
      const w = window;
      return { status: w.__foundationBoard?.()?.status ?? null, sections: w.__foundation ? Object.keys(w.__foundation.getState().sections).length : null };
    });
  for (const [who, page] of [["Ada", ada], ["Kai", kai]]) {
    await page.goto(`${page === ada ? HOSTED : WINDOW}/?board=company`);
    await signedIn(page);
    await page.waitForFunction(() => window.__foundationBoard?.()?.status === "live" || window.__foundationBoard === undefined, undefined, { timeout: 30_000 });
    const st = await boardState(page);
    if (st.status) ok(`${who} is on the company board: sync ${st.status}, ${st.sections} sections`);
  }
  // Ada adds a note through the board's tools; Kai's window has it without a reload
  const mark = `Hosted check ${Date.now()}`;
  const made = await ada.evaluate((text) => fetch("/api/boards/company/tools/add_note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: text, markdown: "Added by Ada from the browser.", request_id: `check-${text}` }) }).then(async (r) => ({ status: r.status, body: await r.text() })), mark);
  assert.equal(made.status, 200, made.body);
  await kai.getByText(mark).first().waitFor({ state: "attached", timeout: 20_000 });
  ok("one board: a note Ada adds on the company board is in Kai's window live");
  await kai.waitForTimeout(1500);
  await shot(kai, "08_app-company-board");

  // ---------- ChatForm: the two of them in #general ----------
  const openChat = async (page) => {
    await page.locator(".top-bar [data-top-chat]").click();
    await page.locator(".chatform").waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(".chat-head-name").filter({ hasText: "general" }).waitFor({ timeout: 20_000 });
  };
  await openChat(ada);
  await openChat(kai);
  const composer = (page) => page.locator('[data-chat-composer="channel"] textarea');
  const message = (page, text) => page.locator(".chat-timeline .chat-msg", { hasText: text });
  await composer(ada).fill("Hello from the browser. Is the hosted server up for you?");
  await composer(ada).press("Enter");
  await message(kai, "Hello from the browser").waitFor({ timeout: 20_000 });
  await composer(kai).fill("It is. This is the desktop app's page, signed in with a code.");
  await composer(kai).press("Enter");
  await message(ada, "signed in with a code").waitFor({ timeout: 20_000 });
  const authors = await ada.evaluate(() => fetch("/api/chat").then((r) => r.json()).then((c) => c.people.map((p) => p.name).sort()));
  assert.ok(authors.includes("Ada Lovelace") && authors.includes("Kai Moreno"));
  ok("ChatForm: Ada (browser) and Kai (app) see each other's messages in #general live, each under their own name");
  await ada.waitForTimeout(1200);
  await shot(ada, "09_chat-browser");
  await shot(kai, "10_chat-app");

  // a dropped connection comes back: Kai goes offline and returns, and gets what he missed
  await kaiCtx.setOffline(true);
  await composer(ada).fill("Sent while Kai was offline.");
  await composer(ada).press("Enter");
  await ada.waitForTimeout(2500);
  await kaiCtx.setOffline(false);
  await message(kai, "Sent while Kai was offline").waitFor({ timeout: 45_000 });
  ok("after Kai's network drops and returns, the message sent meanwhile arrives without a reload");
  console.log(`\n  ${said.length} checks passed`);
} finally {
  await browser.close();
  windowServer.close();
}

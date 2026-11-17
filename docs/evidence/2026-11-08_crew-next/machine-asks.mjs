/**
 * Evidence for machine_run (2026-11-08): an agent's command in a machine a
 * person started, approved per command, against the real engine on this
 * computer (Docker Desktop here), two people and a viewer in Chromium.
 *
 *   FOUNDATION_PORT=15410 FOUNDATION_ENGINES=docker=npipe:////./pipe/docker_engine \
 *     FOUNDATION_ADMIN_EMAILS=ada@formindustries.com node --import tsx apps/server/src/index.ts
 *   (cd apps/client && FOUNDATION_CLIENT_PORT=15437 FOUNDATION_SERVER_URL=http://127.0.0.1:15410 npx vite)
 *   node docs/evidence/2026-11-08_crew-next/machine-asks.mjs http://localhost:15437
 *
 * Writes screenshots next to this file and prints what it measured.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../../apps/client/package.json"));
const { chromium } = require("@playwright/test");

const CLIENT = process.argv[2] ?? "http://localhost:15437";
const shot = (name) => join(here, name);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
async function person(name, email, scheme = "dark") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, baseURL: CLIENT });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  if (!res.ok()) throw new Error(`dev login ${email}: ${res.status()}`);
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const me = await (await context.request.get(`${CLIENT}/api/me`)).json();
  return { context, me: me.user };
}
async function open(p, board) {
  const page = await p.context.newPage();
  await page.goto(`/?rafshim&board=${encodeURIComponent(board)}`);
  await page.waitForFunction(() => window.__foundationBoard?.()?.status === "live" && Object.keys(window.__foundation.getState().sections).length > 0, undefined, { timeout: 30_000 });
  return page;
}
const frame = (page, id) => page.evaluate((id) => window.__foundation.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } }), id);
const asks = (page, card) => page.evaluate((card) => window.__foundationBoard().doc.getMap("machineAsks").get(card) ?? [], card);

const ada = await person("Ada Test", "ada@formindustries.com");
const kai = await person("Kai Test", "kai@formindustries.com");
const vic = await person("Vic Test", "vic@formindustries.com");

// a board, a machine card, and Ada starts it (a person, from her browser session)
const board = (await (await ada.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Machine asks ${Date.now().toString(36)}` } })).json()).id;
await ada.context.request.post(`${CLIENT}/api/boards/${board}/people`, { data: { userId: vic.me.id, role: "viewer" } });
const proposed = await (await ada.context.request.post(`${CLIENT}/api/boards/${board}/tools/propose_machine`, { data: { name: "Asks box", image: "alpine" } })).json();
const card = proposed.result.card;
log("board", board, "card", card);
const t0 = Date.now();
const started = await ada.context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/start`, { data: { image: "alpine:3.22" }, timeout: 180_000 });
log("start:", started.status(), (await started.json()).machine?.state, `${Date.now() - t0} ms`);

// an agent acting for Ada: a bearer token, at the HTTP tools door
const token = (await (await ada.context.request.post(`${CLIENT}/api/agent/token`)).json()).token;
const agent = await browser.newContext({ baseURL: CLIENT, extraHTTPHeaders: { authorization: `Bearer ${token}` } });

const adaPage = await open(ada, board);
const kaiPage = await open(kai, board);
const vicPage = await open(vic, board);
for (const p of [adaPage, kaiPage, vicPage]) await frame(p, card);
await sleep(1500);

// 1. the agent asks; its call waits
const t1 = Date.now();
const call1 = agent.request.post(`${CLIENT}/api/boards/${board}/tools/machine_run`, { data: { machine: "asks-box", command: "cat /etc/os-release | head -n 2; uname -m; echo to-stderr >&2", why: "which distro this box runs" }, timeout: 180_000 });
await kaiPage.locator(".machine-ask.is-waiting").waitFor({ timeout: 10_000 });
await adaPage.locator(".machine-ask.is-waiting").waitFor({ timeout: 10_000 });
await vicPage.locator(".machine-ask.is-waiting").waitFor({ timeout: 10_000 });
const [ask] = await asks(kaiPage, card);
log("waiting on the card:", JSON.stringify({ by: ask.by, for: ask.for, state: ask.state, command: ask.command }));
await sleep(600);
const cardOf = (p) => p.locator(`.machine-body`).first();
await cardOf(adaPage).screenshot({ path: shot("10_ask-waiting-ada.png") });
await cardOf(kaiPage).screenshot({ path: shot("11_ask-waiting-kai.png") });
await cardOf(vicPage).screenshot({ path: shot("12_ask-waiting-vic-viewer.png") });
log("viewer sees Run buttons:", await vicPage.locator(".machine-ask.is-waiting .f-pill.is-accent").count());

// refusals: the agent's own bearer, and the viewer's browser
const byBearer = await agent.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/asks/${ask.id}/run`, { data: {} });
log("bearer presses Run:", byBearer.status(), (await byBearer.json()).error ?? "");
const byViewer = await vic.context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/asks/${ask.id}/run`, { data: {} });
log("viewer presses Run:", byViewer.status(), (await byViewer.json()).error ?? "");
log("still waiting:", (await asks(kaiPage, card))[0].state);

// Ada presses Run on her card
await adaPage.locator(".machine-ask.is-waiting .f-pill.is-accent").click();
const r1 = await (await call1).json();
log("agent's call returned after", Date.now() - t1, "ms:", JSON.stringify(r1.result));
await kaiPage.locator(".machine-ask.is-done").waitFor({ timeout: 10_000 });
await sleep(400);
await cardOf(kaiPage).screenshot({ path: shot("13_ran-seen-by-kai.png") });

// 2. declined: nothing runs
const call2 = agent.request.post(`${CLIENT}/api/boards/${board}/tools/machine_run`, { data: { machine: card, command: "rm -rf /srv/cache", why: "clear the old exports" }, timeout: 60_000 });
await kaiPage.locator(".machine-ask.is-waiting").waitFor({ timeout: 10_000 });
await kaiPage.locator(".machine-ask.is-waiting .f-pill", { hasText: "Decline" }).click();
const r2 = await (await call2).json();
log("declined:", JSON.stringify(r2.result));
await sleep(500);
await cardOf(adaPage).screenshot({ path: shot("14_declined-seen-by-ada.png") });

// the board's activity: who asked, for whom, who ran or declined it
const acts = await kaiPage.evaluate(() => window.__foundationBoard().activity().slice(-6));
for (const a of acts) log(`activity: ${a.who} [${a.role}${a.for ? ` for ${a.for}` : ""}] ${a.text}`);

// day: the same card in light
const adaDay = await person("Ada Test", "ada@formindustries.com", "light");
const dayPage = await open(adaDay, board);
await frame(dayPage, card);
await sleep(1200);
await cardOf(dayPage).screenshot({ path: shot("15_answered-day.png") });

// #/design, day and night
for (const scheme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, baseURL: CLIENT });
  await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@formindustries.com" } });
  const p = await ctx.newPage();
  await p.goto("/?rafshim#/design");
  const row = p.locator(".adapt-row", { has: p.locator(".machine-asks") }).first();
  await row.scrollIntoViewIfNeeded();
  await sleep(900);
  await row.screenshot({ path: shot(`16_design-machine-asks-${scheme === "dark" ? "night" : "day"}.png`) });
  await ctx.close();
}

// tidy: Ada removes the machine (a person, with confirm)
const removed = await ada.context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/remove`, { data: { confirm: true } });
log("removed:", removed.status(), (await removed.json()).machine?.state);
await browser.close();

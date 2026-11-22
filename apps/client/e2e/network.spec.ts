/**
 * On your network (apps/server/src/network.ts; docs/server.md), on one machine: the harness server is reached
 * at this computer's own LAN address as if from a second computer (the server sees a peer that isn't
 * loopback, so it is "another computer" for the invitation and for the this-computer-only doors).
 *
 *  1. The admin, at this computer, turns On your network on and invites Kai. Kai's browser (a fresh context)
 *     opens the link at http://<lan-ip>:<port>/#/join/<code>: the code leaves the address bar at once, Kai is
 *     signed in as Kai (a member), ChatForm loads from the page the server serves itself, and a message the
 *     admin posts from localhost arrives live. A this-computer-only door refuses Kai. The page isn't a secure
 *     context there: no camera or microphone (huddles can't send from a plain-http LAN page).
 *  2. A teammate's app stand-in: a page on localhost (as the desktop app's http://localhost:31440 is) pointed
 *     at the LAN address (bearer mode) signs in with the email and the short code, is a secure context, and its
 *     ChatForm socket (a ticket) goes live.
 *  3. The server panel on the admin's side menu, and its chapter on #/design, day and night.
 * Screenshots go to docs/evidence/2026-11-20_server-on-network/. Needs the page built (`npm run build`): it
 * says so and skips 1 if not.
 *
 *   E2E_SERVER_PORT=16731 E2E_CLIENT_PORT=16751 E2E_SLACK_PORT=16741 E2E_MESHY_PORT=16745 E2E_T3_PORT=16795 npm run e2e -w @foundation/client -- network.spec.ts
 */
import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CLIENT, settle } from "./helpers";

const SHOTS = fileURLToPath(new URL("../../../docs/evidence/2026-11-20_server-on-network/", import.meta.url));
const VIRTUAL = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|docker|vboxnet|veth|virbr|^br-|utun|Loopback/i;
const LAN_IP = (() => {
  for (const [iface, list] of Object.entries(networkInterfaces()))
    for (const n of list ?? []) if (n.family === "IPv4" && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address) && !VIRTUAL.test(iface)) return n.address;
  return null;
})();

type Store = { loaded: boolean; status: string; me: { id: string } | null; channels: Record<string, { id: string; name: string }> };
const store = (p: Page) => p.evaluate(() => (window as unknown as { __chatform?: () => Store }).__chatform?.() ?? null);

test.describe.configure({ mode: "serial" });
test.skip(!LAN_IP, "this computer has no private LAN address");

let lanUrl = "";
let admin: { context: BrowserContext; page: Page };

/** the admin at this computer, with the side menu open (the server pill lives in its foot) */
async function adminHere(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Admin", email: "admin@normal.dev" } });
  if (!res.ok()) throw new Error(`dev login: ${res.status()} ${await res.text()}`);
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: true, tabs: [], tab: null, search: false })));
  const page = await context.newPage();
  await page.goto("/?board=company");
  return { context, page };
}

test("the switch, an invitation, and ChatForm live on another computer's browser at the LAN address", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  admin = await adminHere(browser);
  const on = await admin.context.request.post(`${CLIENT}/api/server/network`, { data: { on: true } });
  expect(on.ok(), await on.text()).toBe(true);
  const info = await on.json();
  lanUrl = info.network.urls.find((u: { url: string }) => u.url.includes(LAN_IP!))?.url;
  expect(lanUrl, JSON.stringify(info.network)).toBeTruthy();
  const page = await admin.context.request.get(`${lanUrl}/`);
  test.skip(page.status() !== 200, `the page isn't built (${page.status()}): run npm run build`);

  const inv = await admin.context.request.post(`${CLIENT}/api/server/invites`, { data: { email: "kai.lan@normal.dev", name: "Kai on the LAN" } });
  expect(inv.ok(), await inv.text()).toBe(true);
  const link: string = (await inv.json()).links.find((l: { url: string }) => l.url.startsWith(lanUrl)).url;

  // another computer's browser: nothing installed, nothing remembered, no headers of the harness's own
  const kaiCtx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: "dark", extraHTTPHeaders: {}, baseURL: lanUrl });
  const kai = await kaiCtx.newPage();
  await kai.goto(link);
  await expect.poll(() => kai.url()).not.toContain("#/join/");
  await kai.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().loaded === true, undefined, { timeout: 45_000 });
  const me = await kai.evaluate(async () => (await (await fetch("/api/me")).json()) as { user: { email: string; role: string } });
  expect(me.user.email).toBe("kai.lan@normal.dev");
  expect(me.user.role).toBe("member");

  // ChatForm, from the page the server serves itself
  await kai.locator(".top-bar [data-top-chat]").click();
  await expect(kai.locator(".chatform")).toBeVisible();
  await expect(kai.locator(".chat-head-name")).toHaveText("general");
  await expect.poll(async () => (await store(kai))?.status, { timeout: 15_000 }).toBe("live");

  // a message from the person at localhost arrives live on the LAN browser
  const general = Object.values((await store(kai))!.channels).find((c) => c.name === "general")!;
  const said = `from this computer, over the network ${Date.now() % 100000}`;
  const post = await admin.context.request.post(`${CLIENT}/api/chat/channels/${general.id}/messages`, { data: { text: said, request_id: `lan-${Date.now()}` } });
  expect(post.ok(), await post.text()).toBe(true);
  await expect(kai.locator(".chat-timeline .chat-msg", { hasText: said })).toBeVisible({ timeout: 10_000 });
  await settle(kai, 600);
  await kai.screenshot({ path: `${SHOTS}03_lan-browser-chatform.png` });

  // a this-computer-only door refuses Kai; the page isn't a secure context (no camera, no microphone)
  const refused = await kai.evaluate(async () => {
    const r = await fetch("/api/places");
    return { status: r.status, error: ((await r.json()) as { error: string }).error };
  });
  expect(refused.status).toBe(403);
  expect(refused.error).toMatch(/computer this server runs on/);
  const secure = await kai.evaluate(() => ({ secure: window.isSecureContext, media: typeof navigator.mediaDevices?.getUserMedia }));
  expect(secure).toEqual({ secure: false, media: "undefined" });

  // the admin sees Kai, from the LAN address, with a socket open
  const list = await admin.context.request.get(`${CLIENT}/api/server/sessions`);
  const kaiRow = (await list.json()).sessions.find((s: { email: string }) => s.email === "kai.lan@normal.dev");
  expect(kaiRow.addr).toBe(LAN_IP);
  expect(kaiRow.live).toBeGreaterThan(0);
  await kaiCtx.close();
});

test("a teammate's app (a localhost page, bearer) points at the LAN address and signs in with the code", async ({ browser }) => {
  test.setTimeout(120_000);
  test.skip(!lanUrl, "the first check didn't open the network");
  const inv = await admin.context.request.post(`${CLIENT}/api/server/invites`, { data: { email: "noa.lan@normal.dev", name: "Noa on the LAN" } });
  const { code } = (await inv.json()) as { code: string };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: "light", extraHTTPHeaders: {} });
  // the Server line, as a person sets it on the sign-in page (kept on the device)
  await ctx.addInitScript((url) => localStorage.getItem("foundation-server") ?? localStorage.setItem("foundation-server", url), lanUrl);
  const p = await ctx.newPage();
  await p.goto(CLIENT);
  const form = p.locator("[data-login-invite-form]");
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.locator('input[type="email"]').fill("noa.lan@normal.dev");
  await form.locator('input[aria-label="Invitation code"]').fill(code.toLowerCase());
  await settle(p, 400);
  await p.screenshot({ path: `${SHOTS}04_app-sign-in-with-code.png` });
  await form.locator("button.login-go").click();
  await p.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().status === "live", undefined, { timeout: 45_000 });
  const env = await p.evaluate(() => ({ secure: window.isSecureContext, media: typeof navigator.mediaDevices?.getUserMedia, bearer: Object.keys(localStorage).some((k) => k.startsWith("foundation-bearer:")) }));
  expect(env).toEqual({ secure: true, media: "function", bearer: true });
  await ctx.close();
});

test("the server panel at this computer, and its chapter on #/design, day and night", async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  if (admin) {
    const pill = admin.page.locator('.side-pane [data-server-where="pane"] .server-switch-pill');
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await pill.click();
    const panel = admin.page.locator("#server-switch-panel");
    await expect(panel.locator(".server-about")).toBeVisible();
    await expect(panel).toContainText(lanUrl ? "On your network" : "This computer");
    if (lanUrl) {
      await panel.locator('input[aria-label="Their name"]').fill("Lin");
      await panel.locator('input[aria-label="Their work email"]').fill("lin@normal.dev");
      await panel.locator('button[type="submit"]', { hasText: "Invite" }).click();
      await expect(panel.locator(".server-net-code")).toBeVisible();
    }
    await settle(admin.page, 700);
    await admin.page.screenshot({ path: `${SHOTS}05_server-panel-night.png` });
    // off again: this computer only
    if (lanUrl) await admin.context.request.post(`${CLIENT}/api/server/network`, { data: { on: false } });
    await admin.context.close();
  }
  for (const [scheme, name] of [["light", "01_design-day"], ["dark", "02_design-night"]] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1600 }, colorScheme: scheme });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator(".server-switch-demo");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator("[data-server-demo]").first()).toBeVisible();
    // each state on its own (the page scrolls inside its own pane, so a picture of the whole chapter is clipped)
    for (const i of [0, 1, 2, 4]) {
      const one = demo.locator(`[data-server-demo="${i}"]`);
      await one.scrollIntoViewIfNeeded();
      await settle(p, 500);
      await one.screenshot({ path: `${SHOTS}${name}_state${i}.png` });
    }
    await c.close();
  }
});

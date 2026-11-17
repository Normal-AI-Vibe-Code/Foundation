/**
 * Machines, fixed (Josh, 2026-11-17: "Add a desktop doesn't work in Kiri …
 * the selection around the window is still weird, it should be within the
 * section when it's actively being typed into"), in a real browser against
 * the engine on this computer (skipped where none answers).
 *
 *   1. The ring. A running machine wears no ring of its own (it wore an
 *      agent's: violet, breathing, 8 px outside the card and so outside the
 *      section it fills). While it has the keys the ring is the well's: inside
 *      the section and the card, 2 px on the screen at the section's fit,
 *      zoomed out and zoomed in, by day and by night, on a machine that fills
 *      its section and on one that is a card among others; none in full
 *      screen. The keys line stays with it.
 *   2. Add a desktop when it can't work, and when it can: a server older than
 *      the app says so on the card (it said "not found" in a toast); an
 *      install can be stopped; then the desktop goes in, and its ring goes
 *      round the machine's screen, inside its well.
 *   3. The packaged app's transport: the production build served from another
 *      origin (as tauri-plugin-localhost serves it), signed in with a bearer,
 *      sockets by ticket. Runs when E2E_BEARER_DIST names a build made with
 *      VITE_E2E_HOOKS=1 (see NOTES.md).
 *
 * Screenshots land in docs/evidence/2026-11-17_machines-fixes/.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_machines-fixes";
mkdirSync(SHOTS, { recursive: true });

type Tool = (name: string, data: object) => Promise<{ result?: any; error?: string }>;

async function engineUp(context: BrowserContext) {
  const r = (await (await context.request.get(`${CLIENT}/api/machines/engines`)).json()) as { engines: Array<{ id: string; up: boolean }> };
  return r.engines.some((e) => e.up);
}

async function newBoard(context: BrowserContext, name: string): Promise<{ board: string; tool: Tool }> {
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `${name} ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool: Tool = async (n, data) => (await context.request.post(`${CLIENT}/api/boards/${board}/tools/${n}`, { data })).json();
  return { board, tool };
}

const frameSection = (page: Page, card: string) =>
  page.evaluate((id) => {
    const f = (window as any).__foundation;
    f.setState({ snapRequest: { kind: "section", id: f.getState().panels[id].sectionId, nonce: Math.random() } });
  }, card);

/** everything about the ring that could look wrong, measured on the screen */
const ringOf = (page: Page, card: string) =>
  page.evaluate((id) => {
    const slot = document.querySelector<HTMLElement>(`[data-obj-id="${id}"]`)!;
    const well = slot.querySelector<HTMLElement>(".machine-term-wrap, .machine-desk")!;
    const own = slot.querySelector<HTMLElement>(".machine-desk-ring");
    const cs = own ? getComputedStyle(own) : getComputedStyle(well, "::after");
    const box = (r: DOMRect) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
    const drawn = well.getBoundingClientRect().width / well.offsetWidth;
    const section = slot.closest<HTMLElement>(".section-card")!;
    const cardEl = slot.matches(".fs-able") ? slot : slot.querySelector<HTMLElement>(".fs-able")!;
    // the ring is an inset shadow: its spread is its width, in the card's own pixels
    const spread = cs.content !== "none" && cs.display !== "none" ? parseFloat(/([\d.]+)px inset$/.exec(cs.boxShadow)?.[1] ?? "0") : 0;
    return {
      shown: spread > 0,
      // the ring's own box: the well's, or the desktop's screen inside it
      ring: box((own ?? well).getBoundingClientRect()),
      well: box(well.getBoundingClientRect()),
      card: box(cardEl.getBoundingClientRect()),
      section: box(section.getBoundingClientRect()),
      /** the ring's width as drawn on the screen */
      px: spread * drawn,
      drawn,
      hasKeys: well.classList.contains("has-keys"),
      // nothing else rings the machine: no agent's ring, no section ring, no selection ring on the card
      agentRings: document.querySelectorAll(".agent-ring").length,
      sectionRing: getComputedStyle(section, "::after").opacity,
      cardShadow: getComputedStyle(cardEl).boxShadow,
      cardActive: cardEl.classList.contains("ctx-active"),
      keysLine: slot.querySelector(".machine-keys")?.textContent ?? "",
    };
  }, card);

const inside = (a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }, slack = 0.6) => a.l >= b.l - slack && a.t >= b.t - slack && a.r <= b.r + slack && a.b <= b.b + slack;

async function clickWell(page: Page, card: string) {
  const box = (await page.locator(`[data-obj-id="${card}"] .machine-term-wrap, [data-obj-id="${card}"] .machine-desk`).first().boundingBox())!;
  // the middle of what is on the screen of it (zoomed in, a well is bigger than the window)
  const x0 = Math.max(box.x, 40), x1 = Math.min(box.x + box.width, 1400);
  const y0 = Math.max(box.y, 110), y1 = Math.min(box.y + box.height, 780);
  await page.mouse.click((x0 + x1) / 2, (y0 + y1) / 2);
}

/** zoom the grid about a point that is not a card (so nothing scrolls instead) */
async function zoom(page: Page, dy: number) {
  const before = await page.evaluate(() => (document.querySelector(".world") as HTMLElement).getBoundingClientRect().width);
  await page.mouse.move(720, 870);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, dy);
  await page.keyboard.up("Control");
  await settle(page, 1300);
  return before;
}

test("the in-use ring is the well's: inside the section, 2 px at any zoom, day and night, and a running machine wears no other", async ({ browser }) => {
  test.setTimeout(300_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  const { board, tool } = await newBoard(context, "Ring");
  await tool("add_section", { name: "Box" });
  await tool("add_section", { name: "Mixed" });
  const stamp = Date.now().toString(36);
  // the first machine in a section fills it; the second is a card among others
  const host = (await tool("propose_machine", { section: "Box", name: `ring-a-${stamp}`, image: "alpine" })).result.card as string;
  await tool("add_note", { section: "Mixed", title: "First", markdown: "a note that came first" });
  const among = (await tool("propose_machine", { section: "Mixed", name: `ring-b-${stamp}`, image: "alpine" })).result.card as string;
  for (const c of [host, among]) expect((await context.request.post(`${CLIENT}/api/boards/${board}/machines/${c}/start`, { data: {} })).status()).toBe(200);
  try {
    for (const scheme of ["dark", "light"] as const) {
      const time = scheme === "dark" ? "night" : "day";
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/?board=${board}`);
      await waitLive(page);
      await page.waitForFunction(() => Object.keys((window as any).__foundation.getState().panels).length > 1);
      for (const [label, card] of [["hosting-a-section", host], ["card-among-others", among]] as const) {
        await frameSection(page, card);
        await page.locator(`[data-obj-id="${card}"] .machine-term .xterm`).waitFor({ timeout: 60_000 });
        await settle(page, 1800);

        // running, nobody typing: no ring of any kind (it wore an agent's ring, outside the card)
        const idle = await ringOf(page, card);
        expect(idle.agentRings, "a running machine is not an agent at work").toBe(0);
        expect(idle.shown).toBe(false);
        expect(idle.hasKeys).toBe(false);
        expect(idle.keysLine).toBe("");
        if (scheme === "dark") await page.screenshot({ path: `${SHOTS}/ring_${label}_idle_${time}.png` });

        for (const z of ["fit", "far", "near"] as const) {
          if (z === "far") await zoom(page, 400);
          if (z === "near") await zoom(page, -700);
          await clickWell(page, card);
          await expect(page.locator(`[data-obj-id="${card}"] .xterm-helper-textarea`)).toBeFocused();
          await page.mouse.move(8, 500);
          await settle(page, 700);
          const r = await ringOf(page, card);
          const where = `${label} ${time} ${z} (drawn at ${Math.round(r.drawn * 100)} %)`;
          expect(r.shown, where).toBe(true);
          expect(r.keysLine, where).toContain("Keys go to this machine");
          // inside the well, so inside the card and the section: never on or past the section's edge
          expect(inside(r.ring, r.well), `${where}: the ring is the well's`).toBe(true);
          expect(inside(r.ring, r.card), `${where}: inside the card`).toBe(true);
          expect(r.ring.l - r.section.l, `${where}: inside the section's left edge`).toBeGreaterThan(2);
          expect(r.section.r - r.ring.r, `${where}: inside the section's right edge`).toBeGreaterThan(2);
          expect(r.section.b - r.ring.b, `${where}: inside the section's bottom edge`).toBeGreaterThan(2);
          // 2 px on the screen whatever the zoom
          expect(Math.abs(r.px - 2), `${where}: ${r.px.toFixed(2)} px on the screen`).toBeLessThan(0.12);
          // and it is the only ring: no agent's, none of the section's, no selection ring on the card
          expect(r.agentRings, where).toBe(0);
          expect(r.sectionRing, `${where}: the section's own ring`).toBe("0");
          expect(r.cardActive, `${where}: the card's selection ring`).toBe(false);
          await page.screenshot({ path: `${SHOTS}/ring_${label}_typing_${time}_${z}.png` });
          // a close look at a corner of the ring, as drawn
          if (z !== "far") await page.screenshot({ path: `${SHOTS}/ring_${label}_typing_${time}_${z}_corner.png`, clip: { x: Math.max(0, r.well.l - 30), y: Math.max(0, r.well.t - 30), width: 220, height: 140 } });
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await expect(page.locator(`[data-obj-id="${card}"] .machine-keys`)).toHaveCount(0);
          expect((await ringOf(page, card)).shown, `${where}: gone with the keys`).toBe(false);
        }

        // a card among others that is the selected one wears the selection ring; with the keys, only the well's
        await frameSection(page, card);
        await settle(page, 1500);
        if (label === "card-among-others") {
          await page.locator(`[data-obj-id="${card}"] .machine-head .machine-engine`).click();
          await settle(page, 400);
          const picked = await ringOf(page, card);
          expect(picked.cardActive, `${time}: a press on the card selects it`).toBe(true);
          expect(picked.cardShadow, `${time}: and it wears the selection ring`).toMatch(/0px 0px 0px 2\.5px/);
          await clickWell(page, card);
          await expect(page.locator(`[data-obj-id="${card}"] .machine-keys`)).toHaveCount(1);
          await settle(page, 500);
          const typing = await ringOf(page, card);
          expect(typing.shown).toBe(true);
          expect(typing.cardShadow, `${time}: one ring: the selection ring stands down while the machine has the keys`).not.toMatch(/0px 0px 0px 2\.5px/);
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await page.mouse.click(8, 500);
          await settle(page, 300);
        }

        // full screen is the machine's alone: the keys line, no ring
        const fb = (await page.locator(`[data-obj-id="${card}"] .machine-term-wrap`).boundingBox())!;
        await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
        await page.keyboard.press("ControlOrMeta+Enter");
        await page.waitForFunction(() => !!document.fullscreenElement);
        await settle(page, 900);
        await clickWell(page, card);
        await expect(page.locator(`[data-obj-id="${card}"] .machine-keys`)).toContainText("Keys go to this machine");
        expect((await ringOf(page, card)).shown, `${label} ${time}: no ring in full screen`).toBe(false);
        if (label === "hosting-a-section") await page.screenshot({ path: `${SHOTS}/ring_${label}_full-screen_${time}.png` });
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => !document.fullscreenElement);
        await settle(page, 700);
      }
    }
  } finally {
    for (const c of [host, among]) await context.request.post(`${CLIENT}/api/boards/${board}/machines/${c}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

test("Add a desktop: an older server says so on the card, an install can be stopped, and the desktop's ring goes round its screen", async ({ browser }) => {
  test.setTimeout(900_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  const { board, tool } = await newBoard(context, "Desk fixes");
  await tool("add_section", { name: "Box" });
  const card = (await tool("propose_machine", { section: "Box", name: `deskfix-${Date.now().toString(36)}`, image: "ubuntu" })).result.card as string;
  expect((await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/start`, { data: {} })).status()).toBe(200);
  try {
    await page.goto(`/?board=${board}`);
    await waitLive(page);
    await page.waitForFunction(() => Object.keys((window as any).__foundation.getState().panels).length > 0);
    await frameSection(page, card);
    await page.locator(".machine-term .xterm").waitFor({ timeout: 60_000 });
    await settle(page, 1200);
    await page.locator(".machine-view-tab", { hasText: "Desktop" }).click();
    const well = page.locator(".machine-desk-well");
    await expect(well).toContainText("has no desktop yet");

    // ---- a Foundation server from before desktops (the owner's: started 2 h before the feature was merged, never
    //      restarted) answers its router's 404 for the route. That is what this is: the same status and body. ----
    await page.route("**/api/boards/*/machines/*/desktop", (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
    await well.getByRole("button", { name: "Add a desktop" }).click();
    await expect(well).toContainText("The desktop didn't go in");
    await expect(well).toContainText("is older than this app and can't add a desktop yet");
    await expect(well).toContainText("Restart it");
    await expect(well.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01_an-older-server-says-so-on-the-card.png` });
    await page.unroute("**/api/boards/*/machines/*/desktop");

    // ---- Try again, on a server that knows how: the install starts; a person can stop it ----
    await well.getByRole("button", { name: "Try again" }).click();
    const progress = page.locator(".machine-desk-progress");
    await expect(progress).toContainText("Adding a desktop", { timeout: 15_000 });
    await expect(progress.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(progress).toContainText(/Downloading|Unpacking|Setting up/, { timeout: 180_000 });
    await page.screenshot({ path: `${SHOTS}/02_installing-with-stop.png` });
    // the head's switch still works meanwhile: the terminal is one press away, and so is the way back
    await page.locator(".machine-view-tab", { hasText: "Terminal" }).click();
    await expect(page.locator(".machine-term .xterm")).toBeVisible();
    await page.locator(".machine-view-tab", { hasText: "Desktop" }).click();
    await progress.getByRole("button", { name: "Stop" }).click();
    await expect(well).toContainText("has no desktop yet", { timeout: 20_000 });
    await expect(well.getByRole("button", { name: "Add a desktop" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/03_stopped-back-to-no-desktop.png` });

    // ---- and again: it picks up from what was unpacked, and the desktop comes ----
    await well.getByRole("button", { name: "Add a desktop" }).click();
    const desk = page.frameLocator(".machine-desk iframe");
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 600_000 });
    await expect(page.locator(".machine-closed")).toHaveCount(0, { timeout: 60_000 });
    await settle(page, 2500);

    for (const scheme of ["dark", "light"] as const) {
      const time = scheme === "dark" ? "night" : "day";
      if (scheme === "light") {
        await page.emulateMedia({ colorScheme: "light" });
        await page.reload();
        await waitLive(page);
        await frameSection(page, card);
        await expect(desk.locator("canvas")).toBeVisible({ timeout: 60_000 });
        await expect(page.locator(".machine-closed")).toHaveCount(0, { timeout: 60_000 });
        await settle(page, 2500);
      }
      expect((await ringOf(page, card)).agentRings).toBe(0);
      await expect(page.locator(".machine-desk-ring")).toHaveCount(0);
      // the section is the active one here (its card's switch was just pressed) and wears its own ring…
      if (scheme === "dark") expect((await ringOf(page, card)).sectionRing, "the section's ring before the keys").toBe("1");
      await clickWell(page, card);
      await expect(page.locator(".machine-keys")).toContainText("Keys go to this desktop");
      await page.mouse.move(8, 500);
      await settle(page, 800);
      const r = await ringOf(page, card);
      expect(r.shown).toBe(true);
      // …which stands down while the desktop has the keys (below): one ring, not two.
      // Round the machine's screen (1280×800, letterboxed), inside its well, inside the section
      const canvas = (await desk.locator("canvas").boundingBox())!;
      expect(Math.abs(r.ring.l - canvas.x), `${time}: the ring's left is the screen's`).toBeLessThan(2.5);
      expect(Math.abs(r.ring.t - canvas.y), `${time}: the ring's top is the screen's`).toBeLessThan(2.5);
      expect(Math.abs(r.ring.r - (canvas.x + canvas.width)), `${time}: the ring's right is the screen's`).toBeLessThan(2.5);
      expect(Math.abs(r.ring.b - (canvas.y + canvas.height)), `${time}: the ring's bottom is the screen's`).toBeLessThan(2.5);
      expect(inside(r.ring, r.well)).toBe(true);
      expect(r.section.b - r.ring.b).toBeGreaterThan(2);
      expect(Math.abs(r.px - 2), `${time}: ${r.px.toFixed(2)} px on the screen`).toBeLessThan(0.12);
      expect(r.agentRings).toBe(0);
      expect(r.sectionRing).toBe("0");
      await page.screenshot({ path: `${SHOTS}/ring_desktop_in-use_${time}.png` });
      await page.mouse.click(8, 500);
      await expect(page.locator(".machine-desk-ring")).toHaveCount(0);
    }
  } finally {
    await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

// ---------- the packaged app's transport ----------

const DIST = process.env.E2E_BEARER_DIST ?? "";
const SERVER = `http://localhost:${process.env.E2E_SERVER_PORT ?? 4430}`;
const APP_PORT = Number(process.env.E2E_CLIENT_PORT ?? 1450) + 3;
const APP = `http://localhost:${APP_PORT}`;
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm", ".ico": "image/x-icon" };

/** the build's files and nothing else, an unknown path answered with index.html: what tauri-plugin-localhost does on :31440 */
function serveBuild(seen: string[]): Promise<Server> {
  const s = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", APP).pathname);
    let file = normalize(join(DIST, path));
    if (!file.startsWith(normalize(DIST)) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    seen.push(`${path} → ${file.slice(normalize(DIST).length).replace(/\\/g, "/")}`);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => s.listen(APP_PORT, "localhost", () => ok(s)));
}

test("the packaged app's way: the production build on another origin, a bearer, sockets by ticket: Add a desktop and see it", async ({ browser }) => {
  test.skip(!DIST || !existsSync(join(DIST, "desktop.html")), "E2E_BEARER_DIST doesn't name a build with desktop.html");
  test.setTimeout(900_000);
  const served: string[] = [];
  const app = await serveBuild(served);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  // sign in as the app does: a session in the body, kept on the device, sent as a header (never a cookie, never in a URL)
  const signIn = await fetch(`${SERVER}/auth/dev`, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify({ name: "Ada Test", email: "ada@normal.dev", bearer: true }) });
  const { session } = (await signIn.json()) as { session: string };
  expect(session, "the server hands the app a session").toBeTruthy();
  const auth = { authorization: `Bearer ${session}`, "content-type": "application/json", origin: APP };
  const call = async (path: string, data: object = {}) => {
    const r = await fetch(`${SERVER}${path}`, { method: "POST", headers: auth, body: JSON.stringify(data) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const engines = (await (await fetch(`${SERVER}/api/machines/engines`, { headers: auth })).json()) as { engines: Array<{ up: boolean }> };
  test.skip(!engines.engines.some((e) => e.up), "no container engine answers on this computer");
  const board = (await call("/api/boards", { name: `Bearer ${Date.now().toString(36)}` })).body.id as string;
  await call(`/api/boards/${board}/tools/add_section`, { name: "Box" });
  const card = (await call(`/api/boards/${board}/tools/propose_machine`, { section: "Box", name: `bearer-${Date.now().toString(36)}`, image: "ubuntu" })).body.result.card as string;
  // a person's press, by the app's bearer: Start
  expect((await call(`/api/boards/${board}/machines/${card}/start`)).status).toBe(200);
  await context.addInitScript(
    ([server, token]) => {
      localStorage.setItem("foundation-server", server);
      localStorage.setItem(`foundation-bearer:${server}`, token);
      localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
    },
    [SERVER, session],
  );
  const page = await context.newPage();
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  const failed: string[] = [];
  page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  try {
    await page.goto(`${APP}/?board=${board}`);
    await waitLive(page);
    // no cookie anywhere: the session is the bearer's alone
    expect((await context.cookies()).filter((c) => /foundation|session/i.test(c.name))).toEqual([]);
    await frameSection(page, card);
    await page.locator(".machine-term .xterm").waitFor({ timeout: 60_000 });
    await settle(page, 1200);
    await page.locator(".machine-view-tab", { hasText: "Desktop" }).click();
    const well = page.locator(".machine-desk-well");
    await expect(well).toContainText("has no desktop yet");
    // the press itself, in the app's transport
    await well.getByRole("button", { name: "Add a desktop" }).click();
    await expect(page.locator(".machine-desk-progress")).toContainText("Adding a desktop", { timeout: 15_000 });
    const desk = page.frameLocator(".machine-desk iframe");
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 600_000 });
    await expect(page.locator(".machine-closed")).toHaveCount(0, { timeout: 60_000 });
    await settle(page, 2500);
    // the frame is the build's second page, from the app's own origin; the machine's screen is in it
    const src = await page.locator(".machine-desk iframe").getAttribute("src");
    expect(src).toMatch(/^\/desktop\.html#board=/);
    expect(served.some((s) => s === "/desktop.html → /desktop.html"), "desktop.html is in the build and served as itself").toBe(true);
    expect(served.filter((s) => /^\/assets\/desktop-.*\.js → \/assets\/desktop-/.test(s)).length, "its script is in the build").toBeGreaterThan(0);
    const size = await desk.locator("canvas").evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
    expect(size).toEqual({ w: 1280, h: 800 });
    // both of the machine's sockets went to the server with a one-time ticket, and neither carries the session
    const vnc = sockets.find((u) => u.includes(`/machines/${board}/${card}/vnc`));
    const tty = sockets.find((u) => u.includes(`/machines/${board}/${card}/tty`));
    expect(vnc, `the desktop's socket: ${sockets.join(" ")}`).toMatch(/^ws:\/\/localhost:\d+\/machines\/.+\/vnc\?.*ticket=/);
    expect(tty).toMatch(/ticket=/);
    expect(sockets.join(" ")).not.toContain(session);
    // using it: a click gives it the keys, and the ring is the screen's
    await clickWell(page, card);
    await expect(page.locator(".machine-keys")).toContainText("Keys go to this desktop");
    await page.mouse.move(8, 500);
    await settle(page, 800);
    const r = await ringOf(page, card);
    expect(r.shown).toBe(true);
    expect(inside(r.ring, r.well)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/04_production-build_other-origin_bearer.png` });
    expect(failed.filter((f) => /desktop|vnc|assets/.test(f)), "nothing of the desktop's failed to load").toEqual([]);
  } finally {
    await call(`/api/boards/${board}/machines/${card}/remove`, { confirm: true });
    await context.close();
    await new Promise((ok) => app.close(ok));
  }
});

test("Machines on #/design: the ring round the well and the screen, and the words when it can't work, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1500 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    await p.locator(".machine-io").first().scrollIntoViewIfNeeded();
    await settle(p, 900);
    const rows = p.locator(".adapt-row", { has: p.locator(".machine-view") });
    const time = scheme === "dark" ? "night" : "day";
    // the terminal's ring is an ::after on the well; the desktop's is round the screen, inside its well
    const term = await p.locator(".machine-term-wrap.has-keys").first().evaluate((el) => ({ ring: getComputedStyle(el, "::after").boxShadow, well: getComputedStyle(el).boxShadow, moves: getComputedStyle(el, "::after").transitionProperty }));
    expect(term.ring).toMatch(/ 0px 0px 0px 2px inset$/);
    expect(term.well).toBe("none");
    expect(term.moves).not.toMatch(/box-shadow/);
    const ring = (await p.locator(".machine-desk-ring.is-screen").first().boundingBox())!;
    const wellBox = (await p.locator(".machine-desk.has-keys").first().boundingBox())!;
    expect(ring.x).toBeGreaterThanOrEqual(wellBox.x);
    expect(ring.x + ring.width).toBeLessThanOrEqual(wellBox.x + wellBox.width + 0.5);
    expect(Math.abs(ring.width / ring.height - 1.6)).toBeLessThan(0.02);
    await expect(p.locator(".machine-desk-progress").nth(1)).toContainText("no word from the package manager for 3 min");
    await expect(p.locator(".machine-desk-progress").nth(1).getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(p.locator(".machine-desk-well", { hasText: "older than this app" })).toContainText("Restart it");
    await rows.nth(0).screenshot({ path: `${SHOTS}/design_${time}_keys-and-ring.png` });
    await rows.nth(1).screenshot({ path: `${SHOTS}/design_${time}_desktop-ring.png` });
    await rows.nth(2).screenshot({ path: `${SHOTS}/design_${time}_desktop-wells.png` });
    await rows.nth(3).screenshot({ path: `${SHOTS}/design_${time}_when-it-cant-work.png` });
    await ctx.close();
  }
});

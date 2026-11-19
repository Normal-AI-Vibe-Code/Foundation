/**
 * 2026-11-17 (Josh): the top right's functions moved to the bottom bar, the top right became the built-in tools,
 * the councils stand at the right, the side menu's foot holds the server and day/night, and night reaches the
 * grid's paper every time. Each check here is one of those asks, measured in a real browser; screenshots go to
 * docs/evidence/2026-11-17_bottom-bar/.
 *
 *   E2E_SERVER_PORT=15630 E2E_CLIENT_PORT=15650 E2E_SLACK_PORT=15640 E2E_MESHY_PORT=15645 npm run e2e -w @foundation/client -- bottom-bar
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, FRAME, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_bottom-bar";
let admin: Page;
let ctx: BrowserContext;

test.describe.configure({ mode: "serial" });

type Store = { getState(): { sections: Record<string, { id: string; name: string }> }; setState(p: object): void };
const box = async (p: Page, sel: string) => (await p.locator(sel).first().boundingBox())!;
const css = (p: Page, sel: string, prop: string) => p.locator(sel).first().evaluate((el, k) => getComputedStyle(el).getPropertyValue(k), prop);
/** a token's colour as the browser resolves it */
const token = (p: Page, name: string, prop = "color") =>
  p.evaluate(
    ([n, k]) => {
      const probe = document.createElement("span");
      probe.style.setProperty(k, `var(${n})`);
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).getPropertyValue(k);
      probe.remove();
      return v;
    },
    [name, prop] as const,
  );

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Admin", "admin@normal.dev");
  admin = a.page;
  ctx = a.context;
});
test.afterAll(async () => {
  // T3 off even if a check stopped half way: dev sign-in is refused while it runs, and the next files sign in
  await ctx?.request.post(`${CLIENT}/api/t3host/stop`, { failOnStatusCode: false }).catch(() => {});
  await ctx?.close();
});

test("the top bar's right end is the tools; search, talk, the zoom, present, commands, the council and Ask (with the agents' settings) are the bottom bar", async () => {
  const top = admin.locator(".top-bar");
  for (const id of ["terminal", "browser", "files", "changes", "t3"]) await expect(top.locator(`[data-tool-open="${id}"]`)).toBeVisible();
  await expect(top.locator("[data-council-open]")).toHaveCount(0);
  await expect(top.locator(".night-orb")).toHaveCount(0);
  await expect(top.locator(".server-switch-place")).toHaveCount(0);
  const hud = admin.locator("[data-hud]");
  await expect(hud.locator(".hud-search")).toBeVisible();
  await expect(hud.locator(".hud-talk")).toBeVisible();
  await expect(hud.locator(".hud-zoom")).toBeVisible();
  await expect(hud.locator('.hud-icon[aria-label="Present"]')).toBeVisible();
  await expect(hud.locator('.hud-icon[aria-label="Commands"]')).toBeVisible();
  await expect(hud.locator("[data-council-open]")).toBeVisible();
  // Ask is on the right, the council beside it, the settings at Ask's end
  const order = await hud.evaluate((el) => [...el.querySelectorAll<HTMLElement>(".hud-search, .hud-talk, .hud-zoom, .hud-icons, .hud-council, .hud-ask, .hud-ask-gear")].map((x) => [x.className.split(" ")[0], Math.round(x.getBoundingClientRect().left)] as const));
  const xs = order.map(([, x]) => x);
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  expect(order.map(([c]) => c)).toEqual(["hud-search", "hud-talk", "hud-zoom", "hud-icons", "hud-icon", "hud-ask", "hud-ask-gear"]);
  // the gear opens the agents panel
  await hud.locator("[data-hud-agents]").click();
  await expect(admin.locator(".agents-pane")).toBeVisible();
  // and the agents panel draws a line, the grid's hairline, between its tabs and what scrolls under them
  expect(await css(admin, ".agents-tabs", "border-bottom-width")).toBe("1px");
  expect(await css(admin, ".agents-tabs", "border-bottom-color")).toBe(await token(admin, "--color-line"));
  const tabs = await box(admin, ".agents-tabs");
  const pane = await box(admin, ".agents-pane");
  expect(Math.abs(tabs.width - (pane.width - 1))).toBeLessThan(3);
  await settle(admin, 400);
  await admin.screenshot({ path: `${SHOTS}/01_bars.png` });
  await hud.locator("[data-hud-agents]").click();
  await expect(admin.locator(".agents-pane")).toHaveCount(0);
});

test("search pops up right above its pill; the pin moves it to the right and back; the line under it is the grid's hairline, typing or not", async () => {
  await admin.locator(".hud-search").click();
  const pop = admin.locator('[data-search-mode="pop"]');
  await expect(pop).toBeVisible();
  await settle(admin, 400);
  const p = (await pop.boundingBox())!;
  const pill = await box(admin, ".hud-search");
  expect(p.y + p.height).toBeLessThanOrEqual(pill.y);
  expect(pill.y - (p.y + p.height)).toBeLessThan(16);
  expect(Math.abs(p.x - pill.x)).toBeLessThan(2);
  await pop.locator(".search-field").fill("Foundation");
  const line = await token(admin, "--color-line");
  expect(await css(admin, '[data-search-mode="pop"] .search-head', "border-bottom-color")).toBe(line);
  await admin.screenshot({ path: `${SHOTS}/02_search-over-the-bar.png` });
  // pinned: a floor pane at the right, the bar's window gone; the line is the same hairline while focused
  await pop.locator("[data-search-pin]").click();
  const pinned = admin.locator('[data-search-mode="pinned"]');
  await expect(pinned).toBeVisible();
  await expect(pop).toHaveCount(0);
  const r = (await pinned.boundingBox())!;
  expect(Math.abs(r.x + r.width - 1440)).toBeLessThan(2);
  await pinned.locator(".search-field").focus();
  expect(await css(admin, '[data-search-mode="pinned"] .search-head', "border-bottom-color")).toBe(line);
  await admin.screenshot({ path: `${SHOTS}/03_search-pinned.png` });
  // ⌘F goes where it was last kept: pinned now
  await admin.keyboard.press("Escape");
  await admin.keyboard.press("Escape");
  await expect(pinned).toHaveCount(0);
  await admin.keyboard.press("Control+f");
  await expect(admin.locator('[data-search-mode="pinned"]')).toBeVisible();
  // unpinned, it goes back over the bar
  await admin.locator("[data-search-pin]").click();
  await expect(admin.locator('[data-search-mode="pop"]')).toBeVisible();
  // a press anywhere else puts the window away
  await admin.mouse.click(720, 300);
  await expect(admin.locator('[data-search-mode="pop"]')).toHaveCount(0);
});

test("the grid's council stands at the right; the bar steps to the bottom left; its buttons keep the bar's distance from the bottom and right edges", async () => {
  await admin.locator("[data-council-open]").click();
  const council = admin.locator(".council.is-board");
  await expect(council).toBeVisible();
  // three places, nobody in them: three silhouettes
  await expect(council.locator(".council-ghost")).toHaveCount(3);
  await settle(admin, 900);
  const hud = await box(admin, "[data-hud]");
  const tools = await box(admin, ".council.is-board .council-tools");
  const H = 900;
  const W = 1440;
  // the bar: bottom left, 16 px in from the left of the open paper and up from the bottom
  expect(Math.abs(hud.x - 16)).toBeLessThan(2);
  expect(Math.abs(H - (hud.y + hud.height) - 16)).toBeLessThan(2);
  // the council's buttons: 16 px from the right and from the bottom, like the bar
  expect(Math.abs(W - (tools.x + tools.width) - 16)).toBeLessThan(2);
  expect(Math.abs(H - (tools.y + tools.height) - 16)).toBeLessThan(2);
  // the figures are at the right, beside the buttons, past the bar
  const seats = await admin.locator(".council.is-board .council-seat").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right })));
  expect(seats[0].l).toBeGreaterThan(hud.x + hud.width);
  expect(tools.x - seats[seats.length - 1].r).toBeLessThan(16);
  // close together
  for (let i = 1; i < seats.length; i++) expect(seats[i].l - seats[i - 1].r).toBeLessThan(6);
  await admin.screenshot({ path: `${SHOTS}/04_council-of-the-grid.png` });
  await admin.keyboard.press("Escape");
  await expect(admin.locator(".council")).toHaveCount(0);
  await settle(admin, 700);
  // the bar is back in the middle
  const back = await box(admin, "[data-hud]");
  expect(Math.abs(back.x + back.width / 2 - W / 2)).toBeLessThan(4);
});

test("a section's council: three places at the section's right, by its Council button, close together, and the empty places breathe", async () => {
  const sid = await admin.evaluate(() => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections)[0].id);
  const card = admin.locator(`.section-card[data-section-id="${sid}"]`);
  await admin.evaluate((id) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), sid);
  await settle(admin, 900);
  await card.hover();
  await card.locator(".sec-council").first().click();
  const council = card.locator(".council.is-section");
  await expect(council).toBeVisible();
  await expect(council.locator(".council-ghost")).toHaveCount(3);
  await settle(admin, 900);
  const sec = (await card.boundingBox())!;
  const seats = await council.locator(".council-seat").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right })));
  const tools = (await council.locator(".council-tools").boundingBox())!;
  // at the right: the last figure is beside the buttons, and the buttons at the section's right edge
  expect(sec.x + sec.width - (tools.x + tools.width)).toBeLessThan(40);
  expect(seats[seats.length - 1].l).toBeGreaterThan(sec.x + sec.width / 2);
  for (let i = 1; i < seats.length; i++) expect(seats[i].l - seats[i - 1].r).toBeLessThan(6);
  // the silhouettes move a little (an animation that runs on and on)
  const anim = await council.locator(".council-ghost .council-figure > *").first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, n: s.animationIterationCount };
  });
  expect(anim).toEqual({ name: "council-ghost-idle", n: "infinite" });
  await admin.screenshot({ path: `${SHOTS}/05_council-of-a-section.png` });
  await admin.keyboard.press("Escape");
});

test("the side menu's foot: the server a small pill right of Settings in its band, day and night left of you, in line with the Settings icon", async () => {
  await admin.locator(".pane-fold").click();
  const pane = admin.locator(".side-pane");
  await expect(pane.locator('[data-server-where="pane"]')).toBeVisible();
  await settle(admin, 500);
  const pill = await box(admin, '.side-pane [data-server-where="pane"] .server-switch-pill');
  const settings = await box(admin, '.side-pane [data-place="settings"] .pane-glyph');
  const orb = await box(admin, ".side-pane .pane-foot .night-orb");
  const me = await box(admin, ".side-pane .pane-foot .me-avatar");
  const paneBox = (await pane.boundingBox())!;
  // in Settings' band: right of it, centred on the same line, small, and inside the menu's right edge
  expect(pill.x).toBeGreaterThan(settings.x + settings.width);
  expect(Math.abs(pill.y + pill.height / 2 - (settings.y + settings.height / 2))).toBeLessThan(3);
  expect(pill.height).toBeLessThanOrEqual(24);
  expect(pill.x + pill.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
  // the orb's left edge in line with the Settings icon
  expect(Math.abs(orb.x - settings.x)).toBeLessThan(3);
  // the orb is left of you
  expect(orb.x + orb.width).toBeLessThanOrEqual(me.x);
  await admin.screenshot({ path: `${SHOTS}/06_side-menu-foot.png` });
  // pressed, its panel opens in the menu's own flow (2026-11-18): inside the menu, right above the band, on no glass
  await admin.locator('.side-pane [data-server-where="pane"] .server-switch-pill').click();
  const panel = admin.locator(".side-pane .pane-server-slot .server-switch-panel");
  await expect(panel).toBeVisible();
  await settle(admin, 700);
  const p = await box(admin, ".side-pane .pane-server-slot .server-switch-panel");
  const band = await box(admin, ".side-pane .pane-low-row");
  expect(p.x).toBeGreaterThanOrEqual(paneBox.x - 1);
  expect(p.x + p.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  expect(Math.abs(p.y + p.height - band.y)).toBeLessThan(3);
  expect(await panel.evaluate((el) => el.classList.contains("f-glass"))).toBe(false);
  // its type is the menu's: the same colour as Settings
  expect(await css(admin, ".side-pane .pane-server-slot .server-switch-option-head strong", "color")).toBe(await css(admin, '.side-pane [data-place="settings"] .pane-label', "color"));
  await admin.screenshot({ path: `${SHOTS}/06b_side-menu-server-open.png` });
  await admin.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("day and night reach the grid's paper, even when the browser has taken the paper's WebGL context", async () => {
  const night = () => admin.evaluate(() => document.documentElement.classList.contains("is-night"));
  const paperNight = () => admin.evaluate(() => (window as unknown as { __foundationBg: { uniforms: { night: number } } }).__foundationBg.uniforms.night);
  const start = await night();
  await admin.locator(".side-pane .night-orb").click();
  expect(await night()).toBe(!start);
  await expect.poll(paperNight, { timeout: 4000 }).toBe(start ? 0 : 1);
  await admin.screenshot({ path: `${SHOTS}/07_${start ? "day" : "night"}.png` });
  // the browser takes the context (too many WebGL pages open): the canvas steps aside, the CSS paper shows, and follows the switch
  await admin.evaluate(() => {
    const lose = document.querySelector<HTMLCanvasElement>(".gl-bg")!.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    (window as unknown as { __lose: WEBGL_lose_context }).__lose = lose;
    lose.loseContext();
  });
  await expect.poll(() => css(admin, ".gl-bg", "visibility")).toBe("hidden");
  const before = await css(admin, ".grid-viewport", "background-color");
  await admin.locator(".side-pane .night-orb").click();
  await expect.poll(() => css(admin, ".grid-viewport", "background-color"), { timeout: 4000 }).not.toBe(before);
  await settle(admin, 1600);
  expect(await css(admin, ".grid-viewport", "background-color")).toBe(await token(admin, "--color-void", "background-color"));
  await admin.screenshot({ path: `${SHOTS}/08_context-lost-still-switches.png` });
  // and when the context comes back, the shader paper does too, in the right light
  await admin.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
  await expect.poll(() => css(admin, ".gl-bg", "visibility")).toBe("visible");
  await expect.poll(paperNight, { timeout: 4000 }).toBe(start ? 1 : 0);
  await admin.locator(".pane-fold").click();
});

test("the tools: a terminal that runs a line for an admin, the change log, the files, a browser, and T3", async ({ browser }) => {
  // the member signs in first: dev sign-in is refused while the built-in terminal (a shell here) is open
  const m = await person(browser, "Ada Test", "ada@normal.dev");
  // terminal: pressing its button starts the shell (no second press); then a line in, its answer and the folder back
  await admin.locator('[data-tool-open="terminal"]').click();
  const pane = admin.locator(".tool-pane");
  await expect(pane).toBeVisible();
  const screen = pane.locator("[data-term-screen]");
  await expect(screen).toContainText("❯", { timeout: 15_000 });
  await screen.click();
  await admin.keyboard.type("echo foundation-terminal-ok");
  await admin.keyboard.press("Enter");
  await expect(screen).toContainText("foundation-terminal-ok", { timeout: 15_000 });
  // its keys are the shell's: V and P typed there don't open talk or present
  await admin.keyboard.type("vp");
  await expect(admin.locator(".talk-sheet.is-open")).toHaveCount(0);
  await expect(admin.locator("body.is-presenting")).toHaveCount(0);
  await admin.keyboard.press("Backspace");
  await admin.keyboard.press("Backspace");
  await admin.screenshot({ path: `${SHOTS}/09_terminal.png` });

  // and while it is, nobody signs in by email alone (the shell could sign itself in as a person)
  const late = await browser.newContext();
  const lateSignIn = await late.request.post(`${CLIENT}/auth/dev`, { data: { name: "Late Test", email: "late@normal.dev" }, failOnStatusCode: false });
  expect(lateSignIn.status()).toBe(403);
  expect(await lateSignIn.text()).toContain("the built-in terminal is running");
  await late.close();

  // a member gets no terminal: the server refuses, and the tool says why
  const refused = await m.page.request.post("/api/host-terminal", { data: {} });
  expect(refused.status()).toBe(403);
  await m.page.locator('[data-tool-open="terminal"]').click();
  await expect(m.page.locator(".tool-pane")).toContainText("only an admin");
  await m.context.close();

  // the change log: this checkout's commits
  await admin.locator('[data-tool-tab="changes"]').click();
  await expect(pane.locator(".tool-log-row").first()).toBeVisible({ timeout: 10_000 });
  await admin.screenshot({ path: `${SHOTS}/10_changes.png` });
  await pane.locator('[data-changes-face="releases"]').click();
  await expect(pane.locator(".tool-release").first()).toBeVisible();
  // the terminal is still there, its shell alive, when you go back
  await admin.locator('[data-tool-tab="terminal"]').click();
  await expect(screen).toContainText("foundation-terminal-ok");

  // files and the browser
  await admin.locator('[data-tool-tab="files"]').click();
  await expect(pane.locator(".tool-files")).toBeVisible();
  await admin.locator('[data-tool-tab="browser"]').click();
  await pane.locator("[data-browser-addr]").fill(FRAME.replace(/^http:\/\//, ""));
  await pane.locator("[data-browser-addr]").press("Enter");
  await expect(pane.locator("[data-browser-frame]")).toBeVisible();
  await admin.screenshot({ path: `${SHOTS}/11_browser.png` });

  // T3: the stand-in starts on a person's press, and its page opens here
  await admin.locator('[data-tool-tab="t3"]').click();
  await expect(pane.locator("[data-t3-start]")).toBeVisible();
  await pane.locator("[data-t3-start]").click();
  await expect(pane.locator('[data-tool-body="t3"] .tool-term-head')).toContainText("is running", { timeout: 20_000 });
  await admin.screenshot({ path: `${SHOTS}/12_t3.png` });
  await pane.locator("[data-t3-stop]").click();
  await expect(pane.locator('[data-tool-body="t3"] .tool-term-head')).toContainText("off", { timeout: 10_000 });

  // closing the pane ends the shell
  await admin.locator(".tool-close").click();
  await expect(pane).toHaveCount(0);
});

test("the bar folds as a pane comes in from the right, and as the grid's council stands beside it: never under either", async () => {
  await admin.setViewportSize({ width: 1000, height: 800 });
  await settle(admin, 500);
  const label = admin.locator("[data-hud] .hud-search .hud-label");
  await expect(label).toBeVisible();
  // the agents pane comes in: the room left is narrower than the whole bar, so the words go and the icons stay
  await admin.locator("[data-hud-agents]").click();
  await expect(admin.locator(".agents-pane")).toBeVisible();
  await settle(admin, 600);
  await expect(label).toBeHidden();
  const hud = await box(admin, "[data-hud]");
  const pane = await box(admin, ".agents-pane");
  expect(hud.x + hud.width).toBeLessThanOrEqual(pane.x);
  await admin.screenshot({ path: `${SHOTS}/16_bar-folded-for-a-pane.png` });
  await admin.locator("[data-hud-agents]").click();
  await expect(admin.locator(".agents-pane")).toHaveCount(0);
  // the grid's council at the bottom right: the bar keeps to the room it leaves
  await admin.locator("[data-council-open]").click();
  await settle(admin, 900);
  const bar = await box(admin, "[data-hud]");
  const row = await box(admin, ".council.is-board .council-row");
  expect(bar.x + bar.width).toBeLessThanOrEqual(row.x + 2);
  await admin.screenshot({ path: `${SHOTS}/17_bar-beside-the-council.png` });
  await admin.keyboard.press("Escape");
  await admin.setViewportSize({ width: 1440, height: 900 });
});

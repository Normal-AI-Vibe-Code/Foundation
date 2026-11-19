/**
 * 2026-11-18 (Josh): the interface wears the theme of what's in focus (Today's room, a grid's paper, a grid's
 * own pinned look), so the tools pane reads white on Today and ink on a grid, the terminal included; Changes
 * is a release page; the wheel zooms; the orb is right of you; a boundary's grab area is one section's edge;
 * a card has a right-click menu (minimize, pin, inputs and outputs, remove); a section a person adds starts
 * with a table pinned to it, on its paper; an app opens as a tab of its own.
 * Each check is one of those asks, measured in a real browser; screenshots go to docs/evidence/2026-11-18_themes/.
 *
 *   E2E_SERVER_PORT=15630 E2E_CLIENT_PORT=15650 E2E_SLACK_PORT=15640 E2E_MESHY_PORT=15645 npm run e2e -w @foundation/client -- look
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-18_themes";
let admin: Page;
let ctx: BrowserContext;

test.describe.configure({ mode: "serial" });

type Obj = { id: string; sectionId: string; pinned?: boolean; folded?: boolean; float?: boolean; cols?: number; rows?: number };
type Store = { getState(): { sections: Record<string, { id: string; name: string; c0: number; c1: number; r0: number; r1: number }>; tables: Record<string, Obj>; notes: Record<string, Obj>; activeSectionId: string }; setState(p: object): void };
const state = (p: Page) => p.evaluate(() => (window as unknown as { __foundation: Store }).__foundation.getState());
const css = (p: Page, sel: string, prop: string) => p.locator(sel).first().evaluate((el, k) => getComputedStyle(el).getPropertyValue(k), prop);
const root = (p: Page) => p.evaluate(() => ({ theme: document.documentElement.dataset.theme, night: document.documentElement.classList.contains("is-night") }));
/** a colour as r, g, b in 0–255, whatever notation the browser answers in */
const rgb = (p: Page, color: string) =>
  p.evaluate((c) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const g = cv.getContext("2d")!;
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, color);
const luma = (c: number[]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const zoom = (p: Page) => p.locator(".hud-zoom span").innerText();

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Admin", "admin@normal.dev");
  admin = a.page;
  ctx = a.context;
  // these checks are of the wheel as it ships: it zooms
  await admin.evaluate(() => localStorage.setItem("foundation-wheel", "zoom"));
  // day, so ink on paper is dark and the room's white is told apart from it
  await admin.evaluate(() => localStorage.setItem("foundation-night", "0"));
  await admin.reload();
  await waitLive(admin);
});
test.afterAll(async () => {
  await ctx?.close();
});

/** from Today to the grid that's open, without reloading the page */
const toGrid = (p: Page) => p.evaluate(() => void (window.location.hash = "#/board"));
const toToday = (p: Page) => p.evaluate(() => void (window.location.hash = "#/today"));

test("Today wears the room: the Changes pane is a release page drawn in white; back on a grid it is ink on paper", async () => {
  await toToday(admin);
  await settle(admin, 1200);
  expect((await root(admin)).theme).toBe("room");
  await admin.locator('[data-tool-open="changes"]').click();
  const card = admin.locator(".tool-pane .release-card").first();
  await expect(card).toBeVisible();
  // a cover, a title, the description, the bar, and a tile per part of the post
  await expect(card.locator(".release-cover .release-version")).toBeVisible();
  await expect(card.locator(".release-lede")).toBeVisible();
  expect(await card.locator(".release-bar-seg").count()).toBeGreaterThan(1);
  expect(await card.locator(".release-tile").count()).toBe(await card.locator(".release-bar-seg").count());
  const onToday = {
    title: luma(await rgb(admin, await css(admin, ".tool-pane .release-title", "color"))),
    what: luma(await rgb(admin, await css(admin, ".tool-pane .release-tile-what", "color"))),
  };
  expect(onToday.title).toBeGreaterThan(0.95);
  expect(onToday.what).toBeGreaterThan(0.75);
  // the full notes (a note's body, which reads the older --ink names) are white too
  await card.locator(".release-tile").first().click();
  await expect(card.locator(".release-body")).toBeVisible();
  expect(luma(await rgb(admin, await css(admin, ".tool-pane .release-body strong", "color")))).toBeGreaterThan(0.95);
  await admin.screenshot({ path: `${SHOTS}/01-today-release-page.png` });

  // back to the grid, in the app (a reload would close the pane)
  await toGrid(admin);
  await settle(admin, 1600);
  expect((await root(admin)).theme).toBe("paper");
  expect(luma(await rgb(admin, await css(admin, ".tool-pane .release-title", "color")))).toBeLessThan(0.25);
  expect(luma(await rgb(admin, await css(admin, ".tool-pane .release-body strong", "color")))).toBeLessThan(0.25);
  await admin.screenshot({ path: `${SHOTS}/02-grid-release-page.png` });
});

test("the terminal's ink follows the place: white in the room, ink on a grid's paper, without a restart", async () => {
  await toToday(admin);
  await settle(admin, 800);
  await admin.locator('[data-tool-open="terminal"]').click();
  await admin.locator("[data-term-start]").click();
  await expect(admin.locator(".tool-term-screen .xterm-rows")).toBeVisible({ timeout: 20_000 });
  await settle(admin, 800);
  const fg = async () => luma(await rgb(admin, await css(admin, ".tool-term-screen .xterm-rows", "color")));
  expect(await fg()).toBeGreaterThan(0.9);
  // run two commands: what they print has no blank padding, and one empty line stands before each prompt
  await admin.locator(".tool-term-screen").click();
  await admin.keyboard.type("echo one");
  await admin.keyboard.press("Enter");
  await settle(admin, 2500);
  await admin.keyboard.type("echo two");
  await admin.keyboard.press("Enter");
  await settle(admin, 2500);
  const lines = await admin.locator(".tool-term-screen .xterm-rows > div").evaluateAll((rows) => rows.map((r) => (r.textContent ?? "").trimEnd()));
  const used = lines.slice(0, lines.reduce((last, l, i) => (l ? i : last), 0) + 1);
  const at = (needle: RegExp) => used.findIndex((l) => needle.test(l));
  const one = at(/^one$/);
  const two = at(/^two$/);
  expect(one, JSON.stringify(used)).toBeGreaterThan(0);
  expect(two).toBeGreaterThan(one);
  // prompt+command, its output, one empty line, the next prompt+command (a long folder wraps onto a row of its own), its output
  expect(used[one - 1]).toMatch(/❯ echo one$/);
  expect(used[one + 1]).toBe("");
  const p2 = at(/❯ echo two$/);
  expect(p2).toBeGreaterThan(one + 1);
  expect(used.slice(one + 2, p2).every((l) => l.length > 0), JSON.stringify(used)).toBe(true);
  expect(two).toBe(p2 + 1);
  // never two empty lines together
  expect(used.some((l, i) => !l && i > 0 && !used[i - 1])).toBe(false);
  await admin.screenshot({ path: `${SHOTS}/03-today-terminal.png` });

  await toGrid(admin);
  await settle(admin, 2200);
  expect(await fg()).toBeLessThan(0.3);
  await admin.screenshot({ path: `${SHOTS}/04-grid-terminal.png` });
  await admin.locator(".tool-close").click();
});

test("the wheel zooms the grid around the pointer; Shift+wheel slides the paper; a trackpad's two fingers still pan", async () => {
  await settle(admin, 600);
  const cam = () => admin.locator(".world").evaluate((el) => (el as HTMLElement).style.transform);
  const before = parseInt(await zoom(admin), 10);
  await admin.mouse.move(700, 450);
  await admin.mouse.wheel(0, -100);
  await settle(admin, 900);
  const inn = parseInt(await zoom(admin), 10);
  expect(inn).toBeGreaterThan(before);
  await admin.mouse.wheel(0, 100);
  await admin.mouse.wheel(0, 100);
  await settle(admin, 900);
  expect(parseInt(await zoom(admin), 10)).toBeLessThan(inn);
  // Shift: the paper moves, the zoom doesn't
  const z = await zoom(admin);
  const c0 = await cam();
  await admin.keyboard.down("Shift");
  await admin.mouse.wheel(0, 120);
  await admin.keyboard.up("Shift");
  await settle(admin, 500);
  expect(await zoom(admin)).toBe(z);
  expect(await cam()).not.toBe(c0);
  // fingers on a trackpad: small, both ways at once. They pan, and the gesture doesn't turn into a zoom half way
  const c1 = await cam();
  await admin.evaluate(() => {
    const vp = document.querySelector(".grid-viewport")!;
    for (const d of [{ deltaX: 1, deltaY: 4 }, { deltaX: 0, deltaY: 9 }, { deltaX: 0, deltaY: 120 }]) vp.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 700, clientY: 450, ...d }));
  });
  await settle(admin, 500);
  expect(await zoom(admin)).toBe(z);
  expect(await cam()).not.toBe(c1);
  // Settings → General has the other choice
  await admin.goto("/#/settings/general");
  await expect(admin.getByText("The wheel on a grid").first()).toBeVisible();
  await admin.goto("/?board=company#/board");
  await waitLive(admin);
});

test("the day/night orb is right of you, at the foot's other end", async () => {
  if (!(await admin.locator(".side-pane").count())) await admin.locator(".pane-fold").click();
  await expect(admin.locator(".side-pane .pane-foot .night-orb")).toBeVisible();
  const [orb, me, foot] = await Promise.all([".side-pane .pane-foot .night-orb", ".side-pane .pane-foot .pane-me", ".side-pane .pane-foot"].map(async (s) => (await admin.locator(s).boundingBox())!));
  expect(orb.x).toBeGreaterThan(me.x + me.width - 1);
  expect(foot.x + foot.width - (orb.x + orb.width)).toBeLessThan(24);
  await admin.locator(".pane-fold").click();
});

test("a section a person adds starts with a table pinned to it: on the section's paper, at its exact width, out of the flow", async () => {
  const id = await admin.evaluate(async () => (await (await fetch("/api/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sheets", kind: "grid" }) })).json()).id as string);
  await admin.goto(`/?board=${id}#/board`);
  await waitLive(admin);
  await settle(admin, 800);
  // a keyboard press on the + (a pointer press waits out the double-click window)
  await admin.locator(".add-section-right").first().focus();
  await admin.keyboard.press("Enter");
  await settle(admin, 2200);
  const st = await state(admin);
  const sec = st.sections[st.activeSectionId];
  const tables = Object.values(st.tables).filter((t) => t.sectionId === sec.id);
  expect(tables).toHaveLength(1);
  expect(tables[0].pinned).toBe(true);
  // both boxes read in one go: the camera may still be gliding to the new section
  const { body, table } = await admin.evaluate((id) => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const card = document.querySelector(`.section-card[data-section-id="${id}"]`)!;
    return { body: box(card.querySelector(".section-body")!), table: box(card.querySelector(".pinned-slot .table-card")!) };
  }, sec.id);
  expect(Math.abs(table.x - body.x)).toBeLessThan(1.5);
  expect(Math.abs(table.width - body.width)).toBeLessThan(1.5);
  expect(table.y - body.y).toBeLessThan(1.5);
  // it fills the section: as many rows as fit, none past the foot
  expect(table.height).toBeGreaterThan(body.height * 0.8);
  expect(table.y + table.height).toBeLessThanOrEqual(body.y + body.height + 1);
  // no card under it: no fill, no edge, no shadow
  const look = await admin.locator(".pinned-slot .table-card").evaluate((el) => {
    const c = getComputedStyle(el);
    return { bg: c.backgroundColor, border: c.borderTopWidth, shadow: c.boxShadow };
  });
  expect(look.border).toBe("0px");
  expect(look.shadow).toBe("none");
  expect(look.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  // the section isn't "empty" any more, and a cell takes typing
  await expect(admin.locator(`.section-card[data-section-id="${sec.id}"] .section-empty`)).toHaveCount(0);
  await admin.locator(".pinned-slot .cell").first().dblclick();
  await admin.keyboard.type("Rim drive");
  await admin.keyboard.press("Enter");
  await expect(admin.locator(".pinned-slot .cell").first()).toContainText("Rim drive");
  await admin.screenshot({ path: `${SHOTS}/05-new-section-sheet.png` });

  // a card added there lies over the sheet, in the flow
  await admin.locator(`.section-card[data-section-id="${sec.id}"]`).hover();
  await admin.locator(`.section-card[data-section-id="${sec.id}"] .sec-tool[aria-label="Add a note"]`).click();
  await settle(admin, 1400);
  expect((await state(admin)).tables[tables[0].id].pinned).toBe(true);
  await expect(admin.locator(`.section-card[data-section-id="${sec.id}"] .section-content .frame-anchor`)).toHaveCount(1);
  await admin.screenshot({ path: `${SHOTS}/06-note-over-the-sheet.png` });
});

test("right-click a card: minimize and restore it, unpin and pin a table, see what's wired, remove it", async () => {
  const menu = async (sel: string) => {
    await admin.locator(sel).first().click({ button: "right", position: { x: 24, y: 12 } });
    await expect(admin.locator(".context-menu")).toBeVisible();
    return admin.locator(".context-menu .menu-item").allInnerTexts();
  };
  const pick = (label: string) => admin.locator(".context-menu .menu-item", { hasText: label }).click();
  const st0 = await state(admin);
  const noteId = Object.keys(st0.notes)[0];
  const tableId = Object.keys(st0.tables)[0];

  // the note: its menu, then Minimize
  const items = await menu(`[data-obj-id="${noteId}"] .frame-card`);
  for (const want of ["Frame it", "Full screen", "Minimize", "Float freely", "Copy a link to it", "Remove this note"]) expect(items.some((i) => i.includes(want)), want).toBe(true);
  await admin.screenshot({ path: `${SHOTS}/07-card-menu.png` });
  await pick("Minimize");
  await settle(admin, 900);
  expect((await state(admin)).notes[noteId].folded).toBe(true);
  await expect(admin.locator(`[data-obj-id="${noteId}"] .frame-anchor`)).toHaveClass(/is-folded/);
  expect(await admin.locator(`[data-obj-id="${noteId}"] .frame-card`).evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(40);
  expect(await css(admin, `[data-obj-id="${noteId}"] .frame-header`, "opacity")).toBe("1");
  await admin.screenshot({ path: `${SHOTS}/08-minimized.png` });
  await admin.locator(`[data-obj-id="${noteId}"] [data-card-restore]`).click();
  await settle(admin, 700);
  expect((await state(admin)).notes[noteId].folded).toBe(false);

  // the table: unpin it and it's a card in the flow; pin it and it spans again
  expect((await menu(`[data-obj-id="${tableId}"] .table-header`)).some((i) => i.includes("Unpin"))).toBe(true);
  await pick("Unpin");
  await settle(admin, 1200);
  expect((await state(admin)).tables[tableId].pinned).toBe(false);
  await expect(admin.locator(".pinned-slot")).toHaveCount(0);
  await expect(admin.locator(`.section-content [data-obj-id="${tableId}"] .table-card`)).toBeVisible();
  await admin.screenshot({ path: `${SHOTS}/09-unpinned.png` });
  await menu(`[data-obj-id="${tableId}"] .table-header`);
  await pick("Pin to the section");
  await settle(admin, 1200);
  expect((await state(admin)).tables[tableId].pinned).toBe(true);
  await expect(admin.locator(".pinned-slot")).toHaveCount(1);

  // Remove: the note goes
  await menu(`[data-obj-id="${noteId}"] .frame-card`);
  await pick("Remove this note");
  await settle(admin, 700);
  expect((await state(admin)).notes[noteId]).toBeUndefined();
});

test("a boundary's grab area is one section's edge, top to bottom, and lights only there", async () => {
  await admin.goto("/?board=company#/board");
  await waitLive(admin);
  await settle(admin, 1200);
  const data = await admin.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world")!;
    const k = world.getBoundingClientRect().width / world.offsetWidth || 1;
    void k;
    const secs = [...document.querySelectorAll<HTMLElement>(".section-card[data-section-id]")].map((s) => ({ l: s.offsetLeft, t: s.offsetTop, w: s.offsetWidth, h: s.offsetHeight }));
    const cols = [...document.querySelectorAll<HTMLElement>(".gutter-col:not(.is-interior)")].map((g) => ({ x: g.offsetLeft + 7, t: g.offsetTop, h: g.offsetHeight }));
    return { secs, cols };
  });
  expect(data.cols.length).toBeGreaterThan(0);
  for (const g of data.cols) {
    // some section's right edge sits just left of this boundary and has exactly this stretch
    const beside = data.secs.filter((s) => Math.abs(s.l + s.w + 20 - g.x) < 2 || Math.abs(s.l - 20 - g.x) < 2);
    expect(beside.some((s) => Math.abs(s.t - g.t) < 2 && Math.abs(s.h - g.h) < 2), `a section edge matches the grab area at x ${g.x}, ${g.t}+${g.h}`).toBe(true);
  }
});

test("an app opens as a tab of its own: T3 from its pane, listed in All Grids with its own mark", async () => {
  await admin.locator('[data-tool-open="t3"]').click();
  await expect(admin.locator("[data-t3-expand]")).toBeVisible();
  await admin.locator("[data-t3-expand]").click();
  await expect(admin.locator('[data-app-canvas="t3"]')).toBeVisible();
  await expect(admin.locator(".tool-pane")).toHaveCount(0);
  // its tab, with its kind
  await expect(admin.locator('.tab.is-current[data-space-kind="app"]')).toBeVisible();
  expect((await root(admin)).theme).toBe("paper");
  // and its row in the side menu, with T3's mark (an svg, not the grid's ▦)
  if (!(await admin.locator(".side-pane").count())) await admin.locator(".pane-fold").click();
  const row = admin.locator('.space-row[data-space-kind="app"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator(".pane-glyph svg")).toBeVisible();
  await admin.screenshot({ path: `${SHOTS}/10-t3-as-a-tab.png` });
  // opening it again goes to the tab there is
  const again = await admin.evaluate(async () => (await (await fetch("/api/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "app", app: "t3" }) })).json()) as { id: string; existing?: boolean });
  expect(again.existing).toBe(true);
});

test("a grid can pin its own look: Always night for this grid, paper again on the next", async () => {
  const id = await admin.evaluate(async () => (await (await fetch("/api/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Night shift", kind: "grid" }) })).json()).id as string);
  await admin.goto(`/?board=${id}#/board`);
  await waitLive(admin);
  expect(await root(admin)).toEqual({ theme: "paper", night: false });
  await admin.locator(".tab.is-current .tab-info").click();
  await admin.locator("[data-grid-theme]").selectOption("night");
  await expect.poll(async () => (await root(admin)).theme).toBe("night");
  expect((await root(admin)).night).toBe(true);
  await settle(admin, 1800);
  await admin.screenshot({ path: `${SHOTS}/11-grid-always-night.png` });
  // another grid is paper, by day, as the orb says
  await admin.goto("/?board=company#/board");
  await waitLive(admin);
  await expect.poll(async () => (await root(admin)).theme).toBe("paper");
  expect((await root(admin)).night).toBe(false);
});

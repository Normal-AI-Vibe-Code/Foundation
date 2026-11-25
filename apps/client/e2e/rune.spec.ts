/**
 * The Rune renderer beside the web renderer (Settings → Renderer; src/rune,
 * apps/rune). Rune draws through WebGPU, so this runs headed on the machine's
 * GPU, in Edge (the desktop app's engine on Windows), and needs the build:
 *
 *   npm run rune:build
 *   PERF_GPU=1 E2E_CLIENT_PORT=15450 npm run e2e -w @foundation/client -- rune
 *
 * It checks that the default is untouched, that Rune draws the board the store
 * has (and says so), that presses, a drag, the wheel and writing a note reach
 * the board, that a browser without WebGPU falls back and says why, and takes
 * the two engines' pictures of one board, day and night, into docs/evidence.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { CLIENT, settle, waitLive } from "./helpers";

const GPU = !!process.env.PERF_GPU;
const OUT = `../../docs/evidence/${process.env.RUNE_OUT ?? "2026-11-12_rune"}`;

test.skip(!GPU, "PERF_GPU=1 runs this headed, on the machine's GPU (Rune needs WebGPU)");
test.skip(!existsSync("public/rune/rune.json"), "the Rune renderer isn't built: npm run rune:build");
test.use({
  headless: false,
  channel: process.env.PERF_CHANNEL ?? "msedge",
  launchOptions: { args: ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] },
});

type Scene = {
  sections: Array<{ id: string; name: string; x: number; y: number; w: number; h: number; active: boolean; tools: Array<{ id: string }>; confirm: string }>;
  cards: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number; s: number; text: string }>;
};
type Camera = { x: number; y: number; scale: number; left: number; top: number };
type Motion = { motion: "instant" | "animated"; rule: string };
type Hook = { motions(): Motion[]; setUi(patch: { pane?: boolean }): void; setNight(on: boolean): void; camera: Camera; status(): { state: string; reason?: string }; scene(): Scene; addNote(section: string, text: string): { id: string }; createTable(section: string): { id: string } };
type Note = { id: string; x: number; y: number; float: boolean; text: string };
type Store = { workbook: { setCell(t: string, c: number, r: number, raw: string): void; getCell(t: string, c: number, r: number): { value: unknown } | undefined }; getState(): { activeSectionId: string; activeObjectId: string | null; notes: Record<string, Note> } };

async function open(page: Page, engine: "rune" | "web", night = true) {
  const res = await page.context().request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada", email: "ada@normal.dev" } });
  expect(res.ok()).toBe(true);
  await page.addInitScript(
    ([n]) => {
      localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
      localStorage.setItem("foundation-night", n ? "1" : "0");
    },
    [night],
  );
  await page.goto(`/?board=company&engine=${engine}`);
  await waitLive(page);
  if (engine === "rune") await page.waitForSelector(".rune-mark.is-ready", { timeout: 30_000 });
  await settle(page, 1200);
}

const camera = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __foundationRune: Hook }).__foundationRune.camera }));
const scene = (page: Page) => page.evaluate(() => (window as unknown as { __foundationRune: Hook }).__foundationRune.scene());
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __foundation: Store }).__foundation.getState();
    return { activeSectionId: s.activeSectionId, activeObjectId: s.activeObjectId, notes: Object.values(s.notes) };
  });
/** the middle of a card on screen, through the one camera both engines share */
async function cardPoint(page: Page, id: string) {
  const card = (await scene(page)).cards.find((c) => c.id === id)!;
  const c = await camera(page);
  return { x: c.left + c.x + (card.x + (card.w * card.s) / 2) * c.scale, y: c.top + c.y + (card.y + (card.h * card.s) / 2) * c.scale, k: c.scale * card.s };
}

test("the web renderer is the default, and nothing of Rune loads", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (/\/rune\/(foundation_rune|rune\.json|snippets)/.test(r.url())) asked.push(r.url());
  });
  await open(page, "web");
  expect(await page.locator(".section-card").count()).toBeGreaterThan(0);
  expect(await page.locator("#foundation-rune").count()).toBe(0);
  expect(await page.locator(".rune-mark").count()).toBe(0);
  expect(asked).toEqual([]);
});

test("Rune draws the board, marked as Rune's, and its pictures sit beside the web renderer's", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const night of [true, false]) {
    await open(page, "web", night);
    await page.keyboard.press("0");
    await settle(page, 1400);
    await page.screenshot({ path: `${OUT}/board-web-${night ? "night" : "day"}.png` });
    await open(page, "rune", night);
    // the web renderer's sections are gone: Rune's canvas is the board
    expect(await page.locator(".section-card:not(.is-rune-shell)").count()).toBe(0);
    expect(await page.locator("#foundation-rune").count()).toBe(1);
    await expect(page.locator(".rune-mark")).toHaveText("Rune");
    await page.keyboard.press("0");
    await settle(page, 1400);
    await page.screenshot({ path: `${OUT}/board-rune-${night ? "night" : "day"}.png` });
  }
  expect(errors.filter((e) => /rune|wgpu|webgpu|panicked/i.test(e))).toEqual([]);
});

test("motion has an owner: a pane and another board land, a look eases, a let-go settles", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page, "rune");
  await page.keyboard.press("0");
  await settle(page, 1400);
  const motions = () => page.evaluate(() => (window as unknown as { __foundationRune: Hook }).__foundationRune.motions());
  /** what the boards handed over since `from` were told */
  const since = async (from: number) => (await motions()).slice(from);
  // the first board landed
  expect((await motions())[0]).toEqual({ motion: "instant", rule: "first" });

  // a pane opens with the pointer moving over the board (what made Rune ease it before): the floor lands
  let n = (await motions()).length;
  await page.mouse.move(700, 500);
  await page.evaluate(() => (window as unknown as { __foundationRune: Hook }).__foundationRune.setUi({ pane: true }));
  for (let i = 0; i < 12; i++) await page.mouse.move(700 + i * 6, 500 + i * 3);
  await settle(page, 300);
  await page.screenshot({ path: `${OUT}/motion-pane-300ms.png` });
  await settle(page, 600);
  let got = await since(n);
  expect(got.length).toBeGreaterThan(0);
  expect(got.filter((m) => m.rule === "floor").length).toBeGreaterThan(0);
  expect(got.filter((m) => m.rule === "floor" && m.motion !== "instant")).toEqual([]);
  // and closing it
  n = (await motions()).length;
  await page.evaluate(() => (window as unknown as { __foundationRune: Hook }).__foundationRune.setUi({ pane: false }));
  await settle(page, 900);
  got = await since(n);
  expect(got.some((m) => m.rule === "floor" && m.motion === "instant")).toBe(true);

  // the selection is a look: it eases
  n = (await motions()).length;
  const sc = await scene(page);
  const other = sc.sections.find((s) => !s.active)!;
  const c = await camera(page);
  await page.mouse.click(c.left + c.x + (other.x + other.w - 60) * c.scale, c.top + c.y + (other.y + other.h - 40) * c.scale);
  await expect.poll(async () => (await state(page)).activeSectionId).toBe(other.id);
  await settle(page, 300);
  expect(await since(n)).toContainEqual({ motion: "animated", rule: "look" });

  // day: every token changes and nothing moves, so it eases (the fade is sent three times)
  n = (await motions()).length;
  await page.evaluate(() => (window as unknown as { __foundationRune: Hook }).__foundationRune.setNight(false));
  await settle(page, 2000);
  got = await since(n);
  expect(got.length).toBeGreaterThan(0);
  expect(got.filter((m) => m.rule !== "look")).toEqual([]);
  await page.evaluate(() => (window as unknown as { __foundationRune: Hook }).__foundationRune.setNight(true));
  await settle(page, 2000);

  // a card let go settles; one that arrives from the store lands
  const sec = (await scene(page)).sections.find((s) => s.active)!;
  const made = await page.evaluate((id) => (window as unknown as { __foundationRune: Hook }).__foundationRune.addNote(id, "# Moves").id, sec.id);
  await settle(page, 500);
  n = (await motions()).length;
  const at = await cardPoint(page, made);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 40, { steps: 8 });
  await page.mouse.up();
  await settle(page, 600);
  expect(await since(n)).toContainEqual({ motion: "animated", rule: "hand" });
  n = (await motions()).length;
  await page.evaluate((id) => (window as unknown as { __foundationRune: Hook }).__foundationRune.addNote(id, "# Arrives"), sec.id);
  await settle(page, 500);
  got = await since(n);
  expect(got.length).toBeGreaterThan(0);
  expect(got.filter((m) => m.motion !== "instant")).toEqual([]);

  // another board (a section opened as its own grid) lands
  n = (await motions()).length;
  await page.evaluate((id) => (window as unknown as { __foundation: { expandSection(id: string | null): void } }).__foundation.expandSection(id), sec.id);
  await settle(page, 900);
  got = await since(n);
  expect(got.filter((m) => m.rule === "board").length).toBeGreaterThan(0);
  expect(got.filter((m) => m.rule === "board" && m.motion !== "instant")).toEqual([]);
  await page.screenshot({ path: `${OUT}/motion-after.png` });
  expect(errors.filter((e) => /rune|wgpu|webgpu|panicked/i.test(e))).toEqual([]);
});

test("presses, the wheel, a drag and writing a note reach the board", async ({ page }) => {
  await open(page, "rune");
  await page.keyboard.press("0"); // the whole board in view
  await settle(page, 1400);
  const sc = await scene(page);
  expect(sc.sections.length).toBeGreaterThan(1);

  // a press on another section's paper (its header strip) selects it
  const other = sc.sections.find((s) => !s.active)!;
  const c0 = await camera(page);
  // (its tools wait at the header's right end: press its paper, lower down)
  await page.mouse.click(c0.left + c0.x + (other.x + other.w - 60) * c0.scale, c0.top + c0.y + (other.y + other.h - 40) * c0.scale);
  await expect.poll(async () => (await state(page)).activeSectionId).toBe(other.id);

  // the wheel pans and Ctrl+wheel zooms: the one camera, drawn by Rune
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 120);
  await settle(page, 400);
  const c1 = await camera(page);
  // (a headed browser scales the wheel's delta by the display's: the grid moves by what the event says)
  expect(c1.y).toBeLessThan(c0.y - 100);
  expect(Math.abs(c1.x - c0.x)).toBeLessThan(1);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await settle(page, 900);
  expect((await camera(page)).scale).toBeGreaterThan(c1.scale);

  // a note, made through the store as any card is; a new card is brought into view
  const id = await page.evaluate((sec) => (window as unknown as { __foundationRune: Hook }).__foundationRune.addNote(sec, "Drawn by Rune").id, other.id);
  await settle(page, 1500);
  // a press on it selects it
  let at = await cardPoint(page, id);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await state(page)).activeObjectId).toBe(id);

  // drag it 90 × 60 px: it floats where it was let go
  const sceneBefore = (await scene(page)).cards.find((c) => c.id === id)!;
  at = await cardPoint(page, id);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 30, { steps: 6 });
  await page.mouse.move(at.x + 90, at.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).notes.find((n) => n.id === id)?.float).toBe(true);
  await settle(page, 500);
  const sceneAfter = (await scene(page)).cards.find((c) => c.id === id)!;
  const cam = await camera(page);
  expect(Math.abs((sceneAfter.x - sceneBefore.x) * cam.scale - 90)).toBeLessThan(3);
  expect(Math.abs((sceneAfter.y - sceneBefore.y) * cam.scale - 60)).toBeLessThan(3);

  // a double-click on a note that's framed opens it for writing in Rune's own field, and typing reaches the board
  at = await cardPoint(page, id);
  await page.mouse.dblclick(at.x, at.y);
  await settle(page, 800);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(", typed in its own field");
  await expect.poll(async () => (await state(page)).notes.find((n) => n.id === id)?.text).toBe("Drawn by Rune, typed in its own field");
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/note-writing-rune.png` });
  await page.keyboard.press("Escape");
});

test("without WebGPU the board falls back to the web renderer and says why", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true }));
  const res = await page.context().request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada", email: "ada@normal.dev" } });
  expect(res.ok()).toBe(true);
  await page.goto("/?board=company&engine=rune");
  await waitLive(page);
  await page.waitForSelector(".rune-mark.is-failed");
  await expect(page.locator(".rune-mark")).toHaveText("Rune off");
  expect(await page.locator(".section-card").count()).toBeGreaterThan(0);
  expect(await page.locator("#foundation-rune").count()).toBe(0);
});

test("Settings → Renderer switches engines on this device and shows where Rune stands", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await open(page, "web");
  for (const night of [true, false]) {
    await page.evaluate((n) => document.documentElement.classList.toggle("is-night", n), night);
    await page.goto("/?board=company#/settings/renderer");
    await page.waitForSelector(".rune-option");
    await settle(page, 1600);
    await page.screenshot({ path: `${OUT}/settings-renderer-${night ? "night" : "day"}.png`, fullPage: true });
  }
  await expect(page.locator(".rune-option.is-current .rune-option-name")).toContainText("Web renderer");
  expect(await page.locator(".rune-row").count()).toBeGreaterThan(20);
  await page.locator(".rune-option", { hasText: "Experimental" }).click();
  await expect(page.locator(".rune-option.is-current .rune-option-name")).toContainText("Rune");
  expect(await page.evaluate(() => localStorage.getItem("foundation-engine"))).toBe("rune");
  // back on the board (no ?engine in the address): Rune is drawing, and says so
  await page.goto("/?board=company");
  await waitLive(page);
  await page.waitForSelector(".rune-mark.is-ready", { timeout: 30_000 });
  expect(await page.locator(".section-card:not(.is-rune-shell)").count()).toBe(0);
  // and back again: the web renderer, with nothing of Rune left on the page
  await page.locator(".rune-mark").click();
  await page.locator(".rune-option", { hasText: "Default" }).click();
  await page.goto("/?board=company");
  await waitLive(page);
  await settle(page, 600);
  expect(await page.locator(".section-card").count()).toBeGreaterThan(0);
  expect(await page.locator("#foundation-rune").count()).toBe(0);
  expect(await page.locator(".rune-mark").count()).toBe(0);
});

test("the design page shows the mark and the ledger, day and night", async ({ page }) => {
  await open(page, "web");
  for (const night of [true, false]) {
    await page.goto("/#/design");
    await page.evaluate((n) => document.documentElement.classList.toggle("is-night", n), night);
    const section = page.locator(".design-section", { hasText: "Rune renderer" });
    await section.scrollIntoViewIfNeeded();
    await settle(page, 1600);
    await section.screenshot({ path: `${OUT}/design-rune-${night ? "night" : "day"}.png` });
  }
});

test("web content stays live as islands over Rune; a table is Rune's at rest and the web's in hand", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await open(page, "rune");
  await page.keyboard.press("0");
  await settle(page, 1400);
  // the seeded board's apps and connectors are the web's own components, in the sections Rune drew
  const panels = await page.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { panels: object } } }).__foundation.getState().panels).length);
  expect(panels).toBeGreaterThan(0);
  expect(await page.locator(".is-rune-shell .panel-card").count()).toBe(panels);
  // and Rune is handed none of them: each card is drawn by exactly one engine
  const drawn = (await scene(page)).cards.map((c) => c.kind);
  expect(drawn.every((k) => k === "note" || k === "table" || k === "image")).toBe(true);
  // an island sits where the store says: its box on screen is the rect the wires land on
  const off = await page.evaluate(() => {
    const st = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string }> }; sectionCardRect(g: unknown, s: unknown): { x: number; y: number; w: number; h: number } } }).__foundation;
    const cam = (window as unknown as { __foundationRune: { camera: { x: number; y: number; scale: number; left: number; top: number } } }).__foundationRune.camera;
    const s = st.getState() as unknown as { grid: unknown; sections: Record<string, { id: string }> };
    let worst = 0;
    for (const el of document.querySelectorAll<HTMLElement>(".section-card.is-rune-shell")) {
      const r = el.getBoundingClientRect();
      const want = st.sectionCardRect(s.grid, s.sections[el.dataset.sectionId!]);
      worst = Math.max(worst, Math.abs(r.left - (cam.left + cam.x + want.x * cam.scale)), Math.abs(r.top - (cam.top + cam.y + want.y * cam.scale)), Math.abs(r.width - want.w * cam.scale));
    }
    return worst;
  });
  expect(off).toBeLessThan(1);
  await page.screenshot({ path: `${OUT}/islands-rune-night.png` });

  // a table: Rune draws it at rest, with what its cells show
  const sec = (await scene(page)).sections.find((s) => s.name === "Apps")!;
  const id = await page.evaluate((s) => (window as unknown as { __foundationRune: Hook }).__foundationRune.createTable(s).id, sec.id);
  await page.evaluate((t) => {
    const wb = (window as unknown as { __foundation: Store }).__foundation.workbook;
    wb.setCell(t, 0, 0, "Part");
    wb.setCell(t, 1, 0, "Qty");
    wb.setCell(t, 0, 1, "Rim drive");
    wb.setCell(t, 1, 1, "12");
    wb.setCell(t, 1, 2, "=B2*2");
  }, id);
  await settle(page, 1600);
  const card = (await scene(page)).cards.find((c) => c.id === id)!;
  expect(card.kind).toBe("table");
  expect(await page.locator(`.obj-slot[data-obj-id="${id}"]`).count()).toBe(0);
  await page.screenshot({ path: `${OUT}/table-rune-at-rest.png` });

  // pressed, it's the card in hand: the web's live sheet takes its place, and a cell takes typing
  const at = await cardPoint(page, id);
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(`.obj-slot[data-obj-id="${id}"] .cell`);
  expect((await scene(page)).cards.some((c) => c.id === id)).toBe(false);
  const cell = page.locator(`.obj-slot[data-obj-id="${id}"] .cell`).nth(4 * 3 + 2); // C4
  await cell.click();
  await page.keyboard.type("=B3+1");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate((t) => (window as unknown as { __foundation: Store }).__foundation.workbook.getCell(t, 2, 3)?.value, id)).toBe(25);
  await settle(page, 400);
  await page.screenshot({ path: `${OUT}/table-web-in-hand.png` });

  // a press on the section's paper lets go of it: Rune draws it again, with the new cell
  const box = (await page.locator(`.obj-slot[data-obj-id="${id}"] .sheet`).boundingBox())!;
  await page.mouse.click(box.x + box.width + 120, box.y + 40);
  await expect.poll(() => page.locator(`.obj-slot[data-obj-id="${id}"]`).count()).toBe(0);
  const back = (await scene(page)).cards.find((c) => c.id === id) as unknown as { cells: Array<{ c: number; r: number; t: string }> };
  expect(back.cells.find((x) => x.c === 2 && x.r === 3)?.t).toBe("25");
});

test("a section's tools, rename, drag, right-click menu and remove; a note's bar and resize", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await open(page, "rune");
  await page.keyboard.press("0");
  await settle(page, 1400);
  type Sec = Scene["sections"][number];
  const at = async (s: Sec, wx: number, wy: number) => {
    const c = await camera(page);
    return { x: c.left + c.x + (s.x + wx) * c.scale, y: c.top + c.y + (s.y + wy) * c.scale };
  };
  const sectionOf = async (name: string) => (await scene(page)).sections.find((s) => s.name === name)!;
  const full = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string; c0: number; r0: number }>; notes: Record<string, { id: string; w: number; h: number; float: boolean; sectionId: string }>; pendingRemoval: string | null; level: string | null } } }).__foundation.getState();
      return { sections: Object.values(s.sections), notes: Object.values(s.notes), pendingRemoval: s.pendingRemoval, level: s.level };
    });
  // where a tool sits in the toolbar: 26 px buttons from the header's right edge (8 px in, 4 px of bar padding), a 7 px hairline before each group
  const toolPoint = async (s: Sec, id: string) => {
    const tools = (await scene(page)).sections.find((x) => x.id === s.id)!.tools as Array<{ id: string; gap?: boolean }>;
    let x = s.w - 8 - 4;
    for (let i = tools.length - 1; i >= 0; i--) {
      x -= 13;
      if (tools[i].id === id) return at(s, x, 21);
      x -= 13 + 1 + (tools[i].gap ? 7 + 1 : 0);
    }
    throw new Error(`no tool ${id}`);
  };

  // the Design section is big enough on screen to work on: frame it
  let design = await sectionOf("Design");
  let p = await at(design, design.w / 2, 300);
  await page.mouse.dblclick(p.x, p.y);
  await settle(page, 1500);
  design = await sectionOf("Design");

  // the toolbar: ▤ adds a note to this section
  const notes0 = (await full()).notes.length;
  p = await at(design, design.w / 2, 300);
  await page.mouse.move(p.x, p.y);
  await settle(page, 400);
  await page.screenshot({ path: `${OUT}/section-tools-rune.png` });
  p = await toolPoint(design, "note");
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await full()).notes.length).toBe(notes0 + 1);
  await settle(page, 1500);

  // rename: a press on the name opens Rune's field; typing and Enter names it
  await page.keyboard.press("0");
  await settle(page, 1400);
  design = await sectionOf("Design");
  p = await at(design, design.w / 2, 300);
  await page.mouse.dblclick(p.x, p.y);
  await settle(page, 1500);
  design = await sectionOf("Design");
  p = await at(design, 34, 21);
  await page.mouse.click(p.x, p.y);
  await settle(page, 700);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Studio work");
  await settle(page, 300);
  await page.screenshot({ path: `${OUT}/section-rename-rune.png` });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await full()).sections.some((s) => s.name === "Studio work")).toBe(true);

  // the right-click menu is the web section's own list
  let studio = await sectionOf("Studio work");
  p = await at(studio, studio.w - 200, 500);
  await page.mouse.click(p.x, p.y, { button: "right" });
  // (the grid's own actions are a row of icons since 2026-11-17: each is named by its label, not by words beside it)
  await expect(page.locator('.context-menu .menu-iconrow button[aria-label="Insert section left"]')).toBeVisible();
  await expect(page.locator('.context-menu .menu-iconrow button[aria-label="Split column"]')).toBeVisible();
  await page.screenshot({ path: `${OUT}/section-menu-rune.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator(".context-menu")).toHaveCount(0);

  // remove asks first: Cancel keeps it, Remove takes it
  p = await toolPoint(studio, "remove");
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await full()).pendingRemoval).toBe(studio.id);
  await settle(page, 400);
  await page.screenshot({ path: `${OUT}/section-confirm-rune.png` });
  // the answer buttons sit under the toolbar, right-aligned: Cancel is the last
  p = await at(studio, studio.w - 10 - 12 - 30, 48 + 22);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await full()).pendingRemoval).toBe(null);
  expect((await full()).sections.some((s) => s.id === studio.id)).toBe(true);

  // drag a section by its header onto another's cell: they swap
  await page.keyboard.press("0");
  await settle(page, 1400);
  const before = (await full()).sections;
  const vision = await sectionOf("Vision");
  const bom = await sectionOf("BomForm");
  const from = await at(vision, 150, 21);
  const to = await at(bom, bom.w / 2, bom.h / 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 10, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await settle(page, 300);
  await page.screenshot({ path: `${OUT}/section-drag-rune.png` });
  await page.mouse.up();
  const cellOf = (list: typeof before, name: string) => {
    const s = list.find((x) => x.name === name)!;
    return `${s.c0},${s.r0}`;
  };
  await expect.poll(async () => cellOf((await full()).sections, "Vision")).toBe(cellOf(before, "BomForm"));
  expect(cellOf((await full()).sections, "BomForm")).toBe(cellOf(before, "Vision"));

  // a note: its corner resizes it, its bar's ✕ removes it
  const note = (await full()).notes.find((n) => n.sectionId === studio.id && !["Drawn"].includes(n.id))!;
  const added = (await full()).notes[(await full()).notes.length - 1];
  const target = added ?? note;
  let cp = await cardPoint(page, target.id);
  await page.mouse.dblclick(cp.x, cp.y);
  await settle(page, 1500);
  await page.keyboard.press("Escape");
  await settle(page, 300);
  const card = (await scene(page)).cards.find((c) => c.id === target.id)!;
  const cam = await camera(page);
  const corner = { x: cam.left + cam.x + (card.x + (card.w - 8) * card.s) * cam.scale, y: cam.top + cam.y + (card.y + (card.h - 8) * card.s) * cam.scale };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 30, corner.y + 20, { steps: 5 });
  await page.mouse.move(corner.x + 80, corner.y + 50, { steps: 5 });
  await page.mouse.up();
  const k = cam.scale * card.s;
  await expect.poll(async () => Math.round((await full()).notes.find((n) => n.id === target.id)!.w)).toBe(Math.round(card.w + 80 / k));
  expect(Math.round((await full()).notes.find((n) => n.id === target.id)!.h)).toBe(Math.round(card.h + 50 / k));
  // the bar: over the note's top edge while the pointer is on it; its last button removes the note
  const grown = (await scene(page)).cards.find((c) => c.id === target.id)!;
  const bar = { x: cam.left + cam.x + (grown.x + (grown.w - 5 - 6 - 13) * grown.s) * cam.scale, y: cam.top + cam.y + (grown.y + 20 * grown.s) * cam.scale };
  await page.mouse.move(bar.x - 120, bar.y + 60);
  await settle(page, 400);
  await page.screenshot({ path: `${OUT}/note-bar-rune.png` });
  await page.mouse.click(bar.x, bar.y);
  await expect.poll(async () => (await full()).notes.some((n) => n.id === target.id)).toBe(false);

  // ⤢ opens the section as its own grid; Esc goes back up a level
  await page.keyboard.press("0");
  await settle(page, 1400);
  studio = await sectionOf("Studio work");
  p = await at(studio, studio.w / 2, 400);
  await page.mouse.dblclick(p.x, p.y);
  await settle(page, 1500);
  studio = await sectionOf("Studio work");
  p = await toolPoint(studio, "open");
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await full()).level).toBe(studio.id);
  await settle(page, 1200);
  expect((await scene(page)).sections.length).toBe(1);
  await page.screenshot({ path: `${OUT}/section-open-rune.png` });
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await full()).level).toBe(null);
});

/** what a screenshot holds, read in the page (the PNG decoded on a canvas) */
async function pixels(page: Page, a: Buffer, b?: Buffer) {
  return page.evaluate(
    async ([x, y]) => {
      const read = async (b64: string) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const g = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
        g.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, d: g.getImageData(0, 0, img.width, img.height).data };
      };
      const A = await read(x!);
      const n = A.w * A.h;
      const mean = [0, 0, 0];
      // ink: pixels far from the picture's most common colour (its paper)
      const bins = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) mean[k] += A.d[i * 4 + k];
        const key = (A.d[i * 4] >> 2) | ((A.d[i * 4 + 1] >> 2) << 6) | ((A.d[i * 4 + 2] >> 2) << 12);
        bins.set(key, (bins.get(key) ?? 0) + 1);
      }
      const paper = [...bins].sort((p, q) => q[1] - p[1])[0][0];
      const base = [(paper & 63) << 2, ((paper >> 6) & 63) << 2, ((paper >> 12) & 63) << 2];
      let ink = 0;
      for (let i = 0; i < n; i++) {
        if (Math.abs(A.d[i * 4] - base[0]) + Math.abs(A.d[i * 4 + 1] - base[1]) + Math.abs(A.d[i * 4 + 2] - base[2]) > 90) ink++;
      }
      let diff = -1;
      let changed = -1;
      if (y) {
        const B = await read(y);
        diff = 0;
        changed = 0;
        for (let i = 0; i < n * 4; i += 4) {
          const d = Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]);
          diff += d / 3;
          if (d > 0) changed++;
        }
        diff /= n;
        changed /= n;
      }
      return { mean: mean.map((v) => v / n), ink: ink / n, diff, changed };
    },
    [a.toString("base64"), b?.toString("base64")] as const,
  );
}

const MARKDOWN = "# Paper and type\n\nThe body, with **strong**, *emphasis*, `code` and a [link](https://foundation.invalid/rune).\n\n## A list\n\n- one\n- two\n- three\n\n> A quoted line.\n\n```\nlet x = 1;\n```\n";

test("a press on a note's link says where it goes", async ({ page }) => {
  // A press on a link's letters used to go to the <a> Rune's accessibility mirror lays over them (rune.css):
  // the browser opened the address itself and Rune reported nothing. Only the blank rows of the line answered.
  page.context().on("page", (p) => void p.close().catch(() => {}));
  await open(page, "rune");
  await page.keyboard.press("0");
  await settle(page, 1400);
  const section = (await scene(page)).sections.find((s) => s.name === "Design" || s.name === "Studio work")!;
  const id = await page.evaluate(([sec, text]) => (window as unknown as { __foundationRune: Hook }).__foundationRune.addNote(sec, text).id, [section.id, "Go to [foundation.invalid](https://foundation.invalid/press) now."] as const);
  await settle(page, 1500);
  const p = await cardPoint(page, id);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press("f");
  await settle(page, 1600);
  const card = (await scene(page)).cards.find((c) => c.id === id)!;
  const cam = await camera(page);
  const k = cam.scale * card.s;
  const at = (x: number, y: number) => ({ x: cam.left + cam.x + card.x * cam.scale + x * k, y: cam.top + cam.y + card.y * cam.scale + y * k });
  // where Rune itself says the link is: the first line, by the cursor
  const xs: number[] = [];
  for (let x = 20; x <= 200; x += 3) {
    const q = at(x, 24);
    await page.mouse.move(q.x, q.y);
    await page.waitForTimeout(30);
    if ((await page.evaluate(() => document.getElementById("foundation-rune")!.style.cursor)) === "pointer") xs.push(x);
  }
  expect(xs.length).toBeGreaterThan(4);
  // the middle of the link
  const q = at((xs[0] + xs[xs.length - 1]) / 2, 24);
  console.log(`link press: the note is drawn at ${k.toFixed(2)}, its link from ${xs[0]} to ${xs[xs.length - 1]}`);
  await page.mouse.move(q.x, q.y);
  await settle(page, 500);
  await page.mouse.down();
  await page.mouse.up();
  // nothing of the mirror is under the pointer: the canvas is
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [q.x, q.y])).toBe("CANVAS");
  await expect
    .poll(() => page.evaluate(() => ((window as unknown as { __foundationRune: { events(): Array<{ t: string; url?: string }> } }).__foundationRune.events() ?? []).filter((e) => e.t === "link").map((e) => e.url)), { timeout: 3000 })
    .toContain("https://foundation.invalid/press");
});

test("the paper, the face and a note in markdown are the web renderer's own", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  // a link opens a window: nothing answers at .invalid, and the window goes
  page.context().on("page", (p) => void p.close().catch(() => {}));
  const fonts: string[] = [];
  page.on("response", (r) => {
    if (/\/rune\/fonts\/.+\.ttf/.test(r.url()) && r.ok()) fonts.push(r.url().split("/").pop()!);
  });
  // bare paper, clear of the grid, the bars and the pointer
  const bare = { x: 40, y: 740, width: 260, height: 60 };
  const shots: Record<string, { paper: Buffer; note: Buffer; clip: { x: number; y: number; width: number; height: number } }> = {};
  let noteId = "";
  // where the web note sets its link, from the note's corner
  let link = { x: 0, y: 0 };
  for (const engine of ["web", "rune"] as const) {
    await open(page, engine);
    await page.keyboard.press("0");
    await settle(page, 1400);
    // (the section check before this one renames Design)
    const section = (await scene(page)).sections.find((s) => s.name === "Design" || s.name === "Studio work")!;
    if (!noteId) noteId = await page.evaluate(([id, text]) => (window as unknown as { __foundationRune: Hook }).__foundationRune.addNote(id, text).id, [section.id, MARKDOWN] as const);
    // (a new note is framed: back to the whole board)
    await settle(page, 1500);
    await page.keyboard.press("0");
    await settle(page, 1500);
    // away from the grid, so the light that follows the pointer is off
    await page.mouse.move(700, 20);
    await settle(page, 1500);
    const paper = await page.screenshot({ clip: bare });
    await page.screenshot({ path: `${OUT}/paper-${engine}-night.png` });
    // the note, framed
    const p = await cardPoint(page, noteId);
    await page.mouse.dblclick(p.x, p.y);
    await settle(page, 1600);
    await page.keyboard.press("Escape");
    await page.mouse.move(700, 20);
    await settle(page, 900);
    const card = (await scene(page)).cards.find((c) => c.id === noteId)!;
    const cam = await camera(page);
    const k = cam.scale * card.s;
    const clip = { x: Math.round(cam.left + cam.x + card.x * cam.scale) + 2, y: Math.round(cam.top + cam.y + card.y * cam.scale) + 2, width: Math.round(card.w * k) - 4, height: Math.round(card.h * k) - 4 };
    shots[engine] = { paper, note: await page.screenshot({ clip }), clip };
    if (engine === "web") {
      const a = (await page.locator('.note-rendered a[href*="foundation.invalid/rune"]').boundingBox())!;
      link = { x: a.x + a.width / 2 - clip.x, y: a.y + a.height / 2 - clip.y };
    }
    await page.screenshot({ path: `${OUT}/note-markdown-${engine}.png`, clip });
  }
  // (the page is Rune's from here.) The note is the same size on screen in both; where the framing rests may differ
  expect([shots.rune.clip.width, shots.rune.clip.height]).toEqual([shots.web.clip.width, shots.web.clip.height]);

  // the paper: the same colour as the web's, within grain
  const web = await pixels(page, shots.web.paper);
  const rune = await pixels(page, shots.rune.paper);
  console.log(`paper: web ${web.mean.map((v) => v.toFixed(1))} rune ${rune.mean.map((v) => v.toFixed(1))}`);
  for (let k = 0; k < 3; k++) expect(Math.abs(web.mean[k] - rune.mean[k]), `paper channel ${k}`).toBeLessThan(2.5);

  // the face reached Rune
  expect(fonts).toContain("HankenGrotesk-Latin.ttf");

  // the note: about as much ink as the web note has
  const noteWeb = await pixels(page, shots.web.note);
  const noteRune = await pixels(page, shots.rune.note, shots.web.note);
  console.log(`note markdown: ink web ${(noteWeb.ink * 100).toFixed(2)}% rune ${(noteRune.ink * 100).toFixed(2)}%; mean difference ${noteRune.diff.toFixed(2)}/255`);
  expect(noteRune.ink / noteWeb.ink).toBeGreaterThan(0.75);
  expect(noteRune.ink / noteWeb.ink).toBeLessThan(1.3);
  // and pixel for pixel they differ by little (4/255 on average here: the faces' edges, the bullets, the code face)
  expect(noteRune.diff).toBeLessThan(8);

  // the link sits where the web note sets it (since 2026-11-18 a link wears its real host, which wraps this one
  // to the second line in both): Rune shows a link under the pointer there
  await page.mouse.move(shots.rune.clip.x + link.x, shots.rune.clip.y + link.y);
  await expect.poll(() => page.evaluate(() => document.getElementById("foundation-rune")!.style.cursor)).toBe("pointer");
  await page.mouse.move(700, 20);

  // the grain steps twice a second though nothing else moves
  await page.keyboard.press("0");
  await settle(page, 1500);
  await page.mouse.move(700, 20);
  await settle(page, 1200);
  const frames0 = await page.evaluate(() => (window as unknown as { __foundationRune: { paper(): number[] } }).__foundationRune.paper()[4]);
  const g0 = await page.screenshot({ clip: bare });
  await settle(page, 1300);
  const g1 = await page.screenshot({ clip: bare });
  const frames1 = await page.evaluate(() => (window as unknown as { __foundationRune: { paper(): number[] } }).__foundationRune.paper()[4]);
  const grain = await pixels(page, g0, g1);
  // and a board at rest draws for the grain alone: a few frames, not sixty a second
  expect(frames1 - frames0).toBeGreaterThan(0);
  expect(frames1 - frames0).toBeLessThan(12);
  console.log(`grain: ${(grain.changed * 100).toFixed(0)}% of bare paper changed in 1.3 s`);
  expect(grain.changed).toBeGreaterThan(0.2);

  // the light that follows the pointer: the paper under it is brighter than it was
  const spot = { x: bare.x + 90, y: bare.y - 10, width: 80, height: 80 };
  const dark = await pixels(page, await page.screenshot({ clip: spot }));
  await page.mouse.move(spot.x + 40, spot.y + 40, { steps: 4 });
  await settle(page, 1500);
  await page.screenshot({ path: `${OUT}/paper-light-rune.png`, clip: { x: 0, y: 560, width: 520, height: 300 } });
  const lit = await pixels(page, await page.screenshot({ clip: spot }));
  console.log(`pointer light: ${dark.mean.map((v) => v.toFixed(1))} -> ${lit.mean.map((v) => v.toFixed(1))}`);
  expect(lit.mean[0] - dark.mean[0]).toBeGreaterThan(3);
  // and it follows: with the pointer across the board, this paper is as it was
  await page.mouse.move(1300, 120, { steps: 4 });
  await settle(page, 1800);
  const gone = await pixels(page, await page.screenshot({ clip: spot }));
  expect(Math.abs(gone.mean[0] - dark.mean[0])).toBeLessThan(1.5);
});

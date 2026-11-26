/**
 * What the pointer does, in a real browser with real mouse moves
 * (Josh, 2026-11-17):
 *
 *  1. "left mouse is always grabs, where it really should only grab on the
 *     grid, or a top handle of a section or a menu": a plain left drag moves
 *     something only from the paper (pans), a section's header, or a card's
 *     own bar; an image or a video from anywhere on it (2026-11-24). A press on a
 *     card's body is the body's own, at 1.0, 0.6 and 0.3: a character's ✕ and
 *     its Remove / Keep, the buttons in it, a kanban's buttons, a note's
 *     words (they select), a table's cells.
 *  2. "Ctrl Zoom should always zoom and alt+scroll should scroll a card ->
 *     show a small icon on roll-over, allow user to dismiss this hint."
 *  3. "the right mouse click to open add and live next to each other, and
 *     make the grid manipulation buttons in a line on the bottom, with
 *     roll-over descriptions, instead of words next to them."
 *
 * Meshy is the stand-in (e2e/meshy-standin.mjs): nothing is charged.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_pointer";

type Obj = { id: string; name: string; sectionId: string; x: number; y: number; float: boolean; autoplay?: boolean };
type Sec = { id: string; name: string };
type State = { notes: Record<string, Obj>; panels: Record<string, Obj>; tables: Record<string, Obj>; media: Record<string, Obj>; sections: Record<string, Sec> };
type Store = { getState(): State; setState(p: object): void };

let ada: Page;
let ctx: BrowserContext;
let board = "";
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

const LONG = ["# Rim drive, rev C", ...Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: the bearing seat is reamed to H7 and the press fit holds at 60 °C.`)].join("\n\n");
const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#6f8f6a"/><circle cx="160" cy="100" r="60" fill="#d9c8a0"/></svg>')}`;

const tool = (name: string, data: object) => ctx.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
const all = (s: State) => [...Object.values(s.notes), ...Object.values(s.panels), ...Object.values(s.tables), ...Object.values(s.media)];
const find = (p: Page, name: string) =>
  p.evaluate((n) => {
    const s = (window as unknown as { __foundation: Store }).__foundation.getState();
    return [...Object.values(s.notes), ...Object.values(s.panels), ...Object.values(s.tables), ...Object.values(s.media)].find((o) => o.name === n)?.id ?? null;
  }, name);
void all;
const obj = (p: Page, id: string) =>
  p.evaluate((i) => {
    const s = (window as unknown as { __foundation: Store }).__foundation.getState();
    const o = s.notes[i] ?? s.panels[i] ?? s.tables[i] ?? s.media[i];
    return o ? { x: o.x, y: o.y, float: o.float, autoplay: o.autoplay ?? null, sectionId: o.sectionId } : null;
  }, id);
const slot = (p: Page, id: string) => p.locator(`.obj-slot[data-obj-id="${id}"]`);
const CARD = ".frame-card, .table-card";
const card = (p: Page, id: string) => slot(p, id).locator(CARD).first();
const world = (p: Page) => p.evaluate(() => document.querySelector<HTMLElement>(".world")!.style.transform);
const zoomOf = (t: string) => Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? NaN);
/** the scale a card is drawn at on screen (zoom × its section's fit) */
const scaleOf = (p: Page, id: string) => card(p, id).evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
const mid = async (l: Locator) => {
  const b = (await l.first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.x, top: b.y };
};
const leave = async (p: Page) => {
  await p.mouse.move(4, 450, { steps: 3 });
  await settle(p, 500);
};

/** bring a card to the middle of the screen, drawn at `want` (zoom × its section's fit) */
async function show(p: Page, id: string, want: number) {
  await p.mouse.move(4, 450);
  await p.evaluate((i) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "object", id: i, nonce: Math.random() } }), id);
  await settle(p, 1400);
  for (let i = 0; i < 120; i++) {
    const cur = await scaleOf(p, id);
    if (Math.abs(cur / want - 1) < 0.01) break;
    const b = (await card(p, id).boundingBox())!;
    const dy = Math.max(-39, Math.min(39, -Math.log(want / cur) / 0.011));
    // setting the stage, not the thing under test: a pinch (a Ctrl-wheel nobody holds a key for) follows 1:1
    await p.evaluate(([x, y, d]) => document.querySelector(".grid-viewport")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: d, ctrlKey: true, metaKey: true })), [b.x + b.width / 2, b.y + b.height / 2, dy]);
    await p.waitForTimeout(20);
  }
  await settle(p, 500);
  expect(Math.abs((await scaleOf(p, id)) / want - 1), `the card is drawn at ${want}`).toBeLessThan(0.02);
}

/** the pointer travels there as a hand does, then a plain press and release where it stands */
async function click(p: Page, x: number, y: number) {
  await p.mouse.move(x, y, { steps: 6 });
  await p.waitForTimeout(220);
  await p.mouse.down();
  await p.waitForTimeout(40);
  await p.mouse.up();
  await p.waitForTimeout(120);
}
async function drag(p: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  await p.mouse.move(from.x, from.y, { steps: 6 });
  await p.waitForTimeout(220);
  await p.mouse.down();
  await p.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 6 });
  await p.mouse.move(from.x + by.x, from.y + by.y, { steps: 6 });
  await p.waitForTimeout(60);
  await p.mouse.up();
  await settle(p, 500);
}
/** every click the page sees, as the element it landed on */
async function watchClicks(p: Page) {
  await p.evaluate(() => {
    const w = window as unknown as { __clicks?: string[] };
    if (w.__clicks) return;
    w.__clicks = [];
    window.addEventListener("click", (e) => w.__clicks!.push((e.target as HTMLElement).closest("button")?.outerHTML.slice(0, 80) ?? (e.target as HTMLElement).tagName), true);
  });
}
const clicks = (p: Page) => p.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks.splice(0));
/** a button inside a card's body that is really under its own centre (not clipped, not covered) */
async function bodyButton(p: Page, id: string) {
  return p.evaluate((i) => {
    const root = document.querySelector(`.obj-slot[data-obj-id="${i}"] .frame-body`);
    for (const b of root?.querySelectorAll("button:not(:disabled)") ?? []) {
      const r = b.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      if (r.width > 2 && document.elementFromPoint(x, y)?.closest("button") === b) return { x, y, w: r.width, h: r.height, html: b.outerHTML.slice(0, 80) };
    }
    return null;
  }, id);
}
/** a place in a card's body with nothing to press under it */
async function quietPoint(p: Page, id: string) {
  const pt = await p.evaluate((i) => {
    const body = document.querySelector(`.obj-slot[data-obj-id="${i}"] .frame-body`)!;
    const r = body.getBoundingClientRect();
    for (let fy = 0.5; fy < 0.95; fy += 0.05)
      for (let fx = 0.5; fx > 0.1; fx -= 0.05) {
        const x = r.x + r.width * fx;
        const y = r.y + r.height * fy;
        const el = document.elementFromPoint(x, y);
        if (el && body.contains(el) && !el.closest("button, a, input, textarea, select, [contenteditable='true']")) return { x, y };
      }
    return null;
  }, id);
  if (!pt) throw new Error("no quiet place in the card");
  return pt;
}

async function setUp(p: Page, taro = true) {
  await p.evaluate((src) => {
    const f = (window as unknown as { __foundation: Store }).__foundation;
    const s = f.getState();
    const things = Object.values(s.sections).find((x) => x.name === "Things")!;
    const media = Object.values(s.sections).find((x) => x.name === "Media")!;
    const base = { x: 0, y: 0, float: false, bornAt: Date.now() };
    f.setState({
      panels: { ...s.panels, pnl_kanban_p: { ...base, id: "pnl_kanban_p", sectionId: things.id, name: "Plan", panel: "kanban", source: "plan", w: 720, h: 460, ports: [] } },
      media: {
        ...s.media,
        med_pic_p: { ...base, id: "med_pic_p", sectionId: media.id, name: "Picture", media: "image", src, w: 320, h: 200, autoplay: false, muted: true },
        med_vid_p: { ...base, id: "med_vid_p", sectionId: media.id, name: "Clip", media: "video", src: "/e2e/none.webm", w: 320, h: 200, autoplay: false, muted: true },
      },
    });
  }, PICTURE);
  for (const n of ["Words", "Long", "Short", "Sheet", ...(taro ? ["Taro"] : []), "Plan", "Picture", "Clip"]) {
    await expect.poll(() => find(p, n), { message: `the card “${n}”` }).not.toBeNull();
    ids[n] = (await find(p, n))!;
  }
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Pointer ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  await tool("add_section", { name: "Things" });
  await tool("add_note", { section: "Things", title: "Words", markdown: "# Words\n\nThe bearing seat is reamed to H7 and the press fit holds at sixty degrees.\n\nThe stator is potted in two pours and the second one cured overnight." });
  await tool("add_table", { section: "Things", name: "Sheet", columns: ["Part", "Qty"], rows: [["Rim", 4], ["Hub", 2], ["Duct", 1]] });
  await tool("add_section", { name: "Reading" });
  await tool("add_note", { section: "Reading", title: "Long", markdown: LONG });
  await tool("add_note", { section: "Reading", title: "Short", markdown: "# Short\n\nNothing to scroll here." });
  await tool("add_section", { name: "Media" });
  await tool("add_note", { section: "Media", title: "Beside", markdown: "Beside the pictures." });
  const taro = await ctx.request.post(`${CLIENT}/api/boards/${board}/characters`, { data: { name: "Taro", set: "animals", form: "mesh", identity: "A plump red shiba in a soft gouache style.", refs: [], height: 0.6 } });
  expect(taro.ok(), await taro.text()).toBe(true);
  await ada.goto(`/?board=${board}`);
  await waitLive(ada);
  await setUp(ada);
  await watchClicks(ada);
});

test("1 · a press on a card's body is the body's own, at 1.0, 0.6 and 0.3: buttons, ✕ and its Remove / Keep, words, cells", async () => {
  for (const z of [1.0, 0.6, 0.3]) {
    // ---- a character: a body that doesn't drag, a button in it, ✕, Keep
    await show(ada, ids.Taro, z);
    const s = slot(ada, ids.Taro);
    const before = { o: await obj(ada, ids.Taro), w: await world(ada) };
    await drag(ada, await quietPoint(ada, ids.Taro), { x: 90, y: 50 });
    expect(await obj(ada, ids.Taro), `z=${z}: a drag on a character's body doesn't move it`).toEqual(before.o);
    expect(await world(ada), `z=${z}: and doesn't pan the grid`).toBe(before.w);
    await expect(s.locator(".frame-anchor.dragging")).toHaveCount(0);
    await clicks(ada);
    const b = await bodyButton(ada, ids.Taro);
    expect(b, `z=${z}: a button in the character's card`).not.toBeNull();
    // (a press and release on it: the click arrives at that button; nothing in between took it)
    await ada.mouse.move(b!.x, b!.y, { steps: 6 });
    await ada.waitForTimeout(250);
    const now = await bodyButton(ada, ids.Taro); // the bar has made room: the button is where it is now
    await ada.mouse.move(now!.x, now!.y, { steps: 2 });
    await ada.mouse.down();
    await ada.mouse.up();
    expect((await clicks(ada))[0], `z=${z}: the click lands on the button`).toBe(now!.html);
    await ada.keyboard.press("Escape");
    await settle(ada, 300);

    const body = await mid(s.locator(".frame-card"));
    await ada.mouse.move(body.x, body.y, { steps: 6 });
    await settle(ada, 450);
    const x = await mid(s.locator(".frame-header .is-remove"));
    await click(ada, x.x, x.y);
    const pop = s.locator(".frame-confirm");
    await expect(pop, `z=${z}: ✕ asks (the ✕ is ${x.w.toFixed(1)} px on screen)`).toBeVisible();
    await settle(ada, 350);
    if (z === 0.3) await ada.screenshot({ path: `${SHOTS}/01_remove-asks-at-0.3-night.png` });
    const keep = await mid(pop.locator(".confirm-btn", { hasText: "Keep" }));
    await click(ada, keep.x, keep.y);
    await expect(pop, `z=${z}: Keep keeps it`).toHaveCount(0);
    await expect(ada.locator('[data-character-card="Taro"]')).toBeVisible();

    // ---- a kanban: its buttons
    await show(ada, ids.Plan, z);
    await clicks(ada);
    const kb = await bodyButton(ada, ids.Plan);
    expect(kb, `z=${z}: a button in the kanban`).not.toBeNull();
    await ada.mouse.move(kb!.x, kb!.y, { steps: 6 });
    await ada.waitForTimeout(250);
    const kn = (await bodyButton(ada, ids.Plan))!;
    await ada.mouse.move(kn.x, kn.y, { steps: 2 });
    await ada.mouse.down();
    await ada.mouse.up();
    expect((await clicks(ada))[0], `z=${z}: the click lands on the kanban's button`).toBe(kn.html);
    await ada.keyboard.press("Escape");
    await settle(ada, 300);

    // ---- a note: a drag across its words selects them; the card and the grid stay
    await show(ada, ids.Words, z);
    const nb = { o: await obj(ada, ids.Words), w: await world(ada) };
    await ada.mouse.move(...(Object.values(await mid(card(ada, ids.Words))).slice(0, 2) as [number, number]), { steps: 4 });
    await settle(ada, 500); // the bar has made room; the words are where they'll be
    const line = (await slot(ada, ids.Words).locator(".note-rendered p").first().boundingBox())!;
    await drag(ada, { x: line.x + 3 * z, y: line.y + line.height * 0.3 }, { x: Math.min(line.width - 8 * z, 260 * z), y: 0 });
    const picked = await ada.evaluate(() => getSelection()?.toString() ?? "");
    expect(picked.length, `z=${z}: a drag across a note's words selects them (“${picked}”)`).toBeGreaterThan(3);
    expect("The bearing seat is reamed to H7 and the press fit holds at sixty degrees.").toContain(picked.trim());
    expect(await obj(ada, ids.Words)).toEqual(nb.o);
    expect(await world(ada)).toBe(nb.w);
    await ada.evaluate(() => getSelection()?.removeAllRanges());

    // ---- a table: a click picks the cell
    await show(ada, ids.Sheet, z);
    const cell = await mid(slot(ada, ids.Sheet).locator(".cell", { hasText: "Hub" }));
    await click(ada, cell.x, cell.y);
    await expect(slot(ada, ids.Sheet).locator(".cell.sel"), `z=${z}: a click picks the cell`).toHaveText("Hub");
    const other = await mid(slot(ada, ids.Sheet).locator(".cell", { hasText: "Duct" }));
    await click(ada, other.x, other.y);
    await expect(slot(ada, ids.Sheet).locator(".cell.sel")).toHaveText("Duct");
    await ada.keyboard.press("Escape");
  }

  // and at the smallest: ✕, then Remove takes the character off the board
  await show(ada, ids.Taro, 0.3);
  const s = slot(ada, ids.Taro);
  const body = await mid(s.locator(".frame-card"));
  await ada.mouse.move(body.x, body.y, { steps: 6 });
  await settle(ada, 450);
  const x = await mid(s.locator(".frame-header .is-remove"));
  await click(ada, x.x, x.y);
  await expect(s.locator(".frame-confirm")).toBeVisible();
  await settle(ada, 350);
  const rm = await mid(s.locator(".frame-confirm .confirm-btn.danger"));
  await click(ada, rm.x, rm.y);
  await expect(ada.locator('[data-character-card="Taro"]'), "Remove, at 0.3, removes it").toHaveCount(0);
});

test("1b · what a left drag does pick up: the paper pans, a card's bar moves it, an image or a video moves from anywhere on it; a tap on a video plays it", async () => {
  // a card's bar
  await show(ada, ids.Words, 0.8);
  const c = await mid(card(ada, ids.Words));
  await ada.mouse.move(c.x, c.y, { steps: 5 });
  await settle(ada, 450);
  const bar = await mid(slot(ada, ids.Words).locator(".frame-header .frame-title"));
  const was = (await obj(ada, ids.Words))!;
  await drag(ada, bar, { x: 80, y: 48 });
  const now = (await obj(ada, ids.Words))!;
  expect(now.float, "picked up by its bar, it floats").toBe(true);
  expect(Math.hypot(now.x - was.x, now.y - was.y), "and has moved").toBeGreaterThan(40);

  // a near miss between the bar's buttons is not a grab
  await ada.mouse.move((await mid(card(ada, ids.Words))).x, (await mid(card(ada, ids.Words))).y, { steps: 5 });
  await settle(ada, 450);
  const acts = (await slot(ada, ids.Words).locator(".frame-header .header-actions").boundingBox())!;
  const gap = await ada.evaluate(([l, t, w, h]) => {
    for (let x = l + 1; x < l + w; x += 1) {
      const el = document.elementFromPoint(x, t + h / 2);
      if (el?.classList.contains("header-actions")) return { x, y: t + h / 2 };
    }
    return null;
  }, [acts.x, acts.y, acts.width, acts.height]);
  if (gap) {
    const at = (await obj(ada, ids.Words))!;
    await drag(ada, gap, { x: 60, y: 30 });
    expect(await obj(ada, ids.Words), "a press in the gap between two of the bar's buttons moves nothing").toEqual(at);
  }

  // an image (2026-11-24): the picture itself is the handle; its buttons wait in its top-right corner
  await show(ada, ids.Picture, 0.8);
  const pic = slot(ada, ids.Picture);
  const pm = await mid(pic.locator(".frame-card"));
  await expect(pic.locator(".frame-corner")).toHaveCSS("opacity", "0"); // nothing at rest
  await expect(pic.locator(".frame-grip, .frame-icons, .is-remove")).toHaveCount(0); // no grip, no ✕
  await ada.mouse.move(pm.x, pm.y, { steps: 4 });
  await settle(ada, 500);
  const corner = pic.locator(".frame-corner");
  await expect(corner).toHaveCSS("opacity", "1");
  const fs = (await corner.locator(".fs-open").boundingBox())!;
  const cb = (await pic.locator(".frame-card").boundingBox())!;
  // full screen, top right, 8 px in, 28 px round
  expect(Math.abs(cb.x + cb.width - (fs.x + fs.width) - 8 * 0.8)).toBeLessThan(2.5);
  expect(Math.abs(fs.y - cb.y - 8 * 0.8)).toBeLessThan(2.5);
  expect(Math.abs(fs.width - 28 * 0.8)).toBeLessThan(1.5);
  await ada.screenshot({ path: `${SHOTS}/02_image-corner-night.png`, clip: { x: cb.x - 30, y: cb.y - 30, width: cb.width + 60, height: cb.height + 60 } });
  const p0 = { o: (await obj(ada, ids.Picture))!, w: await world(ada) };
  await drag(ada, pm, { x: 70, y: 44 });
  const p1 = (await obj(ada, ids.Picture))!;
  expect(p1.float).toBe(true);
  expect(Math.hypot(p1.x - p0.o.x, p1.y - p0.o.y), "picked up anywhere on it, it moves").toBeGreaterThan(40);
  expect(await world(ada), "and the grid doesn't pan").toBe(p0.w);

  // a video: a tap plays or pauses it; a drag on it moves it and doesn't play it
  await show(ada, ids.Clip, 0.8);
  const vid = slot(ada, ids.Clip);
  const vm = await mid(vid.locator(".frame-card"));
  expect((await obj(ada, ids.Clip))!.autoplay).toBe(false);
  await click(ada, vm.x, vm.y);
  expect((await obj(ada, ids.Clip))!.autoplay, "a tap on a video plays it").toBe(true);
  await click(ada, vm.x, vm.y);
  expect((await obj(ada, ids.Clip))!.autoplay, "and pauses it").toBe(false);
  const v0 = (await obj(ada, ids.Clip))!;
  await drag(ada, vm, { x: 60, y: 40 });
  const v1 = (await obj(ada, ids.Clip))!;
  expect(Math.hypot(v1.x - v0.x, v1.y - v0.y), "a drag on the video moves it").toBeGreaterThan(30);
  expect(v1.autoplay, "and moving it isn't a tap").toBe(false);

  // the paper pans (a press where no section is)
  await ada.keyboard.press("0");
  await settle(ada, 1200);
  const paper = await ada.evaluate(() => {
    for (let y = 80; y < innerHeight - 20; y += 12)
      for (let x = innerWidth - 12; x > 20; x -= 12) {
        const el = document.elementFromPoint(x, y);
        if (el && el.closest(".grid-viewport") && !el.closest(".section-card, button, .gutter, .empty-cell, .viewport-toolbar")) return { x, y };
      }
    return null;
  });
  expect(paper, "some bare paper on screen").not.toBeNull();
  const w0 = await world(ada);
  await drag(ada, paper!, { x: -120, y: -60 });
  expect(await world(ada), "a drag on the paper pans the grid").not.toBe(w0);
});

test("2 · Ctrl-wheel always zooms; Alt-wheel scrolls the card under the pointer, and is the grid's wheel where there's nothing to scroll", async () => {
  await show(ada, ids.Long, 1);
  const pane = slot(ada, ids.Long).locator(".note-rendered");
  const top = () => pane.evaluate((el) => el.scrollTop);
  const c = await mid(card(ada, ids.Long));
  await ada.mouse.move(c.x, c.y + 20, { steps: 5 });
  await settle(ada, 400);
  expect(await pane.evaluate((el) => el.scrollHeight > el.clientHeight + 100), "the note has more than fits").toBe(true);

  // Ctrl: the grid zooms, the card stays where it was in its text (yesterday it scrolled the card)
  let w = await world(ada);
  await ada.keyboard.down("Control");
  await ada.mouse.wheel(0, 120);
  await settle(ada, 700);
  await ada.keyboard.up("Control");
  expect(await top(), "Ctrl-wheel over a long card doesn't scroll it").toBe(0);
  expect(zoomOf(await world(ada)), "it zooms the grid").toBeLessThan(zoomOf(w) - 0.05);
  await ada.keyboard.down("Control");
  await ada.mouse.wheel(0, -120);
  await ada.keyboard.up("Control");
  await settle(ada, 2000); // the zoom's spring comes fully to rest before the grid is held to "didn't move"

  // Alt: the card scrolls, the grid stays
  w = await world(ada);
  await ada.keyboard.down("Alt");
  await ada.mouse.wheel(0, 120);
  await settle(ada, 500);
  expect(await top(), "Alt-wheel scrolls the card").toBeGreaterThan(80);
  expect(await world(ada), "and the grid doesn't move").toBe(w);
  // to its end, and past it: held (no pan, no zoom)
  const max = await pane.evaluate((el) => el.scrollHeight - el.clientHeight);
  for (let i = 0; i < Math.ceil(max / 300) + 3; i++) await ada.mouse.wheel(0, 300);
  await settle(ada, 700);
  expect(Math.abs((await top()) - max)).toBeLessThan(2);
  for (let i = 0; i < 4; i++) await ada.mouse.wheel(0, 120);
  await settle(ada, 500);
  expect(await world(ada), "at the card's end the wheel is held").toBe(w);
  await ada.mouse.wheel(0, -200);
  await settle(ada, 500);
  expect(await top()).toBeLessThan(max - 100);
  // Ctrl+Alt is still a zoom
  await ada.keyboard.down("Control");
  const t0 = await top();
  await ada.mouse.wheel(0, 100);
  await settle(ada, 600);
  await ada.keyboard.up("Control");
  expect(await top()).toBe(t0);
  expect(zoomOf(await world(ada))).toBeLessThan(zoomOf(w) - 0.05);
  await ada.keyboard.up("Alt");
  await settle(ada, 2000);

  // no key: the grid pans, the card doesn't scroll
  w = await world(ada);
  const t1 = await top();
  await ada.mouse.wheel(0, 60);
  await settle(ada, 400);
  expect(await top()).toBe(t1);
  expect(await world(ada)).not.toBe(w);
  expect(zoomOf(await world(ada))).toBeCloseTo(zoomOf(w), 5);

  // Alt over a card with nothing to scroll, and over the paper: the grid's own wheel (a pan)
  await show(ada, ids.Short, 1);
  const sc = await mid(card(ada, ids.Short));
  await ada.mouse.move(sc.x, sc.y, { steps: 5 });
  await settle(ada, 400);
  w = await world(ada);
  await ada.keyboard.down("Alt");
  await ada.mouse.wheel(0, 60);
  await settle(ada, 400);
  expect(await world(ada), "Alt-wheel over a short card pans as the wheel does").not.toBe(w);
  expect(zoomOf(await world(ada))).toBeCloseTo(zoomOf(w), 5);
  await ada.keyboard.up("Alt");

  // ⇧ turns it sideways: a wide table
  await show(ada, ids.Sheet, 1);
  const wide = await slot(ada, ids.Sheet).evaluate((el) => {
    for (const n of el.querySelectorAll<HTMLElement>("*")) if (n.scrollWidth > n.clientWidth + 40 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
    return false;
  });
  test.info().annotations.push({ type: "sideways", description: wide ? "a pane wider than its card was on the board" : "no card on this board is wider than its pane: ⇧ sideways is covered by the unit test only" });
});

test("2b · the mark on a card that scrolls: there on rest, says what to do, goes after three Alt-scrolls or its ✕, and stays gone", async ({ browser }) => {
  const fresh = async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    await c.addInitScript(() => localStorage.getItem("foundation-floor") ?? localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
    const p = await c.newPage();
    await p.goto(`/?board=${board}`);
    await waitLive(p);
    return { c, p };
  };
  const rest = async (p: Page, id: string) => {
    const c = await mid(card(p, id));
    await p.mouse.move(c.x - 40, c.y + 10, { steps: 5 });
    await p.mouse.move(c.x, c.y + 20, { steps: 3 });
    await settle(p, 800);
  };
  const memory = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem("foundation-scroll-hint") ?? "null") as { off: boolean; used: number } | null);

  // ---- a new device
  let { c, p } = await fresh();
  await show(p, ids.Long, 1);
  await expect(p.locator(".scroll-hint")).toHaveCount(0); // nothing until the pointer rests on such a card
  await rest(p, ids.Long);
  const hint = slot(p, ids.Long).locator(".scroll-hint");
  await expect(hint).toHaveClass(/is-on/);
  await expect(hint).toHaveCSS("opacity", "1");
  const m = (await hint.locator(".scroll-hint-mark").boundingBox())!;
  expect(Math.abs(m.width - 20), "a 20 px round").toBeLessThan(0.6);
  expect(Math.abs(m.height - 20)).toBeLessThan(0.6);
  await expect(hint.locator(".scroll-hint-key")).toHaveText("Alt");
  const cb = (await card(p, ids.Long).boundingBox())!;
  expect(cb.x + cb.width - (m.x + m.width), "at the card's right edge, by the scroll line").toBeLessThan(16);
  expect(await hint.evaluate((el) => getComputedStyle(el).backdropFilter + getComputedStyle(el.querySelector(".scroll-hint-mark")!).backdropFilter), "no blur inside the world").toBe("nonenone");
  expect(await hint.evaluate((el) => !!el.closest("[title]") || !!el.querySelector("[title]"))).toBe(false);
  await p.screenshot({ path: `${SHOTS}/03_scroll-hint-night.png` });
  // its roll-over label
  await p.mouse.move(m.x + m.width / 2, m.y + m.height / 2, { steps: 4 });
  await expect(p.locator(".f-tip.is-on")).toHaveText("Alt + scroll to scroll through this card");
  await expect(hint.locator(".scroll-hint-x")).toHaveCSS("opacity", "1");
  await p.screenshot({ path: `${SHOTS}/04_scroll-hint-label-night.png`, clip: { x: cb.x + cb.width - 330, y: m.y - 70, width: 420, height: 170 } });
  // not on a card with nothing to scroll; and it goes with the pointer
  await rest(p, ids.Short);
  await expect(p.locator(".scroll-hint.is-on")).toHaveCount(0);
  await leave(p);
  await expect(p.locator(".scroll-hint")).toHaveCount(0);

  // ---- three Alt-scrolls and it has done its job
  const pane = slot(p, ids.Long).locator(".note-rendered");
  for (let i = 1; i <= 3; i++) {
    await rest(p, ids.Long);
    if (i < 3) await expect(slot(p, ids.Long).locator(".scroll-hint.is-on"), `before scroll ${i} it's still offered`).toHaveCount(1);
    await p.keyboard.down("Alt");
    await p.mouse.wheel(0, 100);
    await p.mouse.wheel(0, 100); // one turn of the wheel is one scroll
    await p.keyboard.up("Alt");
    await settle(p, 900);
    expect((await memory(p))?.used).toBe(i);
    await leave(p);
  }
  expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
  await rest(p, ids.Long);
  await expect(p.locator(".scroll-hint"), "after three Alt-scrolls it stops by itself").toHaveCount(0);
  await p.reload();
  await waitLive(p);
  await show(p, ids.Long, 1);
  await rest(p, ids.Long);
  await expect(p.locator(".scroll-hint"), "and stays gone after a reload").toHaveCount(0);
  await c.close();

  // ---- another new device: ✕ puts it away for good
  ({ c, p } = await fresh());
  await show(p, ids.Long, 1);
  await rest(p, ids.Long);
  const h2 = slot(p, ids.Long).locator(".scroll-hint");
  await expect(h2).toHaveClass(/is-on/);
  const before = { o: await obj(p, ids.Long), w: await world(p) };
  const x = h2.locator(".scroll-hint-x");
  const xm = await mid(h2.locator(".scroll-hint-mark"));
  await p.mouse.move(xm.x, xm.y, { steps: 4 });
  await expect(x).toHaveCSS("opacity", "1");
  const xb = await mid(x);
  await p.mouse.move(xb.x, xb.y, { steps: 3 });
  await expect(p.locator(".f-tip.is-on")).toHaveText("Got it");
  await p.mouse.down();
  await p.mouse.up();
  await expect(p.locator(".scroll-hint.is-on")).toHaveCount(0);
  expect(await memory(p)).toEqual({ off: true, used: 0 });
  expect({ o: await obj(p, ids.Long), w: await world(p) }, "dismissing it moved nothing").toEqual(before);
  await leave(p);
  await rest(p, ids.Long);
  await expect(p.locator(".scroll-hint"), "dismissed: never shown again").toHaveCount(0);
  await p.reload();
  await waitLive(p);
  await show(p, ids.Long, 1);
  await rest(p, ids.Long);
  await expect(p.locator(".scroll-hint"), "nor after a reload").toHaveCount(0);
  // Alt-scroll still works for someone who dismissed the hint
  await p.keyboard.down("Alt");
  await p.mouse.wheel(0, 120);
  await p.keyboard.up("Alt");
  await settle(p, 500);
  expect(await slot(p, ids.Long).locator(".note-rendered").evaluate((el) => el.scrollTop)).toBeGreaterThan(80);
  await c.close();
});

test("3 · a section's menu: the council, Add and Live side by side, the grid's actions as a row of icons that name themselves; the keys move through it; it fits the window", async () => {
  await ada.keyboard.press("0");
  await settle(ada, 1200);
  const sec = ada.locator(".section-card", { has: ada.locator(".section-name", { hasText: "Reading" }) }).first();
  const sb = (await sec.boundingBox())!;
  const open = async (x = sb.x + sb.width - 30, y = sb.y + sb.height - 30) => {
    await ada.mouse.move(x, y, { steps: 4 });
    await ada.mouse.click(x, y, { button: "right" });
    await expect(ada.locator(".context-menu")).toBeVisible();
    await settle(ada, 350);
  };
  await open();
  const menu = ada.locator(".context-menu");
  await expect(menu).toHaveClass(/is-grouped/);
  const box = async (l: Locator) => (await l.first().boundingBox())!;

  // the council first, across the top
  const first = menu.locator("button").first();
  await expect(first).toHaveText(/Council: ask this section's agents…/);
  await expect(first).toHaveClass(/is-agent/);
  const mb = await box(menu);
  expect((await box(first)).width, "across the menu").toBeGreaterThan(mb.width - 20);

  // Add and Live: two columns side by side under their captions
  const cols = menu.locator(".menu-col");
  await expect(cols).toHaveCount(2);
  await expect(cols.nth(0).locator(".menu-heading")).toHaveText("Add");
  await expect(cols.nth(1).locator(".menu-heading")).toHaveText("Live");
  const [a, l] = [await box(cols.nth(0)), await box(cols.nth(1))];
  expect(Math.abs(a.y - l.y), "side by side").toBeLessThan(1);
  expect(l.x).toBeGreaterThan(a.x + a.width - 1);
  expect(a.y).toBeGreaterThan((await box(first)).y + 20);
  const texts = async (c: Locator) => (await c.locator(".menu-item").allInnerTexts()).map((t) => t.replace(/^\S+\s+/, "").trim());
  expect(await texts(cols.nth(0))).toEqual(["Note", "Voice or video note…", "Table", "Map", "Image, video or file…", "App or web page…"]);
  expect(await texts(cols.nth(1))).toEqual(["Agents card", "Huddle", "ChatForm channel", "Slack channel", "Machine", "Full operating system / WildOS VM", "Kubernetes cluster", "Character: 3D", "Character: mesh avatar", "Collection", "Character pipeline", "All agents on this grid"]);

  // the grid's own actions: a row of icons along the bottom, no words, each named on roll-over
  const row = menu.locator(".menu-iconrow");
  const icons = row.locator("button");
  const names = await icons.evaluateAll((els) => els.map((el) => ({ tip: el.getAttribute("data-tip"), aria: el.getAttribute("aria-label"), title: el.getAttribute("title"), text: (el.textContent ?? "").trim(), danger: el.classList.contains("danger") })));
  expect(names.map((n) => n.tip)).toEqual(["Open as its own grid", "Insert section left", "Insert section right", "Insert section above", "Insert section below", "Split column", "Split row", "Remove section…"]);
  for (const n of names) {
    expect(n.aria).toBe(n.tip);
    expect(n.title, "the app's own tip, never a title").toBeNull();
    expect(n.text.length, `“${n.tip}” is an icon, not words`).toBeLessThanOrEqual(1);
  }
  expect(names.map((n) => n.danger)).toEqual([false, false, false, false, false, false, false, true]);
  const rb = await box(row);
  expect(rb.y, "under the columns").toBeGreaterThan(Math.max(a.y + a.height, l.y + l.height) - 1);
  const ys = await icons.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().y)));
  expect(new Set(ys).size, "in one line").toBe(1);
  expect(await row.evaluate((el) => getComputedStyle(el).borderTopWidth), "under a hairline").toBe("1px");
  // Remove: last, in the bad colour, set apart
  const rm = icons.last();
  const prev = icons.nth(names.length - 2);
  expect((await box(rm)).x - ((await box(prev)).x + (await box(prev)).width), "set apart").toBeGreaterThan(10);
  expect(await rm.evaluate((el) => getComputedStyle(el).color)).toBe(await ada.evaluate(() => {
    const d = document.createElement("i");
    d.style.color = "var(--danger)";
    document.body.append(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }));
  // roll over one: its name comes up in the app's tip
  const left = icons.nth(1);
  const lb = await box(left);
  await ada.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 4 });
  await expect(ada.locator(".f-tip.is-on")).toHaveText("Insert section left");
  await ada.screenshot({ path: `${SHOTS}/05_section-menu-night.png` });
  const rmb = await box(rm);
  await ada.mouse.move(rmb.x + rmb.width / 2, rmb.y + rmb.height / 2, { steps: 4 });
  await expect(ada.locator(".f-tip.is-on")).toHaveText("Remove section…");
  // inside the window
  const inside = async () => {
    const b = await box(ada.locator(".context-menu"));
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1440);
    expect(b.y + b.height).toBeLessThanOrEqual(900);
  };
  await inside();

  // ---- the keys
  const focused = () =>
    ada.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute("aria-label") ?? [...(el?.childNodes ?? [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    });
  await ada.mouse.move(mb.x - 40, mb.y - 40 > 0 ? mb.y - 40 : mb.y + mb.height + 30);
  const w0 = await world(ada);
  await ada.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Council: ask this section's agents…");
  await ada.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Note");
  await ada.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Voice or video note…");
  await ada.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Table");
  // back up a row, so the move right lands beside the second row, as it did before the voice note was added
  await ada.keyboard.press("ArrowUp");
  await ada.keyboard.press("ArrowRight");
  expect(await focused()).toBe("Huddle");
  await ada.keyboard.press("ArrowUp");
  expect(await focused()).toBe("Agents card");
  await ada.keyboard.press("ArrowLeft");
  expect(await focused()).toBe("Note");
  await ada.keyboard.press("End");
  expect(await focused()).toBe("Remove section…");
  await ada.keyboard.press("ArrowLeft");
  expect(await focused()).toBe("Split row");
  await ada.keyboard.press("ArrowUp");
  expect(await focused(), "back up into the column it came from").toBe("App or web page…");
  await ada.keyboard.press("ArrowDown");
  await ada.keyboard.press("ArrowRight");
  expect(await focused()).toBe("Insert section left");
  await ada.keyboard.press("ArrowDown");
  expect(await focused(), "round to the top").toBe("Council: ask this section's agents…");
  expect(await world(ada), "the arrows are the menu's while it's open: the grid doesn't pan").toBe(w0);
  // what has the keyboard looks as it does under the pointer
  await ada.keyboard.press("ArrowDown");
  const fill = await ada.evaluate(() => getComputedStyle(document.activeElement!).backgroundColor);
  expect(fill).not.toBe("rgba(0, 0, 0, 0)");
  // Enter does it
  const notes = () => ada.evaluate(() => Object.keys((window as unknown as { __foundation: Store }).__foundation.getState().notes).length);
  const n0 = await notes();
  expect(await focused()).toBe("Note");
  await ada.keyboard.press("Enter");
  await expect(ada.locator(".context-menu")).toHaveCount(0);
  await expect.poll(notes, { message: "Enter on Note adds one" }).toBe(n0 + 1);
  // Esc closes
  await ada.keyboard.press("Escape");
  await settle(ada, 600);
  await ada.keyboard.press("0");
  await settle(ada, 1200);
  const sb2 = (await sec.boundingBox())!;
  await open(sb2.x + sb2.width - 30, sb2.y + sb2.height - 30);
  await ada.keyboard.press("Escape");
  await expect(ada.locator(".context-menu")).toHaveCount(0);

  // ---- an icon does its thing: Split column
  const sections = () => ada.evaluate(() => Object.keys((window as unknown as { __foundation: Store }).__foundation.getState().sections).length);
  const s0 = await sections();
  await open(sb2.x + sb2.width - 30, sb2.y + sb2.height - 30);
  const split = ada.locator('.menu-iconrow button[aria-label="Split column"]');
  const spb = await box(split);
  await click(ada, spb.x + spb.width / 2, spb.y + spb.height / 2);
  await expect(ada.locator(".context-menu")).toHaveCount(0);
  await expect.poll(sections, { message: "Split column makes a section" }).toBe(s0 + 1);

  // ---- it fits the window: opened in the bottom-right corner, and on a narrow window (the columns stack)
  await ada.keyboard.press("0");
  await settle(ada, 1200);
  const corner = await ada.evaluate(() => {
    let best: { x: number; y: number } | null = null;
    for (const el of document.querySelectorAll<HTMLElement>(".section-card[data-section-id]")) {
      const r = el.getBoundingClientRect();
      const x = Math.min(r.right - 12, innerWidth - 8);
      const y = Math.min(r.bottom - 12, innerHeight - 8);
      const hit = document.elementFromPoint(x, y);
      if (hit && el.contains(hit) && !hit.closest(".obj-slot") && (!best || x + y > best.x + best.y)) best = { x, y };
    }
    return best;
  });
  expect(corner).not.toBeNull();
  await open(corner!.x, corner!.y);
  await inside();
  await ada.keyboard.press("Escape");
  await expect(ada.locator(".context-menu")).toHaveCount(0);

  // a table cell's menu is still a plain list, and the keys walk it
  await show(ada, ids.Sheet, 1);
  const cell = await mid(slot(ada, ids.Sheet).locator(".cell", { hasText: "Rim" }));
  await ada.mouse.click(cell.x, cell.y, { button: "right" });
  await expect(ada.locator(".context-menu")).toBeVisible();
  await expect(ada.locator(".context-menu")).not.toHaveClass(/is-grouped/);
  await expect(ada.locator(".context-menu .menu-cols, .context-menu .menu-iconrow")).toHaveCount(0);
  await ada.keyboard.press("ArrowDown");
  expect(await ada.evaluate(() => document.activeElement?.classList.contains("menu-item"))).toBe(true);
  await ada.keyboard.press("Escape");
});

test("3b · on a narrow window the menu's columns stack and it still fits; an empty cell's menu is a list", async ({ browser }) => {
  const c = await browser.newContext({ viewport: { width: 420, height: 640 }, colorScheme: "dark" });
  await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
  await c.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const p = await c.newPage();
  await p.goto(`/?board=${board}`);
  await waitLive(p);
  await settle(p, 800);
  const at = await p.evaluate(() => {
    for (let y = innerHeight - 30; y > 90; y -= 14)
      for (let x = innerWidth - 20; x > 20; x -= 14) {
        const el = document.elementFromPoint(x, y);
        if (el?.closest(".section-card[data-section-id]") && !el.closest(".obj-slot, button, .section-header")) return { x, y };
      }
    return null;
  });
  expect(at, "a bit of a section on a narrow window").not.toBeNull();
  await p.mouse.click(at!.x, at!.y, { button: "right" });
  const menu = p.locator(".context-menu");
  await expect(menu).toBeVisible();
  await settle(p, 400);
  const b = (await menu.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(420);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(640);
  const cols = menu.locator(".menu-col");
  const [a, l] = [(await cols.nth(0).boundingBox())!, (await cols.nth(1).boundingBox())!];
  // 420 wide holds two 196 px columns only just; either they sit side by side inside it, or they stack
  if (l.y > a.y + 10) expect(l.x).toBeCloseTo(a.x, 0);
  else expect(l.x + l.width).toBeLessThanOrEqual(420);
  // longer than the window, it scrolls inside itself
  expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  await p.screenshot({ path: `${SHOTS}/06_section-menu-narrow-night.png` });
  await p.keyboard.press("Escape");

  // an empty cell (this board has some: five sections on a wider grid): the short list it always was
  await expect(menu).toHaveCount(0);
  await p.keyboard.press("0");
  await settle(p, 1200);
  const empty = p.locator(".empty-cell").first();
  await expect(empty).toBeVisible();
  const eb = (await empty.boundingBox())!;
  await p.mouse.click(eb.x + eb.width / 2, eb.y + eb.height * 0.25, { button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu).not.toHaveClass(/is-grouped/);
  await expect(menu.locator(".menu-item")).toHaveCount(2);
  await expect(menu.locator(".menu-item").first()).toHaveText(/Create section at [A-Z]+\d+/);
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  expect(await p.evaluate(() => document.activeElement?.classList.contains("is-agent"))).toBe(true);
  await p.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await c.close();
});

test("day and night: the board and #/design", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const tone = scheme === "light" ? "day" : "night";
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    await c.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
    const p = await c.newPage();
    await p.goto(`/?board=${board}`);
    await waitLive(p);
    await setUp(p, false); // (Taro was removed in 1)

    // the mark on a card that scrolls
    await show(p, ids.Long, 1);
    const cm = await mid(card(p, ids.Long));
    await p.mouse.move(cm.x - 30, cm.y, { steps: 4 });
    await p.mouse.move(cm.x, cm.y + 20, { steps: 3 });
    await settle(p, 900);
    await expect(slot(p, ids.Long).locator(".scroll-hint.is-on")).toHaveCount(1);
    await p.screenshot({ path: `${SHOTS}/10_scroll-hint-${tone}.png` });
    const hm = await mid(slot(p, ids.Long).locator(".scroll-hint-mark"));
    await p.mouse.move(hm.x, hm.y, { steps: 3 });
    await settle(p, 600);
    await p.screenshot({ path: `${SHOTS}/11_scroll-hint-close-${tone}.png`, clip: { x: hm.x - 260, y: hm.y - 70, width: 340, height: 160 } });

    // an image's corner
    await show(p, ids.Picture, 1);
    const pm = await mid(card(p, ids.Picture));
    await p.mouse.move(pm.x, pm.y, { steps: 4 });
    await settle(p, 700);
    await expect(slot(p, ids.Picture).locator(".frame-corner")).toHaveCSS("opacity", "1");
    await p.screenshot({ path: `${SHOTS}/12_image-corner-${tone}.png`, clip: { x: pm.left - 40, y: pm.top - 40, width: pm.w + 130, height: pm.h + 80 } });

    // a section's menu
    await p.keyboard.press("0");
    await settle(p, 1200);
    const sb = (await p.locator(".section-card", { has: p.locator(".section-name", { hasText: "Media" }) }).first().boundingBox())!;
    await p.mouse.click(sb.x + sb.width * 0.4, sb.y + sb.height - 24, { button: "right" });
    await expect(p.locator(".context-menu.is-grouped")).toBeVisible();
    await settle(p, 400);
    const ib =(await p.locator('.menu-iconrow button[aria-label="Split row"]').boundingBox())!;
    await p.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 4 });
    await expect(p.locator(".f-tip.is-on")).toHaveText("Split row");
    await settle(p, 300);
    await p.screenshot({ path: `${SHOTS}/13_section-menu-${tone}.png` });
    const mb = (await p.locator(".context-menu").boundingBox())!;
    await p.screenshot({ path: `${SHOTS}/14_section-menu-close-${tone}.png`, clip: { x: Math.max(0, mb.x - 16), y: Math.max(0, mb.y - 16), width: mb.width + 32, height: Math.min(900 - Math.max(0, mb.y - 16), mb.height + 60) } });
    await p.keyboard.press("Escape");

    // #/design: the specimens, on the real classes
    await p.goto("/#/design");
    const demo = p.locator("[data-pointer-demo]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator(".frame-corner")).toHaveCount(2);
    await expect(demo.locator(".frame-anchor.is-hover .frame-corner")).toHaveCSS("opacity", "1");
    await expect(demo.locator(".scroll-hint.is-on")).toHaveCount(2);
    await expect(demo.locator(".scroll-hint.is-shown-x .scroll-hint-x")).toHaveCSS("opacity", "1");
    const spec = demo.locator('[data-menu-specimen="section"]');
    await expect(spec.locator(".menu-col")).toHaveCount(2);
    await expect(spec.locator(".menu-iconrow button")).toHaveCount(9);
    const narrow = demo.locator('[data-menu-specimen="narrow"] .menu-col');
    expect((await narrow.nth(1).boundingBox())!.y, "the narrow specimen stacks its columns").toBeGreaterThan((await narrow.nth(0).boundingBox())!.y + 100);
    await expect(demo.locator('[data-menu-specimen="cell"] .menu-item')).toHaveCount(2);
    await settle(p, 500);
    await demo.locator(".adapt-row").first().scrollIntoViewIfNeeded();
    await p.mouse.wheel(0, -120); // clear of the page's own header
    await settle(p, 400);
    await demo.locator(".adapt-row").first().screenshot({ path: `${SHOTS}/20_design-cards-${tone}.png` });
    await demo.locator(".pointer-demo-menus").scrollIntoViewIfNeeded();
    await settle(p, 400);
    await demo.locator(".pointer-demo-menus").screenshot({ path: `${SHOTS}/22_design-menus-${tone}.png` });
    // a specimen icon names itself too
    const one = spec.locator('.menu-iconrow button[aria-label="Insert section above"]');
    await one.scrollIntoViewIfNeeded();
    const ob = (await one.boundingBox())!;
    await p.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2, { steps: 4 });
    // (the page has specimen tips of its own: the live one is the one that is neither)
    await expect(p.locator(".f-tip.is-on:not(.keys-tip):not(.oncall-tip)")).toHaveText("Insert section above");
    await settle(p, 300);
    await p.screenshot({ path: `${SHOTS}/21_design-menu-${tone}.png`, clip: { x: Math.max(0, ob.x - 160), y: Math.max(0, ob.y - 330), width: 560, height: 400 } });
    await c.close();
  }
});

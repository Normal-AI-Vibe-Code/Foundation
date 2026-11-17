/**
 * A card's chrome, in a real browser (Josh, 2026-11-16: "I attempted to
 * delete Taro and couldn't … Allow me to remove Taro. The Cards roll over
 * menu covers up the card contents, it should push it down. also there needs
 * to be a ctrl+scroll feature to scroll through a card. make the scroll bar
 * much thinner and basically 2px line next to the edge of the card and light
 * colored. Make the re-size handles much thinner and really just a gleam on
 * the card corner, and don't show it until hovering over.")
 *
 *  1. Removing a character: ✕ asks first (Keep, Esc and a click elsewhere
 *     keep it); Remove takes the card off, and the character leaves the
 *     board's map, the server's roster and this browser's roster without a
 *     reload; what it drew stays in the archive. A viewer has no ✕.
 *  2. The hover bar makes room: the card's content moves down 38 px, the
 *     card's box, its neighbours, its section, its ports and its resize corner
 *     stay put; a note's last line stays in the card; a live app's document is
 *     neither reloaded nor resized; the editor isn't pushed twice.
 *  3. Alt-wheel (since 2026-11-17; it was Ctrl-wheel for a day) scrolls through a card with more in it than fits (a note, a
 *     character, a design chapter) and leaves the grid alone; at the end it
 *     holds, then zooms after a beat; over a short card or the paper it zooms;
 *     the plain wheel still pans; a pinch (Ctrl-wheel with no key down) zooms.
 *  4. Scroll bars: a 2 px line, 1 px in from the edge, clear at rest, light
 *     while the pointer is on the pane.
 *  5. The resize corner: nothing at rest, a 1 px arc on the corner while the
 *     pointer is on the card, blue under the pointer, the same 22 px to grab.
 *
 * Meshy is the stand-in (e2e/meshy-standin.mjs): nothing is charged.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-16_card-chrome";
const PUSH = 38;

type Obj = { id: string; name: string; sectionId: string; panel?: string };
type Store = { getState(): { notes: Record<string, Obj>; panels: Record<string, Obj>; sections: Record<string, { id: string; name: string }> }; setState(p: object): void };
type Board = { boardId: string; doc: { getMap(n: string): { has(k: string): boolean } } };

let ada: Page;
let ctx: BrowserContext;
let board = "";
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });
// headless Chromium hides every scroll bar by default; these checks are about them, so they're drawn
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const LONG = ["# Rim drive, rev C", ...Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: the bearing seat is reamed to H7 and the press fit holds at 60 °C.`)].join("\n\n");

const tool = (name: string, data: object) => ctx.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
const find = (p: Page, name: string) =>
  p.evaluate((n) => {
    const s = (window as unknown as { __foundation: Store }).__foundation.getState();
    return [...Object.values(s.notes), ...Object.values(s.panels)].find((o) => o.name === n)?.id ?? null;
  }, name);
/** bring a card to the middle of the screen at a readable size */
async function frame(p: Page, id: string) {
  await p.mouse.move(4, 450); // off every card first, so nothing is hovered while the camera moves
  await p.evaluate((i) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "object", id: i, nonce: Math.random() } }), id);
  await settle(p, 1500);
}
const slot = (p: Page, id: string) => p.locator(`.obj-slot[data-obj-id="${id}"]`);
const world = (p: Page) => p.evaluate(() => document.querySelector<HTMLElement>(".world")!.style.transform);
const zoomOf = (t: string) => Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? NaN);
/** the scale a card is drawn at on screen (zoom × its section's fit) */
const scaleOf = (p: Page, id: string) => slot(p, id).locator(".frame-card").first().evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
const rect = (p: Page, sel: string) =>
  p.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right };
  });
const near = (a: number, b: number, by = 0.75) => expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThan(by);
/** the pointer onto a card's body, the way a person arrives (moves, not a jump) */
async function hover(p: Page, id: string, at: { fx?: number; fy?: number } = {}) {
  const b = (await slot(p, id).locator(".frame-card").first().boundingBox())!;
  await p.mouse.move(b.x + b.width * (at.fx ?? 0.5), b.y + b.height * (at.fy ?? 0.6), { steps: 4 });
  await settle(p, 500);
}
const leave = async (p: Page) => {
  await p.mouse.move(4, 450, { steps: 3 });
  await settle(p, 650);
};

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Chrome ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  await tool("add_section", { name: "Notes" });
  await tool("add_note", { section: "Notes", title: "Long", markdown: LONG });
  await tool("add_note", { section: "Notes", title: "Short", markdown: "# Short\n\nNothing to scroll here." });
  await tool("add_section", { name: "Apps" });
  await tool("add_note", { section: "Apps", title: "Beside", markdown: "A note, so the app is a card and not the section's app." });
  await tool("add_panel", { section: "Apps", panel: "app", name: "Live", url: `${CLIENT}/e2e/frame.html` });
  // a character, on this board: a card in "Characters · Animals"
  const taro = await ctx.request.post(`${CLIENT}/api/boards/${board}/characters`, { data: { name: "Taro", set: "animals", form: "mesh", identity: "A plump red shiba in a soft gouache style.", refs: [], height: 0.6 } });
  expect(taro.ok(), await taro.text()).toBe(true);
  ids.character = ((await taro.json()) as { character: { id: string } }).character.id;
  await ada.goto(`/?board=${board}`);
  await waitLive(ada);
  // a chapter of the design language, as a card beside the notes (what the design grid is made of)
  await ada.evaluate(() => {
    const f = (window as unknown as { __foundation: Store }).__foundation;
    const s = f.getState();
    const sec = Object.values(s.sections).find((x) => x.name === "Notes")!;
    const id = "pnl_design_chrome";
    f.setState({ panels: { ...s.panels, [id]: { id, sectionId: sec.id, name: "Design · cards", panel: "design", source: "cards", x: 0, y: 0, w: 520, h: 420, float: false, bornAt: Date.now(), ports: [] } } });
  });
  for (const n of ["Long", "Short", "Beside", "Live", "Taro", "Design · cards"]) {
    await expect.poll(() => find(ada, n), { message: `the card “${n}”` }).not.toBeNull();
    ids[n] = (await find(ada, n))!;
  }
});

test("1 · removing a character asks first; removed, it leaves the board, the roster and the council without a reload, and its files stay", async ({ browser }) => {
  // give it something to keep: its sheet, drawn by the stand-in
  await frame(ada, ids.Taro);
  const card = ada.locator('[data-character-card="Taro"]');
  await expect(card).toBeVisible();
  const sheet = card.locator('[data-char-stage="sheet"]');
  await sheet.locator("button.f-pill").click();
  await expect(sheet).toHaveAttribute("data-char-state", "done", { timeout: 20_000 });
  const file = await ctx.request.get(`${CLIENT}/api/characters/${ids.character}/files/front`);
  expect(file.status()).toBe(200);
  const inRoster = async () => ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ name: string; boardId: string }> }).characters.some((c) => c.name === "Taro" && c.boardId === board);
  expect(await inRoster()).toBe(true);

  // a viewer sees the card and its bar, and no ✕
  const kai = await person(browser, "Kai Viewer", "kai@normal.dev", board);
  const me = (await (await kai.context.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } };
  const admin = await browser.newContext();
  await admin.request.post(`${CLIENT}/auth/dev`, { data: { name: "Admin", email: "admin@normal.dev" } });
  const set = await admin.request.post(`${CLIENT}/api/boards/${board}/people`, { data: { userId: me.user.id, role: "viewer" } });
  expect(set.ok(), await set.text()).toBe(true);
  await admin.close();
  await kai.page.reload();
  await waitLive(kai.page);
  await expect(kai.page.locator("body.is-viewer")).toHaveCount(1);
  await frame(kai.page, ids.Taro);
  await hover(kai.page, ids.Taro);
  await expect(slot(kai.page, ids.Taro).locator(".frame-header")).toHaveCSS("opacity", "1");
  await expect(slot(kai.page, ids.Taro).locator(".frame-header .is-remove")).toBeHidden();

  // ✕ asks; the card is still there
  const s = slot(ada, ids.Taro);
  const x = s.locator(".frame-header .is-remove");
  const pop = s.locator(".frame-confirm");
  await hover(ada, ids.Taro);
  await x.click();
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("Remove Taro? Its pictures and files stay in the archive.");
  await expect(pop.locator(".confirm-btn.danger")).toHaveText("Remove");
  await settle(ada, 400);
  // the question sits inside the card, under its bar
  const [pb, cb] = [(await pop.boundingBox())!, (await s.locator(".frame-card").first().boundingBox())!];
  expect(pb.x).toBeGreaterThanOrEqual(cb.x);
  expect(pb.x + pb.width).toBeLessThanOrEqual(cb.x + cb.width + 0.5);
  await ada.screenshot({ path: `${SHOTS}/01_remove-asks-night.png` });
  // Keep, Esc, and a click elsewhere all keep it
  await pop.locator(".confirm-btn", { hasText: "Keep" }).click();
  await expect(pop).toHaveCount(0);
  await x.click();
  await expect(pop).toBeVisible();
  await ada.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await x.click();
  await expect(pop).toBeVisible();
  await ada.mouse.click(30, 450);
  await expect(pop).toHaveCount(0);
  await expect(card).toBeVisible();
  expect(await inRoster()).toBe(true);

  // Remove: the card goes, and this browser asks for the roster again by itself
  const asked: string[] = [];
  ada.on("request", (r) => void (r.url().endsWith("/api/characters") && asked.push(r.url())));
  await hover(ada, ids.Taro);
  await x.click();
  await pop.locator(".confirm-btn.danger").click();
  await expect(card).toHaveCount(0);
  await expect(kai.page.locator('[data-character-card="Taro"]')).toHaveCount(0); // and for everyone else on the board
  await expect.poll(() => ada.evaluate((id) => (window as unknown as { __foundationBoard: () => Board }).__foundationBoard().doc.getMap("characters").has(id), ids.Taro), { message: "the board's characters map lets go of it" }).toBe(false);
  await expect.poll(() => asked.length, { message: "the open browser re-reads the roster" }).toBeGreaterThan(0);
  await expect.poll(inRoster).toBe(false);
  // what it drew is still in the archive
  expect((await ctx.request.get(`${CLIENT}/api/characters/${ids.character}/files/front`)).status()).toBe(200);
  // and it stays gone
  await ada.reload();
  await waitLive(ada);
  await settle(ada, 800);
  expect(await find(ada, "Taro")).toBeNull();
  await kai.context.close();
});

test("2 · the hover bar makes room: the content moves down, and nothing else moves", async () => {
  await frame(ada, ids.Long);
  const s = slot(ada, ids.Long);
  const k = await scaleOf(ada, ids.Long);
  const sel = (id: string, inner: string) => `.obj-slot[data-obj-id="${id}"] ${inner}`;
  const read = async () => ({
    card: await rect(ada, sel(ids.Long, ".frame-card")),
    inner: await rect(ada, sel(ids.Long, ".note-inner")),
    body: await rect(ada, sel(ids.Long, ".frame-body")),
    corner: await rect(ada, sel(ids.Long, ".map-resize")),
    other: await rect(ada, sel(ids.Short, ".frame-card")),
    section: await rect(ada, ".section-card:has(.obj-slot[data-obj-id='" + ids.Long + "'])"),
  });
  const rest = await read();
  near(rest.inner.y, rest.body.y);
  await expect(s.locator(".frame-header")).toHaveCSS("opacity", "0");
  await ada.screenshot({ path: `${SHOTS}/02_note-at-rest-night.png` });

  await hover(ada, ids.Long);
  await expect(s.locator(".frame-header")).toHaveCSS("opacity", "1");
  const on = await read();
  // the content is 38 px lower (at the card's scale) and the bar sits in the room it left
  near(on.inner.y - rest.inner.y, PUSH * k, 1);
  const bar = await rect(ada, sel(ids.Long, ".frame-header"));
  expect(bar.bottom).toBeLessThanOrEqual(on.inner.y + 0.5);
  // a note gets shorter from the top: its last line is still inside the card
  near(on.inner.bottom, rest.inner.bottom, 1);
  // nothing else moved: the card's box, its resize corner, the card beside it, the section
  for (const key of ["card", "body", "corner", "other", "section"] as const) expect(on[key], key).toEqual(rest[key]);
  await ada.screenshot({ path: `${SHOTS}/03_note-bar-makes-room-night.png` });

  // it goes back when the pointer leaves
  await leave(ada);
  await expect(s.locator(".frame-header")).toHaveCSS("opacity", "0");
  near((await read()).inner.y, rest.inner.y);

  // writing: the bar is up (focus), the editor is pushed once: its first line sits 38 + 14 below the card's top
  await frame(ada, ids.Short);
  const w = slot(ada, ids.Short);
  const kw = await scaleOf(ada, ids.Short);
  await w.locator(".note-rendered").dblclick();
  await expect(w.locator(".cm-content")).toBeVisible({ timeout: 10_000 });
  await leave(ada);
  await expect(w.locator(".frame-header")).toHaveCSS("opacity", "1");
  const line = await rect(ada, sel(ids.Short, ".cm-line"));
  const cardNow = await rect(ada, sel(ids.Short, ".frame-card"));
  near(line.y - cardNow.y, (PUSH + 14 + 1) * kw, 2.5); // + the card's 1 px border
  await ada.screenshot({ path: `${SHOTS}/03b_writing-pushed-once-night.png` });
  await ada.keyboard.press("Escape");
  await ada.mouse.click(30, 450);
  await settle(ada, 600);

  // a live app: its frame slides down, and its document is neither reloaded nor resized
  await frame(ada, ids.Live);
  const iframe = slot(ada, ids.Live).locator(".live-frame iframe");
  await expect(iframe).toHaveCount(1, { timeout: 15_000 });
  await settle(ada, 800);
  const ka = await scaleOf(ada, ids.Live);
  await iframe.evaluate((f) => f.addEventListener("load", () => ((window as unknown as { __loads: number }).__loads = ((window as unknown as { __loads?: number }).__loads ?? 0) + 1)));
  // the page inside is sandboxed (another origin): ask it for its own size through the browser
  const inside = ada.frames().find((f) => f.url().endsWith("/e2e/frame.html"))!;
  expect(inside, "the app's page").toBeTruthy();
  const doc = async () => ({ ...(await iframe.evaluate((f) => ({ w: f.clientWidth, h: f.clientHeight }))), ...(await inside.evaluate(() => ({ iw: innerWidth, ih: innerHeight }))) });
  const before = { doc: await doc(), frame: await rect(ada, sel(ids.Live, ".live-frame")), card: await rect(ada, sel(ids.Live, ".frame-card")) };
  await hover(ada, ids.Live);
  const after = { doc: await doc(), frame: await rect(ada, sel(ids.Live, ".live-frame")), card: await rect(ada, sel(ids.Live, ".frame-card")) };
  near(after.frame.y - before.frame.y, PUSH * ka, 1);
  expect(after.doc).toEqual(before.doc);
  expect(after.card).toEqual(before.card);
  expect(await ada.evaluate(() => (window as unknown as { __loads?: number }).__loads ?? 0)).toBe(0);
  // the body clips it: nothing of the app hangs out under the card
  const clip = await slot(ada, ids.Live).locator(".frame-body").evaluate((el) => getComputedStyle(el).overflow);
  expect(clip).toBe("hidden");
  await ada.screenshot({ path: `${SHOTS}/04_app-bar-makes-room-night.png` });
  await leave(ada);
});

test("3 · Alt-wheel scrolls through a card with more in it than fits and holds at its end; Ctrl-wheel always zooms; the wheel alone still pans", async () => {
  await frame(ada, ids.Long);
  const pane = slot(ada, ids.Long).locator(".note-rendered");
  const top = () => pane.evaluate((el) => el.scrollTop);
  const max = await pane.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(max).toBeGreaterThan(400);
  await hover(ada, ids.Long);

  // the wheel alone is the grid's: it pans, and the note doesn't scroll
  let before = await world(ada);
  await ada.mouse.wheel(0, 120);
  await settle(ada, 300);
  expect(await world(ada)).not.toBe(before);
  expect(await top()).toBe(0);
  await ada.mouse.wheel(0, -120);
  await settle(ada, 300);

  // Alt held: the note scrolls and the grid stays exactly where it is
  await hover(ada, ids.Long);
  await settle(ada, 900);
  before = await world(ada);
  await ada.keyboard.down("Alt");
  await ada.mouse.wheel(0, 120);
  await expect.poll(top).toBeGreaterThan(100);
  await ada.mouse.wheel(0, 120);
  await expect.poll(top).toBeGreaterThan(220);
  expect(await world(ada)).toBe(before);
  await settle(ada, 200);
  await ada.screenshot({ path: "../../docs/evidence/2026-11-17_pointer/30_alt-wheel-scrolls-the-note-night.png" });
  // back up works the same
  await ada.mouse.wheel(0, -60);
  await expect.poll(top).toBeLessThan(200);

  // on to the end: it stops there, and turning on doesn't lurch into a pan or a zoom
  for (let i = 0; i < Math.ceil(max / 300) + 2; i++) await ada.mouse.wheel(0, 300);
  await expect.poll(top).toBeGreaterThan(max - 2);
  for (let i = 0; i < 4; i++) await ada.mouse.wheel(0, 120);
  await settle(ada, 150);
  expect(await world(ada)).toBe(before);
  // and it stays held however long the pause: Alt means the card
  await settle(ada, 600);
  await ada.mouse.wheel(0, 120);
  await settle(ada, 500);
  expect(await world(ada)).toBe(before);
  await ada.keyboard.up("Alt");
  // Ctrl-wheel over the same card zooms the grid, and the card stays where it was in its text
  const held = await top();
  await ada.keyboard.down("Control");
  await ada.mouse.wheel(0, 120);
  await settle(ada, 500);
  expect(zoomOf(await world(ada))).toBeLessThan(zoomOf(before));
  expect(await top()).toBe(held);
  await ada.keyboard.up("Control");

  // a card with nothing to scroll: Ctrl-wheel zooms
  await frame(ada, ids.Short);
  await hover(ada, ids.Short);
  before = await world(ada);
  await ada.keyboard.down("Control");
  await ada.mouse.wheel(0, -120);
  await settle(ada, 500);
  expect(zoomOf(await world(ada))).toBeGreaterThan(zoomOf(before));
  // the paper: zooms
  await ada.mouse.move(30, 450);
  before = await world(ada);
  await ada.mouse.wheel(0, 120);
  await settle(ada, 500);
  expect(zoomOf(await world(ada))).toBeLessThan(zoomOf(before));
  await ada.keyboard.up("Control");

  // a pinch is a Ctrl-wheel nobody holds a key for: over the long note it still zooms
  await frame(ada, ids.Long);
  await pane.evaluate((el) => (el.scrollTop = 0));
  await hover(ada, ids.Long);
  before = await world(ada);
  await pane.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -12, ctrlKey: true, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  });
  await settle(ada, 400);
  expect(zoomOf(await world(ada))).toBeGreaterThan(zoomOf(before));
  expect(await top()).toBe(0);

  // a chapter of the design language (the design and plan cards share this scroller)
  await frame(ada, ids["Design · cards"]);
  const chapter = slot(ada, ids["Design · cards"]).locator(".design-card");
  await hover(ada, ids["Design · cards"]);
  await settle(ada, 900);
  before = await world(ada);
  await ada.keyboard.down("Alt");
  await ada.mouse.wheel(0, 200);
  await expect.poll(() => chapter.evaluate((el) => el.scrollTop)).toBeGreaterThan(150);
  expect(await world(ada)).toBe(before);
  await ada.keyboard.up("Alt");
  await leave(ada);
});

test("3b · Alt-wheel scrolls a character's card", async () => {
  const made = await ctx.request.post(`${CLIENT}/api/boards/${board}/characters`, { data: { name: "Kumo", set: "animals", form: "mesh", identity: "A dreamy cream shiba puppy.", refs: [], height: 0.5 } });
  expect(made.ok(), await made.text()).toBe(true);
  await expect.poll(() => find(ada, "Kumo")).not.toBeNull();
  const id = (await find(ada, "Kumo"))!;
  // short enough that its stages, words and inspiration don't fit
  await ada.evaluate((i) => {
    const f = (window as unknown as { __foundation: Store }).__foundation;
    const p = f.getState().panels as unknown as Record<string, object>;
    f.setState({ panels: { ...p, [i]: { ...p[i], h: 360 } } });
  }, id);
  await frame(ada, id);
  const body = ada.locator('[data-character-card="Kumo"]');
  await expect(body).toBeVisible();
  expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(60);
  await hover(ada, id);
  const before = await world(ada);
  await ada.keyboard.down("Alt");
  await ada.mouse.wheel(0, 120);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  expect(await world(ada)).toBe(before);
  await ada.keyboard.up("Alt");
  await settle(ada, 300);
  await ada.screenshot({ path: "../../docs/evidence/2026-11-17_pointer/31_alt-wheel-scrolls-a-character-night.png" });
  await leave(ada);
});

test("4 · scroll bars are a 2 px light line, 1 px in from the edge: clear at rest, there while the pointer is on the pane", async () => {
  await frame(ada, ids.Long);
  const pane = slot(ada, ids.Long).locator(".note-rendered");
  const thumb = () =>
    pane.evaluate((el) => {
      const t = getComputedStyle(el, "::-webkit-scrollbar-thumb");
      const b = getComputedStyle(el, "::-webkit-scrollbar");
      return { color: t.backgroundColor, left: t.borderLeftWidth, right: t.borderRightWidth, top: t.borderTopWidth, bottom: t.borderBottomWidth, radius: t.borderTopLeftRadius, clip: t.backgroundClip, strip: b.width, gutter: (el as HTMLElement).offsetWidth - el.clientWidth };
    });
  const alpha = (c: string) => {
    // rgba(...) or color(srgb r g b / a)
    const m = /rgba?\([^)]*?,\s*([\d.]+)\)$/.exec(c) ?? /\/\s*([\d.]+)\)$/.exec(c);
    return m ? Number(m[1]) : c === "transparent" ? 0 : 1;
  };
  const rest = await thumb();
  expect(alpha(rest.color), `at rest: ${rest.color}`).toBe(0);
  // 8 px to grab, of which 5 + 1 are clear: a 2 px line, 1 px in from the edge, square
  expect(rest).toMatchObject({ strip: "8px", left: "5px", right: "1px", top: "5px", bottom: "1px", radius: "0px", clip: "content-box", gutter: 8 });
  await hover(ada, ids.Long);
  const on = await thumb();
  expect(alpha(on.color), `under the pointer: ${on.color}`).toBeGreaterThan(0.2);
  expect(alpha(on.color)).toBeLessThan(0.35);
  await ada.keyboard.down("Alt");
  await ada.mouse.wheel(0, 240);
  await ada.keyboard.up("Alt");
  await settle(ada, 400);
  const b = (await pane.boundingBox())!;
  await ada.screenshot({ path: `${SHOTS}/07_scroll-line-night.png`, clip: { x: b.x + b.width - 140, y: b.y, width: 160, height: Math.min(b.height, 320) } });
  // it scrolled: marked, so the line shows even with the pointer away, and then goes
  await leave(ada);
  await pane.evaluate((el) => (el.scrollTop += 40));
  await expect(pane).toHaveClass(/is-scrolling/);
  expect(alpha((await thumb()).color)).toBeGreaterThan(0.2);
  await expect(pane).not.toHaveClass(/is-scrolling/, { timeout: 3000 });
  expect(alpha((await thumb()).color)).toBe(0);
});

test("5 · the resize corner: nothing at rest, a gleam on the corner while the pointer is on the card, and as easy to grab as before", async () => {
  await frame(ada, ids.Short);
  const s = slot(ada, ids.Short);
  const corner = s.locator(".map-resize");
  const k = await scaleOf(ada, ids.Short);
  await expect(corner).toHaveCSS("opacity", "0");
  const arc = () =>
    corner.evaluate((el) => {
      const a = getComputedStyle(el, "::after");
      return { w: a.width, h: a.height, right: a.borderRightWidth, bottom: a.borderBottomWidth, top: a.borderTopWidth, left: a.borderLeftWidth, radius: a.borderBottomRightRadius, color: a.borderRightColor };
    });
  expect(await arc()).toMatchObject({ w: "10px", h: "10px", right: "1px", bottom: "1px", top: "0px", left: "0px", radius: "5px" });

  await hover(ada, ids.Short, { fy: 0.4 });
  await expect(corner).toHaveCSS("opacity", "1");
  const idle = (await arc()).color;
  // the same generous square to grab, reaching just past the card's corner
  const [cb, card] = [(await corner.boundingBox())!, (await s.locator(".frame-card").first().boundingBox())!];
  near(cb.width, 22 * k, 1);
  near(cb.height, 22 * k, 1);
  expect(cb.x + cb.width).toBeGreaterThan(card.x + card.width);
  expect(cb.y + cb.height).toBeGreaterThan(card.y + card.height);
  await ada.screenshot({ path: `${SHOTS}/08_resize-gleam-night.png`, clip: { x: card.x + card.width - 90, y: card.y + card.height - 70, width: 120, height: 100 } });

  // under the pointer it turns blue; grabbed 8 px in from the corner, it resizes the card
  await ada.mouse.move(card.x + card.width - 8 * k, card.y + card.height - 8 * k, { steps: 4 });
  await settle(ada, 200);
  const held = (await arc()).color;
  expect(held).not.toBe(idle);
  const pulse = await ada.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--color-pulse)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(held).toBe(pulse);
  const w0 = card.width;
  await ada.mouse.down();
  await ada.mouse.move(card.x + card.width + 60, card.y + card.height + 40, { steps: 6 });
  await ada.mouse.up();
  await settle(ada, 500);
  expect((await s.locator(".frame-card").first().boundingBox())!.width).toBeGreaterThan(w0 + 30);
  await leave(ada);
  await expect(corner).toHaveCSS("opacity", "0");
});

test("day and night: the board's cards and #/design", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const tone = scheme === "light" ? "day" : "night";
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    await c.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
    const p = await c.newPage();
    await p.goto(`/?board=${board}`);
    await waitLive(p);
    await frame(p, ids.Long);
    await hover(p, ids.Long);
    await p.keyboard.down("Alt");
    await p.mouse.wheel(0, 200);
    await p.keyboard.up("Alt");
    await settle(p, 500);
    await p.screenshot({ path: `${SHOTS}/10_note-hovered-${tone}.png` });
    const card = (await slot(p, ids.Long).locator(".frame-card").first().boundingBox())!;
    await p.screenshot({ path: `${SHOTS}/11_corner-and-scroll-line-${tone}.png`, clip: { x: card.x + card.width - 150, y: card.y + card.height - 150, width: 180, height: 180 } });
    const kumo = await find(p, "Kumo");
    if (kumo) {
      await frame(p, kumo);
      await hover(p, kumo);
      await slot(p, kumo).locator(".frame-header .is-remove").click();
      await expect(slot(p, kumo).locator(".frame-confirm")).toBeVisible();
      await settle(p, 400);
      await p.screenshot({ path: `${SHOTS}/12_remove-asks-${tone}.png` });
      await p.keyboard.press("Escape");
    }

    await p.goto("/#/design");
    const demo = p.locator("[data-card-chrome]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator(".frame-anchor")).toHaveCount(4);
    // the specimens wear the real classes: the held one has made room, the resting one hasn't
    const tops = await demo.locator(".note-inner").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().y - el.closest(".frame-card")!.getBoundingClientRect().y)));
    expect(tops).toEqual([1, 1, PUSH + 1]);
    await settle(p, 500);
    await demo.screenshot({ path: `${SHOTS}/20_design-${tone}.png` });
    // the live one: the pointer on it
    const live = demo.locator(".frame-anchor").first();
    await live.hover();
    await settle(p, 600);
    expect(await live.locator(".note-inner").evaluate((el) => Math.round(el.getBoundingClientRect().y - el.closest(".frame-card")!.getBoundingClientRect().y))).toBe(PUSH + 1);
    await expect(live.locator(".map-resize")).toHaveCSS("opacity", "1");
    await demo.screenshot({ path: `${SHOTS}/21_design-live-hovered-${tone}.png` });
    await c.close();

    // close up (3×): the corner with the pointer on the card, then under the pointer; and the scroll line
    const z = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 3 });
    await z.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const q = await z.newPage();
    await q.goto("/#/design");
    const one = q.locator("[data-card-chrome] .frame-anchor").first();
    await one.scrollIntoViewIfNeeded();
    await one.hover();
    await settle(q, 600);
    const cb = (await one.locator(".frame-card").boundingBox())!;
    const corner = { x: cb.x + cb.width - 56, y: cb.y + cb.height - 56, width: 72, height: 72 };
    await q.screenshot({ path: `${SHOTS}/22_corner-close-up-${tone}.png`, clip: corner });
    await q.mouse.move(cb.x + cb.width - 6, cb.y + cb.height - 6, { steps: 3 });
    await settle(q, 300);
    await q.screenshot({ path: `${SHOTS}/23_corner-under-the-pointer-${tone}.png`, clip: corner });
    await q.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await settle(q, 300);
    await q.screenshot({ path: `${SHOTS}/24_scroll-line-close-up-${tone}.png`, clip: { x: cb.x + cb.width - 56, y: cb.y + 30, width: 72, height: 110 } });
    await z.close();
  }
});

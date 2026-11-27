/**
 * The timeline, live (2026-11-26, Josh: "None of the actions that I took, making notes, creating tables, putting in
 * tables, moving objects around … were captured by the timeline"). In a real browser against the real server, with
 * the grid's band open the whole time and never reopened:
 *
 *  - a person writes in a note, fills a table's cell and drags the note by its bar: each is on the band within a
 *    few seconds, credited to that person (the server nudges the window; it reads the timeline again);
 *  - the band, scrubbed to just after the drag, draws the note where it was dragged to, and just before, where it was.
 *
 * Also the primitives' chrome: a note being written is one box (its bar flush on its top edge, its toolbar flush on
 * its foot, one ring), and a chat card's field is its foot under a hairline with nothing under it.
 *
 * Evidence: docs/evidence/2026-11-26_timeline-live/.
 */

import { test, expect, type Page } from "@playwright/test";
import { CLIENT, frame, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-26_timeline-live";

type Ev = { kind: string; at: number; object?: string; actor: { kind: string; name: string } };
const events = (p: Page) =>
  p.evaluate(() => ((window as unknown as { __timeline: { get(k: string): { slice: { events: Ev[] } | null } | null } }).__timeline.get("grid")?.slice?.events ?? []).map((e) => ({ kind: e.kind, at: e.at, object: e.object, actor: e.actor })));
const state = (p: Page) => p.evaluate(() => (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string }>; notes: Record<string, { id: string; x: number; y: number }> } } }).__foundation.getState());

test("what a person does with the band open is on it within seconds, and plays back where it happened", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Live ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const p = await context.newPage();
  await p.goto(`/?board=${board}`);
  await waitLive(p);
  const sec = Object.values((await state(p)).sections)[0].id;
  const tool = async (name: string, data: object) => {
    const r = await context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
    expect(r.ok(), await r.text()).toBe(true);
    return ((await r.json()) as { result: { id: string } }).result;
  };
  const note = (await tool("add_note", { title: "Brief", markdown: "The first line" })).id;
  const table = (await tool("add_table", { name: "Parts", columns: ["Part", "Qty"], rows: [["bolt", "4"]] })).id;
  await frame(p, "section", sec);

  // the band, opened once
  await p.keyboard.press("h");
  await expect(p.locator('[data-tl-track="grid"]')).toBeVisible({ timeout: 15_000 });
  const mine = async (kind: string, object: string) => (await events(p)).filter((e) => e.kind === kind && e.object === object && e.actor.kind === "person" && e.actor.name === "Ada Test");

  // 1. she writes in the note
  const words = p.locator(`.obj-slot[data-obj-id="${note}"] .note-rendered`);
  await words.click();
  await p.keyboard.press("End");
  await p.keyboard.type(" and a second thought");
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const tEdit = Date.now();
  // the tool's add and its first words are one step (the add); her typing, after, is the edit
  await expect.poll(async () => (await mine("card.edit", note)).length, { timeout: 8000 }).toBe(1);
  console.log(`a note's edit on the open band after ${Date.now() - tEdit} ms`);

  // 2. she fills a cell of the table
  // the second row's quantity (row 0 is the header row the tool wrote)
  const cell = p.locator(`.obj-slot[data-obj-id="${table}"] .cell`).nth(3);
  await cell.dblclick();
  await p.keyboard.type("6");
  await p.keyboard.press("Enter");
  await expect.poll(async () => (await mine("card.edit", table)).length, { timeout: 8000 }).toBe(1);

  // 3. she drags the note by its bar, 160 px right
  const slot = p.locator(`.obj-slot[data-obj-id="${note}"]`);
  const before = (await state(p)).notes[note];
  const card = (await slot.locator(".frame-card").boundingBox())!;
  await p.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 4 });
  await settle(p, 400);
  const bar = (await slot.locator(".frame-header .frame-title").boundingBox())!;
  await p.mouse.move(bar.x + 4, bar.y + bar.height / 2);
  await p.mouse.down();
  await p.mouse.move(bar.x + 84, bar.y + bar.height / 2, { steps: 6 });
  await p.mouse.move(bar.x + 164, bar.y + bar.height / 2, { steps: 6 });
  await p.mouse.up();
  await expect.poll(async () => (await state(p)).notes[note].x, { timeout: 5000 }).not.toBe(before.x);
  const after = (await state(p)).notes[note];
  await expect.poll(async () => (await mine("card.place", note)).length, { timeout: 8000 }).toBe(1);
  await settle(p, 600);
  await p.locator("[data-tl-band]").screenshot({ path: `${SHOTS}/01_band-with-edit-cell-and-drag-night.png` });

  // the band, scrubbed: before the drag the note is where it was, after it where it went
  const placed = (await mine("card.place", note))[0].at;
  const track = p.locator('[data-tl-track="grid"]');
  const at = async (t: number) => {
    const [from, to] = [Number(await track.getAttribute("data-tl-from")), Number(await track.getAttribute("data-tl-to"))];
    const box = (await track.boundingBox())!;
    const x = box.x + ((t - from) / (to - from)) * box.width;
    await p.mouse.move(x - 10, box.y + box.height / 2);
    await p.mouse.down();
    await p.mouse.move(x, box.y + box.height / 2, { steps: 3 });
    await p.mouse.up();
  };
  const pastX = () => p.locator(`[data-tl-past="${sec}"] [data-rp-card="Brief"]`).evaluate((el) => (el as HTMLElement).getBoundingClientRect().x);
  await at(placed + 300);
  await expect(p.locator(`[data-tl-past="${sec}"] [data-rp-card="Brief"]`)).toHaveCount(1, { timeout: 8000 });
  const xAfter = await pastX();
  const tBefore = (await mine("card.edit", table))[0].at + 50;
  await at(tBefore);
  const head = () => p.evaluate(() => (window as unknown as { __timeline: { get(k: string): { head: { t: number | null } } | null } }).__timeline.get("grid")?.head.t ?? null);
  expect(await head()).toBeLessThan(placed);
  await expect.poll(pastX, { timeout: 8000 }).toBeLessThan(xAfter - 40);
  expect(after.x - before.x).toBeGreaterThan(40);
  await p.keyboard.press("Escape");
  await context.close();
});

test("a note being written is one box: its bar on its top edge, its toolbar on its foot, one ring; right-click formats", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
    const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Box ${scheme} ${Date.now().toString(36)}` } });
    const board = ((await made.json()) as { id: string }).id;
    const r = await context.request.post(`${CLIENT}/api/boards/${board}/tools/add_note`, { data: { title: "Brief", markdown: "# Rim drive\n\nThe first pass at the hub.\n\n- wall 2 mm\n- PETG" } });
    const note = ((await r.json()) as { result: { id: string } }).result.id;
    const p = await context.newPage();
    await p.goto(`/?board=${board}`);
    await waitLive(p);
    await frame(p, "section", Object.values((await state(p)).sections)[0].id);
    const slot = p.locator(`.obj-slot[data-obj-id="${note}"]`);
    const words = slot.locator(".note-rendered");
    const firstLine = async () => (await words.locator("h1").boundingBox())!.y;
    const y0 = await firstLine();
    await words.locator("p").click();
    const cardBox = (await slot.locator(".frame-card").boundingBox())!;
    const head = slot.locator(".frame-header");
    const tools = slot.locator(".rich-bar");
    await expect(tools).toBeVisible();
    await settle(p, 500);
    const hb = (await head.boundingBox())!;
    const tb = (await tools.boundingBox())!;
    // flush: the bar's foot on the card's top edge, the toolbar's top on its foot, all three one width
    expect(Math.abs(hb.y + hb.height - (cardBox.y + 1))).toBeLessThan(2.5);
    expect(Math.abs(tb.y - (cardBox.y + cardBox.height - 1))).toBeLessThan(2.5);
    expect(Math.abs(hb.width - cardBox.width)).toBeLessThan(2.5);
    expect(Math.abs(tb.width - cardBox.width)).toBeLessThan(2.5);
    // the words held still
    expect(Math.abs((await firstLine()) - y0)).toBeLessThan(0.5);
    // one ring: the words draw none of their own
    expect(await words.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    await p.screenshot({ path: `${SHOTS}/02_note-one-box-writing-${scheme === "dark" ? "night" : "day"}.png`, clip: { x: hb.x - 24, y: hb.y - 24, width: hb.width + 48, height: tb.y + tb.height - hb.y + 48 } });

    // right-click on a selected word: Italic from the menu
    await words.locator("p").dblclick({ position: { x: 30, y: 8 } });
    const sel = await p.evaluate(() => String(getSelection()));
    await words.locator("p").click({ button: "right", position: { x: 30, y: 8 } });
    const menu = p.locator("[role=menu]").last();
    await expect(menu).toContainText("Format the selection");
    await expect(menu).toContainText("Remove this note");
    await p.screenshot({ path: `${SHOTS}/03_note-right-click-${scheme === "dark" ? "night" : "day"}.png` });
    await menu.getByText(/^Italic/).click();
    await expect.poll(async () => p.evaluate((id) => (window as unknown as { __foundation: { getState(): { notes: Record<string, { text: string }> } } }).__foundation.getState().notes[id].text, note)).toContain(`_${sel.trim()}_`);
    await context.close();
  }
});

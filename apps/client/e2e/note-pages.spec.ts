/**
 * Note pages (2026-11-26, docs/notes.md): a note of its own, in the side menu's Notes, full size there, and the
 * same note on a grid as a card. In real browsers against the real server:
 *
 *  - Kai has the page open full size; Ada has it on her grid as a card. What Ada writes in the card (a to-do,
 *    made with the slash menu) is on Kai's page within seconds, and what Kai writes on the page (a heading by its
 *    markdown shortcut, a callout) is in Ada's card: one text, two places. Kai ticks the to-do on the page and
 *    it's ticked in the card.
 *  - The page is kept as readable markdown (`- [x]`, `## `, `> [!NOTE]`).
 *  - A block moved by its handle moves in the markdown.
 *  - A grid's own note becomes a page from its card's menu: the card stays and shows it, the words unchanged.
 *
 * Screenshots, day and night: docs/evidence/2026-11-26_note-pages/.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { CLIENT, frame, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-26_note-pages";

async function signIn(browser: import("@playwright/test").Browser, name: string, email: string, scheme: "dark" | "light" = "dark"): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  expect(res.ok()).toBe(true);
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: true, tabs: [], tab: null, search: false, spacesView: "notes" })));
  await context.addInitScript(() => localStorage.getItem("foundation-wheel") ?? localStorage.setItem("foundation-wheel", "pan"));
  return context;
}

const pageWords = (p: Page) => p.locator(".note-page .note-rendered");
const markdownOf = async (ctx: BrowserContext, page: string) => {
  const r = await ctx.request.post(`${CLIENT}/api/boards/${page}/tools/read_card`, { data: { id: "body" } });
  return ((await r.json()) as { result: { markdown: string } }).result.markdown;
};

test("one note in two places: written on the grid and on its page, live, kept as markdown", async ({ browser }) => {
  const ada = await signIn(browser, "Ada Notes", "ada-notes@normal.dev");
  const kai = await signIn(browser, "Kai Notes", "kai-notes@normal.dev");
  const stamp = Date.now().toString(36);
  const grid = ((await (await ada.request.post(`${CLIENT}/api/boards`, { data: { name: `Notes grid ${stamp}` } })).json()) as { id: string }).id;
  const made = await ada.request.post(`${CLIENT}/api/boards`, { data: { kind: "note", name: `Rotor notes ${stamp}` } });
  expect(made.ok(), await made.text()).toBe(true);
  const note = ((await made.json()) as { id: string }).id;

  // Ada: the grid, with the page on it as a card
  const a = await ada.newPage();
  await a.goto(`/?board=${grid}`);
  await waitLive(a);
  const placed = await ada.request.post(`${CLIENT}/api/boards/${grid}/tools/place_note`, { data: { note, request_id: `e2e-${stamp}` } });
  expect(placed.ok(), await placed.text()).toBe(true);
  const card = ((await placed.json()) as { result: { id: string; section: string } }).result;
  await frame(a, "section", card.section);
  const cardWords = a.locator(`.obj-slot[data-obj-id="${card.id}"] .note-rendered`);
  await expect(cardWords).toBeVisible({ timeout: 15_000 });

  // Kai: the page full size, listed in Notes
  const k = await kai.newPage();
  await k.goto(`/?board=${note}`);
  await expect(pageWords(k)).toBeVisible({ timeout: 20_000 });
  await expect(k.locator(`.side-pane [data-space-kind="note"][data-space-drop="${note}"]`)).toBeVisible();
  await expect(k.locator(".note-page-title")).toHaveValue(`Rotor notes ${stamp}`);

  // 1. Ada writes a to-do in the card, by the slash menu
  await cardWords.click();
  await a.keyboard.type("/todo");
  await expect(a.locator(".note-slash")).toBeVisible();
  await expect(a.locator(".note-slash-item").first()).toHaveAttribute("data-block", "todo");
  await a.screenshot({ path: `${SHOTS}/slash-menu-in-card-night.png` });
  await a.keyboard.press("Enter");
  await a.keyboard.type("Balance the rotor");
  await expect(pageWords(k).locator("li.md-todo")).toHaveText("Balance the rotor", { timeout: 8000 });

  // 2. Kai writes on the page: a heading by its shortcut, then a callout by the slash menu
  await pageWords(k).click();
  await k.keyboard.press("Control+End");
  await k.keyboard.press("Enter");
  await k.keyboard.press("Enter");
  await k.keyboard.type("## Specs");
  await k.keyboard.press("Enter");
  await k.keyboard.type("/warn");
  await k.keyboard.press("Enter");
  await k.keyboard.type("Hot when it runs");
  await expect(cardWords.locator("h2")).toHaveText("Specs", { timeout: 8000 });
  await expect(cardWords.locator('.md-callout[data-kind="warning"]')).toHaveText("Hot when it runs", { timeout: 8000 });

  // 3. Kai ticks the to-do on the page (its box, in the item's gutter); it's ticked in Ada's card
  const todo = pageWords(k).locator("li.md-todo");
  const box = (await todo.boundingBox())!;
  await k.mouse.click(box.x + 8, box.y + box.height / 2);
  await expect(cardWords.locator("li.md-todo")).toHaveAttribute("data-checked", "true", { timeout: 8000 });

  await k.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(k, 800);
  const md = await markdownOf(kai, note);
  expect(md).toContain("- [x] Balance the rotor");
  expect(md).toContain("## Specs");
  expect(md).toContain("> [!WARNING] Hot when it runs");
  console.log(`the page's markdown:\n${md}`);

  await k.screenshot({ path: `${SHOTS}/page-night.png` });
  await a.screenshot({ path: `${SHOTS}/grid-card-night.png` });

  // 4. the heading moved by its handle above the to-do: the markdown has it first
  const head = pageWords(k).locator("h2");
  await head.hover();
  const handle = k.locator(".note-page .note-block-handle");
  await expect(handle).toBeVisible();
  const from = (await handle.boundingBox())!;
  const to = (await pageWords(k).locator("ul.md-todos").boundingBox())!;
  await k.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await k.mouse.down();
  await k.mouse.move(from.x + 4, to.y + 6, { steps: 6 });
  await k.mouse.move(from.x + 4, to.y + 2, { steps: 2 });
  await k.mouse.up();
  await expect.poll(async () => (await markdownOf(kai, note)).indexOf("## Specs") < (await markdownOf(kai, note)).indexOf("Balance the rotor"), { timeout: 8000 }).toBe(true);
  await expect(cardWords.locator(":scope > *").first()).toHaveText("Specs", { timeout: 8000 });

  // 5. the same page in the day
  const day = await signIn(browser, "Kai Notes", "kai-notes@normal.dev", "light");
  const d = await day.newPage();
  await d.goto(`/?board=${note}`);
  await expect(pageWords(d).locator("h2")).toHaveText("Specs", { timeout: 20_000 });
  await settle(d, 1600);
  await d.screenshot({ path: `${SHOTS}/page-day.png` });
  await day.close();
  await ada.close();
  await kai.close();
});

test("a grid's own note becomes a page from its card's menu: the card stays, showing it, the words unchanged", async ({ browser }) => {
  const ada = await signIn(browser, "Ada Notes", "ada-notes@normal.dev");
  const stamp = Date.now().toString(36);
  const grid = ((await (await ada.request.post(`${CLIENT}/api/boards`, { data: { name: `Make page ${stamp}` } })).json()) as { id: string }).id;
  const a = await ada.newPage();
  await a.goto(`/?board=${grid}`);
  await waitLive(a);
  const words = "**Kept** as written\n\n- one\n- two";
  const r = await ada.request.post(`${CLIENT}/api/boards/${grid}/tools/add_note`, { data: { title: `Old note ${stamp}`, markdown: words } });
  const id = ((await r.json()) as { result: { id: string } }).result.id;
  const sec = await a.evaluate((nid) => (window as unknown as { __foundation: { getState(): { notes: Record<string, { sectionId: string }> } } }).__foundation.getState().notes[nid]?.sectionId, id);
  await frame(a, "section", sec);
  const slot = a.locator(`.obj-slot[data-obj-id="${id}"]`);
  await expect(slot.locator(".note-rendered strong")).toHaveText("Kept");
  await slot.locator(".note-rendered").click({ button: "right" });
  await a.locator(".context-menu .menu-item", { hasText: "Make it a page" }).click();
  await expect.poll(() => a.evaluate((nid) => (window as unknown as { __foundation: { getState(): { notes: Record<string, { ref?: string }> } } }).__foundation.getState().notes[nid]?.ref ?? null, id), { timeout: 8000 }).not.toBeNull();
  const page = await a.evaluate((nid) => (window as unknown as { __foundation: { getState(): { notes: Record<string, { ref?: string }> } } }).__foundation.getState().notes[nid]!.ref!, id);
  expect(await markdownOf(ada, page)).toBe(words);
  await expect(slot.locator(".note-rendered strong")).toHaveText("Kept", { timeout: 8000 });
  await expect(a.locator(`.side-pane [data-space-drop="${page}"]`)).toBeVisible({ timeout: 8000 });
  await ada.close();
});

test("every grid's notes are in Notes under their grid and section; one opens full size, its path back to the grid, the same note as its card", async ({ browser }) => {
  const ada = await signIn(browser, "Ada Notes", "ada-notes@normal.dev");
  const stamp = Date.now().toString(36);
  const gridName = `Listed ${stamp}`;
  const grid = ((await (await ada.request.post(`${CLIENT}/api/boards`, { data: { name: gridName } })).json()) as { id: string }).id;
  await ada.request.post(`${CLIENT}/api/boards/${grid}/tools/add_section`, { data: { name: "Motors" } });
  const r = await ada.request.post(`${CLIENT}/api/boards/${grid}/tools/add_note`, { data: { title: `Torque ${stamp}`, section: "Motors", markdown: "**12 Nm** at the hub" } });
  const id = ((await r.json()) as { result: { id: string } }).result.id;
  const a = await ada.newPage();
  await a.goto(`/?board=${grid}`);
  await waitLive(a);
  // listed under the grid (open, it's the open grid), under its section
  const node = a.locator(`.side-pane [data-notes-grid="${grid}"]`);
  await expect(node).toBeVisible({ timeout: 10_000 });
  await expect(node.locator(".grid-note-where", { hasText: "Motors" })).toBeVisible();
  const row = node.locator(`[data-grid-note-row="${id}"]`);
  await expect(row).toHaveText(`¶Torque ${stamp}`);
  // open full size: its path is the grid, then the section
  await row.locator("button").click();
  const full = a.locator(`.note-page.is-grid-note[data-grid-note="${id}"]`);
  await expect(full).toBeVisible();
  await expect(full.locator(".note-page-crumb").first()).toHaveText(gridName);
  await expect(full.locator(".note-page-crumb").nth(1)).toHaveText("Motors");
  // the same note: written here, it's in the card
  await full.locator(".note-rendered").click();
  await a.keyboard.press("Control+End");
  await a.keyboard.type(" and checked");
  await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => a.evaluate((nid) => (window as unknown as { __foundation: { getState(): { notes: Record<string, { text: string }> } } }).__foundation.getState().notes[nid]?.text, id), { timeout: 8000 }).toContain("and checked");
  await a.screenshot({ path: `${SHOTS}/grid-note-full-night.png` });
  // back to the grid by its path
  await full.locator(".note-page-crumb").first().click();
  await expect(full).toBeHidden();
  await expect(a.locator(`.obj-slot[data-obj-id="${id}"] .note-rendered`)).toContainText("and checked");
  await ada.close();
});

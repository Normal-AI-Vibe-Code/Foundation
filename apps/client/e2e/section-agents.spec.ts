/**
 * The agents of a section, in the section, and the text box (2026-11-13),
 * checked by two people in their own browsers. The agents run on the
 * server's script runtime (the real board tools, no model).
 *
 * - every section carries the agents chip and the way into its own grid, at rest;
 * - the right-click menu leads with asking an agent, and adds a text box, a
 *   markdown note and the agents card;
 * - a text box is written as formatted text (a title, bold, a list, an
 *   underline: toolbar and keys) and kept as the note's markdown; Kai sees it
 *   formatted, writes in it too, and both keep their words;
 * - the chip opens the section's agents in its corner; an ask from there
 *   brings an agent into that section (the chip counts it, for Kai too), the
 *   panel lists it, and afterwards what agents made there;
 * - Keep here puts the same view on the board as a card, for Kai too;
 * - the section opens as its own grid from the mark at rest;
 * - #/design, day and night.
 */

import { test, expect, type Page } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-15_one-interface/section-agents";
let ada: Page;
let kai: Page;
let board = "";
let section = { id: "", name: "" };

test.describe.configure({ mode: "serial" });

type Store = { getState(): { sections: Record<string, { id: string; name: string }>; notes: Record<string, { id: string; text: string; rich?: boolean }>; panels: Record<string, { panel: string; sectionId: string }> }; setState(p: object): void };
const store = (p: Page) => p.evaluateHandle(() => (window as unknown as { __foundation: Store }).__foundation);
const richText = (p: Page) =>
  p.evaluate(() => {
    const st = (window as unknown as { __foundation: Store }).__foundation.getState();
    return Object.values(st.notes).find((n) => n.rich)?.text ?? null;
  });

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await a.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Agents in sections ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  ada = a.page;
  await ada.goto(`/?board=${board}`);
  kai = (await person(browser, "Kai Test", "kai@normal.dev", board)).page;
  for (const p of [ada, kai]) await p.waitForFunction(() => (window as unknown as { __foundationBoard: () => { status: string } }).__foundationBoard()?.status === "live");
  await settle(ada, 800);
  void store;
  section = await ada.evaluate(() => {
    const s = Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections)[0];
    return { id: s.id, name: s.name };
  });
});

test("a section at rest wears its council's mark and says it opens as a grid; the menu leads with the council", async () => {
  const sections = await ada.locator(".section-card[data-section-id]").count();
  expect(sections).toBeGreaterThan(0);
  await expect(ada.locator(".section-card[data-section-id] .sec-agents-chip")).toHaveCount(sections);
  await expect(ada.locator(".section-card[data-section-id] .sec-rest-open")).toHaveCount(sections);
  await expect(ada.locator(`.section-card[data-section-id="${section.id}"] .sec-agents-chip`)).toHaveText(/Council/);
  // no card wears an agent button of its own: agents are the section's
  await expect(ada.locator(".frame-header .icon-btn.is-agent")).toHaveCount(0);

  const box = (await ada.locator(`.section-card[data-section-id="${section.id}"]`).boundingBox())!;
  await ada.mouse.click(box.x + 40, box.y + 90, { button: "right" });
  const menu = ada.locator(".context-menu");
  await expect(menu).toBeVisible();
  const labels = (await menu.locator(".menu-item").allInnerTexts()).map((t) => t.replace(/^\S+\s+/, "").trim());
  expect(labels[0]).toBe("Council: ask this section's agents…");
  for (const want of ["Text box", "Markdown note", "Table", "Map", "App or web page…", "Agents card", "Huddle", "Machine", "Open as its own grid"]) expect(labels).toContain(want);
  await expect(menu.locator(".menu-item.is-agent")).toHaveCount(2);
  // it fits the window, whatever its length
  const m = (await menu.boundingBox())!;
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.y + m.height).toBeLessThanOrEqual(900);
  await ada.screenshot({ path: `${SHOTS}/00_menu.png` });
  await menu.locator(".menu-item", { hasText: "Text box" }).click();
});

test("a text box is written as formatted text and kept as the note's markdown; two people write in it", async () => {
  const text = ada.locator(".rich-text");
  await expect(text).toBeFocused();
  await expect(ada.locator(".rich-bar")).toBeVisible();
  await ada.keyboard.type("Launch plan");
  await ada.locator(".rich-style").selectOption("h1");
  await expect(text.locator("h1")).toHaveText("Launch plan");
  await expect(text).toBeFocused();
  await ada.keyboard.press("Control+End");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("Ship the ");
  await ada.keyboard.press("Control+b");
  await ada.keyboard.type("desktop app");
  await ada.keyboard.press("Control+b");
  await ada.keyboard.type(" this week");
  await ada.keyboard.press("Enter");
  await ada.locator('.rich-btn[aria-label="Bulleted list"]').click();
  await ada.keyboard.type("Sign the build");
  await ada.keyboard.press("Enter");
  // ⌘U is underline here, not the upload dialog; ⌘I italic, not the space's pane
  await ada.keyboard.press("Control+u");
  await ada.keyboard.type("Tell everyone");
  await ada.keyboard.press("Control+u");
  await ada.keyboard.press("Control+i");
  await ada.keyboard.type(" soon");
  await ada.keyboard.press("Control+i");
  await expect.poll(() => richText(ada)).toBe("# Launch plan\n\nShip the **desktop app** this week\n\n- Sign the build\n- <u>Tell everyone</u> _soon_");
  await expect(ada.locator('.rich-btn[aria-label="Bulleted list"]')).toHaveAttribute("aria-pressed", "true");
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/01_text-box-writing.png` });

  // Kai sees it formatted, with no toolbar of his own until he writes
  const his = kai.locator(".rich-text");
  await expect(his.locator("h1")).toHaveText("Launch plan");
  await expect(his.locator("strong")).toHaveText("desktop app");
  await expect(his.locator("u")).toHaveText("Tell everyone");
  await expect(his.locator("li")).toHaveCount(2);
  await expect(kai.locator(".rich-bar")).toHaveCount(0);

  // he writes in the title while Ada's caret is in the list; she keeps typing, and both keep their words
  await his.locator("h1").click();
  await kai.keyboard.press("End");
  await kai.keyboard.type(" for 0.4");
  await expect.poll(() => richText(ada)).toContain("# Launch plan for 0.4");
  await expect(text).toBeFocused();
  await ada.keyboard.type("er");
  await expect.poll(() => richText(kai)).toBe("# Launch plan for 0.4\n\nShip the **desktop app** this week\n\n- Sign the build\n- <u>Tell everyone</u> _sooner_");
  await expect(text.locator("h1")).toHaveText("Launch plan for 0.4");

  // Esc puts the toolbar away; at rest it reads as it was written
  await ada.keyboard.press("Escape");
  await expect(ada.locator(".rich-bar")).toHaveCount(0);
  await kai.keyboard.press("Escape");
  await expect(text.locator("em")).toHaveText("sooner");
  await settle(kai, 400);
  await kai.screenshot({ path: `${SHOTS}/02_kai-text-box-at-rest.png` });
});

test("the chip brings the section's council up on its top edge; a line to all from there brings an agent in, for everyone", async () => {
  const chip = (p: Page) => p.locator(`.section-card[data-section-id="${section.id}"] .sec-agents-chip`);
  // the tools take the corner under the pointer, so the mark at rest is pressed from elsewhere
  await ada.mouse.move(700, 880);
  await settle(ada, 400);
  await chip(ada).dispatchEvent("click");
  const council = ada.locator(".council-place.is-section .council");
  await expect(council).toBeVisible();
  await expect(council).toHaveAttribute("aria-label", `Council of ${section.name}`);
  await expect(council).toHaveAttribute("data-council", "0");
  // it stands inside the window, over the section, under the top bar
  await settle(ada, 700);
  const card = ada.locator(`.section-card[data-section-id="${section.id}"]`);
  const sec = (await card.boundingBox())!;
  const band = (await card.locator(".council-place.is-section").boundingBox())!;
  const head = (await card.locator(".section-header").boundingBox())!;
  // on the section's top edge, over what's above it; the header stays where it was
  expect(Math.abs(band.x - sec.x)).toBeLessThan(3);
  expect(Math.abs(band.y + band.height - sec.y)).toBeLessThan(3);
  expect(head.y - sec.y).toBeLessThan(6);
  await ada.screenshot({ path: `${SHOTS}/03_council-nobody-here.png` });

await council.locator("[data-council-all]").click();
  await council.locator(".council-tools-say .council-say-text").fill("make a table of the parts, and get help");
  await council.locator(".council-tools-say .council-say-text").press("Enter");
  await expect(chip(ada)).toHaveClass(/is-working/, { timeout: 20_000 });
  await expect(chip(ada)).toContainText("at work");
  await expect(chip(kai)).toHaveClass(/is-working/, { timeout: 20_000 });
  await expect(council.locator(".council-seat:not(.council-ghost)").first()).toBeVisible();
  await ada.screenshot({ path: `${SHOTS}/04_council-agent-at-work.png` });

  // when the work is done the chip rests; what the agent made is on the section, in its name
  await expect(chip(ada)).not.toHaveClass(/is-working/, { timeout: 60_000 });
  const made = await ada.evaluate((sid) => {
    const st = (window as unknown as { __foundation: Store & { getState(): { tables: Record<string, { sectionId: string; createdBy?: string }> } } }).__foundation.getState() as unknown as { tables: Record<string, { sectionId: string; createdBy?: string }> };
    return Object.values(st.tables).filter((t) => t.sectionId === sid && t.createdBy).length;
  }, section.id);
  expect(made).toBeGreaterThan(0);
  await expect(ada.locator("[data-agent-pill]").first()).toBeVisible();
  await ada.keyboard.press("Escape");
  await expect(council).toHaveCount(0);
  await settle(ada, 2600);
  await ada.screenshot({ path: `${SHOTS}/05_made-here.png` });
});

test("the menu's Agents card puts the section's agents on the grid as a card, for everyone; the section opens as its own grid", async () => {
  const addCard = async () => {
    const box = (await ada.locator(`.section-card[data-section-id="${section.id}"]`).boundingBox())!;
    // on the section's own paper, clear of its cards and inside the window
    // in the section's own margin, left of its cards (a press on a card opens the card's menu instead)
    await ada.mouse.click(box.x + 8, Math.min(box.y + box.height / 2, 600), { button: "right" });
    // the menu redraws while the board settles after the agent's work: press the item where it stands
    await ada.locator(".context-menu .menu-item", { hasText: "Agents card" }).first().dispatchEvent("click");
  };
  await addCard();
  await expect(ada.locator(".panel-card.kind-crew")).toHaveCount(1);
  await expect(kai.locator(".panel-card.kind-crew")).toHaveCount(1);
  await expect(kai.locator(".kind-crew .sa-card-head")).toContainText(section.name);
  await expect(kai.locator(".kind-crew .t3-ask-text")).toBeVisible();
  // a second card isn't made
  await addCard();
  await expect(ada.locator(".panel-card.kind-crew")).toHaveCount(1);
  await settle(kai, 1500);
  await kai.screenshot({ path: `${SHOTS}/06_kai-agents-card.png` });

  // the mark at rest makes the section a grid of its own (2026-11-17): it asks first, in place, and Cancel
  // changes nothing (the making itself is e2e/sub-grid.spec.ts)
  const open = ada.locator(`.section-card[data-section-id="${section.id}"] .sec-rest-open`);
  await expect(open).toHaveAttribute("aria-label", "Open as its own grid");
  await open.dispatchEvent("click");
  const ask = ada.locator(`.section-card[data-section-id="${section.id}"] .confirm-pop.grid-ask`);
  await expect(ask).toContainText(`Make ${section.name} its own grid?`);
  await expect(ada.locator(".section-card.is-open")).toHaveCount(0);
  await settle(ada, 1200);
  await ada.screenshot({ path: `${SHOTS}/07_open-as-its-own-grid.png` });
  await ask.getByRole("button", { name: "Cancel" }).dispatchEvent("click");
  await expect(ask).toHaveCount(0);
});

test("agents in the section and the text box on #/design, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const when = scheme === "dark" ? "night" : "day";
    const agents = p.locator(".sec-agents-demo");
    await agents.scrollIntoViewIfNeeded();
    await settle(p, 900);
    await agents.screenshot({ path: `${SHOTS}/08_design-agents-${when}.png` });
    const box = p.locator(".text-box-demo");
    await box.scrollIntoViewIfNeeded();
    await settle(p, 500);
    await box.screenshot({ path: `${SHOTS}/09_design-text-box-${when}.png` });
    await ctx.close();
  }
});

/**
 * The agents of a section, in the section, and the note (2026-11-13; one
 * note since 2026-11-24: the text box and the markdown note are the same card),
 * checked by two people in their own browsers. The agents run on the
 * server's script runtime (the real board tools, no model).
 *
 * - every section carries the agents chip and the way into its own grid, at rest;
 * - the right-click menu leads with asking an agent, and adds a note
 *   and the agents card;
 * - a note is written as formatted text (a title, bold, a list, an
 *   underline: toolbar and keys) and kept as the note's markdown; Kai sees it
 *   formatted, writes in it too, and both keep their words;
 * - its text size (the toolbar), its background (the bar) and its markdown
 *   (the bar: the same text, written as source), and a note written by hand
 *   in markdown is not rewritten by being clicked in;
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
/** the one note (2026-11-24): its text size, its background, its markdown */
const NOTE_SHOTS = "../../docs/evidence/2026-11-24_one-note";
let ada: Page;
let kai: Page;
let board = "";
let section = { id: "", name: "" };

test.describe.configure({ mode: "serial" });

type Store = { getState(): { sections: Record<string, { id: string; name: string }>; notes: Record<string, { id: string; name: string; text: string; size?: string; bare?: boolean }>; panels: Record<string, { panel: string; sectionId: string }> }; setState(p: object): void };
const store = (p: Page) => p.evaluateHandle(() => (window as unknown as { __foundation: Store }).__foundation);
const richText = (p: Page) =>
  p.evaluate(() => {
    const st = (window as unknown as { __foundation: Store }).__foundation.getState();
    return Object.values(st.notes).find((n) => /^Note \d+$/.test(n.name))?.text ?? null;
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
  for (const want of ["Note", "Table", "Map", "App or web page…", "Agents card", "Huddle", "Machine"]) expect(labels).toContain(want);
  // the grid's own actions are a row of icons now (2026-11-17), each named on roll-over
  await expect(menu.locator('.menu-iconrow button[aria-label="Open as its own grid"]')).toHaveAttribute("data-tip", "Open as its own grid");
  await expect(menu.locator(".menu-item.is-agent")).toHaveCount(2);
  // it fits the window, whatever its length
  const m = (await menu.boundingBox())!;
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.y + m.height).toBeLessThanOrEqual(900);
  await ada.screenshot({ path: `${SHOTS}/00_menu.png` });
  expect(labels, "one note, not two kinds of it").not.toContain("Markdown note");
  expect(labels).not.toContain("Text box");
  await menu.locator(".menu-item", { hasText: /Note$/ }).click();
});

test("a note is written as formatted text and kept as markdown; two people write in it", async () => {
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

test("one note: its text size, its background and its markdown, for both people; markdown written by hand isn't rewritten by a click", async () => {
  const card = ada.locator(".note-card");
  const text = ada.locator(".note-card .rich-text");
  const his = kai.locator(".note-card .rich-text");
  const WRITTEN = "# Launch plan for 0.4\n\nShip the **desktop app** this week\n\n- Sign the build\n- <u>Tell everyone</u> _sooner_";
  const card0 = (p: Page) =>
    p.evaluate(() => {
      const n = Object.values((window as unknown as { __foundation: Store }).__foundation.getState().notes).find((x) => /^Note \d+$/.test(x.name))!;
      return { id: n.id, size: n.size ?? null, bare: n.bare ?? null };
    });
  const px = (l: typeof text) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const away = (p: Page) => p.mouse.move(8, 892);

  // ---- text size: the toolbar's two As, a step at a time, the whole note's; the caret stays in the text
  await text.locator("h1").click();
  const larger = ada.locator('.rich-btn[aria-label="Larger text"]');
  const smaller = ada.locator('.rich-btn[aria-label="Smaller text"]');
  const base = await px(text);
  await larger.click();
  await larger.click();
  await expect.poll(() => card0(ada).then((c) => c.size)).toBe("xl");
  expect(await px(text)).toBeCloseTo(base * 2, 1);
  await expect(text).toBeFocused();
  await expect.poll(() => kai.locator(".note-card .note-inner").getAttribute("data-size"), { message: "Kai sees it large" }).toBe("xl");
  expect(await px(his)).toBeCloseTo(base * 2, 1);
  // it stops at the largest, and a size is the card's: the markdown is as it was
  await larger.click();
  await expect(larger).toBeDisabled();
  await smaller.click();
  await expect.poll(() => card0(ada).then((c) => c.size)).toBe("xl");
  expect(await richText(ada)).toBe(WRITTEN);
  await ada.keyboard.press("Escape");

  // ---- background: the sheet button in the card's bar takes the paper away, for Kai too
  await card.hover();
  const bare = ada.locator(".note-card .note-bare-btn");
  await expect(bare).toHaveAttribute("aria-pressed", "false");
  await bare.click();
  await expect(bare).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => card0(kai).then((c) => c.bare)).toBe(true);
  await away(kai);
  await expect(kai.locator(".note-card")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // no paper, so no paper's shadow: chosen (Kai wrote in it), it wears the ring alone
  await expect(kai.locator(".note-card")).toHaveCSS("box-shadow", /0px 0px 0px 2\.5px$/);
  await expect(his.locator("h1")).toHaveText("Launch plan for 0.4");
  await settle(kai, 500);
  await kai.screenshot({ path: `${NOTE_SHOTS}/01_large-no-background-night.png` });
  expect(await richText(ada), "nor does the background touch the words").toBe(WRITTEN);

  // ---- markdown: the Markdown button turns the card to its markdown, the same shared text
  await card.hover();
  const md = ada.locator(".note-card .note-md-btn");
  await md.click();
  const cm = ada.locator(".note-card .cm-content");
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await expect(md).toHaveAttribute("aria-pressed", "true");
  await expect(text).toHaveCount(0);
  await expect(cm).toContainText("# Launch plan for 0.4");
  await expect(cm).toContainText("<u>Tell everyone</u> _sooner_");
  await ada.keyboard.press("Control+End");
  await ada.keyboard.type("\n- **Post** it");
  await expect.poll(() => richText(kai)).toBe(`${WRITTEN}\n- **Post** it`);
  // Kai is reading the formatted text: what she writes as markdown arrives formatted
  await expect(his.locator("li")).toHaveCount(3);
  await expect(his.locator("li strong")).toHaveText("Post");
  await settle(ada, 400);
  await ada.screenshot({ path: `${NOTE_SHOTS}/02_as-markdown-night.png` });
  // the markdown stays up when the caret leaves it; Esc (or the button) goes back to the formatted text
  await card.locator(".frame-title").click();
  await expect(cm).toBeVisible();
  await cm.click();
  await ada.keyboard.press("Escape");
  await expect(cm).toHaveCount(0);
  await expect(text.locator("li")).toHaveCount(3);
  await expect(md).toHaveAttribute("aria-pressed", "false");

  // ---- paper back, the usual size: nothing is left on the card
  await card.hover();
  await bare.click();
  await text.locator("h1").click();
  await smaller.click();
  await smaller.click();
  await expect.poll(() => card0(ada)).toMatchObject({ size: null, bare: null });
  await ada.keyboard.press("Escape");
  await away(ada);
  await settle(ada, 500);
  await ada.screenshot({ path: `${NOTE_SHOTS}/03_formatted-at-rest-night.png` });

  // ---- a note an agent wrote by hand: read as formatted text, and a click in it and out again writes nothing
  const HAND = "*By hand*, with a star.\n\n* one\n* two\n\n1) first\n2) second";
  const made = await ada.context().request.post(`${CLIENT}/api/boards/${board}/tools/add_note`, { data: { section: section.name, title: "By hand", markdown: HAND } });
  expect(made.ok(), await made.text()).toBe(true);
  const idByName = () => ada.evaluate(() => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().notes).find((x) => x.name === "By hand")?.id ?? "");
  await expect.poll(idByName).not.toBe("");
  const handId = await idByName();
  const textOf = (p: Page) => p.evaluate((id) => (window as unknown as { __foundation: Store }).__foundation.getState().notes[id]?.text ?? null, handId);
  await expect.poll(() => textOf(ada)).toBe(HAND);
  await ada.evaluate((id) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } }), handId);
  await settle(ada, 1200);
  const byHand = ada.locator(`[data-obj-id="${handId}"] .rich-text`);
  await expect(byHand.locator("em")).toHaveText("By hand");
  await expect(byHand.locator("li")).toHaveCount(4);
  await byHand.locator("em").click();
  await expect(byHand).toBeFocused();
  await ada.keyboard.press("Escape");
  await settle(ada, 300);
  expect(await textOf(ada), "looked at, not rewritten").toBe(HAND);
  // a drag across its words selects them: the words don't move when the press puts the caret in
  await ada.locator(`[data-obj-id="${handId}"] .frame-card`).hover();
  await settle(ada, 500);
  const line = (await byHand.locator("p").first().boundingBox())!;
  const before = await byHand.locator("p").first().evaluate((el) => el.getBoundingClientRect().y);
  await ada.mouse.move(line.x + 2, line.y + line.height / 2);
  await ada.mouse.down();
  await ada.mouse.move(line.x + line.width * 0.6, line.y + line.height / 2, { steps: 8 });
  await ada.mouse.up();
  const picked = await ada.evaluate(() => getSelection()?.toString() ?? "");
  expect(picked.length, `a drag selects words (“${picked}”)`).toBeGreaterThan(3);
  expect("By hand, with a star.").toContain(picked.trim());
  expect(Math.abs((await byHand.locator("p").first().evaluate((el) => el.getBoundingClientRect().y)) - before), "the line stays where it was pressed").toBeLessThan(1);
  await ada.keyboard.press("Escape");
  await settle(ada, 300);
  expect(await textOf(ada), "selected, not rewritten").toBe(HAND);
  // written in, it is kept as the note's markdown from then on
  await byHand.locator("em").click();
  await ada.keyboard.press("Control+End");
  await ada.keyboard.type("!");
  await expect.poll(() => textOf(kai)).toBe("_By hand_, with a star.\n\n- one\n- two\n\n1. first\n2. second!");
  await ada.keyboard.press("Escape");
  // back where the next check expects to be: on the first note
  const first = (await card0(ada)).id;
  await ada.evaluate((id) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } }), first);
  await settle(ada, 1200);
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

test("agents in the section and the note on #/design, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    // a refused sign-in (dev sign-in is refused while T3, the built-in terminal or a job has a shell here) says so
    const signedIn = await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    expect(signedIn.ok(), `dev sign-in: ${signedIn.status()} ${await signedIn.text()}`).toBe(true);
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const when = scheme === "dark" ? "night" : "day";
    const agents = p.locator(".sec-agents-demo");
    await agents.scrollIntoViewIfNeeded();
    await settle(p, 900);
    await agents.screenshot({ path: `${SHOTS}/08_design-agents-${when}.png` });
    const box = p.locator(".note-demo");
    await box.scrollIntoViewIfNeeded();
    await settle(p, 500);
    await box.screenshot({ path: `${NOTE_SHOTS}/09_design-note-${when}.png` });
    await ctx.close();
  }
});

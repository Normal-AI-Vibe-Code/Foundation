/**
 * The council and the Character studio, in a real browser (2026-11-14).
 * Meshy is a stand-in (e2e/meshy-standin.mjs: real PNGs and a real skinned
 * GLB with a clip per mood, nothing charged); the agents run the server's
 * script runtime (the real board tools, no model).
 *
 * - ⌘K opens the Character studio: one board, a column per set.
 * - A character goes through its stages on its card, a press at a time, each
 *   button saying its cost first; when the clips land it's "on the council"
 *   and the card plays it live, a mood at a time.
 * - A press with an agent's bearer is refused: spending needs a person.
 * - A mesh avatar's stages are sheet, portrait and a .mavatar brought in.
 * - With nobody at work the council is the bench: the characters there are.
 * - An agent at work sits in the council under its own name, on its cursor's
 *   colour, wearing a character; it's drawn live (one canvas for every seat),
 *   stands head to toe when pressed, and can be given another character.
 * - A section's council holds only the agents in that section (⌘K).
 * - #/design, day and night.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-14_council-characters";
const MESHY = `http://127.0.0.1:${process.env.E2E_MESHY_PORT ?? "4445"}`;
let ada: Page;
let ctx: BrowserContext;
let studio = "";
let work = "";

test.describe.configure({ mode: "serial" });

type Store = { getState(): { sections: Record<string, { id: string; name: string }>; allSections: Record<string, { id: string; name: string }>; panels: Record<string, { id: string; panel: string; name: string; sectionId: string }> }; setState(p: object): void };
const boardId = (p: Page) => p.evaluate(() => (window as unknown as { __foundationBoard: () => { boardId: string } }).__foundationBoard().boardId);
const frame = (p: Page, name: string) =>
  p.evaluate((n) => {
    const f = (window as unknown as { __foundation: Store }).__foundation;
    const card = Object.values(f.getState().panels).find((x) => x.panel === "character" && x.name === n);
    if (card) f.setState({ snapRequest: { kind: "object", id: card.id, nonce: Math.random() } });
    return card?.id ?? null;
  }, name);
const card = (p: Page, name: string) => p.locator(`[data-character-card="${name}"]`);
const stage = (p: Page, name: string, s: string) => card(p, name).locator(`[data-char-stage="${s}"]`);
/** frames the stage has drawn so far (it counts them on its canvas) */
const frames = (p: Page, sel: string) => p.locator(sel).first().evaluate((c) => Number((c as HTMLElement).dataset.frames ?? 0));

async function press(p: Page, name: string, s: string, words: RegExp) {
  const row = stage(p, name, s);
  const button = row.locator("button.f-pill");
  await expect(button).toHaveText(words);
  await button.click();
  await expect(row).toHaveAttribute("data-char-state", "done", { timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
});

test("⌘K opens the Character studio: one board, inspiration and characters, a column per set", async () => {
  await ada.keyboard.press("Control+k");
  await ada.keyboard.type("Character studio");
  await ada.locator(".cmd-row", { hasText: "Open the Character studio" }).first().click();
  await expect.poll(() => boardId(ada), { timeout: 15_000 }).toMatch(/^character-studio/);
  await waitLive(ada);
  studio = await boardId(ada);
  const names = await ada.evaluate(() => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections).map((s) => s.name).sort());
  expect(names).toEqual(["Characters · Abstract", "Characters · Animals", "Characters · Anime", "Inspiration · Abstract", "Inspiration · Animals", "Inspiration · Anime"]);
  // opening it again opens the same one
  const again = await ctx.request.post(`${CLIENT}/api/characters/studio`);
  expect(await again.json()).toEqual({ id: studio, made: false });
});

test("a 3D character, a press at a time: each button says its cost, the card shows what came back, and the last stage puts it on the council", async () => {
  // two pictures of inspiration, and a character drawn from one of them
  const picture = await (await ctx.request.get(`${MESHY}/_png`)).body();
  const up = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/inspiration?set=Animals&name=shiba.png`, { headers: { "content-type": "image/png" }, data: picture });
  expect(up.ok(), await up.text()).toBe(true);
  const ref = ((await up.json()) as { file: string }).file;
  const made = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name: "Mochi", set: "animals", form: "model", identity: "A cheerful shiba in a teal scarf.", refs: [ref], height: 0.7 } });
  expect(made.ok(), await made.text()).toBe(true);

  await expect.poll(() => frame(ada, "Mochi")).not.toBeNull();
  await settle(ada, 1600);
  const c = card(ada, "Mochi");
  await expect(c).toBeVisible();
  await expect(c.locator(".char-pick.is-on")).toHaveCount(1); // drawn from the picture it was given
  await expect(c.locator(".char-foot")).toContainText("credits left");
  // only the next stage can be pressed; the ones after it wait
  await expect(stage(ada, "Mochi", "views").locator("button")).toHaveCount(0);
  await ada.screenshot({ path: `${SHOTS}/10_card-new.png` });

  await press(ada, "Mochi", "sheet", /Draw the sheet · 9/);
  await expect(c.locator('[data-char-file="front"] img')).toBeVisible();
  await press(ada, "Mochi", "views", /Draw the back and side · 18/);
  await expect(c.locator('[data-char-file="back"] img')).toBeVisible();
  await expect(c.locator('[data-char-file="side"] img')).toBeVisible();
  await press(ada, "Mochi", "model", /Make the model · 30/);
  await press(ada, "Mochi", "rig", /Fit the skeleton · 5/);
  await expect(c).not.toHaveAttribute("data-character-ready", "true");
  await press(ada, "Mochi", "clips", /Animate the moods · 24/);
  await expect(c).toHaveAttribute("data-character-ready", "true");
  await expect(c.locator(".char-tag.is-ready")).toHaveText("on the council");

  // what the stand-in was asked for, in order: the pipeline's five stages
  const sent = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: Array<{ endpoint: string; request: Record<string, unknown> }> }).sent;
  expect(sent.map((s) => s.endpoint)).toEqual(["image-to-image", "image-to-image", "image-to-image", "multi-image-to-3d", "rigging", "animations"]);
  expect(String(sent[0].request.prompt)).toMatch(/^Front view\. A cheerful shiba in a teal s/); // the stand-in keeps the first 40 characters
  expect((sent[5].request.action_ids as number[]).length).toBe(8);

  // the card plays it: a live model, its clip changing with the mood
  const live = c.locator(".avatar-3d");
  await expect(live).toHaveClass(/is-live/, { timeout: 15_000 });
  const before = await frames(ada, `[data-character-card="Mochi"] canvas.avatar-canvas`);
  await c.locator(".char-mood", { hasText: /^happy$/ }).click();
  await expect(live).toHaveAttribute("data-mood", "happy");
  await expect.poll(() => frames(ada, `[data-character-card="Mochi"] canvas.avatar-canvas`)).toBeGreaterThan(before + 10);
  await settle(ada, 500);
  await ada.screenshot({ path: `${SHOTS}/11_card-ready-happy.png` });
});

test("a press with an agent's bearer is refused: spending credits needs a person at a browser", async () => {
  const id = await frame(ada, "Mochi");
  const token = ((await (await ctx.request.post(`${CLIENT}/api/agent/token`)).json()) as { token: string }).token;
  const sentBefore = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: unknown[] }).sent.length;
  const res = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/stages/sheet`, { headers: { authorization: `Bearer ${token}` }, data: {} });
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: string }).error).toMatch(/needs a person/);
  const sentAfter = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: unknown[] }).sent.length;
  expect(sentAfter).toBe(sentBefore);
});

test("with nobody at work, the council is the bench: the characters there are, live, and one waves when pointed at", async () => {
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
  await expect(council).toHaveAttribute("data-council-bench", "true");
  const seat = council.locator('[data-council-seat="Mochi"]');
  await expect(seat.locator(".avatar-3d")).toHaveClass(/is-live/, { timeout: 15_000 });
  await seat.locator(".council-figure").hover();
  await expect(seat).toHaveAttribute("data-mood", "waving");
  const n = await frames(ada, ".council-stage");
  await expect.poll(() => frames(ada, ".council-stage")).toBeGreaterThan(n + 10);
  await ada.screenshot({ path: `${SHOTS}/12_bench.png` });
  await ada.keyboard.press("Escape");
  await expect(council).toHaveCount(0);
});

test("an agent at work sits in the council on its cursor's colour, wearing a character; pressed, it stands head to toe", async () => {
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Council ${Date.now().toString(36)}` } });
  work = ((await made.json()) as { id: string }).id;
  await ada.goto(`/?board=${work}`);
  await waitLive(ada);
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
  await expect(council).toHaveAttribute("data-council-bench", "true");
  // ask from the council itself
  await council.locator(".council-ask-text").fill("make a section called “Supply” with the parts");
  await council.locator(".council-ask button").click();

  const seat = council.locator(".council-seat:not(.is-spare)").first();
  await expect(seat).toBeVisible({ timeout: 10_000 });
  await expect(council).not.toHaveAttribute("data-council-bench", "true");
  const name = (await seat.getAttribute("data-council-seat"))!;
  // it arrives with a wave, then gets on with it
  await expect(seat).toHaveAttribute("data-mood", "waving");
  // the seat stands on the colour its cursor has
  const cursor = ada.locator(".crew-cursor", { hasText: name }).first();
  await expect(cursor).toBeVisible({ timeout: 10_000 });
  const colours = await ada.evaluate((n) => {
    const seat = document.querySelector<HTMLElement>(`[data-council-seat="${n}"]`)!;
    const cur = [...document.querySelectorAll<HTMLElement>(".crew-cursor")].find((c) => c.textContent?.includes(n))!;
    const read = (el: HTMLElement) => getComputedStyle(el).getPropertyValue("--crew").trim();
    return { seat: read(seat), cursor: read(cur), dot: getComputedStyle(seat.querySelector(".council-dot")!).backgroundColor, arrow: getComputedStyle(cur).getPropertyValue("--crew").trim() };
  }, name);
  expect(colours.seat).not.toBe("");
  expect(colours.seat).toBe(colours.cursor);
  // it wears the character, live, and says what its cursor says
  await expect(seat.locator(".council-name")).toContainText("as Mochi");
  await expect(seat.locator(".avatar-3d")).toHaveClass(/is-live/, { timeout: 15_000 });
  await expect(seat.locator(".council-says")).not.toBeEmpty();
  await expect.poll(async () => seat.getAttribute("data-mood"), { timeout: 10_000 }).toMatch(/thinking|working/);
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/13_council-agent-at-work.png` });

  // pressed, it stands: head to toe, with what it was asked and who it's for
  await seat.locator(".council-figure").click();
  await expect(seat).toHaveClass(/is-up/);
  await expect(seat.locator(".avatar-3d")).toHaveAttribute("data-framing", "full");
  const up = council.locator(".council-card");
  await expect(up).toContainText("Supply");
  await expect(up).toContainText("for Ada");
  await expect(up.locator(".council-wear-pick.is-on")).toHaveCount(1);
  await settle(ada, 700);
  await ada.screenshot({ path: `${SHOTS}/14_council-seat-standing.png` });

  // done: it cheers, then rests; the council goes back to the bench once it has left
  await expect.poll(async () => (await council.locator(".council-seat:not(.is-spare)").count()) === 0 || (await seat.getAttribute("data-mood")) === "happy", { timeout: 40_000 }).toBe(true);
  await expect(council).toHaveAttribute("data-council-bench", "true", { timeout: 20_000 });
});

test("a section's council holds only the agents in that section; the board's holds them all", async () => {
  await ada.keyboard.press("Escape");
  const sectionNamed = (n: string) => ada.evaluate((name) => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections).find((s) => s.name === name)?.id ?? null, n);
  const councilOf = async (id: string, name: string) => {
    await ada.evaluate((sid) => (window as unknown as { __foundation: Store }).__foundation.setState({ activeSectionId: sid }), id);
    await ada.keyboard.press("Control+k");
    // the bar keeps what was last typed: write over it
    await ada.locator(".cmd-field input").fill("Council: the agents in");
    await ada.locator(".cmd-row", { hasText: `Council: the agents in ${name}` }).first().click();
    await expect(ada.locator(".council-title")).toContainText(name);
  };
  const supply = (await sectionNamed("Supply"))!;
  expect(supply).not.toBeNull();
  // a second ask: an agent builds another section, and is at work there for a while
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
  await council.locator(".council-ask-text").fill("make a section called “Depot” with the parts, hook up FactoryForm, and get help");
  await council.locator(".council-ask button").click();
  await expect.poll(() => sectionNamed("Depot"), { timeout: 20_000 }).not.toBeNull();
  const depot = (await sectionNamed("Depot"))!;
  await expect(council.locator(".council-seat:not(.is-spare)").first()).toBeVisible({ timeout: 10_000 });

  // Supply's council: nobody is at work there, so it's the bench
  await councilOf(supply, "Supply");
  await expect(council).toHaveAttribute("data-council-bench", "true");
  // Depot's council: the agent building it
  await councilOf(depot, "Depot");
  await expect(council.locator(".council-seat:not(.is-spare)").first()).toBeVisible({ timeout: 10_000 });
  await expect(council).not.toHaveAttribute("data-council-bench", "true");
  await ada.screenshot({ path: `${SHOTS}/16_council-of-a-section.png` });
  await ada.keyboard.press("Escape");
  await expect(council).toHaveCount(0);
});

test("#/design shows the council, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-design-council]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator(".council-seat")).toHaveCount(4);
    await expect(demo.locator(".council-seat.is-up")).toHaveCount(1);
    await settle(p, 900);
    await demo.screenshot({ path: `${SHOTS}/15_design-${scheme === "light" ? "day" : "night"}.png` });
    await c.close();
  }
});

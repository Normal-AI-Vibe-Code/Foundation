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
 * - A mesh avatar's stages are sheet, expressions, portrait and a .mavatar brought in.
 * - With nobody at work the council is the bench: the characters there are.
 * - An agent at work sits in the council under its own name, on its cursor's
 *   colour, wearing a character; it's drawn live (one canvas for every seat),
 *   stands head to toe when pressed, and can be given another character.
 * - A section's council holds only the agents in that section (⌘K).
 * - #/design, day and night.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-15_one-interface/council";
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

test("⌘K opens the Character studio: one board, inspiration, the pipeline and characters, a column per set", async () => {
  await ada.keyboard.press("Control+k");
  await ada.keyboard.type("Character studio");
  await ada.locator(".cmd-row", { hasText: "Open the Character studio" }).first().click();
  await expect.poll(() => boardId(ada), { timeout: 15_000 }).toMatch(/^character-studio/);
  await waitLive(ada);
  studio = await boardId(ada);
  const names = await ada.evaluate(() => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections).map((s) => s.name).sort());
  expect(names).toEqual(["Characters · Abstract", "Characters · Animals", "Characters · Anime", "Foundation avatars", "Inspiration · Abstract", "Inspiration · Animals", "Inspiration · Anime", "Pipeline · Abstract", "Pipeline · Animals", "Pipeline · Anime"]);
  // between a set's inspiration and its characters, the flow: a node card per stage and a way to start one there
  // (e2e/character-studio.spec.ts walks it)
  await expect(ada.locator('[data-pipe-node][data-pipe-set="animals"]')).toHaveCount(9);
  await expect(ada.locator('[data-pipe-node="output"][data-pipe-set="animals"]')).toContainText("0 approved");
  await expect(ada.locator('[data-pipe-node="sheet"][data-pipe-set="animals"] [data-pipe-new]')).toHaveCount(1);
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

  // the stand-in is one for every check on this server: count from what it had been asked before these presses
  const asked = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: unknown[] }).sent.length;
  await press(ada, "Mochi", "sheet", /Draw the sheet · 9/);
  await expect(c.locator('[data-char-file="front"] img')).toBeVisible();
  // the expressions sheet is its own press, and the views wait for it
  await expect(stage(ada, "Mochi", "views").locator("button")).toHaveCount(0);
  await press(ada, "Mochi", "expressions", /Draw the expressions · 9/);
  await expect(c.locator('[data-char-file="expressions"] img')).toBeVisible();
  await press(ada, "Mochi", "views", /Draw the back and side · 18/);
  await expect(c.locator('[data-char-file="back"] img')).toBeVisible();
  await expect(c.locator('[data-char-file="side"] img')).toBeVisible();
  await press(ada, "Mochi", "model", /Make the model · 30/);
  await press(ada, "Mochi", "rig", /Fit the skeleton · 5/);
  await expect(c).not.toHaveAttribute("data-character-ready", "true");
  await press(ada, "Mochi", "clips", /Animate the moods · 24/);
  await expect(c).toHaveAttribute("data-character-ready", "true");
  // finished, and waiting on a person's word before anyone can wear it
  await expect(c.locator(".char-tag.is-pending")).toHaveText("waiting for approval");

  // what the stand-in was asked for, in order: the pipeline's six stages (the sheet, the expressions, two views, …)
  const sent = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: Array<{ endpoint: string; request: Record<string, unknown> }> }).sent.slice(asked);
  expect(sent.map((s) => s.endpoint)).toEqual(["image-to-image", "image-to-image", "image-to-image", "image-to-image", "multi-image-to-3d", "rigging", "animations"]);
  expect(String(sent[0].request.prompt)).toMatch(/^Front view\. A cheerful shiba in a teal s/); // the stand-in keeps the first 40 characters
  expect(String(sent[1].request.prompt)).toMatch(/^Expression and pose sheet/);
  expect((sent[6].request.action_ids as number[]).length).toBe(8);

  // the card plays it: a live model, its clip changing with the mood. The sheet is longer than its card now
  // and the last press was at its foot: back up to the stage, the pointer on it (the card under the pointer plays)
  await c.locator(".char-view").hover();
  const live = c.locator(".avatar-3d");
  await expect(live).toHaveClass(/is-live/, { timeout: 15_000 });
  const before = await frames(ada, `[data-character-card="Mochi"] canvas.avatar-canvas`);
  await c.locator(".char-mood", { hasText: /^happy$/ }).click();
  await expect(live).toHaveAttribute("data-mood", "happy");
  await expect.poll(() => frames(ada, `[data-character-card="Mochi"] canvas.avatar-canvas`)).toBeGreaterThan(before + 10);
  await settle(ada, 500);
  await ada.screenshot({ path: `${SHOTS}/11_card-ready-happy.png` });
});

test("a finished character waits for a person's approval; approved, it's one an agent can wear", async () => {
  const mochi = card(ada, "Mochi");
  await expect(mochi.locator("[data-char-approval]")).toHaveAttribute("data-char-approval", "pending");
  const before = ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ name: string; approval?: string }> }).characters.find((c) => c.name === "Mochi")!;
  expect(before.approval).toBe("pending");
  await mochi.locator("[data-char-approval] .f-pill.is-accent").dispatchEvent("click");
  await expect(mochi.locator("[data-char-approval]")).toHaveAttribute("data-char-approval", "approved");
  await expect(mochi.locator(".char-tag.is-ready")).toHaveText("on the council");
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

test("the grid's council stands on the window's bottom edge, no panel; with nobody assigned it is silhouettes to fill; an agent added stands at rest, live, with its marks", async () => {
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
  await expect(council).toHaveAttribute("data-council", "0");
  // nobody yet: three places to fill, drawn as silhouettes; and nothing to type into
  await expect(council.locator(".council-ghost")).toHaveCount(3);
  await expect(council.locator("input")).toHaveCount(0);
  // it stands on the window's bottom edge, as wide as the open paper; the grid isn't pushed anywhere
  await settle(ada, 700);
  const bar = (await ada.locator(".council-place.is-board").boundingBox())!;
  const paper = await ada.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".side-pane");
    return { left: pane ? pane.getBoundingClientRect().right : 0, right: window.innerWidth };
  });
  expect(Math.abs(bar.y + bar.height - (await ada.evaluate(() => window.innerHeight)))).toBeLessThan(2);
  expect(await ada.evaluate(() => getComputedStyle(document.querySelector(".council-place")!).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(Math.abs(bar.x - paper.left)).toBeLessThan(2);
  expect(Math.abs(bar.x + bar.width - paper.right)).toBeLessThan(2);
  const insetTop = await ada.evaluate(() => Number(getComputedStyle(document.querySelector(".world-mask")!).getPropertyValue("--floor-t").replace("px", "")));
  expect(insetTop).toBe(44);

  // a silhouette opens the agents panel on Add an agent: who (already listed: nothing to look for), connect, avatar, add
  await council.locator("[data-council-add]").first().click();
  const add = ada.locator("[data-add-agent]");
  await expect(add.locator('[data-add-kind="claude"]')).toContainText("ready");
  await expect(add.locator('[data-add-step="2"]')).toHaveAttribute("data-add-state", "wait");
  await add.locator('[data-add-kind="claude"]').click();
  // Claude has three ways to be connected; the one that already is, is the one open
  await expect(add.locator("[data-add-way]")).toHaveCount(3);
  await expect(add.locator('[data-add-way="own"]')).toHaveAttribute("data-add-way-ready", "yes");
  await expect(add.locator('[data-add-way="own"]')).toHaveClass(/is-on/);
  await expect(add.locator('[data-add-connect="ready"]')).toContainText("in the cloud");
  // another way lays out its steps: the key's page, this computer's agents, the key
  await add.locator('[data-add-way="key"] .add-way-head').click();
  await expect(add.locator('[data-add-way="key"] [data-way-step]')).toHaveCount(3);
  await expect(add.locator("[data-add-key-page]")).toContainText("console.anthropic.com");
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/12c_ways-to-connect.png` });
  await add.locator('[data-add-way="own"] .add-way-head').click();
  // an avatar is chosen already (the approved character), so skipping the step still gives it a face
  await expect(add.locator(".add-avatar.is-on")).toHaveAttribute("data-add-avatar", "Mochi");
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/12a_adding-an-agent.png` });
  await add.locator("[data-add-submit]").click();
  await expect(ada.locator("[data-add-agent]")).toHaveCount(0);
  const seat = council.locator('[data-council-agent="claude"]');
  await expect(seat).toBeVisible();
  await expect(seat).toHaveClass(/is-idle/);
  await expect(council).toHaveAttribute("data-council", "1");
  // three places: one taken, two silhouettes (once all three are taken, one more silhouette to add another)
  await expect(council.locator(".council-ghost")).toHaveCount(2);
  // above its head: whose model, that it runs in the cloud, and that it's connected
  await expect(seat.locator('[data-council-where="cloud"]')).toBeVisible();
  await expect(seat.locator("[data-council-offline]")).toHaveCount(0);
  // rolled over, a white line over its body, above the bottom bar, with the mic and ✕ (2026-11-17)
  await seat.locator(".council-marks").hover();
  await expect(seat.locator("[data-council-say] input")).toBeVisible();
  await expect(seat.locator("[data-council-mic]")).toBeVisible();
  await expect(seat.locator("[data-council-say-close]")).toBeVisible();
  const line = (await seat.locator("[data-council-say]").boundingBox())!;
  const hudBox = (await ada.locator("[data-hud]").boundingBox())!;
  expect(line.y + line.height).toBeLessThan(hudBox.y);
  expect(await seat.locator("[data-council-say]").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  // ✕ puts it away until the pointer leaves
  await seat.locator("[data-council-say-close]").click();
  await expect(seat.locator("[data-council-say] input")).toBeHidden();
  await ada.mouse.move(10, 300);
  await seat.locator(".council-marks").hover();
  await expect(seat.locator("[data-council-say] input")).toBeVisible();
  // its own name over its head, beside its marks (a seat's name, not "Claude"); it wears a character, live, and a bead says whose model it is
  const seatName = (await seat.locator("[data-council-name]").innerText()).trim();
  expect(seatName).not.toBe("");
  expect(seatName).not.toBe("Claude");
  await expect(seat.locator(".avatar-3d")).toHaveClass(/is-live/, { timeout: 15_000 });
  await expect(seat.locator('.provider-mark[data-provider="claude"]')).toBeVisible();
  const n = await frames(ada, ".council-stage");
  await expect.poll(() => frames(ada, ".council-stage")).toBeGreaterThan(n + 10);
  await settle(ada, 400);
  await ada.screenshot({ path: `${SHOTS}/12_grid-council-claude-at-rest.png` });

  // the assignment is the grid's, kept by the server
  const posted = await ada.evaluate(() => {
    const b = (window as unknown as { __foundationBoard: () => { doc: { getMap(n: string): { toJSON(): Record<string, Array<{ key: string; byName: string }>> } } } }).__foundationBoard();
    return b.doc.getMap("agents").toJSON();
  });
  expect(posted["*"].map((a) => a.key)).toEqual(["claude"]);
  expect(posted["*"][0].byName).toBe("Ada Test");

  // pressed: the agent on the right, and the council keeps to the paper that's left
  await seat.locator(".council-figure").click({ position: { x: 52, y: 40 } });
  const info = ada.locator(".agent-info");
  await expect(info).toBeVisible();
  await expect(info.locator('[data-agent-where="cloud"]')).toContainText("In the cloud");
  await expect(info).toContainText("To the whole grid, by Ada Test");
  await expect(info.locator(".avatar-3d")).toHaveAttribute("data-framing", "full");
  await settle(ada, 500);
  const moved = (await ada.locator(".council-place.is-board").boundingBox())!;
  const infoBox = (await info.boundingBox())!;
  expect(Math.abs(moved.x + moved.width - infoBox.x)).toBeLessThan(2);
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/12b_agent-pane.png` });

  // taken off, the seat goes, for good
  await info.locator(".agent-info-off").click();
  await expect(council).toHaveAttribute("data-council", "0");
  await ada.keyboard.press("Escape");
  await expect(council).toHaveCount(0);
  await expect(info).toHaveCount(0);
});

test("an agent at work stands in the council on its cursor's colour, wearing a character; pressed, its pane shows it head to toe", async () => {
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Council ${Date.now().toString(36)}` } });
  work = ((await made.json()) as { id: string }).id;
  await ada.goto(`/?board=${work}`);
  await waitLive(ada);
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
  await expect(council).toHaveAttribute("data-council", "0");
  // a line to everyone, from the council's own buttons: with nobody assigned it goes to Claude
  await council.locator("[data-council-all]").click();
  await council.locator(".council-tools-say .council-say-text").fill("make a section called “Supply” with the parts");
  await council.locator(".council-tools-say .council-say-text").press("Enter");

  const seat = council.locator(".council-seat:not(.council-ghost)").first();
  await expect(seat).toBeVisible({ timeout: 10_000 });
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
    return { seat: read(seat), cursor: read(cur) };
  }, name);
  expect(colours.seat).not.toBe("");
  expect(colours.seat).toBe(colours.cursor);
  // under its cursor's name it says which agent it is; it wears the character, live, and says what its cursor says
  await expect(seat.locator("[data-council-name]")).toHaveText(name);
  await expect(seat).toHaveAttribute("data-council-agent", "claude");
  await expect(seat.locator(".avatar-3d")).toHaveClass(/is-live/, { timeout: 15_000 });
  await expect(seat.locator("[data-council-name]")).toHaveAttribute("data-tip", /.+/);
  await expect.poll(async () => seat.getAttribute("data-mood"), { timeout: 10_000 }).toMatch(/thinking|working/);
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/13_council-agent-at-work.png` });

  // pressed: its pane shows it head to toe, with what it was asked and who for
  await seat.locator(".council-figure").click({ position: { x: 52, y: 40 } });
  const info = ada.locator(".agent-info");
  await expect(info).toHaveAttribute("data-agent-info", name);
  await expect(info.locator(".avatar-3d")).toHaveAttribute("data-framing", "full");
  await expect(info).toContainText("Supply");
  await expect(info).toContainText("for Ada");
  await expect(info).toContainText("Not assigned: it's here for one ask");
  await settle(ada, 700);
  await ada.screenshot({ path: `${SHOTS}/14_council-seat-selected.png` });

  // done: it cheers, then leaves; the council is empty again
  await expect.poll(async () => (await council.locator(".council-seat:not(.council-ghost)").count()) === 0 || (await seat.getAttribute("data-mood")) === "happy", { timeout: 40_000 }).toBe(true);
  await expect(council).toHaveAttribute("data-council", "0", { timeout: 20_000 });
});

test("a section's council stands on top of its section and holds only that section's agents", async () => {
  await ada.keyboard.press("Escape");
  const sectionNamed = (n: string) => ada.evaluate((name) => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections).find((s) => s.name === name)?.id ?? null, n);
  const councilOf = async (id: string, name: string) => {
    await ada.evaluate((sid) => (window as unknown as { __foundation: Store }).__foundation.setState({ activeSectionId: sid }), id);
    await ada.keyboard.press("Control+k");
    // the bar keeps what was last typed: write over it
    await ada.locator(".cmd-field input").fill("Council: the agents in");
    await ada.locator(".cmd-row", { hasText: `Council: the agents in ${name}` }).first().click();
    await expect(ada.locator(".council")).toHaveAttribute("aria-label", `Council of ${name}`);
  };
  const supply = (await sectionNamed("Supply"))!;
  expect(supply).not.toBeNull();
  // a second ask: an agent builds another section, and is at work there for a while
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
await council.locator("[data-council-all]").click();
  await council.locator(".council-tools-say .council-say-text").fill("make a section called “Depot” with the parts, hook up FactoryForm, and get help");
  await council.locator(".council-tools-say .council-say-text").press("Enter");
  await expect.poll(() => sectionNamed("Depot"), { timeout: 20_000 }).not.toBeNull();
  const depot = (await sectionNamed("Depot"))!;
  await expect(council.locator(".council-seat:not(.council-ghost)").first()).toBeVisible({ timeout: 10_000 });

  // Supply's council: nobody belongs there and nobody is at work there
  await councilOf(supply, "Supply");
  await expect(ada.locator(".council-place.is-section")).toHaveCount(1);
  await expect(council).toHaveAttribute("data-council", "0");
  // it stands on its section's top edge, as wide as the section, over what's above; the section itself doesn't move
  const over = async (id: string) => {
    await settle(ada, 700);
    const card = ada.locator(`.section-card[data-section-id="${id}"]`);
    await expect(card.locator(".council-place.is-section")).toHaveCount(1);
    const sec = (await card.boundingBox())!;
    const band = (await card.locator(".council-place.is-section").boundingBox())!;
    const head = (await card.locator(".section-header").boundingBox())!;
    expect(Math.abs(band.x - sec.x)).toBeLessThan(3);
    expect(Math.abs(band.width - sec.width)).toBeLessThan(4);
    expect(Math.abs(band.y + band.height - sec.y)).toBeLessThan(3);
    expect(head.y - sec.y).toBeLessThan(6);
  };
  await over(supply);
  // Depot's council: the agent building it was asked from the grid's council, so it stays the grid's while it works
  // (2026-11-17: "every section has a different council"); Depot's has nobody of its own
  await councilOf(depot, "Depot");
  await expect(council).toHaveAttribute("data-council", "0");
  await over(depot);
  await ada.screenshot({ path: `${SHOTS}/16_council-of-a-section.png` });
  await ada.keyboard.press("Escape");
  await expect(council).toHaveCount(0);
});

test("#/design shows the council and the agent's pane, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-design-council]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator(".council-seat:not(.council-ghost)")).toHaveCount(4);
    await expect(demo.locator(".council-seat.is-hot")).toHaveCount(1);
    await expect(demo.locator("[data-council-offline]")).toHaveCount(1);
    await expect(demo.locator(".provider-mark")).not.toHaveCount(0);
    await expect(demo.locator(".council-ghost")).toHaveCount(1);
    await expect(demo.locator("[data-council-talk]")).toContainText("To all 4");
    await expect(demo.locator(".design-agent-info")).toContainText("ChatGPT");
    await settle(p, 900);
    await demo.screenshot({ path: `${SHOTS}/15_design-${scheme === "light" ? "day" : "night"}.png` });
    await c.close();
  }
});

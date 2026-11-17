/**
 * The Character studio's card and flow, in a real browser (2026-11-17). Meshy is the stand-in
 * (e2e/meshy-standin.mjs: a real PNG per image, an eight-panel grid for an expressions sheet; nothing is
 * charged anywhere).
 *
 * - A set's pipeline is nine node cards joined by the grid's own wires, in a band nothing overlaps.
 * - ＋ New on the Sheet node asks for a name, a line and its inspiration, and the character starts at Sheet.
 * - The card's "Who it is" is formatted text on the card: a plain click writes, bold is bold while writing,
 *   ⌘/Ctrl+Enter and leaving it save (a tick says so), the markdown is what's kept, and the prompt that
 *   goes to Meshy has the plain words. The name is a title you can write in.
 * - Generate on a node's tile runs that stage for that character, and the tile moves to the next node.
 * - The expressions stage: its own priced press, one wide picture drawn from the sheet, shown large on the
 *   card; the portrait is then drawn from the sheet and it.
 * - A finished character's card is put into Characters · <Set>, and a second beside it: none overlap.
 * - A character from before expression sheets is offered "Add expressions" and loses nothing by it.
 * - scripts/characters-expressions.mjs, run as the person against this server: lists and prices without
 *   pressing, presses with --press, skips what is done.
 * - #/design shows the card at 260, 400, 460 and 560 and the flow, day and night.
 */

import { execFileSync } from "node:child_process";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_character-studio";
const MESHY = `http://127.0.0.1:${process.env.E2E_MESHY_PORT ?? "4445"}`;
let ada: Page;
let ctx: BrowserContext;
let studio = "";

test.describe.configure({ mode: "serial" });

type Obj = { id: string; panel?: string; name: string; sectionId: string; node?: string; source?: string; float: boolean };
type Store = { getState(): { sections: Record<string, { id: string; name: string }>; panels: Record<string, Obj>; links: Record<string, { from: { panel: string }; to: { panel: string } }> }; setState(p: object): void };
const snap = (p: Page, target: { kind: "section" | "object"; id: string }) => p.evaluate((t) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { ...t, nonce: Math.random() } }), target);
const sectionId = (p: Page, name: string) => p.evaluate((n) => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections).find((s) => s.name === n)?.id ?? "", name);
const cardId = (p: Page, name: string) => p.evaluate((n) => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().panels).find((x) => x.panel === "character" && x.name === n)?.id ?? "", name);
/** the section a character's card is in */
const whereIs = (p: Page, name: string) =>
  p.evaluate((n) => {
    const st = (window as unknown as { __foundation: Store }).__foundation.getState();
    const c = Object.values(st.panels).find((x) => x.panel === "character" && x.name === n);
    return c ? (st.sections[c.sectionId]?.name ?? "") : "";
  }, name);
const node = (p: Page, key: string, set = "abstract") => p.locator(`[data-pipe-node="${key}"][data-pipe-set="${set}"]`);
const tile = (p: Page, key: string, name: string, set = "abstract") => node(p, key, set).locator(`[data-pipe-tile="${name}"]`);
const card = (p: Page, name: string) => p.locator(`[data-character-card="${name}"]`);
const sent = async () => ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: Array<{ endpoint: string; request: Record<string, unknown> }> }).sent;
const stageApi = async (id: string, stage: string) => {
  const res = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/stages/${stage}`, { data: {} });
  expect(res.ok(), await res.text()).toBe(true);
  await expect.poll(async () => ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ panelId: string; stages: Record<string, { state: string }> }> }).characters.find((c) => c.panelId === id)?.stages[stage]?.state, { timeout: 20_000 }).toBe("done");
};
const MAVATAR = { name: "avatar.mavatar", mimeType: "application/zip", buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("rig and layers")]) };

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
  const made = await ctx.request.post(`${CLIENT}/api/characters/studio`);
  studio = ((await made.json()) as { id: string }).id;
  await ada.goto(`/?board=${studio}`);
  await waitLive(ada);
  const picture = await (await ctx.request.get(`${MESHY}/_png`)).body();
  const up = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/inspiration?set=Abstract&name=shiba.png`, { headers: { "content-type": "image/png" }, data: picture });
  expect(up.ok(), await up.text()).toBe(true);
});

// council.spec.ts runs after this one on the same server and makes its own first approved character:
// leave none of ours approved (an archived character is kept, and offered to nobody)
test.afterAll(async () => {
  const id = await cardId(ada, "Kuro");
  if (id) await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/approval`, { data: { approval: "archived" } });
});

test("a set's pipeline is nine node cards joined by the grid's own wires, between its inspiration and its characters", async () => {
  const pipe = await sectionId(ada, "Pipeline · Abstract");
  expect(pipe).not.toBe("");
  await snap(ada, { kind: "section", id: pipe });
  await settle(ada, 1400);
  await expect(ada.locator('[data-pipe-node][data-pipe-set="abstract"]')).toHaveCount(9);
  for (const key of ["inspiration", "sheet", "expressions", "views", "mesh", "model", "rig", "clips", "output"]) await expect(node(ada, key)).toBeVisible();
  // each node says what it takes, what it makes and what a press costs
  await expect(node(ada, "sheet")).toContainText("Takes");
  await expect(node(ada, "sheet")).toContainText("Makes");
  await expect(node(ada, "sheet").locator(".pipe-kind")).toContainText("9 credits");
  await expect(node(ada, "views").locator(".pipe-kind")).toContainText("9 or 18 credits");
  await expect(node(ada, "expressions").locator(".pipe-kind")).toContainText("9 credits");
  await expect(node(ada, "inspiration")).toContainText("1 picture");
  await expect(node(ada, "output")).toContainText("0 approved");
  // the wires are the grid's own: a link per wire of the flow, each drawn as a routed path between two of the cards
  const wires = await ada.evaluate(() => {
    const st = (window as unknown as { __foundation: Store }).__foundation.getState();
    const mine = new Set(Object.values(st.panels).filter((x) => x.panel === "pipeline" && x.source === "abstract").map((x) => x.id));
    return Object.values(st.links).filter((l) => mine.has(l.from.panel) && mine.has(l.to.panel)).length;
  });
  expect(wires).toBe(9);
  await expect.poll(() => ada.locator(".port-layer g.pipe path[data-route]").evaluateAll((ps) => ps.filter((p) => (p.getAttribute("d") ?? "").length > 8).length)).toBeGreaterThanOrEqual(27);
  // the band: no node overlaps another, on screen
  const boxes = await ada.locator('[data-pipe-node][data-pipe-set="abstract"]').evaluateAll((els) => els.map((el) => {
    const r = (el.closest(".frame-card") ?? el).getBoundingClientRect();
    return { k: (el as HTMLElement).dataset.pipeNode!, l: r.left, t: r.top, r: r.right, b: r.bottom };
  }));
  for (const a of boxes) for (const b of boxes) if (a.k < b.k) expect(a.r <= b.l + 1 || b.r <= a.l + 1 || a.b <= b.t + 1 || b.b <= a.t + 1, `${a.k} × ${b.k}`).toBe(true);
  // the flow runs left to right, the 3D lane under the mesh avatar
  const at = Object.fromEntries(boxes.map((b) => [b.k, b]));
  expect(at.inspiration.l).toBeLessThan(at.sheet.l);
  expect(at.sheet.l).toBeLessThan(at.expressions.l);
  expect(at.expressions.l).toBeLessThan(at.views.l);
  expect(at.views.l).toBeLessThan(at.mesh.l);
  expect(at.model.t).toBeGreaterThan(at.mesh.b - 1);
  expect(at.clips.r).toBeLessThan(at.output.l);
  await ada.screenshot({ path: `${SHOTS}/01_flow-empty-night.png` });
});

test("＋ New on the Sheet node: a name, a line of who it is, its inspiration; the character starts at Sheet, its card under the nodes", async () => {
  await node(ada, "sheet").locator("[data-pipe-new]").click();
  const form = node(ada, "sheet").locator("[data-pipe-new-form]");
  await expect(form).toBeVisible();
  await expect(form.locator("[data-pipe-new-add]")).toBeDisabled(); // it needs a name
  await form.locator("input").fill("Kuro");
  await form.locator("textarea").fill("A black shiba with a fox-like face.");
  await expect(form.locator('[data-pipe-form="mesh"]')).toHaveAttribute("aria-checked", "true");
  await form.locator(".pipe-pick").first().click();
  await expect(form.locator(".pipe-pick.is-on")).toHaveCount(1);
  await settle(ada, 200);
  await ada.screenshot({ path: `${SHOTS}/02_new-character-form-night.png` });
  const before = (await sent()).length;
  await form.locator("[data-pipe-new-add]").click();
  await expect(tile(ada, "sheet", "Kuro")).toBeVisible();
  await expect(tile(ada, "sheet", "Kuro").locator("[data-pipe-generate]")).toHaveText("Generate · 9");
  await expect(node(ada, "sheet").locator(".pipe-count")).toHaveText("1 here");
  expect((await sent()).length, "adding a character spends nothing").toBe(before);
  expect(await whereIs(ada, "Kuro")).toBe("Pipeline · Abstract");
  // its card is docked under the band of nodes, not over it
  await settle(ada, 900);
  const kuro = (await ada.locator(`[data-obj-id="${await cardId(ada, "Kuro")}"] .frame-card`).boundingBox())!;
  const band = await ada.locator('[data-pipe-node][data-pipe-set="abstract"]').evaluateAll((els) => Math.max(...els.map((el) => (el.closest(".frame-card") ?? el).getBoundingClientRect().bottom)));
  expect(kuro.y).toBeGreaterThanOrEqual(band - 1);
  // it was given the picture it was drawn from
  const refs = ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ name: string; refs: string[]; identity: string; form: string }> }).characters.find((c) => c.name === "Kuro")!;
  expect(refs.refs.length).toBe(1);
  expect(refs.form).toBe("mesh");
});

test("the card's words are formatted text on the card: click and write, bold is bold, ⌘↵ and leaving save, and the prompt gets plain words", async () => {
  await snap(ada, { kind: "object", id: await cardId(ada, "Kuro") });
  await settle(ada, 1400);
  const c = card(ada, "Kuro");
  const words = c.locator("[data-char-words]");
  await expect(words).toHaveText("A black shiba with a fox-like face.");
  // part of the card: no box of its own, comfortable type, six lines at least
  const look = await words.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, size: s.fontSize, line: parseFloat(s.lineHeight), min: parseFloat(s.minHeight), bg: s.backgroundColor, paper: getComputedStyle(el.closest(".frame-card") ?? el.parentElement!).backgroundColor, tag: el.tagName };
  });
  expect(look.tag).toBe("DIV");
  expect(look.border).toBe("0px");
  expect(look.size).toBe("14px");
  expect(look.line).toBe(21);
  expect(look.min).toBeGreaterThanOrEqual(6 * 21);
  // the parts of the sheet, in order, each under a hairline
  expect(await c.locator("[data-char-part]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.charPart))).toEqual(["who", "stages", "drawn"]);
  expect(await c.locator("[data-char-part]").evaluateAll((els) => els.every((el) => getComputedStyle(el).borderTopWidth === "1px"))).toBe(true);

  // a plain click writes: no double-click, no mode
  await words.click();
  await expect(c.locator(".char-words-bar .rich-bar")).toBeVisible();
  await ada.keyboard.press("Control+a");
  await ada.keyboard.press("Control+b");
  await ada.keyboard.type("Kuro");
  await ada.keyboard.press("Control+b");
  await ada.keyboard.type(" is a black shiba with a fox-like face.");
  await ada.keyboard.press("Enter");
  await c.locator('.char-words-bar [aria-label="Bulleted list"]').click();
  await ada.keyboard.type("cream muzzle");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("a teal scarf");
  // what you see is what's kept: bold is bold and a list is a list, while writing
  await expect(words.locator("b, strong")).toHaveText("Kuro");
  await expect(words.locator("li")).toHaveCount(2);
  await expect(c.locator("[data-char-saved]")).toHaveAttribute("data-char-saved", "dirty");
  const tall = (await words.boundingBox())!.height;
  expect(tall).toBeGreaterThanOrEqual(6 * 21);
  await settle(ada, 200);
  await ada.screenshot({ path: `${SHOTS}/03_card-writing-night.png` });
  // ⌘/Ctrl+Enter saves, and says so
  await ada.keyboard.press("Control+Enter");
  await expect(c.locator("[data-char-saved]")).toHaveAttribute("data-char-saved", "saved");
  await expect(c.locator("[data-char-saved]")).toHaveText("✓ saved");
  const kept = async () => ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ name: string; identity: string }> }).characters.find((x) => x.name === "Kuro" || x.name === "Kuro the fox")!.identity;
  expect(await kept()).toBe("**Kuro** is a black shiba with a fox-like face.\n\n- cream muzzle\n- a teal scarf");
  // it grows with its words, and leaving it saves too
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("two and a half heads tall");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("short legs, clearly apart");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("a curled tail");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("both eyes open, mouth closed");
  expect((await words.boundingBox())!.height).toBeGreaterThan(tall);
  await c.locator(".char-eyebrow").first().click();
  await expect(c.locator(".char-words-bar")).toHaveCount(0);
  await expect.poll(kept).toContain("- both eyes open, mouth closed");
  // at rest it reads as it was written
  await expect(words.locator("b, strong")).toHaveText("Kuro");
  await expect(words.locator("li")).toHaveCount(6);

  // the name is a title you can write in; the card's bar follows
  const name = c.locator("[data-char-name]");
  expect(await name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(20);
  await name.fill("Kuro the fox");
  await name.press("Enter");
  await expect(card(ada, "Kuro the fox")).toBeVisible();
  await expect.poll(() => cardId(ada, "Kuro the fox")).not.toBe("");
  await card(ada, "Kuro the fox").locator("[data-char-name]").fill("Kuro");
  await card(ada, "Kuro the fox").locator("[data-char-name]").press("Enter");
  await expect(card(ada, "Kuro")).toBeVisible();
});

test("Generate on a node's tile runs that stage; when it lands the tile is at the next node, and the prompt had the plain words", async () => {
  await snap(ada, { kind: "section", id: await sectionId(ada, "Pipeline · Abstract") });
  await settle(ada, 1400);
  const before = (await sent()).length;
  await tile(ada, "sheet", "Kuro").locator("[data-pipe-generate]").click();
  // while it runs the tile says so and offers nothing to press
  await expect(tile(ada, "sheet", "Kuro")).toHaveAttribute("data-pipe-running", "true");
  await expect(tile(ada, "sheet", "Kuro").locator("[data-pipe-generate]")).toHaveCount(0);
  // landed: the tile has moved along the wire, and carries its picture
  await expect(tile(ada, "expressions", "Kuro")).toBeVisible({ timeout: 20_000 });
  await expect(tile(ada, "sheet", "Kuro")).toHaveCount(0);
  await expect(node(ada, "sheet").locator(".pipe-count")).toHaveText("none here");
  await expect(tile(ada, "expressions", "Kuro").locator(".pipe-tile-pic img")).toBeVisible();
  await expect(tile(ada, "expressions", "Kuro").locator("[data-pipe-generate]")).toHaveText("Generate · 9");
  const made = (await sent()).slice(before);
  expect(made.map((s) => s.endpoint)).toEqual(["image-to-image"]);
  // the stand-in keeps a prompt's first 40 characters: the words, with no marks in them
  expect(String(made[0].request.prompt)).toMatch(/^Front view\. Kuro is a black shiba with a…/);
  await settle(ada, 500);
  await ada.screenshot({ path: `${SHOTS}/04_tile-at-expressions-night.png` });
});

test("the expressions stage: its own priced press, one wide picture from the sheet, large on the card; the portrait is then drawn from both", async () => {
  await snap(ada, { kind: "object", id: await cardId(ada, "Kuro") });
  await settle(ada, 1400);
  const c = card(ada, "Kuro");
  const row = c.locator('[data-char-stage="expressions"]');
  await expect(row.locator("button.f-pill")).toHaveText("Draw the expressions · 9");
  // the stage after it waits
  await expect(c.locator('[data-char-stage="views"] button')).toHaveCount(0);
  const before = (await sent()).length;
  await row.locator("button.f-pill").click();
  await expect(row).toHaveAttribute("data-char-state", "done", { timeout: 20_000 });
  const made = (await sent()).slice(before);
  expect(made.length).toBe(1);
  expect(made[0].endpoint).toBe("image-to-image");
  expect(made[0].request.aspect_ratio).toBe("4:3");
  expect((made[0].request.reference_image_urls as string[]).length).toBe(1);
  expect(String(made[0].request.prompt)).toMatch(/^Expression and pose sheet of exactly the/);
  // shown large: the card's width, and wide, as it was drawn
  const pic = c.locator('[data-char-file="expressions"] img');
  await expect(pic).toBeVisible();
  await expect.poll(() => pic.evaluate((el) => (el as HTMLImageElement).naturalWidth / (el as HTMLImageElement).naturalHeight)).toBeCloseTo(4 / 3, 1);
  const size = (await pic.boundingBox())!;
  const sheet = (await c.locator('[data-char-file="front"] img').boundingBox())!;
  expect(size.width).toBeGreaterThan(sheet.width * 2.5);
  expect(await c.locator("[data-char-part]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.charPart))).toEqual(["who", "stages", "pictures", "drawn"]);
  await c.locator('[data-char-part="pictures"]').scrollIntoViewIfNeeded();
  await settle(ada, 400);
  await ada.screenshot({ path: `${SHOTS}/05_card-expressions-night.png` });
  // its lineage is kept like any stage's
  const id = await cardId(ada, "Kuro");
  const tasks = ((await (await ctx.request.get(`${CLIENT}/api/boards/${studio}/characters/${id}/tasks`)).json()) as { tasks: Array<{ stage: string; role: string; prompt: string; refHashes: string[]; by: string; credits: number; status: string }> }).tasks;
  const t = tasks.find((x) => x.stage === "expressions")!;
  expect({ role: t.role, by: t.by, credits: t.credits, status: t.status, refs: t.refHashes.length }).toEqual({ role: "expressions", by: "Ada Test", credits: 9, status: "done", refs: 1 });
  expect(t.prompt).toContain("BLINK (both eyes fully closed in a clean line");
  expect(t.prompt).toMatch(/Kuro is a black shiba with a fox-like face\. cream muzzle\. a teal scarf\./);

  // the portrait, from the Views node: drawn from the sheet and the expressions
  await snap(ada, { kind: "section", id: await sectionId(ada, "Pipeline · Abstract") });
  await settle(ada, 1400);
  const mark = (await sent()).length;
  await tile(ada, "views", "Kuro").locator("[data-pipe-generate]").click();
  await expect(tile(ada, "mesh", "Kuro")).toBeVisible({ timeout: 20_000 });
  const portrait = (await sent()).slice(mark);
  expect(portrait.length).toBe(1);
  expect((portrait[0].request.reference_image_urls as string[]).length).toBe(2);
});

test("a finished character is put into Characters · Set, and the next one beside it: added, arranged, nothing overlapping", async () => {
  // the Mesh avatar node's press is the .mavatar, brought in (nothing is spent)
  await expect(tile(ada, "mesh", "Kuro").locator("[data-pipe-generate]")).toHaveText("Bring in .mavatar");
  expect(await whereIs(ada, "Kuro")).toBe("Pipeline · Abstract");
  await tile(ada, "mesh", "Kuro").locator('input[type="file"]').setInputFiles(MAVATAR);
  await expect(tile(ada, "output", "Kuro")).toBeVisible({ timeout: 15_000 });
  await expect(tile(ada, "output", "Kuro")).toContainText("waiting for approval");
  await expect(node(ada, "output").locator(".pipe-count")).toHaveText("0 approved · 1 waiting");
  await expect.poll(() => whereIs(ada, "Kuro")).toBe("Characters · Abstract");
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/06_tile-at-output-night.png` });

  // two more through the same flow (pressed as the same person, by the routes the buttons use)
  for (const name of ["Shiro", "Taro"]) {
    const made = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name, set: "abstract", form: "mesh", identity: `${name}, a shiba.`, section: "Pipeline · Abstract" } });
    const id = ((await made.json()) as { character: { panelId: string } }).character.panelId;
    for (const s of ["sheet", "expressions", "views"]) await stageApi(id, s);
    expect(await whereIs(ada, name)).toBe("Pipeline · Abstract");
    const up = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/mavatar`, { headers: { "content-type": "application/zip" }, data: MAVATAR.buffer });
    expect(up.ok(), await up.text()).toBe(true);
    await expect.poll(() => whereIs(ada, name)).toBe("Characters · Abstract");
  }
  await expect(node(ada, "output").locator("[data-pipe-tile]")).toHaveCount(3);
  // in the section's flow: docked, each in its own place
  const chars = await sectionId(ada, "Characters · Abstract");
  await snap(ada, { kind: "section", id: chars });
  await settle(ada, 1600);
  const placed = await ada.evaluate((sec) => {
    const st = (window as unknown as { __foundation: Store }).__foundation.getState();
    return Object.values(st.panels).filter((x) => x.sectionId === sec && x.panel === "character").map((x) => {
      const r = document.querySelector(`[data-obj-id="${x.id}"] .frame-card`)!.getBoundingClientRect();
      return { name: x.name, float: x.float, l: r.left, t: r.top, r: r.right, b: r.bottom };
    });
  }, chars);
  expect(placed.map((x) => x.name).sort()).toEqual(["Kuro", "Shiro", "Taro"]);
  expect(placed.every((x) => !x.float)).toBe(true);
  for (const a of placed) for (const b of placed) if (a.name < b.name) expect(a.r <= b.l + 1 || b.r <= a.l + 1 || a.b <= b.t + 1 || b.b <= a.t + 1, `${a.name} × ${b.name}`).toBe(true);
  const secBox = (await ada.locator(`.section-card[data-section-id="${chars}"]`).boundingBox())!;
  for (const a of placed) expect(a.l >= secBox.x - 1 && a.r <= secBox.x + secBox.width + 1 && a.t >= secBox.y - 1, `${a.name} is inside its section`).toBe(true);
  await ada.screenshot({ path: `${SHOTS}/07_placed-in-characters-night.png` });
  // approved from its card, the output node counts it
  await card(ada, "Kuro").locator("[data-char-approval] .f-pill.is-accent").dispatchEvent("click");
  await expect(card(ada, "Kuro").locator(".char-tag.is-ready")).toHaveText("on the council");
  await expect(node(ada, "output").locator(".pipe-count")).toHaveText("1 approved · 2 waiting");
});

test("a character from before expression sheets isn't held back: it is offered “Add expressions”, and adding them changes nothing else", async () => {
  // as one made before 2026-11-17: the portrait drawn straight from the sheet, then its avatar
  const made = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name: "Hana", set: "abstract", form: "mesh", identity: "A cream shiba in a red scarf." } });
  const id = ((await made.json()) as { character: { panelId: string } }).character.panelId;
  await stageApi(id, "sheet");
  await stageApi(id, "views");
  await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/mavatar`, { headers: { "content-type": "application/zip" }, data: MAVATAR.buffer });
  await snap(ada, { kind: "object", id });
  await settle(ada, 1400);
  const c = card(ada, "Hana");
  await expect(c).toHaveAttribute("data-character-ready", "true");
  // it is at the output, not sent back to Expressions
  await expect(tile(ada, "output", "Hana")).toHaveCount(1);
  const row = c.locator('[data-char-stage="expressions"]');
  await expect(row).toHaveClass(/is-optional/);
  await expect(row.locator("button.f-pill")).toHaveText("Add expressions · 9");
  await row.locator("button.f-pill").scrollIntoViewIfNeeded();
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/08_add-expressions-night.png` });
  await row.locator("button.f-pill").click();
  await expect(row).toHaveAttribute("data-char-state", "done", { timeout: 20_000 });
  await expect(c).toHaveAttribute("data-character-ready", "true");
  await expect(c.locator('[data-char-stage="views"]')).toHaveAttribute("data-char-state", "done");
  await expect(c.locator('[data-char-stage="mesh"]')).toHaveAttribute("data-char-state", "done");
  await expect(c.locator('[data-char-file="expressions"] img')).toBeVisible();
  await expect(tile(ada, "output", "Hana")).toHaveCount(1);
});

test("scripts/characters-expressions.mjs: it lists and prices without pressing; --press presses as the person and follows it; done ones are skipped", async () => {
  // one made the old way: a sheet and a portrait, no expressions
  const made = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name: "Sumi", set: "abstract", form: "mesh", identity: "An ink-black cat.", section: "Pipeline · Abstract" } });
  const id = ((await made.json()) as { character: { panelId: string } }).character.panelId;
  await stageApi(id, "sheet");
  await stageApi(id, "views");
  const session = (await ctx.cookies()).find((c) => c.name === "foundation_session")!.value;
  const run = (...args: string[]) => execFileSync(process.execPath, ["../../scripts/characters-expressions.mjs", ...args], { env: { ...process.env, FOUNDATION_URL: CLIENT, FOUNDATION_SESSION: session }, encoding: "utf8", timeout: 60_000 });
  const stages = async () => ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ panelId: string; stages: Record<string, { state: string }> }> }).characters.find((c) => c.panelId === id)!.stages;

  const before = (await sent()).length;
  const dry = run("Sumi", "Nobody");
  expect(dry).toMatch(/Sumi\s+mesh\s+abstract\s+would press · 9 credits/);
  expect(dry).toMatch(/nobody\s+no such character/);
  expect(dry).toMatch(/1 to press, 9 credits/);
  expect(dry).toMatch(/Nothing was pressed/);
  expect((await sent()).length, "a run without --press sends nothing").toBe(before);
  expect((await stages()).expressions).toBeUndefined();

  const pressed = run("--press", "Sumi");
  expect(pressed).toMatch(/Sumi\s+\.*done · 9 credits · file f_/);
  expect(pressed).toMatch(/1 expression sheets drawn, 9 credits/);
  const made1 = (await sent()).slice(before);
  expect(made1.length, "one press, one image").toBe(1);
  expect(String(made1[0].request.prompt)).toMatch(/^Expression and pose sheet/);
  const after = await stages();
  expect(after.expressions.state).toBe("done");
  expect(after.views.state, "what was made after the sheet stays").toBe("done");
  // the grid saw it like any press: the card has its picture
  await expect(tile(ada, "mesh", "Sumi")).toHaveCount(1);

  const again = run("--press", "Sumi");
  expect(again).toMatch(/Sumi\s+mesh\s+abstract\s+skip: has its expressions/);
  expect(again).toMatch(/0 to press/);
  expect((await sent()).length).toBe(before + 1);
  // without a session it presses nothing and says what it needs
  expect(() => execFileSync(process.execPath, ["../../scripts/characters-expressions.mjs", "--press", "Sumi"], { env: { ...process.env, FOUNDATION_URL: CLIENT, FOUNDATION_SESSION: "" }, encoding: "utf8", stdio: "pipe" })).toThrow(/FOUNDATION_SESSION/);
});

test("the studio by day, and #/design: the card at 260, 400, 460 and 560 and the flow, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const when = scheme === "light" ? "day" : "night";
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    await c.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
    const p = await c.newPage();
    if (scheme === "light") {
      await p.goto(`/?board=${studio}`);
      await waitLive(p);
      await snap(p, { kind: "section", id: await sectionId(p, "Pipeline · Abstract") });
      await settle(p, 1800);
      await expect(node(p, "output").locator("[data-pipe-tile]")).toHaveCount(4);
      await p.screenshot({ path: `${SHOTS}/09_flow-day.png` });
      await snap(p, { kind: "object", id: await cardId(p, "Kuro") });
      await settle(p, 1800);
      await p.screenshot({ path: `${SHOTS}/10_card-day.png` });
    }
    await p.goto("/#/design");
    const demo = p.locator("[data-design-studio]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator("[data-design-character]")).toHaveCount(4);
    for (const w of [260, 400, 460, 560]) {
      const frame = demo.locator(`[data-design-character="${w}"]`);
      expect(Math.round((await frame.boundingBox())!.width)).toBe(w);
      // nothing spills sideways at any width, and every part is there
      const body = frame.locator(".char-body");
      expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `the card at ${w} doesn't scroll sideways`).toBe(true);
      expect(await body.evaluate((el) => [...el.querySelectorAll<HTMLElement>("*")].filter((x) => x.offsetParent && x.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).length), `nothing pokes out of the card at ${w}`).toBe(0);
      await expect(frame.locator('[data-char-part="who"]')).toBeVisible();
      await expect(frame.locator('[data-char-part="stages"] [data-char-stage]')).toHaveCount(4);
    }
    // the 460 card: one from before expression sheets, offered one; the 560: a viewer's, no buttons
    await expect(demo.locator('[data-design-character="460"] [data-char-stage="expressions"] button')).toHaveText("Add expressions · 9");
    await expect(demo.locator('[data-design-character="560"] button.f-pill')).toHaveCount(0);
    await expect(demo.locator('[data-design-character="400"] [data-char-words] strong')).toHaveCount(1);
    await expect(demo.locator("[data-design-flow] [data-pipe-node]")).toHaveCount(9);
    await expect(demo.locator("[data-design-flow] .pipe-wires path.pipe-line")).toHaveCount(9);
    await expect(demo.locator('[data-design-flow] [data-pipe-node="expressions"] [data-pipe-tile][data-pipe-running]')).toHaveCount(1);
    await expect(demo.locator("[data-design-flow-new] [data-pipe-new-form]")).toBeVisible();
    await settle(p, 900);
    for (const w of [260, 400, 460, 560]) {
      const frame = demo.locator(`[data-design-character="${w}"]`);
      await frame.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await frame.screenshot({ path: `${SHOTS}/11_design-card-${w}-${when}.png` });
    }
    await demo.locator("[data-design-flow]").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await demo.locator("[data-design-flow]").screenshot({ path: `${SHOTS}/12_design-flow-${when}.png` });
    await c.close();
  }
});

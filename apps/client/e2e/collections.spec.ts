/**
 * Collections in a real browser (2026-11-17, Josh: "a primitive … that can output images or character cards
 * like we have stored in Character studio into a collection, that can be piped into a section that
 * automatically lays out the products of that into the section. The collector should be able to also be
 * expanded to be able to drag out copies of those cards onto the grid"). Meshy is the stand-in
 * (e2e/meshy-standin.mjs: a real PNG per image; nothing is charged).
 *
 * - Character pipeline, from a section's right-click menu, lays the nine nodes into it with a collection
 *   wired from Output.
 * - A wire dragged from the Sheet node's output onto the collection brings each sheet drawn; a finished
 *   character comes in from Output.
 * - Expand opens it into tiles; a tile pulled out onto another section is a copy there, where it was let go.
 * - Lay out in → a new section below: everything is laid there docked, and what comes in later follows.
 * - Its output dragged onto a section pipes it there instead.
 * - #/design shows the card empty, folded and opened, day and night.
 */

import { mkdirSync } from "node:fs";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_collections";
const MESHY = `http://127.0.0.1:${process.env.E2E_MESHY_PORT ?? "4445"}`;
let ada: Page;
let ctx: BrowserContext;
let board = "";
let picture = "";

test.describe.configure({ mode: "serial" });

type Port = { id: string; name: string; dir: "in" | "out" };
type Obj = { id: string; kind?: string; panel?: string; name: string; sectionId: string; node?: string; source?: string; float: boolean; x: number; y: number; ports: Port[] };
type St = { sections: Record<string, { id: string; name: string }>; panels: Record<string, Obj>; media: Record<string, Obj>; links: Record<string, { from: { panel: string; port: string }; to: { panel: string; port: string } }> };
type Store = { getState(): St; setState(p: object): void };
const state = (p: Page) => p.evaluate(() => (window as unknown as { __foundation: Store }).__foundation.getState());
const snap = (p: Page, target: { kind: "section" | "object" | "all"; id?: string }) => p.evaluate((t) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { ...t, nonce: Math.random() } }), target);
const sectionId = async (p: Page, name: string) => Object.values((await state(p)).sections).find((s) => s.name === name)?.id ?? "";
/** the cards in a section, by kind: pictures and characters (copies included) */
const inSection = async (p: Page, id: string) => {
  const st = await state(p);
  return { pictures: Object.values(st.media).filter((o) => o.sectionId === id), characters: Object.values(st.panels).filter((o) => o.sectionId === id && o.panel === "character") };
};
const collection = (p: Page) => p.locator("[data-collection]").first();
const count = async (p: Page) => Number((await collection(p).getAttribute("data-coll-count")) ?? 0);
const tool = async <T>(name: string, data: object): Promise<T> => {
  const r = await ctx.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
  expect(r.ok(), await r.text()).toBe(true);
  return ((await r.json()) as { result: T }).result;
};
const stage = async (panel: string, s: string) => {
  const res = await ctx.request.post(`${CLIENT}/api/boards/${board}/characters/${panel}/stages/${s}`, { data: {} });
  expect(res.ok(), await res.text()).toBe(true);
  await expect.poll(async () => ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ panelId: string; stages: Record<string, { state: string }> }> }).characters.find((c) => c.panelId === panel)?.stages[s]?.state, { timeout: 20_000 }).toBe("done");
};
const MAVATAR = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("rig and layers")]);
const newCharacter = async (name: string, section: string) => {
  const r = await ctx.request.post(`${CLIENT}/api/boards/${board}/characters`, { data: { name, set: "anime", form: "mesh", identity: `${name}, a small round figure in soft gouache.`, refs: [picture], section } });
  expect(r.ok(), await r.text()).toBe(true);
  return ((await r.json()) as { character: { panelId: string } }).character.panelId;
};
/** the middle of an element on screen */
const middle = async (p: Page, selector: string) => {
  const b = await p.locator(selector).first().boundingBox();
  expect(b, selector).not.toBeNull();
  return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
};
/** a point in a section's paper that is no card (where a drop lands on the section itself) */
const bareSpot = (p: Page, id: string) =>
  p.evaluate((sid) => {
    const el = document.querySelector(`.section-card[data-section-id="${CSS.escape(sid)}"]`);
    const r = el?.getBoundingClientRect();
    if (!r) return null;
    for (let y = r.bottom - 24; y > r.top + 60; y -= 12)
      for (let x = r.right - 24; x > r.left + 24; x -= 12) {
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest(`.section-card[data-section-id="${CSS.escape(sid)}"]`) && !hit.closest("[data-panel-id], [data-obj-id], .section-header, button")) return { x, y };
      }
    return null;
  }, id);
const drag = async (p: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move(from.x + 8, from.y + 6, { steps: 3 });
  await p.mouse.move(to.x, to.y, { steps: 18 });
  await settle(p, 200);
  await p.mouse.up();
};

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Collections ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  await tool("add_section", { name: "Anime" });
  const png = await (await ctx.request.get(`${MESHY}/_png`)).body();
  const up = await ctx.request.post(`${CLIENT}/api/boards/${board}/characters/inspiration?set=Anime&name=shiba.png`, { headers: { "content-type": "image/png" }, data: png });
  expect(up.ok(), await up.text()).toBe(true);
  picture = ((await up.json()) as { file: string }).file;
  await tool("add_section", { name: "Moodboard" });
  await ada.goto(`/?board=${board}`);
  await waitLive(ada);
});

test("Character pipeline, from a section's menu: the nine nodes and a collection wired from Output", async () => {
  const anime = await sectionId(ada, "Anime");
  await snap(ada, { kind: "section", id: anime });
  await settle(ada, 1200);
  const at = await bareSpot(ada, anime);
  expect(at, "a bare spot in Anime").not.toBeNull();
  await ada.mouse.click(at!.x, at!.y, { button: "right" });
  await ada.locator(".context-menu button.menu-item", { hasText: "Character pipeline" }).click();
  await expect.poll(() => sectionId(ada, "Pipeline · Anime")).toBe(anime);
  await snap(ada, { kind: "section", id: anime });
  await settle(ada, 1400);
  await expect(ada.locator('[data-pipe-node][data-pipe-set="anime"]')).toHaveCount(9);
  await expect(collection(ada)).toBeVisible();
  await expect(collection(ada)).toHaveAttribute("data-coll-count", "0");
  const st = await state(ada);
  const coll = Object.values(st.panels).find((o) => o.panel === "collection")!;
  const output = Object.values(st.panels).find((o) => o.node === "output" && o.source === "anime")!;
  expect(Object.values(st.links).some((l) => l.from.panel === output.id && l.to.panel === coll.id), "Output → the collection").toBe(true);
  await ada.screenshot({ path: `${SHOTS}/01_pipeline-and-collection-night.png` });
});

test("a wire from Sheet brings each sheet drawn; Output brings the finished character", async () => {
  const st = await state(ada);
  const sheet = Object.values(st.panels).find((o) => o.node === "sheet" && o.source === "anime")!;
  const coll = Object.values(st.panels).find((o) => o.panel === "collection")!;
  const out = sheet.ports.find((p) => p.dir === "out")!;
  const into = coll.ports.find((p) => p.dir === "in")!;
  // dragged as a person wires two cards: from Sheet's output to the collection's input
  await drag(ada, await middle(ada, `.port[data-panel="${sheet.id}"][data-port-id="${out.id}"]`), await middle(ada, `.port[data-panel="${coll.id}"][data-port-id="${into.id}"]`));
  await expect.poll(async () => Object.values((await state(ada)).links).some((l) => l.from.port === out.id && l.to.panel === coll.id)).toBe(true);

  const pipe = await sectionId(ada, "Pipeline · Anime");
  const mira = await newCharacter("Mira", pipe);
  await stage(mira, "sheet");
  await expect.poll(() => count(ada), { timeout: 10_000 }).toBe(1);
  await stage(mira, "expressions");
  await stage(mira, "views");
  const up = await ctx.request.post(`${CLIENT}/api/boards/${board}/characters/${mira}/mavatar`, { headers: { "content-type": "application/zip" }, data: MAVATAR });
  expect(up.ok(), await up.text()).toBe(true);
  // finished: Output gives it, as a character (its expressions and views weren't wired, so they don't come)
  await expect.poll(() => count(ada), { timeout: 10_000 }).toBe(2);
  const items = await tool<{ items: Array<{ kind: string; name: string; from: string }> }>("read_collection", { collection: coll.id });
  expect(items.items.map((i) => [i.kind, i.from])).toEqual([
    ["image", "Sheet · Anime"],
    ["character", "Output · Anime"],
  ]);
  await snap(ada, { kind: "object", id: coll.id });
  await settle(ada, 1200);
  await collection(ada).hover();
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/02_folded-stack-night.png` });
});

test("expanded, a tile pulled onto another section is a copy there, where it was let go; the collection keeps it", async () => {
  const coll = Object.values((await state(ada)).panels).find((o) => o.panel === "collection")!;
  await ada.locator("[data-coll-toggle]").click();
  await expect(collection(ada)).toHaveAttribute("data-coll-open", "true");
  await expect(collection(ada).locator(".coll-grid .coll-tile")).toHaveCount(2);
  await snap(ada, { kind: "section", id: coll.sectionId });
  await settle(ada, 1400);
  // opened, it stays inside its section (it moved left over the flow's end to fit)
  const inside = await ada.evaluate(({ c, sec }) => {
    const card = document.querySelector(`[data-panel-id="${CSS.escape(c)}"]`)?.getBoundingClientRect();
    const body = document.querySelector(`.section-card[data-section-id="${CSS.escape(sec)}"]`)?.getBoundingClientRect();
    return card && body ? card.left >= body.left - 1 && card.right <= body.right + 1 && card.bottom <= body.bottom + 1 : false;
  }, { c: coll.id, sec: coll.sectionId });
  expect(inside, "the opened collection is inside its section").toBe(true);
  await ada.screenshot({ path: `${SHOTS}/03_opened-night.png` });

  // the whole board in view: the collection and the Moodboard section both
  await snap(ada, { kind: "all" });
  await settle(ada, 1400);
  const mood = await sectionId(ada, "Moodboard");
  const to = await bareSpot(ada, mood);
  expect(to, "a bare spot in Moodboard").not.toBeNull();
  const from = await middle(ada, '.coll-grid .coll-tile.kind-character');
  await ada.mouse.move(from.x, from.y);
  await ada.mouse.down();
  await ada.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await ada.mouse.move(to!.x, to!.y, { steps: 20 });
  await settle(ada, 250);
  await expect(ada.locator(".collection-ghost")).toHaveCount(1);
  await expect(ada.locator(`.section-card[data-section-id="${mood}"].is-carry-target`)).toHaveCount(1);
  await ada.screenshot({ path: `${SHOTS}/04_dragging-a-copy-night.png` });
  await ada.mouse.up();
  await expect.poll(async () => (await inSection(ada, mood)).characters.length, { timeout: 10_000 }).toBe(1);
  const copy = (await inSection(ada, mood)).characters[0];
  expect(copy.float, "it floats where it was let go").toBe(true);
  const fits = await ada.evaluate(({ c, sec }) => {
    const card = document.querySelector(`[data-panel-id="${CSS.escape(c)}"]`)?.getBoundingClientRect();
    const body = document.querySelector(`.section-card[data-section-id="${CSS.escape(sec)}"]`)?.getBoundingClientRect();
    return card && body ? card.right <= body.right + 1 && card.bottom <= body.bottom + 1 : false;
  }, { c: copy.id, sec: mood });
  expect(fits, "let go near the section's corner, the copy is kept inside it").toBe(true);
  await expect(ada.locator(".collection-ghost")).toHaveCount(0);
  await expect(collection(ada)).toHaveAttribute("data-coll-count", "2");
  await snap(ada, { kind: "object", id: copy.id });
  await settle(ada, 1400);
  await expect(ada.locator(`[data-panel-id="${copy.id}"] .char-tag.is-copy`)).toBeVisible();
  await expect(ada.locator(`[data-panel-id="${copy.id}"] .char-tag.is-pending`), "a copy isn't waiting on anyone").toHaveCount(0);
  // a copy offers nothing to press: its original is where it's made
  await expect(ada.locator(`[data-panel-id="${copy.id}"]`).getByRole("button", { name: /Approve|Draw|Bring in/ })).toHaveCount(0);
  await ada.screenshot({ path: `${SHOTS}/05_copy-on-moodboard-night.png` });
});

test("Lay out in a new section below: everything laid there docked, and what comes in later follows", async () => {
  const coll = Object.values((await state(ada)).panels).find((o) => o.panel === "collection")!;
  await snap(ada, { kind: "object", id: coll.id });
  await settle(ada, 1200);
  await collection(ada).locator("[data-coll-into]").selectOption("+below");
  await expect.poll(() => sectionId(ada, "Collected · Anime"), { timeout: 10_000 }).not.toBe("");
  const shelf = await sectionId(ada, "Collected · Anime");
  await expect.poll(async () => {
    const c = await inSection(ada, shelf);
    return [c.pictures.length, c.characters.length];
  }, { timeout: 10_000 }).toEqual([1, 1]);
  const laid = await inSection(ada, shelf);
  expect([...laid.pictures, ...laid.characters].every((o) => !o.float), "docked: the section's flow arranges them").toBe(true);

  // a second character's sheet arrives: it goes into the collection and on into the section
  const pipe = await sectionId(ada, "Pipeline · Anime");
  const taro = await newCharacter("Taro", pipe);
  await stage(taro, "sheet");
  await expect.poll(async () => (await inSection(ada, shelf)).pictures.length, { timeout: 10_000 }).toBe(2);
  await snap(ada, { kind: "section", id: shelf });
  await settle(ada, 1600);
  await ada.screenshot({ path: `${SHOTS}/06_laid-out-section-night.png` });
});

test("its output dragged onto a section pipes it there", async () => {
  const coll = Object.values((await state(ada)).panels).find((o) => o.panel === "collection")!;
  const mood = await sectionId(ada, "Moodboard");
  await snap(ada, { kind: "all" });
  await settle(ada, 1400);
  const out = coll.ports.find((p) => p.dir === "out")!;
  const to = await bareSpot(ada, mood);
  expect(to).not.toBeNull();
  await drag(ada, await middle(ada, `.port[data-panel="${coll.id}"][data-port-id="${out.id}"]`), to!);
  await expect.poll(async () => (await tool<{ into: string | null }>("read_collection", { collection: coll.id })).into, { timeout: 10_000 }).toBe(mood);
  // three things in it: each laid in Moodboard, beside the copy dragged there before
  await expect.poll(async () => {
    const c = await inSection(ada, mood);
    return c.pictures.length + c.characters.length;
  }, { timeout: 10_000 }).toBe(4);
  await snap(ada, { kind: "section", id: mood });
  await settle(ada, 1600);
  await ada.screenshot({ path: `${SHOTS}/07_piped-into-moodboard-night.png` });
});

test("#/design: a collection empty, folded and opened, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1400 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-design-collections]");
    // the three cards whole, clear of the page's sticky head
    await demo.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(demo.locator("[data-collection]")).toHaveCount(3);
    await settle(p, 900);
    await p.screenshot({ path: `${SHOTS}/08_design-${scheme === "dark" ? "night" : "day"}.png` });
    await c.close();
  }
});

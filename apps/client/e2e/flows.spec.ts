/**
 * Data flowing card to card, in a real browser (2026-11-24, Josh: "Some of the interconnection node roll-overs
 * don't come to the forefront. Also there's no ability to make a disconnection, or undo that result … test
 * whether disconnecting or connecting actually makes a difference in the flow of information … give loading
 * and generation images when connections are made"):
 *
 *  1. a port's card opens on the page's top layer (a child of the body, over every card), with a sample of
 *     what's on the port
 *  2. a wire dragged out of an app's output and let go on a table lands on its rows; what the app emits fills
 *     the table through its lens, the wire's chip says how many rows passed, and a new lens refills it
 *  3. pressing the wire opens its bar; Disconnect takes it off, the table says it's no longer fed, and what
 *     the app emits next doesn't reach it; ⌘Z puts the wire back and the table fills with what's there now
 *  4. the flow examples: BomForm → a lensed table, FactoryForm → stations, places → map, each wire with its
 *     chip saying what its system answered (BomForm isn't configured on a test server: it says so, plainly;
 *     FactoryForm answers when it runs on this computer)
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-24_flows";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

type Store = { getState(): { links: Record<string, { id: string; from: { panel: string }; to: { panel: string } }>; tables: Record<string, { id: string; name: string; feed?: { filter?: string } }> }; setState(p: object): void };

let ada: Page;
let ctx: BrowserContext;
let board = "";
let APP = "";
let TABLE = "";

const tool = async <T = unknown>(name: string, data: object): Promise<T> => {
  const r = await ctx.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data: { request_id: `${name}-${Math.random()}`, ...data } });
  if (!r.ok()) throw new Error(`${name}: ${r.status()} ${await r.text()}`);
  return ((await r.json()) as { result: T }).result;
};
const store = (p: Page) => p.evaluate(() => {
  const s = (window as unknown as { __foundation: Store }).__foundation.getState();
  return { links: Object.values(s.links), tables: s.tables };
});
const sheetText = (p: Page, id: string) => p.locator(`.obj-slot[data-obj-id="${id}"] .sheet`).innerText();
const frame = (p: Page, id: string) => p.evaluate((i) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "section", id: i, nonce: Math.random() } }), id);

/** the middle of a wire on screen (its route's midpoint, through the SVG's own transform) */
const wirePoint = (p: Page, linkTo: string) =>
  p.evaluate((to) => {
    const s = (window as unknown as { __foundation: Store }).__foundation.getState();
    const l = Object.values(s.links).find((x) => x.to.panel === to)!;
    const g = [...document.querySelectorAll<SVGGElement>(".port-layer g.pipe")].find((x) => x.querySelector(`[data-route]`) && x.querySelector("mask")?.id === `tun-${l.id}`)!;
    const path = g.querySelector<SVGPathElement>("path.pipe-hit")!;
    const len = path.getTotalLength();
    const pt = path.getPointAtLength(len * 0.5);
    const m = path.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f, id: l.id };
  }, linkTo);

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Flows ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  await tool("add_section", { name: "Flow" });
  APP = ((await tool<{ id: string }>("add_panel", { section: "Flow", panel: "app", name: "Parts feed", text: "emits the parts list", ports: [{ name: "parts", dir: "out", type: "json" }] })) as { id: string }).id;
  TABLE = (await tool<{ id: string }>("add_table", { section: "Flow", name: "Parts", columns: ["", "", ""], rows: [] })).id;
  await tool("send_to_port", {
    panel: APP,
    port: "parts",
    value: [
      { part: "bolt M6", qty: 40, vendor: "Fastco" },
      { part: "bracket", qty: 2, vendor: "Bendit" },
      { part: "motor 48V", qty: 6, vendor: "Volta" },
    ],
  });
  await ada.goto(`/?board=${board}`);
  await expect.poll(async () => (await store(ada)).tables[TABLE]?.name).toBe("Parts");
  const sec = await ada.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> } } }).__foundation.getState().sections).find((s) => s.name === "Flow")!.id);
  await frame(ada, sec);
  await settle(ada, 1500);
});

test("1 · a port's card opens on the top layer, with a sample of what's on it", async () => {
  const port = ada.locator(`.port.port-out[data-panel="${APP}"]`).first();
  await port.hover();
  const card = ada.locator(`.port-card[data-port-card^="${APP}:"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/is-placed/);
  expect(await card.evaluate((el) => el.parentElement === document.body), "portalled to the body, above every card").toBe(true);
  expect(await card.evaluate((el) => getComputedStyle(el).zIndex)).toBe("1000");
  await expect(card).toContainText("3 rows × 3 columns");
  await expect(card.locator(".flow-sample.is-rows td").first()).toHaveText("bolt M6");
  const b = (await card.boundingBox())!;
  await ada.screenshot({ path: `${SHOTS}/01_port-card-on-top-night.png`, clip: { x: Math.max(0, b.x - 260), y: Math.max(0, b.y - 80), width: b.width + 340, height: b.height + 160 } });
  await ada.mouse.move(10, 10);
});

test("2 · a wire let go on a table lands on its rows; the app's rows fill it through its lens", async () => {
  const from = (await ada.locator(`.port.port-out[data-panel="${APP}"]`).first().boundingBox())!;
  const to = (await ada.locator(`.obj-slot[data-obj-id="${TABLE}"] .sheet`).boundingBox())!;
  await ada.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 4 });
  await ada.mouse.down();
  for (let i = 1; i <= 14; i++) await ada.mouse.move(from.x + ((to.x + to.width / 2 - from.x) * i) / 14, from.y + ((to.y + to.height / 2 - from.y) * i) / 14, { steps: 2 });
  await expect(ada.locator(`.obj-slot[data-obj-id="${TABLE}"]`)).toHaveClass(/is-wire-target/);
  await ada.mouse.up();
  await expect.poll(async () => (await store(ada)).links.filter((l) => l.to.panel === TABLE).length).toBe(1);
  await expect.poll(() => sheetText(ada, TABLE)).toContain("motor 48V");
  const feed = ada.locator(`[data-table-feed="${TABLE}"]`);
  await expect(feed).toContainText("3 of 3 rows from Parts feed pass");
  const chip = ada.locator(".flow-chip[data-flow='ok']").first();
  await expect(chip).toContainText("3 of 3 rows → Parts");

  // a lens: only the parts there are more than 5 of, two columns
  await feed.locator("[data-feed-filter]").fill("qty > 5");
  await feed.locator("[data-feed-columns]").fill("part, qty");
  await feed.locator("[data-feed-columns]").press("Enter");
  await expect(feed).toContainText("2 of 3 rows from Parts feed pass");
  await expect.poll(() => sheetText(ada, TABLE)).not.toContain("bracket");
  expect(await sheetText(ada, TABLE)).not.toContain("Fastco");
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/02_wired-table-with-lens-night.png` });
});

test("3 · Disconnect stops the flow; what's emitted after doesn't arrive; ⌘Z puts the wire back and it fills again", async () => {
  const at = await wirePoint(ada, TABLE);
  await ada.mouse.click(at.x, at.y);
  const bar = ada.locator(`.wire-bar[data-wire-bar="${at.id}"]`);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Parts feed");
  await expect(bar).toContainText("3 rows × 3 columns");
  await ada.screenshot({ path: `${SHOTS}/03_wire-bar-night.png` });
  await bar.locator("[data-wire-disconnect]").click();
  await expect.poll(async () => (await store(ada)).links.filter((l) => l.to.panel === TABLE).length).toBe(0);
  const feed = ada.locator(`[data-table-feed="${TABLE}"]`);
  await expect(feed).toContainText("No longer fed");

  // the app emits a new list: unwired, the table doesn't follow
  await tool("send_to_port", { panel: APP, port: "parts", value: [{ part: "gearbox", qty: 9, vendor: "Cogs" }] });
  await settle(ada, 1200);
  expect(await sheetText(ada, TABLE)).toContain("motor 48V");
  expect(await sheetText(ada, TABLE)).not.toContain("gearbox");
  await ada.screenshot({ path: `${SHOTS}/04_disconnected-night.png` });

  // ⌘Z: the wire is back, and the table fills with what's on it now
  await ada.mouse.click(30, 450);
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await store(ada)).links.filter((l) => l.to.panel === TABLE).length).toBe(1);
  await expect.poll(() => sheetText(ada, TABLE)).toContain("gearbox");
  await expect(feed).toContainText("1 of 1 rows from Parts feed pass");
  // and redo takes it off again
  await ada.keyboard.press(`${MOD}+Shift+z`);
  await expect.poll(async () => (await store(ada)).links.filter((l) => l.to.panel === TABLE).length).toBe(0);
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await store(ada)).links.filter((l) => l.to.panel === TABLE).length).toBe(1);
});

test("4 · the flow examples: each wire's chip says what its system answered", async () => {
  const out = await tool<{ section: string; links: string[] }>("lay_flow_examples", {});
  expect(out.links.length).toBe(2);
  await frame(ada, out.section);
  await settle(ada, 2500);
  // a test server has no BomForm configured: its chip and its table say so, plainly
  await expect.poll(async () => ada.locator(".flow-chip[data-flow='error']").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect(ada.locator(".table-feed.is-bad").first()).toContainText("offline");
  // FactoryForm, when it runs on this computer, answers: its stations are in the table, through its lens
  const stations = await ada.evaluate(() => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().tables).find((t) => t.name.startsWith("Stations"))!.id);
  const ok = ada.locator(`[data-table-feed="${stations}"].is-ok`);
  if (await ok.count().then((n) => n > 0).catch(() => false) || (await ada.locator(`[data-table-feed="${stations}"]`).innerText()).includes("rows from")) {
    await expect.poll(() => sheetText(ada, stations), { message: "the rows that passed are in its cells" }).toContain("Receiving");
  }
  await ada.screenshot({ path: `${SHOTS}/05_examples-night.png` });

});

test("5 · day: the port's card, the wired table with its lens, and the examples", async () => {
  await ada.emulateMedia({ colorScheme: "light" });
  await ada.reload();
  await waitLive(ada);
  const flow = await ada.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> } } }).__foundation.getState().sections).find((s) => s.name === "Flow")!.id);
  await frame(ada, flow);
  await settle(ada, 1500);
  // a wire lands on this port now and its hit area lies over the pill: the wire hands the pointer to the port
  const pb = (await ada.locator(`.port.port-out[data-panel="${APP}"]`).first().boundingBox())!;
  await ada.mouse.move(pb.x + pb.width / 2 - 30, pb.y + pb.height / 2, { steps: 3 });
  await ada.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 6 });
  await expect(ada.locator(`.port-card[data-port-card^="${APP}:"]`)).toHaveClass(/is-placed/);
  await expect(ada.locator(`.port-card[data-port-card^="${APP}:"]`)).toContainText("Parts");
  await settle(ada, 500); // its fade in
  await ada.screenshot({ path: `${SHOTS}/06_port-card-and-lens-day.png` });
  await ada.mouse.move(10, 10);
  const examples = await ada.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> } } }).__foundation.getState().sections).find((s) => s.name === "Flows")!.id);
  await frame(ada, examples);
  await settle(ada, 1500);
  await ada.screenshot({ path: `${SHOTS}/07_examples-day.png` });
});

test("6 · #/design shows the samples, the chip's states and the lens bar, day and night", async () => {
  for (const when of ["day", "night"] as const) {
    await ada.emulateMedia({ colorScheme: when === "day" ? "light" : "dark" });
    await ada.goto("/#/design");
    const demo = ada.locator("[data-design-flows]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator(".port-card")).toHaveCount(4);
    await expect(demo.locator(".flow-chip")).toHaveCount(5);
    await expect(demo.locator(".flow-sample.is-rows td").first()).toHaveText("UL-2271");
    await settle(ada, 500);
    await demo.screenshot({ path: `${SHOTS}/08_design-${when}.png` });
  }
});

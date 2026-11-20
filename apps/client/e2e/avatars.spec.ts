/**
 * Foundation's avatars in a real browser (2026-11-17, Josh: "visualize that the Characters are being exported
 * to the Section on the left through the pipes, in that left section is a Node that can accept Character
 * Input Cards through the flow interface … Breaking a connection will remove that, the characters can be
 * individually connected to that uploader, or a section that holds many of them can be connected").
 *
 * - The studio has Foundation avatars on its left: the uploader fills that section, and a wire runs into it
 *   from each set's Characters section, drawn from the section's edge.
 * - Its tiles are the characters those sections hold, each saying where it stands; on a server that can't
 *   upload (these checks never push: FOUNDATION_AVATARS_REPO is off) Upload now is greyed and the note says why.
 * - A wire selected and deleted breaks the connection: that set's characters are archived and leave the
 *   card. Wire in, let go over the section, wires it back, and they're avatars again.
 * - A character card's own output dragged onto the uploader wires that one character in.
 * - The studio and the card by day and night, and #/design.
 *
 * With E2E_STARTER pointing at apps/server/starter/characters the studio holds the real starter set (the
 * evidence was taken that way); without it, the check makes three characters of its own.
 */

import { mkdirSync } from "node:fs";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, person, sectionBox, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_avatars-uploader";
let ada: Page;
let ctx: BrowserContext;
let studio = "";
const made: string[] = [];

test.describe.configure({ mode: "serial" });

type Obj = { id: string; panel?: string; name: string; sectionId: string; ports: Array<{ id: string; name: string; dir: string; type?: string }> };
type St = { sections: Record<string, { id: string; name: string; c0: number; host?: string }>; panels: Record<string, Obj>; links: Record<string, { id: string; from: { panel: string; port: string }; to: { panel: string; port: string }; label?: string }> };
type Store = { getState(): St; setState(p: object): void };
const state = (p: Page) => p.evaluate(() => (window as unknown as { __foundation: Store }).__foundation.getState());
const snap = (p: Page, target: { kind: "section" | "object" | "all"; id?: string }) => p.evaluate((t) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { ...t, nonce: Math.random() } }), target);
const uploader = (p: Page) => p.locator("[data-uploader]").first();
const MAVATAR = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("rig and layers")]);
type Char = { id: string; name: string; set: string; panelId: string; approval?: string; ready: boolean };
const characters = async () => ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Char[] }).characters;
/** the wires into the uploader, by the name of the section each leaves */
const wiresIn = async (p: Page) => {
  const st = await state(p);
  const up = Object.values(st.panels).find((o) => o.panel === "uploader")!;
  return Object.values(st.links)
    .filter((l) => l.to.panel === up.id)
    .map((l) => st.sections[l.from.panel]?.name ?? st.panels[l.from.panel]?.name ?? l.from.panel)
    .sort();
};

async function finished(name: string, section: string) {
  const res = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name, set: "anime", form: "mesh", identity: `${name}, someone.`, section } });
  expect(res.ok(), await res.text()).toBe(true);
  const id = ((await res.json()) as { character: { panelId: string } }).character.panelId;
  const up = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/mavatar`, { headers: { "content-type": "application/zip" }, data: MAVATAR });
  expect(up.ok(), await up.text()).toBe(true);
  await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/approval`, { data: { approval: "approved" } });
  made.push(id);
  return id;
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
  const res = await ctx.request.post(`${CLIENT}/api/characters/studio`);
  studio = ((await res.json()) as { id: string }).id;
  if (!(await characters()).some((c) => c.set === "anime" && c.ready)) for (const n of ["Ume", "Nori", "Yuzu"]) await finished(n, "Characters · Anime");
  await ada.goto(`/?board=${studio}`);
  await waitLive(ada);
});

// the council's checks run later on the same server and make their own first approved character
test.afterAll(async () => {
  for (const id of made) await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/approval`, { data: { approval: "archived" } });
});

test("the studio has Foundation avatars on its left: the uploader fills it, wired from each set's Characters by the section's edge", async () => {
  const st = await state(ada);
  const sec = Object.values(st.sections).find((s) => s.name === "Foundation avatars")!;
  expect(sec, "the section is there").toBeTruthy();
  expect(sec.c0).toBe(0);
  expect(Object.values(st.sections).every((s) => s.id === sec.id || s.c0 >= 1), "every other section is to its right").toBe(true);
  expect(st.panels[sec.host!]?.panel).toBe("uploader");
  expect(await wiresIn(ada)).toEqual(["Characters · Abstract", "Characters · Animals", "Characters · Anime"]);
  await snap(ada, { kind: "all" });
  await settle(ada, 2000);
  await expect(uploader(ada)).toBeVisible();
  // each wire is drawn: a route that starts on its section's edge and ends on the uploader's
  const ends = await ada.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>(".port-layer .pipe")]
      .filter((g) => g.style.display !== "none" && g.querySelector(".pipe-label")?.textContent && ["Anime", "Animals", "Abstract"].includes(g.querySelector(".pipe-label")!.textContent!))
      .map((g) => g.querySelector("path[data-route]")!.getAttribute("d") ?? ""),
  );
  expect(ends.length).toBe(3);
  expect(ends.every((d) => d.length > 10)).toBe(true);
  await ada.screenshot({ path: `${SHOTS}/01_studio-wired-night.png` });
});

test("its tiles are the characters wired in, each saying where it stands; a server that can't upload says why", async () => {
  const ready = (await characters()).filter((c) => c.ready && (c.approval ?? "approved") === "approved");
  await snap(ada, { kind: "section", id: (await sectionBox(ada, "Foundation avatars")).id });
  await settle(ada, 1600);
  await expect.poll(async () => Number(await uploader(ada).getAttribute("data-up-avatars"))).toBe(ready.length);
  await expect(uploader(ada).locator("[data-up-entry]")).toHaveCount(ready.length);
  await expect(uploader(ada).locator("[data-up-group]")).not.toHaveCount(0);
  await expect(uploader(ada).locator("[data-up-upload]")).toBeDisabled();
  await expect(uploader(ada).locator(".up-note")).toContainText(/turned off|checkout/);
  await ada.screenshot({ path: `${SHOTS}/02_uploader-night.png` });
});

test("a wire deleted breaks the connection: that set's characters are archived and leave; Wire in over the section brings them back", async () => {
  const anime = (await characters()).filter((c) => c.set === "anime" && c.ready && (c.approval ?? "approved") === "approved");
  expect(anime.length).toBeGreaterThan(0);
  await snap(ada, { kind: "all" });
  await settle(ada, 1600);
  // the wire from Characters · Anime (a short hop across the gutter, where the others run too), pressed at the
  // point of its route furthest from every other wire, then Delete
  await snap(ada, { kind: "section", id: (await sectionBox(ada, "Characters · Anime")).id });
  await settle(ada, 1600);
  const mid = await ada.evaluate(() => {
    const groups = [...document.querySelectorAll<SVGGElement>(".port-layer .pipe")].filter((x) => x.style.display !== "none");
    const mine = groups.find((x) => x.querySelector(".pipe-label")?.textContent === "Anime")!;
    const sample = (p: SVGPathElement, n: number) => Array.from({ length: n + 1 }, (_, i) => p.getPointAtLength((p.getTotalLength() * i) / n));
    const path = mine.querySelector<SVGPathElement>("path.pipe-hit")!;
    const others = groups.filter((g) => g !== mine).flatMap((g) => sample(g.querySelector<SVGPathElement>("path.pipe-hit")!, 200));
    let best = sample(path, 40)[20];
    let far = -1;
    for (const pt of sample(path, 40).slice(4, -4)) {
      const d = Math.min(...others.map((o) => Math.hypot(o.x - pt.x, o.y - pt.y)));
      if (d > far) [far, best] = [d, pt];
    }
    const m = path.getScreenCTM()!;
    return { x: best.x * m.a + best.y * m.c + m.e, y: best.x * m.b + best.y * m.d + m.f };
  });
  await ada.mouse.move(mid.x, mid.y);
  await ada.mouse.down();
  await ada.mouse.up();
  await ada.keyboard.press("Delete");
  await expect.poll(() => wiresIn(ada)).toEqual(["Characters · Abstract", "Characters · Animals"]);
  await expect.poll(async () => (await characters()).filter((c) => anime.some((a) => a.id === c.id)).every((c) => c.approval === "archived"), { timeout: 10_000 }).toBe(true);
  await snap(ada, { kind: "section", id: (await sectionBox(ada, "Foundation avatars")).id });
  await settle(ada, 1400);
  for (const c of anime) await expect(uploader(ada).locator(`[data-up-entry="${c.name}"][data-up-state="avatar"]`)).toHaveCount(0);
  await ada.screenshot({ path: `${SHOTS}/03_wire-taken-off-night.png` });

  // Wire in: drawn backwards out of the uploader's input, let go over the section
  await snap(ada, { kind: "all" });
  await settle(ada, 1600);
  const handle = await uploader(ada).locator(".up-wire").boundingBox();
  const target = await sectionBox(ada, "Characters · Anime");
  await ada.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await ada.mouse.down();
  // on the section's own paper, below its cards (over a card, the wire takes that one card)
  await ada.mouse.move(target.x + target.width / 2, target.y + target.height - 12, { steps: 12 });
  await expect(ada.locator(`.section-card[data-section-id="${target.id}"]`)).toHaveClass(/is-wire-target/);
  await ada.screenshot({ path: `${SHOTS}/04_wire-in-dragging-night.png` });
  await ada.mouse.up();
  await expect.poll(() => wiresIn(ada)).toEqual(["Characters · Abstract", "Characters · Animals", "Characters · Anime"]);
  await expect.poll(async () => (await characters()).filter((c) => anime.some((a) => a.id === c.id)).every((c) => c.approval === "approved"), { timeout: 10_000 }).toBe(true);
});

test("a character card's own output, dragged onto the uploader, wires that one character in", async () => {
  // one in the making, in the pipeline section: wired, it waits until it's finished
  const res = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name: "Momo", set: "anime", form: "mesh", identity: "A girl with a peach hat.", section: "Pipeline · Anime" } });
  const id = ((await res.json()) as { character: { panelId: string } }).character.panelId;
  made.push(id);
  await expect.poll(async () => (await state(ada)).panels[id]?.ports.some((p) => p.dir === "out")).toBe(true);
  await snap(ada, { kind: "all" });
  await settle(ada, 1600);
  const out = ada.locator(`.port.port-out[data-panel="${id}"]`);
  await out.scrollIntoViewIfNeeded().catch(() => undefined);
  const from = await out.boundingBox();
  const to = await uploader(ada).boundingBox();
  expect(from && to).toBeTruthy();
  await ada.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await ada.mouse.down();
  await ada.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 14 });
  await ada.mouse.up();
  await expect.poll(() => wiresIn(ada)).toContain("Momo");
  await expect(uploader(ada).locator('[data-up-entry="Momo"]')).toHaveAttribute("data-up-state", "waiting");
});

test("the studio and the uploader by day, and #/design, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const when = scheme === "light" ? "day" : "night";
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    await c.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
    const p = await c.newPage();
    if (scheme === "light") {
      await p.goto(`/?board=${studio}`);
      await waitLive(p);
      await snap(p, { kind: "all" });
      await settle(p, 2000);
      await p.screenshot({ path: `${SHOTS}/05_studio-wired-day.png` });
      await snap(p, { kind: "section", id: (await sectionBox(p, "Foundation avatars")).id });
      await settle(p, 1800);
      await p.screenshot({ path: `${SHOTS}/06_uploader-day.png` });
    }
    await p.goto("/#/design");
    const demo = p.locator("[data-design-uploader]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator("[data-uploader]")).toHaveCount(3);
    await expect(demo.locator('[data-up-state="removed"]')).toHaveCount(1);
    await expect(demo.locator("[data-up-upload]").nth(2)).toBeDisabled();
    for (const [i, name] of ["empty", "wired", "cannot"].entries()) {
      const f = demo.locator(".frame-card").nth(i);
      await f.scrollIntoViewIfNeeded();
      await settle(p, 500);
      await f.screenshot({ path: `${SHOTS}/07_design-${name}-${when}.png` });
    }
    await c.close();
  }
});

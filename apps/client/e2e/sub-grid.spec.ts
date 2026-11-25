/**
 * A section becomes a grid of its own, and the grid it came from keeps a preview and a link
 * (2026-11-17, Josh: "Open as its own grid doesn't work, it should create a sub-grid that can be
 * pulled out of the grid collection and moved to other grids, but still maintain a preview in the
 * Grid it used to be in, and maintain a link to the new location").
 *
 * Two people on one grid, in real browsers:
 *  - ⤢ on a section asks once in place; Cancel changes nothing; **Make it a grid** makes a grid inside
 *    this one with the section's note, table and image, opens it, and shows the way back up;
 *  - the other person, who pressed nothing, sees the section become the grid's card: its name, what
 *    it holds, and the grid in miniature (the image as the image); a change in the child shows there;
 *  - the child is under its parent in All Grids; dragged to the top, the old parent still shows the
 *    preview and says where it went; dragged into another grid, it names that grid and a press goes
 *    there; the card opens the grid; a person can take the leftover card away and the grid stays;
 *  - over HTTP: the same request twice is one grid, and a viewer is refused;
 *  - `#/design` shows the question, the card, both moved states and the way back up, day and night.
 *
 *   E2E_SERVER_PORT=15931 E2E_CLIENT_PORT=15951 E2E_SLACK_PORT=15941 E2E_MESHY_PORT=15945 E2E_T3_PORT=15995 \
 *     npm run e2e -w @foundation/client -- sub-grid
 */

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_sub-grids";

interface St {
  sections: Record<string, { id: string; name: string; host?: string }>;
  panels: Record<string, { id: string; panel: string; name: string; board?: string; sectionId: string }>;
  notes: Record<string, { id: string; name: string; sectionId: string }>;
  tables: Record<string, { id: string; name: string; sectionId: string }>;
  media: Record<string, { id: string; name: string; sectionId: string; src: string }>;
  level: string | null;
}
const state = <T>(p: Page, fn: (s: St) => T) => p.evaluate(`(${fn.toString()})(window.__foundation.getState())`) as Promise<T>;
const boardId = (p: Page) => p.evaluate(() => (window as unknown as { __foundationBoard: () => { boardId: string } | null }).__foundationBoard()?.boardId ?? null);

async function signIn(browser: Browser, name: string, email: string, scheme: "dark" | "light", pane: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await context.addInitScript((open) => {
    if (!localStorage.getItem("foundation-floor")) localStorage.setItem("foundation-floor", JSON.stringify({ pane: open, tabs: [], tab: null, search: false, spacesView: "all" }));
  }, pane);
  return { context, page: await context.newPage() };
}

let ada: { context: BrowserContext; page: Page };
let ben: { context: BrowserContext; page: Page };
const stamp = Date.now().toString(36);
let parent = "";
let child = "";
let motors = "";
let designSection = "";

const api = async <T>(who: BrowserContext, path: string, data?: object) => {
  const res = data ? await who.request.post(`${CLIENT}${path}`, { data }) : await who.request.get(`${CLIENT}${path}`);
  return { status: res.status(), body: (await res.json()) as T };
};
const tool = async (board: string, name: string, data: object) => (await api<{ result: { id: string } }>(ada.context, `/api/boards/${board}/tools/${name}`, data)).body.result;
const grids = async () => (await api<{ boards: Array<{ id: string; name: string; parent: string | null }> }>(ada.context, "/api/boards")).body.boards;
const open = async (p: Page, board: string) => {
  await p.goto(`/?board=${board}&rafshim`);
  await waitLive(p);
  await settle(p, 900);
};

const frameSection = async (p: Page, id: string) => {
  await p.evaluate((sec) => (window as unknown as { __foundation: { setState(s: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id: sec, nonce: Math.random() } }), id);
  await settle(p, 1500);
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  ada = await signIn(browser, "Ada Admin", "admin@normal.dev", "dark", true);
  ben = await signIn(browser, "Ben Test", "ben@normal.dev", "dark", false);
  parent = (await api<{ id: string }>(ada.context, "/api/boards", { name: `Programme ${stamp}` })).body.id;
  motors = (await api<{ id: string }>(ada.context, "/api/boards", { name: `Motors ${stamp}` })).body.id;
  await tool(parent, "add_note", { section: "Section 1", title: "Outside", markdown: "This note stays on the programme." });
  await tool(parent, "add_section", { name: "Design" });
  await tool(parent, "add_note", { section: "Design", title: "Brief", markdown: "# Brief\nA rim-driven fan, 212 mm." });
  await tool(parent, "add_table", { section: "Design", name: "Parts", columns: ["Part", "Qty"], rows: [["Stator", "1"], ["Magnet", "24"]] });
  await open(ada.page, parent);
  designSection = (await state(ada.page, (s) => Object.values(s.sections).find((x) => x.name === "Design")!.id)) as string;
  // an image, as a person would drop one: uploaded, then a picture card in the section
  await ada.page.evaluate(
    async ({ board, section }) => {
      const c = new OffscreenCanvas(480, 320);
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 480, 320);
      grad.addColorStop(0, "hsl(210 60% 62%)");
      grad.addColorStop(1, "hsl(28 70% 55%)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 480, 320);
      const blob = await c.convertToBlob({ type: "image/png" });
      const r = await fetch(`/api/files?board=${encodeURIComponent(board)}&name=sketch.png`, { method: "POST", body: blob, headers: { "content-type": "image/png" }, credentials: "include" });
      const url = ((await r.json()) as { file: { url: string } }).file.url;
      const f = (window as unknown as { __foundation: { getState(): { media: Record<string, unknown> }; setState(p: object): void } }).__foundation;
      const id = `media_e2e${Date.now().toString(36)}`;
      f.setState({ media: { ...f.getState().media, [id]: { id, sectionId: section, name: "sketch.png", x: 0, y: 0, w: 480, h: 320, src: url, media: "image", autoplay: true, muted: true, float: false, bornAt: Date.now() } } });
    },
    { board: parent, section: designSection },
  );
  await expect.poll(async () => (await api<{ cards: number }>(ada.context, `/api/boards/${parent}/outline`)).body.cards).toBe(4);
  await open(ben.page, parent);
});

test.afterAll(async () => {
  await ada?.context.close();
  await ben?.context.close();
});

test("⤢ asks once in place, then the section is a grid inside this one; the other person sees its card with the grid in miniature", async () => {
  const card = ada.page.locator(`.section-card[data-section-id="${designSection}"]`);
  const press = async () => {
    await frameSection(ada.page, designSection);
    await card.locator(".section-header").hover();
    await card.locator('.sec-layout button[aria-label="Open as its own grid"]').click();
  };
  await press();
  const ask = card.locator(".confirm-pop.grid-ask");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Make Design its own grid?");
  await expect(ask).toContainText("Its cards move into a new grid inside this one; this section keeps a preview of it.");
  await settle(ada.page, 500);
  await ada.page.screenshot({ path: `${SHOTS}/01_ask-night.png` });
  // Cancel changes nothing
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  expect((await grids()).filter((b) => b.parent === parent)).toHaveLength(0);
  expect(await state(ada.page, (s) => Object.keys(s.notes).length)).toBe(2);

  await press();
  await ask.getByRole("button", { name: "Make it a grid" }).click();
  // this window opens the new grid: one section, the three cards, and the way back up
  await expect.poll(() => boardId(ada.page), { timeout: 15_000 }).not.toBe(parent);
  child = (await boardId(ada.page))!;
  await waitLive(ada.page);
  const made = (await grids()).find((b) => b.id === child)!;
  expect(made.parent).toBe(parent);
  expect(made.name).toBe("Design");
  await expect.poll(() => state(ada.page, (s) => [Object.values(s.sections).map((x) => x.name).join(), Object.keys(s.notes).length, Object.keys(s.tables).length, Object.keys(s.media).length].join("|"))).toBe("Design|1|1|1");
  await expect(ada.page.getByText("A rim-driven fan, 212 mm.")).toBeVisible();
  const bar = ada.page.locator(".level-bar");
  await expect(bar).toContainText(`Programme ${stamp}`);
  await expect(bar.locator(".level-here")).toContainText("Design");
  // the picture is the child's own file now, and it loads there
  const src = await state(ada.page, (s) => Object.values(s.media)[0].src);
  expect((await ada.context.request.get(`${CLIENT}${src}`)).ok()).toBeTruthy();
  // All Grids: under its parent, one step in
  await expect(ada.page.locator(`.side-pane .grid-node:has(> [data-grid-row="${parent}"]) .grid-node [data-grid-row="${child}"]`)).toBeVisible();
  await settle(ada.page, 1200);
  await ada.page.screenshot({ path: `${SHOTS}/02_child-grid-night.png` });

  // Ben pressed nothing: the section is where it was, and now holds the grid's card
  const link = ben.page.locator(`[data-grid-link="${child}"]`);
  await expect(link).toBeVisible({ timeout: 15_000 });
  await expect(link.locator(".grid-link-eyebrow")).toHaveText("A grid inside this one");
  await expect(link.locator(".grid-link-name")).toContainText("Design");
  await expect(link.locator(".grid-link-facts")).toContainText("1 section · 3 cards");
  const preview = link.locator(".grid-preview");
  await expect(preview.locator('[data-gp-section="Design"]')).toBeVisible();
  await expect(preview.locator(".gp-card")).toHaveCount(3);
  await expect(preview.locator('.gp-card[data-gp-card="note"]')).toHaveCount(1);
  await expect(preview.locator('.gp-card[data-gp-card="table"]')).toHaveCount(1);
  await frameSection(ben.page, designSection);
  await expect.poll(() => preview.locator(".gp-card.is-picture img").evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
  expect(await state(ben.page, (s) => ({ sections: Object.values(s.sections).map((x) => x.name).sort().join(), notes: Object.values(s.notes).map((n) => n.name).join(), tables: Object.keys(s.tables).length, media: Object.keys(s.media).length, hosted: Object.values(s.sections).find((x) => x.name === "Design")?.host === Object.values(s.panels).find((p) => p.panel === "grid")?.id }))).toEqual({
    sections: "Design,Section 1",
    notes: "Outside",
    tables: 0,
    media: 0,
    hosted: true,
  });
  // not moved: no line about where it went
  await expect(link.locator("[data-grid-where]")).toHaveCount(0);

  // the preview follows the child: Ada adds a note there, Ben's card counts it
  await tool(child, "add_note", { section: "Design", title: "Open questions", markdown: "Bearing or bushing?" });
  await expect(link.locator(".grid-link-facts")).toContainText("1 section · 4 cards", { timeout: 15_000 });
  await expect(preview.locator(".gp-card")).toHaveCount(4);
  await ben.page.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), designSection);
  await settle(ben.page, 1500);
  await ben.page.screenshot({ path: `${SHOTS}/03_parent-preview-night.png` });

  // the way back up: ⤡ opens the parent, framed on the section that stands for this grid
  await bar.locator(".level-back").click();
  await expect.poll(() => boardId(ada.page)).toBe(parent);
  await waitLive(ada.page);
  await expect(ada.page.locator(`[data-grid-link="${child}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(ada.page.locator(".level-bar")).toHaveCount(0);
  // on the parent, the section's ⤢ opens the grid it stands for (no question)
  const stood = ada.page.locator(`.section-card[data-section-id="${designSection}"]`);
  await frameSection(ada.page, designSection);
  await stood.locator(".section-header").hover();
  await stood.locator('.sec-layout button[aria-label="Open the grid"]').click();
  await expect.poll(() => boardId(ada.page)).toBe(child);
  await waitLive(ada.page);
});

test("pulled out to the top, then into another grid: the grid it was in keeps the preview and says where it went; the card opens it", async ({ browser }) => {
  await open(ada.page, parent);
  await ada.page.locator(".side-pane .pane-seg-btn", { hasText: "All Grids" }).click();
  const row = (id: string) => ada.page.locator(`.side-pane [data-grid-row="${id}"]`);
  await expect(row(child)).toBeVisible();
  const sectionsBefore = await state(ada.page, (s) => Object.keys(s.sections).length);

  // to the top of All Grids
  await row(child).dragTo(ada.page.locator(".side-pane .pane-seg-btn", { hasText: "All Grids" }));
  await expect.poll(async () => (await grids()).find((b) => b.id === child)!.parent).toBeNull();
  for (const p of [ada.page, ben.page]) {
    const link = p.locator(`[data-grid-link="${child}"]`);
    await expect(link).toHaveAttribute("data-grid-moved", "top", { timeout: 15_000 });
    await expect(link.locator(".grid-link-eyebrow")).toHaveText("A grid that was here");
    await expect(link.locator("[data-grid-where]")).toContainText("Moved out: now at the top of All Grids");
    await expect(link.locator(".grid-preview .gp-card")).toHaveCount(4);
    await expect(link.locator(".grid-link-go")).toHaveText("Open the grid →");
  }
  expect(await state(ada.page, (s) => Object.keys(s.sections).length)).toBe(sectionsBefore);
  // in the menu it's a top-level grid now
  await expect(ada.page.locator(`.side-pane .grid-node:has(> [data-grid-row="${parent}"]) .grid-node [data-grid-row="${child}"]`)).toHaveCount(0);
  await ada.page.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), designSection);
  await settle(ada.page, 1500);
  await ada.page.screenshot({ path: `${SHOTS}/04_moved-to-top-night.png` });

  // into another grid: the old parent names it; the new one has its own card
  await row(child).dragTo(row(motors));
  await expect.poll(async () => (await grids()).find((b) => b.id === child)!.parent).toBe(motors);
  const left = ada.page.locator(`[data-grid-link="${child}"]`);
  await expect(left).toHaveAttribute("data-grid-moved", motors, { timeout: 15_000 });
  await expect(left.locator("[data-grid-where]")).toContainText(`Moved out: now inside Motors ${stamp}`);
  await expect(ben.page.locator(`[data-grid-link="${child}"] [data-grid-where]`)).toContainText(`now inside Motors ${stamp}`, { timeout: 15_000 });
  await settle(ada.page, 800);
  await ada.page.screenshot({ path: `${SHOTS}/05_moved-into-another-night.png` });

  // the same two states by day
  const day = await signIn(browser, "Ada Admin", "admin@normal.dev", "light", false);
  await open(day.page, parent);
  await expect(day.page.locator(`[data-grid-link="${child}"] [data-grid-where]`)).toBeVisible({ timeout: 15_000 });
  await day.page.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), designSection);
  await settle(day.page, 1800);
  await day.page.screenshot({ path: `${SHOTS}/05_moved-into-another-day.png` });
  await day.context.close();

  // the line's grid is a press: it opens Motors, where the grid's card is an ordinary one
  await left.locator(".grid-link-where").click();
  await expect.poll(() => boardId(ada.page)).toBe(motors);
  await waitLive(ada.page);
  const there = ada.page.locator(`[data-grid-link="${child}"]`);
  await expect(there).toBeVisible({ timeout: 15_000 });
  await expect(there.locator(".grid-link-eyebrow")).toHaveText("A grid inside this one");
  await expect(there.locator("[data-grid-where]")).toHaveCount(0);

  // from the old parent, the card still opens the grid
  await open(ada.page, parent);
  await ada.page.locator(`[data-grid-link="${child}"] .grid-link-open`).click();
  await expect.poll(() => boardId(ada.page)).toBe(child);
  await waitLive(ada.page);
  await expect(ada.page.locator(".level-bar")).toContainText(`Motors ${stamp}`);

  // a person takes the leftover card away: the grid itself is untouched
  await open(ada.page, parent);
  await frameSection(ada.page, designSection);
  await ada.page.locator(`[data-grid-link="${child}"] .grid-link-remove`).click();
  await expect(ada.page.locator(`[data-grid-link="${child}"]`)).toHaveCount(0);
  await expect(ben.page.locator(`[data-grid-link="${child}"]`)).toHaveCount(0, { timeout: 15_000 });
  expect((await grids()).find((b) => b.id === child)!.parent).toBe(motors);
  expect((await api<{ cards: number }>(ada.context, `/api/boards/${child}/outline`)).body.cards).toBe(4);
});

test("over HTTP: the same request twice is one grid; a viewer is refused and sees no ⤢ to make one", async ({ browser }) => {
  const board = (await api<{ id: string }>(ada.context, "/api/boards", { name: `Budget ${stamp}` })).body.id;
  await tool(board, "add_note", { section: "Section 1", title: "Numbers", markdown: "12" });
  await tool(board, "add_section", { name: "Later" });
  const kai = await signIn(browser, "Kai Viewer", "kai@normal.dev", "dark", false);
  const me = (await api<{ user: { id: string } }>(kai.context, "/api/me")).body.user;
  expect((await api(ada.context, `/api/boards/${board}/people`, { userId: me.id, role: "viewer" })).status).toBe(200);
  const refused = await api<{ error: string }>(kai.context, `/api/boards/${board}/sections/${encodeURIComponent("Section 1")}/extract`, { request_id: "k1" });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatch(/View only/);
  expect((await grids()).filter((b) => b.parent === board)).toHaveLength(0);
  await open(kai.page, board);
  await expect(kai.page.locator(".section-card[data-section-id]").first()).toBeVisible();
  await expect(kai.page.locator(".sec-rest-open.is-make:visible")).toHaveCount(0);
  await kai.context.close();

  const once = await api<{ result: { board: string; moved: number } }>(ada.context, `/api/boards/${board}/sections/${encodeURIComponent("Section 1")}/extract`, { request_id: "r1" });
  expect(once.status).toBe(200);
  expect(once.body.result.moved).toBe(1);
  const twice = await api<{ result: { board: string } }>(ada.context, `/api/boards/${board}/sections/${encodeURIComponent("Section 1")}/extract`, { request_id: "r1" });
  expect(twice.body.result.board).toBe(once.body.result.board);
  // and without the request id, a section that already stands for a grid answers with that grid
  const third = await api<{ result: { board: string; already?: boolean } }>(ada.context, `/api/boards/${board}/sections/${encodeURIComponent("Section 1")}/extract`, {});
  expect(third.body.result).toMatchObject({ board: once.body.result.board, already: true });
  expect((await grids()).filter((b) => b.parent === board)).toHaveLength(1);
});

test("a section open in this window only (Expand) offers to be made a grid from the pill, asked once there", async () => {
  const board = (await api<{ id: string }>(ada.context, "/api/boards", { name: `Sketches ${stamp}` })).body.id;
  await tool(board, "add_note", { section: "Section 1", title: "Idea", markdown: "A quieter blade." });
  await open(ada.page, board);
  const section = (await state(ada.page, (s) => Object.values(s.sections)[0].id)) as string;
  // the in-window level, as "n more · Expand" opens it
  await ada.page.evaluate((id) => (window as unknown as { __foundation: { expandSection(id: string): void } }).__foundation.expandSection(id), section);
  await expect.poll(() => state(ada.page, (s) => s.level)).toBe(section);
  const bar = ada.page.locator(".level-bar");
  await expect(bar.locator(".level-here")).toContainText("Section 1");
  expect((await grids()).filter((b) => b.parent === board)).toHaveLength(0);
  await bar.locator(".level-make").click();
  await expect(bar.locator(".level-make-ask")).toContainText("Its cards move into a new grid inside this one.");
  await settle(ada.page, 500);
  await ada.page.screenshot({ path: `${SHOTS}/07_level-make-it-a-grid-night.png` });
  await bar.getByRole("button", { name: "Cancel" }).click();
  await expect(bar.locator(".level-make-ask")).toHaveCount(0);
  expect((await grids()).filter((b) => b.parent === board)).toHaveLength(0);
  await bar.locator(".level-make").click();
  await bar.getByRole("button", { name: "Make it a grid", exact: true }).click();
  await expect.poll(() => boardId(ada.page), { timeout: 15_000 }).not.toBe(board);
  await waitLive(ada.page);
  const made = (await grids()).filter((b) => b.parent === board);
  expect(made).toHaveLength(1);
  expect(made[0].id).toBe(await boardId(ada.page));
  await expect.poll(() => state(ada.page, (s) => [s.level, Object.keys(s.notes).length].join("|"))).toBe("|1");
  await expect(ada.page.locator(".level-bar")).toContainText(`Sketches ${stamp}`);
});

test("#/design shows the question, the card with its preview, both moved states and the way back up, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Admin", email: "admin@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-design-subgrid]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator(".grid-preview")).toHaveCount(3);
    await expect(demo.locator(".grid-preview").first().locator(".gp-sec")).toHaveCount(4);
    await expect(demo.locator("[data-grid-where]")).toHaveCount(2);
    await expect(demo.locator(".confirm-pop.grid-ask")).toContainText("Make Stator its own grid?");
    await expect(demo.locator(".level-bar")).toHaveCount(2);
    // every miniature section sits inside its preview
    const spill = await demo.locator(".grid-preview").evaluateAll((els) =>
      els.flatMap((el) => {
        const b = el.getBoundingClientRect();
        return [...el.querySelectorAll(".gp-sec")].filter((s) => {
          const r = s.getBoundingClientRect();
          return r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.width < 8 || r.height < 8;
        }).length;
      }),
    );
    expect(spill).toEqual([0, 0, 0]);
    await settle(p, 900);
    await demo.screenshot({ path: `${SHOTS}/06_design-${scheme === "light" ? "day" : "night"}.png` });
    await c.close();
  }
});

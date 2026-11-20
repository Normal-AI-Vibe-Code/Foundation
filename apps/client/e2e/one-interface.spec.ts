/**
 * One interface (Josh, 2026-11-15): Settings is a place inside Foundation with the settings first;
 * the plan and the design language are grids; a grid dragged onto another becomes its child, in the
 * side menu and on the parent grid; a port under the pointer says what's on it and where it goes; the
 * server's pill is in the top bar.
 */

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-15_one-interface";
let ctx: BrowserContext;
let ada: Page;

test.describe.configure({ mode: "serial" });

type Store = { getState(): { sections: Record<string, { id: string; name: string; host?: string }>; panels: Record<string, { id: string; panel: string; name: string; board?: string; source?: string }>; links: Record<string, unknown> }; setState(p: object): void };
const state = <T>(p: Page, fn: (s: ReturnType<Store["getState"]>) => T) => p.evaluate(`(${fn.toString()})(window.__foundation.getState())`) as Promise<T>;
const boardId = (p: Page) => p.evaluate(() => (window as unknown as { __foundationBoard: () => { boardId: string } | null }).__foundationBoard()?.boardId ?? null);

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const res = await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
  expect(res.ok()).toBeTruthy();
  ada = await ctx.newPage();
});
test.afterAll(async () => {
  await ctx.close();
});

test("Settings is a place in the shell: the side menu stays, the settings come first, and a choice takes effect", async () => {
  await ada.goto("/?rafshim#/today");
  await ada.locator('.side-pane [data-place="settings"]').click();
  await expect(ada).toHaveURL(/#\/settings$/);
  const space = ada.locator(".settings-space");
  await expect(space).toHaveAttribute("data-settings-tab", "general");
  await expect(ada.locator(".side-pane")).toBeVisible();
  await expect(ada.locator(".top-bar [data-place-tab=settings]")).toBeVisible();
  await expect(space.locator(".settings-tab")).toHaveText(["General", "Agents", "Avatars", "Plan", "Design language", "Services", "Places", "Renderer", "Releases"]);
  await expect(space.locator(".settings-tab.is-current")).toHaveText("General");
  // the server this app uses is in the side menu, above Settings (2026-11-17)
  await expect(ada.locator(".side-pane [data-server-where=pane] .server-switch-pill")).toBeVisible();
  await expect(ada.locator(".top-tools [data-tip='Agent layer (A)']")).toHaveCount(0);

  // the colour scheme: night, then day, and the choice is the page's
  const scheme = space.getByRole("radiogroup", { name: "Colour scheme" });
  await scheme.getByRole("radio", { name: "Night" }).click();
  await expect(ada.locator("html")).toHaveClass(/is-night/);
  await settle(ada, 1600);
  await ada.screenshot({ path: `${SHOTS}/settings-general-night.png` });
  await scheme.getByRole("radio", { name: "Day" }).click();
  await expect(ada.locator("html")).not.toHaveClass(/is-night/);
  await expect(scheme.getByRole("radio", { name: "Day" })).toHaveAttribute("aria-checked", "true");

  // what agents may do on a machine's desktop is this person's, kept by the server
  const use = space.getByRole("radiogroup", { name: "Using a machine's desktop" });
  await expect(use.getByRole("radio", { name: "Ask me on each machine" })).toHaveAttribute("aria-checked", "true");
  await use.getByRole("radio", { name: "Never" }).click();
  await expect.poll(async () => ((await (await ctx.request.get(`${CLIENT}/api/prefs`)).json()) as { prefs: { computer_use: string } }).prefs.computer_use).toBe("never");
  await use.getByRole("radio", { name: "Ask me on each machine" }).click();
  await expect.poll(async () => ((await (await ctx.request.get(`${CLIENT}/api/prefs`)).json()) as { prefs: { computer_use: string } }).prefs.computer_use).toBe("ask");
  // a setting can't be made up
  expect((await ctx.request.post(`${CLIENT}/api/prefs`, { data: { key: "computer_use", value: "always" } })).status()).toBe(400);
  await settle(ada, 1600);
  await ada.screenshot({ path: `${SHOTS}/settings-general-day.png` });

  // Agents and Avatars are tabs of their own
  await space.locator(".settings-tab", { hasText: "Agents" }).click();
  await expect(space).toContainText("Your own agent, over MCP");
  await expect(space).toContainText("This computer's agents");
  await ada.screenshot({ path: `${SHOTS}/settings-agents.png` });
  await space.locator(".settings-tab", { hasText: "Avatars" }).click();
  await expect(space.locator('[data-avatar-agent="Claude"]')).toBeVisible();
  await expect(space.locator('[data-avatar-agent="Claude"] .provider-mark[data-provider="claude"]')).toBeVisible();
  await ada.screenshot({ path: `${SHOTS}/settings-avatars.png` });
});

test("the plan is a kanban card on a grid, the design language a grid of chapters; neither is listed among the grids", async () => {
  await ada.locator(".settings-tab", { hasText: "Plan" }).click();
  await expect.poll(() => boardId(ada)).toBe("foundation-plan");
  await waitLive(ada);
  const kinds = await state(ada, (s) => Object.values(s.panels).map((p) => `${p.panel}:${p.source}`));
  expect(kinds).toEqual(["kanban:plan"]);
  expect(await state(ada, (s) => Object.values(s.sections).length)).toBe(1);
  const card = ada.locator(".hosted-app.kind-kanban [data-kanban=plan]");
  await expect(card.locator(".kb-col")).not.toHaveCount(0);
  await expect(card.locator(".kb-card").first()).toBeVisible({ timeout: 15_000 });
  // the strip stays over the grid, and the grid's own tools are there: it is a grid
  await expect(ada.locator(".settings-space.is-grid .settings-tab.is-current")).toHaveText("Plan");
  await expect(ada.locator(".hud")).toBeVisible();
  await settle(ada, 1500);
  await ada.screenshot({ path: `${SHOTS}/settings-plan-grid.png` });

  await ada.locator(".settings-tab", { hasText: "Design language" }).click();
  await expect.poll(() => boardId(ada)).toBe("foundation-design");
  await waitLive(ada);
  const chapters = await state(ada, (s) => Object.values(s.panels).filter((p) => p.panel === "design").map((p) => p.source));
  expect(chapters).toHaveLength(13);
  expect(await state(ada, (s) => Object.values(s.sections).every((x) => !!x.host))).toBe(true);
  await expect(ada.locator("[data-design-chapter]").first()).toBeVisible({ timeout: 15_000 });
  await settle(ada, 2500);
  await ada.screenshot({ path: `${SHOTS}/settings-design-grid.png` });

  // Foundation's own grids aren't among the grids, and leaving the tab brings back the grid that was open
  await expect(ada.locator('.side-pane [data-grid-row^="foundation-"]')).toHaveCount(0);
  await ada.locator(".settings-tab", { hasText: "General" }).click();
  await expect.poll(() => boardId(ada)).toBe("company");
});

test("a grid dragged onto another becomes its child: in All Grids, and as a section on the parent grid that opens it", async () => {
  const stamp = Date.now().toString(36);
  const make = async (name: string) => ((await (await ctx.request.post(`${CLIENT}/api/boards`, { data: { name } })).json()) as { id: string }).id;
  const fans = await make(`Fans ${stamp}`);
  const rim = await make(`Rim drive ${stamp}`);
  await ada.goto(`/?board=${fans}&rafshim`);
  await waitLive(ada);
  await ada.locator(".side-pane .pane-seg-btn", { hasText: "All Grids" }).click();
  const row = (id: string) => ada.locator(`.side-pane [data-grid-row="${id}"]`);
  await expect(row(rim)).toBeVisible();

  await row(rim).dragTo(row(fans));
  // in the menu: under its parent, one step in
  const kid = ada.locator(`.side-pane .grid-node:has(> [data-grid-row="${fans}"]) .grid-node [data-grid-row="${rim}"]`);
  await expect(kid).toBeVisible();
  const boards = ((await (await ctx.request.get(`${CLIENT}/api/boards`)).json()) as { boards: Array<{ id: string; parent: string | null }> }).boards;
  expect(boards.find((b) => b.id === rim)!.parent).toBe(fans);
  // on the parent grid: a section that stands for it
  const link = ada.locator(`[data-grid-link="${rim}"]`);
  await expect(link).toBeVisible({ timeout: 10_000 });
  await expect(link).toContainText(`Rim drive ${stamp}`);
  await expect(link).toContainText("1 section");
  expect(await state(ada, (s) => Object.values(s.sections).filter((x) => x.host).length)).toBe(1);
  await settle(ada, 1200);
  await ada.screenshot({ path: `${SHOTS}/grid-of-grids.png` });

  // a loop is refused, in words
  const loop = await ctx.request.post(`${CLIENT}/api/boards/${fans}`, { data: { parent: rim } });
  expect(loop.status()).toBe(400);
  expect(((await loop.json()) as { error: string }).error).toMatch(/is inside .* already/);

  // the card opens the child
  await link.locator(".grid-link-open").click();
  await expect.poll(() => boardId(ada)).toBe(rim);
  await expect(ada.locator(`.side-pane [data-grid-row="${rim}"]`)).toHaveClass(/is-current/);

  // back to the top: the grid it was in keeps its card, as a preview and a link to where it went (2026-11-17; e2e/sub-grid.spec.ts)
  await row(rim).dragTo(ada.locator(".side-pane .pane-seg-btn", { hasText: "All Grids" }));
  await expect.poll(async () => ((await (await ctx.request.get(`${CLIENT}/api/boards`)).json()) as { boards: Array<{ id: string; parent: string | null }> }).boards.find((b) => b.id === rim)!.parent).toBeNull();
  await row(fans).locator(".space-open").click();
  await expect.poll(() => boardId(ada)).toBe(fans);
  await waitLive(ada);
  const left = ada.locator(`[data-grid-link="${rim}"]`);
  await expect(left).toHaveAttribute("data-grid-moved", "top", { timeout: 15_000 });
  await expect(left.locator("[data-grid-where]")).toContainText("now at the top of All Grids");
});

test("a port under the pointer says what's on it and where it goes, and lights its wire; there is no layer to switch on", async () => {
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Wires ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool = async (name: string, data: object) => ((await (await ctx.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data })).json()) as { result: unknown }).result;
  await tool("add_section", { name: "Flow" });
  await tool("add_note", { section: "Flow", title: "Keep them cards", markdown: "so the apps are cards, not the section's app" });
  await tool("add_panel", { section: "Flow", panel: "app", name: "Maker", url: `${CLIENT}/e2e/frame.html`, ports: [{ name: "parts", dir: "out", type: "bom" }] });
  await tool("add_panel", { section: "Flow", panel: "app", name: "Taker", url: `${CLIENT}/e2e/frame.html`, ports: [{ name: "bom", dir: "in", type: "bom" }] });
  await ada.goto(`/?board=${board}&rafshim`);
  await waitLive(ada);
  const ids = await state(ada, (s) => Object.fromEntries(Object.values(s.panels).map((p) => [p.name, p.id])));
  await tool("connect", { from_panel: ids.Maker, from_port: "parts", to_panel: ids.Taker, to_port: "bom", label: "parts list" });
  await tool("send_to_port", { panel: ids.Maker, port: "parts", value: { rows: 12, name: "Rim drive BOM" } });
  await expect.poll(() => state(ada, (s) => Object.keys(s.links).length)).toBe(1);
  await ada.evaluate((id) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } }), ids.Maker);
  await settle(ada, 1500);

  const out = ada.locator(`.port.port-out[data-panel="${ids.Maker}"]`);
  await expect(out).toHaveCount(1);
  const pipe = ada.locator(".port-layer .pipe").first();
  await expect(pipe).not.toHaveClass(/is-hover/);
  const b = (await out.boundingBox())!;
  await ada.mouse.move(b.x - 40, b.y - 40);
  await ada.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  const label = out.locator(".port-label.is-open");
  await expect(label).toBeVisible();
  await expect(label).toContainText("parts");
  await expect(label).toContainText("output");
  await expect(label).toContainText("Rim drive BOM");
  await expect(label.locator(".port-link")).toContainText("Taker");
  await expect(label.locator(".port-link")).toContainText("into its bom");
  await expect(pipe).toHaveClass(/is-hover/);
  await settle(ada, 500);
  await ada.screenshot({ path: `${SHOTS}/port-hover.png` });
  // the A key no longer switches a layer on
  await ada.mouse.move(700, 870);
  await ada.keyboard.press("a");
  await expect(ada.locator(".app.shell")).not.toHaveClass(/agent-layer-on/);
  await expect(ada.locator(".frame-header .icon-btn.is-agent")).toHaveCount(0);
});

test("#/design shows settings' rows, a grid inside a grid and the provider beads, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-design-settings]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator(".set-row")).toHaveCount(3);
    await expect(demo.locator(".provider-mark")).toHaveCount(9);
    await expect(demo.locator(".grid-link-name")).toContainText("Rim drive");
    await settle(p, 900);
    await demo.screenshot({ path: `${SHOTS}/design-settings-${scheme === "light" ? "day" : "night"}.png` });
    await c.close();
  }
});

/**
 * CAD cards fed by an app (2026-11-25, docs/cad-feed.md), in a real browser on the real routes. A stand-in BOM app
 * (an MCP server in this test's process) answers `part_model` with an STL. A person saves the app; an agent's add_cad
 * asks for a press; once allowed, a 3D card stands in the CAD section, wired from the app's card, drawing the model.
 * The app's part changes and Refresh takes the new model; the wire is cut and the card is an orphan that keeps it;
 * a copy pasted elsewhere is unlinked from the start. Day and night.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-25_council-trace-cad";

/** an STL box, w × d × h mm: twelve facets */
function box(w: number, d: number, h: number) {
  const v = (x: number, y: number, z: number) => `vertex ${x} ${y} ${z}`;
  const quad = (a: number[], b: number[], c: number[], e: number[]) => [
    `facet normal 0 0 0\nouter loop\n${v(a[0], a[1], a[2])}\n${v(b[0], b[1], b[2])}\n${v(c[0], c[1], c[2])}\nendloop\nendfacet`,
    `facet normal 0 0 0\nouter loop\n${v(a[0], a[1], a[2])}\n${v(c[0], c[1], c[2])}\n${v(e[0], e[1], e[2])}\nendloop\nendfacet`,
  ];
  const p = (x: number, y: number, z: number) => [x * w, y * d, z * h];
  const f = [
    ...quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)),
    ...quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
    ...quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)),
    ...quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
    ...quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)),
    ...quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
  ];
  return `solid part\n${f.join("\n")}\nendsolid part\n`;
}

const models: Record<string, string> = { hub: box(40, 40, 12), bracket: box(60, 10, 30) };
let mcp: Server;
let address = "";
let page: Page;
let ctx: BrowserContext;
let board = "";
let app = "";
let hub = "";

const tool = async (name: string, input: object) => {
  const r = await ctx.request.post(`${CLIENT}/api/boards/${encodeURIComponent(board)}/tools/${name}`, { data: input });
  expect(r.ok(), await r.text()).toBe(true);
  return ((await r.json()) as { result: unknown }).result;
};
const card = (id: string) => page.locator(`[data-panel-id="${id}"]`).first();

async function look(p: Page, night: boolean) {
  // the command toggles; its words are whichever the bar showed when it opened
  for (let i = 0; i < 2 && (await p.evaluate(() => document.documentElement.classList.contains("is-night"))) !== night; i++) {
    // the side menu's orb; the menu is opened for it and folded again if it was folded
    const orb = p.locator(".side-pane .night-orb").first();
    const folded = !(await orb.isVisible());
    if (folded) await p.locator(".pane-fold").click();
    await orb.click();
    if (folded) await p.locator(".pane-fold").click();
    await settle(p, 200);
  }
  await expect.poll(() => p.evaluate(() => document.documentElement.classList.contains("is-night")), { timeout: 5000 }).toBe(night);
  await expect
    .poll(() => p.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--night"))), { timeout: 5000 })
    .toBe(night ? 1 : 0);
  await expect
    .poll(() => p.evaluate((n) => { const u = (window as unknown as { __foundationBg?: { uniforms: { night: number } } }).__foundationBg?.uniforms.night; return u === undefined || u === n; }, night ? 1 : 0), { timeout: 5000 })
    .toBe(true);
  await settle(p, 300);
}

const night = (on: boolean) => look(page, on);

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mcp = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const server = new McpServer({ name: "bom-standin", version: "0.0.1" });
    server.registerTool("part_model", { description: "A part's 3D model as an STL file.", inputSchema: { part: z.string() } }, async ({ part }) => ({
      content: [{ type: "text" as const, text: `${part}` }, { type: "resource" as const, resource: { uri: `bom://parts/${part}.stl`, mimeType: "model/stl", blob: Buffer.from(models[part] ?? "").toString("base64") } }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((ok) => mcp.listen(0, "127.0.0.1", ok));
  address = `http://127.0.0.1:${(mcp.address() as { port: number }).port}/mcp`;
  const a = await person(browser, "Admin", "admin@normal.dev");
  page = a.page;
  ctx = a.context;
  board = await page.evaluate(() => (window as unknown as { __foundationBoard: () => { boardId: string } }).__foundationBoard().boardId);
});

test.afterAll(async () => {
  await ctx?.close();
  mcp?.close();
});

test("an app's part becomes a 3D card beside it, wired to it, once a person allows the tool", async () => {
  const saved = await ctx.request.post(`${CLIENT}/api/apps`, { data: { name: "Airform BOM", url: "http://127.0.0.1/", mcp: address, description: "parts" } });
  expect(saved.ok(), await saved.text()).toBe(true);
  app = ((await tool("add_panel", { panel: "app", name: "Airform BOM", section: "BOM", mcp: address })) as { id: string }).id;
  // the first ask: nothing is called and no card is made; a person is asked on the app's card
  const first = await tool("add_cad", { name: "Fan hub", from: { panel: app, tool: "part_model", args: { part: "hub" } }, section: "CAD" });
  expect(String(first)).toMatch(/Nothing was called/);
  const waiting = () =>
    page.evaluate((id) => {
      const b = (window as unknown as { __foundationBoard: () => { doc: import("yjs").Doc } }).__foundationBoard();
      const m = b.doc.getMap("machineAsks").get(id) as Array<{ id: string; state: string }> | undefined;
      return (m ?? []).filter((a) => a.state === "waiting").map((a) => a.id);
    }, app);
  await expect.poll(async () => (await waiting()).length, { timeout: 10_000 }).toBe(1);
  const asks = await waiting();
  // the ask stands on the app's card, with Allow
  await settle(page, 600);
  await page.screenshot({ path: `${SHOTS}/04a_the-app-asks-first-day.png` });
  const allowed = await ctx.request.post(`${CLIENT}/api/boards/${encodeURIComponent(board)}/apps/${app}/asks/${asks[0]}/allow`);
  expect(allowed.ok(), await allowed.text()).toBe(true);

  const made = (await tool("add_cad", { name: "Fan hub", from: { panel: app, tool: "part_model", args: { part: "hub" } }, section: "CAD" })) as { id: string; wired: boolean };
  expect(made.wired).toBe(true);
  hub = made.id;
  await tool("add_cad", { name: "Bracket", from: { panel: app, tool: "part_model", args: { part: "bracket" } }, section: "CAD" });
  // the CAD section in view, then the card itself (the model plays near)
  const sectionOf = await page.evaluate((id) => ((window as unknown as { __foundationBoard: () => { doc: import("yjs").Doc } }).__foundationBoard().doc.getMap("objects").get(id) as { sectionId: string }).sectionId, hub);
  await page.evaluate((sid) => (window as unknown as { __foundation: { setState: (s: object) => void } }).__foundation.setState({ snapRequest: { kind: "section", id: sid, nonce: Math.random() } }), sectionOf);
  await settle(page, 1500);
  const c = card(hub);
  await expect(c).toBeVisible({ timeout: 15_000 });
  await expect(c.locator(".cad-feed-source")).toContainText("Airform BOM");
  await expect(c.locator(".cad-feed-refresh")).toBeVisible();
  // the model fills the card: a picture of it or the live viewer
  await expect(c.locator(".cad-card.is-model")).toBeVisible();
  await c.hover();
  await expect(c.locator(".cad-card canvas, .cad-card img").first()).toBeVisible({ timeout: 20_000 });
  // and a wire runs from the app's card to it
  const wired = await page.evaluate((id) => {
    const b = (window as unknown as { __foundationBoard: () => { doc: import("yjs").Doc } }).__foundationBoard();
    return [...(b.doc.getMap("links").values() as IterableIterator<{ to: { panel: string; port: string } }>)].some((l) => l.to.panel === id && l.to.port === "model");
  }, hub);
  expect(wired).toBe(true);
  await settle(page, 800);
  await night(false);
  await settle(page, 600);
  await page.screenshot({ path: `${SHOTS}/04_cad-beside-the-app-day.png` });
  await night(true);
  await settle(page, 600);
  await page.screenshot({ path: `${SHOTS}/05_cad-beside-the-app-night.png` });
  await night(false);
});

test("the app's part changes: Refresh takes the new model; cut the wire and it keeps it, unlinked", async () => {
  const before = await page.evaluate((id) => ((window as unknown as { __foundationBoard: () => { doc: import("yjs").Doc } }).__foundationBoard().doc.getMap("objects").get(id) as { fileId: string }).fileId, hub);
  models.hub = box(40, 40, 30);
  await card(hub).locator(".cad-feed-refresh").click();
  await expect
    .poll(() => page.evaluate((id) => ((window as unknown as { __foundationBoard: () => { doc: import("yjs").Doc } }).__foundationBoard().doc.getMap("objects").get(id) as { fileId: string }).fileId, hub), { timeout: 15_000 })
    .not.toBe(before);
  // the wire off: an orphan, saying so, with no Refresh
  await tool("disconnect", { to_panel: hub, from_panel: app, confirm: true });
  await expect(card(hub).locator(".cad-feed-source, .cad-feed-meta").first()).toBeVisible();
  await expect(card(hub)).toContainText(/Unlinked/);
  await expect(card(hub).locator(".cad-feed-refresh")).toHaveCount(0);
  const r = await ctx.request.post(`${CLIENT}/api/boards/${encodeURIComponent(board)}/cad/${hub}/refresh`);
  expect(r.status()).toBe(409);
  await settle(page, 400);
  await page.screenshot({ path: `${SHOTS}/06_cad-unlinked-keeps-its-model-day.png` });
});

/**
 * The grid behind the grid (2026-11-26): the agents' work trail, with two of T3's agents working in one section at once.
 * T3 is the stand-in (playwright.config.ts): a thread reads the board, asks concurrent_work who else is at work, writes
 * two files in its folder, fails a read, then makes a note in its section, through Foundation's MCP as its crew member.
 *
 * Ada starts T3 and asks Claude twice in “Depot”. Then:
 * - "See their work" opens the trail: both agents' run cards, Depot as a section card with two at once, each agent's
 *   folder with its files by name, the wire-less layout, each run's last steps with how long they took;
 * - following one hangs its chain under Depot: Ada asked, so she sees what each tool was given and answered;
 * - Kai, a member who didn't ask, sees the same shape but none of the arguments or answers;
 * - the trail reads only (the board doesn't change while it's open), and Esc goes back;
 * - day and night.
 */

import { test, expect, type Page } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-26_work-trail";
let ada: Page;
let kai: Page;
let board = "";
let depot = "";

test.describe.configure({ mode: "serial" });

const sectionId = (p: Page, name: string) =>
  p.evaluate((n) => {
    const st = (window as unknown as { __foundation: { getState(): { allSections: Record<string, { id: string; name: string }> } } }).__foundation.getState();
    return Object.values(st.allSections).find((s) => s.name === n)?.id ?? null;
  }, name);

/** day or night through the side menu's orb, as council.spec.ts does, settled before a picture */
async function look(p: Page, night: boolean) {
  for (let i = 0; i < 2 && (await p.evaluate(() => document.documentElement.classList.contains("is-night"))) !== night; i++) {
    const orb = p.locator(".side-pane .night-orb").first();
    const folded = !(await orb.isVisible());
    if (folded) await p.locator(".pane-fold").click();
    await orb.click();
    if (folded) await p.locator(".pane-fold").click();
    await settle(p, 200);
  }
  await expect.poll(() => p.evaluate(() => document.documentElement.classList.contains("is-night")), { timeout: 5000 }).toBe(night);
  await expect.poll(() => p.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--night"))), { timeout: 5000 }).toBe(night ? 1 : 0);
  await settle(p, 300);
}

test.beforeAll(async ({ browser }) => {
  const boot = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await boot.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Work trail ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  await boot.context.close();
  ada = (await person(browser, "Ada Test", "ada@normal.dev", board)).page;
  kai = (await person(browser, "Kai Test", "kai@normal.dev", board)).page;
  await look(ada, false);
});

test.afterAll(async () => {
  await ada?.context().request.post(`${CLIENT}/api/t3host/stop`, { failOnStatusCode: false });
});

test("two of T3's agents in one section: the trail shows each one's way, steps, files and the section they share", async () => {
  // the grid's first section is Depot
  const first = await ada.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { allSections: Record<string, unknown> } } }).__foundation.getState().allSections)[0]);
  const renamed = await ada.context().request.post(`${CLIENT}/api/boards/${board}/tools/rename_section`, { data: { section: first, name: "Depot" } });
  expect(renamed.ok(), await renamed.text()).toBeTruthy();
  depot = (await expect.poll(() => sectionId(ada, "Depot"), { timeout: 10_000 }).not.toBeNull().then(() => sectionId(ada, "Depot")))!;

  // T3, started by a person; then Claude, asked twice in Depot
  const r1 = await ada.context().request.post(`${CLIENT}/api/t3host/start`);
  expect(r1.ok()).toBeTruthy();
  const ready = async () => ((await (await ada.context().request.get(`${CLIENT}/api/t3host`)).json()) as { agents: Array<{ id: string; boardTools?: boolean }> }).agents.some((a) => a.id === "claudeAgent" && a.boardTools);
  await expect.poll(ready, { timeout: 30_000 }).toBe(true);
  for (const text of ["Reconcile the unit prices with the supplier list, and keep going", "Check the parts against the BOM, and keep going"]) {
    const res = await ada.context().request.post(`${CLIENT}/api/t3host/threads`, { data: { board, section: depot, agent: "claudeAgent", model: "claude-haiku-4-5", text } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  // the trail, from the agents pane's T3 block
  await ada.locator("[data-hud-agents]").click();
  await ada.locator("[data-t3-trail]").first().click();
  const trail = ada.locator("[data-trail]");
  await expect(trail).toBeVisible();
  await expect(trail.locator("[data-trail-run]")).toHaveCount(2, { timeout: 10_000 });
  await expect(trail.locator('[data-trail-run="Claude"]')).toHaveAttribute("data-trail-kind", "t3");
  await expect(trail.locator('[data-trail-run="Claude 2"]')).toBeVisible();
  // Depot: both are in it, writing at once
  const node = trail.locator('[data-trail-node="Depot"]');
  await expect(node).toBeVisible();
  await expect(node).toHaveClass(/is-contested/, { timeout: 15_000 });
  await expect(node).toContainText("Two at once");
  await expect(trail.locator("[data-trail-sum]")).toContainText("2 agents at work");
  // each one's folder, with its files by name; never the pass file
  await expect(trail.locator('[data-trail-node="Claude\'s folder"]')).toContainText("src/prices.ts", { timeout: 10_000 });
  await expect(trail.locator('[data-trail-node="Claude\'s folder"]')).toContainText("data/suppliers.csv");
  await expect(trail).not.toContainText(".foundation-mcp");
  // its last steps with how long each took, the failed read in its own colour
  const run = trail.locator('[data-trail-run="Claude"]');
  await expect(run.locator(".trail-run-tools li")).toHaveCount(4, { timeout: 10_000 });
  await expect(run.locator(".trail-run-tools li.is-bad")).toHaveCount(1);
  await settle(ada, 900);
  await ada.screenshot({ path: `${SHOTS}/02_two-t3-agents-one-section-day.png` });

  // follow one: its chain under Depot, and (Ada asked) what each tool was given and answered
  await run.locator(".trail-run-head").click();
  await expect(trail).toHaveAttribute("data-trail-focus", /.+/);
  const chain = trail.locator('[data-trail-chain="Claude"]');
  await expect(chain).toBeVisible();
  await expect.poll(async () => chain.locator('[data-trail-capsule="tool"]').count()).toBeGreaterThanOrEqual(4);
  await expect(chain.locator(".trail-capsule-args").first()).toBeVisible();
  await expect(chain).toContainText("Failed:");
  await settle(ada, 900);
  await ada.screenshot({ path: `${SHOTS}/03_following-claude-chain-day.png` });

  // the trail only reads: the board's document doesn't change while it's open, beyond the agents' own notes
  const before = await ada.evaluate(() => document.querySelectorAll(".section-card").length);
  await ada.keyboard.press("Escape");
  await expect(trail).toHaveCount(0);
  expect(await ada.evaluate(() => document.querySelectorAll(".section-card").length)).toBe(before);
});

test("someone who didn't ask sees where they work, not what their tools were given or answered", async () => {
  const res = await kai.context().request.get(`${CLIENT}/api/boards/${board}/trail`);
  expect(res.ok()).toBeTruthy();
  const { lanes } = (await res.json()) as { lanes: Array<{ name: string; mine: boolean; steps: Array<{ input?: unknown; summary?: unknown; kind: string }>; files: unknown[] }> };
  expect(lanes.length).toBe(2);
  for (const l of lanes) {
    expect(l.mine).toBe(false);
    expect(l.steps.length).toBeGreaterThan(0);
    expect(l.steps.every((s) => s.input === undefined && s.summary === undefined && s.kind === "tool")).toBe(true);
  }
  // a board nobody let him see is not there at all
  const none = await kai.context().request.get(`${CLIENT}/api/boards/not-a-board/trail`, { failOnStatusCode: false });
  expect(none.status()).toBe(404);
});

test("at night", async () => {
  await look(ada, true);
  if (!(await ada.locator("[data-t3-trail]").count())) await ada.locator("[data-hud-agents]").click();
  await ada.locator("[data-t3-trail]").first().click();
  const trail = ada.locator("[data-trail]");
  await expect(trail.locator("[data-trail-run]")).toHaveCount(2, { timeout: 10_000 });
  await trail.locator('[data-trail-run="Claude 2"] .trail-run-head').click();
  await settle(ada, 1200);
  await ada.screenshot({ path: `${SHOTS}/04_following-claude-2-night.png` });
  await ada.keyboard.press("Escape");
});

test("#/design shows the grid behind the grid, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-design-trail]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator("[data-trail-run]")).toHaveCount(3);
    await expect(demo.locator('[data-trail-chain="Kimi"] [data-trail-capsule]')).toHaveCount(7);
    await expect(demo.locator('[data-trail-node="Unit prices"]')).toHaveClass(/is-contested/);
    await expect(demo.locator('[data-trail-node="Kimi\'s folder"]')).toContainText("src/reconcile.ts");
    await settle(p, 1200);
    await demo.screenshot({ path: `${SHOTS}/05_design-${scheme === "dark" ? "night" : "day"}.png` });
    await ctx.close();
  }
});

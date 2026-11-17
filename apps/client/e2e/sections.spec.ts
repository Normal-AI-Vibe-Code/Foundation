/**
 * Moving and splitting sections on the seeded company board, checked for
 * what would look wrong after each step (helpers.layoutProblems) and
 * photographed for a person to look over.
 */

import { test, expect, type Page } from "@playwright/test";
import { CLIENT, frame, holes, layoutProblems, person, sectionBox, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-03_sections";
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  ({ page } = await person(browser, "Ada Test", "ada@normal.dev"));
  await frame(page, "all");
});

async function expectClean(label: string) {
  const p = await layoutProblems(page);
  await page.screenshot({ path: `${SHOTS}/${label}.png` });
  expect(p, label).toEqual({ cellClash: [], overlap: [], spill: [], offGrid: [], clipped: [] });
}

async function tool(section: string, label: string) {
  const box = await sectionBox(page, section);
  await page.mouse.move(box.x + 40, box.y + 6);
  await page.locator(`.section-card[data-section-id="${box.id}"] [aria-label="${label}"]`).click();
  await settle(page, 1200);
}

/** a move must not leave more empty cells behind than there were */
async function drag(section: string, to: { x: number; y: number }, shot?: string) {
  const before = await holes(page);
  const box = await sectionBox(page, section);
  const from = { x: box.x + 18, y: box.y + 4 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await settle(page, 250);
  if (shot) await page.screenshot({ path: `${SHOTS}/${shot}.png` });
  await page.mouse.up();
  await settle(page, 1200);
  expect(await holes(page), `empty cells after moving ${section}`).toBeLessThanOrEqual(before);
}

test("the seeded board starts clean", async () => {
  await expectClean("00_board");
});

test("splitting a section of cards into two columns", async () => {
  await frame(page, "all");
  await tool("Design", "Split into two columns");
  await frame(page, "all");
  await expectClean("01_split-design-columns");
});

test("splitting an app section into two rows", async () => {
  await tool("Vision", "Split into two rows");
  await frame(page, "all");
  await expectClean("02_split-vision-rows");
});

test("dragging a section onto another swaps them", async () => {
  const target = await sectionBox(page, "Design");
  await drag("Section 2", { x: target.x + target.width / 2, y: target.y + target.height / 2 }, "03a_drag-over-design");
  await frame(page, "all");
  await expectClean("03b_swapped");
});

test("dragging a section past the board's edge appends it along that side", async () => {
  const grid = await page.locator(".grid-frame").boundingBox();
  await drag("Asks & agents", { x: grid!.x + grid!.width + 60, y: grid!.y + grid!.height / 2 }, "04a_drag-past-right-edge");
  await frame(page, "all");
  await expectClean("04b_appended-right");
});

test("dragging onto an empty cell after a split", async () => {
  await tool("Creation", "Split into two columns");
  await frame(page, "all");
  const empty = page.locator(".empty-cell").first();
  if ((await empty.count()) === 0) test.skip(true, "no empty cell to drop on");
  const e = (await empty.boundingBox())!;
  await drag("FactoryForm", { x: e.x + e.width / 2, y: e.y + e.height / 2 }, "05a_drag-to-empty");
  await frame(page, "all");
  await expectClean("05b_moved-to-empty");
});

test("the design page shows the HUD with talk, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const hud = p.locator(".oncall-hud").first();
    await hud.scrollIntoViewIfNeeded();
    await settle(p, 600);
    await p.locator(".oncall-row").first().screenshot({ path: `${SHOTS}/09_design-hud-${scheme}.png` });
    await ctx.close();
  }
});

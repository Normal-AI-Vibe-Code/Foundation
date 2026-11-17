/**
 * Today in the top bar's left corner (2026-11-17, Josh: "please move the today over to the top left"): it is the
 * first thing in the bar, before the side menu's fold and the tabs, with the menu open (the fold at the menu's
 * right edge) and folded; it still takes you to Today. Day and night.
 */
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_today-top-left";

async function boxes(p: Page) {
  const box = async (sel: string) => (await p.locator(sel).first().boundingBox())!;
  return { today: await box(".top-bar [data-top-today]"), fold: await box(".top-bar .pane-fold"), tabs: await box(".top-bar .tabs") };
}

test("Today is the top bar's first thing, in the left corner, with the side menu open and folded; day and night", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["dark", "light"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/?board=company");
    await waitLive(p);
    await settle(p, 900);
    const name = scheme === "dark" ? "night" : "day";

    // the side menu open: Today in the corner, the fold at the menu's right edge, then the tabs
    if (!(await p.locator(".side-pane").isVisible())) await p.locator(".top-bar .pane-fold").click();
    await expect(p.locator(".side-pane")).toBeVisible();
    await settle(p, 500);
    let b = await boxes(p);
    expect(b.today.x, "Today in the left corner").toBeLessThan(40);
    expect(b.today.x + b.today.width).toBeLessThanOrEqual(b.fold.x);
    expect(b.fold.x + b.fold.width).toBeLessThanOrEqual(b.tabs.x);
    expect(await p.locator(".top-bar .top-tools [data-top-today]").count(), "no longer at the right end").toBe(0);
    await p.screenshot({ path: `${SHOTS}/01_menu-open-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 260 } });

    // folded: Today, the fold, the tabs, left to right
    await p.locator(".top-bar .pane-fold").click();
    await expect(p.locator(".side-pane")).toHaveCount(0);
    await settle(p, 500);
    b = await boxes(p);
    expect(b.today.x).toBeLessThan(40);
    expect(b.today.x + b.today.width).toBeLessThanOrEqual(b.fold.x);
    expect(b.fold.x + b.fold.width).toBeLessThanOrEqual(b.tabs.x);
    await p.screenshot({ path: `${SHOTS}/02_menu-folded-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 260 } });

    // it still goes to Today
    await p.locator(".top-bar [data-top-today]").click();
    await expect(p.locator(".today")).toBeVisible();
    await expect(p.locator(".top-bar [data-top-today]")).toHaveClass(/is-on/);
    await settle(p, 900);
    await p.screenshot({ path: `${SHOTS}/03_on-today-${name}.png` });
    await c.close();
  }
});

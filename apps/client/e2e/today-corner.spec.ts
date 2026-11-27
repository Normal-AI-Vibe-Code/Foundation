/**
 * Today in the top bar's left corner (2026-11-17, Josh: "please move the today over to the top left"): it is the
 * first thing in the bar, before the side menu's fold and the tabs, with the menu open (the fold at the menu's
 * right edge) and folded; it still takes you to Today. Day and night. Since 2026-11-26 the bell (what was said to me)
 * sits right against it, one pair, menu open or folded and at every Mac menu width ("right now it's a bit floating").
 */
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { CLIENT, settle, waitLive } from "./helpers";

// 2026-11-26: the bell joined Today as one pair; the shots now show the pair (the 2026-11-17 set is kept as it was)
const SHOTS = "../../docs/evidence/2026-11-26_today-notices/corner";
const MAC_SHOTS = "../../docs/evidence/2026-11-24_mac-corner";

async function boxes(p: Page) {
  const box = async (sel: string) => (await p.locator(sel).first().boundingBox())!;
  return { today: await box(".top-bar [data-top-today]"), bell: await box(".top-bar [data-top-bell]"), fold: await box(".top-bar .pane-fold"), tabs: await box(".top-bar .tabs") };
}
type Box = { x: number; y: number; width: number; height: number };
/** the bell right against Today (2026-11-26, Josh: it was "a bit floating"): beside it, on its line, nothing between */
function pairHolds(b: { today: Box; bell: Box; fold: Box }, where: string) {
  const gap = b.bell.x - (b.today.x + b.today.width);
  expect(gap, `${where}: the bell right after Today`).toBeGreaterThanOrEqual(0);
  expect(gap, `${where}: the bell not drifting off Today`).toBeLessThanOrEqual(8);
  expect(Math.abs(b.bell.y + b.bell.height / 2 - (b.today.y + b.today.height / 2)), `${where}: on Today's line`).toBeLessThanOrEqual(1);
  expect(b.bell.x + b.bell.width, `${where}: before the fold`).toBeLessThanOrEqual(b.fold.x);
}

test("Today is the top bar's first thing, in the left corner, with the side menu open and folded; day and night", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(MAC_SHOTS, { recursive: true });
  for (const scheme of ["dark", "light"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/?board=company");
    await waitLive(p);
    await expect(p.locator(".top-bar [data-top-bell]")).toBeVisible({ timeout: 30_000 });
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
    pairHolds(b, "menu open");
    await expect(p.locator(".top-bar [data-top-today-pair] [data-top-bell]")).toHaveCount(1);
    await p.screenshot({ path: `${SHOTS}/01_menu-open-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 260 } });

    // folded: Today, the fold, the tabs, left to right
    await p.locator(".top-bar .pane-fold").click();
    await expect(p.locator(".side-pane")).toHaveCount(0);
    await settle(p, 500);
    b = await boxes(p);
    expect(b.today.x).toBeLessThan(40);
    expect(b.today.x + b.today.width).toBeLessThanOrEqual(b.fold.x);
    expect(b.fold.x + b.fold.width).toBeLessThanOrEqual(b.tabs.x);
    pairHolds(b, "menu folded");
    await p.screenshot({ path: `${SHOTS}/02_menu-folded-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 260 } });

    // a Mac's window (2026-11-24, Josh: "the tabs are too far out on mac and should be brought back to that panel
    // line"): the lights take the corner, and the group's line still lands on the menu's edge at every width
    await p.locator(".top-bar .pane-fold").click();
    await expect(p.locator(".side-pane")).toBeVisible();
    await settle(p, 500); // the menu slides in: measured mid-slide, its edge is still moving
    await p.evaluate(() => document.documentElement.classList.add("is-desktop", "is-mac"));
    for (const w of [220, 272, 340, 420]) {
      const m = await p.evaluate(async (w) => {
        const tl = document.querySelector<HTMLElement>(".top-left")!;
        const pane = document.querySelector<HTMLElement>("aside.side-pane")!;
        tl.style.setProperty("--pane-w", `${w}px`);
        pane.style.width = `${w}px`;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return { line: tl.getBoundingClientRect().right + 4, edge: pane.getBoundingClientRect().right, today: r(".top-left [data-top-today]"), bell: r(".top-left [data-top-bell]"), fold: r(".top-left .pane-fold") };
      }, w);
      expect(Math.abs(m.line - m.edge), `${w}px menu: the line on its edge`).toBeLessThanOrEqual(1);
      expect(m.fold.right, `${w}px menu: the fold inside it`).toBeLessThanOrEqual(m.edge);
      expect(m.today.left, `${w}px menu: Today clear of the lights`).toBeGreaterThanOrEqual(80);
      expect(m.bell.left - m.today.right, `${w}px menu: the bell right against Today`).toBeLessThanOrEqual(8);
      expect(m.bell.right, `${w}px menu: the bell before the fold`).toBeLessThanOrEqual(m.fold.left);
    }
    await expect(p.locator(".top-bar [data-top-bell]")).toHaveAccessibleName(/Notifications/);
    await p.screenshot({ path: `${MAC_SHOTS}/mac-menu-420-${name}.png`, clip: { x: 0, y: 0, width: 720, height: 160 } });
    await p.evaluate(() => document.documentElement.classList.remove("is-desktop", "is-mac"));

    // it still goes to Today
    await p.locator(".top-bar [data-top-today]").click();
    await expect(p.locator(".today")).toBeVisible();
    await expect(p.locator(".top-bar [data-top-today]")).toHaveClass(/is-on/);
    await settle(p, 900);
    await p.screenshot({ path: `${SHOTS}/03_on-today-${name}.png` });
    await c.close();
  }
});

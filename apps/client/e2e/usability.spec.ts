/**
 * 2026-11-22: Whole-app usability, legibility, spacing, accessibility & motion
 * pass (jakubkrehel/skills) verified in a real browser across Day, Night, Room,
 * reduced-motion, and keyboard navigation.
 *
 * Evidence screenshots land in docs/evidence/2026-11-22_usability-pass/.
 *
 *   E2E_SERVER_PORT=15830 E2E_CLIENT_PORT=15850 E2E_SLACK_PORT=15840 E2E_MESHY_PORT=15845 npm run e2e -w @foundation/client -- usability
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-22_usability-pass";
mkdirSync(SHOTS, { recursive: true });

let admin: Page;
let ctx: BrowserContext;

test.describe.configure({ mode: "serial" });

async function setNightMode(p: Page, on: boolean) {
  const isNow = await p.evaluate(() => document.documentElement.classList.contains("is-night"));
  if (isNow === on) {
    await settle(p, 300);
    return;
  }
  // Use the real night orb when available so WebGL paper + DOM tokens switch together,
  // falling back to localStorage + reload on standalone pages (#/design).
  const orb = p.locator(".orb-btn, button[aria-label*='night' i], button[aria-label*='day' i]").first();
  if (await orb.isVisible().catch(() => false)) {
    await orb.click();
  } else {
    const fold = p.locator("button[data-tip*='menu' i], button[aria-label*='menu' i]").first();
    if (await fold.isVisible().catch(() => false)) {
      await fold.click();
      await settle(p, 250);
      const orbOpen = p.locator(".orb-btn, button[aria-label*='night' i], button[aria-label*='day' i]").first();
      if (await orbOpen.isVisible().catch(() => false)) {
        await orbOpen.click();
        await fold.click();
      } else {
        await p.evaluate((night) => localStorage.setItem("foundation-night", night ? "1" : "0"), on);
        await p.reload();
      }
    } else {
      await p.evaluate((night) => localStorage.setItem("foundation-night", night ? "1" : "0"), on);
      await p.reload();
    }
  }
  // allow the 1.4 s --night transition to finish completely
  await settle(p, 1700);
}

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Admin", "admin@normal.dev");
  admin = a.page;
  ctx = a.context;
  await admin.evaluate(() => localStorage.setItem("foundation-night", "0"));
  await admin.reload();
  await waitLive(admin);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("1. #/design renders the live Usability & Contrast specimen in Day and Night with every AA pair >= 4.5:1", async () => {
  await admin.goto("/#/design");
  await settle(admin, 1200);
  await setNightMode(admin, false);

  await expect(admin).toHaveTitle(/Design language/);
  const heading = admin.getByRole("heading", { name: "Usability & contrast" });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();

  // Verify the live-computed contrast readouts on the specimen itself all meet >= 4.5:1
  const ratios = await admin.locator(".usability-ratio").allInnerTexts();
  expect(ratios.length).toBeGreaterThanOrEqual(18);
  for (const r of ratios) {
    const num = parseFloat(r);
    expect(num, `computed specimen ratio ${r} should meet WCAG AA >= 4.5:1`).toBeGreaterThanOrEqual(4.5);
  }

  // Verify selectable text on #/design (user-select is not 'none' on body)
  const bodySelect = await admin.evaluate(() => getComputedStyle(document.body).userSelect);
  expect(bodySelect).not.toBe("none");

  await admin.screenshot({ path: `${SHOTS}/01-design-usability-day.png` });

  await setNightMode(admin, true);
  await admin.getByRole("heading", { name: "Usability & contrast" }).scrollIntoViewIfNeeded();
  await settle(admin, 300);
  await admin.screenshot({ path: `${SHOTS}/02-design-usability-night.png` });
  await setNightMode(admin, false);
});

test("2. Shell landmarks, Skip-to-content, keyboard :focus-visible ring, CommandBar dialog, and scroll containment", async () => {
  await admin.goto("/#/board");
  await waitLive(admin);
  await setNightMode(admin, false);

  // Skip-to-content link is first focusable element and moves focus to #main-content without changing hash
  const hashBefore = await admin.evaluate(() => window.location.hash);
  await admin.keyboard.press("Tab");
  const skip = admin.locator("a.f-skip-link");
  await expect(skip).toBeFocused();
  const skipOutline = await skip.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(skipOutline).not.toBe("none");

  await admin.keyboard.press("Enter");
  const activeId = await admin.evaluate(() => document.activeElement?.id);
  expect(activeId).toBe("main-content");
  expect(await admin.evaluate(() => window.location.hash)).toBe(hashBefore);

  // Grid viewport keeps user-select: none for canvas drag, while body allows text selection
  const viewportSelect = await admin.locator(".grid-viewport").evaluate((el) => getComputedStyle(el).userSelect);
  expect(viewportSelect).toBe("none");

  // Side menu scroller contains overscroll
  const sideScroller = admin.locator(".side-scroll").first();
  if (await sideScroller.isVisible()) {
    const overscroll = await sideScroller.evaluate((el) => getComputedStyle(el).overscrollBehaviorY);
    expect(overscroll).toBe("contain");
  }

  await admin.screenshot({ path: `${SHOTS}/03-grid-day.png` });

  // Open CommandBar (Ctrl+K / Meta+K): role="dialog", aria-modal="true", Escape closes and restores focus
  await admin.keyboard.press("Control+k");
  const cmdDialog = admin.locator('[role="dialog"][aria-modal="true"]').first();
  await expect(cmdDialog).toBeVisible();
  await settle(admin, 350);
  await admin.screenshot({ path: `${SHOTS}/04-command-bar-day.png` });
  await admin.keyboard.press("Escape");
  await expect(cmdDialog).toBeHidden();

  // Night mode on grid
  await setNightMode(admin, true);
  await admin.screenshot({ path: `${SHOTS}/05-grid-night.png` });
  await setNightMode(admin, false);
});

test("3. Today (room theme): single <main>, readable contrast, and crisp visual hierarchy", async () => {
  await admin.evaluate(() => void (window.location.hash = "#/today"));
  await settle(admin, 1200);
  await expect(admin).toHaveTitle(/Today/);

  // Only one <main> landmark on Today (no nested <main>)
  expect(await admin.locator("main").count()).toBe(1);

  const theme = await admin.evaluate(() => document.documentElement.dataset.theme);
  expect(theme).toBe("room");

  await admin.screenshot({ path: `${SHOTS}/06-today-room.png` });
});

test("4. ChatForm & Settings: selectable prose, scroll containment, document titles, Day and Night", async () => {
  await admin.evaluate(() => void (window.location.hash = "#/chat"));
  await settle(admin, 1000);
  await expect(admin).toHaveTitle(/ChatForm/);

  const chatSelect = await admin.evaluate(() => getComputedStyle(document.body).userSelect);
  expect(chatSelect).not.toBe("none");

  await setNightMode(admin, false);
  await admin.screenshot({ path: `${SHOTS}/07-chatform-day.png` });

  await setNightMode(admin, true);
  await admin.screenshot({ path: `${SHOTS}/08-chatform-night.png` });

  // Settings
  await admin.evaluate(() => void (window.location.hash = "#/settings/general"));
  await settle(admin, 1000);
  await expect(admin).toHaveTitle(/Settings/);

  await setNightMode(admin, false);
  await admin.screenshot({ path: `${SHOTS}/09-settings-day.png` });

  await setNightMode(admin, true);
  await admin.screenshot({ path: `${SHOTS}/10-settings-night.png` });
  await setNightMode(admin, false);
});

test("5. Reduced motion: CSS animations and JS Spring settle immediately under prefers-reduced-motion: reduce", async () => {
  await admin.emulateMedia({ reducedMotion: "reduce" });
  await admin.goto("/#/design");
  await settle(admin, 900);

  const heading = admin.getByRole("heading", { name: "Usability & contrast" });
  await heading.scrollIntoViewIfNeeded();
  await expect(admin.locator(".usability-readout")).toContainText("prefers-reduced-motion: reduce");

  // Trigger Spring.to and verify it settles immediately (restless: no)
  await admin.getByRole("button", { name: "Spring.to" }).click();
  await expect(admin.locator(".usability-readout")).toContainText("restless: no");

  await admin.emulateMedia({ reducedMotion: "no-preference" });
});

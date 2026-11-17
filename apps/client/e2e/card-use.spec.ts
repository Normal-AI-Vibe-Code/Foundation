/**
 * No card takes the wheel (Josh, 2026-11-11: "Don't allow any of the objects
 * to take over scroll, give them a ctrl keyboard command to interact with
 * them, and allow them to be fullscreened"). lib/cardUse.ts.
 *
 *   - the wheel over a live app pans the grid, and a plain click doesn't hand it the wheel
 *   - Ctrl-click puts it in use: the wheel goes to the app, the grid stays still
 *   - panning elsewhere, or Esc, gives the wheel back
 *   - Ctrl+Enter opens it full screen: the same frame (no reload) fills the window; Esc returns
 */

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = `../../docs/evidence/2026-11-11_heavy-board`;

test("a live app never takes the wheel until it's put in use; Ctrl+Enter is full screen", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Use ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool = (name: string, data: object) => context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
  await tool("add_section", { name: "Apps" });
  await tool("add_note", { section: "Apps", title: "First", markdown: "A note so the app is a card, not the section's app" });
  await tool("add_panel", { section: "Apps", panel: "app", name: "Live", url: `${CLIENT}/e2e/frame.html` });
  await page.goto(`/?board=${board}`);
  await page.waitForFunction(() => Object.keys((window as unknown as { __foundation: { getState(): { panels: object } } }).__foundation.getState().panels).length > 0);
  // frame the app at full size, so its frame mounts
  await page.evaluate(() => {
    const f = (window as unknown as { __foundation: { getState(): { panels: Record<string, { id: string }> }; setState(p: object): void } }).__foundation;
    const id = Object.values(f.getState().panels)[0].id;
    f.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } });
  });
  const frame = page.locator(".live-frame iframe");
  await expect(frame).toHaveCount(1, { timeout: 15_000 });
  await settle(page, 1200);
  const box = (await page.locator(".live-frame").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const camera = () => page.evaluate(() => document.querySelector<HTMLElement>(".world")!.style.transform);
  let loads = 0;
  await frame.evaluate((f) => f.addEventListener("load", () => ((window as unknown as { __loads: number }).__loads = ((window as unknown as { __loads?: number }).__loads ?? 0) + 1)));

  // the wheel over the app pans the grid
  await page.mouse.move(cx, cy);
  let before = await camera();
  await page.mouse.wheel(0, 120);
  await settle(page, 300);
  expect(await camera()).not.toBe(before);

  // a plain click selects; the wheel is still the grid's
  await page.mouse.click(cx, cy);
  before = await camera();
  await page.mouse.wheel(0, 120);
  await settle(page, 300);
  expect(await camera()).not.toBe(before);
  await expect(page.locator(".live-frame.is-engaged")).toHaveCount(0);

  // Ctrl-click (⌘-click on a Mac): in use, the wheel goes to the app and the grid stays where it is
  const box2 = (await page.locator(".live-frame").boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("ControlOrMeta");
  await expect(page.locator(".live-frame.is-engaged")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/card-in-use.png` });
  before = await camera();
  await page.mouse.wheel(0, 120);
  await settle(page, 300);
  expect(await camera()).toBe(before);

  // Esc gives it back
  await page.keyboard.press("Escape");
  await expect(page.locator(".live-frame.is-engaged")).toHaveCount(0);
  before = await camera();
  await page.mouse.wheel(0, 120);
  await settle(page, 300);
  expect(await camera()).not.toBe(before);

  // Ctrl+Enter with the pointer on it: full screen, the same frame, not reloaded
  const box3 = (await page.locator(".live-frame").boundingBox())!;
  await page.mouse.move(box3.x + box3.width / 2, box3.y + box3.height / 2);
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.waitForFunction(() => !!document.fullscreenElement);
  const fs = await page.evaluate(() => {
    const el = document.fullscreenElement as HTMLElement;
    const r = el.getBoundingClientRect();
    const f = el.querySelector("iframe")!.getBoundingClientRect();
    return { cls: el.className, w: Math.round(r.width), h: Math.round(r.height), fw: Math.round(f.width), fh: Math.round(f.height), vw: innerWidth, vh: innerHeight, bar: !!el.querySelector(".fs-bar"), pe: getComputedStyle(el.querySelector("iframe")!).pointerEvents };
  });
  expect(fs.cls).toContain("fs-able");
  expect(fs.bar).toBe(true);
  expect(fs.w).toBe(fs.vw);
  expect(fs.fw).toBe(fs.vw);
  expect(fs.fh).toBeGreaterThan(fs.vh - 60);
  expect(fs.pe).toBe("auto");
  await page.screenshot({ path: `${SHOTS}/card-fullscreen.png` });
  loads = await page.evaluate(() => (window as unknown as { __loads?: number }).__loads ?? 0);
  expect(loads).toBe(0);
  await page.locator(".fs-bar button", { hasText: "Back to the grid" }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await expect(page.locator(".live-frame.is-engaged")).toHaveCount(0);
  await context.close();
});

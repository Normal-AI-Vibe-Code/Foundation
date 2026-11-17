/**
 * A section never takes the wheel (Josh, 2026-11-07: "Scrolling shouldn't be
 * taken over by a section"). It fits its cards to its body, down to 40 %;
 * past that it says how many don't fit and offers Expand, which opens it full-screen as
 * its own grid (2026-11-11), its cards at full size: the wheel pans down through it, Esc goes back up.
 */

import { test, expect, type Page } from "@playwright/test";
import { frame, person, sectionBox, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-07_section-fit";
let page: Page;
const SECTION = "Asks & agents";
const added: string[] = [];

type Win = { __foundation: { getState(): { sections: Record<string, { id: string; name: string }>; notes: Record<string, object> }; setState(p: object): void } };

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  ({ page } = await person(browser, "Ada Test", "ada@normal.dev"));
});

test.afterAll(async () => {
  // leave the board as the other checks expect it
  await page.evaluate((ids) => {
    const f = (window as unknown as Win).__foundation;
    const notes = { ...f.getState().notes } as Record<string, object>;
    for (const id of ids) delete notes[id];
    f.setState({ notes, level: null });
  }, added);
});

const worldTransform = () => page.evaluate(() => document.querySelector<HTMLElement>(".world")!.style.transform);
const contentOf = (id: string) => page.locator(`.section-card[data-section-id="${id}"] .section-content`);

test("a crowded section fits its cards, then clips and offers Expand", async () => {
  const id = await page.evaluate((name) => {
    const f = (window as unknown as Win).__foundation;
    const sec = Object.values(f.getState().sections).find((s) => s.name === name)!;
    const notes = { ...f.getState().notes } as Record<string, object>;
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const id = `note_fit_${i}`;
      ids.push(id);
      notes[id] = { id, sectionId: sec.id, name: `Fit ${i + 1}`, x: 0, y: 0, w: 420, h: 300, float: false, bornAt: Date.now() + i, text: `# Fit ${i + 1}` };
    }
    f.setState({ notes });
    return [sec.id, ids] as const;
  }, SECTION);
  added.push(...id[1]);
  const secId = id[0];
  await frame(page, "section", secId);
  await expect(contentOf(secId)).toHaveAttribute("style", /scale\(0\.4\)/);
  await expect(page.locator(`.section-card[data-section-id="${secId}"] .section-more`)).toContainText(/\d+ more/);
  await page.screenshot({ path: `${SHOTS}/e2e-01-clipped.png` });
});

test("the wheel over a section pans the board; the section's cards don't move", async () => {
  const box = await sectionBox(page, SECTION);
  const content = await contentOf(box.id).getAttribute("style");
  const before = await worldTransform();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 60);
  await settle(page, 400);
  expect(await worldTransform()).not.toBe(before);
  expect(await contentOf(box.id).getAttribute("style")).toBe(content);
});

test("Expand opens the section full-screen as its own grid; the wheel reads down it; Esc goes back up", async () => {
  await frame(page, "section", (await sectionBox(page, SECTION)).id);
  const box = await sectionBox(page, SECTION);
  await page.locator(`.section-card[data-section-id="${box.id}"] .section-more`).click();
  await settle(page, 1400);
  const card = page.locator(`.section-card[data-section-id="${box.id}"]`);
  await expect(card).toHaveClass(/is-open/);
  await expect(contentOf(box.id)).toHaveAttribute("style", /scale\(1\)/);
  await expect(card.locator(".section-more")).toHaveCount(0);
  // the board's other sections aren't in this grid; where you are says so
  await expect(page.locator(".section-card")).toHaveCount(1);
  await expect(page.locator(".level-bar")).toContainText(SECTION);
  // its grid holds everything at full size: far taller than the screen
  const grown = await card.boundingBox();
  expect(grown!.height).toBeGreaterThan(900 * 2);
  await page.screenshot({ path: `${SHOTS}/e2e-02-expanded.png` });

  const before = await worldTransform();
  await page.mouse.move(720, 450);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 80);
  await settle(page, 400);
  expect(await worldTransform()).not.toBe(before);
  await page.screenshot({ path: `${SHOTS}/e2e-03-expanded-wheel-down.png` });

  await page.keyboard.press("Escape");
  await settle(page, 1400);
  await expect(page.locator(".level-bar")).toHaveCount(0);
  await expect(card).not.toHaveClass(/is-open/);
  await expect(contentOf(box.id)).toHaveAttribute("style", /scale\(0\.4\)/);
});

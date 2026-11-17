/**
 * A live page runs only when it's drawn big enough to read (SPEC §5): the
 * gate is the scale it's drawn at, the camera's zoom times its section's fit.
 * Before 2026-11-08 it read the zoom alone, so a page fitted to 40 % in a
 * crowded section ran at zoom 0.5 (drawn at 20 %), and a page mounted at any
 * zoom until the camera first moved.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { CLIENT, person, settle } from "./helpers";

const OUT = process.env.FITTED_OUT ?? "../../docs/evidence/e2e-results";

type Store = {
  getState(): { sections: Record<string, { id: string; name: string }>; panels: Record<string, { id: string; name: string }> };
  sectionFlow(id: string): { fit: number };
  objectWorldRect(o: object): { x: number; y: number; w: number; h: number } | null;
  requestSnap(t: object): void;
};

/** centre the camera on an app card at a zoom, and say whether its page is mounted */
async function liveAt(page: Page, name: string, scale: number): Promise<boolean> {
  await page.evaluate(
    async ({ name, scale }) => {
      const store = (await import(/* @vite-ignore */ `${location.origin}/src/state/store.ts`)) as Store;
      const app = Object.values(store.getState().panels).find((p) => p.name === name)!;
      const r = store.objectWorldRect(app)!;
      const vp = document.querySelector(".grid-viewport")!.getBoundingClientRect();
      store.requestSnap({ kind: "view", scale, x: vp.width / 2 - (r.x + r.w / 2) * scale, y: vp.height / 2 - (r.y + r.h / 2) * scale });
    },
    { name, scale },
  );
  await settle(page, 1800);
  return page.evaluate((name) => {
    const st = (window as unknown as { __foundation: { getState(): { panels: Record<string, { id: string; name: string }> } } }).__foundation.getState();
    const app = Object.values(st.panels).find((p) => p.name === name)!;
    return Boolean(document.querySelector(`[data-obj-id="${app.id}"] iframe`));
  }, name);
}

test("a live page's gate is the scale it's drawn at: zoom × its section's fit", async ({ browser }) => {
  test.skip(Boolean(process.env.E2E_BUILD), "reads the fit through the dev server's store module");
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Fitted ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool = (name: string, data: object) => context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });

  // a roomy section (a note and a page) and a crowded one (the same, then 24 more notes, so it fits them small)
  for (const [section, extra] of [["Roomy", 0], ["Crowded", 24]] as const) {
    await tool("add_section", { name: section });
    await tool("add_note", { section, title: `${section} note`, markdown: "A note first, so the page is a card." });
    await tool("add_panel", { section, panel: "app", name: `${section} page`, url: `${CLIENT}/e2e/frame.html` });
    for (let n = 0; n < extra; n++) await tool("add_note", { section, title: `${section} ${n}`, markdown: `## ${section} ${n}\n\nfiller` });
  }
  await page.goto(`/?board=${board}`);
  await page.waitForFunction(() => Object.keys((window as unknown as { __foundation: { getState(): { notes: object } } }).__foundation.getState().notes).length >= 26, undefined, { timeout: 30_000 });
  await settle(page, 1500);
  const fit = await page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ `${location.origin}/src/state/store.ts`)) as Store;
    const s = Object.values(store.getState().sections).find((x) => x.name === "Crowded")!;
    return store.sectionFlow(s.id).fit;
  });
  expect(fit, "the crowded section fits its cards small").toBeLessThan(0.7);

  // a zoom above the old 0.3 line that draws the crowded page below it. The crowded page is checked there
  // first: once a page has loaded it stays mounted (LiveFrame keeps a loaded frame rather than reload it)
  const low = Math.max(0.32, (0.3 / fit) * 0.85);
  const high = Math.min(1.6, (0.3 / fit) * 1.3);
  const lowCrowded = await liveAt(page, "Crowded page", low);
  await page.screenshot({ path: `${OUT}/crowded-page-at-low-zoom.png` });
  const results = {
    fit: Math.round(fit * 1000) / 1000,
    low: { zoom: Math.round(low * 100) / 100, drawnAt: Math.round(low * fit * 100) / 100, crowded: lowCrowded, roomy: await liveAt(page, "Roomy page", low) },
    high: { zoom: Math.round(high * 100) / 100, drawnAt: Math.round(high * fit * 100) / 100, crowded: await liveAt(page, "Crowded page", high) },
  };
  await page.screenshot({ path: `${OUT}/crowded-page-at-high-zoom.png` });
  writeFileSync(`${OUT}/fitted.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  expect(results.low.crowded, `the crowded page at zoom ${results.low.zoom} is drawn at ${results.low.drawnAt}: a poster`).toBe(false);
  expect(results.low.roomy, "the roomy page at the same zoom runs").toBe(true);
  expect(results.high.crowded, `zoomed to ${results.high.zoom}, the crowded page is drawn at ${results.high.drawnAt}: it runs`).toBe(true);
  await context.close();
});

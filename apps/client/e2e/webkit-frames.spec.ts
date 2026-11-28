/**
 * The Mac's engine held to 60 fps (plan webkit-frames). The Mac app draws in WKWebView: WebKit, which was twenty times
 * slower than Chromium on the same board until 2026-11-24 (SPEC §0.16, docs/evidence/2026-11-24_mac-studio-perf/).
 * frames.spec.ts measures Edge only; this measures Playwright's WebKit on a seeded Character studio: characters and their
 * cards, inspiration pictures, and the set's pipeline of nine nodes joined by wires.
 *
 * Measured as the page's own frames (rAF intervals): at rest, a pan at the opening zoom, zooming out and in, a pan after
 * the zoom, and a pan far out (the board fitted). On a Mac with PERF_GPU it holds them: each measure's p95 within a
 * frame and a half, and long frames (over 25 ms) under a tenth.
 *
 * Elsewhere it records and holds nothing (2026-11-27): Playwright's WebKit on Windows composites the whole page in
 * software on every frame, so a still studio costs ~42 ms a frame there even with every animation loop stopped and
 * nothing changing (a plain page: 16 ms; the studio with its grid hidden: 16 ms; section shadows are half of it). The
 * Mac's WebKit draws unchanged layers for free; it measured 58–60 fps at rest on the Mac's own studio (2026-11-24).
 * Its numbers here are WebKit-on-Windows', not Foundation's.
 *
 *   npx playwright install webkit          (once: WebKit 27.2)
 *   PERF_GPU=1 npm run e2e -w @foundation/client -- webkit-frames
 *
 * Numbers go to docs/evidence/<PERF_OUT or today>_webkit-frames/.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

test.use({ browserName: "webkit" });

const OUT = `../../docs/evidence/${process.env.PERF_OUT ?? `${new Date().toISOString().slice(0, 10)}_webkit-frames`}`;
const MESHY = `http://127.0.0.1:${process.env.E2E_MESHY_PORT ?? "4445"}`;
const W = 1440;
const H = 900;
/** how many characters and inspiration pictures the studio is seeded with (the Mac's had 11 and 30) */
const CHARACTERS = 11;
const PICTURES = 12;
const NAMES = ["Kuro", "Mochi", "Taro", "Hana", "Pip", "Wren", "Sora", "Kai", "Nori", "Yuki", "Ume", "Rin"];

type Result = { label: string; frames: number; fps: number; p50: number; p95: number; max: number; longPct: number };

async function frames(page: Page, label: string, act: () => Promise<void>): Promise<Result> {
  await page.evaluate(() => {
    const w = window as unknown as { __wf: number[]; __wfOn: boolean };
    w.__wf = [];
    w.__wfOn = true;
    let last = performance.now();
    const tick = (now: number) => {
      w.__wf.push(now - last);
      last = now;
      if (w.__wfOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await act();
  const seconds = (Date.now() - t0) / 1000;
  const f = await page.evaluate(() => {
    const w = window as unknown as { __wf: number[]; __wfOn: boolean };
    w.__wfOn = false;
    return w.__wf.slice(1);
  });
  const s = [...f].sort((a, b) => a - b);
  const q = (k: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(k * s.length))] * 10) / 10 : 0);
  const r = { label, frames: s.length, fps: Math.round((s.length / seconds) * 10) / 10, p50: q(0.5), p95: q(0.95), max: q(1), longPct: Math.round((s.filter((x) => x > 25).length / Math.max(1, s.length)) * 1000) / 10 };
  console.log(JSON.stringify(r));
  return r;
}

test("WebKit holds 60 fps on a Character studio: at rest, panning, zooming, and panning far out", async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  // (person() keeps the wheel on pan, as most specs: the zoom below is Ctrl-wheel, a pinch)
  const { context, page } = await person(browser, "Wren WebKit", "wren.webkit@normal.dev");
  await page.setViewportSize({ width: W, height: H });

  // the studio, seeded: pictures to draw from, and characters with their cards
  const made = await context.request.post(`${CLIENT}/api/characters/studio`);
  expect(made.ok(), await made.text()).toBe(true);
  const studio = ((await made.json()) as { id: string }).id;
  const png = await (await context.request.get(`${MESHY}/_png`)).body();
  for (let i = 0; i < PICTURES; i++) {
    const up = await context.request.post(`${CLIENT}/api/boards/${studio}/characters/inspiration?set=Abstract&name=ref-${i}.png`, { headers: { "content-type": "image/png" }, data: png });
    expect(up.ok(), await up.text()).toBe(true);
  }
  for (let i = 0; i < CHARACTERS; i++) {
    const c = await context.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name: NAMES[i], set: "abstract", form: "mesh", identity: `${NAMES[i]} is a small round creature with a ${["red", "blue", "green", "gold"][i % 4]} scarf.`, refs: [], height: 0.6 } });
    expect(c.ok(), await c.text()).toBe(true);
  }

  await page.goto(`/?board=${studio}`);
  await waitLive(page);
  await expect(page.locator("[data-pipe-node]")).not.toHaveCount(0, { timeout: 20_000 });
  await settle(page, 3000);
  await page.mouse.move(W / 2, H / 2);

  const results: Result[] = [];
  const run = async (label: string, act: () => Promise<void>) => results.push(await frames(page, label, act));
  const pan = (n: number, step: number) => async () => {
    for (let i = 0; i < n; i++) {
      await page.mouse.wheel(Math.floor(i / 30) % 2 ? -step : step, Math.floor(i / 45) % 2 ? -step / 2 : step / 2);
      await page.waitForTimeout(16);
    }
  };
  const zoom = async () => {
    await page.keyboard.down("Control");
    for (let i = 0; i < 120; i++) {
      await page.mouse.wheel(0, i < 60 ? 6 : -6);
      await page.waitForTimeout(16);
    }
    await page.keyboard.up("Control");
  };

  await run("at rest (3 s)", () => settle(page, 3000));
  await run("pan at the opening zoom (3 s)", pan(150, 30));
  await run("zoom out and in (2 s)", zoom);
  await settle(page, 800);
  await run("pan after the zoom (3 s)", pan(150, 30));
  await page.screenshot({ path: `${OUT}/studio-rest-night.png` });
  // far out: the whole board fitted
  await page.locator(".grid-viewport").click({ position: { x: 20, y: H - 60 } });
  await page.keyboard.press("0");
  await settle(page, 2000);
  await page.screenshot({ path: `${OUT}/studio-far-night.png` });
  await run("pan far out, the board fitted (3 s)", pan(150, 30));

  writeFileSync(`${OUT}/frames.json`, JSON.stringify({ browser: `${browser.browserType().name()} ${browser.version()}`, viewport: `${W}×${H}`, characters: CHARACTERS, pictures: PICTURES, results }, null, 2));
  for (const r of results) {
    expect(r.frames, `${r.label}: frames drawn`).toBeGreaterThan(20);
    if (process.env.PERF_GPU && process.platform === "darwin") {
      expect(r.p95, `${r.label}: p95 frame`).toBeLessThanOrEqual(25);
      expect(r.longPct, `${r.label}: long frames (%)`).toBeLessThan(10);
    }
  }
  await context.close();
});

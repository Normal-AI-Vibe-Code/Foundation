/**
 * The performance budget (SPEC §5), measured: a board with 200 cards and 20
 * live frames, then pan, zoom and a card drag. Every frame's time is recorded
 * in the page; long tasks are counted; the numbers go to docs/evidence.
 */

import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { CLIENT, person, settle } from "./helpers";

const OUT = process.env.PERF_OUT ?? "../../docs/evidence/2026-11-03_perf";

test("pan, zoom and drag on 200 cards and 20 live frames", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Perf ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool = (name: string, data: object) => context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });

  // 10 sections × (18 notes + 2 live frames) = 180 notes + 20 frames = 200 cards
  for (let s = 0; s < 10; s++) {
    const section = `Area ${s + 1}`;
    await tool("add_section", { name: section });
    const note = (n: number) => tool("add_note", { section, title: `Note ${s}.${n}`, markdown: `## Note ${s}.${n}\n\n- a line of text\n- **another** with \`code\`\n- and a [link](https://example.com)` });
    // a note first (an app in an empty section would become the section's app), then the two apps near the top
    await note(0);
    for (let f = 0; f < 2; f++) await tool("add_panel", { section, panel: "app", name: `Live ${s}.${f}`, url: `${CLIENT}/e2e/frame.html` });
    for (let n = 1; n < 18; n++) await note(n);
  }
  await page.goto(`/?board=${board}`);
  await page.waitForFunction(() => Object.keys((window as unknown as { __foundation: { getState(): { notes: object; panels: object } } }).__foundation.getState().notes).length >= 180, undefined, { timeout: 30_000 });
  await settle(page, 2000);

  // a frame clock and a long-task counter in the page
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __long: number; __rec: boolean };
    w.__frames = [];
    w.__long = 0;
    w.__rec = false;
    let last = performance.now();
    const tick = (t: number) => {
      if (w.__rec) w.__frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => (w.__long += w.__rec ? l.getEntries().length : 0)).observe({ type: "longtask", buffered: false });
  });
  const measure = async (label: string, act: () => Promise<void>) => {
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number; __rec: boolean };
      w.__frames = [];
      w.__long = 0;
      w.__rec = true;
      const renders = (window as unknown as { __renders?: Record<string, number> }).__renders ?? {};
      for (const k of Object.keys(renders)) delete renders[k];
    });
    await act();
    const r = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number; __rec: boolean };
      w.__rec = false;
      return { frames: w.__frames.slice(1), long: w.__long, renders: { ...((window as unknown as { __renders?: Record<string, number> }).__renders ?? {}) } };
    });
    const f = [...r.frames].sort((a, b) => a - b);
    const q = (p: number) => Math.round(f[Math.min(f.length - 1, Math.floor(p * f.length))] * 10) / 10;
    const live = await page.evaluate(() => document.querySelectorAll("iframe").length);

    return { label, frames: f.length, p50: q(0.5), p95: q(0.95), max: q(1), over33: f.filter((x) => x > 33.4).length, longTasks: r.long, liveFramesMounted: live, renders: r.renders };
  };

  const browserHandle = context.browser()!;
  await browserHandle.startTracing(page, { path: `../../docs/evidence/e2e-results/perf-trace.json`, screenshots: false });
  const results = [];
  await page.mouse.move(720, 450);
  results.push(
    await measure("pan (trackpad scroll, 3 s)", async () => {
      for (let i = 0; i < 180; i++) {
        await page.mouse.wheel(i % 60 < 30 ? 18 : -18, i % 90 < 45 ? 10 : -10);
        await page.waitForTimeout(16);
      }
    }),
  );
  results.push(
    await measure("pinch zoom (ctrl + wheel, 3 s)", async () => {
      await page.keyboard.down("Control");
      for (let i = 0; i < 180; i++) {
        await page.mouse.wheel(0, i < 90 ? -6 : 6);
        await page.waitForTimeout(16);
      }
      await page.keyboard.up("Control");
    }),
  );
  // frame one section so its cards are big enough to grab, then drag a note by its bar
  await page.evaluate(() => {
    const f = (window as unknown as { __foundation: { getState(): { notes: Record<string, { id: string; name: string }> }; setState(x: object): void } }).__foundation;
    const n = Object.values(f.getState().notes).find((x) => x.name === "Note 0.0")!;
    f.setState({ snapRequest: { kind: "object", id: n.id, nonce: Math.random() } });
  });
  await settle(page, 1500);
  const note = await page.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { notes: Record<string, { id: string; name: string }> } } }).__foundation.getState().notes).find((x) => x.name === "Note 0.0")!.id);
  const box = (await page.locator(`[data-obj-id="${note}"] .frame-card`).boundingBox())!;
  results.push(
    await measure("drag a card (2 s)", async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + 12);
      await page.waitForTimeout(250); // the bar drops in
      await page.mouse.down();
      for (let i = 0; i < 120; i++) {
        await page.mouse.move(box.x + box.width / 2 + Math.sin(i / 12) * 220, box.y + 12 + Math.cos(i / 15) * 140);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    }),
  );
  // live frames on screen: frame a section at a zoom where its apps run, then pan across the board
  await page.evaluate(() => {
    const f = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> }; setState(x: object): void } }).__foundation;
    const s = Object.values(f.getState().sections).find((x) => x.name === "Area 2")!;
    f.setState({ snapRequest: { kind: "section", id: s.id, nonce: Math.random() } });
  });
  await settle(page, 2500);
  results.push(
    await measure("pan with live frames running (3 s)", async () => {
      for (let i = 0; i < 180; i++) {
        await page.mouse.wheel(i < 90 ? 14 : -14, 0);
        await page.waitForTimeout(16);
      }
    }),
  );
  await browserHandle.stopTracing();

  const summary = {
    when: new Date().toISOString(),
    browser: `${browserHandle.browserType().name()} ${browserHandle.version()} (Playwright, headless)`,
    viewport: "1440×900 @1x",
    board: { notes: 180, liveFrames: 20, sections: 10 },
    results,
    note: "Headless Chromium draws WebGL in software (SwiftShader), so the paper shader costs more here than on a GPU; treat these as an upper bound.",
  };
  writeFileSync(`${OUT}/frames.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary.results, null, 2));
  // the budget, with headless slack: p95 within two frames at 60 fps, no frame longer than 250 ms
  for (const r of results) {
    expect(r.p95, `${r.label} p95`).toBeLessThan(34);
    expect(r.max, `${r.label} longest frame`).toBeLessThan(250);
  }
});

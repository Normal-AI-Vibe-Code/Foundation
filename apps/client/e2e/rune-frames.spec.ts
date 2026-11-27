/**
 * Frame times, Rune beside the web renderer, on this machine's GPU.
 *
 * Two boards, each drawn by each engine in the same browser, window and pixel
 * ratio, through the same camera and the same input:
 *
 *   - 300 notes on one plane (markdown, floating): what Rune draws itself,
 *     where the web renderer has 300 cards of DOM
 *   - the heavy board (heavy-board.json: 27 photos, 4 videos, 15 live apps):
 *     mostly web content, which under Rune is still the web's (islands)
 *
 * and for each: pan and pinch fitted, pan and pinch framed at 100 %, and a
 * note dragged for two seconds. Measured as the page's own frames
 * (requestAnimationFrame intervals: p50, p95, longest, the share over one
 * 60 Hz frame) and Long Animation Frames, and for Rune the frames it drew and
 * the times its view ran. Since 2026-11-27 it holds Rune to the web's frames:
 * each measure's p95 within 4 ms of the web renderer's, and no view runs while
 * only the camera pans (frames.spec.ts holds the web renderer to 60 fps).
 *
 * RUNE_FRAMES_QUICK=1 measures Rune on the 300 notes only and holds nothing;
 * RUNE_FRAMES_PROFILE=1 adds a CPU profile of the fitted pan, heaviest first.
 *
 *   npm run rune:build
 *   PERF_GPU=1 E2E_CLIENT_PORT=15450 npm run e2e -w @foundation/client -- rune-frames
 *
 * Numbers go to docs/evidence/<PERF_OUT or today>_rune-frames/.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CLIENT, FRAME as FRAME_PAGE, settle, waitLive } from "./helpers";

const GPU = !!process.env.PERF_GPU;
const DPR = Number(process.env.PERF_DPR ?? 2);
const W = Number(process.env.PERF_W ?? 1440);
const H = Number(process.env.PERF_H ?? 900);
const OUT = `../../docs/evidence/${process.env.PERF_OUT ?? `${new Date().toISOString().slice(0, 10)}_rune-frames`}`;
const FRAME = 1000 / 60;

test.skip(!GPU, "PERF_GPU=1 runs this headed, on the machine's GPU (Rune needs WebGPU)");
test.skip(!existsSync("public/rune/rune.json"), "the Rune renderer isn't built: npm run rune:build");
test.use({
  headless: false,
  channel: process.env.PERF_CHANNEL ?? "msedge",
  launchOptions: { args: ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] },
});

type Obj = { k: "image" | "video" | "app" | "note" | "table"; x: number; y: number; w?: number; h?: number; px?: [number, number] };
const HEAVY = JSON.parse(readFileSync(new URL("./heavy-board.json", import.meta.url), "utf8")) as { grid: { cols: number[]; rows: number[] }; objects: Obj[] };

/** a frame clock and Long Animation Frames, installed before any page script */
function instrument() {
  const w = window as unknown as { __perf: { rec: boolean; frames: number[]; loaf: number[] } };
  w.__perf = { rec: false, frames: [], loaf: [] };
  let last = performance.now();
  const tick = (t: number) => {
    if (w.__perf.rec) w.__perf.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      if (w.__perf.rec) for (const e of list.getEntries()) w.__perf.loaf.push(e.duration);
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {
    /* no LoAF */
  }
}

type Result = { travel?: number; zoomed?: number; board: string; engine: string; label: string; frames: number; fps: number; p50: number; p95: number; max: number; overPct: number; loaf: number; loafMax: number; runeFrames?: number; runeViews?: number; pushes?: number; scenes?: number };

/** frames Rune has drawn and times its view has run, so far */
const runeCounts = (page: Page) => page.evaluate(() => (window as unknown as { __foundationRune?: { paper(): number[] | null } }).__foundationRune?.paper?.() ?? null);
/** scenes the client built and scenes that changed (rune/host.ts) */
const hostCounts = (page: Page) => page.evaluate(() => (window as unknown as { __foundationRune?: { counts?(): { pushes: number; scenes: number } } }).__foundationRune?.counts?.() ?? null);

async function measure(page: Page, board: string, engine: string, label: string, act: () => Promise<void>): Promise<Result> {
  await page.evaluate(() => {
    const p = (window as unknown as { __perf: { rec: boolean; frames: number[]; loaf: number[] } }).__perf;
    p.frames = [];
    p.loaf = [];
    p.rec = true;
  });
  const before = engine === "rune" ? await runeCounts(page) : null;
  const hostBefore = engine === "rune" ? await hostCounts(page) : null;
  // the path the camera travels while it runs (a pan that goes back and forth ends where it started)
  await page.evaluate(() => {
    const w = window as unknown as { __foundationRune?: { camera: { x: number; y: number; scale: number } }; __travel?: { on: boolean; px: number; zoom: number } };
    const c = w.__foundationRune?.camera;
    if (!c) return;
    const t = (w.__travel = { on: true, px: 0, zoom: 0 });
    let last = { x: c.x, y: c.y, scale: c.scale };
    const step = () => {
      t.px += Math.hypot(c.x - last.x, c.y - last.y);
      t.zoom += Math.abs(Math.log(c.scale / last.scale));
      last = { x: c.x, y: c.y, scale: c.scale };
      if (t.on) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const t0 = Date.now();
  await act();
  const travelled = await page.evaluate(() => {
    const t = (window as unknown as { __travel?: { on: boolean; px: number; zoom: number } }).__travel;
    if (!t) return null;
    t.on = false;
    return { px: Math.round(t.px), zoom: Math.round(t.zoom * 100) / 100 };
  });
  const seconds = (Date.now() - t0) / 1000;
  const after = engine === "rune" ? await runeCounts(page) : null;
  const hostAfter = engine === "rune" ? await hostCounts(page) : null;
  const r = await page.evaluate(() => {
    const p = (window as unknown as { __perf: { rec: boolean; frames: number[]; loaf: number[] } }).__perf;
    p.rec = false;
    return { frames: p.frames.slice(1), loaf: p.loaf };
  });
  const f = [...r.frames].sort((a, b) => a - b);
  const q = (k: number) => (f.length ? Math.round(f[Math.min(f.length - 1, Math.floor(k * f.length))] * 10) / 10 : 0);
  const res: Result = {
    board,
    engine,
    label,
    frames: f.length,
    fps: Math.round((f.length / seconds) * 10) / 10,
    p50: q(0.5),
    p95: q(0.95),
    max: q(1),
    overPct: Math.round((f.filter((x) => x > FRAME * 1.25).length / Math.max(1, f.length)) * 1000) / 10,
    loaf: r.loaf.length,
    loafMax: Math.round(Math.max(0, ...r.loaf)),
  };
  // how far the camera went: a measure that moved nothing measured nothing
  if (travelled) Object.assign(res, { travel: travelled.px, zoomed: travelled.zoom });
  if (before && after) Object.assign(res, { runeFrames: after[4] - before[4], runeViews: after[5] - before[5] });
  if (hostBefore && hostAfter) Object.assign(res, { pushes: hostAfter.pushes - hostBefore.pushes, scenes: hostAfter.scenes - hostBefore.scenes });
  console.log(JSON.stringify(res));
  return res;
}

const NOTE = (i: number) => `## Note ${i + 1}\n\nA line with **strong** words, *emphasis* and \`code\`, long enough to wrap onto a second line of the card.\n\n- one thing\n- another thing\n- a third\n`;

test("frame times: Rune beside the web renderer, on 300 notes and on the heavy board", async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, colorScheme: "dark" });
  const login = await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Frames", email: "ada.frames@normal.dev" } });
  if (!login.ok()) throw new Error(`dev login: ${login.status()}`);
  await context.addInitScript(instrument);
  await context.addInitScript(() => {
    localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
    localStorage.setItem("foundation-night", "1");
  });
  const page = await context.newPage();
  await page.bringToFront();

  /** a new board, filled through the board's own document, then loaded fresh */
  const make = async (name: string, objects: Obj[], text: (i: number) => string) => {
    const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `${name} ${Date.now().toString(36)}` } });
    const board = ((await made.json()) as { id: string }).id;
    await page.goto(`/?board=${board}`);
    await waitLive(page);
    await page.evaluate(
      ({ objects, grid, frame, texts }) => {
        const doc = (window as unknown as { __foundationBoard: () => { doc: { transact(fn: () => void): void; getMap(n: string): { set(k: string, v: unknown): void; keys(): IterableIterator<string>; delete(k: string): void } } } }).__foundationBoard().doc;
        const sections = doc.getMap("sections");
        const objs = doc.getMap("objects");
        doc.transact(() => {
          for (const k of [...sections.keys()]) sections.delete(k);
          for (const k of [...objs.keys()]) objs.delete(k);
          doc.getMap("grid").set("tracks", grid);
          sections.set("plane", { id: "plane", name: "Plane", c0: 0, r0: 0, c1: 0, r1: 0 });
          objects.forEach((o, i) => {
            const base = { id: `o${i}`, sectionId: "plane", name: `${o.k} ${i}`, x: o.x, y: o.y, float: true, bornAt: 1 };
            // (pictures and clips need files: the heavy spec uploads them; here their cards are apps, as live as its)
            if (o.k === "note") objs.set(base.id, { ...base, kind: "note", w: o.w, h: o.h, text: texts[i] });
            else if (o.k !== "table") objs.set(base.id, { ...base, kind: "panel", panel: "app", w: o.w, h: o.h, url: frame, ports: [] });
          });
        });
      },
      { objects, grid: HEAVY.grid, frame: FRAME_PAGE, texts: objects.map((_, i) => text(i)) },
    );
    await settle(page, 2500);
    return board;
  };

  // 300 notes: 25 across, 12 down, on the heavy board's own plane
  const notes: Obj[] = Array.from({ length: 300 }, (_, i) => ({ k: "note", x: 120 + (i % 25) * 610, y: 120 + Math.floor(i / 25) * 420, w: 540, h: 360 }));
  const boards = [
    { name: "300 notes", id: await make("Notes", notes, NOTE), first: 137 },
    { name: "heavy board (56 cards, 15 live apps)", id: await make("Heavy", HEAVY.objects, () => "## A note\n\nSome words on the plane."), first: HEAVY.objects.findIndex((o) => o.k === "note") },
  ];

  const results: Result[] = [];
  const mx = W / 2;
  const my = H / 2;
  // RUNE_FRAMES_QUICK=1: Rune on the 300 notes only, for working on its frames
  const quick = process.env.RUNE_FRAMES_QUICK === "1";
  for (const b of quick ? boards.slice(0, 1) : boards) {
    for (const engine of quick ? ([process.env.RUNE_FRAMES_ENGINE === "web" ? "web" : "rune"] as const) : (["web", "rune"] as const)) {
      await page.goto(`/?board=${b.id}&engine=${engine}`);
      await waitLive(page);
      if (engine === "rune") await page.waitForSelector(".rune-mark.is-ready", { timeout: 30_000 });
      await settle(page, 2500);
      await page.locator(".grid-viewport").click({ position: { x: 20, y: H - 60 } });
      await page.keyboard.press("0");
      await settle(page, 2500);
      await page.mouse.move(mx, my);
      const run = (label: string, act: () => Promise<void>) => measure(page, b.name, engine, label, act).then((r) => results.push(r));
      const pan = (label: string) =>
        run(label, async () => {
          for (let i = 0; i < 180; i++) {
            await page.mouse.wheel(i % 60 < 30 ? 18 : -18, i % 90 < 45 ? 10 : -10);
            await page.waitForTimeout(16);
          }
        });
      const pinch = (label: string) =>
        run(label, async () => {
          await page.keyboard.down("Control");
          for (let i = 0; i < 160; i++) {
            await page.mouse.wheel(0, i % 80 < 40 ? -4 : 4);
            await page.waitForTimeout(16);
          }
          await page.keyboard.up("Control");
        });
      await run("at rest, fitted (3 s)", () => settle(page, 3000));
      // fitted is far out: Rune draws a note's lines as bars there (Scene.far)
      await page.screenshot({ path: `${OUT}/${b.name.split(" ")[0]}-${engine}-fitted.png` });
      // RUNE_FRAMES_PROFILE=1: a CPU profile of the fitted pan, its heaviest functions printed
      const profiling = process.env.RUNE_FRAMES_PROFILE === "1" && engine === "rune";
      const cdp = profiling ? await page.context().newCDPSession(page) : null;
      if (cdp) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
      }
      await pan("fitted: pan (3 s)");
      if (cdp) {
        const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string }; hitCount?: number }>; samples: number[]; timeDeltas: number[] } };
        const self = new Map<string, number>();
        const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        profile.samples.forEach((id, i) => {
          const n = byId.get(id)!;
          const name = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}`;
          self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
        });
        const total = [...self.values()].reduce((a, b) => a + b, 0);
        console.log(`PROFILE total ${Math.round(total)} ms`);
        for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`PROFILE ${Math.round(v)} ms ${k}`);
      }
      await pinch("fitted: pinch (3 s)");
      if (b.first >= 0) {
        await page.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } }), `o${b.first}`);
        await settle(page, 2000);
        await pan("framed on a note: pan (3 s)");
        await pinch("framed on a note: pinch (3 s)");
        // a note in the hand, carried round for two seconds
        await run("a note dragged (2 s)", async () => {
          await page.mouse.move(mx, my);
          await page.mouse.down();
          for (let i = 0; i < 120; i++) {
            await page.mouse.move(mx + Math.sin(i / 10) * 120, my + Math.cos(i / 10) * 80);
            await page.waitForTimeout(16);
          }
          await page.mouse.up();
        });
        await page.screenshot({ path: `${OUT}/${b.name.split(" ")[0]}-${engine}.png` });
      }
    }
  }

  const machine = { viewport: `${W}×${H} @${DPR}x`, browser: `${browser.browserType().name()} ${browser.version()} (headed, GPU)`, rune: JSON.parse(readFileSync("public/rune/rune.json", "utf8")) as unknown };
  if (!quick) writeFileSync(`${OUT}/frames.json`, JSON.stringify({ machine, results }, null, 2));
  // every measure drew frames in both engines
  expect(results.every((r) => r.frames > 20)).toBe(true);
  // Rune holds the web renderer's frames (plan rune-frame-cost, 2026-11-27): each measure's p95 within a few
  // ms of the web's on the same board, and its view doesn't run while only the camera moves
  if (!quick) {
    for (const r of results.filter((x) => x.engine === "rune")) {
      const web = results.find((x) => x.engine === "web" && x.board === r.board && x.label === r.label)!;
      expect(r.p95, `${r.board}, ${r.label}: Rune's p95 against the web's ${web.p95}`).toBeLessThanOrEqual(web.p95 + 4);
      if (/pan/.test(r.label)) expect(r.runeViews, `${r.board}, ${r.label}: view runs while only the camera moved`).toBeLessThanOrEqual(1);
    }
  }
  await context.close();
});

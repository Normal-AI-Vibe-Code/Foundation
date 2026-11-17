/**
 * Frames on a real GPU: every surface held to 60 fps (SPEC §5).
 *
 * perf.spec.ts runs headless, where WebGL is SwiftShader, so the sign-in wind
 * (which refuses software renderers) was never measured, and the paper shader
 * cost more than it does on a person's machine. This check runs headed with
 * the machine's own GPU at the person's pixel ratio (PERF_DPR, default 2) and
 * measures, from the browser's own clocks:
 *
 *   - page frames: requestAnimationFrame intervals (p50, p95, longest, the
 *     share over one 60 Hz frame) and Long Animation Frames (LoAF)
 *   - the wind's own frames: when its glyph pass draws (a wind can run at
 *     25 fps while the page holds 60, and that reads as slow)
 *   - what one wind frame costs the GPU (draw + finish)
 *
 * on the sign-in (opening, at rest, stirred, typed into, pressed, dissolving
 * into the board), and the board (pan, zoom, drag, live frames, panes).
 *
 *   PERF_GPU=1 npm run e2e -w @foundation/client -- frames
 *
 * Without PERF_GPU it skips: a CI box without a GPU can't say anything about
 * 60 fps. Numbers go to docs/evidence/<PERF_OUT or today>_frames/.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { CLIENT, settle, waitLive } from "./helpers";

const GPU = !!process.env.PERF_GPU;
const DPR = Number(process.env.PERF_DPR ?? 2);
const W = Number(process.env.PERF_W ?? 1440);
const H = Number(process.env.PERF_H ?? 900);
const OUT = `../../docs/evidence/${process.env.PERF_OUT ?? `${new Date().toISOString().slice(0, 10)}_frames`}`;
/** the budget: a 60 Hz frame plus vsync jitter */
const FRAME = 1000 / 60;

test.skip(!GPU, "PERF_GPU=1 runs this headed, on the machine's GPU");
test.use({
  headless: false,
  // Edge by default: the desktop app runs in WebView2, which is Edge's engine (PERF_CHANNEL=chrome for Chrome)
  channel: process.env.PERF_CHANNEL ?? "msedge",
  launchOptions: {
    args: [
      "--ignore-gpu-blocklist",
      // a headed window behind another can be throttled; measure the page, not the window manager
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ],
  },
});

type Sample = { frames: number[]; loaf: { d: number; b: number; s: string }[]; wind: number[]; firstWind?: number };
export type Result = {
  label: string;
  frames: number;
  p50: number;
  p95: number;
  max: number;
  /** frames longer than one 60 Hz frame (+25 % for vsync jitter) */
  over: number;
  overPct: number;
  /** Long Animation Frames: count, worst blocking ms, and the worst scripts */
  loaf: number;
  loafBlockingMax: number;
  loafTop: string[];
  /** the wind's own frames per second while measured, and its p95 interval */
  windFps?: number;
  windP95?: number;
  /** the wind's pacing after (0 = every frame) and why it last backed off */
  windState?: unknown;
};

/** the clocks, installed before any page script */
function instrument() {
  const w = window as unknown as { __perf: { rec: boolean } & Sample };
  w.__perf = { rec: false, frames: [], loaf: [], wind: [] };
  let last = performance.now();
  const tick = (t: number) => {
    if (w.__perf.rec) w.__perf.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      if (!w.__perf.rec) return;
      for (const e of list.getEntries() as unknown as { duration: number; blockingDuration: number; scripts?: { sourceURL: string; sourceFunctionName: string; invoker: string; duration: number }[] }[]) {
        const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
        w.__perf.loaf.push({ d: e.duration, b: e.blockingDuration, s: top ? `${top.invoker || top.sourceFunctionName} ${(top.sourceURL || "").split("/").pop()} ${Math.round(top.duration)}ms` : "" });
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {
    /* no LoAF in this browser */
  }
  // the wind's glyph pass is the draw of 6 × cells vertices on its canvas; the field pass draws 3
  const proto = WebGL2RenderingContext.prototype;
  const draw = proto.drawArrays;
  proto.drawArrays = function (mode: number, first: number, count: number) {
    if (count > 3 && (this.canvas as HTMLCanvasElement).dataset?.asciiWindCanvas !== undefined) {
      w.__perf.firstWind ??= performance.now();
      if (w.__perf.rec) w.__perf.wind.push(performance.now());
    }
    return draw.call(this, mode, first, count);
  };
}

async function measure(page: Page, label: string, act: () => Promise<void>): Promise<Result> {
  await page.evaluate(() => {
    const p = (window as unknown as { __perf: { rec: boolean } & Sample }).__perf;
    p.frames = [];
    p.loaf = [];
    p.wind = [];
    p.rec = true;
  });
  const t0 = Date.now();
  await act();
  const seconds = (Date.now() - t0) / 1000;
  const r = await page.evaluate(() => {
    const p = (window as unknown as { __perf: { rec: boolean } & Sample }).__perf;
    p.rec = false;
    return { frames: p.frames.slice(1), loaf: p.loaf, wind: p.wind };
  });
  const f = [...r.frames].sort((a, b) => a - b);
  const q = (xs: number[], k: number) => (xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.floor(k * xs.length))] * 10) / 10 : 0);
  const over = f.filter((x) => x > FRAME * 1.25).length;
  const windGaps = r.wind.slice(1).map((t, i) => t - r.wind[i]).sort((a, b) => a - b);
  const res: Result = {
    label,
    frames: f.length,
    p50: q(f, 0.5),
    p95: q(f, 0.95),
    max: q(f, 1),
    over,
    overPct: Math.round((over / Math.max(1, f.length)) * 1000) / 10,
    loaf: r.loaf.length,
    loafBlockingMax: Math.round(Math.max(0, ...r.loaf.map((l) => l.b))),
    loafTop: [...r.loaf].sort((a, b) => b.d - a.d).slice(0, 3).map((l) => `${Math.round(l.d)}ms: ${l.s}`),
  };
  if (r.wind.length) {
    res.windState = await page.evaluate(() => (document.querySelector("[data-ascii-wind]") as unknown as { asciiWind?: { state?(): unknown } } | null)?.asciiWind?.state?.());
    res.windFps = Math.round((r.wind.length / seconds) * 10) / 10;
    res.windP95 = q(windGaps, 0.95);
  }
  console.log(JSON.stringify(res));
  return res;
}

/** one wind frame on the GPU: draw it and wait for the GPU to finish */
async function windCost(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement & { asciiWind?: { drawNow?(): void; dissolve(x: number, y: number, r: number, b: number): void } }>("[data-ascii-wind]");
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-ascii-wind-canvas]");
    const gl = canvas?.getContext("webgl2");
    if (!root?.asciiWind || !gl || !canvas) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      gl.finish();
      const t = performance.now();
      if (root.asciiWind.drawNow) root.asciiWind.drawNow();
      else root.asciiWind.dissolve(0, 0, 0, 0); // before drawNow, the hooks drew at once
      gl.finish();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return {
      renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "unknown",
      canvas: `${canvas.width}×${canvas.height}`,
      medianMs: Math.round(times[20] * 100) / 100,
      p90Ms: Math.round(times[36] * 100) / 100,
    };
  });
}

async function freshContext(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, colorScheme: "light" });
  await context.addInitScript(instrument);
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  return context;
}

test("every surface at 60 fps on this machine's GPU", async ({ browser }) => {
  test.setTimeout(420_000);
  mkdirSync(OUT, { recursive: true });
  const results: Result[] = [];
  const machine: Record<string, unknown> = { viewport: `${W}×${H} @${DPR}x`, browser: `${browser.browserType().name()} ${browser.version()} (headed)` };

  // ---------- the sign-in ----------
  const context: BrowserContext = await freshContext(browser);
  const page = await context.newPage();
  await page.bringToFront();
  // the opening: from navigation until the frame has opened and the wind has revealed
  results.push(
    await measure(page, "sign-in: arriving (frame opens, wind reveals, 2.5 s)", async () => {
      await page.goto("/");
      await page.evaluate(() => ((window as unknown as { __perf: { rec: boolean } }).__perf.rec = true));
      await page.waitForSelector(".login-btn, .login-or, .f-input", { timeout: 15_000 });
      await settle(page, 2500);
    }),
  );
  await page.waitForFunction(() => !!document.querySelector("canvas[data-ascii-wind-canvas]"), undefined, { timeout: 15_000 }).catch(() => {});
  machine.wind = await windCost(page);
  // ms from navigation to the wind's first frame (fonts, shader compile and link, atlas)
  machine.firstWindMs = await page.evaluate(() => Math.round((window as unknown as { __perf: Sample }).__perf.firstWind ?? -1));
  console.log(JSON.stringify(machine));
  await settle(page, 2000);
  results.push(await measure(page, "sign-in: at rest (4 s)", () => settle(page, 4000)));
  await page.screenshot({ path: `${OUT}/01_sign-in.png` });
  results.push(
    await measure(page, "sign-in: the cursor stirs the wind (3 s)", async () => {
      for (let i = 0; i < 180; i++) {
        await page.mouse.move(W / 2 + Math.sin(i / 9) * W * 0.4, H / 2 + Math.cos(i / 13) * H * 0.35);
        await page.waitForTimeout(16);
      }
    }),
  );
  results.push(
    await measure(page, "sign-in: presses ripple (3 s)", async () => {
      for (let i = 0; i < 6; i++) {
        await page.mouse.click(W * (0.15 + 0.13 * i), H * (i % 2 ? 0.2 : 0.8));
        await page.waitForTimeout(480);
      }
    }),
  );
  const or = page.locator(".login-or");
  if (await or.count()) await or.click();
  await page.locator('input[type="email"]').waitFor();
  await settle(page, 600);
  results.push(
    await measure(page, "sign-in: typing stirs the wind (name + email)", async () => {
      await page.locator('input[placeholder="Your name"]').fill("");
      await page.locator('input[placeholder="Your name"]').pressSequentially("Ada Lovelace", { delay: 70 });
      await page.locator('input[type="email"]').fill("");
      await page.locator('input[type="email"]').pressSequentially("ada@normal.dev", { delay: 70 });
    }),
  );
  // the board mounts and syncs behind the page (the dissolve waits for it), then the page dissolves
  results.push(
    await measure(page, "sign-in: the board loads behind the page (wind keeps turning)", async () => {
      await page.locator(".login-go").click();
      await page.waitForSelector(".login.is-leaving", { timeout: 15_000 });
    }),
  );
  results.push(
    await measure(page, "sign-in: the page dissolves into the board", async () => {
      await page.waitForFunction(() => !document.querySelector(".login"), undefined, { timeout: 15_000 });
    }),
  );
  await waitLive(page);

  // ---------- the board: 10 sections × (18 notes + 2 live frames) ----------
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Frames ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool = (name: string, data: object) => context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
  for (let s = 0; s < 10; s++) {
    const section = `Area ${s + 1}`;
    await tool("add_section", { name: section });
    const note = (n: number) => tool("add_note", { section, title: `Note ${s}.${n}`, markdown: `## Note ${s}.${n}\n\n- a line of text\n- **another** with \`code\`\n- and a [link](https://example.com)` });
    await note(0);
    for (let f = 0; f < 2; f++) await tool("add_panel", { section, panel: "app", name: `Live ${s}.${f}`, url: `${CLIENT}/e2e/frame.html` });
    for (let n = 1; n < 18; n++) await note(n);
  }
  await page.goto(`/?board=${board}`);
  await waitLive(page);
  await page.waitForFunction(() => Object.keys((window as unknown as { __foundation: { getState(): { notes: object } } }).__foundation.getState().notes).length >= 180, undefined, { timeout: 30_000 });
  await settle(page, 2500);
  await page.mouse.move(W / 2, H / 2);
  results.push(await measure(page, "board: at rest (3 s)", () => settle(page, 3000)));
  results.push(
    await measure(page, "board: pan (trackpad scroll, 3 s)", async () => {
      for (let i = 0; i < 180; i++) {
        await page.mouse.wheel(i % 60 < 30 ? 18 : -18, i % 90 < 45 ? 10 : -10);
        await page.waitForTimeout(16);
      }
    }),
  );
  results.push(
    await measure(page, "board: pinch zoom (ctrl + wheel, 3 s)", async () => {
      await page.keyboard.down("Control");
      for (let i = 0; i < 180; i++) {
        await page.mouse.wheel(0, i < 90 ? -6 : 6);
        await page.waitForTimeout(16);
      }
      await page.keyboard.up("Control");
    }),
  );
  await page.evaluate(() => {
    const f = (window as unknown as { __foundation: { getState(): { notes: Record<string, { id: string; name: string }> }; setState(x: object): void } }).__foundation;
    const n = Object.values(f.getState().notes).find((x) => x.name === "Note 0.0")!;
    f.setState({ snapRequest: { kind: "object", id: n.id, nonce: Math.random() } });
  });
  await settle(page, 1500);
  const note = await page.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { notes: Record<string, { id: string; name: string }> } } }).__foundation.getState().notes).find((x) => x.name === "Note 0.0")!.id);
  const box = (await page.locator(`[data-obj-id="${note}"] .frame-card`).boundingBox())!;
  results.push(
    await measure(page, "board: drag a card (2 s)", async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + 12);
      await page.waitForTimeout(250);
      await page.mouse.down();
      for (let i = 0; i < 120; i++) {
        await page.mouse.move(box.x + box.width / 2 + Math.sin(i / 12) * 220, box.y + 12 + Math.cos(i / 15) * 140);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    }),
  );
  await page.evaluate(() => {
    const f = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> }; setState(x: object): void } }).__foundation;
    const s = Object.values(f.getState().sections).find((x) => x.name === "Area 2")!;
    f.setState({ snapRequest: { kind: "section", id: s.id, nonce: Math.random() } });
  });
  await settle(page, 2500);
  results.push(
    await measure(page, "board: pan with live frames running (3 s)", async () => {
      for (let i = 0; i < 180; i++) {
        await page.mouse.wheel(i < 90 ? 14 : -14, 0);
        await page.waitForTimeout(16);
      }
    }),
  );
  results.push(
    await measure(page, "board: side pane, search and ⌘K open and close", async () => {
      for (const keys of ["Control+Backslash", "Control+F", "Control+K"]) {
        await page.keyboard.press(keys);
        await settle(page, 700);
        await page.keyboard.press(keys === "Control+K" ? "Escape" : keys);
        await settle(page, 700);
      }
    }),
  );
  // the floor's fade at the pane's edge, after the mask moved onto .world-mask
  await page.keyboard.press("Control+Backslash");
  await settle(page, 900);
  await page.screenshot({ path: `${OUT}/02_board-side-pane-open.png` });
  await page.keyboard.press("Control+Backslash");
  await settle(page, 700);
  results.push(
    await measure(page, "board: framing glides (0, ⇧1, F)", async () => {
      for (const k of ["0", "Shift+Digit1", "f", "0"]) {
        await page.keyboard.press(k);
        await settle(page, 900);
      }
    }),
  );
  await context.close();

  writeFileSync(`${OUT}/frames.json`, JSON.stringify({ when: new Date().toISOString(), machine, budget: "p95 ≤ 16.7 ms × 1.25; ≤ 5 % of frames over; the wind at ≥ 55 fps while it runs", results }, null, 2));
  for (const r of results) {
    // loading the board is measured and reported, not held to the budget: it's one-off work (§5)
    if (/loads behind/.test(r.label)) continue;
    expect.soft(r.p95, `${r.label}: p95 frame`).toBeLessThanOrEqual(FRAME * 1.25);
    expect.soft(r.overPct, `${r.label}: frames over budget (%)`).toBeLessThanOrEqual(5);
    if (r.windFps !== undefined && /at rest|stirs|ripple|typing/.test(r.label)) expect.soft(r.windFps, `${r.label}: wind fps`).toBeGreaterThanOrEqual(55);
  }
});

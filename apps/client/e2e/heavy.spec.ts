/**
 * A heavy board on a real GPU (SPEC §5): the geometry of a real Flowform room
 * (heavy-board.json: one 15,732 × 5,239 plane, 27 photos up to 4096 px, 4
 * videos, 15 live apps, all floating), rebuilt with generated pictures of the
 * same pixel sizes and a stand-in app that draws every frame. Then pan, pinch
 * and glide at the board's own framings, from fitted (12 %) to 100 %.
 *
 *   PERF_GPU=1 E2E_CLIENT_PORT=15450 npm run e2e -w @foundation/client -- heavy
 *
 * Without PERF_GPU it runs headless (software GL), which says more about the
 * main thread than the GPU. Numbers go to docs/evidence/<PERF_OUT or today>_heavy/.
 */

import { test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CLIENT, settle, waitLive } from "./helpers";

const GPU = !!process.env.PERF_GPU;
const DPR = Number(process.env.PERF_DPR ?? 2);
const W = Number(process.env.PERF_W ?? 1440);
const H = Number(process.env.PERF_H ?? 900);
const OUT = `../../docs/evidence/${process.env.PERF_OUT ?? `${new Date().toISOString().slice(0, 10)}_heavy`}`;
const FRAME = 1000 / 60;

type Obj = { k: "image" | "video" | "app" | "note" | "table"; x: number; y: number; w?: number; h?: number; px?: [number, number] };
const FIXTURE = JSON.parse(readFileSync(new URL("./heavy-board.json", import.meta.url), "utf8")) as { grid: { cols: number[]; rows: number[] }; objects: Obj[] };

if (GPU)
  test.use({
    headless: false,
    channel: process.env.PERF_CHANNEL ?? "msedge",
    launchOptions: { args: ["--ignore-gpu-blocklist", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] },
  });

/** a frame clock and Long Animation Frames, installed before any page script */
function instrument() {
  const w = window as unknown as { __perf: { rec: boolean; frames: number[]; loaf: { d: number; r: number; s: string }[] } };
  w.__perf = { rec: false, frames: [], loaf: [] };
  // what changed while measured: pictures swapped, frames and videos mounted
  const ww = window as unknown as { __churn: { img: number; iframe: number; video: number } };
  ww.__churn = { img: 0, iframe: 0, video: 0 };
  new MutationObserver((list) => {
    if (!w.__perf.rec) return;
    for (const m of list) {
      if (m.type === "attributes" && (m.target as Element).tagName === "IMG") ww.__churn.img++;
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        ww.__churn.img += n.matches("img") ? 1 : n.querySelectorAll("img").length;
        ww.__churn.iframe += n.matches("iframe") ? 1 : n.querySelectorAll("iframe").length;
        ww.__churn.video += n.matches("video") ? 1 : n.querySelectorAll("video").length;
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
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
      for (const e of list.getEntries() as unknown as { duration: number; startTime: number; renderStart: number; scripts?: { sourceURL: string; sourceFunctionName: string; invoker: string; duration: number }[] }[]) {
        const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
        // render: style, layout and paint (what the page's own rendering cost), as opposed to script
        const render = e.renderStart ? e.startTime + e.duration - e.renderStart : 0;
        w.__perf.loaf.push({ d: e.duration, r: render, s: top ? `${top.invoker || top.sourceFunctionName} ${(top.sourceURL || "").split("/").pop()} ${Math.round(top.duration)}ms` : "" });
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {
    /* no LoAF */
  }
}

type Result = { label: string; frames: number; fps: number; p50: number; p95: number; max: number; overPct: number; loaf: number; loafRenderMs: number; loafTop: string[]; churn?: unknown };

async function measure(page: Page, label: string, act: () => Promise<void>): Promise<Result> {
  await page.evaluate(() => {
    const p = (window as unknown as { __perf: { rec: boolean; frames: number[]; loaf: unknown[] } }).__perf;
    p.frames = [];
    p.loaf = [];
    p.rec = true;
    (window as unknown as { __churn: object }).__churn = { img: 0, iframe: 0, video: 0 };
  });
  const t0 = Date.now();
  await act();
  const seconds = (Date.now() - t0) / 1000;
  const r = await page.evaluate(() => {
    const p = (window as unknown as { __perf: { rec: boolean; frames: number[]; loaf: { d: number; r: number; s: string }[] } }).__perf;
    p.rec = false;
    return { frames: p.frames.slice(1), loaf: p.loaf, churn: (window as unknown as { __churn: object }).__churn };
  });
  const f = [...r.frames].sort((a, b) => a - b);
  const q = (k: number) => (f.length ? Math.round(f[Math.min(f.length - 1, Math.floor(k * f.length))] * 10) / 10 : 0);
  const over = f.filter((x) => x > FRAME * 1.25).length;
  const res: Result = {
    label,
    frames: f.length,
    fps: Math.round((f.length / seconds) * 10) / 10,
    p50: q(0.5),
    p95: q(0.95),
    max: q(1),
    overPct: Math.round((over / Math.max(1, f.length)) * 1000) / 10,
    loaf: r.loaf.length,
    loafRenderMs: Math.round(r.loaf.reduce((a, l) => a + l.r, 0)),
    loafTop: [...r.loaf].sort((a, b) => b.d - a.d).slice(0, 3).map((l) => `${Math.round(l.d)}ms (render ${Math.round(l.r)}): ${l.s}`),
    churn: r.churn,
  };
  console.log(JSON.stringify(res));
  return res;
}

/** what the page holds decoded: each mounted image's and video's own pixels, and the live frames */
const residency = (page: Page) =>
  page.evaluate(() => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>(".world img")].filter((i) => i.complete && i.naturalWidth > 64);
    const vids = [...document.querySelectorAll<HTMLVideoElement>(".world video")];
    return {
      images: imgs.length,
      imageMpx: Math.round(imgs.reduce((a, i) => a + i.naturalWidth * i.naturalHeight, 0) / 1e5) / 10,
      videos: vids.length,
      playing: vids.filter((v) => !v.paused).length,
      iframes: document.querySelectorAll(".world iframe").length,
      // quality: pictures on screen drawn from fewer pixels than they cover (a level too small); should be 0
      soft: imgs
        .filter((i) => {
          const r = i.getBoundingClientRect();
          const onScreen = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
          return onScreen && i.naturalWidth < Math.min(r.width * devicePixelRatio * 0.95, 4096) && i.naturalWidth < 4096;
        })
        .map((i) => `${i.naturalWidth}px for ${Math.round(i.getBoundingClientRect().width * devicePixelRatio)}`),
    };
  });

test("a heavy board: 27 photos, 4 videos, 15 live apps", async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: GPU ? DPR : 1, colorScheme: "light" });
  const login = await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Heavy", email: "ada.heavy@normal.dev" } });
  if (!login.ok()) throw new Error(`dev login: ${login.status()}`);
  await context.addInitScript(instrument);
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Heavy ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const page = await context.newPage();
  await page.bringToFront();
  // PERF_NOLOD=1: pictures load their originals, as before image levels (lib/imageLod.ts), to compare
  await page.goto(`/?board=${board}${process.env.PERF_NOLOD ? "&nolod" : ""}`);
  await waitLive(page);

  // ---- the pictures: generated at each card's own pixel size, uploaded as files ----
  const urls = await page.evaluate(
    async ({ board, objects }) => {
      const out: string[] = [];
      const upload = async (blob: Blob, name: string) => {
        const r = await fetch(`/api/files?board=${encodeURIComponent(board)}&name=${encodeURIComponent(name)}`, { method: "POST", body: blob, headers: { "content-type": blob.type }, credentials: "include" });
        return ((await r.json()) as { file: { url: string } }).file.url;
      };
      let video: string | null = null;
      for (const [i, o] of objects.entries()) {
        if (o.k === "image" && o.px) {
          const [w, h] = o.px;
          const c = new OffscreenCanvas(w, h);
          const g = c.getContext("2d")!;
          const grad = g.createLinearGradient(0, 0, w, h);
          grad.addColorStop(0, `hsl(${(i * 47) % 360} 50% 70%)`);
          grad.addColorStop(1, `hsl(${(i * 47 + 120) % 360} 40% 30%)`);
          g.fillStyle = grad;
          g.fillRect(0, 0, w, h);
          // detail, so it compresses like a photograph rather than a flat card
          for (let k = 0; k < 4000; k++) {
            g.fillStyle = `hsl(${(k * 13) % 360} 40% ${30 + (k % 50)}% / 0.5)`;
            g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * w * 0.02, 2 + Math.random() * h * 0.02);
          }
          const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.95 });
          out.push(await upload(blob, `photo-${i}.jpg`));
        } else if (o.k === "video") {
          if (!video) {
            // one short clip, recorded from a canvas, shown in all four cards
            const c = document.createElement("canvas");
            c.width = 1920;
            c.height = 1080;
            const g = c.getContext("2d")!;
            const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm" });
            const parts: Blob[] = [];
            rec.ondataavailable = (e) => parts.push(e.data);
            const done = new Promise((r) => (rec.onstop = r));
            rec.start();
            const t0 = performance.now();
            await new Promise<void>((r) => {
              const draw = () => {
                const t = performance.now() - t0;
                g.fillStyle = `hsl(${t / 10} 40% 40%)`;
                g.fillRect(0, 0, 1920, 1080);
                g.fillStyle = "#fff";
                g.fillRect((t / 2) % 1920, 400, 200, 200);
                if (t < 2500) requestAnimationFrame(draw);
                else r();
              };
              draw();
            });
            rec.stop();
            await done;
            video = await upload(new Blob(parts, { type: "video/webm" }), "clip.webm");
          }
          out.push(video);
        } else out.push("");
      }
      return out;
    },
    { board, objects: FIXTURE.objects },
  );

  // ---- the board: one plane, every card floating where the room had it ----
  await page.evaluate(
    ({ objects, urls, grid, frame }) => {
      const sync = (window as unknown as { __foundationBoard: () => { doc: { transact(fn: () => void): void; getMap(n: string): { set(k: string, v: unknown): void; clear(): void; keys(): IterableIterator<string>; delete(k: string): void } } } }).__foundationBoard();
      const doc = sync.doc;
      const sections = doc.getMap("sections");
      const objs = doc.getMap("objects");
      doc.transact(() => {
        for (const k of [...sections.keys()]) sections.delete(k);
        for (const k of [...objs.keys()]) objs.delete(k);
        doc.getMap("grid").set("tracks", grid);
        sections.set("plane", { id: "plane", name: "Plane", c0: 0, r0: 0, c1: 0, r1: 0 });
        objects.forEach((o, i) => {
          const base = { id: `o${i}`, sectionId: "plane", name: `${o.k} ${i}`, x: o.x, y: o.y, float: true, bornAt: 1 };
          if (o.k === "image" || o.k === "video") objs.set(base.id, { ...base, kind: "media", media: o.k, w: o.w, h: o.h, src: urls[i], autoplay: false, muted: true });
          else if (o.k === "app") objs.set(base.id, { ...base, kind: "panel", panel: "app", w: o.w, h: o.h, url: frame, ports: [] });
          else if (o.k === "note") objs.set(base.id, { ...base, kind: "note", w: o.w, h: o.h, text: "## A note\n\nSome words on the plane." });
        });
      });
    },
    { objects: FIXTURE.objects, urls, grid: FIXTURE.grid, frame: `${CLIENT}/e2e/frame.html` },
  );
  await page.waitForFunction((n) => document.querySelectorAll(".world [data-obj-id]").length >= n, FIXTURE.objects.filter((o) => o.k !== "table").length, { timeout: 30_000 });
  await page.reload();
  await waitLive(page);

  const results: Result[] = [];
  const machine: Record<string, unknown> = { viewport: `${W}×${H} @${GPU ? DPR : 1}x`, browser: `${browser.browserType().name()} ${browser.version()} (${GPU ? "headed, GPU" : "headless"})` };

  // the first load: from the board showing until every picture on screen has drawn
  const vp = page.locator(".grid-viewport");
  await vp.click({ position: { x: 20, y: H - 60 } }); // focus the grid without engaging anything
  await page.keyboard.press("0");
  results.push(
    await measure(page, "fitted (12 %): loading every picture (6 s)", async () => {
      await settle(page, 6000);
    }),
  );
  const mx = W / 2;
  const my = H / 2;
  await page.mouse.move(mx, my);
  const pan = (label: string) =>
    measure(page, label, async () => {
      for (let i = 0; i < 180; i++) {
        await page.mouse.wheel(i % 60 < 30 ? 18 : -18, i % 90 < 45 ? 10 : -10);
        await page.waitForTimeout(16);
      }
    });
  const pinch = (label: string) =>
    measure(page, label, async () => {
      await page.keyboard.down("Control");
      for (let i = 0; i < 160; i++) {
        await page.mouse.wheel(0, i % 80 < 40 ? -4 : 4);
        await page.waitForTimeout(16);
      }
      await page.keyboard.up("Control");
    });
  results.push(await pan("fitted: pan (3 s)"));
  results.push(await pinch("fitted: pinch in and out (3 s)"));

  // framed on a cluster of photos, then on the apps, at the zooms people read at
  const frameOn = async (i: number) => {
    await page.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } }), `o${i}`);
    await settle(page, 1500);
  };
  const zoomTo = async (factor: number) => {
    // a mouse wheel with ctrl steps the zoom on its spring
    await page.keyboard.down("Control");
    const steps = Math.round(Math.abs(Math.log(factor) / 0.0022 / 100));
    for (let i = 0; i < steps; i++) await page.mouse.wheel(0, factor < 1 ? 100 : -100);
    await page.keyboard.up("Control");
    await settle(page, 1500);
  };
  const photo = FIXTURE.objects.findIndex((o) => o.k === "image" && o.x > 7500 && o.x < 9000 && o.y < 1000);
  await frameOn(photo);
  await zoomTo(0.35);
  machine.photosAt35 = await residency(page);
  await settle(page, 1500);
  machine.photosAt35Settled = await residency(page);
  results.push(await pan("photos at ~35 %: pan (3 s)"));
  results.push(await pinch("photos at ~35 %: pinch in and out (3 s)"));
  await frameOn(photo);
  machine.photosAt100 = await residency(page);
  // a level steps up once the camera settles and the next one has decoded: look again a moment later
  await settle(page, 1500);
  machine.photosAt100Settled = await residency(page);
  results.push(await pan("photos at 100 %: pan (3 s)"));
  results.push(await pinch("photos at 100 %: pinch in and out (3 s)"));
  const bigApp = FIXTURE.objects.findIndex((o) => o.k === "app" && o.w! > 2000);
  for (let i = 1; i <= 3; i++) {
    if (i > 1) await frameOn(photo);
    results.push(
      await measure(page, `glide ${i}: photos → fitted → apps (framing keys)`, async () => {
        await page.keyboard.press("0");
        await settle(page, 1200);
        await frameOn(bigApp);
      }),
    );
  }
  // live pages start once the camera is still, one at a time (lib/calm.ts): give them a moment
  await settle(page, 2000);
  machine.apps = await residency(page);
  results.push(await pan("apps framed: pan (3 s)"));
  results.push(await pinch("apps framed: pinch in and out (3 s)"));
  await page.screenshot({ path: `${OUT}/heavy-apps.png` });
  await page.keyboard.press("0");
  await settle(page, 1500);
  machine.fitted = await residency(page);
  await page.screenshot({ path: `${OUT}/heavy-fitted.png` });

  const file = `${OUT}/heavy${process.env.PERF_TAG ? `-${process.env.PERF_TAG}` : ""}.json`;
  writeFileSync(file, JSON.stringify({ machine, results }, null, 2));
  console.log(`\n${file}`);
  await context.close();
});

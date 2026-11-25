// Measure a board in headed Edge on this machine's GPU (1440x900 at 2x), on a copy of the real data.
//   node measure.mjs <label> <board> [clientUrl] [outDir]
// Cold load (fresh profile), at rest, pan / zoom frames, far zoom, warm reload. Prints one JSON object.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
const require = createRequire(process.env.PW_FROM ?? new URL("../../../../apps/client/package.json", import.meta.url));
const pw = require("@playwright/test");
const [label = "run", board = "character-studio", CLIENT = "http://localhost:15531", OUT = "."] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const EMAIL = process.env.M_EMAIL ?? "ada@formindustries.com";
const isPic = (u) => /\/files\/|\/api\/characters\/[^/]+\/files\//.test(u);

function instrument() {
  const w = window;
  const P = (w.__p = { rec: false, frames: [], loaf: [], long: [], gl: 0, glLive: new Set(), draws: 0, drawBy: {} });
  let last = performance.now();
  const tick = (t) => {
    if (P.rec) P.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
        P.loaf.push({ at: Math.round(e.startTime), d: Math.round(e.duration), b: Math.round(e.blockingDuration), rec: P.rec, s: top ? `${top.invoker || top.sourceFunctionName} ${(top.sourceURL || "").split("/").pop().slice(0, 40)} ${Math.round(top.duration)}ms` : "" });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.long.push({ at: Math.round(e.startTime), d: Math.round(e.duration), rec: P.rec });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...a) {
    const c = get.call(this, kind, ...a);
    if (c && /webgl/.test(kind) && !this.__counted) {
      this.__counted = true;
      P.gl++;
      P.glLive.add(this);
    }
    return c;
  };
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype])
    for (const fn of ["drawArrays", "drawElements"]) {
      const o = proto[fn];
      proto[fn] = function (...a) {
        if (P.rec) {
          P.draws++;
          const k = this.canvas.dataset?.stage ?? (this.canvas.className || "canvas");
          P.drawBy[k] = (P.drawBy[k] ?? 0) + 1;
        }
        return o.apply(this, a);
      };
    }
}

const browser = await pw.chromium.launch({ headless: false, channel: "msedge", args: ["--ignore-gpu-blocklist", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: process.env.M_SCHEME ?? "dark" });
const login = await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada", email: EMAIL }, headers: { origin: CLIENT } });
if (!login.ok()) throw new Error(`sign-in ${login.status()} ${await login.text()}`);
await ctx.addInitScript(() => {
  localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
  localStorage.getItem("foundation-wheel") ?? localStorage.setItem("foundation-wheel", "pan");
});
await ctx.addInitScript(instrument);
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
let net = [];
page.on("requestfinished", async (r) => {
  if (!isPic(r.url())) return;
  const s = await r.sizes().catch(() => null);
  net.push({ u: r.url().replace(CLIENT, ""), b: s?.responseBodySize ?? 0, t: Date.now() });
});

const visiblePics = () =>
  page.evaluate(() => {
    const on = (i) => {
      const b = i.getBoundingClientRect();
      return b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth && b.width > 6;
    };
    const vis = [...document.querySelectorAll("img")].filter(on);
    const done = vis.filter((i) => i.complete && i.naturalWidth > 0);
    // blurry: a 64 px stand-in stretched over much more than it has
    const dpr = devicePixelRatio;
    const blurry = done.filter((i) => i.naturalWidth < 100 && i.getBoundingClientRect().width * dpr > i.naturalWidth * 2.5);
    const wells = [...document.querySelectorAll(".avatar-none, .char-thumb > span, .f-prog[data-prog-phase='well'], .f-prog[data-prog-phase='preview'], [data-arrive='well'], [data-arrive='preview']")].filter(on);
    return { vis: vis.length, done: done.length, blurry: blurry.length, wells: wells.length };
  });

async function load(kind, go) {
  net = [];
  const t0 = Date.now();
  await go();
  await page.waitForFunction(() => !!window.__foundation && Object.keys(window.__foundation.getState().sections).length > 0 && window.__foundationBoard?.()?.status === "live", undefined, { timeout: 30000 });
  const live = Date.now() - t0;
  let first = 0,
    all = 0,
    lastState = "",
    stable = 0;
  const trail = [];
  while (Date.now() - t0 < 20000) {
    const v = await visiblePics();
    const now = Date.now() - t0;
    if (!first && v.done > 0) first = now;
    const s = JSON.stringify(v);
    if (s !== lastState) {
      trail.push([now, v.vis, v.done, v.blurry, v.wells]);
      lastState = s;
      stable = now;
    }
    if (v.vis > 0 && v.done === v.vis && v.blurry === 0 && v.wells === 0) {
      if (!all) all = stable;
      if (now - stable > 1500) break;
    } else all = 0;
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1500);
  const reqs = net.length,
    kb = Math.round(net.reduce((a, r) => a + r.b, 0) / 1024);
  const byTier = {};
  for (const r of net) {
    const k = /[?&]w=(\d+)/.exec(r.u)?.[1] ?? (/(clips|mavatar)/.test(r.u) ? "model/avatar bytes" : "original");
    byTier[k] = byTier[k] ?? [0, 0];
    byTier[k][0]++;
    byTier[k][1] += Math.round(r.b / 1024);
  }
  const lastReq = net.length ? Math.max(...net.map((r) => r.t)) - t0 : 0;
  const perf = await page.evaluate(() => ({
    long: window.__p.long.length,
    longMs: window.__p.long.reduce((a, l) => a + l.d, 0),
    longMax: Math.max(0, ...window.__p.long.map((l) => l.d)),
    loaf: window.__p.loaf.length,
    loafBlocking: window.__p.loaf.reduce((a, l) => a + l.b, 0),
    loafTop: [...window.__p.loaf].sort((a, b) => b.d - a.d).slice(0, 6).map((l) => `${l.d}ms@${l.at} ${l.s}`),
  }));
  return { kind, boardLiveMs: live, firstPictureMs: first, allVisibleSharpMs: all, lastPictureRequestMs: lastReq, pictureRequests: reqs, pictureKB: kb, byTier, perf, trail: trail.slice(0, 60) };
}

const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));

async function rest() {
  const m = await metrics();
  let layers = 0;
  try {
    const got = new Promise((res) => {
      cdp.once("LayerTree.layerTreeDidChange", (e) => res(e.layers?.length ?? 0));
      setTimeout(() => res(-1), 2500);
    });
    await cdp.send("LayerTree.enable");
    layers = await got;
    await cdp.send("LayerTree.disable");
  } catch {}
  const dom = await page.evaluate(async () => {
    const P = window.__p;
    const imgs = [...document.querySelectorAll("img")];
    const seen = new Map();
    for (const i of imgs) if (i.complete && i.naturalWidth) seen.set(i.currentSrc, i.naturalWidth * i.naturalHeight);
    const dataUrls = imgs.filter((i) => i.currentSrc.startsWith("data:"));
    const cv = [...document.querySelectorAll("canvas")];
    const f0 = cv.map((c) => Number(c.dataset.frames ?? 0));
    P.rec = true;
    P.draws = 0;
    P.drawBy = {};
    await new Promise((r) => setTimeout(r, 2000));
    P.rec = false;
    const f1 = cv.map((c) => Number(c.dataset.frames ?? 0));
    const onscreen = (e) => {
      const b = e.getBoundingClientRect();
      return b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
    };
    const st = window.__foundation.getState();
    return {
      nodes: document.querySelectorAll("*").length,
      imgs: imgs.length,
      imgsOnScreen: imgs.filter(onscreen).length,
      decodedMpx: +([...seen.values()].reduce((a, b) => a + b, 0) / 1e6).toFixed(1),
      dataUrlImgs: dataUrls.length,
      dataUrlKB: Math.round(dataUrls.reduce((a, i) => a + i.currentSrc.length, 0) / 1024),
      canvases: cv.length,
      webglContextsMade: P.gl,
      webglCanvasesInDom: [...P.glLive].filter((c) => c.isConnected).length,
      avatarStages: cv.filter((c) => c.dataset.stage === "avatars").length,
      avatarStagesOffScreen: cv.filter((c) => c.dataset.stage === "avatars" && !onscreen(c)).length,
      stageFramesIn2s: f1.reduce((a, b, i) => a + (b - f0[i]), 0),
      glDrawsIn2s: P.draws,
      glDrawsBy: P.drawBy,
      live3d: document.querySelectorAll(".avatar-3d.is-live").length,
      liveMesh: document.querySelectorAll(".avatar-mesh.is-live").length,
      stills: document.querySelectorAll(".avatar-still").length,
      cards: document.querySelectorAll("[data-obj-id]").length,
      charCards: document.querySelectorAll("[data-character-card]").length,
      charCardsOnScreen: [...document.querySelectorAll("[data-character-card]")].filter(onscreen).length,
      zoom: st.camera?.zoom ?? st.zoom ?? null,
      animations: document.getAnimations().filter((a) => a.playState === "running").length,
    };
  });
  return { ...dom, layers, jsHeapMB: +(m.JSHeapUsedSize / 1e6).toFixed(1), domNodesCdp: m.Nodes };
}

async function sample(name, fn, ms = 3000) {
  const m0 = await metrics();
  await page.evaluate(() => {
    const P = window.__p;
    P.frames.length = 0;
    P.loaf.length = 0;
    P.long.length = 0;
    P.rec = true;
  });
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) await fn(i++);
  const r = await page.evaluate(() => {
    const P = window.__p;
    P.rec = false;
    return { t: P.frames.slice(1), loaf: P.loaf.filter((l) => l.rec), long: P.long.filter((l) => l.rec) };
  });
  const m1 = await metrics();
  const t = r.t.sort((a, b) => a - b);
  const sum = t.reduce((a, b) => a + b, 0);
  const B = (1000 / 60) * 1.25;
  return {
    name,
    frames: t.length,
    fps: +(1000 / (sum / Math.max(1, t.length))).toFixed(1),
    p50: +t[Math.floor(t.length * 0.5)]?.toFixed(1),
    p95: +t[Math.floor(t.length * 0.95)]?.toFixed(1),
    p99: +t[Math.floor(t.length * 0.99)]?.toFixed(1),
    worst: +t[t.length - 1]?.toFixed(1),
    overPct: +((100 * t.filter((x) => x > B).length) / Math.max(1, t.length)).toFixed(1),
    loaf: r.loaf.length,
    loafWorst: Math.max(0, ...r.loaf.map((l) => l.d)),
    loafTop: r.loaf.sort((a, b) => b.d - a.d).slice(0, 3).map((l) => `${l.d}ms ${l.s}`),
    longTasks: r.long.length,
    layouts: m1.LayoutCount - m0.LayoutCount,
    styleRecalcs: m1.RecalcStyleCount - m0.RecalcStyleCount,
    scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000),
    layoutMs: Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000),
    styleMs: Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000),
  };
}
const zoomBy = async (dy, n, gap = 16) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, dy);
    await page.keyboard.up("Control");
    await page.waitForTimeout(gap);
  }
};

const out = { label, board, client: CLIENT, at: new Date().toISOString(), browser: browser.version() };
out.cold = await load('cold', () => page.goto(CLIENT + '/?board=' + encodeURIComponent(board)));
await page.screenshot({ path: OUT + '/' + label + '-' + board + '-loaded.png' });
out.rest = await rest();
await page.mouse.move(900, 450);
const fr = [];
const pan = (dx, dy, every = 50, everyY = 70) => async (i) => (await page.mouse.wheel(Math.floor(i / every) % 2 ? -dx : dx, Math.floor(i / everyY) % 2 ? -dy : dy), void (await page.waitForTimeout(16)));
const zoom = (d, every = 40) => async (i) => { await page.keyboard.down('Control'); await page.mouse.wheel(0, Math.floor(i / every) % 2 ? -d : d); await page.keyboard.up('Control'); await page.waitForTimeout(16); };
fr.push(await sample('at rest', async () => void (await page.waitForTimeout(100)), 2000));
fr.push(await sample('pan, opening zoom', pan(24, 10)));
const cardAt = () => page.evaluate(() => { const e = document.querySelector('[data-character-card]'); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top]; });
const hasChars = await cardAt();
if (hasChars) {
  // arrive at the characters: a quick pan that brings the first character card to the top left, then let it fill
  fr.push(await sample('arriving at the character cards (pan there, 5 s)', async (i) => { const at = await cardAt(); const dx = at[0] - 260, dy = at[1] - 150; if (i < 400 && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) await page.mouse.wheel(Math.max(-160, Math.min(160, dx)), Math.max(-160, Math.min(160, dy))); await page.waitForTimeout(16); }, 5000));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/' + label + '-' + board + '-characters.png' });
  out.restCharacters = await rest();
  fr.push(await sample('at rest over the characters', async () => void (await page.waitForTimeout(100)), 2000));
  fr.push(await sample('pan over the characters', pan(24, 10)));
  // rest the pointer on one character (it wakes), leave it, and come back (it wakes again)
  for (let k = 0; k < 80; k++) { const at = await cardAt(); const dx = at[0] - 260, dy = at[1] - 150; if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break; await page.mouse.wheel(Math.max(-160, Math.min(160, dx)), Math.max(-160, Math.min(160, dy))); await page.waitForTimeout(16); }
  await page.waitForTimeout(600);
  const box = await page.evaluate(() => { const v = [...document.querySelectorAll('[data-character-card] .char-view')].map((e) => e.getBoundingClientRect()).filter((b) => b.left > 300 && b.right < innerWidth && b.top > 80 && b.bottom < innerHeight - 120)[0]; return [v.left + v.width / 2, v.top + v.height / 2]; });
  await page.mouse.move(700, 50);
  await page.waitForTimeout(2500);
  out.restPointerAway = await rest();
  fr.push(await sample('the pointer rests on a character: it wakes (3 s)', async (i) => { if (i === 5) await page.mouse.move(box[0], box[1]); await page.waitForTimeout(16); }, 3000));
  out.restPointerOn = await rest();
  await page.mouse.move(700, 50);
  await page.waitForTimeout(3000);
  fr.push(await sample('the pointer comes back: it wakes again (3 s)', async (i) => { if (i === 5) await page.mouse.move(box[0], box[1]); await page.waitForTimeout(16); }, 3000));
  out.restAfterPointer = await rest();
  await page.mouse.move(900, 450);
}
fr.push(await sample('zoom out and in', zoom(12), 4000));
fr.push(await sample('pan after zoom', pan(30, 0)));
await zoomBy(-12, 45);
await page.waitForTimeout(1500);
out.restNear = await rest();
fr.push(await sample('pan, zoomed in', pan(40, 24, 60, 45)));
await page.screenshot({ path: OUT + '/' + label + '-' + board + '-near.png' });
await zoomBy(12, 120);
await page.waitForTimeout(2000);
out.restFar = await rest();
await page.screenshot({ path: OUT + '/' + label + '-' + board + '-far.png' });
fr.push(await sample('pan, zoomed all the way out', pan(30, 16, 40, 55)));
fr.push(await sample('zoom in from far and back', zoom(-14, 50), 4000));
out.frames = fr;
out.warm = await load("warm reload", () => page.reload());
out.restAfterReload = await rest();
writeFileSync(`${OUT}/${label}-${board}.json`, JSON.stringify(out, null, 1));
const brief = (l) => ({ ...l, trail: undefined });
console.log(JSON.stringify({ ...out, cold: brief(out.cold), warm: brief(out.warm) }, null, 1));
await browser.close();

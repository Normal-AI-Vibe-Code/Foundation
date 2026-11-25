// Frame probe for the Character studio in WebKit (the Mac app's engine) and Chromium.
// node probe.mjs <webkit|chromium> <label> [clientUrl]
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../apps/client/package.json", import.meta.url));
const pw = require("@playwright/test");

const [engine = "webkit", label = "run", CLIENT = "http://localhost:1440"] = process.argv.slice(2);
const browser = await pw[engine].launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
const r = await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Perf Test", email: "perf-test@formindustries.co" }, headers: { Origin: CLIENT } });
if (!r.ok()) throw new Error(`sign-in ${r.status()} ${await r.text()}`);
const p = await ctx.newPage();
let bytes = 0, reqs = 0;
p.on("response", async (res) => {
  if (!/\/api\/files|\/files\//.test(res.url())) return;
  reqs++;
  const len = Number((await res.allHeaders())["content-length"] ?? 0);
  bytes += len;
});

const t0 = Date.now();
await p.goto(`${CLIENT}/?board=character-studio`);
await p.waitForSelector(".section, [data-section-id]", { timeout: 30000 });
const firstSection = Date.now() - t0;
// wait until visible images have decoded or 15 s
await p.waitForFunction(() => [...document.querySelectorAll("img")].filter((i) => { const b = i.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight && b.width > 8; }).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => {});
const imagesVisible = Date.now() - t0;

await p.evaluate(() => {
  window.__f = [];
  let last = performance.now();
  const f = (now) => { window.__f.push(now - last); last = now; requestAnimationFrame(f); };
  requestAnimationFrame(f);
});
const sample = async (name, fn, ms = 3000) => {
  await p.evaluate(() => (window.__f.length = 0));
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) { await fn(i++); }
  const t = await p.evaluate(() => window.__f.slice(1));
  t.sort((a, b) => a - b);
  const avg = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length);
  return { name, fps: +(1000 / avg).toFixed(1), p50: +t[Math.floor(t.length * 0.5)]?.toFixed(1), p95: +t[Math.floor(t.length * 0.95)]?.toFixed(1), worst: +t[t.length - 1]?.toFixed(1), over33: t.filter((x) => x > 33.4).length, frames: t.length };
};
await p.mouse.move(900, 450);
const out = [];
out.push(await sample("idle", async () => { await p.waitForTimeout(100); }, 2000));
out.push(await sample("pan", async (i) => { await p.mouse.wheel(Math.floor(i / 50) % 2 ? -24 : 24, Math.floor(i / 70) % 2 ? -10 : 10); await p.waitForTimeout(16); }));
out.push(await sample("zoom out/in", async (i) => {
  await p.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await p.mouse.wheel(0, Math.floor(i / 40) % 2 ? -12 : 12);
  await p.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  await p.waitForTimeout(16);
}, 4000));
out.push(await sample("pan after zoom", async (i) => { await p.mouse.wheel(Math.floor(i / 50) % 2 ? -30 : 30, 0); await p.waitForTimeout(16); }));
const dom = await p.evaluate(() => ({ nodes: document.querySelectorAll("*").length, img: document.querySelectorAll("img").length, video: document.querySelectorAll("video").length, playing: [...document.querySelectorAll("video")].filter((v) => !v.paused).length, canvas: document.querySelectorAll("canvas").length, zoom: document.querySelector("[data-zoom], .zoom-readout")?.textContent ?? "" }));
console.log(JSON.stringify({ engine, label, firstSection, imagesVisible, fileReqs: reqs, fileKB: Math.round(bytes / 1024), dom, frames: out }, null, 1));
await p.screenshot({ path: `${engine}-${label}.png` });
await browser.close();

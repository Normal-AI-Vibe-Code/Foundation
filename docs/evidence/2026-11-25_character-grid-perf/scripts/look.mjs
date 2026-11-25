// Look at the character cards: at rest, a 3D card hovered (live), a mesh card hovered, and back. Screenshots + states.
//   node look.mjs <label> [clientUrl] [outDir] [scheme]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(process.env.PW_FROM ?? new URL("../../../../apps/client/package.json", import.meta.url));
const pw = require("@playwright/test");
const [label = "look", CLIENT = "http://localhost:15531", OUT = ".", scheme = "dark"] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await pw.chromium.launch({ headless: false, channel: "msedge", args: ["--ignore-gpu-blocklist", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada", email: "ada@formindustries.com" }, headers: { origin: CLIENT } });
await ctx.addInitScript((night) => {
  localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
  localStorage.getItem("foundation-wheel") ?? localStorage.setItem("foundation-wheel", "pan");
  window.__loaf = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
        window.__loaf.push(`${Math.round(e.duration)}ms@${Math.round(e.startTime)} ${top ? (top.invoker || top.sourceFunctionName) + " " + (top.sourceURL || "").split("/").pop() + " " + Math.round(top.duration) + "ms" : ""}`);
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}
}, scheme === "dark");
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("console.error:", m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
await page.goto(`${CLIENT}/?board=character-studio`);
await page.waitForFunction(() => window.__foundationBoard?.()?.status === "live");
await page.waitForTimeout(1500);
await page.mouse.move(700, 80);
const cardAt = (name) => page.evaluate((n) => { const e = document.querySelector(`[data-character-card="${n}"]`); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; }, name);
const bring = async (name, x, y) => {
  for (let i = 0; i < 80; i++) {
    const at = await cardAt(name);
    const dx = at[0] - x, dy = at[1] - y;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
    await page.mouse.wheel(Math.max(-200, Math.min(200, dx)), Math.max(-200, Math.min(200, dy)));
    await page.waitForTimeout(16);
  }
};
const states = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-character-card]")].map((c) => { const p = c.querySelector(".avatar-poster"); const b = c.getBoundingClientRect(); return [c.dataset.characterCard, `${p?.dataset.poster ?? "-"}${b.right > 0 && b.left < innerWidth && b.bottom > 0 && b.top < innerHeight ? "" : " (off)"}`]; })));
const shot = (n) => page.screenshot({ path: `${OUT}/${label}-${n}.png` });

// straight to the characters, and look while they fill
await bring("Aoi", 60, 120);
await page.waitForTimeout(120);
await shot("1-arriving");
console.log("arriving", JSON.stringify(await states()));
await page.waitForTimeout(700);
await shot("2-filling");
await page.waitForTimeout(6000);
await shot("3-at-rest");
console.log("at rest", JSON.stringify(await states()), "canvases", await page.evaluate(() => document.querySelectorAll("canvas").length));
// the 3D characters' section
await bring("Mochi", 240, 140);
await page.waitForTimeout(7000);
console.log("3D at rest", JSON.stringify(await states()));
await shot("4-3d-at-rest");
const m = await cardAt("Mochi");
await page.mouse.move(m[0] + m[2] / 2, m[1] + 70);
await page.waitForTimeout(150);
await shot("5-3d-waking");
await page.waitForTimeout(2500);
console.log("3D hovered", JSON.stringify(await states()));
await shot("6-3d-live");
await page.mouse.move(700, 80);
await page.waitForTimeout(1500);
await shot("7-3d-leaving");
await page.waitForTimeout(1500);
console.log("3D left", JSON.stringify(await states()), "canvases", await page.evaluate(() => document.querySelectorAll("canvas").length));
// zoom in on Mochi until it is large: plays without the pointer
await page.mouse.move(m[0] + m[2] / 2, m[1] + 200);
for (let i = 0; i < 30; i++) { await page.keyboard.down("Control"); await page.mouse.wheel(0, -12); await page.keyboard.up("Control"); await page.waitForTimeout(16); }
await page.mouse.move(700, 80);
await page.waitForTimeout(4000);
console.log("zoomed in", JSON.stringify(await states()), await page.evaluate(() => document.querySelector(".zoom-readout, [data-zoom]")?.textContent ?? ""));
await shot("8-large-live");
console.log("loaf > 100ms:", JSON.stringify(await page.evaluate(() => window.__loaf.filter((l) => parseInt(l) > 100))));
await browser.close();

// Day and night pictures of the Character studio mid-load and loaded, and the #/design specimen.
//   node shots.mjs [clientUrl] [outDir]
// The network is slowed (120 ms a request, 1.5 Mbit/s) so "mid-load" lasts long enough to photograph.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(process.env.PW_FROM ?? new URL("../../../../apps/client/package.json", import.meta.url));
const pw = require("@playwright/test");
const [CLIENT = "http://localhost:15531", OUT = "."] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await pw.chromium.launch({ headless: false, channel: "msedge", args: ["--ignore-gpu-blocklist", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] });
for (const [when, scheme] of [["night", "dark"], ["day", "light"]]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada", email: "ada@formindustries.com" }, headers: { origin: CLIENT } });
  await ctx.addInitScript(() => {
    localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
    localStorage.getItem("foundation-wheel") ?? localStorage.setItem("foundation-wheel", "pan");
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const shot = (name) => page.screenshot({ path: `${OUT}/studio-${when}-${name}.jpg`, type: "jpeg", quality: 82 });
  const phases = () => page.evaluate(() => {
    const on = (e) => { const b = e.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth && b.width > 6; };
    const count = (sel) => [...document.querySelectorAll(sel)].filter(on).length;
    return { wells: count(".media-host:empty, .f-prog[data-prog-phase='well'], .avatar-none"), standIns: count("img.f-img-preview, .f-prog[data-prog-phase='preview']"), sharp: count(".media-body img.is-loaded:not(.f-img-preview), .f-prog[data-prog-phase='sharp'], img.avatar-still") };
  });
  await page.goto(`${CLIENT}/?board=character-studio`);
  await page.waitForFunction(() => window.__foundationBoard?.()?.status === "live");
  // the board's own files are in; from here every picture comes slowly
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 120, downloadThroughput: (1.5 * 1024 * 1024) / 8, uploadThroughput: (1 * 1024 * 1024) / 8 });
  await page.waitForTimeout(420);
  console.log(when, "inspiration mid-load", JSON.stringify(await phases()));
  await shot("1-inspiration-mid-load");
  await page.waitForTimeout(5000);
  await page.mouse.move(700, 60);
  for (let i = 0; i < 80; i++) {
    const at = await page.evaluate(() => { const b = document.querySelector('[data-character-card="Aoi"]').getBoundingClientRect(); return [b.left, b.top]; });
    const dx = at[0] - 60, dy = at[1] - 120;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
    await page.mouse.wheel(Math.max(-220, Math.min(220, dx)), Math.max(-220, Math.min(220, dy)));
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(260);
  console.log(when, "characters mid-load", JSON.stringify(await phases()));
  await shot("2-characters-mid-load");
  await page.waitForTimeout(500);
  await shot("3-characters-filling");
  await page.waitForTimeout(7000);
  console.log(when, "characters loaded", JSON.stringify(await phases()), "canvases", await page.evaluate(() => document.querySelectorAll("canvas").length));
  await shot("4-characters-loaded");
  // one in use
  const v = await page.evaluate(() => { const b = document.querySelector('[data-character-card="Hana"] .char-view').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
  await page.mouse.move(v[0], v[1]);
  await page.waitForFunction(() => document.querySelector('[data-character-card="Hana"] .avatar-poster')?.dataset.poster === "live", undefined, { timeout: 20000 });
  await page.waitForTimeout(700);
  await shot("5-one-in-use-live");
  // the specimen
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.goto(`${CLIENT}/#/design`);
  const wave = page.locator("[data-design-arrival-wave]");
  await wave.scrollIntoViewIfNeeded({ timeout: 20000 });
  await page.waitForTimeout(900);
  await wave.getByRole("button", { name: "Replay the wave" }).click();
  await page.waitForTimeout(150);
  await wave.screenshot({ path: `${OUT}/design-wave-${when}-mid.jpg`, type: "jpeg", quality: 85 });
  await page.waitForTimeout(900);
  await page.locator("[data-design-progressive-image]").screenshot({ path: `${OUT}/design-progressive-images-${when}.jpg`, type: "jpeg", quality: 85 });
  await ctx.close();
}
await browser.close();

import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../apps/client/package.json", import.meta.url));
const pw = require("@playwright/test");
const CLIENT = "http://localhost:1440";
const only = process.argv[2]?.split(",");
const variants = {
  none: "",
  allimg: "img{visibility:hidden!important}",
  stills: ".avatar-still{visibility:hidden!important}",
  thumbs: ".char-thumb img{visibility:hidden!important}",
  mediaimg: ".panel-inner img{visibility:hidden!important}",
  canvas: "canvas{display:none!important}",
  svg: "svg{display:none!important}",
  masks: "*{mask:none!important;-webkit-mask:none!important;filter:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}",
  anim: "*{animation:none!important;transition:none!important}",
  shadow: "*{box-shadow:none!important}",
  charcards: ".char-view{visibility:hidden!important}",
};
const browser = await pw.webkit.launch({ headless: false });
for (const [k, css] of Object.entries(variants)) {
  if (only && !only.includes(k)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Perf Test", email: "perf-test@formindustries.co" }, headers: { Origin: CLIENT } });
  const p = await ctx.newPage();
  await p.goto(`${CLIENT}/?board=character-studio`);
  await p.waitForSelector("[data-section-id]");
  await p.waitForTimeout(2500);
  await p.addStyleTag({ content: css || "x{}" });
  await p.mouse.move(900, 450);
  for (let i = 0; i < 40; i++) { await p.keyboard.down("Meta"); await p.mouse.wheel(0, 12); await p.keyboard.up("Meta"); await p.waitForTimeout(30); }
  await p.waitForTimeout(2000);
  await p.evaluate(() => { window.__f = []; let l = performance.now(); const f = (n) => { window.__f.push(n - l); l = n; requestAnimationFrame(f); }; requestAnimationFrame(f); window.__to = 0; const t = () => { window.__to++; setTimeout(t, 0); }; t(); });
  const end = Date.now() + 2500; let i = 0;
  while (Date.now() < end) { await p.mouse.wheel(Math.floor(i++ / 40) % 2 ? -30 : 30, 0); await p.waitForTimeout(16); }
  const r = await p.evaluate(() => { const t = window.__f.slice(1); const avg = t.reduce((a, b) => a + b, 0) / t.length; return { fps: +(1000 / avg).toFixed(1), worst: Math.round(Math.max(...t)), timeouts: window.__to }; });
  console.log(k.padEnd(9), JSON.stringify(r));
  await ctx.close();
}
await browser.close();

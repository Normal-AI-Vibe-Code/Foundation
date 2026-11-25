import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../apps/client/package.json", import.meta.url));
const pw = require("@playwright/test");
const CLIENT = "http://localhost:1440";
const only = process.argv[2]?.split(",");
const variants = { none: "" };
const browser = await pw.webkit.launch({ headless: false });
for (const [k, css] of Object.entries(variants)) {
  if (only && !only.includes(k)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Perf Test", email: "perf-test@formindustries.co" }, headers: { Origin: CLIENT } });
  await ctx.addInitScript({ path: "instr.js" }); const p = await ctx.newPage();
  await p.goto(`${CLIENT}/?board=character-studio`);
  await p.waitForSelector("[data-section-id]");
  await p.waitForTimeout(2500);
  await p.addStyleTag({ content: css === "IDLE" ? "x{}" : (css || "x{}") });
  await p.mouse.move(900, 450);
  for (let i = 0; i < 40; i++) { await p.keyboard.down("Meta"); await p.mouse.wheel(0, 12); await p.keyboard.up("Meta"); await p.waitForTimeout(30); }
  await p.waitForTimeout(2000);
  await p.evaluate(() => { window.__js.total=0; window.__js.by={}; window.__f = []; let l = performance.now(); const f = (n) => { window.__f.push(n - l); l = n; requestAnimationFrame(f); }; requestAnimationFrame(f); window.__to = 0; window.__mut={}; new MutationObserver(ms=>{for(const m of ms){const k=(m.target.getAttribute('class')||m.target.tagName)+':'+(m.attributeName||m.type); window.__mut[k]=(window.__mut[k]||0)+1;}}).observe(document.querySelector('.port-layer'),{subtree:true,attributes:true,childList:true}); const t = () => { window.__to++; setTimeout(t, 0); }; t(); });
  const end = Date.now() + 2500; let i = 0;
  while (Date.now() < end) { if (k === "idle") { await p.waitForTimeout(50); continue; } await p.mouse.wheel(Math.floor(i++ / 40) % 2 ? -30 : 30, 0); await p.waitForTimeout(16); }
  const r = await p.evaluate(() => { const t = window.__f.slice(1); const avg = t.reduce((a, b) => a + b, 0) / t.length; return { fps: +(1000 / avg).toFixed(1), worst: Math.round(Math.max(...t)), frames: t.length, js: Math.round(window.__js.total), top: Object.entries(window.__js.by).sort((a,b)=>b[1][0]-a[1][0]).slice(0,12).map(([k,v])=>[Math.round(v[0]),v[1],Math.round(v[2]),k.slice(0,150)]), mut: window.__mut, far: document.querySelector('[data-far]')?.className, moving: !!document.querySelector('[data-moving]'), masked: document.querySelectorAll('.pipe-body[mask]').length, wires: document.querySelectorAll('.pipe').length, live: document.querySelectorAll('.pipe.is-live').length }; });
  console.log(k.padEnd(9), JSON.stringify(r));
  await ctx.close();
}
await browser.close();

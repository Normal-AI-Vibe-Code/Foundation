import { createRequire } from "node:module";
import { rmSync } from "node:fs";
const require = createRequire(new URL("../../../../apps/client/package.json", import.meta.url));
const pw = require("@playwright/test");
const CLIENT = "http://localhost:1440";
const dir = new URL("./wk-profile", import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
for (const run of ["first launch", "relaunch"]) {
  const ctx = await pw.webkit.launchPersistentContext(dir, { headless: false, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  if (run === "first launch") await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Perf Test", email: "perf-test@formindustries.co" }, headers: { Origin: CLIENT } });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  const seen = []; p.on("request", (r) => /\/files\//.test(r.url()) && seen.push(r));
  const t0 = Date.now();
  await p.goto(`${CLIENT}/?board=character-studio`); await p.waitForSelector("[data-section-id]");
  await p.waitForFunction(() => document.querySelectorAll(".char-thumb img[src^='blob:'], .avatar-still").length > 20, null, { timeout: 15000 }).catch(() => {});
  const shown = Date.now() - t0;
  await p.waitForTimeout(4000);
  let net = 0, kb = 0;
  for (const r of seen) { const res = await r.response(); if (!res) continue; const s = await r.sizes().catch(() => null); if (s && s.responseBodySize > 0) { net++; kb += s.responseBodySize / 1024; } }
  const n = await p.evaluate(async () => (await (await caches.open("foundation-image-cache-v3")).keys()).length);
  console.log(seen.filter(r=>!/[?&]w=/.test(r.url())).map(r=>r.url().replace(CLIENT,"")+" "+r.resourceType()).join("\n")); console.log(run.padEnd(12), JSON.stringify({ requests: seen.length, bodiesFromNetwork: net, kb: Math.round(kb), picturesShownMs: shown, cacheEntries: n }));
  await ctx.close();
}

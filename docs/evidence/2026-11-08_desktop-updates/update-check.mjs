#!/usr/bin/env node
// The whole update loop on a real Windows install, isolated from the installed Foundation:
// a "Foundation Update Check" app (its own name, identifier and WebView2 profile) at an old version is
// installed per user, a local feed offers a newer signed build, a person's press is simulated on the
// card, and the relaunched app must report the new version and say what changed.
//
//   node docs/evidence/2026-11-08_desktop-updates/update-check.mjs <dir-with-0.2.90-and-0.2.91> <out-dir>
//
// <dir>/<version>/ holds the NSIS setup.exe and its .sig from
//   tauri build --config conf-<version>.json  (productName "Foundation Update Check",
//   identifier co.normallab.foundation.updatecheck, endpoint http://localhost:16999/latest.json,
//   dangerousInsecureTransportProtocol, createUpdaterArtifacts) with the real updater key.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { join } from "node:path";

const [dir, out = "out", from = "0.2.90", to = "0.2.91"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const log = [];
const say = (s) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(line);
  log.push(line);
};
const setup = (v) => {
  const f = readdirSync(join(dir, v)).find((n) => n.endsWith("-setup.exe"));
  return { file: f, path: join(dir, v, f), sig: readFileSync(join(dir, v, `${f}.sig`), "utf8").trim() };
};
const oldSetup = setup(from);
const newSetup = setup(to);
const PRODUCT = "Foundation Update Check";
const installDir = join(process.env.LOCALAPPDATA, PRODUCT);
const exe = () => readdirSync(installDir).find((n) => n.endsWith(".exe") && !/uninstall/i.test(n));

// 1. the feed: latest.json offers `to`, its installer served beside it (counted, so we know it was fetched)
let served = 0;
const feed = {
  version: to,
  notes: "## Update check\n- The card offered this version\n- The signature was checked before it ran\n- What changed shows once after the restart",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {},
};
for (const k of ["windows-x86_64", "windows-x86_64-nsis"]) feed.platforms[k] = { signature: newSetup.sig, url: `http://localhost:16999/files/${encodeURIComponent(newSetup.file)}` };
const server = createServer((req, res) => {
  say(`feed ← ${req.method} ${req.url}`);
  if (req.url === "/latest.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(feed));
  }
  if (req.url?.startsWith("/files/")) {
    served++;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(newSetup.path).size });
    return createReadStream(newSetup.path).pipe(res);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(16999, "127.0.0.1", r));
say(`feed up: offers ${to} (${newSetup.file})`);

// 2. install the old version silently, per user
say(`installing ${from} (${oldSetup.file}) with /S`);
execFileSync(oldSetup.path, ["/S"], { stdio: "inherit" });
say(`installed: ${installDir}\\${exe()}`);

// 3. start it with WebView2's DevTools port open; the env carries through the installer's relaunch
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=16922" };
spawn(join(installDir, exe()), [], { env, detached: true, stdio: "ignore" }).unref();

async function attach(label) {
  for (let i = 0; i < 60; i++) {
    try {
      const b = await chromium.connectOverCDP("http://127.0.0.1:16922");
      const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("http://localhost:31441"));
      if (page) {
        say(`${label}: attached to ${page.url()}`);
        return { b, page };
      }
      await b.close();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label}: the window never came up`);
}

let { b, page } = await attach("old");
say(`old: app version ${await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:app|version"))}`);
// 4. the card arrives by itself a few seconds after launch
await page.locator(".update-shelf .update-card[data-phase=available]").waitFor({ timeout: 30_000 });
say(`old: card says "${await page.locator(".update-shelf strong").innerText()}"`);
await page.screenshot({ path: join(out, "01_offered.png") });

// 5. a person presses Update and restart; watch the download until the app goes away
await page.getByRole("button", { name: "Update and restart" }).click();
say("old: pressed Update and restart");
try {
  await page.locator(".update-shelf .update-card[data-phase=downloading], .update-shelf .update-card[data-phase=installing]").first().waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(out, "02_downloading.png") });
} catch {
  say("old: the download finished before a photo");
}
await b.close().catch(() => {});

// 6. the installer runs passively and opens the new version
await new Promise((r) => setTimeout(r, 6000));
({ b, page } = await attach("new"));
const v = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:app|version"));
say(`new: app version ${v}`);
await page.locator(".update-shelf .update-card[data-phase=updated]").waitFor({ timeout: 20_000 });
say(`new: card says "${await page.locator(".update-shelf strong").innerText()}"`);
await page.screenshot({ path: join(out, "03_updated.png") });
const ok = v === to && served === 1;
say(`installer fetched ${served}× · result: ${ok ? "PASS" : "FAIL"}`);
await b.close().catch(() => {});
server.close();
writeFileSync(join(out, "update-check.log"), log.join("\n") + "\n");
process.exit(ok ? 0 : 1);

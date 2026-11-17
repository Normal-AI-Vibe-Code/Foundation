/**
 * Foundation for Chrome: the build is a loadable MV3 package (every file the
 * manifest and pages name is there, no remote code, no host beyond localhost
 * and Foundation's own), and the address handling only ever opens http(s).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../dist/unpacked");
execFileSync(process.execPath, [join(here, "../build.mjs")], { env: { ...process.env, FOUNDATION_URL: "https://foundation.example.test/" }, stdio: "ignore" });
const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));

test("manifest: MV3, new tab is Today, popup and options, only storage", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.chrome_url_overrides.newtab, "newtab.html");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://localhost/*", "http://127.0.0.1/*", "https://foundation.example.test/*"]);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
});

test("every file the manifest and pages name is in the package", () => {
  const named = [...Object.values(manifest.icons), manifest.chrome_url_overrides.newtab, manifest.action.default_popup, manifest.options_page];
  for (const page of ["newtab.html", "popup.html", "options.html"]) {
    const html = readFileSync(join(out, page), "utf8");
    for (const [, src] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) named.push(src);
    assert.ok(!/<script(?![^>]*src=)/.test(html), `${page} has no inline script (CSP)`);
    assert.ok(!/https?:\/\//.test(html.replace(/placeholder="[^"]*"/g, "")), `${page} loads nothing remote`);
  }
  for (const js of ["newtab.js", "popup.js", "options.js", "store.js"]) {
    for (const [, src] of readFileSync(join(out, js), "utf8").matchAll(/from "\.\/([^"]+)"/g)) named.push(src);
  }
  for (const f of new Set(named)) assert.ok(existsSync(join(out, f)), `missing ${f}`);
  assert.match(readFileSync(join(out, "tokens.css"), "utf8"), /url\(fonts\/hanken-grotesk\.woff2\)/);
  assert.match(readFileSync(join(out, "config.js"), "utf8"), /"https:\/\/foundation\.example\.test"/);
});

test("the popup's fallback shelf is the company's apps", async () => {
  const { FALLBACK_APPS } = await import(pathToFileURL(join(out, "apps.js")).href);
  const names = FALLBACK_APPS.map((a) => a.name);
  for (const n of ["BomForm", "FactoryForm", "HyperForm", "Vision"]) assert.ok(names.includes(n), n);
});

test("addresses: http(s) only, tidied; Today is marked as from Chrome", async () => {
  const { clean, todayUrl } = await import(pathToFileURL(join(out, "store.js")).href);
  assert.equal(clean(" https://foundation.example.test/ "), "https://foundation.example.test");
  assert.equal(clean("http://localhost:1430"), "http://localhost:1430");
  assert.throws(() => clean("javascript:alert(1)"), /http/);
  assert.throws(() => clean("file:///etc/passwd"), /http/);
  assert.equal(todayUrl("http://localhost:1430"), "http://localhost:1430/?from=chrome#/today");
});

/**
 * The official package: built from release.json (placeholders listed, never
 * hidden), no localhost, Foundation and the company's domains granted at
 * install, a store icon, and the admin's policies pointing at the same
 * Foundation. The admin's address (Chrome policy) wins over the person's own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = mkdtempSync(join(tmpdir(), "foundation-ext-release-"));
const said = execFileSync(process.execPath, [join(root, "build.mjs"), "--release"], { env: { ...process.env, FOUNDATION_URL: "", EXTENSION_DIST: dist }, encoding: "utf8" });
const release = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dist, "unpacked/manifest.json"), "utf8"));
const foundation = release.foundationUrl.value;

test("the release manifest: Foundation and the company's domains, no localhost, the package's version", () => {
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.host_permissions, [`${foundation}/*`, ...release.companyDomains.value.map((d) => `https://*.${d}/*`)]);
  assert.ok(!JSON.stringify(manifest).includes("localhost"));
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.homepage_url, foundation);
  assert.equal(manifest.storage.managed_schema, "managed_schema.json");
  assert.ok(existsSync(join(dist, "unpacked/managed_schema.json")));
  assert.ok(manifest.description.length <= 132, "the store's summary limit");
  assert.ok(existsSync(join(dist, `foundation-today-${pkg.version}.zip`)));
  assert.ok(existsSync(join(dist, "store/icon-128.png")));
});

test("placeholders are listed by name, not hidden", () => {
  for (const [key, v] of Object.entries(release)) if (v?.placeholder) assert.match(said, new RegExp(`- ${key}:`));
});

test("the admin's policies: force-install from the Web Store, and Foundation's address", () => {
  const id = release.extensionId.value || "EXTENSION_ID";
  const admin = JSON.parse(readFileSync(join(dist, "policy/admin-console-policy.json"), "utf8"));
  assert.deepEqual(admin, { foundationUrl: { Value: foundation } });
  const reg = readFileSync(join(dist, "policy/windows.reg"), "utf8");
  assert.ok(reg.includes(`"1"="${id};https://clients2.google.com/service/update2/crx"`));
  assert.ok(reg.includes(`3rdparty\\extensions\\${id}\\policy]`));
  assert.ok(reg.includes(`"foundationUrl"="${foundation}"`));
  assert.ok(readFileSync(join(dist, "policy/com.google.Chrome.plist"), "utf8").includes(`<string>${id};https://clients2.google.com/service/update2/crx</string>`));
  assert.ok(readFileSync(join(dist, `policy/com.google.Chrome.extensions.${id}.plist`), "utf8").includes(`<string>${foundation}</string>`));
});

test("the admin's address wins over the person's, and a bad one is ignored", async () => {
  const fake = (managed, synced) => ({
    storage: {
      managed: { get: async () => managed },
      sync: { get: async () => synced, set: async () => {} },
    },
  });
  const load = async (tag) => import(`${pathToFileURL(join(dist, "unpacked/store.js")).href}?${tag}`);
  globalThis.chrome = fake({ foundationUrl: "https://foundation.formindustries.com/" }, { foundationUrl: "https://elsewhere.example" });
  assert.equal(await (await load("a")).foundationUrl(), "https://foundation.formindustries.com");
  globalThis.chrome = fake({}, { foundationUrl: "https://elsewhere.example" });
  assert.equal(await (await load("b")).foundationUrl(), "https://elsewhere.example");
  globalThis.chrome = fake({ foundationUrl: "javascript:alert(1)" }, {});
  assert.equal(await (await load("c")).foundationUrl(), foundation);
  delete globalThis.chrome;
});

test("the privacy page's contact is release.json's support email", () => {
  const page = readFileSync(join(root, "../client/src/privacy/Privacy.tsx"), "utf8");
  assert.equal(/SUPPORT_EMAIL = "([^"]+)"/.exec(page)?.[1], release.supportEmail.value);
});

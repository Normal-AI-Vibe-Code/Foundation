/**
 * Release notes (docs/blog/<version>.md): every post has its front-matter, is
 * named for its version, and Settings → Releases lists them newest first.
 * The release script refuses a version without a post, so the one the app is
 * built as must have one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { compareVersions, longDate, parsePost, releasesFrom } from "../src/settings/releases";

const dir = new URL("../../../docs/blog/", import.meta.url);
const files = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => [f, readFileSync(new URL(f, dir), "utf8")]),
);

test("each post is named for its version and says its date and title", () => {
  for (const [name, text] of Object.entries(files)) {
    if (name === "README.md") continue;
    const post = parsePost(text);
    assert.ok(post, `${name} has front-matter`);
    assert.equal(`${post.version}.md`, name, "named for its version");
    assert.match(post.date, /^\d{4}-\d{2}-\d{2}$/, `${name}: date as YYYY-MM-DD`);
    assert.ok(post.title.length > 10, `${name}: a title`);
    assert.ok(post.body.length > 200, `${name}: says something`);
    assert.ok(!post.body.startsWith("---"), "the front-matter isn't in the body");
  }
});

test("the version this app is built as has a post", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.ok(
    releasesFrom(files).some((p) => p.version === pkg.version),
    `docs/blog/${pkg.version}.md is missing`,
  );
});

test("newest first, comparing versions as numbers", () => {
  assert.ok(compareVersions("0.10.0", "0.9.2") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  const order = releasesFrom({
    a: "---\nversion: 0.9.0\ndate: 2026-01-01\ntitle: Nine\n---\nx",
    b: "---\nversion: 0.10.0\ndate: 2026-02-01\ntitle: Ten\n---\ny",
    c: "# a README, no front-matter",
  }).map((p) => p.version);
  assert.deepEqual(order, ["0.10.0", "0.9.0"]);
});

test("posts read with Windows line ends and quoted titles", () => {
  const p = parsePost('---\r\nversion: 1.2.3\r\ndate: 2026-11-09\r\ntitle: "Quoted: with a colon"\r\n---\r\n\r\nBody here.\r\n');
  assert.deepEqual(p, { version: "1.2.3", date: "2026-11-09", title: "Quoted: with a colon", body: "Body here." });
  assert.equal(longDate("2026-11-08"), "8 November 2026");
  assert.equal(longDate("soon"), "soon");
});

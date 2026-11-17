import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain .mjs script, imported for its pure parts
import { feed, ciVersion, ciNotes } from "../../../scripts/release.mjs";
import { parsePost } from "../src/settings/releases";

test("latest.json names a signed installer per platform, at its release URL", () => {
  const art = (file: string, sig: string | null) => ({ file, path: file, sig, sigPath: `${file}.sig` });
  const f = feed(
    "0.3.0",
    { body: "- Desktop updates", title: "t", date: null },
    { nsis: art("Foundation_0.3.0_x64-setup.exe", "SIG-NSIS"), msi: art("Foundation_0.3.0_x64_en-US.msi", "SIG-MSI"), appTar: null, appimage: art("x.AppImage", null) },
    new Date("2026-11-09T08:00:00.123Z"),
  );
  assert.equal(f.version, "0.3.0");
  assert.equal(f.notes, "- Desktop updates");
  assert.equal(f.pub_date, "2026-11-09T08:00:00Z");
  assert.deepEqual(Object.keys(f.platforms).sort(), ["windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis"], "unsigned artifacts are left out");
  assert.equal(f.platforms["windows-x86_64"].url, "https://github.com/joshleong/Foundation/releases/download/v0.3.0/Foundation_0.3.0_x64-setup.exe");
  assert.equal(f.platforms["windows-x86_64-msi"].signature, "SIG-MSI");
});

test("CI publishes the checked-in version plus its run number, always newer", () => {
  assert.equal(ciVersion("0.3.0", "1"), "0.3.1");
  assert.equal(ciVersion("0.3.0", 57), "0.3.57");
  assert.equal(ciVersion("0.4.2", "3"), "0.4.5", "a person's bump moves CI on from there");
  assert.throws(() => ciVersion("0.3.0", undefined), "no run number, no release");
  assert.throws(() => ciVersion("0.3.0", "0"));
  assert.throws(() => ciVersion("next", "4"));
});

test("CI's notes are the commits since the last release, a post Settings → Releases can read", () => {
  const subjects = [
    "Plan: synced after rune-frame-cost moved to Review (#133)",
    'Rune: the paper, "Hanken Grotesk", markdown notes',
    "Desktop: releases build themselves on every push to main",
  ];
  const post = parsePost(ciNotes("0.3.8", subjects, "2026-11-13"));
  assert.ok(post);
  assert.equal(post.version, "0.3.8");
  assert.equal(post.date, "2026-11-13");
  assert.equal(post.title, "Rune: the paper, Hanken Grotesk, markdown notes", "the newest change, quotes dropped; plan syncs left out");
  assert.equal(post.body, '- Rune: the paper, "Hanken Grotesk", markdown notes\n- Desktop: releases build themselves on every push to main');
  const many = parsePost(ciNotes("0.3.9", Array.from({ length: 30 }, (_, i) => `Change ${i} ${"word ".repeat(30)}`), "2026-11-13"));
  assert.ok(many && many.title.length <= 91 && many.title.endsWith("…"));
  assert.match(many.body, /- and 5 more changes$/);
  assert.equal(parsePost(ciNotes("0.3.10", ["Plan: synced"], "2026-11-13"))?.body, "- Small fixes.");
});

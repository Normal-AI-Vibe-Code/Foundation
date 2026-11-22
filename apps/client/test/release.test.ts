import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain .mjs script, imported for its pure parts
import { feed, mergeFeeds, ciVersion, ciNotes } from "../../../scripts/release.mjs";
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

test("a Mac build is offered only to Macs of the architecture it was built on", () => {
  const notes = { body: "- Macs", title: "t", date: null };
  const tar = (arch: string) => ({ file: `Foundation_0.3.40_${arch === "aarch64" ? "aarch64" : "x64"}.app.tar.gz`, path: "Foundation.app.tar.gz", sig: `SIG-${arch}`, sigPath: "Foundation.app.tar.gz.sig", arch });
  const dmg = { file: "Foundation_0.3.40_aarch64.dmg", path: "x.dmg", sig: null, sigPath: "x.dmg.sig", arch: "aarch64" };
  const arm = feed("0.3.40", notes, { nsis: null, msi: null, appTar: tar("aarch64"), dmg, appimage: null });
  assert.deepEqual(Object.keys(arm.platforms).sort(), ["darwin-aarch64", "darwin-aarch64-app"], "no darwin-x86_64: an Intel Mac can't run it; the .dmg has no .sig and isn't in the feed");
  assert.equal(arm.platforms["darwin-aarch64"].url, "https://github.com/joshleong/Foundation/releases/download/v0.3.40/Foundation_0.3.40_aarch64.app.tar.gz", "published under its versioned name, not Foundation.app.tar.gz");
  assert.equal(arm.platforms["darwin-aarch64-app"].signature, "SIG-aarch64");
  const intel = feed("0.3.40", notes, { nsis: null, msi: null, appTar: tar("x86_64"), dmg: null, appimage: null });
  assert.deepEqual(Object.keys(intel.platforms).sort(), ["darwin-x86_64", "darwin-x86_64-app"]);
});

test("CI's one latest.json names every platform's build, and refuses builds that disagree", () => {
  const art = (file: string, sig: string, arch = "x86_64") => ({ file, path: file, sig, sigPath: `${file}.sig`, arch });
  const notes = (body: string) => ({ body, title: "t", date: null });
  const win = feed("0.3.40", notes("- from Windows"), { nsis: art("Foundation_0.3.40_x64-setup.exe", "W"), msi: art("Foundation_0.3.40_x64_en-US.msi", "M"), appTar: null, appimage: null });
  const mac = feed("0.3.40", notes("- from the Mac"), { nsis: null, msi: null, appTar: art("Foundation_0.3.40_aarch64.app.tar.gz", "A", "aarch64"), appimage: null });
  const both = mergeFeeds([win, mac], new Date("2026-11-20T12:00:00.500Z"));
  assert.equal(both.version, "0.3.40");
  assert.equal(both.notes, "- from Windows", "the first build's notes");
  assert.equal(both.pub_date, "2026-11-20T12:00:00Z");
  assert.deepEqual(Object.keys(both.platforms).sort(), ["darwin-aarch64", "darwin-aarch64-app", "windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis"]);
  assert.equal(both.platforms["darwin-aarch64"].signature, "A");
  assert.equal(both.platforms["windows-x86_64"].signature, "W");
  assert.throws(() => mergeFeeds([win, { ...mac, version: "0.3.41" }]), /disagree/);
  assert.throws(() => mergeFeeds([win, win]), /both offer/);
  assert.throws(() => mergeFeeds([{ ...win, platforms: {} }]), /no build/);
  assert.throws(() => mergeFeeds([]));
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

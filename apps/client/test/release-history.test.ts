/**
 * The release history (docs/releases.json, settings/history.ts): every published tag is in it with its
 * changes, and the app finds where it stands (a CI build is its stamped version; a dev client the tag it
 * is ahead of). 2026-11-27: the updates panel keeps the version prominent and the whole history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error: a plain .mjs script, imported for its pure parts
import { historyEntry, historyFile, shownSubject } from "../../../scripts/release.mjs";
import { byDay, parseDescribe, releaseAt, sinceRelease, standing, tally, type HistoryRelease } from "../src/settings/history";
import { compareVersions } from "../src/settings/releases";

const file = JSON.parse(readFileSync(new URL("../../../docs/releases.json", import.meta.url), "utf8")) as { releases: HistoryRelease[] };

test("docs/releases.json lists each release once, newest first, each with a date, commit, title and changes", () => {
  const vs = file.releases.map((r) => r.version);
  assert.ok(vs.length >= 50, `${vs.length} releases`);
  assert.equal(new Set(vs).size, vs.length);
  assert.deepEqual([...vs].sort((a, b) => compareVersions(b, a)), vs);
  for (const r of file.releases) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(r.sha, /^[0-9a-f]{7}$/);
    assert.ok(r.title.length > 0);
    assert.ok(Array.isArray(r.changes));
    for (const c of r.changes) assert.ok(shownSubject(c), c);
  }
  assert.ok(vs.includes("0.3.0") && vs.includes("0.2.0"));
});

test("a version's entry leaves out plan syncs, merges and bumps, keeps the newest change as its title, and counts what it cut", () => {
  const e = historyEntry("0.3.9", "2026-11-13T10:00:00-10:00", "abcdef1234", ["Plan: synced", "Merge remote-tracking branch 'origin/main' into x", "Cards resize by their edges", "Foundation 0.3.0", "Fix the bell"]);
  assert.deepEqual(e, { version: "0.3.9", date: "2026-11-13T10:00:00-10:00", sha: "abcdef1", title: "Cards resize by their edges", changes: ["Cards resize by their edges", "Fix the bell"] });
  assert.equal(historyEntry("0.3.10", "2026-11-13", "abcdef1", ["Plan: synced"]).title, "Small fixes");
  const long = historyEntry("0.3.11", "2026-11-13", "abcdef1", Array.from({ length: 70 }, (_, i) => `Change ${i}`), 60);
  assert.equal(long.changes.length, 60);
  assert.equal(long.more, 10);
  const f = historyFile([e, historyEntry("0.3.10", "x", "abcdef1", []), { ...e }]);
  assert.deepEqual(f.releases.map((r: HistoryRelease) => r.version), ["0.3.10", "0.3.9"]);
});

test("git describe is read as the tag, the commits since and the commit", () => {
  assert.deepEqual(parseDescribe("v0.3.56-3-g4a8ecee"), { tag: "0.3.56", ahead: 3, sha: "4a8ecee" });
  assert.deepEqual(parseDescribe("v0.3.56-0-g4a8ecee-dirty"), { tag: "0.3.56", ahead: 0, sha: "4a8ecee" });
  assert.deepEqual(parseDescribe("4a8ecee"), { tag: null, ahead: 0, sha: "4a8ecee" });
  assert.equal(parseDescribe(""), null);
  assert.equal(parseDescribe("nonsense"), null);
});

const rel = (version: string, date = "2026-11-26T10:00:00-10:00", sha = version.replace(/\D/g, "").padEnd(7, "0")): HistoryRelease => ({ version, date, sha, title: `t ${version}`, changes: [`c ${version}`] });
const H = [rel("0.3.56"), rel("0.3.55"), rel("0.3.54", "2026-11-25T10:00:00-10:00")];

test("the app finds itself: a CI build by its stamp, a checkout by the tag it is ahead of", () => {
  // CI stamps 0.3.56 before the tag exists, so describe names 0.3.55
  assert.deepEqual(standing("0.3.56", parseDescribe("v0.3.55-2-gabcdef0"), H), { version: "0.3.56", kind: "release", release: H[0], ahead: 0, newer: null });
  // an installed older build knows a newer one only if its history has it (it doesn't: the update card says so)
  assert.equal(standing("0.3.55", null, H).newer, H[0]);
  // npm run dev: package.json says 0.3.0, describe says 3 past 0.3.56
  const dev = standing("0.3.0", parseDescribe("v0.3.56-3-g1234567"), H);
  assert.equal(dev.kind, "checkout");
  assert.equal(dev.version, "0.3.56");
  assert.equal(dev.ahead, 3);
  assert.equal(dev.release, H[0]);
  // exactly on a tag
  assert.equal(standing("0.3.0", parseDescribe("v0.3.55-0-g1234567"), H).kind, "release");
  assert.equal(standing("0.3.0", parseDescribe("v0.3.55-0-g1234567"), H).newer, H[0]);
  // no git, no history
  assert.equal(standing("0.3.0", null, []).kind, "unknown");
});

test("the history by day, its tally, where releases were cut and what a checkout hasn't released", () => {
  assert.deepEqual(byDay(H).map((d) => [d.day, d.releases.length]), [["2026-11-26", 2], ["2026-11-25", 1]]);
  assert.deepEqual(tally(H), { releases: 3, changes: 3, since: "2026-11-25", days: 2 });
  const at = releaseAt(H);
  assert.equal(at(`${H[1].sha}99999`), "0.3.55");
  assert.equal(at("fffffff"), null);
  const commits = [{ hash: "aaaaaaa1" }, { hash: "bbbbbbb2" }, { hash: `${H[0].sha}c` }, { hash: "ddddddd" }];
  assert.deepEqual(sinceRelease(commits, H[0].sha), commits.slice(0, 2));
  assert.deepEqual(sinceRelease(commits, "0000000"), []);
  assert.deepEqual(sinceRelease(commits, null), []);
});

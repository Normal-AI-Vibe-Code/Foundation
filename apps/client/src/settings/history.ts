/**
 * Foundation's release history (docs/releases.json, written by `node scripts/release.mjs history` from the v*
 * tags, and by every CI build with itself on top) and where the app that is running stands in it.
 *
 * 2026-11-27, Josh: "keep a strong sense of history in the updates panel, and keep the version number
 * prominent in that panel and the latest changes". The hand-written posts (docs/blog) stopped at 0.3.0 while
 * CI went on to publish fifty releases; this is all of them, bundled, so the Changes panel shows them offline.
 */

export interface HistoryRelease {
  version: string;
  /** ISO time of the commit it was cut from */
  date: string;
  /** that commit, short */
  sha: string;
  title: string;
  /** its commits' subjects, newest first (plan syncs and merges left out) */
  changes: string[];
  /** changes past the ones kept */
  more?: number;
}

/** what `git describe --tags --match v* --long` said when this client was built: the last tag, commits since, the commit */
export interface Build {
  tag: string | null;
  ahead: number;
  sha: string | null;
}

/** "v0.3.56-3-g4a8ecee" → { tag: "0.3.56", ahead: 3, sha: "4a8ecee" }; a bare hash (no tag reachable) → its sha only */
export function parseDescribe(s: string | null | undefined): Build | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  const m = /^v(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]{4,40})(-dirty)?$/.exec(t);
  if (m) return { tag: m[1], ahead: Number(m[2]), sha: m[3] };
  if (/^[0-9a-f]{4,40}$/.test(t)) return { tag: null, ahead: 0, sha: t };
  return null;
}

export interface Standing {
  /** the version to set large */
  version: string;
  /** a published release (an installed app, built by CI), a checkout ahead of a release (npm run dev), or neither known */
  kind: "release" | "checkout" | "unknown";
  /** the release it is, or the one the checkout started from */
  release: HistoryRelease | null;
  /** for a checkout: commits since that release */
  ahead: number;
  /** the newest release published, when it is newer than this app's */
  newer: HistoryRelease | null;
}

/**
 * Where this app stands. A CI build is stamped with its own version and finds itself in the history; a dev
 * client still says the checked-in base (0.3.0), so its git describe names the release it is ahead of.
 */
export function standing(version: string, build: Build | null, releases: HistoryRelease[]): Standing {
  const newest = releases[0] ?? null;
  const find = (v: string) => releases.find((r) => r.version === v) ?? null;
  const newerThan = (r: HistoryRelease | null) => (newest && r && compare(newest.version, r.version) > 0 ? newest : null);
  // a CI build stamps its version before its tag exists, so its describe names the release before it: the stamp is it
  const stamped = !build?.tag || compare(version, build.tag) > 0;
  if (stamped && find(version)) return { version, kind: "release", release: find(version), ahead: 0, newer: newerThan(find(version)) };
  if (build?.tag) {
    const from = find(build.tag);
    if (build.ahead === 0) return { version: build.tag, kind: from ? "release" : "unknown", release: from, ahead: 0, newer: newerThan(from) };
    return { version: build.tag, kind: "checkout", release: from, ahead: build.ahead, newer: newerThan(from) };
  }
  return { version, kind: "unknown", release: null, ahead: 0, newer: null };
}

function compare(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** the calendar day a release was cut, as it was written (its own offset), "2026-11-26" */
export const dayKey = (iso: string) => /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? iso;

/** the releases by the day they were cut, newest day first */
export function byDay(releases: HistoryRelease[]): Array<{ day: string; releases: HistoryRelease[] }> {
  const out: Array<{ day: string; releases: HistoryRelease[] }> = [];
  for (const r of releases) {
    const day = dayKey(r.date);
    const last = out[out.length - 1];
    if (last && last.day === day) last.releases.push(r);
    else out.push({ day, releases: [r] });
  }
  return out;
}

/** the whole history in a line's worth of numbers */
export function tally(releases: HistoryRelease[]): { releases: number; changes: number; since: string | null; days: number } {
  const changes = releases.reduce((n, r) => n + r.changes.length + (r.more ?? 0), 0);
  const days = new Set(releases.map((r) => dayKey(r.date))).size;
  return { releases: releases.length, changes, since: releases.length ? dayKey(releases[releases.length - 1].date) : null, days };
}

/** each release's commit, short, to the version cut from it: the Code face marks where releases were cut */
export function releaseAt(releases: HistoryRelease[]): (hash: string) => string | null {
  const map = new Map(releases.map((r) => [r.sha, r.version]));
  return (hash) => map.get(hash.slice(0, 7)) ?? null;
}

/** the commits newer than a release, from a newest-first log (none when the release's commit isn't in it) */
export function sinceRelease<T extends { hash: string }>(commits: T[], sha: string | null | undefined): T[] {
  if (!sha) return [];
  const i = commits.findIndex((c) => c.hash.startsWith(sha));
  return i < 0 ? [] : commits.slice(0, i);
}

/** "3 changes", "1 change" */
export const changesWord = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

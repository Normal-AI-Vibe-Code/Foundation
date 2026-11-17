/**
 * Release notes (docs/blog/<version>.md): front-matter (version, date, title)
 * and a markdown body. Settings → Releases shows them newest first; they're
 * bundled with the app (SettingsPage reads the folder with import.meta.glob),
 * so they open offline. scripts/release.mjs uses the same body for the GitHub
 * Release and the updater's notes.
 */

export interface ReleasePost {
  version: string;
  date: string;
  title: string;
  body: string;
}

/** One post from its file's text; null when it has no version (a README, a draft without front-matter). */
export function parsePost(text: string): ReleasePost | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  if (!meta.version) return null;
  return { version: meta.version, date: meta.date ?? "", title: meta.title ?? `Foundation ${meta.version}`, body: m[2].trim() };
}

/** 0.10.0 after 0.9.2: versions compared part by part, as numbers */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** every post from a folder's files, newest version first */
export function releasesFrom(files: Record<string, string>): ReleasePost[] {
  return Object.values(files)
    .map(parsePost)
    .filter((p): p is ReleasePost => p !== null)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** "8 November 2026" from "2026-11-08" (as written, whatever the time zone) */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

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

// ---------------------------------------------------------------- a post, outlined (the release page)

/** what a part of a release is about: picks its icon on the release page */
export type ReleaseKind = "new" | "fix" | "agent" | "plan" | "release" | "search" | "grid" | "talk" | "machine";

export interface ReleasePart {
  title: string;
  /** one sentence saying what it is */
  summary: string;
  kind: ReleaseKind;
  /** how many separate things it lists (at least 1) */
  count: number;
}

export interface ReleaseOutline {
  /** the post's opening paragraph, as plain words */
  lede: string;
  parts: ReleasePart[];
  /** things changed or added, and things fixed, counted from the post's own lists */
  changes: number;
  fixes: number;
}

/** markdown's marks taken off, for a line of plain words */
export function plainWords(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** the first sentence of some words, cut at a word if it runs long */
export function firstSentence(text: string, max = 150): string {
  const plain = plainWords(text);
  const m = /^(.+?[.!?])(\s|$)/.exec(plain);
  let s = m ? m[1] : plain;
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return s;
}

const KINDS: Array<[RegExp, ReleaseKind]> = [
  [/\bfix/i, "fix"],
  [/agent|crew|council|shiba/i, "agent"],
  [/\bplan\b|kanban|github/i, "plan"],
  [/release|update|install|desktop app|version/i, "release"],
  [/search|file|folder|upload/i, "search"],
  [/huddle|slack|talk|voice/i, "talk"],
  [/machine|terminal|kiri|docker/i, "machine"],
  [/board|grid|section|card|wire|table|note/i, "grid"],
];
export const releaseKind = (title: string): ReleaseKind => KINDS.find(([re]) => re.test(title))?.[1] ?? "new";

/**
 * A post as the release page shows it before the full notes: its opening paragraph, and each of its
 * `## ` parts as a title, one sentence and a count. Counted from the post itself, never written by hand.
 */
export function outlinePost(body: string): ReleaseOutline {
  const chunks = body.replace(/\r\n/g, "\n").split(/^## +/m);
  const lede = plainWords((chunks.shift() ?? "").split(/\n\s*\n/)[0] ?? "");
  let changes = 0;
  let fixes = 0;
  const parts: ReleasePart[] = chunks.map((chunk) => {
    const nl = chunk.indexOf("\n");
    const title = plainWords(nl < 0 ? chunk : chunk.slice(0, nl));
    const text = nl < 0 ? "" : chunk.slice(nl + 1);
    const kind = releaseKind(title);
    const lines = text.split("\n");
    const top = lines.filter((l) => /^[-*] /.test(l));
    // a "Fixed:" bullet inside another part lists fixes of its own, indented under it
    let nested = 0;
    let inFixed = false;
    for (const l of lines) {
      if (/^[-*] /.test(l)) inFixed = /^[-*] \*\*Fixed/i.test(l);
      else if (inFixed && /^\s+[-*] /.test(l)) nested++;
    }
    const count = Math.max(1, top.length);
    if (kind === "fix") fixes += count;
    else {
      changes += count - (nested ? 1 : 0);
      fixes += nested;
    }
    const firstPara = text.split(/\n\s*\n/).find((p) => p.trim()) ?? "";
    const lead = /^[-*] /.test(firstPara.trim()) ? firstPara.trim().split("\n")[0].replace(/^[-*] /, "") : firstPara;
    return { title, summary: firstSentence(lead), kind, count };
  });
  return { lede, parts, changes, fixes };
}

/**
 * What changed in Foundation's own code: the commits of the checkout this server runs from, for the change log
 * among the top bar's tools (shell/Tools.tsx). Read with `git log`, newest first; nothing is written. A server that
 * isn't in a git checkout (an installed copy) says so instead.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { childOptions, execFileChild, type ExecFileOptions } from "./child.ts";

export interface Commit {
  hash: string;
  /** ISO time it was committed */
  at: string;
  author: string;
  subject: string;
  body: string;
}

const SEP = "\x1f";
const END = "\x1e";

/** parse `git log --format=%H%x1f%cI%x1f%an%x1f%s%x1f%b%x1e` */
export function parseLog(out: string): Commit[] {
  return out
    .split(END)
    .map((r) => r.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [hash, at, author, subject, body = ""] = r.split(SEP);
      return { hash, at, author, subject, body: body.trim() };
    })
    .filter((c) => /^[0-9a-f]{7,40}$/.test(c.hash ?? ""));
}

export type Changelog = { available: boolean; branch?: string; commits: Commit[]; why?: string };

/**
 * Where the checkout's HEAD stands, without starting git: the size and time of HEAD's own log, which git
 * appends to on every commit, checkout, merge, reset, pull and branch rename. `.git` is looked for from
 * `cwd` upward; in a worktree it is a file naming the real folder. Null when it can't be told (no checkout,
 * a log that is switched off): then nothing is kept and git is asked every time.
 */
export function headMark(cwd: string): string | null {
  try {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      const dot = join(dir, ".git");
      const st = statSync(dot, { throwIfNoEntry: false });
      if (st) {
        const gitDir = st.isDirectory() ? dot : resolve(dir, /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1].trim() ?? "");
        const log = statSync(join(gitDir, "logs", "HEAD"));
        return `${gitDir}|${log.size}|${log.mtimeMs}`;
      }
      if (dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

/** the last answer for each folder and length, kept while HEAD stays where it was (git took 50 ms a request; profiled 2026-11-20) */
const kept = new Map<string, { mark: string; log: Changelog }>();

export async function changelog(limit = 60, cwd = process.cwd()): Promise<Changelog> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 60));
  const key = `${resolve(cwd)}|${n}`;
  const mark = headMark(cwd);
  const had = kept.get(key);
  if (mark && had?.mark === mark) return had.log;
  const log = await readLog(n, cwd);
  // kept only if HEAD didn't move while git was reading it, and only an answer git gave
  if (mark && log.available && headMark(cwd) === mark) kept.set(key, { mark, log });
  else kept.delete(key);
  return log;
}

function readLog(n: number, cwd: string): Promise<Changelog> {
  const git = (args: string[]) =>
    // git reads the checkout and needs nothing beyond the allowlist (it finds its settings in the home folder)
    new Promise<string>((ok, no) => execFileChild("git", args, childOptions<ExecFileOptions>({ extras: [] }, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 8000 }), (e, out) => (e ? no(e) : ok(out))));
  return Promise.all([git(["log", `-n${n}`, `--format=%H${SEP}%cI${SEP}%an${SEP}%s${SEP}%b${END}`]), git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")])
    .then(([log, branch]) => ({ available: true, branch: branch.trim() || undefined, commits: parseLog(log) }))
    .catch((e: Error) => ({ available: false, commits: [], why: /not a git repository/i.test(e.message) ? "This server isn't running from a git checkout." : "git couldn't be read here." }));
}

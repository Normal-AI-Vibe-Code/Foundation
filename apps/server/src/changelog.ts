/**
 * What changed in Foundation's own code: the commits of the checkout this server runs from, for the change log
 * among the top bar's tools (shell/Tools.tsx). Read with `git log`, newest first; nothing is written. A server that
 * isn't in a git checkout (an installed copy) says so instead.
 */

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

export function changelog(limit = 60, cwd = process.cwd()): Promise<{ available: boolean; branch?: string; commits: Commit[]; why?: string }> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 60));
  const git = (args: string[]) =>
    // git reads the checkout and needs nothing beyond the allowlist (it finds its settings in the home folder)
    new Promise<string>((ok, no) => execFileChild("git", args, childOptions<ExecFileOptions>({ extras: [] }, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 8000 }), (e, out) => (e ? no(e) : ok(out))));
  return Promise.all([git(["log", `-n${n}`, `--format=%H${SEP}%cI${SEP}%an${SEP}%s${SEP}%b${END}`]), git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")])
    .then(([log, branch]) => ({ available: true, branch: branch.trim() || undefined, commits: parseLog(log) }))
    .catch((e: Error) => ({ available: false, commits: [], why: /not a git repository/i.test(e.message) ? "This server isn't running from a git checkout." : "git couldn't be read here." }));
}

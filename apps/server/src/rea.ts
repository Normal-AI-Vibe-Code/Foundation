/**
 * How a REA job starts (jobs.ts): the target is checked, then the program and
 * its arguments are worked out for this platform. Pure over a given platform,
 * env, Node and file system, so the exact command is testable on any machine.
 *
 * Nothing here goes through a shell: the target (a URL or a path a person or
 * an agent typed) is always one argument in an array. On Windows `npx` and an
 * npm-installed `claude` are `.cmd` shims, which `spawn` can only start through
 * cmd.exe, so instead the script a shim wraps runs under this Node:
 *  - npx → `<node> <npm>/bin/npx-cli.js …`, npm found next to this Node, from
 *    `npm_execpath`, or from an `npx.cmd` on PATH (the script it points at);
 *  - claude → `claude.exe` on PATH as is; a `claude.cmd` runs the cli.js it
 *    wraps under this Node; a shim with no script in it is refused.
 * macOS and Linux run `npx` and `claude` as they always have.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface Runtime {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** the Node running Foundation's server */
  execPath: string;
  /** where a relative target is resolved from */
  cwd: string;
  exists: (f: string) => boolean;
  isDir: (f: string) => boolean;
  read: (f: string) => string;
}

export const here = (): Runtime => ({
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  cwd: process.cwd(),
  exists: existsSync,
  isDir: (f) => {
    try {
      return statSync(f).isDirectory();
    } catch {
      return false;
    }
  },
  read: (f) => readFileSync(f, "utf8"),
});

export type Refused = { ok: false; reason: string };
export type Command = { ok: true; cmd: string; pre: string[] };
export type Target = { ok: true; kind: "url" | "app" | "file"; target: string };
export type ReaPlan = { ok: true; route: "rea-agents" | "claude"; target: string; cmd: string; argv: string[] } | Refused;

const pathOf = (rt: Pick<Runtime, "platform">) => (rt.platform === "win32" ? path.win32 : path.posix);
const refuse = (reason: string): Refused => ({ ok: false, reason });

/** an env var, by any case on Windows (its env is case-insensitive; `Path` is common) */
function envGet(rt: Runtime, name: string): string | undefined {
  if (rt.env[name] !== undefined || rt.platform !== "win32") return rt.env[name];
  const key = Object.keys(rt.env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? rt.env[key] : undefined;
}

function pathDirs(rt: Runtime): string[] {
  const sep = rt.platform === "win32" ? ";" : ":";
  return (envGet(rt, "PATH") ?? "")
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/** the script an npm shim (`.cmd`) runs: `"%_prog%"  "%dp0%\node_modules\npm\bin\npx-cli.js" %*` */
export function shimScript(shim: string, rt: Runtime): string | null {
  let text = "";
  try {
    text = rt.read(shim);
  } catch {
    return null;
  }
  const m = text.match(/"%~?dp0%?\\?([^"%]+\.[cm]?js)"/i);
  if (!m) return null;
  const p = pathOf(rt);
  const script = p.join(p.dirname(shim), m[1]);
  return rt.exists(script) ? script : null;
}

/**
 * The target: a web address (http/https, or a bare `host.tld/…`) or a path on
 * this computer that exists. Never one that starts with "-" (a program would
 * read it as an option) or holds control characters.
 */
export function checkTarget(raw: string, rt: Runtime): Target | Refused {
  const target = raw.trim();
  if (!target) return refuse("There's no target: give it a web address (https://…) or a path on this computer.");
  if (/[\u0000-\u001f\u007f]/.test(target)) return refuse("The target has control characters (a line break or similar) in it.");
  if (target.startsWith("-")) return refuse(`The target "${target}" starts with "-", so a program would read it as an option. Give a web address (https://…) or a path on this computer.`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return refuse(`"${target}" isn't a valid web address.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return refuse(`Only http and https addresses can be reverse-engineered, not ${url.protocol}//.`);
    return { ok: true, kind: "url", target }; // as typed: it parsed
  }
  const p = pathOf(rt);
  const local = p.resolve(rt.cwd, target);
  if (rt.exists(local)) return { ok: true, kind: rt.isDir(local) || /\.asar$/i.test(local) ? "app" : "file", target: local };
  // a bare host like github.com/morluto/rea
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(target)) {
    try {
      new URL(`https://${target}`);
      return { ok: true, kind: "url", target };
    } catch { /* not one: said below */ }
  }
  return refuse(`"${target}" is neither a web address (https://…) nor a path that exists on this computer (looked for ${local}).`);
}

/** npx, started without a shell */
export function npxCommand(rt: Runtime): Command | Refused {
  if (rt.platform !== "win32") return { ok: true, cmd: "npx", pre: [] };
  const p = path.win32;
  const tried: string[] = [p.join(p.dirname(rt.execPath), "node_modules", "npm", "bin", "npx-cli.js")];
  const npmExec = envGet(rt, "npm_execpath");
  if (npmExec && /^np[mx]-cli\.js$/i.test(p.basename(npmExec))) tried.push(p.join(p.dirname(npmExec), "npx-cli.js"));
  const hit = tried.find((f) => rt.exists(f));
  if (hit) return { ok: true, cmd: rt.execPath, pre: [hit] };
  for (const dir of pathDirs(rt)) {
    const shim = p.join(dir, "npx.cmd");
    if (!rt.exists(shim)) continue;
    const script = shimScript(shim, rt);
    if (script) return { ok: true, cmd: rt.execPath, pre: [script] };
    tried.push(`${shim} (no npx-cli.js it runs)`);
  }
  return refuse(`npm's npx (npx-cli.js) isn't on this computer, so rea-agents can't start. Looked next to Node (${rt.execPath})${npmExec ? `, by npm_execpath` : ""} and for npx.cmd on PATH:\n${tried.map((t) => `  ${t}`).join("\n")}\nInstall Node.js with npm, then press Run again.`);
}

/** Claude Code (`FOUNDATION_CLAUDE_CLI`, `claude` by default), started without a shell */
export function claudeCommand(cli: string, rt: Runtime): Command | Refused {
  if (rt.platform !== "win32") return { ok: true, cmd: cli, pre: [] };
  const p = path.win32;
  if (/\.[cm]?js$/i.test(cli)) return { ok: true, cmd: rt.execPath, pre: [cli] };
  const exts = [".exe", ".com", ".cmd", ".bat"];
  const named = p.extname(cli) ? [cli] : exts.map((e) => cli + e);
  const candidates = /[\\/]/.test(cli) ? named : pathDirs(rt).flatMap((d) => named.map((n) => p.join(d, n)));
  const found = candidates.find((f) => rt.exists(f));
  if (!found)
    return refuse(
      /[\\/]/.test(cli)
        ? `Claude Code isn't at ${cli} (FOUNDATION_CLAUDE_CLI). Point it at claude.exe, then start Foundation's server again.`
        : `Claude Code (${cli}) isn't on this computer's PATH. Install it (claude.exe), or set FOUNDATION_CLAUDE_CLI to where it is, then start Foundation's server again.`,
    );
  if (/\.(cmd|bat)$/i.test(found)) {
    const script = shimScript(found, rt);
    if (script) return { ok: true, cmd: rt.execPath, pre: [script] };
    return refuse(`Claude Code at ${found} is a ${p.extname(found)} script, which only runs through cmd.exe, and the job's arguments hold the target, so Foundation won't. Set FOUNDATION_CLAUDE_CLI to claude.exe (or the cli.js it wraps).`);
  }
  if (!/\.(exe|com)$/i.test(found)) return refuse(`Claude Code at ${found} isn't a program Windows can start directly. Set FOUNDATION_CLAUDE_CLI to claude.exe.`);
  return { ok: true, cmd: found, pre: [] };
}

/** On Windows npx runs a package's bin through cmd.exe (npm escapes it, but these are cmd's own characters) */
const CMD_SPECIAL = /[%!^&|<>"]/;

export const REA_DEFAULT_GOAL = "Map how it works: structure, data flow, APIs, and anything we can reuse.";

/** the whole command for a REA job, or why it won't start */
export function reaCommand(job: { target: string; goal: string }, claudeCli: string, rt: Runtime): ReaPlan {
  const t = checkTarget(job.target, rt);
  if (!t.ok) return t;
  if (job.goal.includes("\u0000")) return refuse("The goal has a NUL character in it.");
  const goal = job.goal || REA_DEFAULT_GOAL;
  if (t.kind === "app") {
    if (rt.platform === "win32" && CMD_SPECIAL.test(t.target))
      return refuse(`On Windows npx runs rea-agents through cmd.exe, so a path with any of % ! ^ & | < > in it isn't passed to it: ${t.target}. Copy or move the app to a plain path, then press Run again.`);
    const npx = npxCommand(rt);
    if (!npx.ok) return npx;
    return { ok: true, route: "rea-agents", target: t.target, cmd: npx.cmd, argv: [...npx.pre, "-y", "rea-agents@latest", "analyze-javascript-application", t.target, "--json"] };
  }
  const claude = claudeCommand(claudeCli, rt);
  if (!claude.ok) return claude;
  return {
    ok: true,
    route: "claude",
    target: t.target,
    cmd: claude.cmd,
    argv: [
      ...claude.pre,
      "-p",
      `Reverse-engineer ${t.target} for Form Industries (we own it or are authorized to examine it). Goal: ${goal}\nUse the REA MCP tools (rea) if available. Report findings with evidence as concise markdown: architecture, key modules, data flow, APIs/IPC, and what we could reuse.`,
      "--output-format",
      "text",
    ],
  };
}

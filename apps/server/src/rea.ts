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
 *
 * A local target (a file or folder on this computer) must be inside a folder a
 * person approved (places.ts), checked on its real path (no `..`, no link out),
 * and is never the home folder or above it, nor a hidden file or folder, a key
 * or a credential store (secretnames.ts). Web addresses are unchanged.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isSecretName } from "./secretnames.ts";

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
  /** the real location of a path (links and junctions followed), or null when there is none */
  real: (f: string) => string | null;
  /** the person's home folder */
  home: string;
  /** folders a person approved (places.ts): a local target must be inside one */
  places: string[];
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
  real: (f) => {
    try {
      return realpathSync.native(f);
    } catch {
      return null;
    }
  },
  home: homedir(),
  // the job fills these in from the approved places (jobs.ts); none here means no local target passes
  places: [],
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

/** is `inner` the same as `outer`, or inside it (case-blind on Windows) */
function within(outer: string, inner: string, rt: Pick<Runtime, "platform">) {
  const p = pathOf(rt);
  const n = (s: string) => (rt.platform === "win32" ? s.toLowerCase() : s);
  const rel = p.relative(n(outer), n(inner));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/**
 * Why a job may not run on this local path (already its real location), or null. Never the home
 * folder or anything that holds it (it holds sign-ins and keys); never a hidden file or folder, key or
 * credential store anywhere on the path (.ssh, .aws, .env, .claude, .config, .gnupg, .npmrc and the
 * like); and only inside a folder a person approved.
 */
export function localTargetRefusal(at: string, rt: Pick<Runtime, "platform" | "real" | "home" | "places">): string | null {
  const home = rt.real(rt.home) ?? rt.home;
  if (within(at, home, rt)) return `${at} is your home folder or holds it, with its sign-ins and keys, so no job runs on it.`;
  const parts = at.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => isSecretName(part) && !/^[a-z]:$/i.test(part)))
    return `${at} is, or is inside, a hidden file or folder, a key or a credential store (like .ssh, .aws, .env, .claude or .config), so no job runs on it.`;
  const roots = rt.places.map((r) => rt.real(r) ?? r);
  if (!roots.some((r) => within(r, at, rt)))
    return `${at} isn't inside a folder a person approved for Foundation (Settings → Places), so no job runs on it. An admin can approve the folder it's in, then press Run again.`;
  return null;
}

/**
 * The target: a web address (http/https, or a bare `host.tld/…`) or a path on
 * this computer that exists, inside an approved place (localTargetRefusal).
 * Never one that starts with "-" (a program would read it as an option) or
 * holds control characters.
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
  if (rt.exists(local)) {
    if (target.split(/[\\/]+/).includes("..")) return refuse(`The target "${target}" climbs out of a folder (".."). Give the full path of what to examine.`);
    // checked where it really is: a link or junction is followed before the rules apply
    const at = rt.real(local);
    if (!at) return refuse(`${local} can't be resolved to where it really is on this computer.`);
    const no = localTargetRefusal(at, rt);
    if (no) return refuse(no);
    return { ok: true, kind: rt.isDir(at) || /\.asar$/i.test(at) ? "app" : "file", target: at };
  }
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

/**
 * What Claude Code gets beyond childenv.ts's BASE (its home folders are in BASE: it finds its login
 * under ~/.claude, or the macOS keychain by the user, and ~/.claude.json holds MCP servers set up with
 * `npx rea-agents@6.9.0 setup`). Never ANTHROPIC_API_KEY: with it set, `claude -p` bills the API key instead
 * of the person's plan.
 */
export const CLAUDE_CODE_ENV = [
  // its config and login, when a person moved them out of ~/.claude
  "CLAUDE_CONFIG_DIR",
  // Windows: Claude Code runs its shell through Git Bash, found by this when it isn't on PATH
  "CLAUDE_CODE_GIT_BASH_PATH",
] as const;

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

/**
 * The one rea-agents Foundation runs (ADR-001 G13: an exact version, never the newest one fetched at run time). npm's
 * registry, 2026-11-18: rea-agents 6.9.0, MIT, github.com/morluto/rea. Before a job starts, the
 * registry's integrity for this exact version is compared with the one here (checkReaIntegrity), and
 * npx itself checks the tarball it fetches against the registry's. A new version is a change here,
 * read and pinned by a person.
 */
export const REA_AGENTS = {
  name: "rea-agents",
  version: "6.9.0",
  integrity: "sha512-KqDn1UR5BMqHoQ3MGAnPuWiSKwgdFaz1L/uUNgrKt+1W8kPtgYP8AWEOXIF1lDIOBVyPuYIIst2iamo1Wf3r8g==",
} as const;
export const REA_SPEC = `${REA_AGENTS.name}@${REA_AGENTS.version}`;

/**
 * The one registry rea-agents is checked against and fetched from. npx is told it explicitly, so a person's
 * npm settings that name another registry can't swap in what wasn't checked (jobs.ts also gives npx no
 * npm settings file, so no npm sign-in goes with it).
 */
export const REA_REGISTRY = "https://registry.npmjs.org/";

/** the registry's integrity string for one exact version (what `npm view <name>@<version> dist.integrity` says) */
export type IntegrityLookup = (name: string, version: string) => Promise<string | undefined>;
export const registryIntegrity: IntegrityLookup = async (name, version) => {
  const res = await fetch(`${REA_REGISTRY}${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm's registry answered ${res.status}`);
  return ((await res.json()) as { dist?: { integrity?: string } }).dist?.integrity;
};

/** why the pinned rea-agents mustn't start (the registry says something else, or couldn't be asked), or null when it matches */
export async function checkReaIntegrity(lookup: IntegrityLookup = registryIntegrity): Promise<string | null> {
  let found: string | undefined;
  try {
    found = await lookup(REA_AGENTS.name, REA_AGENTS.version);
  } catch (e) {
    return `Couldn't check ${REA_SPEC} against npm's registry (${(e as Error).message}), so it didn't start.`;
  }
  if (found !== REA_AGENTS.integrity) return `npm's registry says ${REA_SPEC} is ${found ?? "missing"}, not the ${REA_AGENTS.integrity} Foundation pinned, so it didn't start.`;
  return null;
}

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
    return { ok: true, route: "rea-agents", target: t.target, cmd: npx.cmd, argv: [...npx.pre, `--registry=${REA_REGISTRY}`, "-y", REA_SPEC, "analyze-javascript-application", t.target, "--json"] };
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

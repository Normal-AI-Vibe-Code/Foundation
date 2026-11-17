/**
 * Where Vision Code (T3) lives on this computer: its CLI, its home (the
 * T3CODE_HOME holding `userdata/state.sqlite`) and its address. Worked out
 * per platform from Vision's own layout:
 *
 * - Home: Vision runs T3 with T3CODE_HOME = `<app data>/code` (code_host.rs
 *   `default_home`, overridable there with VISION_CODE_HOME), and Tauri's app
 *   data is `~/Library/Application Support/co.normallab.vision` on macOS,
 *   `%APPDATA%\co.normallab.vision` on Windows and
 *   `$XDG_DATA_HOME/co.normallab.vision` (`~/.local/share`) on Linux.
 * - CLI: the T3 server binary is also its CLI. Vision runs it from a checkout
 *   (`.tools/code-server/t3[.exe]`, or the bare `@t3code/t3-<os>-<arch>`
 *   package in `.tools/t3-server`) or from an installed app's
 *   `code-server/` resource. Then `t3` on PATH.
 *
 * - Address: T3_URL, else the origin T3 wrote to
 *   `<home>/userdata/server-runtime.json`, else http://127.0.0.1:3783.
 *
 * T3_CLI, T3CODE_HOME and T3_URL win over all of it, and are read when used,
 * never at import (a test or a launcher may set them after this loads).
 * Plain T3 Code's `~/.t3` is not a candidate: Vision keeps its own home, and
 * the hand-off talks to Vision's server.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface Where {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  home: string;
}

export const here = (): Where => ({ platform: process.platform, arch: process.arch, env: process.env, home: homedir() });

const pathOf = (w: Where) => (w.platform === "win32" ? path.win32 : path.posix);
const exeName = (w: Where) => (w.platform === "win32" ? "t3.exe" : "t3");
const APP_ID = "co.normallab.vision";

export const DEFAULT_T3_URL = "http://127.0.0.1:3783";

/** a usable http(s) origin, without a trailing slash, or null */
function origin(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The address T3 says it's serving on: `<home>/userdata/server-runtime.json`,
 * which T3 writes when its server starts and clears when it stops
 * (`{version: 1, pid, host?, port, origin, startedAt, …}`). Its own CLI goes
 * by `origin`; `host`/`port` stand in when that's unusable. Null when the
 * file is missing, unreadable or names nothing usable.
 */
export function runtimeOrigin(home: string, w: Where = here(), read: (f: string) => string = (f) => readFileSync(f, "utf8")): string | null {
  let state: { origin?: unknown; host?: unknown; port?: unknown };
  try {
    state = JSON.parse(read(pathOf(w).join(home, "userdata", "server-runtime.json")));
  } catch {
    return null;
  }
  if (!state || typeof state !== "object") return null;
  const o = origin(state.origin);
  if (o) return o;
  const port = state.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = typeof state.host === "string" && /^[A-Za-z0-9.-]+$/.test(state.host) && state.host !== "0.0.0.0" ? state.host : "127.0.0.1";
  return `http://${host}:${port}`;
}

export interface T3Address {
  url: string;
  /** where it came from, in a person's words */
  from: string;
}

/**
 * Vision Code's address, read when used: T3_URL, else what Vision Code's
 * server-runtime.json says (Vision takes the next free port when :3783 is
 * taken), else http://127.0.0.1:3783.
 */
export function t3Address(w: Where = here(), exists: (f: string) => boolean = existsSync, read?: (f: string) => string): T3Address {
  if (w.env.T3_URL) return { url: w.env.T3_URL.replace(/\/+$/, ""), from: "T3_URL" }; // taken as given
  const home = findT3Home(w, exists).found;
  const said = home ? runtimeOrigin(home, w, read) : null;
  if (said) return { url: said, from: `${pathOf(w).join(home!, "userdata", "server-runtime.json")}` };
  return { url: DEFAULT_T3_URL, from: "the default" };
}

export const t3Url = (w: Where = here()) => t3Address(w).url;

/** Vision's T3CODE_HOME, in the order looked at. T3CODE_HOME, when set, is the only one */
export function t3HomeCandidates(w: Where): string[] {
  if (w.env.T3CODE_HOME) return [w.env.T3CODE_HOME];
  const p = pathOf(w);
  const out: string[] = [];
  if (w.env.VISION_CODE_HOME) out.push(w.env.VISION_CODE_HOME); // Vision's own override
  if (w.platform === "darwin") out.push(p.join(w.home, "Library", "Application Support", APP_ID, "code"));
  else if (w.platform === "win32") out.push(p.join(w.env.APPDATA || p.join(w.home, "AppData", "Roaming"), APP_ID, "code"));
  else out.push(p.join(w.env.XDG_DATA_HOME || p.join(w.home, ".local", "share"), APP_ID, "code"));
  return out;
}

/** where a Vision checkout may be */
function visionCheckouts(w: Where): string[] {
  const p = pathOf(w);
  const roots = [p.join(w.home, "Development", "Vision"), p.join(w.home, "Dev", "Vision")];
  if (w.platform === "win32") roots.push(p.join(`${w.env.SystemDrive || "C:"}\\`, "Dev", "Vision"));
  return roots;
}

/** the T3 CLI, in the order looked at (`t3` on PATH comes after). T3_CLI, when set, is the only one */
export function t3CliCandidates(w: Where): string[] {
  if (w.env.T3_CLI) return [w.env.T3_CLI];
  const p = pathOf(w);
  const exe = exeName(w);
  const os = w.platform === "win32" ? "win32" : w.platform;
  const arch = w.arch === "x86_64" ? "x64" : w.arch === "aarch64" ? "arm64" : w.arch;
  const out: string[] = [];
  for (const root of visionCheckouts(w)) {
    out.push(p.join(root, ".tools", "code-server", exe));
    out.push(p.join(root, ".tools", "t3-server", "node_modules", "@t3code", `t3-${os}-${arch}`, exe));
  }
  // an installed Vision: its bundled code-server/ resource
  if (w.platform === "darwin") {
    out.push(p.join("/Applications", "Vision.app", "Contents", "Resources", "code-server", exe));
    out.push(p.join(w.home, "Applications", "Vision.app", "Contents", "Resources", "code-server", exe));
  } else if (w.platform === "win32") {
    out.push(p.join(w.env.LOCALAPPDATA || p.join(w.home, "AppData", "Local"), "Vision", "code-server", exe));
    out.push(p.join(w.env.ProgramFiles || "C:\\Program Files", "Vision", "code-server", exe));
  } else {
    out.push(p.join("/usr", "lib", "Vision", "code-server", exe));
  }
  return out;
}

/** `t3` on PATH: t3.exe or an npm shim (t3.cmd) on Windows */
function onPath(w: Where, exists: (f: string) => boolean): string | null {
  const p = pathOf(w);
  const dirs = (w.env.PATH ?? w.env.Path ?? "").split(w.platform === "win32" ? ";" : ":").filter(Boolean);
  const names = w.platform === "win32" ? ["t3.exe", "t3.cmd"] : ["t3"];
  for (const d of dirs) for (const n of names) if (exists(p.join(d, n))) return p.join(d, n);
  return null;
}

export const ON_PATH = "t3 on PATH";

export interface Found<T> {
  found: T | null;
  tried: string[];
}

export function findT3Home(w: Where = here(), exists: (f: string) => boolean = existsSync): Found<string> {
  const tried = t3HomeCandidates(w);
  if (w.env.T3CODE_HOME) return { found: w.env.T3CODE_HOME, tried }; // an override is taken as given
  const p = pathOf(w);
  return { found: tried.find((h) => exists(p.join(h, "userdata", "state.sqlite"))) ?? null, tried };
}

export function findT3Cli(w: Where = here(), exists: (f: string) => boolean = existsSync): Found<string> {
  const tried = t3CliCandidates(w);
  if (w.env.T3_CLI) return { found: w.env.T3_CLI, tried };
  const hit = tried.find((c) => exists(c)) ?? onPath(w, exists);
  return { found: hit, tried: [...tried, ON_PATH] };
}

/**
 * How to start the CLI without a shell. A script runs under this Node (Windows
 * can't start a #! file); an npm shim (`.cmd`) runs the script it wraps,
 * since a .cmd needs cmd.exe and its arguments would then go through cmd's
 * parsing. Anything else is started directly.
 */
export function t3Command(cli: string, w: Where = here(), read: (f: string) => string = (f) => readFileSync(f, "utf8")): { cmd: string; pre: string[] } {
  if (/\.[cm]?js$/i.test(cli)) return { cmd: process.execPath, pre: [cli] };
  if (w.platform === "win32" && /\.(cmd|bat)$/i.test(cli)) {
    let text = "";
    try {
      text = read(cli);
    } catch { /* unreadable: said below */ }
    // npm's shim: "%_prog%"  "%dp0%\node_modules\t3\dist\bin.mjs" %*
    const m = text.match(/"%~?dp0%?\\?([^"%]+\.[cm]?js)"/i);
    if (m) return { cmd: process.execPath, pre: [path.win32.join(path.win32.dirname(cli), m[1])] };
    throw new Error(`Vision Code's CLI at ${cli} is a .cmd Foundation won't run through a shell. Set T3_CLI to t3.exe or to the script it wraps.`);
  }
  return { cmd: cli, pre: [] };
}

/** the address in use and where it came from, for messages */
export function addressSaid(w: Where = here()) {
  const a = t3Address(w);
  return a.from === "the default" ? `${a.url}, the default` : `${a.url}, from ${a.from}`;
}

const list = (xs: string[]) => xs.map((x) => `  ${x}`).join("\n");

/** what a person sees when Vision Code isn't found: where we looked, and what to set */
export function notFoundMessage(cli: Found<string> | null, home: Found<string> | null): string {
  const parts: string[] = [];
  if (cli && !cli.found) parts.push(`Vision Code's CLI isn't on this computer. Looked for:\n${list(cli.tried)}`);
  if (home && !home.found) parts.push(`Vision Code's threads aren't on this computer (no userdata/state.sqlite). Looked in:\n${list(home.tried)}`);
  const set = [
    cli && !cli.found ? "T3_CLI to its t3 program (t3.exe on Windows)" : null,
    home && !home.found ? "T3CODE_HOME to its data folder (the one holding userdata/state.sqlite)" : null,
    `T3_URL to its address (now ${addressSaid()})`,
  ].filter(Boolean) as string[];
  const said = set.length > 1 ? `${set.slice(0, -1).join(", ")} and ${set.at(-1)}` : set[0];
  return `${parts.join("\n")}\nIf Vision Code is somewhere else, set ${said} for Foundation's server, then start it again.`;
}

/**
 * The built-in terminal (the top bar's tools, 2026-11-17): a shell on the computer Foundation's server runs
 * on, in the server's own folder, for an admin.
 *
 * It runs whatever is typed, so it is the strictest thing Foundation has:
 *  - only a person opens one (`requirePerson`: their browser's cookie or their app's sign-in, never an agent's
 *    bearer, MCP or the service token), and only an admin (index.ts);
 *  - opening is two steps: `POST /api/host-terminal` mints a one-time key (30 s, in memory, never stored), and the
 *    socket `/host/terminal/<id>?key=…` spends it. A key is good for one socket, once;
 *  - nothing starts until that press: no shell runs at boot or when the tool is merely shown.
 *
 * There is no pseudo-terminal (no native module to build on every platform): the shell reads lines on stdin and
 * the browser edits the line (shell/Tools.tsx). After each line the shell prints a mark with its folder, which
 * comes back as the prompt, so the browser knows when a command has finished and where it is. Programs that want
 * a real terminal (an editor, a pager, a sign-in that hides what's typed) don't belong here; use this computer's
 * own terminal for those.
 */

import { childOptions, spawnChild, type ChildProcess, type SpawnOptions } from "./child.ts";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { UserInfo } from "@foundation/protocol";
import { requirePerson } from "./auth.ts";
import { HttpError, type Req } from "./http.ts";

const KEY_TTL_MS = 30_000;
/** the mark the shell prints after each line: \x01FP<folder>\x02 */
const MARK = /\x01FP([^\x02]*)\x02\r?\n?/g;
const MAX_LINE = 8_000;

interface Opened {
  user: UserInfo;
  key: string;
  expires: number;
}
const opened = new Map<string, Opened>();
const live = new Map<string, { proc: ChildProcess; user: string }>();

export const HOST_TERM_PATH = /^\/host\/terminal\/([A-Za-z0-9_-]{8,64})$/;

/** `POST /api/host-terminal`: a person, an admin, asks for a terminal (an agent, a viewer or a member is refused) */
export function requestHostTerminal(req: Req) {
  const u = requirePerson(req, "Opening a terminal");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin can open a terminal on the server's computer.");
  return openHostTerminal(u);
}

/** a person asked for a terminal: a one-time key for its socket */
export function openHostTerminal(user: UserInfo): { id: string; key: string; expiresIn: number; shell: string; cwd: string } {
  const now = Date.now();
  for (const [id, o] of opened) if (o.expires <= now) opened.delete(id);
  const id = randomBytes(9).toString("base64url");
  const key = randomBytes(24).toString("base64url");
  opened.set(id, { user, key, expires: now + KEY_TTL_MS });
  return { id, key, expiresIn: KEY_TTL_MS / 1000, shell: shellName(), cwd: process.cwd() };
}

/** spend a key on its socket: the person it was minted for, or null (wrong, used, or expired) */
export function spendHostTerminalKey(id: string, key: string | null): UserInfo | null {
  const o = opened.get(id);
  opened.delete(id);
  if (!o || !key || o.key !== key || o.expires <= Date.now()) return null;
  return o.user;
}

const shellName = () => (process.platform === "win32" ? "PowerShell" : process.env.SHELL?.split("/").pop() || "sh");

/**
 * The shell is a person's own, but not the server's keys: it gets the allowlist (child.ts), no extras, and
 * TERM=dumb (no colours or cursor codes; there's no pseudo-terminal), so `env` or `Get-ChildItem env:` in it
 * prints none of `.env`. An admin who needs a key reads `.env` themselves.
 */
function startShell(cwd: string): ChildProcess {
  if (process.platform === "win32") {
    const p = spawnChild("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], childOptions<SpawnOptions>({ extras: [], set: { TERM: "dumb" } }, { cwd, windowsHide: true }));
    p.stdin?.write("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\n");
    return p;
  }
  const sh = process.env.SHELL && /(^|\/)(bash|zsh|sh)$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  return spawnChild(sh, ["-s"], childOptions<SpawnOptions>({ extras: [], set: { TERM: "dumb", PS1: "" } }, { cwd }));
}

/** the line that prints the mark after each command */
const markLine = () => (process.platform === "win32" ? 'Write-Output ("$([char]1)FP" + (Get-Location).Path + "$([char]2)")\n' : "printf '\\001FP%s\\002\\n' \"$PWD\"\n");

/** text for a terminal: every line ending as \r\n */
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/**
 * A socket that spent its key: the shell starts now, and stops when the socket closes.
 * Client → server: {t:"line", text} · {t:"restart"}. Server → client: {t:"out", data} · {t:"prompt", cwd} · {t:"exit", code}.
 */
export function attachHostTerminal(id: string, ws: WebSocket, user: UserInfo) {
  let proc: ChildProcess | null = null;
  let buf = "";
  const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const flush = (chunk: string) => {
    buf += chunk;
    // hold back a partial mark until the rest of it arrives
    const cut = buf.lastIndexOf("\x01");
    const keep = cut >= 0 && buf.indexOf("\x02", cut) < 0 ? buf.slice(cut) : "";
    const text = keep ? buf.slice(0, cut) : buf;
    buf = keep;
    let last = 0;
    for (const m of text.matchAll(MARK)) {
      if (m.index! > last) send({ t: "out", data: crlf(text.slice(last, m.index)) });
      send({ t: "prompt", cwd: m[1] });
      last = m.index! + m[0].length;
    }
    if (last < text.length) send({ t: "out", data: crlf(text.slice(last)) });
  };
  const start = () => {
    proc = startShell(process.cwd());
    const p = proc;
    live.set(id, { proc: p, user: user.id });
    p.stdout?.setEncoding("utf8");
    p.stderr?.setEncoding("utf8");
    p.stdout?.on("data", (d: string) => flush(d));
    p.stderr?.on("data", (d: string) => send({ t: "out", data: crlf(d), err: true }));
    p.on("exit", (code) => {
      if (proc !== p) return;
      live.delete(id);
      send({ t: "exit", code });
    });
    p.on("error", (e) => send({ t: "out", data: `\r\nThe shell didn't start: ${e.message}\r\n`, err: true }));
    p.stdin?.write(markLine());
  };
  const stop = () => {
    const p = proc;
    proc = null;
    live.delete(id);
    if (p && p.exitCode === null) p.kill();
  };
  start();
  console.log(`  terminal           ${user.name} opened a ${shellName()} in ${process.cwd()}`);
  ws.on("message", (raw) => {
    let m: { t?: string; text?: string };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.t === "line" && typeof m.text === "string" && proc?.stdin?.writable) {
      const line = m.text.slice(0, MAX_LINE).replace(/[\r\n]+/g, " ");
      proc.stdin.write(`${line}\n`);
      proc.stdin.write(markLine());
    } else if (m.t === "restart") {
      stop();
      buf = "";
      start();
    }
  });
  ws.on("close", stop);
  ws.on("error", stop);
}

/** shells open now (for the tests, and a server stopping) */
export function hostTerminals(): number {
  return live.size;
}
export function stopHostTerminals() {
  for (const { proc } of live.values()) if (proc.exitCode === null) proc.kill();
  live.clear();
}
// a shell outlives nothing: when the server goes, its shells go with it
process.on("exit", stopHostTerminals);

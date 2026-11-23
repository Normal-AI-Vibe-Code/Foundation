/**
 * The server switch's rules (SPEC §3 "The server switch"), pure so they're tested on their own
 * (test/serverSwitch.test.ts). Two ways for the app to have a server:
 *  - **this computer**: Foundation's own server on http://localhost:4410, started by the desktop app
 *    (`start_local_server`, local_server.rs): the one built into the app, or a checkout's;
 *  - **a remote server**: any Foundation reachable over http(s), by address.
 */

export const LOCAL_PORT = 4410;
export const LOCAL_SERVER = `http://localhost:${LOCAL_PORT}`;
/** where Josh's checkout lives; the switch remembers another once it's changed */
export const FOLDER_DEFAULT = "C:\\Dev\\Foundation";
/** the address the remote option starts with (Josh, 2026-11-13: "connect to the flowform server") */
export const REMOTE_DEFAULT = "https://server.formresearch.ai";

/** whether an address is this computer: loopback by name or number, any port */
export function isLocalServer(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** an address as people say it: no scheme, no trailing slash */
export function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** what a person typed, as a server origin; a bare host gets https (http for this computer) */
export function serverOrigin(input: string): { ok: true; origin: string } | { ok: false; reason: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "Type the server's address." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${/^(localhost|127\.|\[::1\])/i.test(raw) ? "http" : "https"}://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, reason: "That isn't an address." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "A server's address starts with https:// or http://." };
  if (!u.hostname) return { ok: false, reason: "That isn't an address." };
  return { ok: true, origin: u.origin };
}

/** which server "This computer" starts: the one built into the app, or a checkout's */
export type LocalKind = "builtIn" | "checkout";

/**
 * Which kind the switch offers first: what the person picked last; else a checkout if they've
 * started one here before (Josh's machine); else the built-in one, when this build has it.
 */
export function initialKind(saved: string | null, folderSaved: boolean, builtIn: boolean): LocalKind {
  if (!builtIn) return "checkout";
  if (saved === "builtIn" || saved === "checkout") return saved;
  return folderSaved ? "checkout" : "builtIn";
}

/**
 * Whether the desktop app starts this computer's server as it opens: only one a person started
 * here and didn't stop (quitting the app stops it; Stop means "not again"), and only when the app
 * uses this computer's server and nothing answers there already.
 */
export function startsAtLaunch(lastStarted: string | null, currentIsLocal: boolean, listening: boolean): LocalKind | null {
  if (!currentIsLocal || listening) return null;
  return lastStarted === "builtIn" || lastStarted === "checkout" ? lastStarted : null;
}

/** how the server this app uses answered its last check */
export type Reach = "checking" | "up" | "down";

/** the server on this computer, as the desktop app sees it */
export type LocalPhase = "unknown" | "stopped" | "starting" | "running" | "failed";

/** a Windows or POSIX absolute path; the desktop app refuses anything else */
export function isAbsoluteFolder(p: string): boolean {
  return /^[a-z]:[\\/]/i.test(p.trim()) || p.trim().startsWith("/") || p.trim().startsWith("\\\\");
}

/** the dot and word the collapsed switch shows */
export function pillState(reach: Reach, local: LocalPhase, currentIsLocal: boolean): { tone: "ok" | "warn" | "bad"; word: string } {
  if (currentIsLocal && local === "starting") return { tone: "warn", word: "Starting…" };
  if (reach === "checking") return { tone: "warn", word: "Checking…" };
  if (reach === "up") return { tone: "ok", word: "Connected" };
  return { tone: "bad", word: currentIsLocal ? "Not running" : "Can't reach" };
}

/**
 * The way out of a start that failed, when the app knows one. EACCES on Windows is the port inside a
 * block Windows reserved at boot for Hyper-V and WSL (`netsh int ipv4 show excludedportrange tcp`):
 * nothing holds it, and nothing may take it until the block moves or the port is set aside for good.
 */
export function startHelp(message: string, windows: boolean, port = LOCAL_PORT): { help: string; command: string | null } | null {
  if (/\b(WSA)?EACCES\b/.test(message) && windows)
    return {
      help: `Windows reserved a block of ports that includes ${port} when it started (Hyper-V and WSL do this). Restarting the computer usually moves the block. To keep ${port} free for good, run this once in an administrator terminal:`,
      command: `net stop winnat; netsh int ipv4 add excludedportrange protocol=tcp startport=${port} numberofports=1 store=persistent; net start winnat`,
    };
  if (/\bEADDRINUSE\b/.test(message)) return { help: `Another program is listening on port ${port}. Close it, then try again.`, command: null };
  return null;
}

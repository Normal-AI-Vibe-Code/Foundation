/**
 * The oldest client this server still works with (2026-11-12; Flowform does the same: its server
 * answers 426 "Flowform 1.9.0 or newer is required" and its client says "no longer supported").
 *
 * The desktop app updates itself, but only when a person presses Update, and Later and Skip are
 * theirs to press. That is right for an ordinary release and wrong for one the server can't work
 * without (a board schema it would misread, a protocol change). `FOUNDATION_MIN_CLIENT=0.4.0` is how
 * whoever runs the server says so. Then:
 *  - `/auth/config` (public) carries it, so a client learns before it signs in and the update card
 *    stops offering Later;
 *  - a client older than it gets no board socket: the ticket (`POST /api/ws-ticket`, 426) or the
 *    socket itself (closed 4426) is refused, so an old build can't write a board it would misread.
 *    Reading over HTTP still works: the person can see their boards and the card that says to update.
 *
 * A client says its version in the ticket's body or the socket's query (`client=`): a request body
 * and a query need no CORS allowance, so a new client still works against a server from before this.
 * The desktop builds from before clients said (0.3.0 and earlier) are known by their page's origin.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { belowMinimum, isVersion } from "@foundation/protocol";
import { childOptions, execFileSyncChild, type ExecFileSyncOptions } from "./child.ts";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

/** this server's own version (apps/server/package.json; `npm run release -- bump` keeps it with the app's) */
export const SERVER_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Where in the release history this server's code is from, as `git describe` says it (`v0.3.58-4-g24521f71`),
 * read once at start: a server started from a checkout keeps running what it was started with while the app
 * updates itself (plan *server-older-than-app*), so the app compares this with its own and offers the restart.
 * `FOUNDATION_BUILD` names it where there is no git (a packaged server); null when neither says.
 */
export const SERVER_BUILD: string | null = (() => {
  const said = process.env.FOUNDATION_BUILD?.trim();
  if (said) return said.slice(0, 80);
  try {
    const out = execFileSyncChild("git", ["describe", "--tags", "--match", "v*", "--long", "--always"], childOptions<ExecFileSyncOptions>({ extras: [] }, { cwd: join(import.meta.dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }));
    return String(out).trim() || null;
  } catch {
    return null;
  }
})();

/** the last desktop release that didn't say its version */
const SILENT_DESKTOP = "0.3.0";
const DESKTOP_ORIGINS = new Set(["http://localhost:31440", "tauri://localhost"]);

/** the minimum, or "" when none is set (or what's set isn't a version: it's ignored, and the server says so once at start) */
export const minClient = (): string => (isVersion(config.minClient) ? config.minClient.replace(/^v/, "") : "");

/** the version a request is from: what it says, else 0.3.0 for the desktop app's page, else unknown */
export function clientVersionOf(said: unknown, origin: string | undefined): string | null {
  if (isVersion(said)) return said;
  return origin && DESKTOP_ORIGINS.has(origin) ? SILENT_DESKTOP : null;
}

/** whether this client is too old for this server */
export function clientTooOld(said: unknown, origin: string | undefined): boolean {
  return belowMinimum(clientVersionOf(said, origin), minClient());
}

/** refuse (426) a client older than the minimum, in words its person can act on */
export function requireCurrentClient(said: unknown, origin: string | undefined) {
  if (!clientTooOld(said, origin)) return;
  throw new HttpError(426, `Foundation ${clientVersionOf(said, origin)} is no longer supported by this server. Update to ${minClient()} or newer to keep working.`);
}

/** the socket close code for a client that's too old (4001 is a role change, 4002 a reset board) */
export const CLOSE_TOO_OLD = 4426;

if (config.minClient && !isVersion(config.minClient)) console.warn(`FOUNDATION_MIN_CLIENT="${config.minClient}" isn't a version (x.y.z): no minimum is enforced`);

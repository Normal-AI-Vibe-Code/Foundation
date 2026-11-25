/**
 * Which pages may use the session cookie, and which names this server answers to.
 *
 * - **Origins.** Pages that may call this server with credentials (CORS) are exactly: the client
 *   (FOUNDATION_CLIENT_URL), FOUNDATION_CORS_ORIGINS, and the desktop app's window (its fixed
 *   http://localhost:31440, and tauri://localhost) only when the desktop app started this server
 *   (startedForDesktop) or this server is hosted at another address (hosted: the cookie can't ride there). Otherwise nothing tells that port's page from any other program's, so a
 *   server started another way trusts it only if FOUNDATION_CORS_ORIGINS lists it. Not "any localhost port": a page another program
 *   serves on this computer (a dev server an agent started, T3's own UI, a machine's published port) is
 *   the same site as the server, so the SameSite cookie rides along with its requests.
 * - **Cookie writes.** A request that changes something (anything but GET, HEAD, OPTIONS) or opens a
 *   socket, and is signed in by the cookie (no Authorization header, no socket ticket), must say it
 *   comes from one of those pages: its Origin is on the list, or, with no Origin, the browser says
 *   Sec-Fetch-Site same-origin or none. Anything else is refused (cross-site request forgery, and
 *   cross-site WebSocket hijacking). A bearer is never sent by a browser on its own, so a bearer
 *   request (agents, MCP, the desktop app on another server) needs no Origin.
 * - **Host.** Every request must name this server: a loopback name (localhost, 127.0.0.1, [::1]) with
 *   the server's or the client's port, the host of FOUNDATION_PUBLIC_URL or FOUNDATION_CLIENT_URL, or
 *   one in FOUNDATION_HOSTS. That is the fence against DNS rebinding (a page on evil.example whose
 *   name now points at 127.0.0.1), which a loopback-peer test like dev sign-in's can't see.
 * - **On your network** (network.ts): while an admin has it on, also this computer's LAN addresses and name,
 *   with the port, and (asked by those names only) their own page origins and the desktop app's window.
 */

import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";
import { hasSessionCookie } from "./auth.ts";

/** the packaged desktop app's window (apps/client/src-tauri/src/lib.rs: fixed, it keys the device's offline copies) */
export const DESKTOP_PAGE_ORIGINS = ["http://localhost:31440", "tauri://localhost"];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const strip = (s: string) => s.trim().replace(/\/$/, "");
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * This server was started by the desktop app: both ways it starts one (the server it carries, and a
 * checkout's; apps/client/src-tauri/src/local_server.rs, and scripts/desktop-server.mjs's check) set
 * FOUNDATION_EXIT_WITH_PARENT=1 so the server leaves with the app. `npm run dev` doesn't.
 */
export const startedForDesktop = (env: NodeJS.ProcessEnv = process.env) => env.FOUNDATION_EXIT_WITH_PARENT === "1";

/** the pages that may call a server with these settings with credentials, exactly */
export function originsFor(o: { clientUrl: string; corsOrigins: string[]; desktop: boolean }): Set<string> {
  return new Set([originOf(o.clientUrl) ?? strip(o.clientUrl), ...(o.desktop ? DESKTOP_PAGE_ORIGINS : []), ...o.corsOrigins.map(strip)].filter(Boolean));
}

/**
 * A hosted server (FOUNDATION_PUBLIC_URL names an address that isn't this computer) is another site to the
 * desktop app's window on each person's computer, so its SameSite cookie never rides that window's requests:
 * the app signs in for a bearer it keeps itself. Admitting the window there lets the app read answers and
 * hands no other program on that computer a sign-in.
 */
export function hosted(publicUrl: string): boolean {
  try {
    return !LOOPBACK.has(new URL(publicUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

let origins: Set<string> | null = null;
/** the pages that may call this server with credentials, exactly */
export function allowedOrigins(): Set<string> {
  origins ??= originsFor({ clientUrl: config.clientUrl, corsOrigins: config.corsOrigins, desktop: startedForDesktop() || hosted(config.publicUrl) });
  return origins;
}

export const originAllowed = (origin: string) => allowedOrigins().has(origin);

/**
 * The names this server answers to on the office network, while a person has it open there (network.ts):
 * its LAN addresses and this computer's name, each with the port, and the page origins those give. Empty
 * when it isn't (exactly today's rules). A request that names one of these hosts may come from that page
 * (cookie, same origin) or from the desktop app on a teammate's computer (its window is
 * http://localhost:31440 there, and it sends a bearer: a SameSite cookie never crosses to a LAN address).
 */
let networkNames: { hosts: Set<string>; origins: Set<string> } = { hosts: new Set(), origins: new Set() };
export function setNetworkNames(hosts: Iterable<string>, origins: Iterable<string>) {
  networkNames = { hosts: new Set([...hosts].map((h) => h.toLowerCase())), origins: new Set(origins) };
}
/** this request names the server by one of its network names (not loopback, not FOUNDATION_HOSTS) */
export const isNetworkHost = (req: IncomingMessage) => networkNames.hosts.has(String(req.headers.host ?? "").trim().toLowerCase());
/** may a page at `origin` use this server for this request: the fixed list, or (asked by a network name) the network's pages */
export const originAllowedFor = (origin: string, req: IncomingMessage) =>
  originAllowed(origin) || (isNetworkHost(req) && (networkNames.origins.has(origin) || DESKTOP_PAGE_ORIGINS.includes(origin)));

const defaultPort = (protocol: string) => (protocol === "https:" ? "443" : "80");

function hostOf(url: string): { host: string; port: string } | null {
  try {
    const u = new URL(url);
    return { host: u.host.toLowerCase(), port: u.port || defaultPort(u.protocol) };
  } catch {
    return null;
  }
}

let hosts: { exact: Set<string>; ports: Set<string> } | null = null;
function hostRules() {
  if (hosts) return hosts;
  const pub = hostOf(config.publicUrl);
  const client = hostOf(config.clientUrl);
  hosts = {
    exact: new Set([pub?.host, client?.host, ...config.hosts.map((h) => h.toLowerCase())].filter((h): h is string => Boolean(h))),
    ports: new Set([String(config.port), client?.port].filter((p): p is string => Boolean(p))),
  };
  return hosts;
}

/** why this request's Host isn't this server (DNS rebinding), or null when it names it */
export function hostRefusal(req: IncomingMessage): string | null {
  const raw = String(req.headers.host ?? "").trim().toLowerCase();
  const no = `This server doesn't answer to “${raw.slice(0, 80) || "no name"}”. Open Foundation at its own address, or add that name to FOUNDATION_HOSTS.`;
  if (!raw) return no;
  const rules = hostRules();
  if (rules.exact.has(raw) || networkNames.hosts.has(raw)) return null;
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return no;
  const port = m[2] ?? "80";
  if (LOOPBACK.has(m[1]) && rules.ports.has(port)) return null;
  return no;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Why a request signed in by the cookie is refused for where it comes from, or null. `upgrade`: a
 * socket (checked whatever its method). A request with an Authorization header or a socket ticket isn't
 * signed in by the cookie, and one with no session cookie has nothing to forge.
 */
export function cookieOriginRefusal(req: IncomingMessage, opts: { upgrade?: boolean; ticket?: boolean } = {}): string | null {
  if (!opts.upgrade && SAFE.has(String(req.method ?? "GET").toUpperCase())) return null;
  if (opts.ticket || req.headers.authorization || !hasSessionCookie(req)) return null;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (originAllowedFor(String(origin), req)) return null;
    return `A page at ${String(origin).slice(0, 80)} can't use your Foundation sign-in. Open Foundation itself (or add that page to FOUNDATION_CORS_ORIGINS).`;
  }
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site === "same-origin" || site === "none") return null;
  return "This request didn't say which page it came from, so your Foundation sign-in can't be used for it. Open Foundation itself.";
}

/**
 * Which pages may use the session cookie, and which names this server answers to.
 *
 * - **Origins.** Pages that may call this server with credentials (CORS) are exactly: the client
 *   (FOUNDATION_CLIENT_URL), the desktop app's window (its fixed http://localhost:31440, and
 *   tauri://localhost), and FOUNDATION_CORS_ORIGINS. Not "any localhost port": a page another program
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
 */

import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";
import { hasSessionCookie } from "./auth.ts";

/** the packaged desktop app's window (apps/client/src-tauri/src/lib.rs: fixed, it keys the device's offline copies) */
export const DESKTOP_PAGE_ORIGINS = ["http://localhost:31440", "tauri://localhost"];

const strip = (s: string) => s.trim().replace(/\/$/, "");
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

let origins: Set<string> | null = null;
/** the pages that may call this server with credentials, exactly */
export function allowedOrigins(): Set<string> {
  origins ??= new Set([originOf(config.clientUrl) ?? strip(config.clientUrl), ...DESKTOP_PAGE_ORIGINS, ...config.corsOrigins.map(strip)].filter(Boolean));
  return origins;
}

export const originAllowed = (origin: string) => allowedOrigins().has(origin);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
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
  if (rules.exact.has(raw)) return null;
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
    if (originAllowed(String(origin))) return null;
    return `A page at ${String(origin).slice(0, 80)} can't use your Foundation sign-in. Open Foundation itself (or add that page to FOUNDATION_CORS_ORIGINS).`;
  }
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site === "same-origin" || site === "none") return null;
  return "This request didn't say which page it came from, so your Foundation sign-in can't be used for it. Open Foundation itself.";
}

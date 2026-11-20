/**
 * The client's Content Security Policy: what its pages may load, and from where. One policy for the app
 * shell (index.html, machine.html) and for the machine desktop page (desktop.html), which differs only in
 * who may frame it (the app itself; nothing frames the shell).
 *
 * What the app actually uses:
 * - scripts: its own bundle, and WebAssembly (the CAD viewer's occt-import-js, the Rune renderer), which
 *   needs 'wasm-unsafe-eval' to compile. No 'unsafe-eval': no dependency here evaluates strings. In dev only,
 *   Vite's React refresh preamble is an inline script, so dev adds 'unsafe-inline' for scripts.
 * - styles: its own CSS, plus inline <style> elements that libraries add (xterm, maplibre) and style
 *   attributes in rendered markup: 'unsafe-inline' for styles only.
 * - the server: same origin in dev (Vite proxies it), or the one this build or this device points at, which
 *   a person may switch to any server (the server switch): https/wss anywhere, and http/ws on this computer.
 * - pictures: its own and the server's files, data: and blob: (the 3D viewers and image previews make them),
 *   map tiles, and a picture from elsewhere once a person presses Load image (any http/https).
 * - frames: only http(s), and every one is fenced by the frame rules (src/panels/frameSandbox.ts).
 * - nothing else: no plugins (object-src 'none'), no <base> elsewhere, forms post only to itself.
 */

export interface CspOptions {
  /** the dev server: adds Vite's inline React refresh preamble and its HMR socket */
  dev?: boolean;
  /** the page may be framed by the app itself (desktop.html, inside a machine card); the shell never is */
  framedBySelf?: boolean;
  /** server origins this build talks to (VITE_FOUNDATION_SERVER, the dev proxy's target) */
  servers?: string[];
}

/** the server switch can point a device at any https server, or at one on this computer */
const ANY_SERVER = ["https:", "wss:", "http://localhost:*", "ws://localhost:*", "http://127.0.0.1:*", "ws://127.0.0.1:*"];

function origins(servers: string[]): string[] {
  const out = new Set<string>();
  for (const s of servers) {
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      out.add(u.origin);
      out.add(u.origin.replace(/^http/, "ws"));
    } catch {
      /* not an address */
    }
  }
  return [...out];
}

export function cspDirectives(o: CspOptions = {}): Record<string, string[]> {
  const servers = origins(o.servers ?? []);
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'", ...(o.dev ? ["'unsafe-inline'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "http:", "https:"],
    "font-src": ["'self'", "data:"],
    "media-src": ["'self'", "data:", "blob:", ...[...servers, ...ANY_SERVER].filter((s) => s.startsWith("http"))],
    "connect-src": ["'self'", "data:", "blob:", ...servers, ...ANY_SERVER],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'self'", "http:", "https:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": [o.framedBySelf ? "'self'" : "'none'"],
  };
}

export function cspString(o: CspOptions = {}): string {
  return Object.entries(cspDirectives(o))
    .map(([k, v]) => `${k} ${[...new Set(v)].join(" ")}`)
    .join("; ");
}

/**
 * The header a page is served with. Report-only for now: the policy has been tried in a browser against the
 * dev client and the production build, but not inside the packaged desktop app, so it reports what it would
 * block (in the page's console) instead of blocking it.
 */
export const CSP_HEADER = "Content-Security-Policy-Report-Only";

/** the page a request is for: desktop.html is framed by the app; everything else is the shell */
export const framedBySelf = (url: string | undefined) => /^\/desktop\.html(?:[?#]|$)/.test(url ?? "");

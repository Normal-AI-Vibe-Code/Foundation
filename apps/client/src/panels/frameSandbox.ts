/**
 * What a frame that shows an address from a card, an app or a person's typing may be (#80; 2026-11-18).
 * One decision for every such frame: an app card, a web page space, the built-in browser and T3's frame.
 *
 * - **Never Foundation itself.** Not the client's origin, not the server's (nor the dev proxy's target), and not
 *   a loopback address on either one's port under another name (127.0.0.1 for localhost): framed, our own page
 *   would run with the person's session under a frame someone else chose. Refused, with a sentence in its place.
 *   Only http(s) addresses are framed at all (no data:, blob:, javascript:, about:, file:).
 * - **Always sandboxed.** Scripts, forms, popups, modals and downloads.
 * - **Its own origin only when it's trusted.** `allow-same-origin` (its sign-in and storage work, and the bridge
 *   can address it by origin) is granted only to the origin of a saved app (the apps registry) or, for T3's frame,
 *   the configured T3 address. Any other address, typed or on a card, runs as an opaque origin: with scripts
 *   and same-origin together on a loopback port it would be same-site with Foundation.
 * - **The bridge** (app ↔ grid postMessage) names the frame's own origin when it sends, never "*", so it sends
 *   only to a frame that has one; it accepts a message only from that frame's window and from its origin ("null"
 *   for an opaque one).
 */
export const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

export interface FrameContext {
  /** Foundation's own origins: the page's, the server's, the dev proxy's target */
  ours: string[];
  /** the ports Foundation answers on: a loopback address on one of them is Foundation, whatever it's called */
  ports: string[];
  /** origins of saved apps (the apps registry) */
  saved: string[];
  /** the configured T3 address's origin, for T3's own frame only */
  t3?: string | null;
}

export type FrameDecision =
  | { ok: true; url: string; origin: string; sandbox: string; trusted: boolean }
  | { ok: false; reason: string };

/** localhost and its subdomains, 127.0.0.0/8, ::1 (and its IPv4-mapped form), and the any-address */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(h) || h === "::1" || h === "0.0.0.0" || h === "::" || /^::ffff:(127\.|7f)/.test(h);
}

const portOf = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");

export const OWN_PAGE = "Foundation doesn't show its own pages inside a frame. Open it in a tab of its own.";

export function frameFor(url: string, ctx: FrameContext): FrameDecision {
  let u: URL;
  try {
    u = new URL(url, ctx.ours[0]);
  } catch {
    return { ok: false, reason: "This address can't be opened here." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "Only web pages (http or https) open here." };
  if (ctx.ours.includes(u.origin) || (isLoopbackHost(u.hostname) && ctx.ports.includes(portOf(u)))) return { ok: false, reason: OWN_PAGE };
  const trusted = ctx.saved.includes(u.origin) || Boolean(ctx.t3 && ctx.t3 === u.origin);
  return { ok: true, url: u.href, origin: u.origin, sandbox: trusted ? `${SANDBOX} allow-same-origin` : SANDBOX, trusted };
}

/** what the bridge sends to: the frame's own origin, or nothing (an opaque frame can't be named, and "*" is never used) */
export function bridgeTarget(d: FrameDecision): string | null {
  return d.ok && d.trusted ? d.origin : null;
}

/** a message is the frame's own: from its window, and from its origin ("null" when it runs opaque) */
export function bridgeAccepts(d: FrameDecision, e: { origin: string; source: unknown }, frameWindow: unknown): boolean {
  if (!d.ok || !frameWindow || e.source !== frameWindow) return false;
  return e.origin === (d.trusted ? d.origin : "null");
}

/** what a frame may ask the browser for: camera and microphone, and reading the clipboard, only for a trusted one */
export function frameAllow(d: FrameDecision, extra = ""): string {
  const base = d.ok && d.trusted ? "clipboard-read; clipboard-write; camera; microphone" : "clipboard-write";
  return extra ? `${base}; ${extra}` : base;
}

/** Foundation's own origins and ports, from where this page is and the server it talks to */
export function foundationOrigins(here: string, servers: string[]): Pick<FrameContext, "ours" | "ports"> {
  const ours = new Set<string>();
  const ports = new Set<string>();
  for (const s of [here, ...servers]) {
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.origin !== "null") ours.add(u.origin);
      if ((u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.hostname)) ports.add(portOf(u));
    } catch {
      /* not an address */
    }
  }
  return { ours: [...ours], ports: [...ports] };
}

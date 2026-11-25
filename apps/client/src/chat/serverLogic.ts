/**
 * ChatForm's own server, the pure part (chat/server.ts keeps the choice and talks to it): what a person typed as
 * an address, whether that server is another than Foundation's, and what of ChatForm it has.
 */

/**
 * What a person typed, as a server's origin: "chat.example.app" is https, a name on this computer is http,
 * a path or a trailing slash is dropped. null when it isn't an address a browser can call.
 */
export function chatServerOrigin(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${local ? "http" : "https"}://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** an address as a person would say it: no scheme */
export const chatServerName = (origin: string) => origin.replace(/^https?:\/\//, "");

/** is ChatForm on a server of its own: one is chosen, and it isn't the Foundation server this app already uses */
export function isRemoteChat(chosen: string, foundationOrigin: string): boolean {
  const o = chosen ? chatServerOrigin(chosen) : null;
  return !!o && o !== foundationOrigin;
}

/** a chat server this app knows by name */
export interface KnownChatServer {
  origin: string;
  /** what a person calls it; absent: its address */
  name?: string;
  note?: string;
}

/**
 * The team's chat server (apps/chatserver on Vercel, live since 2026-11-24). Josh, 2026-11-24: "make it one of the
 * remembered servers, and as the default for right now". It's the desktop app's default; a device that chose
 * another, or Foundation's own, keeps its choice.
 */
export const FORM_CHAT_SERVER: KnownChatServer = { origin: "https://foundation-chatserver.vercel.app", name: "Form Industries", note: "The team's chat server, on Vercel" };
export const KNOWN_CHAT_SERVERS: KnownChatServer[] = [FORM_CHAT_SERVER];

/**
 * The chat server a build is made for. A build that names one (VITE_CHATFORM_SERVER, even as "" for Foundation's
 * own) gets that; the desktop app (`vite build --mode desktop`) gets the team's; anything else (the dev server, the
 * e2e build, a hosted Foundation) stays on Foundation's own.
 */
export function builtChatServer(named: string | undefined, mode: string): string {
  if (named !== undefined) return chatServerOrigin(named) ?? "";
  return mode === "desktop" ? FORM_CHAT_SERVER.origin : "";
}

const MAX_USED = 5;

/** the addresses this device has used, newest first, with this one added (Foundation's own is never one) */
export function rememberChatServer(used: string[], origin: string): string[] {
  const o = chatServerOrigin(origin);
  if (!o) return used.slice(0, MAX_USED);
  return [o, ...used.filter((u) => u !== o)].slice(0, MAX_USED);
}

/** what a stored list reads as: addresses only, in order, rubbish dropped */
export function readUsedChatServers(raw: string | null): string[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      const o = typeof x === "string" ? chatServerOrigin(x) : null;
      if (o && !out.includes(o)) out.push(o);
    }
    return out.slice(0, MAX_USED);
  } catch {
    return [];
  }
}

/** the servers Settings offers: the known ones first, then those this device has used, each once */
export function rememberedChatServers(known: KnownChatServer[], used: string[], foundationOrigin: string): KnownChatServer[] {
  const out: KnownChatServer[] = [];
  for (const s of [...known, ...used.map((origin) => ({ origin }))]) {
    const o = chatServerOrigin(s.origin);
    if (!o || o === foundationOrigin || out.some((x) => x.origin === o)) continue;
    out.push({ ...s, origin: o });
  }
  return out;
}

/**
 * What ChatForm can do on a server of its own. Such a server says what it has (`/auth/config` → `features`); one
 * that doesn't say is taken to have what the chat store itself asks for. Files, huddles, agents, the inbox and
 * the Slack import are Foundation's own server's and are never on a separate chat server.
 */
export type ChatFeature = "files" | "pins" | "topics" | "members" | "notify" | "star" | "export" | "archive" | "threads-list" | "huddles" | "agents";

const FOUNDATION_ONLY: ChatFeature[] = ["files", "huddles", "agents"];

export function chatCan(remote: boolean, features: string[] | null, what: ChatFeature): boolean {
  if (!remote) return true;
  if (FOUNDATION_ONLY.includes(what)) return false;
  if (!features) return true;
  return features.includes(what);
}

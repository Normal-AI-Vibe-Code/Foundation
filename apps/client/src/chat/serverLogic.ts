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

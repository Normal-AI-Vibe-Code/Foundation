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
 * that doesn't say is taken to have what the chat store itself asks for. Huddles, agents, the inbox and the Slack
 * import are Foundation's own server's and are never on a separate chat server. Files (uploads, and the pictures
 * and downloads they are read back as) and the list of what was said to me are there only when the server says so:
 * a chat server that doesn't say has neither, and the client never falls back to Foundation's archive for them.
 */
export type ChatFeature = "files" | "pins" | "topics" | "members" | "notify" | "star" | "export" | "archive" | "threads-list" | "huddles" | "agents" | "previews" | "mentions";

const FOUNDATION_ONLY: ChatFeature[] = ["huddles", "agents"];
/** on a chat server: only when it lists them */
const ONLY_WHEN_SAID: ChatFeature[] = ["files", "mentions"];

export function chatCan(remote: boolean, features: string[] | null, what: ChatFeature): boolean {
  if (!remote) return true;
  if (FOUNDATION_ONLY.includes(what)) return false;
  if (ONLY_WHEN_SAID.includes(what)) return !!features?.includes(what);
  if (!features) return true;
  return features.includes(what);
}

// ---------------------------------------------------------------- files on whichever server ChatForm is on

/** a GIF keeps its frames only as the file it is: never asked for by width, never re-encoded */
export function isGif(f: { name?: string; mime?: string }): boolean {
  return (f.mime ?? "").toLowerCase() === "image/gif" || /\.gif$/i.test(f.name ?? "");
}

/** the width a chat picture is asked for: the drawn width's tier, or the file itself for a GIF or an SVG (and in the lightbox) */
export function chatPictureTier(f: { name?: string; mime?: string }, drawn: 256 | 512 | "orig"): 256 | 512 | "orig" {
  if (drawn === "orig" || isGif(f)) return "orig";
  if ((f.mime ?? "").toLowerCase() === "image/svg+xml" || /\.svg$/i.test(f.name ?? "")) return "orig";
  return drawn;
}

/** the box a picture holds before it loads, from the width and height the server kept; null when it kept none */
export function pictureBox(f: { w?: number; h?: number }, maxW = 360, maxH = 280): { width: number; height: number } | null {
  const w = Number(f.w), h = Number(f.h);
  if (!(w > 0) || !(h > 0)) return null;
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** "4 MB", "512 KB": a limit as a person says it */
export function sizeWords(n: number): string {
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * The most a server takes in one file, in bytes, when it says: `/auth/config` may carry it (`maxUpload`,
 * `maxUploadBytes`, `uploadLimit`, or `limits.upload`), and a refusal may (`limit`, `max`, or "4 MB" in its words).
 * null when nothing says.
 */
export function uploadLimitOf(said: unknown): number | null {
  if (!said || typeof said !== "object") return null;
  const o = said as Record<string, unknown>;
  const limits = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;
  for (const v of [o.maxUpload, o.maxUploadBytes, o.uploadLimit, o.max_upload, limits.upload, limits.file, o.limit, o.max]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  const words = typeof o.error === "string" ? o.error : "";
  const m = /(\d+(?:\.\d+)?)\s*(kb|mb|gb|kib|mib|gib)\b/i.exec(words);
  if (m) {
    const unit = m[2].toLowerCase()[0];
    return Math.round(Number(m[1]) * (unit === "k" ? 1024 : unit === "m" ? 1024 * 1024 : 1024 * 1024 * 1024));
  }
  return null;
}

/**
 * Why an upload didn't land, in words a person can act on. A file over the server's limit says the limit (the one
 * the server gave, in its config or its refusal) and the file's own size; anything else is the server's own words.
 */
export function uploadFailure(file: { name: string; size: number }, status: number, body: unknown, where: string, knownLimit: number | null = null): string {
  const said = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  const limit = uploadLimitOf(body) ?? knownLimit;
  const over = status === 413 || (limit !== null && file.size > limit && status !== 401 && status !== 403);
  if (over) {
    return limit !== null
      ? `Too big for ${where}: it takes files up to ${sizeWords(limit)}, and this one is ${sizeWords(file.size)}.`
      : `Too big for ${where} (this file is ${sizeWords(file.size)}).${said ? ` It says: ${said}` : ""}`;
  }
  if (status === 0) return `Can't reach ${where}, or it cut the upload off (this file is ${sizeWords(file.size)}). The file wasn't sent.`;
  if (status === 401) return `Your sign-in on ${where} ended. Sign in again, then attach it once more.`;
  return said || `The upload didn't land (${where} answered ${status}).`;
}

/** a file too big to send, known before a byte goes (the server said its limit): the words, or null when it fits */
export function tooBigBefore(file: { name: string; size: number }, limit: number | null, where: string): string | null {
  if (limit === null || file.size <= limit) return null;
  return uploadFailure(file, 413, { limit }, where, limit);
}

/**
 * One sign-in (Josh, 2026-11-25: "the first sign in for Foundation should automatically log you in to
 * ChatForm"). ChatForm in the desktop app is on a chat server of its own (apps/chatserver), which has its own
 * accounts and trusts Google, never a Foundation server. So when a person finishes a **Google** sign-in here,
 * this server passes Google's own proof along:
 *
 *   1. auth.ts googleIdentity takes the `id_token` from Google's token answer and holds it here, in memory,
 *      under the sign-in it came back with (`holdGoogleProof`).
 *   2. When that sign-in becomes a Foundation session (auth.ts signIn: at once in a browser, only after the
 *      person's "This is me" for an app), `startChatSession` posts the token, server to server, to
 *      `<chat server>/auth/exchange`. The chat server checks Google's signature and the audience itself and
 *      answers `{ user, session }`: a bearer of its own.
 *   3. The signed-in app collects it once, by its own Foundation session, at `POST /api/chat-session`
 *      (`claimChatSession`), keeps it as it keeps any chat bearer, and ChatForm opens signed in.
 *
 * The rules:
 *  - **Which chat server** is this server's own setting (FOUNDATION_CHAT_SERVER; config.ts) and nothing else. A
 *    person's Google ID token sent to an address a browser, a link or a query named would hand their identity
 *    to whoever chose it. https only (or this computer, for tests); a redirect is not followed.
 *  - **Sign-in never waits on ChatForm, and never fails because of it.** The exchange runs beside the sign-in,
 *    each call is cut off after a few seconds, the chat server is asked first whether it exchanges at all
 *    (`GET /auth/config` → `exchange: true`, remembered briefly), and anything else is skipped quietly: ChatForm's
 *    own sign-in screen is still there.
 *  - **The chat bearer is held in memory only**, never written to SQLite, a log, a URL, a redirect or a cookie;
 *    for five minutes, tied to the one Foundation session that earned it, handed over once. One nobody collects
 *    (or whose Foundation session signs out first) is signed out at the chat server.
 *  - **No Google proof, no exchange.** Dev sign-in, an invitation on the network and Google through Flowform
 *    (Flowform runs Google; this server never sees an ID token) exchange nothing, and neither does a session
 *    from before this existed. Nobody's identity is made up for them: ChatForm asks them to sign in itself.
 */

import { config } from "./config.ts";

/** what `POST /api/chat-session` answers: the chat server this Foundation server signs in to ("" when none), and the session if there was one to collect */
export interface ChatSessionClaim {
  server: string;
  session: string | null;
  user?: unknown;
}

interface Grant {
  server: string;
  session: string;
  user: unknown;
}

interface Held {
  at: number;
  /** Google's proof, until the sign-in it belongs to becomes a session */
  idToken?: string;
  /** the exchange, once that session exists */
  pending?: Promise<Grant | null>;
}

/** how long each call may take, and how long anything is held; tests shorten them */
export const chatSessionLimits = { configMs: 3_000, exchangeMs: 5_000, holdMs: 5 * 60_000 };
/** the clock holds expire by; tests move it */
export const chatSessionClock = { now: () => Date.now() };

const MAX_HELD = 500;
/** by `proof:<sha256 of the Google state>` until there is a session, then by `session:<the session's hash>` */
const held = new Map<string, Held>();
/** does this chat server exchange: asked once a minute (a no or a failure, every fifteen seconds) */
const offers = new Map<string, { at: number; ok: boolean }>();

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** a chat server's origin from the setting: "" when unset, null when it isn't one this server will send a token to */
export function chatServerOrigin(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL.has(u.hostname.toLowerCase()))) return u.origin;
  return null;
}

let warned = "";
/** the configured chat server, or "" (none, or one that is refused: said once, without repeating the value) */
export function chatServer(): string {
  const origin = chatServerOrigin(config.chatServer);
  if (origin === null) {
    if (warned !== config.chatServer) console.warn("chat sign-in: FOUNDATION_CHAT_SERVER is not an https address (or this computer), so it is ignored.");
    warned = config.chatServer;
    return "";
  }
  return origin;
}

function sweep() {
  const now = chatSessionClock.now();
  for (const [key, h] of held) if (now - h.at >= chatSessionLimits.holdMs) discard(key);
  // more sign-ins in flight than any real server has: the oldest go first
  while (held.size > MAX_HELD) discard(held.keys().next().value as string);
}

/** let go of what is held under this key; a chat session nobody will collect is ended where it was made */
function discard(key: string) {
  const h = held.get(key);
  held.delete(key);
  void h?.pending?.then((g) => g && signOutThere(g));
}

function sweepLater() {
  setTimeout(sweep, chatSessionLimits.holdMs + 1_000).unref();
}

/**
 * Google's proof for a sign-in still in flight (`proof`: the hash of the state Google returned). Kept only when
 * there is a chat server to take it to, and only until the sign-in becomes a session or five minutes pass.
 */
export function holdGoogleProof(proof: string, idToken: unknown) {
  if (!proof || typeof idToken !== "string" || idToken.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(idToken)) return;
  if (!chatServer()) return;
  sweep();
  held.set(`proof:${proof}`, { at: chatSessionClock.now(), idToken });
  sweepLater();
}

/** a sign-in that ended without a session (turned down, refused): its proof is forgotten */
export function dropGoogleProof(proof: string) {
  held.delete(`proof:${proof}`);
}

/**
 * The sign-in became a Foundation session: exchange its proof now, beside the sign-in (nothing here is awaited
 * by it, and nothing here throws). The result waits under the session's hash for that session to collect.
 */
export function startChatSession(proof: string, sessionHash: string) {
  const h = held.get(`proof:${proof}`);
  held.delete(`proof:${proof}`);
  if (!h?.idToken || !sessionHash || chatSessionClock.now() - h.at >= chatSessionLimits.holdMs) return;
  held.set(`session:${sessionHash}`, { at: chatSessionClock.now(), pending: exchange(h.idToken).catch(() => null) });
  sweepLater();
}

/**
 * The session collects what its sign-in earned, once. `expect` is the chat server the app's ChatForm is on, to
 * compare only (it is never an address anything is sent to): an app on another chat server takes nothing.
 */
export async function claimChatSession(sessionHash: string, expect?: string): Promise<ChatSessionClaim> {
  sweep();
  const server = chatServer();
  const key = `session:${sessionHash}`;
  const h = held.get(key);
  if (!h?.pending || (expect !== undefined && expect !== server)) return { server, session: null };
  held.delete(key);
  const g = await h.pending;
  if (!g) return { server, session: null };
  return { server: g.server, session: g.session, user: g.user };
}

/** the Foundation session ended (sign-out): whatever it hadn't collected is not kept for anyone else */
export function forgetChatSession(sessionHash: string) {
  discard(`session:${sessionHash}`);
}

/** for tests: nothing held, nothing remembered about any chat server */
export function resetChatSessions() {
  held.clear();
  offers.clear();
  warned = "";
}

async function exchanges(origin: string): Promise<boolean> {
  const known = offers.get(origin);
  const now = chatSessionClock.now();
  if (known && now - known.at < (known.ok ? 60_000 : 15_000)) return known.ok;
  let ok = false;
  try {
    const res = await fetch(`${origin}/auth/config`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(chatSessionLimits.configMs) });
    ok = res.ok && ((await res.json()) as { exchange?: unknown } | null)?.exchange === true;
  } catch {
    /* unreachable, slow, or not a chat server: no exchange */
  }
  offers.set(origin, { at: chatSessionClock.now(), ok });
  return ok;
}

/** what went wrong, in a word: never a body, a header or a token */
const why = (e: unknown) => ((e as Error)?.name === "TimeoutError" ? "didn't answer in time" : "couldn't be reached");

async function exchange(idToken: string): Promise<Grant | null> {
  const server = chatServer();
  if (!server || !(await exchanges(server))) return null;
  try {
    // the token goes in the body, to the configured origin alone: a redirect elsewhere is an error, not a second address
    const res = await fetch(`${server}/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ id_token: idToken }),
      redirect: "error",
      signal: AbortSignal.timeout(chatSessionLimits.exchangeMs),
    });
    if (!res.ok) {
      // 401: it doesn't accept this proof (another Google client than it trusts, or someone not on its allowlist)
      console.warn(`chat sign-in: ${server} answered ${res.status} to the exchange; ChatForm will ask for its own sign-in.`);
      return null;
    }
    const body = (await res.json()) as { session?: unknown; user?: unknown } | null;
    if (!body || typeof body.session !== "string" || !body.session || body.session.length > 4096 || !body.user || typeof body.user !== "object") return null;
    return { server, session: body.session, user: body.user };
  } catch (e) {
    console.warn(`chat sign-in: ${server} ${why(e)}; ChatForm will ask for its own sign-in.`);
    return null;
  }
}

/** end a chat session this server asked for and nobody collected (it would otherwise live out its days unused) */
async function signOutThere(g: Grant) {
  try {
    await fetch(`${g.server}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${g.session}` }, redirect: "error", signal: AbortSignal.timeout(chatSessionLimits.exchangeMs) });
  } catch {
    /* it expires on its own */
  }
}

/**
 * Sign-in. Two doors, one session model (ported from flowform-server's
 * allowlist + Google OAuth, simplified to cookie sessions):
 *
 * - Google OAuth (authorization-code flow) when GOOGLE_CLIENT_ID/SECRET are set.
 * - Dev login — pick a name and an allowlisted email, no password — for local
 *   testing. Off unless FOUNDATION_DEV_LOGIN=1, and even then only from this
 *   computer, with an allowlist, while T3 isn't running (devSignInRefusal).
 *
 * Sessions are random 32-byte tokens in an HttpOnly cookie (browser) or a
 * Bearer header (the app on another site's server, agents); only their
 * SHA-256 is stored, and a bearer never travels in a URL (flowform-server's
 * rules). Sockets that can't send a header use a one-time ticket instead
 * (sockets.ts). The service token authenticates other services and agents as
 * the "foundation-agent" user.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { UserInfo } from "@foundation/protocol";
import { config } from "./config.ts";
import { one, run } from "./db.ts";
import { HttpError, parseCookies, type Req } from "./http.ts";
import { audit } from "./audit.ts";

const SESSION_DAYS = 30;
/** an agent's bearer (/api/agent/token) lasts a week (ADR-001 G9) */
export const AGENT_TOKEN_DAYS = 7;
const COOKIE = "foundation_session";

const PALETTE = ["#e8553d", "#2f6fde", "#1e9e6a", "#c2410c", "#7c3aed", "#0e7490", "#b45309", "#be185d"];

export function isAllowed(email: string): boolean {
  const e = email.toLowerCase();
  if (config.allowlist.length === 0) return true;
  return config.allowlist.some((rule) => (rule.startsWith("@") ? e.endsWith(rule) : e === rule));
}

/** a request straight from this computer: a loopback peer, and no proxy in between that names another client */
export function fromLoopback(req: Req): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  // a reverse proxy on this computer forwards other people's requests from loopback: those say so in these headers
  return loopback && !req.headers["x-forwarded-for"] && !req.headers.forwarded && !req.headers["x-real-ip"];
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * Why dev sign-in (no password) is refused for this request, or null when it may go ahead. Anything that
 * can reach the port and passes here becomes "a person", so it asks (ADR-001 G0): turned on
 * (FOUNDATION_DEV_LOGIN=1); an allowlist to keep to (an empty one admits everyone); a request from this
 * computer, by a loopback name (a proxy on this computer, such as the client's dev server opened to the
 * network, forwards other computers' requests from loopback under the name they used); and nothing with a
 * shell running here (`shell` names it: Foundation's T3 gives agents one, the built-in terminal is one, a
 * job may run Claude Code; any of them could sign itself in as a person).
 */
export function devSignInRefusal(req: Req, shell: string | false): string | null {
  if (!config.devLogin) return "Sign-in by email alone is off on this server. To use it on your own computer, add FOUNDATION_DEV_LOGIN=1 to .env and restart the server.";
  if (config.allowlist.length === 0) return "Sign-in by email alone needs an allowlist (FOUNDATION_ALLOWLIST), and this server has none, so it is refused.";
  if (!fromLoopback(req) || !LOOPBACK_HOST.test(String(req.headers.host ?? ""))) return "Sign-in by email alone works only from the computer the server runs on.";
  if (shell) return `Sign-in by email alone is refused while ${shell} is running here, because it has a shell on this computer. Stop it, or sign in with Google.`;
  return null;
}

export function upsertUser(email: string, name: string): UserInfo {
  const e = email.toLowerCase().trim();
  const existing = one<UserInfo>("select id, email, name, color, role from users where email = ?", e);
  if (existing) {
    if (name && name !== existing.name) run("update users set name = ? where id = ?", name, existing.id);
    return { ...existing, name: name || existing.name };
  }
  const id = `u_${randomBytes(6).toString("hex")}`;
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const role = config.adminEmails.includes(e) ? "admin" : "member";
  run("insert into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, ?, ?)", id, e, name || e.split("@")[0], color, role, Date.now());
  const user: UserInfo = { id, email: e, name: name || e.split("@")[0], color, role };
  // someone Slack's history already knows by this email becomes themselves in ChatForm (a lazy import: chat reads auth)
  void import("./chatimport.ts").then((m) => m.linkGhostsByEmail(user)).catch(() => {});
  return user;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * What a session is for. `browser`: the sign-in cookie. `app`: a person's own
 * app holding a bearer because the cookie can't reach this server (the
 * desktop app on a hosted server); it counts as a person, like the cookie.
 * `agent`: a bearer handed to an agent (/api/agent/token, an agent run's MCP).
 */
export type SessionKind = "browser" | "app" | "agent";

export function createSession(userId: string, ttlMs = SESSION_DAYS * 864e5, kind: SessionKind = "browser"): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  run("insert into sessions (token, user_id, created_at, expires_at, kind) values (?, ?, ?, ?, ?)", hashToken(token), userId, now, now + ttlMs, kind);
  return token;
}

/**
 * Finish a sign-in. A browser gets the cookie. A client that asked for a
 * bearer (`{ bearer: true }`: the app on a server that isn't its own site,
 * where a SameSite cookie never arrives) gets an `app` session in the
 * response body instead, to keep outside URLs and send as Authorization.
 */
export function signIn(res: ServerResponse, userId: string, bearer: boolean): { session?: string } {
  if (bearer) return { session: createSession(userId, SESSION_DAYS * 864e5, "app") };
  setSessionCookie(res, createSession(userId));
  return {};
}

export function revokeSession(token: string) {
  run("delete from sessions where token = ?", hashToken(token));
}

export function setSessionCookie(res: ServerResponse, token: string) {
  const secure = config.publicUrl.startsWith("https") ? "; Secure" : "";
  res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

export function clearSession(req: Req, res: ServerResponse) {
  const token = tokenFrom(req);
  if (token) run("delete from sessions where token = ?", hashToken(token));
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** the request carries the sign-in cookie (whether or not its session is still live) */
export function hasSessionCookie(req: { headers: { cookie?: string } }): boolean {
  return Boolean(parseCookies(req.headers.cookie)[COOKIE]);
}

export function tokenFrom(req: Req): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return parseCookies(req.headers.cookie)[COOKIE] ?? null;
}

const AGENT_USER: UserInfo = { id: "agent", email: "agent@foundation.local", name: "Foundation Agent", color: "#7c3aed", role: "member" };

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function userFromRequest(req: Req): UserInfo | null {
  const token = tokenFrom(req);
  if (!token) return null;
  if (isServiceToken(token)) return AGENT_USER;
  const found = userFromSessionHash(hashToken(token));
  if (!found) return null;
  const { kind: _k, ...user } = found;
  return user;
}

export const isServiceToken = (token: string) => config.serviceToken.length >= 32 && safeEq(token, config.serviceToken);

/** the live session stored under this hash, as its person (and what kind of session it is) */
export function userFromSessionHash(sessionHash: string): (UserInfo & { kind: SessionKind | null }) | null {
  const row = one<UserInfo & { expires_at: number; kind: SessionKind | null }>(
    "select u.id, u.email, u.name, u.color, u.role, s.expires_at, s.kind from sessions s join users u on u.id = s.user_id where s.token = ?",
    sessionHash,
  );
  if (!row || row.expires_at < Date.now()) return null;
  const { expires_at: _e, ...user } = row;
  return user;
}

export function requireUser(req: Req): UserInfo {
  const u = req.user ?? userFromRequest(req);
  if (!u) throw new HttpError(401, "sign in first");
  req.user = u;
  return u;
}

/**
 * A person at their own screen, not an agent: the session is the sign-in
 * cookie with no bearer on the request, or a bearer the person's app was
 * given at sign-in (kind `app`). Agents, MCP clients and the service token
 * hold `agent` bearers (or none of these), so things that run third-party
 * code (starting a machine) can ask for this.
 */
export function requirePerson(req: Req, what = "This"): UserInfo {
  const u = requireUser(req);
  if (personBehind(req, u)) return u;
  // recorded: who was refused, at which route, and on which board (audit.ts); never the request's body
  const path = new URL(req.url ?? "/", "http://local").pathname;
  audit({
    actor_kind: u.id === AGENT_USER.id ? "service" : "agent",
    actor_id: u.id === AGENT_USER.id ? "agent" : `agent:${u.id}`,
    actor_name: u.name,
    for_person: u.id === AGENT_USER.id ? null : u.id,
    board_id: /^\/api\/boards\/([^/]+)/.exec(path)?.[1] ?? req.query?.get("board") ?? null,
    door: "route",
    action: `${req.method ?? "?"} ${path}`,
    decision: "refused",
    reason: `${what} needs a person`,
  });
  throw new HttpError(403, `${what} needs a person: press the button on the card. Agents can propose, not run.`);
}

/** requirePerson's test, for a signed-in user: their browser's cookie with no bearer, or their app's sign-in bearer */
function personBehind(req: Req, u: UserInfo): boolean {
  if (u.id === AGENT_USER.id) return false;
  const auth = req.headers.authorization;
  if (auth) {
    // a bearer is a person only if it is an app's sign-in session
    const s = auth.startsWith("Bearer ") ? userFromSessionHash(hashToken(auth.slice(7))) : null;
    return s?.kind === "app";
  }
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(cookie) && userFromSessionHash(hashToken(cookie!))?.kind !== "agent";
}

/** is this request a person (requirePerson's test), without refusing it or recording a refusal */
export function isPerson(req: Req, _user?: UserInfo): boolean {
  try {
    return personBehind(req, requireUser(req));
  } catch {
    return false;
  }
}

// ---------- Google OAuth ----------

const pendingStates = new Map<string, number>();
/** the browser that started a Google sign-in holds its state in this cookie; the callback must come back to it */
export const GOOGLE_STATE_COOKIE = "foundation_google_state";

/** where Google is asked to sign the person in, and the cookie that binds that sign-in to this browser */
export function googleStart(): { url: string; cookie: string } {
  const url = googleAuthUrl();
  const state = new URL(url).searchParams.get("state")!;
  const secure = config.publicUrl.startsWith("https") ? "; Secure" : "";
  return { url, cookie: `${GOOGLE_STATE_COOKIE}=${state}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure}` };
}

export function googleAuthUrl(): string {
  if (!config.google.clientId) throw new HttpError(501, "Google sign-in is not configured (GOOGLE_CLIENT_ID)");
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: `${config.publicUrl}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Google came back. Only to the browser that started (its state cookie, `presented`, names this state):
 * another browser's callback is someone else's sign-in, and finishing it here would sign this browser in as
 * them (login CSRF).
 */
export async function googleCallback(code: string, state: string, presented: string): Promise<UserInfo> {
  const issued = pendingStates.get(state);
  pendingStates.delete(state);
  if (!issued || Date.now() - issued > 10 * 60_000) throw new HttpError(400, "sign-in expired, try again");
  if (!presented || !safeEq(presented, state)) throw new HttpError(400, "This sign-in was started in a different browser. Start again from Foundation.");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: `${config.publicUrl}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new HttpError(502, "Google rejected the sign-in");
  const tokens = (await tokenRes.json()) as { access_token: string };
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const info = (await infoRes.json()) as { email?: string; email_verified?: boolean; name?: string };
  if (!info.email || !info.email_verified) throw new HttpError(403, "Google account has no verified email");
  if (!isAllowed(info.email)) throw new HttpError(403, `${info.email} is not on Foundation's allowlist`);
  return upsertUser(info.email, info.name ?? "");
}

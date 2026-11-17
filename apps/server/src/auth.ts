/**
 * Sign-in. Two doors, one session model (ported from flowform-server's
 * allowlist + Google OAuth, simplified to cookie sessions):
 *
 * - Google OAuth (authorization-code flow) when GOOGLE_CLIENT_ID/SECRET are set.
 * - Dev login — pick a name and an allowlisted email, no password — for local
 *   testing. Disabled with FOUNDATION_DEV_LOGIN=0.
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

const SESSION_DAYS = 30;
const COOKIE = "foundation_session";

const PALETTE = ["#e8553d", "#2f6fde", "#1e9e6a", "#c2410c", "#7c3aed", "#0e7490", "#b45309", "#be185d"];

export function isAllowed(email: string): boolean {
  const e = email.toLowerCase();
  if (config.allowlist.length === 0) return true;
  return config.allowlist.some((rule) => (rule.startsWith("@") ? e.endsWith(rule) : e === rule));
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
  return { id, email: e, name: name || e.split("@")[0], color, role };
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
  const refuse = () => new HttpError(403, `${what} needs a person: press the button on the card. Agents can propose, not run.`);
  if (u.id === AGENT_USER.id) throw refuse();
  const auth = req.headers.authorization;
  if (auth) {
    // a bearer is a person only if it is an app's sign-in session
    const s = auth.startsWith("Bearer ") ? userFromSessionHash(hashToken(auth.slice(7))) : null;
    if (s?.kind !== "app") throw refuse();
    return u;
  }
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  if (!cookie || userFromSessionHash(hashToken(cookie))?.kind === "agent") throw refuse();
  return u;
}

/** is this request a person (requirePerson's test: their browser's cookie, or their app's sign-in bearer), without refusing it */
export function isPerson(req: Req, _user?: UserInfo): boolean {
  try {
    requirePerson(req);
    return true;
  } catch {
    return false;
  }
}

// ---------- Google OAuth ----------

const pendingStates = new Map<string, number>();

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

export async function googleCallback(code: string, state: string): Promise<UserInfo> {
  const issued = pendingStates.get(state);
  pendingStates.delete(state);
  if (!issued || Date.now() - issued > 10 * 60_000) throw new HttpError(400, "sign-in expired, try again");
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

/**
 * A person's link to Flowform: Foundation reads their Flowform boards and
 * files through flowform-server's own MCP endpoint (`<FLOWFORM_URL>/mcp`), as
 * that person, with the access Flowform gives them and no more.
 *
 * How it connects (learned from the server itself, 2026-11-09: its
 * `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`):
 * the standard MCP authorization — a public OAuth client registered once
 * (dynamic registration), an authorization code with PKCE (S256) that the
 * person approves in their browser on Flowform's own page, then an access
 * token and a refresh token.
 *
 * Rules:
 *  - **Read only.** Foundation asks for `search:read canvas:read` and nothing
 *    else, so the token can't write a Flowform canvas whoever holds it.
 *  - **A person connects it**, from their browser or desktop app. An agent's
 *    bearer can use a link that exists; it can't make or remove one.
 *  - **Per person.** Each person's link is their own; nobody reads Flowform as
 *    someone else.
 *  - Flowform's tokens have to be replayed, so they can't be stored hashed like
 *    Foundation's own sessions. They are encrypted at rest (AES-256-GCM) with a
 *    key that lives beside the database (`data/secret.key`), never in it, and
 *    they never leave the server: not in a URL, a response or a log.
 *  - Disconnect revokes the tokens at Flowform, then forgets them.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db, one, run } from "./db.ts";
import { HttpError } from "./http.ts";
import { callMcpTool, listMcpTools } from "./mcpclient.ts";

/** what Foundation asks Flowform for: reading, never writing */
export const SCOPE = "search:read canvas:read";

db.exec(`
  create table if not exists flowform_links (
    user_id text primary key, access text not null, refresh text, expires_at integer not null,
    scope text not null default '', connected_at integer not null
  );
  create table if not exists flowform_oauth_client (
    issuer text primary key, client_id text not null, redirect_uri text not null, at integer not null
  );
`);
try {
  db.exec("alter table flowform_links add column client_id text");
} catch { /* already there */ }

// ---------- the key, and sealing ----------

let key: Buffer | null = null;
function secretKey(): Buffer {
  if (key) return key;
  const file = join(config.dataDir, "secret.key");
  if (existsSync(file)) key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (!key || key.length !== 32) {
    key = randomBytes(32);
    writeFileSync(file, key.toString("base64"), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch { /* Windows: the file takes the folder's ACL */ }
  }
  return key;
}

/** encrypt for the database: iv.tag.ciphertext, base64url */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
export function unseal(sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", secretKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

// ---------- Flowform's OAuth, as it describes itself ----------

const base = () => config.flowformUrl.replace(/\/$/, "");
export const mcpUrl = () => `${base()}/mcp`;
const redirectUri = () => `${config.publicUrl.replace(/\/$/, "")}/auth/flowform/link/callback`;

interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}
let meta: { at: number; base: string; v: AuthServer } | null = null;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, `Flowform (${new URL(url).host}) can't be reached from here`);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `Flowform answered ${res.status} at ${new URL(url).pathname}${text && text.length < 200 ? `: ${text}` : ""}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(502, `Flowform's answer at ${new URL(url).pathname} wasn't JSON`);
  }
}

async function authServer(): Promise<AuthServer> {
  if (meta && meta.base === base() && Date.now() - meta.at < 3600_000) return meta.v;
  const v = await getJson<AuthServer>(`${base()}/.well-known/oauth-authorization-server`);
  // every endpoint must be Flowform's own: a token is only ever sent to the server it's for
  for (const u of [v.authorization_endpoint, v.token_endpoint, v.registration_endpoint, v.revocation_endpoint])
    if (u && new URL(u).origin !== new URL(base()).origin) throw new HttpError(502, "Flowform's sign-in points at another server; not following it");
  meta = { at: Date.now(), base: base(), v };
  return v;
}

/**
 * Foundation as an OAuth client of this Flowform. Registered afresh for every connection: Flowform forgets a
 * registration that goes unused (a day-old one got "This tool is not registered with Flowform"), and the approval
 * page is the person's browser, so a stale id can't be noticed and retried from here. Each link keeps the id it
 * was made with, for its refreshes.
 */
async function registerClient(): Promise<string> {
  const as = await authServer();
  if (!as.registration_endpoint) throw new HttpError(502, "This Flowform doesn't register clients, so Foundation can't connect to it");
  const reg = await getJson<{ client_id: string }>(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Foundation",
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  if (!reg.client_id) throw new HttpError(502, "Flowform registered Foundation without a client id");
  run("insert or replace into flowform_oauth_client (issuer, client_id, redirect_uri, at) values (?, ?, ?, ?)", as.issuer, reg.client_id, redirectUri(), Date.now());
  return reg.client_id;
}

// ---------- connecting ----------

/** sign-ins in flight: state (hashed) → who started it and the PKCE verifier. Ten minutes, spent once, in memory. */
const attempts = new Map<string, { userId: string; verifier: string; clientId: string; at: number }>();
const ATTEMPT_MS = 10 * 60_000;
const sha = (s: string) => createHash("sha256").update(s).digest();

/** the address to send this person's browser to: Flowform's own approval page */
export async function beginLink(userId: string): Promise<{ url: string }> {
  const as = await authServer();
  const id = await registerClient();
  for (const [k, a] of attempts) if (Date.now() - a.at > ATTEMPT_MS) attempts.delete(k);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  attempts.set(sha(state).toString("hex"), { userId, verifier, clientId: id, at: Date.now() });
  const u = new URL(as.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", sha(verifier).toString("base64url"));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", mcpUrl());
  return { url: u.toString() };
}

interface TokenAnswer {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function keep(userId: string, t: TokenAnswer, clientId: string, connectedAt = Date.now()) {
  const old = one<{ refresh: string | null }>("select refresh from flowform_links where user_id = ?", userId);
  run(
    "insert or replace into flowform_links (user_id, access, refresh, expires_at, scope, connected_at, client_id) values (?, ?, ?, ?, ?, ?, ?)",
    userId,
    seal(t.access_token),
    // a refresh that doesn't hand back a new refresh token keeps the old one
    t.refresh_token ? seal(t.refresh_token) : (old?.refresh ?? null),
    Date.now() + (t.expires_in ?? 3600) * 1000,
    t.scope ?? SCOPE,
    connectedAt,
    clientId,
  );
}

async function tokenRequest(params: Record<string, string>, clientId: string): Promise<TokenAnswer> {
  const as = await authServer();
  const t = await getJson<TokenAnswer>(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: clientId, resource: mcpUrl() }).toString(),
  });
  if (!t.access_token) throw new HttpError(502, "Flowform answered without a token");
  return t;
}

/** Flowform sent the person back: trade the code for their tokens. Returns whose link it is. */
export async function finishLink(code: string, state: string): Promise<string> {
  const k = sha(state || "").toString("hex");
  const a = attempts.get(k);
  attempts.delete(k);
  if (!a || Date.now() - a.at > ATTEMPT_MS) throw new HttpError(400, "That Flowform sign-in expired or was already used. Start it again from Foundation.");
  if (!code) throw new HttpError(400, "Flowform didn't send a code");
  keep(a.userId, await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: a.verifier }, a.clientId), a.clientId);
  return a.userId;
}

// ---------- using it ----------

export interface LinkStatus {
  connected: boolean;
  server: string;
  scope?: string;
  connectedAt?: number;
}

export function linkStatus(userId: string): LinkStatus {
  const row = one<{ scope: string; connected_at: number }>("select scope, connected_at from flowform_links where user_id = ?", userId);
  return row ? { connected: true, server: new URL(base()).host, scope: row.scope, connectedAt: row.connected_at } : { connected: false, server: new URL(base()).host };
}

const refreshing = new Map<string, Promise<string>>();

/** this person's access token, refreshed when it's within a minute of expiring (one refresh at a time per person) */
async function accessToken(userId: string, force = false): Promise<string> {
  const row = one<{ access: string; refresh: string | null; expires_at: number; connected_at: number; client_id: string | null }>("select access, refresh, expires_at, connected_at, client_id from flowform_links where user_id = ?", userId);
  if (!row) throw new HttpError(409, "Flowform isn't connected for you yet. Connect it in Settings → Services.");
  if (!force && row.expires_at - Date.now() > 60_000) return unseal(row.access);
  if (!row.refresh || !row.client_id) {
    run("delete from flowform_links where user_id = ?", userId);
    throw new HttpError(409, "Your Flowform connection expired. Connect it again in Settings → Services.");
  }
  let p = refreshing.get(userId);
  if (!p) {
    p = (async () => {
      try {
        const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: unseal(row.refresh!) }, row.client_id!);
        keep(userId, t, row.client_id!, row.connected_at);
        return t.access_token;
      } catch (e) {
        // Flowform refused the refresh token (revoked there, or expired): the link is over
        if (e instanceof HttpError && /answered 4\d\d/.test(e.message)) {
          run("delete from flowform_links where user_id = ?", userId);
          throw new HttpError(409, "Your Flowform connection was ended on Flowform's side. Connect it again in Settings → Services.");
        }
        throw e;
      } finally {
        refreshing.delete(userId);
      }
    })();
    refreshing.set(userId, p);
  }
  return p;
}

const unauthorized = (e: unknown) => /\b401\b|unauthori[sz]ed/i.test((e as Error)?.message ?? "");

/** run something against Flowform's MCP as this person; an access token Flowform no longer takes is refreshed once */
async function asPerson<T>(userId: string, fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const go = async (force: boolean) => fn({ authorization: `Bearer ${await accessToken(userId, force)}` });
  try {
    return await go(false);
  } catch (e) {
    if (e instanceof HttpError || !unauthorized(e)) throw e;
    return go(true);
  }
}

/** the tools Flowform offers this person (its own names and descriptions) */
export const flowformTools = (userId: string) => asPerson(userId, (h) => listMcpTools(mcpUrl(), h));

/** call one of Flowform's tools as this person. The token is read-only, so Flowform refuses anything that writes. */
export const flowformCall = (userId: string, name: string, args: Record<string, unknown> = {}) => asPerson(userId, (h) => callMcpTool(mcpUrl(), name, args, h));

/** end the link: revoke at Flowform (best effort), then forget the tokens here */
export async function unlink(userId: string): Promise<void> {
  const row = one<{ access: string; refresh: string | null; client_id: string | null }>("select access, refresh, client_id from flowform_links where user_id = ?", userId);
  if (!row) return;
  run("delete from flowform_links where user_id = ?", userId);
  try {
    const as = await authServer();
    if (!as.revocation_endpoint || !row.client_id) return;
    const id = row.client_id;
    for (const sealed of [row.refresh, row.access]) {
      if (!sealed) continue;
      await fetch(as.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: unseal(sealed), client_id: id }).toString(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  } catch {
    /* Flowform unreachable: the tokens are gone from here either way */
  }
}

/** the page the person lands on after Flowform sends them back (their browser, or the system browser for the desktop app) */
export function landingPage(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foundation · Flowform</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ec;color:#201e19;font:400 14px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px}h1{font-size:20px;margin:0 0 8px;letter-spacing:-.01em}p{margin:0;color:#5f5b51}b{color:${ok ? "#2e7d54" : "#b3261e"}}
@media (prefers-color-scheme:dark){body{background:#0a111f;color:#e6ecf7}p{color:#94a2b9}}</style>
<main><h1><b>${ok ? "✓" : "!"}</b> ${esc(ok ? "Flowform is connected" : "Flowform didn't connect")}</h1><p>${esc(message)}</p></main>
<script>try{window.opener&&window.opener.postMessage({type:"foundation:flowform-link",ok:${ok}},"*")}catch(e){}${ok ? "setTimeout(function(){window.close()},1200)" : ""}</script>`;
}

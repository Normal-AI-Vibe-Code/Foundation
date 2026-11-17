/**
 * Sign in with Google through Flowform — the same Google login, on the same
 * server, as the flowform client.
 *
 * Foundation doesn't hold a Google client of its own for this: it hands the
 * person to flowform-server's native sign-in (FLOWFORM_URL, default
 * https://server.formresearch.ai), exactly as the flowform client does:
 *
 *   1. {flowform}/auth/google/start?cb=http://localhost:<port>/auth/flowform/done/<nonce>
 *      — flowform runs Google (its client, its PKCE, its JWKS check, its
 *      signup allowlist) and 303s back to the loopback with ?session_token=…
 *   2. Foundation asks {flowform}/auth/me with that bearer: a verified Google
 *      identity (email_verified) and flowform's role.
 *   3. Foundation keeps that flowform session, encrypted, for downloading the
 *      person's Flowform files and nothing else (flowformfiles.ts; Josh,
 *      2026-11-11; until then it was revoked here), upserts its own user, and
 *      mints its own session. A refused sign-in's session is revoked.
 *
 * Two ways to finish:
 *  - web: the browser that started is the browser that finishes; a cookie
 *    bound to the attempt is checked at /done (no login fixation), and the
 *    Foundation session cookie is set there.
 *  - desktop (Tauri): Google refuses embedded webviews, so the window opens the
 *    system browser and polls with a secret only it holds; the poll response
 *    sets the session cookie in the window.
 *
 * Attempts in flight live in SQLite (`flowform_attempts`), hashed, for 10
 * minutes and spent once, so a server restart mid-sign-in doesn't lose them.
 *
 * flowform's loopback rule (http, 127.0.0.1 | localhost, a port, no fragment)
 * means this works wherever Foundation's server runs on the person's machine.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { UserInfo } from "@foundation/protocol";
import { config } from "./config.ts";
import { all, db, one, run } from "./db.ts";
import { createSession, setSessionCookie, signIn, upsertUser } from "./auth.ts";
import { HttpError, parseCookies, type Req } from "./http.ts";
import { finishGrant, keepSession, takeGrant } from "./flowformfiles.ts";

const ATTEMPT_TTL = 10 * 60_000; // flowform's own oauth_state lives 10 minutes
const ATTEMPT_COOKIE = "foundation_ff_attempt";
const STALLED_AFTER = 60_000; // /done asks flowform with a 10 s timeout; a minute without an answer means it never will

/**
 * A sign-in in flight. It lives in SQLite (`flowform_attempts`, db.ts), not in
 * this module, so a server restart (tsx watch reloads on every save) in the
 * middle of a sign-in doesn't lose it. Only hashes of its secrets are stored —
 * each is only ever compared: the callback nonce (flowform and the browser
 * see it), the web browser's binding cookie, the desktop window's poll secret.
 */
interface Attempt {
  nonce_hash: string;
  mode: "web" | "desktop";
  /** web: hash of the cookie the starting browser holds */
  browser_hash: string | null;
  /** desktop: hash of the poll secret only the window holds */
  poll_hash: string | null;
  /** where to land afterwards (web) */
  return_to: string;
  created_at: number;
  expires_at: number;
  /** flowform has come back once; a second /done is a replay */
  used_at: number | null;
  /** desktop: set once /done verified the person (or refused them) */
  result_user_id: string | null;
  result_error: string | null;
}

/** the clock attempts expire by; tests move it */
export const attemptClock = { now: () => Date.now() };

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

function sweep() {
  run("delete from flowform_attempts where expires_at <= ?", attemptClock.now());
}

function saveAttempt(nonce: string, a: { mode: Attempt["mode"]; browserHash?: string; pollHash?: string; returnTo: string }) {
  const now = attemptClock.now();
  run(
    "insert into flowform_attempts (nonce_hash, mode, browser_hash, poll_hash, return_to, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
    hash(nonce),
    a.mode,
    a.browserHash ?? null,
    a.pollHash ?? null,
    a.returnTo,
    now,
    now + ATTEMPT_TTL,
  );
}

/**
 * flowform came back: spend the attempt in one statement, so a replayed
 * callback (or a second server on the same file) finds it already used. A web
 * attempt is gone at once; a desktop attempt stays, used, so the window keeps
 * polling (pending) while flowform answers.
 */
function consumeAttempt(nonce: string): Attempt | undefined {
  const now = attemptClock.now();
  const a = one<Attempt>(
    "update flowform_attempts set used_at = ? where nonce_hash = ? and used_at is null and expires_at > ? returning *",
    now,
    hash(nonce),
    now,
  );
  if (a?.mode === "web") run("delete from flowform_attempts where nonce_hash = ?", a.nonce_hash);
  return a;
}

function sameHash(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const flowformUrl = () => config.flowformUrl.replace(/\/$/, "");

/** The loopback origin flowform will send the person back to. */
export function loopbackOrigin(req: Req): string {
  // Through Vite's proxy the Host is the client's (localhost:1430), so the
  // session cookie lands on the origin the person is actually using.
  const host = req.headers.host ?? "";
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && /:\d+$/.test(host)) return `http://${host}`;
  const pub = new URL(config.publicUrl);
  if ((pub.hostname === "localhost" || pub.hostname === "127.0.0.1") && pub.port) return pub.origin;
  throw new HttpError(500, "Flowform sign-in needs Foundation's server on this machine (a loopback address with a port)");
}

function flowformStartUrl(origin: string, nonce: string) {
  const cb = `${origin}/auth/flowform/done/${nonce}`;
  return `${flowformUrl()}/auth/google/start?cb=${encodeURIComponent(cb)}`;
}

/** web: redirect this browser to flowform's Google sign-in */
export function startWeb(req: Req, res: ServerResponse) {
  sweep();
  const nonce = secret();
  const browser = secret();
  const returnTo = safeReturn(req.query.get("return"));
  const location = flowformStartUrl(loopbackOrigin(req), nonce);
  saveAttempt(nonce, { mode: "web", browserHash: hash(browser), returnTo });
  res.setHeader("set-cookie", `${ATTEMPT_COOKIE}=${browser}; Path=/auth/flowform; HttpOnly; SameSite=Lax; Max-Age=${ATTEMPT_TTL / 1000}`);
  res.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end();
}

/** desktop: an attempt the window finishes by polling; the URL opens in the system browser */
export function beginDesktop(req: Req) {
  sweep();
  const nonce = secret();
  const poll = secret();
  const url = flowformStartUrl(loopbackOrigin(req), nonce);
  saveAttempt(nonce, { mode: "desktop", pollHash: hash(poll), returnTo: "/" });
  return { url, poll, expiresIn: ATTEMPT_TTL / 1000 };
}

function safeReturn(raw: string | null) {
  // only same-origin paths; never an absolute URL
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

interface FlowformMe {
  user_id: string;
  display_name: string;
  email: string;
  /** flowform ≥ Oct 2026: whether `email` is the address Google verified for this account's sign-in */
  email_verified?: boolean;
  role: "admin" | "user" | "viewer" | string;
  is_admin?: boolean;
}

async function verifyWithFlowform(token: string): Promise<FlowformMe> {
  const res = await fetch(`${flowformUrl()}/auth/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 401 || res.status === 403) throw new HttpError(401, "Flowform didn't accept that sign-in");
  if (!res.ok) throw new HttpError(502, `Flowform answered ${res.status}`);
  return (await res.json()) as FlowformMe;
}

/** a session Foundation won't keep (a refused sign-in) is ended at Flowform */
async function revokeAtFlowform(token: string) {
  try {
    await fetch(`${flowformUrl()}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  } catch {
    /* it expires on its own; nothing is stored here */
  }
}

/**
 * A flowform-verified person becomes (or stays) a Foundation user, keyed by
 * their flowform account. flowform only mints a session after a verified
 * Google sign-in, so the account is proven; its address may not be (flowform
 * keeps the sign-up address, e.g. josh@normallab.co for a Google identity at
 * josh@formindustries.co, and says so with email_verified: false). An
 * unproven address may name a new Foundation user, never claim someone else's.
 */
export function admitFlowformUser(me: FlowformMe): UserInfo {
  if (!me.email || !me.user_id) throw new HttpError(403, "Flowform didn't say who signed in");
  if (me.role === "viewer" && !config.flowformAdmitViewers) throw new HttpError(403, "This Flowform account is view-only");
  const linked = one<UserInfo>("select id, email, name, color, role from users where flowform_user_id = ?", me.user_id);
  let user: UserInfo;
  if (linked) {
    user = linked;
    if (me.display_name && me.display_name !== linked.name) {
      run("update users set name = ? where id = ?", me.display_name, linked.id);
      user = { ...linked, name: me.display_name };
    }
  } else {
    const holder = one<{ flowform_user_id: string | null }>("select flowform_user_id from users where email = ?", me.email.toLowerCase().trim());
    if (holder?.flowform_user_id && holder.flowform_user_id !== me.user_id) {
      throw new HttpError(403, `${me.email} belongs to another Flowform account in Foundation`);
    }
    // older flowform servers don't send email_verified; their callback still refused unverified Google emails
    if (holder && me.email_verified === false) {
      throw new HttpError(
        403,
        `Foundation already has ${me.email}, and Flowform can't confirm this Google sign-in owns that address. Sign in once with the dev login as ${me.email} and an admin can link it, or update your Flowform email.`,
      );
    }
    user = upsertUser(me.email, me.display_name);
    run("update users set flowform_user_id = ? where id = ?", me.user_id, user.id);
    // a flowform viewer (let in by FLOWFORM_ADMIT_VIEWERS) starts as a viewer here too; an admin can open a board to them
    if (!holder && me.role === "viewer" && user.role === "member") {
      run("update users set role = 'viewer' where id = ?", user.id);
      user = { ...user, role: "viewer" };
    }
  }
  // flowform's admins are Foundation's admins (as are FOUNDATION_ADMIN_EMAILS)
  if ((me.role === "admin" || me.is_admin) && user.role !== "admin") {
    run("update users set role = 'admin' where id = ?", user.id);
    user = { ...user, role: "admin" };
  }
  return user;
}

/** flowform 303s here with ?session_token=… after Google */
export async function done(req: Req, res: ServerResponse) {
  sweep();
  const token = req.query.get("session_token") ?? "";
  // a signed-in person allowing file downloads (flowformfiles.ts) comes back here too: keep the session, sign nobody in
  const grant = takeGrant(req.params.nonce ?? "");
  if (grant) {
    if (!/^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(token)) return page(res, 400, "Nothing was allowed", "Flowform didn't return a session. Try again from Foundation.");
    try {
      await finishGrant(grant.userId, await verifyWithFlowform(token), token);
    } catch (e) {
      void revokeAtFlowform(token);
      return page(res, e instanceof HttpError ? e.status : 500, "Nothing was allowed", (e as Error).message);
    }
    return page(res, 200, "Flowform files allowed", "Foundation can now bring your Flowform files in. You can close this tab.");
  }
  const attempt = consumeAttempt(req.params.nonce ?? "");
  if (!attempt) return page(res, 400, "Sign-in expired", "That sign-in took too long or was already used. Go back to Foundation and try again.");
  if (attempt.mode === "web") {
    const presented = parseCookies(req.headers.cookie)[ATTEMPT_COOKIE] ?? "";
    // only the browser that started this sign-in may finish it (spent either way: no second try)
    if (!attempt.browser_hash || !sameHash(hash(presented), attempt.browser_hash)) {
      return page(res, 400, "Sign-in didn't finish", "This sign-in was started in a different browser. Start again from Foundation.");
    }
  }
  if (!/^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(token)) {
    finishDesktop(attempt, { error: "Flowform didn't return a session" });
    return page(res, 400, "Sign-in didn't finish", "Flowform didn't return a session. Go back to Foundation and try again.");
  }
  let user: UserInfo;
  try {
    const me = await verifyWithFlowform(token);
    user = admitFlowformUser(me);
    // kept for downloading their Flowform files (encrypted; flowformfiles.ts)
    keepSession(user.id, me.user_id, token);
  } catch (e) {
    void revokeAtFlowform(token);
    const msg = (e as Error).message;
    finishDesktop(attempt, { error: msg });
    return page(res, e instanceof HttpError ? e.status : 500, "Sign-in didn't finish", msg);
  }
  if (attempt.mode === "desktop") {
    finishDesktop(attempt, { userId: user.id });
    return page(res, 200, "You're signed in", "You can return to Foundation and close this tab.");
  }
  const headers: Record<string, string | string[]> = {
    location: attempt.return_to,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  setSessionCookie(res, createSession(user.id));
  const cookies = ([] as string[]).concat(res.getHeader("set-cookie") as string | string[]);
  cookies.push(`${ATTEMPT_COOKIE}=; Path=/auth/flowform; HttpOnly; SameSite=Lax; Max-Age=0`);
  headers["set-cookie"] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function finishDesktop(attempt: Attempt, result: { userId: string } | { error: string }) {
  // kept under its poll until the window collects it
  if (attempt.mode !== "desktop") return;
  run(
    "update flowform_attempts set result_user_id = ?, result_error = ? where nonce_hash = ?",
    "userId" in result ? result.userId : null,
    "error" in result ? result.error : null,
    attempt.nonce_hash,
  );
}

/**
 * desktop: the window asks whether the browser finished; on success it gets its session cookie,
 * or, if it asked for one (`?bearer=1`: its server is another site), an app session in the body
 */
export function poll(req: Req, res: ServerResponse) {
  const bearer = req.query?.get("bearer") === "1";
  sweep();
  const presented = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!presented) throw new HttpError(404, "no such sign-in (expired?)");
  const pollHash = hash(presented);
  const now = attemptClock.now();
  // a finished attempt is collected once: read and deleted in one statement
  const finished = one<Pick<Attempt, "result_user_id" | "result_error">>(
    `delete from flowform_attempts where poll_hash = ? and mode = 'desktop' and expires_at > ?
       and (result_user_id is not null or result_error is not null) returning result_user_id, result_error`,
    pollHash,
    now,
  );
  if (!finished) {
    const open = one<{ used_at: number | null }>("select used_at from flowform_attempts where poll_hash = ? and mode = 'desktop' and expires_at > ?", pollHash, now);
    if (!open) throw new HttpError(404, "no such sign-in (expired?)");
    // flowform came back but no answer was recorded: the server stopped while asking flowform (its calls time out in seconds)
    if (open.used_at !== null && now - open.used_at > STALLED_AFTER) {
      run("delete from flowform_attempts where poll_hash = ?", pollHash);
      return { status: "error", error: "Sign-in was interrupted. Try again." };
    }
    return { status: "pending" };
  }
  if (!finished.result_user_id) return { status: "error", error: finished.result_error ?? "Sign-in didn't finish" };
  const user = one<UserInfo>("select id, email, name, color, role from users where id = ?", finished.result_user_id);
  if (!user) throw new HttpError(500, "user vanished");
  return { status: "ok", user, ...signIn(res, user.id, bearer) };
}

function page(res: ServerResponse, status: number, title: string, body: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · Foundation</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ec;color:#201e19;font:15px/1.5 "Hanken Grotesk",system-ui,sans-serif}
@media (prefers-color-scheme:dark){body{background:#0a111f;color:#e6ecf7}}main{max-width:420px;padding:32px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 8px}p{opacity:.75;margin:0}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(html);
}

/** every column that holds a Foundation user id (boards store names, not ids) */
const USER_COLUMNS: Array<[table: string, column: string]> = [
  ["sessions", "user_id"],
  ["files", "uploaded_by"],
  ["apps", "created_by"],
  ["asks", "created_by"],
  ["agent_runs", "created_by"],
  ["jobs", "created_by"],
  ["huddle_lines", "user_id"],
];

/**
 * One person, two Foundation users (say a dev-login address and the address
 * flowform signs them in with): fold `other` into `keep`. keep's email stays;
 * its sessions, files, runs and asks now include other's, it takes other's
 * flowform link (so Google via flowform signs in as keep), stays admin if
 * either was, and other is removed. An admin's call, from the command line:
 * `npm run link-accounts -- <keep email> <other email>`.
 */
export function linkAccounts(keepEmail: string, otherEmail: string) {
  type U = { id: string; email: string; role: string; flowform_user_id: string | null };
  const find = (e: string) => one<U>("select id, email, role, flowform_user_id from users where email = ?", e.toLowerCase().trim());
  const keep = find(keepEmail);
  const other = find(otherEmail);
  if (!keep) throw new Error(`no Foundation user ${keepEmail}`);
  if (!other) throw new Error(`no Foundation user ${otherEmail}`);
  if (keep.id === other.id) throw new Error("that's the same user");
  if (keep.flowform_user_id && other.flowform_user_id && keep.flowform_user_id !== other.flowform_user_id) {
    throw new Error("both are linked to different Flowform accounts");
  }
  const tables = new Set(all<{ name: string }>("select name from sqlite_master where type = 'table'").map((t) => t.name));
  const moved: Record<string, number> = {};
  db.exec("begin");
  try {
    for (const [table, column] of USER_COLUMNS) {
      if (!tables.has(table)) continue;
      const n = Number(run(`update ${table} set ${column} = ? where ${column} = ?`, keep.id, other.id).changes);
      if (n) moved[`${table}.${column}`] = n;
    }
    const ff = keep.flowform_user_id ?? other.flowform_user_id;
    run("delete from users where id = ?", other.id); // frees the flowform link for keep
    run("update users set flowform_user_id = ?, role = ? where id = ?", ff, keep.role === "admin" || other.role === "admin" ? "admin" : keep.role, keep.id);
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
  return { kept: keep.email, removed: other.email, moved };
}

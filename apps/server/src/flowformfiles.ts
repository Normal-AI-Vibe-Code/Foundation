/**
 * Flowform's files, as bytes: a person's Flowform session, kept for downloads only.
 *
 * Josh, 2026-11-11, choosing between a new Flowform tool and this: "Keep
 * Flowform session". It reverses the 2026-11-02 rule that Foundation never keeps
 * another service's bearer, for this one purpose. Flowform's read-only link
 * (flowformlink.ts) brings rooms and file search but never a file: its tools
 * return no URLs, and Flowform's download route takes only its own session.
 *
 * Where the session comes from: Flowform's own sign-in (flowform.ts). Signing in
 * to Foundation through Flowform keeps it; someone already signed in grants it
 * once with **Allow file downloads** (Settings → Services), which runs the same
 * sign-in and only keeps the session, for the Foundation person whose Flowform
 * account it is (a session for anyone else is refused and revoked).
 *
 * How it's kept: encrypted at rest with the link's key (AES-256-GCM,
 * `data/secret.key`), never in a URL or a response, used for one route,
 * `GET /me/files/:file/revisions/:rev/url`, whose answer is a short-lived address
 * the bytes are fetched from. Disconnecting Flowform revokes it at Flowform and
 * forgets it; a session Flowform no longer takes is forgotten, and says so.
 */

import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { db, one, run } from "./db.ts";
import { HttpError } from "./http.ts";
import { seal, unseal } from "./flowformlink.ts";

db.exec(`
  create table if not exists flowform_sessions (
    user_id text primary key, token text not null, flowform_user_id text not null, kept_at integer not null
  );
  create table if not exists flowform_file_grants (
    nonce_hash text primary key, user_id text not null, created_at integer not null, expires_at integer not null
  );
`);

const base = () => config.flowformUrl.replace(/\/$/, "");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const GRANT_MS = 10 * 60_000;
/** the most one file may be (as the places' bring) */
export const MAX_FILE = 512 * 1024 * 1024;

// ---------- keeping and dropping ----------

async function revoke(token: string) {
  try {
    await fetch(`${base()}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  } catch {
    /* it expires on its own */
  }
}

/** keep this person's Flowform session (encrypted); one per person, the one it replaces is revoked */
export function keepSession(userId: string, flowformUserId: string, token: string) {
  const old = one<{ token: string }>("select token from flowform_sessions where user_id = ?", userId);
  run(
    "insert or replace into flowform_sessions (user_id, token, flowform_user_id, kept_at) values (?, ?, ?, ?)",
    userId, seal(token), flowformUserId, Date.now(),
  );
  if (old) {
    const was = unseal(old.token);
    if (was !== token) void revoke(was);
  }
}

/** forget it here and end it at Flowform */
export async function dropSession(userId: string) {
  const row = one<{ token: string }>("select token from flowform_sessions where user_id = ?", userId);
  if (!row) return;
  run("delete from flowform_sessions where user_id = ?", userId);
  await revoke(unseal(row.token));
}

export function downloadsStatus(userId: string): { downloads: boolean; since?: number } {
  const row = one<{ kept_at: number }>("select kept_at from flowform_sessions where user_id = ?", userId);
  return row ? { downloads: true, since: row.kept_at } : { downloads: false };
}

export const canDownload = (userId: string) => Boolean(one("select 1 from flowform_sessions where user_id = ?", userId));

// ---------- granting it while signed in ----------

/** the address of Flowform's sign-in that, coming back, only keeps the session for this person */
export function beginGrant(userId: string, origin: string): { url: string } {
  run("delete from flowform_file_grants where expires_at <= ?", Date.now());
  const nonce = randomBytes(32).toString("base64url");
  run("insert into flowform_file_grants (nonce_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)", hash(nonce), userId, Date.now(), Date.now() + GRANT_MS);
  const cb = `${origin}/auth/flowform/done/${nonce}`;
  return { url: `${base()}/auth/google/start?cb=${encodeURIComponent(cb)}` };
}

/** Flowform came back to a grant (not a sign-in): spent once. Who it was for, or undefined if it isn't one. */
export function takeGrant(nonce: string): { userId: string } | undefined {
  const row = one<{ user_id: string }>("delete from flowform_file_grants where nonce_hash = ? and expires_at > ? returning user_id", hash(nonce), Date.now());
  return row ? { userId: row.user_id } : undefined;
}

/** a grant came back: keep the session only if it's this person's own Flowform account */
export async function finishGrant(userId: string, me: { user_id: string }, token: string): Promise<void> {
  const mine = one<{ flowform_user_id: string | null }>("select flowform_user_id from users where id = ?", userId)?.flowform_user_id;
  if (!mine || mine !== me.user_id) {
    await revoke(token);
    throw new HttpError(403, mine ? "That's a different Flowform account from the one you sign in to Foundation with, so nothing was kept." : "Sign in to Foundation through Flowform once first, so Foundation knows which Flowform account is yours.");
  }
  keepSession(userId, me.user_id, token);
}

// ---------- the bytes ----------

const sessionOf = (userId: string) => {
  const row = one<{ token: string }>("select token from flowform_sessions where user_id = ?", userId);
  if (!row) throw new HttpError(409, "Flowform file downloads aren't allowed for you yet. Allow them in Settings → Services.");
  return unseal(row.token);
};

/**
 * The rendition asked for. Flowform's download route requires `role`; asked on 2026-11-11 it knows `source`,
 * `display`, `playback` and `thumbnail` ("unsupported asset role", 400, for anything else), and answers 404
 * "file rendition not available" for one a file lacks (an older upload had no `source`, only `display`).
 * The original is wanted: `source`, else `playback` (a video's), else `display`. `thumbnail` never.
 */
const ROLES = ["source", "playback", "display"];
/** roles Flowform said it doesn't know (400): not asked again */
const unknownRoles = new Set<string>();

export interface FlowformFile {
  body: Buffer;
  mime: string;
  /** the file's own name, when the download says it (Content-Disposition) */
  name?: string;
}

/** a filename from a Content-Disposition header (filename* first), without any path */
export function dispositionName(h: string | null): string | undefined {
  if (!h) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h);
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(h);
  let name = star ? decodeURIComponent(star[1].trim()) : plain?.[1].trim();
  name = name?.split(/[\\/]/).pop()?.trim();
  return name || undefined;
}

/** one file revision's bytes, as this person (null when Flowform doesn't have it, or it's too big) */
export async function fileBytes(userId: string, fileId: string, revisionId: string, roles: string[] = ROLES, max = MAX_FILE): Promise<FlowformFile | null> {
  if (!/^[\w.-]{1,128}$/.test(fileId) || !/^[\w.-]{1,160}$/.test(revisionId)) throw new HttpError(400, "not a Flowform file id");
  const token = sessionOf(userId);
  let url: string | null = null;
  for (const role of roles.filter((r) => !unknownRoles.has(r))) {
    let res: Response;
    try {
      res = await fetch(`${base()}/me/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}/url?role=${role}`, {
        // Flowform's file routes refuse clients older than its minimum (426); the version is config.flowformClientVersion
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-flowform-client-version": config.flowformClientVersion },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(502, "Flowform can't be reached from here");
    }
    if (res.status === 401) {
      run("delete from flowform_sessions where user_id = ?", userId);
      throw new HttpError(409, "Flowform ended the session Foundation downloads with. Allow file downloads again in Settings → Services.");
    }
    if (res.status === 426) {
      const said = (await res.text().catch(() => "")).slice(0, 160);
      throw new HttpError(502, `Flowform wants a newer client for files (${said || "426"}). Set FLOWFORM_CLIENT_VERSION to the version it asks for.`);
    }
    if (res.status === 403) return null; // not theirs to read
    if (res.status === 404) continue; // this file has no such rendition (or no such file): the next
    if (res.status === 400 || res.status === 422) {
      unknownRoles.add(role); // a rendition Flowform doesn't know: the next, and never again
      continue;
    }
    if (!res.ok) throw new HttpError(502, `Flowform answered ${res.status} for a file`);
    const j = (await res.json().catch(() => ({}))) as { url?: string };
    if (!j.url) continue;
    url = j.url;
    break;
  }
  if (!url) return null;
  const obj = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) }).catch(() => null);
  if (!obj?.ok) return null;
  const size = Number(obj.headers.get("content-length") ?? 0);
  if (size > max) return null;
  const body = Buffer.from(await obj.arrayBuffer());
  if (body.length > max) return null;
  return { body, mime: (obj.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim(), name: dispositionName(obj.headers.get("content-disposition")) };
}

// ---------- small pictures ----------

/** the most a thumbnail may be: it's a picture for a list, not the file */
const MAX_THUMB = 4 * 1024 * 1024;
const THUMBS_KEPT = 400;
/** thumbnails already fetched, per person (one person's never answers another's request); oldest out first */
const thumbs = new Map<string, FlowformFile | null>();

/**
 * Flowform's own small picture of a file (its `thumbnail` rendition, else `display`), as this person.
 * Null when Flowform has none, or it isn't a picture. Kept in memory so a list scrolled twice asks once.
 */
export async function fileThumb(userId: string, fileId: string, revisionId: string): Promise<FlowformFile | null> {
  const k = `${userId}
${fileId}
${revisionId}`;
  if (thumbs.has(k)) return thumbs.get(k) ?? null;
  const got = await fileBytes(userId, fileId, revisionId, ["thumbnail", "display"], MAX_THUMB);
  const pic = got && got.mime.startsWith("image/") ? got : null;
  thumbs.set(k, pic);
  if (thumbs.size > THUMBS_KEPT) thumbs.delete(thumbs.keys().next().value!);
  return pic;
}

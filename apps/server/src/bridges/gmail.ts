/**
 * Google Workspace mail through the Gmail API. A person connects their own mailbox with its own consent
 * ("Connect mail": gmail.readonly to read, gmail.send to reply; the company's sign-in keeps asking only for
 * who you are). Which mail comes in is bounded: threads carrying a label the person picks (default
 * "Foundation"), never the whole inbox. Each such thread is a portal (name: its subject, origin: the
 * thread id, account: the mailbox), each correspondent a ghost; what the mailbox itself sent (from Gmail,
 * on the phone) shows as the mailbox's owner.
 *
 *  - Sync: `users.history.list` from a stored historyId, on a poll (GMAIL_POLL_SECONDS, default 60). With
 *    GMAIL_PUBSUB_TOPIC set, `users.watch` asks Gmail to push to /api/chat/hooks/gmail too (its Google-signed
 *    token is checked); a push only makes the sync run sooner.
 *  - A new message in a thread that is already a portal comes in whether or not it carries the label.
 *  - Words from the text/plain part (else the html, stripped), the quoted reply trimmed; attachments archived.
 *  - Replies: an RFC 2822 message with In-Reply-To, References and the thread id, from the mailbox, to
 *    whoever the thread's last message came from (its Reply-To first).
 *  - Tokens are kept sealed (AES-256-GCM, data/secret.key), never sent to a client or logged.
 */

import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";
import type { UserInfo } from "@foundation/protocol";
import { config } from "../config.ts";
import { all, db, one, run } from "../db.ts";
import { HttpError, readJson, type Req, type Router } from "../http.ts";
import { requirePerson, requireUser } from "../auth.ts";
import { channelByOrigin } from "../chat.ts";
import { seal, unseal } from "../flowformlink.ts";
import { apiBase, env, fetchJson, needsOf, overrideHost, scrub } from "./common.ts";
import type { AdapterStatus, BridgeAdapter, BridgeContext, InboundEvent, InboundFile, InboundMessage, OutboundFile, Portal } from "./types.ts";

db.exec(`
create table if not exists chat_gmail_accounts (
  email text primary key,
  user_id text not null,
  secret text not null,
  label text not null default 'Foundation',
  label_id text,
  history_id text,
  connected_at integer not null,
  last_sync_at integer,
  last_error text,
  watch_until integer
);
`);

const SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const api = () => apiBase("GMAIL_API_BASE", "https://gmail.googleapis.com");
const oauthBase = () => apiBase("GOOGLE_OAUTH_BASE", "https://oauth2.googleapis.com");
const accountsBase = () => apiBase("GOOGLE_ACCOUNTS_BASE", "https://accounts.google.com");
const clientId = () => env("GMAIL_CLIENT_ID") || env("GOOGLE_CLIENT_ID");
const clientSecret = () => env("GMAIL_CLIENT_SECRET") || env("GOOGLE_CLIENT_SECRET");
const redirectUri = () => `${(env("FOUNDATION_PUBLIC_URL") || config.publicUrl).replace(/\/$/, "")}/api/chat/bridges/gmail/callback`;
const defaultLabel = () => env("GMAIL_LABEL") || "Foundation";

interface AccountRow {
  email: string;
  user_id: string;
  secret: string;
  label: string;
  label_id: string | null;
  history_id: string | null;
  connected_at: number;
  last_sync_at: number | null;
  last_error: string | null;
  watch_until: number | null;
}
interface Secret {
  refresh: string;
  access?: string;
  expiresAt?: number;
}

const accounts = () => all<AccountRow>("select * from chat_gmail_accounts order by connected_at");
const accountRow = (email: string) => one<AccountRow>("select * from chat_gmail_accounts where email = ?", email.toLowerCase());

/** keep a mailbox's tokens, sealed (also how tests connect one without Google's consent page) */
export function saveGmailAccount(a: { email: string; userId: string; refresh: string; access?: string; expiresAt?: number; label?: string; historyId?: string | null }) {
  const secret = seal(JSON.stringify({ refresh: a.refresh, access: a.access, expiresAt: a.expiresAt } satisfies Secret));
  run(
    `insert into chat_gmail_accounts (email, user_id, secret, label, history_id, connected_at) values (?, ?, ?, ?, ?, ?)
     on conflict(email) do update set user_id = excluded.user_id, secret = excluded.secret, label = excluded.label, label_id = null, last_error = null`,
    a.email.toLowerCase(), a.userId, secret, a.label || defaultLabel(), a.historyId ?? null, Date.now(),
  );
}

async function accessToken(acct: AccountRow): Promise<string> {
  const s = JSON.parse(unseal(acct.secret)) as Secret;
  if (s.access && (s.expiresAt ?? 0) > Date.now() + 60_000) return s.access;
  const r = await fetchJson<{ access_token: string; expires_in?: number }>(`${oauthBase()}/token`, {
    what: "Google token",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: s.refresh, grant_type: "refresh_token" }),
  });
  const next: Secret = { refresh: s.refresh, access: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
  run("update chat_gmail_accounts set secret = ? where email = ?", seal(JSON.stringify(next)), acct.email);
  return r.access_token;
}

async function gmail<T>(acct: AccountRow, path: string, init: RequestInit = {}): Promise<T> {
  const tok = await accessToken(acct);
  return fetchJson<T>(`${api()}/gmail/v1/users/me${path}`, { ...init, what: "Gmail", headers: { authorization: `Bearer ${tok}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
}

// ---------- reading a message ----------

interface Part {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: Part;
}

/** "Ada Lovelace <ada@example.com>" → name and address; a list of them split on commas outside quotes */
export function parseAddresses(v: string | undefined): Array<{ name: string; email: string }> {
  if (!v) return [];
  const out: Array<{ name: string; email: string }> = [];
  for (const raw of v.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const s = raw.trim();
    const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
    const email = (m ? m[2] : s).trim().toLowerCase();
    if (!/@/.test(email)) continue;
    out.push({ name: (m ? m[1] : "").replace(/^"|"$/g, "").trim() || email, email });
  }
  return out;
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function decodePart(p: Part): string {
  if (!p.body?.data) return "";
  const charset = /charset="?([\w-]+)/i.exec(p.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(b64url(p.body.data));
  } catch {
    return b64url(p.body.data).toString("utf8");
  }
}

function walk(p: Part | undefined, fn: (p: Part) => void) {
  if (!p) return;
  fn(p);
  for (const c of p.parts ?? []) walk(c, fn);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** html as plain words: scripts, styles and tags gone, breaks kept, entities decoded. Nothing of it is rendered as html */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** the new words of a reply: what follows "On … wrote:" and the quoted lines at the end are dropped */
export function trimQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^On .{4,200}wrote:\s*$/.test(lines[i]) || (/^On .{4,200}$/.test(lines[i]) && /wrote:\s*$/.test(lines[i + 1] ?? "")) || /^-{2,}\s*Original Message\s*-{2,}/i.test(lines[i])) {
      end = i;
      break;
    }
  }
  const kept = lines.slice(0, end);
  while (kept.length && (/^>/.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
  return kept.join("\n").trim() || text.trim();
}

export function messageEvent(acct: Pick<AccountRow, "email" | "user_id">, m: GMessage, fetchAttachment: (attId: string) => Promise<Buffer>): InboundMessage | null {
  if (m.labelIds?.includes("DRAFT")) return null;
  const headers = new Map((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  const from = parseAddresses(headers.get("from"))[0] ?? { name: "Unknown sender", email: "unknown@unknown" };
  const self = from.email === acct.email.toLowerCase();
  let plain = "";
  let html = "";
  const files: InboundFile[] = [];
  walk(m.payload, (p) => {
    const mime = (p.mimeType ?? "").toLowerCase();
    if (p.filename) {
      const size = p.body?.size;
      if (p.body?.data) files.push({ name: p.filename, mime: mime || "application/octet-stream", size, data: b64url(p.body.data) });
      else if (p.body?.attachmentId) {
        const att = p.body.attachmentId;
        files.push({ name: p.filename, mime: mime || "application/octet-stream", size, resolve: async () => ({ data: await fetchAttachment(att) }) });
      }
      return;
    }
    if (mime === "text/plain" && !plain) plain = decodePart(p);
    else if (mime === "text/html" && !html) html = decodePart(p);
  });
  const text = trimQuoted(plain || htmlToText(html));
  const subject = headers.get("subject")?.trim() || "(no subject)";
  const messageId = headers.get("message-id") ?? "";
  const references = [headers.get("references"), messageId].filter(Boolean).join(" ").trim();
  const replyTo = self ? headers.get("to") ?? "" : headers.get("reply-to") || headers.get("from") || "";
  return {
    kind: "message",
    conversation: {
      externalId: m.threadId,
      account: acct.email,
      name: subject.slice(0, 120),
      topic: `Mail · ${acct.email}`,
      members: [acct.user_id],
      meta: { subject, lastMessageId: messageId, references, replyTo, cc: self ? headers.get("cc") ?? "" : "" },
    },
    from: self ? { handle: from.email, name: from.name, self: true, person: acct.user_id } : { handle: from.email, name: from.name },
    externalId: m.id,
    text: text || (files.length ? "" : "_(an empty message)_"),
    at: m.internalDate ? Number(m.internalDate) : undefined,
    files,
  };
}

// ---------- sync ----------

let ctx: BridgeContext | null = null;
const syncing = new Map<string, Promise<void>>();

async function findLabel(acct: AccountRow): Promise<string | null> {
  const r = await gmail<{ labels?: Array<{ id: string; name: string }> }>(acct, "/labels");
  const l = (r.labels ?? []).find((x) => x.name.toLowerCase() === acct.label.toLowerCase());
  if (l) run("update chat_gmail_accounts set label_id = ? where email = ?", l.id, acct.email);
  return l?.id ?? null;
}

async function threadEvents(acct: AccountRow, threadId: string): Promise<InboundEvent[]> {
  const t = await gmail<{ messages?: GMessage[] }>(acct, `/threads/${encodeURIComponent(threadId)}?format=full`);
  return (t.messages ?? []).map((m) => messageEvent(acct, m, (att) => attachment(acct, m.id, att))).filter((e): e is InboundMessage => Boolean(e));
}

async function attachment(acct: AccountRow, messageId: string, attId: string): Promise<Buffer> {
  const r = await gmail<{ data?: string }>(acct, `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attId)}`);
  return b64url(r.data ?? "");
}

const MAX_INITIAL = () => Math.max(1, Math.min(100, Number(env("GMAIL_INITIAL_THREADS")) || 20));

async function syncAccount(email: string): Promise<void> {
  let acct = accountRow(email);
  if (!acct || !ctx) return;
  try {
    const labelId = acct.label_id ?? (await findLabel(acct));
    if (!labelId) throw new Error(`No label named “${acct.label}” in ${acct.email}: make it in Gmail and put the threads that belong in Foundation under it.`);
    acct = accountRow(email)!;
    const events: InboundEvent[] = [];
    let historyId = acct.history_id;
    const fresh = async () => {
      // the first look (or a historyId Gmail no longer has): the newest labelled threads, then follow history from here
      const profile = await gmail<{ historyId: string }>(acct!, "/profile");
      const list = await gmail<{ threads?: Array<{ id: string }> }>(acct!, `/threads?labelIds=${encodeURIComponent(labelId)}&maxResults=${MAX_INITIAL()}`);
      for (const t of [...(list.threads ?? [])].reverse()) events.push(...(await threadEvents(acct!, t.id)));
      historyId = profile.historyId;
    };
    if (!historyId) await fresh();
    else {
      const whole = new Set<string>();
      const single: Array<{ id: string; threadId: string }> = [];
      let page: string | undefined;
      let newest = historyId;
      try {
        do {
          const q = new URLSearchParams({ startHistoryId: historyId, maxResults: "500" });
          q.append("historyTypes", "messageAdded");
          q.append("historyTypes", "labelAdded");
          if (page) q.set("pageToken", page);
          const h = await gmail<{ history?: Array<{ messagesAdded?: Array<{ message: GMessage }>; labelsAdded?: Array<{ message: GMessage; labelIds?: string[] }> }>; historyId?: string; nextPageToken?: string }>(acct, `/history?${q}`);
          for (const rec of h.history ?? []) {
            for (const la of rec.labelsAdded ?? []) if (la.labelIds?.includes(labelId)) whole.add(la.message.threadId);
            for (const ma of rec.messagesAdded ?? []) {
              const m = ma.message;
              if (m.labelIds?.includes("DRAFT")) continue;
              const known = Boolean(channelByOrigin("gmail", m.threadId, acct.email));
              if (known) single.push({ id: m.id, threadId: m.threadId });
              else if (m.labelIds?.includes(labelId)) whole.add(m.threadId);
            }
          }
          if (h.historyId) newest = h.historyId;
          page = h.nextPageToken;
        } while (page);
        historyId = newest;
      } catch (e) {
        if ((e as { status?: number }).status === 404) await fresh();
        else throw e;
      }
      for (const t of whole) events.push(...(await threadEvents(acct, t)));
      for (const s of single) {
        if (whole.has(s.threadId)) continue;
        const m = await gmail<GMessage>(acct, `/messages/${encodeURIComponent(s.id)}?format=full`);
        const ev = messageEvent(acct, m, (att) => attachment(acct!, m.id, att));
        if (ev) events.push(ev);
      }
    }
    if (events.length) await ctx.ingest(events);
    run("update chat_gmail_accounts set history_id = ?, last_sync_at = ?, last_error = null where email = ?", historyId, Date.now(), acct.email);
  } catch (e) {
    run("update chat_gmail_accounts set last_error = ?, last_sync_at = ? where email = ?", scrub((e as Error).message), Date.now(), email);
  }
  ctx.changed();
}

/** sync one mailbox now, or all of them; one run per mailbox at a time */
export function syncGmail(email?: string): Promise<void> {
  const list = email ? [email.toLowerCase()] : accounts().map((a) => a.email);
  return Promise.all(
    list.map((e) => {
      const had = syncing.get(e);
      if (had) return had;
      const p = syncAccount(e).finally(() => syncing.delete(e));
      syncing.set(e, p);
      return p;
    }),
  ).then(() => undefined);
}

async function renewWatch(acct: AccountRow) {
  const topic = env("GMAIL_PUBSUB_TOPIC");
  if (!topic || !acct.label_id || (acct.watch_until ?? 0) > Date.now() + 864e5) return;
  const r = await gmail<{ expiration?: string }>(acct, "/watch", { method: "POST", body: JSON.stringify({ topicName: topic, labelIds: [acct.label_id], labelFilterBehavior: "include" }) });
  run("update chat_gmail_accounts set watch_until = ? where email = ?", Number(r.expiration ?? Date.now() + 6 * 864e5), acct.email);
}

let timer: NodeJS.Timeout | null = null;

// ---------- Google's signed push (Pub/Sub) ----------

let certs: { keys: Array<Record<string, string>>; until: number } | null = null;
async function googleKeys() {
  if (certs && certs.until > Date.now()) return certs.keys;
  const r = await fetchJson<{ keys: Array<Record<string, string>> }>(env("GOOGLE_CERTS_URL") || "https://www.googleapis.com/oauth2/v3/certs", { what: "Google certs" });
  certs = { keys: r.keys, until: Date.now() + 3600_000 };
  return r.keys;
}

/** a Pub/Sub push's `Authorization: Bearer <Google-signed OIDC token>`: RS256 by Google, for our audience, not expired */
async function verifyPush(req: Req): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) throw new HttpError(401, "no push token");
  const header = JSON.parse(b64url(h).toString("utf8")) as { kid?: string; alg?: string };
  const claims = JSON.parse(b64url(p).toString("utf8")) as { aud?: string; iss?: string; exp?: number; email?: string; email_verified?: boolean };
  if (header.alg !== "RS256") throw new HttpError(401, "bad push token");
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "bad push token");
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: jwk as never, format: "jwk" }), b64url(s));
  const audience = env("GMAIL_PUSH_AUDIENCE") || `${(env("FOUNDATION_PUBLIC_URL") || config.publicUrl).replace(/\/$/, "")}/api/chat/hooks/gmail`;
  const sa = env("GMAIL_PUSH_SERVICE_ACCOUNT");
  if (!ok || claims.aud !== audience || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "") || (claims.exp ?? 0) * 1000 < Date.now() || (sa && claims.email !== sa)) throw new HttpError(401, "bad push token");
}

// ---------- consent ----------

const pending = new Map<string, { userId: string; label: string; verifier: string; at: number }>();

function landing(ok: boolean, message: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>Foundation · Mail</title><body style="font:15px system-ui;margin:3em;max-width:36em"><h2>${ok ? "Mail connected" : "Mail didn't connect"}</h2><p>${esc(message)}</p><p>You can close this tab and go back to ChatForm's Inbox.</p></body>`;
}

// ---------- sending ----------

const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const cleanHeader = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** an RFC 2822 message (multipart when it carries files), as Gmail's `raw` wants it */
export function buildMail(m: { from: string; to: string; cc?: string; subject: string; text: string; inReplyTo?: string; references?: string; messageId: string; files?: OutboundFile[] }): string {
  const head = [
    `From: ${cleanHeader(m.from)}`,
    `To: ${cleanHeader(m.to)}`,
    ...(m.cc ? [`Cc: ${cleanHeader(m.cc)}`] : []),
    `Subject: ${encodeHeader(cleanHeader(m.subject))}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${cleanHeader(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${cleanHeader(m.references)}`] : []),
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(m.text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n")];
  let mime: string[];
  if (!m.files?.length) mime = [...head, ...textPart];
  else {
    const b = `fdn_${randomBytes(12).toString("hex")}`;
    mime = [...head, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, ...textPart];
    for (const f of m.files) {
      const name = f.name.replace(/["\r\n]/g, "_");
      mime.push(`--${b}`, `Content-Type: ${f.mime}; name="${encodeHeader(name)}"`, `Content-Disposition: attachment; filename="${encodeHeader(name)}"`, "Content-Transfer-Encoding: base64", "", f.body.toString("base64").replace(/.{76}/g, "$&\r\n"));
    }
    mime.push(`--${b}--`);
  }
  return Buffer.from(mime.join("\r\n"), "utf8").toString("base64url");
}

const newMessageId = (email: string) => `<fdn.${randomBytes(10).toString("hex")}@${email.split("@")[1] ?? "foundation.local"}>`;

function accountFor(portal: Portal): AccountRow {
  const acct = accountRow(portal.account ?? "");
  if (!acct) throw new Error(`The mailbox ${portal.account ?? ""} isn't connected any more: connect it again in the Inbox.`);
  return acct;
}

export const gmailAdapter: BridgeAdapter = {
  service: "gmail",
  name: "Mail",

  status(): AdapterStatus {
    const needs = needsOf([
      ["GMAIL_CLIENT_ID", "A Google OAuth client id (or the sign-in's GOOGLE_CLIENT_ID)", Boolean(clientId())],
      ["GMAIL_CLIENT_SECRET", "Its secret (or GOOGLE_CLIENT_SECRET)", Boolean(clientSecret())],
      ["GMAIL_LABEL", `Optional: the label whose threads come in (now “${defaultLabel()}”)`],
      ["GMAIL_PUBSUB_TOPIC", "Optional: a Pub/Sub topic for push instead of only polling"],
    ]);
    const list = accounts();
    const steps = [
      "In Google Cloud Console, in the project that holds Foundation's sign-in client (or a new one), enable the Gmail API.",
      "OAuth consent screen: add the scopes gmail.readonly and gmail.send (internal app for the Workspace, so no Google review is needed).",
      `Credentials: on the OAuth client, add the redirect URI ${redirectUri()}. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (or reuse GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET) and restart.`,
      `In Gmail, make a label called “${defaultLabel()}”. Only threads under it come into ChatForm.`,
      "Press Connect mail here and approve on Google's page. Each person connects their own mailbox.",
    ];
    if (!clientId() || !clientSecret()) return { state: "needs-setup", detail: "Needs a Google OAuth client for mail (GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET, or the sign-in's).", needs, canSend: false, steps };
    if (!list.length) return { state: "needs-setup", detail: `Ready to connect: press Connect mail. Only threads labelled “${defaultLabel()}” will come in, never the whole inbox.`, needs, canSend: false, steps: steps.slice(3) };
    const bad = list.filter((a) => a.last_error);
    const labels = [...new Set(list.map((a) => `“${a.label}”`))].join(" or ");
    if (bad.length) return { state: "error", detail: `${bad[0].email}: ${bad[0].last_error}`, needs, canSend: true };
    return { state: "live", detail: `Watching ${list.length === 1 ? list[0].email : `${list.length} mailboxes`}: threads labelled ${labels} come in as conversations; the rest of the inbox stays out.`, needs, canSend: true };
  },

  async receive(req, raw) {
    if (!env("GMAIL_PUBSUB_TOPIC")) throw new HttpError(404, "push isn't set up (GMAIL_PUBSUB_TOPIC)");
    await verifyPush(req);
    let email = "";
    try {
      const body = JSON.parse(raw.toString("utf8")) as { message?: { data?: string } };
      email = (JSON.parse(Buffer.from(body.message?.data ?? "", "base64").toString("utf8")) as { emailAddress?: string }).emailAddress ?? "";
    } catch {
      /* a push we can't read only means: look */
    }
    if (email && accountRow(email)) void syncGmail(email);
    return { events: [] };
  },

  async check() {
    if (!clientId() || !clientSecret()) return { ok: false, said: `Still missing: ${[!clientId() && "the client id", !clientSecret() && "the client secret"].filter(Boolean).join(" and ")}.` };
    return { ok: true, said: `Both are set. Google checks them the first time someone presses Connect your Gmail: its page opens, or names what's wrong. The redirect URI it must list is ${redirectUri()}.` };
  },

  async send(portal, out) {
    const acct = accountFor(portal);
    const meta = portal.meta as { subject?: string; lastMessageId?: string; references?: string; replyTo?: string; cc?: string };
    const to = parseAddresses(meta.replyTo).filter((a) => a.email !== acct.email);
    if (!to.length) throw new Error("There's no one to reply to in this thread yet.");
    const subject = meta.subject ? (/^re:/i.test(meta.subject) ? meta.subject : `Re: ${meta.subject}`) : "Re:";
    const messageId = newMessageId(acct.email);
    const raw = buildMail({ from: acct.email, to: to.map((a) => (a.name && a.name !== a.email ? `"${a.name.replace(/"/g, "")}" <${a.email}>` : a.email)).join(", "), cc: meta.cc || undefined, subject, text: out.text, inReplyTo: meta.lastMessageId || undefined, references: meta.references || undefined, messageId, files: out.files });
    const r = await gmail<{ id: string; threadId: string }>(acct, "/messages/send", { method: "POST", body: JSON.stringify({ raw, threadId: portal.externalId }) });
    return { externalId: r.id, meta: { lastMessageId: messageId, references: [meta.references, messageId].filter(Boolean).join(" ") } };
  },

  async startConversation(by: UserInfo, body) {
    const mine = accounts().filter((a) => a.user_id === by.id);
    const want = typeof body.account === "string" ? body.account.toLowerCase() : "";
    const acct = (want ? mine.find((a) => a.email === want) : mine[0]) ?? null;
    if (!acct) throw new HttpError(400, "Connect your own mailbox first: mail goes out from the person who writes it.");
    const to = parseAddresses(typeof body.to === "string" ? body.to : "");
    const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 200) : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!to.length) throw new HttpError(400, "to: one or more addresses");
    if (!subject) throw new HttpError(400, "a subject");
    if (!text) throw new HttpError(400, "say something");
    const messageId = newMessageId(acct.email);
    const raw = buildMail({ from: acct.email, to: to.map((a) => a.email).join(", "), subject, text, messageId });
    const r = await gmail<{ id: string; threadId: string }>(acct, "/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
    return {
      conversation: { externalId: r.threadId, account: acct.email, name: subject, topic: `Mail · ${acct.email}`, members: [acct.user_id], meta: { subject, lastMessageId: messageId, references: messageId, replyTo: to.map((a) => a.email).join(", "), cc: "" } },
      externalId: r.id,
      text,
    };
  },

  start(c) {
    ctx = c;
    if (timer) return;
    const every = Math.max(15, Number(env("GMAIL_POLL_SECONDS")) || 60) * 1000;
    timer = setInterval(() => {
      if (!clientId() || !clientSecret()) return;
      void syncGmail().then(() => Promise.all(accounts().map((a) => renewWatch(a).catch((e) => run("update chat_gmail_accounts set last_error = ? where email = ?", scrub((e as Error).message), a.email)))));
    }, every);
    timer.unref();
  },

  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },

  mediaHosts: () => ["gmail.googleapis.com", ...overrideHost("GMAIL_API_BASE")],

  routes(r: Router, c: BridgeContext) {
    ctx = c;
    // a person connects their own mailbox: Google's consent page, then back here
    r.post("/api/chat/bridges/gmail/connect", async (req) => {
      const user = requirePerson(req, "Connecting a mailbox");
      if (!clientId() || !clientSecret()) throw new HttpError(503, "Mail isn't set up on this server yet (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)");
      const body = await readJson<{ label?: string }>(req);
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 100) : defaultLabel();
      const state = randomBytes(16).toString("hex");
      const verifier = randomBytes(32).toString("base64url");
      for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
      pending.set(state, { userId: user.id, label, verifier, at: Date.now() });
      const q = new URLSearchParams({
        client_id: clientId(),
        redirect_uri: redirectUri(),
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        login_hint: user.email,
      });
      return { url: `${accountsBase()}/o/oauth2/v2/auth?${q}` };
    });

    r.get("/api/chat/bridges/gmail/callback", async (req, res) => {
      const send = (ok: boolean, msg: string) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(landing(ok, msg));
      };
      const state = req.query.get("state") ?? "";
      const p = pending.get(state);
      pending.delete(state);
      if (!p || Date.now() - p.at > 15 * 60_000) return send(false, "This link expired. Press Connect mail again.");
      if (req.query.get("error")) return send(false, `Google said: ${scrub(req.query.get("error") ?? "")}.`);
      try {
        const t = await fetchJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>(`${oauthBase()}/token`, {
          what: "Google",
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code: req.query.get("code") ?? "", client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: p.verifier }),
        });
        if (!t.refresh_token) return send(false, "Google didn't give Foundation lasting access. Remove Foundation at myaccount.google.com/permissions and connect again.");
        if (t.scope && !(t.scope.includes("gmail.readonly") && t.scope.includes("gmail.send"))) return send(false, "Both permissions are needed: reading (only the labelled threads come in) and sending your replies.");
        const profile = await fetchJson<{ emailAddress: string }>(`${api()}/gmail/v1/users/me/profile`, { what: "Gmail", headers: { authorization: `Bearer ${t.access_token}` } });
        saveGmailAccount({ email: profile.emailAddress, userId: p.userId, refresh: t.refresh_token, access: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, label: p.label });
        c.changed();
        void syncGmail(profile.emailAddress);
        return send(true, `${profile.emailAddress} is connected. Threads labelled “${p.label}” come into ChatForm; nothing else in the mailbox does.`);
      } catch (e) {
        return send(false, scrub((e as Error).message));
      }
    });

    // disconnect: the mailbox's owner, or an admin; Google is asked to forget the grant too
    r.post("/api/chat/bridges/gmail/disconnect", async (req) => {
      const user = requirePerson(req, "Disconnecting a mailbox");
      const body = await readJson<{ email?: string; confirm?: boolean }>(req);
      const acct = accountRow(String(body.email ?? ""));
      if (!acct) throw new HttpError(404, "no such mailbox");
      if (acct.user_id !== user.id && user.role !== "admin") throw new HttpError(403, "only its owner or an admin disconnects a mailbox");
      if (body.confirm !== true) throw new HttpError(400, "disconnecting needs confirm: true");
      try {
        const s = JSON.parse(unseal(acct.secret)) as Secret;
        await fetch(`${oauthBase()}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: s.refresh }), signal: AbortSignal.timeout(8000) });
      } catch {
        /* forgotten here either way */
      }
      run("delete from chat_gmail_accounts where email = ?", acct.email);
      c.changed();
      return { ok: true };
    });

    r.post("/api/chat/bridges/gmail/sync", async (req) => {
      requireUser(req);
      await syncGmail();
      return { ok: true };
    });
  },

  demo(): InboundEvent[] {
    const id = `demo${Date.now().toString(36)}`;
    const conversation = { externalId: `${id}-thread`, account: "demo", name: "Quote for 40 aluminium brackets (demo)", topic: "", meta: { subject: "Quote for 40 aluminium brackets", replyTo: "sam@example.com" } };
    const from = { handle: "sam@example.com", name: "Sam Okafor (demo)" };
    const now = Date.now();
    return [
      { kind: "message", conversation, from, externalId: `${id}-1`, at: now - 3600_000, text: "Hello,\n\nCould you quote 40 of the B-40 brackets in 6061, anodised black? Drawing attached.\n\nThanks,\nSam", files: [{ name: "B-40-drawing.txt", mime: "text/plain", data: Buffer.from("B-40 bracket\nMaterial: 6061-T6\nQty: 40\n") }] },
      { kind: "message", conversation, from, externalId: `${id}-2`, at: now - 600_000, text: "One more thing: we'd need them by the 28th." },
    ];
  },
};

/** for the Inbox: the mailboxes connected (address, owner, label, last sync), never their tokens */
export function gmailAccounts() {
  return accounts().map((a) => ({ email: a.email, userId: a.user_id, label: a.label, labelFound: Boolean(a.label_id), lastSyncAt: a.last_sync_at, connectedAt: a.connected_at, error: a.last_error }));
}

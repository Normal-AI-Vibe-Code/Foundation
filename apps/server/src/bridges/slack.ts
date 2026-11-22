/**
 * ChatForm's live Slack bridge (docs/chatform.md; Josh: "build a bridge between them so that slack messages
 * show up here and vice versa to help the transition to foundation").
 *
 * Unlike the other bridges (portals onto someone else's conversation), a Slack channel is linked to an
 * ordinary ChatForm channel, the one the history import made or would make (`origin {slack, <channel id>}`),
 * and both stay in step while the company moves across.
 *
 *  - **Linking is per channel, explicit, and an admin's, in person.** Nothing is bridged until someone links
 *    it; a link can be paused or removed, and removing it never deletes a message. Direct messages and group
 *    DMs are never bridged: Slack doesn't let an app post into them for people.
 *  - **In.** Slack says a channel changed (the Slack app's Socket Mode process forwards the event's type and
 *    channel, never its text: slacklive.ts `onSlackEvent`), or the poll comes round (every
 *    FOUNDATION_SLACK_BRIDGE_POLL_MS, 10 s while the app is away, 60 s while it's there; Retry-After obeyed).
 *    The channel's latest page is read through the API and reconciled: new messages are mirrored through the
 *    importer's own mapping (people by email, else ghosts; mrkdwn; files into the archive; threads; reactions)
 *    with the importer's origins (`<channel id>:<ts>`), so import and live never double; an edit in Slack
 *    edits the copy; a message deleted in Slack is removed here (the row stays); reactions follow.
 *  - **Out.** A person's message in a linked channel goes to Slack as they post it (`chat.postMessage` as
 *    "Name via Foundation", thread replies in the thread, files uploaded with files.uploadV2's three steps
 *    when the app has files:write, else a line naming the file) and shows sending → sent or failed with Try
 *    again. What was sent is recorded (`chat_bridge_sent`) and tagged (`metadata.event_payload.source =
 *    "chatform"`), so its echo is never mirrored back and two servers on one channel can't ping-pong. Its
 *    author's edit or removal here is carried to Slack (the bot may change its own posts). An agent's
 *    message in a linked channel is a draft until a person sends it.
 *  - Slack's refusals are said plainly: the app isn't in the channel (with Join for a public one), a private
 *    channel needs /invite, a missing scope names the scope.
 *
 * SLACK_API_BASE points it at a stand-in (tests, e2e). Every call goes through the egress gate.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { slackEmoji, slackTsMs, type ChatBridgeStatus, type ChatChannel, type ChatChannelKind, type ChatMessage, type ChatParty, type UserInfo } from "@foundation/protocol";
import { all, db, one, run } from "../db.ts";
import { HttpError, readJson, type Router } from "../http.ts";
import { requirePerson, requireUser } from "../auth.ts";
import { audit } from "../audit.ts";
import { guardEgress } from "../egressguard.ts";
import * as chat from "../chat.ts";
import { fileBytesSync } from "../files.ts";
import { Importer, emptyReport, type SlackConversation, type SlackMessage, type SlackUser } from "../chatimport.ts";
import { forgetSlackStatus, slackBotToken, slackTokenSource } from "../slack.ts";
import { bridgeLive, onSlackEvent } from "../slacklive.ts";
import { secretStates, setSecret } from "../bridgesecrets.ts";

db.exec(`
create table if not exists chat_slack_links (
  channel_id text primary key,
  slack_id text not null unique,
  slack_name text not null,
  private integer not null default 0,
  state text not null default 'live',
  linked_by text not null,
  linked_by_name text not null,
  linked_at integer not null,
  last_ts text,
  threads_json text not null default '{}',
  last_read_at integer,
  last_in_at integer,
  last_out_at integer,
  next_read_at integer,
  last_error text,
  error_code text
);
create table if not exists chat_bridge_sent (
  service text not null,
  external_id text not null,
  message_id text not null,
  primary key (service, external_id)
);
create table if not exists chat_slack_out (
  message_id text primary key,
  slack_id text not null,
  ts text not null,
  text text not null,
  deleted integer not null default 0
);
create table if not exists chat_slack_out_files (
  file_id text primary key,
  message_id text not null
);
create table if not exists chat_slack_reactions (
  message_id text not null,
  emoji text not null,
  party_kind text not null,
  party_id text not null,
  primary key (message_id, emoji, party_kind, party_id)
);
create table if not exists chat_slack_requests (
  user_id text not null,
  request_id text not null,
  result text not null,
  at integer not null,
  primary key (user_id, request_id)
);
create table if not exists person_prefs (
  user_id text not null,
  key text not null,
  value text not null,
  updated_at integer not null,
  primary key (user_id, key)
);
`);

/** what the bridge needs the Slack app to have (docs/slack-app-manifest.yml); files:write is optional (files go as a line without it) */
export const SLACK_SCOPES = ["channels:read", "groups:read", "channels:history", "groups:history", "channels:join", "chat:write", "chat:write.customize", "users:read", "users:read.email", "files:read", "reactions:read"];
export const SLACK_OPTIONAL_SCOPES = ["files:write"];
export const SLACK_EVENTS = ["message.channels", "message.groups", "reaction_added", "reaction_removed"];

const MAX_FILE = () => Math.max(1, Number(process.env.FOUNDATION_BRIDGE_MAX_FILE_MB) || 25) * 1024 * 1024;

interface LinkRow {
  channel_id: string;
  slack_id: string;
  slack_name: string;
  private: number;
  state: "live" | "paused";
  linked_by: string;
  linked_by_name: string;
  linked_at: number;
  last_ts: string | null;
  threads_json: string;
  last_read_at: number | null;
  last_in_at: number | null;
  last_out_at: number | null;
  next_read_at: number | null;
  last_error: string | null;
  error_code: string | null;
}

const linkOf = (channelId: string) => one<LinkRow>("select * from chat_slack_links where channel_id = ?", channelId);
const linkBySlack = (slackId: string) => one<LinkRow>("select * from chat_slack_links where slack_id = ?", slackId);
const links = () => all<LinkRow>("select * from chat_slack_links order by slack_name");
/** is this ChatForm channel bridged to Slack right now (linked and not paused) */
export const slackLinked = (channelId: string) => linkOf(channelId)?.state === "live";

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowTs = () => (Date.now() / 1000).toFixed(6);

// ---------- Slack's Web API ----------

export class SlackBridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfter = 0,
  ) {
    super(message);
  }
}

/** Slack's codes in words a person can act on */
export function slackWords(code: string, channel?: string): string {
  const where = channel ? ` #${channel}` : " this channel";
  switch (code) {
    case "not_in_channel":
      return `The Foundation app isn't in${where}. Press Join (a public channel), or type /invite @Foundation in the channel in Slack.`;
    case "channel_not_found":
      return `Slack can't find${where} for the app: if it's private, type /invite @Foundation in it in Slack first.`;
    case "is_archived":
      return `${channel ? `#${channel}` : "The channel"} is archived in Slack.`;
    case "missing_scope":
      return "The Slack app is missing a permission (scope). Update it from the manifest in the Slack guide and reinstall it.";
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "account_inactive":
      return "Slack refused the bot token. Paste a fresh one in the Slack guide.";
    case "not_configured":
      return "No Slack bot token on this server yet: an admin pastes one in the Slack guide.";
    case "ratelimited":
      return "Slack asked us to slow down; it carries on after the wait Slack named.";
    case "restricted_action":
      return "The workspace's settings don't let the app post here.";
    case "msg_too_long":
      return "Slack says the message is too long.";
    default:
      return `Slack said ${code}.`;
  }
}

const apiBase = () => (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");

/** one Web API call: GET with a query, or POST with JSON. A refusal is a SlackBridgeError with Slack's code; 429 carries Retry-After */
async function slackCall<T>(method: string, params: Record<string, unknown> = {}, post = false): Promise<{ body: T; headers: Headers }> {
  const tok = slackBotToken();
  if (!tok) throw new SlackBridgeError("not_configured", slackWords("not_configured"));
  guardEgress("Slack");
  let url = `${apiBase()}/${method}`;
  const init: RequestInit = { method: post ? "POST" : "GET", headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(15_000) };
  if (post) {
    (init.headers as Record<string, string>)["content-type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(params);
  } else {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]): [string, string] => [k, String(v)]));
    url += `?${q}`;
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new SlackBridgeError("unreachable", `Couldn't reach Slack (${(e as Error).message.replace(/xox\w-[\w-]+/g, "…")}).`);
  }
  if (res.status === 429) {
    const wait = Math.max(1, Math.min(600, Number(res.headers.get("retry-after")) || 30));
    await res.body?.cancel();
    throw new SlackBridgeError("ratelimited", `Slack asked us to wait ${wait} s.`, wait);
  }
  const body = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string; needed?: string } & T;
  if (!body.ok) {
    const code = body.error ?? "unknown_error";
    throw new SlackBridgeError(code, code === "missing_scope" && body.needed ? `${slackWords(code)} It needs ${body.needed}.` : slackWords(code));
  }
  return { body, headers: res.headers };
}

/** a call that waits out one short rate limit (≤ 10 s) and tries again; a longer one is said */
async function slackPatient<T>(method: string, params: Record<string, unknown> = {}, post = false): Promise<T> {
  try {
    return (await slackCall<T>(method, params, post)).body;
  } catch (e) {
    if (!(e instanceof SlackBridgeError) || e.code !== "ratelimited" || e.retryAfter > 10) throw e;
    await sleep(e.retryAfter * 1000);
    return (await slackCall<T>(method, params, post)).body;
  }
}

// ---------- who the app is ----------

interface AppInfo {
  ok: boolean;
  team?: string;
  url?: string;
  bot?: string;
  botId?: string;
  scopes: string[] | null;
  checkedAt: number;
  error?: string;
  code?: string;
}
let app: AppInfo | null = null;

/** auth.test, with the scopes Slack names in its header. Asked when a person presses Check, and once a while otherwise */
export async function checkApp(force = false): Promise<AppInfo> {
  if (!force && app && Date.now() - app.checkedAt < 10 * 60_000) return app;
  try {
    const { body, headers } = await slackCall<{ team?: string; url?: string; user?: string; bot_id?: string }>("auth.test");
    const sc = headers.get("x-oauth-scopes");
    app = { ok: true, team: body.team, url: body.url, bot: body.user, botId: body.bot_id, scopes: sc ? sc.split(",").map((s) => s.trim()).filter(Boolean) : null, checkedAt: Date.now() };
  } catch (e) {
    const err = e as SlackBridgeError;
    app = { ok: false, scopes: null, checkedAt: Date.now(), error: err.message, code: err.code };
  }
  forgetSlackStatus();
  changed();
  return app;
}
const canUpload = () => Boolean(app?.scopes?.includes("files:write"));

// ---------- people ----------

const users = new Map<string, { u: SlackUser; at: number }>();
async function ensureUsers(ids: Iterable<string>) {
  for (const id of new Set(ids)) {
    if (!id || !/^[UW][A-Z0-9]+$/.test(id)) continue;
    const hit = users.get(id);
    if (hit && Date.now() - hit.at < 3600_000) continue;
    try {
      const r = await slackPatient<{ user: SlackUser }>("users.info", { user: id });
      users.set(id, { u: { ...r.user, id }, at: Date.now() });
    } catch (e) {
      if (e instanceof SlackBridgeError && e.code === "ratelimited") throw e;
      users.set(id, { u: { id }, at: Date.now() });
    }
  }
}

function idsIn(m: SlackMessage): string[] {
  const out = [m.user ?? "", m.edited?.user ?? ""];
  for (const x of (m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)) out.push(x[1]);
  for (const r of m.reactions ?? []) out.push(...(r.users ?? []));
  return out.filter(Boolean);
}

// ---------- in: reading a channel ----------

const publishBridge = () => chat.publish({ t: "bridge", bridge: slackStatusLine() }, "all");
let changeTimer: ReturnType<typeof setTimeout> | null = null;
function changed() {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    publishBridge();
  }, 50);
  changeTimer.unref?.();
}

const reading = new Map<string, Promise<void>>();
let backoffUntil = 0;

/** read a linked channel now (one read per channel at a time; a second ask while one runs waits for it) */
export function readLinked(channelId: string, opts: { backfill?: number } = {}): Promise<void> {
  const going = reading.get(channelId);
  if (going) return going;
  const p = doRead(channelId, opts).finally(() => reading.delete(channelId));
  reading.set(channelId, p);
  return later(p);
}

interface Known {
  id: string;
  text: string;
  root_id: string | null;
  deleted_at: number | null;
  origin_id: string;
}

async function doRead(channelId: string, opts: { backfill?: number }) {
  const link = linkOf(channelId);
  if (!link) return;
  const ch = chat.getChannel(channelId);
  if (!ch) return;
  if (Date.now() < backoffUntil) return;
  const silent = Boolean(opts.backfill);
  try {
    // the newest page; more pages back to where we read up to (or the backfill's depth)
    const msgs: SlackMessage[] = [];
    let cursor: string | undefined;
    const depth = opts.backfill ?? 0;
    for (let page = 0; page < 10; page++) {
      // a read never sits out a rate limit: it stops, and the next one waits until Slack said (backoffUntil)
      const r = (await slackCall<{ messages: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>("conversations.history", { channel: link.slack_id, limit: 100, include_all_metadata: true, cursor })).body;
      msgs.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
      if (depth ? msgs.length >= depth : !link.last_ts || msgs.some((m) => Number(m.ts) <= Number(link.last_ts))) break;
    }
    msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
    const since = depth ? null : link.last_ts;
    const threads = parse<Record<string, string>>(link.threads_json, {});
    const conv: SlackConversation = { id: link.slack_id, kind: (ch.kind === "private" ? "private" : "open") as ChatChannelKind, name: link.slack_name, members: [], topic: "", purpose: "", pins: new Set() };

    const replies: SlackMessage[] = [];
    for (const m of msgs) {
      if (!m.reply_count || (m.thread_ts && m.thread_ts !== m.ts)) continue;
      const latest = (m as SlackMessage & { latest_reply?: string }).latest_reply ?? "";
      if (latest && threads[m.ts] === latest) continue;
      // replies of a thread that started before the link (and wasn't imported) still come: the root is looked for, else they stand in the channel
      const r = (await slackCall<{ messages: SlackMessage[] }>("conversations.replies", { channel: link.slack_id, ts: m.ts, limit: 200, include_all_metadata: true })).body;
      for (const x of r.messages ?? []) if (x.ts !== m.ts) replies.push(x);
      if (latest) threads[m.ts] = latest;
    }
    await ensureUsers([...msgs, ...replies].flatMap(idsIn));

    const imp = new Importer(emptyReport("api", false, "Slack, live"), { dryRun: false, files: true, maxFileBytes: MAX_FILE(), token: slackBotToken() }, () => {}, { state: "running", channel: "", done: 0, total: 0, messages: 0, files: 0, skipped: [] });
    imp.loadUsers([...users.values()].map((x) => x.u));
    imp.convNames.set(link.slack_id, link.slack_name);

    const known = new Map<string, Known>();
    for (const r of all<Known>("select id, text, root_id, deleted_at, origin_id from chat_messages where channel_id = ? and origin_service = 'slack'", channelId)) known.set(r.origin_id, r);
    const ours = new Set(all<{ external_id: string }>("select external_id from chat_bridge_sent where service = 'slack' and external_id like ?", `${link.slack_id}:%`).map((r) => r.external_id));
    const ourFiles = new Set(all<{ file_id: string }>("select file_id from chat_slack_out_files").map((r) => r.file_id));
    let newest = link.last_ts ?? "0";
    let came = 0;

    const fromUs = (m: SlackMessage) => {
      const payload = (m.metadata as { event_payload?: { source?: string } } | undefined)?.event_payload;
      if (ours.has(`${link.slack_id}:${m.ts}`) || payload?.source === "chatform") return true;
      // our own file uploads come back as the bot's file_share messages
      return Boolean(m.files?.length && m.files.every((f) => f.id && ourFiles.has(f.id)));
    };

    const handle = async (m: SlackMessage) => {
      if (Number(m.ts) > Number(newest)) newest = m.ts;
      if (fromUs(m)) return;
      const ext = `${link.slack_id}:${m.ts}`;
      const had = known.get(ext);
      if (had) {
        if (had.deleted_at) return;
        // an edit in Slack
        if (m.edited?.ts) {
          const p = imp.prepare(m, conv, [], []);
          // the words follow; files stay as they came
          if (!("skip" in p) && p.type === "text" && p.text.trim() && p.text !== had.text) {
            chat.updateMessage(had.id, { text: p.text }, { edited: true });
            had.text = p.text;
          }
        }
        await reactions(had.id, m, imp);
        return;
      }
      if (since && Number(m.ts) <= Number(since)) return; // before the link: history is the importer's
      const f = m.files?.length ? await imp.files(m, `#${link.slack_name}`) : { ids: [], lines: [] };
      const p = imp.prepare(m, conv, f.lines, f.ids);
      if ("skip" in p) return;
      let root: string | null = null;
      if (p.threadTs) {
        const rootExt = `${link.slack_id}:${p.threadTs}`;
        root = known.get(rootExt)?.id ?? one<{ message_id: string }>("select message_id from chat_bridge_sent where service = 'slack' and external_id = ?", rootExt)?.message_id ?? null;
        if (root && chat.getMessage(root)?.channel !== channelId) root = null;
      }
      const msg = chat.postMessage(channelId, p.author, { text: p.text, files: p.files, root, type: p.type, origin: { service: "slack", externalId: ext }, createdAt: p.createdAt, editedAt: p.editedAt, pinned: p.pinned }, { silent });
      known.set(ext, { id: msg.id, text: msg.text, root_id: msg.root, deleted_at: null, origin_id: ext });
      came++;
      await reactions(msg.id, m, imp);
    };

    for (const m of msgs) await handle(m);
    for (const m of replies.sort((a, b) => Number(a.ts) - Number(b.ts))) await handle(m);

    // deleted in Slack: what was mirrored, at the top level, inside the page just read and no longer in it
    if (msgs.length) {
      const lo = Number(msgs[0].ts);
      const hi = Number(msgs[msgs.length - 1].ts);
      const present = new Set(msgs.map((m) => `${link.slack_id}:${m.ts}`));
      for (const k of known.values()) {
        if (k.root_id || k.deleted_at || present.has(k.origin_id)) continue;
        const ts = Number(k.origin_id.slice(link.slack_id.length + 1));
        if (ts >= lo && ts <= hi) chat.removeMessage(k.id);
      }
    }

    run(
      "update chat_slack_links set last_ts = ?, threads_json = ?, last_read_at = ?, last_in_at = case when ? > 0 then ? else last_in_at end, last_error = null, error_code = null where channel_id = ?",
      newest === "0" ? link.last_ts : newest, JSON.stringify(trimThreads(threads)), Date.now(), came, Date.now(), channelId,
    );
  } catch (e) {
    const err = e instanceof SlackBridgeError ? e : new SlackBridgeError("error", (e as Error).message);
    if (err.code === "ratelimited") backoffUntil = Date.now() + err.retryAfter * 1000;
    run("update chat_slack_links set last_error = ?, error_code = ?, last_read_at = ? where channel_id = ?", err.code === "not_in_channel" || err.code === "channel_not_found" ? slackWords(err.code, link.slack_name) : err.message, err.code, Date.now(), channelId);
  }
  changed();
}

/** keep the newest few hundred threads' marks */
function trimThreads(t: Record<string, string>) {
  const keys = Object.keys(t).sort((a, b) => Number(b) - Number(a));
  return Object.fromEntries(keys.slice(0, 300).map((k) => [k, t[k]]));
}

/** a mirrored message's reactions follow Slack's: added and taken away, only the ones that came from Slack */
async function reactions(messageId: string, m: SlackMessage, imp: Importer) {
  const want = new Map<string, { party: ChatParty; emoji: string }>();
  for (const r of m.reactions ?? []) {
    const emoji = slackEmoji(r.name);
    for (const uid of r.users ?? []) {
      const party = imp.party(uid);
      want.set(`${emoji}|${party.kind}|${party.id}`, { party, emoji });
    }
  }
  const had = all<{ emoji: string; party_kind: string; party_id: string }>("select emoji, party_kind, party_id from chat_slack_reactions where message_id = ?", messageId);
  const haveKeys = new Set(had.map((h) => `${h.emoji}|${h.party_kind}|${h.party_id}`));
  const msg = chat.getMessage(messageId);
  if (!msg || msg.deletedAt) return;
  for (const [k, w] of want) {
    if (haveKeys.has(k)) continue;
    chat.react(messageId, w.party, w.emoji, true);
    run("insert or ignore into chat_slack_reactions (message_id, emoji, party_kind, party_id) values (?, ?, ?, ?)", messageId, w.emoji, w.party.kind, w.party.id);
  }
  for (const h of had) {
    const k = `${h.emoji}|${h.party_kind}|${h.party_id}`;
    if (want.has(k)) continue;
    chat.react(messageId, { kind: h.party_kind as ChatParty["kind"], id: h.party_id, name: "" }, h.emoji, false);
    run("delete from chat_slack_reactions where message_id = ? and emoji = ? and party_kind = ? and party_id = ?", messageId, h.emoji, h.party_kind, h.party_id);
  }
}

// ---------- events and the poll ----------

const eventMs = () => Math.max(0, Number(process.env.FOUNDATION_SLACK_BRIDGE_EVENT_MS ?? 400));
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Slack said something happened in a channel: read it shortly (events in a burst make one read) */
export function slackEventFor(slackChannel: string) {
  const link = linkBySlack(slackChannel);
  if (!link || link.state !== "live") return;
  const had = pending.get(link.channel_id);
  if (had) clearTimeout(had);
  const t = setTimeout(() => {
    pending.delete(link.channel_id);
    void readLinked(link.channel_id).catch(() => undefined);
  }, eventMs());
  t.unref?.();
  pending.set(link.channel_id, t);
}

onSlackEvent((ev) => {
  if (ev.type !== "message" && ev.type !== "reaction_added" && ev.type !== "reaction_removed") return;
  const channel = typeof ev.channel === "string" ? ev.channel : ev.channel?.id;
  if (channel) slackEventFor(channel);
});

/** how often a linked channel is read without an event: 60 s while the Slack app forwards events, else 10 s (or the env's) */
export function pollMs(): number {
  const set = Number(process.env.FOUNDATION_SLACK_BRIDGE_POLL_MS);
  if (Number.isFinite(set) && set > 0) return bridgeLive() ? Math.max(set, 60_000) : set;
  return bridgeLive() ? 60_000 : 10_000;
}

let ticker: ReturnType<typeof setInterval> | null = null;
export async function pollOnce() {
  if (!slackBotToken() || Date.now() < backoffUntil) return;
  for (const l of links()) {
    if (l.state !== "live" || (l.last_read_at ?? 0) + pollMs() > Date.now() + 50) continue;
    await readLinked(l.channel_id).catch(() => undefined);
    if (Date.now() < backoffUntil) return;
  }
}
export function startSlackBridge() {
  if (ticker) return;
  const every = Math.min(5000, Math.max(250, Math.floor(pollMs() / 2)));
  ticker = setInterval(() => void pollOnce(), every);
  ticker.unref?.();
}
export function stopSlackBridge() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

// ---------- out ----------

/** markdown here → Slack's mrkdwn: **bold**, ~~strike~~, [label](url), and @handles of people Slack knows */
export function toMrkdwn(md: string): string {
  const handles = new Map(
    all<{ external_id: string; name: string; user_id: string | null }>("select external_id, name, user_id from chat_import_people where service = 'slack' and is_bot = 0").map((r) => {
      const u = r.user_id ? one<{ name: string }>("select name from users where id = ?", r.user_id) : undefined;
      return [(u?.name ?? r.name).trim().toLowerCase().replace(/\s+/g, ".").replace(/[^\p{L}\p{N}._-]/gu, ""), r.external_id] as const;
    }),
  );
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => `<${u}|${t.replace(/[|]/g, " ")}>`)
    .replace(/(^|[\s(])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,63})/gu, (all, pre: string, h: string) => {
      const id = handles.get(h.toLowerCase().replace(/[.]+$/, ""));
      return id ? `${pre}<@${id}>` : h === "channel" || h === "here" ? `${pre}<!${h}>` : all;
    });
}

const work = new Set<Promise<unknown>>();
function later<T>(p: Promise<T>): Promise<T> {
  work.add(p);
  void p.catch(() => undefined).finally(() => work.delete(p));
  return p;
}
/** resolves once nothing the Slack bridge started is still running (tests, the test message) */
export async function slackIdle() {
  while (work.size) await Promise.allSettled([...work]);
}

const inflight = new Set<string>();

/** where in Slack a reply goes: its thread's first message's ts there, if that message is in Slack */
function threadTsOf(m: ChatMessage, slackId: string): string | undefined {
  if (!m.root) return undefined;
  const root = chat.getMessage(m.root);
  if (root?.origin?.service === "slack" && root.origin.externalId.startsWith(`${slackId}:`)) return root.origin.externalId.slice(slackId.length + 1);
  return one<{ ts: string }>("select ts from chat_slack_out where message_id = ? and slack_id = ?", m.root, slackId)?.ts;
}

async function uploadFiles(m: ChatMessage, slackId: string, threadTs: string | undefined, by: string): Promise<string[]> {
  const ids: string[] = [];
  const done: Array<{ id: string; title: string }> = [];
  for (const f of m.files) {
    const got = fileBytesSync(f.id);
    if (!got) throw new SlackBridgeError("file_gone", `${f.name} isn't in the archive any more.`);
    const up = await slackPatient<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", { filename: f.name, length: got.body.length });
    guardEgress("Slack");
    const res = await fetch(up.upload_url, { method: "POST", headers: { "content-type": f.mime || "application/octet-stream" }, body: new Uint8Array(got.body), signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new SlackBridgeError("upload_failed", `Slack didn't take ${f.name} (${res.status}).`);
    await res.body?.cancel();
    done.push({ id: up.file_id, title: f.name });
    ids.push(up.file_id);
    run("insert or ignore into chat_slack_out_files (file_id, message_id) values (?, ?)", up.file_id, m.id);
  }
  if (done.length) await slackPatient("files.completeUploadExternal", { files: done, channel_id: slackId, ...(threadTs ? { thread_ts: threadTs } : {}), initial_comment: `${by} via Foundation shared ${done.length === 1 ? "a file" : `${done.length} files`}` }, true);
  return ids;
}

/** send a person's message (or a draft a person sent) to Slack, marking it sending → sent or failed; idempotent per message */
export async function deliverSlack(messageId: string, by: string): Promise<void> {
  if (inflight.has(messageId)) return;
  inflight.add(messageId);
  const fail = (why: string) => {
    const m = chat.getMessage(messageId);
    if (m) chat.updateMessage(messageId, { outbound: { state: "failed", by, at: Date.now(), error: why } });
  };
  try {
    const m = chat.getMessage(messageId);
    if (!m || m.deletedAt) return;
    const link = linkOf(m.channel);
    if (!link) return fail("This channel isn't linked to Slack any more.");
    if (link.state !== "live") return fail(`The link to Slack's #${link.slack_name} is paused.`);
    // sent already (a retry after an answer that was lost): it's marked, not sent twice
    if (one("select 1 from chat_slack_out where message_id = ?", messageId)) {
      chat.updateMessage(messageId, { outbound: { state: "sent", by, at: Date.now() } });
      return;
    }
    chat.updateMessage(messageId, { outbound: { state: "sending", by, at: Date.now() } });
    const threadTs = threadTsOf(m, link.slack_id);
    if (!app) await checkApp();
    const upload = m.files.length > 0 && canUpload();
    const lines = m.files.length && !upload ? m.files.map((f) => `📎 ${f.name} (in Foundation)`) : [];
    const text = [toMrkdwn(m.text.trim()), ...lines].filter(Boolean).join("\n").slice(0, 39_000);
    let ts: string | undefined;
    if (text) {
      const r = await slackPatient<{ ts: string }>(
        "chat.postMessage",
        {
          channel: link.slack_id,
          text,
          username: `${by} via Foundation`,
          unfurl_links: false,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          metadata: { event_type: "foundation_post", event_payload: { by, source: "chatform", message: m.id } },
        },
        true,
      );
      ts = r.ts;
      run("insert or ignore into chat_bridge_sent (service, external_id, message_id) values ('slack', ?, ?)", `${link.slack_id}:${ts}`, messageId);
      run("insert or replace into chat_slack_out (message_id, slack_id, ts, text, deleted) values (?, ?, ?, ?, 0)", messageId, link.slack_id, ts, m.text);
    }
    if (upload) await uploadFiles(m, link.slack_id, threadTs ?? ts, by);
    if (!ts && !upload) return fail("Nothing to send.");
    run("update chat_slack_links set last_out_at = ? where channel_id = ?", Date.now(), m.channel);
    chat.updateMessage(messageId, { outbound: { state: "sent", by, at: Date.now() } });
    changed();
  } catch (e) {
    const err = e as SlackBridgeError;
    const link = chat.getMessage(messageId) ? linkOf(chat.getMessage(messageId)!.channel) : undefined;
    fail(err.code === "not_in_channel" || err.code === "channel_not_found" ? slackWords(err.code, link?.slack_name) : err.message || "it failed");
    if (link && (err.code === "not_in_channel" || err.code === "channel_not_found")) run("update chat_slack_links set last_error = ?, error_code = ? where channel_id = ?", slackWords(err.code, link.slack_name), err.code, link.channel_id);
    changed();
  } finally {
    inflight.delete(messageId);
  }
}

// the rule, in the post itself: in a linked channel a person's words go out; an agent's are a draft a person sends
chat.beforeChatPost((ctx, m) => {
  if (ctx.service !== "slack" || ctx.silent || m.origin || (ctx.kind !== "open" && ctx.kind !== "private")) return;
  if (m.type && m.type !== "text" && m.type !== "draft") return;
  if (!slackLinked(ctx.channel)) return;
  if (ctx.author.kind === "agent") return { ...m, type: "draft", outbound: { state: "draft", by: ctx.author.name, at: Date.now() } };
  if (ctx.author.kind === "person") return { ...m, type: "text", outbound: { state: "sending", by: ctx.author.name, at: Date.now() } };
  return undefined;
});

chat.onChatMessage((m, ch) => {
  if (ch.origin?.service !== "slack" || m.author.kind !== "person" || m.origin || m.outbound?.state !== "sending") return;
  void later(deliverSlack(m.id, m.author.name));
});

// its author's edit or removal of a message that went out is carried to Slack (the bot may change its own posts)
chat.onPublish((ev) => {
  if (ev.t !== "message-changed") return;
  const out = one<{ slack_id: string; ts: string; text: string; deleted: number }>("select slack_id, ts, text, deleted from chat_slack_out where message_id = ?", ev.message.id);
  if (!out || out.deleted) return;
  const m = ev.message;
  if (m.deletedAt) {
    run("update chat_slack_out set deleted = 1 where message_id = ?", m.id);
    void later(slackPatient("chat.delete", { channel: out.slack_id, ts: out.ts }, true).catch((e) => console.error(`slack bridge: couldn't remove ${out.ts} in Slack: ${(e as Error).message}`)));
  } else if (m.text !== out.text && m.text.trim()) {
    run("update chat_slack_out set text = ? where message_id = ?", m.text, m.id);
    void later(slackPatient("chat.update", { channel: out.slack_id, ts: out.ts, text: toMrkdwn(m.text) }, true).catch((e) => console.error(`slack bridge: couldn't edit ${out.ts} in Slack: ${(e as Error).message}`)));
  }
});

// ---------- linking ----------

interface SlackChannelInfo {
  id: string;
  name: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

/** the ChatForm channel a Slack channel lands in: the one that has its origin, else an open one of the same name with none (merged), else a new one (named -slack if the name is taken): the importer's rule */
function landingFor(sc: SlackChannelInfo, by: UserInfo): { channel: ChatChannel; how: "had" | "merged" | "made" } {
  const had = chat.channelByOrigin("slack", sc.id);
  if (had) return { channel: had, how: "had" };
  const slug = sc.name.trim().toLowerCase().replace(/^#/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || sc.id.toLowerCase();
  const same = one<{ id: string; kind: string; origin_service: string | null }>("select id, kind, origin_service from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null order by created_at limit 1", slug);
  if (!sc.is_private && same && same.kind === "open" && !same.origin_service) {
    run("update chat_channels set origin_service = 'slack', origin_id = ? where id = ?", sc.id, same.id);
    return { channel: chat.getChannel(same.id)!, how: "merged" };
  }
  let name = slug;
  if (same) {
    name = `${slug}-slack`.slice(0, 80);
    for (let i = 2; one("select 1 from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null", name); i++) name = `${slug}-slack-${i}`.slice(0, 80);
  }
  const channel = chat.createChannel(chat.personParty(by), { kind: sc.is_private ? "private" : "open", name, topic: sc.topic?.value ?? "", purpose: sc.purpose?.value ?? "", origin: { service: "slack", externalId: sc.id } });
  return { channel, how: "made" };
}

function remembered(userId: string, requestId: unknown): string | null {
  if (typeof requestId !== "string" || !requestId) return null;
  return one<{ result: string }>("select result from chat_slack_requests where user_id = ? and request_id = ?", userId, requestId.slice(0, 120))?.result ?? null;
}
function remember(userId: string, requestId: unknown, result: string) {
  if (typeof requestId === "string" && requestId) run("insert or ignore into chat_slack_requests (user_id, request_id, result, at) values (?, ?, ?, ?)", userId, requestId.slice(0, 120), result, Date.now());
}

const did = (user: UserInfo, action: string, target: string) => audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "http", action, target, service: "Slack", provenance: "external", decision: "allowed", result: "ok" });

function requireAdmin(user: UserInfo, what: string) {
  if (user.role !== "admin") throw new HttpError(403, `Only an admin ${what}.`);
}

const asHttp = (e: unknown): never => {
  if (e instanceof HttpError) throw e;
  if (e instanceof SlackBridgeError) throw new HttpError(e.code === "not_configured" ? 409 : e.code === "ratelimited" ? 429 : 502, e.message);
  throw e;
};

/** link a Slack channel to a ChatForm channel (the one named, or the importer's landing for it) */
export async function linkChannel(user: UserInfo, body: { slackId?: unknown; channel?: unknown; backfill?: unknown }): Promise<{ link: LinkView; how: string }> {
  const slackId = typeof body.slackId === "string" ? body.slackId.trim() : "";
  if (!/^[CG][A-Z0-9]{4,30}$/.test(slackId)) throw new HttpError(400, slackId.startsWith("D") ? "Direct messages aren't bridged: Slack doesn't let an app post into them for people." : "slackId: a Slack channel id (C… or G…)");
  let sc: SlackChannelInfo;
  try {
    sc = (await slackPatient<{ channel: SlackChannelInfo }>("conversations.info", { channel: slackId })).channel;
  } catch (e) {
    if (e instanceof SlackBridgeError && (e.code === "channel_not_found" || e.code === "not_in_channel")) throw new HttpError(409, slackWords(e.code));
    return asHttp(e);
  }
  if (sc.is_im || sc.is_mpim) throw new HttpError(400, "Direct messages and group DMs aren't bridged: Slack doesn't let an app post into them for people.");
  if (sc.is_archived) throw new HttpError(409, slackWords("is_archived", sc.name));
  const already = linkBySlack(slackId);
  let channel: ChatChannel;
  let how = "had";
  if (typeof body.channel === "string" && body.channel) {
    const c = chat.getChannel(body.channel);
    if (!c || !chat.canSeeChannel(user, c)) throw new HttpError(404, "no such channel");
    if (c.kind !== "open" && c.kind !== "private") throw new HttpError(400, "Only a channel is linked to Slack (never a direct message, a group, an agent or a portal).");
    if (c.origin && !(c.origin.service === "slack" && c.origin.externalId === slackId)) throw new HttpError(409, c.origin.service === "slack" ? "That channel came from another Slack channel." : "That channel already stands for something outside Foundation.");
    const other = chat.channelByOrigin("slack", slackId);
    if (other && other.id !== c.id) throw new HttpError(409, `Slack's #${sc.name} is already #${other.name} here.`);
    if (!c.origin) run("update chat_channels set origin_service = 'slack', origin_id = ? where id = ?", slackId, c.id);
    channel = chat.getChannel(c.id)!;
  } else {
    const l = landingFor(sc, user);
    channel = l.channel;
    how = l.how;
  }
  if (already && already.channel_id !== channel.id) throw new HttpError(409, `Slack's #${sc.name} is already linked.`);
  if (!chat.canSeeChannel(user, channel)) chat.addMember(channel.id, chat.personParty(user), { silent: true });
  if (!already) {
    run(
      "insert into chat_slack_links (channel_id, slack_id, slack_name, private, state, linked_by, linked_by_name, linked_at, last_ts) values (?, ?, ?, ?, 'live', ?, ?, ?, ?)",
      channel.id, slackId, sc.name, sc.is_private ? 1 : 0, user.id, user.name, Date.now(), nowTs(),
    );
  } else run("update chat_slack_links set state = 'live', slack_name = ? where channel_id = ?", sc.name, channel.id);
  chat.publish({ t: "channel", channel: chat.getChannel(channel.id)! }, { channel: channel.id });
  did(user, "slack.link", slackId);
  const depth = body.backfill === true ? 200 : typeof body.backfill === "number" ? Math.max(1, Math.min(1000, body.backfill)) : 0;
  if (depth) await readLinked(channel.id, { backfill: depth });
  changed();
  return { link: viewOf(linkOf(channel.id)!, user), how };
}

// ---------- what the Inbox and the guide read ----------

export interface LinkView {
  channel: string;
  name: string;
  kind: string;
  slackId: string;
  slackName: string;
  private: boolean;
  state: "live" | "paused";
  linkedBy: string;
  linkedAt: number;
  lastReadAt: number | null;
  lastInAt: number | null;
  lastOutAt: number | null;
  error?: string;
  errorCode?: string;
}

function viewOf(l: LinkRow, user: UserInfo): LinkView {
  const c = chat.getChannel(l.channel_id);
  const see = c ? chat.canSeeChannel(user, c) : false;
  return {
    channel: l.channel_id,
    name: c && see ? c.name : "a private channel",
    kind: c?.kind ?? "open",
    slackId: l.slack_id,
    slackName: see || !l.private ? l.slack_name : "private",
    private: Boolean(l.private),
    state: l.state,
    linkedBy: l.linked_by_name,
    linkedAt: l.linked_at,
    lastReadAt: l.last_read_at,
    lastInAt: l.last_in_at,
    lastOutAt: l.last_out_at,
    ...(l.last_error ? { error: l.last_error } : {}),
    ...(l.error_code ? { errorCode: l.error_code } : {}),
  };
}

/** the Slack bridge in the Inbox's one line (and the socket's `{t:"bridge"}`) */
export function slackStatusLine(): ChatBridgeStatus {
  const ls = links();
  const live = ls.filter((l) => l.state === "live");
  const broken = live.find((l) => l.last_error);
  const tok = slackTokenSource();
  const lastEventAt = Math.max(0, ...ls.map((l) => Math.max(l.last_in_at ?? 0, l.last_out_at ?? 0)));
  const needs = [{ key: "SLACK_BOT_TOKEN", set: Boolean(tok), what: "The Foundation Slack app's bot token (xoxb-…)" }];
  const base = { service: "slack" as const, name: "Slack", needs, canSend: Boolean(tok), portals: ls.length, ...(lastEventAt ? { lastEventAt } : {}) };
  if (!tok) return { ...base, state: "needs-setup", detail: "Not connected: the Slack app's bot token isn't set. The Slack guide walks an admin through it." };
  if (app && !app.ok) return { ...base, state: "error", detail: app.error ?? "Slack refused the bot token." };
  if (broken) return { ...base, state: "error", detail: `#${broken.slack_name}: ${broken.last_error}` };
  if (!live.length) return { ...base, state: "needs-setup", detail: ls.length ? "Every link is paused: nothing comes in or goes out." : `Connected${app?.team ? ` to ${app.team}` : ""}. No channel is linked yet.` };
  const mode = bridgeLive() ? "Slack's events arrive through the Slack app" : `read every ${Math.round(pollMs() / 1000)} s (the Slack app isn't forwarding events)`;
  return { ...base, state: "live", detail: `${live.length === 1 ? "1 channel" : `${live.length} channels`} in step with Slack${app?.team ? ` (${app.team})` : ""}: ${mode}.` };
}

const nudgeDismissed = (userId: string) => one<{ value: string }>("select value from person_prefs where user_id = ? and key = 'chat.slack_nudge'", userId)?.value === "hidden";

export function slackView(user: UserInfo) {
  const imported = one<{ n: number }>("select count(*) as n from chat_channels where origin_service = 'slack' and kind in ('open', 'private', 'dm', 'group')")?.n ?? 0;
  const lastImport = one<{ at: number | null }>("select max(finished_at) as at from chat_import_jobs where state = 'done' and dry_run = 0 and kind != 'upload'")?.at ?? null;
  const ls = links();
  const token = secretStates("slack")[0];
  const source = slackTokenSource();
  const scopes = app?.scopes ?? null;
  return {
    status: slackStatusLine(),
    admin: user.role === "admin",
    token: { set: Boolean(source), source, ...(token?.source === source && token.tail ? { tail: token.tail } : {}), ...(token?.setBy ? { setBy: token.setBy, setAt: token.setAt } : {}) },
    app: app ? { ok: app.ok, team: app.team ?? null, url: app.url ?? null, bot: app.bot ?? null, checkedAt: app.checkedAt, error: app.error ?? null } : null,
    scopes: { have: scopes, need: SLACK_SCOPES, optional: SLACK_OPTIONAL_SCOPES, missing: scopes ? SLACK_SCOPES.filter((s) => !scopes.includes(s)) : null, files: scopes ? (scopes.includes("files:write") ? "upload" : "line") : null },
    events: SLACK_EVENTS,
    mode: !source ? "off" : bridgeLive() ? "events" : "polling",
    pollSeconds: Math.round(pollMs() / 1000),
    links: ls.map((l) => viewOf(l, user)),
    history: { channels: imported, lastImportAt: lastImport },
    nudge: !nudgeDismissed(user.id) && !ls.length && !imported,
    nudgeDismissed: nudgeDismissed(user.id),
  };
}

// ---------- HTTP ----------

let started = false;
export function chatSlackRoutes(r: Router) {
  if (!process.env.NODE_TEST_CONTEXT && !started) {
    started = true;
    startSlackBridge();
    if (slackBotToken()) void checkApp().catch(() => undefined);
  }

  r.get("/api/chat/slack", (req) => slackView(requireUser(req)));

  // the Slack channels the app can see, each with where it lands here (an admin, setting links up)
  r.get("/api/chat/slack/channels", async (req) => {
    const user = requirePerson(req, "Listing Slack's channels");
    requireAdmin(user, "sets up the Slack bridge");
    try {
      const out: SlackChannelInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await slackPatient<{ channels: SlackChannelInfo[]; response_metadata?: { next_cursor?: string } }>("conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor });
        out.push(...(r.channels ?? []));
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      return {
        channels: out
          .filter((c) => !c.is_im && !c.is_mpim)
          .map((c) => {
            const link = linkBySlack(c.id);
            const had = chat.channelByOrigin("slack", c.id);
            const slug = c.name.toLowerCase();
            const same = had ? undefined : one<{ id: string; name: string; kind: string; origin_service: string | null }>("select id, name, kind, origin_service from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null order by created_at limit 1", slug);
            const lands = had ? { id: had.id, name: had.name, how: "imported" } : same && !c.is_private && same.kind === "open" && !same.origin_service ? { id: same.id, name: same.name, how: "merge" } : { id: null, name: same ? `${slug}-slack` : slug, how: "create" };
            return { id: c.id, name: c.name, private: Boolean(c.is_private), member: Boolean(c.is_member), members: c.num_members ?? null, topic: c.topic?.value ?? "", link: link ? viewOf(link, user) : null, lands };
          })
          .sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name)),
      };
    } catch (e) {
      return asHttp(e);
    }
  });

  // the bot token, pasted into the guide: stored sealed; Slack is asked who it is
  r.post("/api/chat/slack/token", async (req) => {
    const user = requirePerson(req, "Setting the Slack token");
    requireAdmin(user, "sets the Slack token");
    const body = await readJson<{ token?: unknown }>(req);
    setSecret(user, "SLACK_BOT_TOKEN", typeof body.token === "string" ? body.token : "");
    users.clear();
    const a = slackBotToken() ? await checkApp(true) : ((app = null), forgetSlackStatus(), changed(), null);
    return { view: slackView(user), check: a };
  });

  // Check: auth.test and its scopes, now (a person's press)
  r.post("/api/chat/slack/check", async (req) => {
    const user = requirePerson(req, "Checking the Slack app");
    requireAdmin(user, "checks the Slack app");
    const a = await checkApp(true);
    return { check: a, view: slackView(user) };
  });

  r.post("/api/chat/slack/links", async (req) => {
    const user = requirePerson(req, "Linking a channel to Slack");
    requireAdmin(user, "links a channel to Slack");
    const body = await readJson<{ slackId?: unknown; channel?: unknown; backfill?: unknown; request_id?: unknown }>(req);
    const again = remembered(user.id, body.request_id);
    if (again) {
      const l = linkOf(again);
      if (l) return { link: viewOf(l, user), how: "had", view: slackView(user) };
    }
    const out = await linkChannel(user, body);
    remember(user.id, body.request_id, out.link.channel);
    return { ...out, view: slackView(user) };
  });

  // pause or resume a link
  r.post("/api/chat/slack/links/:channel", async (req) => {
    const user = requirePerson(req, "Changing a Slack link");
    requireAdmin(user, "changes a Slack link");
    const l = linkOf(req.params.channel);
    if (!l) throw new HttpError(404, "that channel isn't linked to Slack");
    const body = await readJson<{ state?: unknown }>(req);
    if (body.state !== "live" && body.state !== "paused") throw new HttpError(400, "state: live or paused");
    // resumed: what was said in Slack while it was paused comes in (from where it was read up to)
    run("update chat_slack_links set state = ?, last_error = null, error_code = null where channel_id = ?", body.state, l.channel_id);
    did(user, body.state === "live" ? "slack.link.resume" : "slack.link.pause", l.slack_id);
    if (body.state === "live") void readLinked(l.channel_id).catch(() => undefined);
    changed();
    return { link: viewOf(linkOf(l.channel_id)!, user), view: slackView(user) };
  });

  // unlink: nothing more crosses; every message stays, and the channel still knows its Slack channel (to link again)
  r.post("/api/chat/slack/links/:channel/unlink", async (req) => {
    const user = requirePerson(req, "Unlinking a channel from Slack");
    requireAdmin(user, "unlinks a channel from Slack");
    const body = await readJson<{ confirm?: unknown }>(req);
    const l = linkOf(req.params.channel);
    if (!l) throw new HttpError(404, "that channel isn't linked to Slack");
    if (body.confirm !== true) throw new HttpError(400, "unlinking needs confirm: true");
    run("delete from chat_slack_links where channel_id = ?", l.channel_id);
    did(user, "slack.unlink", l.slack_id);
    changed();
    return { ok: true, view: slackView(user) };
  });

  // the app joins a public channel (channels:join): the channel sees it join. A person's press
  r.post("/api/chat/slack/join", async (req) => {
    const user = requirePerson(req, "Having the Slack app join a channel");
    requireAdmin(user, "has the Slack app join a channel");
    const body = await readJson<{ slackId?: unknown }>(req);
    const id = typeof body.slackId === "string" ? body.slackId : "";
    if (!/^C[A-Z0-9]{4,30}$/.test(id)) throw new HttpError(400, "Only a public channel (C…) can be joined; a private one needs /invite @Foundation in Slack.");
    try {
      await slackPatient("conversations.join", { channel: id }, true);
    } catch (e) {
      return asHttp(e);
    }
    did(user, "slack.join", id);
    const l = linkBySlack(id);
    if (l) {
      run("update chat_slack_links set last_error = null, error_code = null where channel_id = ?", l.channel_id);
      void readLinked(l.channel_id).catch(() => undefined);
    }
    changed();
    return { ok: true, view: slackView(user) };
  });

  // the live test: a person's message into a linked channel, out to Slack, and read back
  r.post("/api/chat/slack/test", async (req) => {
    const user = requirePerson(req, "Sending a test message to Slack");
    requireAdmin(user, "sends the test message");
    const body = await readJson<{ channel?: unknown; request_id?: unknown }>(req);
    const l = typeof body.channel === "string" ? linkOf(body.channel) : undefined;
    if (!l) throw new HttpError(404, "that channel isn't linked to Slack");
    if (l.state !== "live") throw new HttpError(409, "that link is paused");
    const requestId = typeof body.request_id === "string" ? body.request_id : `slack-test-${randomBytes(6).toString("hex")}`;
    const m = chat.postMessage(l.channel_id, chat.personParty(user), { text: `Test from Foundation: if you can read this in Slack's #${l.slack_name}, the bridge works. (${user.name})`, requestId });
    await slackIdle();
    const sent = one<{ ts: string }>("select ts from chat_slack_out where message_id = ?", m.id);
    let confirmed = false;
    if (sent) {
      try {
        const h = await slackPatient<{ messages: SlackMessage[] }>("conversations.history", { channel: l.slack_id, latest: sent.ts, inclusive: true, limit: 1 });
        confirmed = (h.messages ?? []).some((x) => x.ts === sent.ts);
      } catch {
        /* sent, not read back */
      }
    }
    did(user, "slack.test", l.slack_id);
    return { message: chat.getMessage(m.id), sent: Boolean(sent), confirmed };
  });

  // the Slack app's manifest, for the guide's copy button (docs/slack-app-manifest.yml; built from what the bridge needs when the file isn't beside this build)
  r.get("/api/chat/slack/manifest", (req) => {
    requireUser(req);
    let text = "";
    try {
      text = readFileSync(resolve(import.meta.dirname, "../../../../docs/slack-app-manifest.yml"), "utf8");
    } catch {
      text = [
        "display_information:",
        "  name: Foundation",
        "features:",
        "  bot_user:",
        "    display_name: Foundation",
        "oauth_config:",
        "  scopes:",
        "    bot:",
        ...[...SLACK_SCOPES, ...SLACK_OPTIONAL_SCOPES, "im:write"].map((s) => `      - ${s}`),
        "settings:",
        "  socket_mode_enabled: true",
        "  event_subscriptions:",
        "    bot_events:",
        ...[...SLACK_EVENTS, "channel_created", "channel_rename", "channel_archive", "channel_unarchive", "member_joined_channel"].map((e) => `      - ${e}`),
        "",
      ].join("\n");
    }
    return { manifest: text, scopes: SLACK_SCOPES, optional: SLACK_OPTIONAL_SCOPES, events: SLACK_EVENTS };
  });

  // the transition nudge, dismissed (or brought back) for this person
  r.post("/api/chat/slack/nudge", async (req) => {
    const user = requirePerson(req, "Hiding the Slack nudge");
    const body = await readJson<{ dismissed?: unknown }>(req);
    run(
      "insert into person_prefs (user_id, key, value, updated_at) values (?, 'chat.slack_nudge', ?, ?) on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at",
      user.id, body.dismissed === false ? "show" : "hidden", Date.now(),
    );
    return { view: slackView(user) };
  });
}

/** tests only */
export function _resetSlackBridge() {
  app = null;
  users.clear();
  backoffUntil = 0;
  stopSlackBridge();
}

/**
 * Slack channels on the board. A "slack" card shows a channel's recent
 * messages and lets the people on the board post to it, send it a link to a
 * place on the board, invite it to a huddle, and hand it a huddle's notes.
 *
 * It runs on a bot token (SLACK_BOT_TOKEN — the Foundation Slack app,
 * docs/slack-app-manifest.yml). Posts carry the person's name ("Josh via
 * Foundation") through chat:write.customize, so the channel sees who wrote.
 * Reads are polled while a card is on screen and cached here for a few
 * seconds, so ten people looking at one channel cost one Slack call.
 *
 * Search keeps using the user token (search:read) in search.ts; this module
 * never needs it. SLACK_API_BASE points the client at a stand-in (tests).
 */

import { config } from "./config.ts";

const READ_TTL = 4000;

export class SlackError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function base() {
  return (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
}

/**
 * A bot token the Slack app's own process handed over (apps/slack-agent, run
 * by `slack run`, which is given the token by the Slack CLI). Kept in memory
 * only, never stored or logged, and only used when .env has none.
 */
let lent = "";
export function lendToken(t: string) {
  if (/^xoxb-[A-Za-z0-9-]{10,}$/.test(t) && t !== lent) {
    lent = t;
    statusCache = null;
  }
}

function token() {
  return process.env.SLACK_BOT_TOKEN || lent;
}

export function slackConfigured() {
  return Boolean(token());
}

async function call<T>(method: string, params: Record<string, unknown> = {}, post = false): Promise<T> {
  if (!token()) throw new SlackError("not_configured", "Slack isn't connected — set SLACK_BOT_TOKEN (SPEC §6)");
  const headers: Record<string, string> = { authorization: `Bearer ${token()}` };
  let url = `${base()}/${method}`;
  let body: string | undefined;
  if (post) {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify(params);
  } else {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)]));
    url += `?${q}`;
  }
  const res = await fetch(url, { method: post ? "POST" : "GET", headers, body, signal: AbortSignal.timeout(8000) });
  if (res.status === 429) throw new SlackError("ratelimited", `Slack asked us to slow down (retry in ${res.headers.get("retry-after") ?? "a few"} s)`);
  const out = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!out.ok) throw new SlackError(out.error ?? "unknown_error", explain(out.error));
  return out;
}

/** Slack's error codes, in words a person can act on */
function explain(code?: string) {
  switch (code) {
    case "not_in_channel":
      return "The Foundation app isn't in this channel — /invite @Foundation in Slack";
    case "channel_not_found":
      return "No such channel (or it's private and the app wasn't invited)";
    case "missing_scope":
      return "The Slack app is missing a scope — reinstall it from docs/slack-app-manifest.yml";
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
      return "Slack rejected the bot token — check SLACK_BOT_TOKEN";
    default:
      return code;
  }
}

// ---------- status ----------

let statusCache: { at: number; value: SlackStatus } | null = null;

export interface SlackStatus {
  connected: boolean;
  team?: string;
  bot?: string;
  reason?: string;
}

export async function slackStatus(): Promise<SlackStatus> {
  if (!token()) return { connected: false, reason: "Set SLACK_BOT_TOKEN — create the app from docs/slack-app-manifest.yml (SPEC §6)" };
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  let value: SlackStatus;
  try {
    const r = await call<{ team: string; user: string }>("auth.test");
    value = { connected: true, team: r.team, bot: r.user };
  } catch (e) {
    value = { connected: false, reason: (e as Error).message };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// ---------- channels ----------

export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
  member: boolean;
  members?: number;
  topic?: string;
}

export async function listChannels(): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await call<{ channels: Array<{ id: string; name: string; is_private: boolean; is_member: boolean; num_members?: number; topic?: { value: string } }>; response_metadata?: { next_cursor?: string } }>("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const c of r.channels) out.push({ id: c.id, name: c.name, private: c.is_private, member: c.is_member, members: c.num_members, topic: c.topic?.value || undefined });
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
}

const channelCache = new Map<string, { at: number; value: SlackChannel }>();

export async function channelInfo(id: string): Promise<SlackChannel> {
  const hit = channelCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const r = await call<{ channel: { id: string; name: string; is_private: boolean; is_member: boolean; num_members?: number; topic?: { value: string } } }>("conversations.info", { channel: id });
  const c = r.channel;
  const value = { id: c.id, name: c.name, private: c.is_private, member: c.is_member, members: c.num_members, topic: c.topic?.value || undefined };
  channelCache.set(id, { at: Date.now(), value });
  return value;
}

// ---------- reading ----------

export interface SlackMessage {
  ts: string;
  at: number;
  user: string;
  name: string;
  text: string;
  replies?: number;
  /** posted from Foundation (by the app, on someone's behalf) */
  viaFoundation?: boolean;
}

const names = new Map<string, string>();

async function userName(id: string): Promise<string> {
  const hit = names.get(id);
  if (hit) return hit;
  try {
    const r = await call<{ user: { name: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", { user: id });
    const n = r.user.profile?.display_name || r.user.profile?.real_name || r.user.real_name || r.user.name;
    names.set(id, n);
    return n;
  } catch {
    return id;
  }
}

/** the shortcodes people use most; anything else stays as written */
const EMOJI: Record<string, string> = {
  movie_camera: "🎥", "+1": "👍", thumbsup: "👍", "-1": "👎", white_check_mark: "✅", heavy_check_mark: "✔️", eyes: "👀", tada: "🎉", fire: "🔥",
  rocket: "🚀", pray: "🙏", raised_hands: "🙌", wave: "👋", smile: "😄", slightly_smiling_face: "🙂", joy: "😂", thinking_face: "🤔", warning: "⚠️", x: "❌", memo: "📝", heart: "❤️", point_up: "☝️",
};

/** Slack mrkdwn → plain text a card can show: mentions become names, links their labels, shortcodes emoji */
export async function plainText(text: string): Promise<string> {
  const ids = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const resolved = new Map(await Promise.all(ids.map(async (id) => [id, await userName(id)] as const)));
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${resolved.get(id) ?? id}`)
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/:([a-z0-9_+-]+):/g, (m, k: string) => EMOJI[k] ?? m)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const historyCache = new Map<string, { at: number; value: SlackMessage[] }>();

export async function channelHistory(channel: string, limit = 40, fresh = false): Promise<SlackMessage[]> {
  const hit = historyCache.get(channel);
  if (!fresh && hit && Date.now() - hit.at < READ_TTL) return hit.value;
  const r = await call<{ messages: Array<{ ts: string; user?: string; bot_id?: string; username?: string; text: string; subtype?: string; reply_count?: number; metadata?: { event_type?: string } }> }>("conversations.history", { channel, limit, include_all_metadata: true });
  const value = await Promise.all(
    r.messages
      .filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast")
      .map(async (m) => ({
        ts: m.ts,
        at: Math.round(Number(m.ts) * 1000),
        user: m.user ?? m.bot_id ?? "",
        name: m.username ?? (m.user ? await userName(m.user) : "app"),
        text: await plainText(m.text ?? ""),
        replies: m.reply_count || undefined,
        viaFoundation: m.metadata?.event_type === "foundation_post" || /via Foundation$/.test(m.username ?? ""),
      })),
  );
  value.reverse(); // oldest first, like the channel
  historyCache.set(channel, { at: Date.now(), value });
  return value;
}

// ---------- writing (people only: these go out under a person's name) ----------

export async function postMessage(channel: string, text: string, as: { name: string }, meta: Record<string, unknown> = {}): Promise<{ ts: string }> {
  const clean = text.trim().slice(0, 3800);
  if (!clean) throw new SlackError("empty", "say something");
  const msg = {
    channel,
    text: clean,
    username: `${as.name} via Foundation`,
    unfurl_links: false,
    metadata: { event_type: "foundation_post", event_payload: { by: as.name, ...meta } },
  };
  let r: { ts: string };
  try {
    r = await call<{ ts: string }>("chat.postMessage", msg, true);
  } catch (e) {
    // public channels can be joined without an invite (channels:join)
    if (!(e instanceof SlackError) || e.code !== "not_in_channel") throw e;
    await call("conversations.join", { channel }, true);
    r = await call<{ ts: string }>("chat.postMessage", msg, true);
  }
  historyCache.delete(channel);
  return { ts: r.ts };
}

/** a link straight to a place on a board — the card (or section) is framed when it opens */
export function boardLink(boardId: string, objectId?: string) {
  const u = new URL(config.clientUrl);
  u.searchParams.set("board", boardId);
  if (objectId) u.searchParams.set("focus", objectId);
  return u.toString();
}

/** Slack's link syntax can't hold < > or |; labels are plain text */
function label(s: string) {
  return s.replace(/[<>|]/g, " ").trim().slice(0, 120);
}

export function shareText(p: { by: string; board: string; objectId?: string; title: string; note?: string }) {
  return `${p.note ? `${p.note}\n` : ""}<${boardLink(p.board, p.objectId)}|${label(p.title)} on Foundation>`;
}

export function inviteText(p: { by: string; board: string; huddleId: string; huddleName: string; live: string[] }) {
  const who = p.live.length ? ` — ${p.live.join(", ")} ${p.live.length === 1 ? "is" : "are"} there now` : "";
  return `:movie_camera: ${p.by} invited this channel to a huddle on Foundation${who}.\n<${boardLink(p.board, p.huddleId)}|Join ${label(p.huddleName)}>`;
}

// ---------- a channel as a section reads it (slacklive.ts) ----------

export interface SlackFileRef {
  id: string;
  name: string;
  title?: string;
  mime: string;
  /** Slack's private link: fetched with the bot token, never handed to a browser */
  url?: string;
}

/** a top-level message with what was attached to it */
export interface ChannelItem extends SlackMessage {
  files: SlackFileRef[];
}

interface RawFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  mode?: string;
}

/**
 * A channel's latest top-level messages, newest first, with their files.
 * Replies stay in their threads (a count on the message); joins, leaves and
 * other housekeeping are left out. Not cached: the caller decides how often.
 */
export async function channelItems(channel: string, limit = 60): Promise<ChannelItem[]> {
  const r = await call<{ messages: Array<{ ts: string; thread_ts?: string; user?: string; bot_id?: string; username?: string; text?: string; subtype?: string; reply_count?: number; files?: RawFile[]; metadata?: { event_type?: string } }> }>(
    "conversations.history",
    { channel, limit, include_all_metadata: true },
  );
  const top = r.messages.filter((m) => (!m.subtype || m.subtype === "bot_message" || m.subtype === "file_share") && (!m.thread_ts || m.thread_ts === m.ts));
  return Promise.all(
    top.map(async (m) => ({
      ts: m.ts,
      at: Math.round(Number(m.ts) * 1000),
      user: m.user ?? m.bot_id ?? "",
      name: m.username ?? (m.user ? await userName(m.user) : "app"),
      text: await plainText(m.text ?? ""),
      replies: m.reply_count || undefined,
      viaFoundation: m.metadata?.event_type === "foundation_post" || /via Foundation$/.test(m.username ?? ""),
      files: (m.files ?? [])
        .filter((f) => f.mode !== "tombstone" && f.id)
        .map((f) => ({ id: f.id, name: f.name ?? f.id, title: f.title || undefined, mime: f.mimetype ?? "application/octet-stream", url: f.url_private_download ?? f.url_private })),
    })),
  );
}

/** a file's bytes, fetched as the app (Slack's file links are private) */
export async function downloadFile(f: SlackFileRef, max = 40 * 1024 * 1024): Promise<Buffer> {
  if (!token()) throw new SlackError("not_configured", "Slack isn't connected");
  let url = f.url;
  if (!url) {
    const r = await call<{ file: RawFile }>("files.info", { file: f.id });
    url = r.file.url_private_download ?? r.file.url_private;
  }
  if (!url) throw new SlackError("file_not_found", `Slack has no link for ${f.name}`);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new SlackError("download_failed", `Slack wouldn't hand over ${f.name} (${res.status})`);
  // a sign-in page instead of the file means the app lacks files:read
  if (/^text\/html/.test(res.headers.get("content-type") ?? "")) throw new SlackError("missing_scope", explain("missing_scope"));
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > max) throw new SlackError("too_large", `${f.name} is over ${Math.round(max / 1048576)} MB`);
  return body;
}

/** the app joins a public channel (channels:join). People press this; it shows in the channel. */
export async function joinChannel(channel: string) {
  await call("conversations.join", { channel }, true);
  channelCache.delete(channel);
}

/** forget what was cached about channels (a channel was made, renamed, joined or left) */
export function forgetChannels() {
  channelCache.clear();
}

/**
 * ChatForm's core (docs/chatform.md §2): the store, who may do what, the hub,
 * search, unread, link previews and the HTTP routes. The contract's types and
 * pure rules are `@foundation/protocol` chat.ts.
 *
 * - A conversation is a channel; every message has a `seq` in it, counted from
 *   one and never reused. A member's read mark is a seq; unread is the pure
 *   rule `chatUnread`.
 * - The server says who spoke: a person's session posts as that person, an
 *   agent's bearer (or the service token) posts as an agent and is always drawn
 *   as one. A request may *name* its agent (`X-Foundation-Agent` or `as`), never
 *   make one a person.
 * - Who hears what: `publish(event, audience)` is the hub; chatsock.ts delivers
 *   each event only to the sockets of people who may see its channel. A DM's
 *   events never reach a non-member, admins included.
 * - Removing a message keeps its row (the thread holds together); its text and
 *   files leave what is sent and the search index, and its files stay archived.
 *
 * Tables are made at import, like huddles.ts.
 */

import { randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { ServerResponse } from "node:http";
import {
  CHAT_FILES_MAX,
  CHAT_GROUP_MAX,
  CHAT_TEXT_MAX,
  chatHandle,
  chatMembersKey,
  chatMentionHandles,
  chatSlug,
  chatTitle,
  chatUnread,
  parseChatQuery,
  type ChatAgentRef,
  type ChatChannel,
  type ChatChannelKind,
  type ChatChannelView,
  type ChatEvent,
  type ChatFile,
  type ChatHuddleState,
  type ChatLinkPreview,
  type ChatMembership,
  type ChatMessage,
  type ChatMessageType,
  type ChatOrigin,
  type ChatPage,
  type ChatParty,
  type ChatReaction,
  type ChatService,
  type UserInfo,
} from "@foundation/protocol";
import { all, db, indexDoc, one, run, unindexDoc } from "./db.ts";
import { HttpError, readJson, type Req, type Router } from "./http.ts";
import { isPerson, requireUser } from "./auth.ts";
import { canSeeBoard } from "./members.ts";

/** the reserved board id chat uploads are kept under (`POST /api/files?board=chat`) and chat's search rows carry */
export const CHAT_BOARD = "chat";

db.exec(`
create table if not exists chat_channels (
  id text primary key,
  kind text not null,
  name text not null default '',
  topic text not null default '',
  purpose text not null default '',
  created_by text not null,
  created_at integer not null,
  archived_at integer,
  members_key text unique,
  origin_service text,
  origin_id text,
  origin_account text,
  agent_json text,
  last_seq integer not null default 0,
  last_post_at integer not null default 0,
  last_text text,
  huddle_json text
);
create unique index if not exists chat_channels_origin on chat_channels(origin_service, origin_id, coalesce(origin_account, '')) where origin_service is not null;

create table if not exists chat_members (
  channel_id text not null,
  party_kind text not null,
  party_id text not null,
  name text not null,
  party_json text not null,
  read_seq integer not null default 0,
  mentions integer not null default 0,
  notify text not null default 'all',
  starred integer not null default 0,
  joined_at integer not null,
  primary key (channel_id, party_kind, party_id)
);
create index if not exists chat_members_party on chat_members(party_kind, party_id);

create table if not exists chat_messages (
  id text primary key,
  channel_id text not null,
  seq integer not null,
  author_kind text not null,
  author_id text not null,
  author_json text not null,
  type text not null default 'text',
  text text not null default '',
  root_id text,
  created_at integer not null,
  edited_at integer,
  deleted_at integer,
  files_json text not null default '[]',
  mentions_json text not null default '[]',
  previews_json text,
  extra_json text,
  pinned integer not null default 0,
  request_id text,
  origin_service text,
  origin_id text,
  reply_count integer not null default 0,
  last_reply_at integer,
  repliers_json text,
  updated_at integer not null,
  unique (channel_id, seq),
  unique (channel_id, author_id, request_id),
  unique (channel_id, origin_service, origin_id)
);
create index if not exists chat_messages_root on chat_messages(root_id, seq);
create index if not exists chat_messages_channel on chat_messages(channel_id, root_id, seq);
create index if not exists chat_messages_updated on chat_messages(channel_id, updated_at);

create table if not exists chat_reactions (
  message_id text not null,
  emoji text not null,
  party_kind text not null,
  party_id text not null,
  name text not null,
  at integer not null,
  primary key (message_id, emoji, party_kind, party_id)
);

create table if not exists chat_ghosts (
  id text primary key,
  service text not null,
  handle text not null,
  name text not null,
  avatar text,
  user_id text,
  unique (service, handle)
);

-- which messages carry which uploaded file (who may open /files/:id of a chat upload)
create table if not exists chat_files (
  file_id text not null,
  message_id text not null,
  channel_id text not null,
  primary key (file_id, message_id)
);

-- request_id for writes that aren't messages (a channel made twice by a retry is made once)
create table if not exists chat_requests (
  user_id text not null,
  request_id text not null,
  result text not null,
  at integer not null,
  primary key (user_id, request_id)
);

-- people put into #general once, on their first visit (leaving it sticks)
create table if not exists chat_autojoin (
  user_id text not null,
  channel_id text not null,
  primary key (user_id, channel_id)
);
`);

// ---------- rows ----------

interface ChannelRow {
  id: string;
  kind: ChatChannelKind;
  name: string;
  topic: string;
  purpose: string;
  created_by: string;
  created_at: number;
  archived_at: number | null;
  members_key: string | null;
  origin_service: string | null;
  origin_id: string | null;
  origin_account: string | null;
  agent_json: string | null;
  last_seq: number;
  last_post_at: number;
  last_text: string | null;
  huddle_json: string | null;
}

interface MemberRow {
  channel_id: string;
  party_kind: string;
  party_id: string;
  name: string;
  party_json: string;
  read_seq: number;
  mentions: number;
  notify: "all" | "mentions" | "none";
  starred: number;
  joined_at: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  seq: number;
  author_kind: string;
  author_id: string;
  author_json: string;
  type: ChatMessageType;
  text: string;
  root_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  files_json: string;
  mentions_json: string;
  previews_json: string | null;
  extra_json: string | null;
  pinned: number;
  request_id: string | null;
  origin_service: string | null;
  origin_id: string | null;
  reply_count: number;
  last_reply_at: number | null;
  repliers_json: string | null;
  updated_at: number;
}

interface MessageExtra {
  huddle?: ChatMessage["huddle"];
  place?: ChatMessage["place"];
  outbound?: ChatMessage["outbound"];
  originAccount?: string;
}

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** run `fn` atomically; nests inside a caller's transaction (savepoints) */
function atomically<T>(fn: () => T): T {
  const sp = `chat_${randomBytes(4).toString("hex")}`;
  db.exec(`savepoint ${sp}`);
  try {
    const out = fn();
    db.exec(`release ${sp}`);
    return out;
  } catch (e) {
    db.exec(`rollback to ${sp}`);
    db.exec(`release ${sp}`);
    throw e;
  }
}

// ---------- parties ----------

export const SYSTEM_PARTY: ChatParty = { kind: "system", id: "system", name: "ChatForm" };
const AGENT_COLOR = "#7c3aed";

export function personParty(user: Pick<UserInfo, "id" | "name" | "color">): ChatParty {
  return { kind: "person", id: user.id, name: user.name, color: user.color };
}

/** an agent, by its name (its id is its name); `forName`: the person it is working for */
export function agentParty(name: string, via?: string, forName?: string): ChatParty {
  const clean = cleanAgentName(name) || "Agent";
  return { kind: "agent", id: clean, name: clean, color: AGENT_COLOR, ...(via ? { via } : {}), ...(forName ? { forName } : {}) };
}

function cleanAgentName(name: unknown): string {
  return typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40) : "";
}

/**
 * Someone outside Foundation who speaks through a bridge, made once per service and handle (its name and
 * picture follow the latest). A ghost linked to one of us (`chat_ghosts.user_id`) speaks as that person.
 */
export function ghostParty(service: ChatService, handle: string, name: string, avatar?: string): ChatParty {
  const h = handle.trim().toLowerCase().slice(0, 200);
  if (!h) throw new HttpError(400, "a ghost needs a handle");
  let row = one<{ id: string; name: string; avatar: string | null; user_id: string | null }>("select id, name, avatar, user_id from chat_ghosts where service = ? and handle = ?", service, h);
  if (!row) {
    const id = newId("gh");
    run("insert into chat_ghosts (id, service, handle, name, avatar) values (?, ?, ?, ?, ?)", id, service, h, name || h, avatar ?? null);
    row = { id, name: name || h, avatar: avatar ?? null, user_id: null };
  } else if ((name && name !== row.name) || (avatar && avatar !== row.avatar)) {
    run("update chat_ghosts set name = ?, avatar = ? where id = ?", name || row.name, avatar ?? row.avatar, row.id);
    row = { ...row, name: name || row.name, avatar: avatar ?? row.avatar };
  }
  if (row.user_id) {
    const u = one<UserInfo>("select id, email, name, color, role from users where id = ?", row.user_id);
    if (u) return personParty(u);
  }
  return { kind: "ghost", id: row.id, name: row.name, service, handle: h, ...(row.avatar ? { avatar: row.avatar } : {}) };
}

const partyKey = (p: Pick<ChatParty, "kind" | "id">) => (p.kind === "person" ? p.id : `${p.kind}:${p.id}`);

/** a viewer account reads where it is a member and posts there; it makes nothing */
const isViewer = (u: UserInfo) => u.id !== "agent" && u.role !== "admin" && u.role !== "member";

/**
 * Who a request speaks as. A person's own session (their browser's cookie, their app's sign-in bearer) is
 * that person. Anything else (an agent's bearer, the service token, a browser session sent as a bearer)
 * is an agent working for the session's person; `X-Foundation-Agent` or the body's `as` may name it.
 */
export function requestParty(req: Req, body?: { as?: unknown }): { user: UserInfo; party: ChatParty; person: boolean } {
  const user = requireUser(req);
  if (isPerson(req)) return { user, party: personParty(user), person: true };
  const header = req.headers["x-foundation-agent"];
  const named = cleanAgentName(Array.isArray(header) ? header[0] : header) || cleanAgentName(body?.as);
  const via = cleanAgentName(req.headers["x-foundation-agent-via"] as string | undefined) || undefined;
  const name = named || (user.id === "agent" ? "Foundation Agent" : "Agent");
  return { user, party: agentParty(name, via, user.id === "agent" ? undefined : user.name), person: false };
}

// ---------- the hub ----------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** an event before its connection's `rev` is stamped on it */
export type ChatEventBody = DistributiveOmit<ChatEvent, "rev">;
export type ChatAudience = { channel: string } | { users: string[] } | "all";

const sinks = new Set<(event: ChatEventBody, audience: ChatAudience) => void>();
/** chatsock.ts delivers; tests can listen */
export function onPublish(fn: (event: ChatEventBody, audience: ChatAudience) => void): () => void {
  sinks.add(fn);
  return () => sinks.delete(fn);
}
/** send an event to everyone in the audience who may see it (chatsock.ts checks each socket's person) */
export function publish(event: ChatEventBody, audience: { channel: string } | { users: string[] } | "all"): void {
  for (const s of sinks) {
    try {
      s(event, audience);
    } catch (e) {
      console.error("chat: delivering an event failed", e);
    }
  }
}

let onlineSource: () => string[] = () => [];
/** chatsock.ts says who has a socket open */
export function setOnlineSource(fn: () => string[]) {
  onlineSource = fn;
}
export const onlineUsers = () => onlineSource();

const messageListeners = new Set<(message: ChatMessage, channel: ChatChannel) => void>();
/** after every non-silent post (agents, bridges) */
export function onChatMessage(fn: (message: ChatMessage, channel: ChatChannel) => void): () => void {
  messageListeners.add(fn);
  return () => messageListeners.delete(fn);
}

// ---------- agents we know ----------

const agentSources = new Set<() => ChatAgentRef[]>();
/** another module (agents in chat) says which agents can be talked to and @mentioned */
export function registerChatAgents(fn: () => ChatAgentRef[]): () => void {
  agentSources.add(fn);
  return () => agentSources.delete(fn);
}

export function knownAgents(): ChatAgentRef[] {
  const out = new Map<string, ChatAgentRef>();
  for (const src of agentSources) {
    try {
      for (const a of src()) if (a.name && !out.has(a.name.toLowerCase())) out.set(a.name.toLowerCase(), a);
    } catch {
      /* a source that fails names nobody */
    }
  }
  const seen = all<{ party_json: string }>("select party_json from chat_members where party_kind = 'agent' union select author_json as party_json from (select distinct author_json from chat_messages where author_kind = 'agent' limit 200)");
  for (const r of seen) {
    const p = parse<ChatParty | null>(r.party_json, null);
    if (p?.name && !out.has(p.name.toLowerCase())) out.set(p.name.toLowerCase(), { name: p.name, ...(p.via ? { via: p.via } : {}) });
  }
  return [...out.values()];
}

// ---------- channels ----------

function channelRow(id: string): ChannelRow | undefined {
  return one<ChannelRow>("select * from chat_channels where id = ?", id);
}

function memberRows(channelId: string): MemberRow[] {
  return all<MemberRow>("select * from chat_members where channel_id = ? order by joined_at, rowid", channelId);
}

function memberRow(channelId: string, p: Pick<ChatParty, "kind" | "id">): MemberRow | undefined {
  return one<MemberRow>("select * from chat_members where channel_id = ? and party_kind = ? and party_id = ?", channelId, p.kind, p.id);
}

const partyOfMember = (m: MemberRow): ChatParty => parse<ChatParty>(m.party_json, { kind: m.party_kind as ChatParty["kind"], id: m.party_id, name: m.name });

function toChannel(row: ChannelRow): ChatChannel {
  const members = memberRows(row.id);
  const pinned = all<{ id: string }>("select id from chat_messages where channel_id = ? and pinned = 1 and deleted_at is null order by seq", row.id).map((r) => r.id);
  const c: ChatChannel = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    purpose: row.purpose,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    lastSeq: row.last_seq,
    lastPostAt: row.last_post_at,
    memberCount: members.length,
    pinned,
    huddle: parse<ChatHuddleState | null>(row.huddle_json, null),
  };
  if (row.last_text) c.lastText = plainLine(row.last_text);
  if (row.origin_service && row.origin_id) c.origin = { service: row.origin_service as ChatOrigin["service"], externalId: row.origin_id, ...(row.origin_account ? { account: row.origin_account } : {}) };
  if (row.agent_json) c.agent = parse<ChatAgentRef | undefined>(row.agent_json, undefined);
  if (row.kind !== "open") c.members = members.map(partyOfMember);
  return c;
}

export function getChannel(id: string): ChatChannel | undefined {
  const row = channelRow(id);
  return row ? toChannel(row) : undefined;
}

function membershipOf(m: MemberRow | undefined): ChatMembership | null {
  if (!m) return null;
  return { channel: m.channel_id, readSeq: m.read_seq, mentions: m.mentions, notify: m.notify, starred: Boolean(m.starred), joinedAt: m.joined_at };
}

/** the channel as this person sees it: their membership and unread */
export function channelView(user: UserInfo, channel: ChatChannel): ChatChannelView {
  const me = membershipOf(memberRow(channel.id, { kind: "person", id: user.id }));
  return { ...channel, me, unread: chatUnread(channel.lastSeq, me) };
}

/** the person (or the service token's agent) is a member: the session's own person, never their agents */
const isMemberUser = (channelId: string, user: UserInfo) =>
  Boolean(user.id === "agent" ? memberRow(channelId, { kind: "agent", id: "Foundation Agent" }) : memberRow(channelId, { kind: "person", id: user.id }));

/**
 * Who may read a channel: an open one, anyone signed in (a viewer account only where it's a member);
 * everything else, its members only. Admins don't read others' DMs, groups or private channels.
 */
export function canSeeChannel(user: UserInfo, channel: Pick<ChatChannel, "id" | "kind">): boolean {
  if (channel.kind === "open" && !isViewer(user)) return true;
  return isMemberUser(channel.id, user);
}

/** the channel, or 404 when there's none or it's hidden from this person (a hidden channel answers like a missing one) */
export function requireChannel(user: UserInfo, id: string): ChatChannel {
  const c = getChannel(id);
  if (!c || !canSeeChannel(user, c)) throw new HttpError(404, "no such channel");
  return c;
}

/** may this person write in it (post, react, pin): members; anyone but a viewer in an open one (writing joins it) */
function requireWritable(user: UserInfo, c: ChatChannel) {
  if (c.archivedAt) throw new HttpError(409, "this channel is archived");
  if (isMemberUser(c.id, user)) return;
  if (c.kind === "open" && !isViewer(user)) return;
  throw new HttpError(403, isViewer(user) ? "View only: your account can post only where it's a member" : "join this channel first");
}

export function channelByOrigin(service: string, externalId: string, account?: string): ChatChannel | undefined {
  const row = one<ChannelRow>("select * from chat_channels where origin_service = ? and origin_id = ? and coalesce(origin_account, '') = ?", service, externalId, account ?? "");
  return row ? toChannel(row) : undefined;
}

export function createChannel(
  by: ChatParty,
  c: { kind: ChatChannelKind; name?: string; topic?: string; purpose?: string; members?: ChatParty[]; origin?: ChatOrigin; agent?: ChatAgentRef; createdAt?: number },
): ChatChannel {
  if (c.origin) {
    const had = channelByOrigin(c.origin.service, c.origin.externalId, c.origin.account);
    if (had) return had;
  }
  if (c.kind === "dm" || c.kind === "group") {
    const parties = [...(by.kind === "system" ? [] : [by]), ...(c.members ?? [])];
    const ch = openDirect(parties, { createdAt: c.createdAt });
    if (c.origin && !ch.origin) {
      run("update chat_channels set origin_service = ?, origin_id = ?, origin_account = ? where id = ?", c.origin.service, c.origin.externalId, c.origin.account ?? null, ch.id);
      return getChannel(ch.id)!;
    }
    return ch;
  }
  const name = c.kind === "open" || c.kind === "private" ? chatSlug(c.name ?? "") : (c.name ?? "").trim().slice(0, 120);
  if ((c.kind === "open" || c.kind === "private") && !name) throw new HttpError(400, "a channel needs a name");
  const id = newId("ch");
  const at = c.createdAt ?? Date.now();
  run(
    "insert into chat_channels (id, kind, name, topic, purpose, created_by, created_at, origin_service, origin_id, origin_account, agent_json, last_post_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, c.kind, name, (c.topic ?? "").slice(0, 250), (c.purpose ?? "").slice(0, 250), by.id, at,
    c.origin?.service ?? null, c.origin?.externalId ?? null, c.origin?.account ?? null, c.agent ? JSON.stringify(c.agent) : null, at,
  );
  const parties = [...(by.kind === "person" || by.kind === "agent" ? [by] : []), ...(c.members ?? [])];
  if (c.kind === "agent" && c.agent && !parties.some((p) => p.kind === "agent")) parties.push(agentParty(c.agent.name, c.agent.via));
  for (const p of parties) addMember(id, p, { silent: true });
  const ch = getChannel(id)!;
  publish({ t: "channel", channel: ch }, { channel: id });
  return ch;
}

/** the dm (two, or one with themselves) or group (three to CHAT_GROUP_MAX) of exactly these parties, made once */
export function openDirect(parties: ChatParty[], opts: { createdAt?: number } = {}): ChatChannel {
  const uniq = [...new Map(parties.filter((p) => p.kind !== "system").map((p) => [partyKey(p), p])).values()];
  if (!uniq.length) throw new HttpError(400, "a conversation needs someone in it");
  if (uniq.length > CHAT_GROUP_MAX) throw new HttpError(400, `a group holds at most ${CHAT_GROUP_MAX}: make a private channel`);
  const key = chatMembersKey(uniq.map(partyKey));
  const had = one<ChannelRow>("select * from chat_channels where members_key = ?", key);
  if (had) return toChannel(had);
  const id = newId("ch");
  const at = opts.createdAt ?? Date.now();
  run(
    "insert into chat_channels (id, kind, name, created_by, created_at, members_key, last_post_at) values (?, ?, '', ?, ?, ?, ?)",
    id, uniq.length <= 2 ? "dm" : "group", uniq[0].id, at, key, at,
  );
  for (const p of uniq) addMember(id, p, { silent: true });
  const ch = getChannel(id)!;
  publish({ t: "channel", channel: ch }, { channel: id });
  return ch;
}

/** join someone to a channel; their read mark starts at its newest message. Not silent: a system line, and events */
/** a list line reads as words: the markdown marks of the message it came from are dropped */
function plainLine(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,!?])/g, "$1$2")
    .replace(/(^|: )(?:>|#{1,6}|[-*])\s+/g, "$1");
}

export function addMember(channelId: string, party: ChatParty, opts: { silent?: boolean } = {}) {
  const ch = channelRow(channelId);
  if (!ch) throw new HttpError(404, "no such channel");
  if (party.kind === "system") return;
  if (memberRow(channelId, party)) return;
  if (!opts.silent && party.kind !== "agent") postMessage(channelId, SYSTEM_PARTY, { type: "system", text: `${party.name} joined.` });
  const seq = channelRow(channelId)!.last_seq;
  run(
    "insert or ignore into chat_members (channel_id, party_kind, party_id, name, party_json, read_seq, joined_at) values (?, ?, ?, ?, ?, ?, ?)",
    channelId, party.kind, party.id, party.name, JSON.stringify(party), seq, Date.now(),
  );
  if (opts.silent) return;
  const c = getChannel(channelId)!;
  publish({ t: "member", channel: channelId, party, joined: true }, { channel: channelId });
  publish({ t: "channel", channel: c }, { channel: channelId });
  if (party.kind === "person") publish({ t: "read", channel: channelId, readSeq: seq, mentions: 0 }, { users: [party.id] });
}

export function removeMember(channelId: string, party: Pick<ChatParty, "kind" | "id" | "name">, opts: { silent?: boolean } = {}) {
  const ch = channelRow(channelId);
  if (!ch || !memberRow(channelId, party)) return;
  run("delete from chat_members where channel_id = ? and party_kind = ? and party_id = ?", channelId, party.kind, party.id);
  if (opts.silent) return;
  postMessage(channelId, SYSTEM_PARTY, { type: "system", text: `${party.name} left.` });
  const c = getChannel(channelId)!;
  publish({ t: "member", channel: channelId, party: party as ChatParty, joined: false }, { channel: channelId });
  publish({ t: "channel", channel: c }, { channel: channelId });
  if (party.kind === "person" && c.kind !== "open") publish({ t: "channel-gone", channel: channelId }, { users: [party.id] });
}

export function setChannelHuddle(channelId: string, state: ChatHuddleState | null): void {
  if (!channelRow(channelId)) throw new HttpError(404, "no such channel");
  run("update chat_channels set huddle_json = ? where id = ?", state ? JSON.stringify(state) : null, channelId);
  publish({ t: "channel", channel: getChannel(channelId)! }, { channel: channelId });
}

/** #general: the open channel everyone starts in, made the first time anyone looks */
export function ensureGeneral(): ChatChannel {
  const had = one<ChannelRow>("select * from chat_channels where kind = 'open' and name = 'general' and archived_at is null order by created_at limit 1");
  if (had) return toChannel(had);
  return createChannel(SYSTEM_PARTY, { kind: "open", name: "general", purpose: "The whole company, in one place." });
}

function autoJoinGeneral(user: UserInfo) {
  if (user.id === "agent" || isViewer(user)) return;
  const g = ensureGeneral();
  if (one("select 1 from chat_autojoin where user_id = ? and channel_id = ?", user.id, g.id)) return;
  run("insert or ignore into chat_autojoin (user_id, channel_id) values (?, ?)", user.id, g.id);
  addMember(g.id, personParty(user), { silent: true });
}

// ---------- messages ----------

function messageRow(id: string): MessageRow | undefined {
  return one<MessageRow>("select * from chat_messages where id = ?", id);
}

function reactionsFor(ids: string[]): Map<string, ChatReaction[]> {
  const out = new Map<string, ChatReaction[]>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = all<{ message_id: string; emoji: string; name: string }>(
      `select message_id, emoji, name from chat_reactions where message_id in (${chunk.map(() => "?").join(",")}) order by at, rowid`,
      ...chunk,
    );
    for (const r of rows) {
      const list = out.get(r.message_id) ?? [];
      let e = list.find((x) => x.emoji === r.emoji);
      if (!e) list.push((e = { emoji: r.emoji, by: [] }));
      e.by.push(r.name);
      out.set(r.message_id, list);
    }
  }
  return out;
}

function toMessage(row: MessageRow, reactions?: Map<string, ChatReaction[]>): ChatMessage {
  const gone = row.deleted_at !== null;
  const extra = parse<MessageExtra>(row.extra_json, {});
  const m: ChatMessage = {
    id: row.id,
    channel: row.channel_id,
    seq: row.seq,
    author: parse<ChatParty>(row.author_json, { kind: row.author_kind as ChatParty["kind"], id: row.author_id, name: row.author_id }),
    type: row.type,
    text: gone ? "" : row.text,
    root: row.root_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    files: gone ? [] : parse<ChatFile[]>(row.files_json, []),
    reactions: gone ? [] : ((reactions ?? reactionsFor([row.id])).get(row.id) ?? []),
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
    pinned: Boolean(row.pinned) && !gone,
    mentions: gone ? [] : parse<string[]>(row.mentions_json, []),
  };
  const repliers = parse<string[]>(row.repliers_json, []);
  if (repliers.length) m.repliers = repliers;
  if (!gone && row.previews_json) m.previews = parse<ChatLinkPreview[]>(row.previews_json, []);
  if (row.origin_service && row.origin_id) m.origin = { service: row.origin_service as ChatOrigin["service"], externalId: row.origin_id, ...(extra.originAccount ? { account: extra.originAccount } : {}) };
  if (extra.huddle) m.huddle = extra.huddle;
  if (extra.place && !gone) m.place = extra.place;
  if (extra.outbound) m.outbound = extra.outbound;
  return m;
}

function toMessages(rows: MessageRow[]): ChatMessage[] {
  const reactions = reactionsFor(rows.map((r) => r.id));
  return rows.map((r) => toMessage(r, reactions));
}

export function getMessage(id: string): ChatMessage | undefined {
  const row = messageRow(id);
  return row ? toMessage(row) : undefined;
}

/** the archive rows for these file ids, as a message names them (unknown ids are dropped) */
function fileRefs(ids: string[]): ChatFile[] {
  const out: ChatFile[] = [];
  for (const id of [...new Set(ids)].slice(0, CHAT_FILES_MAX)) {
    const f = one<{ id: string; name: string; mime: string; size: number }>("select id, name, mime, size from files where id = ?", id);
    if (f) out.push({ id: f.id, name: f.name, mime: f.mime, size: f.size });
  }
  return out;
}

function usersForMentions() {
  return all<{ id: string; name: string; email: string }>("select id, name, email from users");
}

/** `@handle`s as user ids (by chatHandle of their name, their email's local part, or a first name only one person has), agents as `agent:<name>`, and channel / here */
export function resolveMentions(text: string): string[] {
  const handles = chatMentionHandles(text);
  if (!handles.length) return [];
  const users = usersForMentions();
  const firsts = new Map<string, string[]>();
  for (const u of users) {
    const f = u.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (f) firsts.set(f, [...(firsts.get(f) ?? []), u.id]);
  }
  const agents = knownAgents();
  const out = new Set<string>();
  for (const h of handles) {
    if (h === "channel" || h === "everyone" || h === "all") {
      out.add("channel");
      continue;
    }
    if (h === "here") {
      out.add("here");
      continue;
    }
    let found = false;
    for (const u of users) {
      if (chatHandle(u.name) === h || u.email.split("@")[0].toLowerCase() === h) {
        out.add(u.id);
        found = true;
      }
    }
    if (!found && firsts.get(h)?.length === 1) {
      out.add(firsts.get(h)![0]);
      found = true;
    }
    if (!found) for (const a of agents) if (chatHandle(a.name) === h) out.add(`agent:${a.name}`);
  }
  return [...out];
}

/** does this message count as a mention for this member */
function mentionsMember(kind: ChatChannelKind, m: MemberRow, author: ChatParty, mentions: string[], online: Set<string>): boolean {
  if (m.party_kind !== "person" || (author.kind === "person" && author.id === m.party_id)) return false;
  if (kind === "dm" || kind === "group" || kind === "agent" || kind === "portal") return author.kind !== "system";
  return mentions.includes(m.party_id) || mentions.includes("channel") || (mentions.includes("here") && online.has(m.party_id));
}

function channelLabel(row: ChannelRow): string {
  if (row.kind === "open" || row.kind === "private") return `#${row.name}`;
  const c = toChannel(row);
  return chatTitle(c) || "Direct message";
}

function indexMessage(row: MessageRow, ch: ChannelRow) {
  if (row.deleted_at !== null || row.type === "system") return unindexDoc("chat", row.id);
  const author = parse<ChatParty>(row.author_json, { kind: "person", id: row.author_id, name: row.author_id });
  const files = parse<ChatFile[]>(row.files_json, []);
  indexDoc("chat", row.id, CHAT_BOARD, `${channelLabel(ch)} · ${author.name}`, [row.text, ...files.map((f) => f.name)].filter(Boolean).join("\n"));
}

/** a thread's first message keeps its count, newest reply and up to five repliers (newest first), from what's not removed */
function recountThread(rootId: string) {
  const rows = all<{ author_json: string; created_at: number }>("select author_json, created_at from chat_messages where root_id = ? and deleted_at is null order by seq", rootId);
  const names: string[] = [];
  for (const r of [...rows].reverse()) {
    const n = parse<ChatParty | null>(r.author_json, null)?.name;
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= 5) break;
  }
  run(
    "update chat_messages set reply_count = ?, last_reply_at = ?, repliers_json = ?, updated_at = ? where id = ?",
    rows.length, rows.length ? Math.max(...rows.map((r) => r.created_at)) : null, JSON.stringify(names), Date.now(), rootId,
  );
}

/** a member's mentions above their read mark, counted again (after a read mark moves) */
function recountMentions(channelId: string, m: MemberRow): number {
  const ch = channelRow(channelId)!;
  const rows = all<{ author_json: string; mentions_json: string }>(
    "select author_json, mentions_json from chat_messages where channel_id = ? and seq > ? and deleted_at is null and type != 'system'",
    channelId, m.read_seq,
  );
  const online = new Set<string>(); // @here counted when it was said; a recount can't know who was here then, so it counts it for everyone
  let n = 0;
  for (const r of rows) {
    const mentions = parse<string[]>(r.mentions_json, []);
    const author = parse<ChatParty>(r.author_json, SYSTEM_PARTY);
    if (mentionsMember(ch.kind, m, author, mentions.map((x) => (x === "here" ? "channel" : x)), online)) n++;
  }
  return n;
}

export interface PostInput {
  text?: string;
  files?: string[];
  root?: string | null;
  type?: ChatMessageType;
  requestId?: string;
  origin?: ChatOrigin;
  createdAt?: number;
  huddle?: ChatMessage["huddle"];
  place?: ChatMessage["place"];
  outbound?: ChatMessage["outbound"];
  reactions?: ChatReaction[];
  pinned?: boolean;
  editedAt?: number;
}

/** what a "before post" hook is told: the channel, its kind and service, who is posting, and whether it is brought-in history */
export type ChatPostContext = { channel: string; kind: ChatChannelKind; service: string | null; author: ChatParty; silent: boolean };
const postTransforms = new Set<(ctx: ChatPostContext, m: PostInput) => PostInput | void>();
/** change a message before it is stored, atomically with its post (bridges: an agent's portal message is stored as a draft) */
export function beforeChatPost(fn: (ctx: ChatPostContext, m: PostInput) => PostInput | void): () => void {
  postTransforms.add(fn);
  return () => postTransforms.delete(fn);
}

/**
 * Post a message. A retry with the same request id (per channel and author) or the same origin returns the
 * first message. `silent` is for brought-in history: no events, no listeners, no mention counts, and
 * members who were caught up stay caught up.
 */
export function postMessage(channelId: string, author: ChatParty, m: PostInput, opts: { silent?: boolean } = {}): ChatMessage {
  const ch = channelRow(channelId);
  if (!ch) throw new HttpError(404, "no such channel");
  const requestId = typeof m.requestId === "string" && m.requestId ? m.requestId.slice(0, 120) : null;
  if (requestId) {
    const had = one<MessageRow>("select * from chat_messages where channel_id = ? and author_id = ? and request_id = ?", channelId, author.id, requestId);
    if (had) return toMessage(had);
  }
  if (m.origin) {
    const had = one<MessageRow>("select * from chat_messages where channel_id = ? and origin_service = ? and origin_id = ?", channelId, m.origin.service, m.origin.externalId);
    if (had) return toMessage(had);
  }
  for (const fn of postTransforms) m = fn({ channel: channelId, kind: ch.kind, service: ch.origin_service, author, silent: Boolean(opts.silent) }, m) ?? m;
  const type: ChatMessageType = m.type ?? (m.place ? "link" : "text");
  const text = (m.text ?? "").slice(0, CHAT_TEXT_MAX);
  const files = fileRefs(m.files ?? []);
  if ((type === "text" || type === "draft") && !text.trim() && !files.length) throw new HttpError(400, "say something");
  if (type === "link" && !m.place?.board) throw new HttpError(400, "a link names a place");
  let rootId: string | null = null;
  if (m.root) {
    const r = messageRow(m.root);
    if (!r || r.channel_id !== channelId) throw new HttpError(400, "no such thread in this channel");
    rootId = r.root_id ?? r.id;
  }
  const silent = Boolean(opts.silent);
  // writing in an open channel joins it
  if (!silent && ch.kind === "open" && (author.kind === "person" || author.kind === "agent") && !memberRow(channelId, author)) addMember(channelId, author);

  const mentions = type === "system" ? [] : resolveMentions(text);
  const id = newId("m");
  const createdAt = m.createdAt ?? Date.now();
  const extra: MessageExtra = {};
  if (m.huddle) extra.huddle = m.huddle;
  if (m.place) extra.place = { board: String(m.place.board), label: String(m.place.label ?? m.place.board).slice(0, 200), ...(m.place.boardName ? { boardName: m.place.boardName } : {}), ...(m.place.section ? { section: m.place.section } : {}), ...(m.place.object ? { object: m.place.object } : {}) };
  if (m.outbound) extra.outbound = m.outbound;
  if (m.origin?.account) extra.originAccount = m.origin.account;
  const online = new Set(onlineUsers());
  const touched: string[] = [];

  atomically(() => {
    const seq = one<{ last_seq: number }>("update chat_channels set last_seq = last_seq + 1 where id = ? returning last_seq", channelId)!.last_seq;
    run(
      `insert into chat_messages (id, channel_id, seq, author_kind, author_id, author_json, type, text, root_id, created_at, edited_at, files_json, mentions_json, extra_json, pinned, request_id, origin_service, origin_id, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, channelId, seq, author.kind, author.id, JSON.stringify(author), type, text, rootId, createdAt, m.editedAt ?? null,
      JSON.stringify(files), JSON.stringify(mentions), Object.keys(extra).length ? JSON.stringify(extra) : null, m.pinned ? 1 : 0,
      requestId, m.origin?.service ?? null, m.origin?.externalId ?? null, Date.now(),
    );
    for (const f of files) run("insert or ignore into chat_files (file_id, message_id, channel_id) values (?, ?, ?)", f.id, id, channelId);
    for (const r of m.reactions ?? []) for (const name of r.by) run("insert or ignore into chat_reactions (message_id, emoji, party_kind, party_id, name, at) values (?, ?, 'person', ?, ?, ?)", id, r.emoji, `name:${name}`, name, createdAt);
    const summary = type === "system" || rootId ? null : (text.replace(/\s+/g, " ").trim().slice(0, 140) || (files[0] ? files[0].name : null));
    run(
      "update chat_channels set last_post_at = max(last_post_at, ?), last_text = coalesce(?, last_text) where id = ?",
      createdAt, summary ? `${author.kind === "system" ? "" : `${author.name}: `}${summary}` : null, channelId,
    );
    if (silent) {
      run("update chat_members set read_seq = ? where channel_id = ? and read_seq >= ?", seq, channelId, seq - 1);
    } else {
      for (const mem of memberRows(channelId)) {
        if (author.kind !== "system" && mem.party_kind === author.kind && mem.party_id === author.id) {
          run("update chat_members set read_seq = ?, mentions = 0 where channel_id = ? and party_kind = ? and party_id = ?", seq, channelId, mem.party_kind, mem.party_id);
          if (mem.party_kind === "person") touched.push(mem.party_id);
        } else if (mentionsMember(ch.kind, mem, author, mentions, online)) {
          run("update chat_members set mentions = mentions + 1 where channel_id = ? and party_kind = ? and party_id = ?", channelId, mem.party_kind, mem.party_id);
          touched.push(mem.party_id);
        }
      }
    }
    if (rootId) recountThread(rootId);
  });

  const row = messageRow(id)!;
  const chNow = channelRow(channelId)!;
  indexMessage(row, chNow);
  const message = toMessage(row);
  if (!silent) {
    publish({ t: "message", message, ...(requestId ? { requestId } : {}) }, { channel: channelId });
    if (rootId) publish({ t: "message-changed", message: getMessage(rootId)! }, { channel: channelId });
    for (const uid of new Set(touched)) {
      const me = memberRow(channelId, { kind: "person", id: uid });
      if (me) publish({ t: "read", channel: channelId, readSeq: me.read_seq, mentions: me.mentions }, { users: [uid] });
    }
    const channel = toChannel(chNow);
    for (const fn of messageListeners) {
      try {
        fn(message, channel);
      } catch (e) {
        console.error("chat: a message listener failed", e);
      }
    }
    if (type === "text") queuePreviews(message);
  }
  return message;
}

/** change a message (text, a huddle card, a draft's state, its previews); `edited` marks it edited */
export function updateMessage(id: string, patch: Partial<Pick<ChatMessage, "text" | "huddle" | "outbound" | "previews">>, opts: { edited?: boolean } = {}): ChatMessage {
  const row = messageRow(id);
  if (!row) throw new HttpError(404, "no such message");
  const extra = parse<MessageExtra>(row.extra_json, {});
  if (patch.huddle !== undefined) extra.huddle = patch.huddle;
  if (patch.outbound !== undefined) extra.outbound = patch.outbound;
  const text = patch.text !== undefined ? patch.text.slice(0, CHAT_TEXT_MAX) : row.text;
  const mentions = patch.text !== undefined && row.type !== "system" ? resolveMentions(text) : parse<string[]>(row.mentions_json, []);
  const previews = patch.previews !== undefined ? JSON.stringify(patch.previews) : patch.text !== undefined && patch.text !== row.text ? null : row.previews_json;
  run(
    "update chat_messages set text = ?, mentions_json = ?, extra_json = ?, previews_json = ?, edited_at = ?, updated_at = ? where id = ?",
    text, JSON.stringify(mentions), Object.keys(extra).length ? JSON.stringify(extra) : null, previews, opts.edited ? Date.now() : row.edited_at, Date.now(), id,
  );
  const now = messageRow(id)!;
  if (patch.text !== undefined) indexMessage(now, channelRow(now.channel_id)!);
  const message = toMessage(now);
  publish({ t: "message-changed", message }, { channel: now.channel_id });
  if (patch.text !== undefined && patch.text !== row.text && now.type === "text") queuePreviews(message);
  return message;
}

/** remove a message: the row stays (deletedAt), its text and files leave what's sent and search; files stay archived */
export function removeMessage(id: string): ChatMessage {
  const row = messageRow(id);
  if (!row) throw new HttpError(404, "no such message");
  if (row.deleted_at === null) {
    run("update chat_messages set deleted_at = ?, pinned = 0, updated_at = ? where id = ?", Date.now(), Date.now(), id);
    unindexDoc("chat", id);
    if (row.root_id) recountThread(row.root_id);
  }
  const message = getMessage(id)!;
  publish({ t: "message-changed", message }, { channel: row.channel_id });
  if (row.root_id) publish({ t: "message-changed", message: getMessage(row.root_id)! }, { channel: row.channel_id });
  if (row.pinned) publish({ t: "channel", channel: getChannel(row.channel_id)! }, { channel: row.channel_id });
  return message;
}

export function react(id: string, party: ChatParty, emoji: string, on: boolean): ChatMessage {
  const row = messageRow(id);
  if (!row) throw new HttpError(404, "no such message");
  if (row.deleted_at !== null) throw new HttpError(409, "that message was removed");
  const e = emoji.trim().slice(0, 64);
  if (!e) throw new HttpError(400, "which emoji?");
  if (on) run("insert or ignore into chat_reactions (message_id, emoji, party_kind, party_id, name, at) values (?, ?, ?, ?, ?, ?)", id, e, party.kind, party.id, party.name, Date.now());
  else run("delete from chat_reactions where message_id = ? and emoji = ? and party_kind = ? and party_id = ?", id, e, party.kind, party.id);
  run("update chat_messages set updated_at = ? where id = ?", Date.now(), id);
  const message = getMessage(id)!;
  publish({ t: "message-changed", message }, { channel: row.channel_id });
  return message;
}

export function pin(id: string, by: ChatParty, on: boolean): ChatMessage {
  const row = messageRow(id);
  if (!row) throw new HttpError(404, "no such message");
  if (row.deleted_at !== null) throw new HttpError(409, "that message was removed");
  if (Boolean(row.pinned) !== on) {
    run("update chat_messages set pinned = ?, updated_at = ? where id = ?", on ? 1 : 0, Date.now(), id);
    if (on) postMessage(row.channel_id, SYSTEM_PARTY, { type: "system", text: `${by.name} pinned a message.` });
    publish({ t: "channel", channel: getChannel(row.channel_id)! }, { channel: row.channel_id });
  }
  const message = getMessage(id)!;
  publish({ t: "message-changed", message }, { channel: row.channel_id });
  return message;
}

/**
 * A page of messages, oldest first. Without `root`: the channel's own messages (thread replies stay in
 * their thread). With `root`: that thread, its first message always first. `before`/`after`/`around` are
 * seqs; `since` (ms) is what was made or changed since then (catching up after a reconnect).
 */
export function pageMessages(channelId: string, q: { before?: number; after?: number; around?: number; since?: number; root?: string; limit?: number } = {}): ChatPage {
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
  const where = q.root ? "channel_id = ? and (id = ? or root_id = ?)" : "channel_id = ? and root_id is null";
  const args: unknown[] = q.root ? [channelId, q.root, q.root] : [channelId];
  const sel = (cond: string, order: "asc" | "desc", n: number, ...more: unknown[]) => all<MessageRow>(`select * from chat_messages where ${where} and ${cond} order by seq ${order} limit ?`, ...args, ...more, n);
  const exists = (cond: string, ...more: unknown[]) => Boolean(one(`select 1 from chat_messages where ${where} and ${cond} limit 1`, ...args, ...more));
  let rows: MessageRow[];
  let before = false;
  let after = false;
  if (q.since !== undefined) {
    rows = sel("updated_at > ?", "asc", limit + 1, q.since);
    after = rows.length > limit;
    rows = rows.slice(0, limit);
  } else if (q.after !== undefined) {
    rows = sel("seq > ?", "asc", limit + 1, q.after);
    after = rows.length > limit;
    rows = rows.slice(0, limit);
    before = exists("seq <= ?", q.after);
  } else if (q.before !== undefined) {
    rows = sel("seq < ?", "desc", limit + 1, q.before);
    before = rows.length > limit;
    rows = rows.slice(0, limit).reverse();
    after = exists("seq >= ?", q.before);
  } else if (q.around !== undefined) {
    const half = Math.floor(limit / 2);
    const older = sel("seq < ?", "desc", half + 1, q.around);
    const newer = sel("seq >= ?", "asc", limit - half + 1, q.around);
    before = older.length > half;
    after = newer.length > limit - half;
    rows = [...older.slice(0, half).reverse(), ...newer.slice(0, limit - half)];
  } else {
    rows = sel("1 = 1", "desc", limit + 1);
    before = rows.length > limit;
    rows = rows.slice(0, limit).reverse();
  }
  if (q.root && !rows.some((r) => r.id === q.root) && q.since === undefined) {
    const root = messageRow(q.root);
    if (root && root.channel_id === channelId && root.root_id === null) rows = [root, ...rows];
  }
  return { messages: toMessages(rows), before, after };
}

/** move a member's read mark (below the newest is "mark unread from here"); their mentions are counted again */
export function setRead(channelId: string, userId: string, seq: number): ChatMembership | null {
  const ch = channelRow(channelId);
  const m = memberRow(channelId, { kind: "person", id: userId });
  if (!ch || !m) return null;
  const readSeq = Math.max(0, Math.min(ch.last_seq, Math.floor(seq)));
  const mentions = recountMentions(channelId, { ...m, read_seq: readSeq });
  run("update chat_members set read_seq = ?, mentions = ? where channel_id = ? and party_kind = 'person' and party_id = ?", readSeq, mentions, channelId, userId);
  publish({ t: "read", channel: channelId, readSeq, mentions }, { users: [userId] });
  return membershipOf(memberRow(channelId, { kind: "person", id: userId }));
}

// ---------- files ----------

/** may this person open a chat upload: they uploaded it, or they can see a message (not removed) that carries it */
export function canSeeChatFile(user: UserInfo, fileId: string): boolean {
  const f = one<{ uploaded_by: string | null; board_id: string | null }>("select uploaded_by, board_id from files where id = ?", fileId);
  if (!f) return false;
  if (f.board_id !== CHAT_BOARD) return true;
  if (f.uploaded_by && f.uploaded_by === user.id) return true;
  const carriers = all<{ channel_id: string }>(
    "select distinct cf.channel_id from chat_files cf join chat_messages m on m.id = cf.message_id where cf.file_id = ? and m.deleted_at is null",
    fileId,
  );
  return carriers.some((c) => {
    const ch = channelRow(c.channel_id);
    return Boolean(ch && canSeeChannel(user, ch));
  });
}

/** files a person may put on a message: their own chat uploads, chat files they can already see, files of boards they can see */
function requireAttachable(user: UserInfo, ids: unknown): string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new HttpError(400, "files: a list of file ids");
  if (ids.length > CHAT_FILES_MAX) throw new HttpError(400, `at most ${CHAT_FILES_MAX} files on a message`);
  for (const id of ids as string[]) {
    const f = one<{ board_id: string | null }>("select board_id from files where id = ?", id);
    const ok = f && (f.board_id === CHAT_BOARD ? canSeeChatFile(user, id) : !f.board_id || canSeeBoard(user, f.board_id));
    if (!ok) throw new HttpError(400, `no such file: ${id} (upload it first: POST /api/files?board=chat)`);
  }
  return ids as string[];
}

// ---------- link previews ----------

const PREVIEW_TIMEOUT_MS = 3000;
const PREVIEW_MAX_BYTES = 512 * 1024;

/** on unless FOUNDATION_CHAT_PREVIEWS=0; off under `node --test` unless a test sets FOUNDATION_CHAT_PREVIEWS=1 */
export function previewsOn(): boolean {
  const v = process.env.FOUNDATION_CHAT_PREVIEWS;
  if (v === "0" || v === "off") return false;
  if (v === "1" || v === "on") return true;
  return !process.env.NODE_TEST_CONTEXT;
}
/** a test's stand-in site is on loopback: allowed only with FOUNDATION_CHAT_PREVIEWS_LOOPBACK=1 *and* under the test runner */
const loopbackAllowed = () => process.env.FOUNDATION_CHAT_PREVIEWS_LOOPBACK === "1" && Boolean(process.env.NODE_TEST_CONTEXT);

function v4Public(o: number[]): boolean {
  const [a, b, c] = o;
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const o = tail.slice(1).map(Number);
    s = `${s.slice(0, tail.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = rest === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** an address on the public internet (not private, loopback, link-local, multicast, reserved, or one of those wrapped in IPv6) */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Public(ip.split(".").map(Number));
  const g = v6Groups(ip);
  if (!g) return false;
  const v4of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Public(v4of(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::, ::1, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Public(v4of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4Public(v4of(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // Teredo, benchmarking, ORCHID
  return true;
}

function addressAllowed(ip: string): boolean {
  if (isPublicAddress(ip)) return true;
  if (!loopbackAllowed()) return false;
  const g = isIP(ip) === 6 ? v6Groups(ip) : null;
  return /^127\./.test(ip) || Boolean(g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1);
}

/** DNS for the preview fetcher: every address a name resolves to must be allowed, and the connection uses one of those */
function safeLookup(hostname: string, options: { all?: boolean; family?: number | string }, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { all: true, family: typeof options.family === "number" ? options.family : 0 }, (err, addrs) => {
    if (err) return cb(err, "", 0);
    if (!addrs.length || addrs.some((a) => !addressAllowed(a.address))) return cb(Object.assign(new Error(`${hostname} is not a public address`), { code: "EBLOCKED" }), "", 0);
    if (options.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

function getOnce(url: URL, deadline: number): Promise<{ status: number; location?: string; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !addressAllowed(host)) return reject(new Error("not a public address"));
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(
      url,
      { lookup: safeLookup as never, headers: { "user-agent": "ChatForm link preview", accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, type, body: "" });
        }
        if (status !== 200 || !/html/i.test(type)) {
          res.destroy();
          return resolve({ status, type, body: "" });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => resolve({ status, type, body: Buffer.concat(chunks).toString("utf8") });
        res.on("data", (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size >= PREVIEW_MAX_BYTES) {
            res.destroy();
            done();
          }
        });
        res.on("end", done);
        res.on("error", () => done());
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("timed out")), Math.max(1, deadline - Date.now()));
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on("close", () => clearTimeout(timer));
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function parseOpenGraph(html: string, url: URL): ChatLinkPreview | null {
  const meta = new Map<string, string>();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs.set(a[1].toLowerCase(), a[3] ?? a[4] ?? a[5] ?? "");
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decodeEntities(content).trim());
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = meta.get("og:title") || meta.get("twitter:title") || (titleTag ? decodeEntities(titleTag).replace(/\s+/g, " ").trim() : "");
  const description = meta.get("og:description") || meta.get("twitter:description") || meta.get("description") || "";
  if (!title && !description) return null;
  let image: string | undefined;
  const rawImage = meta.get("og:image") || meta.get("twitter:image");
  if (rawImage) {
    try {
      const u = new URL(rawImage, url);
      if (u.protocol === "https:" || u.protocol === "http:") image = u.toString();
    } catch {
      /* no picture */
    }
  }
  return {
    url: url.toString(),
    ...(title ? { title: title.slice(0, 200) } : {}),
    ...(description ? { description: description.slice(0, 400) } : {}),
    ...(image ? { image } : {}),
    site: (meta.get("og:site_name") || url.hostname).slice(0, 80),
  };
}

/** fetch one link's OpenGraph: http(s) only, public addresses only (every hop), 3 s, 512 KB */
export async function linkPreview(raw: string): Promise<ChatLinkPreview | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
  for (let hop = 0; hop < 4; hop++) {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    const res = await getOnce(url, deadline);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      continue;
    }
    if (res.status !== 200 || !res.body) return null;
    const p = parseOpenGraph(res.body, url);
    return p ? { ...p, url: raw } : null;
  }
  return null;
}

/** the first three http(s) links of a text, outside code */
export function linksIn(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const out: string[] = [];
  for (const m of plain.matchAll(/https?:\/\/[^\s<>()"'`[\]]+/g)) {
    const u = m[0].replace(/[.,;:!?*_~]+$/, "");
    if (!out.includes(u)) out.push(u);
    if (out.length >= 3) break;
  }
  return out;
}

function queuePreviews(m: ChatMessage) {
  if (!previewsOn()) return;
  const urls = linksIn(m.text);
  if (!urls.length) return;
  void Promise.all(urls.map((u) => linkPreview(u).catch(() => null))).then((got) => {
    const previews = got.filter((p): p is ChatLinkPreview => Boolean(p));
    if (!previews.length) return;
    const now = messageRow(m.id);
    if (!now || now.deleted_at !== null || now.text !== m.text) return;
    try {
      updateMessage(m.id, { previews });
    } catch {
      /* gone meanwhile */
    }
  });
}

// ---------- search, unread, Today ----------

function ftsMatch(words: string): string {
  const parts: string[] = [];
  for (const m of words.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (m[1] !== undefined) {
      const phrase = m[1].replace(/["*^:()]/g, " ").trim();
      if (phrase) parts.push(`"${phrase}"`);
    } else {
      for (const t of m[2].toLowerCase().replace(/["'()*:^]/g, " ").split(/\s+/).filter(Boolean)) parts.push(`"${t}"*`);
    }
  }
  return parts.slice(0, 12).join(" ");
}

const markSnippet = (snip: string) => snip.replace(/[«»]/g, '"').replace(/\s+/g, " ").replace(/\x02/g, "«").replace(/\x03/g, "»").trim();

export interface ChatSearchHit {
  message: ChatMessage;
  channel: { id: string; name: string; kind: ChatChannelKind };
  snippet: string;
}

/** a visibility check that remembers its answers for one request */
function seer(user: UserInfo) {
  const cache = new Map<string, ChannelRow | null>();
  return (channelId: string): ChannelRow | null => {
    if (!cache.has(channelId)) {
      const ch = channelRow(channelId);
      cache.set(channelId, ch && canSeeChannel(user, ch) ? ch : null);
    }
    return cache.get(channelId)!;
  };
}

/** `from:ada in:general before:2026-11-01 has:file "exact words" rest`, only where the person may read */
export function searchChat(user: UserInfo, q: string, limit = 50): ChatSearchHit[] {
  const query = parseChatQuery(q);
  const sees = seer(user);
  const snippets = new Map<string, string>();
  let rows: MessageRow[];
  if (query.words) {
    const match = ftsMatch(query.words);
    if (!match) return [];
    const hits = all<{ ref: string; snip: string }>(
      "select ref, snippet(search_fts, 4, char(2), char(3), '…', 16) as snip from search_fts where search_fts match ? and source = 'chat' order by bm25(search_fts, 0, 0, 0, 4, 1) limit 1000",
      match,
    );
    for (const h of hits) snippets.set(h.ref, markSnippet(h.snip));
    rows = [];
    const ids = hits.map((h) => h.ref);
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      rows.push(...all<MessageRow>(`select * from chat_messages where id in (${chunk.map(() => "?").join(",")})`, ...chunk));
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  } else {
    if (!query.from && !query.in && !query.has && query.before === undefined && query.after === undefined) return [];
    rows = all<MessageRow>("select * from chat_messages where deleted_at is null and type != 'system' order by created_at desc limit 5000");
  }
  let fromIds: Set<string> | null = null;
  if (query.from) {
    const f = query.from;
    fromIds = new Set(
      usersForMentions()
        .filter((u) => u.id === f || chatHandle(u.name) === f || u.email.split("@")[0].toLowerCase() === f || u.name.trim().split(/\s+/)[0]?.toLowerCase() === f || u.name.toLowerCase() === f)
        .map((u) => u.id),
    );
  }
  const out: ChatSearchHit[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (r.deleted_at !== null || r.type === "system") continue;
    const ch = sees(r.channel_id);
    if (!ch) continue;
    if (query.from) {
      const a = parse<ChatParty>(r.author_json, SYSTEM_PARTY);
      const byPerson = a.kind === "person" && fromIds!.has(a.id);
      const byName = a.kind !== "person" && (chatHandle(a.name) === query.from || a.name.toLowerCase() === query.from);
      if (!byPerson && !byName) continue;
    }
    if (query.in) {
      const want = query.in.replace(/^@/, "");
      const named = ch.name.toLowerCase() === want;
      const withSomeone = !ch.name && memberRows(ch.id).some((m) => chatHandle(m.name) === want || m.party_id === want);
      if (!named && !withSomeone) continue;
    }
    if (query.before !== undefined && r.created_at >= query.before) continue;
    if (query.after !== undefined && r.created_at <= query.after) continue;
    if (query.has === "file" && parse<ChatFile[]>(r.files_json, []).length === 0) continue;
    if (query.has === "link" && !/https?:\/\//.test(r.text)) continue;
    if (query.has === "pin" && !r.pinned) continue;
    out.push({
      message: toMessage(r),
      channel: { id: ch.id, name: ch.kind === "open" || ch.kind === "private" ? ch.name : channelLabel(ch), kind: ch.kind },
      snippet: snippets.get(r.id) ?? r.text.replace(/\s+/g, " ").slice(0, 200),
    });
  }
  return out;
}

/**
 * For ⌘K (search.ts): a test of a chat search row by its message id, for this person; answers the
 * channel id to open, or null when they may not read it. Without a person, nothing in chat is shown.
 */
export function chatHitFilter(userId: string | undefined): (messageId: string) => string | null {
  if (!userId) return () => null;
  const user = one<UserInfo>("select id, email, name, color, role from users where id = ?", userId);
  if (!user) return () => null;
  const sees = seer(user);
  return (messageId) => {
    const m = one<{ channel_id: string; deleted_at: number | null }>("select channel_id, deleted_at from chat_messages where id = ?", messageId);
    if (!m || m.deleted_at !== null) return null;
    return sees(m.channel_id) ? m.channel_id : null;
  };
}

export function unreadsFor(user: UserInfo): { total: number; mentions: number; channels: Array<{ id: string; unread: number; mentions: number }> } {
  const rows = all<MemberRow & { last_seq: number; archived_at: number | null }>(
    "select m.*, c.last_seq, c.archived_at from chat_members m join chat_channels c on c.id = m.channel_id where m.party_kind = 'person' and m.party_id = ?",
    user.id,
  );
  const channels: Array<{ id: string; unread: number; mentions: number }> = [];
  let total = 0;
  let mentions = 0;
  for (const r of rows) {
    if (r.archived_at) continue;
    const unread = chatUnread(r.last_seq, { readSeq: r.read_seq, mentions: r.mentions, notify: r.notify });
    if (!unread && !r.mentions) continue;
    channels.push({ id: r.channel_id, unread, mentions: r.mentions });
    total += unread;
    mentions += r.mentions;
  }
  return { total, mentions, channels };
}

/** Today's focus (today.ts): kind "message", one per channel with mentions of them, or a dm or group with unread */
export function chatFocus(user: UserInfo, now = Date.now()) {
  const rows = all<MemberRow & { kind: ChatChannelKind; last_seq: number; last_post_at: number; last_text: string | null; archived_at: number | null }>(
    "select m.*, c.kind, c.last_seq, c.last_post_at, c.last_text, c.archived_at from chat_members m join chat_channels c on c.id = m.channel_id where m.party_kind = 'person' and m.party_id = ?",
    user.id,
  );
  const items: Array<{ id: string; kind: "message"; title: string; why: string; board: string; boardName: string; href: string; at: number; tone?: "agent" }> = [];
  for (const r of rows) {
    if (r.archived_at || r.notify === "none") continue;
    const direct = r.kind === "dm" || r.kind === "group" || r.kind === "agent";
    const unread = Math.max(0, r.last_seq - r.read_seq);
    if (!(r.mentions > 0 || (direct && unread > 0))) continue;
    const ch = channelRow(r.channel_id)!;
    const last = one<{ author_json: string }>("select author_json from chat_messages where channel_id = ? and type != 'system' and deleted_at is null order by seq desc limit 1", r.channel_id);
    const lastAuthor = last ? parse<ChatParty>(last.author_json, SYSTEM_PARTY) : null;
    const label = direct ? chatTitle(toChannel(ch), user.id) : `#${ch.name}`;
    const n = direct ? unread : r.mentions;
    const mins = Math.max(0, Math.round((now - r.last_post_at) / 60000));
    const when = mins < 2 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
    items.push({
      id: `message:${r.channel_id}`,
      kind: "message",
      title: r.last_text ?? label,
      why: `${direct ? `${n} new from ${label}` : `${n} mention${n === 1 ? "" : "s"} in ${label}`} · ${when}`,
      board: CHAT_BOARD,
      boardName: "ChatForm",
      href: `#/chat/chat/${r.channel_id}`,
      at: r.last_post_at,
      ...(lastAuthor?.kind === "agent" ? { tone: "agent" as const } : {}),
    });
  }
  return items;
}

// ---------- export ----------

export function exportChannel(channelId: string): { channel: ChatChannel; exportedAt: number; messages: ChatMessage[] } {
  const channel = getChannel(channelId);
  if (!channel) throw new HttpError(404, "no such channel");
  const rows = all<MessageRow>("select * from chat_messages where channel_id = ? order by seq", channelId);
  return { channel, exportedAt: Date.now(), messages: toMessages(rows) };
}

export function exportMarkdown(data: ReturnType<typeof exportChannel>): string {
  const c = data.channel;
  const title = c.kind === "open" || c.kind === "private" ? `#${c.name}` : chatTitle(c);
  const iso = (t: number) => new Date(t).toISOString();
  const lines = [`# ${title}`, ""];
  if (c.topic) lines.push(`> ${c.topic}`, "");
  if (c.purpose) lines.push(c.purpose, "");
  lines.push(`Exported from ChatForm ${iso(data.exportedAt)} · ${data.messages.length} messages`, "");
  const replies = new Map<string, ChatMessage[]>();
  for (const m of data.messages) if (m.root) replies.set(m.root, [...(replies.get(m.root) ?? []), m]);
  const who = (m: ChatMessage) => `${m.author.name}${m.author.kind === "agent" ? ` (agent${m.author.forName ? `, for ${m.author.forName}` : ""})` : m.author.kind === "ghost" ? ` (${m.author.service})` : ""}`;
  const body = (m: ChatMessage, indent: string) => {
    const out: string[] = [];
    if (m.deletedAt) out.push(`${indent}_(removed)_`);
    else {
      if (m.text) out.push(...m.text.split("\n").map((l) => `${indent}${l}`));
      for (const f of m.files) out.push(`${indent}- 📎 [${f.name}](/files/${f.id}) (${f.mime}, ${f.size} bytes)`);
      if (m.place) out.push(`${indent}- 🔗 ${m.place.label} (board ${m.place.board})`);
      if (m.reactions.length) out.push(`${indent}${m.reactions.map((r) => `${r.emoji} ${r.by.join(", ")}`).join(" · ")}`);
    }
    return out;
  };
  let day = "";
  for (const m of data.messages) {
    if (m.root) continue;
    const d = iso(m.createdAt).slice(0, 10);
    if (d !== day) lines.push(`## ${(day = d)}`, "");
    if (m.type === "system") {
      lines.push(`_${iso(m.createdAt).slice(11, 16)} · ${m.text}_`, "");
      continue;
    }
    lines.push(`**${who(m)}** · ${iso(m.createdAt).slice(11, 16)} UTC${m.editedAt ? " (edited)" : ""}${m.pinned ? " 📌" : ""}`, ...body(m, ""), "");
    for (const r of replies.get(m.id) ?? []) lines.push(`> **${who(r)}** · ${iso(r.createdAt).replace("T", " ").slice(0, 16)} UTC${r.editedAt ? " (edited)" : ""}`, ...body(r, "> "), "");
  }
  return lines.join("\n");
}

// ---------- HTTP ----------

const str = (v: unknown, max = 250) => (typeof v === "string" ? v.slice(0, max) : undefined);
const intParam = (v: string | null) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

function viewOrNull(user: UserInfo, id: string): ChatChannelView | null {
  const c = getChannel(id);
  return c && canSeeChannel(user, c) ? channelView(user, c) : null;
}

/** the parties a request names: user ids, or `agent:<name>` */
function partiesFrom(ids: unknown): ChatParty[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new HttpError(400, "members: a list of user ids");
  return (ids as string[]).map((id) => {
    if (id.startsWith("agent:")) return agentParty(id.slice(6));
    const u = one<UserInfo>("select id, email, name, color, role from users where id = ?", id);
    if (!u) throw new HttpError(400, `no such person: ${id}`);
    return personParty(u);
  });
}

/** the person a request works for, as a member: their own party (an agent's request still makes its person the member) */
function personOf(user: UserInfo): ChatParty {
  if (user.id === "agent") throw new HttpError(400, "the service token has no person: use a person's session or an agent bearer");
  return personParty(user);
}

function sameAuthor(m: ChatMessage, party: ChatParty) {
  return m.author.kind === party.kind && m.author.id === party.id && (party.kind !== "agent" || (m.author.forName ?? "") === (party.forName ?? ""));
}

function remembered(userId: string, requestId: unknown): string | null {
  if (typeof requestId !== "string" || !requestId) return null;
  return one<{ result: string }>("select result from chat_requests where user_id = ? and request_id = ?", userId, requestId)?.result ?? null;
}
function remember(userId: string, requestId: unknown, result: string) {
  if (typeof requestId === "string" && requestId) run("insert or ignore into chat_requests (user_id, request_id, result, at) values (?, ?, ?, ?)", userId, requestId.slice(0, 120), result, Date.now());
}

let agentsFromRuntimes = false;

export function chatRoutes(r: Router) {
  // the agents that can be talked to (Claude, T3's agents) join the ones chat has seen
  if (!agentsFromRuntimes) {
    agentsFromRuntimes = true;
    void import("./posted.ts")
      .then((p) => registerChatAgents(() => p.availableAgents().agents.map((a) => ({ name: a.name, via: a.key }))))
      .catch(() => undefined);
  }

  r.get("/api/chat", (req) => {
    const user = requireUser(req);
    if (isPerson(req)) autoJoinGeneral(user);
    else ensureGeneral();
    const channels = all<ChannelRow>("select * from chat_channels order by last_post_at desc")
      .filter((c) => canSeeChannel(user, c))
      .map((c) => channelView(user, toChannel(c)));
    const people = all<UserInfo>("select id, email, name, color, role from users order by name").map(personParty);
    return { channels, people, agents: knownAgents(), online: onlineUsers() };
  });

  r.post("/api/chat/channels", async (req) => {
    const body = await readJson<Record<string, unknown>>(req);
    const { user, party } = requestParty(req, body);
    if (isViewer(user)) throw new HttpError(403, "View only: your account can't make channels");
    const again = remembered(user.id, body.request_id);
    if (again) return { channel: viewOrNull(user, again) };
    const kind = body.kind as ChatChannelKind;
    let ch: ChatChannel;
    if (kind === "dm" || kind === "group") {
      const others = partiesFrom(body.members);
      ch = openDirect([personOf(user), ...others]);
    } else if (kind === "open" || kind === "private") {
      const name = chatSlug(str(body.name, 200) ?? "");
      if (!name) throw new HttpError(400, "a channel needs a name");
      if (one("select 1 from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null", name)) throw new HttpError(409, `#${name} is taken`);
      // an agent's request makes the channel for its person (they are its maker and first member)
      ch = createChannel(user.id === "agent" ? party : personParty(user), { kind, name, topic: str(body.topic), purpose: str(body.purpose), members: partiesFrom(body.members) });
    } else if (kind === "agent") {
      const a = body.agent as ChatAgentRef | undefined;
      const name = cleanAgentName(a?.name);
      if (!name) throw new HttpError(400, "which agent? (agent: { name, via? })");
      const agent: ChatAgentRef = { name, ...(str(a?.via, 80) ? { via: str(a?.via, 80) } : {}), ...(str(a?.session, 200) ? { session: str(a?.session, 200) } : {}) };
      ch = createChannel(personOf(user), { kind: "agent", name: str(body.name, 120), topic: str(body.topic), purpose: str(body.purpose), agent, members: [agentParty(agent.name, agent.via), ...partiesFrom(body.members)] });
    } else if (kind === "portal") {
      throw new HttpError(400, "portals are made by bridges, not by hand");
    } else throw new HttpError(400, "kind: open, private, dm, group or agent");
    remember(user.id, body.request_id, ch.id);
    return { channel: channelView(user, ch) };
  });

  r.get("/api/chat/channels/:id", (req) => {
    const user = requireUser(req);
    return { channel: channelView(user, requireChannel(user, req.params.id)) };
  });

  r.post("/api/chat/channels/:id", async (req) => {
    const body = await readJson<Record<string, unknown>>(req);
    const { user, party } = requestParty(req, body);
    const c = requireChannel(user, req.params.id);
    const member = isMemberUser(c.id, user);
    if (body.notify !== undefined || body.starred !== undefined) {
      if (!member) throw new HttpError(403, "join this channel first");
      if (body.notify !== undefined && !["all", "mentions", "none"].includes(body.notify as string)) throw new HttpError(400, "notify: all, mentions or none");
      const who = user.id === "agent" ? { kind: "agent", id: "Foundation Agent" } : { kind: "person", id: user.id };
      if (body.notify !== undefined) run("update chat_members set notify = ? where channel_id = ? and party_kind = ? and party_id = ?", body.notify, c.id, who.kind, who.id);
      if (body.starred !== undefined) run("update chat_members set starred = ? where channel_id = ? and party_kind = ? and party_id = ?", body.starred ? 1 : 0, c.id, who.kind, who.id);
    }
    const changes = body.name !== undefined || body.topic !== undefined || body.purpose !== undefined;
    if (changes) {
      if (isViewer(user)) throw new HttpError(403, "View only: your account can't change a channel");
      if (c.archivedAt) throw new HttpError(409, "this channel is archived");
      if (!member) throw new HttpError(403, "join this channel first");
      if (body.name !== undefined) {
        if (c.kind !== "open" && c.kind !== "private") throw new HttpError(400, "only channels have names");
        if (c.createdBy !== user.id && !(user.role === "admin" && isPerson(req))) throw new HttpError(403, "only the channel's maker or an admin renames it");
        const name = chatSlug(str(body.name, 200) ?? "");
        if (!name) throw new HttpError(400, "a channel needs a name");
        if (name !== c.name) {
          if (one("select 1 from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null and id != ?", name, c.id)) throw new HttpError(409, `#${name} is taken`);
          run("update chat_channels set name = ? where id = ?", name, c.id);
          postMessage(c.id, SYSTEM_PARTY, { type: "system", text: `${party.name} renamed the channel to #${name}.` });
        }
      }
      if (body.topic !== undefined && str(body.topic) !== c.topic) {
        run("update chat_channels set topic = ? where id = ?", str(body.topic) ?? "", c.id);
        postMessage(c.id, SYSTEM_PARTY, { type: "system", text: str(body.topic) ? `${party.name} set the topic: ${str(body.topic)}` : `${party.name} cleared the topic.` });
      }
      if (body.purpose !== undefined && str(body.purpose) !== c.purpose) run("update chat_channels set purpose = ? where id = ?", str(body.purpose) ?? "", c.id);
      publish({ t: "channel", channel: getChannel(c.id)! }, { channel: c.id });
    }
    return { channel: channelView(user, getChannel(c.id)!) };
  });

  r.post("/api/chat/channels/:id/join", (req) => {
    const user = requireUser(req);
    const c = requireChannel(user, req.params.id);
    if (!isMemberUser(c.id, user)) {
      if (c.kind !== "open") throw new HttpError(403, "a member has to add you");
      if (isViewer(user)) throw new HttpError(403, "View only: a member has to add you");
      if (c.archivedAt) throw new HttpError(409, "this channel is archived");
      addMember(c.id, user.id === "agent" ? agentParty("Foundation Agent") : personParty(user));
    }
    return { channel: channelView(user, getChannel(c.id)!) };
  });

  r.post("/api/chat/channels/:id/leave", (req) => {
    const user = requireUser(req);
    const c = requireChannel(user, req.params.id);
    if (c.kind === "dm" || c.kind === "group") throw new HttpError(400, "a direct message can't be left");
    const me = user.id === "agent" ? agentParty("Foundation Agent") : personParty(user);
    removeMember(c.id, me);
    return { channel: viewOrNull(user, c.id) };
  });

  r.post("/api/chat/channels/:id/members", async (req) => {
    const body = await readJson<{ add?: unknown; remove?: unknown }>(req);
    const user = requireUser(req);
    const c = requireChannel(user, req.params.id);
    if (isViewer(user)) throw new HttpError(403, "View only: your account can't change who's in a channel");
    if (c.archivedAt) throw new HttpError(409, "this channel is archived");
    if (!isMemberUser(c.id, user)) throw new HttpError(403, "join this channel first");
    if (c.kind === "dm" || c.kind === "group") throw new HttpError(400, "a direct message keeps its people: start a new one");
    const adding = partiesFrom(body.add);
    const removing = partiesFrom(body.remove);
    const mayRemoveOthers = c.createdBy === user.id || (user.role === "admin" && isPerson(req));
    for (const p of removing) if (!(p.kind === "person" && p.id === user.id) && !mayRemoveOthers) throw new HttpError(403, "only the channel's maker or an admin removes people");
    for (const p of adding) addMember(c.id, p);
    for (const p of removing) removeMember(c.id, p);
    return { channel: viewOrNull(user, c.id) };
  });

  r.post("/api/chat/channels/:id/archive", async (req) => {
    const body = await readJson<{ confirm?: unknown }>(req);
    const { user, party, person } = requestParty(req, body as { as?: unknown });
    const c = requireChannel(user, req.params.id);
    if (body.confirm !== true) throw new HttpError(400, "archiving a channel needs confirm: true");
    if (!person || (c.createdBy !== user.id && user.role !== "admin")) throw new HttpError(403, "only the channel's maker or an admin archives it");
    if (!c.archivedAt) {
      postMessage(c.id, SYSTEM_PARTY, { type: "system", text: `${party.name} archived the channel.` });
      run("update chat_channels set archived_at = ? where id = ?", Date.now(), c.id);
      publish({ t: "channel", channel: getChannel(c.id)! }, { channel: c.id });
    }
    return { channel: channelView(user, getChannel(c.id)!) };
  });

  r.get("/api/chat/channels/:id/messages", (req) => {
    const user = requireUser(req);
    const c = requireChannel(user, req.params.id);
    const q = req.query;
    return pageMessages(c.id, {
      before: intParam(q.get("before")),
      after: intParam(q.get("after")),
      around: intParam(q.get("around")),
      since: intParam(q.get("since")),
      root: q.get("root") || undefined,
      limit: intParam(q.get("limit")),
    });
  });

  r.post("/api/chat/channels/:id/messages", async (req) => {
    const body = await readJson<Record<string, unknown>>(req);
    const { user, party } = requestParty(req, body);
    const c = requireChannel(user, req.params.id);
    requireWritable(user, c);
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > CHAT_TEXT_MAX) throw new HttpError(400, `a message holds at most ${CHAT_TEXT_MAX} characters`);
    const files = requireAttachable(user, body.files);
    let place: ChatMessage["place"] | undefined;
    if (body.place && typeof body.place === "object") {
      const p = body.place as Record<string, unknown>;
      const board = str(p.board, 64);
      if (!board || !canSeeBoard(user, board)) throw new HttpError(400, "no such board");
      place = { board, label: str(p.label, 200) || board, ...(str(p.boardName, 120) ? { boardName: str(p.boardName, 120) } : {}), ...(str(p.section, 64) ? { section: str(p.section, 64) } : {}), ...(str(p.object, 64) ? { object: str(p.object, 64) } : {}) };
    }
    const message = postMessage(c.id, party, { text, files, root: str(body.root, 64) ?? null, requestId: str(body.request_id, 120), place });
    return { message };
  });

  r.post("/api/chat/channels/:id/read", async (req) => {
    const body = await readJson<{ seq?: unknown }>(req);
    const user = requireUser(req);
    const c = requireChannel(user, req.params.id);
    const seq = typeof body.seq === "number" ? body.seq : c.lastSeq;
    return { me: setRead(c.id, user.id, seq) };
  });

  r.get("/api/chat/channels/:id/export", (req, res: ServerResponse) => {
    const user = requireUser(req);
    const c = requireChannel(user, req.params.id);
    const data = exportChannel(c.id);
    const md = req.query.get("format") === "md";
    const base = `${c.kind === "open" || c.kind === "private" ? c.name : chatSlug(chatTitle(c, user.id)) || "conversation"}-${new Date(data.exportedAt).toISOString().slice(0, 10)}`;
    const out = md ? exportMarkdown(data) : JSON.stringify(data, null, 2);
    res.writeHead(200, {
      "content-type": md ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${base}.${md ? "md" : "json"}"`,
      "content-length": Buffer.byteLength(out),
    });
    res.end(out);
  });

  r.post("/api/chat/messages/:id", async (req) => {
    const body = await readJson<Record<string, unknown>>(req);
    const { user, party } = requestParty(req, body);
    const m = getMessage(req.params.id);
    if (!m) throw new HttpError(404, "no such message");
    const c = requireChannel(user, m.channel);
    if (!sameAuthor(m, party)) throw new HttpError(403, "only its author edits a message");
    if (m.deletedAt) throw new HttpError(409, "that message was removed");
    if (c.archivedAt) throw new HttpError(409, "this channel is archived");
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim() && !m.files.length) throw new HttpError(400, "say something (or remove the message)");
    if (text.length > CHAT_TEXT_MAX) throw new HttpError(400, `a message holds at most ${CHAT_TEXT_MAX} characters`);
    if (text === m.text) return { message: m };
    return { message: updateMessage(m.id, { text }, { edited: true }) };
  });

  r.delete("/api/chat/messages/:id", async (req) => {
    const body = await readJson<Record<string, unknown>>(req);
    const { user, party, person } = requestParty(req, body);
    const m = getMessage(req.params.id);
    if (!m) throw new HttpError(404, "no such message");
    requireChannel(user, m.channel);
    if (body.confirm !== true && req.query.get("confirm") !== "true") throw new HttpError(400, "removing a message needs confirm: true");
    const admin = person && user.role === "admin";
    if (!sameAuthor(m, party) && !admin) throw new HttpError(403, party.kind === "agent" ? "an agent removes only its own messages" : "only its author or an admin removes a message");
    return { message: removeMessage(m.id) };
  });

  r.post("/api/chat/messages/:id/react", async (req) => {
    const body = await readJson<Record<string, unknown>>(req);
    const { user, party } = requestParty(req, body);
    const m = getMessage(req.params.id);
    if (!m) throw new HttpError(404, "no such message");
    const c = requireChannel(user, m.channel);
    requireWritable(user, c);
    if (typeof body.emoji !== "string") throw new HttpError(400, "which emoji?");
    if (c.kind === "open" && (party.kind === "person" || party.kind === "agent") && !memberRow(c.id, party)) addMember(c.id, party);
    return { message: react(m.id, party, body.emoji, body.on !== false) };
  });

  r.post("/api/chat/messages/:id/pin", async (req) => {
    const body = await readJson<Record<string, unknown>>(req);
    const { user, party } = requestParty(req, body);
    const m = getMessage(req.params.id);
    if (!m) throw new HttpError(404, "no such message");
    const c = requireChannel(user, m.channel);
    requireWritable(user, c);
    if (!isMemberUser(c.id, user)) throw new HttpError(403, "join this channel first");
    return { message: pin(m.id, party, body.on !== false) };
  });

  r.get("/api/chat/search", (req) => {
    const user = requireUser(req);
    const q = (req.query.get("q") ?? "").trim();
    return { hits: q ? searchChat(user, q, Math.min(100, intParam(req.query.get("limit")) ?? 50)) : [] };
  });

  r.get("/api/chat/unreads", (req) => unreadsFor(requireUser(req)));

  /** the threads this person started or replied in, newest reply first */
  r.get("/api/chat/threads", (req) => {
    const user = requireUser(req);
    const sees = seer(user);
    const roots = all<MessageRow>(
      `select * from chat_messages where reply_count > 0 and deleted_at is null and root_id is null
         and (author_id = ? or id in (select root_id from chat_messages where author_id = ? and root_id is not null))
       order by last_reply_at desc limit 100`,
      user.id, user.id,
    );
    const threads: Array<{ root: ChatMessage; channel: { id: string; name: string; kind: ChatChannelKind } }> = [];
    for (const r of roots) {
      const ch = sees(r.channel_id);
      if (!ch) continue;
      threads.push({ root: toMessage(r), channel: { id: ch.id, name: ch.kind === "open" || ch.kind === "private" ? ch.name : channelLabel(ch), kind: ch.kind } });
      if (threads.length >= 50) break;
    }
    return { threads };
  });
}

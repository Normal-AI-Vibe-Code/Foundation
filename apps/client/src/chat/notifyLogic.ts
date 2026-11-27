/**
 * What was said to me, the pure part (chat/notify.ts keeps the list and tells this device; chat/Bell.tsx draws it).
 *
 * A **notice** is one message that concerns me: it names me, it says @channel or @here where I'm a member, or it
 * arrived in a direct message or a group I'm in. Never my own, never a removed one, never a system line, never an
 * agent's draft that no person has sent, never history brought in from elsewhere, and never from a conversation I
 * muted (its `notify` is `none`).
 *
 * **Seen** is kept on this device: everything up to a moment (Mark all read), the notices pressed one by one, and
 * anything my read mark in its channel has passed (so reading the channel anywhere clears its notices here).
 */

import type { ChatChannelKind, ChatChannelView, ChatMention, ChatMessage } from "@foundation/protocol";

export type NoticeWhy = "mention" | "everyone" | "direct";

export interface Notice {
  /** the message's id */
  id: string;
  message: ChatMessage;
  channel: { id: string; name: string; kind: ChatChannelKind };
  why: NoticeWhy;
}

type ChannelLike = Pick<ChatChannelView, "kind" | "me" | "archivedAt">;

/** a message older than this when it arrives is history being brought in, not something just said */
export const NOTICE_FRESH_MS = 5 * 60_000;

const isDirectKind = (k: ChatChannelKind) => k === "dm" || k === "group";

/**
 * Does a message that just arrived concern me, and how. `channel` is my view of where it was said (my membership
 * and how I asked to hear about it); without it nothing is told.
 */
export function noticeFor(m: ChatMessage, channel: ChannelLike | null | undefined, meId: string | undefined, now = Date.now()): NoticeWhy | null {
  if (!meId || !channel) return null;
  if (m.deletedAt || m.type === "system" || m.type === "draft") return null;
  // an agent's words for a bridged conversation are a draft until a person sends them
  if (m.outbound && m.outbound.state !== "sent") return null;
  if (m.author.kind === "system") return null;
  if (m.author.kind === "person" && m.author.id === meId) return null;
  // brought in from elsewhere (Slack's history), or old when it lands: not news
  if (m.origin?.service === "slack") return null;
  if (now - m.createdAt > NOTICE_FRESH_MS) return null;
  if (channel.archivedAt) return null;
  if (channel.me?.notify === "none") return null;
  if (m.mentions.includes(meId)) return "mention";
  if (!channel.me) return null;
  if (isDirectKind(channel.kind)) return "direct";
  if (m.mentions.includes("channel") || m.mentions.includes("here")) return "everyone";
  return null;
}

/** why a row of the server's list (`GET /api/chat/mentions`) is in it */
export function whyOf(x: ChatMention, meId: string | undefined): NoticeWhy {
  if (meId && x.message.mentions.includes(meId)) return "mention";
  return isDirectKind(x.channel.kind) ? "direct" : "everyone";
}

export const noticeOf = (x: ChatMention, meId: string | undefined): Notice => ({ id: x.message.id, message: x.message, channel: x.channel, why: whyOf(x, meId) });

const newestFirst = (a: Notice, b: Notice) => b.message.createdAt - a.message.createdAt || b.message.seq - a.message.seq;

/** the list with more in it: each message once (the newer copy wins), newest first, `cap` at most */
export function mergeNotices(list: Notice[], more: Notice[], cap = 100): Notice[] {
  const by = new Map<string, Notice>();
  for (const n of list) by.set(n.id, n);
  for (const n of more) by.set(n.id, n);
  return [...by.values()].sort(newestFirst).slice(0, cap);
}

/** a message changed: its notice follows (its words), or goes when the message was removed */
export function changeNotice(list: Notice[], m: ChatMessage): Notice[] {
  if (!list.some((n) => n.id === m.id)) return list;
  return m.deletedAt ? list.filter((n) => n.id !== m.id) : list.map((n) => (n.id === m.id ? { ...n, message: m } : n));
}

export const dropChannel = (list: Notice[], channel: string): Notice[] => (list.some((n) => n.channel.id === channel) ? list.filter((n) => n.channel.id !== channel) : list);

// ---------------------------------------------------------------- seen

export interface Seen {
  /** everything said up to this moment is seen (Mark all read) */
  allAt: number;
  /** notices pressed one by one since */
  ids: string[];
}

export const NOTHING_SEEN: Seen = { allAt: 0, ids: [] };
const SEEN_IDS_MAX = 300;

export function readSeen(raw: string | null | undefined): Seen {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Seen>) : null;
    if (!v || typeof v !== "object") return NOTHING_SEEN;
    return {
      allAt: typeof v.allAt === "number" && Number.isFinite(v.allAt) ? v.allAt : 0,
      ids: Array.isArray(v.ids) ? v.ids.filter((x): x is string => typeof x === "string").slice(-SEEN_IDS_MAX) : [],
    };
  } catch {
    return NOTHING_SEEN;
  }
}

type Channels = Record<string, Pick<ChatChannelView, "me"> | undefined>;

export function isSeen(n: Notice, seen: Seen, channels: Channels = {}): boolean {
  if (n.message.createdAt <= seen.allAt || seen.ids.includes(n.id)) return true;
  const me = channels[n.channel.id]?.me;
  return !!me && n.message.seq <= me.readSeq;
}

/** a muted conversation's notices stay in the list, and never count */
const isMuted = (n: Notice, channels: Channels) => channels[n.channel.id]?.me?.notify === "none";

/** how many the bell shows */
export function unseenCount(list: Notice[], seen: Seen, channels: Channels = {}): number {
  let n = 0;
  for (const x of list) if (!isSeen(x, seen, channels) && !isMuted(x, channels)) n++;
  return n;
}

export function markSeen(seen: Seen, id: string): Seen {
  if (seen.ids.includes(id)) return seen;
  return { allAt: seen.allAt, ids: [...seen.ids, id].slice(-SEEN_IDS_MAX) };
}

/** Mark all read: everything up to now, and up to the newest in the list (a clock that runs behind the server's) */
export function markAllSeen(list: Notice[], now = Date.now()): Seen {
  return { allAt: Math.max(now, ...list.map((n) => n.message.createdAt)), ids: [] };
}

// ---------------------------------------------------------------- telling this device

export type TellPermission = "granted" | "denied" | "default" | "unsupported";

/** am I looking at where it was said: this window has focus and that conversation (and, for a reply, its thread) is open */
export function lookingAt(m: Pick<ChatMessage, "channel" | "root">, open: { channel: string | null; thread: string | null }, focused: boolean): boolean {
  return focused && open.channel === m.channel && (!m.root || open.thread === m.root);
}

/** does this device show a desktop notification for it: the setting is on, the browser allows it, and I'm not looking at it */
export function tells(why: NoticeWhy | null, o: { on: boolean; permission: TellPermission; looking: boolean }): boolean {
  return !!why && o.on && o.permission === "granted" && !o.looking;
}

/**
 * Does this device sound the ping (chat/pingSound.ts): a mention of me or a direct message, while I'm not looking
 * at it. @channel and @here stay quiet (they're for everyone), and a muted conversation never gets here.
 */
export function sounds(why: NoticeWhy | null, o: { on: boolean; looking: boolean }): boolean {
  return (why === "mention" || why === "direct") && o.on && !o.looking;
}

/** a message's first line as plain words (no markdown marks), for a list row or a notification's body */
export function firstLine(m: Pick<ChatMessage, "text" | "files">, max = 140): string {
  const plain = m.text
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#]+/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  const line = plain || (m.files.length ? (m.files.length === 1 ? m.files[0].name : `${m.files.length} files`) : "");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** where it was said, as a person says it: `#general`, or the direct message's name */
export const whereWords = (c: { name: string; kind: ChatChannelKind }) => (c.kind === "open" || c.kind === "private" ? `#${c.name}` : c.name || "Direct message");

/** a desktop notification's two lines: who (and where, for a channel), then what */
export function tellWords(n: Notice): { title: string; body: string } {
  const who = n.message.author.name || "Someone";
  const title = n.why === "direct" && n.channel.kind === "dm" ? who : `${who} in ${whereWords(n.channel)}`;
  return { title, body: firstLine(n.message) };
}

/** what a row says about why it is here, beside who and where */
export const whyWords = (why: NoticeWhy) => (why === "mention" ? "mentioned you" : why === "everyone" ? "to everyone" : "");

// ---------------------------------------------------------------- without the server's list

export interface WaitingRow {
  channel: string;
  kind: ChatChannelKind;
  /** how many: unread in a direct message, mentions of me in a channel */
  n: number;
  why: "mention" | "direct";
  at: number;
  text: string;
}

/**
 * What the bell shows on a server with no list of what was said to me: the conversations with something waiting,
 * from the counts the store already has (mentions of me in channels, unread direct messages), newest first.
 */
export function waitingRows(channels: Iterable<ChatChannelView>): WaitingRow[] {
  const out: WaitingRow[] = [];
  for (const c of channels) {
    if (!c.me || c.archivedAt || c.me.notify === "none") continue;
    // as the top bar's badge counts them (logic `chatTotals`): a conversation with an agent is direct too
    const direct = c.kind === "dm" || c.kind === "group" || c.kind === "agent";
    const n = direct ? c.unread : c.me.mentions;
    if (n > 0) out.push({ channel: c.id, kind: c.kind, n, why: direct ? "direct" : "mention", at: c.lastPostAt, text: c.lastText ?? "" });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------- the count, as shown

export const countWords = (n: number) => (n > 99 ? "99+" : String(n));

/** the window's title with what's waiting in front: "(3) Foundation — Today"; none, and the title is as it was */
export function titleWithCount(title: string, n: number): string {
  const bare = title.replace(/^\(\d+\+?\)\s+/, "");
  return n > 0 ? `(${countWords(n)}) ${bare}` : bare;
}

/** @channel and @here reach everyone in a channel: over this many members, the composer asks first */
export const EVERYONE_ASKS_OVER = 5;

/** does sending this text need a yes first: it says @channel, @here, @everyone or @all (outside code) in a big channel */
export function everyoneAsk(text: string, channel: Pick<ChatChannelView, "kind" | "memberCount"> | null | undefined, handles: (text: string) => string[]): { word: string; people: number } | null {
  if (!channel || (channel.kind !== "open" && channel.kind !== "private")) return null;
  if (channel.memberCount <= EVERYONE_ASKS_OVER) return null;
  const word = handles(text).find((h) => h === "channel" || h === "here" || h === "everyone" || h === "all");
  return word ? { word: `@${word}`, people: channel.memberCount } : null;
}

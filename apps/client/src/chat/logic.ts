/**
 * ChatForm's pure rules on the client: how a timeline is laid out (day rules, the *New* rule, a run of one
 * author's messages within five minutes), what an `@`, `#` or `:` in the composer is asking for, the
 * quick switcher's fuzzy match, drafts kept on the device, and how a pending message meets its echo.
 * Nothing here touches the DOM, the network or the store, so `test/chat-*.test.ts` runs it in node.
 */

import { chatHandle, type ChatAgentRef, type ChatChannelView, type ChatMessage, type ChatParty } from "@foundation/protocol";

// ---------------------------------------------------------------- the timeline

/** a run from one author breaks after this long */
export const GROUP_MS = 5 * 60_000;

export type TimelineItem =
  | { kind: "day"; key: string; at: number; label: string }
  | { kind: "new"; key: string }
  | { kind: "message"; key: string; message: ChatMessage; /** the same author said the message above, within five minutes: no avatar or name */ continued: boolean }
  | { kind: "pending"; key: string; pending: PendingMessage; continued: boolean };

export interface PendingMessage {
  requestId: string;
  channel: string;
  root: string | null;
  text: string;
  /** archive file ids, and what to draw for them while they go */
  files: Array<{ id: string; name: string; mime: string; size: number }>;
  /** a card on a grid this links to (a message of type "link") */
  place?: { board: string; boardName?: string; section?: string; object?: string; label: string };
  createdAt: number;
  state: "sending" | "failed";
  error?: string;
}

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** "Today", "Yesterday", "Monday 16 November", or with the year when it isn't this one */
export function dayLabel(at: number, now = Date.now()): string {
  const k = dayKey(at);
  if (k === dayKey(now)) return "Today";
  if (k === dayKey(now - 86_400_000)) return "Yesterday";
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

/** a message can sit under the one above it when the same author wrote both, close together, as plain words */
export function continues(prev: Pick<ChatMessage, "author" | "type" | "createdAt"> | null, next: Pick<ChatMessage, "author" | "type" | "createdAt">): boolean {
  if (!prev) return false;
  if (prev.type !== "text" || next.type !== "text") return false;
  if (prev.author.kind !== next.author.kind || prev.author.id !== next.author.id) return false;
  // an agent working for someone else is someone else's message
  if ((prev.author.forName ?? "") !== (next.author.forName ?? "")) return false;
  if (dayKey(prev.createdAt) !== dayKey(next.createdAt)) return false;
  return next.createdAt - prev.createdAt >= 0 && next.createdAt - prev.createdAt < GROUP_MS;
}

/**
 * The timeline as drawn: oldest first, a rule at each new day, the *New* rule above the first message newer
 * than `readSeq` (what was read when the channel was opened; null: no rule), then the pending messages this
 * window is still sending, after everything the server has.
 */
export function layoutTimeline(messages: ChatMessage[], opts: { readSeq?: number | null; meId?: string; pending?: PendingMessage[]; now?: number } = {}): TimelineItem[] {
  const out: TimelineItem[] = [];
  let prev: ChatMessage | null = null;
  let lastDay = "";
  let ruled = false;
  for (const m of messages) {
    const day = dayKey(m.createdAt);
    let broke = false;
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day-${day}`, at: m.createdAt, label: dayLabel(m.createdAt, opts.now) });
      lastDay = day;
      broke = true;
    }
    if (!ruled && opts.readSeq != null && m.seq > opts.readSeq && m.author.id !== opts.meId) {
      out.push({ kind: "new", key: "new" });
      ruled = true;
      broke = true;
    }
    out.push({ kind: "message", key: m.id, message: m, continued: !broke && continues(prev, m) });
    prev = m;
  }
  let prevAt = prev?.createdAt ?? 0;
  let prevMine = !!prev && prev.author.id === opts.meId && prev.type === "text";
  for (const p of opts.pending ?? []) {
    const day = dayKey(p.createdAt);
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day-${day}`, at: p.createdAt, label: dayLabel(p.createdAt, opts.now) });
      lastDay = day;
      prevMine = false;
    }
    out.push({ kind: "pending", key: p.requestId, pending: p, continued: prevMine && p.createdAt - prevAt < GROUP_MS });
    prevAt = p.createdAt;
    prevMine = true;
  }
  return out;
}

// ---------------------------------------------------------------- messages, pending and echoed

/** put a message into a seq-ordered list: replace the one with its id, or insert it in order */
export function upsertMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0) {
    const next = list.slice();
    const had = list[at];
    // a stale copy (a send's HTTP answer arriving after the socket said it went out) never takes its way out back
    next[at] = had.outbound && m.outbound && (had.outbound.at ?? 0) > (m.outbound.at ?? 0) ? { ...m, outbound: had.outbound } : m;
    return next;
  }
  // nearly always the newest: look from the end
  let i = list.length;
  while (i > 0 && list[i - 1].seq > m.seq) i--;
  return [...list.slice(0, i), m, ...list.slice(i)];
}

/** several at once (a page), deduplicated, in seq order */
export function mergeMessages(list: ChatMessage[], more: ChatMessage[]): ChatMessage[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of more) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * A message arrived (the socket's echo, or the POST's answer): the pending copy with the same request id
 * goes, and the message takes its place. Whichever comes first wins; the second changes nothing.
 */
export function settlePending(pending: PendingMessage[], requestId: string | undefined, m: Pick<ChatMessage, "channel" | "root">): PendingMessage[] {
  if (!requestId) return pending;
  const next = pending.filter((p) => !(p.requestId === requestId && p.channel === m.channel));
  return next.length === pending.length ? pending : next;
}

/** a send failed: the pending copy stays, marked, with Retry */
export function failPending(pending: PendingMessage[], requestId: string, error: string): PendingMessage[] {
  return pending.map((p) => (p.requestId === requestId ? { ...p, state: "failed" as const, error } : p));
}

/** Retry: the same request id again (the server answers a retry with the first result) */
export function retryPending(pending: PendingMessage[], requestId: string): PendingMessage[] {
  return pending.map((p) => (p.requestId === requestId ? { ...p, state: "sending" as const, error: undefined } : p));
}

/** a thread reply arrived: its root's count and repliers move on, unless the server's own change already did */
export function bumpRoot(root: ChatMessage, reply: ChatMessage): ChatMessage {
  if (root.lastReplyAt != null && root.lastReplyAt >= reply.createdAt) return root;
  const repliers = [...new Set([...(root.repliers ?? []), reply.author.name])].slice(-5);
  return { ...root, replyCount: root.replyCount + 1, lastReplyAt: reply.createdAt, repliers };
}

/** toggle a reaction locally, as the server will (by names) */
export function toggleReaction(m: ChatMessage, emoji: string, who: string, on: boolean): ChatMessage {
  const reactions = m.reactions.map((r) => ({ ...r, by: [...r.by] }));
  const r = reactions.find((x) => x.emoji === emoji);
  if (on) {
    if (r) {
      if (!r.by.includes(who)) r.by.push(who);
    } else reactions.push({ emoji, by: [who] });
  } else if (r) r.by = r.by.filter((n) => n !== who);
  return { ...m, reactions: reactions.filter((x) => x.by.length) };
}

// ---------------------------------------------------------------- unread, for the list and the badge

export interface ChatTotals {
  /** mentions of me in channels that aren't direct */
  mentions: number;
  /** unread messages in direct messages and groups */
  direct: number;
  /** the badge: both */
  total: number;
}

const DIRECT = new Set(["dm", "group", "agent"]);
export const isDirect = (c: Pick<ChatChannelView, "kind">) => DIRECT.has(c.kind);

export function chatTotals(channels: Iterable<ChatChannelView>): ChatTotals {
  let mentions = 0;
  let direct = 0;
  for (const c of channels) {
    if (!c.me || c.archivedAt || c.me.notify === "none") continue;
    if (isDirect(c)) direct += c.unread;
    else mentions += c.me.mentions;
  }
  return { mentions, direct, total: mentions + direct };
}

export function totalsWords(t: ChatTotals): string {
  const parts = [t.mentions && `${t.mentions} ${t.mentions === 1 ? "mention" : "mentions"}`, t.direct && `${t.direct} in direct messages`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing new for you";
}

// ---------------------------------------------------------------- the composer: @ # :

export interface Trigger {
  kind: "@" | "#" | ":";
  query: string;
  /** where the trigger character sits in the text */
  start: number;
}

/** what the word at the caret is asking for, if it starts with @, # or : (an emoji needs two letters first) */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])([@#:])([\p{L}\p{N}._+-]*)$/u.exec(before);
  if (!m) return null;
  const kind = m[2] as Trigger["kind"];
  const query = m[3];
  if (kind === ":" && query.length < 2) return null;
  return { kind, query, start: caret - query.length - 1 };
}

/** put the chosen thing in place of the trigger word, with a space after; returns the new text and caret */
export function applyCompletion(text: string, t: Trigger, insert: string, caret: number): { text: string; caret: number } {
  const next = `${text.slice(0, t.start)}${insert} ${text.slice(caret).replace(/^ /, "")}`;
  return { text: next, caret: t.start + insert.length + 1 };
}

export interface MentionOption {
  kind: "person" | "agent" | "special";
  id: string;
  name: string;
  /** what goes into the text, without the @ */
  handle: string;
  detail?: string;
  color?: string;
}

/** a word-prefix match beats a match inside a word; an empty query keeps everyone, in order */
function rank(q: string, ...names: string[]): number {
  if (!q) return 1;
  let best = 0;
  for (const raw of names) {
    const n = raw.toLowerCase();
    if (n === q) best = Math.max(best, 4);
    else if (n.startsWith(q)) best = Math.max(best, 3);
    else if (n.split(/[\s._-]+/).some((w) => w.startsWith(q))) best = Math.max(best, 2);
    else if (n.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

export function matchMentions(query: string, people: ChatParty[], agents: ChatAgentRef[], meId?: string, limit = 8): MentionOption[] {
  const q = query.toLowerCase();
  const opts: Array<MentionOption & { score: number }> = [];
  for (const p of people) {
    if (p.id === meId) continue;
    const handle = chatHandle(p.name);
    const score = rank(q, p.name, handle);
    if (score) opts.push({ kind: "person", id: p.id, name: p.name, handle, color: p.color, score: score + 0.2 });
  }
  for (const a of agents) {
    const handle = chatHandle(a.name);
    const score = rank(q, a.name, handle);
    if (score) opts.push({ kind: "agent", id: a.name, name: a.name, handle, detail: "Agent", score });
  }
  for (const [handle, detail] of [
    ["channel", "Everyone in the channel"],
    ["here", "Everyone here now"],
  ] as const) {
    const score = rank(q, handle);
    if (score) opts.push({ kind: "special", id: handle, name: `@${handle}`, handle, detail, score: score - 0.5 });
  }
  return opts
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ score: _s, ...o }) => o);
}

export function matchChannels<T extends Pick<ChatChannelView, "id" | "name" | "kind" | "archivedAt">>(query: string, channels: T[], limit = 8): T[] {
  const q = query.toLowerCase();
  return channels
    .filter((c) => c.name && (c.kind === "open" || c.kind === "private") && !c.archivedAt)
    .map((c) => ({ c, s: rank(q, c.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}

// ---------------------------------------------------------------- the quick switcher

/**
 * A fuzzy score: every letter of the query in order, with bonuses for runs and for word starts. 0 means
 * no match. `hay` is what's matched against (a channel's name, a person's name).
 */
export function fuzzyScore(query: string, hay: string): number {
  const q = query.toLowerCase().replace(/^[#@]/, "").trim();
  const h = hay.toLowerCase();
  if (!q) return 1;
  if (h === q) return 1000;
  if (h.startsWith(q)) return 500 - h.length;
  let score = 0;
  let hi = 0;
  let run = 0;
  for (const ch of q) {
    const at = h.indexOf(ch, hi);
    if (at < 0) return 0;
    const wordStart = at === 0 || /[\s._#-]/.test(h[at - 1]);
    run = at === hi ? run + 1 : 0;
    score += 10 + run * 5 + (wordStart ? 15 : 0) - Math.min(9, at - hi);
    hi = at + 1;
  }
  return Math.max(1, score - (h.length - q.length) * 0.5);
}

// ---------------------------------------------------------------- drafts, kept on the device

export interface DraftStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const draftKey = (channel: string, root?: string | null) => `chatform-draft:${channel}${root ? `:${root}` : ""}`;

/** the draft for a channel (or a thread in it); a store that can't be read is no draft */
export function readDraft(store: DraftStore | null | undefined, channel: string, root?: string | null): string {
  try {
    return store?.getItem(draftKey(channel, root)) ?? "";
  } catch {
    return "";
  }
}

/** keep it; an empty draft is no draft (it leaves nothing behind) */
export function writeDraft(store: DraftStore | null | undefined, channel: string, text: string, root?: string | null): void {
  try {
    if (!store) return;
    if (text.trim()) store.setItem(draftKey(channel, root), text);
    else store.removeItem(draftKey(channel, root));
  } catch { /* private window, full storage: the draft lives only in the field */ }
}

// ---------------------------------------------------------------- the composer's markdown toolbar

export type Format = "bold" | "italic" | "strike" | "code" | "link" | "list" | "quote";

/** wrap the selection (or put the marks at the caret) the way the toolbar's buttons do; returns the new text and selection */
export function applyFormat(text: string, start: number, end: number, f: Format): { text: string; start: number; end: number } {
  const sel = text.slice(start, end);
  const wrap = (l: string, r = l) => ({ text: text.slice(0, start) + l + sel + r + text.slice(end), start: start + l.length, end: end + l.length });
  switch (f) {
    case "bold":
      return wrap("**");
    case "italic":
      return wrap("_");
    case "strike":
      return wrap("~~");
    case "code":
      return sel.includes("\n") ? wrap("```\n", "\n```") : wrap("`");
    case "link": {
      const label = sel || "words";
      const next = `${text.slice(0, start)}[${label}](https://)${text.slice(end)}`;
      const urlAt = start + label.length + 3;
      return { text: next, start: urlAt, end: urlAt + "https://".length };
    }
    case "list":
    case "quote": {
      const mark = f === "list" ? "- " : "> ";
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const block = text.slice(lineStart, end);
      const marked = block
        .split("\n")
        .map((l) => (l.startsWith(mark) ? l : mark + l))
        .join("\n");
      return { text: text.slice(0, lineStart) + marked + text.slice(end), start: start + mark.length, end: end + (marked.length - block.length) };
    }
  }
}

// ---------------------------------------------------------------- mentions in what's drawn

/**
 * Mark `@handles` and `#channels` in rendered markdown (HTML from utils/markdown, already escaped): outside
 * tags and outside code. `mine` is the reader's own handle, drawn louder.
 */
export function markMentions(html: string, mine?: string): string {
  let inCode = 0;
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(code|pre)\b/i.test(part)) inCode++;
        else if (/^<\/(code|pre)>/i.test(part)) inCode = Math.max(0, inCode - 1);
        return part;
      }
      if (inCode) return part;
      return part
        .replace(/(^|[\s(])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,63})/gu, (_m, pre: string, h: string) => {
          const handle = h.replace(/[.]+$/, "");
          const rest = h.slice(handle.length);
          const me = mine && (handle.toLowerCase() === mine || handle === "channel" || handle === "here");
          return `${pre}<span class="chat-mention${me ? " is-me" : ""}">@${handle}</span>${rest}`;
        })
        .replace(/(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,79})/gu, (_m, pre: string, n: string) => `${pre}<span class="chat-channel-ref" data-channel-name="${n.toLowerCase()}">#${n}</span>`);
    })
    .join("");
}

/** a byte count as people read it */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** what kind of file to draw */
export function fileKind(f: { name: string; mime: string }): "image" | "video" | "audio" | "cad" | "pdf" | "other" {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (/^(step|stp|iges|igs|stl|obj|glb)$/.test(ext)) return "cad";
  if (f.mime.startsWith("image/")) return "image";
  if (f.mime.startsWith("video/")) return "video";
  if (f.mime.startsWith("audio/")) return "audio";
  if (f.mime === "application/pdf" || ext === "pdf") return "pdf";
  return "other";
}

/** a request id for a write (the server answers a retry with the first result) */
export function requestId(): string {
  const r = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `rq_${r}`;
}

/**
 * How a link preview is drawn: a link straight to a picture or a GIF (the server gives its picture and no words, or
 * the address itself ends like a picture) is the picture; anything else is a card of its site, title and description.
 */
export function previewShape(p: { url: string; title?: string; description?: string; image?: string }): "picture" | "card" {
  if (!p.image) return "card";
  if (!p.title && !p.description) return "picture";
  let path = "";
  try {
    path = new URL(p.url).pathname;
  } catch { /* not an address: a card */ }
  return /\.(gif|png|jpe?g|webp|avif)$/i.test(path) && p.image === p.url ? "picture" : "card";
}

/** the route's rest: a channel, a thread in it, or a message to show in place */
export interface ChatRest {
  channel: string | null;
  thread: string | null;
  at: number | null;
  view: "threads" | "browse" | "search" | "mentions" | null;
  q: string;
}

export function parseRest(rest: string): ChatRest {
  const parts = rest.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const out: ChatRest = { channel: null, thread: null, at: null, view: null, q: "" };
  if (parts[0] === "threads" || parts[0] === "browse" || parts[0] === "mentions") {
    out.view = parts[0];
    return out;
  }
  if (parts[0] === "search") {
    out.view = "search";
    out.q = parts.slice(1).join("/");
    return out;
  }
  out.channel = parts[0] ?? null;
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === "thread") out.thread = parts[i + 1] ?? null;
    else if (parts[i] === "at") {
      const n = Number(parts[i + 1]);
      out.at = Number.isFinite(n) ? n : null;
    }
  }
  return out;
}

export function restOf(r: Partial<ChatRest>): string {
  if (r.view === "search") return `search/${encodeURIComponent(r.q ?? "")}`;
  if (r.view) return r.view;
  if (!r.channel) return "";
  return [encodeURIComponent(r.channel), r.thread ? `thread/${encodeURIComponent(r.thread)}` : "", r.at != null ? `at/${r.at}` : ""].filter(Boolean).join("/");
}

/** a link to a grid's card, in words, where the chat server can't carry the link (one of its own: chat/chatDrop.ts) */
export function placeWords(place: { label: string; boardName?: string }): string {
  return `🔗 ${place.label}${place.boardName ? ` · ${place.boardName}` : ""}`;
}

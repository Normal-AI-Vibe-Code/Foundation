/**
 * ChatForm's store: one per window, outside React (read with `useChat`), fed by `/api/chat` and by the one
 * `/chat` socket this window opens once someone is signed in. Everything that changes anything goes over
 * HTTP (docs/chatform.md §2.3); the socket says what's passing (protocol `ChatEvent`).
 *
 *  - **The list** (`/api/chat`): channels with my membership and unread, people, agents, who's online. The
 *    top bar's badge is worked out from it (logic `chatTotals`), so it's right even when ChatForm isn't open.
 *  - **Catch-up**: `rev` counts up by one per event on a connection. A gap, or a reconnect, means the list
 *    is fetched again and the open channel `since` the last event this window saw; other channels' pages
 *    are dropped and fetched again when opened.
 *  - **Sending**: a message is drawn at once as pending under its `request_id`; the POST's answer or the
 *    socket's echo (whichever comes first) takes its place (logic `settlePending`). A failure keeps it,
 *    marked, with Retry (the same request id: the server answers a retry with the first result).
 *  - **Reading**: `markRead` is called by the place when the channel is open, the window has focus and the
 *    newest message is in view; it moves my mark to the newest seq at once and tells the server.
 *  - The socket reconnects with backoff (1 s doubling to 30 s); a server without ChatForm (404) is
 *    *unavailable* and asked again a minute later.
 */

import { useSyncExternalStore } from "react";
import {
  CHAT_TYPING_MS,
  chatUnread,
  type ChatAgentRef,
  type ChatChannel,
  type ChatChannelKind,
  type ChatChannelView,
  type ChatEvent,
  type ChatMessage,
  type ChatPage,
  type ChatParty,
  type ChatSay,
} from "@foundation/protocol";
import { ApiError, api, authHeaders, openSocket, serverUrl } from "../lib/api";
import { bumpRoot, failPending, mergeMessages, requestId, retryPending, settlePending, toggleReaction, upsertMessage, type PendingMessage } from "./logic";

export interface ChatTimeline {
  /** top-level messages, oldest first */
  messages: ChatMessage[];
  /** there are older / newer messages than these on the server */
  before: boolean;
  after: boolean;
  loading: boolean;
}

export interface ChatThread {
  root: ChatMessage | null;
  replies: ChatMessage[];
  loading: boolean;
  loaded: boolean;
}

export interface Typist {
  channel: string;
  root: string | null;
  party: ChatParty;
  until: number;
}

export type ChatStatus = "off" | "connecting" | "live" | "offline" | "unavailable";

export interface ChatState {
  status: ChatStatus;
  /** why it isn't live, in a sentence */
  why: string;
  /** the list has been fetched at least once */
  loaded: boolean;
  me: { id: string; name: string } | null;
  channels: Record<string, ChatChannelView>;
  people: ChatParty[];
  agents: ChatAgentRef[];
  online: string[];
  timelines: Record<string, ChatTimeline>;
  /** by root message id */
  threads: Record<string, ChatThread>;
  pending: PendingMessage[];
  typing: Typist[];
}

const EMPTY: ChatState = { status: "off", why: "", loaded: false, me: null, channels: {}, people: [], agents: [], online: [], timelines: {}, threads: {}, pending: [], typing: [] };

let state: ChatState = EMPTY;
const subs = new Set<() => void>();

function set(next: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) {
  const patch = typeof next === "function" ? next(state) : next;
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export const getChat = () => state;

const bridgeSubs = new Set<(b: Extract<ChatEvent, { t: "bridge" }>["bridge"]) => void>();
/** hear a bridge's state as the server publishes it (`{t:"bridge"}` on the chat socket) */
export function onBridge(fn: (b: Extract<ChatEvent, { t: "bridge" }>["bridge"]) => void): () => void {
  bridgeSubs.add(fn);
  return () => void bridgeSubs.delete(fn);
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => void subs.delete(fn);
}

export function useChat(): ChatState {
  return useSyncExternalStore(subscribe, getChat);
}

// ---------------------------------------------------------------- what this window shows

/** the channel and thread on screen (for catch-up and for marking read) */
let open: { channel: string | null; thread: string | null } = { channel: null, thread: null };
export function setOpen(channel: string | null, thread: string | null) {
  open = { channel, thread };
}

// ---------------------------------------------------------------- start: the list and the socket

let started = false;
let ws: WebSocket | null = null;
let rev = -1;
let everLive = false;
let tries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
/** the last time this window heard from the server: catch-up asks for what changed since a little before it */
let heardAt = 0;

/** start once someone is signed in (the top bar's button does this, so the badge is live everywhere) */
export function startChat(me?: { id: string; name: string }) {
  if (me && (!state.me || state.me.id !== me.id || state.me.name !== me.name)) set({ me: { id: me.id, name: me.name } });
  if (started) return;
  started = true;
  set({ status: "connecting" });
  void loadList().then((ok) => ok && connect());
  window.addEventListener("online", () => {
    if (state.status === "offline") {
      tries = 0;
      clearTimeout(retryTimer);
      connect();
    }
  });
}

/** for tests and sign-out: everything forgotten */
export function stopChat() {
  started = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  ws?.close();
  ws = null;
  state = EMPTY;
  subs.forEach((f) => f());
}

async function loadList(): Promise<boolean> {
  try {
    const r = await api<{ channels: ChatChannelView[]; people: ChatParty[]; agents: ChatAgentRef[]; online: string[] }>("/api/chat");
    const channels: Record<string, ChatChannelView> = {};
    for (const c of r.channels) channels[c.id] = c;
    set({ channels, people: r.people ?? [], agents: r.agents ?? [], online: r.online ?? [], loaded: true, why: state.status === "unavailable" ? "" : state.why });
    if (state.status === "unavailable") set({ status: "connecting" });
    return true;
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 404) {
      set({ status: "unavailable", why: "This server doesn't have ChatForm yet.", loaded: true });
      retryTimer = setTimeout(() => void loadList().then((ok) => ok && connect()), 60_000);
      return false;
    }
    if (status === 401 || status === 403) {
      set({ status: "off", why: "Signed out." });
      started = false;
      return false;
    }
    set({ status: "offline", why: (e as Error).message });
    later();
    return false;
  }
}

function later() {
  clearTimeout(retryTimer);
  const wait = Math.min(30_000, 1000 * 2 ** tries++);
  retryTimer = setTimeout(() => {
    void (state.loaded && state.status !== "unavailable" ? Promise.resolve(true) : loadList()).then((ok) => ok && connect());
  }, wait);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (state.status !== "live") set({ status: "connecting" });
  openSocket("/chat")
    .then((sock) => {
      ws = sock;
      sock.onmessage = (e) => {
        try {
          onEvent(JSON.parse(String(e.data)) as ChatEvent);
        } catch { /* not ours */ }
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        clearInterval(pingTimer);
        if (!started) return;
        set({ status: "offline", why: "The chat connection dropped; trying again." });
        later();
      };
      sock.onopen = () => {
        clearInterval(pingTimer);
        pingTimer = setInterval(() => say({ t: "ping" }), 25_000);
      };
    })
    .catch(() => {
      set({ status: "offline", why: "Can't reach the chat server." });
      later();
    });
}

function say(m: ChatSay) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// ---------------------------------------------------------------- events

function onEvent(ev: ChatEvent) {
  heardAt = Date.now();
  if (ev.t === "hello") {
    const again = everLive;
    everLive = true;
    tries = 0;
    rev = ev.rev;
    set((s) => ({ status: "live", why: "", me: s.me && s.me.id === ev.you ? s.me : { id: ev.you, name: s.me?.name ?? s.people.find((p) => p.id === ev.you)?.name ?? "" } }));
    if (again) void catchUp();
    return;
  }
  const gap = rev >= 0 && ev.rev !== rev + 1;
  rev = ev.rev;
  apply(ev);
  if (gap) void catchUp();
}

const mentionsMe = (m: ChatMessage, me: string | undefined) => !!me && (m.mentions.includes(me) || m.mentions.includes("channel") || m.mentions.includes("here"));

function withUnread(c: ChatChannelView): ChatChannelView {
  return { ...c, unread: chatUnread(c.lastSeq, c.me) };
}

/** a message landed (an event, or a POST's answer): wherever this window keeps it */
function land(m: ChatMessage, reqId?: string) {
  set((s) => {
    const out: Partial<ChatState> = { pending: settlePending(s.pending, reqId, m) };
    // the channel's list row
    const c = s.channels[m.channel];
    if (c && m.seq > c.lastSeq) {
      const mine = m.author.id === s.me?.id;
      const me = c.me ? { ...c.me, readSeq: mine ? m.seq : c.me.readSeq, mentions: c.me.mentions + (!mine && mentionsMe(m, s.me?.id) ? 1 : 0) } : null;
      out.channels = { ...s.channels, [c.id]: withUnread({ ...c, lastSeq: m.seq, lastPostAt: m.createdAt, lastText: m.text.slice(0, 120), me }) };
    }
    if (m.root) {
      const t = s.threads[m.root];
      if (t) out.threads = { ...s.threads, [m.root]: { ...t, replies: upsertMessage(t.replies, m) } };
      const tl = s.timelines[m.channel];
      if (tl) {
        const root = tl.messages.find((x) => x.id === m.root);
        if (root) out.timelines = { ...s.timelines, [m.channel]: { ...tl, messages: upsertMessage(tl.messages, bumpRoot(root, m)) } };
      }
      if (t?.root && t.root.id === m.root) out.threads = { ...(out.threads ?? s.threads), [m.root]: { ...(out.threads ?? s.threads)[m.root], root: bumpRoot(t.root, m) } };
    } else {
      const tl = s.timelines[m.channel];
      // a page around an old message doesn't take the newest: it knows there's more after it
      if (tl) out.timelines = { ...s.timelines, [m.channel]: tl.after ? tl : { ...tl, messages: upsertMessage(tl.messages, m) } };
    }
    return out;
  });
}

/** a message changed (edited, removed, reacted to, pinned, its thread moved on) */
function changed(m: ChatMessage) {
  set((s) => {
    const out: Partial<ChatState> = {};
    const tl = s.timelines[m.channel];
    if (tl && tl.messages.some((x) => x.id === m.id)) out.timelines = { ...s.timelines, [m.channel]: { ...tl, messages: upsertMessage(tl.messages, m) } };
    const threads = { ...s.threads };
    let touched = false;
    if (threads[m.id]) {
      threads[m.id] = { ...threads[m.id], root: m };
      touched = true;
    }
    if (m.root && threads[m.root]?.replies.some((x) => x.id === m.id)) {
      threads[m.root] = { ...threads[m.root], replies: upsertMessage(threads[m.root].replies, m) };
      touched = true;
    }
    if (touched) out.threads = threads;
    return out;
  });
}

let typingTimer: ReturnType<typeof setTimeout> | undefined;
function sweepTyping() {
  clearTimeout(typingTimer);
  const now = Date.now();
  const left = state.typing.filter((t) => t.until > now);
  if (left.length !== state.typing.length) set({ typing: left });
  if (left.length) typingTimer = setTimeout(sweepTyping, Math.max(200, Math.min(...left.map((t) => t.until)) - now + 20));
}

function apply(ev: ChatEvent) {
  switch (ev.t) {
    case "message":
      if (!state.channels[ev.message.channel]) void refreshChannel(ev.message.channel);
      land(ev.message, ev.requestId);
      // whoever said it isn't typing any more
      if (state.typing.some((t) => t.party.id === ev.message.author.id && t.channel === ev.message.channel)) set((s) => ({ typing: s.typing.filter((t) => !(t.party.id === ev.message.author.id && t.channel === ev.message.channel)) }));
      return;
    case "message-changed":
      changed(ev.message);
      return;
    case "channel": {
      const fresh = !state.channels[ev.channel.id] || !state.channels[ev.channel.id].me;
      set((s) => {
        const was = s.channels[ev.channel.id];
        return { channels: { ...s.channels, [ev.channel.id]: withUnread({ ...(was ?? { me: null, unread: 0 }), ...ev.channel, me: was?.me ?? null } as ChatChannelView) } };
      });
      // one I hadn't got (a dm someone just started with me): my membership comes with the channel's own view
      if (fresh) void refreshChannel(ev.channel.id);
      return;
    }
    case "channel-gone":
      set((s) => {
        const channels = { ...s.channels };
        delete channels[ev.channel];
        return { channels };
      });
      return;
    case "member": {
      const c = state.channels[ev.channel];
      if (ev.party.id === state.me?.id) {
        // I joined or left: the server's view of my membership comes with the channel
        if (ev.joined) void refreshChannel(ev.channel);
        else if (c) set((s) => ({ channels: { ...s.channels, [c.id]: { ...c, me: null, unread: 0 } } }));
        return;
      }
      if (!c) return;
      const members = c.members ? (ev.joined ? [...c.members.filter((m) => m.id !== ev.party.id), ev.party] : c.members.filter((m) => m.id !== ev.party.id)) : undefined;
      const had = !!c.members?.some((m) => m.id === ev.party.id);
      const memberCount = members ? members.length : Math.max(0, c.memberCount + (ev.joined ? (had ? 0 : 1) : -1));
      set((s) => ({ channels: { ...s.channels, [c.id]: { ...c, members, memberCount } } }));
      return;
    }
    case "read": {
      const c = state.channels[ev.channel];
      if (!c?.me) return;
      set((s) => ({ channels: { ...s.channels, [c.id]: withUnread({ ...c, me: { ...c.me!, readSeq: ev.readSeq, mentions: ev.mentions } }) } }));
      return;
    }
    case "typing": {
      if (ev.party.id === state.me?.id) return;
      const until = Date.now() + CHAT_TYPING_MS;
      set((s) => ({ typing: [...s.typing.filter((t) => !(t.party.id === ev.party.id && t.channel === ev.channel && t.root === ev.root)), { channel: ev.channel, root: ev.root, party: ev.party, until }] }));
      sweepTyping();
      return;
    }
    case "presence":
      set({ online: ev.online });
      // someone new is here (signed in for the first time since the list came): the list again, for their name
      if (ev.online.some((id) => !state.people.some((p) => p.id === id))) refreshList();
      return;
    case "bridge":
      // the Inbox tab's (and the Slack guide's): they follow a bridge's state live
      for (const fn of bridgeSubs) fn(ev.bridge);
      return;
  }
}

/** after a gap or a reconnect: the list again, and the open channel since a little before we last heard */
async function catchUp() {
  const since = Math.max(0, heardAt - 10_000);
  await loadList();
  set((s) => {
    const timelines: Record<string, ChatTimeline> = {};
    if (open.channel && s.timelines[open.channel]) timelines[open.channel] = s.timelines[open.channel];
    const threads: Record<string, ChatThread> = {};
    if (open.thread && s.threads[open.thread]) threads[open.thread] = s.threads[open.thread];
    return { timelines, threads };
  });
  if (open.channel && state.timelines[open.channel]) {
    try {
      const page = await api<ChatPage>(`/api/chat/channels/${enc(open.channel)}/messages?since=${since}&limit=200`);
      const tops = page.messages.filter((m) => !m.root);
      set((s) => {
        const tl = s.timelines[open.channel!];
        return tl ? { timelines: { ...s.timelines, [open.channel!]: { ...tl, messages: mergeMessages(tl.messages, tops) } } } : {};
      });
      for (const m of page.messages) if (m.root) land(m);
    } catch { /* the next event or open will fetch it */ }
  }
  if (open.channel && open.thread) void loadThread(open.channel, open.thread, true);
}

let listTimer: ReturnType<typeof setTimeout> | undefined;
/** the list again (people who've signed in since, channels made elsewhere), a beat later, once */
export function refreshList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => void loadList(), 250);
}

// ---------------------------------------------------------------- channels

const enc = encodeURIComponent;

export async function refreshChannel(id: string): Promise<ChatChannelView | null> {
  try {
    const { channel } = await api<{ channel: ChatChannelView }>(`/api/chat/channels/${enc(id)}`);
    set((s) => ({ channels: { ...s.channels, [id]: withUnread({ ...s.channels[id], ...channel }) } }));
    return channel;
  } catch {
    return null;
  }
}

function took(channel: ChatChannelView | ChatChannel): ChatChannelView {
  const was = state.channels[channel.id];
  const view = withUnread({ ...(was ?? { me: null, unread: 0 }), ...channel } as ChatChannelView);
  set((s) => ({ channels: { ...s.channels, [view.id]: view } }));
  return view;
}

export async function createChannel(c: { kind: ChatChannelKind; name?: string; topic?: string; purpose?: string; members?: string[] }): Promise<ChatChannelView> {
  const { channel } = await api<{ channel: ChatChannelView }>("/api/chat/channels", { method: "POST", json: { ...c, request_id: requestId() } });
  const view = took(channel);
  // the list carries my membership; a new channel's row needs it for the sidebar
  if (!view.me) void refreshChannel(view.id);
  return view;
}

/** a dm with one person, or a group with several: the one that exists, or a new one */
export function openDirect(ids: string[]) {
  return createChannel({ kind: ids.length > 1 ? "group" : "dm", members: ids });
}

export async function updateChannel(id: string, patch: { name?: string; topic?: string; purpose?: string; notify?: "all" | "mentions" | "none"; starred?: boolean }) {
  // the star and the notify level are mine: drawn at once
  const c = state.channels[id];
  if (c?.me && (patch.starred !== undefined || patch.notify !== undefined)) {
    set((s) => ({ channels: { ...s.channels, [id]: withUnread({ ...c, me: { ...c.me!, ...(patch.starred !== undefined ? { starred: patch.starred } : {}), ...(patch.notify ? { notify: patch.notify } : {}) } }) } }));
  }
  const { channel } = await api<{ channel: ChatChannelView }>(`/api/chat/channels/${enc(id)}`, { method: "POST", json: { ...patch, request_id: requestId() } });
  return took(channel);
}

export async function joinChannel(id: string) {
  const { channel } = await api<{ channel: ChatChannelView }>(`/api/chat/channels/${enc(id)}/join`, { method: "POST", json: { request_id: requestId() } });
  const v = took(channel);
  if (!v.me) await refreshChannel(id);
  return v;
}

export async function leaveChannel(id: string) {
  const { channel } = await api<{ channel: ChatChannelView }>(`/api/chat/channels/${enc(id)}/leave`, { method: "POST", json: { request_id: requestId() } });
  set((s) => ({ channels: { ...s.channels, [id]: { ...s.channels[id], ...channel, me: null, unread: 0 } } }));
}

export async function changeMembers(id: string, add: string[], remove: string[]) {
  const { channel } = await api<{ channel: ChatChannelView }>(`/api/chat/channels/${enc(id)}/members`, { method: "POST", json: { add, remove, request_id: requestId() } });
  return took(channel);
}

export async function archiveChannel(id: string) {
  await api(`/api/chat/channels/${enc(id)}/archive`, { method: "POST", json: { confirm: true, request_id: requestId() } });
  set((s) => {
    const c = s.channels[id];
    return c ? { channels: { ...s.channels, [id]: { ...c, archivedAt: Date.now() } } } : {};
  });
}

/** the channel as a file: JSON (whole) or Markdown (to read) */
export async function exportChannel(id: string, format: "json" | "md") {
  const res = await fetch(serverUrl(`/api/chat/channels/${enc(id)}/export?format=${format}`), { credentials: "include", headers: authHeaders() });
  if (!res.ok) {
    let why = `${res.status}`;
    try {
      why = ((await res.json()) as { error?: string }).error ?? why;
    } catch { /* not JSON */ }
    throw new Error(`The export didn't come: ${why}`);
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${state.channels[id]?.name || id}.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------- pages of messages

const PAGE = 50;

function setTimeline(id: string, fn: (t: ChatTimeline) => ChatTimeline) {
  set((s) => ({ timelines: { ...s.timelines, [id]: fn(s.timelines[id] ?? { messages: [], before: false, after: false, loading: false }) } }));
}

/** the newest page, unless this window already has the channel */
export async function loadChannel(id: string, force = false) {
  const tl = state.timelines[id];
  if (tl && !force && !tl.after) return;
  setTimeline(id, (t) => ({ ...t, loading: true }));
  try {
    const page = await api<ChatPage>(`/api/chat/channels/${enc(id)}/messages?limit=${PAGE}`);
    setTimeline(id, () => ({ messages: page.messages.filter((m) => !m.root), before: page.before, after: false, loading: false }));
  } catch (e) {
    setTimeline(id, (t) => ({ ...t, loading: false }));
    throw e;
  }
}

export async function loadOlder(id: string) {
  const tl = state.timelines[id];
  if (!tl || tl.loading || !tl.before || !tl.messages.length) return;
  setTimeline(id, (t) => ({ ...t, loading: true }));
  try {
    const page = await api<ChatPage>(`/api/chat/channels/${enc(id)}/messages?before=${tl.messages[0].seq}&limit=${PAGE}`);
    setTimeline(id, (t) => ({ ...t, messages: mergeMessages(t.messages, page.messages.filter((m) => !m.root)), before: page.before, loading: false }));
  } catch {
    setTimeline(id, (t) => ({ ...t, loading: false }));
  }
}

export async function loadNewer(id: string) {
  const tl = state.timelines[id];
  if (!tl || tl.loading || !tl.after || !tl.messages.length) return;
  setTimeline(id, (t) => ({ ...t, loading: true }));
  try {
    const page = await api<ChatPage>(`/api/chat/channels/${enc(id)}/messages?after=${tl.messages[tl.messages.length - 1].seq}&limit=${PAGE}`);
    setTimeline(id, (t) => ({ ...t, messages: mergeMessages(t.messages, page.messages.filter((m) => !m.root)), after: page.after, loading: false }));
  } catch {
    setTimeline(id, (t) => ({ ...t, loading: false }));
  }
}

/** a page around one message (a search result, a link), unless it's already here */
export async function loadAround(id: string, seq: number): Promise<ChatMessage | null> {
  const have = state.timelines[id]?.messages.find((m) => m.seq === seq);
  if (have) return have;
  setTimeline(id, (t) => ({ ...t, loading: true }));
  try {
    const page = await api<ChatPage>(`/api/chat/channels/${enc(id)}/messages?around=${seq}&limit=${PAGE}`);
    const tops = page.messages.filter((m) => !m.root);
    setTimeline(id, () => ({ messages: tops, before: page.before, after: page.after, loading: false }));
    // a reply: its thread opens beside it
    return page.messages.find((m) => m.seq === seq) ?? null;
  } catch {
    setTimeline(id, (t) => ({ ...t, loading: false }));
    return null;
  }
}

export async function loadThread(channel: string, root: string, force = false) {
  const t = state.threads[root];
  if (t?.loaded && !force) return;
  set((s) => ({ threads: { ...s.threads, [root]: { root: s.threads[root]?.root ?? s.timelines[channel]?.messages.find((m) => m.id === root) ?? null, replies: s.threads[root]?.replies ?? [], loading: true, loaded: !!s.threads[root]?.loaded } } }));
  try {
    const page = await api<ChatPage>(`/api/chat/channels/${enc(channel)}/messages?root=${enc(root)}&limit=200`);
    const rootMsg = page.messages.find((m) => m.id === root) ?? null;
    set((s) => ({ threads: { ...s.threads, [root]: { root: rootMsg ?? s.threads[root]?.root ?? null, replies: mergeMessages(s.threads[root]?.replies ?? [], page.messages.filter((m) => m.id !== root)), loading: false, loaded: true } } }));
  } catch {
    set((s) => ({ threads: { ...s.threads, [root]: { ...s.threads[root], loading: false } } }));
  }
}

// ---------------------------------------------------------------- writing

/** say it: drawn at once as pending, then the server's message in its place */
export function send(channel: string, text: string, files: PendingMessage["files"] = [], root: string | null = null) {
  const p: PendingMessage = { requestId: requestId(), channel, root, text, files, createdAt: Date.now(), state: "sending" };
  set((s) => ({ pending: [...s.pending, p] }));
  void post(p);
  return p.requestId;
}

async function post(p: PendingMessage) {
  try {
    const { message } = await api<{ message: ChatMessage }>(`/api/chat/channels/${enc(p.channel)}/messages`, {
      method: "POST",
      json: { text: p.text, files: p.files.map((f) => f.id), root: p.root, request_id: p.requestId },
    });
    land(message, p.requestId);
    // posting to an open channel joins it: the list row needs my membership
    if (!state.channels[p.channel]?.me) void refreshChannel(p.channel);
  } catch (e) {
    set((s) => ({ pending: failPending(s.pending, p.requestId, (e as Error).message) }));
  }
}

export function retry(reqId: string) {
  const p = state.pending.find((x) => x.requestId === reqId);
  if (!p) return;
  set((s) => ({ pending: retryPending(s.pending, reqId) }));
  void post({ ...p, state: "sending" });
}

export function discard(reqId: string) {
  set((s) => ({ pending: s.pending.filter((p) => p.requestId !== reqId) }));
}

export async function editMessage(m: ChatMessage, text: string) {
  const was = m;
  changed({ ...m, text, editedAt: Date.now() });
  try {
    const { message } = await api<{ message: ChatMessage }>(`/api/chat/messages/${enc(m.id)}`, { method: "POST", json: { text, request_id: requestId() } });
    changed(message);
  } catch (e) {
    changed(was);
    throw e;
  }
}

export async function removeMessage(m: ChatMessage) {
  await api(`/api/chat/messages/${enc(m.id)}`, { method: "DELETE", json: { confirm: true, request_id: requestId() } });
  changed({ ...m, text: "", files: [], deletedAt: Date.now() });
}

export async function react(m: ChatMessage, emoji: string, on: boolean) {
  const who = state.me?.name ?? "";
  changed(toggleReaction(m, emoji, who, on));
  try {
    const { message } = await api<{ message: ChatMessage }>(`/api/chat/messages/${enc(m.id)}/react`, { method: "POST", json: { emoji, on, request_id: requestId() } });
    changed(message);
  } catch (e) {
    changed(m);
    throw e;
  }
}

export async function pin(m: ChatMessage, on: boolean) {
  changed({ ...m, pinned: on });
  try {
    const { message } = await api<{ message: ChatMessage }>(`/api/chat/messages/${enc(m.id)}/pin`, { method: "POST", json: { on, request_id: requestId() } });
    changed(message);
    void refreshChannel(m.channel);
  } catch (e) {
    changed(m);
    throw e;
  }
}

// ---------------------------------------------------------------- reading

const reading = new Map<string, number>();

/** my mark moves to `seq` (the newest, when the channel is read); below the newest is "unread from here" */
export async function markRead(channel: string, seq?: number) {
  const c = state.channels[channel];
  if (!c?.me) return;
  const to = seq ?? c.lastSeq;
  if (seq === undefined && c.me.readSeq >= to && c.me.mentions === 0) return;
  if (reading.get(channel) === to) return;
  reading.set(channel, to);
  set((s) => ({ channels: { ...s.channels, [channel]: withUnread({ ...c, me: { ...c.me!, readSeq: to, mentions: seq === undefined ? 0 : c.me!.mentions } }) } }));
  try {
    await api(`/api/chat/channels/${enc(channel)}/read`, { method: "POST", json: { seq: to, request_id: requestId() } });
  } catch { /* the list says what the server has next time */ }
  finally {
    reading.delete(channel);
  }
}

/** mark unread from this message on (its seq and everything after) */
export function markUnreadFrom(m: ChatMessage) {
  return markRead(m.channel, Math.max(0, m.seq - 1));
}

// ---------------------------------------------------------------- passing: typing

let lastTyping = 0;
let lastTypingAt = "";
export function sayTyping(channel: string, root: string | null = null) {
  const key = `${channel}:${root ?? ""}`;
  const now = Date.now();
  if (key === lastTypingAt && now - lastTyping < 3000) return;
  lastTyping = now;
  lastTypingAt = key;
  say({ t: "typing", channel, root });
}

// ---------------------------------------------------------------- search

export interface ChatHit {
  message: ChatMessage;
  channel: { id: string; name: string; kind: ChatChannelKind };
  snippet: string;
}

export async function searchChat(q: string, signal?: AbortSignal): Promise<ChatHit[]> {
  const { hits } = await api<{ hits: ChatHit[] }>(`/api/chat/search?q=${enc(q)}`, { signal });
  return hits;
}

// ---------------------------------------------------------------- the dev hook (e2e reads the store)

if (typeof window !== "undefined") (window as unknown as { __chatform?: () => ChatState }).__chatform = getChat;

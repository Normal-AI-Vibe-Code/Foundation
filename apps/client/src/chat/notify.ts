/**
 * What was said to me, kept for this window (the bell in the top bar and ChatForm's Recent mentions read it; the
 * rules are chat/notifyLogic.ts).
 *
 *  - **The list** is the server's (`GET /api/chat/mentions`, on Foundation's own server and on a chat server that
 *    lists `mentions`), fetched once someone is signed in and again after a reconnect, and kept live from the chat
 *    socket: a message that concerns me is put at its head as it arrives, an edit follows, a removal takes it out.
 *    A server with no such list still gets what arrives while this window is open; the bell then falls back to the
 *    counts the chat store has.
 *  - **Seen** is this device's (localStorage, per server and person): pressing a notice, Mark all read, and my read
 *    mark in the channel passing the message.
 *  - **Being told**: when one arrives and I'm not looking at that conversation, a desktop notification through the
 *    web Notification API: who, and the first line. Off until a person turns it on in Settings → General (the
 *    browser's question is asked from that press, never on load); a muted conversation never tells; pressing the
 *    notification brings this window forward and opens the message.
 *  - The window's title carries the count in front ("(3) Foundation — Today"), and the app's badge where the
 *    browser has one.
 */

import { useSyncExternalStore } from "react";
import { chatTitle, type ChatEvent, type ChatMention, type ChatMessage } from "@foundation/protocol";
import { goChat } from "../lib/place";
import { getChat, getOpen, onChatEvent, refreshChannel, subscribeChat } from "./model";
import { CHAT_SERVER, chatApi } from "./server";
import { chatCan } from "./serverLogic";
import { restOf } from "./logic";
import { setListFolded } from "./pins";
import { openPlace } from "../lib/openPlace";
import { playPing, soundOn } from "./pingSound";
import { changeNotice, dropChannel, lookingAt, sounds, markAllSeen, markSeen, mergeNotices, noticeFor, noticeOf, NOTHING_SEEN, readSeen, tells, tellWords, titleWithCount, unseenCount, type Notice, type Seen, type TellPermission } from "./notifyLogic";

export interface NoticesState {
  list: Notice[];
  seen: Seen;
  /** the server has the list, and it has been read at least once */
  loaded: boolean;
  /** the server keeps a list of what was said to me (else: only what arrived while this window was open) */
  listed: boolean;
  busy: boolean;
  why: string;
}

let state: NoticesState = { list: [], seen: NOTHING_SEEN, loaded: false, listed: false, busy: false, why: "" };
const subs = new Set<() => void>();

function set(patch: Partial<NoticesState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export const getNotices = () => state;
export function useNotices(): NoticesState {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    getNotices,
  );
}

/** how many the bell shows, from the two stores */
export const noticeCount = () => unseenCount(state.list, state.seen, getChat().channels);

// ---------------------------------------------------------------- seen, on this device

const seenKey = (me: string) => `chatform-seen:${CHAT_SERVER || "foundation"}:${me}`;

function keepSeen(seen: Seen) {
  set({ seen });
  const me = getChat().me?.id;
  if (!me) return;
  try {
    localStorage.setItem(seenKey(me), JSON.stringify(seen));
  } catch { /* private window */ }
}

export function seeNotice(id: string) {
  const next = markSeen(state.seen, id);
  if (next !== state.seen) keepSeen(next);
}

export function seeAllNotices() {
  keepSeen(markAllSeen(state.list));
}

/**
 * Open where I was referenced, and it's seen: a message that links a place on a grid (a ping from a card, a card
 * shared into chat) opens that grid at the card; any other opens ChatForm at the message (the place loads the page
 * around it and flashes it). `inChat` always opens the message.
 */
export function openNotice(n: Pick<Notice, "id" | "message">, inChat = false) {
  seeNotice(n.id);
  if (!inChat && n.message.place) return openPlace(n.message.place);
  setListFolded(false);
  goChat("chat", restOf({ channel: n.message.channel, thread: n.message.root, at: n.message.seq }));
}

// ---------------------------------------------------------------- the list

let loadedFor = "";
let loading = false;

async function load(me: string) {
  if (loading) return;
  loading = true;
  set({ busy: true, why: "" });
  try {
    const r = await chatApi<{ mentions: ChatMention[] }>("/api/chat/mentions?limit=50");
    if (getChat().me?.id !== me) return;
    // a direct message has no name of its own: it's the others in it, as this window's list knows them
    const named = (r.mentions ?? []).map((x) => {
      const c = getChat().channels[x.channel.id];
      const direct = x.channel.kind !== "open" && x.channel.kind !== "private";
      return noticeOf(direct && c ? { ...x, channel: { ...x.channel, name: chatTitle(c, me) } } : x, me);
    });
    set({ list: mergeNotices(state.list, named), loaded: true, listed: true, busy: false });
  } catch (e) {
    // a server without the route: the bell falls back to the store's counts
    set({ busy: false, why: (e as Error).message, loaded: false, listed: false });
  } finally {
    loading = false;
  }
}

/** the list again (the Recent mentions view asks when it opens) */
export function refreshNotices() {
  const s = getChat();
  if (s.me && chatCan(s.remote, s.features, "mentions")) void load(s.me.id);
}

let wasLive = false;
/** follow the chat store: a person signed in (or another one), what the server has, a reconnect */
function follow() {
  const s = getChat();
  const me = s.me?.id ?? "";
  const can = !!me && s.loaded && chatCan(s.remote, s.features, "mentions");
  const key = me ? `${me}|${can ? 1 : 0}` : "";
  if (key !== loadedFor) {
    const sameMe = loadedFor.split("|")[0] === me;
    loadedFor = key;
    if (!me) {
      set({ list: [], seen: NOTHING_SEEN, loaded: false, listed: false, why: "" });
      return;
    }
    if (!sameMe) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(seenKey(me));
      } catch { /* private window */ }
      set({ list: [], seen: readSeen(raw), loaded: false, listed: can, why: "" });
    } else set({ listed: can });
    if (can) void load(me);
  }
  // back after a drop: what was said meanwhile
  const live = s.status === "live";
  if (live && !wasLive && can && state.loaded) void load(me);
  wasLive = live;
  badge();
}

// ---------------------------------------------------------------- live

async function onMessage(m: ChatMessage) {
  const me = getChat().me?.id;
  if (!me) return;
  // one I hadn't got (a direct message someone just started): my membership comes with the channel's own view
  const c = getChat().channels[m.channel] ?? (await refreshChannel(m.channel)) ?? getChat().channels[m.channel];
  const why = noticeFor(m, c, me);
  if (!why || !c) return;
  const n: Notice = { id: m.id, message: m, channel: { id: c.id, name: c.kind === "open" || c.kind === "private" ? c.name : chatTitle(c, me), kind: c.kind }, why };
  set({ list: mergeNotices(state.list, [n]) });
  const looking = lookingAt(m, getOpen(), typeof document !== "undefined" && document.hasFocus() && !document.hidden);
  // in front of me as it lands: nothing to count
  if (looking) seeNotice(n.id);
  if (tells(why, { on: tellOn(), permission: tellPermission(), looking })) tell(n);
  if (sounds(why, { on: soundOn(), looking })) playPing();
  badge();
}

function onEvent(ev: ChatEvent) {
  if (ev.t === "message") void onMessage(ev.message);
  else if (ev.t === "message-changed") {
    const next = changeNotice(state.list, ev.message);
    if (next !== state.list) set({ list: next });
  } else if (ev.t === "channel-gone") {
    const next = dropChannel(state.list, ev.channel);
    if (next !== state.list) set({ list: next });
  }
}

// ---------------------------------------------------------------- being told (this device)

const TELL_KEY = "chatform-tell";
const tellSubs = new Set<() => void>();

export function tellPermission(): TellPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as TellPermission;
}

export function tellOn(): boolean {
  try {
    return localStorage.getItem(TELL_KEY) === "on";
  } catch {
    return false;
  }
}

let tellSnap = { on: false, permission: "default" as TellPermission };
function tellState() {
  const on = tellOn(), permission = tellPermission();
  if (tellSnap.on !== on || tellSnap.permission !== permission) tellSnap = { on, permission };
  return tellSnap;
}

/** Settings → General: is this device told, and what the browser says about it */
export function useTell(): { on: boolean; permission: TellPermission } {
  return useSyncExternalStore(
    (fn) => {
      tellSubs.add(fn);
      return () => void tellSubs.delete(fn);
    },
    tellState,
  );
}

/**
 * Turn being told on or off for this device. Called from a person's press: turning it on is when the browser is
 * asked (never on load). Answers what the browser said.
 */
export async function setTell(on: boolean): Promise<TellPermission> {
  let permission = tellPermission();
  if (on && permission === "default") {
    try {
      permission = (await Notification.requestPermission()) as TellPermission;
    } catch {
      permission = tellPermission();
    }
  }
  try {
    if (on && permission === "granted") localStorage.setItem(TELL_KEY, "on");
    else localStorage.removeItem(TELL_KEY);
  } catch { /* private window */ }
  tellSubs.forEach((f) => f());
  return permission;
}

function tell(n: Notice) {
  try {
    const { title, body } = tellWords(n);
    // one per message: the same one arriving twice (a reconnect) replaces itself
    const note = new Notification(title, { body, tag: `chatform:${n.id}` });
    note.onclick = () => {
      window.focus();
      openNotice(n);
      note.close();
    };
  } catch { /* the browser refused after all: the bell still has it */ }
}

// ---------------------------------------------------------------- the title and the app's badge

let badged = -1;
let titleWatch: MutationObserver | null = null;

function badge() {
  if (typeof document === "undefined") return;
  const n = noticeCount();
  const want = titleWithCount(document.title, n);
  if (document.title !== want) document.title = want;
  if (n === badged) return;
  badged = n;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (n > 0) void nav.setAppBadge?.(n)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch { /* no badge here */ }
}

// ---------------------------------------------------------------- start

let started = false;
/** start once (the bell does, so it's live wherever the person is) */
export function startNotices() {
  if (started || typeof window === "undefined") return;
  started = true;
  subscribeChat(follow);
  subs.add(badge);
  onChatEvent(onEvent);
  // the shell names the place in the title as it changes: the count goes back in front
  const el = document.querySelector("title");
  if (el && typeof MutationObserver !== "undefined") {
    titleWatch = new MutationObserver(() => badge());
    titleWatch.observe(el, { childList: true, characterData: true, subtree: true });
  }
  follow();
}

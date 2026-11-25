/**
 * Conversations kept in the side menu (2026-11-20, Josh: "ChatForm should be able to drag its channels out
 * into the Left project pane … if they open a chat, it should take over the whole grid area to the right
 * and collapse the other chat channels in ChatForm").
 *
 *  - **The pins**: an ordered list of channel ids, the person's own, kept on the server in their personal
 *    preferences (`chat.pinned`; apps/server/src/prefs.ts, `GET/POST /api/prefs`) so they follow them
 *    across devices. Drawn at once and saved behind; a refused save puts the list back.
 *  - **Which are shown**: only channels the chat list gives this person (and not archived). A pin to one
 *    they can no longer see is dropped quietly (and the trimmed list saved once).
 *  - **The folded list**: opening a chat from the side menu folds ChatForm's own channel list so the
 *    conversation takes the whole area; the unfold control at the head, or choosing the Chat tab, brings it
 *    back. That's this device's (localStorage), like the side menu's width.
 *  - **Something held**: while a conversation is in the hand (chat/carryChat.ts) the side menu rings to say
 *    it can take it.
 *
 * The pure parts (`pinAdd`, `pinMove`, `pinRemove`, `reconcilePins`) are chat/sideMenuLogic.ts's.
 */

import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { MAX_PINS, pinAdd, pinMove, pinRemove } from "./sideMenuLogic";

const KEY = "chat.pinned";

export interface PinsState {
  /** the list as the person keeps it (before dropping the ones they can't see) */
  ids: string[];
  loaded: boolean;
  /** ChatForm's channel list folded away: the open conversation takes the whole area (this device's) */
  listFolded: boolean;
  /** a conversation in the hand, and whether it's over the side menu now */
  held: { id: string; over: boolean } | null;
}

const FOLD = "chatform-list-folded";
const readFold = () => {
  try {
    return localStorage.getItem(FOLD) === "1";
  } catch {
    return false;
  }
};

let state: PinsState = { ids: [], loaded: false, listFolded: typeof localStorage === "undefined" ? false : readFold(), held: null };
const subs = new Set<() => void>();
function set(patch: Partial<PinsState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const getPins = () => state;

let loading: Promise<void> | null = null;
/** the pins from the server, once per window (again when asked: a sign-in, a test) */
export function loadPins(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api<{ lists?: Record<string, unknown> }>("/api/prefs")
    .then((r) => {
      const v = r.lists?.[KEY];
      set({ ids: Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [], loaded: true });
    })
    .catch(() => set({ loaded: true }));
  return loading;
}

export function usePins(): PinsState {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      if (!loading) void loadPins();
      return () => void subs.delete(fn);
    },
    getPins,
  );
}

let saving = Promise.resolve();
/** the new list, drawn at once and saved in order; a refused save puts back what the server has */
export function savePins(next: string[]) {
  const ids = next.slice(0, MAX_PINS);
  if (ids.length === state.ids.length && ids.every((x, i) => x === state.ids[i])) return;
  set({ ids });
  saving = saving.then(() =>
    api("/api/prefs", { method: "POST", json: { key: KEY, value: ids } }).then(
      () => undefined,
      () => void loadPins(true),
    ),
  );
}

export const keepInSideMenu = (id: string, at?: number) => savePins(pinAdd(state.ids, id, at));
export const takeOutOfSideMenu = (id: string) => savePins(pinRemove(state.ids, id));
export const movePin = (id: string, before: number) => savePins(pinMove(state.ids, id, before));
export const isKept = (id: string) => state.ids.includes(id);

export function setListFolded(folded: boolean) {
  if (folded === state.listFolded) return;
  try {
    localStorage.setItem(FOLD, folded ? "1" : "0");
  } catch { /* private window */ }
  set({ listFolded: folded });
}

export function setHeld(held: PinsState["held"]) {
  if (held === state.held || (held && state.held && held.id === state.held.id && held.over === state.held.over)) return;
  set({ held });
}

/** open a kept conversation from the side menu: the whole area is its, ChatForm's list folded */
export function openFromSideMenu(id: string) {
  setListFolded(true);
  window.location.hash = `#/chat/chat/${encodeURIComponent(id)}`;
}

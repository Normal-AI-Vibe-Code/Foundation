/**
 * Who is where (2026-11-21): the people and agents on each grid this person can see, kept current by the chat
 * socket every signed-in window holds (chat/model.ts: `where`), first read from `GET /api/whereabouts`. The server
 * side is apps/server/src/whereabouts.ts.
 */

import { useSyncExternalStore } from "react";
import type { WhereBoard } from "@foundation/protocol";
import { api } from "./api";
import { grids } from "./grids";
import { mergeWhere } from "./whereLines";

let boards: Record<string, WhereBoard> = {};
const subs = new Set<() => void>();
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

/** Foundation's own answer, and what a chat server of its own relays from other computers (chat/model.ts, in remote mode) */
let own: Record<string, WhereBoard> = {};
let fromChat: Record<string, WhereBoard> = {};

function merged() {
  // a grid the chat server names that this person's own list of grids doesn't have is dropped (whereLines.ts mergeWhere)
  const known = new Set(grids().map((g) => g.id));
  boards = Object.keys(fromChat).length ? mergeWhere(own, fromChat, (id) => known.has(id)) : own;
  for (const fn of subs) fn();
}

export function setWhereabouts(next: Record<string, WhereBoard>) {
  own = next;
  merged();
}

/** a chat server's `where` (only when ChatForm is on a server of its own): merged with Foundation's, each person once */
export function setChatWhereabouts(next: Record<string, WhereBoard>) {
  fromChat = next ?? {};
  merged();
}

/** the first look (and after a reconnect): who is where now */
export async function loadWhereabouts() {
  try {
    const r = await api<{ boards: Record<string, WhereBoard> }>("/api/whereabouts");
    setWhereabouts(r.boards ?? {});
  } catch {
    /* an older server, or signed out: nobody is shown anywhere */
  }
}

export function useWhereabouts(): Record<string, WhereBoard> {
  return useSyncExternalStore(subscribe, () => boards);
}

export { gridsOf, hereLine, mergeWhere, othersOn } from "./whereLines";

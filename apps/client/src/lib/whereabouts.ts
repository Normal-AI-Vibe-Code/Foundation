/**
 * Who is where (2026-11-21): the people and agents on each grid this person can see, kept current by the chat
 * socket every signed-in window holds (chat/model.ts: `where`), first read from `GET /api/whereabouts`. The server
 * side is apps/server/src/whereabouts.ts.
 */

import { useSyncExternalStore } from "react";
import type { WhereBoard } from "@foundation/protocol";
import { api } from "./api";

let boards: Record<string, WhereBoard> = {};
const subs = new Set<() => void>();
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export function setWhereabouts(next: Record<string, WhereBoard>) {
  boards = next;
  for (const fn of subs) fn();
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

export { gridsOf, hereLine, othersOn } from "./whereLines";

/**
 * The agents assigned to the open grid's sections (and to the grid itself): who is on each council.
 * The server keeps them in the board's `agents` map (apps/server/src/posted.ts); this reads that map,
 * and asks the server to put an agent on a place or take one off.
 */

import { useSyncExternalStore } from "react";
import { GRID_PLACE, boardMaps, type PostedAgent } from "@foundation/protocol";
import { api } from "./api";
import { activeBoard, onBoardChange } from "../sync/board";

export { GRID_PLACE };
export type { PostedAgent };

/** an agent that could be assigned: the server's own, or one of this computer's */
export interface AvailableAgent extends Omit<PostedAgent, "by" | "byName" | "at"> {
  ready: boolean;
  why?: string;
}

type Posted = Record<string, PostedAgent[]>;
const EMPTY: Posted = {};
let now: Posted = EMPTY;
let watched: ReturnType<typeof activeBoard> = null;
let unwatch: (() => void) | null = null;
const subs = new Set<() => void>();

function read() {
  const b = activeBoard();
  if (!b) return void (now = EMPTY);
  const out: Posted = {};
  for (const [place, list] of boardMaps(b.doc).agents.entries()) if (Array.isArray(list) && list.length) out[place] = list;
  now = Object.keys(out).length ? out : EMPTY;
}

function watch() {
  const b = activeBoard();
  if (b === watched) return;
  unwatch?.();
  watched = b;
  unwatch = null;
  read();
  if (!b) return;
  const map = boardMaps(b.doc).agents;
  const on = () => {
    read();
    subs.forEach((f) => f());
  };
  map.observe(on);
  unwatch = () => map.unobserve(on);
}

function subscribe(fn: () => void) {
  subs.add(fn);
  watch();
  const off = onBoardChange(() => {
    watch();
    fn();
  });
  return () => {
    subs.delete(fn);
    off();
  };
}

/** place (a section id, or GRID_PLACE) → the agents assigned there */
export function usePosted(): Posted {
  return useSyncExternalStore(subscribe, () => now);
}

export const fetchAvailable = () => api<{ agents: AvailableAgent[]; t3: "off" | "starting" | "running" | "error" }>("/api/agents/available");

export async function postAgent(place: string, agent: string) {
  const board = activeBoard()?.boardId;
  if (!board) return;
  await api(`/api/boards/${encodeURIComponent(board)}/agents`, { method: "POST", json: { place, agent } });
}

export async function unpostAgent(place: string, agent: string) {
  const board = activeBoard()?.boardId;
  if (!board) return;
  await api(`/api/boards/${encodeURIComponent(board)}/agents/remove`, { method: "POST", json: { place, agent } });
}

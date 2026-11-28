/**
 * Whether the council is up, and for what: the whole board, or one section
 * (characters/Council.tsx). This window's own, one at a time. Kept apart from
 * the component so the toolbar's rules and the menus can open it.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

export type CouncilScope = { kind: "board" } | { kind: "section"; id: string };

let open: CouncilScope | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openCouncil(scope: CouncilScope) {
  open = scope;
  selected = NONE;
  emit();
}

// the seats a line goes to (and the one the agent's pane shows); none: everyone
const NONE: string[] = [];
let selected: string[] = NONE;

/** press a seat: it joins or leaves the ones spoken to. `only`: it alone (the agent's pane, moving between agents) */
export function selectSeat(id: string, only = false) {
  selected = only ? [id] : selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  if (!selected.length) selected = NONE;
  emit();
}
export const councilSelection = () => selected;
export function useCouncilSelection(): string[] {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => selected,
  );
}

export function closeCouncil() {
  if (!open) return;
  open = null;
  selected = NONE;
  emit();
}

/** the same scope again closes it; another scope moves it there */
export function toggleCouncil(scope: CouncilScope) {
  const same = open && open.kind === scope.kind && (open.kind === "board" || (scope.kind === "section" && open.id === scope.id));
  if (same) closeCouncil();
  else openCouncil(scope);
}

export const councilOpen = () => open;

export function useCouncilOpen(): CouncilScope | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => open,
  );
}

// ---- what was said to a council (this window's; the agents panel's Council tab shows it)

export interface Said {
  id: number;
  at: number;
  text: string;
  /** who it went to, by name */
  to: string[];
  all: boolean;
  /** "board" or the section's id */
  place: string;
}
let said: Said[] = [];
let saidN = 0;
export const placeOf = (scope: CouncilScope) => (scope.kind === "board" ? "board" : scope.id);
export function logSaid(scope: CouncilScope, text: string, to: string[], all: boolean) {
  said = [...said.slice(-199), { id: ++saidN, at: Date.now(), text, to, all, place: placeOf(scope) }];
  emit();
}
export function useSaid(): Said[] {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => said,
  );
}

// ---- the conversation as the server keeps it (council.ts on the server; plan council-replies-in-panel)

export interface CouncilReply {
  name: string;
  state: "waiting" | "working" | "answered" | "none" | "elsewhere";
  text?: string;
  withheld?: string;
  session?: string;
}
export interface CouncilLine {
  id: string;
  place: string;
  text: string;
  by: string;
  mine: boolean;
  at: number;
  all: boolean;
  replies: CouncilReply[];
}

/** keep a line on the server, with the sessions it started (a seat with none answers in its own thread) */
/** the server's door, loaded when first used: this module is read by the grid's menus and tests that run without a page */
const api = async <T>(path: string, init?: Parameters<typeof import("./api").api>[1]) => (await import("./api")).api<T>(path, init);

export async function keepLine(board: string, scope: CouncilScope, text: string, to: Array<{ name: string; session?: string }>, all: boolean, requestId: string) {
  await api(`/api/boards/${encodeURIComponent(board)}/council`, { method: "POST", json: { place: placeOf(scope), text, to, all, request_id: requestId } });
  window.dispatchEvent(new Event(LINES_EVENT));
}
const LINES_EVENT = "foundation:council-lines";
/** how often an open Council tab asks again while an answer is on its way, and while nothing is */
const BUSY_MS = 2_500;
const QUIET_MS = 15_000;

/** a council's conversation on a grid, read again while it's shown (sooner while an agent is still answering) */
export function useCouncilLines(board: string | null, place: string): { lines: CouncilLine[]; loaded: boolean; error: string | null } {
  const [state, setState] = useState<{ key: string; lines: CouncilLine[]; loaded: boolean; error: string | null }>({ key: "", lines: [], loaded: false, error: null });
  const key = `${board ?? ""}|${place}`;
  useEffect(() => {
    if (!board) return;
    let off = false;
    let timer = 0;
    const read = async () => {
      window.clearTimeout(timer);
      let busy = false;
      try {
        const { lines } = await api<{ lines: CouncilLine[] }>(`/api/boards/${encodeURIComponent(board)}/council?place=${encodeURIComponent(place)}`);
        if (off) return;
        busy = lines.some((l) => l.replies.some((r) => r.state === "waiting" || r.state === "working"));
        setState({ key, lines, loaded: true, error: null });
      } catch (e) {
        if (!off) setState((s) => ({ ...s, key, loaded: true, error: (e as Error).message }));
      }
      if (!off) timer = window.setTimeout(() => void read(), busy ? BUSY_MS : QUIET_MS);
    };
    void read();
    const again = () => void read();
    window.addEventListener(LINES_EVENT, again);
    return () => {
      off = true;
      window.clearTimeout(timer);
      window.removeEventListener(LINES_EVENT, again);
    };
  }, [board, place, key]);
  return state.key === key ? state : { lines: [], loaded: false, error: null };
}

/** what a seat said back to its council's last line, as this reader may have it */
export interface SeatAnswer {
  text?: string;
  withheld?: string;
  at: number;
}
/** an answer stays under its bar this long after the line it answers */
const ANSWER_FOR_MS = 10 * 60_000;
/** each seat's answer to the last line said to it on this council, by name */
export function answersBySeat(lines: CouncilLine[], now = Date.now()): Map<string, SeatAnswer> {
  const out = new Map<string, SeatAnswer>();
  for (const l of lines) {
    if (now - l.at > ANSWER_FOR_MS) continue;
    for (const r of l.replies) {
      // a later line to it that hasn't been answered yet takes the older answer away
      if (r.state !== "answered") out.delete(r.name);
      else if (r.text || r.withheld) out.set(r.name, { ...(r.text ? { text: r.text } : {}), ...(r.withheld ? { withheld: r.withheld } : {}), at: l.at });
    }
  }
  return out;
}

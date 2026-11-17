/**
 * The crew on the open board, as something to render from: the same list
 * until an agent joins, leaves, aims somewhere else or says something new.
 *
 * The board's awareness fires on every pointer move of every person, and each
 * section's agent group reads the crew. So there's one watcher for the board:
 * it reads the crew once per change, and tells the groups only when what they
 * draw from is different. A section never renders because someone moved a
 * mouse.
 */

import { useMemo, useSyncExternalStore } from "react";
import { activeBoard, onBoardChange } from "../sync/board";
import { crewPeers, type CrewPeer } from "../shell/Crew";
import { getState } from "../state/store";
import { crewIsIn, sectionOfCrew, type CrewWhere } from "./sectionCrew";

type Board = NonNullable<ReturnType<typeof activeBoard>>;

const EMPTY: CrewPeer[] = [];
let watched: Board | null = null;
let off: (() => void) | null = null;
let crew: CrewPeer[] = EMPTY;
let key = "";
const listeners = new Set<() => void>();

/** what a group draws from: who, where, with whom, doing what */
function keyOf(list: CrewPeer[]) {
  return list
    .map((p) => {
      const c = p.crew;
      return [c.id, p.user.name, c.hue, c.status, c.doing, c.lead ?? "", c.leadName ?? "", c.asker, c.askerName, c.target?.kind ?? "", c.target?.id ?? ""].join("\u0001");
    })
    .join("\u0000");
}

function read(): boolean {
  const next = watched ? crewPeers(watched.peers()) : EMPTY;
  const k = keyOf(next);
  if (k === key) return false;
  key = k;
  crew = next.length ? next : EMPTY;
  return true;
}

function watch(board: Board | null) {
  if (board === watched) return;
  off?.();
  watched = board;
  off = board ? board.subscribe(() => read() && listeners.forEach((f) => f())) : null;
  read();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  watch(activeBoard());
  const offBoard = onBoardChange(() => {
    watch(activeBoard());
    fn();
  });
  return () => {
    listeners.delete(fn);
    offBoard();
  };
}

function snapshot() {
  watch(activeBoard());
  return crew;
}

/** every agent at work on the open board (a stable list until something a group shows changes) */
export function useCrew(): CrewPeer[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/** where things are on this board, from the store */
export const boardWhere: CrewWhere = {
  sectionOfObject(id) {
    const st = getState();
    return (st.tables[id] ?? st.maps[id] ?? st.notes[id] ?? st.media[id] ?? st.panels[id])?.sectionId;
  },
  parentOf: (id) => getState().allSections[id]?.parent,
  hasSection: (id) => id in getState().allSections,
};

/** the agents in a section (and in the sections inside it) */
export function useSectionCrew(sectionId: string): CrewPeer[] {
  const all = useCrew();
  return useMemo(() => {
    if (!all.length) return EMPTY;
    const here = all.filter((p) => crewIsIn(p.crew, sectionId, boardWhere));
    return here.length ? here : EMPTY;
  }, [all, sectionId]);
}

/** the section an agent is in (null: it hasn't aimed anywhere yet) */
export function crewSection(p: CrewPeer): string | null {
  return sectionOfCrew(p.crew, boardWhere);
}

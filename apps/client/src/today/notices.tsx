/**
 * What's waiting on a person, as a number on Today's row in the side menu (2026-11-16): things asked
 * of them and notes that tag them (other people), stages they own and what agents left for them
 * (the AI), new files and changes on their grids, and an update to the app that's ready. The same
 * `/api/today` the page draws, asked once a minute while the window is in front, so the badge and the
 * page can't disagree.
 *
 * And the Shiba, very small: two soft lights turning inside a disc, in CSS alone (no WebGL context
 * for a 16 px mark), breathing faster while it thinks or speaks.
 */

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { useUpdate } from "../update/updater";
import { useToday, type FocusItem } from "./model";

export interface Notices {
  people: number;
  agents: number;
  changes: number;
  update: boolean;
}
const NONE: Notices = { people: 0, agents: 0, changes: 0, update: false };
let now = NONE;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

import { countNotices } from "./talk";
export { countNotices };

async function read() {
  if (document.hidden) return;
  try {
    const t = await api<{ focus: FocusItem[] }>("/api/today");
    const next = { ...countNotices(t.focus), update: now.update };
    if (next.people !== now.people || next.agents !== now.agents || next.changes !== now.changes) {
      now = next;
      subs.forEach((f) => f());
    }
  } catch { /* offline: the last count stands */ }
}

function subscribe(fn: () => void) {
  subs.add(fn);
  if (!timer) {
    void read();
    timer = setInterval(() => void read(), 60_000);
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNotices(): Notices & { total: number; words: string } {
  const n = useSyncExternalStore(subscribe, () => now);
  const u = useUpdate();
  const update = u.phase === "available" || u.phase === "downloading";
  const total = n.people + n.agents + n.changes + (update ? 1 : 0);
  const words =
    [n.people && `${n.people} from people`, n.agents && `${n.agents} from agents`, n.changes && `${n.changes} new or changed`, update && "an update is ready"].filter(Boolean).join(" · ") || "Nothing is waiting on you";
  return { ...n, update, total, words };
}

/** the Shiba as a mark: its mood only changes how fast it breathes */
export function ShibaDot({ size = 18 }: { size?: number }) {
  const mood = useToday().mood;
  // the page being open elsewhere keeps the mood; at rest it is idle
  useEffect(() => {}, []);
  return <span className="shiba-dot" data-mood={mood} style={{ width: size, height: size }} aria-hidden />;
}

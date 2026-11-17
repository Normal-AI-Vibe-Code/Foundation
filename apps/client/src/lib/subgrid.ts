/**
 * A section becomes a grid of its own (2026-11-17, Josh: "Open as its own grid … should create a
 * sub-grid that can be pulled out of the grid collection and moved to other grids, but still maintain
 * a preview in the Grid it used to be in, and maintain a link to the new location").
 *
 * ⤢ on a section asks once, in place, then asks the server to do it (`extract_section`: one move for
 * everyone, done once however many people press), and opens the new grid. A section that already
 * stands for a grid just opens it. It restructures shared work, so it is a person's confirmed press.
 */

import { useSyncExternalStore } from "react";
import { api } from "./api";
import { openGrid } from "./grids";
import { activeBoard } from "../sync/board";
import { getState, openLevel, requestSnap, uid, type PanelMeta } from "../state/store";
import { toast } from "../state/ui";

/** card kinds that stay on the grid they were made on (the server's rule, said before the press) */
const STAYS: Record<string, string> = { machine: "machine", huddle: "huddle", stage: "pipeline stage" };

/** the section being asked about (one at a time), and the one being made into a grid */
let asking: string | null = null;
let making: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** show (or with null, put away) the question on a section */
export function askGrid(sectionId: string | null) {
  if (asking === sectionId) return;
  asking = sectionId;
  emit();
}
/** is this section showing the question, or being made into a grid right now */
export function useGridAsk(sectionId: string): "ask" | "making" | null {
  return useSyncExternalStore(subscribe, () => (making === sectionId ? "making" : asking === sectionId ? "ask" : null));
}

/** the grid a section stands for, when its app is a grid's card */
export const gridOfSection = (host: PanelMeta | null | undefined): string | null => (host?.panel === "grid" && host.board ? host.board : null);

/** what in this section would stay behind, in words ("the machine “Bench”"), for the question */
export function staysBehind(sectionId: string): string[] {
  const st = getState();
  const inside = new Set([sectionId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of Object.values(st.allSections)) if (s.parent && inside.has(s.parent) && !inside.has(s.id)) grew = inside.add(s.id) && true;
  }
  return Object.values(st.panels)
    .filter((p) => inside.has(p.sectionId) && p.panel in STAYS)
    .map((p) => `the ${STAYS[p.panel]} “${p.name}”`);
}

/** ⤢ on a section: open the grid it stands for, or ask to make it one */
export function openAsGrid(sectionId: string, host: PanelMeta | null | undefined) {
  const child = gridOfSection(host);
  if (child) openGrid(child);
  else askGrid(sectionId);
}

interface Extracted {
  result: { board: string; name: string; moved: number; stayed: Array<{ name: string; kind: string }>; wires: { moved: number; dropped: number }; already?: boolean };
}

/** the confirmed press: the server makes the grid, then this window opens it */
export async function makeSectionAGrid(sectionId: string): Promise<string | null> {
  const board = activeBoard()?.boardId;
  if (!board || making) return null;
  making = sectionId;
  asking = null;
  emit();
  try {
    const { result } = await api<Extracted>(`/api/boards/${encodeURIComponent(board)}/sections/${encodeURIComponent(sectionId)}/extract`, { method: "POST", json: { request_id: uid("grid") } });
    // a section open as a local level is the board again: what it showed lives in the new grid now
    if (getState().level) openLevel(null);
    window.dispatchEvent(new Event("foundation:boards"));
    const notes = [
      result.stayed.length ? `${result.stayed.map((s) => `the ${s.kind} “${s.name}”`).join(", ")} stayed where ${result.stayed.length === 1 ? "it was" : "they were"}` : "",
      result.wires.dropped ? `${result.wires.dropped} ${result.wires.dropped === 1 ? "wire" : "wires"} that crossed its edge ${result.wires.dropped === 1 ? "was" : "were"} let go` : "",
    ].filter(Boolean);
    toast(result.already ? `${result.name} is a grid already` : `${result.name} is its own grid now${notes.length ? `: ${notes.join("; ")}` : ""}`, "ok");
    openGrid(result.board);
    // the camera was on the grid it came from: show all of the new one once it's here
    onceOn(result.board, () => Object.keys(getState().sections).length > 0 && activeBoard()?.status === "live", () => requestSnap({ kind: "all" }));
    return result.board;
  } catch (e) {
    toast((e as Error).message, "bad");
    return null;
  } finally {
    making = null;
    emit();
  }
}

/** once this window is on `boardId` and `ready` says so (for up to 15 s), do `then` */
function onceOn<T>(boardId: string, ready: () => T | null | undefined | false, then: (v: T) => void) {
  const t0 = Date.now();
  const tick = window.setInterval(() => {
    const v = activeBoard()?.boardId === boardId ? ready() : null;
    if (!v && Date.now() - t0 < 15_000) return;
    window.clearInterval(tick);
    if (v) then(v);
  }, 200);
}

/** open the grid this one is inside, framed on the section that stands for this one there */
export function openParentGrid(parentId: string, childId: string) {
  openGrid(parentId);
  onceOn(
    parentId,
    () => Object.values(getState().panels).find((p) => p.panel === "grid" && p.board === childId),
    (card) => requestSnap({ kind: "section", id: card.sectionId }),
  );
}

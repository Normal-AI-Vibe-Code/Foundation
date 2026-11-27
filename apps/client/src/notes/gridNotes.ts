/**
 * Every grid's notes, for the side menu's Notes (2026-11-26, Josh: "List them all, and make sure their hierarchy
 * refers back to the grids that they are in"; docs/notes.md). The server keeps a row per note card: the grid it is
 * on, its section's path, its name, the page it shows if it's a page's card (`GET /api/notes`, only the grids this
 * person can see). Read when Notes is shown, again when grids change (`foundation:boards`) or the window comes
 * back, and every 20 s while Notes is open. Kept on the device so the tree draws at once.
 */

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { openGrid } from "../lib/grids";
import { setUi } from "../state/ui";

export interface GridNote {
  id: string;
  name: string;
  section: string;
  sectionPath: string;
  /** the note page this card shows, if it's a page's card */
  ref: string | null;
  preview: string;
  bornAt: number;
}

const KEY = "foundation-grid-notes";
let byGrid: Record<string, GridNote[]> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, GridNote[]>) : {};
  } catch {
    return {};
  }
})();
const subs = new Set<() => void>();

export async function loadGridNotes() {
  try {
    const r = await api<{ grids: Record<string, GridNote[]> }>("/api/notes");
    byGrid = r.grids;
    try {
      localStorage.setItem(KEY, JSON.stringify(byGrid));
    } catch { /* a private window */ }
    subs.forEach((f) => f());
  } catch { /* offline: the device's list stands */ }
}

/** every grid's notes; reading them again while `live` (Notes is open) */
export function useGridNotes(live: boolean): Record<string, GridNote[]> {
  useEffect(() => {
    if (!live) return;
    void loadGridNotes();
    const again = () => void loadGridNotes();
    const t = setInterval(again, 20_000);
    window.addEventListener("foundation:boards", again);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(t);
      window.removeEventListener("foundation:boards", again);
      window.removeEventListener("focus", again);
    };
  }, [live]);
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => byGrid,
  );
}

/** the grids a note page stands on as a card (the page says where it is) */
export function gridsShowing(page: string, all: Record<string, GridNote[]>): string[] {
  return Object.entries(all)
    .filter(([, notes]) => notes.some((n) => n.ref === page))
    .map(([g]) => g);
}

/** open a grid's note: a page's card opens the page; a grid's own note opens full size over its grid */
export function openGridNote(board: string, note: GridNote) {
  if (note.ref) return openGrid(note.ref);
  openGrid(board);
  setUi({ noteOpen: { board, note: note.id } });
}

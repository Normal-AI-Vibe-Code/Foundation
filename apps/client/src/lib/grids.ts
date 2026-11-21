/**
 * Every grid there is, as this person may see it: one list for the top bar's tabs, the side
 * menu (Recent, All Grids), the cards that stand for a child grid, and ⌘K.
 *
 * A grid and a board are the same thing; "grid" is the word (2026-11-15). A grid holds sections,
 * and a grid can sit inside another: its `parent`. All Grids is that tree; Recent is every grid
 * by when this device last opened it.
 *
 * Kept on the device too, so names (and roles) show offline. Reloads on a `foundation:boards`
 * window event (anything that makes, renames or files a grid fires one).
 */

import { useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * what a grid's canvas is: sections and cards, a deck of slides (a grid whose sections are the slides), a web page,
 * or an app opened as a tab of its own (2026-11-18: T3, Vision, anything that was a tool or a card and was expanded)
 */
export type SpaceKind = "grid" | "deck" | "page" | "app";
export const KIND_GLYPH: Record<SpaceKind, string> = { grid: "▦", deck: "▶", page: "◳", app: "◈" };
export const KIND_NAME: Record<SpaceKind, string> = { grid: "Grid", deck: "Presentation", page: "Web page", app: "App" };
/** a space with no grid to look at: its canvas is a page (it holds no grids, and has no sections to count) */
export const isPageKind = (k?: SpaceKind) => k === "page" || k === "app";

export interface BoardRow {
  id: string;
  name: string;
  role: "admin" | "member" | "viewer";
  kind?: SpaceKind;
  /** the grid it sits inside; null or absent at the top of All Grids */
  parent?: string | null;
  /** before grids of grids, a grid could be filed in a named folder; no longer shown */
  folder?: string | null;
  /** a page's address (an app's too, unless it is one Foundation opens itself) */
  url?: string | null;
  /** an app space's built-in app ("t3": its address is minted each time it opens) */
  app?: string | null;
  /** the look this grid pins for everyone on it; absent: paper, following the orb (the themes: DESIGN.md §2.1) */
  theme?: "day" | "night" | null;
  updated_at?: number;
}

const KEY = "foundation-boards";
let rows: BoardRow[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v as BoardRow[]) : [];
  } catch {
    return [];
  }
})();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function grids(): BoardRow[] {
  return rows;
}
export function setGrids(next: BoardRow[]) {
  rows = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* private window */ }
  emit();
}
export function useGrids(): BoardRow[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    grids,
  );
}

export async function loadGrids() {
  try {
    const r = await api<{ boards: BoardRow[] }>("/api/boards");
    setGrids(r.boards);
  } catch { /* offline: the device's list stands */ }
}

/** a grid's parent, when that parent is one this person can see (a parent they can't see reads as the top) */
export function parentOf(b: BoardRow, all: BoardRow[] = rows): BoardRow | null {
  return (b.parent && all.find((x) => x.id === b.parent)) || null;
}
/** the grids directly inside `id` (null: the top), by name */
export function childrenOf(id: string | null, all: BoardRow[] = rows): BoardRow[] {
  return all.filter((b) => (parentOf(b, all)?.id ?? null) === id).sort((a, b) => a.name.localeCompare(b.name));
}
/** the grids on the way down to this one, outermost first (not itself) */
export function gridPath(b: BoardRow, all: BoardRow[] = rows): BoardRow[] {
  const out: BoardRow[] = [];
  for (let p = parentOf(b, all), n = 0; p && n < 64; p = parentOf(p, all), n++) out.unshift(p);
  return out;
}
/** would putting `id` inside `into` make a loop? */
export function wouldLoop(id: string, into: string, all: BoardRow[] = rows): boolean {
  if (id === into) return true;
  const target = all.find((b) => b.id === into);
  return !!target && gridPath(target, all).some((p) => p.id === id);
}

/** put a grid inside another, or back at the top (null). Shown at once; the server has the last word. */
export async function fileGrid(id: string, parent: string | null): Promise<string | null> {
  const before = rows;
  setGrids(rows.map((b) => (b.id === id ? { ...b, parent } : b)));
  try {
    await api(`/api/boards/${encodeURIComponent(id)}`, { method: "POST", json: { parent } });
    window.dispatchEvent(new Event("foundation:boards"));
    return null;
  } catch (e) {
    setGrids(before);
    return (e as Error).message;
  }
}

/**
 * Open an app as a tab of its own: it becomes a space (kind "app") listed in All Grids like any grid, and
 * opening it again goes to the tab it already has. `app: "t3"` is Foundation's own; anything else is its address.
 * Returns what went wrong, or null.
 */
export async function openAppTab(what: { app?: string; url?: string; name?: string }): Promise<string | null> {
  try {
    const { id } = await api<{ id: string }>("/api/boards", { method: "POST", json: { kind: "app", ...what } });
    await loadGrids();
    openGrid(id);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** open a grid in this window (the shell listens) */
export function openGrid(id: string) {
  window.dispatchEvent(new CustomEvent("foundation:board", { detail: id }));
}

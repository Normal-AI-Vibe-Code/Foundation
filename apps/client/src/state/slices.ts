/**
 * Narrow subscriptions for the board-wide layers (SPEC §5: no React render on
 * the hot path). `GridViewport`, the two wire layers, maps and presentation
 * mode each read one slice of the store instead of all of it, so a press,
 * a drag frame or a keystroke in one card no longer re-renders them. The
 * selectors are plain functions of the state so `test/slices.test.ts` can
 * hold them to that.
 */

import { useRef, useSyncExternalStore } from "react";
import { getState, subscribe, type AppState } from "./store";

/** same keys, and each value the same object */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a) as Array<keyof T>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/**
 * A slice of the store: `select` runs once per store change, and the
 * component re-renders only when the result differs by `equal` (shallow by
 * default). Strings and numbers compare by value, so a selector can return a
 * signature of what it draws.
 */
export function useStoreSlice<T>(select: (st: AppState) => T, equal: (a: T, b: T) => boolean = shallowEqual): T {
  const cache = useRef<{ st: AppState; select: (st: AppState) => T; val: T } | null>(null);
  const get = () => {
    const st = getState();
    const c = cache.current;
    if (c && c.st === st && c.select === select) return c.val;
    const next = select(st);
    const val = c && equal(c.val, next) ? c.val : next;
    cache.current = { st, select, val };
    return val;
  };
  return useSyncExternalStore(subscribe, get);
}

/** what the grid itself draws: tracks, sections, the drop highlight, framing requests */
export function gridViewSlice(st: AppState) {
  return {
    grid: st.grid,
    sections: st.sections,
    focusLevel: st.focusLevel,
    activeSectionId: st.activeSectionId,
    expandedSection: st.expandedSection,
    snapRequest: st.snapRequest,
    sectionDragTarget: st.sectionDragTarget,
  };
}

/** the section opened full-screen as its own grid (wires redraw for the grid in view), "" on the board */
const openSection = (st: AppState) => st.level ?? (st.expandedSection && st.sections[st.expandedSection] ? st.expandedSection : "");

/**
 * What the sheet's wire layer draws (table → map and table → table): which
 * tables and maps exist, which table each map reads, and the sections they
 * sit in. A signature, so moving or typing in a card leaves it equal; the
 * per-frame geometry reads the store itself.
 */
export function sheetWiresSlice(st: AppState) {
  let tables = "";
  for (const t of Object.values(st.tables)) tables += `${t.id}@${t.sectionId},`;
  let maps = "";
  for (const m of Object.values(st.maps)) maps += `${m.id}<${m.sourceTableId ?? ""}@${m.sectionId},`;
  return { grid: st.grid, tables, maps, open: openSection(st) };
}

/**
 * What the app-wire layer draws: the links, and for each, whether its source
 * has a value (live), its port type and the two sections (for stepping back);
 * plus which apps are running (their rings). Dragging an app or an app
 * emitting a value that doesn't change any of that renders nothing.
 */
export function portWiresSlice(st: AppState) {
  let wires = "";
  for (const l of Object.values(st.links)) {
    const a = st.panels[l.from.panel];
    const b = st.panels[l.to.panel];
    const type = a?.ports.find((p) => p.id === l.from.port)?.type ?? "";
    wires += `${l.id}:${a?.outputs?.[l.from.port] !== undefined ? 1 : 0}:${type}:${a?.sectionId ?? ""}:${b?.sectionId ?? ""},`;
  }
  let running = "";
  // a machine's "running" is the machine, not an agent at work on the card: it wears no agent's ring
  // (2026-11-17: every running machine had a breathing violet ring 8 px outside its card, so outside its section when it hosts one)
  for (const p of Object.values(st.panels)) if (p.status === "running" && p.panel !== "machine") running += `${p.id}\u0000${p.createdBy ?? "agent"}\u0001`;
  return { grid: st.grid, links: st.links, wires, running, open: openSection(st) };
}

/** a map's table picker: the tables' ids and names, as a signature */
export function tableOptionsSlice(st: AppState): string {
  let out = "";
  for (const t of Object.values(st.tables)) out += `${t.id}\u0000${t.name}\u0001`;
  return out;
}

export function parsePairs(sig: string): Array<[string, string]> {
  return sig
    .split("\u0001")
    .filter(Boolean)
    .map((p) => p.split("\u0000") as [string, string]);
}

/**
 * App layout state — one spreadsheet-like Grid of sections.
 *
 * The workspace is a single Grid with column/row tracks (like a spreadsheet).
 * Sections occupy rectangular spans of tracks; splitting a section subdivides
 * a track (shifting/widening every other section that touches it), and
 * resizing a track resizes every section in it. Each section is its own
 * scrollable nested grid holding primitives (tables, maps). The viewport
 * camera snaps to sections, track bands, or the whole grid.
 */

import { useSyncExternalStore } from "react";
import { workbook } from "../engine/workbook";

let idCounter = 0;
export function uid(prefix: string): string {
  return `${prefix}_${++idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

// ---------- types ----------

interface ObjectBase {
  id: string;
  sectionId: string;
  name: string;
  /** content-space position — used only while floating */
  x: number;
  y: number;
  /** false = docked into the section's flow grid, true = free position */
  float: boolean;
  bornAt: number;
}

export interface TableMeta extends ObjectBase {
  cols: number;
  rows: number;
}

export interface MapMeta extends ObjectBase {
  w: number;
  h: number;
  sourceTableId: string | null;
  pitched: boolean;
}

export interface NoteMeta extends ObjectBase {
  w: number;
  h: number;
  text: string;
}

export interface MediaMeta extends ObjectBase {
  w: number;
  h: number;
  src: string; // object URL (session-lifetime)
  media: "image" | "video";
  autoplay: boolean; // video only
  muted: boolean; // video only
}

export type AnyObject = TableMeta | MapMeta | NoteMeta | MediaMeta;

export interface Section {
  id: string;
  name: string;
  // inclusive track spans in the grid
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  scroll: { x: number; y: number };
}

export interface GridTracks {
  cols: number[]; // track widths, world px
  rows: number[]; // track heights
}

export type SnapTarget =
  | { kind: "all" }
  | { kind: "section"; id: string }
  | { kind: "object"; id: string };

export interface AppState {
  grid: GridTracks;
  sections: Record<string, Section>;
  tables: Record<string, TableMeta>;
  maps: Record<string, MapMeta>;
  notes: Record<string, NoteMeta>;
  media: Record<string, MediaMeta>;
  activeSectionId: string;
  snapRequest: (SnapTarget & { nonce: number }) | null;
  /** cell highlighted while a section is being dragged to a new home */
  sectionDragTarget: { sectionId: string; c: number; r: number } | null;
}

// ---------- geometry constants ----------

export const CELL_W = 148;
export const CELL_H = 40;
export const HEADER_H = 52;
export const ROWNUM_W = 44;
export const COLHEAD_H = 32;

export const DEFAULT_COL_W = 1560;
export const DEFAULT_ROW_H = 1160;
export const MIN_COL_W = 420;
export const MIN_ROW_H = 340;
export const SECTION_HEADER = 42;
export const SECTION_INSET = 12; // visual gap between section card and its cell
export const CONTENT_PAD = 28;

export function tablePixelSize(t: { cols: number; rows: number }) {
  return {
    w: ROWNUM_W + t.cols * CELL_W,
    h: HEADER_H + COLHEAD_H + t.rows * CELL_H,
  };
}

export const MINI_HEADER = 34;

export function objectPixelSize(obj: AnyObject): { w: number; h: number } {
  if ("cols" in obj) return tablePixelSize(obj);
  if ("sourceTableId" in obj) return { w: obj.w, h: obj.h + HEADER_H };
  return { w: obj.w, h: obj.h + MINI_HEADER };
}

/** every primitive living in a section */
export function objectsInSection(sectionId: string): AnyObject[] {
  const st = getState();
  const all: AnyObject[] = [
    ...Object.values(st.tables),
    ...Object.values(st.maps),
    ...Object.values(st.notes),
    ...Object.values(st.media),
  ];
  return all.filter((o) => o.sectionId === sectionId);
}

export function allObjects(): AnyObject[] {
  const st = getState();
  return [
    ...Object.values(st.tables),
    ...Object.values(st.maps),
    ...Object.values(st.notes),
    ...Object.values(st.media),
  ];
}

const FLOW_GAP = 26;

/**
 * Flow layout for a section's docked primitives: shelves packed
 * left-to-right in creation order, wrapping at the section width.
 */
export function sectionLayout(sectionId: string): Map<string, { x: number; y: number }> {
  const st = getState();
  const sec = st.sections[sectionId];
  const out = new Map<string, { x: number; y: number }>();
  if (!sec) return out;
  const card = sectionCardRect(st.grid, sec);
  const availW = Math.max(360, card.w - CONTENT_PAD * 2);
  const docked = objectsInSection(sectionId)
    .filter((o) => !o.float)
    .sort((a, b) => a.bornAt - b.bornAt);
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const o of docked) {
    const { w, h } = objectPixelSize(o);
    if (x > 0 && x + w > availW) {
      x = 0;
      y += shelfH + FLOW_GAP;
      shelfH = 0;
    }
    out.set(o.id, { x, y });
    x += w + FLOW_GAP;
    shelfH = Math.max(shelfH, h);
  }
  return out;
}

/** where an object actually sits in section content space */
export function effectivePos(obj: AnyObject): { x: number; y: number } {
  if (obj.float) return { x: obj.x, y: obj.y };
  return sectionLayout(obj.sectionId).get(obj.id) ?? { x: obj.x, y: obj.y };
}

export function trackOffsets(tracks: number[]): number[] {
  const out = [0];
  for (const t of tracks) out.push(out[out.length - 1] + t);
  return out;
}

/** full cell-span rect of a section in grid world space */
export function sectionCellRect(grid: GridTracks, s: Section) {
  const xo = trackOffsets(grid.cols);
  const yo = trackOffsets(grid.rows);
  return {
    x: xo[s.c0],
    y: yo[s.r0],
    w: xo[s.c1 + 1] - xo[s.c0],
    h: yo[s.r1 + 1] - yo[s.r0],
  };
}

/** the visible card rect (inset from the cell span) */
export function sectionCardRect(grid: GridTracks, s: Section) {
  const r = sectionCellRect(grid, s);
  return {
    x: r.x + SECTION_INSET,
    y: r.y + SECTION_INSET,
    w: r.w - SECTION_INSET * 2,
    h: r.h - SECTION_INSET * 2,
  };
}

export function gridSize(grid: GridTracks) {
  const xo = trackOffsets(grid.cols);
  const yo = trackOffsets(grid.rows);
  return { w: xo[xo.length - 1], h: yo[yo.length - 1] };
}

/** live (mid-spring) section scroll positions, written by SectionView */
export const liveScroll = new Map<string, { x: number; y: number }>();

export function getLiveScroll(id: string): { x: number; y: number } {
  return liveScroll.get(id) ?? getState().sections[id]?.scroll ?? { x: 0, y: 0 };
}

/**
 * Live (mid-spring) object positions in section content space, written by
 * the object components each animation frame — lets wires and snap targets
 * track cards while they're being dragged or reflowing.
 */
export const liveObjPos = new Map<string, { x: number; y: number }>();

/** world rect of a single grid cell */
export function gridCellRect(grid: GridTracks, c: number, r: number) {
  const xo = trackOffsets(grid.cols);
  const yo = trackOffsets(grid.rows);
  return { x: xo[c], y: yo[r], w: grid.cols[c], h: grid.rows[r] };
}

/** which grid cell contains a world point (null when outside the grid) */
export function cellAtWorld(x: number, y: number): { c: number; r: number } | null {
  const { grid } = getState();
  const xo = trackOffsets(grid.cols);
  const yo = trackOffsets(grid.rows);
  if (x < 0 || y < 0 || x >= xo[xo.length - 1] || y >= yo[yo.length - 1]) return null;
  let c = 0;
  while (c < grid.cols.length - 1 && x >= xo[c + 1]) c++;
  let r = 0;
  while (r < grid.rows.length - 1 && y >= yo[r + 1]) r++;
  return { c, r };
}

export function sectionCovering(c: number, r: number): Section | null {
  for (const s of Object.values(getState().sections)) {
    if (s.c0 <= c && c <= s.c1 && s.r0 <= r && r <= s.r1) return s;
  }
  return null;
}

/** grid cells not covered by any section */
export function emptyCells(): Array<{ c: number; r: number }> {
  const { grid } = getState();
  const out: Array<{ c: number; r: number }> = [];
  for (let c = 0; c < grid.cols.length; c++) {
    for (let r = 0; r < grid.rows.length; r++) {
      if (!sectionCovering(c, r)) out.push({ c, r });
    }
  }
  return out;
}

/** world-space rect of an object (accounts for section position + scroll) */
export function objectWorldRect(obj: AnyObject) {
  const st = getState();
  const sec = st.sections[obj.sectionId];
  if (!sec) return null;
  const card = sectionCardRect(st.grid, sec);
  const scroll = getLiveScroll(sec.id);
  const { w, h } = objectPixelSize(obj);
  const pos = liveObjPos.get(obj.id) ?? effectivePos(obj);
  return {
    x: card.x + CONTENT_PAD + pos.x - scroll.x,
    y: card.y + SECTION_HEADER + CONTENT_PAD + pos.y - scroll.y,
    w,
    h,
  };
}

// ---------- store ----------

const firstSectionId = uid("sec");

let state: AppState = {
  grid: { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] },
  sections: {
    [firstSectionId]: {
      id: firstSectionId,
      name: "Section 1",
      c0: 0,
      r0: 0,
      c1: 0,
      r1: 0,
      scroll: { x: 0, y: 0 },
    },
  },
  tables: {},
  maps: {},
  notes: {},
  media: {},
  activeSectionId: firstSectionId,
  snapRequest: { kind: "all", nonce: Math.random() },
  sectionDragTarget: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getState(): AppState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState);
}

function set(partial: Partial<AppState>) {
  state = { ...state, ...partial };
  emit();
}

// ---------- snap / focus ----------

export function requestSnap(target: SnapTarget) {
  set({ snapRequest: { ...target, nonce: Math.random() } });
}

export function setActiveSection(id: string) {
  if (state.activeSectionId !== id) set({ activeSectionId: id });
}

// ---------- section actions ----------

let sectionCount = 1;

/**
 * Split a section like a spreadsheet: if it spans multiple tracks, hand the
 * later tracks to the new section; if it spans exactly one, subdivide that
 * track in half — every other section touching the track shifts or widens.
 */
export function splitSection(sectionId: string, dir: "h" | "v") {
  const s = state.sections[sectionId];
  if (!s) return;
  const grid: GridTracks = { cols: [...state.grid.cols], rows: [...state.grid.rows] };
  const sections: Record<string, Section> = { ...state.sections };
  sectionCount++;
  const fresh: Section = {
    id: uid("sec"),
    name: `Section ${sectionCount}`,
    c0: 0,
    r0: 0,
    c1: 0,
    r1: 0,
    scroll: { x: 0, y: 0 },
  };

  if (dir === "h") {
    const span = s.c1 - s.c0 + 1;
    if (span > 1) {
      const mid = s.c0 + Math.ceil(span / 2);
      Object.assign(fresh, { c0: mid, c1: s.c1, r0: s.r0, r1: s.r1 });
      sections[sectionId] = { ...s, c1: mid - 1 };
    } else {
      const k = s.c0;
      const w = grid.cols[k];
      grid.cols.splice(k, 1, Math.round(w / 2), Math.round(w / 2));
      for (const o of Object.values(sections)) {
        if (o.id === sectionId) continue;
        const n = { ...o };
        if (n.c0 > k) n.c0++;
        if (n.c1 >= k) n.c1++;
        sections[o.id] = n;
      }
      Object.assign(fresh, { c0: k + 1, c1: k + 1, r0: s.r0, r1: s.r1 });
      sections[sectionId] = { ...s };
    }
  } else {
    const span = s.r1 - s.r0 + 1;
    if (span > 1) {
      const mid = s.r0 + Math.ceil(span / 2);
      Object.assign(fresh, { r0: mid, r1: s.r1, c0: s.c0, c1: s.c1 });
      sections[sectionId] = { ...s, r1: mid - 1 };
    } else {
      const k = s.r0;
      const h = grid.rows[k];
      grid.rows.splice(k, 1, Math.round(h / 2), Math.round(h / 2));
      for (const o of Object.values(sections)) {
        if (o.id === sectionId) continue;
        const n = { ...o };
        if (n.r0 > k) n.r0++;
        if (n.r1 >= k) n.r1++;
        sections[o.id] = n;
      }
      Object.assign(fresh, { r0: k + 1, r1: k + 1, c0: s.c0, c1: s.c1 });
      sections[sectionId] = { ...s };
    }
  }

  sections[fresh.id] = fresh;
  set({
    grid,
    sections,
    activeSectionId: fresh.id,
    snapRequest: { kind: "section", id: fresh.id, nonce: Math.random() },
  });
}

/**
 * Add a fresh section beside an existing one — inserts a new track after the
 * section's span (spreadsheet insert-column/row: later sections shift,
 * ranges crossing the insertion point widen).
 */
export function addSectionAdjacent(sectionId: string, dir: "right" | "below") {
  const s = state.sections[sectionId];
  if (!s) return;
  const grid: GridTracks = { cols: [...state.grid.cols], rows: [...state.grid.rows] };
  const sections: Record<string, Section> = { ...state.sections };
  sectionCount++;
  const fresh: Section = {
    id: uid("sec"),
    name: `Section ${sectionCount}`,
    c0: 0,
    r0: 0,
    c1: 0,
    r1: 0,
    scroll: { x: 0, y: 0 },
  };

  if (dir === "right") {
    const k = s.c1 + 1;
    grid.cols.splice(k, 0, grid.cols[s.c1]);
    for (const o of Object.values(sections)) {
      const n = { ...o };
      if (n.c0 >= k) n.c0++;
      if (n.c1 >= k) n.c1++;
      sections[o.id] = n;
    }
    Object.assign(fresh, { c0: k, c1: k, r0: s.r0, r1: s.r1 });
  } else {
    const k = s.r1 + 1;
    grid.rows.splice(k, 0, grid.rows[s.r1]);
    for (const o of Object.values(sections)) {
      const n = { ...o };
      if (n.r0 >= k) n.r0++;
      if (n.r1 >= k) n.r1++;
      sections[o.id] = n;
    }
    Object.assign(fresh, { r0: k, r1: k, c0: s.c0, c1: s.c1 });
  }

  sections[fresh.id] = fresh;
  set({
    grid,
    sections,
    activeSectionId: fresh.id,
    snapRequest: { kind: "section", id: fresh.id, nonce: Math.random() },
  });
}

/**
 * Remove a section and everything in it. A neighbor sharing the exact same
 * track span on one axis absorbs the freed space; tracks no section uses
 * anymore are pruned (spreadsheet delete-column/row).
 */
export function removeSection(id: string) {
  const doomed = state.sections[id];
  if (!doomed || Object.keys(state.sections).length <= 1) return;

  // drop the section's objects
  const tables = { ...state.tables };
  const maps = { ...state.maps };
  const notes = { ...state.notes };
  const media = { ...state.media };
  for (const t of Object.values(tables)) {
    if (t.sectionId === id) {
      workbook.removeTable(t.id);
      delete tables[t.id];
    }
  }
  for (const m of Object.values(maps)) if (m.sectionId === id) delete maps[m.id];
  for (const n of Object.values(notes)) if (n.sectionId === id) delete notes[n.id];
  for (const m of Object.values(media)) {
    if (m.sectionId === id) {
      URL.revokeObjectURL(m.src);
      delete media[m.id];
    }
  }

  const sections: Record<string, Section> = { ...state.sections };
  delete sections[id];

  // let an aligned neighbor absorb the hole
  const others = Object.values(sections);
  const above = others.find((o) => o.c0 === doomed.c0 && o.c1 === doomed.c1 && o.r1 === doomed.r0 - 1);
  const below = others.find((o) => o.c0 === doomed.c0 && o.c1 === doomed.c1 && o.r0 === doomed.r1 + 1);
  const left = others.find((o) => o.r0 === doomed.r0 && o.r1 === doomed.r1 && o.c1 === doomed.c0 - 1);
  const right = others.find((o) => o.r0 === doomed.r0 && o.r1 === doomed.r1 && o.c0 === doomed.c1 + 1);
  if (above) sections[above.id] = { ...above, r1: doomed.r1 };
  else if (below) sections[below.id] = { ...below, r0: doomed.r0 };
  else if (left) sections[left.id] = { ...left, c1: doomed.c1 };
  else if (right) sections[right.id] = { ...right, c0: doomed.c0 };

  // prune tracks nothing spans anymore
  const grid: GridTracks = { cols: [...state.grid.cols], rows: [...state.grid.rows] };
  pruneEmptyTracks(grid, sections);

  const nextActive =
    state.activeSectionId === id ? Object.keys(sections)[0] : state.activeSectionId;
  set({
    grid,
    sections,
    tables,
    maps,
    notes,
    media,
    activeSectionId: nextActive,
    snapRequest: { kind: "all", nonce: Math.random() },
  });
}

/** drop tracks that no section spans anymore, shifting spans down */
function pruneEmptyTracks(grid: GridTracks, sections: Record<string, Section>) {
  const secList = () => Object.values(sections);
  for (let c = grid.cols.length - 1; c >= 0; c--) {
    if (grid.cols.length <= 1) break;
    if (secList().some((o) => o.c0 <= c && c <= o.c1)) continue;
    grid.cols.splice(c, 1);
    for (const o of secList()) {
      const n = { ...o };
      if (n.c0 > c) n.c0--;
      if (n.c1 >= c) n.c1--;
      sections[o.id] = n;
    }
  }
  for (let r = grid.rows.length - 1; r >= 0; r--) {
    if (grid.rows.length <= 1) break;
    if (secList().some((o) => o.r0 <= r && r <= o.r1)) continue;
    grid.rows.splice(r, 1);
    for (const o of secList()) {
      const n = { ...o };
      if (n.r0 > r) n.r0--;
      if (n.r1 >= r) n.r1--;
      sections[o.id] = n;
    }
  }
}

export function setSectionDragTarget(target: AppState["sectionDragTarget"]) {
  const a = state.sectionDragTarget;
  if (
    a?.sectionId === target?.sectionId &&
    a?.c === target?.c &&
    a?.r === target?.r
  )
    return;
  set({ sectionDragTarget: target });
}

/**
 * Move a section to another grid cell: swap spans when dropping onto a
 * sibling, occupy the cell when dropping onto empty grid.
 */
export function moveSectionTo(id: string, c: number, r: number) {
  const s = state.sections[id];
  if (!s) return;
  if (s.c0 <= c && c <= s.c1 && s.r0 <= r && r <= s.r1) return; // dropped on itself
  const sections: Record<string, Section> = { ...state.sections };
  const target = sectionCovering(c, r);
  if (target) {
    sections[id] = { ...s, c0: target.c0, c1: target.c1, r0: target.r0, r1: target.r1 };
    sections[target.id] = { ...target, c0: s.c0, c1: s.c1, r0: s.r0, r1: s.r1 };
  } else {
    sections[id] = { ...s, c0: c, c1: c, r0: r, r1: r };
  }
  const grid: GridTracks = { cols: [...state.grid.cols], rows: [...state.grid.rows] };
  pruneEmptyTracks(grid, sections);
  set({ grid, sections, activeSectionId: id });
}

/** create a fresh section in an uncovered grid cell */
export function createSectionAt(c: number, r: number) {
  if (sectionCovering(c, r)) return;
  sectionCount++;
  const fresh: Section = {
    id: uid("sec"),
    name: `Section ${sectionCount}`,
    c0: c,
    c1: c,
    r0: r,
    r1: r,
    scroll: { x: 0, y: 0 },
  };
  set({
    sections: { ...state.sections, [fresh.id]: fresh },
    activeSectionId: fresh.id,
    snapRequest: { kind: "section", id: fresh.id, nonce: Math.random() },
  });
}

export function renameSection(id: string, name: string) {
  const s = state.sections[id];
  if (!s || !name.trim()) return;
  set({ sections: { ...state.sections, [id]: { ...s, name: name.trim() } } });
}

export function setSectionScroll(id: string, x: number, y: number) {
  const s = state.sections[id];
  if (!s) return;
  set({ sections: { ...state.sections, [id]: { ...s, scroll: { x, y } } } });
}

// ---------- track resizing (spreadsheet column/row semantics) ----------

export function resizeCol(i: number, w: number) {
  const cols = [...state.grid.cols];
  if (i < 0 || i >= cols.length) return;
  cols[i] = Math.max(MIN_COL_W, Math.min(2600, Math.round(w)));
  set({ grid: { ...state.grid, cols } });
}

export function resizeRow(i: number, h: number) {
  const rows = [...state.grid.rows];
  if (i < 0 || i >= rows.length) return;
  rows[i] = Math.max(MIN_ROW_H, Math.min(2400, Math.round(h)));
  set({ grid: { ...state.grid, rows } });
}

// ---------- float / dock ----------

type ObjKey = "tables" | "maps" | "notes" | "media";

function findObject(id: string): { key: ObjKey; obj: AnyObject } | null {
  for (const key of ["tables", "maps", "notes", "media"] as ObjKey[]) {
    const obj = (state[key] as Record<string, AnyObject>)[id];
    if (obj) return { key, obj };
  }
  return null;
}

export function setObjectFloat(id: string, float: boolean) {
  const found = findObject(id);
  if (!found || found.obj.float === float) return;
  // when releasing into float, freeze the current flow position so the
  // object doesn't jump
  const pos = float ? effectivePos(found.obj) : { x: found.obj.x, y: found.obj.y };
  set({
    [found.key]: {
      ...(state[found.key] as Record<string, AnyObject>),
      [id]: { ...found.obj, float, x: pos.x, y: pos.y },
    },
  } as Partial<AppState>);
}

// ---------- note actions ----------

let noteCount = 0;

export function addNote(sectionId: string, text?: string): NoteMeta {
  noteCount++;
  const meta: NoteMeta = {
    id: uid("note"),
    sectionId,
    name: `Note ${noteCount}`,
    x: 0,
    y: 0,
    w: 420,
    h: 300,
    text: text ?? "## New note\n\nDouble-click to edit. **Markdown** works:\n\n- lists\n- `code`\n- [links](https://example.com)",
    float: false,
    bornAt: performance.now(),
  };
  set({
    notes: { ...state.notes, [meta.id]: meta },
    activeSectionId: sectionId,
    snapRequest: { kind: "object", id: meta.id, nonce: Math.random() },
  });
  return meta;
}

export function updateNoteText(id: string, text: string) {
  const n = state.notes[id];
  if (!n) return;
  set({ notes: { ...state.notes, [id]: { ...n, text } } });
}

export function removeNote(id: string) {
  const { [id]: gone, ...rest } = state.notes;
  if (!gone) return;
  set({ notes: rest });
}

export function moveNote(id: string, x: number, y: number) {
  const n = state.notes[id];
  if (!n) return;
  set({ notes: { ...state.notes, [id]: { ...n, x: Math.max(0, x), y: Math.max(0, y) } } });
}

export function resizeNote(id: string, w: number, h: number) {
  const n = state.notes[id];
  if (!n) return;
  set({
    notes: {
      ...state.notes,
      [id]: { ...n, w: Math.max(220, Math.min(1200, w)), h: Math.max(120, Math.min(1400, h)) },
    },
  });
}

// ---------- media actions (images & videos from disk) ----------

export function addMedia(
  sectionId: string,
  src: string,
  media: "image" | "video",
  name: string,
  w: number,
  h: number,
): MediaMeta {
  // fit oversized media to a sane card size, keep aspect
  const maxW = 560;
  const maxH = 460;
  const scale = Math.min(1, maxW / w, maxH / h);
  const meta: MediaMeta = {
    id: uid("media"),
    sectionId,
    name,
    x: 0,
    y: 0,
    w: Math.max(180, Math.round(w * scale)),
    h: Math.max(120, Math.round(h * scale)),
    src,
    media,
    autoplay: true,
    muted: true,
    float: false,
    bornAt: performance.now(),
  };
  set({
    media: { ...state.media, [meta.id]: meta },
    activeSectionId: sectionId,
    snapRequest: { kind: "object", id: meta.id, nonce: Math.random() },
  });
  return meta;
}

export function removeMedia(id: string) {
  const { [id]: gone, ...rest } = state.media;
  if (!gone) return;
  URL.revokeObjectURL(gone.src);
  set({ media: rest });
}

export function moveMedia(id: string, x: number, y: number) {
  const m = state.media[id];
  if (!m) return;
  set({ media: { ...state.media, [id]: { ...m, x: Math.max(0, x), y: Math.max(0, y) } } });
}

export function resizeMedia(id: string, w: number, h: number) {
  const m = state.media[id];
  if (!m) return;
  set({
    media: {
      ...state.media,
      [id]: { ...m, w: Math.max(160, Math.min(1400, w)), h: Math.max(100, Math.min(1200, h)) },
    },
  });
}

export function setMediaFlag(id: string, patch: Partial<Pick<MediaMeta, "autoplay" | "muted">>) {
  const m = state.media[id];
  if (!m) return;
  set({ media: { ...state.media, [id]: { ...m, ...patch } } });
}

// ---------- table actions ----------

const DEFAULT_COLS = 4;
const DEFAULT_ROWS = 8;
let tableCount = 0;

export function createTable(sectionId: string, atX?: number, atY?: number): TableMeta {
  const id = uid("table");
  tableCount++;
  let name = `Table ${tableCount}`;
  while (!tableNameFree(name)) {
    tableCount++;
    name = `Table ${tableCount}`;
  }
  const cols = DEFAULT_COLS;
  const rows = DEFAULT_ROWS;
  const meta: TableMeta = {
    id,
    sectionId,
    name,
    x: atX ?? 0,
    y: atY ?? 0,
    cols,
    rows,
    float: false,
    bornAt: performance.now(),
  };
  workbook.addTable(id, name, cols, rows);
  set({
    tables: { ...state.tables, [id]: meta },
    activeSectionId: sectionId,
    snapRequest: { kind: "object", id, nonce: Math.random() },
  });
  return meta;
}

function tableNameFree(name: string): boolean {
  return !Object.values(state.tables).some(
    (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
}

export function removeTable(id: string) {
  const { [id]: gone, ...rest } = state.tables;
  if (!gone) return;
  workbook.removeTable(id);
  set({ tables: rest });
}

export function moveTable(id: string, x: number, y: number) {
  const t = state.tables[id];
  if (!t) return;
  set({ tables: { ...state.tables, [id]: { ...t, x: Math.max(0, x), y: Math.max(0, y) } } });
}

export function renameTable(id: string, name: string): boolean {
  const t = state.tables[id];
  if (!t || name.trim() === "") return false;
  if (!workbook.renameTable(id, name.trim())) return false;
  set({ tables: { ...state.tables, [id]: { ...t, name: name.trim() } } });
  return true;
}

export function resizeTable(id: string, cols: number, rows: number) {
  const t = state.tables[id];
  if (!t) return;
  cols = Math.max(1, Math.min(26, cols));
  rows = Math.max(1, Math.min(200, rows));
  workbook.resize(id, cols, rows);
  set({ tables: { ...state.tables, [id]: { ...t, cols, rows } } });
}

// ---------- map actions ----------

const MAP_W = 640;
const MAP_H = 440;
let mapCount = 0;

export function createMap(sectionId: string, atX?: number, atY?: number): MapMeta {
  const id = uid("map");
  mapCount++;
  // default binding: the most recently created table anywhere
  const allTables = Object.values(state.tables);
  const source = allTables.length ? allTables[allTables.length - 1] : null;
  const meta: MapMeta = {
    id,
    sectionId,
    name: `Map ${mapCount}`,
    x: atX ?? 0,
    y: atY ?? 0,
    w: MAP_W,
    h: MAP_H,
    sourceTableId: source?.id ?? null,
    pitched: true,
    float: false,
    bornAt: performance.now(),
  };
  set({
    maps: { ...state.maps, [id]: meta },
    activeSectionId: sectionId,
    snapRequest: { kind: "object", id, nonce: Math.random() },
  });
  return meta;
}

export function removeMap(id: string) {
  const { [id]: gone, ...rest } = state.maps;
  if (!gone) return;
  set({ maps: rest });
}

export function moveMap(id: string, x: number, y: number) {
  const m = state.maps[id];
  if (!m) return;
  set({ maps: { ...state.maps, [id]: { ...m, x: Math.max(0, x), y: Math.max(0, y) } } });
}

export function resizeMap(id: string, w: number, h: number) {
  const m = state.maps[id];
  if (!m) return;
  set({
    maps: {
      ...state.maps,
      [id]: { ...m, w: Math.max(320, Math.min(1600, w)), h: Math.max(240, Math.min(1200, h)) },
    },
  });
}

export function bindMap(id: string, sourceTableId: string | null) {
  const m = state.maps[id];
  if (!m) return;
  set({ maps: { ...state.maps, [id]: { ...m, sourceTableId } } });
}

export function toggleMapPitch(id: string) {
  const m = state.maps[id];
  if (!m) return;
  set({ maps: { ...state.maps, [id]: { ...m, pitched: !m.pitched } } });
}

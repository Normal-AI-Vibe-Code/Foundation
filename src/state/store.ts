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
import { sfx } from "../sound/sfx";

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
  /** which layer the keyboard/context currently addresses */
  focusLevel: "grid" | "section" | "object";
  activeObjectId: string | null;
  /** multi-selected sections (ctrl/cmd-click, shift-click) — for merge etc. */
  selectedSectionIds: string[];
  snapRequest: (SnapTarget & { nonce: number }) | null;
  /** cell highlighted while a section is being dragged to a new home */
  sectionDragTarget: { sectionId: string; c: number; r: number } | null;
  /** foreign section hovered while a primitive card is being dragged */
  objectDropTarget: { objId: string; sectionId: string } | null;
  /** a primitive drag in progress — drives the trash drop-target overlay */
  dragHud: { objId: string; overTrash: boolean } | null;
  /** section awaiting the remove-confirmation popover (e.g. via context menu) */
  pendingRemoval: string | null;
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
 * left-to-right in creation order, wrapping at the section width, and
 * flowing AROUND floating cards so nothing ever overlays anything.
 */
export function sectionLayout(sectionId: string): Map<string, { x: number; y: number }> {
  const st = getState();
  const sec = st.sections[sectionId];
  const out = new Map<string, { x: number; y: number }>();
  if (!sec) return out;
  const card = sectionCardRect(st.grid, sec);
  const availW = Math.max(360, card.w - CONTENT_PAD * 2);
  const all = objectsInSection(sectionId);
  const docked = all.filter((o) => !o.float).sort((a, b) => a.bornAt - b.bornAt);
  const floaters = all
    .filter((o) => o.float)
    .map((o) => {
      const s = objectPixelSize(o);
      return { x: o.x, y: o.y, w: s.w, h: s.h };
    });
  const collide = (x: number, y: number, w: number, h: number) =>
    floaters.find(
      (f) =>
        x < f.x + f.w + FLOW_GAP &&
        x + w + FLOW_GAP > f.x &&
        y < f.y + f.h + FLOW_GAP &&
        y + h + FLOW_GAP > f.y,
    );

  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const o of docked) {
    const { w, h } = objectPixelSize(o);
    let guard = 0;
    while (guard++ < 80) {
      if (x > 0 && x + w > availW) {
        x = 0;
        y += shelfH + FLOW_GAP;
        shelfH = 0;
        continue;
      }
      const hit = collide(x, y, w, h);
      if (!hit) break;
      const nextX = hit.x + hit.w + FLOW_GAP;
      if (nextX + w <= availW) {
        x = nextX;
      } else {
        x = 0;
        y = Math.max(y + FLOW_GAP, hit.y + hit.h + FLOW_GAP);
        shelfH = 0;
      }
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
  focusLevel: "grid",
  activeObjectId: null,
  selectedSectionIds: [],
  snapRequest: { kind: "all", nonce: Math.random() },
  sectionDragTarget: null,
  objectDropTarget: null,
  dragHud: null,
  pendingRemoval: null,
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

// ---------- persistence hydration ----------

function maxNamed(names: string[], pattern: RegExp): number {
  let max = 0;
  for (const n of names) {
    const m = n.match(pattern);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/**
 * Replace the document portion of the state with a persisted snapshot.
 * Interaction state resets; naming counters re-sync so fresh objects don't
 * collide; bornAt is renormalized to negative values so objects created in
 * this session (performance.now() ≥ 0) always flow after restored ones.
 */
export function hydrateState(
  saved: Pick<
    AppState,
    "grid" | "sections" | "tables" | "maps" | "notes" | "media" | "activeSectionId"
  >,
) {
  const all: AnyObject[] = [
    ...Object.values(saved.tables),
    ...Object.values(saved.maps),
    ...Object.values(saved.notes),
    ...Object.values(saved.media),
  ].sort((a, b) => a.bornAt - b.bornAt);
  all.forEach((o, i) => (o.bornAt = i - all.length));

  const sectionNames = Object.values(saved.sections).map((s) => s.name);
  sectionCount = Math.max(Object.keys(saved.sections).length, maxNamed(sectionNames, /^Section (\d+)$/));
  tableCount = maxNamed(Object.values(saved.tables).map((t) => t.name), /^Table (\d+)$/);
  mapCount = maxNamed(Object.values(saved.maps).map((m) => m.name), /^Map (\d+)$/);
  noteCount = maxNamed(Object.values(saved.notes).map((n) => n.name), /^Note (\d+)$/);

  const activeSectionId = saved.sections[saved.activeSectionId]
    ? saved.activeSectionId
    : Object.keys(saved.sections)[0];

  state = {
    ...state,
    ...saved,
    activeSectionId,
    focusLevel: "grid",
    activeObjectId: null,
    selectedSectionIds: [],
    sectionDragTarget: null,
    objectDropTarget: null,
    pendingRemoval: null,
    snapRequest: { kind: "all", nonce: Math.random() },
  };
  emit();
}

// ---------- snap / focus ----------

export function requestSnap(target: SnapTarget) {
  set({ snapRequest: { ...target, nonce: Math.random() } });
}

export function setActiveSection(id: string) {
  if (state.activeSectionId === id && state.focusLevel === "section" && !state.activeObjectId)
    return;
  if (state.focusLevel !== "section") sfx.tick();
  set({ activeSectionId: id, focusLevel: "section", activeObjectId: null });
}

export function setActiveObject(id: string) {
  const found = findObject(id);
  if (!found) return;
  if (state.activeObjectId === id && state.focusLevel === "object") return;
  if (state.activeObjectId !== id) sfx.tick();
  set({
    activeObjectId: id,
    activeSectionId: found.obj.sectionId,
    focusLevel: "object",
  });
}

export function setFocusGrid() {
  if (state.focusLevel === "grid") return;
  sfx.tick();
  set({ focusLevel: "grid", activeObjectId: null });
}

/** step one level up: object → section → grid */
export function focusUp() {
  if (state.selectedSectionIds.length > 0) {
    // Escape drops the multi-select before changing levels
    set({ selectedSectionIds: [] });
    return;
  }
  if (state.focusLevel === "object") {
    set({ focusLevel: "section", activeObjectId: null });
    requestSnap({ kind: "section", id: state.activeSectionId });
  } else if (state.focusLevel === "section") {
    set({ focusLevel: "grid", activeObjectId: null });
    requestSnap({ kind: "all" });
  } else {
    requestSnap({ kind: "all" });
  }
}

export function getObject(id: string): AnyObject | null {
  return findObject(id)?.obj ?? null;
}

/** spatially nearest section in a direction (for section-level arrows) */
export function neighborSection(fromId: string, dir: "left" | "right" | "up" | "down"): Section | null {
  const st = getState();
  const cur = st.sections[fromId];
  if (!cur) return null;
  const cr = sectionCellRect(st.grid, cur);
  const cx = cr.x + cr.w / 2;
  const cy = cr.y + cr.h / 2;
  let best: { s: Section; score: number } | null = null;
  for (const s of Object.values(st.sections)) {
    if (s.id === fromId) continue;
    const r = sectionCellRect(st.grid, s);
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    const dx = x - cx;
    const dy = y - cy;
    let primary = 0;
    let cross = 0;
    if (dir === "left") [primary, cross] = [-dx, Math.abs(dy)];
    else if (dir === "right") [primary, cross] = [dx, Math.abs(dy)];
    else if (dir === "up") [primary, cross] = [-dy, Math.abs(dx)];
    else [primary, cross] = [dy, Math.abs(dx)];
    if (primary <= 1) continue; // wrong direction
    const score = primary + cross * 2;
    if (!best || score < best.score) best = { s, score };
  }
  return best?.s ?? null;
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
  sfx.split();
  set({
    grid,
    sections,
    activeSectionId: fresh.id,
    snapRequest: { kind: "section", id: fresh.id, nonce: Math.random() },
  });
}

/**
 * Add a fresh section beside an existing one — inserts a new track next to
 * the section's span (spreadsheet insert-column/row: later sections shift,
 * ranges crossing the insertion point widen).
 */
export function addSectionAdjacent(
  sectionId: string,
  dir: "right" | "below" | "left" | "above",
) {
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

  if (dir === "right" || dir === "left") {
    // new track index: after the span for "right", before it for "left"
    const k = dir === "right" ? s.c1 + 1 : s.c0;
    grid.cols.splice(k, 0, grid.cols[dir === "right" ? s.c1 : s.c0]);
    for (const o of Object.values(sections)) {
      const n = { ...o };
      if (n.c0 >= k) n.c0++;
      if (n.c1 >= k) n.c1++;
      sections[o.id] = n;
    }
    const home = sections[sectionId]; // may have shifted
    Object.assign(fresh, { c0: k, c1: k, r0: home.r0, r1: home.r1 });
  } else {
    const k = dir === "below" ? s.r1 + 1 : s.r0;
    grid.rows.splice(k, 0, grid.rows[dir === "below" ? s.r1 : s.r0]);
    for (const o of Object.values(sections)) {
      const n = { ...o };
      if (n.r0 >= k) n.r0++;
      if (n.r1 >= k) n.r1++;
      sections[o.id] = n;
    }
    const home = sections[sectionId];
    Object.assign(fresh, { r0: k, r1: k, c0: home.c0, c1: home.c1 });
  }

  sections[fresh.id] = fresh;
  sfx.split();
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

  sfx.trash();
  const nextActive =
    state.activeSectionId === id ? Object.keys(sections)[0] : state.activeSectionId;
  const objGone =
    state.activeObjectId !== null && !getObjectIn(state.activeObjectId, tables, maps, notes, media);
  set({
    grid,
    sections,
    tables,
    maps,
    notes,
    media,
    activeSectionId: nextActive,
    selectedSectionIds: state.selectedSectionIds.filter((s) => s !== id),
    ...(objGone ? { activeObjectId: null, focusLevel: "grid" as const } : {}),
    snapRequest: { kind: "all", nonce: Math.random() },
    pendingRemoval: null,
  });
}

function getObjectIn(
  id: string,
  ...records: Array<Record<string, AnyObject>>
): AnyObject | undefined {
  for (const r of records) if (r[id]) return r[id];
  return undefined;
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
  sfx.drop();
  set({ grid, sections, activeSectionId: id });
}

/** create a fresh section in an uncovered grid cell */
export function createSectionAt(c: number, r: number): Section | null {
  if (sectionCovering(c, r)) return null;
  sfx.split();
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
  return fresh;
}

// ---------- multi-select & merge ----------

export function toggleSectionSelected(id: string) {
  if (!state.sections[id]) return;
  let sel = [...state.selectedSectionIds];
  // seed the selection with the active section so the first modifier-click
  // already forms a pair
  if (sel.length === 0 && id !== state.activeSectionId && state.sections[state.activeSectionId]) {
    sel.push(state.activeSectionId);
  }
  if (sel.includes(id)) sel = sel.filter((s) => s !== id);
  else sel.push(id);
  if (sel.length === 1) sel = []; // a lone section isn't a multi-select
  sfx.tick();
  set({
    selectedSectionIds: sel,
    activeSectionId: id,
    focusLevel: "section",
    activeObjectId: null,
  });
}

/** shift-click: select every section touching the rect between active and target */
export function selectSectionRange(toId: string) {
  const from = state.sections[state.activeSectionId];
  const to = state.sections[toId];
  if (!from || !to) return;
  const c0 = Math.min(from.c0, to.c0);
  const c1 = Math.max(from.c1, to.c1);
  const r0 = Math.min(from.r0, to.r0);
  const r1 = Math.max(from.r1, to.r1);
  const sel = Object.values(state.sections)
    .filter((s) => s.c0 <= c1 && s.c1 >= c0 && s.r0 <= r1 && s.r1 >= r0)
    .map((s) => s.id);
  sfx.tick();
  set({
    selectedSectionIds: sel.length > 1 ? sel : [],
    focusLevel: "section",
    activeObjectId: null,
  });
}

export function clearSectionSelection() {
  if (state.selectedSectionIds.length === 0) return;
  set({ selectedSectionIds: [] });
}

/**
 * Sections can merge only when their cell spans tile a solid rectangle.
 * Spans never overlap, so covered area == bounding-box area ⇔ exact tiling.
 */
export function canMergeSections(ids: string[]): boolean {
  const secs = ids.map((id) => state.sections[id]).filter(Boolean) as Section[];
  if (secs.length < 2) return false;
  const c0 = Math.min(...secs.map((s) => s.c0));
  const c1 = Math.max(...secs.map((s) => s.c1));
  const r0 = Math.min(...secs.map((s) => s.r0));
  const r1 = Math.max(...secs.map((s) => s.r1));
  const covered = secs.reduce((a, s) => a + (s.c1 - s.c0 + 1) * (s.r1 - s.r0 + 1), 0);
  return covered === (c1 - c0 + 1) * (r1 - r0 + 1);
}

/**
 * Merge sections into one: the survivor's span grows to the union rectangle
 * and it absorbs every object from the others. The active section survives
 * when it's part of the selection, otherwise the top-left one.
 */
export function mergeSections(ids: string[]) {
  if (!canMergeSections(ids)) {
    sfx.nope();
    return;
  }
  const secs = ids.map((id) => state.sections[id]).filter(Boolean) as Section[];
  const c0 = Math.min(...secs.map((s) => s.c0));
  const c1 = Math.max(...secs.map((s) => s.c1));
  const r0 = Math.min(...secs.map((s) => s.r0));
  const r1 = Math.max(...secs.map((s) => s.r1));
  const survivor = ids.includes(state.activeSectionId)
    ? state.sections[state.activeSectionId]
    : secs.find((s) => s.c0 === c0 && s.r0 === r0)!;

  const doomed = new Set(ids.filter((id) => id !== survivor.id));
  const adopt = <T extends AnyObject>(rec: Record<string, T>): Record<string, T> => {
    let changed = false;
    const out = { ...rec };
    for (const o of Object.values(rec)) {
      if (doomed.has(o.sectionId)) {
        out[o.id] = { ...o, sectionId: survivor.id };
        changed = true;
      }
    }
    return changed ? out : rec;
  };

  const sections: Record<string, Section> = { ...state.sections };
  for (const id of doomed) delete sections[id];
  sections[survivor.id] = { ...survivor, c0, c1, r0, r1 };

  sfx.connect();
  set({
    sections,
    tables: adopt(state.tables),
    maps: adopt(state.maps),
    notes: adopt(state.notes),
    media: adopt(state.media),
    selectedSectionIds: [],
    activeSectionId: survivor.id,
    focusLevel: "section",
    activeObjectId: null,
    snapRequest: { kind: "section", id: survivor.id, nonce: Math.random() },
  });
}

export function mergeSelectedSections() {
  mergeSections(state.selectedSectionIds);
}

export function renameSection(id: string, name: string) {
  const s = state.sections[id];
  if (!s || !name.trim()) return;
  set({ sections: { ...state.sections, [id]: { ...s, name: name.trim() } } });
}

/** ask a section to show its remove-confirmation popover */
export function requestRemoveSection(id: string | null) {
  if (state.pendingRemoval !== id) set({ pendingRemoval: id });
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
  if (float) sfx.lift();
  else sfx.drop();
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

// ---------- moving primitives between sections ----------

export function setObjectDropTarget(target: AppState["objectDropTarget"]) {
  const a = state.objectDropTarget;
  if (a?.objId === target?.objId && a?.sectionId === target?.sectionId) return;
  set({ objectDropTarget: target });
}

/**
 * Re-parent a primitive into another section, keeping it visually where it
 * was dropped: worldX/Y is the card's top-left in grid world space, converted
 * into the target section's content space. The card arrives floating.
 */
export function moveObjectToSection(
  id: string,
  sectionId: string,
  worldX: number,
  worldY: number,
): boolean {
  const found = findObject(id);
  const sec = state.sections[sectionId];
  if (!found || !sec || found.obj.sectionId === sectionId) return false;
  const card = sectionCardRect(state.grid, sec);
  const scroll = getLiveScroll(sectionId);
  const x = Math.max(0, worldX - (card.x + CONTENT_PAD) + scroll.x);
  const y = Math.max(0, worldY - (card.y + SECTION_HEADER + CONTENT_PAD) + scroll.y);
  sfx.drop();
  set({
    [found.key]: {
      ...(state[found.key] as Record<string, AnyObject>),
      [id]: { ...found.obj, sectionId, float: true, x, y },
    },
    activeSectionId: sectionId,
    activeObjectId: id,
    focusLevel: "object",
    objectDropTarget: null,
  } as Partial<AppState>);
  return true;
}

/** which section the pointer hovered at the last drag move (null = void) */
let lastHoverSectionId: string | null = null;

/** call on grab: shows the trash target and seeds hover tracking */
export function beginObjectDrag(id: string) {
  const obj = findObject(id)?.obj;
  if (!obj) return;
  lastHoverSectionId = obj.sectionId;
  set({ dragHud: { objId: id, overTrash: false } });
}

/**
 * Called each move of a card drag: which foreign section is the pointer
 * over, and is it hovering the trash target? Feeds the highlights and the
 * decision on release.
 */
export function trackObjectDrag(
  el: HTMLElement | null,
  id: string,
  clientX: number,
  clientY: number,
  scale: number,
) {
  const obj = findObject(id)?.obj;
  if (!obj) return;
  // trash hit-test happens in screen space — the overlay is viewport-fixed
  let overTrash = false;
  const trash = document.querySelector(".drag-trash");
  if (trash) {
    const r = trash.getBoundingClientRect();
    const pad = 12; // a forgiving halo around the icon
    overTrash =
      clientX >= r.left - pad &&
      clientX <= r.right + pad &&
      clientY >= r.top - pad &&
      clientY <= r.bottom + pad;
  }
  const hud = state.dragHud;
  if (!hud || hud.objId !== id || hud.overTrash !== overTrash) {
    set({ dragHud: { objId: id, overTrash } });
  }
  const world = el?.closest(".world") as HTMLElement | null;
  if (!world) return;
  const wr = world.getBoundingClientRect();
  const cell = cellAtWorld((clientX - wr.left) / scale, (clientY - wr.top) / scale);
  const over = cell ? sectionCovering(cell.c, cell.r) : null;
  lastHoverSectionId = over?.id ?? null;
  setObjectDropTarget(
    !overTrash && over && over.id !== obj.sectionId
      ? { objId: id, sectionId: over.id }
      : null,
  );
}

/** remove any primitive by id, whatever its type */
export function removeObject(id: string) {
  const found = findObject(id);
  if (!found) return;
  if (found.key === "tables") removeTable(id);
  else if (found.key === "maps") removeMap(id);
  else if (found.key === "notes") removeNote(id);
  else removeMedia(id);
}

/**
 * Call on release. Decides the drop:
 *  - "deleted"  — dropped on the trash target
 *  - "moved"    — re-parented into the hovered foreign section
 *  - "stay"     — released over its home section; caller commits the move
 *  - "returned" — released over the void / an empty cell; caller springs
 *                 the card back to where it was grabbed
 */
export function endObjectDrag(id: string): "deleted" | "moved" | "stay" | "returned" {
  const hud = state.dragHud;
  const target = state.objectDropTarget;
  const overTrash = hud?.objId === id && hud.overTrash;
  const hover = lastHoverSectionId;
  if (state.dragHud || state.objectDropTarget) {
    set({ dragHud: null, objectDropTarget: null });
  }
  const obj = findObject(id)?.obj;
  if (!obj) return "stay";
  if (overTrash) {
    removeObject(id);
    return "deleted";
  }
  if (target && target.objId === id) {
    const rect = objectWorldRect(obj);
    if (rect && moveObjectToSection(id, target.sectionId, rect.x, rect.y)) return "moved";
  }
  if (hover === obj.sectionId) return "stay";
  sfx.nope();
  return "returned";
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
  sfx.pop(1.15);
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
  sfx.trash();
  set({ notes: rest, ...focusCleanup(id) });
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
  sfx.pop(1.05);
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
  sfx.trash();
  set({ media: rest, ...focusCleanup(id) });
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
  sfx.pop();
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

function focusCleanup(removedId: string): Partial<AppState> {
  if (state.activeObjectId !== removedId) return {};
  return { activeObjectId: null, focusLevel: "section" };
}

export function removeTable(id: string) {
  const { [id]: gone, ...rest } = state.tables;
  if (!gone) return;
  workbook.removeTable(id);
  sfx.trash();
  set({ tables: rest, ...focusCleanup(id) });
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

// spreadsheet structural edits — formulas are rewritten by the workbook

export function insertTableRows(id: string, at: number, count = 1) {
  const t = state.tables[id];
  if (!t || t.rows + count > 200) return;
  workbook.insertRows(id, at, count);
  set({ tables: { ...state.tables, [id]: { ...t, rows: t.rows + count } } });
}

export function deleteTableRows(id: string, at: number, count = 1) {
  const t = state.tables[id];
  if (!t || t.rows - count < 1) return;
  workbook.deleteRows(id, at, count);
  set({ tables: { ...state.tables, [id]: { ...t, rows: t.rows - count } } });
}

export function insertTableCols(id: string, at: number, count = 1) {
  const t = state.tables[id];
  if (!t || t.cols + count > 26) return;
  workbook.insertCols(id, at, count);
  set({ tables: { ...state.tables, [id]: { ...t, cols: t.cols + count } } });
}

export function deleteTableCols(id: string, at: number, count = 1) {
  const t = state.tables[id];
  if (!t || t.cols - count < 1) return;
  workbook.deleteCols(id, at, count);
  set({ tables: { ...state.tables, [id]: { ...t, cols: t.cols - count } } });
}

// ---------- map actions ----------

const MAP_W = 640;
const MAP_H = 440;
let mapCount = 0;

export function createMap(sectionId: string, atX?: number, atY?: number): MapMeta {
  const id = uid("map");
  mapCount++;
  // maps start unbound — drag a wire from a table's port (or use the
  // dropdown) to connect data
  const meta: MapMeta = {
    id,
    sectionId,
    name: `Map ${mapCount}`,
    x: atX ?? 0,
    y: atY ?? 0,
    w: MAP_W,
    h: MAP_H,
    sourceTableId: null,
    pitched: true,
    float: false,
    bornAt: performance.now(),
  };
  sfx.pop(0.85);
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
  sfx.trash();
  set({ maps: rest, ...focusCleanup(id) });
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
  if (!m || m.sourceTableId === sourceTableId) return;
  if (sourceTableId) sfx.connect();
  else sfx.disconnect();
  set({ maps: { ...state.maps, [id]: { ...m, sourceTableId } } });
}

export function toggleMapPitch(id: string) {
  const m = state.maps[id];
  if (!m) return;
  set({ maps: { ...state.maps, [id]: { ...m, pitched: !m.pitched } } });
}

/**
 * App layout state — one spreadsheet-like Grid of sections.
 *
 * The workspace is a single Grid with column/row tracks (like a spreadsheet).
 * Sections occupy rectangular spans of tracks; splitting a section subdivides
 * a track (shifting/widening every other section that touches it), and
 * resizing a track resizes every section in it. Each section is its own
 * nested grid holding primitives (tables, maps), fitted to its body (it never
 * scrolls; Expand opens it as its own grid at full size). The viewport
 * camera snaps to sections, track bands, or the whole grid.
 */

import { useSyncExternalStore } from "react";
import { isHostable, type HuddleState, type LinkDoc, type PanelDoc } from "@foundation/protocol";
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
  /** the crew agent that made it (protocol ObjectBaseDoc.createdBy); people's cards leave it unset */
  createdBy?: string;
  /** pinned to its section: out of the flow, spanning the section on its own paper (protocol ObjectBaseDoc.pinned) */
  pinned?: boolean;
  /** minimized to its title bar (protocol ObjectBaseDoc.folded) */
  folded?: boolean;
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
  /** a text box: written as formatted text, not markdown source (protocol NoteDoc.rich) */
  rich?: boolean;
}

export interface MediaMeta extends ObjectBase {
  w: number;
  h: number;
  src: string; // object URL (session-lifetime)
  media: "image" | "video";
  autoplay: boolean; // video only
  muted: boolean; // video only
  /** image only: inverted on a dark ground (protocol MediaDoc.invert) */
  invert?: boolean;
}

/** apps, links, files, machines, agents, connectors and asks — see @foundation/protocol */
export type PanelMeta = Omit<PanelDoc, "kind" | "huddle"> & {
  /**
   * A huddle's live state, read from the board's `huddles` map (schema 6) —
   * never from the card, and never written back: the server alone keeps it.
   */
  huddle?: HuddleState;
};

export type AnyObject = TableMeta | MapMeta | NoteMeta | MediaMeta | PanelMeta;

export function isPanel(o: AnyObject): o is PanelMeta {
  return "panel" in o;
}

export interface Section {
  id: string;
  name: string;
  // inclusive track spans in the grid
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  /** the app this section hosts (schema 2): it fills the section, its ports sit on the section's edges */
  host?: string;
  /** the section whose own grid this one sits in (none: the board's grid). Spans count in that grid's tracks */
  parent?: string;
  /**
   * Local only, never synced: a section opened as its own grid that holds
   * cards rather than sections shows them as one section filling its grid.
   * It has the opened section's id; adding or splitting beside it makes it real.
   */
  virtual?: boolean;
}

export interface GridTracks {
  cols: number[]; // track widths, world px
  rows: number[]; // track heights
}

/** a side of the whole board — dropping a section there appends a track for it */
export type BoardEdge = "left" | "right" | "top" | "bottom";

export type SnapTarget =
  | { kind: "all" }
  | { kind: "section"; id: string }
  | { kind: "object"; id: string }
  /** an exact camera (Back, after an agent brought you somewhere) */
  | { kind: "view"; x: number; y: number; scale: number };

export interface AppState {
  /** the tracks of the grid you're looking at (the board's, or an opened section's) */
  grid: GridTracks;
  /** the sections in the grid you're looking at */
  sections: Record<string, Section>;
  /**
   * Sections are grids within themselves (2026-11-11, Josh): every section on
   * the board, at every depth (`parent` says whose grid it sits in) …
   */
  allSections: Record<string, Section>;
  /** … and every grid's tracks: "" is the board's, a section id that section's own */
  grids: Record<string, GridTracks>;
  /** the section opened full-screen as its own grid (null: the board). Local to this window */
  level: string | null;
  tables: Record<string, TableMeta>;
  maps: Record<string, MapMeta>;
  notes: Record<string, NoteMeta>;
  media: Record<string, MediaMeta>;
  panels: Record<string, PanelMeta>;
  /** wires between app ports (the meta layer) */
  links: Record<string, LinkDoc>;
  activeSectionId: string;
  /** which layer the keyboard/context currently addresses */
  focusLevel: "grid" | "section" | "object";
  activeObjectId: string | null;
  snapRequest: (SnapTarget & { nonce: number }) | null;
  /** cell (or board edge) highlighted while a section is being dragged to a new home */
  sectionDragTarget: { sectionId: string; c: number; r: number; edge?: BoardEdge; /** what letting go there does, when it isn't the section moving (a carried card makes a section) */ label?: string } | null;
  /** section awaiting the remove-confirmation popover (e.g. via context menu) */
  pendingRemoval: string | null;
  /** the section opened as its own grid (local to this window, never shared) */
  expandedSection: string | null;
  /** bumped when a section's held fit is let go, so flows recompute */
  layoutEpoch: number;
}

// ---------- geometry constants ----------

/** the board's own grid in `grids` */
export const ROOT = "";

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
/** half the gap between sections: wide enough (40 px) for a road of wires between apps */
export const SECTION_INSET = 20;
export const CONTENT_PAD = 28;

export function tablePixelSize(t: { cols: number; rows: number }) {
  return {
    w: ROWNUM_W + t.cols * CELL_W,
    h: HEADER_H + COLHEAD_H + t.rows * CELL_H,
  };
}

/** height of a card's hover bar (it overlays the card; it adds nothing to the size) */
export const MINI_HEADER = 34;

export function objectPixelSize(obj: AnyObject): { w: number; h: number } {
  // minimized: its title bar alone (a table's and a map's own header; any other card's bar)
  if (obj.folded) return { w: "cols" in obj ? tablePixelSize(obj).w : obj.w, h: "cols" in obj || "sourceTableId" in obj ? HEADER_H : FOLDED_H };
  if ("cols" in obj) return tablePixelSize(obj);
  if ("sourceTableId" in obj) return { w: obj.w, h: obj.h + HEADER_H };
  return { w: obj.w, h: obj.h }; // cards rest without a header bar; it overlays on hover
}

/** a minimized card: its bar and the 5 px it sits in from the card's edge, top and bottom */
export const FOLDED_H = 40;

/** the card pinned to a section, if it still lives there (one to a section: the newest pin) */
export function pinnedOf(sectionId: string): AnyObject | null {
  const sec = state.sections[sectionId] ?? state.allSections[sectionId];
  if (!sec || sec.host) return null; // a hosted app fills the section: nothing shows under it
  let best: AnyObject | null = null;
  for (const o of objectsInSection(sectionId)) if (o.pinned && (!best || o.bornAt >= best.bornAt)) best = o;
  return best;
}

/**
 * How a pinned card is drawn: at the section body's top-left, scaled by `k` so its own width is exactly the
 * section's (a table keeps its cells' measure and is scaled as one, a little above or below 1).
 */
export function pinnedScale(sec: Section, obj: AnyObject): number {
  const st = getState();
  const card = sectionBaseRect(sec.virtual ? st.grid : (st.grids[sec.parent ?? ROOT] ?? DEFAULT_GRID), sec);
  const w = objectPixelSize({ ...obj, folded: false }).w;
  const k = (card.w - 2) / Math.max(1, w);
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** every primitive living in a section */
export function objectsInSection(sectionId: string): AnyObject[] {
  const st = getState();
  const all: AnyObject[] = [
    ...Object.values(st.tables),
    ...Object.values(st.maps),
    ...Object.values(st.notes),
    ...Object.values(st.media),
    ...Object.values(st.panels),
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
    ...Object.values(st.panels),
  ];
}

const FLOW_GAP = 26;

/**
 * Flow layout for a section's docked primitives: shelves packed
 * left-to-right in creation order, wrapping at the section width, and
 * flowing AROUND floating cards so nothing ever overlays anything.
 */
let layoutCacheState: AppState | null = null;
const layoutCache = new Map<string, SectionFlow>();

/**
 * How a section presents what it holds. A section never scrolls (the wheel
 * always belongs to the grid): it lays its cards out at the width that lets
 * them show largest, then scales them to fit its body (never above 1). Below
 * MIN_FIT it stops shrinking and shows what fits — `clipped` — and the rest
 * is one Expand away (the section opened as its own grid, at full size).
 */
export interface SectionFlow {
  pos: Map<string, { x: number; y: number }>;
  /** content scale inside the section body (1 when expanded) */
  fit: number;
  /** some cards don't fit even at MIN_FIT */
  clipped: boolean;
  /** content size in content px, padding included */
  extent: { w: number; h: number };
  /** the flow width the docked cards wrapped at */
  availW: number;
}

/** the smallest a section shrinks its cards to before it clips and offers Expand */
export const MIN_FIT = 0.4;
/** the nominal scales a section tries its flow at (wider flow ↔ smaller scale) */
const FIT_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

/**
 * While a person is pressing inside a section (picking up, dragging, resizing
 * a card) its flow width and fit hold still, so what's under the finger never
 * rescales; letting go re-fits.
 */
const fitHolds = new Map<string, { fit: number; availW: number }>();

export function holdSectionFit(sectionId: string) {
  const f = sectionFlow(sectionId);
  fitHolds.set(sectionId, { fit: f.fit, availW: f.availW });
}

export function releaseSectionFit(sectionId: string) {
  const held = fitHolds.get(sectionId);
  if (!held) return;
  fitHolds.delete(sectionId);
  layoutCacheState = null; // the held answer is cached: work it out again
  const now = sectionFlow(sectionId);
  // re-fit only if letting go changes something (a plain click doesn't)
  if (now.fit !== held.fit || now.availW !== held.availW) set({ layoutEpoch: state.layoutEpoch + 1 });
}

export function sectionFlow(sectionId: string): SectionFlow {
  const st = getState();
  // overlays ask for layouts every frame; the answer only changes with state
  if (layoutCacheState !== st) {
    layoutCacheState = st;
    layoutCache.clear();
  }
  const hit = layoutCache.get(sectionId);
  if (hit) return hit;
  const computed = computeSectionFlow(st, sectionId);
  layoutCache.set(sectionId, computed);
  return computed;
}

export function sectionLayout(sectionId: string): Map<string, { x: number; y: number }> {
  return sectionFlow(sectionId).pos;
}

/** the scale a section's cards are drawn at right now (SectionView's spring while it glides, else the flow's) */
export function sectionFit(sectionId: string): number {
  return liveFit.get(sectionId) ?? sectionFlow(sectionId).fit;
}

/**
 * The scale a card is drawn at, at rest: the camera's zoom times its section's
 * fit (none for a hosted app, which fills its section). Live pages run only
 * when this is big enough (PanelView's useOnScreen).
 */
export function drawnScale(zoom: number, sectionId: string | null | undefined): number {
  return zoom * (sectionId ? sectionFlow(sectionId).fit : 1);
}

/** live (mid-spring) section fits, written by SectionView */
export const liveFit = new Map<string, number>();

function computeSectionFlow(st: AppState, sectionId: string): SectionFlow {
  // a section at any depth: one in view, or one drawn in miniature inside a section that is a grid
  const sec = st.sections[sectionId] ?? st.allSections[sectionId];
  if (!sec) return { pos: new Map(), fit: 1, clipped: false, extent: { w: 0, h: 0 }, availW: 0 };
  const card = sectionBaseRect(sec.virtual ? st.grid : (st.grids[sec.parent ?? ROOT] ?? DEFAULT_GRID), sec);
  if (!Number.isFinite(card.w) || !Number.isFinite(card.h)) {
    // a section whose tracks haven't arrived yet: lay out plainly, at full size
    const flow = flowAt(sec, 360);
    return { ...flow, fit: 1, clipped: false, availW: 360 };
  }
  const bodyW = card.w - 2;
  const bodyH = card.h - 2 - SECTION_HEADER;
  const fitOf = (ext: { w: number; h: number }) => Math.min(1, bodyW / Math.max(1, ext.w), bodyH / Math.max(1, ext.h));
  const expanded = st.expandedSection === sectionId;
  const held = fitHolds.get(sectionId);
  if (held) {
    const flow = flowAt(sec, held.availW);
    return { ...flow, fit: expanded ? 1 : held.fit, clipped: !expanded && fitOf(flow.extent) < held.fit - 1e-3, availW: held.availW };
  }
  if (expanded) {
    // opened as its own grid: its own width, at full size, as long as it needs (the wheel reads on down)
    const availW = Math.max(360, card.w - CONTENT_PAD * 2);
    return { ...flowAt(sec, availW), fit: 1, clipped: false, availW };
  }
  let best: (ReturnType<typeof flowAt> & { fit: number; availW: number }) | null = null;
  for (const step of FIT_STEPS) {
    const availW = Math.max(360, card.w / step - CONTENT_PAD * 2);
    const flow = flowAt(sec, availW);
    const fit = fitOf(flow.extent);
    // a wider flow has to earn it: only take it when the cards come out clearly larger
    if (!best || fit > best.fit + 0.02) best = { ...flow, fit, availW };
    if (fit >= step - 1e-3) break; // fits at this width: going wider only shrinks it
  }
  const b = best!;
  const clipped = b.fit < MIN_FIT;
  return { pos: b.pos, extent: b.extent, availW: b.availW, fit: expanded ? 1 : Math.max(MIN_FIT, b.fit), clipped: !expanded && clipped };
}

function flowAt(sec: Section, availW: number): { pos: Map<string, { x: number; y: number }>; extent: { w: number; h: number } } {
  const sectionId = sec.id;
  const out = new Map<string, { x: number; y: number }>();
  let extW = 0;
  let extH = 0;
  // the hosted app isn't in the flow, and neither is the card pinned to the section (it is the ground the flow lies on)
  const pin = pinnedOf(sectionId)?.id;
  const all = objectsInSection(sectionId).filter((o) => o.id !== sec.host && o.id !== pin);
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
    extW = Math.max(extW, x + w);
    extH = Math.max(extH, y + h);
    x += w + FLOW_GAP;
    shelfH = Math.max(shelfH, h);
  }
  for (const f of floaters) {
    extW = Math.max(extW, f.x + f.w);
    extH = Math.max(extH, f.y + f.h);
  }
  return { pos: out, extent: { w: extW + CONTENT_PAD * 2, h: extH + CONTENT_PAD * 2 } };
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

/** the card rect a section has in its cells (inset from the cell span) */
export function sectionBaseRect(grid: GridTracks, s: Section) {
  const r = sectionCellRect(grid, s);
  return {
    x: r.x + SECTION_INSET,
    y: r.y + SECTION_INSET,
    w: r.w - SECTION_INSET * 2,
    h: r.h - SECTION_INSET * 2,
  };
}

/**
 * The visible card rect. An expanded section grows from its top-left corner
 * until everything it holds shows at full size: it becomes its own grid, and
 * the wheel pans across it like any other part of the board.
 */
export function sectionCardRect(grid: GridTracks, s: Section) {
  const rest = sectionRestRect(grid, s);
  const e = sectionEase.get(s.id);
  if (!e) return rest;
  // the card's own transition, when it has one, is the clock; else time since the start (and never past 3× the time)
  const own = e.progress?.();
  const p = clock() - e.t0 > SECTION_EASE_MS * 3 ? 1 : (own ?? (clock() - e.t0) / SECTION_EASE_MS);
  if (p >= 1) {
    sectionEase.delete(s.id);
    return rest;
  }
  const k = settle(Math.max(0, p));
  return { x: e.from.x + (rest.x - e.from.x) * k, y: e.from.y + (rest.y - e.from.y) * k, w: e.from.w + (rest.w - e.from.w) * k, h: e.from.h + (rest.h - e.from.h) * k };
}

/** where the card comes to rest: what the DOM is given (its CSS eases it there) */
export function sectionRestRect(grid: GridTracks, s: Section) {
  const base = sectionBaseRect(grid, s);
  if (getState().expandedSection !== s.id || s.host) return base;
  const { extent } = sectionFlow(s.id);
  return { ...base, w: Math.max(base.w, extent.w + 2), h: Math.max(base.h, SECTION_HEADER + extent.h + 2) };
}

/**
 * Opening or closing a section eases its card over 0.5 s (App.css: .section-card,
 * var(--ease-settle)). sectionCardRect follows the same curve meanwhile, so the
 * wires and landings that read it travel with the card instead of jumping to
 * the end at once (the wire layer redraws every frame).
 */
const SECTION_EASE_MS = 500;
const sectionEase = new Map<string, { from: { x: number; y: number; w: number; h: number }; t0: number; progress?: () => number | null }>();
let clock = () => performance.now();

/**
 * A section card's size just changed in the DOM (opened or closed): from now,
 * sectionCardRect eases from `from` (where the card was drawn) to where it
 * rests, on the CSS's curve and time. SectionView calls it as the new size
 * lands, so the two start on the same frame.
 */
export function startSectionEase(id: string, from: { x: number; y: number; w: number; h: number }, progress?: () => number | null) {
  sectionEase.set(id, { from, t0: clock(), progress });
}
/** tests: a clock they turn by hand */
export function setSectionClock(fn: () => number) {
  clock = fn;
}

/** cubic-bezier(x1, y1, x2, y2) as a function of progress, as CSS draws it */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dx = (t: number) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (bx(t) - x) / d;
    }
    // Newton can wander on a flat stretch: settle it by halving
    if (t < 0 || t > 1 || Math.abs(bx(t) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        if (bx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return by(t);
  };
}
const settle = cubicBezier(0.22, 1.3, 0.36, 1);

export function gridSize(grid: GridTracks) {
  const xo = trackOffsets(grid.cols);
  const yo = trackOffsets(grid.rows);
  return { w: xo[xo.length - 1], h: yo[yo.length - 1] };
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

/** the app a section hosts, if it still lives there */
export function hostOf(sectionId: string): PanelMeta | null {
  const st = getState();
  const id = (st.sections[sectionId] ?? st.allSections[sectionId])?.host;
  const p = id ? st.panels[id] : undefined;
  return p && p.sectionId === sectionId ? p : null;
}

/**
 * A wire between two sections that both stepped back for an expanded one:
 * it fades with them (DESIGN §5 Section body). A wire with an end in the open
 * section stays, so you can see what it's connected to.
 */
export function wireBackstage(st: AppState, fromSection: string | undefined, toSection: string | undefined): boolean {
  const open = st.expandedSection;
  if (!open || !st.sections[open]) return false;
  return fromSection !== open && toSection !== open;
}

export function isHosted(obj: AnyObject): boolean {
  return getState().sections[obj.sectionId]?.host === obj.id;
}

/** the part of a section below its header — where a hosted app lives */
export function sectionBodyRect(grid: GridTracks, s: Section) {
  const card = sectionCardRect(grid, s);
  return { x: card.x, y: card.y + SECTION_HEADER, w: card.w, h: card.h - SECTION_HEADER };
}

/** world-space rect of an object (accounts for section position + fit); `s` is the scale it's drawn at */
export function objectWorldRect(obj: AnyObject) {
  const st = getState();
  const sec = st.sections[obj.sectionId];
  if (!sec) return null;
  if (sec.host === obj.id) return { ...sectionBodyRect(st.grid, sec), s: 1 }; // a hosted app is the section
  if (obj.pinned && pinnedOf(sec.id)?.id === obj.id) {
    // pinned: it spans the section's body from its top-left, at the scale that makes its width the section's
    const body = sectionBodyRect(st.grid, sec);
    const k = pinnedScale(sec, obj);
    return { x: body.x + 1, y: body.y + 1, w: body.w - 2, h: Math.min(body.h - 2, objectPixelSize(obj).h * k), s: k };
  }
  const card = sectionCardRect(st.grid, sec);
  const s = sectionFit(sec.id);
  const { w, h } = objectPixelSize(obj);
  const pos = liveObjPos.get(obj.id) ?? effectivePos(obj);
  // + the section card's 1 px border: its body is laid out inside it, and wires
  // must land where the DOM puts the card (ports sit on this rect's edges).
  // The body draws its content at the section's fit, scaled from its top-left.
  return {
    x: card.x + 1 + (CONTENT_PAD + pos.x) * s,
    y: card.y + 1 + SECTION_HEADER + (CONTENT_PAD + pos.y) * s,
    w: w * s,
    h: h * s,
    s,
  };
}

/**
 * The window a wire between two objects is seen through: when both sit in one
 * section's scrolling body, that body — so a wire to a card scrolled out of
 * view runs to the section's edge rather than across the grid. Otherwise none.
 */
export function wireClipRect(a: AnyObject, b: AnyObject) {
  const sec = sharedSection(a, b);
  return sec ? sectionBodyRect(getState().grid, sec) : null;
}

/** the section whose scrolling body holds both objects (neither a hosted app), if any */
export function sharedSection(a: AnyObject, b: AnyObject) {
  const sec = a.sectionId === b.sectionId ? getState().sections[a.sectionId] : undefined;
  return sec && sec.host !== a.id && sec.host !== b.id ? sec : null;
}

/** Point an SVG wire group at its clip window (a `clipPath` with one rect inside the group), or let it run free. */
export function applyWireClip(g: SVGGElement, clip: { x: number; y: number; w: number; h: number } | null) {
  const path = g.querySelector("clipPath");
  const rect = path?.querySelector("rect");
  if (!clip || !path || !rect) {
    g.removeAttribute("clip-path");
    return;
  }
  rect.setAttribute("x", String(clip.x));
  rect.setAttribute("y", String(clip.y));
  rect.setAttribute("width", String(clip.w));
  rect.setAttribute("height", String(clip.h));
  g.setAttribute("clip-path", `url(#${path.id})`);
}

// ---------- store ----------

const firstSectionId = uid("sec");

const firstSection: Section = { id: firstSectionId, name: "Section 1", c0: 0, r0: 0, c1: 0, r1: 0 };
const firstGrid: GridTracks = { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] };

let state: AppState = {
  grid: firstGrid,
  sections: { [firstSectionId]: firstSection },
  allSections: { [firstSectionId]: firstSection },
  grids: { [ROOT]: firstGrid },
  level: null,
  tables: {},
  maps: {},
  notes: {},
  media: {},
  panels: {},
  links: {},
  activeSectionId: firstSectionId,
  focusLevel: "grid",
  activeObjectId: null,
  snapRequest: { kind: "all", nonce: Math.random() },
  sectionDragTarget: null,
  pendingRemoval: null,
  expandedSection: null,
  layoutEpoch: 0,
};

const listeners = new Set<() => void>();

/**
 * Sync bridge: the board's Y.Doc (sync/board.ts) registers here. Every local
 * change is offered to it; remote changes come back through applyRemote()
 * and are not echoed.
 */
let syncHook: ((next: AppState, prev: AppState) => void) | null = null;
let applyingRemote = false;

export function setSyncHook(fn: typeof syncHook) {
  syncHook = fn;
}

export function applyRemote(partial: Partial<AppState>) {
  applyingRemote = true;
  try {
    state = settleLevels(state, { ...state, ...partial }, partial, false);
    emit();
  } finally {
    applyingRemote = false;
  }
}

function emit() {
  for (const fn of listeners) fn();
}

// dev: let the browser console (and headless checks) read the live model
// the test hooks: the dev server, and a build made for the e2e checks (E2E_BUILD sets VITE_E2E_HOOKS)
if ((import.meta.env?.DEV || import.meta.env?.VITE_E2E_HOOKS) && typeof window !== "undefined") (window as unknown as { __foundation: unknown }).__foundation = { getState: () => state, setState: (p: Partial<AppState>) => set(p), workbook, sectionCardRect, expandSection };

export function getState(): AppState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Changes only when cards or sections come or go (not on every drag frame):
 * for views that look things up by id, like a session's steps.
 */
export function useObjectSetVersion(): string {
  return useSyncExternalStore(subscribe, () => {
    const st = getState();
    return [st.panels, st.notes, st.tables, st.maps, st.media, st.sections].map((r) => Object.keys(r).length).join(",");
  });
}

/** the whole store: renders on every change. Board-wide layers read a slice instead (state/slices.ts) */
export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState);
}

/** one panel by id (or nothing): for a page that follows the machine card it came from */
export function usePanel(id: string | undefined): PanelMeta | undefined {
  return useSyncExternalStore(subscribe, () => (id ? state.panels[id] : undefined));
}

/** what one section draws from the store: its cards, its app, and which of them is active */
export interface SectionSnap {
  /** the cards in the section's flow (not its hosted app, nor the card pinned to it) */
  objects: AnyObject[];
  host: PanelMeta | null;
  /** the card pinned to the section: it spans it, under the flow */
  pinned: AnyObject | null;
  /** the active card, if it's one of this section's */
  activeObjectId: string | null;
  sectionFocus: boolean;
  pendingRemoval: boolean;
  /** how the section presents its cards (see SectionFlow) — numbers, so an unchanged flow doesn't re-render */
  fit: number;
  clipped: boolean;
  availW: number;
  extentW: number;
  extentH: number;
  /** opened as its own grid in this window */
  expanded: boolean;
}

function flowFields(sectionId: string) {
  const f = sectionFlow(sectionId);
  return { fit: f.fit, clipped: f.clipped, availW: f.availW, extentW: f.extent.w, extentH: f.extent.h };
}

const sectionSnaps = new Map<string, { st: AppState; snap: SectionSnap }>();

export function sectionSnap(sectionId: string): SectionSnap {
  const cached = sectionSnaps.get(sectionId);
  if (cached && cached.st === state) return cached.snap;
  const host = hostOf(sectionId);
  const pinned = pinnedOf(sectionId);
  const objects = objectsInSection(sectionId).filter((o) => o.id !== host?.id && o.id !== pinned?.id);
  const a = state.focusLevel === "object" ? state.activeObjectId : null;
  const next: SectionSnap = {
    objects,
    host,
    pinned,
    activeObjectId: a && (a === host?.id || a === pinned?.id || objects.some((o) => o.id === a)) ? a : null,
    sectionFocus: state.focusLevel === "section",
    pendingRemoval: state.pendingRemoval === sectionId,
    ...flowFields(sectionId),
    expanded: state.expandedSection === sectionId,
  };
  const prev = cached?.snap;
  // the same cards keep the same array, so the section's layout (and its cards' props) hold
  if (prev && prev.objects.length === objects.length && prev.objects.every((o, i) => o === objects[i])) next.objects = prev.objects;
  const same =
    prev &&
    prev.objects === next.objects &&
    prev.host === next.host &&
    prev.pinned === next.pinned &&
    prev.activeObjectId === next.activeObjectId &&
    prev.sectionFocus === next.sectionFocus &&
    prev.pendingRemoval === next.pendingRemoval &&
    prev.fit === next.fit &&
    prev.clipped === next.clipped &&
    prev.availW === next.availW &&
    prev.extentW === next.extentW &&
    prev.extentH === next.extentH &&
    prev.expanded === next.expanded;
  const snap = same ? prev : next;
  sectionSnaps.set(sectionId, { st: state, snap });
  return snap;
}

/**
 * One section's slice of the store. A section re-renders when its own cards
 * change, or the active card moves into, out of or within it — not when a
 * card elsewhere is pressed, dragged or typed in (which used to re-render
 * every section and every card on the board).
 */
export function useSection(sectionId: string): SectionSnap {
  return useSyncExternalStore(subscribe, () => sectionSnap(sectionId));
}

function set(partial: Partial<AppState>) {
  const prev = state;
  state = settleLevels(prev, { ...state, ...partial }, partial, !applyingRemote);
  if (!applyingRemote && syncHook) syncHook(state, prev);
  emit();
}

// ---------- grids within grids ----------

/** the sections whose grid is this one's (none: the board's own) */
export function childrenOf(id: string | null, all: Record<string, Section> = state.allSections): Section[] {
  return Object.values(all).filter((s) => (s.parent ?? null) === id);
}

/** a section that holds sections (a grid of its own) rather than cards */
export function isGridSection(id: string): boolean {
  return Object.values(state.allSections).some((s) => s.parent === id);
}

/** a section by id at any depth (the one in view first: an opened section's own cards show as it) */
export function sectionById(id: string): Section | undefined {
  return state.sections[id] ?? state.allSections[id];
}

/** the tracks a section's spans count in */
export function gridFor(s: Section): GridTracks {
  if (s.virtual) return state.grid;
  return state.grids[s.parent ?? ROOT] ?? DEFAULT_GRID;
}

/** where cards for this section really go: itself, or (a grid of sections) its first section, top-left first */
export function leafSection(id: string): string {
  let at = id;
  for (let guard = 0; guard < 16; guard++) {
    const kids = childrenOf(at).sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
    if (!kids.length) return at;
    at = kids[0].id;
  }
  return at;
}

/** the chain from the board down to a level: [] on the board, [Design] in it, [Design, Sketches] … */
export function levelPath(level: string | null = state.level): Section[] {
  const out: Section[] = [];
  let at = level ? state.allSections[level] : undefined;
  for (let guard = 0; at && guard < 16; guard++) {
    out.unshift(at);
    at = at.parent ? state.allSections[at.parent] : undefined;
  }
  return out;
}

const DEFAULT_GRID: GridTracks = { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] };

/**
 * A section opened that holds cards: one section filling its grid, at the
 * size that shows them all at full size (as Expand did before it opened a
 * grid), at least as big as the section was.
 */
function leafGrid(st: AppState, sec: Section): GridTracks {
  const own = st.grids[sec.id];
  if (own) return own;
  const base = sectionBaseRect(st.grids[sec.parent ?? ROOT] ?? DEFAULT_GRID, sec);
  const w = Number.isFinite(base.w) ? base.w : DEFAULT_COL_W - SECTION_INSET * 2;
  const h = Number.isFinite(base.h) ? base.h : DEFAULT_ROW_H - SECTION_INSET * 2;
  const { extent } = flowAt(sec, Math.max(360, w - CONTENT_PAD * 2));
  return {
    cols: [Math.round(Math.max(w, extent.w + 2) + SECTION_INSET * 2)],
    rows: [Math.round(Math.max(h, SECTION_HEADER + extent.h + 2) + SECTION_INSET * 2)],
  };
}

/** the grid and sections one level shows */
function levelView(st: AppState, level: string | null): { grid: GridTracks; sections: Record<string, Section> } {
  if (!level) {
    const sections: Record<string, Section> = {};
    for (const s of childrenOf(null, st.allSections)) sections[s.id] = s;
    return { grid: st.grids[ROOT] ?? DEFAULT_GRID, sections };
  }
  const kids = childrenOf(level, st.allSections);
  const grid = st.grids[level] ?? (kids.length ? DEFAULT_GRID : leafGrid(st, st.allSections[level]));
  const sections: Record<string, Section> = {};
  if (kids.length) for (const s of kids) sections[s.id] = s;
  else {
    const me = st.allSections[level];
    sections[level] = { ...me, parent: level, virtual: true, c0: 0, r0: 0, c1: grid.cols.length - 1, r1: grid.rows.length - 1 };
  }
  return { grid, sections };
}

/**
 * Keep the whole and the view in step. A level change (or a remote change to
 * the whole) derives the view; a local edit to the view (`sections`, `grid`)
 * is folded back into the whole. Adding or splitting beside an opened
 * section's own cards makes them a real section first, so the opened section
 * becomes a grid of sections.
 */
function settleLevels(prev: AppState, next: AppState, partial: Partial<AppState>, local: boolean): AppState {
  // the opened section went away (removed here or by someone else): back to the nearest level that's left
  let level = next.level;
  while (level && !next.allSections[level]) level = prev.allSections[level]?.parent ?? null;
  if (level !== next.level) next = { ...next, level };
  // an edit to what's in view: made here, or handed in whole as one level (not the whole board's sections)
  const viewEdit =
    ("sections" in partial || "grid" in partial) && next.level === prev.level && (local || !("allSections" in partial || "grids" in partial));
  if (!viewEdit) {
    if (next.level === prev.level && next.allSections === prev.allSections && next.grids === prev.grids && !("level" in partial)) return next;
    const view = levelView(next, next.level);
    // the view is the same objects when nothing it shows changed, so sections don't re-render for nothing
    const sameSections =
      Object.keys(view.sections).length === Object.keys(prev.sections).length && Object.entries(view.sections).every(([id, s]) => sameSection(prev.sections[id], s));
    const fixed = { ...next, grid: sameGrid(prev.grid, view.grid) ? prev.grid : view.grid, sections: sameSections ? prev.sections : view.sections };
    if (!fixed.sections[fixed.activeSectionId]) {
      const first = Object.keys(fixed.sections)[0];
      if (first) fixed.activeSectionId = first;
    }
    return fixed;
  }
  // a local edit at this level: fold it into the whole
  const L = next.level;
  const all: Record<string, Section> = { ...(partial.allSections ?? prev.allSections) };
  const grids = { ...(partial.grids ?? prev.grids) };
  for (const s of Object.values(all)) if ((s.parent ?? null) === L) delete all[s.id];
  let sections = next.sections;
  const virtual = L ? sections[L] : undefined;
  const others = Object.values(sections).filter((s) => !s.virtual);
  let out = next;
  let materialized = false;
  if (L && virtual?.virtual) {
    if (others.length === 0) {
      // still one section of cards: what changed on it is the opened section's own
      all[L] = { ...all[L], name: virtual.name, host: virtual.host };
    } else {
      // made real: the cards (and a hosted app) move into a section of their own, in this grid
      materialized = true;
      const real: Section = { id: uid("sec"), name: virtual.name, c0: virtual.c0, r0: virtual.r0, c1: virtual.c1, r1: virtual.r1, parent: L, ...(virtual.host ? { host: virtual.host } : {}) };
      all[L] = { ...all[L], host: undefined };
      sections = { ...sections };
      delete sections[L];
      sections[real.id] = real;
      const moved: Partial<AppState> = {};
      for (const key of ["tables", "maps", "notes", "media", "panels"] as const) {
        const rec = out[key] as Record<string, AnyObject>;
        if (!Object.values(rec).some((o) => o.sectionId === L)) continue;
        const copy = { ...rec };
        for (const o of Object.values(copy)) if (o.sectionId === L) copy[o.id] = { ...o, sectionId: real.id };
        (moved as Record<string, unknown>)[key] = copy;
      }
      out = {
        ...out,
        ...moved,
        sections,
        activeSectionId: out.activeSectionId === L ? real.id : out.activeSectionId,
        sectionDragTarget: out.sectionDragTarget?.sectionId === L ? { ...out.sectionDragTarget, sectionId: real.id } : out.sectionDragTarget,
      };
    }
  }
  for (const s of Object.values(sections)) {
    if (s.virtual) continue;
    all[s.id] = (s.parent ?? null) === L ? s : L ? { ...s, parent: L } : withoutParent(s);
  }
  // an opened section's tracks are kept once they change, or once its cards became a section of their own
  if (out.grid !== prev.grid || materialized || (!L && !grids[ROOT])) grids[L ?? ROOT] = out.grid;
  // sections whose grid is gone go with it, and so do their cards
  const gone = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of Object.values(all)) {
      if (s.parent && !all[s.parent]) {
        delete all[s.id];
        delete grids[s.id];
        gone.add(s.id);
        changed = true;
      }
    }
  }
  for (const id of Object.keys(grids)) if (id !== ROOT && !all[id]) delete grids[id];
  if (gone.size) {
    for (const key of ["tables", "maps", "notes", "media", "panels"] as const) {
      const rec = out[key] as Record<string, AnyObject>;
      if (!Object.values(rec).some((o) => gone.has(o.sectionId))) continue;
      const copy = { ...rec };
      for (const o of Object.values(copy)) if (gone.has(o.sectionId)) delete copy[o.id];
      out = { ...out, [key]: copy };
    }
  }
  // (virtual sections never enter the whole; the view keeps a materialised one as real)
  // the view holds the same section objects as the whole (with their parent), the opened section's own cards aside
  const view: Record<string, Section> = {};
  let viewChanged = false;
  for (const [id, s] of Object.entries(out.sections)) {
    const v = s.virtual ? s : (all[id] ?? s);
    if (v !== s) viewChanged = true;
    view[id] = v;
  }
  return { ...out, sections: viewChanged ? view : out.sections, allSections: all, grids };
}

function withoutParent(s: Section): Section {
  if (!("parent" in s)) return s;
  const { parent: _p, ...rest } = s;
  return rest;
}

function sameSection(a: Section | undefined, b: Section): boolean {
  return !!a && a.name === b.name && a.c0 === b.c0 && a.c1 === b.c1 && a.r0 === b.r0 && a.r1 === b.r1 && a.host === b.host && a.parent === b.parent && a.virtual === b.virtual;
}

function sameGrid(a: GridTracks, b: GridTracks): boolean {
  return a.cols.length === b.cols.length && a.rows.length === b.rows.length && a.cols.every((v, i) => v === b.cols[i]) && a.rows.every((v, i) => v === b.rows[i]);
}

/**
 * Open a section full-screen as its own grid (sections are grids within
 * themselves), or with null go back up one level. The camera frames the new
 * level; going up, it frames the section you came out of. Local to this window.
 */
export function openLevel(id: string | null) {
  const from = state.level;
  if (id === from) return;
  if (id && !state.allSections[id]) return;
  // going up: frame the section you came out of, as it sits in the grid you're back in
  const path = levelPath(from);
  const at = id === null ? 0 : path.findIndex((s) => s.id === id) + 1;
  const cameFrom = at > 0 || id === null ? path[at] : undefined;
  set({
    level: id,
    expandedSection: null,
    focusLevel: "section",
    activeObjectId: null,
    ...(cameFrom ? { activeSectionId: cameFrom.id } : {}),
    snapRequest: cameFrom ? { kind: "section", id: cameFrom.id, nonce: Math.random() } : { kind: "all", nonce: Math.random() },
  });
}

/** one level up (Esc, the breadcrumb's back) */
export function levelUp() {
  const at = state.level ? state.allSections[state.level] : undefined;
  if (at) openLevel(at.parent ?? null);
}

// ---------- snap / focus ----------

export function requestSnap(target: SnapTarget) {
  set({ snapRequest: { ...target, nonce: Math.random() } });
}

export function setActiveSection(id: string) {
  if (state.activeSectionId === id && state.focusLevel === "section" && !state.activeObjectId)
    return;
  set({ activeSectionId: id, focusLevel: "section", activeObjectId: null });
}

export function setActiveObject(id: string) {
  const found = findObject(id);
  if (!found) return;
  if (state.activeObjectId === id && state.focusLevel === "object") return;
  set({
    activeObjectId: id,
    activeSectionId: found.obj.sectionId,
    focusLevel: "object",
  });
}

export function setFocusGrid() {
  if (state.focusLevel === "grid") return;
  set({ focusLevel: "grid", activeObjectId: null });
}

/** step one level up: object → section → grid */
export function focusUp() {
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
  set({
    grid,
    sections,
    activeSectionId: fresh.id,
    snapRequest: { kind: "section", id: fresh.id, nonce: Math.random() },
  });
  startWithSheet(fresh.id);
  return fresh.id;
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
/**
 * A section left a rectangle of cells empty: grow neighbours into it rather
 * than leave a void. On any side, the sections touching the hole that
 * together cover that whole side (and stay within it) extend across; the side
 * needing the fewest sections wins (one aligned neighbour is the tidiest).
 * Mutates `sections`; returns false when no side lines up (the cells stay
 * empty, each offering "+ Section").
 */
export function fillHole(sections: Record<string, Section>, hole: { c0: number; c1: number; r0: number; r1: number }): boolean {
  const others = Object.values(sections);
  type Side = { list: Section[]; grow: (o: Section) => Section };
  const tiles = (list: Section[], lo: (o: Section) => number, hi: (o: Section) => number, from: number, to: number) => {
    const sorted = [...list].sort((a, b) => lo(a) - lo(b));
    let at = from;
    for (const o of sorted) {
      if (lo(o) !== at || hi(o) > to) return false;
      at = hi(o) + 1;
    }
    return at === to + 1;
  };
  const sides: Side[] = [];
  const above = others.filter((o) => o.r1 === hole.r0 - 1 && o.c0 >= hole.c0 && o.c1 <= hole.c1);
  if (tiles(above, (o) => o.c0, (o) => o.c1, hole.c0, hole.c1)) sides.push({ list: above, grow: (o) => ({ ...o, r1: hole.r1 }) });
  const left = others.filter((o) => o.c1 === hole.c0 - 1 && o.r0 >= hole.r0 && o.r1 <= hole.r1);
  if (tiles(left, (o) => o.r0, (o) => o.r1, hole.r0, hole.r1)) sides.push({ list: left, grow: (o) => ({ ...o, c1: hole.c1 }) });
  const below = others.filter((o) => o.r0 === hole.r1 + 1 && o.c0 >= hole.c0 && o.c1 <= hole.c1);
  if (tiles(below, (o) => o.c0, (o) => o.c1, hole.c0, hole.c1)) sides.push({ list: below, grow: (o) => ({ ...o, r0: hole.r0 }) });
  const right = others.filter((o) => o.c0 === hole.c1 + 1 && o.r0 >= hole.r0 && o.r1 <= hole.r1);
  if (tiles(right, (o) => o.r0, (o) => o.r1, hole.r0, hole.r1)) sides.push({ list: right, grow: (o) => ({ ...o, c0: hole.c0 }) });
  if (!sides.length) return false;
  const best = sides.reduce((a, b) => (b.list.length < a.list.length ? b : a));
  for (const o of best.list) sections[o.id] = best.grow(o);
  return true;
}

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
    a?.r === target?.r &&
    a?.edge === target?.edge
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
    // where it was is a hole now: the neighbours that line up grow into it
    const rest = { ...sections };
    delete rest[id];
    fillHole(rest, s);
    Object.assign(sections, rest);
  }
  const grid: GridTracks = { cols: [...state.grid.cols], rows: [...state.grid.rows] };
  pruneEmptyTracks(grid, sections);
  set({ grid, sections, activeSectionId: id });
}

/** which side of the board a world point lies beyond (null when inside the grid) */
export function edgeAtWorld(x: number, y: number): BoardEdge | null {
  const size = gridSize(getState().grid);
  const out = { left: -x, right: x - size.w, top: -y, bottom: y - size.h };
  let best: BoardEdge | null = null;
  let d = 0;
  for (const k of Object.keys(out) as BoardEdge[]) {
    if (out[k] > d) {
      d = out[k];
      best = k;
    }
  }
  return best;
}

/**
 * Move a section off its cell and append it along a whole side of the board:
 * a new track opens on that side and the section spans the full board beside
 * it. The hole it leaves is absorbed by an aligned neighbour, and tracks
 * nothing spans any more are pruned.
 */
export function moveSectionToEdge(id: string, edge: BoardEdge) {
  const s = state.sections[id];
  if (!s) return;
  const grid: GridTracks = { cols: [...state.grid.cols], rows: [...state.grid.rows] };
  const sections: Record<string, Section> = { ...state.sections };
  delete sections[id];
  fillHole(sections, s);
  const xo = trackOffsets(grid.cols);
  const yo = trackOffsets(grid.rows);
  // the new track takes the section's own size, within a normal track's
  const width = Math.min(DEFAULT_COL_W, Math.max(MIN_COL_W, xo[s.c1 + 1] - xo[s.c0]));
  const height = Math.min(DEFAULT_ROW_H, Math.max(MIN_ROW_H, yo[s.r1 + 1] - yo[s.r0]));
  if (edge === "left" || edge === "right") {
    if (edge === "left") {
      grid.cols.unshift(width);
      for (const o of Object.values(sections)) sections[o.id] = { ...o, c0: o.c0 + 1, c1: o.c1 + 1 };
    } else grid.cols.push(width);
    const c = edge === "left" ? 0 : grid.cols.length - 1;
    sections[id] = { ...s, c0: c, c1: c, r0: 0, r1: grid.rows.length - 1 };
  } else {
    if (edge === "top") {
      grid.rows.unshift(height);
      for (const o of Object.values(sections)) sections[o.id] = { ...o, r0: o.r0 + 1, r1: o.r1 + 1 };
    } else grid.rows.push(height);
    const r = edge === "top" ? 0 : grid.rows.length - 1;
    sections[id] = { ...s, r0: r, r1: r, c0: 0, c1: grid.cols.length - 1 };
  }
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
  };
  set({
    sections: { ...state.sections, [fresh.id]: fresh },
    activeSectionId: fresh.id,
    snapRequest: { kind: "section", id: fresh.id, nonce: Math.random() },
  });
  startWithSheet(fresh.id);
}

/**
 * A section a person adds starts as a sheet (2026-11-18, Josh: "I'd like for the creation of a new section to
 * actually have a few full-screen primitives starting with tables, the table should span to the full width of
 * the section"): a table pinned to it, sized to fill it, drawn on the section's own paper. Unpin it and it is
 * a card like any other; an app opened into a section that still holds only its untouched sheet takes the
 * section instead (addPanel).
 */
function startWithSheet(sectionId: string) {
  const t = createTable(sectionId, undefined, undefined, { quiet: true });
  setObjectPinned(t.id, true);
  set({ activeSectionId: sectionId, focusLevel: "section", activeObjectId: null, snapRequest: { kind: "section", id: sectionId, nonce: Math.random() } });
}

/** a table nobody has written in */
function tableIsBlank(id: string): boolean {
  const t = workbook.getTable(id);
  if (!t) return true;
  for (const c of t.cells.values()) if (c.raw) return false;
  return true;
}

/** the untouched sheet a section started with, when that is all it holds */
function startingSheet(sectionId: string): TableMeta | null {
  const objs = objectsInSection(sectionId);
  const only = objs.length === 1 ? objs[0] : null;
  return only && "cols" in only && only.pinned && tableIsBlank(only.id) ? only : null;
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

/**
 * Open a section as its own grid (or close it, with null): it grows to show
 * everything at full size, the rest of the board steps back, and the camera
 * frames it. Local to this window: nobody else's view changes.
 */
export function expandSection(id: string | null) {
  // since 2026-11-11 a section opens full-screen as a grid of its own (openLevel); null goes back up a level
  if (id === null) return levelUp();
  if (state.sections[id]?.virtual) return; // already open
  openLevel(id);
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

type ObjKey = "tables" | "maps" | "notes" | "media" | "panels";

function findObject(id: string): { key: ObjKey; obj: AnyObject } | null {
  for (const key of ["tables", "maps", "notes", "media", "panels"] as ObjKey[]) {
    const obj = (state[key] as Record<string, AnyObject>)[id];
    if (obj) return { key, obj };
  }
  return null;
}

/** the map a card's meta lives in */
function slotOf(obj: AnyObject): "tables" | "maps" | "notes" | "media" | "panels" {
  return isPanel(obj) ? "panels" : "cols" in obj ? "tables" : "sourceTableId" in obj ? "maps" : "text" in obj ? "notes" : "media";
}
function patchObject(id: string, patch: Partial<ObjectBase>, more: Partial<AppState> = {}) {
  const obj = getObject(id);
  if (!obj) return;
  const slot = slotOf(obj);
  set({ [slot]: { ...state[slot], [id]: { ...obj, ...patch } }, ...more } as Partial<AppState>);
}

/** what can be pinned to a section today: tables (a hosted app is the same idea for apps: setSectionHost) */
export function canPin(obj: AnyObject): boolean {
  return "cols" in obj;
}

/**
 * Pin a card to its section, or let it go. Pinned, it leaves the flow and spans the section on its own
 * paper; a table grows (never shrinks) to as many columns and rows as fill the section. One to a section:
 * pinning another lets the first go. Unpinned, it is a docked card again, at the size it has.
 */
export function setObjectPinned(id: string, pinned: boolean) {
  const obj = getObject(id);
  if (!obj || !canPin(obj) || !!obj.pinned === pinned) return;
  const sec = state.sections[obj.sectionId] ?? state.allSections[obj.sectionId];
  if (!sec) return;
  if (!pinned) return patchObject(id, { pinned: false, float: false });
  // the others in the section let go
  let tables = state.tables;
  for (const o of objectsInSection(sec.id)) if (o.pinned && o.id !== id && "cols" in o) tables = { ...tables, [o.id]: { ...o, pinned: false } };
  if ("cols" in obj) {
    const card = sectionBaseRect(sec.virtual ? state.grid : (state.grids[sec.parent ?? ROOT] ?? DEFAULT_GRID), sec);
    const bodyW = card.w - 2;
    const bodyH = card.h - 2 - SECTION_HEADER;
    const cols = Math.max(obj.cols, Number.isFinite(bodyW) ? Math.floor((bodyW - ROWNUM_W) / CELL_W) : obj.cols, 1);
    const k = Number.isFinite(bodyW) ? bodyW / (ROWNUM_W + cols * CELL_W) : 1;
    const rows = Math.max(obj.rows, Number.isFinite(bodyH) ? Math.floor((bodyH / k - HEADER_H - COLHEAD_H) / CELL_H) : obj.rows, 1);
    if (cols !== obj.cols || rows !== obj.rows) workbook.resize(id, cols, rows);
    tables = { ...tables, [id]: { ...obj, cols, rows, pinned: true, folded: false, float: false } };
    set({ tables, ...unhostFor(sec.id) });
  }
}

/** minimize a card to its title bar, or bring it back */
export function setObjectFolded(id: string, folded: boolean) {
  const obj = getObject(id);
  if (!obj || !!obj.folded === folded) return;
  patchObject(id, { folded });
}

/** take a card off the grid, whatever kind it is (a card that asks first does so on its own frame: ObjectFrame) */
export function removeObject(id: string) {
  const obj = getObject(id);
  if (!obj) return;
  if (isPanel(obj)) removePanel(id);
  else if ("cols" in obj) removeTable(id);
  else if ("sourceTableId" in obj) removeMap(id);
  else if ("text" in obj) removeNote(id);
  else removeMedia(id);
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

/** the section under a world point (null on empty paper or off the grid) */
export function sectionAtWorld(x: number, y: number): Section | null {
  // an expanded section lies over its neighbours: it owns all of its paper
  const ex = state.expandedSection ? state.sections[state.expandedSection] : undefined;
  if (ex) {
    const r = sectionCardRect(state.grid, ex);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return ex;
  }
  const cell = cellAtWorld(x, y);
  return cell ? sectionCovering(cell.c, cell.r) : null;
}

/**
 * Put a card down where it was dropped: floating in its section, its top-left
 * centred-ish under the pointer (search pane drags). Keeps it inside the body.
 */
export function placeAtWorld(id: string, wx: number, wy: number) {
  const found = findObject(id);
  if (!found) return;
  const sec = state.sections[found.obj.sectionId];
  if (!sec || sec.host === id) return; // an app that became its section's app fills it
  const card = sectionCardRect(state.grid, sec);
  const s = sectionFit(sec.id);
  const { w } = objectPixelSize(found.obj);
  const x = Math.max(0, (wx - card.x - 1) / s - CONTENT_PAD - Math.min(w / 2, 120));
  const y = Math.max(0, (wy - card.y - 1 - SECTION_HEADER) / s - CONTENT_PAD - 16);
  set({
    [found.key]: { ...(state[found.key] as Record<string, AnyObject>), [id]: { ...found.obj, float: true, x, y } },
  } as Partial<AppState>);
}

/**
 * Carry a card into another section (dragged out of its own and let go over
 * this one). With `at` (the world point its top-left was let go at) it floats
 * there; without, it joins the section's flow. A hosted app gives way to the
 * card (unhostFor), and a section the card hosted lets it go.
 */
export function moveObjectToSection(id: string, sectionId: string, at?: { wx: number; wy: number } | null) {
  // onto a section that is a grid of sections: into its first one, joining the flow
  if (isGridSection(sectionId)) {
    sectionId = leafSection(sectionId);
    at = null;
  }
  const found = findObject(id);
  const sec = sectionById(sectionId);
  if (!found || !sec) return;
  const from = sectionById(found.obj.sectionId);
  // a section that hosted it lets it go; one hosting an app gives way to it (in view, or deeper)
  let sections = state.sections;
  let all = state.allSections;
  const unhost = (s: Section) => {
    if (state.sections[s.id]) sections = { ...sections, [s.id]: { ...s, host: undefined } };
    else all = { ...all, [s.id]: { ...s, host: undefined } };
  };
  if (from?.host === id) unhost(from);
  if (sec.host && sec.host !== id) unhost(sec);
  let pos = { x: 0, y: 0, float: false };
  if (at) {
    const card = sectionCardRect(state.grid, sec);
    const s = sectionFit(sec.id);
    pos = {
      x: Math.max(0, Math.round((at.wx - card.x - 1) / s - CONTENT_PAD)),
      y: Math.max(0, Math.round((at.wy - card.y - 1 - SECTION_HEADER) / s - CONTENT_PAD)),
      float: true,
    };
  }
  const inView = !!state.sections[sectionId];
  set({
    ...(sections !== state.sections ? { sections } : {}),
    ...(all !== state.allSections ? { allSections: all } : {}),
    [found.key]: { ...(state[found.key] as Record<string, AnyObject>), [id]: { ...found.obj, sectionId, ...pos } },
    ...(inView ? { activeSectionId: sectionId, activeObjectId: id } : {}),
  } as Partial<AppState>);
}

/** a fresh, empty section in an uncovered cell, without moving the camera (a card is about to land in it) */
export function newSectionAt(c: number, r: number): string | null {
  if (sectionCovering(c, r) || c < 0 || r < 0 || c >= state.grid.cols.length || r >= state.grid.rows.length) return null;
  sectionCount++;
  const fresh: Section = { id: uid("sec"), name: `Section ${sectionCount}`, c0: c, c1: c, r0: r, r1: r };
  set({ sections: { ...state.sections, [fresh.id]: fresh } });
  return fresh.id;
}

/**
 * A fresh section along a whole side of the board: a new track opens there,
 * a normal track's size, and the section spans the board beside it (as a
 * section dropped past the edge does, moveSectionToEdge).
 */
export function newSectionAtEdge(edge: BoardEdge): string {
  const grid: GridTracks = { cols: [...state.grid.cols], rows: [...state.grid.rows] };
  const sections: Record<string, Section> = { ...state.sections };
  sectionCount++;
  const id = uid("sec");
  const name = `Section ${sectionCount}`;
  if (edge === "left" || edge === "right") {
    if (edge === "left") {
      grid.cols.unshift(DEFAULT_COL_W);
      for (const o of Object.values(sections)) sections[o.id] = { ...o, c0: o.c0 + 1, c1: o.c1 + 1 };
    } else grid.cols.push(DEFAULT_COL_W);
    const c = edge === "left" ? 0 : grid.cols.length - 1;
    sections[id] = { id, name, c0: c, c1: c, r0: 0, r1: grid.rows.length - 1 };
  } else {
    if (edge === "top") {
      grid.rows.unshift(DEFAULT_ROW_H);
      for (const o of Object.values(sections)) sections[o.id] = { ...o, r0: o.r0 + 1, r1: o.r1 + 1 };
    } else grid.rows.push(DEFAULT_ROW_H);
    const r = edge === "top" ? 0 : grid.rows.length - 1;
    sections[id] = { id, name, r0: r, r1: r, c0: 0, c1: grid.cols.length - 1 };
  }
  set({ grid, sections });
  return id;
}

// ---------- note actions ----------

/**
 * A hosted app fills its section, so a card added there would be hidden under
 * it: the app becomes a card in the flow beside it instead ("Show as a card"),
 * as an agent's add does (cardSection in the server's tools.ts).
 */
function unhostFor(sectionId: string): Partial<AppState> {
  const sec = state.sections[sectionId];
  if (!sec?.host) return {};
  return { sections: { ...state.sections, [sectionId]: { ...sec, host: undefined } } };
}

let noteCount = 0;

export function addNote(sectionId: string, text?: string, opts: { focus?: boolean } = {}): NoteMeta {
  sectionId = leafSection(sectionId); // a section that is a grid of sections: its first one
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
    bornAt: Date.now(),
  };
  set({
    notes: { ...state.notes, [meta.id]: meta },
    ...unhostFor(sectionId),
    activeSectionId: sectionId,
    ...(opts.focus === false ? {} : { snapRequest: { kind: "object" as const, id: meta.id, nonce: Math.random() } }),
  });
  return meta;
}

let textCount = 0;
/** the text box this window just made: its maker's caret goes in it (nobody else's does) */
let freshTextBox: string | null = null;
export function takeFreshTextBox(id: string): boolean {
  if (freshTextBox !== id) return false;
  freshTextBox = null;
  return true;
}

/**
 * A text box: a note you write as formatted text (bold, headings, lists: a
 * toolbar, as in a word processor) instead of as markdown source. It starts
 * empty and `at` puts it where it was asked for.
 */
export function addTextBox(sectionId: string, at: { float?: boolean; x?: number; y?: number } = {}, opts: { focus?: boolean } = {}): NoteMeta {
  sectionId = leafSection(sectionId);
  textCount++;
  const meta: NoteMeta = {
    id: uid("note"),
    sectionId,
    name: `Text ${textCount}`,
    x: at.x ?? 0,
    y: at.y ?? 0,
    w: 480,
    h: 320,
    text: "",
    rich: true,
    float: at.float ?? false,
    bornAt: Date.now(),
  };
  freshTextBox = meta.id;
  set({
    notes: { ...state.notes, [meta.id]: meta },
    ...unhostFor(sectionId),
    activeSectionId: sectionId,
    ...(opts.focus === false ? {} : { snapRequest: { kind: "object" as const, id: meta.id, nonce: Math.random() } }),
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
  opts: { focus?: boolean } = {},
): MediaMeta {
  sectionId = leafSection(sectionId); // a section that is a grid of sections: its first one
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
    bornAt: Date.now(),
  };
  set({
    media: { ...state.media, [meta.id]: meta },
    ...unhostFor(sectionId),
    activeSectionId: sectionId,
    ...(opts.focus === false ? {} : { snapRequest: { kind: "object" as const, id: meta.id, nonce: Math.random() } }),
  });
  return meta;
}

/** swap a local preview for the shared URL once the upload lands */
export function setMediaSrc(id: string, src: string) {
  const m = state.media[id];
  if (!m) return;
  if (m.src.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(m.src), 4000);
  set({ media: { ...state.media, [id]: { ...m, src } } });
}

export function removeMedia(id: string) {
  const { [id]: gone, ...rest } = state.media;
  if (!gone) return;
  if (gone.src.startsWith("blob:")) URL.revokeObjectURL(gone.src);
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

export function setMediaFlag(id: string, patch: Partial<Pick<MediaMeta, "autoplay" | "muted" | "invert">>) {
  const m = state.media[id];
  if (!m) return;
  set({ media: { ...state.media, [id]: { ...m, ...patch } } });
}

// ---------- table actions ----------

const DEFAULT_COLS = 4;
const DEFAULT_ROWS = 8;
let tableCount = 0;

export function createTable(sectionId: string, atX?: number, atY?: number, opts: { quiet?: boolean } = {}): TableMeta {
  sectionId = leafSection(sectionId); // a section that is a grid of sections: its first one
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
    bornAt: Date.now(),
  };
  workbook.addTable(id, name, cols, rows);
  set({
    tables: { ...state.tables, [id]: meta },
    ...unhostFor(sectionId),
    activeSectionId: sectionId,
    ...(opts.quiet ? {} : { snapRequest: { kind: "object" as const, id, nonce: Math.random() } }),
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
  sectionId = leafSection(sectionId); // a section that is a grid of sections: its first one
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
    bornAt: Date.now(),
  };
  set({
    maps: { ...state.maps, [id]: meta },
    ...unhostFor(sectionId),
    activeSectionId: sectionId,
    snapRequest: { kind: "object", id, nonce: Math.random() },
  });
  return meta;
}

export function removeMap(id: string) {
  const { [id]: gone, ...rest } = state.maps;
  if (!gone) return;
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
  if (!m) return;
  set({ maps: { ...state.maps, [id]: { ...m, sourceTableId } } });
}

export function toggleMapPitch(id: string) {
  const m = state.maps[id];
  if (!m) return;
  set({ maps: { ...state.maps, [id]: { ...m, pitched: !m.pitched } } });
}

// ---------- panels (apps, links, files, machines, agents, connectors, asks) ----------

const PANEL_SIZE: Record<PanelMeta["panel"], [number, number]> = {
  app: [720, 520],
  link: [640, 460],
  file: [420, 340],
  machine: [760, 520],
  agent: [420, 360],
  connector: [460, 320],
  ask: [380, 220],
  stage: [460, 440],
  huddle: [560, 420],
  slack: [420, 520],
  crew: [380, 440],
  character: [460, 720],
  grid: [720, 520],
  kanban: [1480, 980],
  design: [1180, 900],
  pipeline: [1480, 330],
  collection: [360, 420],
};

export function addPanel(
  sectionId: string,
  p: Partial<PanelMeta> & Pick<PanelMeta, "panel" | "name">,
  opts: { focus?: boolean } = {},
): PanelMeta {
  sectionId = leafSection(sectionId); // a section that is a grid of sections: its first one
  const [w, h] = PANEL_SIZE[p.panel];
  // an app opened into an empty section becomes that section's app
  const sec = state.sections[sectionId];
  // (a section that still holds only the untouched sheet it started with counts as empty: the sheet gives way)
  const sheet = sec && isHostable(p.panel) ? startingSheet(sectionId) : null;
  const hosts = Boolean(sec) && (objectsInSection(sectionId).length === 0 || !!sheet) && isHostable(p.panel);
  if (sheet) removeTable(sheet.id);
  const meta: PanelMeta = {
    id: uid("pnl"),
    sectionId,
    x: 0,
    y: 0,
    float: false,
    bornAt: Date.now(),
    w,
    h,
    ports: [],
    ...p,
  };
  set({
    panels: { ...state.panels, [meta.id]: meta },
    ...(hosts ? { sections: { ...state.sections, [sectionId]: { ...sec, host: meta.id, name: meta.name } } } : unhostFor(sectionId)),
    activeSectionId: sectionId,
    ...(opts.focus === false ? {} : { snapRequest: { kind: "object" as const, id: meta.id, nonce: Math.random() } }),
  });
  return meta;
}

/** A machine card in a section, not started yet (SPEC §3 Machines): a person picks an image and presses Start on it.
 *  One way in for the section's tools, its right-click menu and ⌘K. `at` places it where the person pointed. */
export function startMachine(sectionId: string, at: Partial<Pick<PanelMeta, "float" | "x" | "y">> = {}): PanelMeta {
  return addPanel(sectionId, { panel: "machine", name: "Machine", machine: { name: `box-${Math.random().toString(16).slice(2, 6)}`, state: "absent" }, ...at });
}

export function updatePanel(id: string, patch: Partial<PanelMeta>) {
  const p = state.panels[id];
  if (!p) return;
  set({ panels: { ...state.panels, [id]: { ...p, ...patch } } });
}

export function removePanel(id: string) {
  const { [id]: gone, ...rest } = state.panels;
  if (!gone) return;
  const links = Object.fromEntries(Object.entries(state.links).filter(([, l]) => l.from.panel !== id && l.to.panel !== id));
  const sec = state.sections[gone.sectionId];
  const sections = sec?.host === id ? { sections: { ...state.sections, [sec.id]: { ...sec, host: undefined } } } : {};
  set({ panels: rest, links, ...sections, ...focusCleanup(id) });
}

/** Host an app in its section (it fills it, ports on the section's edges), or let it go back to being a card. */
export function setSectionHost(sectionId: string, panelId: string | null) {
  const sec = state.sections[sectionId];
  if (!sec) return;
  const p = panelId ? state.panels[panelId] : null;
  set({
    sections: { ...state.sections, [sectionId]: { ...sec, host: p ? p.id : undefined, ...(p ? { name: p.name } : {}) } },
    ...(p ? { panels: { ...state.panels, [p.id]: { ...p, sectionId, float: false, x: 0, y: 0 } } } : {}),
  });
}

export function movePanel(id: string, x: number, y: number) {
  updatePanel(id, { x: Math.max(0, x), y: Math.max(0, y) });
}

export function resizePanel(id: string, w: number, h: number) {
  updatePanel(id, { w: Math.max(240, Math.min(2400, w)), h: Math.max(140, Math.min(1800, h)) });
}

/** an app emitted a value on one of its output ports */
export function emitPort(panelId: string, portId: string, value: unknown) {
  const p = state.panels[panelId];
  if (!p) return;
  updatePanel(panelId, { outputs: { ...(p.outputs ?? {}), [portId]: value } });
}

export function addLink(link: Omit<LinkDoc, "id">): LinkDoc {
  const l: LinkDoc = { ...link, id: uid("lnk") };
  set({ links: { ...state.links, [l.id]: l } });
  return l;
}

export function removeLink(id: string) {
  const { [id]: gone, ...rest } = state.links;
  if (!gone) return;
  set({ links: rest });
}

/** the value arriving at an input port, following the wire back to its source */
export function inputValue(panelId: string, portId: string): unknown {
  for (const l of Object.values(state.links)) {
    if (l.to.panel === panelId && l.to.port === portId) {
      return state.panels[l.from.panel]?.outputs?.[l.from.port];
    }
  }
  return undefined;
}

/** a new named section at the right of the active one (⌘K → New section) */
export function appendSectionLocal(name: string) {
  addSectionAdjacent(state.activeSectionId, "right");
  renameSection(state.activeSectionId, name);
}

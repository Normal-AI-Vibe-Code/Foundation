/**
 * The board, as Rune is handed it (apps/rune/src/scene.rs reads this shape;
 * keep the two in step and bump SCENE_VERSION together).
 *
 * Everything is already laid out by the store's own geometry — the same
 * functions the web renderer, the wires and the cursors read — so the two
 * engines can't disagree about where a section or a card is. Colours arrive
 * resolved from the design tokens. Rune decides neither.
 *
 * Not every card is Rune's. Live apps, pages, machines, huddles, Slack,
 * connectors, maps and video are web content: they stay the web's own
 * components, placed over Rune's canvas as **islands** (RuneIslands.tsx) at
 * the same rects. A table is Rune's at rest and the web's while it's the card
 * in hand, so cells, formulas, ranges and menus all work. `isIsland` is the
 * one rule both sides read: a card is drawn by exactly one of them.
 */

import {
  CONTENT_PAD,
  SECTION_HEADER,
  SECTION_INSET,
  childrenOf,
  emptyCells,
  gridCellRect,
  gridSize,
  isPanel,
  objectPixelSize,
  objectWorldRect,
  objectsInSection,
  sectionFlow,
  sectionRestRect,
  trackOffsets,
  type AnyObject,
  type AppState,
} from "../state/store";
import { workbook } from "../engine/workbook";
import { colName, gutterRuns } from "../lib/gridLines";
import { formatValue } from "../lib/cellText";
import { cardChrome, removeQuestion, sectionTools, type SceneTool } from "./tools";

export const SCENE_VERSION = 4;

/** sRGB, straight alpha, 0..1 */
export type Rgba = [number, number, number, number];

/** the tokens Rune draws with (packages/ui/src/tokens.css), by the name scene.rs gives them */
export const TOKEN_VARS = {
  void: "--color-void",
  abyss: "--color-abyss",
  panel: "--color-panel",
  raise: "--color-raise",
  frost: "--color-frost",
  mist: "--color-mist",
  dim: "--color-dim",
  pulse: "--color-pulse",
  moss: "--color-moss",
  agent: "--color-agent",
  bad: "--color-bad",
  line: "--color-line",
  lineStrong: "--color-line-strong",
} as const;
export type SceneTokens = Record<keyof typeof TOKEN_VARS, Rgba>;

export type CardKind = "note" | "table" | "image";

/** a table cell that has something in it: column, row, what it shows, and whether that's a number or an error */
export interface SceneCell {
  c: number;
  r: number;
  t: string;
  n: boolean;
  e: boolean;
}

export interface SceneCard {
  id: string;
  kind: CardKind;
  x: number;
  y: number;
  w: number;
  h: number;
  s: number;
  name: string;
  text: string;
  src: string;
  agent: string;
  active: boolean;
  /** the section it's in (it travels with it while the section is dragged) */
  section: string;
  /** its chrome on hover, and whether its corner resizes it (tools.ts) */
  chrome: "" | "bar" | "icons";
  tools: SceneTool[];
  resizable: boolean;
  /** a table's size and the cells that hold something */
  cols: number;
  rows: number;
  cells: SceneCell[];
}

export interface Scene {
  version: number;
  view: { left: number; top: number; right: number };
  paper: boolean;
  readOnly: boolean;
  tokens: SceneTokens;
  grid: {
    w: number;
    h: number;
    cols: Array<{ at: number; len: number; label: string }>;
    rows: Array<{ at: number; len: number; label: string }>;
    lines: Array<{ x: number; y: number; len: number; vertical: boolean }>;
  };
  sections: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    coords: string;
    count: string;
    active: boolean;
    /** its toolbar (tools.ts), whether it can be dragged to another cell, what its remove confirmation asks, how many cards don't fit */
    tools: SceneTool[];
    movable: boolean;
    confirm: string;
    more: number;
  }>;
  empties: Array<{ c: number; r: number; x: number; y: number; w: number; h: number; label: string }>;
  cards: SceneCard[];
  /** where a section being dragged would land (the store's sectionDragTarget, as the web grid draws it) */
  drop: { x: number; y: number; w: number; h: number; label: string } | null;
}

export interface SceneOptions {
  insets: { left: number; top: number; right: number };
  readOnly: boolean;
  tokens: SceneTokens;
  /** Rune paints the paper (its canvas isn't see-through here) */
  paper: boolean;
  /** the address Rune can fetch an image from, or "" when it can't (a blob: the web renderer made, a file behind a bearer) */
  imageSrc?(src: string): string;
}

const imageSrcOf = (o: AnyObject, opts: Pick<SceneOptions, "imageSrc">) => ("src" in o && "media" in o && o.media === "image" ? (opts.imageSrc ? opts.imageSrc(o.src) : o.src) : "");

/**
 * Is this card the web's to draw, over Rune's canvas? Everything Rune doesn't
 * draw itself: panels (apps, pages, machines, huddles, Slack, connectors,
 * files, asks), maps, video, an image Rune can't fetch, and the table that's
 * the card in hand (the live sheet takes its place while it's being worked on).
 */
export function isIsland(st: AppState, o: AnyObject, opts: Pick<SceneOptions, "imageSrc"> = {}): boolean {
  if (isPanel(o)) return true;
  if ("sourceTableId" in o) return true;
  if ("cols" in o) return st.focusLevel === "object" && st.activeObjectId === o.id;
  if ("media" in o) return o.media === "video" || !imageSrcOf(o, opts);
  // a text box is written in the page's own editing surface
  if ("text" in o) return !!o.rich;
  return false;
}

function tableCells(id: string, cols: number, rows: number): SceneCell[] {
  const out: SceneCell[] = [];
  const data = workbook.getTable(id);
  if (!data) return out;
  for (const [coord, cell] of data.cells) {
    const [c, r] = coord.split(",").map(Number);
    if (c >= cols || r >= rows) continue;
    const t = cell.error ? cell.error : formatValue(cell.value);
    if (t) out.push({ c, r, t, n: typeof cell.value === "number" && !cell.error, e: !!cell.error });
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}

/** what Rune should draw for the store as it stands */
export function buildScene(st: AppState, opts: SceneOptions): Scene {
  const size = gridSize(st.grid);
  const xo = trackOffsets(st.grid.cols);
  const yo = trackOffsets(st.grid.rows);
  const sections = Object.values(st.sections);

  const lines = gutterRuns(st.grid, sections)
    .filter((g) => !g.interior)
    .map((g) =>
      g.axis === "col"
        ? { x: xo[g.index + 1], y: yo[g.from], len: yo[g.to + 1] - yo[g.from], vertical: true }
        : { x: xo[g.from], y: yo[g.index + 1], len: xo[g.to + 1] - xo[g.from], vertical: false },
    );

  const cards: SceneCard[] = [];
  const outSections: Scene["sections"] = [];
  for (const s of sections) {
    const rect = sectionRestRect(st.grid, s);
    const kids = s.virtual ? [] : childrenOf(s.id, st.allSections);
    const objects = objectsInSection(s.id);
    // a section's body never scrolls: below its smallest fit it shows what fits (the rest is one Expand away)
    const flow = sectionFlow(s.id);
    const bodyW = rect.w - 2;
    const bodyH = rect.h - 2 - SECTION_HEADER;
    const fits = (o: AnyObject) => {
      if (!flow.clipped || s.host === o.id) return true;
      const p = flow.pos.get(o.id) ?? { x: o.x, y: o.y };
      const px = objectPixelSize(o);
      return (CONTENT_PAD + p.x + px.w) * flow.fit <= bodyW + 1 && (CONTENT_PAD + p.y + px.h) * flow.fit <= bodyH + 1;
    };
    outSections.push({
      id: s.id,
      name: s.name,
      ...rect,
      coords: `${colName(s.c0)}${s.r0 + 1}${s.c1 !== s.c0 || s.r1 !== s.r0 ? `:${colName(s.c1)}${s.r1 + 1}` : ""}`,
      count: kids.length ? `▦ ${kids.length}` : objects.length ? String(objects.length) : "",
      active: st.activeSectionId === s.id,
      tools: sectionTools(st, s, opts.readOnly),
      movable: !opts.readOnly && !s.virtual,
      confirm: removeQuestion(st, s),
      more: objects.filter((o) => !fits(o)).length,
    });
    for (const o of objects) {
      if (isIsland(st, o, opts)) continue; // the web's, over the canvas
      const r = objectWorldRect(o);
      if (!r) continue;
      const px = objectPixelSize(o);
      if (!fits(o)) continue;
      const table = "cols" in o ? o : null;
      cards.push({
        id: o.id,
        kind: table ? "table" : "media" in o ? "image" : "note",
        x: r.x,
        y: r.y,
        // its own size, drawn at the section's fit
        w: px.w,
        h: px.h,
        s: r.s,
        name: o.name,
        text: "text" in o && typeof o.text === "string" ? o.text : "",
        src: imageSrcOf(o, opts),
        agent: o.createdBy ?? "",
        active: st.focusLevel === "object" && st.activeObjectId === o.id,
        section: s.id,
        ...cardChrome(o, opts.readOnly),
        cols: table?.cols ?? 0,
        rows: table?.rows ?? 0,
        cells: table ? tableCells(table.id, table.cols, table.rows) : [],
      });
    }
  }

  return {
    version: SCENE_VERSION,
    view: opts.insets,
    paper: opts.paper,
    readOnly: opts.readOnly,
    tokens: opts.tokens,
    grid: {
      w: size.w,
      h: size.h,
      cols: st.grid.cols.map((len, i) => ({ at: xo[i], len, label: colName(i) })),
      rows: st.grid.rows.map((len, i) => ({ at: yo[i], len, label: String(i + 1) })),
      lines,
    },
    sections: outSections,
    empties: emptyCells().map(({ c, r }) => {
      const rect = gridCellRect(st.grid, c, r);
      return { c, r, x: rect.x + SECTION_INSET, y: rect.y + SECTION_INSET, w: rect.w - SECTION_INSET * 2, h: rect.h - SECTION_INSET * 2, label: `${colName(c)}${r + 1}` };
    }),
    cards,
    drop: dropTarget(st),
  };
}

/** the cell (or the band along an edge of the board) a dragged section would land in, as GridViewport draws it */
function dropTarget(st: AppState): Scene["drop"] {
  const t = st.sectionDragTarget;
  if (!t) return null;
  if (t.edge) {
    const size = gridSize(st.grid);
    const band = 120;
    const r =
      t.edge === "left" ? { x: -band - 12, y: 0, w: band, h: size.h }
      : t.edge === "right" ? { x: size.w + 12, y: 0, w: band, h: size.h }
      : t.edge === "top" ? { x: 0, y: -band - 12, w: size.w, h: band }
      : { x: 0, y: size.h + 12, w: size.w, h: band };
    return { ...r, label: t.label ?? `Append along the ${t.edge} of the board` };
  }
  const r = gridCellRect(st.grid, t.c, t.r);
  return { x: r.x + 6, y: r.y + 6, w: r.w - 12, h: r.h - 12, label: t.label ?? "" };
}

/**
 * What's under a point of the grid's world, by the same rects Rune draws:
 * the topmost card, else the section whose paper it's on. The camera and its
 * gestures stay in the client for both engines, and ask this where the web
 * renderer asks the DOM. (An island answers for itself: it's in the DOM.)
 */
export function hitWorld(st: AppState, x: number, y: number): { section: string | null; object: string | null } {
  const inside = (r: { x: number; y: number; w: number; h: number }) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  for (const s of Object.values(st.sections)) {
    if (!inside(sectionRestRect(st.grid, s))) continue;
    const objects = objectsInSection(s.id);
    for (let i = objects.length - 1; i >= 0; i--) {
      const r = objectWorldRect(objects[i]);
      if (r && inside(r)) return { section: s.id, object: objects[i].id };
    }
    return { section: s.id, object: null };
  }
  return { section: null, object: null };
}

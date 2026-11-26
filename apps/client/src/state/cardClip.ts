/**
 * Cards copied off the grid (⌘C / ⌘X) and pasted back (⌘V): what a copy keeps, what it leaves, and where it lands.
 * The pure half; the keys and the clipboard events are lib/cardClipboard.ts.
 *
 * A copy is the card's own fields, a note's text and a table's cells. It never brings wires: a pasted card stands
 * alone (a pasted CAD card keeps its `feed`, so it says it's unlinked and keeps its last model). A card whose life
 * is on the server (a huddle, a machine, an agent's session, a replay, a character in the making, a child grid…)
 * isn't copied at all: a second card would claim the same thing, so the copy is refused with a sentence.
 */
import type { AnyObject, MapMeta, MediaMeta, NoteMeta, PanelMeta, TableMeta } from "./store";

export type ClipCard =
  | { kind: "table"; card: TableMeta; cells: Record<string, string> }
  | { kind: "note"; card: NoteMeta }
  | { kind: "map"; card: MapMeta }
  | { kind: "media"; card: MediaMeta }
  | { kind: "panel"; card: PanelMeta };

/** what's copied: the clips, which section they came from, and which board */
export interface Clip {
  /** the copy's number: the marker on the OS clipboard names it (foundation-cards:<n>) */
  n: number;
  board: string;
  cards: ClipCard[];
}

/** the text a card copy puts on the OS clipboard, so a later paste knows whether the clipboard is still ours */
export const MARKER = "foundation-cards:";
export const markerOf = (n: number) => `${MARKER}${n}`;
export function parseMarker(text: string | null | undefined): number | null {
  const m = /^foundation-cards:(\d+)$/.exec((text ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** panel kinds whose card is a handle on something the server keeps: why each can't be copied */
const KEPT: Partial<Record<PanelMeta["panel"], string>> = {
  huddle: "A huddle is one place to meet: it can't be copied. Open a new huddle instead.",
  agent: "An agent's session can't be copied: it is one run. Ask an agent again instead.",
  replay: "A replay is its session's clock: it can't be copied.",
  character: "A character in the making is kept by the server: it can't be copied.",
  pipeline: "A studio's step is kept by the server: it can't be copied.",
  collection: "A collector is kept by the server: it can't be copied.",
  uploader: "The avatar uploader is kept by the server: it can't be copied.",
  local: "A project on this computer is kept by the server: it can't be copied.",
  grid: "A grid inside this one can't be copied: it would be two doors to one grid.",
  slack: "A Slack channel is bridged once, by an admin: it can't be copied.",
  ask: "A request to a person can't be copied: ask again instead.",
};

/** the fields a copied panel never carries: per-card state the server keeps for that one card */
const PANEL_DROP = ["huddle", "home", "sessionId", "machine", "vm", "status"] as const;

/** a card as it goes on the clipboard, or why it can't (pure) */
export function clipOf(obj: AnyObject, cells: Record<string, string> = {}): { clip: ClipCard } | { refuse: string } {
  const base = { ...obj } as AnyObject & { createdBy?: string; pinned?: boolean };
  // the copy is the person's, not the agent's that made the first; pinning is one to a section
  delete base.createdBy;
  delete base.pinned;
  if ("panel" in obj) {
    const why = KEPT[obj.panel];
    if (why) return { refuse: why };
    if (obj.panel === "machine" && (obj.machine || obj.vm))
      return { refuse: "A machine runs on the server: a copy would be a second card for one machine. Add a new machine instead." };
    if (obj.status === "running" && obj.panel === "file") return { refuse: `${obj.name || "That file"} is still uploading: copy it once it lands.` };
    const p = base as PanelMeta & Record<string, unknown>;
    for (const k of PANEL_DROP) delete p[k];
    return { clip: { kind: "panel", card: p } };
  }
  if ("cols" in obj) return { clip: { kind: "table", card: base as TableMeta, cells: { ...cells } } };
  if ("sourceTableId" in obj) return { clip: { kind: "map", card: base as MapMeta } };
  if ("text" in obj) return { clip: { kind: "note", card: base as NoteMeta } };
  if (obj.src.startsWith("blob:")) return { refuse: `${obj.name || "That picture"} is still uploading: copy it once it lands.` };
  return { clip: { kind: "media", card: base as MediaMeta } };
}

/** where a pasted card goes */
export interface PasteTarget {
  sectionId: string;
  /** the content point under the pointer in that section, when the pointer is on it */
  at?: { x: number; y: number } | null;
}

/** how far each paste steps from the one before, so copies never sit exactly on top */
export const PASTE_STEP = 32;

/**
 * Where the i-th card of a paste lands (pure). Under the pointer: floating there, each next one a step down and
 * right. In the section it came from: a floating card a step (per paste) from where it was; a card in the flow
 * joins the flow (it lays out beside the first). Anywhere else: it joins that section's flow.
 */
export function placeFor(
  origin: { sectionId: string; x: number; y: number; float: boolean },
  target: PasteTarget,
  i: number,
  round: number,
): { sectionId: string; x: number; y: number; float: boolean } {
  const d = PASTE_STEP * i;
  if (target.at) return { sectionId: target.sectionId, x: Math.max(0, Math.round(target.at.x + d)), y: Math.max(0, Math.round(target.at.y + d)), float: true };
  if (target.sectionId === origin.sectionId && origin.float) {
    const k = PASTE_STEP * Math.max(1, round) + d;
    return { sectionId: target.sectionId, x: origin.x + k, y: origin.y + k, float: true };
  }
  return { sectionId: target.sectionId, x: 0, y: 0, float: false };
}

/** a name not already taken (case aside): "Parts", "Parts copy", "Parts copy 2"… (pure) */
export function copyName(name: string, taken: Iterable<string>): string {
  const t = new Set([...taken].map((s) => s.trim().toLowerCase()));
  const stem = `${name.trim() || "Table"} copy`;
  if (!t.has(stem.toLowerCase())) return stem;
  for (let k = 2; ; k++) if (!t.has(`${stem} ${k}`.toLowerCase())) return `${stem} ${k}`;
}

/** a pasted card, and a table's cells to fill it with */
export interface Pasted {
  card: AnyObject;
  cells?: Record<string, string>;
}

/**
 * The cards a paste puts down (pure): fresh ids, the target's section and places, a new birth; a table gets a name
 * of its own (formulas find tables by name), and a map that read a table copied with it reads the copy.
 */
export function pasteCards(
  clips: ClipCard[],
  target: PasteTarget,
  opts: { round: number; now: number; id: (prefix: string) => string; tableNames: Iterable<string> },
): Pasted[] {
  const names = [...opts.tableNames];
  const ids = new Map<string, string>();
  const prefix = { table: "table", note: "note", map: "map", media: "media", panel: "pnl" } as const;
  for (const c of clips) ids.set(c.card.id, opts.id(prefix[c.kind]));
  return clips.map((c, i) => {
    const place = placeFor(c.card, target, i, opts.round);
    const card = { ...c.card, ...place, id: ids.get(c.card.id)!, bornAt: opts.now } as AnyObject;
    if (c.kind === "table") {
      const name = copyName(c.card.name, names);
      names.push(name);
      return { card: { ...(card as TableMeta), name }, cells: { ...c.cells } };
    }
    if (c.kind === "map" && c.card.sourceTableId && ids.has(c.card.sourceTableId)) return { card: { ...(card as MapMeta), sourceTableId: ids.get(c.card.sourceTableId)! } };
    return { card };
  });
}

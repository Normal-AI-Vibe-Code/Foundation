/**
 * Board migrations (meta.schema). flowform shipped unversioned fields and
 * paid for it; every layout change here is a numbered, idempotent step.
 *
 *  1 → 2  Sections host apps. A section that held only apps (the company
 *         board's six connectors) becomes one section per app, laid out the
 *         way the cards were, each app filling its section, so the wires
 *         between them run section to section. A section holding a single
 *         app is that app's host.
 *  2 → 3  A note's text moves into its own Y.Text (`noteText`).
 *  3 → 5  Each table's cells become a Y.Map in `cells`, made with the table.
 *  5 → 6  A huddle's live state moves off its card into `huddles`, which
 *         only the server writes, so moving the card can't overwrite it.
 */

import * as Y from "yjs";
import { BOARD_SCHEMA, boardMaps, isHostable, readTracks, setHuddleState, setNoteText, tableCellMap, uid, type GridTracks, type ObjectDoc, type PanelDoc, type SectionDoc } from "@foundation/protocol";
import { editBoard, getBoard, listBoards } from "./boards.ts";
import { nameOldSeats } from "./posted.ts";
import { roster, setAvatar } from "./characters.ts";

export function migrateAllBoards() {
  for (const b of listBoards()) migrateBoard(b.id);
  // council seats from before they had names of their own (posted.ts): named once, keeping the character each wore
  const avatars = roster().avatars;
  const system = { id: "system", email: "system@foundation.local", name: "Foundation", color: "#888", role: "admin" as const };
  for (const b of listBoards()) nameOldSeats(b.id, (n) => avatars[n], (alias, ch) => {
    try {
      setAvatar(system, alias, ch);
    } catch {
      /* a character no longer ready: the seat goes back to the steady pick */
    }
  });
}

export function migrateBoard(id: string) {
  const m = boardMaps(getBoard(id).doc);
  const schema = (m.meta.get("schema") as number | undefined) ?? 1;
  if (schema >= BOARD_SCHEMA) return false;
  editBoard(id, "migrate", (doc) => {
    if (schema < 2) hostApps(doc);
    if (schema < 3) noteTextToYText(doc);
    if (schema < 5) cellsToYMaps(doc); // 4: maps for tables with cells; 5: every table, cells or not
    if (schema < 6) huddleStateToMap(doc);
    boardMaps(doc).meta.set("schema", BOARD_SCHEMA);
  });
  return true;
}

/**
 * schema 6: a huddle's live state moves off its card into `huddles`. The
 * server writes that map alone; the card in `objects` is the person's (they
 * move and resize it), so a move at the moment someone joins no longer
 * overwrites who's in it. State already in the map wins (it's the server's
 * newer word). Idempotent: a second run finds no card carrying `huddle`.
 */
export function huddleStateToMap(doc: Y.Doc) {
  const m = boardMaps(doc);
  for (const o of [...m.objects.values()]) {
    if (o.kind !== "panel" || o.huddle === undefined) continue;
    if (!m.huddles.has(o.id)) setHuddleState(doc, o.id, o.huddle);
    const { huddle: _moved, ...card } = o;
    m.objects.set(o.id, card);
  }
}

/** schema 4: each table's cells become a Y.Map, so two people editing different cells both land */
export function cellsToYMaps(doc: Y.Doc) {
  const m = boardMaps(doc);
  const tables = [...m.objects.values()].filter((o) => o.kind === "table").map((o) => o.id);
  for (const id of new Set([...m.cells.keys(), ...tables])) tableCellMap(doc, id);
}

/** schema 3: each note's text moves into its own Y.Text, so concurrent typing merges */
export function noteTextToYText(doc: Y.Doc) {
  const m = boardMaps(doc);
  for (const o of [...m.objects.values()]) {
    if (o.kind !== "note" || o.text === undefined) continue;
    if (!m.noteText.has(o.id)) setNoteText(doc, o.id, o.text);
    const { text: _moved, ...card } = o;
    m.objects.set(o.id, card);
  }
}

/** schema 2: every app gets a section of its own */
export function hostApps(doc: Y.Doc) {
  const m = boardMaps(doc);
  for (const id of [...m.sections.keys()]) {
    const sec = m.sections.get(id); // re-read: an earlier split may have moved it
    if (!sec) continue;
    const inside = [...m.objects.values()].filter((o) => o.sectionId === sec.id);
    const apps = inside.filter((o): o is PanelDoc => o.kind === "panel" && isHostable(o.panel));
    if (apps.length >= 2 && apps.length === inside.length) splitIntoApps(doc, sec, apps);
    else if (apps.length === 1 && inside.length === 1) m.sections.set(sec.id, { ...sec, host: apps[0].id });
  }
}

/** group positions that sit within `tol` of each other into ordered bands */
function bands(values: number[], tol = 160): number[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}
const bandOf = (v: number, b: number[]) => b.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(b[best] - v) ? i : best), 0);

/**
 * Replace the section's own tracks with one per band of apps (same total
 * size), shift every other section's spans to match, and give each app a
 * section where its card was — widened right over empty cells in its row.
 */
function splitIntoApps(doc: Y.Doc, sec: SectionDoc, apps: PanelDoc[]) {
  const m = boardMaps(doc);
  const pos = new Map(apps.map((a) => [a.id, { x: a.float ? a.x : 0, y: a.float ? a.y : 0 }]));
  // docked apps flowed left to right: place them by birth order instead
  if (apps.every((a) => !a.float)) [...apps].sort((a, b) => a.bornAt - b.bornAt).forEach((a, i) => pos.set(a.id, { x: (i % 3) * 600, y: Math.floor(i / 3) * 400 }));
  const xb = bands(apps.map((a) => pos.get(a.id)!.x));
  const yb = bands(apps.map((a) => pos.get(a.id)!.y));

  const tracks = readTracks(doc);
  const split = (list: number[], a0: number, a1: number, k: number) => {
    const total = list.slice(a0, a1 + 1).reduce((s, v) => s + v, 0);
    return [...list.slice(0, a0), ...Array.from({ length: k }, () => Math.round(total / k)), ...list.slice(a1 + 1)];
  };
  const remap = (i: number, a0: number, a1: number, k: number, end: boolean) => {
    const span = a1 - a0 + 1;
    if (i < a0) return i;
    if (i > a1) return i + k - span;
    return end ? a0 + Math.ceil(((i - a0 + 1) * k) / span) - 1 : a0 + Math.floor(((i - a0) * k) / span);
  };
  const next: GridTracks = { cols: split(tracks.cols, sec.c0, sec.c1, xb.length), rows: split(tracks.rows, sec.r0, sec.r1, yb.length) };
  for (const o of [...m.sections.values()]) {
    if (o.id === sec.id) continue;
    m.sections.set(o.id, {
      ...o,
      c0: remap(o.c0, sec.c0, sec.c1, xb.length, false),
      c1: remap(o.c1, sec.c0, sec.c1, xb.length, true),
      r0: remap(o.r0, sec.r0, sec.r1, yb.length, false),
      r1: remap(o.r1, sec.r0, sec.r1, yb.length, true),
    });
  }
  m.grid.set("tracks", next);

  // place: row by row, each app reaches right to the next one (the first back to the row's start)
  const cell = new Map(apps.map((a) => [a.id, { c: bandOf(pos.get(a.id)!.x, xb), r: bandOf(pos.get(a.id)!.y, yb) }]));
  const ordered = [...apps].sort((a, b) => cell.get(a.id)!.r - cell.get(b.id)!.r || cell.get(a.id)!.c - cell.get(b.id)!.c);
  ordered.forEach((app, i) => {
    const { c, r } = cell.get(app.id)!;
    const rowMates = ordered.filter((o) => cell.get(o.id)!.r === r);
    const j = rowMates.indexOf(app);
    const c0 = j === 0 ? 0 : c;
    const c1 = j === rowMates.length - 1 ? xb.length - 1 : cell.get(rowMates[j + 1].id)!.c - 1;
    const id = i === 0 ? sec.id : uid("sec"); // the first app keeps the section (and its links in people's heads)
    m.sections.set(id, { id, name: app.name, c0: sec.c0 + c0, c1: sec.c0 + c1, r0: sec.r0 + r, r1: sec.r0 + r, host: app.id });
    const moved: ObjectDoc = { ...app, sectionId: id, x: 0, y: 0, float: false };
    m.objects.set(app.id, moved);
  });
}

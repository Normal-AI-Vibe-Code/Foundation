/**
 * Every grid's notes, for the side menu's Notes (2026-11-26, Josh: "List them all, and make sure their
 * hierarchy refers back to the grids that they are in"; docs/notes.md §5). A row per note card: the grid it
 * is on, its section (and that section's path, for a section inside a section), its name, the note page it
 * shows (`ref`) if it is a page's card, and a line of its words. Kept as a board changes (boards.ts indexes it
 * with the search index, a beat after edits settle); a board not opened since this index began is read once,
 * at boot, from its stored updates (without keeping it open).
 *
 * Read only through `notesByGrid`, which answers to a person only for the grids they can see. Nothing here
 * writes a board.
 */

import * as Y from "yjs";
import { boardMaps, noteTextOf, type SectionDoc } from "@foundation/protocol";
import { all, db, run } from "./db.ts";

db.exec(`create table if not exists note_index (
  board_id text not null, note_id text not null, name text not null, section_id text not null,
  section_path text not null, ref text, preview text not null, born_at integer not null,
  primary key (board_id, note_id)
)`);
db.exec("create table if not exists note_index_boards (board_id text primary key, at integer not null)");

/** a section's names from the grid down ("Motors › Rim drive") */
function pathOf(sections: Map<string, SectionDoc>, id: string): string {
  const names: string[] = [];
  for (let s = sections.get(id), n = 0; s && n < 16; s = s.parent ? sections.get(s.parent) : undefined, n++) names.unshift(s.name);
  return names.join(" › ");
}

/** the first line of words, as plain text */
const previewOf = (md: string) =>
  (md.split("\n").map((l) => l.replace(/^\s*(#{1,6}|[-*]|\d+[.)]|>|\[[ xX]\])\s*/, "").replace(/[*_~`#>[\]]/g, "").trim()).find((l) => l && !/^<\/?(details|summary)/i.test(l)) ?? "").slice(0, 120);

/** the notes on one board, written over what was kept for it */
export function indexNotes(boardId: string, doc: Y.Doc) {
  const m = boardMaps(doc);
  const sections = new Map([...m.sections.entries()]);
  const rows = [...m.objects.values()].filter((o) => o.kind === "note" && m.sections.has(o.sectionId));
  // its own transaction, unless one is open (a write inside one is part of it)
  const own = !(db as unknown as { isTransaction?: boolean }).isTransaction;
  if (own) db.exec("begin");
  try {
    run("delete from note_index where board_id = ?", boardId);
    for (const o of rows) {
      if (o.kind !== "note") continue;
      run(
        "insert into note_index (board_id, note_id, name, section_id, section_path, ref, preview, born_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        boardId, o.id, o.name ?? "", o.sectionId, pathOf(sections, o.sectionId), o.ref ?? null, o.ref ? "" : previewOf(noteTextOf(doc, o)), o.bornAt ?? 0,
      );
    }
    run("insert or replace into note_index_boards (board_id, at) values (?, ?)", boardId, Date.now());
    if (own) db.exec("commit");
  } catch (e) {
    if (own) db.exec("rollback");
    throw e;
  }
}

/** boards that have never been indexed: read each from its stored updates (a throwaway doc), once */
export function backfillNoteIndex(isOpen: (id: string) => boolean) {
  const missing = all<{ id: string }>("select id from boards where id not in (select board_id from note_index_boards)");
  for (const { id } of missing) {
    if (isOpen(id)) continue; // an open board is indexed by its own updates
    const doc = new Y.Doc();
    try {
      for (const r of all<{ update_blob: Uint8Array }>("select update_blob from board_updates where board_id = ? order by seq", id)) Y.applyUpdate(doc, r.update_blob, "load");
      indexNotes(id, doc);
    } catch (e) {
      console.warn(`notes index: ${id} not read (${(e as Error).message})`);
    } finally {
      doc.destroy();
    }
  }
}

export interface IndexedNote {
  id: string;
  name: string;
  section: string;
  sectionPath: string;
  ref: string | null;
  preview: string;
  bornAt: number;
}

/** every grid's notes, grid by grid (only `grids`: the ones this person can see, and that are grids) */
export function notesByGrid(grids: string[]): Record<string, IndexedNote[]> {
  if (!grids.length) return {};
  const want = new Set(grids);
  const out: Record<string, IndexedNote[]> = {};
  for (const r of all<{ board_id: string; note_id: string; name: string; section_id: string; section_path: string; ref: string | null; preview: string; born_at: number }>(
    "select board_id, note_id, name, section_id, section_path, ref, preview, born_at from note_index order by section_path, born_at",
  )) {
    if (!want.has(r.board_id)) continue;
    (out[r.board_id] ??= []).push({ id: r.note_id, name: r.name, section: r.section_id, sectionPath: r.section_path, ref: r.ref, preview: r.preview, bornAt: r.born_at });
  }
  return out;
}

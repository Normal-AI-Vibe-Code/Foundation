/**
 * Note pages (2026-11-26, docs/notes.md): a note as a first-class object. A note page is a space of kind
 * "note": a `boards` row (its name is the page's title, its `parent` the note page it sits inside) and a
 * board document holding one note, NOTE_BODY, whose shared text is the page's markdown. The same page can
 * stand on any grid as a note card with `ref`: the card has no words of its own, so the side pane and every
 * grid show one text, live.
 *
 * Everything a board has, a note page has: its own sync socket and roles (a viewer of the page can't write
 * it from anywhere, a grid card included), members (a members-only page answers only to its members), its
 * timeline, search. A page is archived, never deleted.
 */

import { NOTE_BODY, NOTE_LINK, boardMaps, noteTextOf, putNote, setNoteText, type NoteDoc } from "@foundation/protocol";
import { createBoardRow, editBoard, getBoard, isNoteKind, listBoards, setBoardParent, type BoardRow } from "./boards.ts";
import { one, run } from "./db.ts";
import { HttpError } from "./http.ts";
import { hiddenBoards } from "./members.ts";
import { notesByGrid, type IndexedNote } from "./noteindex.ts";
import type { UserInfo } from "@foundation/protocol";

/** a page's title as kept: trimmed, one line, at most 80 characters */
export const cleanTitle = (t: unknown) => (typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, 80) : "");

/** a note page that is there (listed, not archived), else undefined */
export function notePage(id: string): BoardRow | undefined {
  const row = listBoards().find((b) => b.id === id);
  return row && isNoteKind(row.kind) ? row : undefined;
}

/** a note page, or a 404 that says so */
export function requireNotePage(id: string): BoardRow {
  const row = notePage(id);
  if (!row) throw new HttpError(404, `No note page ${id}`);
  return row;
}

/** the page's words (its body note's markdown) */
export function notePageText(id: string): string {
  const doc = getBoard(id).doc;
  const body = boardMaps(doc).objects.get(NOTE_BODY);
  return body ? noteTextOf(doc, body) : "";
}

/** the body a note page's board holds, written once (two people opening a new page at once don't both seed it) */
export function seedNoteBody(id: string, name: string, markdown = "") {
  editBoard(id, "system", (doc) => {
    const m = boardMaps(doc);
    if (m.objects.get(NOTE_BODY)) return;
    const body: NoteDoc & { text: string } = { id: NOTE_BODY, kind: "note", sectionId: "", name, x: 0, y: 0, float: false, bornAt: Date.now(), w: 760, h: 900, text: markdown };
    putNote(doc, body);
  });
}

/** an unnamed note takes a name nothing else has: "Untitled note", then "Untitled note 2"… */
function freshTitle(): string {
  const taken = new Set(listBoards().map((b) => b.name));
  let name = "Untitled note";
  for (let n = 2; taken.has(name); n++) name = `Untitled note ${n}`;
  return name;
}

/**
 * Make a note page (inside `parent`, a note page, when one is named): its row, its body, and, unless
 * `link` is false (the editor puts the line where the caret is), a page line at the end of its parent's
 * words, written as `origin` (the caller's write to the parent). The caller has checked it may write the parent.
 */
export function makeNotePage(opts: { title?: string; markdown?: string; parent?: string | null; link?: boolean; origin?: string }): { id: string; name: string } {
  const name = cleanTitle(opts.title) || freshTitle();
  if (opts.parent) requireNotePage(opts.parent);
  const id = createBoardRow(name, { kind: "note" });
  seedNoteBody(id, name, opts.markdown ?? "");
  if (opts.parent) {
    const out = setBoardParent(id, opts.parent);
    if ("error" in out) throw new HttpError(400, out.error);
    if (opts.link !== false) linkInParent(opts.parent, id, name, opts.origin ?? "agent");
  }
  return { id, name };
}

/** a page line for `id` at the end of `parent`'s words, unless one is there already */
export function linkInParent(parent: string, id: string, name: string, origin: string) {
  editBoard(parent, origin, (doc) => {
    const body = boardMaps(doc).objects.get(NOTE_BODY);
    if (!body) return;
    const text = noteTextOf(doc, body);
    if (text.split("\n").some((l) => NOTE_LINK.exec(l.trim())?.[2] === id)) return;
    const line = `[${name.replace(/[[\]]/g, "")}](note:${id})`;
    setNoteText(doc, NOTE_BODY, text.trim() ? `${text.replace(/\s+$/, "")}\n\n${line}` : line);
  });
}

/** a renamed note page: its body carries the name too, so read_board on its board says it */
export function renameNoteBody(id: string, name: string) {
  if (!notePage(id)) return;
  editBoard(id, "system", (doc) => {
    const m = boardMaps(doc);
    const body = m.objects.get(NOTE_BODY);
    if (body && body.name !== name) m.objects.set(NOTE_BODY, { ...body, name });
  });
}

/**
 * Archive a note page: it leaves the side pane and every list, its row and its board stay (never deleted),
 * and a card showing it says it was archived. The pages inside it go up to where it was.
 */
export function archiveNotePage(id: string) {
  const row = requireNotePage(id);
  for (const child of listBoards().filter((b) => b.parent === id)) run("update boards set parent = ? where id = ?", row.parent ?? null, child.id);
  run("update boards set archived_at = ? where id = ?", Date.now(), id);
}

/** was this note page archived (a card showing it says so) */
export const isArchivedNote = (id: string) => Boolean(one<{ archived_at: number | null }>("select archived_at from boards where id = ? and kind = 'note'", id)?.archived_at);

/**
 * Every grid's notes as this person may see them (the side menu's Notes; noteindex.ts): only grids and decks
 * they can see (a members-only grid they aren't on isn't there), not Foundation's own grids, and a card showing
 * a note page they can't see, or one archived, left out.
 */
export function gridNotesFor(user: UserInfo): Record<string, IndexedNote[]> {
  const hidden = hiddenBoards(user);
  const rows = listBoards().filter((b) => !hidden.has(b.id));
  const grids = rows.filter((b) => (b.kind === "grid" || b.kind === "deck") && !b.id.startsWith("foundation-")).map((b) => b.id);
  const pages = new Set(rows.filter((b) => b.kind === "note").map((b) => b.id));
  const by = notesByGrid(grids);
  return Object.fromEntries(Object.entries(by).map(([g, notes]) => [g, notes.filter((n) => !n.ref || pages.has(n.ref))]));
}

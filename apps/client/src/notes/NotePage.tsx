/**
 * A note page, full size (docs/notes.md): the canvas of a space of kind "note", where the floor leaves room
 * (under the top bar, between the panes). Its words are the page's board's one note (NOTE_BODY), written in
 * the same editor as a note on a grid (RichNote, with its blocks); a card showing this page on any grid is
 * the same text, live.
 *
 * Over the words: the pages it sits inside (each opens), its title (the space's name: renaming it renames the
 * page everywhere), and its actions: put it on a grid, open its ⓘ (people, activity), archive it. A reader
 * reads; the title and the words stay theirs to look at.
 */

import { useEffect, useState } from "react";
import { NOTE_BODY } from "@foundation/protocol";
import { requestSnap, useAppState } from "../state/store";
import { floorInsets, getUi, setUi, toast, useUi } from "../state/ui";
import { RichNote } from "../components/RichText";
import { gridPath, isNoteKind, openGrid, useGrids, type BoardRow } from "../lib/grids";
import { openContextMenu, type MenuItem } from "../components/ContextMenu";
import { api } from "../lib/api";
import { isSystemGrid } from "../shell/SidePane";
import { makeNotePage, placeNote } from "./noteSync";
import { gridsShowing, loadGridNotes, useGridNotes } from "./gridNotes";
import "./notepage.css";

export function NotePage({ space, onRename }: { space: BoardRow; onRename(name: string): void }) {
  const ui = useUi();
  const st = useAppState();
  const rows = useGrids();
  const insets = floorInsets(ui);
  const body = st.notes[NOTE_BODY];
  const canWrite = space.role !== "viewer";
  const [title, setTitle] = useState(space.name);
  useEffect(() => setTitle(space.name), [space.name]);
  const path = gridPath(space, rows);

  const commitTitle = () => {
    const t = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!t) return setTitle(space.name);
    if (t !== space.name) onRename(t);
  };

  const putOn = (e: React.MouseEvent) => {
    const grids = rows.filter((b) => !isNoteKind(b.kind) && (b.kind === "grid" || b.kind === "deck") && !isSystemGrid(b.id) && b.role !== "viewer").sort((a, b) => a.name.localeCompare(b.name));
    const items: MenuItem[] = [
      { heading: "Put this note on a grid" },
      ...grids.map(
        (g): MenuItem => ({
          label: g.name,
          action: async () => {
            const err = await placeNote(g.id, space.id);
            if (err) return toast(err, "bad");
            toast(`“${space.name}” is on ${g.name} now: the same note, edited in either place`, "ok");
          },
        }),
      ),
    ];
    if (!grids.length) items.push({ label: "No grid you can change", disabled: true });
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 4, items);
  };

  const archive = async () => {
    if (!window.confirm(`Archive “${space.name}”? It leaves Notes; its words are kept, and cards showing it on grids say it was archived. The pages inside it move up to where it was.`)) return;
    try {
      await api(`/api/boards/${encodeURIComponent(space.id)}/tools/archive_note_page`, { method: "POST", json: { confirm: true, request_id: `archive-${space.id}` } });
      window.dispatchEvent(new Event("foundation:boards"));
      toast(`“${space.name}” was archived`, "ok");
      if (space.parent) openGrid(space.parent);
      else openGrid("company");
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  return (
    <div className="note-page" style={{ left: insets.left, right: insets.right, top: insets.top, bottom: insets.bottom }} data-note-page={space.id}>
      <div className="note-page-col">
        <header className="note-page-head">
          <nav className="note-page-path" aria-label="Inside">
            {path.map((p) => (
              <button key={p.id} type="button" className="note-page-crumb" onClick={() => openGrid(p.id)}>
                {p.name}
              </button>
            ))}
          </nav>
          <div className="note-page-acts">
            {canWrite && (
              <button type="button" className="f-pill" onClick={putOn} data-note-put>
                Put on a grid
              </button>
            )}
            <button type="button" className="f-pill" onClick={() => setUi({ paneView: ui.paneView === "info" ? "spaces" : "info" })} aria-pressed={ui.paneView === "info"}>
              People and activity
            </button>
            {canWrite && (
              <button type="button" className="f-pill is-quiet" onClick={() => void archive()} data-note-archive>
                Archive
              </button>
            )}
          </div>
        </header>
        <OnGrids page={space.id} />
        <input
          className="note-page-title"
          value={title}
          readOnly={!canWrite}
          aria-label="The note's title"
          placeholder="Untitled note"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
              (document.querySelector(".note-page .note-rendered") as HTMLElement | null)?.focus();
            }
            if (e.key === "Escape") {
              setTitle(space.name);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="note-inner note-page-body" data-size={body?.size ?? "m"}>
          {body ? <RichNote note={{ ...body, name: space.name }} page={space.id} /> : <div className="note-page-wait">Opening the note…</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * A grid's own note, full size (2026-11-26, from the side menu's Notes): the same note as its card, over its grid,
 * written in the same editor. Its path goes back to where it is: the grid (which closes this and shows the grid),
 * and the section it sits in. "Show it on the grid" frames its card; "Make it a page" moves its words to a page.
 */
export function GridNoteFull({ board, noteId, gridName }: { board: string; noteId: string; gridName: string }) {
  const ui = useUi();
  const st = useAppState();
  const insets = floorInsets(ui);
  const note = st.notes[noteId];
  const section = note ? st.sections[note.sectionId] : undefined;
  const path: { id: string; name: string }[] = [];
  for (let s = section, n = 0; s && n < 16; s = s.parent ? st.sections[s.parent] : undefined, n++) path.unshift({ id: s.id, name: s.name });
  const canWrite = getUi().role !== "viewer";
  const close = () => setUi({ noteOpen: null });
  const showOnGrid = () => {
    close();
    requestSnap({ kind: "object", id: noteId });
  };
  // a page's card opens the page itself
  useEffect(() => {
    if (note?.ref) {
      close();
      openGrid(note.ref);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.ref]);
  return (
    <div className="note-page is-grid-note" style={{ left: insets.left, right: insets.right, top: insets.top, bottom: insets.bottom }} data-grid-note={noteId}>
      <div className="note-page-col">
        <header className="note-page-head">
          <nav className="note-page-path" aria-label="Where it is">
            <button type="button" className="note-page-crumb is-grid" onClick={close} data-tip="Back to the grid">
              {gridName}
            </button>
            {path.map((s) => (
              <button key={s.id} type="button" className="note-page-crumb" onClick={() => (close(), requestSnap({ kind: "section", id: s.id }))}>
                {s.name}
              </button>
            ))}
          </nav>
          <div className="note-page-acts">
            <button type="button" className="f-pill" onClick={showOnGrid} data-note-show>
              Show it on the grid
            </button>
            {canWrite && note && (
              <button
                type="button"
                className="f-pill"
                onClick={() =>
                  void makeNotePage(board, noteId).then((r) => {
                    if (typeof r === "string") return toast(r, "bad");
                    close();
                    openGrid(r.id);
                  })
                }
              >
                Make it a page
              </button>
            )}
            <button type="button" className="f-pill is-quiet" onClick={close} aria-label="Close">
              Close
            </button>
          </div>
        </header>
        <div className="note-page-title is-static" role="heading" aria-level={1}>
          {note?.name ?? "A note"}
        </div>
        <div className="note-inner note-page-body" data-size={note?.size ?? "m"}>
          {note ? <RichNote note={note} /> : <div className="note-page-wait">{st.sections && Object.keys(st.sections).length ? "This note isn't on the grid any more." : "Opening the note…"}</div>}
        </div>
      </div>
    </div>
  );
}

/** the grids a note page stands on, each a way back to it there */
function OnGrids({ page }: { page: string }) {
  const all = useGridNotes(false);
  const rows = useGrids();
  useEffect(() => void loadGridNotes(), [page]);
  const on = gridsShowing(page, all)
    .map((g) => rows.find((b) => b.id === g))
    .filter((b): b is BoardRow => !!b);
  if (!on.length) return null;
  return (
    <div className="note-page-on" aria-label="On grids">
      <span className="note-page-on-label">On</span>
      {on.map((g) => (
        <button
          key={g.id}
          type="button"
          className="note-page-crumb is-grid"
          onClick={() => {
            const card = all[g.id]?.find((n) => n.ref === page);
            openGrid(g.id);
            if (card) setTimeout(() => requestSnap({ kind: "object", id: card.id }), 900);
          }}
        >
          {g.name}
        </button>
      ))}
    </div>
  );
}

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
import { useAppState } from "../state/store";
import { floorInsets, setUi, toast, useUi } from "../state/ui";
import { RichNote } from "../components/RichText";
import { gridPath, isNoteKind, openGrid, useGrids, type BoardRow } from "../lib/grids";
import { openContextMenu, type MenuItem } from "../components/ContextMenu";
import { api } from "../lib/api";
import { isSystemGrid } from "../shell/SidePane";
import { placeNote } from "./noteSync";
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

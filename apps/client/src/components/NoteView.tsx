import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AgentPill } from "../characters/AgentPill";
import {
  NoteMeta,
  moveNote,
  setNoteBare,
  removeNote,
  resizeNote,
} from "../state/store";

import { activeBoard, onBoardChange, type BoardSync, type NoteCaret } from "../sync/board";
import { getUi, toast } from "../state/ui";

import { ObjectFrame } from "./ObjectFrame";
import type { CaretSource, NoteEditorHandle } from "./noteEditor";
import { countRender } from "../state/renders";
import { RichNote } from "./RichText";
import { useNotePage } from "../notes/noteSync";
import { openGrid, useGrids } from "../lib/grids";

interface Props {
  note: NoteMeta;
  pos: { x: number; y: number };
  isActive: boolean;
  getScale(): number;
}

/**
 * CodeMirror is its own chunk (~100 kB gzipped), never in the first load. It
 * is fetched when a pointer rests on a note, or at idle once a board shows a
 * note (so a page that later loses its network can still open one), and a
 * failed fetch is tried again next time.
 */
let editorModule: Promise<typeof import("./noteEditor")> | null = null;
export const loadNoteEditor = () =>
  (editorModule ??= import("./noteEditor").catch((e: unknown) => {
    editorModule = null;
    throw e;
  }));
let warmed = false;
function warmNoteEditor() {
  if (warmed) return;
  warmed = true;
  const go = () => void loadNoteEditor().catch(() => (warmed = false));
  if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 10_000 });
  else setTimeout(go, 3000);
}

/**
 * A note. There is one kind (2026-11-24, Josh: "the note object and the
 * markdown object should be the same object"): it is written as formatted
 * text, in place, with a toolbar (RichText.tsx), and it is kept as markdown in
 * the note's shared text.
 *
 * Its card's bar carries two buttons of its own, at the right:
 * - **Markdown** turns the card to its markdown and back: a CodeMirror editor
 *   bound to the same shared text, mounted only while it shows (a board of 180
 *   notes runs no editors). Every keystroke goes out as it's typed, so two
 *   people can write in one note at once, even in one word; you see where the
 *   others are writing (their caret and selection, named), and ⌘Z takes back
 *   only your own typing. Which side shows is this window's, not the board's:
 *   one person can read the markdown while another writes the formatted text.
 *   Esc, ⌘↵ or the button again goes back. A viewer can look, not write.
 * - **Background** takes the paper from behind the note, or gives it back
 *   (`bare`, kept on the card): the words stand on the section itself.
 *
 * How large its text is set (`size`) is in the toolbar, with the other
 * formatting.
 */
export const NoteView = memo(function NoteView({ note, pos, isActive, getScale }: Props) {
  countRender("NoteView");
  const [source, setSource] = useState(false);
  const carets = useNoteCarets(note.id, note.text);
  const canWrite = getUi().role !== "viewer";
  // a card showing a note page (docs/notes.md): the words are the page's, under the page's own role
  const pageRow = useGrids().find((b) => b.id === note.ref);
  const page = useNotePage(note.ref);
  const pageReadOnly = !pageRow || pageRow.role === "viewer" || page?.status === "locked";
  useEffect(() => {
    warmNoteEditor();
  }, []);

  const bar = (
    <>
      {canWrite && (
        <button
          className={"icon-btn note-bare-btn" + (note.bare ? " is-on" : "")}
          aria-pressed={!!note.bare}
          aria-label="No background"
          data-tip={note.bare ? "Show the background" : "Hide the background"}
          onClick={() => setNoteBare(note.id, !note.bare)}
        >
          <BareGlyph off={!!note.bare} />
        </button>
      )}
      {note.ref && pageRow && (
        <button className="icon-btn note-open-btn" aria-label={`Open ${pageRow.name}`} data-tip="Open the page" onClick={() => openGrid(note.ref!)}>
          <PageGlyph />
        </button>
      )}
      {!note.ref && <button
        className={"icon-btn note-md-btn" + (source ? " is-on" : "")}
        aria-pressed={source}
        aria-label="Markdown"
        data-tip={source ? "Back to the formatted text" : canWrite ? "Write it as markdown" : "See its markdown"}
        onPointerEnter={() => void loadNoteEditor().catch(() => {})}
        onClick={() => setSource((s) => !s)}
      >
        <MarkdownGlyph />
      </button>}
    </>
  );

  return (
    <ObjectFrame
      id={note.id}
      title={note.ref ? (pageRow?.name ?? note.name) : note.name}
      pos={pos}
      width={note.w}
      float={note.float}
      isActive={isActive}
      getScale={getScale}
      onMove={(x, y) => moveNote(note.id, x, y)}
      onResize={(dw, dh) => resizeNote(note.id, note.w + dw, note.h + dh)}
      onRemove={() => removeNote(note.id)}
      headerExtras={bar}
      bodyClass="note-body"
      cardClass={"note-card" + (note.bare ? " is-bare" : "") + (note.ref ? " is-page" : "")}
      // its bar rises above it and the words hold still (2026-11-25)
      barRise
    >
      <div style={{ ["--h" as string]: `${note.h}px` }} className="note-inner bar-reflow" data-size={note.size ?? "m"}>
        {note.createdBy && !source && (
          <AgentPill name={note.createdBy} tip={`Written by ${note.createdBy}, an agent`} />
        )}
        {!source && carets.length > 0 && (
          <div className="note-writers" aria-label="Writing here now">
            {dedupe(carets).map((c) => (
              <span key={c.clientId} className="note-writer" style={{ ["--peer" as string]: c.color }}>
                {c.name}
              </span>
            ))}
          </div>
        )}
        {note.ref ? (
          page?.status === "locked" ? (
            <div className="note-locked" role="note">
              A note page you can't open: it's members-only, or it isn't there any more.
            </div>
          ) : (
            <>
              {!pageRow && page?.status === "live" && <div className="note-page-gone">This note page was archived. Its words are kept, read-only.</div>}
              <RichNote note={note} words={{ text: page?.text ?? "", write: (md) => page?.write(md), readOnly: pageReadOnly }} page={note.ref} />
            </>
          )
        ) : source ? (
          <NoteWriter noteId={note.id} text={note.text} readOnly={!canWrite} onDone={() => setSource(false)} />
        ) : (
          <RichNote note={note} />
        )}
      </div>
    </ObjectFrame>
  );
});

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** a note page: a sheet with its corner turned, and lines */
export function PageGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...stroke}>
      <path d="M3.5 1.8h4.6l2.4 2.4v8H3.5z" />
      <path d="M8 1.8v2.5h2.5M5.3 7h3.4M5.3 9.3h3.4" />
    </svg>
  );
}

/** the Markdown mark: an M and an arrow down, in a frame */
export function MarkdownGlyph() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden {...stroke}>
      <rect x="1" y="2.5" width="14" height="9" rx="1.6" />
      <path d="M3.6 9V5l1.9 2.2L7.4 5v4M11.2 5v3.8M9.6 7.4l1.6 1.6 1.6-1.6" />
    </svg>
  );
}

/** a card's paper: a sheet, dashed where the paper has been taken away */
export function BareGlyph({ off }: { off: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...stroke}>
      <rect x="1.75" y="1.75" width="10.5" height="10.5" rx="2" strokeDasharray={off ? "2 2.2" : undefined} />
      <path d="M4.4 5.2h5.2M4.4 7h5.2M4.4 8.8h3.2" />
    </svg>
  );
}

/**
 * The note as its markdown: CodeMirror on the note's Y.Text. Until its code has loaded
 * (the first time, a few tens of ms) the note's text shows as it will in the
 * editor, so nothing jumps.
 */
function NoteWriter({ noteId, text, readOnly, onDone }: { noteId: string; text: string; readOnly: boolean; onDone(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let handle: NoteEditorHandle | null = null;
    let gone = false;
    void loadNoteEditor().then((m) => {
      const board = activeBoard();
      const ytext = board?.noteYText(noteId);
      if (gone || !host.current) return;
      if (!board || !ytext) {
        toast("This note's markdown can't be opened until the board has loaded.", "warn");
        done.current();
        return;
      }
      handle = m.mountNoteEditor(host.current, {
        ytext,
        undoManager: board.noteUndoManager(noteId) ?? false,
        carets: boardCarets(board, noteId),
        onDone: () => done.current(),
        focus: !readOnly,
        readOnly,
        stay: true,
      });
      setReady(true);
    }, () => {
      if (gone) return;
      toast("The markdown editor couldn't load (offline?). Try again in a moment.", "warn");
      done.current();
    });
    return () => {
      gone = true;
      handle?.destroy();
    };
  }, [noteId, readOnly]);
  return (
    <div
      ref={host}
      className="note-cm"
      // the board's one-key shortcuts and the grid's keys stand down while writing
      onKeyDown={(e) => e.stopPropagation()}
    >
      {!ready && <div className="note-cm-waiting">{text}</div>}
    </div>
  );
}

/** the board's awareness as the editor's caret source */
function boardCarets(board: BoardSync, noteId: string): CaretSource {
  return {
    get: () => board.noteCarets(noteId),
    subscribe: (fn) => board.onNoteCarets(noteId, fn),
    publish: (sel) => (sel ? board.setCaret(noteId, sel.anchor, sel.head) : board.setCaret(null)),
  };
}

/** other people's carets in this note; re-renders only when one moves or the text changes */
function useNoteCarets(noteId: string, text: string): NoteCaret[] {
  const [tick, setTick] = useState(0);
  const [board, setBoard] = useState(activeBoard);
  useEffect(() => onBoardChange(() => setBoard(activeBoard())), []);
  useEffect(() => board?.onNoteCarets(noteId, () => setTick((t) => t + 1)), [board, noteId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => board?.noteCarets(noteId) ?? [], [board, noteId, text, tick]);
}

/** one chip per person (two tabs of one person show once) */
function dedupe(carets: NoteCaret[]) {
  const seen = new Set<string>();
  return carets.filter((c) => !seen.has(c.name) && seen.add(c.name));
}

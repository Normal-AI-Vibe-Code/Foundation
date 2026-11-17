import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentPill } from "../characters/AgentPill";
import {
  NoteMeta,
  moveNote,
  removeNote,
  resizeNote,
} from "../state/store";
import { renderMarkdown } from "../utils/markdown";
import { activeBoard, onBoardChange, type BoardSync, type NoteCaret } from "../sync/board";
import { getUi, toast } from "../state/ui";
import { openExternal } from "../utils/media";
import { ObjectFrame } from "./ObjectFrame";
import type { CaretSource, NoteEditorHandle } from "./noteEditor";
import { countRender } from "../state/renders";
import { RichNote } from "./RichText";

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
 * A markdown note, rendered at rest. Double-click to write in it: a
 * CodeMirror editor bound to the note's shared text, mounted only while it's
 * open (a board of 180 notes runs no editors). Every keystroke goes out as
 * it's typed, so two people can write in one note at once — even in one word
 * — and someone else's words land without moving your caret; you see where
 * they are writing (their caret and selection, named). ⌘Z takes back only
 * your own typing. Esc or clicking away goes back to the rendered note.
 */
export const NoteView = memo(function NoteView({ note, pos, isActive, getScale }: Props) {
  countRender("NoteView");
  const [editing, setEditing] = useState(false);
  const carets = useNoteCarets(note.id, note.text);
  useEffect(() => {
    if (getUi().role !== "viewer" && !note.rich) warmNoteEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const html = useMemo(() => (editing || note.rich ? "" : renderMarkdown(note.text)), [note.text, editing, note.rich]);

  const onBodyClick = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[data-ext]");
    if (a) {
      e.preventDefault();
      void openExternal((a as HTMLAnchorElement).href);
    }
  }, []);

  return (
    <ObjectFrame
      id={note.id}
      title={note.name}
      pos={pos}
      width={note.w}
      float={note.float}
      isActive={isActive}
      getScale={getScale}
      onMove={(x, y) => moveNote(note.id, x, y)}
      onResize={(dw, dh) => resizeNote(note.id, note.w + dw, note.h + dh)}
      onRemove={() => removeNote(note.id)}
      bodyClass={note.rich ? "note-body is-rich" : "note-body"}
    >
      <div style={{ ["--h" as string]: `${note.h}px` }} className="note-inner bar-reflow">
        {note.createdBy && !editing && (
          <AgentPill name={note.createdBy} tip={`Written by ${note.createdBy}, an agent`} />
        )}
        {!editing && carets.length > 0 && (
          <div className="note-writers" aria-label="Writing here now">
            {dedupe(carets).map((c) => (
              <span key={c.clientId} className="note-writer" style={{ ["--peer" as string]: c.color }}>
                {c.name}
              </span>
            ))}
          </div>
        )}
        {note.rich ? (
          // a text box: written as formatted text, in place (RichText.tsx)
          <RichNote note={note} />
        ) : editing ? (
          <NoteWriter noteId={note.id} text={note.text} onDone={() => setEditing(false)} />
        ) : (
          <div
            className="note-rendered"
            onPointerEnter={() => getUi().role !== "viewer" && void loadNoteEditor()}
            onDoubleClick={() => getUi().role !== "viewer" && setEditing(true)}
            onClick={onBodyClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </ObjectFrame>
  );
});

/**
 * The open editor: CodeMirror on the note's Y.Text. Until its code has loaded
 * (the first time, a few tens of ms) the note's text shows as it will in the
 * editor, so nothing jumps.
 */
function NoteWriter({ noteId, text, onDone }: { noteId: string; text: string; onDone(): void }) {
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
        toast("This note can't be written in until the board has loaded.", "warn");
        done.current();
        return;
      }
      handle = m.mountNoteEditor(host.current, {
        ytext,
        undoManager: board.noteUndoManager(noteId) ?? false,
        carets: boardCarets(board, noteId),
        onDone: () => done.current(),
        focus: true,
      });
      setReady(true);
    }, () => {
      if (gone) return;
      toast("The note editor couldn't load (offline?). Try again in a moment.", "warn");
      done.current();
    });
    return () => {
      gone = true;
      handle?.destroy();
    };
  }, [noteId]);
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

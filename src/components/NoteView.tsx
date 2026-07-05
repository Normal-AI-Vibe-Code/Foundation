import { memo, useCallback, useMemo, useState } from "react";
import {
  NoteMeta,
  moveNote,
  removeNote,
  resizeNote,
  updateNoteText,
} from "../state/store";
import { renderMarkdown } from "../utils/markdown";
import { openExternal } from "../utils/media";
import { ObjectFrame } from "./ObjectFrame";

interface Props {
  note: NoteMeta;
  pos: { x: number; y: number };
  getScale(): number;
}

export const NoteView = memo(function NoteView({ note, pos, getScale }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);

  const html = useMemo(() => renderMarkdown(note.text), [note.text]);

  const commit = useCallback(() => {
    updateNoteText(note.id, draft);
    setEditing(false);
  }, [note.id, draft]);

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
      getScale={getScale}
      onMove={(x, y) => moveNote(note.id, x, y)}
      onResize={(dw, dh) => resizeNote(note.id, note.w + dw, note.h + dh)}
      onRemove={() => removeNote(note.id)}
      bodyClass="note-body"
    >
      <div style={{ height: note.h }} className="note-inner">
        {editing ? (
          <textarea
            className="note-editor"
            value={draft}
            autoFocus
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                setDraft(note.text);
                setEditing(false);
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                commit();
              }
            }}
          />
        ) : (
          <div
            className="note-rendered"
            onDoubleClick={() => {
              setDraft(note.text);
              setEditing(true);
            }}
            onClick={onBodyClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </ObjectFrame>
  );
});

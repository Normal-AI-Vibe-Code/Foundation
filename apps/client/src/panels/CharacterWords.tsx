/**
 * "Who it is", on a character's card: the words every prompt of that character is built from, written as
 * formatted text on the card's own paper (2026-11-17, Josh: "the text box should be larger and easier to
 * edit, more WYSIWYG and part of the card").
 *
 * It is the grid's text box (components/RichText.tsx) without a note under it: the same editing surface
 * (the page's own, so bold is bold and a list is a list while writing), the same toolbar, and the same
 * `htmlToMarkdown` to keep what was written as markdown. Where a text box writes each keystroke into the
 * shared note, this keeps the draft on the card and saves it to the server (a character's state is the
 * server's) on leaving the field and on ⌘/Ctrl+Enter, and says so with a tick. The prompts get the plain
 * words (server: `plainWords`), never the marks.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { htmlToMarkdown, RichToolbar } from "../components/RichText";
import { renderMarkdown } from "../utils/markdown";

type Marks = Parameters<typeof RichToolbar>[0]["marks"];
const NO_MARKS: Marks = { bold: false, italic: false, underline: false, strike: false, ul: false, ol: false, quote: false, style: "p" };

function readMarks(): Marks {
  const q = (c: string) => {
    try {
      return document.queryCommandState(c);
    } catch {
      return false;
    }
  };
  let block = "";
  try {
    block = String(document.queryCommandValue("formatBlock")).toLowerCase();
  } catch { /* not editing */ }
  return { bold: q("bold"), italic: q("italic"), underline: q("underline"), strike: q("strikeThrough"), ul: q("insertUnorderedList"), ol: q("insertOrderedList"), quote: block === "blockquote", style: block === "h1" || block === "h2" || block === "h3" ? block : "p" };
}

/** markdown as the editing surface holds it: no line breaks between blocks, so its text is only its words */
const surface = (md: string) => renderMarkdown(md).replace(/>\n</g, "><");

export type SaveState = "clean" | "dirty" | "saving" | "saved";

export interface WordsProps {
  /** the words as kept (markdown) */
  value: string;
  readOnly?: boolean;
  placeholder?: string;
  label: string;
  /** keep them: resolves when the server has them */
  onSave: (markdown: string) => Promise<unknown>;
  onState?: (s: SaveState) => void;
}

export function CharacterWords({ value, readOnly = false, placeholder, label, onSave, onState }: WordsProps) {
  const el = useRef<HTMLDivElement>(null);
  /** the markdown the surface was last drawn from, or last saved as */
  const shown = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const range = useRef<Range | null>(null);
  const said = useRef<SaveState>("clean");
  const say = useCallback(
    (s: SaveState) => {
      if (said.current === s) return;
      said.current = s;
      onState?.(s);
    },
    [onState],
  );

  // draw the kept words, unless they're being written (a draft is never drawn over) or are what's already there
  useLayoutEffect(() => {
    const host = el.current;
    if (!host || shown.current === value) return;
    if (document.activeElement === host && said.current === "dirty") return;
    host.innerHTML = surface(value);
    shown.current = value;
  }, [value]);

  const draft = () => (el.current ? htmlToMarkdown(el.current) : (shown.current ?? ""));

  const save = useCallback(async () => {
    const md = draft().trim();
    if (md === (shown.current ?? "").trim()) return say(said.current === "saved" ? "saved" : "clean");
    say("saving");
    // the surface already holds these words: when they come back through the board (which can be before the
    // request's own answer) there is nothing to draw, and the caret stays where it is
    const was = shown.current;
    shown.current = md;
    try {
      await onSave(md);
      say("saved");
    } catch {
      shown.current = was;
      say("dirty");
    }
  }, [onSave, say]);

  useEffect(() => {
    if (!focused) return;
    const read = () => {
      const sel = window.getSelection();
      if (!sel?.rangeCount || !el.current?.contains(sel.anchorNode)) return;
      range.current = sel.getRangeAt(0).cloneRange();
      setMarks(readMarks());
    };
    read();
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [focused]);

  const restore = () => {
    const host = el.current;
    if (!host) return;
    host.focus({ preventScroll: true });
    const sel = window.getSelection();
    if (range.current && sel && host.contains(range.current.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(range.current);
    }
  };
  const touched = () => say(draft().trim() === (shown.current ?? "").trim() ? "clean" : "dirty");
  const command = (cmd: string, v?: string) => {
    if (!el.current) return;
    restore();
    if (cmd === "quote") document.execCommand("formatBlock", false, readMarks().quote ? "p" : "blockquote");
    else document.execCommand(cmd, false, v);
    touched();
    setMarks(readMarks());
  };

  return (
    <div className={`char-words-wrap${focused ? " is-writing" : ""}`}>
      <div
        ref={el}
        className="char-words note-rendered rich-text"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={label}
        aria-readonly={readOnly}
        data-placeholder={placeholder ?? ""}
        data-char-words
        spellCheck
        onFocus={() => {
          setFocused(true);
          try {
            document.execCommand("defaultParagraphSeparator", false, "p");
          } catch { /* an old engine: it makes <div>s, which read the same */ }
        }}
        onBlur={(e) => {
          // the toolbar is part of the field: pressing it isn't leaving
          if ((e.relatedTarget as HTMLElement | null)?.closest(".char-words-bar")) return;
          setFocused(false);
          void save();
        }}
        onInput={touched}
        // the board's one-key shortcuts and the grid's keys stand down while writing
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") (e.currentTarget as HTMLElement).blur();
        }}
        onKeyUp={(e) => e.stopPropagation()}
        onPaste={(e) => {
          // words only: what's pasted takes the field's own formatting
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
      />
      {focused && !readOnly && (
        <div
          className="char-words-bar"
          onBlur={(e) => {
            const to = e.relatedTarget as HTMLElement | null;
            if (to && (to === el.current || to.closest(".char-words-bar"))) return;
            if (!to && e.currentTarget.contains(document.activeElement)) return;
            setFocused(false);
            void save();
          }}
        >
          <RichToolbar
            marks={marks}
            onCommand={command}
            onStyle={(s) => command("formatBlock", s)}
            onLink={(url) => {
              restore();
              document.execCommand("createLink", false, url);
              touched();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A text box: a note written as formatted text. What you see is what's kept:
 * bold is bold, a heading is a heading, and a toolbar along the card's foot
 * does what a word processor's does (style, bold, italic, underline, strike,
 * lists, quote, link, clear). No markup on screen.
 *
 * Under it, it is still a note: the same markdown in the same shared text
 * (`NoteDoc.rich`), so search, agents, Rune and "send to another board" read
 * a text box as they read any note, and an agent's `add_note` can be opened
 * and edited as one. The page's own editing (contenteditable) holds the
 * formatted text; after each change it is written back as markdown
 * (`htmlToMarkdown`), and the board's sync turns that into the smallest edit,
 * so someone else's words in another paragraph survive yours.
 *
 * Click in it to write (no double-click: it is a text box). Esc, or a click
 * anywhere else, puts the toolbar away. A viewer reads it; links open.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { takeFreshTextBox, updateNoteText, type NoteMeta } from "../state/store";
import { getUi } from "../state/ui";
import { renderMarkdown } from "../utils/markdown";
import { openExternal } from "../utils/media";

// ---------- formatted text → markdown ----------

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "HR", "TABLE"]);

/** wrap what's inside a mark, keeping the spaces at its ends outside it (`** x**` isn't bold) */
function mark(inner: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m || !m[2]) return inner;
  // one mark per line: a mark can't span a line break in the note's markdown
  return m[1] + m[2].split("\n").map((l) => (l.trim() ? open + l + close : l)).join("\n") + m[3];
}

function inlineOf(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? "").replace(/ /g, " ").replace(/​/g, "").replace(/\s*\n\s*/g, " ");
  if (!(n instanceof HTMLElement)) return "";
  const tag = n.tagName;
  if (tag === "BR") return "\n";
  const inner = [...n.childNodes].map(inlineOf).join("");
  const st = n.style;
  if (tag === "STRONG" || tag === "B" || Number(st.fontWeight) >= 600 || st.fontWeight === "bold") return mark(inner, "**");
  if (tag === "EM" || tag === "I" || st.fontStyle === "italic") return mark(inner, "_");
  if (tag === "U" || st.textDecorationLine === "underline") return mark(inner, "<u>", "</u>");
  if (tag === "S" || tag === "STRIKE" || tag === "DEL" || st.textDecorationLine === "line-through") return mark(inner, "~~");
  if (tag === "CODE") return inner.trim() ? `\`${inner}\`` : inner;
  if (tag === "A") {
    const href = n.getAttribute("href") ?? "";
    return /^https?:\/\//.test(href) && inner.trim() ? `[${inner.trim()}](${href})` : inner;
  }
  return inner;
}

/** the lines of a block's own text (a <br> inside it starts a new line) */
const linesOf = (n: Node) => inlineOf(n).split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * What a text box holds, as the note's markdown. Reads the editing surface's
 * own tree: headings, paragraphs, lists (flat, as the note renders them),
 * quotes, code blocks, rules, tables and the marks inside them.
 */
export function htmlToMarkdown(root: HTMLElement): string {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (!run.length) return;
    const wrap = document.createElement("span");
    for (const n of run) wrap.appendChild(n.cloneNode(true));
    out.push(...linesOf(wrap));
    run = [];
  };
  const block = (el: HTMLElement) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const lvl = Math.min(4, Number(tag[1]));
      for (const l of linesOf(el)) out.push(`${"#".repeat(lvl)} ${l}`);
    } else if (tag === "UL" || tag === "OL") {
      let i = 0;
      const items = (list: HTMLElement) => {
        for (const li of list.children) {
          if (!(li instanceof HTMLElement)) continue;
          if (li.tagName === "UL" || li.tagName === "OL") {
            items(li);
            continue;
          }
          // a list inside an item: its items follow, flat
          const own = li.cloneNode(true) as HTMLElement;
          own.querySelectorAll("ul, ol").forEach((x) => x.remove());
          const text = linesOf(own).join(" ");
          if (text) out.push(tag === "OL" ? `${++i}. ${text}` : `- ${text}`);
          li.querySelectorAll(":scope > ul, :scope > ol").forEach((x) => items(x as HTMLElement));
        }
      };
      const lines = out.length;
      items(el);
      // a list is one block: its items on consecutive lines
      const made = out.splice(lines);
      if (made.length) out.push(made.join("\n"));
    } else if (tag === "BLOCKQUOTE") {
      const lines = linesOf(el);
      if (lines.length) out.push(lines.map((l) => `> ${l}`).join("\n"));
    } else if (tag === "PRE") {
      out.push("```\n" + (el.textContent ?? "").replace(/\n+$/, "") + "\n```");
    } else if (tag === "HR") {
      out.push("---");
    } else if (tag === "TABLE") {
      const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => linesOf(c).join(" ").replace(/\|/g, "/")));
      if (rows.length) {
        const row = (r: string[]) => `| ${r.join(" | ")} |`;
        out.push([row(rows[0]), row(rows[0].map(() => "---")), ...rows.slice(1).map(row)].join("\n"));
      }
    } else if ([...el.children].some((c) => BLOCKS.has(c.tagName))) {
      // a wrapper around blocks (a pasted <div>, the table's scroller): its children, in order
      walk(el);
    } else {
      out.push(...linesOf(el));
    }
  };
  const walk = (parent: HTMLElement) => {
    for (const n of parent.childNodes) {
      if (n instanceof HTMLElement && BLOCKS.has(n.tagName)) {
        flush();
        block(n);
      } else run.push(n);
    }
    flush();
  };
  walk(root);
  return out.join("\n\n");
}

// ---------- the caret, across a re-render ----------

/** how many characters of text come before the caret */
function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(sel.focusNode!, sel.focusOffset);
  return r.toString().length;
}

function placeCaret(root: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = offset;
  let last: Text | null = null;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    last = t;
    if (left <= t.length) {
      window.getSelection()?.collapse(t, left);
      return;
    }
    left -= t.length;
  }
  if (last) window.getSelection()?.collapse(last, last.length);
  else window.getSelection()?.collapse(root, 0);
}

/**
 * Where a caret goes when the text around it changed under it: characters
 * written before it push it along, characters written after it leave it be
 * (the change is what lies between the longest shared start and end).
 */
export function mapCaret(at: number, before: string, after: string): number {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  if (at <= p) return at;
  if (at >= before.length - s) return at + (after.length - before.length);
  return Math.min(after.length - s, Math.max(p, at));
}

/** the note's markdown as the editing surface holds it: no line breaks between blocks, so its text is only its words */
const surfaceHtml = (md: string) => renderMarkdown(md).replace(/>\n</g, "><");

// ---------- the toolbar ----------

type Style = "p" | "h1" | "h2" | "h3";
interface Marks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  ul: boolean;
  ol: boolean;
  quote: boolean;
  style: Style;
}
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
  return {
    bold: q("bold"),
    italic: q("italic"),
    underline: q("underline"),
    strike: q("strikeThrough"),
    ul: q("insertUnorderedList"),
    ol: q("insertOrderedList"),
    quote: block === "blockquote",
    style: block === "h1" || block === "h2" || block === "h3" ? block : "p",
  };
}

const STYLES: Array<{ id: Style; label: string }> = [
  { id: "p", label: "Body" },
  { id: "h1", label: "Title" },
  { id: "h2", label: "Heading" },
  { id: "h3", label: "Subheading" },
];

/** the toolbar alone, for the text box and the design page */
export function RichToolbar({ marks, onCommand, onStyle, onLink }: { marks: Marks; onCommand?: (cmd: string, value?: string) => void; onStyle?: (s: Style) => void; onLink?: (url: string) => void }) {
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("https://");
  const btn = (cmd: string, glyph: React.ReactNode, tip: string, on: boolean, kbd?: string, cls = "") => (
    <button
      type="button"
      className={`rich-btn${on ? " is-on" : ""} ${cls}`}
      aria-pressed={on}
      aria-label={tip}
      data-tip={tip}
      data-kbd={kbd}
      // the selection stays in the text while a button is pressed
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onCommand?.(cmd)}
    >
      {glyph}
    </button>
  );
  return (
    <div className="rich-bar" role="toolbar" aria-label="Text formatting" onPointerDown={(e) => e.stopPropagation()}>
      {linking ? (
        <form
          className="rich-link"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^https?:\/\/\S+\.\S+/.test(url.trim())) onLink?.(url.trim());
            setLinking(false);
          }}
        >
          <input
            className="rich-link-field"
            autoFocus
            value={url}
            spellCheck={false}
            aria-label="Link address"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setLinking(false);
            }}
          />
          <button type="submit" className="rich-btn is-word">
            Link
          </button>
          <button type="button" className="rich-btn is-word" onClick={() => setLinking(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <select
            className="rich-style"
            value={marks.style}
            aria-label="Text style"
            data-tip="Text style"
            onChange={(e) => onStyle?.(e.target.value as Style)}
          >
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="rich-sep" />
          {btn("bold", <b>B</b>, "Bold", marks.bold, "mod+B")}
          {btn("italic", <i>I</i>, "Italic", marks.italic, "mod+I")}
          {btn("underline", <u>U</u>, "Underline", marks.underline, "mod+U")}
          {btn("strikeThrough", <s>S</s>, "Strikethrough", marks.strike)}
          <span className="rich-sep" />
          {btn("insertUnorderedList", <ListGlyph />, "Bulleted list", marks.ul)}
          {btn("insertOrderedList", <ListGlyph numbered />, "Numbered list", marks.ol)}
          {btn("quote", <QuoteGlyph />, "Quote", marks.quote)}
          <span className="rich-sep" />
          <button type="button" className="rich-btn" aria-label="Link" data-tip="Link the selected words" onMouseDown={(e) => e.preventDefault()} onClick={() => setLinking(true)}>
            <LinkGlyph />
          </button>
          {btn("removeFormat", <ClearGlyph />, "Clear formatting", false)}
        </>
      )}
    </div>
  );
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;
function ListGlyph({ numbered = false }: { numbered?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...stroke}>
      <path d="M5.5 3.5h6M5.5 7h6M5.5 10.5h6" />
      {numbered ? <path d="M2 2.6l.9-.5v2.8M1.9 8.6c0-.9 1.5-.9 1.5 0 0 .6-1.5 1.3-1.5 2h1.6" strokeWidth="1" /> : <path d="M2.4 3.5h.01M2.4 7h.01M2.4 10.5h.01" strokeWidth="2" />}
    </svg>
  );
}
function QuoteGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...stroke}>
      <path d="M2.5 2.5v9M5.5 4h6M5.5 7h6M5.5 10h4" />
    </svg>
  );
}
function LinkGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...stroke}>
      <path d="M6 8a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 8 2.5l-.8.8M8 6a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 6 11.5l.8-.8" />
    </svg>
  );
}
function ClearGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...stroke}>
      <path d="M3 3h7M6.5 3l-1.5 8M9 8.5l3 3M12 8.5l-3 3" />
    </svg>
  );
}

// ---------- the text box ----------

export function RichNote({ note }: { note: NoteMeta }) {
  const el = useRef<HTMLDivElement>(null);
  /** the markdown the surface shows: what we last wrote, or last drew */
  const shown = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const canWrite = getUi().role !== "viewer";
  /** where the caret was in the text, for a toolbar control that takes the focus (the style picker, the link field) */
  const range = useRef<Range | null>(null);
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

  // draw the note's text, unless it's what the surface already holds (our own typing coming back)
  useLayoutEffect(() => {
    const host = el.current;
    if (!host || shown.current === note.text) return;
    const at = document.activeElement === host ? caretOffset(host) : null;
    const before = host.textContent ?? "";
    host.innerHTML = surfaceHtml(note.text);
    shown.current = note.text;
    // someone else wrote while the caret was here: it stays with the words it was among
    if (at !== null) placeCaret(host, mapCaret(at, before, host.textContent ?? ""));
  }, [note.text]);

  // a text box you just made is ready to type in (it arrives on everyone else's board without taking their caret)
  useEffect(() => {
    if (takeFreshTextBox(note.id) && canWrite) el.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(() => {
    const host = el.current;
    if (!host) return;
    const md = htmlToMarkdown(host);
    if (md === shown.current) return;
    shown.current = md;
    updateNoteText(note.id, md);
  }, [note.id]);

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

  const command = useCallback(
    (cmd: string, value?: string) => {
      if (!el.current) return;
      restore();
      if (cmd === "quote") document.execCommand("formatBlock", false, readMarks().quote ? "p" : "blockquote");
      else document.execCommand(cmd, false, value);
      commit();
      setMarks(readMarks());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commit],
  );

  return (
    <>
      <div
        ref={el}
        className={`note-rendered rich-text${focused ? " is-writing" : ""}`}
        contentEditable={canWrite}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={note.name}
        data-placeholder={canWrite ? "Type here" : ""}
        data-rich-note={note.id}
        spellCheck
        onFocus={() => {
          setFocused(true);
          try {
            document.execCommand("defaultParagraphSeparator", false, "p");
          } catch { /* an old engine: it makes <div>s, which read the same */ }
        }}
        onBlur={(e) => {
          // the toolbar is part of the box: pressing it isn't leaving
          if ((e.relatedTarget as HTMLElement | null)?.closest(".rich-bar")) return;
          commit();
          setFocused(false);
        }}
        onInput={commit}
        // the board's one-key shortcuts and the grid's keys stand down while writing
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") (e.currentTarget as HTMLElement).blur();
        }}
        onKeyUp={(e) => e.stopPropagation()}
        onPaste={(e) => {
          // words only: what's pasted takes the box's own formatting
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
          // a link opens for a reader, and with ⌘/Ctrl for a writer (a plain click places the caret)
          if (a && (!canWrite || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void openExternal(a.href);
          }
        }}
      />
      {focused && canWrite && (
        <div
          className="rich-bar-slot"
          onBlur={(e) => {
            // leaving the toolbar for anywhere but the text puts it away
            const to = e.relatedTarget as HTMLElement | null;
            if (to && (to === el.current || to.closest(".rich-bar"))) return;
            if (!to && e.currentTarget.contains(document.activeElement)) return;
            setFocused(false);
          }}
        >
          <RichToolbar
            marks={marks}
            onCommand={command}
            onStyle={(s) => command("formatBlock", s)}
            onLink={(url) => {
              restore();
              document.execCommand("createLink", false, url);
              commit();
            }}
          />
        </div>
      )}
    </>
  );
}

/**
 * A note, as it is written: formatted text. What you see is what's kept: bold
 * is bold, a heading is a heading, and a toolbar along the card's foot does
 * what a word processor's does (style, text size, bold, italic, underline,
 * strike, lists, quote, link, clear). No markup on screen.
 *
 * Under it is the note's markdown in the note's shared text, so search,
 * agents, Rune and "send to another board" read what was written, an agent's
 * `add_note` is edited the same way, and the card's Markdown button shows
 * that markdown itself (NoteView.tsx). The page's own editing
 * (contenteditable) holds the formatted text; after each change it is written
 * back as markdown (`htmlToMarkdown`), and the board's sync turns that into
 * the smallest edit, so someone else's words in another paragraph survive
 * yours. A note that is only looked at, or clicked in and left, is never
 * rewritten: markdown an agent or a person wrote by hand stays as they wrote
 * it until someone changes the words.
 *
 * Click in it to write (no double-click). Esc, or a click anywhere else, puts
 * the toolbar away. A viewer reads it; links open.
 *
 * The toolbar sits just outside the card's foot, under it, and rises a few px
 * into place (2026-11-25, Josh: "should actually animate up, not moving the
 * text down, keep it steady"): it is drawn into the card itself, outside the
 * clipped body, so the words keep their padding and their scroll while it
 * shows and every line stays in view.
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { NOTE_SIZES, type NoteSize } from "@foundation/protocol";
import { setNoteSize, takeFreshNote, updateNoteText, type NoteMeta } from "../state/store";
import { getUi, toast } from "../state/ui";
import { openContextMenu, type MenuItem } from "./ContextMenu";
import { cardMenuItems } from "./cardMenu";
import { IS_MAC, keys } from "../lib/keys";
import { renderNote } from "../notes/blocks";
import { NoteBlocks } from "../notes/BlockUi";
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
  // what renderMarkdown adds around the words (utils/markdown.ts) goes back as the markdown it came from:
  // a link's host is shown beside it, not written; a picture (loaded, or waiting for a press) is its ![alt](address)
  if (n.dataset.md === "host") return "";
  if (n.dataset.md === "remote-img") return `![${n.dataset.alt ?? ""}](${n.dataset.src ?? ""})`;
  if (tag === "IMG" && n.classList.contains("md-img")) return `![${n.getAttribute("alt") ?? ""}](${n.getAttribute("src") ?? ""})`;
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
    // the blocks a note page writes (notes/blocks.ts says what each is kept as)
    if (el.classList.contains("md-page") && el.dataset.note) {
      const title = (el.querySelector(".md-page-title")?.textContent ?? "").replace(/[[\]\n]/g, "").trim();
      out.push(`[${title}](note:${el.dataset.note})`);
      return;
    }
    if (el.classList.contains("md-embed") && el.dataset.url) {
      out.push(el.dataset.url);
      return;
    }
    if (el.classList.contains("md-callout")) {
      const kind = (el.dataset.kind ?? "note").toUpperCase();
      const lines = [...el.children].flatMap((c) => linesOf(c));
      out.push([`> [!${kind}]${lines[0] ? ` ${lines[0]}` : ""}`, ...lines.slice(1).map((l) => `> ${l}`)].join("\n"));
      return;
    }
    if (el.classList.contains("md-toggle")) {
      const head = el.querySelector(":scope > .md-toggle-head");
      const body = el.querySelector(":scope > .md-toggle-body") as HTMLElement | null;
      const inner = body ? htmlToMarkdown(body) : "";
      out.push(`<details${el.dataset.open === "true" ? " open" : ""}>\n<summary>${head ? linesOf(head).join(" ") : ""}</summary>${inner ? `\n\n${inner}\n` : ""}\n</details>`);
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      const lvl = Math.min(4, Number(tag[1]));
      for (const l of linesOf(el)) out.push(`${"#".repeat(lvl)} ${l}`);
    } else if (tag === "UL" || tag === "OL") {
      let i = 0;
      const items = (list: HTMLElement, depth: number) => {
        const todos = list.classList.contains("md-todos");
        for (const li of list.children) {
          if (!(li instanceof HTMLElement)) continue;
          if (li.tagName === "UL" || li.tagName === "OL") {
            items(li, depth + 1);
            continue;
          }
          // a list inside an item: its items follow, a level in
          const own = li.cloneNode(true) as HTMLElement;
          own.querySelectorAll("ul, ol").forEach((x) => x.remove());
          const text = linesOf(own).join(" ");
          const lead = "  ".repeat(Math.min(4, depth + Number(li.dataset.indent ?? 0)));
          const todo = todos || li.classList.contains("md-todo");
          // an empty to-do is still a to-do (the box is there to be filled in)
          if (todo) out.push(`${lead}- [${li.dataset.checked === "true" ? "x" : " "}] ${text}`.trimEnd());
          else if (text) out.push(`${lead}${tag === "OL" ? `${++i}.` : "-"} ${text}`);
          li.querySelectorAll(":scope > ul, :scope > ol").forEach((x) => items(x as HTMLElement, depth + 1));
        }
      };
      const lines = out.length;
      items(el, 0);
      // a list is one block: its items on consecutive lines
      const made = out.splice(lines);
      if (made.length) out.push(made.join("\n"));
    } else if (tag === "BLOCKQUOTE") {
      const lines = linesOf(el);
      if (lines.length) out.push(lines.map((l) => `> ${l}`).join("\n"));
    } else if (tag === "PRE") {
      out.push("```" + (el.dataset.lang ?? "") + "\n" + (el.textContent ?? "").replace(/\n+$/, "") + "\n```");
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
const surfaceHtml = (md: string) => renderNote(md).replace(/>\n</g, "><");

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

/** what each text size is called */
export const SIZE_NAMES: Record<NoteSize, string> = { s: "Small", m: "Normal", l: "Large", xl: "Extra large", xxl: "Huge" };

/**
 * The toolbar alone, for the note, a character's words and the design page.
 * With `size` it carries the text size: the whole note's, a step smaller or
 * larger (markdown has no sizes of its own, so it is the card's, not a word's).
 */
export function RichToolbar({ marks, size, onCommand, onStyle, onLink, onSize, linkAsk = 0 }: { marks: Marks; size?: NoteSize; onCommand?: (cmd: string, value?: string) => void; onStyle?: (s: Style) => void; onLink?: (url: string) => void; onSize?: (s: NoteSize) => void; /** bumped to open the link field (the right-click menu's Link…) */ linkAsk?: number }) {
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("https://");
  useEffect(() => {
    if (linkAsk) setLinking(true);
  }, [linkAsk]);
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
  const step = NOTE_SIZES.indexOf(size ?? "m");
  const sizeBtn = (by: -1 | 1) => {
    const to = NOTE_SIZES[step + by] as NoteSize | undefined;
    const tip = by < 0 ? "Smaller text" : "Larger text";
    return (
      <button
        type="button"
        className={`rich-btn rich-size ${by < 0 ? "is-down" : "is-up"}`}
        disabled={!to}
        aria-label={tip}
        data-tip={to ? `${tip}: ${SIZE_NAMES[to].toLowerCase()}` : `${tip}: this is the ${by < 0 ? "smallest" : "largest"}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => to && onSize?.(to)}
      >
        <span aria-hidden>A</span>
      </button>
    );
  };
  const items: Array<{ key: string; sep?: true; node: React.ReactNode }> = [
    {
      key: "style",
      node: (
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
      ),
    },
    ...(size
      ? [
          {
            key: "size",
            node: (
              <span className="rich-sizes" role="group" aria-label={`Text size: ${SIZE_NAMES[size].toLowerCase()}`} data-size={size}>
                {sizeBtn(-1)}
                {sizeBtn(1)}
              </span>
            ),
          },
        ]
      : []),
    { key: "sep1", sep: true, node: <span className="rich-sep" /> },
    { key: "bold", node: btn("bold", <b>B</b>, "Bold", marks.bold, "mod+B") },
    { key: "italic", node: btn("italic", <i>I</i>, "Italic", marks.italic, "mod+I") },
    { key: "underline", node: btn("underline", <u>U</u>, "Underline", marks.underline, "mod+U") },
    { key: "strike", node: btn("strikeThrough", <s>S</s>, "Strikethrough", marks.strike) },
    { key: "sep2", sep: true, node: <span className="rich-sep" /> },
    { key: "ul", node: btn("insertUnorderedList", <ListGlyph />, "Bulleted list", marks.ul) },
    { key: "ol", node: btn("insertOrderedList", <ListGlyph numbered />, "Numbered list", marks.ol) },
    { key: "quote", node: btn("quote", <QuoteGlyph />, "Quote", marks.quote) },
    { key: "sep3", sep: true, node: <span className="rich-sep" /> },
    {
      key: "link",
      node: (
        <button type="button" className="rich-btn" aria-label="Link" data-tip="Link the selected words" onMouseDown={(e) => e.preventDefault()} onClick={() => setLinking(true)}>
          <LinkGlyph />
        </button>
      ),
    },
    { key: "clear", node: btn("removeFormat", <ClearGlyph />, "Clear formatting", false) },
  ];
  const { barRef, fit, more, setMore, moreUp } = useToolbarFit(items.map((i) => i.key), linking);
  // one line: what doesn't fit goes under "More", last first; a line never ends on a divider
  let shown = items.slice(0, fit);
  while (shown.length && shown[shown.length - 1].sep) shown = shown.slice(0, -1);
  const rest = items.slice(fit).filter((i) => !i.sep);
  return (
    <div ref={barRef} className="rich-bar" role="toolbar" aria-label="Text formatting" onPointerDown={(e) => e.stopPropagation()}>
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
          {shown.map((i) => (
            <Fragment key={i.key}>{i.node}</Fragment>
          ))}
          {rest.length > 0 && (
            <>
              <button
                type="button"
                className={"rich-btn rich-more" + (more ? " is-on" : "")}
                data-rich-more
                aria-label="More formatting"
                aria-haspopup="true"
                aria-expanded={more}
                data-tip="More formatting"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setMore((m) => !m)}
              >
                <MoreGlyph />
              </button>
              {more && (
                <div className={"rich-more-menu" + (moreUp ? " is-up" : "")} role="group" aria-label="More formatting">
                  {rest.map((i) => (
                    <Fragment key={i.key}>{i.node}</Fragment>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Keeps the toolbar to one line (2026-11-26, Josh: "the format bar itself should collapse into a drop down of
 * more options, it should try to keep within one line"). Each item's width is measured as it's drawn (offsetWidth:
 * the grid's zoom doesn't change it), and the line holds as many as fit its holder; the rest wait under "More".
 */
function useToolbarFit(keys: string[], paused: boolean) {
  const barRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [fit, setFit] = useState(keys.length);
  const [more, setMore] = useState(false);
  const [moreUp, setMoreUp] = useState(false);
  const sig = keys.join(",");
  const fitRef = useRef(fit);
  fitRef.current = fit;

  const measure = useCallback(() => {
    const bar = barRef.current;
    const holder = bar?.parentElement;
    if (!bar || !holder || paused) return;
    const ks = sig.split(",");
    // what's on the line now, in order (the More button, its menu, last)
    const kids = Array.from(bar.children) as HTMLElement[];
    // the line is always the first items, in order
    kids.forEach((el, i) => {
      if (i < ks.length && !el.matches("[data-rich-more], .rich-more-menu")) widths.current.set(ks[i], el.offsetWidth);
    });
    const bs = getComputedStyle(bar);
    const hs = getComputedStyle(holder);
    const gap = parseFloat(bs.columnGap) || 0;
    const chrome = parseFloat(bs.paddingLeft) + parseFloat(bs.paddingRight) + parseFloat(bs.borderLeftWidth) + parseFloat(bs.borderRightWidth);
    const room = holder.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight) - chrome;
    const w = (key: string) => widths.current.get(key) ?? (key.startsWith("sep") ? 7 : 32);
    const all = ks.reduce((s, key) => s + w(key), 0) + gap * (ks.length - 1);
    let n = ks.length;
    if (all > room) {
      const moreW = (bar.querySelector<HTMLElement>("[data-rich-more]")?.offsetWidth ?? 32) + gap;
      let used = 0;
      n = 0;
      while (n < ks.length) {
        const next = used + (n ? gap : 0) + w(ks[n]);
        if (next > room - moreW) break;
        used = next;
        n++;
      }
      n = Math.max(1, n);
    }
    if (n !== fitRef.current) setFit(n);
  }, [sig, paused]);

  useLayoutEffect(measure);
  useEffect(() => {
    const holder = barRef.current?.parentElement;
    if (!holder || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(holder);
    return () => ro.disconnect();
  }, [measure]);

  // everything fits again: nothing to show under More
  useEffect(() => {
    if (fit >= keys.length) setMore(false);
  }, [fit, keys.length]);

  // the menu opens down, unless the bar is near the window's foot (a note full screen); a press elsewhere, or Esc, closes it
  useLayoutEffect(() => {
    if (!more) return;
    const r = barRef.current?.getBoundingClientRect();
    setMoreUp(!!r && window.innerHeight - r.bottom < 120);
    const away = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setMore(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMore(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [more]);

  return { barRef, fit, more, setMore, moreUp };
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
function MoreGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...stroke}>
      <path d="M2.6 5.6h.01M7 5.6h.01M11.4 5.6h.01" strokeWidth="2.2" />
      <path d="M5 9.6l2 1.6 2-1.6" />
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

// ---------- the note's formatted text ----------

export function RichNote({ note, words, page }: { note: NoteMeta; /** a card showing a note page (docs/notes.md): its words are the page's, written to the page's board */ words?: { text: string; write(md: string): void; readOnly: boolean }; /** this is a note page's body (a page block made in it goes inside it) */ page?: string | null }) {
  const text = words ? words.text : note.text;
  const el = useRef<HTMLDivElement>(null);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  /** the surface, once drawn, for the blocks beside it (notes/BlockUi.tsx) */
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  /** the markdown the surface shows: what we last wrote, or last drew */
  const shown = useRef<string | null>(null);
  /**
   * What the surface reads back as, as it was drawn (taken when the caret arrives), and whether anything has
   * been written since. Markdown written by hand rarely reads back letter for letter (`*x*` comes back `_x_`,
   * a nested list flat), so until the words themselves change, nothing is written.
   */
  const drawn = useRef<string | null>(null);
  const wrote = useRef(false);
  const [focused, setFocused] = useState(false);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const [linkAsk, setLinkAsk] = useState(0);
  const canWrite = getUi().role !== "viewer" && !words?.readOnly;
  /** the card the toolbar is drawn into, under its foot (outside the body, which clips); none: in place, as before */
  const [card, setCard] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setCard(el.current?.closest<HTMLElement>(".frame-card") ?? null), []);
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
    if (!host || shown.current === text) return;
    const at = document.activeElement === host ? caretOffset(host) : null;
    const before = host.textContent ?? "";
    host.innerHTML = surfaceHtml(text);
    shown.current = text;
    wrote.current = false;
    drawn.current = at !== null ? htmlToMarkdown(host) : null;
    // someone else wrote while the caret was here: it stays with the words it was among
    if (at !== null) placeCaret(host, mapCaret(at, before, host.textContent ?? ""));
  }, [text]);

  // a note you just made is ready to type in (it arrives on everyone else's board without taking their caret)
  useEffect(() => {
    if (takeFreshNote(note.id) && canWrite) el.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(() => {
    const host = el.current;
    if (!host) return;
    const md = htmlToMarkdown(host);
    if (md === shown.current) return;
    // still what was drawn: the caret came and went, or a mark was put on and taken off again
    if (!wrote.current && md === drawn.current) return;
    wrote.current = true;
    shown.current = md;
    if (wordsRef.current) wordsRef.current.write(md);
    else updateNoteText(note.id, md);
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

  /**
   * Right-click in the words (2026-11-26, Josh: "you should be able to right click format selections, in addition
   * to other things to the note"): the selection's formatting first, then the clipboard, the text's size, and the
   * note's own card menu (frame it, full screen, float, copy a link, remove). A reader gets the card's menu only.
   */
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    // the selection in these words, or none (never one left over from before)
    range.current = sel?.rangeCount && el.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const card = cardMenuItems(note.id) ?? [];
    if (!canWrite) return openContextMenu(e.clientX, e.clientY, card);
    const m = readMarks();
    const picked = !!range.current && !range.current.collapsed;
    const tick = (on: boolean) => (on ? "✓" : "");
    const mod = (k: string) => `  ${keys(`mod+${k}`)}`;
    const fmt = (label: string, cmd: string, on: boolean, kbd = ""): MenuItem => ({ icon: tick(on), label: label + kbd, action: () => command(cmd) });
    const step = NOTE_SIZES.indexOf(note.size ?? "m");
    const smaller = NOTE_SIZES[step - 1] as NoteSize | undefined;
    const larger = NOTE_SIZES[step + 1] as NoteSize | undefined;
    const items: MenuItem[] = [
      { heading: picked ? "Format the selection" : "Format" },
      fmt("Bold", "bold", m.bold, mod("B")),
      fmt("Italic", "italic", m.italic, mod("I")),
      fmt("Underline", "underline", m.underline, mod("U")),
      fmt("Strikethrough", "strikeThrough", m.strike),
      { divider: true },
      ...STYLES.map((st): MenuItem => ({ icon: tick(m.style === st.id), label: st.label, action: () => command("formatBlock", st.id) })),
      fmt("Bulleted list", "insertUnorderedList", m.ul),
      fmt("Numbered list", "insertOrderedList", m.ol),
      fmt("Quote", "quote", m.quote),
      { divider: true },
      {
        icon: "⌁",
        label: "Link…",
        disabled: !picked,
        action: () => {
          restore();
          setFocused(true);
          setLinkAsk((n) => n + 1);
        },
      },
      { icon: "⌫", label: "Clear formatting", disabled: !picked, action: () => command("removeFormat") },
      { divider: true },
      { label: `Cut${mod("X")}`, disabled: !picked, action: () => (restore(), document.execCommand("cut"), commit()) },
      { label: `Copy${mod("C")}`, disabled: !picked, action: () => (restore(), document.execCommand("copy")) },
      {
        label: `Paste${mod("V")}`,
        action: () =>
          void navigator.clipboard.readText().then(
            (t) => {
              restore();
              document.execCommand("insertText", false, t);
              commit();
            },
            () => toastPaste(),
          ),
      },
      { divider: true },
      { icon: "A", label: "Smaller text", disabled: !smaller, action: () => smaller && setNoteSize(note.id, smaller) },
      { icon: "A", label: "Larger text", disabled: !larger, action: () => larger && setNoteSize(note.id, larger) },
    ];
    // the note itself: its card's menu, under its name
    openContextMenu(e.clientX, e.clientY, card.length ? [...items, { divider: true }, ...card] : items);
  };

  return (
    <>
      <div
        ref={(n) => {
          el.current = n;
          if (n !== surface) setSurface(n);
        }}
        className={`note-rendered rich-text${focused ? " is-writing" : ""}`}
        onContextMenu={onContextMenu}
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
          if (!wrote.current && el.current) drawn.current = htmlToMarkdown(el.current);
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
      <NoteBlocks surface={surface} canWrite={canWrite} commit={commit} page={page} />
      {portalTo(
        card,
        <AnimatePresence>
          {focused && canWrite && (
            <motion.div
              key="bar"
              className={`rich-bar-slot${card ? " is-under" : ""}`}
              // the box grows down to hold it: it unfolds from the card's foot, and folds back the same way (DESIGN §6:
              // --dur-pane in, --dur-quick out, ease-out-soft). Full screen it floats inside instead (App.css).
              initial={card ? { opacity: 0, clipPath: "inset(0px -6px 100% -6px)" } : { opacity: 0, y: 6 }}
              // once unfolded, the clip opens below so the More menu can hang under the bar
              animate={card ? { opacity: 1, clipPath: "inset(0px -6px -6px -6px)", transitionEnd: { clipPath: "inset(0px -6px -400px -6px)" }, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } } : { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } }}
              exit={card ? { opacity: 0, clipPath: "inset(0px -6px 100% -6px)", transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } } : { opacity: 0, y: 6, transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
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
                size={note.size ?? "m"}
                onSize={(s) => setNoteSize(note.id, s)}
                linkAsk={linkAsk}
                onCommand={command}
                onStyle={(s) => command("formatBlock", s)}
                onLink={(url) => {
                  restore();
                  document.execCommand("createLink", false, url);
                  commit();
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>,
      )}
    </>
  );
}

/** the browser keeps the clipboard from a page that wasn't given it: the keys still paste */
function toastPaste() {
  toast(`The browser keeps the clipboard from menus here: press ${IS_MAC ? "⌘" : "Ctrl+"}V to paste.`, "warn");
}

const portalTo = (to: HTMLElement | null, node: React.ReactNode) => (to ? createPortal(node, to) : node);

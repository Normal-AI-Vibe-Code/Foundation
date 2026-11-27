/**
 * A note's blocks, worked by hand (docs/notes.md §3). Drawn beside the note's editing surface (RichNote) and
 * wired to it, so every note has them: a grid's own note, a card showing a note page, and the page itself.
 *
 * - **A slash** opens the block menu at the caret, filtered as you type (`/h2`, `/todo`, `/tog`); Enter, Tab or a
 *   click turns the block the caret is in into that one; Esc, or the caret leaving, puts it away.
 * - **Markdown at a block's start**: `# `, `## `, `### `, `- `, `1. `, `[] `, `> `, `>> ` (toggle), `! ` (callout),
 *   ```` ``` ```` and `---` followed by a space.
 * - **Tab / Shift+Tab** take a list item a level in or out. **Enter** in a toggle's head goes into it; on an
 *   empty last line of a callout or a toggle it leaves the box. **Backspace** at a heading's, quote's, callout's
 *   or toggle's start makes it text again.
 * - **The handle** (⋮⋮) sits beside the block under the pointer: drag it to move the block, press it for the
 *   block's menu (turn into, duplicate, move, delete).
 * - A press on a to-do's box ticks it; on a toggle's arrow folds it (kept in the note, `<details open>`); on a
 *   page opens it; on a link card opens its address in a new tab.
 *
 * A reader (a viewer, or a note page they may only read) gets the presses that read: open a page or a link,
 * fold a toggle on their own screen.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NOTE_BLOCKS, noteRecent, rankBlocks, readRecents, shortcutOf, type BlockCommand, type BlockKind } from "./blocks";
import { blockOf, caretBlock, caretIn, caretLine, caretToEnd, caretToStart, ensureBlocks, indentItem, lineAfter, moveBlock, todoHit, toggleHit, turnInto } from "./blockEdit";
import { openContextMenu, type MenuItem } from "../components/ContextMenu";
import { openExternal } from "../utils/media";
import { grids, openGrid, useGrids } from "../lib/grids";
import { api } from "../lib/api";
import { toast } from "../state/ui";
import "./blocks.css";

interface Slash {
  line: HTMLElement;
  /** where the "/" is in the line's text */
  at: number;
  query: string;
  x: number;
  y: number;
  pick: number;
}

const TURNS: BlockKind[] = ["p", "h1", "h2", "h3", "ul", "ol", "todo", "toggle", "quote", "callout-note", "code"];

/** make a note page for a page block: inside the page being written, when it is one */
async function newPage(parent: string | null, title: string): Promise<{ id: string; title: string } | null> {
  try {
    const { id } = await api<{ id: string }>("/api/boards", { method: "POST", json: { kind: "note", name: title || undefined, parent, link: false } });
    window.dispatchEvent(new Event("foundation:boards"));
    const name = grids().find((b) => b.id === id)?.name ?? (title || "Untitled note");
    return { id, title: name };
  } catch (e) {
    toast((e as Error).message, "bad");
    return null;
  }
}

export function NoteBlocks({ surface, canWrite, commit, page }: { surface: HTMLDivElement | null; canWrite: boolean; commit: () => void; /** the note page this is the body of (a page block goes inside it) */ page?: string | null }) {
  const [slash, setSlash] = useState<Slash | null>(null);
  const slashRef = useRef<Slash | null>(null);
  slashRef.current = slash;
  const [hover, setHover] = useState<{ block: HTMLElement; top: number; left: number } | null>(null);
  const [drop, setDrop] = useState<{ top: number; left: number; width: number } | null>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const rows = useGrids();

  // page blocks wear their page's name now, or say they can't be opened (a page this person can't see)
  useEffect(() => {
    if (!surface) return;
    const name = () => {
      for (const p of surface.querySelectorAll<HTMLElement>(".md-page[data-note]")) {
        const row = rows.find((b) => b.id === p.dataset.note);
        const t = p.querySelector(".md-page-title");
        if (row && t && t.textContent !== row.name) t.textContent = row.name;
        p.classList.toggle("is-locked", !row);
        p.title = row ? `Open “${row.name}”` : "A note page you can't open, or one that was archived";
      }
    };
    name();
    const mo = new MutationObserver(name);
    mo.observe(surface, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [surface, rows]);

  // ---------- the slash menu ----------

  const found = slash ? rankBlocks(slash.query, readRecents()) : [];

  const apply = async (cmd: BlockCommand) => {
    const s = slashRef.current;
    setSlash(null);
    if (!surface || !s) return;
    surface.focus({ preventScroll: true });
    // take the "/query" out of the line
    const text = s.line.textContent ?? "";
    const end = s.at + 1 + s.query.length;
    if (text.slice(s.at, end) === `/${s.query}`) removeText(s.line, s.at, end);
    caretInLine(s.line, s.at);
    await turnHere(cmd.id);
    noteRecent(cmd.id);
  };

  /** turn the block the caret is in into `kind`, asking what it needs (an address, a new page) */
  const turnHere = async (kind: BlockKind, target?: HTMLElement) => {
    if (!surface) return;
    const block = target ?? caretBlock(surface);
    if (!block) return;
    const extra: Parameters<typeof turnInto>[2] = {};
    if (kind === "image" || kind === "bookmark") {
      const url = window.prompt(kind === "image" ? "The picture's address (a file of Foundation's shows at once; one from elsewhere waits for a press)" : "The web address")?.trim();
      if (!url) return;
      if (!/^https?:\/\/\S+$/.test(url) && !(kind === "image" && /^\/files\//.test(url))) return void toast("An address that starts with http:// or https://", "warn");
      extra.url = url;
    }
    if (kind === "page") {
      const title = (block.textContent ?? "").trim().slice(0, 80);
      const made = await newPage(page ?? null, title);
      if (!made) return;
      extra.page = made;
    }
    caretToEnd(turnInto(block, kind, extra));
    commit();
  };

  // ---------- keys, input and presses on the surface ----------

  useEffect(() => {
    if (!surface) return;
    const onInput = (e: Event) => {
      const ev = e as InputEvent;
      if (!canWrite) return;
      ensureBlocks(surface);
      const s = slashRef.current;
      if (s) {
        // the query is what's between the "/" and the caret, in the same line
        const line = caretLine(surface);
        const at = line ? caretIn(line) : null;
        const text = s.line.textContent ?? "";
        if (line !== s.line || at === null || at <= s.at || text[s.at] !== "/" || at - s.at > 24) setSlash(null);
        else setSlash({ ...s, query: text.slice(s.at + 1, at), pick: 0 });
      }
      // what was typed may come one key at a time or all at once (a paste of words, an input method): both are read from the line
      const typed = ev.inputType === "insertText" || ev.inputType === "insertReplacementText" ? (ev.data ?? "") : "";
      if (!s && typed.includes("/")) {
        const line = caretLine(surface);
        const at = line ? caretIn(line) : null;
        if (line && at !== null && !line.closest("pre")) {
          const before = (line.textContent ?? "").slice(0, at);
          // the "/" that came in now, at a word's start, with no space after it yet
          const m = /(^|\s)\/([^\s/]{0,24})$/.exec(before);
          const slashAt = m ? before.length - m[2].length - 1 : -1;
          if (m && slashAt >= at - typed.length) {
            const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
            const box = r.width || r.height ? r : line.getBoundingClientRect();
            setSlash({ line, at: slashAt, query: m[2], x: box.left, y: box.bottom + 4, pick: 0 });
          }
        }
      }
      // markdown at a block's start, as the space after it is typed
      if (typed.includes(" ")) {
        const line = caretLine(surface);
        const at = line ? caretIn(line) : null;
        if (line && line.tagName === "P" && !line.classList.contains("md-toggle-head") && !line.closest(".md-callout") && at !== null) {
          const before = (line.textContent ?? "").slice(0, at);
          const sc = shortcutOf(before);
          const prefix = sc ? before.length - sc.rest.length : 0;
          // only when the space that ends the mark came in now (typing "- " before old words turns them too)
          if (sc && prefix > at - typed.length) {
            removeText(line, 0, prefix);
            void turnHere(sc.kind, blockOf(surface, line) ?? undefined);
          }
        }
      }
      // a new to-do under a ticked one starts unticked
      if (ev.inputType === "insertParagraph") {
        const li = caretLine(surface);
        if (li?.matches("li.md-todo") && !(li.textContent ?? "").trim()) li.dataset.checked = "false";
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const s = slashRef.current;
      if (s) {
        const list = rankBlocks(s.query, readRecents());
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setSlash({ ...s, pick: (s.pick + (e.key === "ArrowDown" ? 1 : -1) + Math.max(1, list.length)) % Math.max(1, list.length) });
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && list.length) {
          e.preventDefault();
          e.stopPropagation();
          void apply(list[Math.min(s.pick, list.length - 1)]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setSlash(null);
          return;
        }
      }
      if (!canWrite) return;
      const line = caretLine(surface);
      if (!line) return;
      if (e.key === "Tab" && line.tagName === "LI") {
        e.preventDefault();
        e.stopPropagation();
        if (indentItem(line, e.shiftKey ? -1 : 1)) commit();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // code: a new line in it, not a new block
        if (line.closest("pre")) {
          e.preventDefault();
          document.execCommand("insertText", false, "\n");
          return;
        }
        // a toggle's head: into its body
        if (line.classList.contains("md-toggle-head")) {
          e.preventDefault();
          const toggle = line.parentElement!;
          toggle.dataset.open = "true";
          const body = toggle.querySelector<HTMLElement>(".md-toggle-body")!;
          let first = body.firstElementChild as HTMLElement | null;
          if (!first) {
            first = document.createElement("p");
            first.innerHTML = "<br>";
            body.appendChild(first);
          }
          caretToStart(first);
          commit();
          return;
        }
        // an empty last line in a box leaves it
        const box = line.parentElement;
        if (box && (box.classList.contains("md-callout") || box.classList.contains("md-toggle-body")) && line === box.lastElementChild && !(line.textContent ?? "").trim() && box.children.length > 1) {
          e.preventDefault();
          line.remove();
          const out = box.classList.contains("md-callout") ? box : box.parentElement!;
          caretToStart(lineAfter(out));
          commit();
          return;
        }
      }
      if (e.key === "Backspace" && caretIn(line) === 0 && window.getSelection()?.isCollapsed) {
        const block = blockOf(surface, line);
        if (!block) return;
        if (/^H[1-4]$|^BLOCKQUOTE$/.test(line.tagName) && line === block) {
          e.preventDefault();
          caretToStart(turnInto(block, "p"));
          commit();
        } else if (line.classList.contains("md-toggle-head")) {
          e.preventDefault();
          const p = document.createElement("p");
          p.innerHTML = line.innerHTML;
          const body = block.querySelector(".md-toggle-body");
          block.replaceWith(p, ...(body ? [...body.childNodes] : []));
          caretToStart(p);
          commit();
        } else if (block.classList.contains("md-callout") && line === block.firstElementChild) {
          e.preventDefault();
          const kids = [...block.childNodes];
          block.replaceWith(...kids);
          caretToStart(line);
          commit();
        }
      }
    };

    const onPress = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const page = t.closest<HTMLElement>(".md-page[data-note]");
      if (page && surface.contains(page)) {
        e.preventDefault();
        if (page.classList.contains("is-locked")) return void toast("That note page isn't one you can open (it's members-only, or it was archived).", "warn");
        openGrid(page.dataset.note!);
        return;
      }
      const embed = t.closest<HTMLElement>(".md-embed[data-url]");
      if (embed && surface.contains(embed)) {
        e.preventDefault();
        void openExternal(embed.dataset.url!);
        return;
      }
      const todo = t.closest<HTMLElement>("li.md-todo");
      if (todo && surface.contains(todo) && todoHit(todo, e.clientX)) {
        e.preventDefault();
        if (!canWrite) return;
        todo.dataset.checked = todo.dataset.checked === "true" ? "false" : "true";
        commit();
        return;
      }
      const head = t.closest<HTMLElement>(".md-toggle-head");
      if (head && surface.contains(head) && toggleHit(head, e.clientX)) {
        e.preventDefault();
        const toggle = head.parentElement!;
        toggle.dataset.open = toggle.dataset.open === "true" ? "false" : "true";
        // kept in the note for a writer; a reader folds it on their own screen
        if (canWrite) commit();
      }
    };
    // the caret leaving the "/" line puts the menu away
    const onSel = () => {
      const s = slashRef.current;
      if (s && caretLine(surface) !== s.line) setSlash(null);
    };
    const onBlur = () => setTimeout(() => document.activeElement !== surface && setSlash(null), 120);

    surface.addEventListener("input", onInput);
    surface.addEventListener("keydown", onKey);
    surface.addEventListener("click", onPress);
    surface.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", onSel);
    return () => {
      surface.removeEventListener("input", onInput);
      surface.removeEventListener("keydown", onKey);
      surface.removeEventListener("click", onPress);
      surface.removeEventListener("blur", onBlur);
      document.removeEventListener("selectionchange", onSel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, canWrite, commit, page]);

  // ---------- the handle ----------

  /** where a block's handle goes: its first line's top, in the gutter left of it (the surface scrolls under it) */
  const placeFor = (block: HTMLElement) => {
    if (!surface) return null;
    return { block, top: block.offsetTop - surface.scrollTop + 2, left: Math.max(0, block.offsetLeft - 20) };
  };

  useEffect(() => {
    if (!surface || !canWrite) return;
    const holder = surface.parentElement;
    const move = (e: PointerEvent) => {
      if (dragging.current) return;
      if (handle.current?.contains(e.target as Node)) return;
      const block = blockOf(surface, e.target as Node);
      if (block) setHover(placeFor(block));
    };
    const leave = (e: PointerEvent) => {
      if (dragging.current || holder?.contains(e.relatedTarget as Node)) return;
      setHover(null);
    };
    const scroll = () => setHover((h) => (h ? placeFor(h.block) : h));
    surface.addEventListener("pointermove", move);
    holder?.addEventListener("pointerleave", leave);
    surface.addEventListener("scroll", scroll);
    return () => {
      surface.removeEventListener("pointermove", move);
      holder?.removeEventListener("pointerleave", leave);
      surface.removeEventListener("scroll", scroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, canWrite]);

  const dragging = useRef<{ x: number; y: number; moved: boolean; target: HTMLElement | null; after: boolean } | null>(null);

  const blockMenu = (block: HTMLElement, x: number, y: number) => {
    if (!surface) return;
    const turn = (k: BlockKind) => () => {
      caretToEnd(block.querySelector("li, .md-toggle-head, .md-callout > p") ?? block);
      void turnHere(k, block);
    };
    const items: MenuItem[] = [
      { heading: "Turn into" },
      ...TURNS.map((k): MenuItem => ({ label: NOTE_BLOCKS.find((b) => b.id === k)!.name, action: turn(k) })),
      { divider: true },
      {
        icon: "⧉",
        label: "Duplicate",
        action: () => {
          block.after(block.cloneNode(true));
          commit();
        },
      },
      { icon: "↑", label: "Move up", disabled: !block.previousElementSibling, action: () => (moveBlock(block, block.previousElementSibling as HTMLElement, false), commit()) },
      { icon: "↓", label: "Move down", disabled: !block.nextElementSibling, action: () => (moveBlock(block, block.nextElementSibling as HTMLElement, true), commit()) },
      { divider: true },
      {
        icon: "🗑",
        label: "Delete",
        danger: true,
        action: () => {
          block.remove();
          setHover(null);
          commit();
        },
      },
    ];
    openContextMenu(x, y, items);
  };

  const onHandleDown = (e: React.PointerEvent) => {
    if (!hover || !surface) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = { x: e.clientX, y: e.clientY, moved: false, target: null, after: false };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d || !hover || !surface) return;
    e.stopPropagation();
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    // the drop goes among the dragged block's own neighbours (the surface's, or the toggle body's)
    const parent = hover.block.parentElement!;
    const sibs = [...parent.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
    let target = sibs[sibs.length - 1];
    let after = true;
    for (const s of sibs) {
      const r = s.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        target = s;
        after = false;
        break;
      }
    }
    d.target = target;
    d.after = after;
    const top = (after ? target.offsetTop + target.offsetHeight : target.offsetTop) - surface.scrollTop;
    setDrop({ top, left: target.offsetLeft, width: target.offsetWidth });
  };
  const onHandleUp = (e: React.PointerEvent) => {
    const d = dragging.current;
    dragging.current = null;
    setDrop(null);
    if (!d || !hover) return;
    e.stopPropagation();
    if (d.moved && d.target) {
      moveBlock(hover.block, d.target, d.after);
      setHover(placeFor(hover.block));
      commit();
    } else if (!d.moved) blockMenu(hover.block, e.clientX, e.clientY);
  };

  // the menu is kept on screen
  const menu = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!slash) return setMenuAt(null);
    const r = menu.current?.getBoundingClientRect();
    const h = r?.height ?? 300;
    const w = r?.width ?? 260;
    setMenuAt({ x: Math.min(slash.x, window.innerWidth - w - 8), y: slash.y + h > window.innerHeight - 8 ? Math.max(8, slash.y - h - 28) : slash.y });
  }, [slash]);

  return (
    <>
      {canWrite && hover && (
        <button
          ref={handle}
          type="button"
          className="note-block-handle"
          style={{ top: hover.top, left: hover.left }}
          aria-label="Move the block, or press for its menu"
          data-tip="Drag to move · press for more"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={() => {
            dragging.current = null;
            setDrop(null);
          }}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden fill="currentColor">
            <circle cx="3" cy="3" r="1.1" />
            <circle cx="7" cy="3" r="1.1" />
            <circle cx="3" cy="7" r="1.1" />
            <circle cx="7" cy="7" r="1.1" />
            <circle cx="3" cy="11" r="1.1" />
            <circle cx="7" cy="11" r="1.1" />
          </svg>
        </button>
      )}
      {drop && <div className="note-block-drop" style={{ top: drop.top, left: drop.left, width: drop.width }} aria-hidden />}
      {slash &&
        createPortal(
          <div
            ref={menu}
            className="note-slash f-paper"
            role="listbox"
            aria-label="Turn into"
            style={{ left: menuAt?.x ?? slash.x, top: menuAt?.y ?? slash.y, visibility: menuAt ? "visible" : "hidden" }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {found.length === 0 ? (
              <div className="note-slash-none">No block called “{slash.query}”</div>
            ) : (
              found.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  role="option"
                  aria-selected={i === slash.pick}
                  className={"note-slash-item" + (i === slash.pick ? " is-picked" : "")}
                  data-block={b.id}
                  onMouseEnter={() => setSlash((s) => (s ? { ...s, pick: i } : s))}
                  onClick={() => void apply(b)}
                >
                  <span className="note-slash-glyph" data-block={b.id} aria-hidden />
                  <span className="note-slash-words">
                    <span className="note-slash-name">{b.name}</span>
                    <span className="note-slash-hint">{b.hint}</span>
                  </span>
                  {b.md && <kbd className="note-slash-md">{b.md}</kbd>}
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** take characters [from, to) out of an element's text, across its text nodes */
function removeText(el: HTMLElement, from: number, to: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  const r = document.createRange();
  let started = false;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    const end = at + t.length;
    if (!started && from <= end) {
      r.setStart(t, from - at);
      started = true;
    }
    if (started && to <= end) {
      r.setEnd(t, to - at);
      r.deleteContents();
      if (!(el.textContent ?? "")) el.innerHTML = "<br>";
      return;
    }
    at = end;
  }
}

/** put the caret `at` characters into a line */
function caretInLine(el: HTMLElement, at: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = at;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (left <= t.length) {
      window.getSelection()?.collapse(t, left);
      return;
    }
    left -= t.length;
  }
  caretToEnd(el);
}

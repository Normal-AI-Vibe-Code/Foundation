/**
 * Copy, cut and paste of cards on the grid (2026-11-25, Josh: CAD cards an agent pulls out of an app are cut or
 * copied and pasted elsewhere to keep working on them apart).
 *
 *   ⌘C / Ctrl+C   copy the selected card
 *   ⌘X / Ctrl+X   copy it and remove it, the way Delete does (⌘Z puts it back; a card that asks first still asks)
 *   ⌘V / Ctrl+V   paste copies (new ids, no wires) into the section under the pointer, else the one you're in
 *
 * The copy is held here (and in localStorage, so another window of the app can paste it); the OS clipboard gets
 * only a marker, `foundation-cards:<n>`. A paste takes the cards only while that marker is what's on the OS
 * clipboard, so copying a picture or a file afterwards pastes the file (UploadTray) as it always did. Where the
 * browser fires no copy or paste event (nothing selected, on some webviews) the keys fall back to the async
 * clipboard, and when that can't be read either, to the cards if they were the last thing copied in Foundation.
 *
 * The keys are the grid's only when nothing else has them: a field, a note's editor, a table's cells, a machine's
 * shell keep their own. Viewers copy; they don't cut or paste.
 */

import { activeBoard } from "../sync/board";
import { getObject, getState, leafSection, putCards, sectionAtWorld, sectionById, sectionCardRect, sectionFit, uid, CONTENT_PAD, SECTION_HEADER, type AnyObject } from "../state/store";
import { getUi, toast } from "../state/ui";
import { workbook } from "../engine/workbook";
import { clipOf, markerOf, parseMarker, pasteCards, type Clip, type ClipCard } from "../state/cardClip";
import { kindWord, removeCard } from "../components/cardMenu";
import { gridPointAt } from "./ingest";
import { holdsKeys } from "./keysHeld";
import { keys } from "./keys";

const KEY = "foundation.cardclip.v1";

let held: Clip | null = null;
/** something else was copied in Foundation since (text in a note, a link): the cards are no longer the last copy */
let superseded = false;
/** how many times the held cards were pasted: each paste steps a little further */
let rounds = 0;
/** the copy or paste the key started was handled by its clipboard event */
let handled = false;

function readStored(): Clip | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Clip | null;
    return v && typeof v.n === "number" && Array.isArray(v.cards) ? v : null;
  } catch {
    return null;
  }
}
function store(c: Clip) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* too big or storage off: this window still has it */
  }
}

/** something that takes typing has the keys (a field, a note's editor, a rich text box) */
function textHas(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest(".cm-editor, .rich-text, [contenteditable]:not([contenteditable='false']), .xterm");
}

/** the page, the grid or a card's own frame has the keys, not a control inside a card that keeps its own (a table's cells) */
function gridOrCard(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  if (el.matches?.(".grid-viewport, .grid-world")) return true;
  return !!el.closest?.(".frame-anchor") && !el.closest("[tabindex]:not(.frame-anchor), iframe");
}

/** text the person selected on the page: ⌘C is for that */
function textSelected(): boolean {
  const s = typeof window !== "undefined" ? window.getSelection?.() : null;
  return !!s && !s.isCollapsed && s.toString().trim().length > 0;
}

function free(t: EventTarget | null, onGrid: () => boolean): boolean {
  const ui = getUi();
  return onGrid() && !ui.command && !ui.presenting && !holdsKeys(t) && !textHas(t) && gridOrCard(t);
}

function selected(): AnyObject | null {
  const st = getState();
  return st.focusLevel === "object" && st.activeObjectId ? getObject(st.activeObjectId) : null;
}

/** copy the selected card into Foundation's clipboard; the marker to put on the OS clipboard, or null */
function copySelected(cut: boolean): string | null {
  const o = selected();
  if (!o) return null;
  if (cut && getUi().role === "viewer") {
    toast("View only: you can copy cards here, not cut them", "warn");
    return null;
  }
  const cells: Record<string, string> = {};
  if ("cols" in o) for (const [k, c] of workbook.getTable(o.id)?.cells ?? []) if (c.raw) cells[k] = c.raw;
  const r = clipOf(o, cells);
  if ("refuse" in r) {
    toast(r.refuse, "warn");
    return null;
  }
  const clip: Clip = { n: Date.now(), board: activeBoard()?.boardId ?? "", cards: [r.clip] };
  held = clip;
  superseded = false;
  rounds = 0;
  store(clip);
  const name = o.name || kindWord(o);
  if (cut) {
    activeBoard()?.gridStep();
    const gone = removeCard(o.id);
    toast(gone ? `Cut ${name} · ${keys("mod+V")} pastes it, ${keys("mod+Z")} puts it back` : `Copied ${name}: it asks before it goes`);
  } else toast(`Copied ${name} · ${keys("mod+V")} pastes it`);
  return markerOf(clip.n);
}

/** the clip a marker names: this window's, or one another window of the app left in storage */
function clipFor(n: number): Clip | null {
  if (held?.n === n) return held;
  const s = readStored();
  if (s?.n === n) {
    held = s;
    rounds = 0;
    return s;
  }
  return null;
}

let pointer: { x: number; y: number } | null = null;

/** paste the held cards where the pointer is (or the section you're in, or the one they came from) */
function paste(clip: Clip) {
  if (getUi().role === "viewer") {
    toast("View only: pasting needs someone who can edit this board", "warn");
    return;
  }
  // a file or a picture is the grid's own record of its bytes: on another grid it would be a card nobody there can open
  // (the card's menu sends it, and the server gives that grid its own record)
  const here = activeBoard()?.boardId ?? "";
  if (clip.board && clip.board !== here && clip.cards.some((c) => c.kind === "media" || (c.kind === "panel" && (c.card.fileId || c.card.panel === "file")))) {
    toast("A file card pastes on the grid it came from. To put it on this one, use Send to grid on its menu.", "warn");
    return;
  }
  const st = getState();
  const at = pointer ? gridPointAt(pointer.x, pointer.y) : null;
  const under = at ? sectionAtWorld(at.x, at.y) : null;
  const first = clip.cards[0]?.card;
  let sec = under ?? st.sections[st.activeSectionId] ?? (first ? sectionById(first.sectionId) : undefined);
  if (!sec) {
    toast("Point at a section, then paste", "warn");
    return;
  }
  let local: { x: number; y: number } | null = null;
  const leaf = leafSection(sec.id);
  if (leaf !== sec.id) sec = sectionById(leaf) ?? sec;
  else if (under && at) {
    // the content point under the pointer, as a card dropped there lands (store.placeAtWorld)
    const card = sectionCardRect(st.grid, sec);
    const s = sectionFit(sec.id);
    local = { x: (at.x - card.x - 1) / s - CONTENT_PAD - 24, y: (at.y - card.y - 1 - SECTION_HEADER) / s - CONTENT_PAD - 16 };
  }
  rounds++;
  activeBoard()?.gridStep();
  const pasted = pasteCards(clip.cards as ClipCard[], { sectionId: sec.id, at: local }, {
    round: rounds,
    now: Date.now(),
    id: uid,
    tableNames: Object.values(getState().tables).map((t) => t.name),
  });
  putCards(pasted, sec.id);
  const one = pasted.length === 1 ? pasted[0].card : null;
  toast(`Pasted ${one ? one.name || kindWord(one) : `${pasted.length} cards`}${clip.cards.some((c) => c.kind === "panel" && c.card.feed) ? " · unlinked from its app: it keeps its last model" : ""}`);
}

/** bind the keys and the clipboard events; `onGrid` says whether a grid is what's on screen. Returns the unbinding. */
export function installCardClipboard(onGrid: () => boolean): () => void {
  const move = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
  };

  // the clipboard events: the marker goes on the OS clipboard with the copy, and a paste reads it back
  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    if (e.defaultPrevented || !free(e.target, onGrid) || textSelected() || !selected()) {
      // a copy of anything else in Foundation: the cards stop being the last thing copied
      superseded = true;
      return;
    }
    handled = true;
    const marker = copySelected(cut);
    if (!marker) return;
    e.clipboardData?.setData("text/plain", marker);
    e.preventDefault();
  };
  const copy = (e: ClipboardEvent) => onCopy(e, false);
  const cut = (e: ClipboardEvent) => onCopy(e, true);
  const onPaste = (e: ClipboardEvent) => {
    if (e.defaultPrevented || !free(e.target, onGrid)) return;
    const cd = e.clipboardData;
    if (!cd) return;
    handled = true;
    // files on the clipboard are newer than any card copy: they're UploadTray's
    if (cd.files.length || [...cd.items].some((i) => i.kind === "file")) return;
    const n = parseMarker(cd.getData("text/plain"));
    const clip = n === null ? null : clipFor(n);
    if (!clip) return;
    e.preventDefault();
    paste(clip);
  };

  // the keys: where no clipboard event follows them, the async clipboard does the work
  const onKey = (e: KeyboardEvent) => {
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    if (!mod || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k !== "c" && k !== "x" && k !== "v") return;
    if (!free(e.target, onGrid)) return;
    handled = false;
    setTimeout(() => {
      if (handled) return;
      if (k === "v") {
        if (!held || getUi().role === "viewer") return;
        const mine = held;
        const os = navigator.clipboard?.readText?.();
        if (!os) {
          if (!superseded) paste(mine);
          return;
        }
        os.then(
          (t) => {
            const n = parseMarker(t);
            const c = n === null ? null : clipFor(n);
            if (c) paste(c);
          },
          // the clipboard can't be read here: the cards, if they were the last thing copied in Foundation
          () => {
            if (!superseded && held === mine) paste(mine);
          },
        );
        return;
      }
      if (textSelected() || !selected()) return;
      const marker = copySelected(k === "x");
      if (marker) void navigator.clipboard?.writeText?.(marker).catch(() => {});
    }, 0);
  };

  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("copy", copy, true);
  window.addEventListener("cut", cut, true);
  window.addEventListener("paste", onPaste, true);
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("copy", copy, true);
    window.removeEventListener("cut", cut, true);
    window.removeEventListener("paste", onPaste, true);
    window.removeEventListener("keydown", onKey);
  };
}

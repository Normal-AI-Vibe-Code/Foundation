/**
 * The grid's keys for taking a step back (2026-11-24, Josh: "these actions should also be able to be undone.
 * If we haven't implemented a strong sequence for undo and redo of actions on the grid we should do so now").
 *
 *   ⌘Z / Ctrl+Z            undo your last change on the grid
 *   ⇧⌘Z / Ctrl+Shift+Z     redo it (Ctrl+Y too, on Windows and Linux)
 *   Delete / Backspace     remove the selected card (the card menu's Remove: one that asks first still asks)
 *
 * The stack itself is the board's (sync/board.ts `undo`): only what you did, never a teammate's or an agent's
 * work. A press or a key starts a new step, so a drag is one step however many frames it took, and a move
 * right after a removal is a step of its own.
 *
 * The keys are the grid's only when nothing else has them: in a note, a cell, a field, a chat box or a
 * machine's shell, ⌘Z and Backspace are that text's own.
 */

import { activeBoard } from "../sync/board";
import { getObject, getState } from "../state/store";
import { getUi, toast } from "../state/ui";
import { kindWord, removeCard } from "../components/cardMenu";
import { holdsKeys } from "./keysHeld";
import { keys } from "./keys";

/** something that takes typing has the keys (a field, a note's editor, a rich text box) */
function textHas(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest(".cm-editor, .rich-text, [contenteditable]");
}

/** nothing has focus but the page or the grid itself: a key here is the grid's */
function gridHas(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  return !!el.matches?.(".grid-viewport, .grid-world");
}

export function undoGrid(): boolean {
  return activeBoard()?.undo() ?? false;
}
export function redoGrid(): boolean {
  return activeBoard()?.redo() ?? false;
}

/** bind the keys; `onGrid` says whether a grid is what's on screen. Returns the unbinding. */
export function installGridKeys(onGrid: () => boolean): () => void {
  // every new press or key closes the step before it
  const step = () => activeBoard()?.gridStep();
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat && e.key !== "z" && e.key !== "Z") return;
    if (e.defaultPrevented || !onGrid() || holdsKeys(e.target) || textHas(e.target)) return;
    const ui = getUi();
    if (ui.command || ui.presenting || ui.role === "viewer") return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && (k === "z" || (k === "y" && !e.metaKey))) {
      e.preventDefault();
      if (k === "y" || e.shiftKey) redoGrid();
      else undoGrid();
      return;
    }
    if (!mod && !e.altKey && (e.key === "Delete" || e.key === "Backspace") && gridHas(e.target)) {
      const st = getState();
      const id = st.focusLevel === "object" ? st.activeObjectId : null;
      const o = id ? getObject(id) : null;
      if (!id || !o) return;
      e.preventDefault();
      step();
      const name = o.name || kindWord(o);
      const gone = removeCard(id);
      if (gone) toast(`Removed ${name} · ${keys("mod+Z")} puts it back`);
    }
  };
  window.addEventListener("pointerdown", step, true);
  window.addEventListener("keydown", step, true);
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("pointerdown", step, true);
    window.removeEventListener("keydown", step, true);
    window.removeEventListener("keydown", onKey);
  };
}

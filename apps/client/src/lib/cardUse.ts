/**
 * Using a card (2026-11-11, Josh: "Don't allow any of the objects to take
 * over scroll, give them a ctrl keyboard command to interact with them, and
 * allow them to be fullscreened").
 *
 * A card on the grid is something you look at and move. The wheel always pans
 * the grid, wherever the pointer is: over a live app, a map, a terminal or a
 * list. ⌘/Ctrl-wheel always zooms the grid; Alt-wheel scrolls through a card
 * with more in it than fits (lib/cardScroll.ts, 2026-11-17).
 * To use what's inside a card:
 *
 *   - ⌘-click (Ctrl-click elsewhere) puts it **in use** in place: the app,
 *     map, list or terminal takes the pointer and the wheel while the pointer
 *     is on it. Esc, a click elsewhere, or panning the grid ends it.
 *   - ⌘↵ / Ctrl+Enter, or ⤢ on the card, opens it **full screen** (the
 *     browser's own: the card leaves the grid's transforms and clips without
 *     reloading, and fills the window). Esc comes back.
 *
 * Holding the modifier shows which card a click would put in use.
 */

import { getUi, setUi } from "../state/ui";
import { IS_MAC } from "./keys";

/** the platform's modifier: ⌘ on a Mac (⌃-click is the right button there), Ctrl elsewhere */
export const modHeld = (e: { ctrlKey: boolean; metaKey: boolean }) => (IS_MAC ? e.metaKey : e.ctrlKey);

/** the card (object id) an element sits in */
export function cardOf(el: EventTarget | null): string | null {
  return el instanceof Element ? (el.closest<HTMLElement>("[data-obj-id]")?.dataset.objId ?? null) : null;
}

/** whether an event's target is inside the card that's in use (or full screen) */
export function inUse(target: EventTarget | null): boolean {
  const id = getUi().engaged;
  return !!id && cardOf(target) === id;
}

export function putInUse(id: string) {
  if (getUi().engaged !== id) setUi({ engaged: id });
}

export function releaseCard() {
  if (getUi().engaged && !fullscreenCard()) setUi({ engaged: null });
}

// ---------- full screen ----------

/** the element a card goes full screen with: its frame (the whole card), or the app filling a section */
function fullscreenTarget(id: string): HTMLElement | null {
  const slot = document.querySelector<HTMLElement>(`[data-obj-id="${CSS.escape(id)}"]`);
  if (!slot) return null;
  return slot.matches(".fs-able") ? slot : slot.querySelector<HTMLElement>(".fs-able");
}

/** the card that's full screen now, if one is */
export function fullscreenCard(): string | null {
  return cardOf(document.fullscreenElement);
}

export async function toggleFullscreen(id: string) {
  if (fullscreenCard() === id) {
    await document.exitFullscreen().catch(() => {});
    return;
  }
  const el = fullscreenTarget(id);
  if (!el?.requestFullscreen) return;
  try {
    await el.requestFullscreen({ navigationUI: "hide" });
  } catch {
    /* refused (no user gesture, or a webview without element full screen) */
  }
}

let installed = false;
let pointer: { x: number; y: number } | null = null;
let keyDown = false;

/**
 * Whether a person is really holding ⌘/Ctrl (seen on keydown, and on any pointer move, which carries the real
 * keys). A trackpad pinch reaches the page as a Ctrl-wheel with no key down.
 */
export const modKeyDown = () => keyDown;

/**
 * Once per page: the modifier hint, ⌘↵ / Ctrl+Enter, and keeping "in use" in
 * step with full screen. Returns nothing to undo: it lives as long as the page.
 */
export function installCardUse() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const root = document.documentElement;
  const held = (on: boolean) => {
    keyDown = on;
    root.classList.toggle("use-key-held", on);
  };
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      // the key went down or came up while the window wasn't listening (another window had the keyboard)
      if (modHeld(e) !== keyDown) held(modHeld(e));
    },
    { passive: true, capture: true },
  );
  // ⌘/Ctrl and the main button on any card puts it in use (a terminal's scrollback, a list, a map, an app)
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || !modHeld(e)) return;
      const t = e.target as Element | null;
      if (!t?.closest?.(".grid-viewport") || t.closest(".frame-header, .map-header, button, a, input, select, textarea")) return;
      const id = cardOf(t);
      if (id) putInUse(id);
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === (IS_MAC ? "Meta" : "Control")) held(true);
      if (e.key === "Enter" && modHeld(e) && !e.shiftKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        // a field takes its own ⌘↵ (the command bar asks the agent with it)
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const under = pointer ? cardOf(document.elementFromPoint(pointer.x, pointer.y)) : null;
        const id = fullscreenCard() ?? getUi().engaged ?? under;
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        void toggleFullscreen(id);
      }
    },
    true,
  );
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control" || e.key === "Meta") held(false);
  });
  window.addEventListener("blur", () => held(false));
  document.addEventListener("fullscreenchange", () => {
    const id = fullscreenCard();
    if (id) setUi({ engaged: id });
    else if (getUi().engaged) setUi({ engaged: null });
    root.classList.toggle("card-fullscreen", Boolean(id));
  });
}

/** for components: re-render when a card enters or leaves full screen */
export function onFullscreen(fn: () => void) {
  document.addEventListener("fullscreenchange", fn);
  return () => document.removeEventListener("fullscreenchange", fn);
}

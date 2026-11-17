/**
 * The mark that says a card scrolls (2026-11-17, Josh: "alt+scroll should
 * scroll a card -> show a small icon on roll-over, allow user to dismiss this
 * hint").
 *
 * When the pointer rests on a card with more in it than fits, a small mark
 * comes up on the card's right edge, by its scroll line: a 20 px light round
 * with a wheel in it, and "Alt" under it as a key. Its roll-over label says
 * "Alt + scroll to scroll through this card". It goes with the pointer.
 *
 * It is a hint, so it ends: its ✕ ("Got it") puts it away for good on this
 * device, and it stops coming up by itself once the person has Alt-scrolled a
 * card three times. Someone who dismissed it never sees it again.
 *
 * One element for the whole page, moved onto the card it speaks for; nothing
 * here is React state.
 */

import { IS_MAC } from "./keys";
import { cardRootOf, panesUnder } from "./cardScroll";

// ---------- what is remembered (pure) ----------

export const HINT_KEY = "foundation-scroll-hint";
/** Alt-scrolls after which the hint has done its job */
export const LEARNED = 3;
/** wheels closer together than this are one scroll, not several */
export const ONE_SCROLL = 600;

export interface HintMemory {
  /** dismissed by the person: never again */
  off: boolean;
  /** how many times they've Alt-scrolled a card */
  used: number;
}

export function readHint(raw: string | null | undefined): HintMemory {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<HintMemory>) : null;
    return { off: v?.off === true, used: typeof v?.used === "number" && v.used > 0 ? Math.floor(v.used) : 0 };
  } catch {
    return { off: false, used: 0 };
  }
}

/** whether the hint may still come up */
export const hintWanted = (m: HintMemory) => !m.off && m.used < LEARNED;

/** an Alt-wheel scrolled a card at `now`; the last one that did was at `last` */
export function afterScroll(m: HintMemory, now: number, last: number): HintMemory {
  return now - last < ONE_SCROLL || m.used >= LEARNED ? m : { ...m, used: m.used + 1 };
}

export const dismissed = (m: HintMemory): HintMemory => ({ ...m, off: true });

/** the key as this machine writes it, and the roll-over label */
export const altKey = (mac = IS_MAC) => (mac ? "⌥" : "Alt");
export const hintLabel = (mac = IS_MAC) => `${mac ? "Option" : "Alt"} + scroll to scroll through this card`;

// ---------- in the page ----------

let memory: HintMemory | null = null;
const load = (): HintMemory => {
  if (memory) return memory;
  try {
    memory = readHint(localStorage.getItem(HINT_KEY));
  } catch {
    memory = { off: false, used: 0 };
  }
  return memory;
};
const save = (m: HintMemory) => {
  memory = m;
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(m));
  } catch {
    /* private mode: it lasts as long as the page */
  }
};

let lastScroll = -Infinity;
/** lib/cardScroll.ts tells us each time an Alt-wheel scrolled a card */
export function noteAltScroll() {
  const now = performance.now();
  const next = afterScroll(load(), now, lastScroll);
  lastScroll = now;
  if (next !== memory) save(next);
  if (!hintWanted(next)) put(null);
}

const WHEEL = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.2v9.6M3.6 3.4 6 1.2l2.4 2.2M3.6 8.6 6 10.8l2.4-2.2"/></svg>`;

/** the mark's markup, for the page and for #/design */
export function hintMarkup(mac = IS_MAC): string {
  return `<span class="scroll-hint-mark">${WHEEL}</span><span class="scroll-hint-key">${altKey(mac)}</span><button type="button" class="scroll-hint-x" aria-label="Got it: don't show this again" data-tip="Got it">✕</button>`;
}

let mark: HTMLElement | null = null;
let host: HTMLElement | null = null;
let leaving = 0;

function element(): HTMLElement {
  if (mark) return mark;
  const el = document.createElement("div");
  el.className = "scroll-hint";
  el.setAttribute("role", "note");
  el.setAttribute("aria-label", hintLabel());
  el.dataset.tip = hintLabel();
  el.innerHTML = hintMarkup();
  // the mark is not a handle and not the card's: a press on it stays here
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.querySelector(".scroll-hint-x")!.addEventListener("click", (e) => {
    e.stopPropagation();
    save(dismissed(load()));
    put(null);
  });
  mark = el;
  return el;
}

/** show the mark on this card (its positioned frame), or put it away */
function put(on: HTMLElement | null) {
  if (on === host) return;
  window.clearTimeout(leaving);
  host = on;
  if (!on) {
    const el = mark;
    if (!el) return;
    el.classList.remove("is-on");
    leaving = window.setTimeout(() => host === null && el.remove(), 200);
    return;
  }
  const el = element();
  el.classList.remove("is-on");
  on.append(el);
  // a frame so the fade has somewhere to start from
  requestAnimationFrame(() => host === on && el.classList.add("is-on"));
}

/** the positioned frame of the card an element is in: where the mark sits */
function frameOf(el: Element): HTMLElement | null {
  const slot = el.closest<HTMLElement>("[data-obj-id]");
  if (!slot) return null;
  return slot.matches(".hosted-app") ? slot : slot.querySelector<HTMLElement>(".frame-card, .table-card, .map-card");
}

/** whether the card under this element has more in it than fits (somewhere under the pointer, out to the card) */
export function scrollsHere(el: Element): boolean {
  const root = cardRootOf(el);
  return !!root && panesUnder(el, root).length > 0;
}

/** how long the pointer rests on a card before the mark comes up */
const REST = 320;

/**
 * Watch the pointer inside `viewport` (the grid). Returns the way to stop.
 * The pointer's moves only restart a timer; the looking happens once it rests.
 */
export function installScrollHint(viewport: HTMLElement): () => void {
  let timer = 0;
  let x = 0;
  let y = 0;
  let down = false;
  const look = () => {
    if (down || !hintWanted(load()) || document.body.classList.contains("is-carrying")) return put(null);
    const el = document.elementFromPoint(x, y);
    if (!el || !viewport.contains(el)) return put(null);
    if (mark?.contains(el)) return; // on the mark itself: it stays
    const frame = scrollsHere(el) ? frameOf(el) : null;
    put(frame);
  };
  const move = (e: PointerEvent) => {
    x = e.clientX;
    y = e.clientY;
    window.clearTimeout(timer);
    // off the card it's on: it goes at once (after its own short fade); onto one: after a rest
    if (host && !host.contains(e.target as Node)) put(null);
    if (!hintWanted(load())) return;
    timer = window.setTimeout(look, REST);
  };
  const press = (e: PointerEvent) => {
    down = e.type === "pointerdown";
    if (down && !mark?.contains(e.target as Node)) {
      window.clearTimeout(timer);
      put(null);
    }
  };
  const leave = () => {
    window.clearTimeout(timer);
    put(null);
  };
  viewport.addEventListener("pointermove", move, { passive: true });
  viewport.addEventListener("pointerleave", leave);
  window.addEventListener("pointerdown", press, true);
  window.addEventListener("pointerup", press, true);
  window.addEventListener("pointercancel", press, true);
  return () => {
    window.clearTimeout(timer);
    put(null);
    viewport.removeEventListener("pointermove", move);
    viewport.removeEventListener("pointerleave", leave);
    window.removeEventListener("pointerdown", press, true);
    window.removeEventListener("pointerup", press, true);
    window.removeEventListener("pointercancel", press, true);
  };
}

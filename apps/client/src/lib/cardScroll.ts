/**
 * ⌘/Ctrl-wheel scrolls through a card (2026-11-16, Josh: "there needs to be a
 * ctrl+scroll feature to scroll through a card").
 *
 * The plain wheel is still the grid's, everywhere (lib/cardUse.ts). With the
 * modifier held:
 *
 *   - over a card whose content is longer than the card, the wheel scrolls
 *     that content: the nearest scrolling pane under the pointer that has
 *     room that way, then the ones around it, inside the card;
 *   - at the end of it the wheel is held (nothing moves) for as long as the
 *     turning goes on, so reaching the end of a list never lurches into a
 *     zoom; after a beat of quiet it zooms the grid again;
 *   - over the paper, or a card with nothing to scroll, it zooms the grid as
 *     it always has.
 *
 * A trackpad pinch arrives as a Ctrl-wheel nobody is holding a key for: that
 * is always the grid's zoom (`keyHeld`). Live pages are a separate case: the
 * wheel can't be handed into a frame from here, so they need "in use".
 */

/** what the rule needs to know about a scrolling pane */
export interface Pane {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/** how long after the last scroll (or held turn) the wheel at a card's end goes back to zooming the grid */
export const BEAT = 350;

/** content longer (or wider) than its pane by more than a rounding pixel */
export const overflows = (p: Pane) => p.scrollHeight - p.clientHeight > 1 || p.scrollWidth - p.clientWidth > 1;

/** whether a pane can still move by this much (a pixel of slack for fractional sizes) */
export function hasRoom(p: Pane, dx: number, dy: number): boolean {
  if (dy < 0 && p.scrollTop > 0.5) return true;
  if (dy > 0 && p.scrollTop + p.clientHeight < p.scrollHeight - 1) return true;
  if (dx < 0 && p.scrollLeft > 0.5) return true;
  if (dx > 0 && p.scrollLeft + p.clientWidth < p.scrollWidth - 1) return true;
  return false;
}

export type Verdict = { do: "scroll"; pane: number } | { do: "hold" } | { do: "zoom" };

/**
 * What a modifier-wheel over a card does. `panes` are the card's scrolling
 * panes under the pointer, nearest first (only ones whose content overflows);
 * `quietFor` is how long since this card last scrolled or held a turn.
 */
export function wheelVerdict(panes: readonly Pane[], dx: number, dy: number, quietFor: number): Verdict {
  if (!panes.length) return { do: "zoom" };
  const pane = panes.findIndex((p) => hasRoom(p, dx, dy));
  if (pane >= 0) return { do: "scroll", pane };
  return quietFor < BEAT ? { do: "hold" } : { do: "zoom" };
}

/** wheel deltas in pixels (a line is 16 px, a page is the pane), with ⇧ turning the wheel sideways */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }, page = 600): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page : 1;
  let dx = e.deltaX * unit;
  let dy = e.deltaY * unit;
  if (e.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  return { dx, dy };
}

// ---------- in the page ----------

const SCROLLS = /^(auto|scroll)$/;

/** the card's scrolling panes from `target` out to (and including) `card`, nearest first */
export function panesUnder(target: Element, card: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el instanceof HTMLElement && (el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1)) {
      const cs = getComputedStyle(el);
      const y = SCROLLS.test(cs.overflowY) && el.scrollHeight - el.clientHeight > 1;
      const x = SCROLLS.test(cs.overflowX) && el.scrollWidth - el.clientWidth > 1;
      if (x || y) out.push(el);
    }
    if (el === card) break;
  }
  return out;
}

// a mouse wheel's step glides to where it's going (the browser's own smooth wheel, which we've taken over);
// a trackpad's small deltas follow the fingers 1:1
const glides = new WeakMap<HTMLElement, { x: number; y: number; raf: number }>();
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function scrollPane(el: HTMLElement, dx: number, dy: number, direct: boolean) {
  const maxX = el.scrollWidth - el.clientWidth;
  const maxY = el.scrollHeight - el.clientHeight;
  const g = glides.get(el);
  const x = Math.max(0, Math.min(maxX, (g?.x ?? el.scrollLeft) + dx));
  const y = Math.max(0, Math.min(maxY, (g?.y ?? el.scrollTop) + dy));
  if (direct || still()) {
    if (g) cancelAnimationFrame(g.raf);
    glides.delete(el);
    el.scrollLeft = x;
    el.scrollTop = y;
    return;
  }
  const next = g ?? { x, y, raf: 0 };
  next.x = x;
  next.y = y;
  if (g) return;
  glides.set(el, next);
  const step = () => {
    const ex = next.x - el.scrollLeft;
    const ey = next.y - el.scrollTop;
    if (!el.isConnected || (Math.abs(ex) < 1 && Math.abs(ey) < 1)) {
      el.scrollLeft = next.x;
      el.scrollTop = next.y;
      glides.delete(el);
      return;
    }
    // a third of what's left each frame, and never less than a pixel (scroll positions are whole pixels)
    el.scrollLeft += Math.abs(ex) < 1 ? ex : Math.sign(ex) * Math.max(1, Math.abs(ex) * 0.34);
    el.scrollTop += Math.abs(ey) < 1 ? ey : Math.sign(ey) * Math.max(1, Math.abs(ey) * 0.34);
    next.raf = requestAnimationFrame(step);
  };
  next.raf = requestAnimationFrame(step);
}

/** where a pane is going (mid-glide) rather than where it is this frame */
function heading(el: HTMLElement): Pane {
  const g = glides.get(el);
  return { scrollTop: g?.y ?? el.scrollTop, scrollLeft: g?.x ?? el.scrollLeft, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
}

const lastAt = new WeakMap<Element, number>();

/**
 * A modifier-wheel over the grid: true when the card under the pointer took
 * it (scrolled, or held at its end), false when it's the grid's to zoom with.
 * `keyHeld` is whether a person is really holding ⌘/Ctrl (a pinch isn't).
 */
export function cardWheel(e: WheelEvent, keyHeld: boolean): boolean {
  if (!keyHeld) return false;
  const target = e.target instanceof Element ? e.target : null;
  const card = target?.closest<HTMLElement>(".frame-body, .panel-body, .map-body-wrap, .table-card, .hosted-app");
  if (!target || !card) return false;
  const panes = panesUnder(target, card);
  const { dx, dy } = wheelPixels(e, card.clientHeight);
  if (!dx && !dy) return panes.length > 0;
  const now = performance.now();
  const verdict = wheelVerdict(panes.map(heading), dx, dy, now - (lastAt.get(card) ?? -Infinity));
  if (verdict.do === "zoom") return false;
  lastAt.set(card, now);
  if (verdict.do === "scroll") scrollPane(panes[verdict.pane], dx, dy, e.deltaMode === 0 && Math.abs(dx) + Math.abs(dy) < 40);
  return true;
}

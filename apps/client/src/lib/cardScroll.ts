/**
 * Alt-wheel scrolls through a card (2026-11-17, Josh: "Ctrl Zoom should always
 * zoom and alt+scroll should scroll a card"; before that, for a day, it was
 * ⌘/Ctrl-wheel, which made the zoom key do two things).
 *
 * The plain wheel is the grid's, everywhere, and ⌘/Ctrl-wheel always zooms it
 * (lib/cardUse.ts). With Alt (⌥) held:
 *
 *   - over a card whose content is longer than the card, the wheel scrolls
 *     that content: the nearest scrolling pane under the pointer that has
 *     room that way, then the ones around it, inside the card; ⇧ turns it
 *     sideways;
 *   - at the end of it the wheel is held (nothing moves): Alt means the card,
 *     so reaching the end of a list never lurches into a pan of the grid;
 *   - over the paper, or a card with nothing to scroll, Alt changes nothing:
 *     the wheel pans the grid as it does without it.
 *
 * Live pages are a separate case: the wheel can't be handed into a frame from
 * here, so they need "in use". The mark that says all this on a card with
 * more than fits is lib/scrollHint.ts.
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

export type Verdict = { do: "scroll"; pane: number } | { do: "hold" } | { do: "pass" };

/**
 * What an Alt-wheel over a card does. `panes` are the card's scrolling panes
 * under the pointer, nearest first (only ones whose content overflows).
 * `pass`: there's nothing here to scroll, so the wheel is the grid's.
 */
export function wheelVerdict(panes: readonly Pane[], dx: number, dy: number): Verdict {
  if (!panes.length) return { do: "pass" };
  const pane = panes.findIndex((p) => hasRoom(p, dx, dy));
  return pane >= 0 ? { do: "scroll", pane } : { do: "hold" };
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

/** what of a card scrolls: the root the panes are looked for in */
export const CARD_ROOT = ".frame-body, .panel-body, .map-body-wrap, .table-card, .hosted-app";

/** the card's scrolling root an element is in, if it's in one */
export const cardRootOf = (el: Element | null) => el?.closest<HTMLElement>(CARD_ROOT) ?? null;

/**
 * An Alt-wheel over the grid: true when the card under the pointer took it
 * (scrolled, or held at its end), false when there is nothing there to scroll
 * and the wheel is the grid's. `onScroll` hears each wheel that scrolled.
 */
export function cardWheel(e: WheelEvent, onScroll?: () => void): boolean {
  const target = e.target instanceof Element ? e.target : null;
  const card = cardRootOf(target);
  if (!target || !card) return false;
  const panes = panesUnder(target, card);
  const { dx, dy } = wheelPixels(e, card.clientHeight);
  if (!dx && !dy) return panes.length > 0;
  const verdict = wheelVerdict(panes.map(heading), dx, dy);
  if (verdict.do === "pass") return false;
  if (verdict.do === "scroll") {
    scrollPane(panes[verdict.pane], dx, dy, e.deltaMode === 0 && Math.abs(dx) + Math.abs(dy) < 40);
    onScroll?.();
  }
  return true;
}

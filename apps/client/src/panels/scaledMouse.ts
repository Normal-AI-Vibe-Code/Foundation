/**
 * Mouse events for a widget that measures in its own unscaled pixels (xterm),
 * drawn inside the board's scaled world (camera zoom × the section's fit).
 * xterm turns clientX/Y into a cell with getBoundingClientRect (scaled) and its
 * cell size (unscaled), so at 50 % a drag selected from the wrong place: twice
 * as far from the corner as the pointer (#53). Here each mouse event bound for
 * the widget is caught on its way down and sent on with the pointer's place
 * expressed in the widget's own pixels, which is what xterm assumes.
 *
 * mousedown, click and dblclick inside the widget; mousemove and mouseup on
 * the whole page while a press that began inside is held (xterm follows a
 * selection drag on the document). Typing, wheel and touch are untouched.
 */

/** where the pointer is in the widget's unscaled pixels, as client coordinates xterm will read */
export function unscaledPoint(clientX: number, clientY: number, rect: { left: number; top: number }, scale: number) {
  return { x: rect.left + (clientX - rect.left) / scale, y: rect.top + (clientY - rect.top) / scale };
}

/** the scale a node is drawn at: its box on screen against its own layout width */
export function drawnScaleOf(node: HTMLElement): number {
  const w = node.offsetWidth;
  return w ? node.getBoundingClientRect().width / w : 1;
}

const RESENT = new WeakSet<Event>();

export function unscaleMouse(node: HTMLElement): () => void {
  let held = false;
  const resend = (e: MouseEvent) => {
    if (RESENT.has(e)) return;
    const scale = drawnScaleOf(node);
    if (Math.abs(scale - 1) < 0.002) return;
    const rect = node.getBoundingClientRect();
    const p = unscaledPoint(e.clientX, e.clientY, rect, scale);
    const again = new MouseEvent(e.type, {
      bubbles: e.bubbles,
      cancelable: e.cancelable,
      composed: e.composed,
      view: e.view,
      detail: e.detail,
      screenX: e.screenX,
      screenY: e.screenY,
      clientX: p.x,
      clientY: p.y,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      button: e.button,
      buttons: e.buttons,
      relatedTarget: e.relatedTarget,
    });
    RESENT.add(again);
    e.stopImmediatePropagation();
    // The real press is spent here too. xterm takes the caret on the press it is handed (the one sent
    // on below) and cancels that one; left alone, the real press then did what a press on plain page
    // does and moved focus to the page, so the terminal lost the keys the moment it got them: at any
    // zoom but 100 % a click never let you type (2026-11-15).
    e.preventDefault();
    (e.target ?? node).dispatchEvent(again);
  };
  const onDown = (e: MouseEvent) => {
    if (!node.contains(e.target as Node)) return;
    held = true;
    resend(e);
  };
  const onInside = (e: MouseEvent) => {
    if (node.contains(e.target as Node)) resend(e);
  };
  const onMove = (e: MouseEvent) => {
    if (held) resend(e);
  };
  const onUp = (e: MouseEvent) => {
    if (!held) return;
    held = false;
    resend(e);
  };
  // capture on the window: before xterm's own listeners on its element and the document
  const opts = { capture: true } as const;
  window.addEventListener("mousedown", onDown, opts);
  window.addEventListener("click", onInside, opts);
  window.addEventListener("dblclick", onInside, opts);
  window.addEventListener("mousemove", onMove, opts);
  window.addEventListener("mouseup", onUp, opts);
  return () => {
    window.removeEventListener("mousedown", onDown, opts);
    window.removeEventListener("click", onInside, opts);
    window.removeEventListener("dblclick", onInside, opts);
    window.removeEventListener("mousemove", onMove, opts);
    window.removeEventListener("mouseup", onUp, opts);
  };
}

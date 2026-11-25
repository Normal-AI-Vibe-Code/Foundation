/**
 * What the wheel does on the grid (2026-11-18, Josh: "The default behavior for the scroll wheel should be
 * zoom instead of scroll"; 2026-11-24, Josh: "scroll wheel should just be zoom in the grid").
 *
 * The wheel **zooms** the grid around the pointer, whatever sent it. The paper is moved by dragging it (or
 * the middle or right button, or Space), and Shift+wheel slides it sideways. ⌘/Ctrl-wheel zooms as it always
 * did, and Alt-wheel still scrolls the card under the pointer (lib/cardScroll.ts).
 *
 * Nothing guesses whether an event came from a mouse or a trackpad any more: the guess (small or fractional
 * steps meant fingers, which panned) took a wheel on a scaled display, or a high-resolution one, for a
 * trackpad, and the wheel panned. Two fingers on a trackpad zoom like a wheel; a pinch zooms as before.
 *
 * Settings → General has the other choice (the wheel pans, as it did before), kept on this device.
 */

export type WheelMode = "zoom" | "pan";
const KEY = "foundation-wheel";

export function wheelMode(): WheelMode {
  try {
    return localStorage.getItem(KEY) === "pan" ? "pan" : "zoom";
  } catch {
    return "zoom";
  }
}
export function setWheelMode(m: WheelMode) {
  try {
    localStorage.setItem(KEY, m);
  } catch { /* private window */ }
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** what one wheel event does to the grid */
export function wheelAction(e: WheelLike, mode: WheelMode): "zoom" | "pan" {
  if (e.ctrlKey || e.metaKey) return "zoom"; // the zoom key, and a trackpad's pinch
  if (mode === "pan" || e.shiftKey) return "pan";
  // a tilt wheel, or a wheel the system turned sideways: there is no zoom in it
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return "pan";
  return "zoom";
}

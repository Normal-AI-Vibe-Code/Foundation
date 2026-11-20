/**
 * What the wheel does on the grid (2026-11-18, Josh: "The default behavior for the scroll wheel should be
 * zoom instead of scroll").
 *
 * A mouse wheel **zooms** the grid around the pointer. The paper is moved by dragging it (or the middle or
 * right button, or Space), and Shift+wheel slides it sideways. ⌘/Ctrl-wheel zooms as it always did, and
 * Alt-wheel still scrolls the card under the pointer (lib/cardScroll.ts).
 *
 * A trackpad is not a wheel: two fingers moving on it still **pan** (and a pinch zooms), because that is what
 * the gesture means there. The two are told apart once, at the start of a gesture, and the answer holds until
 * the wheel has been quiet for a moment, so a gesture never changes its mind half way.
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

/** how long the wheel must rest before the next event starts a new gesture */
export const GESTURE_GAP_MS = 180;
/** a wheel notch is 100 px or more in every browser here (a line-mode wheel is in lines); a trackpad starts small */
const PAD_FIRST_MAX = 30;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** does a gesture that starts with this event come from a trackpad (two fingers), not a wheel? */
export function startsOnTrackpad(e: WheelLike): boolean {
  if (e.deltaMode !== 0) return false; // lines or pages: a wheel
  const ax = Math.abs(e.deltaX);
  const ay = Math.abs(e.deltaY);
  if (ax === 0 && ay === 0) return false;
  // small, or not whole pixels, or moving both ways at once: fingers
  return Math.max(ax, ay) < PAD_FIRST_MAX || !Number.isInteger(e.deltaY) || !Number.isInteger(e.deltaX) || (ax > 0 && ay > 0);
}

/** what one wheel event does to the grid, given what its gesture started as */
export function wheelAction(e: WheelLike, mode: WheelMode, trackpad: boolean): "zoom" | "pan" {
  if (e.ctrlKey || e.metaKey) return "zoom"; // the zoom key, and a trackpad's pinch
  if (mode === "pan" || trackpad || e.shiftKey) return "pan";
  // a tilt wheel, or a wheel the system turned sideways: there is no zoom in it
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return "pan";
  return "zoom";
}

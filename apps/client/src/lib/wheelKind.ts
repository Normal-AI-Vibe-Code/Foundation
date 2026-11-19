/**
 * What a wheel event is (2026-11-17, Josh: "Scroll wheel should be zoom in Foundation"; and, asked how a
 * trackpad should behave: "Mouse zooms, trackpad pans"). A browser gives both as `wheel` events, so the
 * kind is read off the event's shape, a gesture at a time:
 *
 *   - a **mouse wheel** clicks in whole steps on one axis: lines (Firefox), or pixels in big integer steps
 *     (Chromium sends 100 or 120 a notch, times the display's scale), with no sideways part;
 *   - a **trackpad** scrolls in small, often fractional pixel steps, usually with some sideways part;
 *   - a **pinch** on a trackpad arrives as Ctrl+wheel with small steps (the browser sets ctrlKey itself).
 *
 * Once a gesture has looked like a trackpad it stays one until the wheel rests (GAP_MS), so the first
 * big flick of a two-finger swipe doesn't zoom. Shift+wheel pans (sideways, as a browser does it).
 */

export type WheelKind = "zoom-mouse" | "zoom-pinch" | "pan";

/** a pause this long ends a gesture */
export const GAP_MS = 240;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  timeStamp: number;
}

export interface WheelMemory {
  last: number;
  trackpad: boolean;
}

export const wheelMemory = (): WheelMemory => ({ last: -Infinity, trackpad: false });

/** whether one event looks like a trackpad's (small or fractional steps, or a sideways part) */
export function looksLikeTrackpad(e: Pick<WheelLike, "deltaX" | "deltaY" | "deltaMode">): boolean {
  if (e.deltaMode !== 0) return false; // lines or pages: a mouse wheel
  const ax = Math.abs(e.deltaX);
  const ay = Math.abs(e.deltaY);
  if (ax > 0 && ay > 0) return true;
  const d = ax || ay;
  if (d === 0) return false;
  return d < 50 || !Number.isInteger(d);
}

/** the kind of this event, remembering the gesture it belongs to */
export function wheelKind(e: WheelLike, mem: WheelMemory): WheelKind {
  const fresh = e.timeStamp - mem.last > GAP_MS;
  mem.last = e.timeStamp;
  if (fresh) mem.trackpad = false;
  if (e.ctrlKey || e.metaKey) {
    // a pinch (small Ctrl+wheel steps, the browser's) follows the fingers; a mouse wheel held with Ctrl zooms in steps
    return e.deltaMode === 0 && Math.abs(e.deltaY) < 40 ? "zoom-pinch" : "zoom-mouse";
  }
  // Shift+wheel, and a wheel that only goes sideways (a tilt wheel, Shift on Windows), pans
  if (e.shiftKey || (e.deltaY === 0 && e.deltaX !== 0)) return "pan";
  if (looksLikeTrackpad(e)) mem.trackpad = true;
  return mem.trackpad ? "pan" : "zoom-mouse";
}

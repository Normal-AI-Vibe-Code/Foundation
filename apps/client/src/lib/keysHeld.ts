/**
 * Keys that belong to something outside Foundation: a machine's shell or its
 * desktop (2026-11-15, Josh: "I can't actually type into the VM when focused
 * on the object"). While the caret is in one, the app's own shortcuts stand
 * down — Ctrl+W, Ctrl+U, Ctrl+L and Ctrl+K are the shell's (delete a word,
 * clear the line, clear the screen, cut to the end), not close-a-space,
 * upload, and the command bar — and so does the talk sheet's early-key catch.
 *
 * The element that takes the keys carries `data-holds-keys`; the shell's key
 * handler and the talk sheet ask `holdsKeys(e.target)` first. The one way out
 * is Esc twice (a single Esc is the machine's: vi needs it), or a click
 * anywhere else.
 */

export const HOLDS_KEYS = "data-holds-keys";

/** whether a key event's target sits in something that holds the keyboard for a machine */
export function holdsKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${HOLDS_KEYS}]`) !== null;
}

/** two presses of Esc this close together leave the machine */
export const LEAVE_MS = 500;

/**
 * Watches Esc on its way to the machine: the second of two within LEAVE_MS
 * calls `leave`. Both still reach the machine (an extra Esc is harmless
 * there). Returns the handler to feed each keydown.
 */
export function escEscToLeave(leave: () => void, now: () => number = () => performance.now()) {
  let last = -Infinity;
  return (e: { key: string; repeat?: boolean }) => {
    if (e.key !== "Escape") {
      last = -Infinity;
      return false;
    }
    if (e.repeat) return false;
    const t = now();
    if (t - last <= LEAVE_MS) {
      last = -Infinity;
      leave();
      return true;
    }
    last = t;
    return false;
  };
}

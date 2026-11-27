/**
 * The ping's sound (2026-11-27, Josh: "referencing someone in chat pings them with a sound"): two soft notes, drawn
 * with Web Audio (no file to fetch), when something is said to me and I'm not looking at it. On by default, kept per
 * device (Settings → General turns it off). A burst (a reconnect bringing several) sounds once.
 */

import { useSyncExternalStore } from "react";

const KEY = "chatform-sound";
const subs = new Set<() => void>();

export function soundOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSound(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch { /* private window */ }
  subs.forEach((f) => f());
}

export function useSound(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    soundOn,
  );
}

let ctx: AudioContext | null = null;
let last = 0;
/** how close two pings may sound */
export const PING_GAP_MS = 1500;

/** play it (when on, and not just played); `force` for Settings' Try it */
export function playPing(force = false) {
  if (!force && !soundOn()) return false;
  const now = Date.now();
  if (!force && now - last < PING_GAP_MS) return false;
  last = now;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 0.16;
    out.connect(ctx.destination);
    // a rising fifth: E6 then B6, each a quick strike and a soft ring
    for (const [i, f] of [1318.5, 1975.5].entries()) {
      const at = t0 + i * 0.11;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(1, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + 0.45);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Which engine draws the board: the web renderer (React and the DOM, the
 * default, and the one everything is built against) or Rune
 * (github.com/anomalyco/rune: a GPU renderer with its own layout, text and
 * springs, built from apps/rune to wasm and drawn through WebGPU).
 *
 * Rune runs beside the web renderer, never instead of it. The choice is this
 * device's (Settings → Renderer); when Rune can't run here (no WebGPU, no
 * build), the board falls back to the web renderer and says why.
 */

import { useSyncExternalStore } from "react";

export type Engine = "web" | "rune";

export interface RuneBuild {
  /** the Rune revision it was built against */
  rune: string;
  profile: string;
  bytes: number;
  builtAt: string;
}

export interface RuneStatus {
  /** off: the web renderer is drawing · loading · ready: Rune is drawing · failed: it couldn't, and the web renderer is */
  state: "off" | "loading" | "ready" | "failed";
  /** why it failed, in words a person can act on */
  reason?: string;
  build?: RuneBuild;
}

const KEY = "foundation-engine";

function stored(): Engine {
  try {
    // ?engine=rune (or web) picks for this page load without remembering it: links, checks, e2e
    const q = new URLSearchParams(window.location.search).get("engine");
    if (q === "rune" || q === "web") return q;
    return localStorage.getItem(KEY) === "rune" ? "rune" : "web";
  } catch {
    return "web";
  }
}

let engine: Engine = typeof window === "undefined" ? "web" : stored();
let status: RuneStatus = { state: "off" };
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getEngine = () => engine;
export const getRuneStatus = () => status;

export function setEngine(next: Engine) {
  if (next === engine) return;
  engine = next;
  status = { state: "off", build: status.build };
  try {
    localStorage.setItem(KEY, next);
  } catch { /* private window */ }
  tell();
}

export function setRuneStatus(next: RuneStatus) {
  status = { build: status.build, ...next };
  tell();
}

export const useEngine = () => useSyncExternalStore(subscribe, getEngine);
export const useRuneStatus = () => useSyncExternalStore(subscribe, getRuneStatus);

/** Rune is the one drawing (or about to): chosen, and not failed */
export const runeDrawing = (e: Engine = engine, s: RuneStatus = status) => e === "rune" && s.state !== "failed";
export function useRuneDrawing(): boolean {
  const e = useEngine();
  const s = useRuneStatus();
  return runeDrawing(e, s);
}

/** can this browser (or the desktop app's webview) run it at all? */
export function webgpuHere(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

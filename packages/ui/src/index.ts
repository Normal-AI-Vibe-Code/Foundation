/**
 * @foundation/ui — design tokens in TypeScript (for canvas/WebGL surfaces
 * that can't read CSS), the night engine, and the motion constants.
 * DESIGN.md is the contract.
 */

export const paper = {
  void: "#f6f3ec",
  abyss: "#fcfbf7",
  panel: "#efece3",
  raise: "#ffffff",
  frost: "#201e19",
  mist: "#5f5b51",
  dim: "#8a8577",
  pulse: "#325bb4",
  volt: "#27488f",
  moss: "#2e5d43",
  ok: "#2e7d54",
  warn: "#a16207",
  bad: "#b3261e",
  agent: "#6b5bd6",
} as const;

/** night is greys and white, with yellow (attention) and orange (broken) the only pops; agents stay violet */
export const night = {
  void: "#0f0f10",
  abyss: "#171718",
  panel: "#131314",
  raise: "#1f1f21",
  frost: "#ededed",
  mist: "#a3a3a3",
  dim: "#6f6f6f",
  pulse: "#f2f2f2",
  volt: "#c4c4c4",
  moss: "#8c8c8c",
  ok: "#d9d9d9",
  warn: "#f5c542",
  bad: "#f27a3a",
  agent: "#8f76ee",
} as const;

export const viz = {
  day: ["#325bb4", "#c07a10", "#2e7d54", "#6b5bd6", "#1f8f9c", "#b3476e", "#64748b", "#8b7ae6"],
  night: ["#3f97d6", "#c97a1c", "#27a877", "#8f76ee", "#2ab0be", "#d8628f", "#8ea0b8", "#b39cff"],
} as const;

/** Spring presets (stiffness, damping, mass) — shared with Vision's motion.ts. */
export const springs = {
  camera: { stiffness: 170, damping: 26, mass: 1 },
  pop: { stiffness: 260, damping: 20, mass: 1 },
  drag: { stiffness: 550, damping: 38, mass: 1 },
  soft: { stiffness: 90, damping: 22, mass: 1 },
  /** presentation-mode glide: long, no overshoot */
  glide: { stiffness: 120, damping: 24, mass: 1 },
} as const;

export const durations = { press: 80, quick: 160, pane: 280, lift: 350, rise: 800, delightMax: 600 } as const;
export const easings = {
  outSoft: [0.22, 1, 0.36, 1],
  move: [0.2, 0.8, 0.2, 1],
  spring: [0.22, 1.4, 0.36, 1],
  settle: [0.22, 1.3, 0.36, 1],
} as const;

// ---------- night engine, and themes ----------
//
// A theme is the look the interface wears for what is in focus (DESIGN.md §2.1). The place decides:
// Today wears the room; a grid or an app wears its own (a grid may pin day or night), and everything
// else wears paper, which follows the orb. Night stays one engine: a theme may pin it, and
// `isNight()` / `onNight` always say what is actually showing. Surfaces that can't read CSS
// (a terminal's colours, a canvas) listen to `onLook`, which fires whenever any token may have changed.

const KEY = "foundation-night";
type Listener = (isNight: boolean) => void;
const listeners = new Set<Listener>();
const lookListeners = new Set<() => void>();

export type ThemeId = "paper" | "day" | "night" | "room";
export const THEMES: Record<ThemeId, { name: string; what: string }> = {
  paper: { name: "Paper", what: "Paper by day, graphite by night: it follows the orb" },
  day: { name: "Always day", what: "Paper, whatever the orb says" },
  night: { name: "Always night", what: "Graphite, whatever the orb says" },
  room: { name: "The room", what: "Clear panes and white type over a picture: Today" },
};
export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && Object.prototype.hasOwnProperty.call(THEMES, v);

/** what the person chose with the orb (or the OS did, the first time) */
let chosen = false;
let themeId: ThemeId = "paper";

function apply() {
  const root = document.documentElement;
  const was = root.classList.contains("is-night");
  const wasTheme = root.dataset.theme ?? "paper";
  const on = themeId === "day" ? false : themeId === "night" ? true : chosen;
  root.classList.toggle("is-night", on);
  root.dataset.theme = themeId;
  if (on !== was) for (const fn of listeners) fn(on);
  if (on !== was || wasTheme !== themeId) for (const fn of lookListeners) fn();
}

/** night as it shows now (a theme may have pinned it) */
export function isNight(): boolean {
  return document.documentElement.classList.contains("is-night");
}

export function setNight(on: boolean, persist = true) {
  chosen = on;
  if (persist) {
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* private mode */
    }
  }
  apply();
}

export function onNight(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** the theme the interface wears now */
export function theme(): ThemeId {
  return themeId;
}
/** wear a theme (the shell does, for the place in focus) */
export function setTheme(id: ThemeId) {
  if (id === themeId) return;
  themeId = id;
  apply();
}
/** the look changed: the theme, or day and night. For what resolves tokens by hand (xterm, a canvas) */
export function onLook(fn: () => void): () => void {
  lookListeners.add(fn);
  return () => lookListeners.delete(fn);
}
/** is night pinned by the theme (the orb's choice waits until the theme lets go) */
export function nightPinned(): boolean {
  return themeId === "day" || themeId === "night";
}

/** what was chosen: day, night, or nothing yet (the app follows the system until the orb or Settings says otherwise) */
export function nightChoice(): "day" | "night" | "system" {
  try {
    const v = localStorage.getItem(KEY);
    return v === "1" ? "night" : v === "0" ? "day" : "system";
  } catch {
    return "system";
  }
}

/** choose day or night for good, or go back to following the system */
export function chooseNight(choice: "day" | "night" | "system") {
  if (choice !== "system") return setNight(choice === "night");
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
  setNight(window.matchMedia("(prefers-color-scheme: dark)").matches, false);
}

/** First launch follows the OS; after that the orb's choice is remembered. */
export function initNight() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  const on = stored === null ? window.matchMedia("(prefers-color-scheme: dark)").matches : stored === "1";
  setNight(on, false);
}

/**
 * The timelines open in this window (docs/timeline.md §3): the grid's, and any number of sections'. Each has its
 * range (hour · day · week · all), a playhead (null is now), playing and its speed, the slice the server answered
 * (`GET /api/boards/:id/timeline` → TimelineSlice) and the history to scrub (`GET /api/boards/:id/history` → a
 * take's "FRT1" bytes, played by `TakePlayer`). Fetched when opened and when the range changes (debounced, the
 * last one aborted), refreshed quietly while it sits at now.
 *
 * A section follows the grid's playhead until its own bar is scrubbed while the grid's is open; then it is
 * detached (its own moment) until *Follow the grid* or closing (logic.ts sectionMoment).
 *
 * The playhead is not React state: a scrub moves it on every pointer move, and only what is cheap listens that
 * often (`onMove`: the playhead's line, the time in words). Everything else hears it at most once a frame
 * (`subscribe`), and the sections drawn as they were redraw only when a change or a cursor sample is crossed.
 *
 * Reading the past never writes the board: these are GETs, and the board document is never touched.
 */

import { useSyncExternalStore } from "react";
import { decodeTake, TakePlayer, type HistoryHead, type TimelineSlice } from "@foundation/protocol";
import { ApiError, api, fetchFile } from "../lib/api";
import { activeBoard, onBoardChange } from "../sync/board";
import { hostOf } from "../state/store";
import { clampT, openingRange, playRate, rangeBounds, sectionMoment, type Range } from "./logic";

// ---------- the playhead ----------

export class Playhead {
  /** null: now */
  t: number | null = null;
  playing = false;
  speed = 1;
  /** where it may go, kept by its timeline */
  window = { from: 0, to: 0, start: null as number | null };
  private moves = new Set<() => void>();
  private subs = new Set<() => void>();
  private frame = 0;
  private raf = 0;
  private last = 0;
  /** bumps on every change (useSyncExternalStore keys) */
  version = 0;

  /** told at once, on every move: only for what is cheap (a line's transform, a label's text) */
  onMove = (fn: () => void) => {
    this.moves.add(fn);
    return () => void this.moves.delete(fn);
  };
  /** told at most once a frame */
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };
  private changed() {
    this.version++;
    for (const f of this.moves) f();
    if (this.frame) return;
    const run = () => {
      this.frame = 0;
      for (const f of this.subs) f();
    };
    // a hidden page has no frames: tell them now (raf-less panes, tests)
    if (typeof requestAnimationFrame === "undefined" || (typeof document !== "undefined" && document.hidden)) run();
    else this.frame = requestAnimationFrame(run);
  }
  seek(t: number | null) {
    const w = this.window;
    const next = t === null ? null : clampT(t, w.from, w.to, w.start);
    if (next === this.t) return;
    this.t = next;
    this.last = performance.now();
    if (next === null && this.playing) this.stopPlaying();
    this.changed();
  }
  private tick = (now: number) => {
    if (!this.playing) return;
    const w = this.window;
    const dt = now - this.last;
    this.last = now;
    const from = this.t ?? Math.max(w.from, w.start ?? w.from);
    const next = from + dt * playRate(w.to - w.from, this.speed);
    if (next >= w.to) {
      this.t = w.to;
      this.playing = false;
    } else this.t = next;
    this.changed();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  };
  play() {
    if (this.playing) return;
    const w = this.window;
    // from now (or the end), playing starts at the range's beginning
    if (this.t === null || this.t >= w.to - 1) this.t = Math.max(w.from, w.start ?? w.from);
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.changed();
  }
  private stopPlaying() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }
  pause() {
    if (!this.playing) return;
    this.stopPlaying();
    this.changed();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  setSpeed(s: number) {
    this.speed = s;
    this.changed();
  }
  destroy() {
    this.stopPlaying();
    cancelAnimationFrame(this.frame);
    this.moves.clear();
    this.subs.clear();
  }
}

// ---------- a timeline ----------

export type Load = "loading" | "ok" | "missing" | "error";

export interface Timeline {
  key: string;
  /** "grid": the open grid's; "section": a section's (its own bar) */
  scope: "grid" | "section";
  sectionId: string | null;
  /** the board whose timeline this is: the open grid, or the grid a section stands for */
  board: string;
  /** `?section=` asked of it: a plain section's; null for a grid (and for a section that is a grid) */
  section: string | null;
  /** a section that is a grid of its own: that grid's name ("<name>'s own timeline") */
  childName: string | null;
  range: Range;
  head: Playhead;
  /** a section scrubbed on its own while the grid's is open */
  detached: boolean;
  /** the window drawn: from..to */
  from: number;
  to: number;
  slice: TimelineSlice | null;
  sliceState: Load;
  sliceWhy: string | null;
  player: TakePlayer | null;
  historyHead: HistoryHead | null;
  historyState: Load | "idle";
  historyWhy: string | null;
  /** the server's clock less this one's (slice.now) */
  skew: number;
  /** opening: the range is chosen once the grid's age is known (logic.ts openingRange) */
  auto?: boolean;
}

const open = new Map<string, Timeline>();
const subs = new Set<() => void>();
let version = 0;
function emit() {
  version++;
  for (const f of subs) f();
}
function patch(key: string, p: Partial<Timeline>) {
  const tl = open.get(key);
  if (!tl) return;
  open.set(key, { ...tl, ...p });
  emit();
}

export const GRID = "grid";
export const sectionKey = (id: string) => `s:${id}`;
export const getTimeline = (key: string) => open.get(key) ?? null;
export const openTimelines = () => [...open.values()];

export function subscribeTimelines(fn: () => void) {
  subs.add(fn);
  return () => void subs.delete(fn);
}
/** re-render when a timeline opens, closes, loads or changes range (not when a playhead moves) */
export function useTimelines(): number {
  return useSyncExternalStore(subscribeTimelines, () => version);
}
export function useTimeline(key: string): Timeline | null {
  useTimelines();
  return open.get(key) ?? null;
}
/** re-render when the playhead crosses a `step` ms boundary, plays, pauses or changes speed */
export function usePlayhead(head: Playhead | null | undefined, step = 1000) {
  useSyncExternalStore(
    (f) => (head ? head.subscribe(f) : () => {}),
    () => (head ? `${head.t === null ? "now" : Math.floor(head.t / Math.max(1, step))}|${head.playing}|${head.speed}` : "-"),
  );
  return head;
}

// ---------- fetching ----------

const ctrls = new Map<string, AbortController>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const refreshers = new Map<string, ReturnType<typeof setInterval>>();

const enc = encodeURIComponent;

/** in words, what went wrong; a 404 from a server that has no timeline yet says so plainly */
function why(e: unknown, what: "timeline" | "history"): { state: Load; why: string } {
  if (e instanceof ApiError && e.status === 404)
    return { state: "missing", why: what === "timeline" ? "This server keeps no timeline for this grid. It may be older than this app (update the server), or the grid isn't one you can see." : "This server doesn't keep this grid's history, so its past can't be drawn." };
  if (e instanceof ApiError && e.status === 403) return { state: "error", why: "This grid's past isn't yours to read." };
  return { state: "error", why: (e as Error)?.message || `The ${what} didn't load.` };
}

/** history last fetched, per timeline; and the ones whose events are newer than their history */
const historyAt = new Map<string, number>();
const behind = new Set<string>();
/** while at now, the history (up to tens of MB on a big grid) is fetched again at most this often; scrubbing catches it up */
const HISTORY_EVERY_MS = 10_000;

async function load(key: string, quiet = false, history = true) {
  const tl0 = open.get(key);
  if (!tl0) return;
  ctrls.get(key)?.abort();
  const ctrl = new AbortController();
  ctrls.set(key, ctrl);
  const now = Date.now() + tl0.skew;
  let { from, to } = rangeBounds(tl0.range, now, tl0.slice?.start);
  if (!quiet) patch(key, { sliceState: tl0.slice ? tl0.sliceState : "loading", historyState: "loading", from, to });
  const base = `/api/boards/${enc(tl0.board)}`;
  let slice: TimelineSlice;
  try {
    // a range ends now: the server's now (no `to`), so this computer's clock running ahead never asks for the future
    slice = await api<TimelineSlice>(`${base}/timeline?from=${Math.max(0, Math.floor(from))}&limit=2000${tl0.section ? `&section=${enc(tl0.section)}` : ""}`, { signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError" || ctrl.signal.aborted) return;
    const w = why(e, "timeline");
    patch(key, { sliceState: w.state, sliceWhy: w.why, historyState: "idle" });
    return;
  }
  if (ctrl.signal.aborted || !open.has(key)) return;
  const skew = typeof slice.now === "number" ? slice.now - Date.now() : 0;
  // opening: the smallest range that holds the whole history, fitted to it; asked again once it's known
  if (tl0.auto) {
    const pick = openingRange(slice.now ?? now, slice.start);
    const b = rangeBounds(pick, slice.now ?? now, slice.start);
    patch(key, { slice, skew, range: pick, auto: false });
    if (Math.abs(b.from - from) > 1000) return load(key, quiet);
  }
  // everything, asked before this knew when keeping began: ask again from there
  else if (tl0.range === "all" && typeof slice.start === "number" && slice.start < from - 1000 && !tl0.slice?.start) {
    patch(key, { slice, skew });
    return load(key, quiet);
  }
  if (typeof slice.from === "number" && typeof slice.to === "number" && slice.from < slice.to) ({ from, to } = slice);
  // everything: from when keeping began
  if (tl0.range === "all") ({ from, to } = rangeBounds("all", slice.now ?? now, slice.start));
  const tl1 = open.get(key)!;
  tl1.head.window = { from, to, start: typeof slice.start === "number" ? slice.start : null };
  patch(key, { slice, sliceState: "ok", sliceWhy: null, skew, from, to });
  // the events are new; the board as it was waits for a scrub, or the next slower read
  if (!history && open.get(key)?.player) {
    behind.add(key);
    return;
  }
  // the board as it was, to scrub
  try {
    const hFrom = Math.max(from, typeof slice.start === "number" ? slice.start : from);
    const res = await fetchFile(`${base}/history?from=${Math.floor(hFrom)}&to=${Math.ceil(to)}`, { signal: ctrl.signal });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, msg);
    }
    const frames = decodeTake(new Uint8Array(await res.arrayBuffer()));
    if (ctrl.signal.aborted || !open.has(key)) return;
    const player = new TakePlayer(frames);
    const old = open.get(key)?.player;
    patch(key, { player, historyHead: frames.head as HistoryHead, historyState: "ok", historyWhy: null });
    old?.destroy();
    historyAt.set(key, Date.now());
    behind.delete(key);
  } catch (e) {
    if ((e as Error).name === "AbortError" || ctrl.signal.aborted) return;
    const w = why(e, "history");
    patch(key, { historyState: w.state, historyWhy: w.why });
  }
}

/** the timelines told something new while they looked back: read again once they come back to now */
const stale = new Set<string>();
const lastRead = new Map<string, number>();
const nudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function refresh(key: string) {
  stale.delete(key);
  lastRead.set(key, Date.now());
  return load(key, true, Date.now() - (historyAt.get(key) ?? 0) >= HISTORY_EVERY_MS);
}

/** the server's nudge (sync/board.ts): every open timeline of that grid reads again, soon, if it's at now */
if (typeof window !== "undefined")
  window.addEventListener("foundation:timeline", (ev) => {
    const board = (ev as CustomEvent<{ board: string }>).detail?.board;
    for (const tl of open.values()) {
      if (tl.board !== board) continue;
      if (tl.head.t !== null) {
        stale.add(tl.key);
        continue;
      }
      // at most one read in 1.5 s, however busy the grid (the last nudge of a stretch is always read)
      if (nudgeTimers.has(tl.key)) continue;
      const wait = Math.max(150, 1500 - (Date.now() - (lastRead.get(tl.key) ?? 0)));
      nudgeTimers.set(
        tl.key,
        setTimeout(() => {
          nudgeTimers.delete(tl.key);
          void refresh(tl.key);
        }, wait),
      );
    }
  });

function schedule(key: string, ms = 160) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void load(key), ms));
}

// ---------- opening and closing ----------

/** `range` given: open on it (a section beside the grid's band reads on the grid's); none: the one that fits the history */
function make(key: string, p: Pick<Timeline, "scope" | "sectionId" | "board" | "section" | "childName">, range?: Range): Timeline {
  const now = Date.now();
  const r = range ?? "day";
  const { from, to } = rangeBounds(r, now);
  const head = new Playhead();
  head.window = { from, to, start: null };
  return { key, ...p, range: r, auto: !range, head, detached: false, from, to, slice: null, sliceState: "loading", sliceWhy: null, player: null, historyHead: null, historyState: "idle", historyWhy: null, skew: 0 };
}

function start(tl: Timeline) {
  open.set(tl.key, tl);
  emit();
  // leaving now with history older than the events: read it whole once, so the past holds what just happened
  let wasNow = true;
  tl.head.onMove(() => {
    const now = tl.head.t === null;
    if (wasNow && !now && behind.has(tl.key) && open.get(tl.key) === tl) void load(tl.key, true, true);
    wasNow = now;
  });
  lastRead.set(tl.key, Date.now());
  void load(tl.key);
  // kept up to date while it sits at now: the server nudges every window on the grid when something is recorded
  // (below); this is the fallback for a grid this window isn't joined to (a section that is another grid) and for
  // what a nudge missed. A scrub keeps what it has, so the past doesn't shift under it; it's read again at now.
  refreshers.set(
    tl.key,
    setInterval(() => {
      const cur = open.get(tl.key);
      if (!cur || cur.head.t !== null || document.hidden) return;
      if (stale.has(tl.key) || Date.now() - (lastRead.get(tl.key) ?? 0) > 20_000) void refresh(tl.key);
    }, 1_000),
  );
}

export function closeTimeline(key: string) {
  const tl = open.get(key);
  if (!tl) return;
  ctrls.get(key)?.abort();
  ctrls.delete(key);
  clearTimeout(timers.get(key));
  clearInterval(refreshers.get(key));
  timers.delete(key);
  refreshers.delete(key);
  clearTimeout(nudgeTimers.get(key));
  nudgeTimers.delete(key);
  stale.delete(key);
  lastRead.delete(key);
  historyAt.delete(key);
  behind.delete(key);
  tl.head.destroy();
  tl.player?.destroy();
  open.delete(key);
  emit();
}

export function closeAll() {
  for (const k of [...open.keys()]) closeTimeline(k);
}

/** the open grid's timeline */
export function openGridTimeline() {
  const board = activeBoard()?.boardId;
  if (!board) return;
  const had = open.get(GRID);
  if (had && had.board === board) return;
  if (had) closeTimeline(GRID);
  start(make(GRID, { scope: "grid", sectionId: null, board, section: null, childName: null }));
}
export function toggleGridTimeline() {
  if (open.has(GRID)) closeTimeline(GRID);
  else openGridTimeline();
}

/**
 * A section's timeline. A section that stands for a grid (`grid`: the child board, `name`: its name) opens that
 * grid's own timeline; any other, the open grid's filtered to it.
 */
export function openSectionTimeline(sectionId: string, grid?: { board: string; name: string } | null) {
  const board = activeBoard()?.boardId;
  if (!board) return;
  const key = sectionKey(sectionId);
  if (open.has(key)) return;
  if (grid === undefined) grid = childGridOf(sectionId);
  // it starts on the grid's range, when the grid's is open: the two read together
  const range = open.get(GRID)?.range;
  start(make(key, grid ? { scope: "section", sectionId, board: grid.board, section: null, childName: grid.name } : { scope: "section", sectionId, board, section: sectionId, childName: null }, range));
}
/** the grid a section stands for (its host is a `grid` card), with its name */
export function childGridOf(sectionId: string): { board: string; name: string } | null {
  const h = hostOf(sectionId);
  return h?.panel === "grid" && h.board ? { board: h.board, name: h.name || "This grid" } : null;
}

export function toggleSectionTimeline(sectionId: string, grid?: { board: string; name: string } | null) {
  const key = sectionKey(sectionId);
  if (open.has(key)) closeTimeline(key);
  else openSectionTimeline(sectionId, grid);
}

export function setRange(key: string, range: Range) {
  const tl = open.get(key);
  if (!tl || tl.range === range) return;
  const now = Date.now() + tl.skew;
  const { from, to } = rangeBounds(range, now, tl.slice?.start);
  tl.head.window = { ...tl.head.window, from, to };
  // a playhead outside the new range comes back inside it
  if (tl.head.t !== null) tl.head.seek(tl.head.t);
  patch(key, { range, from, to, auto: false });
  schedule(key);
}

/** a scrub of a section's own bar: it leaves the grid's playhead while the grid's is open */
export function seekSection(sectionId: string, t: number | null) {
  const key = sectionKey(sectionId);
  const tl = open.get(key);
  if (!tl) return;
  if (!tl.detached && open.has(GRID) && t !== null) patch(key, { detached: true });
  tl.head.seek(t);
}

export function followGrid(sectionId: string) {
  const key = sectionKey(sectionId);
  const tl = open.get(key);
  if (!tl) return;
  tl.head.pause();
  tl.head.seek(null);
  patch(key, { detached: false });
}

/** every playhead back to now */
export function allBackToNow() {
  for (const tl of open.values()) {
    tl.head.pause();
    tl.head.seek(null);
  }
}

/**
 * What a section shows now: the moment, and the timeline whose history draws it. null: the present. A section that
 * stands for another grid is drawn only from the grid it sits on (its own timeline is the child grid's: the lanes
 * and the moment show it, its cards stay as they are).
 */
export function momentOfSection(sectionId: string): { t: number; tl: Timeline } | null {
  const grid = open.get(GRID) ?? null;
  const own = open.get(sectionKey(sectionId)) ?? null;
  const m = sectionMoment({ gridOpen: !!grid, gridT: grid?.head.t ?? null, sectionOpen: !!own, sectionT: own?.head.t ?? null, detached: !!own?.detached });
  if (m.t === null) return null;
  const tl = m.source === "section" ? own : grid;
  if (!tl || (tl.scope === "section" && tl.childName)) return null;
  return { t: m.t, tl };
}

/** some section is shown as it was (the keys that write stand down) */
export function anyPast(): boolean {
  for (const tl of open.values()) if (tl.head.t !== null && !(tl.scope === "section" && tl.childName)) return true;
  return false;
}

/** every playhead's changes, for whatever draws "as it was" (subscribed to each open timeline's head) */
export function subscribeAllHeads(fn: () => void): () => void {
  let offs: Array<() => void> = [];
  const wire = () => {
    offs.forEach((o) => o());
    offs = [...open.values()].map((tl) => tl.head.subscribe(fn));
  };
  wire();
  const offOpen = subscribeTimelines(() => {
    wire();
    fn();
  });
  return () => {
    offOpen();
    offs.forEach((o) => o());
  };
}

// a grid's timelines are that grid's: switching grids closes them
let boardOf: string | null = null;
if (typeof window !== "undefined")
  onBoardChange(() => {
    const id = activeBoard()?.boardId ?? null;
    if (id !== boardOf) {
      boardOf = id;
      closeAll();
    }
  });

// tests and the e2e checks read where things stand
if (typeof window !== "undefined" && (import.meta.env?.DEV || import.meta.env?.VITE_E2E_HOOKS))
  (window as unknown as { __timeline: unknown }).__timeline = { get: getTimeline, all: openTimelines, seekSection, momentOfSection };

/**
 * The timeline's arithmetic, kept apart from React and the DOM so it is tested on its own (test/timeline.test.ts):
 * a range's bounds, time ↔ x, the ticks under the lanes, how the lanes are laid out and folded, the marks drawn
 * from a slice and which one is under the pointer, what a section's playhead is (following the grid or its own),
 * and what was said around a moment.
 */

import { TIMELINE_KINDS, TIMELINE_LANES, timelineLane, type TimelineEvent, type TimelineLane, type TimelineSlice } from "@foundation/protocol";

export const RANGES = ["hour", "day", "week", "all"] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_NAMES: Record<Range, string> = { hour: "Hour", day: "Day", week: "Week", all: "All" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const RANGE_MS: Record<Exclude<Range, "all">, number> = { hour: HOUR, day: DAY, week: 7 * DAY };

/** the least a window shows: a grid a few seconds old still reads as a stretch of time, not a point (more would be mostly unknown) */
export const MIN_SPAN = 5_000;
/** the most of the width "nothing is known" (before keeping began) may take */
export const MAX_UNKNOWN = 0.12;
/** "All" starts a little before keeping began, so "History begins" has room to say so */
export const LEAD = 0.05;

const known = (start: number | null | undefined, now: number) => (typeof start === "number" && start > 0 && start < now ? start : null);

/**
 * What a range shows, fitted to what exists. The last hour, day or week up to now; everything since keeping began
 * (with a small lead-in before it). A window that would begin before keeping began gives the unknown part at most
 * MAX_UNKNOWN of the width, so a young grid's marks spread over the bar instead of crowding its right edge. Never
 * less than MIN_SPAN.
 */
export function rangeBounds(range: Range, now: number, start?: number | null): { from: number; to: number } {
  const s = known(start, now);
  if (range === "all") {
    if (s === null) return { from: now - DAY, to: now };
    const age = now - s;
    const from = Math.min(s - Math.max(1_000, age * LEAD), now - MIN_SPAN);
    return { from, to: now };
  }
  let from = now - RANGE_MS[range];
  if (s !== null && from < s) {
    // the unknown share (s − from) / (now − from) ≤ MAX_UNKNOWN
    const floor = s - ((now - s) * MAX_UNKNOWN) / (1 - MAX_UNKNOWN);
    from = Math.max(from, Math.min(floor, now - MIN_SPAN));
  }
  return { from, to: now };
}

/** the window is narrower than the range's name says (a young grid): how much it does show */
export function rangeClipped(range: Range, from: number, to: number): boolean {
  return range !== "all" && to - from < RANGE_MS[range] - 1000;
}

/** the range a timeline opens on: the smallest that holds the grid's whole history (All for a grid younger than an hour) */
export function openingRange(now: number, start?: number | null): Range {
  const s = known(start, now);
  if (s === null) return "day";
  const age = now - s;
  if (age <= HOUR) return "all";
  if (age <= DAY) return "day";
  if (age <= RANGE_MS.week) return "week";
  return "all";
}

/** a span in words: "12 min", "3 h", "2 days" */
export function spanWords(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} days`;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** a time's x in a track `w` wide drawing from..to */
export function xOf(t: number, from: number, to: number, w: number): number {
  return ((t - from) / Math.max(1, to - from)) * w;
}
/** the time at x (clamped to the track) */
export function tOf(x: number, from: number, to: number, w: number): number {
  return from + clamp(x / Math.max(1, w), 0, 1) * (to - from);
}

/** where a playhead may go: not before keeping began, not past now */
export function clampT(t: number, from: number, to: number, start?: number | null): number {
  return clamp(t, Math.max(from, start ?? from), to);
}

/** an arrow key's step: a minute on an hour, a quarter on a day, two hours on a week, a hundredth of everything */
export function stepMs(range: Range, span: number, big = false): number {
  const s = range === "hour" ? 60_000 : range === "day" ? 15 * 60_000 : range === "week" ? 2 * HOUR : Math.max(60_000, Math.round(span / 100));
  return big ? s * 4 : s;
}

/**
 * Playing covers the visible range in a minute at 1× (an hour plays at a minute a second, a week at nearly three
 * hours a second): the range is what the person chose to look at, so it sets the pace.
 */
export function playRate(span: number, speed: number): number {
  return (span / 60_000) * speed;
}
export const SPEEDS = [1, 2, 4] as const;

/** ticks along the axis: a nice interval that leaves about 90 px between labels */
const STEPS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY];
export function ticks(from: number, to: number, w: number, minGap = 90): Array<{ t: number; x: number; day: boolean }> {
  const span = Math.max(1, to - from);
  const want = (span / Math.max(1, w)) * minGap;
  const step = STEPS.find((s) => s >= want) ?? STEPS[STEPS.length - 1];
  const out: Array<{ t: number; x: number; day: boolean }> = [];
  // align to the local clock: a tick at 14:00, not at 13:47
  const offset = new Date(from).getTimezoneOffset() * 60_000;
  let t = Math.ceil((from - offset) / step) * step + offset;
  if (step >= DAY) {
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    t = d.getTime();
    while (t < from) t += step;
  }
  for (; t <= to && out.length < 200; t += step) {
    const local = new Date(t);
    out.push({ t, x: xOf(t, from, to, w), day: local.getHours() === 0 && local.getMinutes() === 0 && local.getSeconds() === 0 });
  }
  return out;
}

/** a tick's label: the time on a short range, the day on a long one */
export function tickLabel(t: number, from: number, to: number): string {
  const d = new Date(t);
  if (to - from > 2 * DAY) return d.toLocaleDateString([], { weekday: "short", day: "numeric" });
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return d.toLocaleDateString([], { weekday: "short", day: "numeric" });
  // a few minutes across: the seconds are what tell the ticks apart
  if (to - from <= 10 * 60_000 && d.getSeconds() !== 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** the moment in words: "Now", "14:32" today, "Tue 24 Nov, 14:32" another day */
export function whenWords(t: number | null, now = Date.now()): string {
  if (t === null) return "Now";
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const same = new Date(now).toDateString() === d.toDateString();
  if (same) return `Today, ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

// ---------- lanes ----------

export interface LaneBox {
  lane: TimelineLane;
  y: number;
  h: number;
  /** nothing in range: drawn as a line */
  empty: boolean;
}

/**
 * The lanes top to bottom: a lane with something in range gets `row` px, an empty one folds to `line` px. Compact
 * (a short window, or a section's bar): everything in `rows` rows, the open work (people, agents, behind the
 * scenes) in the first and what was made and said (changes, chat, notes) in the second.
 */
export function layoutLanes(events: TimelineEvent[], opts: { row?: number; line?: number; gap?: number; rows?: 0 | 1 | 2 } = {}): { lanes: LaneBox[]; height: number } {
  const row = opts.row ?? 16;
  const line = opts.line ?? 5;
  const gap = opts.gap ?? 3;
  const has = new Set(events.map((e) => timelineLane(e.kind)));
  if (opts.rows === 1 || opts.rows === 2) {
    const rows = opts.rows;
    const lanes = TIMELINE_LANES.map((lane, i) => {
      const r = rows === 1 ? 0 : i < 3 ? 0 : 1;
      return { lane, y: r * (row + gap), h: row, empty: !has.has(lane) };
    });
    return { lanes, height: rows * row + (rows - 1) * gap };
  }
  let y = 0;
  const lanes = TIMELINE_LANES.map((lane) => {
    const empty = !has.has(lane);
    const h = empty ? line : row;
    const box = { lane, y, h, empty };
    y += h + gap;
    return box;
  });
  return { lanes, height: Math.max(0, y - gap) };
}

export type MarkShape = "span" | "tick" | "note" | "hollow";
export interface Mark {
  id: string;
  lane: TimelineLane;
  shape: MarkShape;
  /** px, in the track */
  x0: number;
  x1: number;
  y: number;
  h: number;
  /** how it's coloured: a person (their colour), an agent (violet), ink, or a removal (dim) */
  tone: "person" | "agent" | "ink" | "dim";
  color?: string;
  event: TimelineEvent;
}

const isSpan = (kind: string) => (TIMELINE_KINDS as Record<string, { span: boolean }>)[kind]?.span ?? false;

/** the marks for a slice in a track `w` wide, laid out by `lanes` (events outside from..to are left out) */
export function marksOf(events: TimelineEvent[], lanes: LaneBox[], from: number, to: number, w: number, now: number): Mark[] {
  const box = new Map(lanes.map((l) => [l.lane, l]));
  const out: Mark[] = [];
  for (const e of events) {
    const lane = timelineLane(e.kind);
    const l = box.get(lane);
    if (!l) continue;
    const end = isSpan(e.kind) ? (e.end ?? now) : e.at;
    if (end < from || e.at > to) continue;
    const x0 = xOf(Math.max(from, e.at), from, to, w);
    const x1 = Math.max(x0 + 2, xOf(Math.min(to, end), from, to, w));
    const agent = e.actor.kind === "agent";
    const tone: Mark["tone"] = agent ? "agent" : e.kind === "card.remove" || e.kind === "section.remove" || e.kind === "wire.remove" ? "dim" : e.actor.kind === "person" && (lane === "people" || lane === "chat") ? "person" : "ink";
    const shape: MarkShape = lane === "behind" ? "hollow" : lane === "notes" ? "note" : isSpan(e.kind) ? "span" : "tick";
    out.push({ id: e.id, lane, shape, x0, x1: shape === "span" || (shape === "hollow" && isSpan(e.kind)) ? x1 : x0, y: l.y, h: l.h, tone, color: e.actor.color, event: e });
  }
  return out;
}

/**
 * The mark under (x, y): the nearest instant within `tol` px in the lane under y, else a span that covers x.
 * Instants win over spans, so a message inside a long visit is still found.
 */
export function hitMark(marks: Mark[], x: number, y: number, tol = 6): Mark | null {
  let best: Mark | null = null;
  let bestD = Infinity;
  let span: Mark | null = null;
  for (const m of marks) {
    if (y < m.y - 2 || y > m.y + m.h + 2) continue;
    if (m.x1 > m.x0 + 2) {
      if (x >= m.x0 - 2 && x <= m.x1 + 2 && (!span || m.x1 - m.x0 < span.x1 - span.x0)) span = m;
      continue;
    }
    const d = Math.abs(m.x0 - x);
    if (d <= tol && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best ?? span;
}

/** changes per step, scaled 0..1 against the busiest step (the track's texture) */
export function densityLevels(density: number[]): number[] {
  const max = Math.max(0, ...density);
  return max ? density.map((d) => Math.sqrt(d / max)) : density.map(() => 0);
}

// ---------- following the grid ----------

/**
 * The moment a section shows. A section whose own bar was scrubbed while the grid's was open is detached: it keeps
 * its own playhead. Otherwise it follows the grid's when the grid's is open, and its own when it is alone.
 * null is now.
 */
export function sectionMoment(s: { gridOpen: boolean; gridT: number | null; sectionOpen: boolean; sectionT: number | null; detached: boolean }): { t: number | null; source: "grid" | "section" | null } {
  if (s.sectionOpen && (s.detached || !s.gridOpen)) return { t: s.sectionT, source: s.sectionT === null ? null : "section" };
  if (s.gridOpen) return { t: s.gridT, source: s.gridT === null ? null : "grid" };
  return { t: null, source: null };
}

/** scrubbing a section's bar detaches it from the grid only while the grid's is open (alone, there's nothing to follow) */
export const detachesOnScrub = (gridOpen: boolean) => gridOpen;

// ---------- the moment ----------

export interface Said {
  id: string;
  at: number;
  end?: number | null;
  kind: string;
  who: string;
  agent: boolean;
  body: string | null;
  text: string;
  withheld?: string;
  event: TimelineEvent;
}

/** what was said and the notes left within `window` ms of t (oldest first), and the one nearest t */
export function momentAround(events: TimelineEvent[], t: number, window = 30 * 60_000): { said: Said[]; notes: TimelineEvent[]; nearest: string | null } {
  const said: Said[] = [];
  const notes: TimelineEvent[] = [];
  for (const e of events) {
    const lane = timelineLane(e.kind);
    const end = e.end ?? e.at;
    const near = Math.abs(e.at - t) <= window || (isSpan(e.kind) && e.at <= t && (e.end ?? Infinity) >= t);
    if (!near) continue;
    if (lane === "chat") {
      const body = typeof e.data?.body === "string" ? (e.data.body as string) : null;
      said.push({ id: e.id, at: e.at, end: isSpan(e.kind) ? end : undefined, kind: e.kind, who: e.actor.name, agent: e.actor.kind === "agent", body, text: e.text, withheld: e.withheld, event: e });
    } else if (lane === "notes") notes.push(e);
  }
  said.sort((a, b) => a.at - b.at);
  notes.sort((a, b) => a.at - b.at);
  let nearest: string | null = null;
  let d = Infinity;
  for (const s of said) {
    const dd = Math.abs(s.at - t);
    if (s.at <= t + 60_000 && dd < d) {
      d = dd;
      nearest = s.id;
    }
  }
  return { said, notes, nearest };
}

/** which cursor sample t falls on (-1: none within 2 s, as TakePlayer.cursorsAt reads them): the past redraws only when it changes */
export function sampleAt(c: Array<{ at: number }>, t: number): number {
  let lo = 0;
  let hi = c.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].at <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t - c[lo - 1].at <= 2000 ? lo - 1 : -1;
}

/** the sections a slice names as gone: they were here, and aren't now */
export const goneSections = (slice: Pick<TimelineSlice, "sections"> | null) => (slice?.sections ?? []).filter((s) => s.gone);

/** a short "3 changes" */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

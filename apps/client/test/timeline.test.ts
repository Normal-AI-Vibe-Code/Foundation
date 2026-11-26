/**
 * The timeline's arithmetic (src/timeline/logic.ts): a range's bounds, time ↔ x, the ticks, the lanes laid out and
 * folded, the marks a slice draws and which one is under the pointer, a section following the grid or detached,
 * and what was said around a moment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineEvent } from "@foundation/protocol";
import { clampT, densityLevels, hitMark, layoutLanes, LEAD, marksOf, MAX_UNKNOWN, MIN_SPAN, momentAround, openingRange, playRate, rangeBounds, rangeClipped, RANGE_MS, sampleAt, sectionMoment, spanWords, stepMs, tickLabel, tOf, ticks, whenWords, xOf } from "../src/timeline/logic";

const NOW = Date.UTC(2026, 10, 25, 14, 0);
const H = 3_600_000;
let n = 0;
const ev = (kind: string, at: number, p: Partial<TimelineEvent> = {}): TimelineEvent => ({ id: `e${n++}`, board: "b", section: "s1", at, kind, actor: { kind: "person", name: "Ada", color: "#325bb4" }, text: kind, ...p });

test("a range ends now and reaches back its length when history is older than it", () => {
  assert.deepEqual(rangeBounds("hour", NOW), { from: NOW - H, to: NOW });
  assert.deepEqual(rangeBounds("week", NOW), { from: NOW - RANGE_MS.week, to: NOW });
  assert.deepEqual(rangeBounds("day", NOW, NOW - 30 * 24 * H), { from: NOW - 24 * H, to: NOW });
  assert.deepEqual(rangeBounds("all", NOW, null), { from: NOW - 24 * H, to: NOW }, "unknown: a day");
});

test("all runs from just before keeping began to now, however short", () => {
  const age = 3 * 24 * H;
  const all = rangeBounds("all", NOW, NOW - age);
  assert.equal(all.to, NOW);
  assert.ok(all.from < NOW - age, "a lead-in before History begins");
  assert.ok((NOW - age - all.from) / (all.to - all.from) <= LEAD + 1e-9, "the lead-in is a small share");
  const young = rangeBounds("all", NOW, NOW - 10 * 60_000);
  assert.ok(young.to - young.from < 11 * 60_000, "ten minutes of history draws about ten minutes, not an hour");
  assert.ok(young.from < NOW - 10 * 60_000);
  const newborn = rangeBounds("all", NOW, NOW - 2_000);
  assert.equal(newborn.to - newborn.from, MIN_SPAN, "a few seconds old: the least a window shows");
});

test("a window that begins before keeping began gives the unknown at most 12 % of the width", () => {
  for (const r of ["hour", "day", "week"] as const)
    for (const age of [30_000, 10 * 60_000, 50 * 60_000, 5 * H]) {
      const s = NOW - age;
      const b = rangeBounds(r, NOW, s);
      const span = b.to - b.from;
      if (b.from < s) assert.ok((s - b.from) / span <= MAX_UNKNOWN + 1e-6 || span === MIN_SPAN, `${r} at ${age}: ${(s - b.from) / span}`);
      assert.ok(span >= MIN_SPAN);
      assert.ok(span <= RANGE_MS[r] + 1);
    }
  const tenMin = rangeBounds("hour", NOW, NOW - 10 * 60_000);
  assert.ok(rangeClipped("hour", tenMin.from, tenMin.to), "the hour is clipped, and says so");
  assert.ok(!rangeClipped("hour", NOW - H, NOW));
  assert.ok(!rangeClipped("all", tenMin.from, tenMin.to));
});

test("a timeline opens on the smallest range that holds the whole history", () => {
  assert.equal(openingRange(NOW, NOW - 10 * 60_000), "all");
  assert.equal(openingRange(NOW, NOW - 59 * 60_000), "all");
  assert.equal(openingRange(NOW, NOW - 5 * H), "day");
  assert.equal(openingRange(NOW, NOW - 3 * 24 * H), "week");
  assert.equal(openingRange(NOW, NOW - 30 * 24 * H), "all");
  assert.equal(openingRange(NOW, null), "day");
  assert.equal(spanWords(12 * 60_000), "12 min");
  assert.equal(spanWords(5 * H), "5 h");
  assert.equal(spanWords(3 * 24 * H), "3 days");
});

test("a few minutes across, the ticks fall on seconds and say them", () => {
  const from = NOW - 3 * 60_000;
  const tk = ticks(from, NOW, 900);
  assert.ok(tk.length >= 5, `${tk.length} ticks`);
  assert.ok(tk.some((k) => new Date(k.t).getSeconds() !== 0));
  const s = tk.find((k) => new Date(k.t).getSeconds() !== 0)!;
  assert.match(tickLabel(s.t, from, NOW), /^\d\d:\d\d:\d\d$/);
});

test("time and x turn into each other, clamped to the track", () => {
  const from = NOW - H;
  assert.equal(xOf(NOW - H / 2, from, NOW, 600), 300);
  assert.equal(tOf(300, from, NOW, 600), NOW - H / 2);
  assert.equal(tOf(-40, from, NOW, 600), from);
  assert.equal(tOf(900, from, NOW, 600), NOW);
  for (const x of [0, 17, 333, 600]) assert.ok(Math.abs(xOf(tOf(x, from, NOW, 600), from, NOW, 600) - x) < 1e-6);
});

test("the playhead never goes before keeping began or past now", () => {
  assert.equal(clampT(NOW - 2 * H, NOW - H, NOW, NOW - H / 2), NOW - H / 2);
  assert.equal(clampT(NOW + 5, NOW - H, NOW, null), NOW);
  assert.equal(clampT(NOW - 10, NOW - H, NOW, null), NOW - 10);
});

test("arrow steps and playing pace follow the range", () => {
  assert.equal(stepMs("hour", H), 60_000);
  assert.equal(stepMs("day", 24 * H), 15 * 60_000);
  assert.equal(stepMs("day", 24 * H, true), 60 * 60_000);
  assert.equal(stepMs("week", 7 * 24 * H), 2 * H);
  assert.equal(stepMs("all", 100 * H), H);
  // 1× plays the visible range in a minute
  assert.equal(playRate(H, 1) * 60_000, H);
  assert.equal(playRate(H, 4), 4 * playRate(H, 1));
});

test("ticks leave room for their labels and fall on whole times", () => {
  const from = NOW - 24 * H;
  const tk = ticks(from, NOW, 1200);
  assert.ok(tk.length >= 4 && tk.length <= 14, `${tk.length} ticks`);
  for (let i = 1; i < tk.length; i++) assert.ok(tk[i].x - tk[i - 1].x >= 89, "at least 90 px apart");
  for (const k of tk) assert.equal(new Date(k.t).getMinutes(), 0, "on the hour");
  assert.ok(tk.every((k) => k.t >= from && k.t <= NOW));
});

test("lanes with nothing in range fold to a line; compact puts them in two rows", () => {
  const events = [ev("card.add", NOW - 10), ev("chat.message", NOW - 20)];
  const full = layoutLanes(events, { row: 16, line: 5, gap: 3 });
  assert.deepEqual(full.lanes.map((l) => [l.lane, l.empty, l.h]), [
    ["people", true, 5],
    ["agents", true, 5],
    ["behind", true, 5],
    ["changes", false, 16],
    ["chat", false, 16],
    ["notes", true, 5],
  ]);
  assert.equal(full.height, 4 * 5 + 2 * 16 + 5 * 3);
  const two = layoutLanes(events, { rows: 2, row: 10, gap: 2 });
  assert.equal(two.height, 22);
  assert.deepEqual([...new Set(two.lanes.map((l) => l.y))], [0, 12], "people/agents/behind on top, changes/chat/notes under");
});

test("marks: spans as bars, changes as ticks, behind the scenes hollow, notes round, agents violet, removals dim", () => {
  const from = NOW - H;
  const events = [
    ev("person.here", NOW - 50 * 60_000, { end: NOW - 20 * 60_000 }),
    ev("agent.run", NOW - 30 * 60_000, { end: null, actor: { kind: "agent", name: "Wren" } }),
    ev("agent.tool", NOW - 29 * 60_000, { actor: { kind: "agent", name: "Wren" } }),
    ev("card.add", NOW - 10 * 60_000),
    ev("card.remove", NOW - 5 * 60_000),
    ev("note.audio", NOW - 4 * 60_000),
    ev("card.add", NOW - 2 * H), // before the range: left out
    ev("some.future.kind", NOW - 60_000), // unknown: drawn in Changes
  ];
  const { lanes } = layoutLanes(events);
  const marks = marksOf(events, lanes, from, NOW, 600, NOW);
  assert.equal(marks.length, 7);
  const by = (k: string) => marks.filter((m) => m.event.kind === k);
  assert.equal(by("person.here")[0].shape, "span");
  assert.equal(by("person.here")[0].tone, "person");
  assert.ok(by("person.here")[0].x1 - by("person.here")[0].x0 > 100);
  const run = by("agent.run")[0];
  assert.equal(run.tone, "agent");
  assert.ok(Math.abs(run.x1 - 600) < 1, "a run still going reaches now");
  assert.equal(by("agent.tool")[0].shape, "hollow");
  assert.equal(by("card.add")[0].shape, "tick");
  assert.equal(by("card.remove")[0].tone, "dim");
  assert.equal(by("note.audio")[0].shape, "note");
  assert.equal(by("some.future.kind")[0].lane, "changes");
});

test("the mark under the pointer: the nearest instant in the lane, before a span that covers it", () => {
  const from = NOW - H;
  const events = [ev("huddle", NOW - 40 * 60_000, { end: NOW - 10 * 60_000 }), ev("chat.message", NOW - 25 * 60_000), ev("chat.message", NOW - 24 * 60_000)];
  const { lanes } = layoutLanes(events);
  const marks = marksOf(events, lanes, from, NOW, 600, NOW);
  const chat = lanes.find((l) => l.lane === "chat")!;
  const y = chat.y + chat.h / 2;
  const x24 = xOf(NOW - 24 * 60_000, from, NOW, 600);
  assert.equal(hitMark(marks, x24 + 2, y)?.event.id, events[2].id);
  assert.equal(hitMark(marks, xOf(NOW - 35 * 60_000, from, NOW, 600), y)?.event.kind, "huddle");
  assert.equal(hitMark(marks, 590, y), null, "past the huddle's end, nothing");
  assert.equal(hitMark(marks, x24, chat.y + chat.h + 20), null, "another lane");
});

test("a section follows the grid until its own bar is scrubbed, then keeps its own moment", () => {
  const T = NOW - H;
  assert.deepEqual(sectionMoment({ gridOpen: true, gridT: T, sectionOpen: false, sectionT: null, detached: false }), { t: T, source: "grid" });
  assert.deepEqual(sectionMoment({ gridOpen: true, gridT: T, sectionOpen: true, sectionT: T - 5, detached: false }), { t: T, source: "grid" }, "open, not scrubbed: follows");
  assert.deepEqual(sectionMoment({ gridOpen: true, gridT: T, sectionOpen: true, sectionT: T - 5, detached: true }), { t: T - 5, source: "section" });
  assert.deepEqual(sectionMoment({ gridOpen: true, gridT: null, sectionOpen: true, sectionT: null, detached: true }), { t: null, source: null }, "detached at now is now");
  assert.deepEqual(sectionMoment({ gridOpen: false, gridT: null, sectionOpen: true, sectionT: T, detached: false }), { t: T, source: "section" }, "alone, its own");
  assert.deepEqual(sectionMoment({ gridOpen: false, gridT: null, sectionOpen: false, sectionT: null, detached: false }), { t: null, source: null });
});

test("the moment: what was said near t, the nearest marked, withheld kept as its own line, notes beside", () => {
  const t = NOW - H;
  const events = [
    ev("chat.ask", t - 5 * 60_000, { data: { body: "Is 3 mm enough?" } }),
    ev("chat.answer", t - 4 * 60_000, { actor: { kind: "agent", name: "Wren" }, withheld: "Its answer read beyond this grid" }),
    ev("chat.message", t + 40 * 60_000, { data: { body: "far later" } }),
    ev("note.video", t - 60_000, { data: { note: { fileId: "f1", mime: "video/webm", ms: 9000 } } }),
    ev("card.add", t),
  ];
  const m = momentAround(events, t, 10 * 60_000);
  assert.deepEqual(m.said.map((s) => s.kind), ["chat.ask", "chat.answer"]);
  assert.equal(m.said[0].body, "Is 3 mm enough?");
  assert.equal(m.said[1].withheld, "Its answer read beyond this grid");
  assert.equal(m.said[1].agent, true);
  assert.equal(m.nearest, m.said[1].id);
  assert.equal(m.notes.length, 1);
});

test("the texture scales against the busiest step; the cursor sample a moment falls on", () => {
  assert.deepEqual(densityLevels([0, 4, 16]), [0, 0.5, 1]);
  assert.deepEqual(densityLevels([0, 0]), [0, 0]);
  const c = [{ at: 1000 }, { at: 2000 }, { at: 9000 }];
  assert.equal(sampleAt(c, 500), -1);
  assert.equal(sampleAt(c, 2500), 1);
  assert.equal(sampleAt(c, 6000), -1, "more than 2 s old: nobody");
  assert.equal(sampleAt(c, 9000), 2);
});

test("the moment in words", () => {
  assert.equal(whenWords(null), "Now");
  const today = Date.now() - 60_000;
  assert.match(whenWords(today), /^Today, \d\d:\d\d$/);
  assert.match(whenWords(today - 3 * 24 * H), /\d\d:\d\d$/);
  assert.doesNotMatch(whenWords(today - 3 * 24 * H), /^Today/);
});

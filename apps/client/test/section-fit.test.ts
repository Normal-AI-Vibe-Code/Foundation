/**
 * A section never scrolls (Josh, 2026-11-07): it fits its cards to its body,
 * choosing the flow width that shows them largest, stops at MIN_FIT and says
 * it's clipped; expanded, it is its own grid at full size and grows to hold
 * everything. Wires and drops read the same fitted geometry (objectWorldRect).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_PAD,
  MIN_FIT,
  SECTION_HEADER,
  applyRemote,
  expandSection,
  getState,
  objectWorldRect,
  sectionBaseRect,
  cubicBezier,
  sectionCardRect,
  sectionFlow,
  sectionRestRect,
  setSectionClock,
  startSectionEase,
  type NoteMeta,
} from "../src/state/store";

// the section ease runs on a clock the tests turn by hand
let now = 0;
setSectionClock(() => now);

const note = (i: number): NoteMeta => ({ id: `n${i}`, sectionId: "S", name: `n${i}`, x: 0, y: 0, float: false, bornAt: i, w: 420, h: 300, text: "" });
const load = (count: number) =>
  applyRemote({
    grid: { cols: [1200], rows: [900] },
    sections: { S: { id: "S", name: "S", c0: 0, r0: 0, c1: 0, r1: 0 } },
    notes: Object.fromEntries(Array.from({ length: count }, (_, i) => [`n${i}`, note(i)])),
    tables: {},
    maps: {},
    media: {},
    panels: {},
  });

test("cards that fit show at full size", () => {
  load(2);
  const f = sectionFlow("S");
  assert.equal(f.fit, 1);
  assert.equal(f.clipped, false);
});

test("too many cards: a wider flow, scaled to fit the body, everything inside", () => {
  load(12);
  const f = sectionFlow("S");
  const body = sectionBaseRect(getState().grid, getState().sections.S);
  assert.ok(f.fit < 1 && f.fit >= MIN_FIT, `fit ${f.fit}`);
  assert.equal(f.clipped, false);
  assert.ok(f.availW > body.w - CONTENT_PAD * 2, "it chose a wider flow than the section");
  assert.ok(f.extent.w * f.fit <= body.w - 2 + 0.5 && f.extent.h * f.fit <= body.h - 2 - SECTION_HEADER + 0.5, "the fitted content is inside the body");
  // the world rect a wire lands on is the drawn (scaled) card
  const r = objectWorldRect(getState().notes.n0)!;
  assert.equal(r.s, f.fit);
  assert.ok(Math.abs(r.w - 420 * f.fit) < 1e-9);
});

test("far too many: it stops at MIN_FIT and says it's clipped", () => {
  load(80);
  const f = sectionFlow("S");
  assert.equal(f.fit, MIN_FIT);
  assert.equal(f.clipped, true);
});

test("expanded: its own width, full size, and the section grows to hold it all; closing gives the fit back", () => {
  load(80);
  const base = sectionBaseRect(getState().grid, getState().sections.S);
  expandSection("S");
  const f = sectionFlow("S");
  assert.equal(f.fit, 1);
  assert.equal(f.clipped, false);
  assert.equal(f.availW, base.w - CONTENT_PAD * 2);
  const open = sectionCardRect(getState().grid, getState().sections.S);
  assert.equal(open.x, base.x);
  assert.equal(open.y, base.y);
  assert.ok(open.h >= SECTION_HEADER + f.extent.h, "tall enough for every card");
  expandSection(null);
  assert.equal(sectionFlow("S").fit, MIN_FIT);
  assert.deepEqual(sectionCardRect(getState().grid, getState().sections.S), base);
});

test("the CSS curve, in numbers: cubic-bezier as the browser draws it", () => {
  const ease = cubicBezier(0.25, 0.1, 0.25, 1); // CSS `ease`
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3, `ease(0.5) = ${ease(0.5)}`);
  const settle = cubicBezier(0.22, 1.3, 0.36, 1); // --ease-settle overshoots a little, then settles
  const peak = Math.max(...Array.from({ length: 99 }, (_, i) => settle((i + 1) / 100)));
  assert.ok(peak > 1 && peak < 1.12, `overshoot ${peak}`);
});

test("opening a section: its rect eases with the card, so wires travel with it instead of jumping", () => {
  load(80);
  const S = () => getState().sections.S;
  const base = sectionBaseRect(getState().grid, S());
  expandSection("S");
  // SectionView starts the ease as the new size lands in the DOM, from where the card was drawn
  startSectionEase("S", base);
  const open = sectionRestRect(getState().grid, S());
  assert.ok(open.h > base.h + 100, "it has somewhere to grow to");
  // at the press: still where it was
  assert.deepEqual(sectionCardRect(getState().grid, S()), base);
  // part way: between the two, growing from its corner
  now += 150;
  const mid = sectionCardRect(getState().grid, S());
  assert.equal(mid.x, base.x);
  assert.ok(mid.h > base.h && mid.h < open.h * 1.12, `mid ${mid.h} between ${base.h} and ${open.h}`);
  // closing mid-ease starts from where it was drawn then
  expandSection(null);
  startSectionEase("S", mid);
  assert.deepEqual(sectionCardRect(getState().grid, S()), mid);
  now += 600;
  assert.deepEqual(sectionCardRect(getState().grid, S()), base);
});

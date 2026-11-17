/**
 * Sections are grids within themselves (2026-11-11, Josh: "The individual
 * sections are actually grids within themselves, so opening them up to
 * fullscreen opens up a full other grid"). The store keeps every section at
 * every depth (allSections, with parent) and every grid's tracks (grids);
 * what's in view (sections, grid) is one level of that. Opening a section
 * that holds cards shows them as one section filling its grid, and writes
 * nothing; splitting or adding beside it makes that section real; removing a
 * section takes its grid with it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addNote,
  childrenOf,
  getState,
  isGridSection,
  leafSection,
  levelPath,
  levelUp,
  openLevel,
  removeSection,
  setSyncHook,
  splitSection,
} from "../src/state/store";

const writes: string[] = [];
setSyncHook((next, prev) => {
  if (next.allSections !== prev.allSections) writes.push("sections");
  if (next.grids !== prev.grids) writes.push("grids");
});

const first = () => Object.values(getState().allSections)[0];

test("opening a section of cards shows them as one section filling its grid, and writes nothing", () => {
  const top = first();
  const note = addNote(top.id, "# Brief");
  writes.length = 0;
  openLevel(top.id);
  const st = getState();
  assert.equal(st.level, top.id);
  assert.deepEqual(Object.keys(st.sections), [top.id]);
  assert.equal(st.sections[top.id].virtual, true);
  assert.equal(st.notes[note.id].sectionId, top.id, "its cards stay its own");
  assert.deepEqual(writes, [], "just looking writes nothing to the board");
  assert.deepEqual(levelPath().map((s) => s.id), [top.id]);
});

test("splitting it makes its cards a section of their own, in its grid, and it becomes a grid", () => {
  const top = getState().level!;
  const note = Object.values(getState().notes)[0];
  splitSection(top, "h");
  const st = getState();
  const kids = childrenOf(top);
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.parent === top && !k.virtual));
  assert.ok(!st.sections[top], "the opened section is no longer in its own view");
  assert.ok(kids.some((k) => k.id === st.notes[note.id].sectionId), "the cards moved into one of them");
  assert.ok(isGridSection(top));
  assert.equal(st.grids[top].cols.length, 2, "its own tracks are kept");
  assert.ok(Object.values(st.sections).every((s) => s.parent === top), "the view carries the parent");
});

test("a card added to a grid of sections lands in its first section", () => {
  const top = getState().level!;
  levelUp();
  assert.equal(getState().level, null);
  assert.ok(getState().sections[top], "back on the board, the section is in view again");
  const n = addNote(top, "into the grid");
  assert.equal(n.sectionId, leafSection(top));
  assert.notEqual(n.sectionId, top);
});

test("removing a section that is a grid removes its sections, its tracks and their cards", () => {
  const top = first().parent ? first().parent! : Object.values(getState().allSections).find((s) => !s.parent)!.id;
  // a second section on the board, so the first can be removed
  splitSection(top, "v");
  const st0 = getState();
  const kidIds = childrenOf(top).map((k) => k.id);
  const notesInside = Object.values(st0.notes).filter((n) => kidIds.includes(n.sectionId)).length;
  assert.ok(kidIds.length > 0 && notesInside > 0);
  removeSection(top);
  const st = getState();
  assert.ok(!st.allSections[top]);
  assert.ok(kidIds.every((k) => !st.allSections[k]), "its sections went with it");
  assert.ok(!st.grids[top], "and its tracks");
  assert.equal(Object.values(st.notes).filter((n) => kidIds.includes(n.sectionId)).length, 0, "and their cards");
});

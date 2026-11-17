/**
 * A section re-renders from its own slice of the store (store.useSection):
 * pressing, dragging or typing in a card elsewhere leaves another section's
 * snapshot identical, so React skips it and its cards. Before 2026-11-07
 * every section read the whole store, and a press re-rendered all 200 cards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRemote, getState, moveNote, sectionSnap, setActiveObject, updateNoteText, type NoteMeta, type Section } from "../src/state/store";

const sec = (id: string, c0: number): Section => ({ id, name: id, c0, r0: 0, c1: c0, r1: 0 });
const note = (id: string, sectionId: string, bornAt: number): NoteMeta => ({ id, sectionId, name: id, x: 0, y: 0, float: false, bornAt, w: 300, h: 200, text: id });

applyRemote({
  sections: { A: sec("A", 0), B: sec("B", 1) },
  notes: { a1: note("a1", "A", 1), a2: note("a2", "A", 2), b1: note("b1", "B", 3) },
  tables: {},
  maps: {},
  media: {},
  panels: {},
});

test("pressing a card in A leaves B's snapshot as it was; A keeps its cards array", () => {
  const [a, b] = [sectionSnap("A"), sectionSnap("B")];
  setActiveObject("a1");
  assert.equal(sectionSnap("B"), b);
  const a2 = sectionSnap("A");
  assert.notEqual(a2, a);
  assert.equal(a2.activeObjectId, "a1");
  assert.equal(a2.objects, a.objects, "same cards, same array: the section's layout holds");
});

test("moving the active card to another of A's cards changes only A", () => {
  const b = sectionSnap("B");
  setActiveObject("a2");
  assert.equal(sectionSnap("B"), b);
  assert.equal(sectionSnap("A").activeObjectId, "a2");
});

test("dragging and typing in A leave B alone; a change in B reaches B", () => {
  const b = sectionSnap("B");
  moveNote("a1", 40, 40);
  updateNoteText("a2", "typed");
  assert.equal(sectionSnap("B"), b);
  updateNoteText("b1", "changed");
  const b2 = sectionSnap("B");
  assert.notEqual(b2, b);
  assert.equal(b2.objects[0], getState().notes.b1);
});

test("the active card moving out of B clears B's active id", () => {
  setActiveObject("b1");
  assert.equal(sectionSnap("B").activeObjectId, "b1");
  setActiveObject("a1");
  assert.equal(sectionSnap("B").activeObjectId, null);
});

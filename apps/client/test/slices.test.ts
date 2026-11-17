/**
 * The board-wide layers read slices of the store (state/slices.ts), so a
 * press, a drag or a keystroke in one card leaves them as they were and React
 * skips them. Before 2026-11-08 `GridViewport`, both wire layers and every
 * map read the whole store and rendered on each of those.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { addLink, applyRemote, bindMap, expandSection, getState, moveNote, setActiveObject, updateNoteText, updatePanel, type AppState, type MapMeta, type NoteMeta, type PanelMeta, type Section, type TableMeta } from "../src/state/store";
import { gridViewSlice, parsePairs, portWiresSlice, shallowEqual, sheetWiresSlice, tableOptionsSlice } from "../src/state/slices";

const sec = (id: string, c0: number): Section => ({ id, name: id, c0, r0: 0, c1: c0, r1: 0 });
const note = (id: string, sectionId: string, bornAt: number): NoteMeta => ({ id, sectionId, name: id, x: 0, y: 0, float: false, bornAt, w: 300, h: 200, text: id });
const table = (id: string, sectionId: string): TableMeta => ({ id, sectionId, name: id, x: 0, y: 0, float: false, bornAt: 5, cols: 3, rows: 6 }) as TableMeta;
const map = (id: string, sectionId: string, sourceTableId: string | null): MapMeta => ({ id, sectionId, name: id, x: 0, y: 0, float: false, bornAt: 6, w: 400, h: 300, sourceTableId }) as MapMeta;
const app = (id: string, sectionId: string, ports: PanelMeta["ports"]): PanelMeta => ({ id, sectionId, name: id, kind: "app", x: 0, y: 0, float: false, bornAt: 7, w: 400, h: 300, ports }) as PanelMeta;

applyRemote({
  sections: { A: sec("A", 0), B: sec("B", 1) },
  notes: { a1: note("a1", "A", 1), a2: note("a2", "A", 2), b1: note("b1", "B", 3) },
  tables: { t1: table("t1", "B") },
  maps: { m1: map("m1", "B", "t1") },
  media: {},
  panels: { p1: app("p1", "A", [{ id: "o", name: "out", dir: "out" }]), p2: app("p2", "B", [{ id: "i", name: "in", dir: "in" }]) },
  links: {},
});
addLink({ from: { panel: "p1", port: "o" }, to: { panel: "p2", port: "i" } });

const slices = (st: AppState) => ({ grid: gridViewSlice(st), sheet: sheetWiresSlice(st), ports: portWiresSlice(st), tables: tableOptionsSlice(st) });
const same = (a: ReturnType<typeof slices>, b: ReturnType<typeof slices>) =>
  shallowEqual(a.grid, b.grid) && shallowEqual(a.sheet, b.sheet) && shallowEqual(a.ports, b.ports) && a.tables === b.tables;

test("typing in a note, dragging it and dragging an app leave every board-wide slice equal", () => {
  const before = slices(getState());
  updateNoteText("a1", "typed into");
  moveNote("a2", 120, 80);
  updatePanel("p1", { x: 300, y: 40 });
  assert.ok(same(before, slices(getState())));
});

test("pressing a card changes the grid's slice only by which section is active", () => {
  setActiveObject("b1");
  const before = slices(getState());
  setActiveObject("a1");
  const after = slices(getState());
  assert.ok(!shallowEqual(before.grid, after.grid));
  assert.equal(after.grid.activeSectionId, "A");
  assert.ok(shallowEqual(before.sheet, after.sheet) && shallowEqual(before.ports, after.ports));
  setActiveObject("a2");
  assert.ok(shallowEqual(after.grid, gridViewSlice(getState())), "another card in the same section: the grid stays still");
});

test("what the wires draw does change them", () => {
  const s0 = sheetWiresSlice(getState());
  bindMap("m1", null);
  assert.notEqual(sheetWiresSlice(getState()).maps, s0.maps, "unbinding a map drops its wire");
  const p0 = portWiresSlice(getState());
  updatePanel("p1", { outputs: { o: 42 } });
  assert.notEqual(portWiresSlice(getState()).wires, p0.wires, "a source with a value lights its wire");
  const p1 = portWiresSlice(getState());
  updatePanel("p1", { outputs: { o: 43 } });
  assert.equal(portWiresSlice(getState()).wires, p1.wires, "a new value on a live wire draws nothing new");
  updatePanel("p2", { status: "running", createdBy: "Finch" });
  assert.deepEqual(parsePairs(portWiresSlice(getState()).running), [["p2", "Finch"]]);
  // a running machine is a machine running, not an agent at work: no agent's ring around it
  updatePanel("p1", { panel: "machine", status: "running", createdBy: "Finch" });
  assert.deepEqual(parsePairs(portWiresSlice(getState()).running), [["p2", "Finch"]]);
  expandSection("A");
  assert.equal(sheetWiresSlice(getState()).open, "A");
  expandSection(null);
});

test("a map's table picker follows tables' names, not their cards", () => {
  const t0 = tableOptionsSlice(getState());
  applyRemote({ tables: { ...getState().tables, t1: { ...getState().tables.t1, x: 50 } } });
  assert.equal(tableOptionsSlice(getState()), t0);
  applyRemote({ tables: { ...getState().tables, t1: { ...getState().tables.t1, name: "People" } } });
  assert.deepEqual(parsePairs(tableOptionsSlice(getState())), [["t1", "People"]]);
});

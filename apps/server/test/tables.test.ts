/**
 * Tables two people can edit (schema 4): each table's cells are a Y.Map, an
 * edit writes only the cells it changed, and boards from before move their
 * cells over once.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { boardMaps, describeBoard, setTableCells, tableCellMap, tableCellsOf, BOARD_SCHEMA } = await import("@foundation/protocol");
const { migrateBoard } = await import("../src/migrate.ts");
const { getBoard, editBoard, closeBoards } = await import("../src/boards.ts");

after(() => closeBoards());

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const queue: Array<[Y.Doc, Uint8Array]> = [];
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "net" && queue.push([b, u]));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "net" && queue.push([a, u]));
  const deliver = () => {
    while (queue.length) {
      const [to, u] = queue.shift()!;
      Y.applyUpdate(to, u, "net");
    }
  };
  return { a, b, deliver };
}

test("two people editing different cells of one table both land", () => {
  const { a, b, deliver } = pair();
  a.transact(() => setTableCells(a, "table_1", { "0,0": "Part", "1,0": "Qty" }));
  deliver();
  // the same moment, each from the table they had: one fills A2, the other B2
  const seen = tableCellsOf(b, "table_1");
  a.transact(() => setTableCells(a, "table_1", { ...seen, "0,1": "Shroud" }));
  b.transact(() => setTableCells(b, "table_1", { ...seen, "1,1": "=2*3" }));
  deliver();
  const want = { "0,0": "Part", "1,0": "Qty", "0,1": "Shroud", "1,1": "=2*3" };
  assert.deepEqual(tableCellsOf(a, "table_1"), want);
  assert.deepEqual(tableCellsOf(b, "table_1"), want);
});

test("clearing a cell removes just that cell", () => {
  const { a, b, deliver } = pair();
  a.transact(() => setTableCells(a, "t", { "0,0": "x", "1,0": "y" }));
  deliver();
  b.transact(() => setTableCells(b, "t", { "0,0": "x" }));
  a.transact(() => setTableCells(a, "t", { "0,0": "x", "1,0": "y", "2,0": "z" }));
  deliver();
  assert.deepEqual(tableCellsOf(a, "t"), { "0,0": "x", "2,0": "z" });
  assert.deepEqual(tableCellsOf(b, "t"), tableCellsOf(a, "t"));
});

test("two people writing the first cells of a new table at once both land (the map is made with the table)", () => {
  const { a, b, deliver } = pair();
  // the table is made, and its cell map with it, in one change
  a.transact(() => {
    boardMaps(a).objects.set("table_new", { id: "table_new", kind: "table", sectionId: "s", name: "T", x: 0, y: 0, float: false, bornAt: 1, cols: 4, rows: 4 } as never);
    tableCellMap(a, "table_new");
  });
  deliver();
  a.transact(() => setTableCells(a, "table_new", { "0,0": "Part" }));
  b.transact(() => setTableCells(b, "table_new", { "1,0": "Qty" }));
  deliver();
  assert.deepEqual(tableCellsOf(a, "table_new"), { "0,0": "Part", "1,0": "Qty" });
  assert.deepEqual(tableCellsOf(b, "table_new"), tableCellsOf(a, "table_new"));
});

test("…and why: a map made lazily by both at once loses one person's cells", () => {
  const { a, b, deliver } = pair();
  a.transact(() => setTableCells(a, "table_lazy", { "0,0": "Part" }));
  b.transact(() => setTableCells(b, "table_lazy", { "1,0": "Qty" }));
  deliver();
  assert.equal(Object.keys(tableCellsOf(a, "table_lazy")).length, 1, "one of the two maps wins — the reason maps are made with their table");
});

test("schema 4: an older board's cells become a Y.Map per table, once; the agent still reads them", () => {
  const id = "tables-mig";
  editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    m.meta.set("schema", 3);
    m.sections.set("sec_a", { id: "sec_a", name: "A", c0: 0, r0: 0, c1: 0, r1: 0 });
    m.objects.set("table_old", { id: "table_old", kind: "table", sectionId: "sec_a", name: "BOM", x: 0, y: 0, float: false, bornAt: 1, cols: 4, rows: 4 } as never);
    m.cells.set("table_old", { "0,0": "Part", "1,0": "Cost" });
  });
  assert.equal(migrateBoard(id), true);
  const doc = getBoard(id).doc;
  const m = boardMaps(doc);
  assert.equal(m.meta.get("schema"), BOARD_SCHEMA);
  assert.ok(m.cells.get("table_old") instanceof Y.Map);
  assert.deepEqual(tableCellsOf(doc, "table_old"), { "0,0": "Part", "1,0": "Cost" });
  assert.match(describeBoard(doc), /headers: Part \| Cost/);
  assert.equal(migrateBoard(id), false);
});

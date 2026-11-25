/**
 * Data flowing card to card (2026-11-24, Josh: "test whether disconnecting or connecting actually makes a
 * difference in the flow of information"). flows.ts, the lens in packages/protocol/src/flows.ts.
 *
 *  - a connector with no wire out isn't read; wired into a table, its system's main list fills the table
 *    through the table's lens, and the table's flow state says what passed;
 *  - what changes upstream flows through while wired; taking the wire off stops it (the table keeps its last
 *    rows, says it's unfed), and putting the wire back (a person's ⌘Z) fills it again;
 *  - a table fed by a table follows it; a lens that can't be read says why; an offline system says why on
 *    what it feeds;
 *  - the examples lay once, wired; an agent takes a wire off only with confirm.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-flows-"));
process.env.FOUNDATION_STARTER_DIR = "";

const { closeBoards, editBoard, getBoard, createBoardRow } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { feedConnectors, fill, setConnectorReader, stopFlows, connectorValue } = await import("../src/flows.ts");
const { tableRows } = await import("../src/machineio.ts");
const { appendSection, applyLens, boardMaps, setTableCells, uid, TABLE_PORT } = await import("@foundation/protocol");
type PanelDoc = import("@foundation/protocol").PanelDoc;
type TableDoc = import("@foundation/protocol").TableDoc;
type LinkDoc = import("@foundation/protocol").LinkDoc;
type ConnectorState = import("../src/connectors.ts").ConnectorState;

after(() => {
  stopFlows();
  setConnectorReader(null);
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const board = createBoardRow("Flows");
const ctx = { boardId: board, actor: "Ada Lovelace", userId: ada.id, person: true };
const m = () => boardMaps(getBoard(board).doc);
const rowsOf = (id: string) => tableRows(getBoard(board).doc, m().objects.get(id) as TableDoc);

// a stand-in BomForm: what it says is whatever the test sets; it counts its reads
let programs = [
  { code: "UL-2271", name: "Battery pack", agency: "UL", stage: "testing", itemsTotal: 12, itemsResolved: 9, itemsOpen: 3 },
  { code: "FCC-15", name: "Radio", agency: "FCC", stage: "done", itemsTotal: 6, itemsResolved: 6, itemsOpen: 0 },
  { code: "CE-EMC", name: "EMC", agency: "CE", stage: "review", itemsTotal: 8, itemsResolved: 5, itemsOpen: 2 },
];
let offline = false;
let reads = 0;
setConnectorReader(async (id) => {
  reads++;
  if (offline) return { id, name: "BomForm", ok: false, url: "", summary: "offline — the Data Room answered 503", metrics: [], checkedAt: Date.now() } as ConnectorState;
  return { id, name: "BomForm", ok: true, url: "", summary: `${programs.length} cert programs`, metrics: [], detail: { certProjects: programs }, checkedAt: Date.now() } as ConnectorState;
});

const sec = editBoard(board, "test", (doc) => appendSection(doc, "Section 1"));
const bom = {
  id: uid("pnl"),
  kind: "panel",
  panel: "connector",
  connector: "bomform",
  sectionId: sec.id,
  name: "BomForm",
  x: 0,
  y: 0,
  float: false,
  bornAt: Date.now(),
  w: 440,
  h: 300,
  ports: [
    { id: "in", name: "in", dir: "in", type: "json" },
    { id: "out", name: "out", dir: "out", type: "json" },
  ],
} as unknown as PanelDoc;
const table: TableDoc = { id: uid("tbl"), kind: "table", sectionId: sec.id, name: "Open programs", x: 0, y: 0, float: false, bornAt: Date.now(), cols: 4, rows: 6, feed: { filter: "itemsOpen > 0", columns: "code, itemsOpen" } };
editBoard(board, "test", (doc) => {
  boardMaps(doc).objects.set(bom.id, bom);
  boardMaps(doc).objects.set(table.id, table);
  setTableCells(doc, table.id, {});
});

/** a person's wire (their browser writes it to the board) */
function wire(from: string, port: string, to: string): LinkDoc {
  const l: LinkDoc = { id: uid("lnk"), from: { panel: from, port }, to: { panel: to, port: TABLE_PORT } };
  editBoard(board, "person", (doc) => boardMaps(doc).links.set(l.id, l));
  return l;
}
const unwire = (id: string) => editBoard(board, "person", (doc) => boardMaps(doc).links.delete(id));
const setFeed = (feed: TableDoc["feed"]) => editBoard(board, "person", (doc) => boardMaps(doc).objects.set(table.id, { ...(m().objects.get(table.id) as TableDoc), feed }));

test("the lens: filter clauses, columns by name (ignoring case and spaces), limit; a clause it can't read says so", () => {
  const recs = [
    { code: "A", "Items Open": 3, stage: "Testing" },
    { code: "B", "Items Open": 0, stage: "done" },
  ];
  assert.deepEqual(applyLens(recs, { filter: "itemsopen > 0" }).records.map((r) => r.code), ["A"]);
  assert.deepEqual(applyLens(recs, { filter: "stage = testing" }).records.map((r) => r.code), ["A"], "= ignores case");
  assert.deepEqual(applyLens(recs, { filter: "stage ~ EST" }).records.map((r) => r.code), ["A"], "~ is contains, ignoring case");
  assert.deepEqual(applyLens(recs, { filter: "stage !~ est; code != a" }).records.map((r) => r.code), ["B"]);
  assert.deepEqual(applyLens(recs, { columns: "code" }).records, [{ code: "A" }, { code: "B" }]);
  assert.equal(applyLens(recs, { limit: 1 }).records.length, 1);
  assert.match(applyLens(recs, { filter: "itemsOpen" }).error ?? "", /isn't a filter/);
  assert.deepEqual(applyLens([["Name", "Qty"], ["bolt", "4"]], {}).records, [{ Name: "bolt", Qty: "4" }], "rows with a header are records");
});

test("a connector with nothing wired out of it isn't read, and puts nothing on its port; nor one wired only into another connector", async () => {
  await feedConnectors(board);
  assert.equal(reads, 0);
  const ff = { ...bom, id: uid("pnl"), connector: "factoryform", name: "FactoryForm" } as PanelDoc;
  editBoard(board, "test", (doc) => {
    boardMaps(doc).objects.set(ff.id, ff);
    boardMaps(doc).links.set("lnk_c2c", { id: "lnk_c2c", from: { panel: bom.id, port: "out" }, to: { panel: ff.id, port: "in" } });
  });
  await feedConnectors(board);
  assert.equal(reads, 0, "the company map's connector-to-connector wires read nothing");
  editBoard(board, "test", (doc) => {
    boardMaps(doc).links.delete("lnk_c2c");
    boardMaps(doc).objects.delete(ff.id);
  });
  assert.equal((m().objects.get(bom.id) as PanelDoc).outputs, undefined);
});

let link: LinkDoc;
test("wired into a table: BomForm's cert programs fill it through its lens, and its flow says what passed", async () => {
  link = wire(bom.id, "out", table.id);
  await feedConnectors(board);
  assert.equal(reads, 1);
  const out = (m().objects.get(bom.id) as PanelDoc).outputs?.out as ReturnType<typeof connectorValue>;
  assert.equal(out.from, "BomForm");
  assert.equal(out.rows.length, 3, "the connector's port carries every program");
  assert.deepEqual(rowsOf(table.id), [
    ["code", "itemsOpen"],
    ["UL-2271", "3"],
    ["CE-EMC", "2"],
  ]);
  const flow = m().flows.get(table.id)!;
  assert.equal(flow.status, "ok");
  assert.equal(flow.rows, 2);
  assert.equal(flow.total, 3);
  assert.equal(flow.from, "BomForm");
});

test("while wired, what changes upstream flows through; a new lens refills the table", async () => {
  programs = programs.map((p) => (p.code === "FCC-15" ? { ...p, itemsOpen: 1 } : p));
  await feedConnectors(board, true);
  assert.deepEqual(rowsOf(table.id).map((r) => r[0]), ["code", "UL-2271", "FCC-15", "CE-EMC"]);
  setFeed({ filter: "agency = ul", columns: "code, stage" });
  fill(board);
  assert.deepEqual(rowsOf(table.id), [
    ["code", "stage"],
    ["UL-2271", "testing"],
  ]);
});

test("taking the wire off stops the flow: the table keeps its last rows and says it's unfed; the connector isn't read", async () => {
  unwire(link.id);
  fill(board);
  assert.equal(m().flows.get(table.id)!.status, "unfed");
  const before = reads;
  programs = programs.map((p) => ({ ...p, agency: "UL", stage: "changed" }));
  await feedConnectors(board, true);
  assert.equal(reads, before, "an unwired connector isn't read");
  fill(board);
  assert.deepEqual(
    rowsOf(table.id),
    [
      ["code", "stage"],
      ["UL-2271", "testing"],
    ],
    "nothing new arrived",
  );
});

test("putting the wire back (a person's ⌘Z) fills it again with what's there now", async () => {
  editBoard(board, "person", (doc) => boardMaps(doc).links.set(link.id, link));
  await feedConnectors(board, true);
  assert.equal(m().flows.get(table.id)!.status, "ok");
  assert.deepEqual(rowsOf(table.id).map((r) => r[1]), ["stage", "changed", "changed", "changed"]);
});

test("a table fed by a table follows it, through its own lens", () => {
  const second: TableDoc = { id: uid("tbl"), kind: "table", sectionId: sec.id, name: "Codes", x: 0, y: 0, float: false, bornAt: Date.now(), cols: 2, rows: 4, feed: { columns: "code" } };
  editBoard(board, "person", (doc) => {
    boardMaps(doc).objects.set(second.id, second);
    setTableCells(doc, second.id, {});
  });
  wire(table.id, TABLE_PORT, second.id);
  fill(board);
  assert.deepEqual(rowsOf(second.id), [["code"], ["UL-2271"], ["FCC-15"], ["CE-EMC"]]);
});

test("a lens it can't read, and an offline system, say why on the table", async () => {
  setFeed({ filter: "only the good ones" });
  fill(board);
  assert.equal(m().flows.get(table.id)!.status, "error");
  assert.match(m().flows.get(table.id)!.error!, /isn't a filter/);
  setFeed({});
  offline = true;
  await feedConnectors(board, true);
  const flow = m().flows.get(table.id)!;
  assert.equal(flow.status, "error");
  assert.match(flow.error!, /BomForm is offline — the Data Room answered 503/);
  offline = false;
  await feedConnectors(board, true);
  assert.equal(m().flows.get(table.id)!.status, "ok", "back online, it fills again");
});

test("the examples lay once, wired: BomForm and FactoryForm into tables, places onto a map", async () => {
  const out = (await runTool(ctx, "lay_flow_examples", { request_id: "ex1" })) as { section: string; cards: string[]; links: string[] };
  assert.equal(out.links.length, 2);
  const objs = out.cards.map((id) => m().objects.get(id)!);
  const map = objs.find((o) => o.kind === "map")!;
  const places = objs.find((o) => o.kind === "table" && o.name.startsWith("Places"))!;
  assert.equal((map as { sourceTableId: string }).sourceTableId, places.id);
  const open = objs.find((o) => o.kind === "table" && o.name.startsWith("Open cert"))! as TableDoc;
  assert.equal(open.feed?.filter, "itemsOpen > 0");
  // the board's own BomForm is reused, not laid twice
  assert.equal(objs.filter((o) => o.kind === "panel" && (o as { connector?: string }).connector === "bomform").length, 0);
  const again = (await runTool(ctx, "lay_flow_examples", { request_id: "ex2" })) as { already?: boolean };
  assert.equal(again.already, true);
});

test("the flows map is the server's alone: a person's socket can't write a table's state", async () => {
  const { SERVER_MAPS } = await import("../src/boards.ts");
  assert.ok((SERVER_MAPS as readonly string[]).includes("flows"));
});

test("an agent's disconnect needs confirm, and then the wire is gone", async () => {
  const l = [...m().links.values()].find((x) => x.to.panel === table.id)!;
  assert.match(String(await runTool(ctx, "disconnect", { link: l.id, confirm: false, request_id: "d1" })), /not disconnected/);
  assert.ok(m().links.get(l.id));
  await runTool(ctx, "disconnect", { link: l.id, confirm: true, request_id: "d2" });
  assert.equal(m().links.get(l.id), undefined);
});

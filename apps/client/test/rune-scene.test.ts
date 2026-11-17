/**
 * The Rune renderer draws what the store's own geometry says (rune/scene.ts):
 * the same rects the web renderer, the wires and the cursors read. These hold
 * the scene to that, and the parity ledger (rune/parity.ts) to being usable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRemote, getState, objectWorldRect, sectionRestRect, setActiveObject, type NoteMeta, type PanelMeta, type Section, type TableMeta } from "../src/state/store";
import { SCENE_VERSION, TOKEN_VARS, buildScene, hitWorld, isIsland, type SceneTokens } from "../src/rune/scene";
import { workbook } from "../src/engine/workbook";
import { PARITY, PARITY_WORD, parityCounts } from "../src/rune/parity";
import { cardChrome, runCardTool, runSectionTool, sectionTools } from "../src/rune/tools";
import { requestRemoveSection, setSectionDragTarget } from "../src/state/store";
import { readFileSync } from "node:fs";

const sec = (id: string, c0: number, c1 = c0): Section => ({ id, name: id, c0, r0: 0, c1, r1: 0 });
const note = (id: string, sectionId: string, bornAt: number, more: Partial<NoteMeta> = {}): NoteMeta => ({ id, sectionId, name: id, x: 0, y: 0, float: false, bornAt, w: 300, h: 200, text: `# ${id}`, ...more });
const table = (id: string, sectionId: string): TableMeta => ({ id, sectionId, name: id, x: 0, y: 0, float: false, bornAt: 5, cols: 3, rows: 6 }) as TableMeta;
const app = (id: string, sectionId: string): PanelMeta => ({ id, sectionId, name: id, panel: "app", x: 0, y: 0, float: false, bornAt: 7, w: 400, h: 300, ports: [] }) as unknown as PanelMeta;

applyRemote({
  grid: { cols: [1560, 1560, 1560], rows: [1160] },
  sections: { A: sec("A", 0), B: sec("B", 1) },
  notes: { a1: note("a1", "A", 1), a2: note("a2", "A", 2, { createdBy: "Wren" }), b1: note("b1", "B", 3, { float: true, x: 400, y: 300 }) },
  tables: { t1: table("t1", "B") },
  maps: {},
  media: {},
  panels: { p1: app("p1", "A") },
  links: {},
});

const tokens = Object.fromEntries(Object.keys(TOKEN_VARS).map((k) => [k, [0, 0, 0, 1]])) as SceneTokens;
const opts = { insets: { left: 272, top: 44, right: 0 }, readOnly: false, tokens, paper: true };

test("sections and cards sit exactly where the store's geometry puts them", () => {
  const st = getState();
  const scene = buildScene(st, opts);
  assert.equal(scene.version, SCENE_VERSION);
  assert.deepEqual(scene.view, opts.insets);
  assert.equal(scene.sections.length, 2);
  for (const s of scene.sections) {
    const r = sectionRestRect(st.grid, st.sections[s.id]);
    assert.deepEqual({ x: s.x, y: s.y, w: s.w, h: s.h }, r);
  }
  // the app is the web's (an island): Rune is handed the three notes and the table
  assert.deepEqual(scene.cards.map((c) => c.id).sort(), ["a1", "a2", "b1", "t1"]);
  for (const c of scene.cards) {
    const o = st.notes[c.id] ?? st.tables[c.id];
    const r = objectWorldRect(o)!;
    assert.equal(c.x, r.x);
    assert.equal(c.y, r.y);
    // its own size, drawn at the section's fit: together, the rect the wires land on
    assert.ok(Math.abs(c.w * c.s - r.w) < 1e-6 && Math.abs(c.h * c.s - r.h) < 1e-6, c.id);
  }
});

test("the header says what the web renderer's does: coordinates and a count", () => {
  const scene = buildScene(getState(), opts);
  const a = scene.sections.find((s) => s.id === "A")!;
  assert.equal(a.coords, "A1");
  assert.equal(a.count, "3");
  applyRemote({ sections: { ...getState().sections, B: sec("B", 1, 2) } });
  assert.equal(buildScene(getState(), opts).sections.find((s) => s.id === "B")!.coords, "B1:C1");
  applyRemote({ sections: { ...getState().sections, B: sec("B", 1) } });
});

test("cards say what they are, who made them, and which is selected", () => {
  setActiveObject("a1");
  const cards = Object.fromEntries(buildScene(getState(), opts).cards.map((c) => [c.id, c]));
  assert.equal(cards.a1.kind, "note");
  assert.equal(cards.a1.text, "# a1");
  assert.equal(cards.a1.active, true);
  assert.equal(cards.a2.active, false);
  assert.equal(cards.a2.agent, "Wren");
  assert.equal(cards.t1.kind, "table");
  assert.equal(cards.p1, undefined);
});

test("every card is drawn by exactly one of them: web content is an island, and so is the table in hand", () => {
  const st = () => getState();
  setActiveObject("a1");
  assert.equal(isIsland(st(), st().panels.p1), true);
  assert.equal(isIsland(st(), st().notes.a1), false);
  assert.equal(isIsland(st(), st().tables.t1), false);
  // pressed, the live sheet takes the table's place; let go of, it's Rune's again
  setActiveObject("t1");
  assert.equal(isIsland(st(), st().tables.t1), true);
  assert.equal(buildScene(st(), opts).cards.some((c) => c.id === "t1"), false);
  setActiveObject("a1");
  assert.equal(buildScene(st(), opts).cards.some((c) => c.id === "t1"), true);
  // a video is the web's; an image is Rune's when it can fetch it, the web's when it can't
  const media = (media: "image" | "video") => ({ id: "m", sectionId: "A", name: "m", x: 0, y: 0, float: false, bornAt: 9, w: 200, h: 100, src: "/files/abc", media, autoplay: false, muted: true });
  assert.equal(isIsland(st(), media("video")), true);
  assert.equal(isIsland(st(), media("image")), false);
  assert.equal(isIsland(st(), media("image"), { imageSrc: () => "" }), true);
});

test("a table at rest is handed over with what each cell shows", () => {
  workbook.addTable("t1", "t1", 3, 6);
  workbook.setCell("t1", 0, 0, "Part");
  workbook.setCell("t1", 1, 0, "1234.5");
  workbook.setCell("t1", 1, 1, "=B1*2");
  workbook.setCell("t1", 2, 2, "=1/0");
  const t = buildScene(getState(), opts).cards.find((c) => c.id === "t1")!;
  assert.equal(t.cols, 3);
  assert.equal(t.rows, 6);
  const at = (c: number, r: number) => t.cells.find((x) => x.c === c && x.r === r);
  assert.deepEqual(at(0, 0), { c: 0, r: 0, t: "Part", n: false, e: false });
  assert.deepEqual(at(1, 0), { c: 1, r: 0, t: "1,234.5", n: true, e: false });
  assert.deepEqual(at(1, 1), { c: 1, r: 1, t: "2,469", n: true, e: false });
  assert.equal(at(2, 2)?.e, true);
  // empty cells aren't sent
  assert.equal(t.cells.length, 4);
});

test("empty cells are offered where no section is", () => {
  const scene = buildScene(getState(), opts);
  assert.deepEqual(scene.empties.map((e) => e.label), ["C1"]);
  assert.equal(scene.grid.cols.map((c) => c.label).join(""), "ABC");
  // one line between A and B, one between B and the empty cell
  assert.equal(scene.grid.lines.filter((l) => l.vertical).length, 2);
});

test("a point of the world is the topmost card, else the section's paper, else the paper", () => {
  const st = getState();
  const r = objectWorldRect(st.notes.b1)!;
  assert.deepEqual(hitWorld(st, r.x + 5, r.y + 5), { section: "B", object: "b1" });
  const b = sectionRestRect(st.grid, st.sections.B);
  assert.deepEqual(hitWorld(st, b.x + b.w - 30, b.y + 10), { section: "B", object: null });
  // the 40 px road between two sections, and the empty cell, are the grid's paper
  assert.deepEqual(hitWorld(st, 1560, 300), { section: null, object: null });
  assert.deepEqual(hitWorld(st, 1560 * 2 + 400, 300), { section: null, object: null });
});

test("a viewer's board is handed over read-only, and an image only by an address Rune can fetch", () => {
  assert.equal(buildScene(getState(), { ...opts, readOnly: true }).readOnly, true);
  applyRemote({ media: { m1: { id: "m1", sectionId: "A", name: "m1", x: 0, y: 0, float: false, bornAt: 9, w: 200, h: 100, src: "/files/abc", media: "image", autoplay: false, muted: true } } });
  const card = (f?: (s: string) => string) => buildScene(getState(), { ...opts, imageSrc: f }).cards.find((c) => c.id === "m1");
  assert.equal(card()?.src, "/files/abc");
  // one Rune can't fetch isn't handed over at all: it's the web's
  assert.equal(card(() => ""), undefined);
  applyRemote({ media: {} });
});

test("a section's toolbar is the web toolbar's, in its groups; a viewer has none", () => {
  const st = getState();
  const tools = sectionTools(st, st.sections.B, false);
  assert.deepEqual(tools.map((t) => t.id), ["app", "table", "map", "note", "upload", "split-h", "split-v", "open", "ask", "remove"]);
  // a hairline before each group but the first
  assert.deepEqual(tools.filter((t) => t.gap).map((t) => t.id), ["split-h", "ask"]);
  assert.equal(tools.find((t) => t.id === "ask")!.tone, "agent");
  assert.equal(tools.find((t) => t.id === "remove")!.tone, "danger");
  assert.deepEqual(sectionTools(st, st.sections.B, true), []);
  const viewer = buildScene(st, { ...opts, readOnly: true });
  assert.ok(viewer.sections.every((x) => x.tools.length === 0 && !x.movable));
  assert.ok(viewer.cards.every((c) => c.chrome === "" && !c.resizable));
});

test("a tool does what the web's does: a note is added, a section is split, removing asks first", () => {
  const before = Object.keys(getState().notes).length;
  runSectionTool("B", "note");
  assert.equal(Object.keys(getState().notes).length, before + 1);
  const added = Object.values(getState().notes).find((n) => !["a1", "a2", "b1"].includes(n.id))!;
  // the note's bar: set it free, dock it again, remove it
  assert.deepEqual(cardChrome(added, false), { chrome: "bar", tools: [{ id: "float", icon: "float", tone: "", gap: false }, { id: "remove", icon: "remove", tone: "", gap: false }], resizable: true });
  runCardTool(added.id, "float");
  assert.equal(getState().notes[added.id].float, true);
  assert.equal(cardChrome(getState().notes[added.id], false).tools[0].id, "dock");
  runCardTool(added.id, "remove");
  assert.equal(getState().notes[added.id], undefined);

  // remove asks: the scene carries the question until it's answered
  runSectionTool("B", "remove");
  assert.equal(getState().pendingRemoval, "B");
  assert.match(buildScene(getState(), opts).sections.find((x) => x.id === "B")!.confirm, /^Remove B and \d+ items\?$/);
  requestRemoveSection(null);
  assert.equal(buildScene(getState(), opts).sections.find((x) => x.id === "B")!.confirm, "");
});

test("a section being dragged shows where it would land: a cell, or a band along the board's edge", () => {
  setSectionDragTarget({ sectionId: "A", c: 2, r: 0 });
  assert.deepEqual(buildScene(getState(), opts).drop, { x: 1560 * 2 + 6, y: 6, w: 1560 - 12, h: 1160 - 12, label: "" });
  setSectionDragTarget({ sectionId: "A", c: -1, r: -1, edge: "right" });
  const band = buildScene(getState(), opts).drop!;
  assert.equal(band.x, 1560 * 3 + 12);
  assert.equal(band.label, "Append along the right of the board");
  setSectionDragTarget(null);
  assert.equal(buildScene(getState(), opts).drop, null);
});

test("the scene's shape and the Rust reader agree on a version and on the tokens", () => {
  const rs = readFileSync(new URL("../../rune/src/scene.rs", import.meta.url), "utf8");
  assert.equal(Number(/SCENE_VERSION: u32 = (\d+)/.exec(rs)?.[1]), SCENE_VERSION);
  const fields = /pub struct Tokens \{([^}]+)\}/.exec(rs)![1].match(/pub (\w+):/g)!.map((f) => f.slice(4, -1).replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
  assert.deepEqual(fields.sort(), Object.keys(TOKEN_VARS).sort());
});

test("the parity ledger names every row once and counts them", () => {
  const rows = PARITY.flatMap((g) => g.rows);
  assert.equal(new Set(rows.map((r) => r.what)).size, rows.length);
  for (const r of rows) {
    assert.ok(r.status in PARITY_WORD, r.what);
    // anything short of the same says how
    if (r.status === "partial") assert.ok(r.note, `${r.what} is partial: say what differs`);
  }
  const n = parityCounts();
  assert.equal(n.same + n.partial + n.web + n.missing, rows.length);
});

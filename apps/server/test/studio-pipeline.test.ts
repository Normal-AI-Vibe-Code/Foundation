/**
 * The Character studio's pipeline row and a person's word on a character (2026-11-16).
 *
 *  - A new studio has three rows: Inspiration, Pipeline, Characters. A set's pipeline is the flow as
 *    cards (2026-11-17): nine nodes, one per stage between the input and the output, joined by the
 *    grid's own links, in a band the section's docked cards flow under.
 *  - A studio from before gets the row put in between, once; what was there keeps its place below.
 *  - A studio of 2026-11-16 (one flow card per set) gets the nodes, once: the flow card becomes the
 *    first node, the cards in the making stay, the tracks only grow.
 *  - A character a person makes is pending: it can be archived at any time, approved only once it's
 *    finished, and only approved (or older, unmarked) finished characters are offered as avatars.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_STARTER_DIR = "";

const { closeBoards, editBoard, getBoard, createBoardRow } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { run } = await import("../src/db.ts");
const { openStudio, upgradeStudio, createCharacter, setApproval, roster, STUDIO_COL_W } = await import("../src/characters.ts");
const { boardMaps, characterChoosable, uid, DEFAULT_COL_W, DEFAULT_ROW_H, PIPELINE_NODES, PIPELINE_WIRES } = await import("@foundation/protocol");
type PanelDoc = import("@foundation/protocol").PanelDoc;

after(() => closeBoards());
const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const top = (id: string) => [...boardMaps(getBoard(id).doc).sections.values()].filter((s) => !s.parent);
const nodesOf = (id: string, sectionId: string) => [...boardMaps(getBoard(id).doc).objects.values()].filter((o): o is PanelDoc => o.sectionId === sectionId && o.kind === "panel" && o.panel === "pipeline");

/** a set's flow is whole: nine nodes in order, each wire of the flow a link between two of their ports, nothing overlapping */
function assertFlow(id: string, sectionId: string, set: string) {
  const m = boardMaps(getBoard(id).doc);
  const nodes = nodesOf(id, sectionId);
  assert.deepEqual(nodes.map((n) => n.node).sort(), [...PIPELINE_NODES].sort());
  const by = new Map(nodes.map((n) => [n.node!, n]));
  for (const n of nodes) {
    assert.equal(n.source, set.toLowerCase());
    assert.equal(n.float, true, "a node keeps its place in the band");
  }
  const mine = new Set(nodes.map((n) => n.id));
  const links = [...m.links.values()].filter((l) => mine.has(l.from.panel) && mine.has(l.to.panel));
  assert.equal(links.length, PIPELINE_WIRES.length);
  for (const w of PIPELINE_WIRES) {
    const from = by.get(w.from)!;
    const to = by.get(w.to)!;
    const out = from.ports.find((p) => p.dir === "out" && p.name === w.carries);
    const into = to.ports.find((p) => p.dir === "in" && p.name === w.carries);
    assert.ok(out && into, `${w.from} → ${w.to} has its ports`);
    assert.ok(links.some((l) => l.from.panel === from.id && l.from.port === out.id && l.to.panel === to.id && l.to.port === into.id), `${w.from} → ${w.to} is wired`);
    assert.ok(to.x > from.x, `${w.from} → ${w.to} runs left to right`);
  }
  for (const a of nodes) for (const b of nodes) if (a.id < b.id) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.node} and ${b.node} don't overlap`);
  // the band is one block: nothing docked fits beside the short nodes, so cards in the making start under it
  const bottom = Math.max(...nodes.map((n) => n.y + n.h));
  assert.equal(by.get("inspiration")!.y + by.get("inspiration")!.h, bottom);
  assert.equal(by.get("output")!.y + by.get("output")!.h, bottom);
  assert.ok(Math.max(...nodes.map((n) => n.x + n.w)) + 56 <= STUDIO_COL_W, "the band fits a studio column at full size");
}

test("a new studio: inspiration, the pipeline as nodes wired in order for each set, characters", () => {
  const { id, made } = openStudio(ada);
  assert.equal(made, true);
  const m = boardMaps(getBoard(id).doc);
  assert.equal(m.grid.get("tracks")!.rows.length, 3);
  for (const set of ["Anime", "Animals", "Abstract"]) {
    const row = (name: string) => top(id).find((s) => s.name === `${name} · ${set}`)!.r0;
    assert.deepEqual([row("Inspiration"), row("Pipeline"), row("Characters")], [0, 1, 2]);
    const pipe = top(id).find((s) => s.name === `Pipeline · ${set}`)!;
    assertFlow(id, pipe.id, set);
  }
  assert.ok(m.grid.get("tracks")!.cols.every((w) => w >= STUDIO_COL_W));
  // opening it again changes nothing
  const before = top(id).length;
  const cards = m.objects.size;
  const wires = m.links.size;
  assert.equal(openStudio(ada).made, false);
  assert.equal(top(id).length, before);
  assert.equal(m.objects.size, cards);
  assert.equal(m.links.size, wires);
});

test("a studio from before the pipeline gets the row between, once; characters keep their place below", () => {
  const id = createBoardRow("Old studio");
  let chars = "";
  editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    m.grid.set("tracks", { cols: [DEFAULT_COL_W, DEFAULT_COL_W], rows: [DEFAULT_ROW_H, DEFAULT_ROW_H] });
    ["Anime", "Animals"].forEach((set, c) => {
      m.sections.set(`i${c}`, { id: `i${c}`, name: `Inspiration · ${set}`, c0: c, r0: 0, c1: c, r1: 0 });
      m.sections.set(`c${c}`, { id: `c${c}`, name: `Characters · ${set}`, c0: c, r0: 1, c1: c, r1: 1 });
    });
    chars = uid("pnl");
    m.objects.set(chars, { id: chars, kind: "panel", panel: "character", sectionId: "c1", name: "Mochi", x: 0, y: 0, float: false, bornAt: 1, w: 460, h: 620, ports: [] });
  });
  upgradeStudio(id);
  const m = boardMaps(getBoard(id).doc);
  assert.equal(m.grid.get("tracks")!.rows.length, 3);
  assert.deepEqual([m.sections.get("i1")!.r0, m.sections.get("c1")!.r0, m.sections.get("c1")!.r1], [0, 2, 2]);
  const pipe = top(id).filter((s) => s.name.startsWith("Pipeline · "));
  assert.deepEqual(pipe.map((s) => [s.name, s.c0, s.r0]).sort(), [["Pipeline · Animals", 1, 1], ["Pipeline · Anime", 0, 1]]);
  assert.equal(m.objects.get(chars)!.sectionId, "c1", "the card is where it was");
  for (const s of pipe) assertFlow(id, s.id, s.name.replace("Pipeline · ", ""));
  const cards = m.objects.size;
  upgradeStudio(id);
  assert.equal(top(id).filter((s) => s.name.startsWith("Pipeline · ")).length, 2, "once");
  assert.equal(m.objects.size, cards, "once");
});

test("a studio of 2026-11-16 (one flow card per set) gets the flow as nodes, once: nothing is taken away, and the tracks only grow", () => {
  const id = createBoardRow("Studio with flow cards");
  editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    // a person had made the last column wider and the pipeline row taller than the studio would
    m.grid.set("tracks", { cols: [DEFAULT_COL_W, 2600], rows: [DEFAULT_ROW_H, 1040, DEFAULT_ROW_H] });
    ["Anime", "Animals"].forEach((set, c) => {
      m.sections.set(`i${c}`, { id: `i${c}`, name: `Inspiration · ${set}`, c0: c, r0: 0, c1: c, r1: 0 });
      m.sections.set(`p${c}`, { id: `p${c}`, name: `Pipeline · ${set}`, c0: c, r0: 1, c1: c, r1: 1 });
      m.sections.set(`c${c}`, { id: `c${c}`, name: `Characters · ${set}`, c0: c, r0: 2, c1: c, r1: 2 });
      m.objects.set(`flow${c}`, { id: `flow${c}`, kind: "panel", panel: "pipeline", sectionId: `p${c}`, name: `${set} pipeline`, x: 0, y: 0, float: false, bornAt: 1, w: 1480, h: 330, ports: [], source: set.toLowerCase() });
    });
    // a character in the making under the flow card, a finished one below, and a note someone left
    m.objects.set("making", { id: "making", kind: "panel", panel: "character", sectionId: "p1", name: "Kuro", x: 0, y: 0, float: false, bornAt: 2, w: 460, h: 620, ports: [] });
    m.objects.set("finished", { id: "finished", kind: "panel", panel: "character", sectionId: "c1", name: "Mochi", x: 0, y: 0, float: false, bornAt: 3, w: 460, h: 620, ports: [] });
    m.objects.set("note", { id: "note", kind: "note", sectionId: "p0", name: "Ideas", x: 40, y: 700, float: true, bornAt: 4, w: 300, h: 200 } as never);
  });
  const m = boardMaps(getBoard(id).doc);
  const was = new Map([...m.objects.entries()].map(([k, v]) => [k, structuredClone(v)]));
  upgradeStudio(id);
  // every card that was there is still there, and only the flow cards changed (each is now its set's first node);
  // a character card from before ports gains its output (to wire into Foundation's avatars), and nothing else
  for (const [k, v] of was) {
    assert.ok(m.objects.has(k), `${k} is still on the board`);
    if (k.startsWith("flow")) continue;
    const now = m.objects.get(k) as PanelDoc;
    if (now.kind === "panel" && now.panel === "character") {
      assert.deepEqual(now.ports.map((p) => [p.name, p.dir, p.type]), [["character", "out", "character"]], `${k} has its output`);
      assert.deepEqual({ ...now, ports: [] }, { ...v, ports: [] }, `${k} is otherwise as it was`);
    } else assert.deepEqual(now, v, `${k} is as it was`);
  }
  for (const c of [0, 1]) {
    const first = m.objects.get(`flow${c}`) as PanelDoc;
    assert.equal(first.node, "inspiration");
    assert.equal(first.bornAt, 1);
    assertFlow(id, `p${c}`, c ? "Animals" : "Anime");
  }
  assert.equal(m.objects.size, was.size + 2 * (PIPELINE_NODES.length - 1));
  assert.equal(m.sections.size, 6);
  const tracks = m.grid.get("tracks")!;
  assert.equal(tracks.cols[0], STUDIO_COL_W, "a column grows to hold the band");
  assert.equal(tracks.cols[1], 2600, "a wider one is left as it was");
  assert.ok(tracks.rows[1] > 1040, "the pipeline row grows for the band and a shelf of cards");
  assert.deepEqual([tracks.rows[0], tracks.rows[2]], [DEFAULT_ROW_H, DEFAULT_ROW_H]);
  // once: again, and after a person takes a node away or moves one, nothing is put back
  const after = JSON.stringify([[...m.objects.entries()], [...m.links.entries()], tracks]);
  upgradeStudio(id);
  assert.equal(JSON.stringify([[...m.objects.entries()], [...m.links.entries()], m.grid.get("tracks")]), after);
  const moods = nodesOf(id, "p0").find((n) => n.node === "clips")!;
  getBoard(id).doc.transact(() => m.objects.delete(moods.id));
  upgradeStudio(id);
  assert.equal(nodesOf(id, "p0").length, PIPELINE_NODES.length - 1, "a node a person removed stays removed");
});

test("a character a person makes waits for approval: archived any time, approved only when finished, offered only when approved", () => {
  const { id } = openStudio(ada);
  const made = createCharacter(id, { name: ada.name, id: ada.id, human: true }, { name: "Pip", set: "abstract", form: "mesh", identity: "a dot" });
  assert.equal(made.approval, "pending");
  assert.equal(characterChoosable(made), false);
  assert.throws(() => setApproval(id, made.panelId, "approved", ada), /isn't finished yet/);
  assert.equal(setApproval(id, made.panelId, "archived", ada).approval, "archived");
  assert.equal(setApproval(id, made.panelId, "pending", ada).approval, "pending");

  // finished (its mesh avatar is in): now it can be approved, and only then is it one to choose
  const c = { ...made, files: { front: "f_1", portrait: "f_2", mavatar: "f_3" }, ready: true };
  run("update characters set state = ? where id = ?", JSON.stringify(c), made.id);
  assert.equal(characterChoosable(roster().characters.find((x) => x.id === made.id)!), false, "finished but pending");
  assert.equal(setApproval(id, made.panelId, "approved", ada).approval, "approved");
  assert.equal(characterChoosable(roster().characters.find((x) => x.id === made.id)!), true);
  assert.equal(boardMaps(getBoard(id).doc).characters.get(made.panelId)!.approval, "approved", "everyone on the grid sees it");
  setApproval(id, made.panelId, "archived", ada);
  assert.equal(characterChoosable(roster().characters.find((x) => x.id === made.id)!), false);
  assert.ok(roster().characters.some((x) => x.id === made.id), "archived is kept, not gone");

  // a character from before approvals (and the starter set) reads as approved
  assert.equal(characterChoosable({ ready: true }), true);
  assert.equal(characterChoosable({ ready: false }), false);
});

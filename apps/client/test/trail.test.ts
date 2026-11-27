/**
 * The grid behind the grid's layout (src/trail/model.ts): agenttrail's map of sections, wires, agents' trails and
 * handoffs, on a grid's sections.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { depths, edgePath, fileKind, handoffsOf, layoutTrail, pathOf, whereNow, type TrailLane, type TrailStep } from "../src/trail/model.ts";

const NOW = 1_000_000_000;
const step = (o: Partial<TrailStep>): TrailStep => ({ kind: "tool", at: NOW - 30_000, ms: 40, tool: "add_note", label: "making a note", read: false, ok: true, section: null, card: null, ...o });
const lane = (o: Partial<TrailLane>): TrailLane => ({
  crew: "c1",
  name: "Kimi",
  hue: 1,
  via: "t3:kimi",
  kind: "t3",
  askerName: "Ada",
  mine: true,
  task: "do it",
  status: "working",
  doing: "working",
  started: NOW - 60_000,
  ended: null,
  private: false,
  home: { id: "a", name: "A" },
  sections: [],
  cards: [],
  steps: [],
  files: [],
  thread: null,
  plan: null,
  ...o,
});
const sections = [
  { id: "a", name: "A", c0: 0, r0: 0 },
  { id: "b", name: "B", c0: 1, r0: 0 },
  { id: "c", name: "C", c0: 2, r0: 0 },
  { id: "d", name: "D", c0: 0, r0: 1 },
];

test("columns follow the longest chain of wires, and survive a loop", () => {
  const d = depths(["a", "b", "c", "d"], [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "c" },
    { from: "c", to: "a" },
  ]);
  assert.ok(d.get("b")! > d.get("a")! || d.get("a")! > 0, "a loop doesn't run forever");
  assert.equal(d.get("d"), 0);
  const plain = depths(["a", "b", "c"], [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "c" },
  ]);
  assert.deepEqual([plain.get("a"), plain.get("b"), plain.get("c")], [0, 1, 2]);
});

test("only the sections an agent touched are shown, unless all are asked for; a long column wraps", () => {
  const l = lane({ sections: [{ id: "b", name: "B", reads: 1, writes: 0 }] });
  const touched = layoutTrail({ sections, wires: [], lanes: [l], now: NOW });
  assert.deepEqual(touched.nodes.map((n) => n.id).sort(), ["a", "b"]);
  const all = layoutTrail({ sections, wires: [], lanes: [l], all: true, now: NOW });
  assert.equal(all.nodes.length, 4);
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, c0: 0, r0: i }));
  const wrapped = layoutTrail({ sections: many, wires: [], lanes: [], all: true, now: NOW });
  assert.equal(new Set(wrapped.nodes.map((n) => n.x)).size, 2, "five to a column, then the next");
  assert.ok(wrapped.nodes.every((n, i, arr) => arr.every((m) => m === n || m.x !== n.x || Math.abs(m.y - n.y) >= n.h)), "none on another");
});

test("a section's ring and words say how it stands: an agent in it, written, failed, busy in the last minute", () => {
  const working = lane({
    crew: "w",
    steps: [step({ section: "a" }), step({ section: "a", at: NOW - 10_000 }), step({ section: "a", at: NOW - 5_000 })],
    sections: [{ id: "a", name: "A", reads: 0, writes: 3 }],
  });
  const failed = lane({ crew: "f", status: "error", ended: NOW - 1000, home: { id: "b", name: "B" }, steps: [step({ section: "b", ok: false })], sections: [{ id: "b", name: "B", reads: 0, writes: 1 }] });
  const done = lane({ crew: "d", status: "done", ended: NOW - 1000, home: { id: "c", name: "C" }, steps: [step({ section: "c", at: NOW - 600_000 })], sections: [{ id: "c", name: "C", reads: 0, writes: 1 }] });
  const L = layoutTrail({ sections, wires: [], lanes: [working, failed, done], now: NOW });
  const n = (id: string) => L.nodes.find((x) => x.id === id)!;
  assert.equal(n("a").state, "active");
  assert.deepEqual(n("a").here, ["w"]);
  assert.equal(n("a").activity, "Revising");
  assert.equal(n("b").state, "failed");
  assert.equal(n("c").state, "done");
  assert.equal(n("c").activity, null);
});

test("two agents writing in one section at once is contested; one after another finished is a handoff", () => {
  const one = lane({ crew: "one", name: "Kimi", steps: [step({ section: "a", at: NOW - 20_000 })], sections: [{ id: "a", name: "A", reads: 0, writes: 1 }] });
  const two = lane({ crew: "two", name: "Lyra", hue: 2, kind: "council", via: "claude", steps: [step({ section: "a", at: NOW - 10_000 })], sections: [{ id: "a", name: "A", reads: 0, writes: 1 }] });
  assert.equal(layoutTrail({ sections, wires: [], lanes: [one, two], now: NOW }).nodes.find((x) => x.id === "a")!.contested, true);

  const before = lane({ crew: "before", status: "done", ended: NOW - 300_000, steps: [step({ section: "a", at: NOW - 400_000 })], sections: [{ id: "a", name: "A", reads: 0, writes: 1 }] });
  const after = lane({ crew: "after", steps: [step({ section: "a", at: NOW - 100_000 })], sections: [{ id: "a", name: "A", reads: 0, writes: 1 }] });
  assert.deepEqual(handoffsOf([before, after]), [{ section: "a", from: "before", to: "after", at: NOW - 100_000 }]);
  // too long after, or a read, or a failed write, isn't a handoff
  const late = lane({ crew: "late", steps: [step({ section: "a", at: NOW + 20 * 60_000 })] });
  const reader = lane({ crew: "reader", steps: [step({ section: "a", at: NOW - 100_000, read: true })] });
  const broke = lane({ crew: "broke", steps: [step({ section: "a", at: NOW - 100_000, ok: false })] });
  assert.deepEqual(handoffsOf([before, late]), []);
  assert.deepEqual(handoffsOf([before, reader]), []);
  assert.deepEqual(handoffsOf([before, broke]), []);
});

test("an agent's trail goes through its home and each section it visited; its folder is a node beside its home", () => {
  const l = lane({
    steps: [step({ section: "b" }), step({ section: "b" }), step({ kind: "thought", tool: "", section: null }), step({ section: "c" }), step({ section: "b" })],
    sections: [
      { id: "b", name: "B", reads: 0, writes: 3 },
      { id: "c", name: "C", reads: 0, writes: 1 },
    ],
    files: [{ path: "src/bom.ts", change: "added", at: NOW - 1000, bytes: 20 }],
  });
  assert.deepEqual(pathOf(l), ["a", "b", "c", "b"]);
  assert.equal(whereNow(l), "b");
  const L = layoutTrail({ sections, wires: [{ from: "a", to: "b" }], lanes: [l], now: NOW });
  const folder = L.nodes.find((n) => n.kind === "folder")!;
  assert.equal(folder.id, "folder:c1");
  assert.equal(folder.activity, "Editing");
  assert.ok(folder.x > Math.max(...L.nodes.filter((n) => n.kind === "section").map((n) => n.x)), "after the sections");
  assert.equal(folder.y, L.nodes.find((n) => n.id === "a")!.y, "beside its home");
  assert.deepEqual(L.paths[0].nodes, ["a", "b", "c", "b", "folder:c1"]);
  assert.ok(L.edges.some((e) => e.kind === "folder" && e.from === "a" && e.to === "folder:c1"));
  const wire = L.edges.find((e) => e.kind === "wire")!;
  assert.equal(wire.active, true, "an agent stands at one end");
});

test("an agent that hasn't stepped yet stands in its home; a run with no home and no step has no trail", () => {
  const fresh = lane({ steps: [] });
  assert.equal(whereNow(fresh), "a");
  const L = layoutTrail({ sections, wires: [], lanes: [fresh, lane({ crew: "x", home: null })], now: NOW });
  assert.deepEqual(L.nodes.find((n) => n.id === "a")!.here, ["c1"]);
  assert.equal(L.paths.length, 0);
});

test("edges run right side to left side, or round when they go back; files are known by their kind", () => {
  assert.match(edgePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 }), /^M100,25 C/);
  assert.match(edgePath({ x: 300, y: 0, w: 100, h: 50 }, { x: 300, y: 200, w: 100, h: 50 }), /^M350,50 C/);
  assert.deepEqual(["a.tsx", "b.stl", "c.md", "d.json", "e.sh", "f.html", "g"].map(fileKind), ["code", "image", "doc", "data", "shell", "page", "file"]);
});

/**
 * The flow-diagram rules (DESIGN.md → Wires), checked on the real router.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { offsetRoute, pipeCrossings, polyline, road, route, routeSides, segmentOverlap, sideToward, tunnelGeometry, typesCompatible, type P } from "../src/shell/wireGeometry.ts";

function angles(pts: P[]) {
  return pts.slice(1).map((p, i) => {
    const a = (Math.atan2(p.y - pts[i].y, p.x - pts[i].x) * 180) / Math.PI;
    return ((Math.round(a) % 360) + 360) % 360;
  });
}

const cases: Array<[P, P]> = [
  [{ x: 0, y: 0 }, { x: 400, y: 0 }],
  [{ x: 0, y: 0 }, { x: 400, y: 120 }],
  [{ x: 0, y: 0 }, { x: 160, y: 300 }],
  [{ x: 0, y: 0 }, { x: 400, y: -260 }],
  [{ x: 500, y: 100 }, { x: 0, y: 600 }],
  [{ x: 500, y: 100 }, { x: 0, y: 110 }],
];

test("roads only: every segment is horizontal, vertical or 45°", () => {
  for (const [a, b] of cases) {
    for (const ang of angles(route(a, b))) assert.ok(ang % 45 === 0, `angle ${ang} in ${JSON.stringify([a, b])}`);
  }
});

test("wires leave and arrive on a straight horizontal lead", () => {
  for (const [a, b] of cases) {
    const pts = route(a, b);
    assert.equal(pts[1].y, a.y, "leaves level");
    assert.ok(pts[1].x > a.x, "leaves to the right");
    assert.equal(pts[pts.length - 2].y, b.y, "arrives level");
    assert.ok(pts[pts.length - 2].x < b.x, "arrives from the left");
  }
});

test("a backward wire between stacked cards crosses in the gap, never through a card", () => {
  const src = { x: 600, y: 0, w: 400, h: 300 };
  const dst = { x: 0, y: 500, w: 400, h: 300 };
  const pts = route({ x: 1000, y: 100 }, { x: 0, y: 600 }, { src, dst });
  const lane = pts.find((p, i) => i > 0 && p.y === pts[i - 1].y && p.y > 300 && p.y < 500);
  assert.ok(lane, "has a horizontal run in the gap between the cards");
  const inside = (p: P, r: typeof src) => p.x > r.x + 1 && p.x < r.x + r.w - 1 && p.y > r.y + 1 && p.y < r.y + r.h - 1;
  for (let i = 1; i < pts.length; i++) {
    const mid = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
    assert.ok(!inside(mid, src) && !inside(mid, dst), "no segment runs through a card");
  }
});

test("over/under is stable: the earlier id tunnels; crossings near ports don't", () => {
  const h = [{ x: 0, y: 100 }, { x: 400, y: 100 }];
  const v = [{ x: 200, y: 0 }, { x: 200, y: 300 }];
  const c = pipeCrossings([
    { id: "b", points: v },
    { id: "a", points: h },
  ]);
  assert.equal(c.get("a")?.length, 1, "a goes under");
  assert.equal(c.get("b"), undefined, "b stays on top");
  const t = tunnelGeometry(h, c.get("a")!, 13);
  assert.match(t.cut, /^M .* Z$/, "the under-wire is cut at the crossing");
  assert.equal(t.terminals.split("M").length - 1, 2, "two portal marks");
  const nearPort = pipeCrossings([
    { id: "a", points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] },
    { id: "b", points: [{ x: 20, y: -100 }, { x: 20, y: 100 }] },
  ]);
  assert.equal(nearPort.size, 0, "no tunnel within 36 px of a port");
});

test("parallel lanes stay evenly spaced through a 45° bend", () => {
  const base = route({ x: 0, y: 0 }, { x: 400, y: 120 });
  const lane = offsetRoute(base, 4);
  assert.equal(lane.length, base.length);
  assert.ok(Math.abs(lane[0].y - base[0].y - 4) < 1e-6 || Math.abs(lane[0].y - base[0].y + 4) < 1e-6);
});

test("types: same type, or json on either side", () => {
  assert.ok(typesCompatible("cad", "cad"));
  assert.ok(typesCompatible("cad", "json"));
  assert.ok(!typesCompatible("cad", "image"));
});

import { routeAvoiding, segmentHitsRect, chamfer } from "../src/shell/wireGeometry.ts";

const crossesCard = (pts: P[], r: { x: number; y: number; w: number; h: number }) =>
  pts.slice(1).some((q, i) => segmentHitsRect(pts[i], q, r));

test("a wire runs round a card that sits in its way", () => {
  const src = { x: 0, y: 0, w: 300, h: 200 };
  const dst = { x: 1000, y: 400, w: 300, h: 200 };
  const mapCard = { x: 420, y: 60, w: 360, h: 420 }; // squarely between them
  const a = { x: 300, y: 26 };
  const b = { x: 1000, y: 426 };
  assert.ok(crossesCard(route(a, b, { src, dst }), mapCard), "the plain road would run through it");
  const pts = routeAvoiding(a, b, { src, dst, obstacles: [mapCard] });
  assert.ok(!crossesCard(pts, mapCard), "the avoiding road doesn't");
  for (const ang of angles(pts)) assert.ok(ang % 45 === 0, `still roads only (${ang}°)`);
  assert.equal(pts[0].x, a.x);
  assert.equal(pts[pts.length - 1].x, b.x);
});

test("when the way is clear the plain road wins", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 600, y: 200 };
  const far = { x: 2000, y: 2000, w: 100, h: 100 };
  assert.deepEqual(routeAvoiding(a, b, { obstacles: [far] }), route(a, b));
});

test("avoiding stays fast with a crowded board", () => {
  const obstacles = Array.from({ length: 24 }, (_, i) => ({ x: 200 + (i % 6) * 180, y: -300 + Math.floor(i / 6) * 220, w: 140, h: 160 }));
  const t = performance.now();
  for (let k = 0; k < 20; k++) routeAvoiding({ x: 0, y: k * 7 }, { x: 1400, y: 300 + k }, { obstacles });
  assert.ok(performance.now() - t < 400, `20 cold routes past 24 cards in ${Math.round(performance.now() - t)} ms`);
});

test("chamfer turns 90° corners into 45° steps", () => {
  const pts = chamfer([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
  for (const ang of angles(pts)) assert.ok(ang % 45 === 0);
  assert.ok(angles(pts).includes(45));
});

test("a card right beside the port: the lead shortens and the road takes the narrow gap", () => {
  const src = { x: 0, y: 0, w: 400, h: 300 };
  const mapCard = { x: 415, y: 0, w: 360, h: 280 }; // 15 px from the source port
  const dst = { x: 560, y: 500, w: 400, h: 300 };
  const a = { x: 400, y: 26 };
  const b = { x: 560, y: 526 };
  const pts = routeAvoiding(a, b, { src, dst, obstacles: [mapCard] });
  assert.ok(!crossesCard(pts, mapCard), JSON.stringify(pts));
  for (const ang of angles(pts)) assert.ok(ang % 45 === 0, `roads only (${ang}°)`);
});

test("a change of height is one long 45° run, not a stair of short steps", () => {
  const pts = route({ x: 0, y: 0 }, { x: 900, y: 260 });
  const diag = pts.slice(1).map((p, i) => ({ dx: p.x - pts[i].x, dy: p.y - pts[i].y })).filter((d) => Math.abs(d.dy) > 0.5);
  assert.equal(diag.length, 1, "the whole climb is one segment");
  assert.ok(Math.abs(Math.abs(diag[0].dx) - Math.abs(diag[0].dy)) < 1e-6, "at 45°");
  assert.ok(Math.abs(diag[0].dy - 260) < 1e-6, "covering all 260 px");
  // too steep for one diagonal: the turns still take all the room ahead (not 14 px chamfers)
  const steep = route({ x: 0, y: 0 }, { x: 400, y: 700 });
  const firstTurn = steep.slice(1).map((p, i) => ({ dx: p.x - steep[i].x, dy: p.y - steep[i].y })).find((d) => Math.abs(d.dx) > 0.5 && Math.abs(d.dy) > 0.5)!;
  assert.ok(Math.abs(firstTurn.dx) > 100, `turn runs ${Math.abs(firstTurn.dx).toFixed(0)} px`);
});

test("a long turn shortens rather than cut through a card", () => {
  const card = { x: 120, y: 60, w: 200, h: 200 };
  const pts = road([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 800, y: 400 }], [card]);
  for (let i = 1; i < pts.length; i++) assert.ok(segmentOverlap(pts[i - 1], pts[i], card) < 0.5, "no segment enters the card");
  for (const ang of angles(pts)) assert.ok(ang % 45 === 0);
});

test("an app section talks through the edge facing the other app, and both ends agree", () => {
  const a = { x: 0, y: 0, w: 500, h: 400 };
  const right = { x: 540, y: 0, w: 500, h: 400 };
  const below = { x: 200, y: 440, w: 800, h: 400 };
  const farDiag = { x: 1200, y: 900, w: 400, h: 300 };
  assert.equal(sideToward(a, right, "right"), "right");
  assert.equal(sideToward(right, a, "left"), "left");
  assert.equal(sideToward(a, below, "right"), "bottom");
  assert.equal(sideToward(below, a, "left"), "top");
  const s1 = sideToward(a, farDiag, "right");
  const s2 = sideToward(farDiag, a, "left");
  assert.ok((s1 === "right" && s2 === "left") || (s1 === "bottom" && s2 === "top"), `${s1}/${s2} face each other`);
});

test("stacked apps join by a straight drop; offset ones by roads that leave and arrive square", () => {
  const straight = routeSides({ x: 300, y: 400 }, "bottom", { x: 300, y: 440 }, "top");
  assert.equal(straight.length, 2, "one straight segment across the gap");
  const offset = routeSides({ x: 100, y: 400 }, "bottom", { x: 700, y: 900 }, "top");
  for (const ang of angles(offset)) assert.ok(ang % 45 === 0, `angle ${ang}`);
  assert.equal(offset[1].x, 100, "leaves straight down");
  assert.equal(offset[offset.length - 2].x, 700, "arrives straight down");
  const corner = routeSides({ x: 0, y: 0 }, "right", { x: 600, y: 500 }, "top");
  const diag = corner.slice(1).filter((p, i) => Math.abs(p.x - corner[i].x) > 0.5 && Math.abs(p.y - corner[i].y) > 0.5);
  assert.equal(diag.length, 1, "a corner pair turns once, on one long diagonal");
  assert.ok(Math.abs(diag[0].x - corner[corner.indexOf(diag[0]) - 1].x) > 300, "and it is long");
});

test("a turn hemmed in by a card takes the longest diagonal that clears it, not half", () => {
  // the diagonal from (−k, 0) to (0, k) enters this card for every k past 300
  const card = { x: -600, y: 150, w: 450, h: 450 };
  const pts = road([{ x: -1000, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1000 }], [card]);
  const k = -pts[1].x;
  assert.ok(k >= 295 && k <= 300, `diagonal reaches ${k.toFixed(1)} of 300 px (halving gave 240)`);
  for (let i = 1; i < pts.length; i++) assert.ok(segmentOverlap(pts[i - 1], pts[i], card) < 0.5, "and stays out of the card");
});

test("a corner takes the run its neighbour can't use: a step onto a short lead is one diagonal", () => {
  const pts = road([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 230, y: 100 }]);
  assert.deepEqual(angles(pts), [0, 45], "level, then one 45° run to the end");
});

test("bends are drawn round: an arc at each, kept within half of either run", () => {
  const d = polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 100 }, { x: 210, y: 100 }]);
  assert.equal(d.match(/A /g)?.length, 2, "one arc per bend");
  assert.ok(d.startsWith("M 0.0 0.0") && d.endsWith("L 210.0 100.0"), "ends where the road ends");
  const short = polyline([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]);
  const [, r] = short.match(/A ([\d.]+)/)!;
  assert.ok(Number(r) <= 2, `a 4 px run holds only a 2 px radius (got ${r})`);
  assert.equal(polyline([{ x: 0, y: 0 }, { x: 50, y: 0 }]), "M 0.0 0.0 L 50.0 0.0", "a straight wire has no arcs");
});

import { spreadOnEdge } from "../src/shell/ports.ts";

test("landings on one edge keep a pitch apart and stay on the edge at both ends", () => {
  // three wires wanting the far end of a 0..200 edge: they used to run past 200
  const far = spreadOnEdge([195, 198, 200], 0, 200, 18);
  assert.deepEqual(far, [164, 182, 200]);
  // the near end too
  assert.deepEqual(spreadOnEdge([0, 2, 4], 0, 200, 18), [0, 18, 36]);
  // room enough: nothing moves
  assert.deepEqual(spreadOnEdge([20, 100, 180], 0, 200, 18), [20, 100, 180]);
  // a crowd in the middle spreads forward only as far as it must
  assert.deepEqual(spreadOnEdge([100, 101], 0, 200, 18), [100, 118]);
  // too many for the edge: they share it evenly, ends included
  assert.deepEqual(spreadOnEdge([50, 50, 50, 50], 0, 30, 18), [0, 10, 20, 30]);
  // every result is inside the edge and a pitch apart
  const many = spreadOnEdge([10, 190, 191, 192, 193, 194], 0, 200, 18);
  for (let i = 0; i < many.length; i++) {
    assert.ok(many[i] >= 0 && many[i] <= 200);
    if (i) assert.ok(many[i] - many[i - 1] >= 18 - 1e-9);
  }
});

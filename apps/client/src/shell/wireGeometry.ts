/**
 * Wire geometry — Vision's flow-diagram rules, shared across Form Industries'
 * tools (ported from Vision `apps/vision/src/components/wireGeometry.ts` and
 * `@pacific/ui/data-pipes.ts`; DESIGN.md → Wires).
 *
 *  1. Roads, not strings: only horizontal, vertical and 45° segments.
 *  2. Every wire leaves an output and enters an input on a straight lead.
 *  3. Turns are long 45° runs: a turn takes as much of the runs either side
 *     as it can (up to TURN) without touching a card, so a change of height
 *     reads as one clean diagonal; each bend is drawn round (ROUND).
 *  4. A wire going back (target behind its source) crosses through the gap
 *     between the two cards, or just clear of both — never through a card.
 *  5. Wires sharing a port run in parallel lanes, equally spaced at bends.
 *  6. Where two wires cross, the one ordered first goes *under*: it is cut for
 *     the crossing, with portal marks either side and a faint trace through.
 *     The order is stable (by id), so crossings never flicker. Crossings near a
 *     port never tunnel; a wire's own lanes never cross themselves.
 */

export type P = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const LEAD = 48; // straight run out of / into a port
export const LANE = 4; // pitch between parallel wires sharing a run
const CHAMFER = 14; // the shortest 45° step that turns a run through 90°
const TURN = 480; // the longest: a turn's diagonal may run this far each way
const CLEAR = 28; // how far a crossing keeps from a card edge
const ROUND = 20; // the radius a bend is drawn round (smaller where a run is too short to hold it)

/** The road as an SVG path: straight runs, and each bend an arc of radius `r` that keeps within half of either run. */
export function polyline(pts: P[], r = ROUND): string {
  const f = (p: P) => p.x.toFixed(1) + " " + p.y.toFixed(1);
  if (!pts.length) return "";
  let d = "M " + f(pts[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const u = { x: (b.x - a.x) / (l1 || 1), y: (b.y - a.y) / (l1 || 1) };
    const v = { x: (c.x - b.x) / (l2 || 1), y: (c.y - b.y) / (l2 || 1) };
    const turn = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
    if (r <= 0 || !l1 || !l2 || turn < 1e-3 || turn > Math.PI - 1e-3) {
      d += " L " + f(b);
      continue;
    }
    const tan = Math.tan(turn / 2);
    const t = Math.min(r * tan, l1 / 2, l2 / 2); // how far the arc starts before the bend
    const radius = (t / tan).toFixed(1);
    const sweep = u.x * v.y - u.y * v.x > 0 ? 1 : 0;
    d += ` L ${f({ x: b.x - u.x * t, y: b.y - u.y * t })} A ${radius} ${radius} 0 0 ${sweep} ${f({ x: b.x + v.x * t, y: b.y + v.y * t })}`;
  }
  if (pts.length > 1) d += " L " + f(pts[pts.length - 1]);
  return d;
}

/** Offset a route sideways, intersecting parallel segments so lanes stay evenly spaced through bends. */
export function offsetRoute(pts: P[], offset: number): P[] {
  if (pts.length < 2 || offset === 0) return pts;
  const normals = pts.slice(1).map((p, i) => {
    const dx = p.x - pts[i].x;
    const dy = p.y - pts[i].y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  });
  return pts.map((p, i) => {
    const before = normals[Math.max(0, i - 1)];
    const after = normals[Math.min(i, normals.length - 1)];
    const divisor = 1 + before.x * after.x + before.y * after.y || 1;
    return { x: p.x + (offset * (before.x + after.x)) / divisor, y: p.y + (offset * (before.y + after.y)) / divisor };
  });
}

/** Drop duplicate and collinear vertices. */
function dedupe(pts: P[]): P[] {
  const unique = pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) > 1e-6 || Math.abs(p.y - pts[i - 1].y) > 1e-6);
  return unique.filter((p, i) => {
    if (i === 0 || i === unique.length - 1) return true;
    const a = unique[i - 1];
    const b = unique[i + 1];
    return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-6;
  });
}

/** Where a backward wire crosses: the middle of the gap between stacked cards, else just above or below both. */
function crossingY(src: Rect, dst: Rect, ay: number, by: number): number {
  const srcBelow = src.y >= dst.y + dst.h;
  const srcAbove = src.y + src.h <= dst.y;
  if (srcBelow || srcAbove) {
    const gapTop = srcBelow ? dst.y + dst.h : src.y + src.h;
    const gapBottom = srcBelow ? src.y : dst.y;
    if (gapBottom - gapTop >= 2 * CHAMFER + 8) return (gapTop + gapBottom) / 2;
  }
  const above = Math.min(src.y, dst.y) - CLEAR;
  const below = Math.max(src.y + src.h, dst.y + dst.h) + CLEAR;
  const costAbove = Math.abs(ay - above) + Math.abs(by - above);
  const costBelow = Math.abs(ay - below) + Math.abs(by - below);
  return costAbove <= costBelow ? above : below;
}

export interface RouteOpts {
  leadIn?: number;
  leadOut?: number;
  /** lane among wires sharing the run into the target (centred, in lanes) */
  lane?: number;
  /** lane among wires sharing the run out of the source */
  srcLane?: number;
  src?: Rect | null;
  dst?: Rect | null;
}

/**
 * The road from an output (leaving right) to an input (arriving from the
 * left): an orthogonal skeleton whose corners become long 45° runs (road()).
 */
export function route(a: P, b: P, opts: RouteOpts = {}): P[] {
  const { leadIn = LEAD, leadOut = LEAD, lane = 0, srcLane = 0 } = opts;
  const approach = b.x > a.x ? (b.x - a.x) / 4 : Infinity;
  const x1 = a.x + Math.min(leadIn, approach);
  const x2 = b.x - Math.min(leadOut, approach);
  const dx = x2 - x1;
  const ends = [opts.src, opts.dst].filter((r): r is Rect => Boolean(r));
  const keep = { start: (x1 - a.x) / 2, end: (b.x - x2) / 2 };

  if (dx > 0) {
    // forward: one vertical run between the leads — its two turns become diagonals,
    // and when the room ahead allows, they meet as one long 45° run (in a narrow
    // gap between neighbouring sections it is a short step down the gap)
    const xm = Math.min(Math.max(x1 + dx / 2 + lane * LANE, x1 + Math.min(CHAMFER, dx / 2)), x2 - Math.min(CHAMFER, dx / 2));
    return road([a, { x: x1, y: a.y }, { x: xm, y: a.y }, { x: xm, y: b.y }, { x: x2, y: b.y }, b], ends, keep);
  }

  // target behind: out and round beside the source, across clear of both cards, round beside the target, in
  const src = opts.src ?? { x: a.x, y: a.y, w: 0, h: 0 };
  const dst = opts.dst ?? { x: b.x, y: b.y, w: 0, h: 0 };
  let yc = crossingY(src, dst, a.y, b.y) + lane * LANE;
  if (Math.abs(yc - a.y) < 2 * CHAMFER + 16 || Math.abs(yc - b.y) < 2 * CHAMFER + 16) {
    yc = Math.min(src.y, dst.y, a.y, b.y) - CLEAR - 2 * CHAMFER - Math.abs(lane * LANE);
  }
  const xr = Math.max(x1, x2) + 2 * CHAMFER + Math.abs(srcLane * LANE);
  const xl = Math.min(x1, x2) - 2 * CHAMFER - Math.abs(lane * LANE);
  return road([a, { x: x1, y: a.y }, { x: xr, y: a.y }, { x: xr, y: yc }, { x: xl, y: yc }, { x: xl, y: b.y }, { x: x2, y: b.y }, b], ends, keep);
}

/**
 * Turn an orthogonal skeleton into a road. Each corner becomes a 45° run as
 * long as the runs either side allow — a corner shares its outgoing run with
 * the next one (taking whatever the next can't use, at least half), and the
 * leads keep at least `keep` px straight — and as long as the diagonal stays
 * out of every card in `avoid` (the longest clear one, down to a CHAMFER step).
 */
export function road(corners: P[], avoid: Rect[] = [], keep: { start?: number; end?: number } = {}, max = TURN): P[] {
  const pts = dedupe(corners);
  if (pts.length < 3) return pts;
  const out: P[] = [pts[0]];
  const last = pts.length - 2;
  const run = (i: number) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  // the most a corner could take of its runs, before cards and neighbours
  const reach = (i: number) => Math.min(max, run(i - 1) - (i === 1 ? (keep.start ?? 0) : 0), run(i) - (i === last ? (keep.end ?? 0) : 0));
  for (let i = 1; i <= last; i++) {
    const prev = out[out.length - 1];
    const b = pts[i];
    const n = pts[i + 1];
    const lin = Math.hypot(b.x - prev.x, b.y - prev.y) - (i === 1 ? (keep.start ?? 0) : 0);
    const nextLen = run(i);
    const lout = i === last ? nextLen - (keep.end ?? 0) : nextLen - Math.max(0, Math.min(reach(i + 1), nextLen / 2));
    const ux = (b.x - prev.x) / (Math.hypot(b.x - prev.x, b.y - prev.y) || 1);
    const uy = (b.y - prev.y) / (Math.hypot(b.x - prev.x, b.y - prev.y) || 1);
    const vx = (n.x - b.x) / (nextLen || 1);
    const vy = (n.y - b.y) / (nextLen || 1);
    const cut = (k: number) => [{ x: b.x - ux * k, y: b.y - uy * k }, { x: b.x + vx * k, y: b.y + vy * k }] as const;
    const clear = (k: number) => !avoid.some((r) => segmentOverlap(cut(k)[0], cut(k)[1], r) > 0.5);
    let k = Math.min(max, lin, lout);
    if (k > CHAMFER && !clear(k)) {
      // the longest diagonal that stays out of every card, to within a pixel or two
      let lo = 0;
      let hi = k;
      for (let step = 0; step < 8; step++) {
        const mid = (lo + hi) / 2;
        if (clear(mid)) lo = mid;
        else hi = mid;
      }
      k = Math.max(lo, CHAMFER);
    }
    if (k < 0.5) {
      out.push(b);
      continue;
    }
    const [p, q] = cut(k);
    out.push(p, q);
  }
  out.push(pts[pts.length - 1]);
  return dedupe(out);
}

// ---------- over / under ----------

export type Crossing = P & { direction: P };

/**
 * Where routes cross, and which one goes under. Stable order by id: the
 * earlier id tunnels under the later one. Crossings within 36 px of either
 * route's ends (junction approaches) never tunnel; near-duplicates merge.
 */
export function pipeCrossings(routes: { id: string; points: P[] }[]): Map<string, Crossing[]> {
  const result = new Map<string, Crossing[]>();
  const sorted = [...routes].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i++) {
    const under = sorted[i];
    for (const over of sorted.slice(i + 1)) {
      if (under.id === over.id) continue;
      for (let a = 1; a < under.points.length; a++) {
        const p = under.points[a - 1];
        const q = under.points[a];
        for (let b = 1; b < over.points.length; b++) {
          const r = over.points[b - 1];
          const s = over.points[b];
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const ex = s.x - r.x;
          const ey = s.y - r.y;
          const det = dx * ey - dy * ex;
          if (Math.abs(det) < 1e-6) continue;
          const t = ((r.x - p.x) * ey - (r.y - p.y) * ex) / det;
          const u = ((r.x - p.x) * dy - (r.y - p.y) * dx) / det;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const point = { x: p.x + t * dx, y: p.y + t * dy, direction: { x: ex, y: ey } };
          const ends = [under.points[0], under.points[under.points.length - 1], over.points[0], over.points[over.points.length - 1]];
          if (ends.some((end) => Math.hypot(end.x - point.x, end.y - point.y) < 36)) continue;
          const list = result.get(under.id) ?? [];
          if (!list.some((c) => Math.hypot(c.x - point.x, c.y - point.y) < 8)) list.push(point);
          result.set(under.id, list);
        }
      }
    }
  }
  return result;
}

/**
 * The tunnel for an under-route: merged spans around its crossings, returned as
 * a mask path (quads cut out of the wire), and portal strokes at each mouth.
 */
export function tunnelGeometry(points: P[], crossings: Crossing[], width = 12) {
  let distance = 0;
  const segments = points.slice(1).flatMap((end, i) => {
    const start = points[i];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (!length) return [];
    const seg = { start, length, at: distance, dx: (end.x - start.x) / length, dy: (end.y - start.y) / length };
    distance += length;
    return [seg];
  });
  const spans: [number, number][] = [];
  for (const seg of segments)
    for (const c of crossings) {
      const x = c.x - seg.start.x;
      const y = c.y - seg.start.y;
      const along = x * seg.dx + y * seg.dy;
      const across = x * seg.dy - y * seg.dx;
      if (Math.abs(across) >= 18) continue;
      const reach = Math.sqrt(18 ** 2 - across ** 2) / 2 + 3;
      const from = Math.max(0, along - reach);
      const to = Math.min(seg.length, along + reach);
      if (from < to) spans.push([seg.at + from, seg.at + to]);
    }
  const merged: [number, number][] = [];
  for (const span of spans.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  const at = (d: number) => {
    const seg = segments.find((s) => d <= s.at + s.length) ?? segments[segments.length - 1];
    return { seg, x: seg.start.x + seg.dx * (d - seg.at), y: seg.start.y + seg.dy * (d - seg.at) };
  };
  const pt = (p: P) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  const mouths = merged.map((span) =>
    span.map((d) => {
      const { seg, x, y } = at(d);
      const nearest = [...crossings].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
      const dir = nearest?.direction ?? { x: -seg.dy, y: seg.dx };
      const len = Math.hypot(dir.x, dir.y) || 1;
      const tx = dir.x / len;
      const ty = dir.y / len;
      const half = width / (2 * Math.max(0.25, Math.abs(seg.dx * ty - seg.dy * tx)));
      return [
        { x: x + tx * half, y: y + ty * half },
        { x: x - tx * half, y: y - ty * half },
      ];
    }),
  );
  return {
    terminals: mouths.flatMap((pair) => pair.map(([a, b]) => `M ${pt(a)} L ${pt(b)}`)).join(" "),
    cut: mouths.map(([entry, exit]) => `M ${pt(entry[0])} L ${pt(entry[1])} L ${pt(exit[1])} L ${pt(exit[0])} Z`).join(" "),
  };
}

// ---------- port intakes ----------

export const pipeMetrics = { sourcePitch: 18, junction: 14, rowGap: 10 } as const;

/** Each wire into (or out of) a port owns its own landing; returns slot offsets centred on the port. */
export function pipeIntake(ids: string[]) {
  const span = Math.max(0, (ids.length - 1) * pipeMetrics.sourcePitch);
  return {
    height: pipeMetrics.junction + span,
    slots: new Map(ids.map((id, i) => [id, i * pipeMetrics.sourcePitch - span / 2])),
  };
}

/** Port types that may connect: same type, or either side is generic json/any. */
export function typesCompatible(out?: string, input?: string) {
  if (!out || !input) return true;
  if (out === input) return true;
  return out === "json" || input === "json" || out === "any" || input === "any";
}

// ---------- avoiding cards ----------

const AVOID_PAD = 14; // how far a road prefers to keep from a card it passes
const CORNER_COST = 24; // a turn costs as much as 24 px of road
const HIT_COST = 100_000; // running through a card is never worth it
const SOFT_COST = 3; // per px of road inside a card's padding

/** Length of segment p→q inside the interior of r (Liang–Barsky clip, strict). */
export function segmentOverlap(p: P, q: P, r: Rect): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ];
  for (const [pp, qq] of edges) {
    if (Math.abs(pp) < 1e-9) {
      if (qq <= 0) return 0;
      continue;
    }
    const t = qq / pp;
    if (pp < 0) {
      if (t > t1) return 0;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return 0;
      if (t < t1) t1 = t;
    }
  }
  return t1 - t0 > 1e-6 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
}

/** Does segment p→q pass through the interior of r? */
export function segmentHitsRect(p: P, q: P, r: Rect): boolean {
  return segmentOverlap(p, q, r) > 0.5;
}

/** Turn an orthogonal corner path into a road: each 90° corner becomes a 45° chamfer. */
export function chamfer(corners: P[], c = CHAMFER): P[] {
  const pts = dedupe(corners);
  if (pts.length < 3) return pts;
  const out: P[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = pts[i + 1];
    const lin = Math.hypot(b.x - a.x, b.y - a.y);
    const lout = Math.hypot(n.x - b.x, n.y - b.y);
    const k = Math.min(c, lin / 2, lout / 2);
    if (k < 0.5) {
      out.push(b);
      continue;
    }
    out.push({ x: b.x - ((b.x - a.x) / lin) * k, y: b.y - ((b.y - a.y) / lin) * k });
    out.push({ x: b.x + ((n.x - b.x) / lout) * k, y: b.y + ((n.y - b.y) / lout) * k });
  }
  out.push(pts[pts.length - 1]);
  return dedupe(out);
}

function length(pts: P[]) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

const pad = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

/**
 * Score a road: its length, its turns, a heavy price for every card it runs
 * through (the two end cards only past the leads), and a light one for
 * brushing a card's padding.
 */
function cost(pts: P[], raw: Rect[], ends: Rect[]) {
  let total = length(pts) + (pts.length - 2) * CORNER_COST;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    for (const r of raw) {
      if (segmentOverlap(p, q, r) > 0.5) total += HIT_COST;
      else total += segmentOverlap(p, q, pad(r, AVOID_PAD)) * SOFT_COST;
    }
    if (i > 1 && i < pts.length - 1) for (const r of ends) if (segmentOverlap(p, q, r) > 0.5) total += HIT_COST;
  }
  return total;
}

function clearOf(pts: P[], raw: Rect[]) {
  for (let i = 1; i < pts.length; i++) for (const r of raw) if (segmentOverlap(pts[i - 1], pts[i], r) > 0.5) return false;
  return true;
}

export interface AvoidOpts extends RouteOpts {
  /** every other card's rect (not the two this wire joins) */
  obstacles?: Rect[];
}

const memo = new Map<string, P[]>();

/**
 * The road from an output to an input that runs round any card in its way.
 * The plain road wins when it's clear. Otherwise: the leads shorten when a
 * card sits right beside a port, and candidate roads through the channels
 * beside cards (narrow gaps included) and the corridors above and below them
 * are scored by length + turns; roads through a card are never chosen while
 * any other exists.
 */
export function routeAvoiding(a: P, b: P, opts: AvoidOpts = {}): P[] {
  const base = route(a, b, opts);
  const ends = [opts.src, opts.dst].filter((r): r is Rect => Boolean(r));
  const minX = Math.min(a.x, b.x) - 400;
  const maxX = Math.max(a.x, b.x) + 400;
  const minY = Math.min(a.y, b.y) - 400;
  const maxY = Math.max(a.y, b.y) + 400;
  const raw = (opts.obstacles ?? []).filter((r) => r.x < maxX && r.x + r.w > minX && r.y < maxY && r.y + r.h > minY);
  if (!raw.length || clearOf(base, raw)) return base;

  const key = `${a.x.toFixed(0)},${a.y.toFixed(0)},${b.x.toFixed(0)},${b.y.toFixed(0)},${opts.lane ?? 0},${opts.srcLane ?? 0}|${[...raw, ...ends].map((r) => `${r.x.toFixed(0)},${r.y.toFixed(0)},${r.w.toFixed(0)},${r.h.toFixed(0)}`).join(";")}`;
  const hit = memo.get(key);
  if (hit) return hit;

  const { leadIn = LEAD, leadOut = LEAD, lane = 0 } = opts;
  // a card right beside a port shortens that port's lead to half the gap
  const gapRight = Math.min(...raw.filter((r) => r.x >= a.x - 1 && a.y >= r.y - AVOID_PAD && a.y <= r.y + r.h + AVOID_PAD).map((r) => r.x - a.x), Infinity);
  const gapLeft = Math.min(...raw.filter((r) => r.x + r.w <= b.x + 1 && b.y >= r.y - AVOID_PAD && b.y <= r.y + r.h + AVOID_PAD).map((r) => b.x - (r.x + r.w)), Infinity);
  const lin = Math.max(6, Math.min(leadIn, gapRight / 2));
  const lout = Math.max(6, Math.min(leadOut, gapLeft / 2));
  const x1 = a.x + lin;
  const x2 = b.x - lout;
  const off = lane * LANE;

  const all = [...raw, ...ends];
  const xs = new Set<number>([x1, x1 + 2 * CHAMFER, x2 - 2 * CHAMFER, x2, (x1 + x2) / 2]);
  const ys = new Set<number>([(a.y + b.y) / 2]);
  for (const r of all) {
    xs.add(r.x - CLEAR / 2);
    xs.add(r.x + r.w + CLEAR / 2);
    ys.add(r.y - CLEAR / 2);
    ys.add(r.y + r.h + CLEAR / 2);
  }
  // narrow gaps between neighbouring cards are channels too
  for (const r of all)
    for (const s2 of all) {
      if (r === s2) continue;
      const gx = s2.x - (r.x + r.w);
      if (gx > 4 && gx < CLEAR * 2) xs.add(r.x + r.w + gx / 2);
      const gy = s2.y - (r.y + r.h);
      if (gy > 4 && gy < CLEAR * 2) ys.add(r.y + r.h + gy / 2);
    }

  const keep = { start: lin / 2, end: lout / 2 };
  const candidates: P[][] = [base, route(a, b, { ...opts, leadIn: lin, leadOut: lout })];
  for (const xm of xs) {
    if (xm < x1 || xm > x2) continue;
    candidates.push(road([a, { x: x1, y: a.y }, { x: xm + off, y: a.y }, { x: xm + off, y: b.y }, { x: x2, y: b.y }, b], all, keep));
  }
  // the four channels nearest each end keep the search small
  const xas = [...xs].filter((x) => x >= x1).sort((p, q) => p - q).slice(0, 4);
  const xbs = [...xs].filter((x) => x <= x2).sort((p, q) => q - p).slice(0, 4);
  for (const yc of ys)
    for (const xa of xas)
      for (const xb of xbs)
        candidates.push(road([a, { x: x1, y: a.y }, { x: xa + off, y: a.y }, { x: xa + off, y: yc + off }, { x: xb - off, y: yc + off }, { x: xb - off, y: b.y }, { x: x2, y: b.y }, b], all, keep));

  let best = base;
  let bestCost = cost(base, raw, ends);
  for (const c of candidates) {
    const k = cost(c, raw, ends);
    if (k < bestCost) {
      best = c;
      bestCost = k;
    }
  }
  if (memo.size > 600) memo.clear();
  memo.set(key, best);
  return best;
}

// ---------- any side to any side (apps hosted by sections) ----------

/** The edge a port sits on. Cards keep inputs left and outputs right; an app section uses whichever edge faces the other app. */
export type Side = "left" | "right" | "top" | "bottom";

export const NORMAL: Record<Side, P> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
const OPPOSITE: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/**
 * The edge of `me` that faces `other`: across whichever gap is wider, so two
 * apps in a row talk through their facing sides and two stacked apps through
 * top and bottom. Symmetric — the other end picks the opposite edge. Rects that
 * overlap (a card inside the section) fall back.
 */
export function sideToward(me: Rect, other: Rect, fallback: Side): Side {
  const gx = Math.max(other.x - (me.x + me.w), me.x - (other.x + other.w));
  const gy = Math.max(other.y - (me.y + me.h), me.y - (other.y + other.h));
  if (gx < 0 && gy < 0) return fallback;
  if (gx >= gy) return other.x + other.w / 2 > me.x + me.w / 2 ? "right" : "left";
  return other.y + other.h / 2 > me.y + me.h / 2 ? "bottom" : "top";
}

/** quarter turns that carry a side's outward normal onto +x (and back) */
const TURN_TO_RIGHT: Record<Side, [(p: P) => P, (p: P) => P]> = {
  right: [(p) => p, (p) => p],
  left: [(p) => ({ x: -p.x, y: -p.y }), (p) => ({ x: -p.x, y: -p.y })],
  bottom: [(p) => ({ x: p.y, y: -p.x }), (p) => ({ x: -p.y, y: p.x })],
  top: [(p) => ({ x: -p.y, y: p.x }), (p) => ({ x: p.y, y: -p.x })],
};

function turnRect(r: Rect, f: (p: P) => P): Rect {
  const a = f({ x: r.x, y: r.y });
  const b = f({ x: r.x + r.w, y: r.y + r.h });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/**
 * The road from a port on side `sa` to a port on side `sb`, by the same rules.
 * Facing sides (right→left, bottom→top, …) turn the problem a quarter at a time
 * onto the classic right→left one and use the full router, cards and all. Any
 * other pair (a corner: right→top; or same side) takes the cheapest L or Z
 * between the two leads — an L becomes one long diagonal.
 */
export function routeSides(a: P, sa: Side, b: P, sb: Side, opts: AvoidOpts = {}): P[] {
  if (sa === "right" && sb === "left") return routeAvoiding(a, b, opts);
  if (OPPOSITE[sa] === sb) {
    const [to, back] = TURN_TO_RIGHT[sa];
    const pts = routeAvoiding(to(a), to(b), {
      ...opts,
      src: opts.src ? turnRect(opts.src, to) : opts.src,
      dst: opts.dst ? turnRect(opts.dst, to) : opts.dst,
      obstacles: (opts.obstacles ?? []).map((r) => turnRect(r, to)),
    });
    return pts.map(back);
  }
  const na = NORMAL[sa];
  const nb = NORMAL[sb];
  const L1 = { x: a.x + na.x * LEAD, y: a.y + na.y * LEAD };
  const L2 = { x: b.x + nb.x * LEAD, y: b.y + nb.y * LEAD };
  const horizontal = (s: Side) => s === "left" || s === "right";
  const outer = (s: Side, u: number, v: number) => (s === "right" || s === "bottom" ? Math.max(u, v) : Math.min(u, v));
  const mids: P[][] = [
    [{ x: L2.x, y: L1.y }],
    [{ x: L1.x, y: L2.y }],
    horizontal(sa) ? [{ x: (L1.x + L2.x) / 2, y: L1.y }, { x: (L1.x + L2.x) / 2, y: L2.y }] : [{ x: L1.x, y: (L1.y + L2.y) / 2 }, { x: L2.x, y: (L1.y + L2.y) / 2 }],
  ];
  if (sa === sb) {
    // same side: out past both, along, and back in
    mids.push(horizontal(sa) ? [{ x: outer(sa, L1.x, L2.x), y: L1.y }, { x: outer(sa, L1.x, L2.x), y: L2.y }] : [{ x: L1.x, y: outer(sa, L1.y, L2.y) }, { x: L2.x, y: outer(sa, L1.y, L2.y) }]);
  }
  const ends = [opts.src, opts.dst].filter((r): r is Rect => Boolean(r));
  const avoid = [...(opts.obstacles ?? []), ...ends];
  const dot = (p: P, q: P, n: P) => (q.x - p.x) * n.x + (q.y - p.y) * n.y;
  let best: P[] | null = null;
  let bestCost = Infinity;
  for (const mid of mids) {
    const skeleton = dedupe([a, L1, ...mid, L2, b]);
    // never fold back over a lead
    const i1 = skeleton.findIndex((p) => p.x === L1.x && p.y === L1.y);
    const i2 = skeleton.findIndex((p) => p.x === L2.x && p.y === L2.y);
    if (i1 >= 0 && skeleton[i1 + 1] && dot(skeleton[i1], skeleton[i1 + 1], na) < -0.5) continue;
    if (i2 > 0 && dot(skeleton[i2 - 1], skeleton[i2], nb) > 0.5) continue;
    const pts = road(skeleton, avoid, { start: LEAD / 2, end: LEAD / 2 });
    const k = cost(pts, opts.obstacles ?? [], ends);
    if (k < bestCost) {
      best = pts;
      bestCost = k;
    }
  }
  return best ?? road([a, L1, L2, b], avoid);
}

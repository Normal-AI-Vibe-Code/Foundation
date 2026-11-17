/**
 * Port layout — one answer for where a panel's ports sit and where each wire
 * lands on them, read by the card (pills) and by the wire layer (endpoints),
 * so they can never disagree. Inputs stack on the left edge, outputs on the
 * right; a port with several wires grows into a pill with one landing per wire,
 * ordered by where the other end sits so the wires don't cross at the port.
 *
 * An app hosted by a section is different: each wire lands on whichever edge
 * of the section faces the app at its other end (landingsOf), straight across
 * the gap when the two overlap along that edge — so neighbouring apps join by
 * a short straight road, and apps further apart by one long diagonal.
 */

import type { LinkDoc } from "@foundation/protocol";
import { SECTION_HEADER, allObjects, getState, objectWorldRect, sectionBodyRect, sectionCardRect, sharedSection, type PanelMeta } from "../state/store";
import type { P, Rect, Side } from "./wireGeometry";
import { pipeIntake, pipeMetrics, sideToward } from "./wireGeometry";

export const PORT_TOP = 52;
export const PORT_SPACING = 26;

export interface PortSlotLayout {
  id: string;
  dir: "in" | "out";
  /** centre, from the card's top */
  y: number;
  height: number;
  /** linkId → offset from the centre */
  slots: Map<string, number>;
}

/** Ports carry a type; the type picks the wire's tone (DESIGN.md → Wires). */
export const TYPE_TONE: Record<string, string> = {
  json: "var(--color-pulse)",
  text: "var(--viz-7)",
  number: "var(--viz-5)",
  image: "var(--viz-6)",
  cad: "var(--viz-2)",
  data: "var(--viz-3)",
  bom: "var(--viz-4)",
  decision: "var(--color-ok)",
};

export function toneOf(type?: string) {
  return TYPE_TONE[type ?? "json"] ?? "var(--color-pulse)";
}

function otherEndY(l: LinkDoc, dir: "in" | "out") {
  const st = getState();
  const other = st.panels[dir === "in" ? l.from.panel : l.to.panel];
  const r = other && objectWorldRect(other);
  return r ? r.y : 0;
}

export function portLayout(panel: PanelMeta, links: LinkDoc[]): Map<string, PortSlotLayout> {
  const out = new Map<string, PortSlotLayout>();
  for (const dir of ["in", "out"] as const) {
    let cursor = PORT_TOP - PORT_SPACING / 2;
    for (const port of panel.ports.filter((p) => p.dir === dir)) {
      const attached = links
        .filter((l) => (dir === "in" ? l.to.panel === panel.id && l.to.port === port.id : l.from.panel === panel.id && l.from.port === port.id))
        .sort((a, b) => otherEndY(a, dir) - otherEndY(b, dir) || a.id.localeCompare(b.id));
      const intake = pipeIntake(attached.map((l) => l.id));
      const height = Math.max(PORT_SPACING, intake.height + pipeMetrics.rowGap);
      out.set(port.id, { id: port.id, dir, y: cursor + height / 2, height: intake.height, slots: intake.slots });
      cursor += height;
    }
  }
  return out;
}

/** World position of a wire's end on a port (its own landing when it shares the port). */
export function portPoint(panel: PanelMeta, portId: string, linkId?: string, links?: LinkDoc[]): P | null {
  if (linkId) {
    const landing = landingsOf(panel.id).find((l) => l.link === linkId);
    if (landing) return landing;
  }
  return cardPortPoint(panel, portId, linkId, links);
}

/** The edge a wire leaves or enters by: a hosted app's landing side, else outputs right and inputs left. */
export function portSide(panel: PanelMeta, portId: string, linkId?: string): Side {
  const landing = linkId ? landingsOf(panel.id).find((l) => l.link === linkId) : undefined;
  if (landing) return landing.side;
  return panel.ports.find((p) => p.id === portId)?.dir === "out" ? "right" : "left";
}

function cardPortPoint(panel: PanelMeta, portId: string, linkId?: string, links?: LinkDoc[]): P | null {
  const r = objectWorldRect(panel);
  if (!r) return null;
  const layout = portLayout(panel, links ?? Object.values(getState().links)).get(portId);
  if (!layout) return null;
  const offset = linkId ? (layout.slots.get(linkId) ?? 0) : 0;
  // the pills are drawn inside the card, so they scale with its section's fit
  return { x: layout.dir === "out" ? r.x + r.w : r.x, y: r.y + (layout.y + offset) * r.s };
}

export function describeValue(v: unknown): string {
  if (v === undefined) return "no value yet";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string") return `${o.name}${typeof o.note === "string" ? ` · ${o.note}` : ""}`;
    if (typeof o.decision === "string") return `${o.decision}`;
  }
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 64 ? `${s.slice(0, 61)}…` : s;
}

/** every card's world rect this frame — what wires route around */
export function cardRects(): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const o of allObjects()) {
    const r = objectWorldRect(o);
    if (r) out.set(o.id, r);
  }
  return out;
}

/** what a wire treats as its own ends: a card, or for a hosted app its whole section (header included) */
export function endRect(rects: Map<string, Rect>, panelId: string): Rect | undefined {
  const st = getState();
  const p = st.panels[panelId];
  const sec = p && st.sections[p.sectionId];
  if (sec && sec.host === p.id) return sectionCardRect(st.grid, sec);
  return rects.get(panelId);
}

/**
 * What a wire between `from` and `to` must go round: every other card, and
 * every section neither end lives in — so wires between apps run section to
 * section through the gaps, never across another app. A wire inside one
 * section is only seen through that section's body, so it goes round that
 * section's cards alone.
 */
export function obstaclesFor(rects: Map<string, Rect>, from: string, to: string): Rect[] {
  const st = getState();
  const objects = allObjects();
  const a = objects.find((o) => o.id === from);
  const b = objects.find((o) => o.id === to);
  const home = a && b && sharedSection(a, b);
  if (home) {
    // its cards, and walls round the body so the road keeps to what can be
    // seen — save a wall one of its own cards is scrolled behind
    const body = sectionBodyRect(st.grid, home);
    const T = 400;
    const ends = [rects.get(from), rects.get(to)].filter((r): r is Rect => Boolean(r));
    const overlaps = (r: Rect, s: Rect) => r.x < s.x + s.w && s.x < r.x + r.w && r.y < s.y + s.h && s.y < r.y + r.h;
    const walls: Rect[] = [
      { x: body.x - T, y: body.y - T, w: T, h: body.h + 2 * T },
      { x: body.x + body.w, y: body.y - T, w: T, h: body.h + 2 * T },
      { x: body.x, y: body.y - T, w: body.w, h: T },
      { x: body.x, y: body.y + body.h, w: body.w, h: T },
    ].filter((wall) => !ends.some((r) => overlaps(r, wall)));
    return [...objects.filter((o) => o.sectionId === home.id && o.id !== from && o.id !== to && rects.has(o.id)).map((o) => rects.get(o.id)!), ...walls];
  }
  const out: Rect[] = [];
  for (const [id, r] of rects) if (id !== from && id !== to) out.push(r);
  const homes = new Set([st.panels[from]?.sectionId, st.panels[to]?.sectionId]);
  for (const sec of Object.values(st.sections)) if (!homes.has(sec.id)) out.push(sectionCardRect(st.grid, sec));
  return out;
}

// ---------- landings on an app section's edges ----------

export interface Landing extends P {
  link: string;
  port: string;
  side: Side;
}

const EDGE_PAD = 28; // landings keep this far from a section's corners
const LANDING_PITCH = 18; // and this far from each other

/** the section rect of a hosted app, or null for a card */
export function hostRect(panelId: string): Rect | null {
  const st = getState();
  const p = st.panels[panelId];
  const sec = p && st.sections[p.sectionId];
  return sec && sec.host === p.id ? sectionCardRect(st.grid, sec) : null;
}

/** where along an edge landings may sit (below the header on the sides) */
function edgeRange(r: Rect, side: Side): [number, number] {
  return side === "left" || side === "right" ? [r.y + SECTION_HEADER + EDGE_PAD, r.y + r.h - EDGE_PAD] : [r.x + EDGE_PAD, r.x + r.w - EDGE_PAD];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Landings along one edge (sorted), moved as little as possible so each is a
 * pitch from the next and all stay between lo and hi: pushed on from the near
 * end, then back from the far end (where they used to run off the edge). When
 * the edge is too short for them all, they share it evenly.
 */
export function spreadOnEdge(ats: number[], lo: number, hi: number, pitch: number): number[] {
  const n = ats.length;
  if (n === 0) return [];
  if (n > 1 && hi - lo < (n - 1) * pitch) return ats.map((_, i) => lo + ((hi - lo) * i) / (n - 1));
  const out = ats.map((a) => clamp(a, lo, hi));
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + pitch);
  out[n - 1] = Math.min(out[n - 1], hi);
  for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - pitch);
  return out;
}

let landingState: unknown = null;
const landingCache = new Map<string, Landing[]>();

/**
 * Every wire end on a hosted app's section, one landing each. A wire takes the
 * edge facing its other end; it sits at the middle of the stretch the two
 * sections share along that edge (both ends compute the same middle, so the
 * road between them is straight), or level with a card's port, or as near the
 * other end as the edge allows. Landings bound for the same app spread 18 px
 * apart in a stable order; any still crowding on an edge are pushed apart.
 */
export function landingsOf(panelId: string): Landing[] {
  const st = getState();
  if (landingState !== st) {
    landingState = st;
    landingCache.clear();
  }
  const hit = landingCache.get(panelId);
  if (hit) return hit;
  const me = hostRect(panelId);
  const out: Landing[] = [];
  landingCache.set(panelId, out);
  if (!me) return out;

  const raw: Array<{ link: string; port: string; side: Side; at: number; group: string }> = [];
  for (const l of Object.values(st.links)) {
    const outgoing = l.from.panel === panelId;
    if (!outgoing && l.to.panel !== panelId) continue;
    const otherId = outgoing ? l.to.panel : l.from.panel;
    const other = st.panels[otherId];
    if (!other) continue;
    const otherHost = hostRect(otherId);
    const otherRect = otherHost ?? objectWorldRect(other);
    if (!otherRect) continue;
    const side = sideToward(me, otherRect, outgoing ? "right" : "left");
    const along = side === "left" || side === "right" ? "y" : "x";
    const [a0, a1] = edgeRange(me, side);
    let at: number;
    if (otherHost) {
      const [b0, b1] = edgeRange(otherHost, side);
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      at = lo <= hi ? (lo + hi) / 2 : clamp((b0 + b1) / 2, a0, a1);
    } else {
      const pt = cardPortPoint(other, outgoing ? l.to.port : l.from.port, l.id);
      at = clamp(pt ? pt[along] : (otherRect[along] + (along === "y" ? otherRect.h : otherRect.w) / 2), a0, a1);
    }
    raw.push({ link: l.id, port: outgoing ? l.from.port : l.to.port, side, at, group: `${side}:${otherId}` });
  }

  // spread wires bound for the same app, in an order both ends agree on
  const groups = new Map<string, typeof raw>();
  for (const r of raw) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  for (const g of groups.values()) g.sort((p, q) => p.link.localeCompare(q.link)).forEach((r, i) => (r.at += (i - (g.length - 1) / 2) * LANDING_PITCH));

  // then keep every landing on an edge at least a pitch from its neighbour, inside both ends of the edge
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const onSide = raw.filter((r) => r.side === side).sort((p, q) => p.at - q.at || p.link.localeCompare(q.link));
    const [lo, hi] = edgeRange(me, side);
    spreadOnEdge(onSide.map((r) => r.at), lo, hi, LANDING_PITCH).forEach((at, i) => (onSide[i].at = at));
    for (const r of onSide) {
      const x = side === "left" ? me.x : side === "right" ? me.x + me.w : r.at;
      const y = side === "top" ? me.y : side === "bottom" ? me.y + me.h : r.at;
      out.push({ link: r.link, port: r.port, side, x, y });
    }
  }
  return out;
}

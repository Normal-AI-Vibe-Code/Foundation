/**
 * The meta layer above the grid: app and pipeline wires drawn by Vision's
 * flow-diagram rules (wireGeometry.ts) — 45° roads with straight leads,
 * parallel lanes into shared cards, tunnels where one wire passes under
 * another — plus the rings agents leave on the cards they're working on.
 *
 * Wires are interactive: hover shows what flows, click selects (Delete
 * removes), drag from an output magnetises to compatible inputs within 32 px,
 * and grabbing a connected input lifts its wire off to re-route or drop.
 *
 * Geometry runs per frame but writes the DOM only when a route changes;
 * crossings are recomputed only when the set of routes changes.
 */

import { portHover, setPortHover, usePortHover } from "./portHover";
import { peek, ValueSample } from "./flowPeek";
import { flowWork, type FlowWork } from "./flowWork";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { boardMaps, CHARACTER_TYPE, SECTION_PORT, TABLE_PORT, type LinkDoc } from "@foundation/protocol";
import { addLink, applyWireClip, getState, gridSize, objectWorldRect, removeLink, sectionAtWorld, subscribe, uid, updatePanel, usePanel, wireBackstage, wireClipRect, type PanelMeta } from "../state/store";
import { boardTool } from "../lib/collectionDrag";
import { toast } from "../state/ui";
import { useActiveBoard } from "./Presence";
import { toWorld, camera, FAR_ZOOM } from "../state/camera";
import { polyline, route, routeSides, tunnelGeometry, typesCompatible, type P } from "./wireGeometry";
import { allCrossings, publishRoutes, routesVersion, unpublishRoutes } from "./routeRegistry";
import { cardRects, endPanel, endRect, obstaclesFor, portLayout, portPoint, portSide, sectionEndRect, toneOf } from "./ports";
import { countRender } from "../state/renders";
import { parsePairs, portWiresSlice, useStoreSlice } from "../state/slices";
import type { BoardSync } from "../sync/board";

const SNAP_RADIUS = 32;
/** a table's or note's wires meet it level with its header (52 px) */
const OBJECT_ATTACH = 26;

// ---------- drag to connect (magnetic) ----------

type Drag = {
  from: { panel: string; port: string };
  type?: string;
  x: number;
  y: number;
  snap: { panel: string; port: string; x: number; y: number } | null;
  /** a card under the pointer with no compatible port in reach — dropping uses or creates one */
  overPanel: string | null;
  detached?: LinkDoc;
  /**
   * drawn backwards, out of an input (Foundation's avatars: drag from its input to a character card or a
   * section): it snaps to outputs, and let go over a section the wire leaves that section
   */
  reverse?: boolean;
};
let drag: Drag | null = null;
const dragListeners = new Set<() => void>();
const notifyDrag = () => dragListeners.forEach((f) => f());

function portType(panelId: string, portId: string) {
  return endPanel(panelId)?.ports.find((p) => p.id === portId)?.type;
}

/** ring the table a wire would land on */
function markTable(id: string | null) {
  document.querySelectorAll<HTMLElement>(".obj-slot.is-wire-target").forEach((el) => el.dataset.objId !== id && el.classList.remove("is-wire-target"));
  if (id) document.querySelector<HTMLElement>(`.obj-slot[data-obj-id="${CSS.escape(id)}"]`)?.classList.add("is-wire-target");
}

/**
 * Take a wire off (2026-11-24, Josh: "there's no ability to make a disconnection, or undo that result"). It's
 * an ordinary change to the board's links, so the grid's undo puts it back (⌘Z) and redo takes it off again.
 */
export function disconnect(id: string) {
  const l = getState().links[id];
  if (!l) return;
  removeLink(id);
  const st = getState();
  const from = endPanel(l.from.panel)?.name ?? st.tables[l.from.panel]?.name ?? "its source";
  const to = endPanel(l.to.panel)?.name ?? st.tables[l.to.panel]?.name ?? st.notes[l.to.panel]?.name ?? "its card";
  toast(`Disconnected ${from} → ${to} · ⌘Z puts it back`);
}

/** a table or note at a wire's end: no ports of its own, the wire meets its edge level with its header */
function objectEnd(id: string) {
  const st = getState();
  const o = st.tables[id] ?? st.notes[id];
  return o ? objectWorldRect(o) : null;
}

/** ring the section a backwards wire would wire in */
function markSection(id: string | null) {
  document.querySelectorAll<HTMLElement>(".section-card.is-wire-target").forEach((el) => el.dataset.sectionId !== id && el.classList.remove("is-wire-target"));
  if (id) document.querySelector<HTMLElement>(`.section-card[data-section-id="${CSS.escape(id)}"]`)?.classList.add("is-wire-target");
}

/** light up every input this wire could land on; mark the one it's snapped to */
function markTargets(on: boolean) {
  document.body.classList.toggle("is-connecting", on);
  document.querySelectorAll<HTMLElement>(drag?.reverse ? ".port.port-out" : ".port.port-in").forEach((el) => {
    const compatible = on && drag && el.dataset.panel !== drag.from.panel && (drag.reverse ? el.dataset.type === drag.type : typesCompatible(drag.type, el.dataset.type));
    el.classList.toggle("is-target", Boolean(compatible));
    el.classList.toggle("is-snap", Boolean(on && drag?.snap && el.dataset.portId === drag.snap.port));
  });
}

function startDrag(e: React.PointerEvent, from: { panel: string; port: string }, detached?: LinkDoc, reverse = false) {
  const w = toWorld(e.clientX - camera.left, e.clientY - camera.top);
  drag = { from, type: portType(from.panel, from.port), x: w.x, y: w.y, snap: null, overPanel: null, detached, reverse };
  markTargets(true);
  notifyDrag();

  const move = (ev: PointerEvent) => {
    if (!drag) return;
    const p = toWorld(ev.clientX - camera.left, ev.clientY - camera.top);
    let best: Drag["snap"] = null;
    let bestD = SNAP_RADIUS;
    const st = getState();
    const links = Object.values(st.links);
    for (const panel of Object.values(st.panels)) {
      if (panel.id === drag.from.panel) continue;
      for (const port of panel.ports) {
        if (drag.reverse ? port.dir !== "out" || port.type !== drag.type : port.dir !== "in" || !typesCompatible(drag.type, port.type)) continue;
        const pt = portPoint(panel, port.id, undefined, links);
        if (!pt) continue;
        const dist = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (dist < bestD) {
          bestD = dist;
          best = { panel: panel.id, port: port.id, x: pt.x, y: pt.y };
        }
      }
    }
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const hit = under?.closest<HTMLElement>("[data-panel-id]");
    // a table takes a wire too (its rows: the server writes what arrives into its cells, flows.ts)
    const objId = !hit && !drag.reverse ? under?.closest<HTMLElement>("[data-obj-id]")?.dataset.objId : undefined;
    const tableId = objId && st.tables[objId] ? objId : null;
    markTable(best ? null : tableId);
    const over = hit?.dataset.panelId && hit.dataset.panelId !== drag.from.panel ? hit.dataset.panelId : tableId;
    const changed = best?.port !== drag.snap?.port;
    drag = { ...drag, x: p.x, y: p.y, snap: best, overPanel: best ? null : over };
    // drawn backwards: the section it would wire in, when it isn't over a card
    if (drag.reverse) markSection(!best && !over ? (sectionAtWorld(p.x, p.y)?.id ?? null) : null);
    if (changed) markTargets(true);
    notifyDrag();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const d = drag;
    drag = null;
    markTargets(false);
    markSection(null);
    markTable(null);
    notifyDrag();
    if (!d) return;
    const st = getState();
    // let go over a table: the wire lands on its rows
    if (!d.reverse && !d.snap && d.overPanel && st.tables[d.overPanel]) {
      const t = st.tables[d.overPanel];
      const already = Object.values(st.links).some((l) => l.from.panel === d.from.panel && l.from.port === d.from.port && l.to.panel === t.id);
      if (!already) {
        addLink({ from: d.from, to: { panel: t.id, port: TABLE_PORT }, label: d.detached?.label ?? st.panels[d.from.panel]?.ports.find((p) => p.id === d.from.port)?.name });
        toast(`Wired into ${t.name}: what arrives fills its rows`, "ok");
      }
      return;
    }
    if (d.reverse) {
      // out of an input: a card's output it snapped to or was let go over, else the section under the pointer
      const over = d.overPanel ? st.panels[d.overPanel] : undefined;
      const outPort = over?.ports.find((p) => p.dir === "out" && p.type === d.type);
      const sec = !d.snap && !outPort ? sectionAtWorld(d.x, d.y) : null;
      const from = d.snap ? { panel: d.snap.panel, port: d.snap.port } : over && outPort ? { panel: over.id, port: outPort.id } : sec && sec.id !== st.panels[d.from.panel]?.sectionId ? { panel: sec.id, port: SECTION_PORT } : null;
      if (!from) return;
      if (Object.values(st.links).some((l) => l.from.panel === from.panel && l.from.port === from.port && l.to.port === d.from.port)) return;
      addLink({ from, to: d.from, label: sec ? sec.name.replace(/^characters\s*·\s*/i, "") : undefined });
      return;
    }
    let to = d.snap ? { panel: d.snap.panel, port: d.snap.port } : null;
    if (!to && d.overPanel) {
      const dst = st.panels[d.overPanel];
      if (dst) {
        const name = st.panels[d.from.panel]?.ports.find((p) => p.id === d.from.port)?.name ?? "in";
        let inPort = dst.ports.find((p) => p.dir === "in" && typesCompatible(d.type, p.type));
        if (!inPort) {
          inPort = { id: uid("port"), name, dir: "in", type: d.type };
          updatePanel(dst.id, { ports: [...dst.ports, inPort] });
        }
        to = { panel: dst.id, port: inPort.id };
      }
    }
    if (!to) {
      // a collection's output let go over a section (not on a card): it lays its items out there
      const src = st.panels[d.from.panel];
      const sec = src?.panel === "collection" && !d.overPanel ? sectionAtWorld(d.x, d.y) : null;
      if (src && sec) {
        void boardTool<{ into: string | null; laid: number }>("collection_lay_out", { collection: src.id, section: sec.id })
          .then((r) => toast(`Laying ${src.name} out in ${sec.name}${r.laid ? `: ${r.laid} laid` : ""}`, "ok"))
          .catch((e) => toast((e as Error).message, "bad"));
        return;
      }
      if (d.detached) toast("Disconnected");
      return;
    }
    const exists = Object.values(st.links).some((l) => l.from.port === d.from.port && l.to.port === to!.port);
    if (!exists) addLink({ from: d.from, to, label: d.detached?.label ?? st.panels[d.from.panel]?.ports.find((p) => p.id === d.from.port)?.name });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Drag a new wire out of an output port. */
export function beginConnect(e: React.PointerEvent, panel: string, port: string) {
  e.stopPropagation();
  e.preventDefault();
  startDrag(e, { panel, port });
}

/** Draw a wire backwards out of an input: onto a card's output, or let go over a section to wire the whole section in. */
export function beginGather(e: React.PointerEvent, panel: string, port: string) {
  e.stopPropagation();
  e.preventDefault();
  startDrag(e, { panel, port }, undefined, true);
}

/** Grab a connected input: lift the wire landing nearest the pointer off it, to re-route or drop. */
export function beginDetach(e: React.PointerEvent, panel: string, port: string) {
  const st = getState();
  const attached = Object.values(st.links).filter((l) => l.to.panel === panel && l.to.port === port);
  if (!attached.length) return;
  e.stopPropagation();
  e.preventDefault();
  const p = toWorld(e.clientX - camera.left, e.clientY - camera.top);
  const all = Object.values(st.links);
  const target = st.panels[panel];
  const dist = (l: LinkDoc) => {
    const pt = target ? portPoint(target, port, l.id, all) : null;
    return pt ? Math.hypot(pt.x - p.x, pt.y - p.y) : 1e9;
  };
  const nearest = [...attached].sort((a, b) => dist(a) - dist(b))[0];
  removeLink(nearest.id);
  startDrag(e, nearest.from, nearest);
}

const subscribeDrag = (fn: () => void) => {
  dragListeners.add(fn);
  return () => {
    dragListeners.delete(fn);
  };
};

/** renders when a wire drag starts, snaps, lets go of a snap or ends: the ghost follows the pointer per frame, not per render */
function useDrag() {
  useSyncExternalStore(subscribeDrag, () => (drag ? (drag.snap ? "snapped" : "free") : ""));
  return drag;
}

/** which cards other people have in focus, as a signature: their cursors moving render nothing */
function usePeerFocus(board: BoardSync | null): string {
  const sub = useCallback((fn: () => void) => board?.subscribe(fn) ?? (() => {}), [board]);
  return useSyncExternalStore(
    sub,
    () => {
      let out = "";
      for (const p of board?.peers() ?? []) if (p.focus) out += `${p.focus}\u0000${p.user.name}\u0001`;
      return out;
    },
  );
}

// ---------- routes ----------

interface Frame {
  pts: P[];
  d: string;
  /** the section body both ends scroll in, if they share one */
  clip: { x: number; y: number; w: number; h: number } | null;
}

function routesFor(links: LinkDoc[]): Map<string, Frame> {
  const st = getState();
  const frames = new Map<string, Frame>();
  // lanes: wires into the same card share a run, centred and ordered by where they come from; same out of a card
  const intoCard = new Map<string, LinkDoc[]>();
  const outOfCard = new Map<string, LinkDoc[]>();
  for (const l of links) {
    if (!intoCard.has(l.to.panel)) intoCard.set(l.to.panel, []);
    if (!outOfCard.has(l.from.panel)) outOfCard.set(l.from.panel, []);
    intoCard.get(l.to.panel)!.push(l);
    outOfCard.get(l.from.panel)!.push(l);
  }
  const yOf = (id: string) => {
    const sec = sectionEndRect(id);
    if (sec) return sec.y;
    const p = st.panels[id];
    return (p && objectWorldRect(p)?.y) ?? 0;
  };
  const laneOf = new Map<string, number>();
  const srcLaneOf = new Map<string, number>();
  for (const list of intoCard.values())
    [...list].sort((a, b) => yOf(a.from.panel) - yOf(b.from.panel) || a.id.localeCompare(b.id)).forEach((l, i, arr) => laneOf.set(l.id, i - (arr.length - 1) / 2));
  for (const list of outOfCard.values())
    [...list].sort((a, b) => yOf(a.to.panel) - yOf(b.to.panel) || a.id.localeCompare(b.id)).forEach((l, i, arr) => srcLaneOf.set(l.id, i - (arr.length - 1) / 2));

  const rects = cardRects();
  for (const l of links) {
    const a = endPanel(l.from.panel);
    const b = endPanel(l.to.panel);
    const oa = a ? null : objectEnd(l.from.panel);
    const ob = b ? null : objectEnd(l.to.panel);
    if ((!a && !oa) || (!b && !ob)) continue;
    const pa = a ? portPoint(a, l.from.port, l.id, links) : { x: oa!.x + oa!.w, y: oa!.y + OBJECT_ATTACH * oa!.s };
    const pb = b ? portPoint(b, l.to.port, l.id, links) : { x: ob!.x, y: ob!.y + OBJECT_ATTACH * ob!.s };
    if (!pa || !pb) continue;
    // cards leave right and enter left; an app section uses the edge facing the other app
    const sa = a ? portSide(a, l.from.port, l.id) : "right";
    const sb = b ? portSide(b, l.to.port, l.id) : "left";
    const classic = sa === "right" && sb === "left";
    const pts = routeSides(pa, sa, pb, sb, {
      src: a ? endRect(rects, a.id) : oa!,
      dst: b ? endRect(rects, b.id) : ob!,
      lane: classic ? (laneOf.get(l.id) ?? 0) : 0,
      srcLane: classic ? (srcLaneOf.get(l.id) ?? 0) : 0,
      obstacles: obstaclesFor(rects, l.from.panel, l.to.panel),
    });
    const ea = a ?? st.tables[l.from.panel] ?? st.notes[l.from.panel];
    const eb = b ?? st.tables[l.to.panel] ?? st.notes[l.to.panel];
    frames.set(l.id, { pts, d: polyline(pts), clip: wireClipRect(ea, eb) });
  }
  return frames;
}

/** a wire's label sits over the middle of its longest horizontal run */
function labelAt(pts: P[]) {
  let best = { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2, len: -1 };
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (Math.abs(pts[i].y - pts[i - 1].y) < 0.5 && len > best.len) best = { x: (pts[i].x + pts[i - 1].x) / 2, y: pts[i].y, len };
  }
  return best;
}

// ---------- the layer ----------

/** memo: no props, so the grid rendering (a press moves the active section) doesn't render the wires */
export const PortWires = memo(function PortWires() {
  countRender("PortWires");
  // the wires and what they show, not the cards: a drag, a keystroke or a pointer elsewhere renders nothing
  const slice = useStoreSlice(portWiresSlice);
  // the port under the pointer: its wires light up, wherever they run
  const onPort = usePortHover();
  const peerFocus = usePeerFocus(useActiveBoard());
  const d = useDrag();
  const groups = useRef(new Map<string, SVGGElement>());
  const ghost = useRef<SVGPathElement>(null);
  const rings = useRef(new Map<string, SVGRectElement>());
  // the pressed wire and where it was pressed: its bar opens there (what flows, Disconnect)
  const [picked, setPicked] = useState<{ id: string; x: number; y: number } | null>(null);
  const selected = picked && slice.links[picked.id] ? picked.id : null;
  const setSelected = (id: string | null) => setPicked(id ? { id, x: picked?.x ?? 0, y: picked?.y ?? 0 } : null);
  const chips = useRef(new Map<string, HTMLDivElement>());
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  const links: LinkDoc[] = useMemo(() => Object.values(slice.links), [slice.links]);
  const agentFocus = useMemo(() => {
    const out = new Map<string, { name: string }>();
    for (const [id, name] of parsePairs(peerFocus)) out.set(id, { name });
    for (const [id, name] of parsePairs(slice.running)) out.set(id, { name });
    return out;
  }, [peerFocus, slice.running]);

  // Delete / Backspace removes the selected wire; Esc or a click elsewhere lets go
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        disconnect(selected);
        setSelected(null);
      } else if (e.key === "Escape") setSelected(null);
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".pipe-hit, .wire-bar")) setSelected(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [selected]);

  useEffect(() => {
    let raf = 0;
    const lastD = new Map<string, string>();
    let lastVersion = -1;
    const tick = () => {
      const frames = routesFor(links);
      for (const l of links) {
        const g = groups.current.get(l.id);
        const f = frames.get(l.id);
        if (!g) continue;
        if (!f) {
          g.style.display = "none";
          continue;
        }
        g.style.display = "";
        const key = f.clip ? `${f.d}|${f.clip.x},${f.clip.y},${f.clip.w},${f.clip.h}` : f.d;
        if (lastD.get(l.id) === key) continue;
        lastD.set(l.id, key);
        applyWireClip(g, f.clip);
        g.querySelectorAll<SVGPathElement>("path[data-route]").forEach((p) => p.setAttribute("d", f.d));
        // the tunnel mask covers just this wire (+40 px): a huge mask fails to rasterise
        const xs = f.pts.map((p) => p.x);
        const ys = f.pts.map((p) => p.y);
        const box = { x: Math.min(...xs) - 40, y: Math.min(...ys) - 40, width: Math.max(...xs) - Math.min(...xs) + 80, height: Math.max(...ys) - Math.min(...ys) + 80 };
        const mask = g.querySelector("mask");
        const rect = mask?.querySelector("rect");
        for (const [k, v] of Object.entries(box)) {
          mask?.setAttribute(k, String(v));
          rect?.setAttribute(k, String(v));
        }
        const ends = g.querySelectorAll("circle");
        ends[0]?.setAttribute("cx", String(f.pts[0].x));
        ends[0]?.setAttribute("cy", String(f.pts[0].y));
        ends[1]?.setAttribute("cx", String(f.pts[f.pts.length - 1].x));
        ends[1]?.setAttribute("cy", String(f.pts[f.pts.length - 1].y));
        // a short hop across the gap between two apps keeps its label for hover
        let length = 0;
        for (let i = 1; i < f.pts.length; i++) length += Math.hypot(f.pts[i].x - f.pts[i - 1].x, f.pts[i].y - f.pts[i - 1].y);
        g.classList.toggle("is-short", length < 160);
        const label = g.querySelector("text");
        const at = labelAt(f.pts);
        if (label) {
          label.setAttribute("x", String(at.x));
          label.setAttribute("y", String(at.y - 9));
        }
        const chip = chips.current.get(l.id);
        if (chip) {
          chip.dataset.x = String(at.x);
          chip.dataset.y = String(at.y);
          chip.classList.toggle("is-short", length < 160);
        }
      }
      // the chips ride their wires at a constant size on screen
      const k = 1 / (camera.scale || 1);
      for (const [id, chip] of chips.current) {
        const g = groups.current.get(id);
        const hidden = !g || g.style.display === "none" || chip.dataset.x === undefined;
        const key = `${chip.dataset.x},${chip.dataset.y},${k.toFixed(3)},${hidden}`;
        if (chip.dataset.key === key) continue;
        chip.dataset.key = key;
        chip.style.display = hidden ? "none" : "";
        chip.style.transform = `translate3d(${chip.dataset.x}px, ${chip.dataset.y}px, 0) scale(${k})`;
      }
      // over / under across every wire layer: tunnels recomputed only when some route moved
      publishRoutes("ports", new Map([...frames].map(([id, f]) => [id, f.pts])), [...frames.values()].map((f) => f.d).join("|"));
      if (routesVersion() !== lastVersion) {
        lastVersion = routesVersion();
        const crossings = allCrossings();
        for (const [id, f] of frames) {
          const g = groups.current.get(id);
          if (!g) continue;
          const t = tunnelGeometry(f.pts, crossings.get(id) ?? [], 13);
          g.querySelector(".tunnel-cut")?.setAttribute("d", t.cut);
          g.querySelector(".pipe-terminal")?.setAttribute("d", t.terminals);
          g.classList.toggle("is-under", t.cut.length > 0);
          const body = g.querySelector<SVGGElement>(".pipe-body");
          if (body) {
            if (t.cut.length > 0) body.setAttribute("mask", body.dataset.mask ?? "");
            else body.removeAttribute("mask");
          }
        }
      }
      if (ghost.current && drag) {
        const a = endPanel(drag.from.panel);
        const pa = a && portPoint(a, drag.from.port);
        if (pa) {
          const end = drag.snap ?? { x: drag.x, y: drag.y };
          // backwards out of an input, the ghost still runs the way the wire will: from the pointer into the input
          const pts = drag.reverse ? route(end, pa, { leadOut: drag.snap ? 48 : 0 }) : route(pa, end, { leadOut: drag.snap ? 48 : 0, src: sectionEndRect(a.id) ?? objectWorldRect(a) });
          ghost.current.setAttribute("d", polyline(pts));
          ghost.current.classList.toggle("is-snapped", Boolean(drag.snap));
        }
      }
      for (const [id, rect] of rings.current) {
        const st = getState();
        const o = st.panels[id] ?? st.notes[id] ?? st.tables[id] ?? st.media[id] ?? st.maps[id];
        const r = o && objectWorldRect(o);
        if (!r) continue;
        const key = `${r.x},${r.y},${r.w},${r.h}`;
        if (lastD.get(`ring:${id}`) === key) continue;
        lastD.set(`ring:${id}`, key);
        rect.setAttribute("x", String(r.x - 8));
        rect.setAttribute("y", String(r.y - 8));
        rect.setAttribute("width", String(r.w + 16));
        rect.setAttribute("height", String(r.h + 16));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      unpublishRoutes("ports");
    };
  }, [links, agentFocus, d !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const size = gridSize(slice.grid);
  if (links.length === 0 && !d && agentFocus.size === 0) return null;
  const state = getState();
  const hovered = hover ? state.links[hover.id] : undefined;

  return (
    <>
      <svg
        className={`port-layer${d ? " is-dragging" : ""}`}
        width={size.w}
        height={size.h}
        style={{ overflow: "visible" }}
        // drawn small when it mounts: the pulse and the tunnels rest from the start (the viewport marks it as the camera changes)
        ref={(el) => {
          if (el && camera.scale < FAR_ZOOM) el.dataset.far = "1";
        }}
      >
        {[...agentFocus.entries()].map(([id, a]) => (
          <g key={`ring-${id}`} className="agent-ring">
            <rect
              rx={14}
              ref={(el) => {
                if (el) rings.current.set(id, el);
                else rings.current.delete(id);
              }}
            />
            <title>{a.name} is working here</title>
          </g>
        ))}
        {links.map((l) => {
          const type = portType(l.from.panel, l.from.port);
          // a character wire always carries its characters (into Foundation's avatars, a collection): it flows
          const live = state.panels[l.from.panel]?.outputs?.[l.from.port] !== undefined || type === CHARACTER_TYPE;
          const backstage = wireBackstage(state, state.panels[l.from.panel]?.sectionId, state.panels[l.to.panel]?.sectionId);
          return (
            <g
              key={l.id}
              className={`pipe${live ? " is-live" : ""}${selected === l.id ? " is-selected" : ""}${hover?.id === l.id || (onPort && ((l.from.panel === onPort.panel && l.from.port === onPort.port) || (l.to.panel === onPort.panel && l.to.port === onPort.port))) ? " is-hover" : ""}${backstage ? " is-backstage" : ""}`}
              style={{ ["--wire-tone" as string]: toneOf(type) }}
              ref={(el) => {
                if (el) groups.current.set(l.id, el);
                else groups.current.delete(l.id);
              }}
            >
              <defs>
                <clipPath id={`clip-${l.id}`} clipPathUnits="userSpaceOnUse">
                  <rect />
                </clipPath>
                <mask id={`tun-${l.id}`} maskUnits="userSpaceOnUse">
                  <rect fill="white" />
                  <path className="tunnel-cut" fill="black" />
                </mask>
              </defs>
              <path className="pipe-trace" data-route />
              {/* the tunnel mask goes on only where this wire passes under another: a mask is a repaint each frame
                  the camera moves on WebKit, and most wires never cross */}
              <g className="pipe-body" data-mask={`url(#tun-${l.id})`}>
                <path className="pipe-lane" data-route />
                <path className="pipe-wire" data-route />
                <path className="pipe-pulse" data-route />
              </g>
              <path className="pipe-terminal" />
              <circle r={3.5} className="pipe-end" />
              <circle r={3.5} className="pipe-end" />
              {l.label && !chipShows(state, l) && <text className="pipe-label">{l.label}</text>}
              <path
                className="pipe-hit"
                data-route
                onPointerDown={(e) => {
                  // a press on a port the wire lands on is the port's: an output starts another wire (a stage's
                  // output wired on into a collection too), a wired input lifts this one off to re-route
                  const port = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList.contains("port")) as HTMLElement | undefined;
                  if (port?.dataset.panel && port.dataset.portId) {
                    if (port.classList.contains("port-out")) return beginConnect(e, port.dataset.panel, port.dataset.portId);
                    return beginDetach(e, port.dataset.panel, port.dataset.portId);
                  }
                  e.stopPropagation();
                  const w = toWorld(e.clientX - camera.left, e.clientY - camera.top);
                  setPicked({ id: l.id, x: w.x, y: w.y });
                  setHover(null);
                }}
                onContextMenu={(e) => {
                  // a right-click on a wire opens its bar too (Disconnect is the one thing a wire's menu would hold)
                  e.preventDefault();
                  e.stopPropagation();
                  const w = toWorld(e.clientX - camera.left, e.clientY - camera.top);
                  setPicked({ id: l.id, x: w.x, y: w.y });
                  setHover(null);
                }}
                // a wire's hit area lies over the ports it lands on: where a port is under the pointer, the port
                // answers (its own label: what's on it, where it goes), not the wire
                onPointerMove={(e) => {
                  const port = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList.contains("port")) as HTMLElement | undefined;
                  if (port?.dataset.panel && port.dataset.portId) {
                    setPortHover({ panel: port.dataset.panel, port: port.dataset.portId });
                    if (hover) setHover(null);
                    return;
                  }
                  if (portHover()) setPortHover(null);
                  if (hover?.id !== l.id) {
                    const w = toWorld(e.clientX - camera.left, e.clientY - camera.top);
                    setHover({ id: l.id, x: w.x, y: w.y });
                  }
                }}
                onPointerLeave={() => {
                  setHover(null);
                  setPortHover(null);
                }}
              />
            </g>
          );
        })}
        {d && <path ref={ghost} className={`pipe-ghost${d.snap ? " is-snapped" : ""}`} style={{ ["--wire-tone" as string]: toneOf(d.type) }} />}
      </svg>
      <div className="flow-chips">
        {links.map((l) => (
          <FlowChip
            key={l.id}
            link={l}
            hot={hover?.id === l.id || selected === l.id}
            ref={(el) => {
              if (el) chips.current.set(l.id, el);
              else chips.current.delete(l.id);
            }}
          />
        ))}
      </div>
      {hovered && hover && !selected && <PipeTip link={hovered} x={hover.x} y={hover.y} />}
      {selected && picked && state.links[selected] && <WireBar link={state.links[selected]} x={picked.x} y={picked.y} onDone={() => setPicked(null)} />}
    </>
  );
});

/** what flows along a hovered wire: follows its two apps (the value updates while you look) */
function PipeTip({ link, x, y }: { link: LinkDoc; x: number; y: number }) {
  const from = usePanel(link.from.panel) ?? endPanel(link.from.panel);
  const to = usePanel(link.to.panel);
  const fromPort = from?.ports.find((p) => p.id === link.from.port);
  const toPort = to?.ports.find((p) => p.id === link.to.port);
  const type = fromPort?.type;
  return (
    <div className="pipe-tip" style={{ transform: `translate3d(${x}px, ${y}px, 0) scale(${1 / camera.scale})` }}>
      <b>
        {link.label ?? "data"} <i style={{ color: toneOf(type) }}>{type ?? "json"}</i>
      </b>
      <span>
        out of <b>{from?.name}</b>
        {fromPort ? ` (${fromPort.name})` : ""} → into <b>{to?.name}</b>
        {toPort ? ` (${toPort.name})` : ""}
      </span>
      <ValueSample value={from?.outputs?.[link.from.port]} />
      <span className="pipe-tip-hint">press it for its bar: Disconnect, or ⌫</span>
    </div>
  );
}

/** the shared port layout for a card (PanelView renders its pills from this) */
export function usePortLayout(panel: PanelMeta) {
  // only the links: a whole-store subscription re-rendered every app on the board at each press, drag frame and keystroke
  const links = useSyncExternalStore(subscribe, () => getState().links);
  return useMemo(() => portLayout(panel, Object.values(links)), [panel, links]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------- what a wire carries, on the wire ----------

/** the value at a wire's source end, as the client can see it (an app's or connector's output; a table's rows are the server's to read) */
function wireValue(l: LinkDoc): unknown {
  return getState().panels[l.from.panel]?.outputs?.[l.from.port];
}

/** a wire shows its chip (and not its plain label) when something is on it or it feeds a table the server fills */
function chipShows(state: ReturnType<typeof getState>, l: LinkDoc): boolean {
  return state.panels[l.from.panel]?.outputs?.[l.from.port] !== undefined || !!state.tables[l.to.panel];
}

/**
 * The chip riding a wire (2026-11-24): a peek at what's on it ("12 rows × 4 columns"), and what the card it
 * feeds is doing: working (a spinner, while the server reads the source or the card generates), waiting for
 * data, or why it failed. It rings once when a new value arrives. Placed per frame by PortWires' loop.
 */
function FlowChip({ link, hot, ref }: { link: LinkDoc; hot: boolean; ref: (el: HTMLDivElement | null) => void }) {
  const from = usePanel(link.from.panel);
  const value = from?.outputs?.[link.from.port];
  const tick = useFlowTick(link.to.panel);
  const work: FlowWork = flowWork(link, value, tick);
  const [fresh, setFresh] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 900);
    return () => clearTimeout(t);
  }, [value]);
  const shows = value !== undefined || work.kind !== "idle";
  return (
    <div
      ref={ref}
      className={`flow-chip is-${work.kind}${fresh ? " is-fresh" : ""}${hot ? " is-hot" : ""}`}
      data-link={link.id}
      data-flow={work.kind}
      style={{ ["--wire-tone" as string]: toneOf(portType(link.from.panel, link.from.port)), visibility: shows ? undefined : "hidden" }}
      title={work.title}
    >
      <span>{work.text ?? peek(value)}</span>
    </div>
  );
}

/** re-render a chip when the server's state for the card it feeds changes (its `flows` entry, a character's stage) */
function useFlowTick(cardId: string): string {
  const board = useActiveBoard();
  const sub = useCallback(
    (fn: () => void) => {
      if (!board) return () => {};
      const maps = boardMaps(board.doc);
      const on = (e: { keysChanged: Set<string> }) => e.keysChanged.has(cardId) && fn();
      maps.flows.observe(on);
      maps.characters.observe(on);
      return () => {
        maps.flows.unobserve(on);
        maps.characters.unobserve(on);
      };
    },
    [board, cardId],
  );
  return useSyncExternalStore(sub, () => {
    if (!board) return "";
    const maps = boardMaps(board.doc);
    const f = maps.flows.get(cardId);
    const c = maps.characters.get(cardId);
    const running = c ? Object.entries(c.stages ?? {}).find(([, x]) => x?.state === "running") : undefined;
    return `${f?.status ?? ""}:${f?.at ?? 0}:${running ? `${running[0]}:${running[1]?.progress ?? 0}` : ""}`;
  });
}

/** a pressed wire's bar: what flows along it now, and Disconnect (⌫ does the same; ⌘Z puts it back) */
function WireBar({ link, x, y, onDone }: { link: LinkDoc; x: number; y: number; onDone: () => void }) {
  const from = usePanel(link.from.panel) ?? endPanel(link.from.panel);
  const to = usePanel(link.to.panel) ?? endPanel(link.to.panel);
  const st = getState();
  const toName = to?.name ?? st.tables[link.to.panel]?.name ?? st.notes[link.to.panel]?.name ?? "a card that's gone";
  const fromName = from?.name ?? st.tables[link.from.panel]?.name ?? st.notes[link.from.panel]?.name ?? "?";
  const fromPort = from?.ports.find((p) => p.id === link.from.port);
  const value = wireValue(link);
  return (
    <div
      className="wire-bar"
      data-wire-bar={link.id}
      style={{ transform: `translate3d(${x}px, ${y}px, 0) scale(${1 / camera.scale}) translate(12px, 12px)`, ["--wire-tone" as string]: toneOf(fromPort?.type) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="wire-bar-head">
        <b>{fromName}</b>→<b>{toName}</b>
        <i>{fromPort?.type ?? "json"}</i>
      </span>
      <span className="wire-bar-head">{value === undefined && st.tables[link.from.panel] ? "its rows" : peek(value)}</span>
      {value !== undefined && <ValueSample value={value} />}
      <span className="wire-bar-actions">
        <button
          type="button"
          className="is-cut"
          data-wire-disconnect
          onClick={() => {
            disconnect(link.id);
            onDone();
          }}
        >
          Disconnect
        </button>
        <button type="button" onClick={onDone}>
          Close
        </button>
        <span className="wire-bar-key">⌫ · ⌘Z undoes</span>
      </span>
    </div>
  );
}

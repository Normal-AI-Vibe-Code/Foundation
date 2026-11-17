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

import { portHover, sayValue, setPortHover, usePortHover } from "./portHover";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LinkDoc } from "@foundation/protocol";
import { addLink, applyWireClip, getState, gridSize, objectWorldRect, removeLink, sectionAtWorld, subscribe, uid, updatePanel, usePanel, wireBackstage, wireClipRect, type PanelMeta } from "../state/store";
import { boardTool } from "../lib/collectionDrag";
import { toast } from "../state/ui";
import { useActiveBoard } from "./Presence";
import { toWorld, camera } from "../state/camera";
import { polyline, route, routeSides, tunnelGeometry, typesCompatible, type P } from "./wireGeometry";
import { allCrossings, publishRoutes, routesVersion, unpublishRoutes } from "./routeRegistry";
import { cardRects, endRect, obstaclesFor, portLayout, portPoint, portSide, toneOf } from "./ports";
import { countRender } from "../state/renders";
import { parsePairs, portWiresSlice, useStoreSlice } from "../state/slices";
import type { BoardSync } from "../sync/board";

const SNAP_RADIUS = 32;

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
};
let drag: Drag | null = null;
const dragListeners = new Set<() => void>();
const notifyDrag = () => dragListeners.forEach((f) => f());

function portType(panelId: string, portId: string) {
  return getState().panels[panelId]?.ports.find((p) => p.id === portId)?.type;
}

/** light up every input this wire could land on; mark the one it's snapped to */
function markTargets(on: boolean) {
  document.body.classList.toggle("is-connecting", on);
  document.querySelectorAll<HTMLElement>(".port.port-in").forEach((el) => {
    const compatible = on && drag && el.dataset.panel !== drag.from.panel && typesCompatible(drag.type, el.dataset.type);
    el.classList.toggle("is-target", Boolean(compatible));
    el.classList.toggle("is-snap", Boolean(on && drag?.snap && el.dataset.portId === drag.snap.port));
  });
}

function startDrag(e: React.PointerEvent, from: { panel: string; port: string }, detached?: LinkDoc) {
  const w = toWorld(e.clientX - camera.left, e.clientY - camera.top);
  drag = { from, type: portType(from.panel, from.port), x: w.x, y: w.y, snap: null, overPanel: null, detached };
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
        if (port.dir !== "in" || !typesCompatible(drag.type, port.type)) continue;
        const pt = portPoint(panel, port.id, undefined, links);
        if (!pt) continue;
        const dist = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (dist < bestD) {
          bestD = dist;
          best = { panel: panel.id, port: port.id, x: pt.x, y: pt.y };
        }
      }
    }
    const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-panel-id]");
    const over = hit?.dataset.panelId && hit.dataset.panelId !== drag.from.panel ? hit.dataset.panelId : null;
    const changed = best?.port !== drag.snap?.port;
    drag = { ...drag, x: p.x, y: p.y, snap: best, overPanel: best ? null : over };
    if (changed) markTargets(true);
    notifyDrag();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const d = drag;
    drag = null;
    markTargets(false);
    notifyDrag();
    if (!d) return;
    const st = getState();
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
    const a = st.panels[l.from.panel];
    const b = st.panels[l.to.panel];
    if (!a || !b) continue;
    const pa = portPoint(a, l.from.port, l.id, links);
    const pb = portPoint(b, l.to.port, l.id, links);
    if (!pa || !pb) continue;
    // cards leave right and enter left; an app section uses the edge facing the other app
    const sa = portSide(a, l.from.port, l.id);
    const sb = portSide(b, l.to.port, l.id);
    const classic = sa === "right" && sb === "left";
    const pts = routeSides(pa, sa, pb, sb, {
      src: endRect(rects, a.id),
      dst: endRect(rects, b.id),
      lane: classic ? (laneOf.get(l.id) ?? 0) : 0,
      srcLane: classic ? (srcLaneOf.get(l.id) ?? 0) : 0,
      obstacles: obstaclesFor(rects, a.id, b.id),
    });
    frames.set(l.id, { pts, d: polyline(pts), clip: wireClipRect(a, b) });
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
  const [selected, setSelected] = useState<string | null>(null);
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
        removeLink(selected);
        setSelected(null);
        toast("Connection removed");
      } else if (e.key === "Escape") setSelected(null);
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".pipe-hit")) setSelected(null);
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
        if (label) {
          const at = labelAt(f.pts);
          label.setAttribute("x", String(at.x));
          label.setAttribute("y", String(at.y - 9));
        }
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
        }
      }
      if (ghost.current && drag) {
        const a = getState().panels[drag.from.panel];
        const pa = a && portPoint(a, drag.from.port);
        if (pa) {
          const end = drag.snap ?? { x: drag.x, y: drag.y };
          ghost.current.setAttribute("d", polyline(route(pa, end, { leadOut: drag.snap ? 48 : 0, src: objectWorldRect(a) })));
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
      <svg className={`port-layer${d ? " is-dragging" : ""}`} width={size.w} height={size.h} style={{ overflow: "visible" }}>
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
          const live = state.panels[l.from.panel]?.outputs?.[l.from.port] !== undefined;
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
              <g mask={`url(#tun-${l.id})`}>
                <path className="pipe-lane" data-route />
                <path className="pipe-wire" data-route />
                <path className="pipe-pulse" data-route />
              </g>
              <path className="pipe-terminal" />
              <circle r={3.5} className="pipe-end" />
              <circle r={3.5} className="pipe-end" />
              {l.label && <text className="pipe-label">{l.label}</text>}
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
                  setSelected(l.id);
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
      {hovered && hover && <PipeTip link={hovered} x={hover.x} y={hover.y} />}
    </>
  );
});

/** what flows along a hovered wire: follows its two apps (the value updates while you look) */
function PipeTip({ link, x, y }: { link: LinkDoc; x: number; y: number }) {
  const from = usePanel(link.from.panel);
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
      <span className="pipe-tip-value">{sayValue(from?.outputs?.[link.from.port])}</span>
      <span className="pipe-tip-hint">click to select · ⌫ removes</span>
    </div>
  );
}

/** the shared port layout for a card (PanelView renders its pills from this) */
export function usePortLayout(panel: PanelMeta) {
  // only the links: a whole-store subscription re-rendered every app on the board at each press, drag frame and keystroke
  const links = useSyncExternalStore(subscribe, () => getState().links);
  return useMemo(() => portLayout(panel, Object.values(links)), [panel, links]); // eslint-disable-line react-hooks/exhaustive-deps
}

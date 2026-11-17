import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workbook } from "../engine/workbook";
import { applyWireClip, bindMap, getState, gridSize, objectWorldRect, wireBackstage, wireClipRect } from "../state/store";
import { sheetWiresSlice, useStoreSlice } from "../state/slices";
import { polyline, route, routeAvoiding, tunnelGeometry, type P } from "../shell/wireGeometry";
import { cardRects, obstaclesFor } from "../shell/ports";
import { allCrossings, publishRoutes, routesVersion, unpublishRoutes } from "../shell/routeRegistry";
import { countRender } from "../state/renders";

/**
 * The spreadsheet's data-flow wires, drawn by the same flow-diagram rules as
 * app wires (DESIGN.md §5.1 — 45° roads, straight leads, lanes, tunnels):
 *  - table → map for every map binding (blue)
 *  - table → table for every cross-table formula dependency (green)
 * A wire leaves its source's right edge and enters its consumer's left edge
 * level with the header. Routes are shared with the app-wire layer so
 * over/under is decided across both. Geometry runs imperatively per frame and
 * writes only when a route changes — zero React re-renders on the hot path.
 */

/** wires attach level with a card's header (tables and maps have 52 px headers) */
const ATTACH_Y = 26;

interface Edge {
  key: string;
  from: string; // object id (data source)
  to: string; // object id (consumer)
  kind: "map" | "ref";
}

/** memo: no props, so the grid rendering (a press moves the active section) doesn't render the wires */
export const WireLayer = memo(function WireLayer() {
  countRender("WireLayer");
  // which wires exist and where their ends live, not the cards themselves: moving or typing renders nothing
  const slice = useStoreSlice(sheetWiresSlice);
  const [formulaEdges, setFormulaEdges] = useState(() => workbook.tableDependencies());
  const groupRefs = useRef(new Map<string, SVGGElement>());
  const hotUntil = useRef(new Map<string, number>()); // source tableId -> ts
  const svgRef = useRef<SVGSVGElement>(null);
  const highlightRef = useRef<SVGRectElement>(null);

  /** live rebind drag: pull a map wire's consumer end onto another map */
  const rebind = useRef<{
    edgeKey: string;
    tableId: string;
    oldMapId: string;
    x: number;
    y: number;
    hoverMapId: string | null;
  } | null>(null);

  const worldPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const size = gridSize(getState().grid);
    const scale = size.w > 0 ? r.width / size.w : 1;
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  }, []);

  const beginRebind = useCallback(
    (e: React.PointerEvent, edge: Edge) => {
      if (edge.kind !== "map") return;
      e.stopPropagation();
      e.preventDefault();
      const pt = worldPoint(e.clientX, e.clientY);
      if (!pt) return;
      rebind.current = {
        edgeKey: edge.key,
        tableId: edge.from,
        oldMapId: edge.to,
        x: pt.x,
        y: pt.y,
        hoverMapId: null,
      };
      document.body.classList.add("rewiring");
      const move = (ev: PointerEvent) => {
        const p = worldPoint(ev.clientX, ev.clientY);
        const rb = rebind.current;
        if (!p || !rb) return;
        rb.x = p.x;
        rb.y = p.y;
        rb.hoverMapId = null;
        for (const m of Object.values(getState().maps)) {
          const rect = objectWorldRect(m);
          if (rect && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
            rb.hoverMapId = m.id;
            break;
          }
        }
      };
      const up = () => {
        const rb = rebind.current;
        rebind.current = null;
        document.body.classList.remove("rewiring");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (highlightRef.current) highlightRef.current.style.display = "none";
        if (rb?.hoverMapId && rb.hoverMapId !== rb.oldMapId) {
          bindMap(rb.hoverMapId, rb.tableId); // the connection moves…
          bindMap(rb.oldMapId, null); // …away from the old map
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [worldPoint],
  );

  // refresh the edge list + pulse wires when data flows
  useEffect(() => {
    return workbook.subscribeAll((tableId) => {
      setFormulaEdges(workbook.tableDependencies());
      if (tableId) hotUntil.current.set(tableId, performance.now() + 900);
    });
  }, []);

  const edges = useMemo((): Edge[] => {
    const state = getState();
    const out: Edge[] = [];
    for (const m of Object.values(state.maps)) {
      if (m.sourceTableId && state.tables[m.sourceTableId]) {
        out.push({ key: `map:${m.id}`, from: m.sourceTableId, to: m.id, kind: "map" });
      }
    }
    for (const e of formulaEdges) {
      if (state.tables[e.source] && state.tables[e.dependent]) {
        out.push({ key: `ref:${e.source}->${e.dependent}`, from: e.source, to: e.dependent, kind: "ref" });
      }
    }
    return out;
  }, [slice.maps, slice.tables, formulaEdges]);

  // ----- imperative per-frame geometry -----
  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const lastD = new Map<string, string>();
    let lastVersion = -1;

    const objOf = (id: string) => {
      const st = getState();
      return st.tables[id] ?? st.maps[id] ?? st.notes[id] ?? st.media[id] ?? st.panels[id];
    };

    const tick = () => {
      if (disposed) return;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      const now = performance.now();

      // lanes: wires into the same card run side by side, ordered by where they come from; same out of a card
      const into = new Map<string, Edge[]>();
      const outOf = new Map<string, Edge[]>();
      for (const e of edges) {
        if (!into.has(e.to)) into.set(e.to, []);
        if (!outOf.has(e.from)) outOf.set(e.from, []);
        into.get(e.to)!.push(e);
        outOf.get(e.from)!.push(e);
      }
      const yOf = (id: string) => {
        const o = objOf(id);
        return (o && objectWorldRect(o)?.y) ?? 0;
      };
      const lane = new Map<string, number>();
      const srcLane = new Map<string, number>();
      for (const list of into.values())
        [...list].sort((a, b) => yOf(a.from) - yOf(b.from) || a.key.localeCompare(b.key)).forEach((e, i, arr) => lane.set(e.key, i - (arr.length - 1) / 2));
      for (const list of outOf.values())
        [...list].sort((a, b) => yOf(a.to) - yOf(b.to) || a.key.localeCompare(b.key)).forEach((e, i, arr) => srcLane.set(e.key, i - (arr.length - 1) / 2));

      const routes = new Map<string, P[]>();
      const rects = cardRects();
      for (const edge of edges) {
        const g = groupRefs.current.get(edge.key);
        if (!g) continue;
        const a = objOf(edge.from);
        const b = objOf(edge.to);
        const ra = a && objectWorldRect(a);
        const rb = b && objectWorldRect(b);
        if (!ra || !rb) {
          g.style.display = "none";
          continue;
        }
        g.style.display = "";
        const activeRebind = rebind.current?.edgeKey === edge.key ? rebind.current : null;
        const start = { x: ra.x + ra.w, y: ra.y + ATTACH_Y * ra.s };
        const end = activeRebind ? { x: activeRebind.x, y: activeRebind.y } : { x: rb.x, y: rb.y + ATTACH_Y * rb.s };
        const routeOpts = {
          src: ra,
          dst: activeRebind ? null : rb,
          leadOut: activeRebind ? 0 : undefined,
          lane: lane.get(edge.key) ?? 0,
          srcLane: srcLane.get(edge.key) ?? 0,
        };
        // while dragging a rebind the plain road follows the pointer; at rest, roads go round cards
        const pts = activeRebind ? route(start, end, routeOpts) : routeAvoiding(start, end, { ...routeOpts, obstacles: obstaclesFor(rects, edge.from, edge.to) });
        routes.set(edge.key, pts);
        g.classList.toggle("rebinding", !!activeRebind);
        // recalc pulse: packets flow for a moment after the source table changes
        g.classList.toggle("is-live", (hotUntil.current.get(edge.from) ?? 0) > now);
        const d = polyline(pts);
        const clip = activeRebind ? null : wireClipRect(a, b);
        const key = clip ? `${d}|${clip.x},${clip.y},${clip.w},${clip.h}` : d;
        if (lastD.get(edge.key) === key) continue;
        lastD.set(edge.key, key);
        applyWireClip(g, clip);
        g.querySelectorAll<SVGPathElement>("path[data-route]").forEach((p) => p.setAttribute("d", d));
        const ends = g.querySelectorAll("circle");
        ends[0]?.setAttribute("cx", String(start.x));
        ends[0]?.setAttribute("cy", String(start.y));
        ends[1]?.setAttribute("cx", String(end.x));
        ends[1]?.setAttribute("cy", String(end.y));
        // the tunnel mask covers just this wire
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const box = { x: Math.min(...xs) - 40, y: Math.min(...ys) - 40, width: Math.max(...xs) - Math.min(...xs) + 80, height: Math.max(...ys) - Math.min(...ys) + 80 };
        const mask = g.querySelector("mask");
        const rect = mask?.querySelector("rect");
        for (const [k, v] of Object.entries(box)) {
          mask?.setAttribute(k, String(v));
          rect?.setAttribute(k, String(v));
        }
      }

      // over / under, decided across every wire layer
      publishRoutes("sheet", routes, [...routes.values()].map(polyline).join("|"));
      if (routesVersion() !== lastVersion) {
        lastVersion = routesVersion();
        const crossings = allCrossings();
        for (const [key, pts] of routes) {
          const g = groupRefs.current.get(key);
          if (!g) continue;
          const t = tunnelGeometry(pts, crossings.get(key) ?? [], 13);
          g.querySelector(".tunnel-cut")?.setAttribute("d", t.cut);
          g.querySelector(".pipe-terminal")?.setAttribute("d", t.terminals);
          g.classList.toggle("is-under", t.cut.length > 0);
        }
      }

      // drop-target highlight while rebinding
      const hl = highlightRef.current;
      if (hl) {
        const rb = rebind.current;
        const hoverMap = rb?.hoverMapId ? getState().maps[rb.hoverMapId] : null;
        const hr = hoverMap && objectWorldRect(hoverMap);
        if (hr) {
          hl.style.display = "";
          hl.setAttribute("x", String(hr.x - 6));
          hl.setAttribute("y", String(hr.y - 6));
          hl.setAttribute("width", String(hr.w + 12));
          hl.setAttribute("height", String(hr.h + 12));
        } else {
          hl.style.display = "none";
        }
      }
      raf = requestAnimationFrame(tick);
      timer = setTimeout(tick, 80); // hidden-window fallback
    };
    tick();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      unpublishRoutes("sheet");
    };
    // the loop reads every card's place from the store each frame; only a new set of wires restarts it
  }, [edges]);

  const size = gridSize(slice.grid);
  if (edges.length === 0) return null;
  const state = getState();
  const sectionOf = (id: string) => (state.tables[id] ?? state.maps[id])?.sectionId;

  return (
    <svg
      ref={svgRef}
      className="wire-layer"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      style={{ overflow: "visible" }}
    >
      {edges.map((e) => (
        <g
          key={e.key}
          className={`pipe wire-group ${e.kind}${wireBackstage(state, sectionOf(e.from), sectionOf(e.to)) ? " is-backstage" : ""}`}
          style={{ ["--wire-tone" as string]: e.kind === "map" ? "var(--color-pulse)" : "var(--color-wire-formula)" }}
          ref={(el) => {
            if (el) groupRefs.current.set(e.key, el);
            else groupRefs.current.delete(e.key);
          }}
        >
          <title>{e.kind === "map" ? "Table → map: rows with Lat/Lng become pins" : "Formula: this table reads the other"}</title>
          <defs>
            <clipPath id={`sheet-clip-${e.key.replace(/[^\w-]/g, "_")}`} clipPathUnits="userSpaceOnUse">
              <rect />
            </clipPath>
            <mask id={`sheet-tun-${e.key.replace(/[^\w-]/g, "_")}`} maskUnits="userSpaceOnUse">
              <rect fill="white" />
              <path className="tunnel-cut" fill="black" />
            </mask>
          </defs>
          <path className="pipe-trace" data-route />
          <g mask={`url(#sheet-tun-${e.key.replace(/[^\w-]/g, "_")})`}>
            <path className="pipe-lane" data-route />
            <path className="pipe-wire" data-route />
            <path className="pipe-pulse" data-route />
          </g>
          <path className="pipe-terminal" />
          <circle className="pipe-end" r={4} />
          <circle
            className={"pipe-end" + (e.kind === "map" ? " port-grab" : "")}
            r={e.kind === "map" ? 6 : 4}
            onPointerDown={(ev) => beginRebind(ev, e)}
          >
            {e.kind === "map" && <title>Drag to move this connection to another map</title>}
          </circle>
        </g>
      ))}
      <rect ref={highlightRef} className="rebind-highlight" rx={14} style={{ display: "none" }} />
    </svg>
  );
});

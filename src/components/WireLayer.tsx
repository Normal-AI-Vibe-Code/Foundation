import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workbook } from "../engine/workbook";
import { bindMap, getState, gridSize, objectWorldRect, useAppState } from "../state/store";

/**
 * Animated data-flow wires drawn in world space:
 *  - table → map for every map binding (blue)
 *  - table → table for every cross-table formula dependency (green)
 * Endpoints are recomputed imperatively each frame so wires track cards
 * mid-spring (drag, reflow, section scroll) with zero React re-renders.
 */

interface Edge {
  key: string;
  from: string; // object id (data source)
  to: string; // object id (consumer)
  kind: "map" | "ref";
}

export function WireLayer() {
  const state = useAppState();
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
  }, [state.maps, state.tables, formulaEdges]);

  // ----- imperative per-frame geometry -----
  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const objOf = (id: string) =>
      state.tables[id] ?? state.maps[id] ?? state.notes[id] ?? state.media[id];

    const tick = () => {
      if (disposed) return;
      // single chain: whichever of rAF/timeout fires first cancels the other
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      const now = performance.now();
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
        // while this wire's consumer end is being dragged, follow the cursor
        const activeRebind = rebind.current?.edgeKey === edge.key ? rebind.current : null;
        // pick facing edges
        const acx = ra.x + ra.w / 2;
        const bcx = activeRebind ? activeRebind.x : rb.x + rb.w / 2;
        const acy = ra.y + ra.h / 2;
        const bcy = activeRebind ? activeRebind.y : rb.y + rb.h / 2;
        const horizontal = Math.abs(bcx - acx) > Math.abs(bcy - acy);
        let x1: number, y1: number, x2: number, y2: number, d: string;
        if (horizontal) {
          const leftToRight = acx < bcx;
          x1 = leftToRight ? ra.x + ra.w : ra.x;
          y1 = acy;
          x2 = activeRebind ? activeRebind.x : leftToRight ? rb.x : rb.x + rb.w;
          y2 = bcy;
          const k = Math.max(50, Math.abs(x2 - x1) * 0.45) * (leftToRight ? 1 : -1);
          d = `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
        } else {
          const topToBottom = acy < bcy;
          x1 = acx;
          y1 = topToBottom ? ra.y + ra.h : ra.y;
          x2 = bcx;
          y2 = activeRebind ? activeRebind.y : topToBottom ? rb.y : rb.y + rb.h;
          const k = Math.max(50, Math.abs(y2 - y1) * 0.45) * (topToBottom ? 1 : -1);
          d = `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
        }
        g.classList.toggle("rebinding", !!activeRebind);
        const path = g.querySelector("path.wire") as SVGPathElement;
        const glow = g.querySelector("path.wire-glow") as SVGPathElement;
        path?.setAttribute("d", d);
        glow?.setAttribute("d", d);
        const dotA = g.querySelector("circle.port-a") as SVGCircleElement;
        const dotB = g.querySelector("circle.port-b") as SVGCircleElement;
        dotA?.setAttribute("cx", String(x1));
        dotA?.setAttribute("cy", String(y1));
        dotB?.setAttribute("cx", String(x2));
        dotB?.setAttribute("cy", String(y2));
        // recalc pulse: source table just changed
        const hot = (hotUntil.current.get(edge.from) ?? 0) > now;
        g.classList.toggle("hot", hot);
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
    };
  }, [edges, state.tables, state.maps, state.notes, state.media]);

  const size = gridSize(state.grid);
  if (edges.length === 0) return null;

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
          className={`wire-group ${e.kind}`}
          ref={(el) => {
            if (el) groupRefs.current.set(e.key, el);
            else groupRefs.current.delete(e.key);
          }}
        >
          <path className="wire-glow" />
          <path className="wire" />
          <circle className="port-a" r={5} />
          <circle
            className={"port-b" + (e.kind === "map" ? " port-grab" : "")}
            r={e.kind === "map" ? 7 : 5}
            onPointerDown={(ev) => beginRebind(ev, e)}
          >
            {e.kind === "map" && <title>Drag to move this connection to another map</title>}
          </circle>
        </g>
      ))}
      <rect ref={highlightRef} className="rebind-highlight" rx={14} style={{ display: "none" }} />
    </svg>
  );
}

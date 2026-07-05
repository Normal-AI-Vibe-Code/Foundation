import { useEffect, useMemo, useRef, useState } from "react";
import { workbook } from "../engine/workbook";
import { gridSize, objectWorldRect, useAppState } from "../state/store";

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
        // pick facing edges
        const acx = ra.x + ra.w / 2;
        const bcx = rb.x + rb.w / 2;
        const acy = ra.y + ra.h / 2;
        const bcy = rb.y + rb.h / 2;
        const horizontal = Math.abs(bcx - acx) > Math.abs(bcy - acy);
        let x1: number, y1: number, x2: number, y2: number, d: string;
        if (horizontal) {
          const leftToRight = acx < bcx;
          x1 = leftToRight ? ra.x + ra.w : ra.x;
          y1 = acy;
          x2 = leftToRight ? rb.x : rb.x + rb.w;
          y2 = bcy;
          const k = Math.max(50, Math.abs(x2 - x1) * 0.45) * (leftToRight ? 1 : -1);
          d = `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
        } else {
          const topToBottom = acy < bcy;
          x1 = acx;
          y1 = topToBottom ? ra.y + ra.h : ra.y;
          x2 = bcx;
          y2 = topToBottom ? rb.y : rb.y + rb.h;
          const k = Math.max(50, Math.abs(y2 - y1) * 0.45) * (topToBottom ? 1 : -1);
          d = `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
        }
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
          <circle className="port-b" r={5} />
        </g>
      ))}
    </svg>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workbook } from "../engine/workbook";
import { bindMap, getState, gridSize, objectWorldRect, useAppState } from "../state/store";

/**
 * Animated data-flow wires drawn in world space, in two layers:
 *  - an UNDER layer (below the section cards) with the wire paths,
 *    dimmed until you hover either connected card
 *  - an OVER layer with the interactive ports: every table exposes a
 *    source port (drag it onto a map to connect); a map wire's consumer
 *    port can be dragged to another map (move) or into the void (disconnect)
 */

interface Edge {
  key: string;
  from: string; // object id (data source)
  to: string; // object id (consumer)
  kind: "map" | "ref";
}

interface DragState {
  mode: "rebind" | "create";
  edgeKey?: string; // rebind: which edge follows the cursor
  tableId: string;
  oldMapId?: string;
  x: number;
  y: number;
  hoverMapId: string | null;
}

export function WireLayer() {
  const state = useAppState();
  const [formulaEdges, setFormulaEdges] = useState(() => workbook.tableDependencies());
  const groupRefs = useRef(new Map<string, SVGGElement>());
  const portRefs = useRef(new Map<string, SVGGElement>());
  const srcPortRefs = useRef(new Map<string, SVGCircleElement>());
  const hotUntil = useRef(new Map<string, number>());
  const svgRef = useRef<SVGSVGElement>(null);
  const overRef = useRef<SVGSVGElement>(null);
  const highlightRef = useRef<SVGRectElement>(null);
  const tempWireRef = useRef<SVGPathElement>(null);
  const drag = useRef<DragState | null>(null);

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

  const tables = Object.values(state.tables);

  const worldPoint = useCallback((clientX: number, clientY: number) => {
    const svg = overRef.current ?? svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const size = gridSize(getState().grid);
    const scale = size.w > 0 ? r.width / size.w : 1;
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  }, []);

  const startDrag = useCallback(
    (e: React.PointerEvent, init: Omit<DragState, "x" | "y" | "hoverMapId">) => {
      e.stopPropagation();
      e.preventDefault();
      const pt = worldPoint(e.clientX, e.clientY);
      if (!pt) return;
      drag.current = { ...init, x: pt.x, y: pt.y, hoverMapId: null };
      document.body.classList.add("rewiring");
      const move = (ev: PointerEvent) => {
        const p = worldPoint(ev.clientX, ev.clientY);
        const d = drag.current;
        if (!p || !d) return;
        d.x = p.x;
        d.y = p.y;
        d.hoverMapId = null;
        for (const m of Object.values(getState().maps)) {
          const rect = objectWorldRect(m);
          if (rect && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
            d.hoverMapId = m.id;
            break;
          }
        }
      };
      const up = () => {
        const d = drag.current;
        drag.current = null;
        document.body.classList.remove("rewiring");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (highlightRef.current) highlightRef.current.style.display = "none";
        if (tempWireRef.current) tempWireRef.current.style.display = "none";
        if (!d) return;
        if (d.mode === "rebind") {
          if (d.hoverMapId && d.hoverMapId !== d.oldMapId) {
            bindMap(d.hoverMapId, d.tableId);
            bindMap(d.oldMapId!, null);
          } else if (!d.hoverMapId) {
            bindMap(d.oldMapId!, null); // dropped into the void — disconnect
          }
        } else if (d.mode === "create" && d.hoverMapId) {
          bindMap(d.hoverMapId, d.tableId);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [worldPoint],
  );

  // ----- imperative per-frame geometry -----
  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const objOf = (id: string) =>
      state.tables[id] ?? state.maps[id] ?? state.notes[id] ?? state.media[id];

    const tick = () => {
      if (disposed) return;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      const now = performance.now();

      // hover detection lights the touched card's wires
      const hoveredId =
        (document.querySelector(".table-card:hover") as HTMLElement | null)?.dataset.objId ??
        (document.querySelector(".map-card:hover") as HTMLElement | null)?.dataset.objId ??
        null;

      for (const edge of edges) {
        const g = groupRefs.current.get(edge.key);
        const pg = portRefs.current.get(edge.key);
        if (!g) continue;
        const a = objOf(edge.from);
        const b = objOf(edge.to);
        const ra = a && objectWorldRect(a);
        const rb = b && objectWorldRect(b);
        if (!ra || !rb) {
          g.style.display = "none";
          if (pg) pg.style.display = "none";
          continue;
        }
        g.style.display = "";
        if (pg) pg.style.display = "";
        const activeDrag = drag.current?.mode === "rebind" && drag.current.edgeKey === edge.key ? drag.current : null;
        const acx = ra.x + ra.w / 2;
        const bcx = activeDrag ? activeDrag.x : rb.x + rb.w / 2;
        const acy = ra.y + ra.h / 2;
        const bcy = activeDrag ? activeDrag.y : rb.y + rb.h / 2;
        const horizontal = Math.abs(bcx - acx) > Math.abs(bcy - acy);
        let x1: number, y1: number, x2: number, y2: number, d: string;
        if (horizontal) {
          const ltr = acx < bcx;
          x1 = ltr ? ra.x + ra.w : ra.x;
          y1 = acy;
          x2 = activeDrag ? activeDrag.x : ltr ? rb.x : rb.x + rb.w;
          y2 = bcy;
          const k = Math.max(50, Math.abs(x2 - x1) * 0.45) * (ltr ? 1 : -1);
          d = `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
        } else {
          const ttb = acy < bcy;
          x1 = acx;
          y1 = ttb ? ra.y + ra.h : ra.y;
          x2 = bcx;
          y2 = activeDrag ? activeDrag.y : ttb ? rb.y : rb.y + rb.h;
          const k = Math.max(50, Math.abs(y2 - y1) * 0.45) * (ttb ? 1 : -1);
          d = `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
        }
        (g.querySelector("path.wire") as SVGPathElement)?.setAttribute("d", d);
        (g.querySelector("path.wire-glow") as SVGPathElement)?.setAttribute("d", d);
        if (pg) {
          const dotA = pg.querySelector("circle.port-a") as SVGCircleElement;
          const dotB = pg.querySelector("circle.port-b") as SVGCircleElement;
          dotA?.setAttribute("cx", String(x1));
          dotA?.setAttribute("cy", String(y1));
          dotB?.setAttribute("cx", String(x2));
          dotB?.setAttribute("cy", String(y2));
        }
        const hot = (hotUntil.current.get(edge.from) ?? 0) > now;
        const lit =
          hot || !!activeDrag || edge.from === hoveredId || edge.to === hoveredId;
        g.classList.toggle("hot", hot);
        g.classList.toggle("lit", lit);
        pg?.classList.toggle("lit", lit);
      }

      // table source ports ride each table's right edge
      for (const t of tables) {
        const c = srcPortRefs.current.get(t.id);
        if (!c) continue;
        const r = objectWorldRect(t);
        if (!r) {
          c.style.display = "none";
          continue;
        }
        c.style.display = "";
        c.setAttribute("cx", String(r.x + r.w));
        c.setAttribute("cy", String(r.y + r.h / 2));
        c.classList.toggle("lit", t.id === hoveredId || drag.current?.tableId === t.id);
      }

      // temp wire while creating a fresh connection from a table port
      const tw = tempWireRef.current;
      if (tw) {
        const d = drag.current;
        if (d?.mode === "create") {
          const src = getState().tables[d.tableId];
          const r = src && objectWorldRect(src);
          if (r) {
            const x1 = r.x + r.w;
            const y1 = r.y + r.h / 2;
            const k = Math.max(50, Math.abs(d.x - x1) * 0.45);
            tw.style.display = "";
            tw.setAttribute("d", `M ${x1} ${y1} C ${x1 + k} ${y1}, ${d.x - k} ${d.y}, ${d.x} ${d.y}`);
          }
        } else {
          tw.style.display = "none";
        }
      }

      // drop-target highlight
      const hl = highlightRef.current;
      if (hl) {
        const d = drag.current;
        const hoverMap = d?.hoverMapId ? getState().maps[d.hoverMapId] : null;
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
      timer = setTimeout(tick, 80);
    };
    tick();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [edges, tables, state.tables, state.maps, state.notes, state.media]);

  const size = gridSize(state.grid);

  return (
    <>
      {/* wire paths — beneath the section cards */}
      <svg
        ref={svgRef}
        className="wire-layer wires-under"
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
          </g>
        ))}
      </svg>

      {/* interactive ports — above the section cards */}
      <svg
        ref={overRef}
        className="wire-layer wires-over"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        style={{ overflow: "visible" }}
      >
        <path ref={tempWireRef} className="temp-wire" style={{ display: "none" }} />
        {edges.map((e) => (
          <g
            key={e.key}
            className={`wire-ports ${e.kind}`}
            ref={(el) => {
              if (el) portRefs.current.set(e.key, el);
              else portRefs.current.delete(e.key);
            }}
          >
            <circle className="port-a" r={4.5} />
            <circle
              className={"port-b" + (e.kind === "map" ? " port-grab" : "")}
              r={e.kind === "map" ? 7 : 4.5}
              onPointerDown={(ev) =>
                e.kind === "map" &&
                startDrag(ev, { mode: "rebind", edgeKey: e.key, tableId: e.from, oldMapId: e.to })
              }
            >
              {e.kind === "map" && (
                <title>Drag to another map to move the connection, or into the void to disconnect</title>
              )}
            </circle>
          </g>
        ))}
        {tables.map((t) => (
          <circle
            key={t.id}
            className="src-port"
            r={6.5}
            ref={(el) => {
              if (el) srcPortRefs.current.set(t.id, el);
              else srcPortRefs.current.delete(t.id);
            }}
            onPointerDown={(ev) => startDrag(ev, { mode: "create", tableId: t.id })}
          >
            <title>Drag onto a map to feed it this table's data</title>
          </circle>
        ))}
        <rect ref={highlightRef} className="rebind-highlight" rx={14} style={{ display: "none" }} />
      </svg>
    </>
  );
}

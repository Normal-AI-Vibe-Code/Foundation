import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ShaderBackground } from "../gl/background";
import { Spring, Spring2D, presets } from "../physics/spring";
import {
  SnapTarget,
  allObjects,
  canMergeSections,
  clearSectionSelection,
  createSectionAt,
  emptyCells,
  focusUp,
  getObject,
  getState,
  gridCellRect,
  gridSize,
  mergeSelectedSections,
  neighborSection,
  objectWorldRect,
  requestSnap,
  resizeCol,
  resizeRow,
  sectionCardRect,
  sectionCellRect,
  setActiveSection,
  setFocusGrid,
  trackOffsets,
  useAppState,
} from "../state/store";
import { dragHasFiles, ingestMediaFiles } from "../state/media";
import { SectionView } from "./SectionView";
import { WireLayer } from "./WireLayer";
import { openContextMenu } from "./ContextMenu";
import { sfx } from "../sound/sfx";

function colName(col: number): string {
  let s = "";
  let n = col;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const MIN_SCALE = 0.12;
const MAX_SCALE = 1.6;
const FIT_MARGIN = 0.92;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Candidate {
  rect: Rect;
  cap: number; // max scale for this framing
  penalty: number;
  target: SnapTarget;
}

export function GridViewport() {
  const state = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<ShaderBackground | null>(null);

  // ----- camera springs -----
  const camera = useMemo(() => new Spring2D(0, 0, presets.camera), []);
  const zoom = useMemo(() => new Spring(0.5, presets.camera), []);

  const applyCamera = useCallback(() => {
    const el = worldRef.current;
    if (el) {
      el.style.transform = `translate3d(${camera.x.value}px, ${camera.y.value}px, 0) scale(${zoom.value})`;
    }
    const bg = bgRef.current;
    if (bg) {
      bg.uniforms.offsetX = camera.x.value;
      bg.uniforms.offsetY = camera.y.value;
      bg.uniforms.scale = zoom.value;
    }
  }, [camera, zoom]);

  useEffect(() => {
    const unsubs = [camera.onChange(applyCamera), zoom.onChange(applyCamera)];
    applyCamera();
    return () => unsubs.forEach((u) => u());
  }, [camera, zoom, applyCamera]);

  // ----- shader background -----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const bg = new ShaderBackground(container);
    bgRef.current = bg;
    const doResize = () => {
      const r = container.getBoundingClientRect();
      if (r.width > 0) bg.resize(r.width, r.height);
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    doResize();
    return () => {
      ro.disconnect();
      bg.dispose();
      bgRef.current = null;
    };
  }, []);

  // ----- snap framing -----

  const viewportRect = useCallback((): { w: number; h: number } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const r = container.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return null;
    return { w: r.width, h: r.height };
  }, []);

  const frameOf = useCallback(
    (rect: Rect, cap: number) => {
      const vp = viewportRect();
      if (!vp) return null;
      const s = Math.max(
        MIN_SCALE,
        Math.min(cap, (vp.w * FIT_MARGIN) / rect.w, (vp.h * FIT_MARGIN) / rect.h),
      );
      return {
        scale: s,
        x: vp.w / 2 - (rect.x + rect.w / 2) * s,
        y: vp.h / 2 - (rect.y + rect.h / 2) * s,
      };
    },
    [viewportRect],
  );

  /** every framing the viewport is allowed to rest on */
  const candidates = useCallback((): Candidate[] => {
    const st = getState();
    const out: Candidate[] = [];
    const size = gridSize(st.grid);
    out.push({
      rect: { x: 0, y: 0, w: size.w, h: size.h },
      cap: 1,
      penalty: 0.12,
      target: { kind: "all" },
    });
    const sections = Object.values(st.sections);
    // track bands (rows / cols of sections) — "groups of sections"
    const xo = trackOffsets(st.grid.cols);
    const yo = trackOffsets(st.grid.rows);
    if (st.grid.rows.length > 1) {
      for (let r = 0; r < st.grid.rows.length; r++) {
        out.push({
          rect: { x: 0, y: yo[r], w: size.w, h: st.grid.rows[r] },
          cap: 1,
          penalty: 0.08,
          target: { kind: "all" },
        });
      }
    }
    if (st.grid.cols.length > 1) {
      for (let c = 0; c < st.grid.cols.length; c++) {
        out.push({
          rect: { x: xo[c], y: 0, w: st.grid.cols[c], h: size.h },
          cap: 1,
          penalty: 0.08,
          target: { kind: "all" },
        });
      }
    }
    for (const s of sections) {
      out.push({
        rect: sectionCardRect(st.grid, s),
        cap: 1.05,
        penalty: 0,
        target: { kind: "section", id: s.id },
      });
    }
    for (const obj of allObjects()) {
      const rect = objectWorldRect(obj);
      if (rect) {
        out.push({
          rect,
          cap: "sourceTableId" in obj ? 1 : 1.05, // maps interact best at exactly 1
          penalty: 0.05,
          target: { kind: "object", id: obj.id },
        });
      }
    }
    return out;
  }, []);

  /** spring the camera to the framing nearest the (projected) camera state */
  const snapToNearest = useCallback(
    (fromX?: number, fromY?: number, fromS?: number) => {
      const vp = viewportRect();
      if (!vp) return;
      const cx = fromX ?? camera.x.goal;
      const cy = fromY ?? camera.y.goal;
      const cs = fromS ?? zoom.goal;
      let best: { score: number; frame: { x: number; y: number; scale: number } } | null = null;
      for (const cand of candidates()) {
        const frame = frameOf(cand.rect, cand.cap);
        if (!frame) continue;
        const dist =
          Math.hypot(frame.x - cx, frame.y - cy) / Math.hypot(vp.w, vp.h);
        const score =
          Math.abs(Math.log(frame.scale / cs)) * 1.3 + dist + cand.penalty;
        if (!best || score < best.score) best = { score, frame };
      }
      if (best) {
        zoom.to(best.frame.scale);
        camera.to(best.frame.x, best.frame.y);
      }
    },
    [camera, zoom, candidates, frameOf, viewportRect],
  );

  const snapTo = useCallback(
    (target: SnapTarget) => {
      const st = getState();
      let rect: Rect | null = null;
      let cap = 1;
      if (target.kind === "all") {
        const size = gridSize(st.grid);
        rect = { x: 0, y: 0, w: size.w, h: size.h };
      } else if (target.kind === "section") {
        const s = st.sections[target.id];
        if (s) rect = sectionCardRect(st.grid, s);
        cap = 1.05;
      } else {
        const obj =
          st.tables[target.id] ?? st.maps[target.id] ?? st.notes[target.id] ?? st.media[target.id];
        if (obj) {
          rect = objectWorldRect(obj);
          cap = "sourceTableId" in obj ? 1 : 1.05;
        }
      }
      if (!rect) return false;
      const frame = frameOf(rect, cap);
      if (!frame) return false;
      // audible only when the camera meaningfully travels
      if (
        Math.hypot(frame.x - camera.x.goal, frame.y - camera.y.goal) > 40 ||
        Math.abs(Math.log(frame.scale / zoom.goal)) > 0.08
      ) {
        sfx.whoosh();
      }
      zoom.to(frame.scale);
      camera.to(frame.x, frame.y);
      return true;
    },
    [camera, zoom, frameOf],
  );

  // snap requests from the store (new table/map/section, shield engage, …)
  useEffect(() => {
    const req = state.snapRequest;
    if (!req) return;
    if (snapTo(req)) return;
    // layout not ready yet — retry briefly
    const timer = setInterval(() => {
      if (snapTo(req)) clearInterval(timer);
    }, 120);
    const giveUp = setTimeout(() => clearInterval(timer), 3000);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.snapRequest]);

  // ----- leveled keyboard navigation -----
  // grid level: arrows page the viewport by its own size
  // section level: arrows walk to the spatially adjacent section
  // object level: the primitive owns its keys (table cell navigation etc.)
  // Escape: step up one level
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // a primitive already handled it
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable)
        return;
      if (e.key === "Escape") {
        el?.blur(); // release e.g. a table sheet so section arrows take over
        focusUp();
        return;
      }
      if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const sel = getState().selectedSectionIds;
        if (sel.length >= 2) {
          e.preventDefault();
          mergeSelectedSections();
          return;
        }
      }
      const dir = (
        {
          ArrowLeft: "left",
          ArrowRight: "right",
          ArrowUp: "up",
          ArrowDown: "down",
        } as const
      )[e.key];
      if (!dir) return;
      const st = getState();
      if (st.focusLevel === "grid") {
        e.preventDefault();
        const vp = viewportRect();
        if (!vp) return;
        const dx = dir === "left" ? vp.w : dir === "right" ? -vp.w : 0;
        const dy = dir === "up" ? vp.h : dir === "down" ? -vp.h : 0;
        camera.to(camera.x.goal + dx * 0.9, camera.y.goal + dy * 0.9);
        armWheelSnap(); // settle onto the nearest framing
      } else if (st.focusLevel === "section") {
        e.preventDefault();
        const n = neighborSection(st.activeSectionId, dir);
        if (n) {
          setActiveSection(n.id);
          requestSnap({ kind: "section", id: n.id });
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, viewportRect]);

  // ----- pan / zoom gestures (always resolving to a snap) -----

  const panDrag = useRef({ active: false, lastX: 0, lastY: 0, vx: 0, vy: 0, lastT: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".section-card, button, input, select, .viewport-toolbar, .gutter")) return;
    if (e.button !== 0 && e.button !== 1) return;
    setFocusGrid(); // clicking the void addresses the grid level
    clearSectionSelection();
    const d = panDrag.current;
    d.active = true;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.vx = 0;
    d.vy = 0;
    d.lastT = performance.now();
    containerRef.current?.classList.add("panning");
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch { /* synthetic */ }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const bg = bgRef.current;
      const container = containerRef.current;
      if (bg && container) {
        const r = container.getBoundingClientRect();
        bg.uniforms.pointerX = e.clientX - r.left;
        bg.uniforms.pointerY = e.clientY - r.top;
        bg.pointerTarget = 1;
      }
      const d = panDrag.current;
      if (!d.active) return;
      const now = performance.now();
      const dt = Math.max(now - d.lastT, 1);
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.vx = 0.8 * d.vx + 0.2 * ((dx / dt) * 1000);
      d.vy = 0.8 * d.vy + 0.2 * ((dy / dt) * 1000);
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      d.lastT = now;
      camera.set(camera.x.value + dx, camera.y.value + dy);
    },
    [camera],
  );

  const onPointerUp = useCallback(() => {
    const d = panDrag.current;
    if (!d.active) return;
    d.active = false;
    containerRef.current?.classList.remove("panning");
    // project the throw's landing point, then snap from there —
    // the release velocity carries into the snap spring
    const projX = camera.x.value + d.vx / 20;
    const projY = camera.y.value + d.vy / 20;
    snapToNearest(projX, projY, zoom.value);
    camera.x.nudgeVelocity(d.vx * 0.35);
    camera.y.nudgeVelocity(d.vy * 0.35);
  }, [camera, zoom, snapToNearest]);

  const onPointerLeave = useCallback(() => {
    if (bgRef.current) bgRef.current.pointerTarget = 0;
  }, []);

  const wheelIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armWheelSnap = useCallback(() => {
    if (wheelIdle.current) clearTimeout(wheelIdle.current);
    wheelIdle.current = setTimeout(() => snapToNearest(), 260);
  }, [snapToNearest]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if ((e.target as HTMLElement).closest(".map-body")) return;
      const r = container.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        const oldS = zoom.goal;
        const factor = Math.exp(-e.deltaY * 0.0022);
        const newS = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldS * factor));
        const ratio = newS / oldS;
        zoom.to(newS);
        camera.to(cx - (cx - camera.x.goal) * ratio, cy - (cy - camera.y.goal) * ratio);
        armWheelSnap();
      } else if (!(e.target as HTMLElement).closest(".section-card")) {
        // wheel over the void pans the grid; sections own their scroll
        camera.to(camera.x.goal - e.deltaX, camera.y.goal - e.deltaY);
        armWheelSnap();
      }
    },
    [camera, zoom, armWheelSnap],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".map-body")) return;
      e.preventDefault();
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  const getScale = useCallback(() => zoom.value, [zoom]);

  const zoomAroundCenter = useCallback(
    (factor: number) => {
      const vp = viewportRect();
      if (!vp) return;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const oldS = zoom.goal;
      const newS = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldS * factor));
      const ratio = newS / oldS;
      zoom.to(newS);
      camera.to(cx - (cx - camera.x.goal) * ratio, cy - (cy - camera.y.goal) * ratio);
    },
    [camera, zoom, viewportRect],
  );

  // ----- track resize gutters -----
  const gutterDrag = useRef({
    active: false,
    axis: "col" as "col" | "row",
    index: 0,
    start: 0,
    orig: 0,
  });

  const onGutterDown = useCallback(
    (e: React.PointerEvent, axis: "col" | "row", index: number) => {
      e.stopPropagation();
      const st = getState();
      const d = gutterDrag.current;
      d.active = true;
      d.axis = axis;
      d.index = index;
      d.start = axis === "col" ? e.clientX : e.clientY;
      d.orig = axis === "col" ? st.grid.cols[index] : st.grid.rows[index];
      document.body.classList.add(axis === "col" ? "resizing-h" : "resizing-v");
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* synthetic */ }
    },
    [],
  );

  const onGutterMove = useCallback(
    (e: React.PointerEvent) => {
      const d = gutterDrag.current;
      if (!d.active) return;
      const s = zoom.value;
      const delta = ((d.axis === "col" ? e.clientX : e.clientY) - d.start) / s;
      if (d.axis === "col") resizeCol(d.index, d.orig + delta);
      else resizeRow(d.index, d.orig + delta);
    },
    [zoom],
  );

  const onGutterUp = useCallback(() => {
    if (!gutterDrag.current.active) return;
    gutterDrag.current.active = false;
    document.body.classList.remove("resizing-h", "resizing-v");
  }, []);

  // the resize knob rides along the boundary, following the cursor on hover
  const knobRefs = useRef(new Map<string, HTMLDivElement>());
  const onGutterHover = useCallback(
    (e: React.PointerEvent, axis: "col" | "row", index: number) => {
      if (gutterDrag.current.active) return;
      const knob = knobRefs.current.get(axis + index);
      const world = worldRef.current;
      if (!knob || !world) return;
      const wr = world.getBoundingClientRect();
      const s = zoom.value;
      if (axis === "col") {
        knob.style.top = `${(e.clientY - wr.top) / s - 22}px`;
      } else {
        knob.style.left = `${(e.clientX - wr.left) / s - 22}px`;
      }
    },
    [zoom],
  );

  // ----- render -----
  const size = gridSize(state.grid);
  const xo = trackOffsets(state.grid.cols);
  const yo = trackOffsets(state.grid.rows);
  const sections = Object.values(state.sections);
  const spring = { type: "spring", stiffness: 480, damping: 24 } as const;

  const activeSec = state.sections[state.activeSectionId];
  const activeObj = state.activeObjectId ? getObject(state.activeObjectId) : null;
  const [soundOn, setSoundOn] = useState(!sfx.isMuted());
  // empty cell currently hovered by a desktop file drag
  const [dropCell, setDropCell] = useState<{ c: number; r: number } | null>(null);

  return (
    <div
      ref={containerRef}
      className={`grid-viewport ctx-${state.focusLevel}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onWheel={onWheel}
    >
      <div ref={worldRef} className="world">
        {/* ----- grid chrome: track lines + spreadsheet labels ----- */}
        <div className="grid-frame" style={{ width: size.w, height: size.h }} />
        {xo.slice(1, -1).map((x, i) => (
          <div key={`lc${i}`} className="grid-line-v" style={{ left: x, height: size.h }} />
        ))}
        {yo.slice(1, -1).map((y, i) => (
          <div key={`lr${i}`} className="grid-line-h" style={{ top: y, width: size.w }} />
        ))}
        {state.grid.cols.map((w, i) => (
          <div key={`hc${i}`} className="track-label track-label-col" style={{ left: xo[i], width: w }}>
            {colName(i)}
          </div>
        ))}
        {state.grid.rows.map((h, i) => (
          <div key={`hr${i}`} className="track-label track-label-row" style={{ top: yo[i], height: h }}>
            {i + 1}
          </div>
        ))}

        {/* empty grid cells — dashed targets you can fill or drop onto */}
        {emptyCells().map(({ c, r }) => {
          const rect = gridCellRect(state.grid, c, r);
          return (
            <div
              key={`empty${c},${r}`}
              className={
                "empty-cell" +
                (dropCell?.c === c && dropCell?.r === r ? " dropping" : "")
              }
              style={{
                left: rect.x + 12,
                top: rect.y + 12,
                width: rect.w - 24,
                height: rect.h - 24,
              }}
              onDragOver={(e) => {
                if (!dragHasFiles(e)) return;
                e.preventDefault();
                if (dropCell?.c !== c || dropCell?.r !== r) setDropCell({ c, r });
              }}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
                  setDropCell(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDropCell(null);
                const files = e.dataTransfer.files;
                const fresh = createSectionAt(c, r);
                if (fresh) void ingestMediaFiles(fresh.id, files);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openContextMenu(e.clientX, e.clientY, [
                  {
                    icon: "+",
                    label: `Create section at ${colName(c)}${r + 1}`,
                    action: () => createSectionAt(c, r),
                  },
                ]);
              }}
            >
              <span className="empty-cell-label">
                {colName(c)}
                {r + 1}
              </span>
              <motion.button
                className="empty-cell-add"
                whileHover={{ scale: 1.12 }}
                whileTap={{ scale: 0.85 }}
                transition={{ type: "spring", stiffness: 480, damping: 24 }}
                title="Create a section here"
                onClick={() => createSectionAt(c, r)}
              >
                + Section
              </motion.button>
            </div>
          );
        })}

        {/* highlight while a section is dragged toward a cell */}
        {state.sectionDragTarget &&
          (() => {
            const { c, r } = state.sectionDragTarget;
            const rect = gridCellRect(state.grid, c, r);
            return (
              <div
                className="cell-drop-highlight"
                style={{ left: rect.x + 6, top: rect.y + 6, width: rect.w - 12, height: rect.h - 12 }}
              />
            );
          })()}

        {sections.map((s) => (
          <SectionView
            key={s.id}
            section={s}
            grid={state.grid}
            active={state.activeSectionId === s.id}
            canRemove={sections.length > 1}
            getScale={getScale}
            zoomSpring={zoom}
          />
        ))}

        {/* merge pill — floats over the multi-selection's bounding box */}
        <AnimatePresence>
          {(() => {
            const sel = state.selectedSectionIds
              .map((id) => state.sections[id])
              .filter(Boolean);
            if (sel.length < 2) return null;
            const rects = sel.map((s) => sectionCellRect(state.grid, s));
            const x0 = Math.min(...rects.map((r) => r.x));
            const x1 = Math.max(...rects.map((r) => r.x + r.w));
            const y0 = Math.min(...rects.map((r) => r.y));
            const ok = canMergeSections(state.selectedSectionIds);
            return (
              <motion.button
                key="merge-pill"
                className={"merge-pill" + (ok ? "" : " blocked")}
                style={{ left: (x0 + x1) / 2, top: y0 }}
                initial={{ opacity: 0, scale: 0.7, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.85, y: 6 }}
                whileHover={ok ? { scale: 1.06 } : undefined}
                whileTap={ok ? { scale: 0.92 } : undefined}
                transition={{ type: "spring", stiffness: 480, damping: 26 }}
                title={
                  ok
                    ? "Merge the selected sections into one (M)"
                    : "Selection must form a solid rectangle to merge"
                }
                onClick={() => ok && mergeSelectedSections()}
              >
                ⧉ Merge {sel.length} sections
              </motion.button>
            );
          })()}
        </AnimatePresence>

        {/* track resize gutters — hover reveals a grab knob on the boundary */}
        {state.grid.cols.slice(0, -1).map((_, i) => (
          <div
            key={`gc${i}`}
            className="gutter gutter-col"
            style={{ left: xo[i + 1] - 7, top: 0, height: size.h }}
            onPointerMove={(e) => onGutterHover(e, "col", i)}
          >
            <div className="gutter-line" />
            <div
              className="gutter-knob"
              ref={(el) => {
                if (el) knobRefs.current.set("col" + i, el);
                else knobRefs.current.delete("col" + i);
              }}
              title="Drag to resize column"
              onPointerDown={(e) => onGutterDown(e, "col", i)}
              onPointerMove={onGutterMove}
              onPointerUp={onGutterUp}
              onPointerCancel={onGutterUp}
            />
          </div>
        ))}
        {state.grid.rows.slice(0, -1).map((_, i) => (
          <div
            key={`gr${i}`}
            className="gutter gutter-row"
            style={{ top: yo[i + 1] - 7, left: 0, width: size.w }}
            onPointerMove={(e) => onGutterHover(e, "row", i)}
          >
            <div className="gutter-line" />
            <div
              className="gutter-knob"
              ref={(el) => {
                if (el) knobRefs.current.set("row" + i, el);
                else knobRefs.current.delete("row" + i);
              }}
              title="Drag to resize row"
              onPointerDown={(e) => onGutterDown(e, "row", i)}
              onPointerMove={onGutterMove}
              onPointerUp={onGutterUp}
              onPointerCancel={onGutterUp}
            />
          </div>
        ))}

        {/* data-flow wires above everything */}
        <WireLayer />
      </div>

      {/* grid-context corner brackets */}
      <div className="ctx-corners">
        <span className="ctx-corner tl" />
        <span className="ctx-corner tr" />
        <span className="ctx-corner bl" />
        <span className="ctx-corner br" />
      </div>

      {/* viewport toolbar */}
      <motion.div
        className="panel-toolbar viewport-toolbar"
        initial={{ y: 70, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 210, damping: 20, delay: 0.05 }}
      >
        {/* context breadcrumb — where the keyboard is aimed */}
        <motion.button
          className="tb-btn crumb-up"
          whileHover={{ scale: 1.1, y: -2 }}
          whileTap={{ scale: 0.88, y: 1 }}
          transition={spring}
          title="Up a level (Esc)"
          onClick={() => focusUp()}
        >
          ↑
        </motion.button>
        <div className="crumbs">
          <motion.button
            className={"crumb" + (state.focusLevel === "grid" ? " on" : "")}
            whileTap={{ scale: 0.94 }}
            title="Grid level — arrow keys page the viewport"
            onClick={() => {
              setFocusGrid();
              requestSnap({ kind: "all" });
            }}
          >
            ⊞ Grid
          </motion.button>
          {activeSec && state.focusLevel !== "grid" && (
            <>
              <span className="crumb-sep">›</span>
              <motion.button
                className={"crumb" + (state.focusLevel === "section" ? " on" : "")}
                whileTap={{ scale: 0.94 }}
                title="Section level — arrow keys walk between sections"
                onClick={() => {
                  setActiveSection(activeSec.id);
                  requestSnap({ kind: "section", id: activeSec.id });
                }}
              >
                {activeSec.name}
              </motion.button>
            </>
          )}
          {activeObj && state.focusLevel === "object" && (
            <>
              <span className="crumb-sep">›</span>
              <motion.button
                className="crumb on"
                whileTap={{ scale: 0.94 }}
                title="Primitive level — keys act inside this card"
                onClick={() => requestSnap({ kind: "object", id: activeObj.id })}
              >
                {activeObj.name}
              </motion.button>
            </>
          )}
        </div>
        <div className="tb-divider" />
        <motion.button
          className="tb-btn"
          whileHover={{ scale: 1.08, y: -2 }}
          whileTap={{ scale: 0.88, y: 1 }}
          transition={spring}
          title="Zoom out"
          onClick={() => {
            zoomAroundCenter(1 / 1.3);
            armWheelSnap();
          }}
        >
          −
        </motion.button>
        <motion.button
          className="tb-btn"
          whileHover={{ scale: 1.08, y: -2 }}
          whileTap={{ scale: 0.88, y: 1 }}
          transition={spring}
          title="Zoom in"
          onClick={() => {
            zoomAroundCenter(1.3);
            armWheelSnap();
          }}
        >
          +
        </motion.button>
        <div className="tb-divider" />
        <motion.button
          className="tb-btn"
          whileHover={{ scale: 1.08, y: -2 }}
          whileTap={{ scale: 0.88, y: 1 }}
          transition={spring}
          title={soundOn ? "Mute interaction sounds" : "Unmute interaction sounds"}
          onClick={() => {
            const next = !soundOn;
            sfx.setMuted(!next);
            setSoundOn(next);
            if (next) sfx.pop();
          }}
        >
          {soundOn ? "🔊" : "🔇"}
        </motion.button>
      </motion.div>
    </div>
  );
}

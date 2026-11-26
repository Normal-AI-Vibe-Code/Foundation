import { fullscreenCard, inUse, releaseCard } from "../lib/cardUse";
import { cardWheel } from "../lib/cardScroll";
import { installScrollHint, noteAltScroll } from "../lib/scrollHint";
import { keys } from "../lib/keys";
import { wheelAction, wheelMode } from "../lib/wheel";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { ShaderBackground } from "../gl/background";
import { Spring, Spring2D, presets } from "../physics/spring";
import {
  SECTION_INSET,
  SnapTarget,
  allObjects,
  createSectionAt,
  emptyCells,
  focusUp,
  getObject,
  getState,
  gridCellRect,
  gridSize,
  neighborSection,
  objectWorldRect,
  objectsInSection,
  requestSnap,
  resizeCol,
  resizeRow,
  sectionCardRect,
  setActiveObject,
  setActiveSection,
  setFocusGrid,
  trackOffsets,
  isGridSection,
  levelUp,
} from "../state/store";
import { SectionView } from "./SectionView";
import { WireLayer } from "./WireLayer";
import { camera, FAR_ZOOM, publishCamera, publishPointer } from "../state/camera";
import { publishGoal } from "../lib/viewAhead";
import { isNight, onNight } from "@foundation/ui";
import { floorInsets, getUi, setUi, toggleSearch, toggleSession, useUi } from "../state/ui";
import { TalkButton } from "../shell/Talk";
import { SearchPop } from "../shell/SearchPane";
import { PresentGlyph, SearchGlyph, SlidersGlyph } from "../shell/glyphs";
import { CouncilGlyph } from "../characters/CouncilGlyph";
import { useOnLocalGrid } from "../panels/LocalView";
import { ComputerGlyph } from "../shell/glyphs";
import { toggleCouncil, useCouncilOpen } from "../lib/councilOpen";
import { COMMANDS_GLYPH } from "../lib/keys";
import { PeerCursors } from "../shell/Presence";
import { CrewCursors, CrewFollow, CrewGuide } from "../shell/Crew";
import { LevelBar } from "../shell/LevelBar";
import { PortWires } from "../shell/AgentLayer";
import { openContextMenu } from "./ContextMenu";
import { openSectionAgents } from "./SectionAgents";
import { countRender } from "../state/renders";
import { gridViewSlice, useStoreSlice } from "../state/slices";
import { colName, gutterRuns, gutterSegments } from "../lib/gridLines";
import { useRuneDrawing } from "../rune/engine";
import { runeHost } from "../rune/host";
import { hitWorld } from "../rune/scene";
import { RuneMark, RuneSurface } from "../rune/RuneSurface";
import { RuneIslands } from "../rune/RuneIslands";
import { toWorld } from "../state/camera";

/** a boundary's grab area runs the length of the section edge beside it: the sections sit this far in from their tracks */
const GUTTER_INSET = SECTION_INSET;
const MIN_SCALE = 0.12;
const MAX_SCALE = 1.6;
const FIT_MARGIN = 0.92;
/** chrome the framing keeps clear of: the search pill below, the side pane when it's open */
/** breathing room inside the floor's edges, and above the search pill */
const SAFE_GAP = 20;
const SAFE_BOTTOM = 68;
/** how far the floor's edge fades the cards out (DESIGN.md → The floor) */
export const FLOOR_FADE = 56;

/**
 * What "frame this section" should show: the cards it holds (plus its header)
 * when they're a small part of it, the middle of it when it's empty, the whole
 * card otherwise — so sparse sections come up close enough to read.
 */
function sectionFocusRect(grid: Parameters<typeof sectionCardRect>[0], s: Parameters<typeof sectionCardRect>[1]): Rect {
  const card = sectionCardRect(grid, s);
  // an open section is framed by its width from the top; the wheel reads on down
  if (getState().expandedSection === s.id || s.virtual) return { ...card, h: Math.min(card.h, card.w * 0.7) };
  // a section that is a grid of sections: all of it, the way its miniature shows it
  if (isGridSection(s.id)) return card;
  const objs = objectsInSection(s.id)
    .map((o) => objectWorldRect(o))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  if (objs.length === 0) {
    const w = Math.min(card.w, 1000);
    const h = Math.min(card.h, 700);
    return { x: card.x + (card.w - w) / 2, y: card.y + (card.h - h) / 2, w, h };
  }
  let x0 = card.x;
  let y0 = card.y;
  let x1 = Math.max(...objs.map((r) => r.x + r.w)) + 40;
  let y1 = Math.max(...objs.map((r) => r.y + r.h)) + 40;
  x1 = Math.min(card.x + card.w, Math.max(x1, card.x + 640));
  y1 = Math.min(card.y + card.h, Math.max(y1, card.y + 420));
  // the section's tools wait at its top-right corner: keep its full width in the frame unless it's far
  // wider than what it holds (then the cards matter more, and hover finds the tools after a pan)
  const fitsAtCap = (card.x + card.w - x0) * 1.05 <= camera.width - floorInsets().left - floorInsets().right - 2 * SAFE_GAP;
  if (fitsAtCap || card.x + card.w - x0 <= (x1 - x0) * 1.6) x1 = card.x + card.w;
  const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  // only tighten when it actually helps
  return rect.w * rect.h < card.w * card.h * 0.7 ? rect : card;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What the board's decoration may skip (2026-11-24): `data-far` while the board is drawn small, `data-moving` while
 * the camera moves and for a beat after. A flowing wire's pulse is a repaint every frame and a tunnel's cut is an
 * SVG mask, on a layer the size of the grid: WebKit (the Mac app's engine) re-renders both as the camera moves, and a
 * studio's wires held it to 2 fps zoomed out. They rest at those times (shell.css). The marks go on the wire layers
 * alone, never the viewport: a mark on the viewport restyles every card under it. Written only when one flips.
 */
const MOVING_REST_MS = 240;
let movingTimer = 0;
let marked = { far: false, moving: false };
function markLayers(el: HTMLElement, m: { far: boolean; moving: boolean }) {
  // drawn small, both already rest: moving says nothing more, so it isn't written (each write to the layer repaints
  // it, and in WebKit a repaint of a grid-sized layer outlasted the rest timer and flipped it again)
  if (m.far) m = { far: true, moving: false };
  if (m.far === marked.far && m.moving === marked.moving) return;
  marked = m;
  el.querySelectorAll<SVGElement>(".port-layer").forEach((layer) => {
    if ((layer.dataset.far === "1") !== m.far) {
      if (m.far) layer.dataset.far = "1";
      else delete layer.dataset.far;
    }
    if ((layer.dataset.moving === "1") !== m.moving) {
      if (m.moving) layer.dataset.moving = "1";
      else delete layer.dataset.moving;
    }
  });
}
function markCamera(el: HTMLElement | null, scale: number) {
  if (!el) return;
  const far = scale < FAR_ZOOM;
  markLayers(el, { far, moving: true });
  clearTimeout(movingTimer);
  if (!far) movingTimer = window.setTimeout(() => markLayers(el, { far, moving: false }), MOVING_REST_MS);
}

interface Candidate {
  rect: Rect;
  cap: number; // max scale for this framing
  penalty: number;
  target: SnapTarget;
}

export function GridViewport({ boardName }: { boardName?: string } = {}) {
  countRender("GridViewport");
  // the grid's own slice: a press, a drag frame or a keystroke in a card doesn't render the board
  const state = useStoreSlice(gridViewSlice);
  const ui = useUi();
  // the grid's council stands at the bottom right: the bar steps aside to the bottom left
  const councilBoard = useCouncilOpen()?.kind === "board";
  // the This computer grid: its council wears the computer's mark
  const onLocal = useOnLocalGrid();
  const insets = floorInsets(ui);
  // Settings → Renderer: Rune draws the sections and cards on its own canvas (rune/); the camera, its
  // gestures and keys, and the layers above stay here for both engines. The handlers read it through a ref
  const rune = useRuneDrawing();
  const runeRef = useRef(rune);
  runeRef.current = rune;
  /** what Rune drew under a pointer: where the web renderer asks the DOM, Rune's board is asked by its rects */
  const runeHit = useCallback((clientX: number, clientY: number) => {
    const r = containerRef.current?.getBoundingClientRect();
    const w = toWorld(clientX - (r?.left ?? 0), clientY - (r?.top ?? 0));
    return hitWorld(getState(), w.x, w.y);
  }, []);
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
    publishCamera(camera.x.value, camera.y.value, zoom.value, containerRef.current);
    publishGoal(camera.x.goal, camera.y.goal, zoom.goal);
    markCamera(containerRef.current, zoom.value);
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
    // the camera owns position: undo any browser scroll (focus, find-in-page, scrollIntoView)
    const unscroll = () => {
      if (container.scrollLeft || container.scrollTop) container.scrollTo(0, 0);
    };
    container.addEventListener("scroll", unscroll);
    const bg = new ShaderBackground(container);
    bgRef.current = bg;
    bg.nightTarget = bg.uniforms.night = isNight() ? 1 : 0; // start in the right light, fade only on toggle
    if (import.meta.env.DEV) (window as unknown as { __foundationBg: ShaderBackground }).__foundationBg = bg;
    const offNight = onNight((n) => (bg.nightTarget = n ? 1 : 0));
    const doResize = () => {
      const r = container.getBoundingClientRect();
      if (r.width > 0) bg.resize(r.width, r.height);
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    doResize();
    return () => {
      ro.disconnect();
      offNight();
      container.removeEventListener("scroll", unscroll);
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
      const f = floorInsets(getUi());
      const left = f.left ? f.left + FLOOR_FADE / 2 : 0;
      const top = f.top + SAFE_GAP;
      const availW = Math.max(160, vp.w - left - (f.right ? f.right + FLOOR_FADE / 2 : 0));
      // the grid's timeline, when open, is the floor's foot: framing fits above it (and the bottom bar above that)
      const availH = Math.max(120, vp.h - top - SAFE_BOTTOM - f.bottom);
      const s = Math.max(
        MIN_SCALE,
        Math.min(cap, (availW * FIT_MARGIN) / rect.w, (availH * FIT_MARGIN) / rect.h),
      );
      return {
        scale: s,
        x: left + availW / 2 - (rect.x + rect.w / 2) * s,
        y: top + availH / 2 - (rect.y + rect.h / 2) * s,
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
        rect: sectionFocusRect(st.grid, s),
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

  /** keyboard paging: spring the camera to the framing nearest where the page would land */
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
      } else {
        camera.to(cx, cy);
      }
    },
    [camera, zoom, candidates, frameOf, viewportRect],
  );

  const snapTo = useCallback(
    (target: SnapTarget) => {
      const st = getState();
      let rect: Rect | null = null;
      let cap = 1;
      if (target.kind === "view") {
        zoom.to(target.scale);
        camera.to(target.x, target.y);
        return true;
      }
      if (target.kind === "all") {
        const size = gridSize(st.grid);
        rect = { x: 0, y: 0, w: size.w, h: size.h };
      } else if (target.kind === "section") {
        const s = st.sections[target.id];
        if (s) rect = sectionFocusRect(st.grid, s);
        cap = 1.05;
      } else {
        const obj =
          st.tables[target.id] ?? st.maps[target.id] ?? st.notes[target.id] ?? st.media[target.id] ?? st.panels[target.id];
        if (obj) {
          rect = objectWorldRect(obj);
          cap = "sourceTableId" in obj ? 1 : 1.05;
        }
      }
      if (!rect) return false;
      const frame = frameOf(rect, cap);
      if (!frame) return false;
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
      // a primitive already handled it (Rune's canvas claims every key's default: those still reach the grid)
      if (e.defaultPrevented && !(runeRef.current && (e.target as HTMLElement | null)?.tagName === "CANVAS")) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable)
        return;
      if (e.key === "Escape") {
        el?.blur(); // release e.g. a table sheet so section arrows take over
        // an open section closes first (unless a card in it has the keys): up one level
        const st0 = getState();
        if (st0.level && st0.focusLevel !== "object") {
          levelUp();
          return;
        }
        focusUp();
        return;
      }
      // view keys (Figma-style): 0 / ⇧1 fit all · ⇧2 or F frame the focus · 1 = 100% · + / − zoom
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const st0 = getState();
        const frameFocus = () =>
          requestSnap(
            st0.focusLevel === "object" && st0.activeObjectId
              ? { kind: "object", id: st0.activeObjectId }
              : { kind: "section", id: st0.activeSectionId },
          );
        if (e.code === "Digit0" || (e.shiftKey && e.code === "Digit1")) {
          e.preventDefault();
          requestSnap({ kind: "all" });
          return;
        }
        if ((e.shiftKey && e.code === "Digit2") || e.key === "f" || e.key === "F") {
          e.preventDefault();
          frameFocus();
          return;
        }
        if (e.code === "Digit1" && !e.shiftKey) {
          e.preventDefault();
          zoomAroundCenter(1 / zoom.goal);
          return;
        }
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          zoomAroundCenter(1.25);
          return;
        }
        if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          zoomAroundCenter(1 / 1.25);
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
        snapToNearest(camera.x.goal + dx * 0.9, camera.y.goal + dy * 0.9, zoom.goal); // keys land on a framing
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

  // ----- pan / zoom gestures: the camera rests wherever the person leaves it -----

  const panDrag = useRef({ active: false, button: 0, pointerId: 0, moved: false, downX: 0, downY: 0, lastX: 0, lastY: 0, vx: 0, vy: 0, lastT: 0 });
  /** a right-drag just panned: the menu its release would open stays shut */
  const menuEaten = useRef(0);

  // hold Space to pan from anywhere — over cards, frames and sections too
  const spaceHeld = useRef(false);
  useEffect(() => {
    const typingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || typingTarget(e.target)) return;
      e.preventDefault();
      spaceHeld.current = true;
      containerRef.current?.classList.add("space-pan");
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spaceHeld.current = false;
      containerRef.current?.classList.remove("space-pan");
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // the middle and right buttons pan from anywhere, like Space; the left only from the paper
    const held = e.button === 1 || e.button === 2;
    if (!spaceHeld.current && !held && target.closest(".section-card, button, input, select, .viewport-toolbar, .gutter")) return;
    // Rune's sections and cards take their own presses: only its paper pans
    if (runeRef.current && !spaceHeld.current && !held && target.tagName === "CANVAS" && runeHit(e.clientX, e.clientY).section) return;
    if (e.button !== 0 && !held) return;
    if (!held) setFocusGrid(); // clicking the void addresses the grid level
    const d = panDrag.current;
    d.active = true;
    d.button = e.button;
    d.pointerId = e.pointerId;
    d.downX = e.clientX;
    d.downY = e.clientY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.vx = 0;
    d.vy = 0;
    d.lastT = performance.now();
    // a right press may still be a right-click (the menu): it becomes a pan once it has moved
    d.moved = e.button !== 2;
    if (!d.moved) return;
    containerRef.current?.classList.add("panning");
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch { /* synthetic */ }
  }, [runeHit]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const bg = bgRef.current;
      const container = containerRef.current;
      if (bg && container) {
        const r = container.getBoundingClientRect();
        bg.uniforms.pointerX = e.clientX - r.left;
        bg.uniforms.pointerY = e.clientY - r.top;
        bg.pointerTarget = 1;
        publishPointer(e.clientX - r.left, e.clientY - r.top);
      }
      const d = panDrag.current;
      if (!d.active) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.downX, e.clientY - d.downY) < 4) return;
        d.moved = true;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        d.lastT = performance.now();
        container?.classList.add("panning");
        try {
          container?.setPointerCapture(d.pointerId);
        } catch { /* synthetic */ }
        return;
      }
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
    if (!d.moved) return; // a right-click that never moved: the menu's
    if (d.button === 2) menuEaten.current = performance.now();
    containerRef.current?.classList.remove("panning");
    // a throw glides on to where it was heading and rests there — no snapping
    camera.to(camera.x.value + d.vx / 8, camera.y.value + d.vy / 8);
    camera.x.nudgeVelocity(d.vx * 0.35);
    camera.y.nudgeVelocity(d.vy * 0.35);
  }, [camera]);

  const onPointerLeave = useCallback(() => {
    if (bgRef.current) bgRef.current.pointerTarget = 0;
    publishPointer(null, null);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;
      // the wheel zooms (lib/wheel.ts): nothing guesses what kind of device it came from
      const zooming = wheelAction(e, wheelMode()) === "zoom";
      // panning the grid ends a card's use, so it can't catch the wheel as it slides under the pointer;
      // a zoom keeps the card under the pointer, so a terminal or a desktop in use keeps the keys
      if (!zooming) releaseCard();
      const r = container.getBoundingClientRect();
      if (zooming) {
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        // trackpad pinch arrives as small ctrl-wheel deltas: follow the fingers 1:1;
        // a mouse wheel (with or without ⌘/ctrl) takes bigger steps on the spring
        const pinch = (e.ctrlKey || e.metaKey) && e.deltaMode === 0 && Math.abs(e.deltaY) < 40;
        // a wheel that counts in lines or pages: a notch is a notch
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? Math.sign(e.deltaY) * 100 : e.deltaY;
        const oldS = pinch ? zoom.value : zoom.goal;
        const factor = Math.exp(-dy * (pinch ? 0.011 : 0.0022));
        const newS = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldS * factor));
        const ratio = newS / oldS;
        if (pinch) {
          zoom.set(newS);
          camera.set(cx - (cx - camera.x.value) * ratio, cy - (cy - camera.y.value) * ratio);
        } else {
          zoom.to(newS);
          camera.to(cx - (cx - camera.x.goal) * ratio, cy - (cy - camera.y.goal) * ratio);
        }
      } else {
        // Shift+wheel, a sideways wheel, or a wheel set to pan (Settings → General): the paper moves.
        // Shift turns a plain wheel sideways where the system hasn't already
        const side = e.shiftKey && e.deltaX === 0;
        camera.set(camera.x.value - (side ? e.deltaY : e.deltaX), camera.y.value - (side ? 0 : e.deltaY));
      }
    },
    [camera, zoom],
  );

  // a right-drag is a pan, not a menu; and the middle button never starts the browser's auto-scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const menu = (e: MouseEvent) => {
      if (performance.now() - menuEaten.current > 400) return;
      menuEaten.current = 0;
      e.preventDefault();
      e.stopPropagation();
    };
    const middle = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener("contextmenu", menu, true);
    el.addEventListener("mousedown", middle);
    return () => {
      el.removeEventListener("contextmenu", menu, true);
      el.removeEventListener("mousedown", middle);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // No card takes the wheel (lib/cardUse.ts): over an app, a map, a terminal or a list it is the grid's
    // (it zooms: lib/wheel.ts), and ⌘/Ctrl-wheel always zooms it. Only the card in use (⌘/Ctrl-click, or full screen) has its own wheel.
    // Caught on the way down, so a card's own scroller (xterm, maplibre, a list) never sees it.
    // Alt-wheel over a card with more in it than fits scrolls through that card (lib/cardScroll.ts);
    // ⌘/Ctrl-wheel always zooms (2026-11-17: the zoom key does one thing).
    // 2026-11-17, Josh ("the VM takes over Ctrl+scroll"): that holds over the card in use too, a terminal or a
    // desktop with the keys included (the desktop's frame hands its ⌘/Ctrl-wheel up: panels/desktopFrame.ts).
    // Only a card full screen keeps it, since the grid isn't there to zoom.
    const h = (e: WheelEvent) => {
      if (inUse(e.target) && (!(e.ctrlKey || e.metaKey) || fullscreenCard())) return;
      e.preventDefault();
      if (e.altKey && !e.ctrlKey && !e.metaKey && cardWheel(e, noteAltScroll)) {
        e.stopPropagation();
        return;
      }
      if ((e.target as Element | null)?.closest?.(".frame-body, .panel-body, .map-body-wrap, .hosted-app")) e.stopPropagation();
      onWheel(e);
    };
    el.addEventListener("wheel", h, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", h, { capture: true });
  }, [onWheel]);

  // the mark on a card with more than fits: "Alt + scroll" (lib/scrollHint.ts)
  useEffect(() => (containerRef.current ? installScrollHint(containerRef.current) : undefined), []);

  const getScale = useCallback(() => zoom.value, [zoom]);

  // live zoom readout, written straight to the DOM (no re-render per frame)
  const zoomLabel = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      zoom.onChange((v: number) => {
        if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(v * 100)}%`;
      }),
    [zoom],
  );

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

  /** zoom by a factor around a viewport point (world point under it stays put) */
  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number) => {
      const oldS = zoom.goal;
      const newS = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldS * factor));
      const ratio = newS / oldS;
      zoom.to(newS);
      camera.to(cx - (cx - camera.x.goal) * ratio, cy - (cy - camera.y.goal) * ratio);
    },
    [camera, zoom],
  );

  // ----- double-click zooms in on what's under the pointer -----
  // An item you aren't framed on yet comes up to fill the view; once you're
  // there, the double-click goes through to the item (edit a note, a cell…).
  const onDoubleClickCapture = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement;
      // a double-click in a gap can land on an add-section + (it's in the gap): that's the paper, not a press
      const onAdd = Boolean(t.closest(".add-btn"));
      if (!onAdd && t.closest("input, textarea, select, button, [contenteditable='true'], .gutter, .port, .side-pane, .hud")) return;
      const st = getState();
      const objEl = onAdd ? null : t.closest<HTMLElement>("[data-obj-id]");
      const secEl = onAdd ? null : t.closest<HTMLElement>("[data-section-id]");
      let target: SnapTarget | null = null;
      let rect: Rect | null = null;
      let cap = 1.05;
      // on Rune's canvas the same rule runs on what Rune drew there
      const hit = runeRef.current && t.tagName === "CANVAS" ? runeHit(e.clientX, e.clientY) : null;
      const obj = hit ? (hit.object ? getObject(hit.object) : null) : objEl?.dataset.objId ? getObject(objEl.dataset.objId) : null;
      const hitSection = hit && !hit.object && hit.section ? st.sections[hit.section] : null;
      if (hitSection) {
        rect = sectionFocusRect(st.grid, hitSection);
        target = { kind: "section", id: hitSection.id };
      } else if (obj) {
        rect = objectWorldRect(obj);
        target = { kind: "object", id: obj.id };
        if ("sourceTableId" in obj) cap = 1;
      } else if (secEl?.dataset.sectionId && st.sections[secEl.dataset.sectionId]) {
        const s = st.sections[secEl.dataset.sectionId];
        rect = sectionFocusRect(st.grid, s);
        target = { kind: "section", id: s.id };
      }
      if (target && rect) {
        const frame = frameOf(rect, cap);
        if (frame && zoom.goal < frame.scale * 0.85) {
          e.stopPropagation();
          e.preventDefault();
          if (target.kind === "object") setActiveObject(target.id);
          else if (target.kind === "section") setActiveSection(target.id);
          requestSnap(target);
        } else if (hit?.object && obj && "text" in obj && getUi().role !== "viewer") {
          // already framed: the double-click goes through to the note, which opens for writing in Rune's own field
          runeHost()?.beginEdit(hit.object);
        }
        return;
      }
      // the void: step in around the pointer
      const r = containerRef.current?.getBoundingClientRect();
      if (r) zoomAt(e.clientX - r.left, e.clientY - r.top, 2);
    },
    [frameOf, zoom, zoomAt, runeHit],
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
    (e: React.PointerEvent, key: string, axis: "col" | "row") => {
      if (gutterDrag.current.active) return;
      const knob = knobRefs.current.get(key);
      if (!knob) return;
      const gr = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const s = zoom.value;
      if (axis === "col") knob.style.top = `${(e.clientY - gr.top) / s - 22}px`;
      else knob.style.left = `${(e.clientX - gr.left) / s - 22}px`;
    },
    [zoom],
  );

  // ----- the floor pushes the view aside -----
  // when a pane opens (or a session or search does), what you were looking at
  // slides over to stay in the middle of the paper that's left
  const lastInsets = useRef(insets);
  useEffect(() => {
    const prev = lastInsets.current;
    lastInsets.current = insets;
    const dx = (insets.left - prev.left - (insets.right - prev.right)) / 2;
    const dy = (insets.top - prev.top - (insets.bottom - prev.bottom)) / 2;
    if (dx || dy) camera.to(camera.x.goal + dx, camera.y.goal + dy);
  }, [insets.left, insets.right, insets.top, insets.bottom, camera]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- render -----
  const size = gridSize(state.grid);
  const xo = trackOffsets(state.grid.cols);
  const yo = trackOffsets(state.grid.rows);
  const sections = Object.values(state.sections);

  return (
    <div
      ref={containerRef}
      className={`grid-viewport ctx-${state.focusLevel}${rune ? " is-rune" : ""}`}
      onPointerDown={onPointerDown}
      onPointerDownCapture={(e) => {
        // Space held, or the middle or right button: the grid takes the pointer before any card can
        if (spaceHeld.current || e.button === 1 || e.button === 2) {
          // (Rune hears a right press on its canvas all the same: its sections answer a right-click themselves)
          const runes = runeRef.current && e.button === 2 && (e.target as HTMLElement).tagName === "CANVAS";
          if (!runes) e.stopPropagation();
          onPointerDown(e);
        }
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClickCapture={onDoubleClickCapture}
    >
      {/* the cards live above the paper but under the floor: masked out where the floor is.
          The floor's edges are set (and transition) on the mask alone: on the viewport, every card under
          it restyled on each frame of a pane opening */}
      {rune && <RuneSurface />}
      <div className="world-mask" style={{ "--floor-l": `${insets.left}px`, "--floor-t": `${insets.top}px`, "--floor-r": `${insets.right}px`, "--floor-b": `${insets.bottom}px` } as CSSProperties}>
      <div ref={worldRef} className={"world" + (state.expandedSection && state.sections[state.expandedSection] ? " has-expanded" : "")}>
        {/* Rune draws the grid, its cells and sections on its own canvas; here the web renderer does */}
        {!rune && (<>
        {/* ----- grid chrome: track lines + spreadsheet labels ----- */}
        <div className="grid-frame" style={{ width: size.w, height: size.h }} />
        {/* track lines only where they divide sections — never across a merged one */}
        {gutterRuns(state.grid, sections)
          .filter((g) => !g.interior)
          .map((g) =>
            g.axis === "col" ? (
              <div key={`l${g.axis}${g.index}:${g.from}`} className="grid-line-v" style={{ left: xo[g.index + 1], top: yo[g.from], height: yo[g.to + 1] - yo[g.from] }} />
            ) : (
              <div key={`l${g.axis}${g.index}:${g.from}`} className="grid-line-h" style={{ top: yo[g.index + 1], left: xo[g.from], width: xo[g.to + 1] - xo[g.from] }} />
            ),
          )}
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
              className="empty-cell"
              style={{
                left: rect.x + SECTION_INSET,
                top: rect.y + SECTION_INSET,
                width: rect.w - SECTION_INSET * 2,
                height: rect.h - SECTION_INSET * 2,
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
                  {
                    icon: "✦",
                    label: "Create it and ask an agent to build it…",
                    agent: true,
                    action: () => {
                      createSectionAt(c, r);
                      // the section just made is the one in use
                      const id = getState().activeSectionId;
                      if (id) openSectionAgents(id, true);
                    },
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
        {state.sectionDragTarget?.edge &&
          (() => {
            const e = state.sectionDragTarget.edge;
            const band = 120;
            const rect =
              e === "left" ? { x: -band - 12, y: 0, w: band, h: size.h }
              : e === "right" ? { x: size.w + 12, y: 0, w: band, h: size.h }
              : e === "top" ? { x: 0, y: -band - 12, w: size.w, h: band }
              : { x: 0, y: size.h + 12, w: size.w, h: band };
            return (
              <div className="cell-drop-highlight is-edge" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
                <span>{state.sectionDragTarget.label ?? `Append along the ${e} of the board`}</span>
              </div>
            );
          })()}
        {state.sectionDragTarget && !state.sectionDragTarget.edge &&
          (() => {
            const { c, r } = state.sectionDragTarget;
            const rect = gridCellRect(state.grid, c, r);
            return (
              <div
                className="cell-drop-highlight"
                style={{ left: rect.x + 6, top: rect.y + 6, width: rect.w - 12, height: rect.h - 12 }}
              >
                {state.sectionDragTarget.label && <span>{state.sectionDragTarget.label}</span>}
              </div>
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

        {/* track resize gutters, one per stretch of boundary between two sections (or empty cells).
            A boundary running inside a merged section has none: the grid is resized from the lines
            between sections only (2026-11-24, Josh) */}
        {gutterSegments(state.grid, sections).filter((g) => !g.interior).map((g) => {
          const key = `${g.axis}${g.index}:${g.from}`;
          const col = g.axis === "col";
          return (
            <div
              key={key}
              className={`gutter gutter-${g.axis}`}
              style={
                col
                  ? { left: xo[g.index + 1] - 7, top: yo[g.from] + GUTTER_INSET, height: yo[g.to + 1] - yo[g.from] - GUTTER_INSET * 2 }
                  : { top: yo[g.index + 1] - 7, left: xo[g.from] + GUTTER_INSET, width: xo[g.to + 1] - xo[g.from] - GUTTER_INSET * 2 }
              }
              onPointerMove={(e) => onGutterHover(e, key, g.axis)}
            >
              <div className="gutter-line" />
              <div
                className="gutter-knob"
                ref={(el) => {
                  if (el) knobRefs.current.set(key, el);
                  else knobRefs.current.delete(key);
                }}
                title={col ? "Drag to resize column" : "Drag to resize row"}
                onPointerDown={(e) => onGutterDown(e, g.axis, g.index)}
                onPointerMove={onGutterMove}
                onPointerUp={onGutterUp}
                onPointerCancel={onGutterUp}
              />
            </div>
          );
        })}

        </>)}
        {/* the cards that are web content (apps, pages, machines, maps, video, the table in hand) stay the web's, over Rune's canvas */}
        {rune && <RuneIslands sections={sections} grid={state.grid} getScale={getScale} zoomSpring={zoom} />}

        {/* data-flow wires above everything */}
        <WireLayer />
        {/* the meta layer: app port wires (shown with the agent layer) */}
        <PortWires />
        <PeerCursors />
        <CrewCursors />
      </div>
      </div>

      {/* an agent brought you somewhere (or asks to): Back / Go */}
      <div className="crew-guide-slot" style={{ left: insets.left, right: insets.right, top: insets.top }}>
        <LevelBar boardName={boardName} />
        <CrewGuide />
        <CrewFollow />
      </div>

      {/* the bottom bar (2026-11-17, Josh: the top right's tools moved here): search (a window over its pill, or
          pinned on the right), talk, the zoom, present and commands, then the council beside Ask, and Ask's own
          pill with the agents' settings at its end. When the grid's council stands at the bottom right, the bar
          goes to the bottom left */}
      {/* the bar's room: the open paper, less the grid's council when it stands at the right. The bar folds into
          icons as the room narrows (2026-11-17, Josh: "the bottom bar should collapse as the panel on the right is
          coming in"): shell.css, @container hud */}
      <div className="hud-room" style={{ left: insets.left, right: insets.right + (councilBoard ? ui.councilW : 0), bottom: insets.bottom }}>
      <motion.div
        className={`hud${councilBoard ? " is-aside" : ""}`}
        layout="position"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 210, damping: 22, delay: 0.05, layout: { type: "spring", stiffness: 320, damping: 32 } }}
        data-hud
      >
        <div className="hud-search-slot" data-hud-search>
          <button className={`hud-search f-glass${ui.searchPop || ui.search ? " is-on" : ""}`} onClick={toggleSearch} aria-pressed={ui.searchPop || ui.search} data-tip={`Search everything and drag it onto the grid · ${keys("mod+K")} for commands`} data-kbd={keys("mod+F")}>
            <span className="hud-glyph">
              <SearchGlyph size={15} />
            </span>
            <span className="hud-label">Search</span>
            <span className="f-kbd">{keys("mod+F")}</span>
          </button>
          <SearchPop />
        </div>
        <TalkButton />
        <RuneMark />
        <button
          className="hud-zoom f-glass"
          data-tip="Zoom: the wheel zooms, drag the paper to move · click for 100% (1) · 0 fits all · F frames the focus"
          onClick={() => zoomAroundCenter(1 / zoom.goal)}
        >
          <span ref={zoomLabel}>50%</span>
        </button>
        <div className="hud-icons f-glass" role="group" aria-label="Present and commands">
          <button className="hud-icon" onClick={() => setUi({ presenting: true })} aria-label="Present" data-tip="Present" data-kbd="P">
            <PresentGlyph size={15} />
          </button>
          <button className="hud-icon" onClick={() => setUi({ command: true })} aria-label="Commands" data-tip="Commands, open an app" data-kbd={keys("mod+K")}>
            <span className="hud-icon-text">{COMMANDS_GLYPH}</span>
          </button>
        </div>
        <button className={`hud-icon hud-council f-glass${councilBoard ? " is-on" : ""}`} onClick={() => toggleCouncil({ kind: "board" })} aria-pressed={councilBoard} aria-label="Council" data-tip={onLocal ? "Council: this grid's agents. The grid is read from this computer, where its sessions run" : "Council: this grid's agents, as characters. Talk to them, add more"} data-council-open>
          <CouncilGlyph />
          {onLocal && (
            <span className="council-local-badge" aria-hidden>
              <ComputerGlyph size={10} />
            </span>
          )}
        </button>
        <div className={`hud-ask-pill f-glass${ui.session ? " is-on" : ""}`}>
          <button className={`hud-ask${ui.session ? " is-on" : ""}`} onClick={toggleSession} aria-pressed={!!ui.session} data-tip={ui.session ? "Put the conversation away" : "Ask the agent: a conversation beside the canvas"} data-kbd={keys("mod+J")}>
            <span className="hud-glyph">✦</span>
            <span className="hud-label">Ask</span>
          </button>
          <button className={`hud-ask-gear${ui.agents ? " is-on" : ""}`} onClick={() => setUi({ agents: !ui.agents })} aria-pressed={ui.agents} aria-label="Agents: settings" data-tip="Agents: who's on this grid, add one, what runs in the background" data-hud-agents>
            <SlidersGlyph size={15} />
          </button>
        </div>
      </motion.div>
      </div>
    </div>
  );
}

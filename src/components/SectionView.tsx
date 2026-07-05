import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CONTENT_PAD,
  GridTracks,
  SECTION_HEADER,
  Section,
  addMedia,
  addNote,
  addSectionAdjacent,
  cellAtWorld,
  createMap,
  createTable,
  effectivePos,
  liveScroll,
  moveSectionTo,
  objectPixelSize,
  objectsInSection,
  removeSection,
  renameSection,
  requestSnap,
  sectionCardRect,
  setActiveSection,
  setSectionDragTarget,
  setSectionScroll,
  splitSection,
  useAppState,
} from "../state/store";
import { Spring, Spring2D, presets } from "../physics/spring";
import { TableView } from "./TableView";
import { MapView } from "./MapView";
import { NoteView } from "./NoteView";
import { MediaView } from "./MediaView";

interface Props {
  section: Section;
  grid: GridTracks;
  active: boolean;
  canRemove: boolean;
  getScale(): number;
  zoomSpring: Spring;
}

/** read natural media dimensions so cards start with the right aspect */
function probeMedia(file: File): Promise<{ src: string; w: number; h: number }> {
  const src = URL.createObjectURL(file);
  return new Promise((resolve) => {
    if (file.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ src, w: v.videoWidth || 640, h: v.videoHeight || 360 });
      v.onerror = () => resolve({ src, w: 640, h: 360 });
      v.src = src;
    } else {
      const img = new Image();
      img.onload = () => resolve({ src, w: img.naturalWidth || 480, h: img.naturalHeight || 360 });
      img.onerror = () => resolve({ src, w: 480, h: 360 });
      img.src = src;
    }
  });
}

export const SectionView = memo(function SectionView({
  section,
  grid,
  active,
  canRemove,
  getScale,
  zoomSpring,
}: Props) {
  const state = useAppState();
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dropping, setDropping] = useState(false);

  // ----- drag the whole section to another grid cell -----
  const moveDrag = useRef({
    down: false,
    dragging: false,
    startX: 0,
    startY: 0,
    target: null as { c: number; r: number } | null,
  });

  const worldPoint = useCallback(
    (clientX: number, clientY: number) => {
      const world = cardRef.current?.closest(".world");
      if (!world) return null;
      const wr = (world as HTMLElement).getBoundingClientRect();
      const s = getScale();
      return { x: (clientX - wr.left) / s, y: (clientY - wr.top) / s };
    },
    [getScale],
  );

  const onSectionHeaderDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    const d = moveDrag.current;
    d.down = true;
    d.dragging = false;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.target = null;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch { /* synthetic */ }
  }, []);

  const onSectionHeaderMove = useCallback(
    (e: React.PointerEvent) => {
      const d = moveDrag.current;
      if (!d.down) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.dragging) {
        if (Math.hypot(dx, dy) < 7) return; // preserve click / double-click
        d.dragging = true;
        cardRef.current?.classList.add("section-dragging");
      }
      const s = getScale();
      const el = cardRef.current;
      if (el) el.style.translate = `${dx / s}px ${dy / s}px`;
      const pt = worldPoint(e.clientX, e.clientY);
      const cell = pt ? cellAtWorld(pt.x, pt.y) : null;
      d.target = cell;
      setSectionDragTarget(cell ? { sectionId: section.id, c: cell.c, r: cell.r } : null);
    },
    [getScale, worldPoint, section.id],
  );

  const onSectionHeaderUp = useCallback(() => {
    const d = moveDrag.current;
    if (!d.down) return;
    d.down = false;
    if (d.dragging) {
      d.dragging = false;
      const el = cardRef.current;
      if (el) {
        el.style.translate = "";
        el.classList.remove("section-dragging");
      }
      setSectionDragTarget(null);
      if (d.target) moveSectionTo(section.id, d.target.c, d.target.r);
    }
  }, [section.id]);

  const rect = sectionCardRect(grid, section);
  const objects = objectsInSection(section.id);
  const layout = useMemo(
    () => {
      const m = new Map<string, { x: number; y: number }>();
      for (const o of objects) m.set(o.id, effectivePos(o));
      return m;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.tables, state.maps, state.notes, state.media, rect.w, section.id],
  );

  // ----- scrollable content (spring-smoothed nested grid) -----
  const scroll = useMemo(
    () => new Spring2D(section.scroll.x, section.scroll.y, presets.camera),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section.id],
  );

  const extent = useMemo(() => {
    let w = 0;
    let h = 0;
    for (const o of objects) {
      const s = objectPixelSize(o);
      const p = layout.get(o.id) ?? { x: o.x, y: o.y };
      w = Math.max(w, p.x + s.w);
      h = Math.max(h, p.y + s.h);
    }
    return { w: w + CONTENT_PAD * 2, h: h + CONTENT_PAD * 2 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const maxScroll = useCallback(() => {
    const viewW = rect.w - CONTENT_PAD;
    const viewH = rect.h - SECTION_HEADER - CONTENT_PAD;
    return {
      x: Math.max(0, extent.w - viewW),
      y: Math.max(0, extent.h - viewH),
    };
  }, [rect.w, rect.h, extent]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const apply = (x: number, y: number) => {
      el.style.transform = `translate3d(${-x}px, ${-y}px, 0)`;
      liveScroll.set(section.id, { x, y });
    };
    apply(scroll.x.value, scroll.y.value);
    return scroll.onChange(apply);
  }, [scroll, section.id]);

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCommit = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      setSectionScroll(section.id, scroll.x.goal, scroll.y.goal);
    }, 500);
  }, [section.id, scroll]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // viewport zoom
      if (getScale() < 0.55) return; // zoomed way out → viewport pan
      if ((e.target as HTMLElement).closest(".map-body")) return;
      e.stopPropagation();
      const m = maxScroll();
      scroll.x.to(Math.max(0, Math.min(m.x, scroll.x.goal + e.deltaX)));
      scroll.y.to(Math.max(0, Math.min(m.y, scroll.y.goal + e.deltaY)));
      scheduleCommit();
    },
    [scroll, maxScroll, getScale, scheduleCommit],
  );

  // ----- media intake: desktop drag-drop + open dialog -----
  const ingestFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of [...files]) {
        if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
          const kind = file.type.startsWith("video/") ? "video" : "image";
          const { src, w, h } = await probeMedia(file);
          addMedia(section.id, src, kind, file.name, w, h);
        }
      }
    },
    [section.id],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);
      void ingestFiles(e.dataTransfer.files);
    },
    [ingestFiles],
  );

  const scrollable = maxScroll();
  const iconSpring = { type: "spring", stiffness: 500, damping: 22 } as const;

  const secBtn = (
    title: string,
    glyph: string,
    onClick: () => void,
    cls = "",
  ) => (
    <motion.button
      className={"icon-btn sec-btn " + cls}
      whileHover={{ scale: 1.12 }}
      whileTap={{ scale: 0.82 }}
      transition={iconSpring}
      title={title}
      onClick={onClick}
    >
      {glyph}
    </motion.button>
  );

  return (
    <motion.div
      ref={cardRef}
      className={"section-card" + (active ? " active" : "") + (dropping ? " dropping" : "")}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 240, damping: 22 }}
      onPointerDown={() => setActiveSection(section.id)}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {/* header — drag it to move the section to another grid cell */}
      <div
        className="section-header"
        style={{ height: SECTION_HEADER }}
        onPointerDown={onSectionHeaderDown}
        onPointerMove={onSectionHeaderMove}
        onPointerUp={onSectionHeaderUp}
        onPointerCancel={onSectionHeaderUp}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          requestSnap({ kind: "section", id: section.id });
        }}
      >
        {renaming ? (
          <input
            className="section-name-input"
            defaultValue={section.name}
            autoFocus
            spellCheck={false}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                renameSection(section.id, (e.target as HTMLInputElement).value);
                setRenaming(false);
              } else if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={(e) => {
              renameSection(section.id, e.target.value);
              setRenaming(false);
            }}
          />
        ) : (
          <button className="section-name" onClick={() => setRenaming(true)} title="Rename section">
            {section.name}
          </button>
        )}
        <span className="section-coords">
          {colName(section.c0)}
          {section.r0 + 1}
          {(section.c1 !== section.c0 || section.r1 !== section.r0) &&
            `:${colName(section.c1)}${section.r1 + 1}`}
        </span>

        <div className="section-actions">
          {secBtn("Add table", "⊞", () => createTable(section.id))}
          {secBtn("Add map", "◍", () => createMap(section.id))}
          {secBtn("Add markdown note", "▤", () => addNote(section.id))}
          {secBtn("Add image or video from disk", "⇪", () => fileRef.current?.click())}
          <span className="sec-sep" />
          {secBtn("Split section — subdivides this grid column", "◫", () =>
            splitSection(section.id, "h"),
          )}
          {secBtn("Split section — subdivides this grid row", "⬓", () =>
            splitSection(section.id, "v"),
          )}
          <span className="sec-sep" />
          {secBtn("Expand — fill the viewport with this section", "⤢", () =>
            requestSnap({ kind: "section", id: section.id }),
          )}
          {canRemove &&
            secBtn("Remove section", "✕", () => setConfirming(true), "sec-remove")}
        </div>
      </div>

      {/* remove confirmation */}
      <AnimatePresence>
        {confirming && (
          <motion.div
            className="confirm-pop"
            initial={{ opacity: 0, y: -10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 400, damping: 26 }}
          >
            <span>
              Remove <b>{section.name}</b>
              {objects.length > 0 && ` and ${objects.length} item${objects.length === 1 ? "" : "s"}`}?
            </span>
            <motion.button
              className="confirm-btn danger"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              onClick={() => removeSection(section.id)}
            >
              Remove
            </motion.button>
            <motion.button
              className="confirm-btn"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* hidden file input for the open dialog */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void ingestFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* scrollable nested grid */}
      <div className="section-body" onWheel={onWheel}>
        <div ref={contentRef} className="section-content">
          {objects.map((o) => {
            const pos = layout.get(o.id) ?? { x: o.x, y: o.y };
            const slot = (child: React.ReactNode) => (
              <div key={o.id} className="obj-slot" style={{ left: CONTENT_PAD, top: CONTENT_PAD }}>
                {child}
              </div>
            );
            if ("cols" in o) return slot(<TableView table={o} framePos={pos} getScale={getScale} />);
            if ("sourceTableId" in o)
              return slot(
                <MapView map={o} framePos={pos} getScale={getScale} zoomSpring={zoomSpring} />,
              );
            if ("text" in o) return slot(<NoteView note={o} pos={pos} getScale={getScale} />);
            return slot(<MediaView item={o} pos={pos} getScale={getScale} />);
          })}
        </div>

        {objects.length === 0 && (
          <div className="section-empty">
            <span>⊞ table · ◍ map · ▤ note · ⇪ media — or drop files here</span>
          </div>
        )}

        {(scrollable.x > 1 || scrollable.y > 1) && <div className="scroll-hint" />}
      </div>

      {/* add-section affordances on the edges */}
      <motion.button
        className="add-btn add-section-right"
        whileHover={{ scale: 1.15 }}
        whileTap={{ scale: 0.8 }}
        transition={iconSpring}
        title="Add section to the right"
        onClick={() => addSectionAdjacent(section.id, "right")}
      >
        +
      </motion.button>
      <motion.button
        className="add-btn add-section-below"
        whileHover={{ scale: 1.15 }}
        whileTap={{ scale: 0.8 }}
        transition={iconSpring}
        title="Add section below"
        onClick={() => addSectionAdjacent(section.id, "below")}
      >
        +
      </motion.button>
    </motion.div>
  );
});

function colName(col: number): string {
  let s = "";
  let n = col;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

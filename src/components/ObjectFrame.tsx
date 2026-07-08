import { ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import {
  MINI_HEADER,
  dropObjectIfRetargeted,
  liveObjPos,
  setActiveObject,
  setObjectFloat,
  trackObjectDrag,
} from "../state/store";
import { Spring2D, presets } from "../physics/spring";

/**
 * Shared card frame for the lightweight primitives (notes, images, videos):
 * spring drag (auto-floats when grabbed), pin/dock toggle, resize handle,
 * remove button, springy entrance.
 */
interface Props {
  id: string;
  title: string;
  pos: { x: number; y: number };
  width: number;
  float: boolean;
  isActive?: boolean;
  getScale(): number;
  onMove(x: number, y: number): void;
  onResize?(dw: number, dh: number): void;
  onRemove(): void;
  headerExtras?: ReactNode;
  children: ReactNode;
  bodyClass?: string;
}

export function ObjectFrame({
  id,
  title,
  pos,
  width,
  float,
  isActive,
  getScale,
  onMove,
  onResize,
  onRemove,
  headerExtras,
  children,
  bodyClass,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  const spring = useMemo(
    () => new Spring2D(pos.x, pos.y, presets.drag),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (x: number, y: number) => {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      liveObjPos.set(id, { x, y });
    };
    apply(spring.x.value, spring.y.value);
    const unsub = spring.onChange(apply);
    return () => {
      unsub();
      liveObjPos.delete(id);
    };
  }, [spring, id]);

  useEffect(() => {
    if (!dragRef.current.active) spring.to(pos.x, pos.y);
  }, [pos.x, pos.y, spring]);

  const dragRef = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const onHeaderDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, input, select")) return;
      e.stopPropagation();
      if (!float) setObjectFloat(id, true); // grabbing undocks it from the flow
      const d = dragRef.current;
      d.active = true;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origX = spring.x.goal;
      d.origY = spring.y.goal;
      rootRef.current?.classList.add("dragging");
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* synthetic */ }
    },
    [spring, id, float],
  );

  const onHeaderMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d.active) return;
      const s = getScale();
      spring.to(
        Math.max(0, d.origX + (e.clientX - d.startX) / s),
        Math.max(0, d.origY + (e.clientY - d.startY) / s),
      );
      trackObjectDrag(rootRef.current, id, e.clientX, e.clientY, s);
    },
    [spring, getScale, id],
  );

  const onHeaderUp = useCallback(() => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    rootRef.current?.classList.remove("dragging");
    if (dropObjectIfRetargeted(id)) return; // landed in another section
    onMove(spring.x.goal, spring.y.goal);
  }, [spring, onMove, id]);

  // ----- resize -----
  const resizeRef = useRef({ active: false, startX: 0, startY: 0 });
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const d = resizeRef.current;
    d.active = true;
    d.startX = e.clientX;
    d.startY = e.clientY;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch { /* synthetic */ }
  }, []);
  const onResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const d = resizeRef.current;
      if (!d.active || !onResize) return;
      const s = getScale();
      onResize((e.clientX - d.startX) / s, (e.clientY - d.startY) / s);
      d.startX = e.clientX;
      d.startY = e.clientY;
    },
    [onResize, getScale],
  );
  const onResizeUp = useCallback(() => {
    resizeRef.current.active = false;
  }, []);

  const iconSpring = { type: "spring", stiffness: 500, damping: 22 } as const;

  return (
    <div ref={rootRef} className="frame-anchor" style={{ width }}>
      <motion.div
        className={"frame-card" + (isActive ? " ctx-active" : "")}
        initial={{ scale: 0.55, opacity: 0, y: 50 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 240, damping: 20 }}
        onPointerDown={() => setActiveObject(id)}
      >
        <div
          className="frame-header"
          style={{ height: MINI_HEADER }}
          onPointerDown={onHeaderDown}
          onPointerMove={onHeaderMove}
          onPointerUp={onHeaderUp}
          onPointerCancel={onHeaderUp}
        >
          <div className="grip mini">
            <span />
            <span />
          </div>
          <span className="frame-title">{title}</span>
          <div className="header-actions">
            {headerExtras}
            <motion.button
              className={"icon-btn float-btn" + (float ? " floating" : "")}
              whileHover={{ scale: 1.12 }}
              whileTap={{ scale: 0.82 }}
              transition={iconSpring}
              title={float ? "Dock into the section grid" : "Floating off — drag to float"}
              onClick={() => setObjectFloat(id, !float)}
            >
              {float ? "✥" : "⌗"}
            </motion.button>
            <motion.button
              className="icon-btn"
              whileHover={{ scale: 1.12 }}
              whileTap={{ scale: 0.82 }}
              transition={iconSpring}
              title="Remove"
              onClick={onRemove}
            >
              ✕
            </motion.button>
          </div>
        </div>
        <div className={"frame-body " + (bodyClass ?? "")}>{children}</div>
        {onResize && (
          <div
            className="map-resize"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title="Resize"
          />
        )}
      </motion.div>
    </div>
  );
}

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getUi } from "../state/ui";
import { MINI_HEADER, getObject, liveObjPos, setActiveObject, setObjectFloat, setObjectFolded } from "../state/store";
import { CARD_REMOVE } from "./cardMenu";
import { Spring2D, presets } from "../physics/spring";
import { countRender } from "../state/renders";
import { LIFT, MAX_LEAN, startCarry, type Carry } from "../lib/carry";
import { FullscreenBar, FullscreenButton, useFullscreenCard } from "./Fullscreen";

/**
 * Shared card frame for the lightweight primitives (notes, images, videos,
 * panels): spring drag (auto-floats when grabbed), pin/dock toggle, resize
 * handle, remove button, springy entrance.
 *
 * Cards rest clean — no menu bar. Their chrome is called by the pointer:
 * `bar` (default) slides a glass bar in at the card's top edge on hover, and
 * the card's content moves down to make room for it (2026-11-16, Josh: "The
 * Cards roll over menu covers up the card contents, it should push it down");
 * `icons` (images, video) shows a few round buttons in the card's top-right
 * corner, full screen last (2026-11-24, Josh: "The expansion icon should be in
 * the top right of the card"). There's no ✕ on them: an image or a video goes
 * from its right-click menu, or with Delete while it's selected, and ⌘Z brings
 * it back (lib/gridUndo.ts).
 *
 * What a left press picks up (2026-11-17, Josh: "left mouse is always grabs,
 * where it really should only grab on the grid, or a top handle of a section
 * or a menu"): a card moves by its bar and by nothing else; a press on its
 * body is the body's own (a button, a link, a caret, a selection). An image or
 * a video has nothing of its own to press, so it is picked up anywhere on it
 * (2026-11-24, Josh: "Image cards and media cards need to be grabbable and
 * movable around the grid"); a tap on a video, without moving, still plays or
 * pauses it.
 *
 * Making room never changes the card's own box (the section's flow doesn't
 * move): the body clips, and what's inside it either gets shorter from the
 * top (`.bar-reflow`: lists, notes, anything that lays itself out again
 * cheaply, so its last line and its bottom controls stay in the card) or just
 * slides (`.bar-slide`: a live app, a terminal, a model — nothing that would
 * have to resize a document).
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
  /** extra class on the card (e.g. panel kind) */
  cardClass?: string;
  /** data-* attributes on the anchor (panels: data-panel-id for drag-to-connect) */
  data?: Record<string, string>;
  /** rendered outside the clipped body, positioned against the card (ports) */
  overlay?: ReactNode;
  /** how the card's chrome appears on hover (see above) */
  chrome?: "bar" | "icons";
  /** for `icons` chrome: the buttons in its top-right corner (full screen is added last) */
  icons?: ReactNode;
  /** for `icons` chrome: a click on the card's body (a video plays or pauses) */
  onTap?(): void;
  /** full screen: an address to open in a tab from its bar */
  openUrl?: string;
  /** removing it loses something a person paid for or made: ✕ asks first, saying this (deletes need confirm) */
  confirmRemove?: { name: string; note: string };
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
  cardClass,
  data,
  overlay,
  chrome = "bar",
  icons,
  onTap,
  openUrl,
  confirmRemove,
}: Props) {
  countRender("ObjectFrame");
  const fullscreen = useFullscreenCard() === id;
  const rootRef = useRef<HTMLDivElement>(null);

  // ----- remove: a card that would lose something asks first -----
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setConfirming(false);
    };
    const away = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".frame-confirm")) setConfirming(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", away, true);
    };
  }, [confirming]);
  const askRemove = () => (confirmRemove ? setConfirming(true) : onRemove());
  // the card menu's Remove comes through here, so a card that asks first still asks
  const askRef = useRef(askRemove);
  askRef.current = askRemove;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; handled: boolean }>).detail;
      if (d.id !== id) return;
      d.handled = true;
      askRef.current();
    };
    window.addEventListener(CARD_REMOVE, on);
    return () => window.removeEventListener(CARD_REMOVE, on);
  }, [id]);
  // minimized (the card menu): its bar alone, always showing; the body is kept, not drawn
  const folded = chrome === "bar" && !!getObject(id)?.folded;

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

  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, origX: 0, origY: 0, lastX: 0, lastT: 0, lean: 0, carry: null as Carry | null, dragged: false });

  /** the held card lifts and leans into its motion: a little physicality, not a ton (DESIGN.md §6: lean ≤ 2.5°) */
  const setLean = (deg: number, lifted: boolean) => {
    const card = rootRef.current?.querySelector<HTMLElement>(".frame-card");
    if (!card) return;
    card.style.rotate = `${deg.toFixed(2)}deg`;
    card.style.scale = lifted ? String(LIFT) : "";
  };

  const onHeaderDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // full screen, nothing moves; a viewer's card stays where it is
      if (fullscreen || (chrome === "icons" && getUi().role === "viewer")) return;
      // a button, and the row of them (a near miss between two isn't a grab)
      if ((e.target as HTMLElement).closest("button, input, select, a, .header-actions")) return;
      e.stopPropagation();
      setActiveObject(id);
      const d = dragRef.current;
      d.moved = false;
      d.dragged = false;
      d.active = true;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origX = spring.x.goal;
      d.origY = spring.y.goal;
      d.lastX = e.clientX;
      d.lastT = performance.now();
      d.lean = 0;
      rootRef.current?.classList.add("dragging");
      setLean(0, true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* synthetic */ }
    },
    [spring, id, float, fullscreen, chrome],
  );

  const onHeaderMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d.active) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return; // still a tap
        d.moved = true;
        if (!float) setObjectFloat(id, true); // grabbing undocks it from the flow
        const anchor = rootRef.current;
        const card = anchor?.querySelector<HTMLElement>(".frame-card");
        // out of its section, it lifts out and can land in another (lib/carry.ts)
        if (anchor && card) d.carry = startCarry(id, anchor, card, e.clientX, e.clientY);
      }
      if (d.carry?.move(e.clientX, e.clientY)) return;
      const s = getScale();
      spring.to(
        Math.max(0, d.origX + (e.clientX - d.startX) / s),
        Math.max(0, d.origY + (e.clientY - d.startY) / s),
      );
      const now = performance.now();
      const vx = (e.clientX - d.lastX) / Math.max(1, now - d.lastT); // px/ms
      d.lastX = e.clientX;
      d.lastT = now;
      d.lean = d.lean * 0.8 + Math.max(-MAX_LEAN, Math.min(MAX_LEAN, vx * 2)) * 0.2;
      setLean(d.lean, true);
    },
    [spring, getScale, float, id],
  );

  const onHeaderUp = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    rootRef.current?.classList.remove("dragging");
    setLean(0, false);
    const carry = d.carry;
    d.carry = null;
    if (carry && (e.type === "pointercancel" ? (carry.cancel(), false) : carry.end(e.clientX, e.clientY))) {
      // it went somewhere else (or flew back): it rests where it was picked up
      spring.set(d.origX, d.origY);
      return;
    }
    if (d.moved) {
      // the click that ends a drag isn't a tap on the card (a video doesn't play because it was moved)
      d.dragged = true;
      onMove(spring.x.goal, spring.y.goal);
    }
  }, [spring, onMove]);

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

  const dragHandlers = {
    onPointerDown: onHeaderDown,
    onPointerMove: onHeaderMove,
    onPointerUp: onHeaderUp,
    onPointerCancel: onHeaderUp,
  };

  return (
    <div
      ref={rootRef}
      className={`frame-anchor chrome-${chrome}${confirming ? " is-confirming" : ""}${folded ? " is-folded" : ""}`}
      style={{ width }}
      // how small this card is drawn right now (the grid's zoom times its section's fit), for the ✕'s press area (App.css)
      onPointerEnter={(e) => {
        const el = e.currentTarget;
        if (el.offsetWidth) el.style.setProperty("--view-scale", (el.getBoundingClientRect().width / el.offsetWidth).toFixed(3));
      }}
      {...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
    >
      <motion.div
        className={"frame-card fs-able" + (isActive ? " ctx-active" : "") + (cardClass ? ` ${cardClass}` : "")}
        initial={{ scale: 0.94, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        onPointerDown={(e) => {
          setActiveObject(id);
          // an image or a video is picked up anywhere on it (the corner's buttons and the resize corner excepted)
          if (chrome === "icons") onHeaderDown(e);
        }}
        {...(chrome === "icons" ? { onPointerMove: onHeaderMove, onPointerUp: onHeaderUp, onPointerCancel: onHeaderUp } : {})}
        // a tap (a press let go where it was) on a video plays or pauses it; a click is on the card, which holds the press
        onClick={
          chrome === "icons" && onTap
            ? (e) => {
                if ((e.target as Element).closest("button, .map-resize, .fs-bar")) return;
                if (dragRef.current.dragged) dragRef.current.dragged = false;
                else onTap();
              }
            : undefined
        }
      >
        {fullscreen && <FullscreenBar id={id} title={title} url={openUrl} />}
        {chrome === "bar" && (
          <div className="frame-header" style={{ height: MINI_HEADER - 4 }} {...dragHandlers}>
            <div className="grip mini">
              <span />
              <span />
            </div>
            <span className="frame-title">{title}</span>
            <div className="header-actions">
              {!folded && headerExtras}
              {folded ? (
                <button type="button" className="icon-btn" data-tip="Restore" aria-label="Restore" onClick={() => setObjectFolded(id, false)} data-card-restore>
                  ▢
                </button>
              ) : (
                <FullscreenButton id={id} />
              )}
              <button
                type="button"
                className={"icon-btn float-btn" + (float ? " floating" : "")}
                data-tip={float ? "Dock into the section" : "Float freely"}
                aria-label={float ? "Dock into the section" : "Float freely"}
                onClick={() => setObjectFloat(id, !float)}
              >
                {float ? "✥" : "⌗"}
              </button>
              <button type="button" className="icon-btn is-remove" data-tip={confirmRemove ? "Remove…" : "Remove"} aria-label="Remove" onClick={askRemove}>
                ✕
              </button>
            </div>
          </div>
        )}
        <AnimatePresence>
          {confirming && confirmRemove && (
            <motion.div
              className="confirm-pop frame-confirm"
              role="alertdialog"
              aria-label={`Remove ${confirmRemove.name}?`}
              initial={{ opacity: 0, y: -10, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.94 }}
              transition={{ type: "spring", stiffness: 400, damping: 26 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span>
                Remove <b>{confirmRemove.name}</b>? {confirmRemove.note}
              </span>
              <span className="frame-confirm-acts">
                <motion.button
                  className="confirm-btn danger"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => {
                    setConfirming(false);
                    onRemove();
                  }}
                >
                  Remove
                </motion.button>
                <motion.button className="confirm-btn" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.92 }} onClick={() => setConfirming(false)}>
                  Keep
                </motion.button>
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        {/* minimized: the content stays mounted (a page keeps its place, a terminal its shell), just not shown */}
        <div className={"frame-body " + (bodyClass ?? "")} hidden={folded}>
          {children}
        </div>
        {chrome === "icons" && !fullscreen && (
          // no bar: its few buttons wait in the top-right corner, full screen last, while the pointer is on it
          <div className="frame-corner">
            {icons}
            <FullscreenButton id={id} round />
          </div>
        )}
        {!folded && overlay}
        {onResize && !folded && (
          <div
            className="map-resize"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            data-tip="Resize"
          />
        )}
      </motion.div>
    </div>
  );
}

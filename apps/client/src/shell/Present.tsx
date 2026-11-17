/**
 * Presentation mode (P). The real grid, chrome gone, the camera gliding from
 * section to section — and an infinite filmstrip at the foot: drag or wheel it
 * with inertia, it loops forever, settles on the nearest slide on a spring and
 * the grid follows. Arrows / Space / click to advance, Esc to leave.
 *
 * Motion (DESIGN.md → Motion → Presentation): the strip is a critically-damped
 * spring (k 120, c 24) on a continuous offset; slides take scale 1 → 0.86 and
 * opacity 1 → 0.35 with distance; titles rise 14 px over 600 ms on
 * --ease-out-soft, words staggered 40 ms.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getState, objectsInSection, requestSnap, subscribe, type Section } from "../state/store";
import { useStoreSlice } from "../state/slices";
import { setUi, useUi } from "../state/ui";
import { countRender } from "../state/renders";

const SLIDE_W = 200;
const GAP = 18;
const STEP = SLIDE_W + GAP;

function orderSections(sections: Record<string, Section>) {
  // reading order: top-left to bottom-right
  return Object.values(sections).sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
}

const noCounts = () => "";
const presentCounts = () => Object.keys(getState().sections).map((id) => objectsInSection(id).length).join(",");

export function Present() {
  countRender("Present");
  const ui = useUi();
  const sections = useSyncExternalStore(subscribe, () => getState().sections);
  // the slides' card counts, only while presenting (each is drawn on its slide)
  useStoreSlice(ui.presenting ? presentCounts : noCounts);
  const slides = useMemo(() => orderSections(sections), [sections]);
  const n = slides.length;
  const [index, setIndex] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const sim = useRef({ x: 0, v: 0, target: 0, dragging: false, lastX: 0, lastT: 0 });

  const go = (i: number) => {
    if (!n) return;
    sim.current.target = i;
    const wrapped = ((Math.round(i) % n) + n) % n;
    setIndex(wrapped);
    requestSnap({ kind: "section", id: slides[wrapped].id });
  };

  // enter: frame the first slide
  useEffect(() => {
    if (!ui.presenting || !n) return;
    const start = Math.max(0, slides.findIndex((s) => s.id === getState().activeSectionId));
    sim.current = { ...sim.current, x: start, v: 0, target: start };
    go(start);
    document.body.classList.add("is-presenting");
    return () => {
      document.body.classList.remove("is-presenting");
      requestSnap({ kind: "all" });
    };
  }, [ui.presenting]); // eslint-disable-line react-hooks/exhaustive-deps

  // the strip's spring, imperatively
  useEffect(() => {
    if (!ui.presenting) return;
    let raf = 0;
    let last = performance.now();
    const k = 120;
    const c = 24;
    const tick = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const s = sim.current;
      if (!s.dragging) {
        const a = -k * (s.x - s.target) - c * s.v;
        s.v += a * dt;
        s.x += s.v * dt;
      }
      const el = strip.current;
      if (el) {
        const kids = el.children as HTMLCollectionOf<HTMLElement>;
        for (let i = 0; i < kids.length; i++) {
          // infinite: place each slide at its nearest wrapped distance from x
          let d = i - s.x;
          d = ((((d + n / 2) % n) + n) % n) - n / 2;
          const ad = Math.abs(d);
          const scale = 1 - Math.min(ad, 3) * 0.047;
          const op = 1 - Math.min(ad, 3) * 0.22;
          kids[i].style.transform = `translate3d(${d * STEP - SLIDE_W / 2}px, 0, 0) scale(${scale})`;
          kids[i].style.opacity = String(Math.max(0.35, op));
          kids[i].style.zIndex = String(100 - Math.round(ad * 10));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ui.presenting, n]);

  // keys
  useEffect(() => {
    if (!ui.presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key.toLowerCase() === "p") {
        e.preventDefault();
        setUi({ presenting: false });
      } else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        go(Math.round(sim.current.target) + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(Math.round(sim.current.target) - 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ui.presenting, n]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDown = (e: React.PointerEvent) => {
    const s = sim.current;
    s.dragging = true;
    s.lastX = e.clientX;
    s.lastT = performance.now();
    s.v = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = sim.current;
    if (!s.dragging) return;
    const now = performance.now();
    const dx = (e.clientX - s.lastX) / STEP;
    s.x -= dx;
    s.v = (-dx / Math.max(1, now - s.lastT)) * 1000;
    s.lastX = e.clientX;
    s.lastT = now;
  };
  const onUp = () => {
    const s = sim.current;
    if (!s.dragging) return;
    s.dragging = false;
    // carry the throw: project 0.18 s ahead, then settle on the nearest slide
    go(Math.round(s.x + s.v * 0.18));
  };
  const onWheel = (e: React.WheelEvent) => {
    const s = sim.current;
    s.x += (e.deltaX || e.deltaY) / STEP;
    clearTimeout((onWheel as unknown as { t?: number }).t);
    (onWheel as unknown as { t?: number }).t = window.setTimeout(() => go(Math.round(s.x)), 120);
  };

  const current = slides[index];
  const count = current ? objectsInSection(current.id).length : 0;

  return (
    <AnimatePresence>
      {ui.presenting && n > 0 && (
        <motion.div className="present" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.28 }}>
          <div className="present-title" key={current?.id}>
            <div className="f-eyebrow">
              {String(index + 1).padStart(2, "0")} / {String(n).padStart(2, "0")}
            </div>
            <h2>
              {(current?.name ?? "").split(" ").map((w, i) => (
                <motion.span
                  key={i}
                  initial={{ y: 14, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: 0.12 + i * 0.04 }}
                >
                  {w}&nbsp;
                </motion.span>
              ))}
            </h2>
            <div className="present-meta">
              {count} card{count === 1 ? "" : "s"}
            </div>
          </div>
          <div className="present-strip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
            <div className="present-track" ref={strip}>
              {slides.map((s, i) => (
                <button key={s.id} className={`present-slide${i === index ? " is-current" : ""}`} onClick={() => go(Math.round(sim.current.target) + shortest(i - index, n))}>
                  <span className="present-slide-num">{String(i + 1).padStart(2, "0")}</span>
                  <span className="present-slide-name">{s.name}</span>
                  <span className="present-slide-count">{objectsInSection(s.id).length}</span>
                </button>
              ))}
            </div>
          </div>
          <button className="present-exit f-pill" onClick={() => setUi({ presenting: false })}>
            Exit <span className="f-kbd">esc</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function shortest(d: number, n: number) {
  return ((((d + n / 2) % n) + n) % n) - n / 2;
}

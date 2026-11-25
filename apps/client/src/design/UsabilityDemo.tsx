/**
 * Usability & Contrast specimens for #/design:
 * - Live-measured WCAG 2.2 AA contrast ratios in Day (.f-day) and Night (.f-night)
 * - Baseline :focus-visible ring and .f-pill enabled vs disabled press behaviour
 * - Reduced-motion Spring settlement
 */

import { useEffect, useRef, useState } from "react";
import { Spring, prefersReducedMotion, presets } from "../physics/spring";
import "./usability.css";

const TEXT_TOKENS = ["frost", "mist", "dim", "pulse", "moss", "ok", "warn", "bad", "agent"] as const;
const FILL_TOKENS = ["pulse", "ok", "warn", "bad", "agent"] as const;

type Rgb = [number, number, number];

function parseComputedRgb(raw: string): Rgb | null {
  const nums = raw.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
  if (!nums || nums.length < 3) return null;
  const [a, b, c] = nums.slice(0, 3).map(Number);
  if (raw.startsWith("color(")) {
    return [
      Math.max(0, Math.min(255, a * 255)),
      Math.max(0, Math.min(255, b * 255)),
      Math.max(0, Math.min(255, c * 255)),
    ];
  }
  return [a, b, c];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function ContrastCard({ mode }: { mode: "day" | "night" }) {
  const worstSurface = mode === "day" ? "panel" : "raise";
  const rowsRef = useRef<HTMLDivElement>(null);
  const fillsRef = useRef<HTMLDivElement>(null);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [fillRatios, setFillRatios] = useState<Record<string, number>>({});

  useEffect(() => {
    const rowsEl = rowsRef.current;
    const fillsEl = fillsRef.current;
    if (!rowsEl || !fillsEl) return;
    const bg = parseComputedRgb(getComputedStyle(rowsEl).backgroundColor);
    if (bg) {
      const next: Record<string, number> = {};
      for (const el of rowsEl.querySelectorAll<HTMLElement>("[data-token]")) {
        const fg = parseComputedRgb(getComputedStyle(el).color);
        if (fg && el.dataset.token) next[el.dataset.token] = contrastRatio(fg, bg);
      }
      setRatios(next);
    }
    const nextFills: Record<string, number> = {};
    for (const el of fillsEl.querySelectorAll<HTMLElement>("[data-fill]")) {
      const fg = parseComputedRgb(getComputedStyle(el).color);
      const fill = parseComputedRgb(getComputedStyle(el).backgroundColor);
      if (fg && fill && el.dataset.fill) nextFills[el.dataset.fill] = contrastRatio(fg, fill);
    }
    setFillRatios(nextFills);
  }, [mode]);

  return (
    <div className={`usability-card ${mode === "day" ? "f-day" : "f-night"}`}>
      <div className="usability-card-head">
        <b>{mode === "day" ? "Day (Paper)" : "Night (Graphite)"}</b>
        <span className="usability-card-sub">Worst surface: --color-{worstSurface} · WCAG AA ≥ 4.5:1</span>
      </div>
      <div ref={rowsRef} className={`usability-rows is-${worstSurface}`}>
        {TEXT_TOKENS.map((t) => {
          const r = ratios[t];
          return (
            <div key={t} className="usability-row">
              <span data-token={t} style={{ color: `var(--color-${t})` }}>
                <code>--color-{t}</code> · Sample label
              </span>
              <span className="usability-ratio">{r ? `${r.toFixed(2)}:1 AA` : "—"}</span>
            </div>
          );
        })}
      </div>
      <div ref={fillsRef} className="usability-fills">
        {FILL_TOKENS.map((t) => {
          const r = fillRatios[t];
          return (
            <span key={t} data-fill={t} className="usability-fill-chip" style={{ background: `var(--color-${t})` }}>
              <span>{t}</span>
              <span>{r ? `${r.toFixed(1)}:1` : ""}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function UsabilityDemo() {
  const [springVal, setSpringVal] = useState(0);
  const [springGoal, setSpringGoal] = useState(0);
  const [restless, setRestless] = useState(false);
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  const springRef = useRef<Spring | null>(null);

  useEffect(() => {
    const s = new Spring(0, presets.camera);
    springRef.current = s;
    const off = s.onChange((v) => {
      setSpringVal(v);
      setSpringGoal(s.goal);
      setRestless(s.restless);
    });
    const mq = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    const onMq = () => setReduced(prefersReducedMotion());
    mq?.addEventListener?.("change", onMq);
    return () => {
      off();
      s.set(0);
      mq?.removeEventListener?.("change", onMq);
    };
  }, []);

  const move = () => {
    const s = springRef.current;
    if (!s) return;
    const next = s.goal > 100 ? 0 : 212;
    s.to(next);
    setSpringGoal(s.goal);
    setRestless(s.restless);
  };

  const fling = () => {
    const s = springRef.current;
    if (!s) return;
    const dir = s.value > 106 ? -1 : 1;
    s.fling(dir * 1200);
    setSpringGoal(s.goal);
    setRestless(s.restless);
  };

  const clampedX = Math.max(0, Math.min(212, springVal));

  return (
    <div className="usability-demo">
      <div className="usability-grid">
        <ContrastCard mode="day" />
        <ContrastCard mode="night" />
      </div>

      <div className="usability-grid">
        <div className="usability-panel">
          <span className="f-eyebrow">Focus ring &amp; pill states</span>
          <p>
            Keyboard focus draws a 2px <code>--color-pulse</code> ring with 2px offset (falling back to <code>CanvasText</code> in forced-colors mode).
            Hover lifts only on <code>hover: hover</code> pointers, and disabled pills never press-scale.
          </p>
          <div className="usability-focus-row">
            <span className="usability-focus-ring-sample">Focus ring</span>
            <button type="button" className="f-pill">
              Press (0.97)
            </button>
            <button type="button" className="f-pill is-accent">
              Accent
            </button>
            <button type="button" className="f-pill" disabled>
              Disabled (no scale)
            </button>
            <input className="usability-input" type="text" defaultValue="Tab to inspect ring" aria-label="Focus ring test input" />
          </div>
        </div>

        <div className="usability-panel">
          <span className="f-eyebrow">Reduced-motion springs</span>
          <p>
            <code>Spring.to()</code> and <code>Spring.fling()</code> check <code>prefersReducedMotion()</code>. Under reduced motion, springs snap synchronously
            to their exact final target with zero rAF travel.
          </p>
          <div className="usability-focus-row">
            <div className="usability-motion-track" aria-hidden>
              <div className="usability-motion-dot" style={{ transform: `translate3d(${clampedX}px, 0, 0)` }} />
            </div>
            <button type="button" className="f-pill" onClick={move}>
              Spring.to
            </button>
            <button type="button" className="f-pill" onClick={fling}>
              Spring.fling
            </button>
          </div>
          <div className="usability-readout">
            <span>prefers-reduced-motion: {reduced ? "reduce" : "no-preference"}</span>
            <span>value: {springVal.toFixed(1)}</span>
            <span>goal: {springGoal.toFixed(1)}</span>
            <span>restless: {restless ? "yes" : "no"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

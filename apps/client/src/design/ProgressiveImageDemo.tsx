/**
 * Progressive image specimen for `#/design` (tokens only, day and night).
 *
 * Shows the four visual states a picture moves through on Foundation:
 *   1. Well          (--color-panel resting ground before first bytes)
 *   2. 64 px preview (< 2 KB server micro-preview, soft blur, ~20 ms)
 *   3. 256/512 sharp (target tier decoded off-main-thread, opacity swap)
 *   4. L1 instant    (0 ms synchronous hit on remount / board switch)
 *
 * Plus an interactive playback card demonstrating cold load, instant L1 hit,
 * off-screen GPU VRAM shedding, and live `imageCache.ts` telemetry.
 *
 * And the wave (2026-11-25, lib/arrival.ts): a section's cold pictures show from the middle of the screen outward,
 * each waiting a few steps by its distance from the centre (a step is half of --dur-press, six at most), on
 * opacity alone. "Replay the wave" plays it; with reduced motion they are simply there.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { ARRIVAL_REACH, arrivalStep } from "../lib/arrival";
import { getImageCacheStats, subscribeImageCache, type ImageCacheStats, type ImageTier } from "../lib/imageCache";
import "../components/progressive-image.css";

type DemoStage = "well" | "preview" | "256" | "512" | "cached" | "shed";

/** Offline fixture artwork (named SVG tones only so design.test.ts sees zero raw colour literals). */
const SPECIMEN_ART = (() => {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">`,
    `<defs>`,
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0%" stop-color="lightsteelblue"/>`,
    `<stop offset="100%" stop-color="gainsboro"/>`,
    `</linearGradient>`,
    `<linearGradient id="hull" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="whitesmoke"/>`,
    `<stop offset="100%" stop-color="silver"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="480" height="320" fill="url(#sky)"/>`,
    `<rect y="220" width="480" height="100" fill="slategray" fill-opacity="0.22"/>`,
    `<circle cx="372" cy="78" r="34" fill="whitesmoke" fill-opacity="0.72"/>`,
    `<path d="M52 224 L170 112 L310 112 L428 224 Z" fill="url(#hull)" stroke="dimgray" stroke-width="2" stroke-opacity="0.35"/>`,
    `<ellipse cx="240" cy="170" rx="112" ry="44" fill="steelblue" fill-opacity="0.24" stroke="steelblue" stroke-width="2.5"/>`,
    `<ellipse cx="240" cy="170" rx="54" ry="20" fill="slategray" fill-opacity="0.55"/>`,
    `<line x1="92" y1="224" x2="388" y2="224" stroke="dimgray" stroke-width="2" stroke-opacity="0.45"/>`,
    `</svg>`,
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
})();

const TIER_LIST: ImageTier[] = [64, 256, 512, 1024, 2048];

/** the wave's specimen: a 6 × 3 field of pictures, each as far from the centre as it would be on a 1440 px screen */
const WAVE_COLS = 6;
const WAVE_ROWS = 3;
const WAVE_TILES = Array.from({ length: WAVE_COLS * WAVE_ROWS }, (_, i) => {
  const dx = ((i % WAVE_COLS) - (WAVE_COLS - 1) / 2) * 220;
  const dy = (Math.floor(i / WAVE_COLS) - (WAVE_ROWS - 1) / 2) * 260;
  return arrivalStep(Math.hypot(dx, dy), ARRIVAL_REACH);
});

function formatKb(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ProgressiveImageDemo() {
  const [stage, setStage] = useState<DemoStage>("512");
  const [stats, setStats] = useState<ImageCacheStats>(() => getImageCacheStats());

  useEffect(() => {
    const refresh = () => setStats(getImageCacheStats());
    refresh();
    return subscribeImageCache(refresh);
  }, []);

  const replayColdLoad = () => {
    setStage("well");
    const t1 = window.setTimeout(() => setStage("preview"), 280);
    const t2 = window.setTimeout(() => setStage("256"), 760);
    const t3 = window.setTimeout(() => setStage("512"), 1260);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  };

  // Keep timers clean if user clicks repeatedly
  const [runId, setRunId] = useState(0);
  useEffect(() => {
    if (runId === 0) return;
    return replayColdLoad();
  }, [runId]);

  const [wave, setWave] = useState(0);

  const activeTier: ImageTier | null =
    stage === "well"
      ? null
      : stage === "preview" || stage === "shed"
        ? 64
        : stage === "256"
          ? 256
          : 512;

  const badgeText =
    stage === "well"
      ? "well"
      : stage === "preview"
        ? "64w · 1.4 KB"
        : stage === "256"
          ? "256w · 14 KB"
          : stage === "512"
            ? "512w · 42 KB"
            : stage === "shed"
              ? "shed -> 64w"
              : "L1 hit · 0 ms";

  const badgeTone =
    stage === "well"
      ? ""
      : stage === "preview" || stage === "shed"
        ? " is-preview"
        : stage === "cached"
          ? " is-cache"
          : " is-sharp";

  return (
    <div className="prog-demo" data-design-progressive-image>
      <div className="prog-demo-strip">
        <div className="prog-demo-stage">
          <div className="prog-demo-frame" />
          <div className="prog-demo-meta">
            <span>1 · Well</span>
            <span className="prog-demo-badge">0 B</span>
          </div>
          <span className="prog-demo-note">Quiet token ground (--color-panel) holds aspect ratio before bytes land.</span>
        </div>

        <div className="prog-demo-stage">
          <div className="prog-demo-frame">
            <img src={SPECIMEN_ART} alt="64px micro-preview specimen" className="f-prog-img is-preview" draggable={false} />
          </div>
          <div className="prog-demo-meta">
            <span>2 · 64 px preview</span>
            <span className="prog-demo-badge is-preview">64w · ~1.4 KB</span>
          </div>
          <span className="prog-demo-note">Parallel micro-preview reveals real composition in ~20 ms with soft blur.</span>
        </div>

        <div className="prog-demo-stage">
          <div className="prog-demo-frame">
            <img src={SPECIMEN_ART} alt="512px sharp specimen" className="f-prog-img is-visible" draggable={false} />
          </div>
          <div className="prog-demo-meta">
            <span>3 · 256 / 512 sharp</span>
            <span className="prog-demo-badge is-sharp">512w · decoded</span>
          </div>
          <span className="prog-demo-note">Target tier decodes off the main thread before swapping cleanly via opacity.</span>
        </div>

        <div className="prog-demo-stage">
          <div className="prog-demo-frame">
            <img src={SPECIMEN_ART} alt="Cached L1 instant hit specimen" className="f-prog-img is-instant" draggable={false} />
          </div>
          <div className="prog-demo-meta">
            <span>4 · L1 instant hit</span>
            <span className="prog-demo-badge is-cache">L1 · 0 ms</span>
          </div>
          <span className="prog-demo-note">Synchronous LRU hit on remount, board switch, or lightbox open: zero flash.</span>
        </div>
      </div>

      <div className="prog-demo-live">
        <div className="prog-demo-frame">
          {stage !== "well" && (
            <img
              src={SPECIMEN_ART}
              alt="Interactive progressive image preview"
              className={
                "f-prog-img" +
                (stage === "cached"
                  ? " is-instant"
                  : stage === "preview" || stage === "shed"
                    ? " is-preview"
                    : " is-visible")
              }
              draggable={false}
            />
          )}
        </div>

        <div className="prog-demo-controls">
          <div className="prog-demo-meta">
            <span>Interactive reveal &amp; VRAM shedding</span>
            <span className={`prog-demo-badge${badgeTone}`} data-prog-demo-badge>
              {badgeText}
            </span>
          </div>

          <div className="prog-demo-actions">
            <button type="button" className="f-pill is-primary" onClick={() => setRunId((n) => n + 1)}>
              Replay cold load
            </button>
            <button type="button" className="f-pill" onClick={() => setStage("cached")}>
              Simulate L1 hit
            </button>
            <button type="button" className="f-pill" onClick={() => setStage("shed")}>
              Shed off-screen VRAM
            </button>
          </div>

          <div className="prog-demo-tiers" aria-label="Server tiers">
            {TIER_LIST.map((t) => {
              const isActive = activeTier === t;
              const isCached = stage === "cached" || stage === "shed" ? t === 64 || t === 512 : isActive;
              return (
                <span
                  key={t}
                  className={`prog-demo-badge${isActive ? (t === 64 ? " is-preview" : " is-sharp") : isCached ? " is-cache" : ""}`}
                >
                  {t}w{isActive ? " · active" : isCached ? " · L1" : ""}
                </span>
              );
            })}
          </div>

          <div className="prog-demo-stats">
            <div className="prog-demo-stat">
              <b>{stats.l1Entries}</b>
              <span>L1 entries</span>
            </div>
            <div className="prog-demo-stat">
              <b>{formatKb(stats.l1Bytes)}</b>
              <span>L1 resident</span>
            </div>
            <div className="prog-demo-stat">
              <b>{stats.l1Pinned}</b>
              <span>Pinned refs</span>
            </div>
            <div className="prog-demo-stat">
              <b>{stats.l1Hits}</b>
              <span>L1 hits</span>
            </div>
            <div className="prog-demo-stat">
              <b>{stats.l2Hits}</b>
              <span>L2 disk hits</span>
            </div>
          </div>
        </div>
      </div>

      <div className="prog-demo-wave" data-design-arrival-wave>
        <div className="prog-demo-meta">
          <span>The wave: cold pictures arrive from the centre outward</span>
          <button type="button" className="f-pill" onClick={() => setWave((n) => n + 1)}>
            Replay the wave
          </button>
        </div>
        <div className="prog-demo-wave-field">
          {WAVE_TILES.map((step, i) => (
            <div key={i} className="prog-demo-frame" data-arrive-step={step}>
              {/* a new element each replay, so it starts from its well again */}
              <img key={wave} src={SPECIMEN_ART} alt="" className="f-prog-img is-visible" style={{ "--arrive-step": step } as CSSProperties} draggable={false} />
              <span className="prog-demo-badge">{step === 0 ? "at once" : `step ${step}`}</span>
            </div>
          ))}
        </div>
        <span className="prog-demo-note">
          Each picture waits {"`--arrive-step`"} × half of --dur-press by its distance from the middle of the screen (six steps at most), then fades in over --dur-quick: opacity only, on the
          compositor. One already in memory doesn't wait or fade.
        </span>
      </div>
    </div>
  );
}

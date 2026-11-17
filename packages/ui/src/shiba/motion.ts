/**
 * @pacific/ui/motion — the physics of the design language (ADR-013).
 *
 * Three things live here, shared by the Archive and Vision so a card behaves
 * the same on `/design` as it does on the flow canvas:
 *
 * 1. `physicality` — the named amounts: how far a sheet lifts, how far a card
 *    tilts under the pointer, how much a held card grows. `/design` §05 renders
 *    this table from the object, so the page and the product cannot drift.
 * 2. `Spring` / `Spring2D` / `presets` — the spring engine Vision's cards and
 *    camera run on (moved here from `apps/vision/src/physics/spring.ts`). All
 *    springs share one rAF loop and write straight to subscribers (normally
 *    DOM styles) — no React re-render on the hot path.
 * 3. `probeMotion` / `measureRefreshRate` — the motion budget: what this device
 *    can carry (`full` | `lite` | `still`). Every effect asks before it runs;
 *    reduced-motion users get a still page, machines without WebGL2 get CSS.
 *
 * No DOM at import time: this file is safe under Vitest's node environment.
 */

// ---------- physicality: the named amounts ----------

/** The amounts every physical interaction uses. Units in the comments. */
export const physicality = {
  /** a rolled-over sheet lifts this far off the desk (px) */
  lift: 4,
  /** glass is already floating, so it lifts less (px) */
  liftGlass: 2,
  /** a pressed control shrinks to this scale */
  press: 0.985,
  /** …and settles back in this long (ms) */
  pressMs: 80,
  /** the most a card tilts under the pointer (degrees, per axis) */
  tilt: 2.5,
  /** the camera distance the tilt is seen from (px) */
  perspective: 1100,
  /** a held card grows to this scale while it is carried */
  hold: 1.03,
  /** a carried card leans into its motion by at most this much (degrees) */
  leanMax: 6,
  /** …at this many degrees per px/s of pointer velocity */
  leanPerVelocity: 0.008,
  /** a new card pops in from this scale */
  popFrom: 0.6,
  /** a figure glides to its new value over this long (ms) */
  glideMs: 650,
  /** lanes: a wire's pulse travels this many px per second */
  laneFlow: 40,
  /** neighboring port rows move aside while a connection pill is open (px) */
  junctionSpread: 6,
} as const;

// ---------- the spring engine ----------

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  /** below these thresholds the spring snaps to target and sleeps */
  restDelta: number;
  restSpeed: number;
}

/** The four springs the interface is built from. */
export const presets = {
  /** camera pan/zoom — tight, quick settle */
  camera: { stiffness: 170, damping: 26, mass: 1, restDelta: 0.01, restSpeed: 0.01 },
  /** entrances and tilt — bouncy, physical */
  pop: { stiffness: 260, damping: 20, mass: 1, restDelta: 0.001, restSpeed: 0.001 },
  /** drag follow — a heavy object on a stiff tether */
  drag: { stiffness: 550, damping: 38, mass: 1, restDelta: 0.01, restSpeed: 0.01 },
  /** gentle ambient drift and the drag lean */
  soft: { stiffness: 90, damping: 22, mass: 1, restDelta: 0.01, restSpeed: 0.01 },
} satisfies Record<string, SpringConfig>;

export type PresetName = keyof typeof presets;

/** Canvas owns modifier-wheel (including trackpad pinch); nested panels own ordinary scroll.
 * Capture before React/OrbitControls can swallow the event, with a non-passive listener so
 * WebView/browser page zoom never competes with the canvas. Chrome keeps its own gestures.
 */
export function attachCanvasWheel(
  element: HTMLElement,
  handlers: {
    zoom: (factor: number, clientX: number, clientY: number) => void;
    pan: (dx: number, dy: number) => void;
  },
) {
  const wheel = (event: WheelEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !element.contains(target)) return;
    if (target?.closest(".canvas-dock, [data-canvas-chrome]")) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (
      !modifier &&
      target?.closest(".node-scroll, .reconstruction-scroll, textarea, [data-canvas-scroll]")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    // Wheel devices report pixels, lines or pages. Convert once, before applying either gesture.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
    const dx = event.deltaX * unit,
      dy = event.deltaY * unit;
    if (modifier)
      handlers.zoom(
        Math.exp(-Math.max(-600, Math.min(600, dy)) * 0.0022),
        event.clientX,
        event.clientY,
      );
    else handlers.pan(dx, dy);
  };
  // A modal dialog lives in the top layer. Chromium can mark its wheel events
  // non-cancelable when only a transformed ancestor registers a listener.
  // Register at the document, but handle only this canvas's descendants.
  const document = element.ownerDocument;
  document.addEventListener("wheel", wheel, { capture: true, passive: false });
  return () => document.removeEventListener("wheel", wheel, true);
}

type Listener = (value: number) => void;

const active = new Set<Spring>();
let rafId: number | null = null;
let backupId: ReturnType<typeof setTimeout> | null = null;
let scheduled = false;
let lastTime = 0;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function onFrame(t: number) {
  scheduled = false;
  if (rafId !== null) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (backupId !== null) {
    clearTimeout(backupId);
    backupId = null;
  }
  const dt = Math.min((t - lastTime) / 1000, 1 / 20); // clamp to avoid tab-suspend blowups
  lastTime = t;
  for (const s of active) s.step(dt);
  if (active.size > 0) schedule();
}

/**
 * Prefer rAF, but arm a setTimeout backup: when the window is hidden or
 * occluded the compositor suppresses rAF entirely, and springs would
 * otherwise freeze mid-flight. Without rAF at all (tests) the backup drives.
 */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  if (typeof requestAnimationFrame === "function") rafId = requestAnimationFrame(onFrame);
  backupId = setTimeout(() => onFrame(now()), 64);
}

function wake(spring: Spring) {
  active.add(spring);
  if (!scheduled) {
    lastTime = now();
    schedule();
  }
}

/** How many springs are awake right now (the design page shows this). */
export function activeSprings(): number {
  return active.size;
}

export class Spring {
  private current: number;
  private velocity = 0;
  private target: number;
  private config: SpringConfig;
  private listeners = new Set<Listener>();

  constructor(initial: number, config: SpringConfig = presets.camera) {
    this.current = initial;
    this.target = initial;
    this.config = config;
  }

  get value() {
    return this.current;
  }

  get goal() {
    return this.target;
  }

  get speed() {
    return this.velocity;
  }

  get restless() {
    return active.has(this);
  }

  setConfig(config: SpringConfig) {
    this.config = config;
  }

  /** animate toward a new target, preserving current velocity */
  to(target: number, velocity?: number) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    wake(this);
  }

  /** jump instantly (e.g. while actively dragging) */
  set(value: number) {
    this.current = value;
    this.target = value;
    this.velocity = 0;
    active.delete(this);
    this.emit();
  }

  /** throw with velocity, target = wherever it lands (decay-style) */
  fling(velocity: number) {
    this.velocity = velocity;
    // project a resting point from current velocity for a natural glide
    const projected = this.current + velocity / (this.config.damping * 0.9);
    this.target = projected;
    wake(this);
  }

  nudgeVelocity(v: number) {
    this.velocity += v;
    wake(this);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** advance by `dt` seconds; exposed so tests and offline traces can drive a spring by hand */
  step(dt: number) {
    const { stiffness, damping, mass, restDelta, restSpeed } = this.config;
    // semi-implicit Euler with sub-stepping for stability at high stiffness
    const steps = Math.ceil(dt / (1 / 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const displacement = this.current - this.target;
      const springForce = -stiffness * displacement;
      const dampingForce = -damping * this.velocity;
      const accel = (springForce + dampingForce) / mass;
      this.velocity += accel * h;
      this.current += this.velocity * h;
    }
    if (Math.abs(this.current - this.target) < restDelta && Math.abs(this.velocity) < restSpeed) {
      this.current = this.target;
      this.velocity = 0;
      active.delete(this);
    }
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn(this.current);
  }
}

/** A 2D spring pair with a single combined onChange, handy for cameras/positions. */
export class Spring2D {
  readonly x: Spring;
  readonly y: Spring;
  private listeners = new Set<(x: number, y: number) => void>();

  constructor(ix: number, iy: number, config: SpringConfig = presets.camera) {
    this.x = new Spring(ix, config);
    this.y = new Spring(iy, config);
    this.x.onChange(() => this.emit());
    this.y.onChange(() => this.emit());
  }

  to(x: number, y: number) {
    this.x.to(x);
    this.y.to(y);
  }

  set(x: number, y: number) {
    this.x.set(x);
    this.y.set(y);
  }

  fling(vx: number, vy: number) {
    this.x.fling(vx);
    this.y.fling(vy);
  }

  setConfig(c: SpringConfig) {
    this.x.setConfig(c);
    this.y.setConfig(c);
  }

  onChange(fn: (x: number, y: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.x.value, this.y.value);
  }
}

/**
 * Trace a spring's response offline: from `from` to `to`, sampled every
 * `dt` seconds until it rests or `maxSeconds` pass. The design page draws
 * these curves; tests check the presets behave (no runaway, settles).
 */
export function traceSpring(
  config: SpringConfig,
  from: number,
  to: number,
  dt = 1 / 120,
  maxSeconds = 4,
): { samples: number[]; settleMs: number; overshoot: number } {
  const s = new Spring(from, config);
  const samples: number[] = [from];
  s.to(to);
  active.delete(s); // never let a trace hit the shared loop
  let overshoot = 0;
  let t = 0;
  while (t < maxSeconds) {
    s.step(dt);
    active.delete(s);
    t += dt;
    samples.push(s.value);
    const past = to >= from ? s.value - to : to - s.value;
    if (past > overshoot) overshoot = past;
    if (s.value === to && s.speed === 0) break;
  }
  return { samples, settleMs: Math.round(t * 1000), overshoot };
}

// ---------- the motion budget ----------

/** What this device can carry. */
export type MotionBudget =
  /** shaders, particles and springs */
  | "full"
  /** CSS motion and springs; no WebGL surfaces */
  | "lite"
  /** the user asked for reduced motion: everything settles instantly, nothing drifts */
  | "still";

export interface MotionProbe {
  budget: MotionBudget;
  reducedMotion: boolean;
  webgl2: boolean;
  /** the GPU/driver string when the browser will say (`WEBGL_debug_renderer_info`) */
  renderer: string | null;
  /** true when the renderer looks like a software rasteriser (SwiftShader, llvmpipe) */
  software: boolean;
  dpr: number;
  /** why the budget is what it is, in words */
  reason: string;
}

const SOFTWARE = /swiftshader|llvmpipe|software|microsoft basic render/i;

/**
 * Probe once at start-up (cheap: one throwaway WebGL2 context). Pass a
 * `canvas` factory in tests. Safe without a DOM — returns `lite`.
 */
export function probeMotion(opts: { createCanvas?: () => HTMLCanvasElement } = {}): MotionProbe {
  const reducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  let webgl2 = false;
  let renderer: string | null = null;
  try {
    const canvas = opts.createCanvas
      ? opts.createCanvas()
      : typeof document !== "undefined"
        ? document.createElement("canvas")
        : null;
    const gl = canvas?.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
    if (gl) {
      webgl2 = true;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* no WebGL here */
  }
  const software = renderer !== null && SOFTWARE.test(renderer);
  let budget: MotionBudget = "full";
  let reason = "WebGL2 on a hardware renderer";
  if (reducedMotion) {
    budget = "still";
    reason = "prefers-reduced-motion is on";
  } else if (!webgl2) {
    budget = "lite";
    reason = "no WebGL2 context";
  } else if (software) {
    budget = "lite";
    reason = "software rasteriser";
  }
  return { budget, reducedMotion, webgl2, renderer, software, dpr, reason };
}

/** Estimate the display's refresh rate from `frames` consecutive rAF ticks (60, 120, 144…). */
export function measureRefreshRate(frames = 40): Promise<number> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") return resolve(60);
    const times: number[] = [];
    const tick = (t: number) => {
      times.push(t);
      if (times.length <= frames) return requestAnimationFrame(tick);
      const deltas = times
        .slice(1)
        .map((t, i) => t - times[i])
        .sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      resolve(median > 0 ? Math.round(1000 / median) : 60);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Holds a WebGL surface at its frame rate by trading resolution: fed each frame's interval, it steps the pixel ratio
 * down a quarter when frames run long, and back up after a long calm — never straight back to a ratio that just
 * failed, so it doesn't flap. A frame of more than a quarter second (a hidden tab, a stall) is ignored.
 */
export class FrameGovernor {
  /** the pixel ratio to render at */
  ratio: number;
  private avg: number;
  private since = 0;
  private calm = 0;
  /** a ratio that ran long, and when (in frames fed) it may be tried again */
  private failed = Infinity;
  private retryAt = 0;
  private n = 0;
  constructor(
    readonly max: number,
    readonly min = 1,
    /** the frame time to hold, ms (60 fps by default) */
    readonly budget = 1000 / 60,
  ) {
    this.ratio = Math.max(min, max);
    this.avg = budget;
  }
  /** Feed one frame's interval (ms); returns the ratio to render at, which changes seldom. */
  frame(ms: number): number {
    if (!(ms > 0) || ms > 250) return this.ratio;
    this.n++;
    this.since++;
    this.avg += (ms - this.avg) * 0.08;
    if (this.since < 45) return this.ratio;
    if (this.avg > this.budget * 1.2 && this.ratio > this.min) {
      this.failed = this.ratio;
      this.retryAt = this.n + 60 * 30;
      this.ratio = Math.max(this.min, +(this.ratio - 0.25).toFixed(2));
      this.since = 0;
      this.calm = 0;
      this.avg = this.budget;
      return this.ratio;
    }
    this.calm = this.avg < this.budget * 1.08 ? this.calm + 1 : 0;
    const next = Math.min(this.max, +(this.ratio + 0.25).toFixed(2));
    if (this.calm > 360 && next > this.ratio && (next < this.failed || this.n >= this.retryAt)) {
      this.ratio = next;
      this.since = 0;
      this.calm = 0;
    }
    return this.ratio;
  }
}

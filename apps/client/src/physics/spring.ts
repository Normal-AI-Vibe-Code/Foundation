/**
 * Minimal high-performance spring physics engine.
 *
 * All springs share one rAF loop and write straight to subscribers
 * (usually DOM styles) — zero React re-renders on the hot path.
 */

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  /** below these thresholds the spring snaps to target and sleeps */
  restDelta: number;
  restSpeed: number;
}

export const presets = {
  /** camera pan/zoom — tight, quick settle */
  camera: { stiffness: 170, damping: 26, mass: 1, restDelta: 0.01, restSpeed: 0.01 },
  /** table entrance — bouncy, physical */
  pop: { stiffness: 260, damping: 20, mass: 1, restDelta: 0.001, restSpeed: 0.001 },
  /** drag follow — heavy object on a stiff tether */
  drag: { stiffness: 550, damping: 38, mass: 1, restDelta: 0.01, restSpeed: 0.01 },
  /** gentle ambient drift */
  soft: { stiffness: 90, damping: 22, mass: 1, restDelta: 0.01, restSpeed: 0.01 },
} satisfies Record<string, SpringConfig>;

type Listener = (value: number) => void;

/** True when the user asked for reduced motion; safe in Node tests without window/matchMedia. */
export function prefersReducedMotion(): boolean {
  const mm =
    (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia.bind(window)) ||
    (typeof globalThis !== "undefined" && typeof (globalThis as { matchMedia?: unknown }).matchMedia === "function"
      ? (globalThis as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia.bind(globalThis)
      : null);
  if (!mm) return false;
  try {
    return Boolean(mm("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

const active = new Set<Spring>();
let rafId: number | null = null;
let backupId: ReturnType<typeof setTimeout> | null = null;
let scheduled = false;
let lastTime = 0;

function clearScheduled() {
  scheduled = false;
  if (rafId !== null) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (backupId !== null) {
    clearTimeout(backupId);
    backupId = null;
  }
}

function onFrame(now: number) {
  clearScheduled();
  const dt = Math.min((now - lastTime) / 1000, 1 / 20); // clamp to avoid tab-suspend blowups
  lastTime = now;
  for (const s of active) s.step(dt);
  if (active.size > 0) schedule();
}

/**
 * Prefer rAF, but arm a setTimeout backup: when the window is hidden or
 * occluded the compositor suppresses rAF entirely, and springs would
 * otherwise freeze mid-flight.
 */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  if (typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(onFrame);
  }
  backupId = setTimeout(() => onFrame(performance.now()), 64);
}

function wake(spring: Spring) {
  active.add(spring);
  if (!scheduled) {
    lastTime = performance.now();
    schedule();
  }
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

  get restless() {
    return active.has(this);
  }

  setConfig(config: SpringConfig) {
    this.config = config;
  }

  /** animate toward a new target, preserving current velocity */
  to(target: number, velocity?: number) {
    if (prefersReducedMotion()) {
      this.set(target);
      return;
    }
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
    if (active.size === 0) clearScheduled();
    this.emit();
  }

  /** throw with velocity, target = wherever it lands (decay-style) */
  fling(velocity: number) {
    // project a resting point from current velocity for a natural glide
    const projected = this.current + velocity / (this.config.damping * 0.9);
    if (prefersReducedMotion()) {
      this.set(projected);
      return;
    }
    this.velocity = velocity;
    this.target = projected;
    wake(this);
  }

  nudgeVelocity(v: number) {
    if (prefersReducedMotion()) {
      this.set(this.target);
      return;
    }
    this.velocity += v;
    wake(this);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

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
    if (
      Math.abs(this.current - this.target) < restDelta &&
      Math.abs(this.velocity) < restSpeed
    ) {
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

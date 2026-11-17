/**
 * The grid camera, published for overlays (peer cursors, the agent layer,
 * presentation mode) without React re-renders: GridViewport writes here on
 * every camera frame; overlays subscribe and write styles directly.
 */

export interface Camera {
  x: number;
  y: number;
  scale: number;
  /** viewport rect in client coords */
  left: number;
  top: number;
  width: number;
  height: number;
}

export const camera: Camera = { x: 0, y: 0, scale: 0.5, left: 0, top: 0, width: 0, height: 0 };
const camListeners = new Set<(c: Camera) => void>();

// The viewport's rect is measured when it changes (a ResizeObserver, and window resizes), never per camera
// frame: reading it on every frame forced a layout of the whole board each time (≈390 ms of a pane opening
// on a 200-card board, measured in e2e/frames.spec.ts).
let tracked: HTMLElement | null = null;
let untrack = () => {};
function measureViewport(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  camera.left = r.left;
  camera.top = r.top;
  camera.width = r.width;
  camera.height = r.height;
}
function track(el: HTMLElement) {
  untrack();
  tracked = el;
  measureViewport(el);
  const remeasure = () => {
    if (tracked !== el) return;
    measureViewport(el);
    for (const fn of camListeners) fn(camera);
  };
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
  ro?.observe(el);
  window.addEventListener("resize", remeasure);
  untrack = () => {
    ro?.disconnect();
    window.removeEventListener("resize", remeasure);
    tracked = null;
  };
}

export function publishCamera(x: number, y: number, scale: number, el: HTMLElement | null) {
  camera.x = x;
  camera.y = y;
  camera.scale = scale;
  if (el && el !== tracked) track(el);
  for (const fn of camListeners) fn(camera);
}

export function onCamera(fn: (c: Camera) => void) {
  camListeners.add(fn);
  return () => {
    camListeners.delete(fn);
  };
}

/** viewport-local px → grid world px */
export function toWorld(vx: number, vy: number) {
  return { x: (vx - camera.x) / camera.scale, y: (vy - camera.y) / camera.scale };
}

// ---------- local pointer, in world coords (throttled for awareness) ----------

const ptrListeners = new Set<(p: { x: number; y: number } | null) => void>();
let lastSent = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let latest: { x: number; y: number } | null = null;

export function publishPointer(vx: number | null, vy: number | null) {
  latest = vx === null || vy === null ? null : toWorld(vx, vy);
  const now = performance.now();
  const flush = () => {
    pending = null;
    lastSent = performance.now();
    for (const fn of ptrListeners) fn(latest);
  };
  if (now - lastSent > 50) flush();
  else if (!pending) pending = setTimeout(flush, 50 - (now - lastSent));
}

export function onPointer(fn: (p: { x: number; y: number } | null) => void) {
  ptrListeners.add(fn);
  return () => {
    ptrListeners.delete(fn);
  };
}

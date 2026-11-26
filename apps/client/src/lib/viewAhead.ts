/**
 * Loading for where the camera is going (2026-11-25). A zoom or a glide is a spring: the moment a wheel tick, a
 * pinch or a key sets its goal, GridViewport knows the view it will land on. Pictures used to wait to be within a
 * screen of the *current* view (an IntersectionObserver with a 100 % margin), so zooming out by more than 3× brought
 * in cards that had not started, or had shed to their 64 px copy, and they arrived blurred and then focused: the
 * flicker. Here a card is "ahead" when it is in the view the camera is heading for (plus half a view around it), so
 * its level starts loading as the gesture begins, not after it lands.
 *
 * One pass for all cards: their rects are read together, at most every AHEAD_MS while the camera moves, and only the
 * cards whose answer changed are told. The board only moves by transform, so reading rects forces no layout.
 */

import { camera, onCamera } from "../state/camera";

/** where the camera's springs are heading (GridViewport writes it with every camera frame) */
export const cameraGoal = { x: 0, y: 0, scale: 0.5, set: false };
/** when the camera last moved (performance.now()) */
let movedAt = 0;
/** how often (ms) the ahead pass runs while the camera moves */
export const AHEAD_MS = 90;
/** how much of the view around it counts as ahead (0.5: half a view on each side) */
export const AHEAD_MARGIN = 0.5;
/** the camera is calm once it hasn't moved for this long: a picture may then drop to a smaller level */
export const CALM_MS = 320;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The client-space rect, on the screen as it is drawn now, of the union of the view now and the view the camera is
 * heading for, grown by `margin` of its size on each side. Pure.
 * `view`: the viewport's client rect; `now` and `goal`: camera {x, y, scale} (screen = world × scale + x).
 */
export function aheadRect(
  view: { left: number; top: number; width: number; height: number },
  now: { x: number; y: number; scale: number },
  goal: { x: number; y: number; scale: number },
  margin = AHEAD_MARGIN,
): Rect {
  // the goal's viewport corners (viewport-local) → world → today's viewport-local
  const k = now.scale / (goal.scale || now.scale || 1);
  const gx0 = (0 - goal.x) * k + now.x;
  const gy0 = (0 - goal.y) * k + now.y;
  const gx1 = (view.width - goal.x) * k + now.x;
  const gy1 = (view.height - goal.y) * k + now.y;
  const x0 = Math.min(0, gx0);
  const y0 = Math.min(0, gy0);
  const x1 = Math.max(view.width, gx1);
  const y1 = Math.max(view.height, gy1);
  const mx = (x1 - x0) * margin;
  const my = (y1 - y0) * margin;
  return { left: view.left + x0 - mx, top: view.top + y0 - my, right: view.left + x1 + mx, bottom: view.top + y1 + my };
}

export function intersects(a: Rect, b: DOMRectReadOnly | Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** the camera's goal: called by GridViewport with every camera frame */
export function publishGoal(x: number, y: number, scale: number) {
  if (cameraGoal.set && cameraGoal.x === x && cameraGoal.y === y && cameraGoal.scale === scale) return;
  cameraGoal.x = x;
  cameraGoal.y = y;
  cameraGoal.scale = scale;
  cameraGoal.set = true;
  schedule();
}

/** true when the camera hasn't moved for CALM_MS */
export function cameraCalm(now = performance.now()): boolean {
  return now - movedAt >= CALM_MS;
}

/** the larger of the scale now and the scale the camera is heading for: a zoom in loads for where it lands */
export function aheadScale(): number {
  return cameraGoal.set ? Math.max(camera.scale, cameraGoal.scale) : camera.scale;
}

// ---------- the registry: one pass for every card ----------

interface Watch {
  el: HTMLElement;
  ahead: boolean;
  fn: (ahead: boolean) => void;
}
const watches = new Set<Watch>();
let timer = 0;
let lastPass = 0;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  onCamera(() => {
    movedAt = performance.now();
    schedule();
  });
}

function schedule() {
  if (timer || !watches.size) return;
  const wait = Math.max(0, AHEAD_MS - (performance.now() - lastPass));
  timer = window.setTimeout(() => {
    timer = 0;
    pass();
  }, wait);
}

function pass() {
  lastPass = performance.now();
  if (!camera.width || !camera.height) return;
  const r = aheadRect(camera, camera, cameraGoal.set ? cameraGoal : camera);
  const changed: Watch[] = [];
  for (const w of watches) {
    if (!w.el.isConnected) continue;
    const a = intersects(r, w.el.getBoundingClientRect());
    if (a !== w.ahead) {
      w.ahead = a;
      changed.push(w);
    }
  }
  for (const w of changed) w.fn(w.ahead);
}

/** tell `fn` whenever `el` comes ahead of the camera or leaves it; returns a stop */
export function watchAhead(el: HTMLElement, fn: (ahead: boolean) => void): () => void {
  listen();
  const w: Watch = { el, ahead: false, fn };
  watches.add(w);
  // its first answer in the next pass
  schedule();
  return () => {
    watches.delete(w);
  };
}

/** for tests: run the pass now */
export function runAheadPass() {
  clearTimeout(timer);
  timer = 0;
  pass();
}

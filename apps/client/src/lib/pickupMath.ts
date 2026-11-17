/**
 * The numbers behind holding search results (lib/pickup.ts), kept pure so they're
 * tested without a pointer (test/pickup.test.ts).
 *
 * A held result is a small card in the hand: it follows on the drag spring,
 * lifted 2.5 % and leaning at most 2.5° into its motion (DESIGN §1: physical, a
 * little, not a ton). Several held at once are a stack: the top card leads, the
 * ones under it are fanned a few degrees and follow on looser springs, so the
 * stack trails behind the hand and gathers when it stops. Let go over the grid
 * and they're dealt out, each a step down and to the right of the last.
 */
import type { SpringConfig } from "../physics/spring";

/** how far a held card leans into its motion, at most (degrees): the same as a carried card's */
export const MAX_LEAN = 2.5;
/** the most cards drawn in a held stack; the rest are in the count */
export const STACK_SHOWN = 3;
/** a paper card (anything without a picture) */
export const PAPER = { w: 232, h: 56 };
/** a picture card's width; its height follows the picture, within reason */
export const PICTURE_W = 176;

/** the next lean, eased toward the pointer's sideways speed (px/ms) */
export function leanToward(lean: number, vx: number): number {
  const want = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, vx * 2));
  return lean * 0.8 + want * 0.2;
}

/** how card `i` of a stack sits under the top one: turned a little, a few px down and across */
export function fan(i: number): { rotate: number; dx: number; dy: number } {
  if (i <= 0) return { rotate: 0, dx: 0, dy: 0 };
  const side = i % 2 ? -1 : 1;
  return { rotate: side * (3 + i), dx: side * 5 * i, dy: 5 * i };
}

/** the spring card `i` follows on: the top card on `lead`, each one under it looser, so the stack trails */
export function trail(lead: SpringConfig, i: number): SpringConfig {
  if (i <= 0) return lead;
  return { ...lead, stiffness: lead.stiffness / (1 + i * 0.9), damping: lead.damping / (1 + i * 0.45) };
}

/** where the `i`th of several dealt cards lands, in screen px from the first: a step down and across, wrapping after six */
export function deal(i: number): { dx: number; dy: number } {
  const col = Math.floor(i / 6);
  const row = i % 6;
  return { dx: row * 28 + col * 260, dy: row * 28 };
}

/** a picture card's size for a picture of this shape (tall and wide ones are held to a sane card) */
export function pictureSize(naturalW: number, naturalH: number): { w: number; h: number } {
  const ratio = naturalW > 0 && naturalH > 0 ? naturalH / naturalW : 0.75;
  return { w: PICTURE_W, h: Math.round(PICTURE_W * Math.max(0.5, Math.min(1.4, ratio))) };
}

/** where in the held card the hand is, keeping the same relative spot it pressed in the row or tile */
export function grabPoint(press: { x: number; y: number }, from: { left: number; top: number; width: number; height: number }, card: { w: number; h: number }): { x: number; y: number } {
  const fx = from.width > 0 ? (press.x - from.left) / from.width : 0.5;
  const fy = from.height > 0 ? (press.y - from.top) / from.height : 0.5;
  const clamp = (v: number) => Math.max(0.08, Math.min(0.92, v));
  return { x: Math.round(clamp(fx) * card.w), y: Math.round(clamp(fy) * card.h) };
}

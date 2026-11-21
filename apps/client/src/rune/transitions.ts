/**
 * What moves when Rune is handed a new board, and what just lands.
 *
 * Rune springs anything that changed between two views unless it's told not
 * to, and left to itself it eased whatever arrived while the pointer was
 * moving: the floor's cut sliding after a pane that has its own motion,
 * one board's sections morphing into another's. Motion on the board has an
 * owner, so every scene goes to Rune with one of two words, decided here by
 * these rules, the first that applies:
 *
 *  1. **Another board lands.** A different board, or a section opened as its
 *     own grid (or closed again): nothing of one becomes the other.
 *  2. **The floor lands.** A pane opening, closing or being resized, the top
 *     bar, the window: the pane moves on the web's own motion and the camera
 *     reframes on its springs. Rune's cut follows at once, it doesn't chase.
 *  3. **What a hand just did through Rune settles.** A card or a section let
 *     go, a tool pressed on Rune's own toolbar, a section made in an empty
 *     cell: the next board eases to rest (the let-go card comes down, the
 *     section travels to its cell). Only that one board, and only if it
 *     arrives straight away.
 *  4. **A change of look eases.** Day and night, the selection, a question
 *     asked on a section: nothing changed place, so colours and what appears
 *     ride Rune's springs.
 *  5. **Everything else lands.** Places and sizes that arrive from the store
 *     (someone else's edit, an agent's card, a track being dragged, a card
 *     being resized, text being typed) are already where they should be.
 *
 * The camera is not a scene: pan, zoom and framing are the client's springs
 * for both engines (state/camera.ts), handed over each frame. What Rune
 * answers by itself (hover chrome, a press, the lift of a held card) stays its
 * own. Pure, so it can be held to (test/rune-transitions.test.ts).
 */

import type { Scene } from "./scene";

export type SceneMotion = "instant" | "animated";
export type MotionRule = "first" | "board" | "floor" | "hand" | "look" | "lands";

export interface MotionCause {
  /** which board this is: the board's id and the section opened as its own grid */
  board: string;
  /** the person just did something through Rune that this board answers (rule 3) */
  byHand: boolean;
}

export interface Decided {
  motion: SceneMotion;
  rule: MotionRule;
}

/** how long after a hand's act its board may still count as the answer (ms): a frame or two, not a later sync */
export const HAND_WINDOW_MS = 250;

/**
 * The board with its looks taken off: what's left is place, size and content.
 * Two scenes with the same `still` differ only in how they look (rule 4).
 */
export function still(scene: Scene): string {
  return JSON.stringify({
    ...scene,
    tokens: null,
    sections: scene.sections.map((s) => ({ ...s, active: false, tools: null, confirm: "" })),
    cards: scene.cards.map((c) => ({ ...c, active: false, tools: null })),
  });
}

const sameFloor = (a: Scene["view"], b: Scene["view"]) => a.left === b.left && a.top === b.top && a.right === b.right;

/** the word a scene goes to Rune with, and the rule that gave it */
export function sceneMotion(prev: { scene: Scene; board: string; still: string } | null, next: Scene, cause: MotionCause, nextStill = still(next)): Decided {
  if (!prev) return { motion: "instant", rule: "first" };
  if (prev.board !== cause.board) return { motion: "instant", rule: "board" };
  if (!sameFloor(prev.scene.view, next.view)) return { motion: "instant", rule: "floor" };
  if (cause.byHand) return { motion: "animated", rule: "hand" };
  if (prev.still === nextStill) return { motion: "animated", rule: "look" };
  return { motion: "instant", rule: "lands" };
}

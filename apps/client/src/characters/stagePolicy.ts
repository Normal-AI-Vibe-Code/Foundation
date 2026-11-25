/**
 * When a character plays, and what it shows when it doesn't (2026-11-25).
 *
 * Measured on the studio (docs/evidence/2026-11-25_character-grid-perf): with every card on screen playing, five
 * mesh avatars at rest kept the page's main thread 72 % busy doing nothing anyone was looking at, and a pan across
 * the board made and threw away a WebGL context per card (19 in one pass), each with its model parsed on the page.
 * So a card rests on a picture: for a 3D character, the model itself drawn once and kept (portrait.ts); for a mesh
 * avatar, the portrait it is cut from. It plays when someone is using it (the pointer is on it, or was a moment
 * ago) or when it is drawn large enough to be what you're looking at, and the picture cross-fades to the live one.
 *
 * Pure: the card says what it knows, this says what to do.
 */

import type { Framing } from "./actor";

/** a card drawn at this share of its own size or more is large: it's what the screen is showing */
export const LARGE_SCALE = 0.8;
/** how long a card goes on playing after the pointer leaves it */
export const LINGER_MS = 1400;
/** the cross-fade between the picture and the live character, each way (--dur-lift) */
export const CROSSFADE_MS = 350;
/** the side of a 3D character's kept still, in pixels (a card's stage is 250–300 px tall, at 2×) */
export const MODEL_STILL_SIZE = 640;

export interface StageFacts {
  /** the character is finished: there is something to play */
  ready: boolean;
  /** on screen, and drawn at a size worth playing at all (PanelView useOnScreen, 0.3) */
  onScreen: boolean;
  /** drawn at LARGE_SCALE or more */
  large: boolean;
  /** the pointer is on the card, or left it less than LINGER_MS ago */
  inUse: boolean;
}

/** whether the card should ask for a place on the stage (characters/stageBudget.ts says whether it gets one) */
export function wantsStage(f: StageFacts): boolean {
  return f.ready && f.onScreen && (f.large || f.inUse);
}

export interface RestFacts {
  form: "model" | "mesh";
  framing: Framing;
  /** the file ids it has, by role */
  files: Partial<Record<string, string | undefined>>;
}

/**
 * What a resting character shows. `render`: the 3D model drawn once, kept under its clips file's id (so a new model
 * is a new picture). `picture`: one of its drawn pictures, by role. `none`: nothing drawn yet.
 */
export function restPicture(c: RestFacts): { kind: "render"; file: string } | { kind: "picture"; role: string } | { kind: "none" } {
  if (c.form === "model" && c.files.clips) return { kind: "render", file: c.files.clips };
  const order = c.framing === "full" ? ["front", "thumb", "portrait"] : c.form === "mesh" ? ["portrait", "thumb", "front"] : ["thumb", "front", "portrait"];
  const role = order.find((r) => c.files[r]);
  return role ? { kind: "picture", role } : { kind: "none" };
}

/** the image cache's parts for a model's kept still: everything the picture depends on */
export function modelStillParts(characterId: string, clipsFile: string, framing: Framing, size = MODEL_STILL_SIZE): Array<string | number> {
  return [characterId, clipsFile, framing, size];
}

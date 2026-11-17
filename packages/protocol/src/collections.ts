/**
 * Collections (2026-11-17, Josh: "a primitive … that can output images or character cards like we have
 * stored in Character studio into a collection, that can be piped into a section that automatically lays
 * out the products of that into the section. The collector should be able to also be expanded to be able
 * to drag out copies of those cards onto the grid").
 *
 * A collection is a card (`panel: "collection"`) with one input and one output. What the cards wired into
 * its input make, it gathers: from the Character studio's flow, a stage node gives the pictures drawn at
 * that stage (the sheets, the expression sheets, the portraits), Inspiration its pictures, and Output the
 * finished characters themselves; another collection gives what it holds. Nothing gathered is dropped when
 * its source changes: a collection keeps what it has until a person takes an item out.
 *
 * It can be piped into a section (`into`): each item it gathers is laid there as a card of its own, docked,
 * so the section's own flow arranges them (a picture as an image card, a character as a copy of its card).
 * A card laid there is the section's from then on: moved or removed, it is not laid again.
 *
 * The server alone writes this, in the board's `collections` map (off the card, so moving the card can't
 * lose an item, and nobody can forge one over the socket).
 */

import type { CharacterForm } from "./characters.ts";

export interface CollectionItem {
  /** what it is, steadily: "chr:<character id>" for a character, "file:<archive file id>" for a picture */
  key: string;
  kind: "image" | "character";
  name: string;
  /** a picture's address (`/files/<id>`); a character's still, when it has one (`/api/characters/<id>/files/thumb`) */
  src?: string;
  /** a picture's archive file id */
  fileId?: string;
  /** a picture's size in pixels, when it was read */
  w?: number;
  h?: number;
  /** a character's id and its card on this board, when it came from one */
  character?: string;
  panel?: string;
  form?: CharacterForm;
  /** where it came from, in a few words: "Sheet · Anime", "Output · Animals", "a collection" */
  from: string;
  at: number;
}

export interface CollectionState {
  items: CollectionItem[];
  /** the section it lays its items out in, when it's piped into one */
  into?: string;
  /** item key → the card laid for it in `into` (kept after the card is moved or removed, so it isn't laid again) */
  laid?: Record<string, string>;
  /** who piped it into its section, and when */
  intoBy?: string;
  intoAt?: number;
}

/** a collection card's two ports, by name */
export const COLLECTION_IN = "collect";
export const COLLECTION_OUT = "items";
/** what the ports carry (wires from any output land on it: `typesCompatible` lets "any" meet every type) */
export const COLLECTION_TYPE = "any";

/** the Character studio's Output node's own output: the finished characters (2026-11-17) */
export const OUTPUT_PORT = "characters";

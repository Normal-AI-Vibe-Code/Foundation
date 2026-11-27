/**
 * Go to a place on a grid (2026-11-27): the grid it's on, opened if it isn't, then the camera on the card (or the
 * section). A chat link (a message of type "link"), a ping and a notice about one all land here, so "where I was
 * referenced" is one press away.
 */

import { getObject, getState, requestSnap } from "../state/store";
import { activeBoard } from "../sync/board";
import { goGrid } from "./place";

export interface GridPlace {
  board: string;
  section?: string;
  object?: string;
}

let waiting: ReturnType<typeof setInterval> | null = null;

export function openPlace(p: GridPlace) {
  goGrid();
  if (activeBoard()?.boardId !== p.board) window.dispatchEvent(new CustomEvent("foundation:board", { detail: p.board }));
  const frame = () => {
    if (activeBoard()?.boardId !== p.board) return false;
    if (p.object && getObject(p.object)) return requestSnap({ kind: "object", id: p.object }), true;
    if (p.section && getState().sections[p.section]) return requestSnap({ kind: "section", id: p.section }), true;
    return !p.object && !p.section;
  };
  if (waiting) clearInterval(waiting);
  waiting = null;
  if (frame()) return;
  // the grid is still arriving: look again until it has the card (a few seconds at most)
  let tries = 0;
  waiting = setInterval(() => {
    if (frame() || ++tries > 40) {
      if (waiting) clearInterval(waiting);
      waiting = null;
    }
  }, 150);
}

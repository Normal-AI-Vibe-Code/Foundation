/**
 * Open a grid at a place on it: the board, then its section or card framed (a Today notification, a todo). On the
 * grid that's already open it frames the place at once (once the canvas is back on screen); on another, it opens
 * that grid and the shell frames `?focus=` once the grid has synced (shell/Shell.tsx). Nothing here writes a board.
 */

import { goGrid } from "./place";
import { openGrid } from "./grids";
import { activeBoard } from "../sync/board";
import { getState, requestSnap } from "../state/store";

/** a section or a card on the open grid, as the camera frames it; null while it isn't there (yet) */
export function placeKind(id: string): "section" | "object" | null {
  const st = getState();
  if (st.sections[id]) return "section";
  if (st.panels[id] || st.notes[id] || st.tables[id] || st.maps[id] || st.media[id]) return "object";
  return null;
}

export function goToPlace(board: string, id?: string) {
  goGrid();
  if (activeBoard()?.boardId === board) {
    if (!id) return;
    // the grid comes back on screen first (from Today or ChatForm), then the camera moves
    const t0 = Date.now();
    const tick = () => {
      const kind = placeKind(id);
      if (kind) requestSnap({ kind, id });
      else if (Date.now() - t0 < 5000) setTimeout(tick, 200);
    };
    requestAnimationFrame(() => requestAnimationFrame(tick));
    return;
  }
  if (id) {
    const u = new URL(window.location.href);
    u.searchParams.set("focus", id);
    window.history.replaceState(window.history.state, "", u);
  }
  openGrid(board);
}

/** a plain press on a link (not one opening a new tab or window) */
export const plainPress = (e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

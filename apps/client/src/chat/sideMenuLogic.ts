/**
 * The pure parts of two ChatForm pieces, kept apart so they're tested without a page
 * (test/chat-sidemenu.test.ts):
 *
 *  - **Pins** (chat/pins.ts): the conversations a person keeps in the side menu, an ordered list of
 *    channel ids. Adding, taking out, moving one, and keeping only those this person can still see.
 *  - **An agent's figure** (chat/AgentFigure.tsx): which form an agent takes at a size, and how its
 *    still is framed so it stands behind a baseline, chest up (the council's way: a figure taller than
 *    its window, cut by the window's foot).
 */

/** the most pins a person keeps (the server holds the same line: prefs.ts LIST_PREFS) */
export const MAX_PINS = 100;

/** `id` kept, at `at` (default: the end); already kept, it moves there. Never more than MAX_PINS */
export function pinAdd(list: readonly string[], id: string, at?: number): string[] {
  const rest = list.filter((x) => x !== id);
  const i = at === undefined ? rest.length : Math.max(0, Math.min(rest.length, at));
  return [...rest.slice(0, i), id, ...rest.slice(i)].slice(0, MAX_PINS);
}

/** `id` let go of (it only leaves the side menu: nothing is left or archived) */
export function pinRemove(list: readonly string[], id: string): string[] {
  return list.filter((x) => x !== id);
}

/**
 * `id` moved so it lands before the row that was at `before` in the list as drawn (`list.length`: the
 * end). Indices are of the list before the move, which is what a pointer over the rows sees.
 */
export function pinMove(list: readonly string[], id: string, before: number): string[] {
  const from = list.indexOf(id);
  if (from < 0) return [...list];
  return pinAdd(list, id, before > from ? before - 1 : before);
}

/** the pins that can be shown: those this person sees, in the pins' order, once each */
export function reconcilePins(list: readonly unknown[], visible: ReadonlySet<string> | ((id: string) => boolean)): string[] {
  const sees = typeof visible === "function" ? visible : (id: string) => visible.has(id);
  const out: string[] = [];
  for (const id of list) if (typeof id === "string" && sees(id) && !out.includes(id)) out.push(id);
  return out.slice(0, MAX_PINS);
}

/** where a row dragged to pointer height `y` would land, given the rows' tops and heights as drawn */
export function dropIndex(y: number, rows: ReadonlyArray<{ top: number; height: number }>): number {
  for (let i = 0; i < rows.length; i++) if (y < rows[i].top + rows[i].height / 2) return i;
  return rows.length;
}

// ---------------------------------------------------------------- an agent's figure

/**
 * Below this size (px) a figure can't be read: an agent is the ✦ on its tint instead (a small paper
 * tile, never a disc). At and above it, the figure stands behind its baseline.
 */
export const FIGURE_MIN = 20;

export type FigureForm = "figure" | "spark";

export function figureForm(size: number): FigureForm {
  return size < FIGURE_MIN ? "spark" : "figure";
}

/**
 * How much of a still's height shows in the window, top and foot, by the kind of picture it is
 * (docs/characters.md): a **portrait** is head and shoulders with headroom (3:4), a **thumb** is the
 * model standing, square, a **front** the whole figure, 3:4. Each shows from just over the head to the chest.
 */
const WINDOW: Record<string, { top: number; foot: number; aspect: number }> = {
  portrait: { top: 0.09, foot: 0.66, aspect: 3 / 4 },
  thumb: { top: 0.07, foot: 0.6, aspect: 1 },
  front: { top: 0.03, foot: 0.36, aspect: 3 / 4 },
};

/**
 * Where a still sits in a figure's window (box w × h, px) so it's cut chest up by the window's foot:
 * the picture's width, its height, and its offset from the window's top left. `aspect` (width / height)
 * is the picture's own when it's known.
 */
export function figureFrame(role: string, box: { w: number; h: number }, aspect?: number): { w: number; h: number; left: number; top: number } {
  const win = WINDOW[role] ?? WINDOW.portrait;
  const a = aspect && isFinite(aspect) && aspect > 0 ? aspect : win.aspect;
  const h = box.h / (win.foot - win.top);
  const w = h * a;
  return { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10, left: Math.round(((box.w - w) / 2) * 10) / 10, top: Math.round(-win.top * h * 10) / 10 };
}

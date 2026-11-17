/**
 * Dragging a copy out of a collection (2026-11-17, Josh: "the collector should be able to also be expanded to
 * be able to drag out copies of those cards onto the grid").
 *
 * A tile in an expanded collection is pressed and pulled: past a few pixels a copy of the tile lifts off it
 * (the same ghost a carried card is: screen space, on the drag spring, leaning into the move) and the tile
 * stays where it is, since the collection keeps its item. Where it's let go is where carry.ts lands a card:
 *
 * - **a section**: the copy floats there, where it was let go;
 * - **an empty cell** of the grid: a new section is made there for it;
 * - **past an edge** of the board: a new section opens along that side;
 * - anywhere else (a pane, the top bar, back on the collection): it flies back and nothing is made.
 *
 * The copy itself is the server's (tool `collection_copy`): a picture becomes an image card, a character a
 * copy of its card with a row of its own. A section made here travels over the socket, so the server waits a
 * moment for it before it puts the copy in.
 */
import { Spring2D, presets } from "../physics/spring";
import { CONTENT_PAD, SECTION_HEADER, cellAtWorld, edgeAtWorld, getState, newSectionAt, newSectionAtEdge, sectionAtWorld, sectionCardRect, sectionCovering, sectionFit, setSectionDragTarget, type BoardEdge } from "../state/store";
import { toWorld } from "../state/camera";
import { api } from "./api";
import { activeBoard } from "../sync/board";
import { toast } from "../state/ui";
import { MAX_LEAN } from "./carry";

type Target = { kind: "section"; id: string } | { kind: "cell"; c: number; r: number } | { kind: "edge"; edge: BoardEdge } | { kind: "none" };

/** how far the pointer goes before a press on a tile becomes a drag (a click below it opens nothing: it's a tile) */
const SLOP = 5;

/** run one of the board's tools as the person at this browser */
export async function boardTool<T = unknown>(name: string, input: Record<string, unknown>): Promise<T> {
  const board = activeBoard()?.boardId;
  if (!board) throw new Error("no board is open");
  const r = await api<{ result: T }>(`/api/boards/${encodeURIComponent(board)}/tools/${name}`, { method: "POST", json: { ...input, request_id: `${name}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` } });
  return r.result;
}

/**
 * Watch a press on a tile; once it moves past the slop, a copy is carried. `tile` is what the ghost copies,
 * `home` the collection's own card (letting go over it flies back).
 */
export function pressTile(e: React.PointerEvent, tile: HTMLElement, collection: string, itemKey: string, itemName: string, size: { w: number; h: number }) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const r0 = tile.getBoundingClientRect();
  const grab = { x: x0 - r0.left, y: y0 - r0.top };
  const home = tile.closest<HTMLElement>("[data-panel-id]");
  let ghost: HTMLElement | null = null;
  let spring: Spring2D | null = null;
  let off: (() => void) | null = null;
  let target: Target = { kind: "none" };
  let lean = 0;
  let lastX = x0;
  let lastT = performance.now();

  const lift = () => {
    const r = tile.getBoundingClientRect();
    const g = document.createElement("div");
    g.className = "carry-ghost collection-ghost";
    g.style.width = `${r.width}px`;
    g.style.height = `${r.height}px`;
    const lifter = document.createElement("div");
    lifter.className = "carry-lift";
    lifter.style.setProperty("--grab-x", `${grab.x}px`);
    lifter.style.setProperty("--grab-y", `${grab.y}px`);
    const copy = tile.cloneNode(true) as HTMLElement;
    copy.classList.add("carry-copy");
    // drawn at the tile's own size, scaled to how big it shows on screen now (the grid's zoom)
    const w = tile.offsetWidth || r.width;
    const h = tile.offsetHeight || r.height;
    copy.style.width = `${w}px`;
    copy.style.height = `${h}px`;
    copy.style.transform = `scale(${r.width / Math.max(1, w)})`;
    lifter.appendChild(copy);
    g.appendChild(lifter);
    document.body.appendChild(g);
    document.body.classList.add("is-carrying");
    tile.classList.add("is-lending");
    spring = new Spring2D(r.left, r.top, presets.drag);
    off = spring.onChange((x, y) => {
      g.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
    g.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    requestAnimationFrame(() => g.classList.add("is-lifted"));
    ghost = g;
  };

  const show = (t: Target) => {
    if (JSON.stringify(t) === JSON.stringify(target)) return;
    document.querySelectorAll(".is-carry-target").forEach((el) => el.classList.remove("is-carry-target"));
    if (t.kind === "section") document.querySelector(`[data-section-id="${CSS.escape(t.id)}"]`)?.classList.add("is-carry-target");
    setSectionDragTarget(t.kind === "cell" ? { sectionId: collection, c: t.c, r: t.r, label: "New section here" } : t.kind === "edge" ? { sectionId: collection, c: -1, r: -1, edge: t.edge, label: `New section along the ${t.edge}` } : null);
    ghost?.classList.toggle("is-nowhere", t.kind === "none");
    target = t;
  };

  const targetAt = (cx: number, cy: number): Target => {
    const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
    const vp = document.querySelector<HTMLElement>(".grid-viewport");
    if (!top || !vp || !vp.contains(top) || top.closest(".floor-pane, .top-bar, .carry-ghost")) return { kind: "none" };
    // back over the collection itself: nothing to make
    if (home && home.contains(top)) return { kind: "none" };
    const vr = vp.getBoundingClientRect();
    const w = toWorld(cx - vr.left, cy - vr.top);
    const sec = sectionAtWorld(w.x, w.y);
    if (sec) return { kind: "section", id: sec.id };
    const cell = cellAtWorld(w.x, w.y);
    if (cell) return sectionCovering(cell.c, cell.r) ? { kind: "none" } : { kind: "cell", c: cell.c, r: cell.r };
    const edge = edgeAtWorld(w.x, w.y);
    return edge ? { kind: "edge", edge } : { kind: "none" };
  };

  /** where in a section's content the ghost's top-left is (a copy floats there) */
  const contentAt = (sectionId: string, cx: number, cy: number) => {
    const vp = document.querySelector<HTMLElement>(".grid-viewport");
    const st = getState();
    const sec = st.sections[sectionId];
    if (!vp || !sec) return null;
    const vr = vp.getBoundingClientRect();
    const w = toWorld(cx - grab.x - vr.left, cy - grab.y - vr.top);
    const card = sectionCardRect(st.grid, sec);
    const f = sectionFit(sec.id);
    // where it was let go, kept inside the section: the copy is a card of its own size, not the tile's
    const roomW = (card.w - 2) / f - CONTENT_PAD * 2;
    const roomH = (card.h - 2 - SECTION_HEADER) / f - CONTENT_PAD * 2;
    const x = Math.min((w.x - card.x - 1) / f - CONTENT_PAD, roomW - size.w);
    const y = Math.min((w.y - card.y - 1 - SECTION_HEADER) / f - CONTENT_PAD, roomH - size.h);
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  };

  const drop = () => {
    off?.();
    off = null;
    spring = null;
    ghost?.remove();
    ghost = null;
    document.body.classList.remove("is-carrying");
    tile.classList.remove("is-lending");
  };

  const flyBack = () => {
    const g = ghost;
    const s = spring;
    if (!g || !s) return drop();
    const r = tile.getBoundingClientRect();
    g.classList.remove("is-lifted", "is-nowhere");
    g.classList.add("is-returning");
    s.to(r.left, r.top);
    window.setTimeout(drop, 260);
  };

  const copyInto = (section: string, at: { x: number; y: number } | null) => {
    void boardTool("collection_copy", { collection, item: itemKey, section, ...(at ?? {}) })
      .then(() => toast(`Copied “${itemName}” out`, "ok"))
      .catch((err) => toast(`“${itemName}” wasn't copied: ${(err as Error).message}`, "bad"));
  };

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SLOP) return;
      lift();
    }
    show(targetAt(ev.clientX, ev.clientY));
    spring!.to(ev.clientX - grab.x, ev.clientY - grab.y);
    const now = performance.now();
    const vx = (ev.clientX - lastX) / Math.max(1, now - lastT);
    lastX = ev.clientX;
    lastT = now;
    lean = lean * 0.8 + Math.max(-MAX_LEAN, Math.min(MAX_LEAN, vx * 2)) * 0.2;
    ghost!.style.setProperty("--lean", `${lean.toFixed(2)}deg`);
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    if (!ghost) return;
    const t = target;
    show({ kind: "none" });
    switch (t.kind) {
      case "section":
        drop();
        copyInto(t.id, contentAt(t.id, ev.clientX, ev.clientY));
        return;
      case "cell": {
        drop();
        const sid = newSectionAt(t.c, t.r);
        if (sid) copyInto(sid, null);
        return;
      }
      case "edge":
        drop();
        copyInto(newSectionAtEdge(t.edge), null);
        return;
      default:
        flyBack();
    }
  };
  const cancel = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    show({ kind: "none" });
    drop();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", cancel);
}

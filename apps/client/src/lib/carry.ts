/**
 * Carrying a card out of its section (2026-11-10, Josh: "dragging should not
 * only be able to be dragged to other boards but it should create new
 * sections to be dropped in").
 *
 * A card dragged inside its own section moves there as it always has. Once
 * the pointer leaves the section, the card lifts out of it: a copy of the card
 * (the "ghost", in screen space, since the section clips its own body) follows
 * the pointer on the drag spring, lifted a little and leaning into the move,
 * and the card itself waits, hidden, where it was. Where it's let go:
 *
 * - **another section**: it lands there, floating where it was let go
 *   (that section rings, as a search result's target does);
 * - **an empty cell** of the grid: a new section is made there for it;
 * - **past an edge of the board**: a new section opens along that whole side;
 * - **another space's tab** (or its row in the spaces pane): it moves to that
 *   board, into a section named for where it came from (server: send_to_board);
 * - anywhere else (a pane, the top bar): it flies back to where it was.
 *
 * Coming back over its own section puts it back under the pointer as before.
 * An expanded section is a grid on its own: its cards stay in it.
 */
import { Spring2D, presets } from "../physics/spring";
import {
  cellAtWorld,
  edgeAtWorld,
  getObject,
  getState,
  moveObjectToSection,
  newSectionAt,
  newSectionAtEdge,
  sectionAtWorld,
  sectionCardRect,
  sectionCovering,
  setSectionDragTarget,
  type BoardEdge,
} from "../state/store";
import { toWorld } from "../state/camera";
import { api } from "./api";
import { activeBoard } from "../sync/board";
import { toast } from "../state/ui";

type Target =
  | { kind: "home" }
  | { kind: "section"; id: string }
  | { kind: "cell"; c: number; r: number }
  | { kind: "edge"; edge: BoardEdge }
  | { kind: "board"; id: string; name: string; el: HTMLElement }
  | { kind: "none" };

/** how far the held card leans into its motion, at most (degrees): a little physicality, not a ton */
export const MAX_LEAN = 2.5;
/** how much a held card lifts */
export const LIFT = 1.025;

export interface Carry {
  /** the pointer moved: true while the card is out of its section (the caller stops moving its own copy) */
  move(clientX: number, clientY: number): boolean;
  /** let go: true when the carry handled it (dropped elsewhere, or flew back); false to drop it at home as usual */
  end(clientX: number, clientY: number): boolean;
  cancel(): void;
}

/**
 * Start watching a drag for the moment it leaves the card's section.
 * `anchor` is the card's positioned root (hidden while carried), `card` the
 * visible card inside it (what the ghost copies).
 */
export function startCarry(id: string, anchor: HTMLElement, card: HTMLElement, clientX: number, clientY: number): Carry {
  const home = getObject(id)?.sectionId ?? null;
  const r0 = card.getBoundingClientRect();
  const grab = { x: clientX - r0.left, y: clientY - r0.top };
  let ghost: HTMLElement | null = null;
  let spring: Spring2D | null = null;
  let off: (() => void) | null = null;
  let target: Target = { kind: "home" };
  let lean = 0;
  let lastX = clientX;
  let lastT = performance.now();
  // a card seen in miniature (inside a section that is a grid) moves only within its own section there
  const pinned = !home || !getState().sections[home];

  const lift = () => {
    const r = card.getBoundingClientRect();
    const g = document.createElement("div");
    g.className = "carry-ghost";
    const copy = card.cloneNode(true) as HTMLElement;
    copy.classList.add("carry-copy");
    // the copy is drawn at the card's own size, scaled to how big it shows on screen now
    const w = card.offsetWidth || r.width;
    const h = card.offsetHeight || r.height;
    copy.style.width = `${w}px`;
    copy.style.height = `${h}px`;
    copy.style.transform = `scale(${r.width / Math.max(1, w)})`;
    copy.style.rotate = "";
    copy.style.scale = "";
    g.style.width = `${r.width}px`;
    g.style.height = `${r.height}px`;
    // lifted and leaning about where it was picked up, as a held thing pivots on the hand
    const lifter = document.createElement("div");
    lifter.className = "carry-lift";
    lifter.style.setProperty("--grab-x", `${grab.x}px`);
    lifter.style.setProperty("--grab-y", `${grab.y}px`);
    lifter.appendChild(copy);
    g.appendChild(lifter);
    // a <video> copy starts from nothing: show the frame the card is on
    const vids = card.querySelectorAll("video");
    copy.querySelectorAll("video").forEach((v, i) => {
      v.muted = true;
      v.currentTime = vids[i]?.currentTime ?? 0;
    });
    document.body.appendChild(g);
    document.body.classList.add("is-carrying");
    anchor.classList.add("is-carried");
    spring = new Spring2D(r.left, r.top, presets.drag);
    off = spring.onChange((x, y) => {
      g.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
    g.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    // lifted on the next frame, so the scale eases in rather than jumping
    requestAnimationFrame(() => g.classList.add("is-lifted"));
    ghost = g;
  };

  const drop = () => {
    off?.();
    off = null;
    spring = null;
    ghost?.remove();
    ghost = null;
    document.body.classList.remove("is-carrying");
  };

  const show = (t: Target) => {
    const same = JSON.stringify({ ...t, el: undefined }) === JSON.stringify({ ...target, el: undefined });
    if (same) return;
    document.querySelectorAll(".is-carry-target").forEach((el) => el.classList.remove("is-carry-target"));
    if (t.kind === "section") document.querySelector(`[data-section-id="${CSS.escape(t.id)}"]`)?.classList.add("is-carry-target");
    if (t.kind === "board") t.el.classList.add("is-carry-target");
    setSectionDragTarget(
      t.kind === "cell"
        ? { sectionId: id, c: t.c, r: t.r, label: "New section here" }
        : t.kind === "edge"
          ? { sectionId: id, c: -1, r: -1, edge: t.edge, label: `New section along the ${t.edge}` }
          : null,
    );
    ghost?.classList.toggle("is-leaving", t.kind === "board");
    ghost?.classList.toggle("is-nowhere", t.kind === "none");
    target = t;
  };

  const targetAt = (cx: number, cy: number): Target => {
    const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
    const tab = top?.closest<HTMLElement>("[data-space-drop]");
    if (tab) {
      const bid = tab.dataset.spaceDrop!;
      const kind = tab.dataset.spaceKind ?? "grid";
      if (bid !== activeBoard()?.boardId && kind === "grid") return { kind: "board", id: bid, name: tab.dataset.spaceName ?? bid, el: tab };
      return { kind: "none" };
    }
    const vp = document.querySelector<HTMLElement>(".grid-viewport");
    if (!top || !vp || !vp.contains(top) || top.closest(".floor-pane, .top-bar, .carry-ghost")) return { kind: "none" };
    const vr = vp.getBoundingClientRect();
    const w = toWorld(cx - vr.left, cy - vr.top);
    const st = getState();
    if (home) {
      const h = st.sections[home];
      const hr = h && sectionCardRect(st.grid, h);
      if (hr && w.x >= hr.x && w.x <= hr.x + hr.w && w.y >= hr.y && w.y <= hr.y + hr.h) return { kind: "home" };
    }
    const sec = sectionAtWorld(w.x, w.y);
    if (sec) return sec.id === home ? { kind: "home" } : { kind: "section", id: sec.id };
    const cell = cellAtWorld(w.x, w.y);
    if (cell) return sectionCovering(cell.c, cell.r) ? { kind: "none" } : { kind: "cell", c: cell.c, r: cell.r };
    const edge = edgeAtWorld(w.x, w.y);
    return edge ? { kind: "edge", edge } : { kind: "none" };
  };

  /** the world point under the ghost's top-left (where a card dropped into a section goes) */
  const ghostWorld = (cx: number, cy: number) => {
    const vp = document.querySelector<HTMLElement>(".grid-viewport");
    if (!vp) return null;
    const vr = vp.getBoundingClientRect();
    // the ghost is drawn at the card's on-screen size, so the grab offset holds in screen pixels
    const w = toWorld(cx - grab.x - vr.left, cy - grab.y - vr.top);
    return { wx: w.x, wy: w.y };
  };

  /** fly the ghost back onto the card and show the card again */
  const flyHome = () => {
    const g = ghost;
    const s = spring;
    if (!g || !s) {
      anchor.classList.remove("is-carried");
      return drop();
    }
    const r = card.getBoundingClientRect();
    g.classList.remove("is-lifted", "is-leaving", "is-nowhere");
    g.classList.add("is-returning");
    s.to(r.left, r.top);
    window.setTimeout(() => {
      anchor.classList.remove("is-carried");
      drop();
    }, 260);
  };

  return {
    move(cx, cy) {
      if (pinned) return false;
      const t = targetAt(cx, cy);
      if (t.kind === "home" && !ghost) return false;
      if (!ghost) lift();
      show(t);
      if (t.kind === "home") {
        // back over its own section: the card takes the pointer again
        anchor.classList.remove("is-carried");
        drop();
        return false;
      }
      spring!.to(cx - grab.x, cy - grab.y);
      const now = performance.now();
      const vx = (cx - lastX) / Math.max(1, now - lastT);
      lastX = cx;
      lastT = now;
      lean = lean * 0.8 + Math.max(-MAX_LEAN, Math.min(MAX_LEAN, vx * 2)) * 0.2;
      ghost!.style.setProperty("--lean", `${lean.toFixed(2)}deg`);
      return true;
    },
    end(cx, cy) {
      if (!ghost) return false;
      const t = target;
      show({ kind: "home" });
      switch (t.kind) {
        case "section": {
          const at = ghostWorld(cx, cy);
          drop();
          anchor.classList.remove("is-carried");
          moveObjectToSection(id, t.id, at);
          return true;
        }
        case "cell": {
          drop();
          anchor.classList.remove("is-carried");
          const sid = newSectionAt(t.c, t.r);
          if (sid) moveObjectToSection(id, sid, null);
          return true;
        }
        case "edge": {
          drop();
          anchor.classList.remove("is-carried");
          moveObjectToSection(id, newSectionAtEdge(t.edge), null);
          return true;
        }
        case "board": {
          const g = ghost;
          // it goes into the tab: shrinks toward it, then the board it left lets it go
          const tr = t.el.getBoundingClientRect();
          g.classList.add("is-sent");
          spring?.to(tr.left + tr.width / 2 - 20, tr.top + tr.height / 2 - 10);
          window.setTimeout(drop, 320);
          void sendToBoard(id, t.id, t.name).then((ok) => {
            if (!ok) anchor.classList.remove("is-carried");
          });
          return true;
        }
        default:
          flyHome();
          return true;
      }
    },
    cancel() {
      show({ kind: "home" });
      anchor.classList.remove("is-carried");
      drop();
    },
  };
}

/** move a card to another board (the server moves it, so both boards agree at once) */
async function sendToBoard(id: string, to: string, name: string): Promise<boolean> {
  const from = activeBoard()?.boardId;
  const card = getObject(id);
  if (!from || !card) return false;
  try {
    await api(`/api/boards/${encodeURIComponent(from)}/tools/send_to_board`, {
      method: "POST",
      json: { id, to_board: to, request_id: `carry_${id}_${Date.now().toString(36)}` },
    });
    toast(`Moved “${card.name}” to ${name}`, "ok");
    return true;
  } catch (e) {
    toast(`“${card.name}” stayed here: ${(e as Error).message}`, "bad");
    return false;
  }
}

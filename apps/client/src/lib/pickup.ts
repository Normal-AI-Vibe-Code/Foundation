/**
 * Picking a result up out of search, and putting it down (2026-11-12, Josh: "a
 * high physicality clipboard like experience where you can drag things from the
 * search into Foundation").
 *
 * Pull a result past 5 px and it comes out of the list as a card in the hand:
 * a picture as the picture, anything else as a slip of paper with its mark and
 * name. It starts where the row was, follows the pointer on the drag spring,
 * lifted 2.5 % and leaning into the move about the point it was pressed
 * (lib/pickupMath.ts; the same hand as a carried card, lib/carry.ts). The row it
 * left stays behind, dimmed and dashed: its place is kept. Several at once (the
 * clipboard, shell/Clipboard.tsx) are a stack: fanned, each card under the top
 * one on a looser spring, so the stack trails and gathers.
 *
 * Let go:
 *  - **over the grid**: the cards are dealt where the hand was, each a step
 *    from the last, floating in the section under them (which rang while they
 *    were held over it). One that has to be fetched first (a Flowform file, a
 *    file in an approved folder) waits at that spot on the board, pinned to it
 *    as the view moves, with a moving bar, and becomes the card when it lands;
 *  - **over the clipboard**: it's clipped, and goes into the strip;
 *  - **anywhere else**, or Esc: it flies back into its row.
 *
 * Everything here writes `transform` straight from the springs; nothing is in
 * React state.
 */
import type { SearchHit } from "@foundation/protocol";
import { Spring2D, presets } from "../physics/spring";
import { camera, onCamera, toWorld } from "../state/camera";
import { sectionAtWorld } from "../state/store";
import { clip, unclip } from "../state/clipboard";
import { toast } from "../state/ui";
import { glyphOf, needsFetch, placeHit, resolveHit } from "./hits";
import { PAPER, STACK_SHOWN, deal, fan, grabPoint, leanToward, pictureSize, trail } from "./pickupMath";

type Over = { kind: "grid"; sectionId: string | null } | { kind: "clipboard"; el: HTMLElement } | { kind: "none" };

export interface Pickup {
  move(x: number, y: number): void;
  /** let go here */
  drop(x: number, y: number): void;
  /** put it back (Esc, a cancelled pointer) */
  cancel(): void;
  /** it has been let go or put back: the pointer that held it is done */
  readonly over: boolean;
}

/** a loaded picture of this hit anywhere on the page (its tile, its clipboard card): what the held card shows */
function pictureFor(hit: SearchHit, near: HTMLElement): HTMLImageElement | null {
  const own = near.matches(`[data-hit-id="${CSS.escape(hit.id)}"]`) ? near : near.querySelector<HTMLElement>(`[data-hit-id="${CSS.escape(hit.id)}"]`);
  const img = (own ?? document.querySelector<HTMLElement>(`[data-hit-id="${CSS.escape(hit.id)}"]`))?.querySelector("img") ?? null;
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/** the card a hit is while it's held */
function cardFor(hit: SearchHit, near: HTMLElement): { el: HTMLElement; w: number; h: number } {
  const el = document.createElement("div");
  const face = document.createElement("div");
  face.className = "held-face";
  const pic = pictureFor(hit, near);
  let size = PAPER;
  if (pic) {
    size = pictureSize(pic.naturalWidth, pic.naturalHeight);
    el.className = "held-card is-picture";
    const img = document.createElement("img");
    img.src = pic.currentSrc || pic.src;
    img.alt = "";
    img.draggable = false;
    const name = document.createElement("span");
    name.className = "held-name";
    name.textContent = hit.title;
    face.append(img, name);
  } else {
    el.className = "held-card";
    const glyph = document.createElement("span");
    glyph.className = "search-row-glyph";
    glyph.textContent = glyphOf(hit);
    const main = document.createElement("span");
    main.className = "held-main";
    const title = document.createElement("span");
    title.className = "held-title";
    title.textContent = hit.title;
    const src = document.createElement("span");
    src.className = "held-src";
    src.textContent = hit.source === "flowform" ? (hit.flowform?.origin ?? "flowform") : hit.source;
    main.append(title, src);
    face.append(glyph, main);
  }
  const bar = document.createElement("i");
  bar.className = "held-wait";
  face.append(bar);
  el.style.width = `${size.w}px`;
  el.style.height = `${size.h}px`;
  el.append(face);
  return { el, w: size.w, h: size.h };
}

function overAt(x: number, y: number): Over {
  const top = document.elementFromPoint(x, y) as HTMLElement | null;
  const board = top?.closest<HTMLElement>(".clipboard");
  if (board) return { kind: "clipboard", el: board };
  const vp = document.querySelector<HTMLElement>(".grid-viewport");
  if (!top || !vp || !vp.contains(top) || top.closest(".floor-pane, .top-bar")) return { kind: "none" };
  const r = vp.getBoundingClientRect();
  const w = toWorld(x - r.left, y - r.top);
  return { kind: "grid", sectionId: sectionAtWorld(w.x, w.y)?.id ?? null };
}

function ring(over: Over) {
  document.querySelectorAll(".is-hit-target").forEach((el) => el.classList.remove("is-hit-target"));
  if (over.kind === "grid" && over.sectionId) document.querySelector(`[data-section-id="${CSS.escape(over.sectionId)}"]`)?.classList.add("is-hit-target");
  if (over.kind === "clipboard") over.el.classList.add("is-hit-target");
}

/**
 * Lift `hits` out of `from` (the row, tile or clipboard card that was pressed at `press`).
 * `fromClipboard`: they're the clipboard's, so the ones that land leave it.
 */
export function pickUp(hits: SearchHit[], from: HTMLElement, press: { x: number; y: number }, opts: { fromClipboard?: boolean } = {}): Pickup {
  const r0 = from.getBoundingClientRect();
  const root = document.createElement("div");
  root.className = "held";
  const shown = hits.slice(0, STACK_SHOWN).map((h) => cardFor(h, from));
  const lead = shown[0];
  const grab = grabPoint(press, r0, lead);
  root.style.setProperty("--grab-x", `${grab.x}px`);
  root.style.setProperty("--grab-y", `${grab.y}px`);
  if (hits.length > 1) {
    const n = document.createElement("span");
    n.className = "held-count";
    n.textContent = String(hits.length);
    lead.el.append(n);
  }
  // the top card is drawn last, over the ones it leads
  const offs: Array<() => void> = [];
  const springs = shown.map((c, i) => {
    const f = fan(i);
    c.el.style.setProperty("--fan", `${f.rotate}deg`);
    c.el.style.zIndex = String(STACK_SHOWN - i);
    const s = new Spring2D(r0.left, r0.top, trail(presets.drag, i));
    offs.push(s.onChange((x, y) => (c.el.style.transform = `translate3d(${x}px, ${y}px, 0)`)));
    c.el.style.transform = `translate3d(${r0.left}px, ${r0.top}px, 0)`;
    root.prepend(c.el);
    return s;
  });
  document.body.append(root);
  document.body.classList.add("is-dragging-hit");
  from.classList.add("is-held");
  requestAnimationFrame(() => root.classList.add("is-lifted"));

  let over: Over = { kind: "none" };
  let lean = 0;
  let lastX = press.x;
  let lastT = performance.now();
  let done = false;
  let unpin: (() => void) | null = null;

  const aim = (x: number, y: number) =>
    springs.forEach((s, i) => {
      const f = fan(i);
      s.to(x - grab.x + f.dx, y - grab.y + f.dy);
    });

  const letGo = () => {
    done = true;
    ring({ kind: "none" });
    document.body.classList.remove("is-dragging-hit");
    window.removeEventListener("keydown", onKey, true);
  };
  const remove = (after: number) =>
    window.setTimeout(() => {
      offs.forEach((o) => o());
      unpin?.();
      root.remove();
      from.classList.remove("is-held");
    }, after);

  /** back into the row it came from */
  const flyBack = () => {
    root.classList.remove("is-lifted", "is-over", "is-clip", "is-waiting");
    root.classList.add("is-back");
    const r = from.isConnected ? from.getBoundingClientRect() : r0;
    springs.forEach((s) => s.to(r.left, r.top));
    remove(260);
  };
  /** set down on the board: it settles flat and gives way to the card arriving under it */
  const setDown = () => {
    root.classList.remove("is-lifted", "is-waiting");
    root.classList.add("is-down");
    remove(200);
  };

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || done) return;
    e.preventDefault();
    e.stopPropagation();
    api.cancel();
  }
  window.addEventListener("keydown", onKey, true);

  const api: Pickup = {
    get over() {
      return done;
    },
    move(x, y) {
      if (done) return;
      aim(x, y);
      const now = performance.now();
      lean = leanToward(lean, (x - lastX) / Math.max(1, now - lastT));
      lastX = x;
      lastT = now;
      root.style.setProperty("--lean", `${lean.toFixed(2)}deg`);
      const o = overAt(x, y);
      if (o.kind !== over.kind || (o.kind === "grid" && over.kind === "grid" && o.sectionId !== over.sectionId)) ring(o);
      over = o;
      root.classList.toggle("is-over", o.kind === "grid");
      root.classList.toggle("is-clip", o.kind === "clipboard");
    },
    drop(x, y) {
      if (done) return;
      const o = overAt(x, y);
      letGo();
      root.style.setProperty("--lean", "0deg");
      if (o.kind === "clipboard") {
        if (opts.fromClipboard) return flyBack();
        const fresh = hits.filter((h) => clip(h)).length;
        if (!fresh) toast(hits.length === 1 ? "That's already on the clipboard" : "Those are already on the clipboard");
        const strip = (o.el.querySelector(".clip-cards") ?? o.el).getBoundingClientRect();
        root.classList.remove("is-lifted", "is-clip");
        root.classList.add("is-clipped");
        springs.forEach((s) => s.to(strip.left + 8, strip.top + strip.height / 2 - lead.h / 2));
        return void remove(240);
      }
      if (o.kind !== "grid") return flyBack();

      // where each lands, fixed in the board's own space now: the view may move while a file is fetched
      const at = hits.map((_, i) => {
        const d = deal(i);
        return toWorld(x + d.dx - camera.left, y + d.dy - camera.top);
      });
      const landed: string[] = [];
      const put = async (h: SearchHit, i: number) => {
        const real = await resolveHit(h);
        if (!real) return;
        await placeHit(real, at[i].x, at[i].y);
        landed.push(h.id);
      };
      const waiting = hits.some(needsFetch);
      if (!waiting) {
        setDown();
        // dealt, not dumped: one card every 45 ms
        hits.forEach((h, i) => window.setTimeout(() => void put(h, i).then(() => opts.fromClipboard && unclip(h.id)), i * 45));
        return;
      }
      // the stack waits on the board where it was put, pinned to that spot as the view moves
      root.classList.remove("is-lifted", "is-over");
      root.classList.add("is-waiting");
      const pin = () => {
        const sx = at[0].x * camera.scale + camera.x + camera.left;
        const sy = at[0].y * camera.scale + camera.y + camera.top;
        springs.forEach((s, i) => {
          const f = fan(i);
          s.set(sx - grab.x + f.dx, sy - grab.y + f.dy);
        });
      };
      // let it arrive on its spring first, then hold it to the board
      window.setTimeout(() => {
        // already landed (or gone back) in that time: nothing left to hold
        if (!root.isConnected || !root.classList.contains("is-waiting")) return;
        pin();
        unpin = onCamera(pin);
      }, 220);
      void Promise.allSettled(hits.map(put)).then(() => {
        if (opts.fromClipboard && landed.length) unclip(landed);
        if (landed.length) setDown();
        else flyBack();
      });
    },
    cancel() {
      if (done) return;
      letGo();
      flyBack();
    },
  };
  return api;
}

/** a result clipped without being dragged (its ＋, or ⌘/Ctrl-click): a copy of its card flies into the clipboard */
export function flyToClipboard(hit: SearchHit, from: HTMLElement) {
  const strip = document.querySelector<HTMLElement>(".clipboard .clip-cards") ?? document.querySelector<HTMLElement>(".clipboard");
  if (!strip) return;
  const r0 = from.getBoundingClientRect();
  const to = strip.getBoundingClientRect();
  const root = document.createElement("div");
  root.className = "held is-lifted";
  const c = cardFor(hit, from);
  root.append(c.el);
  document.body.append(root);
  const s = new Spring2D(r0.left, r0.top, presets.camera);
  const off = s.onChange((x, y) => (c.el.style.transform = `translate3d(${x}px, ${y}px, 0)`));
  c.el.style.transform = `translate3d(${r0.left}px, ${r0.top}px, 0)`;
  requestAnimationFrame(() => {
    root.classList.add("is-clipped");
    s.to(to.left + 8, to.top + to.height / 2 - c.h / 2);
  });
  window.setTimeout(() => {
    off();
    root.remove();
  }, 320);
}

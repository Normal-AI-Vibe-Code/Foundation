/**
 * A conversation carried out of ChatForm's list into the side menu (2026-11-20). The same hand as a search
 * result (lib/pickup.ts) and a carried card (lib/carry.ts): pulled past 5 px, the row comes out as a slip
 * of raised paper (232 × 56: its mark, its name, *ChatForm · channel*) that follows on the drag spring,
 * lifted 2.5 %, leaning at most 2.5° about the point it was pressed; the row stays behind at 35 % with a
 * dashed hairline. While it's held the side menu rings (its Chats segment and its list: 2 px pulse + dim),
 * and a folded side menu opens when the hand reaches the window's left edge.
 *
 * Let go over the side menu: it's kept there (over a kept row: just before or after it), the selector
 * turns to Chats, and the slip draws into the row. Anywhere else, or Esc: it flies back into its row.
 *
 * Everything writes `transform` straight from the spring; the only state is the pins store's `held`.
 */

import { Spring2D, presets } from "../physics/spring";
import { PAPER, grabPoint, leanToward } from "../lib/pickupMath";
import { getUi, setUi, toast } from "../state/ui";
import { getPins, keepInSideMenu, setHeld } from "./pins";
import { dropIndex } from "./sideMenuLogic";

/** how far a press travels before it's a pull, not a click (px) */
export const PULL = 5;
/** how near the window's left edge the hand opens a folded side menu (px) */
const EDGE = 28;

const overMenu = (x: number, y: number) => !!(document.elementFromPoint(x, y) as HTMLElement | null)?.closest(".side-pane");

/** where in the kept rows a drop at height `y` lands (the end when the rows aren't showing) */
function landingIndex(y: number): number {
  const rows = [...document.querySelectorAll<HTMLElement>(".side-pane [data-chat-pin]")].map((el) => el.getBoundingClientRect());
  return rows.length ? dropIndex(y, rows) : getPins().ids.length;
}

export interface ChatCarry {
  move(x: number, y: number): void;
  drop(x: number, y: number): void;
  cancel(): void;
}

/** lift conversation `id` (titled `title`, from row `from`, pressed at `press`) into the hand */
export function carryChat(id: string, title: string, from: HTMLElement, press: { x: number; y: number }, kind: string): ChatCarry {
  const r0 = from.getBoundingClientRect();
  const root = document.createElement("div");
  root.className = "held chat-held";
  root.dataset.chatHeld = id;
  const card = document.createElement("div");
  card.className = "held-card";
  card.style.width = `${PAPER.w}px`;
  card.style.height = `${PAPER.h}px`;
  const face = document.createElement("div");
  face.className = "held-face";
  const mark = document.createElement("span");
  mark.className = "chat-held-mark";
  const theirs = from.querySelector(".chat-side-mark");
  if (theirs) mark.append(...[...theirs.childNodes].map((n) => n.cloneNode(true)));
  const main = document.createElement("span");
  main.className = "held-main";
  const t = document.createElement("span");
  t.className = "held-title";
  t.textContent = title;
  const src = document.createElement("span");
  src.className = "held-src";
  src.textContent = `ChatForm · ${kind}`;
  main.append(t, src);
  face.append(mark, main);
  card.append(face);
  root.append(card);

  const grab = grabPoint(press, r0, PAPER);
  root.style.setProperty("--grab-x", `${grab.x}px`);
  root.style.setProperty("--grab-y", `${grab.y}px`);
  const spring = new Spring2D(r0.left, r0.top, presets.drag);
  const off = spring.onChange((x, y) => (card.style.transform = `translate3d(${x}px, ${y}px, 0)`));
  card.style.transform = `translate3d(${r0.left}px, ${r0.top}px, 0)`;
  document.body.append(root);
  document.body.classList.add("is-dragging-hit", "is-carrying-chat");
  from.classList.add("is-held");
  requestAnimationFrame(() => root.classList.add("is-lifted"));
  setHeld({ id, over: false });

  let lean = 0;
  let lastX = press.x;
  let lastT = performance.now();
  let done = false;
  /** how the side menu listed things before the hand turned it to Chats */
  let wasView: ReturnType<typeof getUi>["spacesView"] | undefined;

  const finish = () => {
    done = true;
    setHeld(null);
    document.body.classList.remove("is-dragging-hit", "is-carrying-chat");
    window.removeEventListener("keydown", onKey, true);
    root.style.setProperty("--lean", "0deg");
  };
  const remove = (after: number) =>
    window.setTimeout(() => {
      off();
      root.remove();
      from.classList.remove("is-held");
    }, after);
  const flyBack = () => {
    if (wasView) setUi({ spacesView: wasView });
    root.classList.remove("is-lifted", "is-over");
    root.classList.add("is-back");
    const r = from.isConnected ? from.getBoundingClientRect() : r0;
    spring.to(r.left, r.top);
    remove(260);
  };

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || done) return;
    e.preventDefault();
    e.stopPropagation();
    api.cancel();
  }
  window.addEventListener("keydown", onKey, true);

  const api: ChatCarry = {
    move(x, y) {
      if (done) return;
      spring.to(x - grab.x, y - grab.y);
      const now = performance.now();
      lean = leanToward(lean, (x - lastX) / Math.max(1, now - lastT));
      lastX = x;
      lastT = now;
      root.style.setProperty("--lean", `${lean.toFixed(2)}deg`);
      // the side menu folded (or showing the grid's own people): the hand at the window's edge opens it
      const ui = getUi();
      if (x <= EDGE && (!ui.pane || ui.paneView !== "spaces")) setUi({ pane: true, paneView: "spaces" });
      const over = overMenu(x, y);
      // over the menu it shows its Chats, so you see where it will go (put back as it was if it flies home)
      if (over && getUi().spacesView !== "chats") {
        wasView ??= getUi().spacesView;
        setUi({ spacesView: "chats" });
      }
      root.classList.toggle("is-over", over);
      setHeld({ id, over });
    },
    drop(x, y) {
      if (done) return;
      const over = overMenu(x, y);
      const at = over && getUi().spacesView === "chats" && getPins().ids.length ? landingIndex(y) : undefined;
      finish();
      if (!over) return flyBack();
      const already = getPins().ids.includes(id);
      keepInSideMenu(id, at);
      setUi({ spacesView: "chats" });
      if (already && at === undefined) toast(`${title} is already in the side menu`);
      // it draws into its row
      root.classList.remove("is-lifted", "is-over");
      root.classList.add("is-clipped");
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(`.side-pane [data-chat-pin="${CSS.escape(id)}"]`);
        if (row) {
          const r = row.getBoundingClientRect();
          spring.to(r.left, r.top + r.height / 2 - PAPER.h / 2);
        }
      });
      remove(260);
    },
    cancel() {
      if (done) return;
      finish();
      flyBack();
    },
  };
  return api;
}

/**
 * Pointer handlers for a row that can be carried: a press that moves past PULL lifts it; the click that
 * ends a pull is swallowed. `info()` says what the row is when the pull starts.
 */
export function carryHandlers(info: () => { id: string; title: string; kind: string } | null) {
  return {
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (e.button !== 0 || e.pointerType === "touch") return;
      const el = e.currentTarget;
      const start = { x: e.clientX, y: e.clientY };
      let carry: ChatCarry | null = null;
      // the click that ends a pull isn't a press
      const swallow = (c: MouseEvent) => {
        c.preventDefault();
        c.stopPropagation();
      };
      const move = (ev: PointerEvent) => {
        if (!carry) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < PULL) return;
          const what = info();
          if (!what) return stop();
          carry = carryChat(what.id, what.title, el, start, what.kind);
          el.addEventListener("click", swallow, true);
        }
        carry.move(ev.clientX, ev.clientY);
      };
      const up = (ev: PointerEvent) => {
        stop();
        carry?.drop(ev.clientX, ev.clientY);
        if (carry) window.setTimeout(() => el.removeEventListener("click", swallow, true), 0);
      };
      const cancel = () => {
        stop();
        carry?.cancel();
        el.removeEventListener("click", swallow, true);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
  };
}

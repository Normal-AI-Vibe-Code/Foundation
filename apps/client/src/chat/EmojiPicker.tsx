/**
 * A small emoji picker: a field that finds by name, the ones this device used last, then the curated set
 * in its groups (chat/emoji.ts). Raised paper, pane radius; a press outside or Esc puts it away.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { EMOJI_GROUPS, loadRecents, matchEmoji, saveRecent, type Emoji } from "./emoji";

const GAP = 6; // between the picker and the button that opened it
const EDGE = 8; // kept from the column's edges

/**
 * With an `anchor`, the picker lives on the page (a portal), not in the message: the timeline's scroll would clip it
 * and the composer would cover it. It opens under the button, or over it when there is no room below, and is held
 * inside the conversation's column (the thread, or the channel with its composer), following the button as it scrolls.
 */
export function EmojiPicker({ onPick, onClose, className = "", anchor }: { onPick(char: string): void; onClose(): void; className?: string; anchor?: HTMLElement | null }) {
  const [q, setQ] = useState("");
  const [recent] = useState(loadRecents);
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const el = box.current;
      if (!el || !anchor.isConnected) return;
      const a = anchor.getBoundingClientRect();
      // the conversation's own column (a thread, or the channel with its composer), not the channel list beside it
      const f = (anchor.closest(".chat-thread, .chat-main, .chatform") ?? document.documentElement).getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const lo = f.top + EDGE;
      const hi = f.bottom - EDGE;
      let top = a.bottom + GAP;
      if (top + h > hi) top = a.top - GAP - h >= lo ? a.top - GAP - h : hi - h;
      top = Math.max(lo, top);
      // its right edge on the button's, or its left edge when the button sits near the column's left
      const want = a.right - w >= f.left + EDGE ? a.right - w : a.left;
      const left = Math.max(f.left + EDGE, Math.min(want, f.right - EDGE - w));
      setAt((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    let raf = 0;
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    window.addEventListener("scroll", soon, true);
    window.addEventListener("resize", soon);
    const ro = new ResizeObserver(soon);
    if (box.current) ro.observe(box.current);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", soon, true);
      window.removeEventListener("resize", soon);
      ro.disconnect();
    };
  }, [anchor]);
  useEffect(() => {
    const off = (e: PointerEvent) => {
      const t = e.target as Node;
      // the button that opened it toggles it itself
      if (!box.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose, anchor]);
  const found = useMemo(() => (q.trim() ? matchEmoji(q.trim(), 40) : null), [q]);
  const pick = (char: string) => {
    saveRecent(char);
    onPick(char);
  };
  const cell = (em: Emoji) => (
    <button key={em.char} className="chat-emoji-cell" onClick={() => pick(em.char)} data-tip={`:${em.names[0]}:`} aria-label={em.names[0]}>
      {em.char}
    </button>
  );
  const picker = (
    <motion.div
      ref={box}
      className={`chat-emoji-picker${anchor ? " is-on-page" : ""} ${className}`}
      style={anchor ? { left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? undefined : "hidden" } : undefined}
      initial={{ opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 38 }}
      onKeyDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Pick an emoji"
    >
      <input
        className="chat-emoji-search"
        autoFocus
        placeholder="Find an emoji"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && found?.[0]) pick(found[0].char);
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="chat-emoji-scroll">
        {found ? (
          found.length ? <div className="chat-emoji-grid">{found.map(cell)}</div> : <p className="chat-emoji-none">No emoji by that name</p>
        ) : (
          <>
            {recent.length > 0 && (
              <section>
                <h4>Used lately</h4>
                <div className="chat-emoji-grid">{recent.map((c) => cell({ char: c, names: [EMOJI_GROUPS.flatMap((g) => g.emoji).find((x) => x.char === c)?.names[0] ?? c] }))}</div>
              </section>
            )}
            {EMOJI_GROUPS.map((g) => (
              <section key={g.id}>
                <h4>{g.name}</h4>
                <div className="chat-emoji-grid">{g.emoji.map(cell)}</div>
              </section>
            ))}
          </>
        )}
      </div>
    </motion.div>
  );
  return anchor ? createPortal(picker, document.body) : picker;
}

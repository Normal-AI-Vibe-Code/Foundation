/**
 * A small emoji picker: a field that finds by name, the ones this device used last, then the curated set
 * in its groups (chat/emoji.ts). Raised paper, pane radius; a press outside or Esc puts it away.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { EMOJI_GROUPS, loadRecents, matchEmoji, saveRecent, type Emoji } from "./emoji";

export function EmojiPicker({ onPick, onClose, className = "" }: { onPick(char: string): void; onClose(): void; className?: string }) {
  const [q, setQ] = useState("");
  const [recent] = useState(loadRecents);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
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
  }, [onClose]);
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
  return (
    <motion.div
      ref={box}
      className={`chat-emoji-picker ${className}`}
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
}

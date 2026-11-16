/**
 * Where you are when a section is open as its own grid (2026-11-11, Josh:
 * "The individual sections are actually grids within themselves, so opening
 * them up to fullscreen opens up a full other grid"). A glass pill under the
 * top bar: ⤡ back up one level (Esc), then the path, the board first; a
 * press on any step goes there. Nothing shows on the board itself.
 */
import { useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getState, levelPath, levelUp, openLevel, subscribe } from "../state/store";
import { activeBoard } from "../sync/board";

const levelKey = () => {
  const st = getState();
  return st.level ? levelPath(st.level).map((s) => `${s.id}\u0000${s.name}`).join("\u0001") : "";
};

export function LevelBar({ boardName }: { boardName?: string }) {
  const key = useSyncExternalStore(subscribe, levelKey);
  const path = key ? levelPath() : [];
  return (
    <AnimatePresence>
      {path.length > 0 && (
        <motion.nav
          key="level"
          className="level-bar f-glass"
          aria-label="Where you are"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        >
          <button className="level-back" onClick={levelUp} data-tip={path.length > 1 ? `Back to ${path[path.length - 2].name}` : "Back to the grid"} data-kbd="Esc">
            <span aria-hidden>⤡</span>
          </button>
          <button className="level-step" onClick={() => openLevel(null)}>
            {boardName ?? activeBoard()?.boardId ?? "Board"}
          </button>
          {path.map((s, i) => (
            <span key={s.id} className="level-crumb">
              <span className="level-sep" aria-hidden>
                ›
              </span>
              {i === path.length - 1 ? (
                <span className="level-here" aria-current="page">
                  <span className="level-glyph" aria-hidden>
                    ▦
                  </span>
                  {s.name}
                </span>
              ) : (
                <button className="level-step" onClick={() => openLevel(s.id)}>
                  {s.name}
                </button>
              )}
            </span>
          ))}
        </motion.nav>
      )}
    </AnimatePresence>
  );
}

/**
 * Where you are, and the way back up. A glass pill under the top bar: ⤡ back up one step, then the
 * path, outermost first; a press on any step goes there. Nothing shows on the board itself.
 *
 * Two kinds of step, one path:
 *  - **grids inside grids** (2026-11-17): a grid that sits inside another shows the grids above it.
 *    A press opens that grid framed on the section that stands for the one you came from; ⤡ does the
 *    same for the grid directly above.
 *  - **a section open in this window** (2026-11-11, "n more · Expand", a grid section's ⤢): the board,
 *    then each section on the way; ⤡ and Esc go up a level. Such a view is this window's alone, so the
 *    pill offers what makes it everyone's: **Make it a grid** (asked once, here), which moves the
 *    section's cards into a real grid inside this one (lib/subgrid.ts).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getState, levelPath, levelUp, openLevel, subscribe } from "../state/store";
import { activeBoard, onBoardChange } from "../sync/board";
import { gridPath, useGrids } from "../lib/grids";
import { makeSectionAGrid, openParentGrid } from "../lib/subgrid";
import { useUi } from "../state/ui";

const levelKey = () => {
  const st = getState();
  return st.level ? levelPath(st.level).map((s) => `${s.id}\u0000${s.name}`).join("\u0001") : "";
};

export function LevelBar({ boardName }: { boardName?: string }) {
  const key = useSyncExternalStore(subscribe, levelKey);
  const path = key ? levelPath() : [];
  const boardId = useSyncExternalStore(onBoardChange, () => activeBoard()?.boardId ?? null);
  const grids = useGrids();
  const role = useUi().role;
  const me = grids.find((b) => b.id === boardId);
  // the grids this one is inside, outermost first
  const above = me ? gridPath(me, grids) : [];
  const here = path[path.length - 1];
  const [sure, setSure] = useState<string | null>(null);
  useEffect(() => setSure(null), [key, boardId]);
  const name = boardName ?? me?.name ?? boardId ?? "Board";
  const up = above[above.length - 1];
  return (
    <AnimatePresence>
      {(path.length > 0 || above.length > 0) && (
        <motion.nav
          key="level"
          className="level-bar f-glass"
          aria-label="Where you are"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        >
          {path.length > 0 ? (
            <button className="level-back" onClick={levelUp} data-tip={path.length > 1 ? `Back to ${path[path.length - 2].name}` : "Back to the grid"} data-kbd="Esc">
              <span aria-hidden>⤡</span>
            </button>
          ) : (
            <button className="level-back" onClick={() => openParentGrid(up.id, boardId!)} data-tip={`Up to ${up.name}, the grid this one is inside`} aria-label={`Up to ${up.name}`}>
              <span aria-hidden>⤡</span>
            </button>
          )}
          {above.map((g, i) => (
            <span key={g.id} className="level-crumb">
              <button className="level-step" data-level-grid={g.id} onClick={() => openParentGrid(g.id, above[i + 1]?.id ?? boardId!)}>
                {g.name}
              </button>
              <span className="level-sep" aria-hidden>
                ›
              </span>
            </span>
          ))}
          {path.length > 0 ? (
            <button className="level-step" onClick={() => openLevel(null)}>
              {name}
            </button>
          ) : (
            <span className="level-here" aria-current="page">
              <span className="level-glyph" aria-hidden>
                ▦
              </span>
              {name}
            </span>
          )}
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
          {here && role !== "viewer" &&
            (sure === here.id ? (
              <span className="level-make-ask" role="alertdialog" aria-label={`Make ${here.name} its own grid?`}>
                <span className="level-make-words">Its cards move into a new grid inside this one.</span>
                <button className="level-make is-go" onClick={() => void makeSectionAGrid(here.id)}>
                  Make it a grid
                </button>
                <button className="level-make" onClick={() => setSure(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button className="level-make" onClick={() => setSure(here.id)} data-tip="This view is yours alone. Make it a real grid inside this one: it shows in All Grids, and this section keeps a preview of it">
                Make it a grid…
              </button>
            ))}
        </motion.nav>
      )}
    </AnimatePresence>
  );
}

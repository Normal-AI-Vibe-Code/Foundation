/**
 * Three cards Foundation makes for itself (2026-11-15):
 *
 *  - **A grid inside this one** (`panel: "grid"`): the section that holds it stands for a child grid.
 *    The server puts it there when a grid is dragged into another in the side menu, or when a section
 *    is made a grid of its own (boards.ts, subgrids.ts), so the link is on the parent grid itself, not
 *    only in the menu. It says what the child holds and draws it in miniature; a press opens it. A grid
 *    that has since moved away keeps its card here: the same preview, and where it is now
 *    (GridLinkCard.tsx).
 *  - **Kanban** (`panel: "kanban"`): columns of cards moved between them. `source: "plan"` is
 *    Foundation's own plan (docs/plan.json), the board Settings → Plan shows.
 *  - **Design chapter** (`panel: "design"`): one chapter of the design language, live on its tokens.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DESIGN_CHAPTERS, type DesignChapter } from "@foundation/protocol";
import { api } from "../lib/api";
import { childrenOf, openGrid, useGrids } from "../lib/grids";
import { openParentGrid } from "../lib/subgrid";
import { removePanel, type PanelMeta } from "../state/store";
import { useUi } from "../state/ui";
import { activeBoard, onBoardChange } from "../sync/board";
import { PlanTab } from "../settings/SettingsPage";
import { DesignPage } from "../design/DesignPage";
import { GridLinkCard, type Outline } from "./GridLinkCard";
import "./system-cards.css";

/** how often a card on screen asks what its grid holds now */
const OUTLINE_EVERY_MS = 4000;

/**
 * What a grid holds: asked when the card arrives, when the list of grids changes, and every few
 * seconds while the card is on screen in a window that's showing (the grid it stands for is someone
 * else's work in progress). An answer that says nothing new changes nothing here.
 */
function useOutline(board: string | undefined, el: React.RefObject<HTMLElement | null>) {
  const [o, setO] = useState<Outline | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!board) return;
    let live = true;
    let last = "";
    let onScreen = true;
    const read = () =>
      void api<Outline>(`/api/boards/${encodeURIComponent(board)}/outline`).then(
        (r) => {
          if (!live) return;
          const text = JSON.stringify(r);
          if (text !== last) setO(r);
          last = text;
          setGone(false);
        },
        () => live && setGone(true),
      );
    read();
    const io = typeof IntersectionObserver === "function" && el.current ? new IntersectionObserver((es) => (onScreen = es.some((e) => e.isIntersecting))) : null;
    if (io && el.current) io.observe(el.current);
    const tick = window.setInterval(() => {
      if (onScreen && document.visibilityState === "visible") read();
    }, OUTLINE_EVERY_MS);
    window.addEventListener("foundation:boards", read);
    return () => {
      live = false;
      io?.disconnect();
      window.clearInterval(tick);
      window.removeEventListener("foundation:boards", read);
    };
  }, [board, el]);
  return { outline: o, gone };
}

export function GridLinkBody({ panel }: { panel: PanelMeta }) {
  const grids = useGrids();
  const ui = useUi();
  const here = useSyncExternalStore(onBoardChange, () => activeBoard()?.boardId ?? null);
  const wrap = useRef<HTMLDivElement>(null);
  const child = grids.find((b) => b.id === panel.board);
  const { outline, gone } = useOutline(panel.board, wrap);
  const inside = panel.board ? childrenOf(panel.board, grids) : [];
  if (!panel.board || (gone && !child))
    return (
      <div className="grid-link is-gone">
        <p>This grid isn't here any more, or you can't open it.</p>
      </div>
    );
  const board = panel.board;
  return (
    <div className="grid-link-wrap" ref={wrap}>
      <GridLinkCard
        board={board}
        name={outline?.name ?? child?.name ?? panel.name}
        kind={child?.kind}
        outline={outline}
        here={here}
        inside={inside}
        onOpen={() => openGrid(board)}
        onOpenGrid={openGrid}
        onOpenWhere={(parent) => openParentGrid(parent, board)}
        onRemove={ui.role === "viewer" ? undefined : () => removePanel(panel.id)}
      />
    </div>
  );
}

export function KanbanBody({ panel }: { panel: PanelMeta }) {
  if (panel.source !== "plan")
    return (
      <div className="kanban-card">
        <p className="kanban-note">This kanban has nothing to show yet: only Foundation's own plan is one so far.</p>
      </div>
    );
  return (
    <div className="kanban-card wheel-own" data-kanban="plan">
      <PlanTab />
    </div>
  );
}

export function DesignBody({ panel }: { panel: PanelMeta }) {
  const chapter = DESIGN_CHAPTERS.find((c) => c.id === panel.source)?.id as DesignChapter | undefined;
  if (!chapter)
    return (
      <div className="design-card">
        <p className="kanban-note">No such chapter of the design language.</p>
      </div>
    );
  return (
    <div className="design-card wheel-own" data-design-chapter={chapter}>
      <DesignPage chapter={chapter} />
    </div>
  );
}

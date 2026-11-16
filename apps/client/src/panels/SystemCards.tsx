/**
 * Three cards Foundation makes for itself (2026-11-15):
 *
 *  - **A grid inside this one** (`panel: "grid"`): the section that holds it stands for a child grid.
 *    The server puts it there when a grid is dragged into another in the side menu (boards.ts), so the
 *    link is on the parent grid itself, not only in the menu. It says what the child holds; a press
 *    opens it.
 *  - **Kanban** (`panel: "kanban"`): columns of cards moved between them. `source: "plan"` is
 *    Foundation's own plan (docs/plan.json), the board Settings → Plan shows.
 *  - **Design chapter** (`panel: "design"`): one chapter of the design language, live on its tokens.
 */

import { useEffect, useState } from "react";
import { DESIGN_CHAPTERS, type DesignChapter } from "@foundation/protocol";
import { api } from "../lib/api";
import { KIND_GLYPH, childrenOf, openGrid, useGrids } from "../lib/grids";
import type { PanelMeta } from "../state/store";
import { PlanTab } from "../settings/SettingsPage";
import { DesignPage } from "../design/DesignPage";
import "./system-cards.css";

interface Outline {
  sections: Array<{ id: string; name: string; cards: number; grids: number }>;
  cards: number;
  updatedAt: number | null;
}

/** what a grid holds, asked once and again when the list of grids changes */
function useOutline(board: string | undefined) {
  const [o, setO] = useState<Outline | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!board) return;
    let live = true;
    const read = () =>
      void api<Outline>(`/api/boards/${encodeURIComponent(board)}/outline`).then(
        (r) => live && (setO(r), setGone(false)),
        () => live && setGone(true),
      );
    read();
    window.addEventListener("foundation:boards", read);
    return () => {
      live = false;
      window.removeEventListener("foundation:boards", read);
    };
  }, [board]);
  return { outline: o, gone };
}

export function GridLinkBody({ panel }: { panel: PanelMeta }) {
  const grids = useGrids();
  const child = grids.find((b) => b.id === panel.board);
  const { outline, gone } = useOutline(panel.board);
  const inside = panel.board ? childrenOf(panel.board, grids) : [];
  if (!panel.board || (gone && !child))
    return (
      <div className="grid-link is-gone">
        <p>This grid isn't here any more, or you can't open it.</p>
      </div>
    );
  return (
    <div className="grid-link" data-grid-link={panel.board}>
      <button className="grid-link-open" onClick={() => openGrid(panel.board!)} aria-label={`Open ${child?.name ?? panel.name}`}>
        <span className="grid-link-eyebrow f-eyebrow">A grid inside this one</span>
        <span className="grid-link-name">
          <span className="grid-link-glyph">{KIND_GLYPH[child?.kind ?? "grid"]}</span>
          {child?.name ?? panel.name}
        </span>
        <span className="grid-link-facts">
          {outline ? (
            <>
              {outline.sections.length} {outline.sections.length === 1 ? "section" : "sections"} · {outline.cards} {outline.cards === 1 ? "card" : "cards"}
              {inside.length > 0 && ` · ${inside.length} ${inside.length === 1 ? "grid" : "grids"} inside`}
            </>
          ) : (
            "Reading it…"
          )}
        </span>
        <span className="grid-link-go f-pill is-accent">Open the grid →</span>
      </button>
      {outline && outline.sections.length > 0 && (
        <ul className="grid-link-sections" aria-label="Its sections">
          {outline.sections.slice(0, 12).map((s) => (
            <li key={s.id}>
              <span className="grid-link-sec">{s.name}</span>
              <span className="grid-link-count">{s.grids ? `▦ ${s.grids}` : s.cards}</span>
            </li>
          ))}
          {outline.sections.length > 12 && <li className="grid-link-more">and {outline.sections.length - 12} more</li>}
        </ul>
      )}
      {inside.length > 0 && (
        <div className="grid-link-kids">
          {inside.map((k) => (
            <button key={k.id} className="f-pill" onClick={() => openGrid(k.id)}>
              {KIND_GLYPH[k.kind ?? "grid"]} {k.name}
            </button>
          ))}
        </div>
      )}
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

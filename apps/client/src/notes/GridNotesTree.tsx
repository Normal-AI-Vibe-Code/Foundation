/**
 * The side menu's Notes, under the pages: every grid's notes, in the grids they are in (2026-11-26, Josh: "List
 * them all, and make sure their hierarchy refers back to the grids that they are in"). The tree is All Grids'
 * own (a grid inside a grid stays inside it), kept to the grids that hold notes, each grid's notes under the
 * section they sit in (a section inside a section named by its path). A grid's own note opens full size over its
 * grid, its path leading back there; a card showing a page (the sheet) opens the page. The open grid starts
 * unfolded; the others fold.
 */

import { useMemo, useState } from "react";
import { childrenOf, type BoardRow } from "../lib/grids";
import { useUi } from "../state/ui";
import { SpaceGlyph } from "../shell/SpaceGlyph";
import { openGridNote, useGridNotes, type GridNote } from "./gridNotes";
import "./blocks.css";

export function GridNotesTree({ grids, current, live }: { grids: BoardRow[]; current: string; live: boolean }) {
  const ui = useUi();
  const all = useGridNotes(live);
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? [current] : []));
  const [shut, setShut] = useState<Set<string>>(() => new Set());

  /** how many notes a grid holds, with the grids inside it */
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    const count = (id: string, n = 0): number => {
      if (c.has(id)) return c.get(id)!;
      if (n > 64) return 0;
      const total = (all[id]?.length ?? 0) + childrenOf(id, grids).reduce((s, k) => s + count(k.id, n + 1), 0);
      c.set(id, total);
      return total;
    };
    for (const g of grids) count(g.id);
    return c;
  }, [all, grids]);

  const isOpen = (id: string) => (open.has(id) || id === current) && !shut.has(id);
  const flip = (id: string) => {
    const now = isOpen(id);
    setOpen((s) => {
      const n = new Set(s);
      if (now) n.delete(id);
      else n.add(id);
      return n;
    });
    setShut((s) => {
      const n = new Set(s);
      if (now) n.add(id);
      else n.delete(id);
      return n;
    });
  };

  const noteRow = (g: BoardRow, n: GridNote, depth: number) => (
    <div key={n.id} className="space-row grid-note-row" style={{ ["--depth" as string]: depth } as React.CSSProperties} data-grid-note-row={n.id}>
      <span className="grid-caret is-none" aria-hidden />
      <button
        type="button"
        className={`pane-row space-open${ui.noteOpen?.note === n.id ? " is-current" : ""}`}
        onClick={() => openGridNote(g.id, n)}
        data-tip={n.ref ? `${n.name} · a page, on ${g.name} as a card · opens the page` : `${n.name} · on ${g.name}${n.sectionPath ? ` › ${n.sectionPath}` : ""}${n.preview ? ` · ${n.preview}` : ""}`}
      >
        <span className="pane-glyph" aria-hidden>
          {n.ref ? "▤" : "¶"}
        </span>
        <span className="pane-label" title={n.name}>
          {n.name || "A note"}
        </span>
      </button>
    </div>
  );

  const gridNode = (g: BoardRow, depth: number): React.ReactNode => {
    const total = counts.get(g.id) ?? 0;
    if (!total) return null;
    const on = isOpen(g.id);
    const mine = all[g.id] ?? [];
    // the grid's notes, section by section (in the order the server keeps: by the section's path)
    const bySection: [string, GridNote[]][] = [];
    for (const n of mine) {
      const last = bySection[bySection.length - 1];
      if (last && last[0] === n.sectionPath) last[1].push(n);
      else bySection.push([n.sectionPath, [n]]);
    }
    return (
      <div key={g.id} className="grid-node" data-notes-grid={g.id}>
        <div className={`space-row is-folder${g.id === current && !ui.noteOpen ? " is-current" : ""}`} style={{ ["--depth" as string]: depth } as React.CSSProperties}>
          <button type="button" className={`grid-caret${on ? " is-open" : ""}`} aria-expanded={on} aria-label={on ? `Fold ${g.name}'s notes` : `Unfold ${g.name}'s notes`} onClick={() => flip(g.id)}>
            ›
          </button>
          <button type="button" className="pane-row space-open" onClick={() => flip(g.id)} data-tip={`${g.name}: its notes, by section`}>
            <span className="pane-glyph" aria-hidden>
              <SpaceGlyph space={g} />
            </span>
            <span className="pane-label" title={g.name}>
              {g.name}
            </span>
            <span className="pane-when">{total}</span>
          </button>
        </div>
        {on && (
          <>
            {childrenOf(g.id, grids).map((k) => gridNode(k, depth + 1))}
            {bySection.map(([path, notes]) => (
              <div key={path} className="grid-note-section" role="group" aria-label={path || g.name}>
                {path && (
                  <div className="grid-note-where" style={{ ["--depth" as string]: depth + 1 } as React.CSSProperties} title={`${g.name} › ${path}`}>
                    {path}
                  </div>
                )}
                {notes.map((n) => noteRow(g, n, depth + 1))}
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  const tops = childrenOf(null, grids).filter((g) => (counts.get(g.id) ?? 0) > 0);
  return (
    <>
      <div className="pane-eyebrow grid-notes-eyebrow">On grids</div>
      {tops.length ? tops.map((g) => gridNode(g, 0)) : <div className="pane-empty">No notes on any grid you can see yet.</div>}
    </>
  );
}

/**
 * A collection's card (protocol collections.ts; server collections.ts). It gathers what the cards wired into
 * its input make: from the Character studio's flow, the pictures drawn at a stage (sheets, expression sheets,
 * portraits) or, from Output, the finished characters; from another collection, what that one holds.
 *
 * Folded, it is a small stack of the newest things it has, how many, and where they came from. **Expand**
 * opens it into a grid of tiles, each pressed and pulled out as a copy onto the grid (lib/collectionDrag.ts):
 * into a section where it's let go, or into a new section on an empty cell or past an edge. **Lay out in**
 * pipes it into a section: everything it holds is laid there, a card each, docked so the section's own flow
 * arranges them, and what it gathers later follows. Its output can also be dragged onto a section to do the
 * same.
 *
 * What it holds is the server's (people can't write the board's `collections` map), so every press here is
 * one of the board's tools.
 */

import { useMemo, useRef, useSyncExternalStore } from "react";
import { boardMaps, type CollectionItem, type CollectionState } from "@foundation/protocol";
import { CONTENT_PAD, SECTION_HEADER, addSectionAdjacent, getState, requestSnap, sectionCardRect, sectionFit, subscribe, updatePanel, type PanelMeta } from "../state/store";
import { activeBoard, onBoardChange } from "../sync/board";
import { toast, useUi } from "../state/ui";
import { useFileSrc } from "../lib/fileSrc";
import { boardTool, pressTile } from "../lib/collectionDrag";
import "./collection.css";

const EMPTY: CollectionState = { items: [] };
/** a collection's size folded (the store's PANEL_SIZE) and opened */
export const FOLDED = { w: 360, h: 420 };
export const OPENED = { w: 920, h: 700 };

/** a collection's state as the board has it, re-read when the server writes it */
export function useCollection(id: string): CollectionState {
  const key = useSyncExternalStore(
    (fn) => {
      let off = () => {};
      const watch = () => {
        off();
        const b = activeBoard();
        if (!b) return;
        const map = boardMaps(b.doc).collections;
        map.observe(fn);
        off = () => map.unobserve(fn);
      };
      watch();
      const offBoard = onBoardChange(() => (watch(), fn()));
      return () => (off(), offBoard());
    },
    () => {
      const b = activeBoard();
      const st = b ? boardMaps(b.doc).collections.get(id) : undefined;
      return st ? JSON.stringify(st) : "";
    },
  );
  return useMemo(() => (key ? (JSON.parse(key) as CollectionState) : EMPTY), [key]);
}

/** a section's content room, in its own (unfitted) pixels: what a card inside it can span */
function sectionRoom(id: string): { w: number; h: number } | null {
  const st = getState();
  const sec = st.sections[id];
  if (!sec) return null;
  const card = sectionCardRect(st.grid, sec);
  const f = sectionFit(id);
  return { w: Math.floor((card.w - 2) / f - CONTENT_PAD * 2), h: Math.floor((card.h - 2 - SECTION_HEADER) / f - CONTENT_PAD * 2) };
}

/** the sections a collection can lay out in: every section of this grid that holds cards (not a grid of sections) */
function useSections(): Array<{ id: string; name: string }> {
  const key = useSyncExternalStore(subscribe, () => {
    const all = Object.values(getState().allSections);
    const parents = new Set(all.map((s) => s.parent).filter(Boolean));
    return all
      .filter((s) => !parents.has(s.id))
      .map((s) => `${s.id}\t${s.name}`)
      .sort((a, b) => a.split("\t")[1].localeCompare(b.split("\t")[1]))
      .join("\n");
  });
  return useMemo(() => (key ? key.split("\n").map((l) => ({ id: l.split("\t")[0], name: l.split("\t")[1] })) : []), [key]);
}

function Picture({ src, name }: { src?: string; name: string }) {
  const url = useFileSrc(src ?? null);
  return url ? <img src={url} alt={name} draggable={false} loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : <i aria-hidden>{src ? "" : "☺"}</i>;
}

/** the size of the card a copy of an item makes (the server's: a character's card, a picture 300 wide at its shape) */
const copySize = (it: CollectionItem) => (it.kind === "character" ? { w: 460, h: 720 } : { w: 300, h: it.w && it.h ? Math.round((300 * it.h) / it.w) : 300 });

function Tile({ it, collection, open, viewer, at }: { it: CollectionItem; collection: string; open: boolean; viewer: boolean; at?: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const movable = open && !viewer;
  return (
    <li
      ref={ref}
      className={`coll-tile kind-${it.kind}${movable ? " is-movable" : ""}`}
      data-coll-item={it.key}
      data-coll-name={it.name}
      data-tip={movable ? `Drag a copy of ${it.name} onto the grid` : undefined}
      style={at !== undefined ? { ["--i" as string]: at } : undefined}
      onPointerDown={movable ? (e) => ref.current && pressTile(e, ref.current, collection, it.key, it.name, copySize(it)) : undefined}
    >
      <span className="coll-pic">
        <Picture src={it.src} name={it.name} />
      </span>
      {open && (
        <span className="coll-words">
          <b>{it.name}</b>
          <span>{it.kind === "character" ? (it.form === "mesh" ? "character · mesh avatar" : "character · 3D") : it.from}</span>
        </span>
      )}
      {open && !viewer && (
        <button
          type="button"
          className="coll-out"
          aria-label={`Take ${it.name} out of the collection`}
          data-tip="Take it out (cards made from it stay)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void boardTool("collection_take_out", { collection, item: it.key, confirm: true }).catch((e) => toast((e as Error).message, "bad"))}
        >
          ×
        </button>
      )}
    </li>
  );
}

export interface CardProps {
  name: string;
  state: CollectionState;
  sections: Array<{ id: string; name: string }>;
  /** its own section (not offered as somewhere to lay out, unless it already is) */
  home: string;
  open: boolean;
  viewer: boolean;
  /** the collection's card id: what a tile's drag and its × name (absent on the design page: tiles don't move) */
  id?: string;
  onToggle?(): void;
  onInto?(value: string): void;
  onGo?(section: string): void;
}

/** a collection's card from what it's given: the grid's (CollectionBody) and the design page's */
export function CollectionCard({ name, state: st, sections, home, open, viewer, id, onToggle, onInto, onGo }: CardProps) {
  const into = st.into ? sections.find((s) => s.id === st.into) : undefined;
  const items = st.items;
  const sources = useMemo(() => [...new Set(items.map((i) => i.from).filter(Boolean))], [items]);
  const newest = useMemo(() => items.slice(-5).reverse(), [items]);
  const still = viewer || !id;
  return (
    <div className={`coll-body wheel-own${open ? " is-open" : ""}`} data-collection={name} data-coll-count={items.length} data-coll-open={open || undefined}>
      <header className="coll-head">
        <span className="coll-kind">
          Collection <i>{items.length}</i>
        </span>
        <button type="button" className="f-pill coll-expand" data-coll-toggle onClick={onToggle} data-tip={open ? "Fold it back to a stack" : "Open it, to drag copies out onto the grid"}>
          {open ? "Fold" : "Expand"}
        </button>
      </header>
      <p className="coll-from">{sources.length ? `From ${sources.slice(0, 3).join(", ")}${sources.length > 3 ? ` and ${sources.length - 3} more` : ""}` : "Wire a node's output into it, and what that node makes gathers here"}</p>

      {items.length === 0 ? (
        <div className="coll-empty">
          <span aria-hidden>❖</span>
          <p>Nothing yet. From the Character studio's flow, a stage's wire brings its pictures and Output brings the finished characters.</p>
        </div>
      ) : open ? (
        <ul className="coll-grid">
          {[...items].reverse().map((it) => (
            <Tile key={it.key} it={it} collection={id ?? ""} open viewer={still} />
          ))}
        </ul>
      ) : (
        <button type="button" className="coll-stack" onClick={onToggle} data-tip="Open it">
          <ul>
            {newest.map((it, i) => (
              <Tile key={it.key} it={it} collection={id ?? ""} open={false} viewer={still} at={i} />
            ))}
          </ul>
          <span className="coll-stack-n">{items.length === 1 ? "1 thing" : `${items.length} things`}</span>
        </button>
      )}

      <footer className="coll-foot">
        <label className="coll-into">
          <span>Lay out in</span>
          <select value={st.into ?? ""} disabled={viewer} data-coll-into onChange={(e) => onInto?.(e.target.value)}>
            <option value="">Nowhere</option>
            {sections
              .filter((s) => s.id !== home || s.id === st.into)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            <option value="+right">A new section to the right</option>
            <option value="+below">A new section below</option>
          </select>
        </label>
        {into && (
          <button type="button" className="coll-go" onClick={() => onGo?.(into.id)} data-tip={`Go to ${into.name}`}>
            {Object.keys(st.laid ?? {}).length} laid ›
          </button>
        )}
      </footer>
    </div>
  );
}

export function CollectionBody({ panel }: { panel: PanelMeta }) {
  const ui = useUi();
  const st = useCollection(panel.id);
  const sections = useSections();
  const open = panel.settings?.open === "1";

  const toggle = () => {
    const was = panel.settings ?? {};
    if (open) {
      // folded back to its size and its place
      const back = { w: Number(was.fw) || FOLDED.w, h: Number(was.fh) || FOLDED.h, ...(panel.float && was.fx ? { x: Number(was.fx), y: Number(was.fy) } : {}) };
      updatePanel(panel.id, { ...back, settings: { ...was, open: "0" } });
      return;
    }
    // opened, it stays inside its section: a floating one at the section's right (a collection after a flow's
    // Output) moves left to fit while it's open, over the cards beside it, and goes back when it's folded
    const room = sectionRoom(panel.sectionId);
    const w = Math.max(panel.w, room ? Math.min(OPENED.w, room.w) : OPENED.w);
    const h = Math.max(panel.h, room ? Math.min(OPENED.h, room.h - panel.y) : OPENED.h);
    const x = panel.float && room ? Math.max(0, Math.min(panel.x, room.w - w)) : panel.x;
    updatePanel(panel.id, { w, h, x, settings: { ...was, open: "1", fw: String(panel.w), fh: String(panel.h), fx: String(panel.x), fy: String(panel.y) } });
  };
  const layIn = (section: string | null) =>
    void boardTool<{ into: string | null; laid: number }>("collection_lay_out", { collection: panel.id, section })
      .then((r) => toast(r.into ? `Laying ${panel.name} out in ${getState().allSections[r.into]?.name ?? "its section"}${r.laid ? `: ${r.laid} laid` : ""}` : `${panel.name} isn't laid out anywhere now`, "ok"))
      .catch((e) => toast((e as Error).message, "bad"));
  const choose = (v: string) => {
    if (v === st.into) return;
    if (v === "") return st.into ? layIn(null) : undefined;
    if (v === "+below" || v === "+right") {
      const id = addSectionAdjacent(panel.sectionId, v === "+below" ? "below" : "right");
      if (id) layIn(id);
      return;
    }
    layIn(v);
  };
  return <CollectionCard name={panel.name} state={st} sections={sections} home={panel.sectionId} open={open} viewer={ui.role === "viewer"} id={panel.id} onToggle={toggle} onInto={choose} onGo={(id) => requestSnap({ kind: "section", id })} />;
}

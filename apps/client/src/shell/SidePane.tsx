/**
 * The side menu, drawn on the floor (the paper and its dots run underneath; the cards stop at its
 * hairline). Folded by the top bar's first button or ⌘\, resized by its right edge. It is open the
 * first time Foundation runs: it is how you get to a grid.
 *
 * Top to bottom: **Grids** (Today lives in the top bar's right end since 2026-11-17), listed two
 * ways, in an outlined pill whose left edge the rows start at: **Recent** (every grid by when this
 * device last opened it, a grid inside another saying which) and **All Grids** (the tree: a grid
 * can hold grids). Drag a grid onto another and it becomes its child, here and on the parent grid
 * itself, where a section stands for it (the server keeps that link: boards.ts). Drag it onto
 * "All Grids" to bring it back to the top. Then **Settings**, and you.
 *
 * What belongs to the open grid (its people, its activity) is the other pane (SpaceInfo.tsx),
 * opened from the grid's tab.
 */

import { SunGlyph, PlusGlyph } from "./glyphs";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { UserInfo } from "@foundation/protocol";
import { WIDTHS, setUi, spaceOpenedAt, toast, useUi } from "../state/ui";
import { logout } from "../lib/api";
import { KIND_NAME, childrenOf, isPageKind, fileGrid, parentOf, wouldLoop, type BoardRow, type SpaceKind } from "../lib/grids";
import { goSettings, type Place } from "../lib/place";
import { initials } from "./Presence";
import { FloorEdge } from "./FloorEdge";
import { ServerSwitch } from "../server/ServerSwitch";
import { NightOrb } from "./NightOrb";
import { SpaceGlyph } from "./SpaceGlyph";
import { LOCAL_GRID_ID } from "@foundation/protocol";
import { LocalRowDot } from "../panels/LocalView";
import { isNight, setNight } from "@foundation/ui";

interface Props {
  user: UserInfo;
  boards: BoardRow[];
  current: string;
  place: Place;
  onSwitch(id: string): void;
  onNew(kind?: SpaceKind, parent?: string | null): void;
}

export const paneSpring = { type: "spring", stiffness: 340, damping: 34 } as const;

/** grids Foundation keeps for itself (the plan, the design language): reached from Settings, not listed */
export const isSystemGrid = (id: string) => id.startsWith("foundation-");

const DRAG = "application/x-foundation-grid";

export function SidePane({ user, boards, current, place, onSwitch, onNew }: Props) {
  const ui = useUi();
  const viewer = user.role === "viewer";
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  /** where the server switch draws its panel: above the Settings band */
  const [serverSlot, setServerSlot] = useState<HTMLDivElement | null>(null);
  /** the grid being dragged, and the row (or "top") it's over */
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const listed = useMemo(() => boards.filter((b) => !isSystemGrid(b.id)), [boards]);
  const recent = useMemo(() => {
    const at = spaceOpenedAt();
    return [...listed].sort((a, b) => (at[b.id] ?? b.updated_at ?? 0) - (at[a.id] ?? a.updated_at ?? 0));
    // re-sorted when the open grid changes (it just became the most recent)
  }, [listed, current]); // eslint-disable-line react-hooks/exhaustive-deps

  const canTake = (into: string | null) => !!drag && (into === null ? !!parentOf(boards.find((b) => b.id === drag)!, listed) : !wouldLoop(drag, into, listed) && !isPageKind(listed.find((b) => b.id === into)?.kind) && boards.find((b) => b.id === drag)?.parent !== into);
  const drop = async (into: string | null) => {
    const id = drag;
    setDrag(null);
    setOver(null);
    if (!id || !canTake(into)) return;
    const me = listed.find((b) => b.id === id);
    const err = await fileGrid(id, into);
    if (err) return toast(err, "bad");
    if (into) {
      setShut((s) => {
        const n = new Set(s);
        n.delete(into);
        return n;
      });
      setUi({ spacesView: "all" });
      toast(`${me?.name ?? "The grid"} is inside ${listed.find((b) => b.id === into)?.name ?? "it"} now`, "ok");
    } else toast(`${me?.name ?? "The grid"} is back at the top of All Grids`, "ok");
  };

  const dragProps = (b: BoardRow) =>
    viewer || b.role === "viewer"
      ? {}
      : {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG, b.id);
            e.dataTransfer.effectAllowed = "move";
            setDrag(b.id);
          },
          onDragEnd: () => {
            setDrag(null);
            setOver(null);
          },
        };
  const dropProps = (into: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canTake(into)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== (into ?? "top")) setOver(into ?? "top");
    },
    onDragLeave: () => over === (into ?? "top") && setOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      void drop(into);
    },
  });

  const row = (b: BoardRow, depth: number, tree: boolean): React.ReactNode => {
    const kids = tree ? childrenOf(b.id, listed) : [];
    const open = !shut.has(b.id);
    const parent = parentOf(b, listed);
    const kind = b.kind ?? "grid";
    return (
      <div key={b.id} className="grid-node">
        <div
          className={`space-row${b.id === current && place.kind === "grid" ? " is-current" : ""}${drag === b.id ? " is-dragging" : ""}${over === b.id ? " is-over" : ""}`}
          style={{ ["--depth" as string]: depth } as React.CSSProperties}
          data-space-drop={b.id}
          data-space-name={b.name}
          data-space-kind={kind}
          data-grid-row={b.id}
          {...dragProps(b)}
          {...dropProps(b.id)}
        >
          {tree && kids.length > 0 ? (
            <button
              className={`grid-caret${open ? " is-open" : ""}`}
              aria-expanded={open}
              aria-label={open ? `Fold ${b.name}` : `Unfold ${b.name}`}
              onClick={() =>
                setShut((s) => {
                  const n = new Set(s);
                  if (n.has(b.id)) n.delete(b.id);
                  else n.add(b.id);
                  return n;
                })
              }
            >
              ›
            </button>
          ) : (
            tree && <span className="grid-caret is-none" aria-hidden />
          )}
          <button className="pane-row space-open" onClick={() => onSwitch(b.id)} data-tip={`${KIND_NAME[kind]}${parent ? ` · inside ${parent.name}` : ""}${viewer ? "" : " · drag onto a grid to put it inside"}`}>
            <span className="pane-glyph">
              <SpaceGlyph space={b} />
            </span>
            <span className="pane-label">{b.name}</span>
            {b.id === LOCAL_GRID_ID && <LocalRowDot />}
            {!tree && parent && <span className="pane-when">{parent.name}</span>}
            {tree && kids.length > 0 && <span className="pane-when">{kids.length}</span>}
          </button>
          {tree && !viewer && b.role !== "viewer" && !isPageKind(kind) && (
            <button className="space-move" onClick={() => onNew("grid", b.id)} aria-label={`New grid inside ${b.name}`} data-tip="New grid inside">
              ＋
            </button>
          )}
        </div>
        {tree && open && kids.map((k) => row(k, depth + 1, true))}
      </div>
    );
  };

  return (
    <AnimatePresence initial={false}>
      {ui.pane && (
        <motion.aside key="pane" className="side-pane floor-pane" style={{ width: ui.paneW }} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={paneSpring} aria-label="Foundation menu">
          {/* how the grids are listed, at the top of them; the rows start at the selector's own left edge */}
          <div className="pane-pick">
            <div className="pane-seg" role="tablist" aria-label="How grids are listed">
              {(["recent", "all"] as const).map((v) => (
                <button key={v} role="tab" aria-selected={ui.spacesView === v} className={`pane-seg-btn${ui.spacesView === v ? " is-on" : ""}${v === "all" && over === "top" ? " is-over" : ""}`} onClick={() => setUi({ spacesView: v })} {...(v === "all" ? dropProps(null) : {})}>
                  {v === "recent" ? "Recent" : "All Grids"}
                </button>
              ))}
            </div>
            {!viewer && (
              <button className="pane-new" onClick={() => onNew("grid")} aria-label="New grid" data-tip="New grid">
                <PlusGlyph />
              </button>
            )}
          </div>

          <div className="pane-scroll">
            <section className="pane-group">
              {ui.spacesView === "recent" ? recent.map((b) => row(b, 0, false)) : childrenOf(null, listed).map((b) => row(b, 0, true))}
              {listed.length === 0 && (
                <div className="pane-empty is-create">
                  <span>No grids yet.</span>
                  {!viewer && (
                    <button className="f-pill is-accent" onClick={() => onNew("grid")}>
                      New grid
                    </button>
                  )}
                </div>
              )}
              {drag && parentOf(boards.find((b) => b.id === drag)!, listed) && (
                <div className={`grid-top-drop${over === "top" ? " is-over" : ""}`} {...dropProps(null)}>
                  Drop here to bring it to the top
                </div>
              )}
            </section>
          </div>

          {/* the server pill's panel opens here, in the menu's flow right above the Settings band (2026-11-18) */}
          <div className="pane-server-slot" ref={setServerSlot} />
          {/* Settings, and the server this app talks to as a small pill to its right in the same band (2026-11-17) */}
          <section className="pane-band pane-low pane-low-row">
            <button className={`pane-row pane-place${place.kind === "settings" ? " is-current" : ""}`} onClick={() => goSettings()} data-place="settings">
              <span className="pane-glyph">
                <SunGlyph />
              </span>
              <span className="pane-label">Settings</span>
            </button>
            <ServerSwitch where="pane" host={serverSlot} />
          </section>
          <footer className="pane-foot">
            <span className="me-avatar" style={{ background: user.color }} title={user.email}>
              {initials(user.name)}
            </span>
            <span className="pane-me">
              <b>{user.name}</b>
              <button
                className="pane-signout"
                onClick={async () => {
                  await logout();
                  window.location.reload();
                }}
              >
                Sign out
              </button>
            </span>
            {/* day and night, right of you, at the foot's other end (2026-11-18, Josh: "to the right of the profile button … on the other side") */}
            <NightOrb onToggle={() => setNight(!isNight())} />
          </footer>

          <FloorEdge side="right" value={ui.paneW} {...WIDTHS.pane} onChange={(w) => setUi({ paneW: w })} label="Foundation menu" />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/**
 * The floorplan is a map of Foundation's own code (every part, file and connection, in plain words),
 * made with the floorplan plugin and exported to `public/floorplan.html` — a static page the client
 * serves. Rebuild it after a release: see docs/floorplan.md. Linked from Settings → Plan.
 */
export const FLOORPLAN_URL = "/floorplan.html";

export function ago(at: number) {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * The top bar, drawn on the floor. Left to right: the side menu's fold, the place you're in when
 * it isn't a grid (Today, Settings), a tab for every grid open in this window, ＋ (a new grid; its
 * caret offers the other canvases: a presentation, a web page), then the tools on the right — the
 * people here, search, the council, the agents, the command bar, present — the server this app
 * uses (2026-11-15: it lives here, not in a corner), and the day/night orb.
 *
 * A tab is a grid: a board whose canvas is a grid, a deck or a web page. The open grid's tab
 * carries its sync dot and its own button (ⓘ) for the grid's people and activity: what belongs to
 * this grid, not to the app. A session with the agent opens from the bottom bar.
 *
 * In the desktop app this is the window's title bar too: its open stretch
 * moves the window, and minimize, maximize and close sit past its right end
 * (shell/WindowControls.tsx), all on the one line.
 */

import { toggleCouncil, useCouncilOpen } from "../lib/councilOpen";
import { useEffect, useRef, useState } from "react";
import { COMMANDS_GLYPH, keys } from "../lib/keys";
import { motion, AnimatePresence } from "motion/react";
import { isNight, setNight } from "@foundation/ui";
import { setUi, useUi } from "../state/ui";
import { PresenceStack, useBoardTick } from "./Presence";
import { NightOrb } from "./NightOrb";
import { KIND_GLYPH, KIND_NAME, type BoardRow, type SpaceKind } from "../lib/grids";
import type { Place } from "../lib/place";
import { ServerSwitch } from "../server/ServerSwitch";
import { CouncilGlyph } from "../characters/CouncilGlyph";

interface Props {
  boards: BoardRow[];
  /** the open grid ("" when the place isn't a grid) */
  current: string;
  place: Place;
  onSwitch(id: string): void;
  onNew(kind?: SpaceKind): void;
  onClose(id: string): void;
  onRename(id: string, name: string): void;
}

export function TopBar({ boards, current, place, onSwitch, onNew, onClose, onRename }: Props) {
  const ui = useUi();
  const council = useCouncilOpen();
  const board = useBoardTick();
  const status = board?.status ?? "connecting";
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const viewer = ui.role === "viewer";

  // the open tabs, in order; a space this window has open but the list hasn't named yet still gets its tab
  const ids = ui.spaces.includes(current) || !current ? ui.spaces : [...ui.spaces, current];
  const tabs = ids.map((id) => boards.find((b) => b.id === id) ?? (id === current ? ({ id, name: id, role: "member" } as BoardRow) : null)).filter((b): b is BoardRow => !!b);

  // the new-space menu closes on a press anywhere else
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, [menu]);

  const spacesOpen = ui.pane && ui.paneView === "spaces";
  const infoOpen = ui.pane && ui.paneView === "info";

  return (
    <header className="top-bar">
      <button
        className={`top-btn pane-fold${spacesOpen ? " is-on" : ""}`}
        onClick={() => setUi(spacesOpen ? { pane: false } : { pane: true, paneView: "spaces" })}
        data-tip={spacesOpen ? "Fold the side menu" : "The side menu: Today, your grids, Settings"}
        data-kbd={keys("mod+\\")}
      >
        <PaneGlyph />
      </button>
      <nav className="tabs" aria-label="Open grids">
        {place.kind !== "grid" && (
          <div className="tab is-space is-place is-current" data-place-tab={place.kind}>
            <span className="tab-main">
              <span className={`tab-glyph${place.kind === "today" ? " is-agent" : ""}`}>{place.kind === "today" ? "◌" : "⚙"}</span>
              <span className="tab-title">{place.kind === "today" ? "Today" : "Settings"}</span>
            </span>
          </div>
        )}
        <AnimatePresence initial={false}>
          {tabs.map((b, i) => {
            const on = b.id === current;
            const kind = b.kind ?? "grid";
            return (
              <motion.div
                key={b.id}
                className={`tab is-space is-${kind}${on ? " is-current is-board" : ""}`}
                data-space-drop={b.id}
                data-space-name={b.name}
                data-space-kind={kind}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                layout="position"
              >
                {renaming === b.id ? (
                  <span className="tab-main">
                    <span className="tab-glyph">{KIND_GLYPH[kind]}</span>
                    <input
                      className="tab-rename"
                      defaultValue={b.name}
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (name && name !== b.name) onRename(b.id, name);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  </span>
                ) : (
                  <button
                    className="tab-main"
                    onClick={() => (!on || place.kind !== "grid") && onSwitch(b.id)}
                    onDoubleClick={() => !viewer && on && setRenaming(b.id)}
                    data-tip={on ? `${KIND_NAME[kind]} · double-click to rename` : `${b.name} · ${KIND_NAME[kind]}`}
                    data-kbd={i < 9 ? keys(`mod+${i + 1}`) : undefined}
                  >
                    <span className="tab-glyph">{b.id === "company" ? "◉" : KIND_GLYPH[kind]}</span>
                    <span className="tab-title">{b.name}</span>
                    {on && <span className={`f-dot ${status === "live" ? "is-ok" : status === "offline" ? "is-warn" : "is-live"}`} title={status === "live" ? "Live" : status === "offline" ? "Offline — edits will sync when back" : "Connecting…"} />}
                    {on && status !== "live" && board && (board.pending || board.fromDevice) && (
                      <span className="offline-pill" title={board.pending ? "Your changes are saved on this device and go to the server when it's back." : "Showing this device's copy until the server answers."}>
                        {board.pending ? "Saved on this device" : "This device's copy"}
                      </span>
                    )}
                    {on && viewer && (
                      <span className="view-only" title="You can read this grid, ask the agent about it and present it. An admin can make you a member.">
                        View only
                      </span>
                    )}
                  </button>
                )}
                {on && (
                  <button
                    className={`tab-info${infoOpen ? " is-on" : ""}`}
                    onClick={() => setUi(infoOpen ? { pane: false } : { pane: true, paneView: "info" })}
                    aria-label="This grid: people and activity"
                    data-tip={infoOpen ? "Fold this grid's pane" : "This grid: people and activity"}
                    data-kbd={keys("mod+I")}
                  >
                    <InfoGlyph />
                  </button>
                )}
                {tabs.length > 1 && (
                  <button className="tab-close" onClick={() => onClose(b.id)} aria-label={`Close ${b.name}`} data-tip="Close the tab" data-kbd={on ? keys("mod+W") : undefined}>
                    ✕
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </nav>
      {!viewer && (
        <div className="tab-new-wrap" ref={menuRef}>
          <button className="top-btn tab-new" onClick={() => onNew("grid")} data-tip="New grid">
            ＋
          </button>
          <button className={`top-btn tab-new-more${menu ? " is-on" : ""}`} onClick={() => setMenu((m) => !m)} aria-label="Other kinds of grid" data-tip="A presentation or a web page">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <path d="M1 2.5l3 3 3-3" />
            </svg>
          </button>
          {menu && (
            <div className="tab-new-menu" role="menu">
              {(["grid", "deck", "page"] as SpaceKind[]).map((k) => (
                <button
                  key={k}
                  className="tab-new-item"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onNew(k);
                  }}
                >
                  <span className="tab-glyph">{KIND_GLYPH[k]}</span>
                  <span className="tab-new-name">{KIND_NAME[k]}</span>
                  <span className="tab-new-hint">{k === "grid" ? "sections, cards, apps" : k === "deck" ? "a grid whose sections are slides" : "an app at its address"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="top-tools">
        {place.kind === "grid" && <PresenceStack />}
        <button className={`top-btn${ui.search ? " is-on" : ""}`} onClick={() => setUi({ search: !ui.search })} data-tip={`Search, drag onto the grid (${keys("mod+F")})`}>
          ⌕
        </button>
        <button className={`top-btn is-agent${council?.kind === "board" ? " is-on" : ""}`} onClick={() => toggleCouncil({ kind: "board" })} aria-label="Council" data-tip="Council: this grid's agents, as characters. Talk to them, add more" data-council-open>
          <CouncilGlyph />
        </button>
        <button className={`top-btn is-agent${ui.agents ? " is-on" : ""}`} onClick={() => setUi({ agents: !ui.agents })} aria-label="Agents" data-tip="Agents on this grid: who's in which section, and who works together">
          ✦
        </button>
        <button className="top-btn" onClick={() => setUi({ command: true })} data-tip={`Commands, open an app (${keys("mod+K")})`}>
          {COMMANDS_GLYPH}
        </button>
        <button className="top-btn" onClick={() => setUi({ presenting: true })} data-tip="Present (P)">
          ▶
        </button>
        <ServerSwitch where="bar" />
        <NightOrb onToggle={() => setNight(!isNight())} />
      </div>
    </header>
  );
}

export function PaneGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

/** this space's own pane: an i in a ring */
export function InfoGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 6.5v3.2M7 4.3v.1" />
    </svg>
  );
}

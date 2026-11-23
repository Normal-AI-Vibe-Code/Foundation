/**
 * The top bar, drawn on the floor. Left to right: Today in the window's corner (with what's waiting
 * on you beside the word; 2026-11-17, Josh: to the top left, from the right end), the side menu's
 * fold (at the menu's right edge, lined off from the tabs), Settings as a pill while you're there,
 * a tab for every grid open in this window, ＋ (a new grid; its caret offers the other canvases: a
 * presentation, a web page), then on the right the people here and the built-in tools (shell/Tools.tsx: a terminal, a
 * browser, the files, what changed, this computer's agents). Search, the council, the agents,
 * commands and present moved to the bottom bar on 2026-11-17; the server and the day/night orb
 * to the side menu's foot.
 *
 * A tab is a grid: a board whose canvas is a grid, a deck or a web page. The open grid's tab
 * carries its sync dot and its own button (ⓘ) for the grid's people and activity: what belongs to
 * this grid, not to the app. A session with the agent opens from the bottom bar.
 *
 * In the desktop app this is the window's title bar too: its open stretch
 * moves the window, and minimize, maximize and close sit past its right end
 * (shell/WindowControls.tsx), all on the one line.
 */

import { GearGlyph } from "./glyphs";
import { ToolButtons } from "./Tools";
import { goToday } from "../lib/place";
import { ShibaDot, useNotices } from "../today/notices";
import { ChatButton } from "../chat/ChatButton";
import { useEffect, useRef, useState } from "react";
import { keys } from "../lib/keys";
import { motion, AnimatePresence } from "motion/react";
import { setUi, useUi } from "../state/ui";
import { PresenceStack, useBoardTick } from "./Presence";
import { SpaceGlyph } from "./SpaceGlyph";
import { KIND_GLYPH, KIND_NAME, type BoardRow, type SpaceKind } from "../lib/grids";
import type { Place } from "../lib/place";

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
  const notices = useNotices();
  const board = useBoardTick();
  const status = board?.status ?? "connecting";
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const viewer = ui.role === "viewer";

  // the open tabs, in order; a space this window has open but the list hasn't named yet still gets its tab
  const ids = ui.spaces.includes(current) || !current ? ui.spaces : [...ui.spaces, current];
  const tabs = ids.map((id) => boards.find((b) => b.id === id) ?? (id === current ? ({ id, name: id, role: "member" } as BoardRow) : null)).filter((b): b is BoardRow => !!b);

  // the new-space menu closes on a press anywhere else or Escape (restoring focus to its trigger)
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(false);
      menuTriggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const spacesOpen = ui.pane && ui.paneView === "spaces";
  const infoOpen = ui.pane && ui.paneView === "info";

  return (
    <header className="top-bar">
      {/* the top left: Today in the window's corner, then the side menu's fold (over the open menu, at its right
          edge) and a line down to the menu's own edge between it and the tabs. The tabs start where the menu ends */}
      <div className={`top-left${ui.pane ? " is-over-pane" : ""}`} style={ui.pane ? { width: Math.max(0, ui.paneW - 16) } : undefined}>
        {/* Today, in the window's top-left corner (2026-11-17, Josh): the Shiba very small, the word, and what's waiting right beside it */}
        <button type="button" className={`top-today${place.kind === "today" ? " is-on" : ""}`} onClick={goToday} data-tip={notices.total ? `Today: ${notices.words}` : "Today: the Shiba, your todos, the apps"} data-top-today data-place="today">
          <ShibaDot size={16} />
          Today
          {notices.total > 0 && (
            <span className="pane-badge" data-today-badge={notices.total} aria-label={`${notices.total} waiting on you: ${notices.words}`}>
              {notices.total > 99 ? "99+" : notices.total}
            </span>
          )}
        </button>
        {/* ChatForm, right after Today and of its family, with what's waiting on you there (chat/ChatButton.tsx) */}
        <ChatButton on={place.kind === "chat"} />
        <button
          type="button"
          className={`top-btn pane-fold${spacesOpen ? " is-on" : ""}`}
          onClick={() => setUi(spacesOpen ? { pane: false } : { pane: true, paneView: "spaces" })}
          aria-label={spacesOpen ? "Fold side menu" : "Open side menu"}
          aria-expanded={spacesOpen}
          data-tip={spacesOpen ? "Fold the side menu" : "The side menu: your grids, Settings"}
          data-kbd={keys("mod+\\")}
        >
          <PaneGlyph />
        </button>
      </div>
      <nav className="tabs" aria-label="Open grids">
        {/* a place that isn't a grid has no tab of its own: Settings shows as a pill while you're there (it's passing, not open work) */}
        {place.kind === "settings" && (
          <div className="tab-pill" data-place-tab="settings">
            <GearGlyph size={14} />
            Settings
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
                      aria-label={`Rename ${b.name}`}
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
                    type="button"
                    className="tab-main"
                    onClick={() => (!on || place.kind !== "grid") && onSwitch(b.id)}
                    onDoubleClick={() => !viewer && on && setRenaming(b.id)}
                    data-tip={on ? `${b.name} · ${KIND_NAME[kind]} · double-click to rename` : `${b.name} · ${KIND_NAME[kind]}`}
                    data-kbd={i < 9 ? keys(`mod+${i + 1}`) : undefined}
                  >
                    <span className="tab-glyph" aria-hidden>
                      <SpaceGlyph space={b} />
                    </span>
                    <span className="tab-title" title={b.name}>
                      {b.name}
                    </span>
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
                    type="button"
                    className={`tab-info${infoOpen ? " is-on" : ""}`}
                    onClick={() => setUi(infoOpen ? { pane: false } : { pane: true, paneView: "info" })}
                    aria-label={infoOpen ? "Close grid details" : "Show grid details"}
                    aria-pressed={infoOpen}
                    data-tip={infoOpen ? "Fold this grid's pane" : "This grid: people and activity"}
                    data-kbd={keys("mod+I")}
                  >
                    <InfoGlyph />
                  </button>
                )}
                {tabs.length > 1 && (
                  <button type="button" className="tab-close" onClick={() => onClose(b.id)} aria-label={`Close ${b.name}`} data-tip="Close tab" data-kbd={on ? keys("mod+W") : undefined}>
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
          <button type="button" className="top-btn tab-new" onClick={() => onNew("grid")} aria-label="Create new grid" data-tip="New grid">
            ＋
          </button>
          <button
            ref={menuTriggerRef}
            type="button"
            className={`top-btn tab-new-more${menu ? " is-on" : ""}`}
            onClick={() => setMenu((m) => !m)}
            aria-label="Choose new grid type"
            aria-expanded={menu}
            aria-haspopup="menu"
            data-tip="A presentation or a web page"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <path d="M1 2.5l3 3 3-3" />
            </svg>
          </button>
          {menu && (
            <div className="tab-new-menu" role="menu" aria-label="New grid type">
              {(["grid", "deck", "page"] as SpaceKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="tab-new-item"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onNew(k);
                  }}
                >
                  <span className="tab-glyph" aria-hidden>{KIND_GLYPH[k]}</span>
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
        {/* the built-in tools (2026-11-17): a terminal, a browser, the files, what changed, and this computer's agents (T3) */}
        <ToolButtons />
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

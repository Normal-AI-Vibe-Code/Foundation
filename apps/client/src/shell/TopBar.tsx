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

import { SunGlyph, TimeGlyph } from "./glyphs";
import { GRID, toggleGridTimeline, useTimeline } from "../timeline/model";
import { ToolButtons } from "./Tools";
import { goToday } from "../lib/place";
import { ShibaDot, useNotices } from "../today/notices";
import { NotificationBell } from "../chat/Bell";
import { useEffect, useRef, useState, type CSSProperties } from "react";
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

  // the tabs past the strip's edge (2026-11-23, Josh): when the strip is full, a caret at its right end lists the
  // tabs it cuts off, and the strip fades at the side that's cut
  const navRef = useRef<HTMLElement>(null);
  const [clip, setClip] = useState({ left: false, right: false });
  const [clipped, setClipped] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const tabKey = tabs.map((b) => b.id).join(" ");
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const left = nav.scrollLeft > 1;
      const right = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
      setClip((c) => (c.left === left && c.right === right ? c : { left, right }));
      // by layout offsets, not on-screen boxes: a tab mid-spring (motion's layout moves) still counts where it lands
      const out = [...nav.querySelectorAll<HTMLElement>("[data-space-drop]")]
        .filter((el) => el.offsetLeft < nav.scrollLeft - 1 || el.offsetLeft + el.offsetWidth > nav.scrollLeft + nav.clientWidth + 1)
        .map((el) => el.dataset.spaceDrop!);
      setClipped((c) => (c.join(" ") === out.join(" ") ? c : out));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    for (const el of nav.children) ro.observe(el);
    nav.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      nav.removeEventListener("scroll", measure);
    };
  }, [tabKey, place.kind, current, more]);
  // the open tab is never left past the edge: switching to one brings it into the strip
  useEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLElement>(`[data-space-drop="${CSS.escape(current)}"]`);
    if (!nav || !el) return;
    const start = el.offsetLeft;
    const end = start + el.offsetWidth;
    if (start < nav.scrollLeft) nav.scrollTo({ left: start, behavior: "smooth" });
    else if (end > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: end - nav.clientWidth, behavior: "smooth" });
  }, [current, tabKey]);
  useEffect(() => {
    if (!more) return;
    const off = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, [more]);
  const hiddenTabs = tabs.filter((b) => clipped.includes(b.id));
  useEffect(() => {
    if (more && !hiddenTabs.length) setMore(false);
  }, [more, hiddenTabs.length]);

  const spacesOpen = ui.pane && ui.paneView === "spaces";
  const infoOpen = ui.pane && ui.paneView === "info";
  const timelineOpen = !!useTimeline(GRID);

  return (
    <header className="top-bar">
      {/* the top left: Today in the window's corner, then the side menu's fold (over the open menu, at its right
          edge) and a line down to the menu's own edge between it and the tabs. The tabs start where the menu ends */}
      {/* over the open menu the group ends on the menu's edge: its width is the menu's less the bar's own inset,
          which a Mac widens for its lights (spaces.css, --bar-inset), so the line lands on the menu's edge there too */}
      <div className={`top-left${ui.pane ? " is-over-pane" : ""}`} style={ui.pane ? ({ "--pane-w": `${ui.paneW}px` } as CSSProperties) : undefined}>
        {/* Today and the bell, one pair in the window's top-left corner (2026-11-26, Josh: the bell was "a bit
            floating"): over the open menu they keep the corner together and the fold keeps the menu's edge */}
        <span className="top-today-pair" data-top-today-pair>
        {/* Today (2026-11-17, Josh): the Shiba very small, the word, and what's waiting right beside it */}
        <button type="button" className={`top-today${place.kind === "today" ? " is-on" : ""}`} onClick={goToday} data-tip={notices.total ? `Today: ${notices.words}` : "Today: the Shiba, your todos, the apps"} data-top-today data-place="today">
          <ShibaDot size={16} />
          <span className="top-word">Today</span>
          {notices.total > 0 && (
            <span className="pane-badge" data-today-badge={notices.total} aria-label={`${notices.total} waiting on you: ${notices.words}`}>
              {notices.total > 99 ? "99+" : notices.total}
            </span>
          )}
        </button>
        {/* what was said to me: mentions and direct messages, with a count and a panel (chat/Bell.tsx); the same
            list is on the Today page, with the notes that tag me on a grid */}
        <NotificationBell />
        </span>
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
      <nav ref={navRef} className={`tabs${clip.left ? " is-clip-left" : ""}${clip.right ? " is-clip-right" : ""}`} aria-label="Open grids">
        {/* a place that isn't a grid has no tab of its own: Settings shows as a pill while you're there (it's passing, not open work) */}
        {place.kind === "settings" && (
          <div className="tab-pill" data-place-tab="settings">
            <SunGlyph size={14} />
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
                {/* the grid's timeline (2026-11-25): beside ⓘ, the same size; H */}
                {on && place.kind === "grid" && (kind === "grid" || kind === "deck") && (
                  <button
                    type="button"
                    className={`tab-info tab-time${timelineOpen ? " is-on" : ""}`}
                    onClick={toggleGridTimeline}
                    aria-label={timelineOpen ? "Close this grid's timeline" : "This grid's timeline"}
                    aria-pressed={timelineOpen}
                    data-tip="This grid's timeline"
                    data-kbd="H"
                    data-tab-time
                  >
                    <TimeGlyph size={14} />
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
      {hiddenTabs.length > 0 && (
        <div className="tab-more-wrap" ref={moreRef}>
          <button
            className={`top-btn tab-more${more ? " is-on" : ""}`}
            onClick={() => setMore((m) => !m)}
            aria-label={`${hiddenTabs.length} more ${hiddenTabs.length === 1 ? "tab" : "tabs"}`}
            aria-haspopup="menu"
            aria-expanded={more}
            data-tip="The tabs past the edge"
            data-tabs-more={hiddenTabs.length}
          >
            <span className="tab-more-count">{hiddenTabs.length}</span>
            <svg width="10" height="10" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <path d="M1 2.5l3 3 3-3" />
            </svg>
          </button>
          {more && (
            <div className="tab-new-menu tab-more-menu" role="menu">
              {hiddenTabs.map((b) => {
                const kind = b.kind ?? "grid";
                return (
                  <button
                    key={b.id}
                    className={`tab-new-item tab-more-item${b.id === current ? " is-current" : ""}`}
                    role="menuitem"
                    data-tab-more-item={b.id}
                    onClick={() => {
                      setMore(false);
                      onSwitch(b.id);
                    }}
                  >
                    <span className="tab-glyph">
                      <SpaceGlyph space={b} />
                    </span>
                    <span className="tab-new-name">{b.name}</span>
                    <span className="tab-new-hint">{KIND_NAME[kind]}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
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

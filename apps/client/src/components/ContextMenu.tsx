import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { NAV_KEYS, layoutMenu, nextSpot, type Counts, type MenuItem, type NavKey, type Spot, type Zone } from "./menuLayout";

/**
 * App-wide right-click menu. Anyone can call openContextMenu(x, y, items);
 * a single ContextMenuView at the app root renders it.
 *
 * A plain list of items is a list. Items that name a `group` make the
 * section's menu (menuLayout.ts): rows across the top, **Add** and **Live** as
 * two columns side by side, and the grid's own actions as a row of icon
 * buttons across the bottom, each naming itself on roll-over (`data-tip`).
 *
 * Keys: the arrows move through it (within a column, across to the other,
 * down to the icon row and along it), Home and End jump, Enter or Space does
 * what has the keyboard, Esc closes.
 */

export type { MenuItem } from "./menuLayout";

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

let current: MenuState | null = null;
const listeners = new Set<() => void>();

export function openContextMenu(x: number, y: number, items: MenuItem[]) {
  current = { x, y, items };
  for (const fn of listeners) fn();
}

export function closeContextMenu() {
  if (!current) return;
  current = null;
  for (const fn of listeners) fn();
}

/** glyphs the row draws itself (a string icon that tints with the text; an emoji wouldn't take the bad colour) */
function Glyph({ icon }: { icon?: string }) {
  if (icon === "🗑")
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2.8 4.4h10.4M6.4 4.4V2.9h3.2v1.5M4.2 4.4l.6 8.7h6.4l.6-8.7M6.8 7v3.6M9.2 7v3.6" />
      </svg>
    );
  return <>{icon ?? ""}</>;
}

/** what's inside the menu: the list, or the zones of a grouped one. `onRun` is called before an item acts (the menu closes). */
export function MenuBody({ items, onRun }: { items: MenuItem[]; onRun?: () => void }) {
  const lay = layoutMenu(items);
  const run = (item: MenuItem) => () => {
    onRun?.();
    item.action?.();
  };
  const cls = (item: MenuItem, base: string) => base + (item.danger ? " danger" : "") + (item.agent ? " is-agent" : "") + (item.disabled ? " disabled" : "");
  const row = (item: MenuItem, i: number, zone: Zone) => (
    <button key={i} className={cls(item, "menu-item")} data-zone={zone} disabled={item.disabled} onClick={run(item)}>
      <span className="menu-icon">
        <Glyph icon={item.icon} />
      </span>
      {item.label}
    </button>
  );

  return (
    <>
        {!lay.grouped ? (
          items.map((item, i) =>
            item.divider ? (
              <div key={i} className="menu-divider" />
            ) : item.heading ? (
              <div key={i} className="menu-heading">
                {item.heading}
              </div>
            ) : (
              row(item, i, "top")
            ),
          )
        ) : (
          <>
            {lay.top.map((item, i) => row(item, i, "top"))}
            {(lay.add.length > 0 || lay.live.length > 0) && (
              <div className="menu-cols">
                {(["add", "live"] as const).map((g) =>
                  lay[g].length ? (
                    <div key={g} className="menu-col" data-menu-col={g} role="group" aria-label={lay.captions[g]}>
                      <div className="menu-heading">{lay.captions[g]}</div>
                      {lay[g].map((item, i) => row(item, i, g))}
                    </div>
                  ) : null,
                )}
              </div>
            )}
            {lay.grid.length > 0 && (
              <div className="menu-iconrow" role="group" aria-label="This section on the grid">
                {lay.grid.map((item, i) => (
                  // no words: it names itself on roll-over (shell/Tip.tsx), and to a screen reader
                  // (one that can't be used stays a live element, so it can still say what it is)
                  <button key={i} className={cls(item, "menu-iconbtn")} data-zone="grid" data-tip={item.label} aria-label={item.label} aria-disabled={item.disabled || undefined} onClick={item.disabled ? undefined : run(item)}>
                    <Glyph icon={item.icon} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
    </>
  );
}

const MARGIN = 12;

export function ContextMenuView() {
  const [menu, setMenu] = useState<MenuState | null>(current);
  const el = useRef<HTMLDivElement>(null);
  /** the column the keyboard was last in: coming back up from the icon row returns to it */
  const lastCol = useRef<"add" | "live">("add");

  useEffect(() => {
    const fn = () => setMenu(current);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    lastCol.current = "add";
    const close = () => closeContextMenu();
    const targets = (zone: Zone) => [...(el.current?.querySelectorAll<HTMLButtonElement>(`button[data-zone="${zone}"]:not(:disabled):not([aria-disabled="true"])`) ?? [])];
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeContextMenu();
        return;
      }
      if (!NAV_KEYS.includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      // the menu has the arrows while it's open (the grid would pan with them)
      e.preventDefault();
      e.stopPropagation();
      const zones: Record<Zone, HTMLButtonElement[]> = { top: targets("top"), add: targets("add"), live: targets("live"), grid: targets("grid") };
      const counts: Counts = { top: zones.top.length, add: zones.add.length, live: zones.live.length, grid: zones.grid.length };
      const focused = document.activeElement as HTMLButtonElement | null;
      const zone = focused && el.current?.contains(focused) ? (focused.dataset.zone as Zone | undefined) : undefined;
      const at: Spot | null = zone ? { zone, i: zones[zone].indexOf(focused!) } : null;
      const to = nextSpot(counts, at && at.i >= 0 ? at : null, e.key as NavKey, lastCol.current);
      if (!to) return;
      if (to.zone === "add" || to.zone === "live") lastCol.current = to.zone;
      zones[to.zone][to.i]?.focus({ preventScroll: false });
    };
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("keydown", key, { capture: true });
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", key, { capture: true });
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // keep the menu inside the window: measured once it's laid out (its size depends on its labels and its columns),
  // before it's painted. offsetWidth/Height are the laid-out size, whatever its entrance is doing to its scale.
  useLayoutEffect(() => {
    const m = el.current;
    if (!menu || !m) return;
    const x = Math.max(MARGIN, Math.min(menu.x, window.innerWidth - m.offsetWidth - MARGIN));
    const y = Math.max(MARGIN, Math.min(menu.y, window.innerHeight - m.offsetHeight - MARGIN));
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
  }, [menu]);

  const lay = menu ? layoutMenu(menu.items) : null;

  return (
    <AnimatePresence>
      {menu && lay && (
        <>
          <div className="menu-backdrop" onPointerDown={closeContextMenu} onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }} />
          <motion.div
            ref={el}
            className={"context-menu" + (lay.grouped ? " is-grouped" : "")}
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            initial={{ opacity: 0, scale: 0.86, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -4 }}
            transition={{ type: "spring", stiffness: 550, damping: 32 }}
          >
            <MenuBody items={menu.items} onRun={closeContextMenu} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

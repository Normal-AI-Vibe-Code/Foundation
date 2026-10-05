import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { sfx } from "../sound/sfx";

/**
 * App-wide right-click menu. Anyone can call openContextMenu(x, y, items);
 * a single ContextMenuView at the app root renders it.
 */

export interface MenuItem {
  divider?: true;
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

let current: MenuState | null = null;
const listeners = new Set<() => void>();

export function openContextMenu(x: number, y: number, items: MenuItem[]) {
  current = { x, y, items };
  sfx.tick();
  for (const fn of listeners) fn();
}

export function closeContextMenu() {
  if (!current) return;
  current = null;
  for (const fn of listeners) fn();
}

export function ContextMenuView() {
  const [menu, setMenu] = useState<MenuState | null>(current);

  useEffect(() => {
    const fn = () => setMenu(current);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => closeContextMenu();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeContextMenu();
      }
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

  // keep the menu inside the window
  const itemH = 30;
  const estH = menu
    ? menu.items.reduce((h, it) => h + (it.divider ? 9 : itemH), 12)
    : 0;
  const x = menu ? Math.min(menu.x, window.innerWidth - 232) : 0;
  const y = menu ? Math.min(menu.y, window.innerHeight - estH - 12) : 0;

  return (
    <AnimatePresence>
      {menu && (
        <>
          <div className="menu-backdrop" onPointerDown={closeContextMenu} onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }} />
          <motion.div
            className="context-menu"
            style={{ left: x, top: y }}
            initial={{ opacity: 0, scale: 0.86, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -4 }}
            transition={{ type: "spring", stiffness: 550, damping: 32 }}
          >
            {menu.items.map((item, i) =>
              item.divider ? (
                <div key={i} className="menu-divider" />
              ) : (
                <button
                  key={i}
                  className={
                    "menu-item" + (item.danger ? " danger" : "") + (item.disabled ? " disabled" : "")
                  }
                  disabled={item.disabled}
                  onClick={() => {
                    closeContextMenu();
                    item.action?.();
                  }}
                >
                  <span className="menu-icon">{item.icon ?? ""}</span>
                  {item.label}
                </button>
              ),
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/**
 * The window's own frame, in Foundation's hand. The desktop app has no system
 * title bar: the top bar is the title bar, so the fold, the tabs and the tools
 * share one line with minimize, maximize and close. The three sit in the top
 * right corner of every page (the board, sign-in, settings, the design page),
 * and the top 44 px of the window is where you take hold of it: drag to move,
 * double-click to maximize. On a Mac the system's own lights stay, at the left.
 *
 * In a browser none of this exists (`inDesktop` is false) and nothing renders.
 */

import { useEffect, useState } from "react";
import { inDesktop } from "../update/updater";

/** the height of the strip that moves the window: the top bar's */
const BAR = 44;
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
/** this window draws its own minimize, maximize and close */
export const ownControls = inDesktop && !isMac;

const win = async () => (await import("@tauri-apps/api/window")).getCurrentWindow();
const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** what a press in the strip must not steal: anything that is itself pressed */
const PRESSED = "button, a, input, textarea, select, label, [role='button'], [contenteditable='true'], .tab, .presence-stack, .floor-edge, .cmd-scrim, .menu-backdrop";

if (inDesktop && typeof document !== "undefined") {
  document.documentElement.classList.add("is-desktop", isMac ? "is-mac" : "has-window-controls");
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.clientY >= BAR) return;
    if ((e.target as HTMLElement).closest(PRESSED)) return;
    e.preventDefault();
    quiet(win().then((w) => (e.detail === 2 ? w.toggleMaximize() : w.startDragging())));
  });
}

/** Minimize, maximize (or restore) and close. `demo` draws them still, for #/design; `day` over the sign-in page. */
export function WindowControls({ demo = false, day = false }: { demo?: boolean; day?: boolean }) {
  const [max, setMax] = useState(false);

  useEffect(() => {
    if (demo || !ownControls) return;
    let gone = false;
    let off: (() => void) | undefined;
    void win()
      .then(async (w) => {
        const read = () => quiet(w.isMaximized().then((m) => !gone && setMax(m)));
        read();
        const un = await w.onResized(read);
        if (gone) un();
        else off = un;
      })
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [demo]);

  if (!demo && !ownControls) return null;
  const act = (fn: (w: Awaited<ReturnType<typeof win>>) => Promise<unknown>) => (demo ? undefined : () => quiet(win().then(fn)));

  return (
    <div className={`window-controls${demo ? " is-demo" : ""}${day ? " f-day" : ""}`}>
      <button className="win-btn" onClick={act((w) => w.minimize())} data-tip="Minimize" aria-label="Minimize" tabIndex={-1}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
          <path d="M0.5 5.5h9" />
        </svg>
      </button>
      <button className="win-btn" onClick={act((w) => w.toggleMaximize())} data-tip={max ? "Restore" : "Maximize"} aria-label={max ? "Restore" : "Maximize"} tabIndex={-1}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
          {max ? (
            <>
              <rect x="0.5" y="2.5" width="7" height="7" rx="1.5" />
              <path d="M2.5 2.5V2a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 9.5 2v4A1.5 1.5 0 0 1 8 7.5h-.5" />
            </>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
          )}
        </svg>
      </button>
      <button className="win-btn is-close" onClick={act((w) => w.close())} data-tip="Close" aria-label="Close" tabIndex={-1}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}

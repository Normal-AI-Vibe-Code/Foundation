/** Small things the machine card's parts share (MachineView, MachineViewDesktop, MachineViewIo). */

import { useEffect, useState } from "react";
import { activeBoard } from "../sync/board";

export const boardId = () => activeBoard()?.boardId ?? "company";

/** where the keys go, and the way out: shown while a machine's shell or desktop has the caret. Also drawn on #/design. */
export function KeysLine({ what = "this machine", inline }: { what?: string; inline?: boolean }) {
  return (
    <div className={`machine-keys${inline ? " is-inline" : ""}`} role="status">
      <span className="f-dot is-live" />
      Keys go to {what}
      <span className="machine-keys-out">
        <span className="f-kbd">Esc</span>
        <span className="f-kbd">Esc</span> to leave
      </span>
    </div>
  );
}

/** "just now", "12 s ago", "3 min ago", "2 h ago" */
export function ago(at: number, now = Date.now()) {
  const s = Math.round((now - at) / 1000);
  if (s < 3) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** the time, ticking while `on` (for "3 s ago" lines) */
export function useNow(on: boolean, everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [on, everyMs]);
  return now;
}

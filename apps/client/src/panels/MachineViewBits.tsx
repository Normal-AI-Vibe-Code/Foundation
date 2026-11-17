/** Small things the machine card's parts share (MachineView, MachineViewDesktop, MachineViewIo). */

import { useEffect, useState, type RefObject } from "react";
import { activeBoard } from "../sync/board";
import { camera, onCamera } from "../state/camera";
import { ringWidth } from "./machineWords";

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

/**
 * The in-use ring is 2 px on the screen at any zoom. A card is drawn scaled
 * (the camera × its section's fit), so while a well has the keys its ring's
 * width is 2 px over that scale, kept in `--machine-ring` (live.css). Measured
 * when the keys arrive, when the camera's zoom changes and when full screen
 * comes or goes; nothing runs while no machine is in use.
 */
export function useRingWidth(el: RefObject<HTMLElement | null>, on: boolean) {
  useEffect(() => {
    const node = el.current;
    if (!on || !node) return;
    let last = 0;
    const measure = () => {
      const drawn = node.offsetWidth ? node.getBoundingClientRect().width / node.offsetWidth : 1;
      if (!drawn || Math.abs(drawn - last) < 0.002) return;
      last = drawn;
      node.style.setProperty("--machine-ring", `${ringWidth(drawn)}px`);
    };
    measure();
    let scale = camera.scale;
    const offCamera = onCamera((c) => {
      if (c.scale === scale) return;
      scale = c.scale;
      measure();
    });
    // a section's fit settles on a spring after the camera does
    const t = setInterval(measure, 400);
    document.addEventListener("fullscreenchange", measure);
    return () => {
      offCamera();
      clearInterval(t);
      document.removeEventListener("fullscreenchange", measure);
      node.style.removeProperty("--machine-ring");
    };
  }, [el, on]);
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

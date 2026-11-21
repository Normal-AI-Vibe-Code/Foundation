/** The day/night orb — sun by day, moon by night; a deliberate act, remembered. */

import { useEffect, useState } from "react";
import { isNight, nightPinned, onLook, onNight } from "@foundation/ui";

export function NightOrb({ onToggle }: { onToggle(): void }) {
  const [night, set] = useState(isNight());
  useEffect(() => onNight(set), []);
  // a grid may pin its own look (its ⓘ pane → Look): the orb then says so, and still sets what everywhere else wears
  const [pinned, setPinned] = useState(nightPinned());
  useEffect(() => onLook(() => setPinned(nightPinned())), []);
  const tip = pinned ? `This grid is always ${night ? "night" : "day"} (its own look). The orb sets everywhere else` : night ? "Switch to day" : "Switch to night";
  return (
    <button className={`night-orb${night ? " is-night" : ""}`} onClick={onToggle} data-tip={tip} aria-label={tip}>
      <span className="orb-sun" />
      <span className="orb-moon" />
    </button>
  );
}

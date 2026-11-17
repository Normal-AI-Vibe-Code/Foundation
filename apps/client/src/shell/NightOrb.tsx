/** The day/night orb — sun by day, moon by night; a deliberate act, remembered. */

import { useEffect, useState } from "react";
import { isNight, onNight } from "@foundation/ui";

export function NightOrb({ onToggle }: { onToggle(): void }) {
  const [night, set] = useState(isNight());
  useEffect(() => onNight(set), []);
  return (
    <button className={`night-orb${night ? " is-night" : ""}`} onClick={onToggle} data-tip={night ? "Switch to day" : "Switch to night"} aria-label={night ? "Switch to day" : "Switch to night"}>
      <span className="orb-sun" />
      <span className="orb-moon" />
    </button>
  );
}

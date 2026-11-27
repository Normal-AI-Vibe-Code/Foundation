/** whether the grid behind the grid is open (TrailGrid.tsx), and whose chain it follows */

import { useSyncExternalStore } from "react";

export interface TrailOpen {
  /** follow this run (a crew id) … */
  crew?: string | null;
  /** … or the newest run of an agent by its name (a seat that has left the council) */
  name?: string | null;
}

let open: TrailOpen | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

export function openTrail(focus: TrailOpen = {}) {
  open = { ...focus };
  tell();
}

export function focusTrail(crew: string | null) {
  if (!open) return;
  open = { crew, name: null };
  tell();
}

export function closeTrail() {
  if (!open) return;
  open = null;
  tell();
}

export function useTrail(): TrailOpen | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => open,
  );
}

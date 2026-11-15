/**
 * Whether the council is up, and for what: the whole board, or one section
 * (characters/Council.tsx). This window's own, one at a time. Kept apart from
 * the component so the toolbar's rules and the menus can open it.
 */

import { useSyncExternalStore } from "react";

export type CouncilScope = { kind: "board" } | { kind: "section"; id: string };

let open: CouncilScope | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openCouncil(scope: CouncilScope) {
  open = scope;
  emit();
}

export function closeCouncil() {
  if (!open) return;
  open = null;
  emit();
}

/** the same scope again closes it; another scope moves it there */
export function toggleCouncil(scope: CouncilScope) {
  const same = open && open.kind === scope.kind && (open.kind === "board" || (scope.kind === "section" && open.id === scope.id));
  if (same) closeCouncil();
  else openCouncil(scope);
}

export const councilOpen = () => open;

export function useCouncilOpen(): CouncilScope | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => open,
  );
}

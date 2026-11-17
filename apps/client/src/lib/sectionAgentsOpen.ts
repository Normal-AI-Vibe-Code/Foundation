/**
 * Which section's agents panel is open (components/SectionAgents.tsx): one at
 * a time, this window's own. Kept apart from the component so the toolbar's
 * rules (rune/tools.ts), which run without a page, can open it.
 */

import { useSyncExternalStore } from "react";

export interface OpenSectionAgents {
  id: string;
  /** put the caret in the ask field as it opens */
  focus: boolean;
}

let open: OpenSectionAgents | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openSectionAgents(sectionId: string, focus = false) {
  open = { id: sectionId, focus };
  emit();
}

export function closeSectionAgents() {
  if (!open) return;
  open = null;
  emit();
}

export function toggleSectionAgents(sectionId: string) {
  if (open?.id === sectionId) closeSectionAgents();
  else openSectionAgents(sectionId, true);
}

export function sectionAgentsOpen(): OpenSectionAgents | null {
  return open;
}

export function useSectionAgentsOpen(): OpenSectionAgents | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => open,
  );
}

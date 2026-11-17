/**
 * Something opened from a conversation, shown on the right (shell/DetailPane.tsx): a block of code
 * or a command an agent wrote, the steps it took, a plan. A conversation keeps these folded to a
 * line (what it is, how long), so the talk stays readable; a press opens the whole thing beside it.
 */

import { useSyncExternalStore } from "react";
import { setUi } from "../state/ui";

export type Detail =
  | { kind: "code"; title: string; lang: string; text: string }
  | { kind: "steps"; title: string; steps: Array<{ name: string; words: string; input?: unknown }> }
  | { kind: "plan"; title: string; goal: string; steps: Array<{ text: string; status: "pending" | "active" | "done" }> };

let detail: Detail | null = null;
const subs = new Set<() => void>();

export function openDetail(d: Detail) {
  detail = d;
  subs.forEach((f) => f());
  setUi({ detail: true });
}
export function closeDetail() {
  setUi({ detail: false });
}
export function useDetail(): Detail | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => detail,
  );
}

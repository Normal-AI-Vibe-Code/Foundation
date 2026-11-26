/**
 * Which section's note recorder is open (one at a time, on this screen only). A section's microphone tool,
 * its right-click menu, an empty section and ⌘K open it; the section draws it (SectionView → NoteRecorderHost).
 * Opening it opens nothing else: the microphone waits for Record.
 */

import { useSyncExternalStore } from "react";
import type { NoteKind } from "./recorder";

export interface NoteAsk {
  sectionId: string;
  kind: NoteKind;
  nonce: number;
}

let ask: NoteAsk | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function openNoteRecorder(sectionId: string, kind: NoteKind = "audio") {
  ask = { sectionId, kind, nonce: Math.random() };
  emit();
}

export function closeNoteRecorder() {
  if (!ask) return;
  ask = null;
  emit();
}

export function getNoteAsk(): NoteAsk | null {
  return ask;
}

/** the open ask, when it is this section's */
export function useNoteAsk(sectionId: string): NoteAsk | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => (ask?.sectionId === sectionId ? ask : null),
  );
}

/**
 * The clipboard: things clipped out of search, held until they're put on a board.
 *
 * Search for one thing, clip it; search for another, clip that; then carry the
 * lot onto the grid in one go (shell/Clipboard.tsx, at the foot of the search
 * pane). It's this device's and this person's: kept in localStorage so a reload
 * or another board doesn't empty it, never shared, never sent anywhere. What's
 * kept is the search hit itself (a title and where it is), not the file: a file
 * that has to be fetched (from Flowform, from an approved folder) is fetched
 * when it's put down, as when it's dragged straight out (lib/hits.ts).
 */
import { useSyncExternalStore } from "react";
import type { SearchHit } from "@foundation/protocol";

const KEY = "foundation.clipboard.v1";
/** more than this and it stops being something you hold */
export const CLIP_MAX = 24;

const isHit = (v: unknown): v is SearchHit => {
  const h = v as SearchHit | null;
  return !!h && typeof h === "object" && typeof h.id === "string" && typeof h.title === "string" && typeof h.source === "string";
};

/** stored clips, or none when missing or unreadable */
export function parseClips(raw: string | null | undefined): SearchHit[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isHit).slice(0, CLIP_MAX) : [];
  } catch {
    return [];
  }
}

function read(): SearchHit[] {
  try {
    return parseClips(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

let clips: SearchHit[] = typeof localStorage === "undefined" ? [] : read();
const listeners = new Set<() => void>();

function set(next: SearchHit[]) {
  clips = next;
  try {
    if (next.length) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: it lasts until the page goes */
  }
  listeners.forEach((l) => l());
}

export const getClips = () => clips;
export const isClipped = (id: string) => clips.some((c) => c.id === id);

/** the list after clipping `hit`: newest first, once, at most CLIP_MAX (pure) */
export function withClip(list: SearchHit[], hit: SearchHit): SearchHit[] {
  return [hit, ...list.filter((c) => c.id !== hit.id)].slice(0, CLIP_MAX);
}

/** put a result on the clipboard; false if it was already there */
export function clip(hit: SearchHit): boolean {
  const had = isClipped(hit.id);
  set(withClip(clips, hit));
  return !had;
}

export function unclip(ids: string | string[]) {
  const gone = new Set(Array.isArray(ids) ? ids : [ids]);
  if (clips.some((c) => gone.has(c.id))) set(clips.filter((c) => !gone.has(c.id)));
}

export const clearClips = () => set([]);

export function useClips(): SearchHit[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    getClips,
    getClips,
  );
}

// another window of the same app clipped something: this one shows it too
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    clips = parseClips(e.newValue);
    listeners.forEach((l) => l());
  });
}

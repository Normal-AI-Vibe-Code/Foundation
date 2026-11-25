/**
 * The characters the council can wear: every one whose card still stands on
 * the Character studio (or any) board, and which agent name wears which.
 * One fetch, shared by every seat; refreshed when a character on the open
 * board changes and when someone picks an avatar.
 */

import { useSyncExternalStore } from "react";
import { boardMaps, characterChoosable, seatCrew, type CharacterState } from "@foundation/protocol";
import { api, fetchFile } from "../lib/api";
import { cachedBytes } from "../lib/byteCache";
import { activeBoard, onBoardChange } from "../sync/board";

export interface RosterCharacter extends CharacterState {
  boardId: string;
  panelId: string;
}

export interface Roster {
  characters: RosterCharacter[];
  /** agent name → character id, where someone chose */
  avatars: Record<string, string>;
  loaded: boolean;
}

let roster: Roster = { characters: [], avatars: {}, loaded: false };
const subs = new Set<() => void>();
let loading: Promise<void> | null = null;
let watched: ReturnType<typeof activeBoard> = null;
let unwatch: (() => void) | null = null;
let again: number | undefined;

function set(next: Roster) {
  roster = next;
  subs.forEach((f) => f());
}

export function refreshRoster(): Promise<void> {
  loading ??= api<{ characters: RosterCharacter[]; avatars: Record<string, string> }>("/api/characters")
    .then((r) => set({ characters: r.characters, avatars: r.avatars, loaded: true }))
    .catch(() => set({ ...roster, loaded: true }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** a character on the open board changed (a stage finished): the roster follows, a moment later */
function watch() {
  const b = activeBoard();
  if (b === watched) return;
  unwatch?.();
  watched = b;
  unwatch = null;
  if (!b) return;
  const map = boardMaps(b.doc).characters;
  const on = () => {
    window.clearTimeout(again);
    again = window.setTimeout(() => void refreshRoster(), 400);
  };
  map.observe(on);
  unwatch = () => map.unobserve(on);
}

function subscribe(fn: () => void) {
  subs.add(fn);
  if (!roster.loaded) void refreshRoster();
  watch();
  const off = onBoardChange(watch);
  return () => {
    subs.delete(fn);
    off();
  };
}

export function useRoster(): Roster {
  return useSyncExternalStore(subscribe, () => roster);
}

/** the characters an agent can wear: finished and approved (protocol characterChoosable) */
export const readyCharacters = (r: Roster) => r.characters.filter(characterChoosable);

/** each agent name's character, for the agents in a room (protocol's seatCrew, over the ready ones) */
export function seats(r: Roster, names: readonly string[]): Record<string, RosterCharacter | undefined> {
  const ready = readyCharacters(r);
  const byId = new Map(ready.map((c) => [c.id, c]));
  const picked = seatCrew(names, ready.map((c) => c.id), r.avatars);
  return Object.fromEntries(names.map((n) => [n, byId.get(picked[n])]));
}

export async function chooseAvatar(name: string, character: string | null) {
  const out = await api<{ avatars: Record<string, string> }>("/api/characters/avatars", { method: "POST", json: { name, character } });
  set({ ...roster, avatars: out.avatars });
}

export const characterFilePath = (id: string, role: string) => `/api/characters/${encodeURIComponent(id)}/files/${role}`;

// one download per file, however many seats and cards show it
const bytes = new Map<string, Promise<ArrayBuffer>>();
export function characterBytes(id: string, role: string, fileId: string): Promise<ArrayBuffer> {
  const key = `${id}/${role}/${fileId}`;
  let p = bytes.get(key);
  if (!p) {
    // and kept between launches (lib/byteCache.ts): the key names the file, so a new one is fetched anew
    p = cachedBytes(`character/${key}`, () =>
      fetchFile(characterFilePath(id, role)).then((r) => {
        if (!r.ok) throw new Error(`the character's ${role} didn't load (${r.status})`);
        return r.arrayBuffer();
      }),
    );
    p.catch(() => bytes.delete(key));
    bytes.set(key, p);
  }
  return p;
}

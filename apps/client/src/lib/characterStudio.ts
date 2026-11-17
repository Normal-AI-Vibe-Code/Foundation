/**
 * The Character studio: one board where the council's characters are made
 * (server: characters.ts). Making it again opens the one there is.
 *
 * Also what a character's card and the flow's nodes share: what each stage is
 * called and makes, what a press costs (one read, shared, read again after a
 * press), the press itself, and the characters and inspiration of the open grid.
 */
import { useMemo, useSyncExternalStore } from "react";
import { boardMaps, MOODS, nextStage, type CharacterForm, type CharacterStageKey, type CharacterState } from "@foundation/protocol";
import { api } from "./api";
import { getState, subscribe } from "../state/store";
import { activeBoard, onBoardChange } from "../sync/board";
import { toast } from "../state/ui";

export async function openCharacterStudio() {
  try {
    const r = await api<{ id: string; made: boolean }>("/api/characters/studio", { method: "POST" });
    window.dispatchEvent(new Event("foundation:boards"));
    window.dispatchEvent(new CustomEvent("foundation:board", { detail: r.id }));
    if (r.made) toast("Made the Character studio: drop inspiration in, then add a character", "ok");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

/** "Characters · Anime" and "Inspiration · Anime" are the anime set's sections */
function setOfSection(sectionId: string): string {
  const name = getState().allSections[sectionId]?.name ?? "";
  const m = /^(?:characters|inspiration|pipeline)\s*·\s*(.+)$/i.exec(name.trim());
  return m ? m[1] : name.trim() || "Abstract";
}

/**
 * A new character's card in a section. The server makes it (its state is the server's to keep), and it
 * arrives through the board's sync. `more` is what the flow's Sheet node asks for: a name, a line of who it
 * is, and the inspiration to draw it from.
 */
export async function newCharacter(sectionId: string, form: "model" | "mesh" = "model", more: { name?: string; identity?: string; refs?: string[]; set?: string } = {}): Promise<boolean> {
  const board = activeBoard()?.boardId;
  if (!board) return false;
  try {
    await api(`/api/boards/${encodeURIComponent(board)}/characters`, { method: "POST", json: { section: sectionId, form, name: more.name?.trim() || "New character", identity: more.identity, refs: more.refs, set: more.set ?? setOfSection(sectionId) } });
    return true;
  } catch (e) {
    toast((e as Error).message, "bad");
    return false;
  }
}

// ----- what each stage is called, what its button says, what it makes -----

export const STAGE_WORDS: Record<CharacterStageKey, { name: string; press: (form: CharacterForm) => string; makes: (form: CharacterForm) => string }> = {
  sheet: { name: "Sheet", press: () => "Draw the sheet", makes: () => "the character from the front, from its words and inspiration" },
  expressions: { name: "Expressions", press: () => "Draw the expressions", makes: (f) => `one picture, eight panels: neutral, happy, sad, surprised, thinking, talking, a blink, waving (${f === "model" ? "head to toe" : "head and shoulders"})` },
  views: { name: "Views", press: (f) => (f === "model" ? "Draw the back and side" : "Draw the portrait"), makes: (f) => (f === "model" ? "the same character from behind and in profile" : "head and shoulders, facing you: what the mesh avatar is cut from") },
  model: { name: "Model", press: () => "Make the model", makes: () => "a textured 3D model from the views" },
  rig: { name: "Skeleton", press: () => "Fit the skeleton", makes: () => "bones, so it can move" },
  clips: { name: "Moods", press: () => "Animate the moods", makes: () => `a clip for each mood: ${MOODS.join(", ")}` },
  mesh: { name: "Mesh avatar", press: () => "Bring in the .mavatar", makes: () => "the portrait as a mesh that blinks, talks and emotes (built with mesh-avatar-studio)" },
};

// ----- what the buttons cost -----

export interface Costs {
  configured: boolean;
  balance: number | null;
  imageModel: string;
  costs: Record<CharacterForm, Partial<Record<CharacterStageKey, number>>>;
}
let costs: Costs | null = null;
const costSubs = new Set<() => void>();
let costLoad: Promise<void> | null = null;
export function loadCosts(force = false) {
  if (costLoad || (costs && !force)) return;
  costLoad = api<Costs>("/api/characters/costs")
    .then((c) => {
      costs = c;
      costSubs.forEach((f) => f());
    })
    .catch(() => {})
    .finally(() => {
      costLoad = null;
    });
}
export function useCosts(): Costs | null {
  return useSyncExternalStore(
    (fn) => {
      costSubs.add(fn);
      loadCosts();
      return () => costSubs.delete(fn);
    },
    () => costs,
  );
}

const characterUrl = (panelId: string, rest: string) => `/api/boards/${encodeURIComponent(activeBoard()?.boardId ?? "")}/characters/${panelId}${rest}`;

/**
 * Press a stage: a person's, from the card or from a node of the flow. A send that was never answered may
 * have been charged, so the person is asked before it goes again. True when the stage started.
 */
export async function pressStage(panelId: string, stage: CharacterStageKey, confirm = false): Promise<boolean> {
  try {
    await api(characterUrl(panelId, `/stages/${stage}`), { method: "POST", json: { confirm } });
    loadCosts(true);
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    if (/may have been charged/.test(msg) && window.confirm(`${msg}\n\nSend it again?`)) return pressStage(panelId, stage, true);
    toast(msg, "bad");
    return false;
  }
}

// ----- the open grid's characters and inspiration -----

export type StudioCharacter = CharacterState & { panelId: string };

/** every character on the open grid whose card is there, keyed by its card: read again when the server's map changes */
export function useStudioCharacters(): StudioCharacter[] {
  const key = useSyncExternalStore(
    (fn) => {
      let off = () => {};
      const watch = () => {
        off();
        const b = activeBoard();
        if (!b) return;
        const map = boardMaps(b.doc).characters;
        map.observe(fn);
        off = () => map.unobserve(fn);
      };
      watch();
      const offBoard = onBoardChange(() => (watch(), fn()));
      const offStore = subscribe(fn);
      return () => (off(), offBoard(), offStore());
    },
    () => {
      const b = activeBoard();
      if (!b) return "";
      const cards = getState().panels;
      return JSON.stringify([...boardMaps(b.doc).characters.entries()].filter(([id]) => cards[id]).map(([id, c]) => ({ ...c, panelId: id })));
    },
  );
  return useMemo(() => (key ? (JSON.parse(key) as StudioCharacter[]) : []), [key]);
}

export interface Inspiration {
  /** the archive's file id (what a character's `refs` hold) */
  file: string;
  src: string;
  name: string;
}
function inspirationKey(set: string): string {
  const st = getState();
  const want = `inspiration · ${set}`.toLowerCase();
  const sec = Object.values(st.allSections).find((s) => s.name.trim().toLowerCase() === want || s.name.trim().toLowerCase() === `${want}s`);
  if (!sec) return "";
  return Object.values(st.media)
    .filter((m) => m.sectionId === sec.id && m.media === "image" && /^\/files\/f_/.test(m.src))
    .map((m) => `${m.src.slice(7)}\t${m.src}\t${m.name}`)
    .join("\n");
}
/** the pictures in a set's Inspiration section */
export function useInspiration(set: string): Inspiration[] {
  const key = useSyncExternalStore(subscribe, () => inspirationKey(set));
  return useMemo(() => (key ? key.split("\n").map((l) => l.split("\t")).map(([file, src, name]) => ({ file, src, name })) : []), [key]);
}

/** the stage a press on this character would run, and whether it is running now */
export function standing(c: Pick<CharacterState, "form" | "stages">): { next: CharacterStageKey | undefined; running: boolean; failed: string | undefined } {
  const next = nextStage(c);
  const st = next ? c.stages[next] : undefined;
  return { next, running: st?.state === "running", failed: st?.state === "failed" ? (st.error ?? "it failed") : undefined };
}

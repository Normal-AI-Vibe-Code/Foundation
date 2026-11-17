/**
 * The Character studio: one board where the council's characters are made
 * (server: characters.ts). Making it again opens the one there is.
 */
import { api } from "./api";
import { getState } from "../state/store";
import { activeBoard } from "../sync/board";
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

/** a new character's card in a section. The server makes it (its state is the server's to keep), and it arrives through the board's sync. */
export async function newCharacter(sectionId: string, form: "model" | "mesh" = "model") {
  const board = activeBoard()?.boardId;
  if (!board) return;
  try {
    await api(`/api/boards/${encodeURIComponent(board)}/characters`, { method: "POST", json: { section: sectionId, form, name: "New character", set: setOfSection(sectionId) } });
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

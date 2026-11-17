/**
 * Making the two primitives of the image pipeline from a section's menu (2026-11-17): a collection card on its
 * own, and the Character studio's whole process laid into a section, with a collection after its Output.
 */
import { COLLECTION_IN, COLLECTION_OUT, COLLECTION_TYPE, uid } from "@foundation/protocol";
import { addPanel, type PanelMeta, type Section } from "../state/store";
import { toast } from "../state/ui";
import { boardTool } from "./collectionDrag";

/** a collection card in a section, empty, with its two ports: wire something into it */
export function addCollection(sectionId: string, at: Partial<Pick<PanelMeta, "float" | "x" | "y">> = {}): PanelMeta {
  return addPanel(sectionId, {
    panel: "collection",
    name: "Collection",
    ports: [
      { id: uid("port"), name: COLLECTION_IN, dir: "in", type: COLLECTION_TYPE },
      { id: uid("port"), name: COLLECTION_OUT, dir: "out", type: COLLECTION_TYPE },
    ],
    ...at,
  });
}

/** the set a section stands for: "Pipeline · Anime" → Anime; a section someone named → that name; otherwise "Characters" */
export function setForSection(name: string): string {
  const m = /·\s*(.+)$/.exec(name.trim());
  if (m) return m[1].trim();
  return /^section\s*\d*$/i.test(name.trim()) || !name.trim() ? "Characters" : name.trim();
}

/** the Character studio's flow in this section, as node cards and wires, with a collection after Output (the server lays it) */
export async function addCharacterPipeline(section: Pick<Section, "id" | "name">): Promise<boolean> {
  const set = setForSection(section.name);
  try {
    await boardTool("add_character_pipeline", { section: section.id, set });
    toast(`Laid the ${set} pipeline here: press ＋ New on Sheet to start a character`, "ok");
    return true;
  } catch (e) {
    toast((e as Error).message, "bad");
    return false;
  }
}

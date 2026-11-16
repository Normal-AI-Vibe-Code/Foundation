/**
 * The buttons Rune draws on a section's toolbar and a card's bar, and what
 * each does. The lists and the actions are the web renderer's own (SectionView's
 * toolbar, ObjectFrame's bar): Rune only draws an icon and says which was
 * pressed, so what a section offers is decided here once, in the client.
 */

import { isHostable } from "@foundation/protocol";
import {
  addNote,
  childrenOf,
  createMap,
  createTable,
  getState,
  hostOf,
  isPanel,
  levelUp,
  objectsInSection,
  openLevel,
  removeMedia,
  removeNote,
  requestRemoveSection,
  requestSnap,
  setActiveSection,
  setObjectFloat,
  setSectionHost,
  splitSection,
  type AnyObject,
  type AppState,
  type PanelMeta,
  type Section,
} from "../state/store";
import { setUi } from "../state/ui";
import { openCouncil } from "../lib/councilOpen";
import type { SectionMenuContext } from "../components/sectionMenu";

/** `icon`: a name apps/rune/src/view.rs draws · `gap`: starts a new group */
export interface SceneTool {
  id: string;
  icon: string;
  tone: "" | "agent" | "danger";
  gap: boolean;
}

const tool = (id: string, gap = false, tone: SceneTool["tone"] = "", icon = id): SceneTool => ({ id, icon, tone, gap });

/** the one card that could fill a section as its app (SectionView's `hostable`) */
function hostableOf(sectionId: string, host: PanelMeta | null): PanelMeta | null {
  if (host) return null;
  const objects = objectsInSection(sectionId);
  const only = objects.length === 1 ? objects[0] : null;
  return only && isPanel(only) && isHostable(only.panel) ? only : null;
}

/** what a section's menu and toolbar need to know about it */
export function sectionContext(st: AppState, s: Section): SectionMenuContext {
  const host = hostOf(s.id);
  return {
    host,
    hostable: hostableOf(s.id, host),
    isOpen: !!s.virtual,
    isGrid: !s.virtual && childrenOf(s.id, st.allSections).length > 0,
    canRemove: Object.keys(st.sections).length > 1,
    upload: () => {
      setActiveSection(s.id);
      window.dispatchEvent(new Event("foundation:upload"));
    },
  };
}

/** a section's toolbar, in the web toolbar's order and groups (a viewer has none) */
export function sectionTools(st: AppState, s: Section, readOnly: boolean): SceneTool[] {
  if (readOnly) return [];
  const { host, hostable, isOpen, canRemove } = sectionContext(st, s);
  const groups: SceneTool[][] = [
    // its app
    host ? [tool("unhost")] : [],
    // add
    [...(hostable ? [tool("fill")] : []), ...(host ? [] : [tool("app")]), tool("table"), tool("map"), tool("note"), tool("upload")],
    // arrange
    [tool("split-h"), tool("split-v"), host && !isOpen ? tool("frame") : isOpen ? tool("up") : tool("open")],
    // the agent, and remove
    [tool("ask", false, "agent"), ...(canRemove && !isOpen ? [tool("remove", false, "danger")] : [])],
  ].filter((g) => g.length > 0);
  // a hairline before each group but the first
  return groups.flatMap((g, i) => g.map((t, j) => ({ ...t, gap: i > 0 && j === 0 })));
}

export function runSectionTool(id: string, which: string) {
  const st = getState();
  const s = st.sections[id];
  if (!s) return;
  const { hostable, upload } = sectionContext(st, s);
  const acts: Record<string, () => void> = {
    unhost: () => setSectionHost(id, null),
    fill: () => hostable && setSectionHost(id, hostable.id),
    app: () => {
      setActiveSection(id);
      setUi({ command: true });
    },
    table: () => createTable(id),
    map: () => createMap(id),
    note: () => addNote(id),
    upload,
    "split-h": () => splitSection(id, "h"),
    "split-v": () => splitSection(id, "v"),
    frame: () => requestSnap({ kind: "section", id }),
    up: () => levelUp(),
    open: () => openLevel(id),
    // agents are the section's: its council (2026-11-15), whether it holds cards or hosts an app
    ask: () => openCouncil({ kind: "section", id: s.id }),
    remove: () => requestRemoveSection(id),
  };
  acts[which]?.();
}

/** what the remove confirmation asks, while this section is the one being asked about */
export function removeQuestion(st: AppState, s: Section): string {
  if (st.pendingRemoval !== s.id) return "";
  const n = objectsInSection(s.id).length;
  return `Remove ${s.name}${n > 0 ? ` and ${n} item${n === 1 ? "" : "s"}` : ""}?`;
}

/** a card's chrome on hover, as ObjectFrame gives it: a note's bar, an image's round buttons */
export function cardChrome(o: AnyObject, readOnly: boolean): { chrome: "" | "bar" | "icons"; tools: SceneTool[]; resizable: boolean } {
  if (readOnly || isPanel(o) || "cols" in o || "sourceTableId" in o) return { chrome: "", tools: [], resizable: false };
  if ("media" in o) return { chrome: "icons", tools: [tool("remove")], resizable: true };
  return { chrome: "bar", tools: [tool(o.float ? "dock" : "float"), tool("remove")], resizable: true };
}

export function runCardTool(id: string, which: string) {
  const st = getState();
  const note = st.notes[id];
  const media = st.media[id];
  const o = note ?? media;
  if (!o) return;
  if (which === "float" || which === "dock") setObjectFloat(id, !o.float);
  else if (which === "remove") note ? removeNote(id) : removeMedia(id);
}

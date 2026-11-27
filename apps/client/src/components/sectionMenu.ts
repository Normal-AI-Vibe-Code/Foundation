/**
 * A section's right-click menu, for both renderers: the web section opens it
 * from its own surface (SectionView), and Rune's board from the grid's hit on
 * what Rune drew (GridViewport). One list, so the two can't drift.
 */

import { openCouncil } from "../lib/councilOpen";
import { newCharacter } from "../lib/characterStudio";
import { addCollection, addCharacterPipeline } from "../lib/collections";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { getUi, toast } from "../state/ui";
import { openNoteRecorder } from "../notes/open";
import {
  CONTENT_PAD,
  SECTION_HEADER,
  addNote,
  NOTE_H,
  NOTE_W,
  addPanel,
  startMachine,
  startVm,
  addSectionAdjacent,
  createMap,
  createTable,
  getState,
  levelUp,
  openLevel,
  requestRemoveSection,
  requestSnap,
  sectionCardRect,
  sectionFit,
  setActiveSection,
  setSectionHost,
  splitSection,
  type PanelMeta,
  type Section,
} from "../state/store";
import { openAgentsPane } from "./SectionCrew";
import { askGrid, gridOfSection, openAsGrid } from "../lib/subgrid";
import { openGrid } from "../lib/grids";
import { keepAgentsCard } from "./SectionAgents";
import { setUi } from "../state/ui";
import type { MenuGroup, MenuItem } from "./menuLayout";
import { addChatPicker } from "../chat/gridChatPlace";
import { pingAboutSection } from "../chat/ping";
import { CHAT_CARD } from "../chat/gridChat";

export interface SectionMenuContext {
  /** where the menu was opened, on screen (the ping picker opens there) */
  screen?: { x: number; y: number };
  /** the app the section hosts, or the one card that could fill it */
  host: PanelMeta | null;
  hostable: PanelMeta | null;
  /** an opened section filling its own grid */
  isOpen: boolean;
  /** a section that is a grid of sections */
  isGrid: boolean;
  canRemove: boolean;
  /** open the file dialog for this section */
  upload(): void;
}

/** `pt`: where it was right-clicked, in the grid's world (live things land there, not in the flow) */
export function sectionMenuItems(section: Section, pt: { x: number; y: number } | null, { host, hostable, isOpen, isGrid, canRemove, upload, screen }: SectionMenuContext): MenuItem[] {
  // live things land where you clicked, not in the flow
  const at = (w: number, h: number) => {
    const st = getState();
    if (!pt) return {};
    const card = sectionCardRect(st.grid, section);
    const f = sectionFit(section.id);
    // centred on the click (in the section's fitted content), kept inside what's visible of the section
    const roomW = (card.w - 2) / f - CONTENT_PAD * 2;
    const roomH = (card.h - 2 - SECTION_HEADER) / f - CONTENT_PAD * 2;
    const x = Math.min((pt.x - card.x - 1) / f - CONTENT_PAD - w / 2, roomW - w);
    const y = Math.min((pt.y - card.y - 1 - SECTION_HEADER) / f - CONTENT_PAD - h / 3, roomH - h);
    return { float: true, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  };
  const channels = Object.values(getState().panels).filter((p) => p.panel === "slack" && p.channel);
  const tellSlack: MenuItem[] = channels.slice(0, 3).map((c) => ({
    icon: "↗",
    label: `Send ${c.name} a link here`,
    action: () =>
      void api(`/api/slack/channels/${c.channel}/share`, { method: "POST", json: { board: activeBoard()?.boardId ?? "company", objectId: section.host ?? section.id, title: section.name } })
        .then(() => toast(`Sent ${c.name} a link to ${section.name}`, "ok"))
        .catch((err) => toast((err as Error).message, "bad")),
  }));
  // where each sits (menuLayout.ts): Add and Live are two columns side by side; the grid's own actions are a
  // row of icon buttons along the bottom, each named on roll-over
  const tag = (group: MenuGroup, items: MenuItem[]): MenuItem[] => items.map((it) => ({ ...it, group }));
  return [
    // an agent first: the section is somewhere agents build with you
    { icon: "⚇", label: "Council: ask this section's agents…", agent: true, action: () => openCouncil({ kind: "section", id: section.id }) },
    // someone, in ChatForm, about this section (chat/ping.ts)
    { icon: "@", label: "Ping someone about this section…", action: () => pingAboutSection(section.id, screen?.x ?? window.innerWidth / 2 - 150, screen?.y ?? 120) },
    ...tag("add", [
    { heading: "Add" },
    { icon: "¶", label: "Note", action: () => addNote(section.id, undefined, at(NOTE_W, NOTE_H)) },
    // a voice or video note opens the recorder (notes/); never a viewer's
    ...(getUi().role === "viewer" ? [] : [{ icon: "◉", label: "Voice or video note…", action: () => openNoteRecorder(section.id) }]),
    { icon: "⊞", label: "Table", action: () => createTable(section.id) },
    { icon: "◍", label: "Map", action: () => createMap(section.id) },
    { icon: "⇪", label: "Image, video or file…", action: () => upload() },
    {
      icon: "◳",
      label: "App or web page…",
      action: () => {
        setActiveSection(section.id);
        setUi({ command: true });
      },
    },
    ]),
    ...tag("live", [
    { heading: "Live" },
    { icon: "✦", label: "Agents card", agent: true, action: () => keepAgentsCard(section.id, at(380, 440)) },
    { icon: "◐", label: "Huddle", action: () => addPanel(section.id, { panel: "huddle", name: "Huddle", ...at(560, 420) }) },
    { icon: "#", label: "ChatForm channel", action: () => void addChatPicker(section.id, at(CHAT_CARD.w, CHAT_CARD.h)) },
    { icon: "#", label: "Slack channel", action: () => addPanel(section.id, { panel: "slack", name: "Slack", ...at(420, 520) }) },
    { icon: "▣", label: "Machine", action: () => startMachine(section.id, at(760, 520)) },
    { icon: "▣", label: "Full operating system / WildOS VM", action: () => startVm(section.id, at(800, 700)) },
    { icon: "⎈", label: "Kubernetes cluster", action: () => void layCluster(section.id) },
    ...tellSlack,
    { icon: "☺", label: "Character: 3D", action: () => void newCharacter(section.id, "model") },
    { icon: "☺", label: "Character: mesh avatar", action: () => void newCharacter(section.id, "mesh") },
    { icon: "❖", label: "Collection", action: () => addCollection(section.id, at(360, 420)) },
    { icon: "⇢", label: "Character pipeline", action: () => void addCharacterPipeline(section) },
    { icon: "◨", label: "All agents on this grid", action: () => openAgentsPane(section.id) },
    ]),
    ...tag("grid", [
    ...(host
      ? [
          { icon: "⤢", label: "Fill the screen with it", action: () => requestSnap({ kind: "section" as const, id: section.id }) },
          // a grid's card: open it, or put it back (the undo of Open as its own grid); a hosted app's section can still become a grid
          ...(gridOfSection(host)
            ? [
                { icon: "▦", label: "Open the grid", action: () => openGrid(gridOfSection(host)!) },
                { icon: "⤓", label: "Put the grid back into this section…", action: () => askGrid(section.id, "back") },
              ]
            : isOpen
              ? []
              : [{ icon: "▦", label: "Open as its own grid", action: () => askGrid(section.id) }]),
        ]
      : isOpen
        ? [{ icon: "⤡", label: "Back up a level", action: () => levelUp() }]
        : [{ icon: "⤢", label: isGrid ? "Open its grid" : "Open as its own grid", action: () => (isGrid ? openLevel(section.id) : openAsGrid(section.id, host)) }]),
    { icon: "←", label: "Insert section left", action: () => addSectionAdjacent(section.id, "left") },
    { icon: "→", label: "Insert section right", action: () => addSectionAdjacent(section.id, "right") },
    { icon: "↑", label: "Insert section above", action: () => addSectionAdjacent(section.id, "above") },
    { icon: "↓", label: "Insert section below", action: () => addSectionAdjacent(section.id, "below") },
    { icon: "◫", label: "Split column", action: () => splitSection(section.id, "h") },
    { icon: "⬓", label: "Split row", action: () => splitSection(section.id, "v") },
    ...(host
      ? [{ icon: "◱", label: `Show ${host.name} as a card`, action: () => setSectionHost(section.id, null) }]
      : hostable
        ? [{ icon: "◳", label: `Let ${hostable.name} fill the section`, action: () => setSectionHost(section.id, hostable.id) }]
        : []),
    {
      icon: "🗑",
      label: "Remove section…",
      danger: true,
      disabled: !canRemove,
      action: () => requestRemoveSection(section.id),
    },
    ]),
  ];
}

/** a Kubernetes cluster's cards laid in a section: a server and two workers, nothing running until a person starts it */
function layCluster(sectionId: string) {
  const board = activeBoard()?.boardId;
  if (!board) return;
  void api<{ cluster: string }>(`/api/boards/${encodeURIComponent(board)}/clusters`, { method: "POST", json: { section: sectionId, workers: 2 } })
    .then(() => toast("A Kubernetes cluster is laid: a server and two workers. Start the cluster on any of them.", "ok"))
    .catch((e: Error) => toast(e.message, "bad"));
}

/**
 * Putting a ChatForm conversation on a grid (2026-11-25): the card is a reference (chat/gridChat.ts says what
 * the board keeps), added like any card, so it is a board write: a viewer of the grid can't add one, and the
 * server would drop it if they tried. Three ways in:
 *
 *  - a conversation in the hand (chat/carryChat.ts) let go over a section, which rings while it's held over it
 *    as a section does for anything else carried onto it (lib/pickup.ts);
 *  - a section's right-click menu and an empty section's choices: a card with no conversation yet, which asks
 *    which one (panels/ChatCardView.tsx);
 *  - a conversation's own menu in ChatForm's list: *Put on the open grid*.
 */

import type { ChatChannelView } from "@foundation/protocol";
import { camera, toWorld } from "../state/camera";
import { addPanel, getState, placeAtWorld, requestSnap, sectionAtWorld, type PanelMeta } from "../state/store";
import { getUi, toast } from "../state/ui";
import { goGrid } from "../lib/place";
import { activeBoard } from "../sync/board";
import { CHAT_SERVER } from "./server";
import { CHAT_CARD, CHAT_CARD_NAME, chatCardRef } from "./gridChat";

const VIEW_ONLY = "View only: you can't put a card on this grid";

/** the section of the grid under a point of the window, when the grid is what's there (not a pane, the top bar or ChatForm) */
export function sectionUnder(x: number, y: number): string | null {
  const top = document.elementFromPoint(x, y) as HTMLElement | null;
  const vp = document.querySelector<HTMLElement>(".grid-viewport");
  if (!top || !vp || !vp.contains(top) || top.closest(".floor-pane, .top-bar")) return null;
  const r = vp.getBoundingClientRect();
  const w = toWorld(x - r.left, y - r.top);
  return sectionAtWorld(w.x, w.y)?.id ?? null;
}

/** ring the section a carried conversation would land in (the ring every drop onto a section has); null puts it away */
export function ringSection(id: string | null) {
  document.querySelectorAll("[data-section-id].is-hit-target").forEach((el) => el.classList.remove("is-hit-target"));
  if (id) document.querySelector(`[data-section-id="${CSS.escape(id)}"]`)?.classList.add("is-hit-target");
}

/** may this person put a card on the open grid */
export const canPlaceChat = () => getUi().role !== "viewer" && !!activeBoard();

/** the card for this conversation already in a section, if there is one (asked twice, added once) */
function cardIn(sectionId: string, channelId: string): PanelMeta | undefined {
  return Object.values(getState().panels).find((p) => p.panel === "chat" && p.sectionId === sectionId && p.channel === channelId && (p.chatServer ?? "") === CHAT_SERVER);
}

/**
 * Put a conversation on a section as a card. `at`: where in the window it was let go (it floats there);
 * without it, it joins the section's flow. One card per conversation per section: asked again, the card
 * that's there is shown.
 */
export function addChatCard(sectionId: string, channel: Pick<ChatChannelView, "id" | "kind" | "name">, at?: { x: number; y: number }): PanelMeta | null {
  if (!canPlaceChat()) {
    toast(VIEW_ONLY);
    return null;
  }
  const had = cardIn(sectionId, channel.id);
  if (had) {
    requestSnap({ kind: "object", id: had.id });
    toast("That conversation is already in this section");
    return had;
  }
  const card = addPanel(sectionId, { ...chatCardRef(channel, CHAT_SERVER), w: CHAT_CARD.w, h: CHAT_CARD.h }, { focus: !at });
  if (at) {
    const w = toWorld(at.x - camera.left, at.y - camera.top);
    placeAtWorld(card.id, w.x, w.y);
  }
  return card;
}

/** a chat card with no conversation yet: the card asks which (a section's menu, an empty section) */
export function addChatPicker(sectionId: string, at: Partial<Pick<PanelMeta, "float" | "x" | "y">> = {}): PanelMeta | null {
  if (!canPlaceChat()) {
    toast(VIEW_ONLY);
    return null;
  }
  return addPanel(sectionId, { panel: "chat", name: CHAT_CARD_NAME, w: CHAT_CARD.w, h: CHAT_CARD.h, ...at });
}

/** from ChatForm's list: onto the open grid, in the section that has the focus (else its first), and go there */
export function putOnOpenGrid(channel: Pick<ChatChannelView, "id" | "kind" | "name">) {
  if (!canPlaceChat()) return void toast(activeBoard() ? VIEW_ONLY : "Open a grid first");
  const st = getState();
  const sectionId = (st.activeSectionId && st.sections[st.activeSectionId] ? st.activeSectionId : undefined) ?? Object.keys(st.sections)[0];
  if (!sectionId) return void toast("This grid has no section to put it in");
  goGrid();
  const card = addChatCard(sectionId, channel);
  if (card) requestSnap({ kind: "object", id: card.id });
}

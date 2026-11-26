/**
 * Things from Foundation, put down on a conversation (2026-11-25, Josh: "I'd like the ability to drag things in from
 * foundation into the chatform chat box and vice versa").
 *
 * A conversation that takes things is a **drop zone** (`data-chat-drop-zone`): ChatForm's open conversation, the one
 * pinned in the right panel, a chat card on a grid. A card carried off the grid (lib/carry.ts) or a search result
 * picked up (lib/pickup.ts) rings the zone it is held over; let go there, the card stays where it was and what it is
 * goes into that conversation's composer (chat/Composer.tsx), to be sent by the person's own press:
 *
 *  - a picture on Foundation's server: the picture itself, attached as a file (a chat server that takes no files
 *    gets a link to the card instead);
 *  - any other card: a link to it (a message of type "link": its name, its grid, and a press there opens it);
 *  - words (a search result with no card): its title and what it says.
 *
 * Nothing is sent by the drop: it is a draft in the field, like a pasted file.
 *
 * The other way, a message pulled out of a conversation onto the grid, is chat/Message.tsx (`CHAT_MESSAGE_MIME`) and
 * components/SectionView.tsx: it lands as a note with who said it, and its pictures come with it.
 */

import type { ChatMessage } from "@foundation/protocol";
import { getObject, isPanel, type AnyObject } from "../state/store";
import { activeBoard } from "../sync/board";

export type ChatPlace = NonNullable<ChatMessage["place"]>;

export type ChatDropItem =
  | { kind: "place"; place: ChatPlace }
  | { kind: "file"; src: string; name: string; place?: ChatPlace }
  | { kind: "text"; text: string };

/** the event a zone's composer hears */
export const CHAT_DROP = "foundation:chat-drop";
/** a message dragged out of a conversation (HTML drag and drop): JSON of `DraggedMessage` */
export const CHAT_MESSAGE_MIME = "application/x-foundation-chat-message";

export interface DraggedMessage {
  author: string;
  text: string;
  at: number;
  channel: string;
  /** its pictures and files, by the address this device reads them at */
  files: Array<{ name: string; src: string; mime: string }>;
}

/** the conversation under a screen point, if one takes drops there */
export function chatZoneAt(el: Element | null): HTMLElement | null {
  const zone = el?.closest<HTMLElement>("[data-chat-drop-zone]") ?? null;
  if (!zone || zone.dataset.chatDropZone === "off") return null;
  return zone;
}

/** put `items` into the zone's composer (the conversation's own, not a thread's) */
export function dropOnChat(zone: HTMLElement, items: ChatDropItem[]) {
  const composer = zone.querySelector<HTMLElement>('[data-chat-composer="channel"]') ?? zone.querySelector<HTMLElement>("[data-chat-composer]");
  if (!composer || !items.length) return false;
  composer.dispatchEvent(new CustomEvent<ChatDropItem[]>(CHAT_DROP, { detail: items }));
  return true;
}

/** the grid the card is on, by the name its tab wears */
function boardName(id: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLElement>(`[data-space-drop="${CSS.escape(id)}"]`)?.dataset.spaceName ?? undefined;
}

/** where a card is, as a chat link names it */
export function placeOf(card: Pick<AnyObject, "id" | "name" | "sectionId">, board: string, name?: string): ChatPlace {
  return { board, label: card.name || "A card", object: card.id, ...(card.sectionId ? { section: card.sectionId } : {}), ...(name ? { boardName: name } : {}) };
}

/** what a card on this grid is, put down on a conversation. Pure on its inputs (the card, the grid) */
export function itemsForCard(card: AnyObject | null, board: string | null | undefined, name?: string): ChatDropItem[] {
  if (!card || !board) return [];
  const place = placeOf(card, board, name);
  if (!isPanel(card) && "media" in card && card.media === "image" && /^\/files\//.test(card.src)) return [{ kind: "file", src: card.src, name: card.name || "picture", place }];
  // a voice or video note goes as its clip (the same archived file), so the conversation can play it
  if (!isPanel(card) && "media" in card && card.note && /^\/files\//.test(card.src)) return [{ kind: "file", src: card.src, name: card.name || (card.media === "audio" ? "voice note" : "video note"), place }];
  return [{ kind: "place", place }];
}

/** the card `id` on the open grid, put down on a conversation */
export function cardDropItems(id: string): ChatDropItem[] {
  const board = activeBoard()?.boardId;
  return itemsForCard(getObject(id), board, board ? boardName(board) : undefined);
}

/** a search result, put down on a conversation */
export function hitDropItems(hit: { title: string; snippet: string; url?: string; objectId?: string; thumb?: string }): ChatDropItem[] {
  if (hit.objectId) {
    const items = cardDropItems(hit.objectId);
    if (items.length) return items;
  }
  if (hit.thumb && /^\/files\//.test(hit.thumb)) return [{ kind: "file", src: hit.thumb, name: hit.title || "picture" }];
  const words = [hit.title, hit.url].filter(Boolean).join(" — ");
  return words ? [{ kind: "text", text: words }] : [];
}

/** a message, as the note it becomes on a grid */
export function noteFromMessage(m: Pick<DraggedMessage, "author" | "text" | "at">): { title: string; body: string } {
  const when = new Date(m.at);
  const stamp = Number.isFinite(when.getTime()) ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const title = `${m.author}${stamp ? ` · ${stamp}` : ""}`;
  return { title, body: m.text.trim() };
}

export { placeWords } from "./logic";

/**
 * Ping someone about a place on a grid (2026-11-27, Josh: "a ping command in the right context menu"). The grid's
 * right-click menu (a card's, a section's) opens the picker (chat/PingPicker.tsx) at the press; picking someone
 * sends them, in ChatForm, a direct message that @mentions them and links the place:
 *
 *  - a person: our direct message (the one there is, or a new one);
 *  - an agent ChatForm knows: my conversation with it (the one there is, or a new one). My message there is my own,
 *    so it may start the agent's turn, as anything I write to it would.
 *
 * Their end: the bell counts it, the ping sounds (chat/pingSound.ts), and pressing the notice opens the grid at the
 * card (lib/openPlace.ts). Nothing is sent but by the person's own pick. Whom I've pinged is kept on this device,
 * per person, for the picker's Recent.
 */

import { useSyncExternalStore } from "react";
import { chatHandle } from "@foundation/protocol";
import { getObject, getState } from "../state/store";
import { activeBoard } from "../sync/board";
import { boardName, placeOf, type ChatPlace } from "./chatDrop";
import { createChannel, getChat, openDirect, send } from "./model";
import { addRecent, pingText, type PingWho, type RecentPing } from "./pingLogic";

// ---------------------------------------------------------------- the picker, open or not

export interface PingAsk {
  x: number;
  y: number;
  place: ChatPlace;
  /** the card it's about (its maker and assignee are offered) */
  objectId?: string;
}

let ask: PingAsk | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function usePingAsk(): PingAsk | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    () => ask,
  );
}

export function closePing() {
  ask = null;
  emit();
}

/** the picker, at a screen point, about a card */
export function pingAboutCard(id: string, x: number, y: number) {
  const board = activeBoard()?.boardId;
  const card = getObject(id);
  if (!board || !card) return;
  ask = { x, y, place: placeOf(card, board, boardName(board)), objectId: id };
  emit();
}

/** the picker, at a screen point, about a section */
export function pingAboutSection(sectionId: string, x: number, y: number) {
  const board = activeBoard()?.boardId;
  const sec = getState().sections[sectionId];
  if (!board || !sec) return;
  const name = boardName(board);
  ask = { x, y, place: { board, section: sectionId, label: sec.name || "A section", ...(name ? { boardName: name } : {}) } };
  emit();
}

// ---------------------------------------------------------------- whom I've pinged (this device's)

const recentKey = (me: string) => `foundation-pings:${me}`;

export function recentPings(): RecentPing[] {
  const me = getChat().me?.id;
  if (!me) return [];
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(me)) ?? "[]") as RecentPing[];
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === "string" && typeof r.name === "string") : [];
  } catch {
    return [];
  }
}

function remember(who: PingWho) {
  const me = getChat().me?.id;
  if (!me) return;
  try {
    localStorage.setItem(recentKey(me), JSON.stringify(addRecent(recentPings(), who)));
  } catch { /* private window */ }
}

// ---------------------------------------------------------------- sending

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** can ChatForm reach them: a person it knows, or an agent it knows (a tool-call's "Ada's agent" isn't one) */
export function reachable(who: PingWho): boolean {
  const s = getChat();
  if (who.kind === "person") return !s.remote || s.people.some((p) => p.id === who.id || same(p.name, who.name));
  return !s.remote && s.agents.some((a) => same(a.name, who.name));
}

/** send the ping; answers the conversation it went to */
export async function sendPing(who: PingWho, place: ChatPlace): Promise<string> {
  const s = getChat();
  if (!s.me || s.status === "signin") throw new Error("Sign in to ChatForm to ping someone");
  if (s.status === "unavailable") throw new Error("ChatForm isn't on this server yet");
  let channel: string;
  if (who.kind === "person") {
    // on a chat server of its own, the person by its id for them (or their name)
    const id = s.remote ? (s.people.find((p) => p.id === who.id) ?? s.people.find((p) => same(p.name, who.name)))?.id : who.id;
    if (!id) throw new Error(`${who.name} isn't on this chat server`);
    channel = (await openDirect([id])).id;
  } else {
    const agent = s.agents.find((a) => same(a.name, who.name));
    if (!agent || s.remote) throw new Error(`${who.name} can't be reached in ChatForm`);
    const have = Object.values(getChat().channels).find((c) => c.kind === "agent" && c.agent && same(c.agent.name, agent.name) && c.me && !c.archivedAt);
    channel = have?.id ?? (await createChannel({ kind: "agent", agent: { name: agent.name, ...(agent.via ? { via: agent.via } : {}) } })).id;
  }
  send(channel, pingText(chatHandle(who.name), place.label), [], null, place);
  remember(who);
  return channel;
}

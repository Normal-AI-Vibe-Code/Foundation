/**
 * A ChatForm conversation on a grid (`panel: "chat"`; Josh, 2026-11-25: "I'd like for chat objects also to be
 * created in sections in Foundation, you can add a channel from ChatForm to an area, and have people who are
 * visible in the grid with you … also able to chat through voice and text inside the Foundation grid with you").
 * The pure part: what the board keeps, what a card is on this device, who is drawn in its head, and its words.
 * panels/ChatCardView.tsx draws it; chat/gridChatPlace.ts puts one on a section.
 *
 * **What the board keeps** is a reference and nothing else:
 *
 *   - `channel`: the conversation's id on its chat server (an opaque id);
 *   - `chatServer`: that server's origin, left out when it is the Foundation server the grid is on. A grid is seen
 *     from many devices and each may point ChatForm somewhere else: the id means nothing on another server (or
 *     worse, someone else's conversation), so a card made against one server says so on a device pointed at
 *     another instead of looking the id up there;
 *   - `name`: `#slug` for an **open** channel (anyone signed in to that chat server can already list it, and the
 *     card's title bar needs words), and the plain word *Conversation* for anything else. A private channel's
 *     name, a direct message's people, the topic, the member list, the kind and every message stay on the chat
 *     server: the board's document is synced to everyone who can see the grid, viewers and agents included, and
 *     a conversation's access is the chat server's alone (CLAUDE.md, ChatForm's invariants).
 *
 * Everything drawn inside the card (its real title, its people, what was said) is asked of the chat server by
 * the person looking, under their own sign-in there. Posting is a chat write, not a board write: a viewer of
 * the grid who is a member of the conversation can write in it; only adding, moving or removing the card is
 * the board's.
 */

import type { ChatAgentRef, ChatChannelView, ChatParty, WhereAgent, WhereBoard } from "@foundation/protocol";
import { chatServerName } from "./serverLogic";

/** the card's size when it's put down, and the smallest it is laid out for */
export const CHAT_CARD = { w: 400, h: 560, minW: 360, minH: 480 };

/** the card's name on the board when the conversation's own name isn't the board's to keep */
export const CHAT_CARD_NAME = "Conversation";

export interface ChatCardRef {
  panel: "chat";
  name: string;
  channel: string;
  chatServer?: string;
}

/** what the board keeps for a conversation (see the head of this file). `server`: the chat server's origin, "" for Foundation's own */
export function chatCardRef(channel: Pick<ChatChannelView, "id" | "kind" | "name">, server: string): ChatCardRef {
  return {
    panel: "chat",
    name: channel.kind === "open" && channel.name ? `#${channel.name}` : CHAT_CARD_NAME,
    channel: channel.id,
    ...(server ? { chatServer: server } : {}),
  };
}

// ---------------------------------------------------------------- what a card is, here

/**
 * What a chat card is on this device:
 *  - `unpicked`: put down from the add menu, no conversation chosen yet;
 *  - `elsewhere`: its conversation is on another chat server than the one this device's ChatForm is on;
 *  - `signin`: nobody is signed in to the chat server on this device;
 *  - `unavailable`: this server has no ChatForm;
 *  - `waiting`: the list hasn't come, or the conversation is being asked for;
 *  - `locked`: the chat server says this person can't see it (or it's gone: the two answer alike);
 *  - `open`: the conversation, drawn.
 */
export type ChatCardState = "unpicked" | "elsewhere" | "signin" | "unavailable" | "waiting" | "locked" | "open";

export interface ChatCardFacts {
  /** the card's `channel` */
  channel?: string;
  /** the card's `chatServer` ("" or absent: Foundation's own) */
  cardServer?: string;
  /** the chat server this device's ChatForm is on ("": Foundation's own) */
  hereServer: string;
  /** the chat store's status */
  status: "off" | "connecting" | "live" | "offline" | "unavailable" | "signin";
  /** the store has its list */
  loaded: boolean;
  /** the store has this conversation (the server gave it to this person) */
  has: boolean;
  /** asked for by id because the list didn't have it: not yet, being asked, or the answer */
  asked: "no" | "asking" | "refused";
}

export function chatCardState(f: ChatCardFacts): ChatCardState {
  if (!f.channel) return "unpicked";
  if ((f.cardServer ?? "") !== f.hereServer) return "elsewhere";
  if (f.status === "signin") return "signin";
  if (f.status === "unavailable") return "unavailable";
  if (f.has) return "open";
  if (!f.loaded || f.asked !== "refused") return "waiting";
  // offline, a refusal may only be the network: it's asked again when the connection is back
  return f.status === "offline" ? "waiting" : "locked";
}

const serverWords = (origin: string) => (origin ? chatServerName(origin) : "Foundation's own server");

/** the on-another-server card: which server it is on, and which this device is on */
export function elsewhereWords(cardServer: string | undefined, hereServer: string): { title: string; line: string } {
  return {
    title: `A conversation on ${serverWords(cardServer ?? "")}`,
    line: `ChatForm on this device is on ${serverWords(hereServer)}, so it can't be shown here. Settings → General → ChatForm's server changes which one this device uses.`,
  };
}

/**
 * The locked card. It never says what the conversation is: an open channel's `#name` is already the card's
 * title on the board, and for anything else the board has no name to give.
 */
export function lockedWords(viewer: boolean): { title: string; line: string } {
  return {
    title: "A conversation you're not in",
    line: viewer ? "Its people can read and write it here. Someone in it can add you." : "Its people can read and write it here. Ask someone in it to add you; or it was archived.",
  };
}

/** why the composer can't send here, if it can't (the same rule as ChatForm's own) */
export function cantSend(channel: Pick<ChatChannelView, "archivedAt" | "me">, chatRole: "admin" | "member" | "viewer"): string | undefined {
  if (channel.archivedAt) return "This channel is archived: everything said stays readable";
  if (chatRole === "viewer" && !channel.me) return "View only: a viewer posts where they're a member";
  return undefined;
}

// ---------------------------------------------------------------- who is here

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface CardFace {
  party: ChatParty;
  /** on this grid now */
  here: boolean;
  /** online in chat */
  online: boolean;
}
export interface CardAgent {
  name: string;
  /** at work on this grid now */
  here: boolean;
  /** what it's doing there */
  doing?: string;
}
export interface CardPeople {
  /** people of the conversation who are on this grid or online, the ones on the grid first; never me */
  faces: CardFace[];
  /** the conversation's agents, and the agents at work on this grid */
  agents: CardAgent[];
}

/**
 * Who a chat card's head draws. People: the conversation's members (an open channel sends no member list, so
 * there everyone the chat server lists) who are **on this grid now** or **online in chat**, each once, not me.
 * A person on the grid is matched to the chat server's person by id, and by name when ChatForm is on a server of
 * its own (two servers, two ids for one person; lib/whereLines.ts `mergeWhere` carries the other id as `chatId`).
 * Agents: the conversation's own, and those at work on this grid.
 */
export function cardPeople(p: { channel: Pick<ChatChannelView, "kind" | "members" | "agent">; people: ChatParty[]; online: string[]; where?: WhereBoard; meId?: string }): CardPeople {
  const members = p.channel.members ?? (p.channel.kind === "open" ? p.people : []);
  const onGrid = p.where?.people ?? [];
  const hereIds = new Set<string>();
  const hereNames = new Set<string>();
  for (const w of onGrid) {
    hereIds.add(w.id);
    if (w.chatId) hereIds.add(w.chatId);
    hereNames.add(norm(w.name));
  }
  const seen = new Set<string>();
  const faces: CardFace[] = [];
  for (const m of members) {
    if (m.kind !== "person" || m.id === p.meId || seen.has(m.id)) continue;
    seen.add(m.id);
    const here = hereIds.has(m.id) || hereNames.has(norm(m.name));
    const online = p.online.includes(m.id);
    if (here || online) faces.push({ party: m, here, online });
  }
  faces.sort((a, b) => Number(b.here) - Number(a.here) || a.party.name.localeCompare(b.party.name));

  const agents = new Map<string, CardAgent>();
  const own: Array<Pick<ChatAgentRef, "name">> = [...(p.channel.agent ? [p.channel.agent] : []), ...(p.channel.members ?? []).filter((m) => m.kind === "agent")];
  for (const a of own) if (!agents.has(norm(a.name))) agents.set(norm(a.name), { name: a.name, here: false });
  for (const a of (p.where?.agents ?? []) as WhereAgent[]) {
    const had = agents.get(norm(a.name));
    if (had) {
      had.here = true;
      if (a.status === "working" && a.doing) had.doing = a.doing;
    } else agents.set(norm(a.name), { name: a.name, here: true, ...(a.status === "working" && a.doing ? { doing: a.doing } : {}) });
  }
  return { faces, agents: [...agents.values()].sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name)) };
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** the head's faces, in words (its roll-over and its label): "Ada and Kai are on this grid · Noa is online · Wren is at work here" */
export function peopleWords(p: CardPeople): string {
  const parts: string[] = [];
  const here = p.faces.filter((f) => f.here).map((f) => f.party.name);
  const away = p.faces.filter((f) => !f.here).map((f) => f.party.name);
  if (here.length) parts.push(`${list(here)} ${here.length === 1 ? "is" : "are"} on this grid`);
  if (away.length) parts.push(`${list(away)} ${away.length === 1 ? "is" : "are"} online`);
  const working = p.agents.filter((a) => a.here).map((a) => a.name);
  if (working.length) parts.push(`${list(working)} ${working.length === 1 ? "is" : "are"} at work here`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- telling a chat server which grid is open

/**
 * What this window says to a chat server of its own about the grid it has open (protocol `ChatSay` `where`), or
 * null when it says nothing.
 *
 *  - Only to a server that asks for it: its `/auth/config` `features` include `where`.
 *  - Only while a grid is what's on screen; on Today, Settings or ChatForm it says `board: null`.
 *  - **The grid's name is never sent** (always null). This window can't tell whether a grid is members-only: the
 *    server's list of grids (`/api/boards`) carries no such mark, and a members-only grid's name must not reach
 *    people outside it (apps/server/src/members.ts answers them as if it didn't exist). The chat server has no use
 *    for the name anyway: every window that may see the grid has its name from its own Foundation server. What
 *    does leave this computer is the grid's id, an opaque string, with who is on it; a window that hears of a grid
 *    it doesn't know drops it (lib/whereLines.ts `mergeWhere`).
 */
export function whereToSay(p: { remote: boolean; features: string[] | null; onGrid: boolean; boardId: string | null }): { board: string | null; name: null } | null {
  if (!p.remote || !p.features?.includes("where")) return null;
  return { board: p.onGrid && p.boardId ? p.boardId : null, name: null };
}

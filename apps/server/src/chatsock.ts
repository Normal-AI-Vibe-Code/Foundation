/**
 * ChatForm's socket, `/chat`: one per window, carrying every channel its person can see
 * (docs/chatform.md §2). The server sends `ChatEvent`s; the client sends `ChatSay` (typing, ping).
 * Everything that changes anything goes over HTTP; this only says what's passing.
 *
 * - `hello` first (rev 0); every event after it counts `rev` up by one on this connection, so a gap
 *   (or a reconnect) tells the client to fetch the list again and the open channel `since` its newest.
 * - An event about a channel reaches only the sockets of people who may read it (chat.ts
 *   canSeeChannel): a DM's never reach a non-member, admins included.
 * - Typing is relayed to the channel's readers (not back to the typer), at most once a second and a
 *   half per person, channel and thread.
 * - Presence: who has a chat socket open, sent to everyone when it changes (debounced).
 *
 * Auth is sockets.ts's: the cookie, an Authorization header, or a one-time ticket (`POST /api/ws-ticket
 * { path: "/chat" }`).
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { ChatEvent, ChatParty, UserInfo } from "@foundation/protocol";
import { hashToken, isPerson } from "./auth.ts";
import { one } from "./db.ts";
import type { Req } from "./http.ts";
import { agentParty, canSeeChannel, getChannel, onPublish, personParty, setOnlineSource, type ChatAudience, type ChatEventBody } from "./chat.ts";

export const CHAT_SOCKET_PATH = "/chat";
const TYPING_EVERY_MS = 1500;
const PRESENCE_DEBOUNCE_MS = 400;

interface Conn {
  id: string;
  ws: WebSocket;
  user: UserInfo;
  party: ChatParty;
  rev: number;
}

const conns = new Set<Conn>();
const lastTyping = new Map<string, number>();

function send(c: Conn, body: ChatEventBody | { t: "hello"; you: string; at: number }, stamp = true) {
  if (c.ws.readyState !== c.ws.OPEN) return;
  const rev = stamp ? ++c.rev : c.rev;
  c.ws.send(JSON.stringify({ ...body, rev } as ChatEvent));
}

/** who an event is for, as a test of one person (answers kept for the one event) */
function audienceTest(audience: ChatAudience): (u: UserInfo) => boolean {
  if (audience === "all") return () => true;
  if ("users" in audience) {
    const set = new Set(audience.users);
    return (u) => set.has(u.id);
  }
  const ch = getChannel(audience.channel);
  if (!ch) return () => false;
  const memo = new Map<string, boolean>();
  return (u) => {
    if (!memo.has(u.id)) memo.set(u.id, canSeeChannel(u, ch));
    return memo.get(u.id)!;
  };
}

function deliver(event: ChatEventBody, audience: ChatAudience, except?: (c: Conn) => boolean) {
  if (!conns.size) return;
  const may = audienceTest(audience);
  for (const c of conns) if (!except?.(c) && may(c.user)) send(c, event);
}

onPublish((event, audience) => deliver(event, audience));

export function chatOnline(): string[] {
  return [...new Set([...conns].map((c) => c.user.id))].sort();
}
setOnlineSource(chatOnline);

let presenceTimer: NodeJS.Timeout | null = null;
let lastPresence = "";
function presenceChanged() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    const online = chatOnline();
    const key = online.join(",");
    if (key === lastPresence) return;
    lastPresence = key;
    deliver({ t: "presence", online }, "all");
  }, PRESENCE_DEBOUNCE_MS);
  presenceTimer.unref?.();
}

/**
 * Is the socket's opener a person (their browser or app) rather than an agent's bearer? A ticket answers
 * for the session it was issued to (read before sockets.ts spends it).
 */
export function chatSocketIsPerson(req: IncomingMessage, url: URL): boolean {
  const ticket = url.searchParams.get("ticket");
  if (ticket !== null) {
    const row = one<{ kind: string | null }>("select s.kind from ws_tickets t join sessions s on s.token = t.session_hash where t.ticket_hash = ?", hashToken(ticket));
    return Boolean(row) && row!.kind !== "agent";
  }
  return isPerson(req as Req);
}

export function attachChat(ws: WebSocket, user: UserInfo, person = true) {
  const party = person && user.id !== "agent" ? personParty(user) : agentParty(user.id === "agent" ? "Foundation Agent" : "Agent", undefined, user.id === "agent" ? undefined : user.name);
  const conn: Conn = { id: `cc_${randomBytes(5).toString("hex")}`, ws, user, party, rev: 0 };
  send(conn, { t: "hello", you: user.id, at: Date.now() }, false);
  conns.add(conn);
  send(conn, { t: "presence", online: chatOnline() });
  presenceChanged();

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t !== "typing" || typeof msg.channel !== "string") return; // ping: nothing to answer, the traffic keeps it open
    const root = typeof msg.root === "string" ? msg.root : null;
    const ch = getChannel(msg.channel);
    if (!ch || ch.archivedAt || !canSeeChannel(user, ch)) return;
    const key = `${user.id}/${ch.id}/${root ?? ""}`;
    const now = Date.now();
    if (now - (lastTyping.get(key) ?? 0) < TYPING_EVERY_MS) return;
    lastTyping.set(key, now);
    if (lastTyping.size > 5000) for (const [k, at] of lastTyping) if (now - at > 60_000) lastTyping.delete(k);
    deliver({ t: "typing", channel: ch.id, root, party: conn.party }, { channel: ch.id }, (c) => c.user.id === user.id);
  });

  ws.on("close", () => {
    conns.delete(conn);
    presenceChanged();
  });
}

/** tests: how many chat sockets are open */
export const chatSocketCount = () => conns.size;

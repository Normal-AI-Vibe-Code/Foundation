/**
 * What Today lists under Notifications, the pure part (TodayNotices.tsx draws it): the bell's list of what was said
 * to me in ChatForm, or Today's own chat items on a server that keeps no list, and the notes that tag me on a grid;
 * newest first, each with the link back to where it happened.
 */

import type { ChatChannelView, ChatParty } from "@foundation/protocol";
import { firstLine, isSeen, whereWords, whyWords, type Notice, type Seen } from "../chat/notifyLogic";
import { restOf } from "../chat/logic";
import type { FocusItem } from "./model";

export interface TodayNotice {
  id: string;
  source: "chat" | "grid";
  /** who said it (a chat row) */
  who?: ChatParty;
  /** a line of what was said */
  title: string;
  /** who, where and why, in a few words */
  why: string;
  /** the pill: the grid's name, or ChatForm */
  where: string;
  at: number;
  unseen: boolean;
  href: string;
  tone?: "agent";
  /** what a press opens */
  open: { notice: Notice } | { hash: string } | { board: string; objectId?: string };
}

/** a chat row's link: the channel, its thread for a reply, at the message */
export const noticeHref = (n: Pick<Notice, "message">) => `#/chat/chat/${restOf({ channel: n.message.channel, thread: n.message.root, at: n.message.seq })}`;

/** a grid row's link (copy, a new tab): the board with the card to frame */
export const placeHref = (board: string, objectId?: string) => `/?board=${encodeURIComponent(board)}${objectId ? `&focus=${encodeURIComponent(objectId)}` : ""}`;

export const NOTICE_ROWS = 8;

/** what Today lists under Notifications, newest first */
export function todayNotices(o: {
  /** the bell's list; absent on a server that keeps none (then Today's own chat items) */
  notices?: Notice[];
  seen: Seen;
  channels?: Record<string, Pick<ChatChannelView, "me"> | undefined>;
  focus: FocusItem[];
  limit?: number;
}): TodayNotice[] {
  const out: TodayNotice[] = [];
  if (o.notices) {
    for (const n of o.notices) {
      const where = n.channel.kind === "dm" ? "" : whereWords(n.channel);
      out.push({
        id: `chat:${n.id}`,
        source: "chat",
        who: n.message.author,
        title: firstLine(n.message) || "…",
        why: [n.message.author.name, where, whyWords(n.why)].filter(Boolean).join(" · ") || "Direct message",
        where: "ChatForm",
        at: n.message.createdAt,
        unseen: !isSeen(n, o.seen, o.channels),
        href: noticeHref(n),
        tone: n.message.author.kind === "agent" ? "agent" : undefined,
        open: { notice: n },
      });
    }
  } else {
    for (const f of o.focus) {
      if (f.kind !== "message") continue;
      out.push({ id: f.id, source: "chat", title: f.title, why: f.why, where: "ChatForm", at: f.at, unseen: true, href: f.href, tone: f.tone === "agent" ? "agent" : undefined, open: { hash: f.href } });
    }
  }
  for (const f of o.focus) {
    if (f.kind !== "mention") continue;
    out.push({
      id: f.id,
      source: "grid",
      title: f.title,
      why: f.sectionName ? `Tagged in a note in ${f.sectionName}` : f.why,
      where: f.boardName,
      at: f.at,
      unseen: false,
      href: placeHref(f.board, f.objectId),
      open: { board: f.board, objectId: f.objectId },
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, o.limit ?? NOTICE_ROWS);
}

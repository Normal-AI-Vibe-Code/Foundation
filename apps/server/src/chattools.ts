/**
 * ChatForm's tools on the one tool surface (tools.ts spreads CHAT_TOOLS into TOOLS, so the built-in
 * agent, MCP and every runtime get them): list, read, search, post and react.
 *
 * - Access is exactly the person's the agent works for (`ToolCtx.userId`): a channel they can't see
 *   answers like a missing one, so an agent can't read or post into a DM its person isn't in.
 * - The author of what a tool posts is the agent (its name is `ToolCtx.actor`, working for the person):
 *   the tools take no author, so an agent can't post as a person or as another agent's person.
 * - Posting follows chat's own member rule (chat.ts: members; anyone but a viewer account in an open
 *   channel), not the board's: these tools take no board, and are in READ_TOOLS so runTool's board gate
 *   (a viewer can't write a board) doesn't decide chat, chat.ts's rule does.
 * - Writes are idempotent by `request_id` (postMessage's own: per channel and author).
 */

import { z } from "zod";
import type { ChatChannel, ChatMessage, UserInfo } from "@foundation/protocol";
import { chatTitle } from "@foundation/protocol";
import { all, one } from "./db.ts";
import { HttpError } from "./http.ts";
import {
  agentParty,
  canSeeChannel,
  channelView,
  getChannel,
  getMessage,
  knownAgents,
  pageMessages,
  postMessage,
  react,
  searchChat,
} from "./chat.ts";
import type { BoardTool, ToolCtx } from "./tools.ts";

const SERVICE_USER: UserInfo = { id: "agent", email: "agent@foundation.local", name: "Foundation Agent", color: "#7c3aed", role: "member" };

/** the person a chat tool acts for (the service token is Foundation's own agent, with no person) */
export function chatPersonOf(ctx: Pick<ToolCtx, "userId">): UserInfo {
  if (ctx.userId === "agent") return SERVICE_USER;
  const u = one<UserInfo>("select id, email, name, color, role from users where id = ?", ctx.userId);
  if (!u) throw new HttpError(403, "ChatForm's tools work for a person; this caller isn't one");
  return u;
}

/** the agent a tool call speaks as: its name (the actor), the agent it is, and whom it works for */
export function chatAuthorOf(ctx: Pick<ToolCtx, "userId" | "actor">, user: UserInfo) {
  const name = ctx.actor || "Agent";
  const via = knownAgents().find((a) => a.name.toLowerCase() === name.toLowerCase())?.via;
  return agentParty(name, via, user.id === "agent" ? undefined : user.name);
}

const isViewer = (u: UserInfo) => u.id !== "agent" && u.role !== "admin" && u.role !== "member";

/** a channel by id, or by #name among the channels this person can see; hidden is missing */
export function chatChannelFor(user: UserInfo, ref: string): ChatChannel {
  const r = ref.trim();
  let c = r.startsWith("ch_") ? getChannel(r) : undefined;
  if (!c) {
    const name = r.replace(/^#/, "").toLowerCase();
    const row = one<{ id: string }>("select id from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null order by created_at limit 1", name);
    c = row ? getChannel(row.id) : undefined;
  }
  if (!c || !canSeeChannel(user, c)) throw new HttpError(404, `no channel “${ref}” that ${user.id === "agent" ? "Foundation's agent" : user.name} can see`);
  return c;
}

/** chat.ts's write rule, for the person behind the agent: members; anyone but a viewer account in an open channel */
export function requireChatWritable(user: UserInfo, c: ChatChannel) {
  if (c.archivedAt) throw new HttpError(409, "this channel is archived");
  const member = user.id === "agent" ? (c.members ?? []).some((m) => m.kind === "agent" && m.id === "Foundation Agent") : channelView(user, c).me !== null;
  if (member) return;
  if (c.kind === "open" && !isViewer(user)) return;
  throw new HttpError(403, isViewer(user) ? `View only: ${user.name}'s account posts only where it's a member` : "join this channel first");
}

const label = (c: ChatChannel, meId?: string) => (c.kind === "open" || c.kind === "private" ? `#${c.name}` : chatTitle(c, meId));
const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** who wrote a message, as a transcript says it */
export function chatWho(m: Pick<ChatMessage, "author">): string {
  const a = m.author;
  if (a.kind === "agent") return `${a.name} (agent${a.forName ? `, for ${a.forName}` : ""})`;
  if (a.kind === "ghost") return `${a.name} (${a.service ?? "outside"})`;
  return a.name;
}

/** messages as lines an agent reads: time, author, text, files, thread size; ids so it can reply or react */
export function chatTranscript(messages: ChatMessage[], opts: { ids?: boolean; max?: number } = {}): string {
  const max = opts.max ?? 2000;
  const lines: string[] = [];
  for (const m of messages) {
    if (m.type === "system") {
      lines.push(`[${stamp(m.createdAt)}] · ${m.text}`);
      continue;
    }
    if (m.deletedAt) {
      lines.push(`[${stamp(m.createdAt)}] ${chatWho(m)}: (removed)`);
      continue;
    }
    const text = m.text.length > max ? `${m.text.slice(0, max)}…` : m.text;
    const files = m.files.length ? ` (files: ${m.files.map((f) => f.name).join(", ")})` : "";
    const place = m.place ? ` (a link to ${m.place.label})` : "";
    const thread = m.replyCount ? ` [thread: ${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}]` : "";
    const reacts = m.reactions.length ? ` [${m.reactions.map((r) => `${r.emoji}×${r.by.length}`).join(" ")}]` : "";
    const draft = m.type === "draft" ? ` [draft, ${m.outbound?.state ?? "not sent"}]` : "";
    lines.push(`${opts.ids ? `(${m.id} #${m.seq}) ` : ""}[${stamp(m.createdAt)}] ${chatWho(m)}: ${text}${files}${place}${thread}${reacts}${draft}`);
  }
  return lines.join("\n");
}

const def = <S extends z.ZodTypeAny>(t: BoardTool<S>): BoardTool => t as unknown as BoardTool;

export const CHAT_TOOLS: BoardTool[] = [
  def({
    name: "chat_channels",
    description:
      "ChatForm (the company's chat): the channels, direct messages and agent conversations the person you work for can see, newest first, with ids, what each is for, whether they're in it and how much is unread. Takes no board.",
    schema: z.object({ query: z.string().optional().describe("only those whose name or purpose has these words"), limit: z.number().int().min(1).max(100).optional() }),
    run: (ctx, { query, limit = 40 }) => {
      const user = chatPersonOf(ctx);
      const q = query?.toLowerCase().trim();
      const ids = all<{ id: string }>("select id from chat_channels where archived_at is null order by last_post_at desc").map((r) => r.id);
      const out: string[] = [];
      for (const id of ids) {
        const c = getChannel(id);
        if (!c || c.archivedAt || !canSeeChannel(user, c)) continue;
        const name = label(c, user.id);
        if (q && !`${name} ${c.purpose} ${c.topic}`.toLowerCase().includes(q)) continue;
        const v = channelView(user, c);
        out.push(`${c.id} · ${name} (${c.kind}${c.agent ? `, with ${c.agent.name}` : ""})${v.me ? "" : " · not a member"}${v.unread ? ` · ${v.unread} unread` : ""}${c.purpose ? ` — ${c.purpose}` : ""}${c.lastText ? ` · last: ${c.lastText.slice(0, 80)}` : ""}`);
        if (out.length >= limit) break;
      }
      return out.join("\n") || "no channels";
    },
  }),
  def({
    name: "chat_read",
    description:
      "Read a ChatForm channel (by id or #name) or one thread in it (thread: the first message's id), oldest first, as a transcript with each message's (id #seq). Paged: before=<seq> reads older. Only what the person you work for can see. Takes no board.",
    schema: z.object({
      channel: z.string().describe("a channel id (ch_…) or #name"),
      thread: z.string().optional().describe("a thread's first message id, to read just that thread"),
      before: z.number().int().optional().describe("read messages older than this seq"),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: (ctx, { channel, thread, before, limit = 40 }) => {
      const user = chatPersonOf(ctx);
      const c = chatChannelFor(user, channel);
      if (thread) {
        const root = getMessage(thread);
        if (!root || root.channel !== c.id) throw new HttpError(404, "no such thread in that channel");
      }
      const page = pageMessages(c.id, { root: thread, before, limit });
      const head = `${label(c, user.id)} (${c.id})${c.purpose ? ` — ${c.purpose}` : ""}${thread ? ` · thread ${thread}` : ""}`;
      const more = page.before && page.messages[0] ? `\n(older messages: before=${page.messages[0].seq})` : "";
      return `${head}\n${chatTranscript(page.messages, { ids: true }) || "(nothing yet)"}${more}`;
    },
  }),
  def({
    name: "chat_search",
    description:
      "Search ChatForm's messages the person you work for can see. Words, \"exact phrases\", and from:name in:channel before:2026-11-01 after:… has:file|link|pin. Takes no board.",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
    run: (ctx, { query, limit = 20 }) => {
      const user = chatPersonOf(ctx);
      const hits = searchChat(user, query, limit);
      return (
        hits
          .map((h) => `(${h.message.id} in ${h.channel.kind === "open" || h.channel.kind === "private" ? `#${h.channel.name}` : h.channel.name} ${h.channel.id}${h.message.root ? `, thread ${h.message.root}` : ""}) [${stamp(h.message.createdAt)}] ${chatWho(h.message)}: ${h.snippet}`)
          .join("\n") || "no messages found"
      );
    },
  }),
  def({
    name: "chat_post",
    description:
      "Post a message in ChatForm as yourself (shown as an agent, working for the person you work for), or reply in a thread (thread: its first message's id). Markdown. Only where that person may post. Give a request_id so a retry doesn't post twice. When you were asked in a chat, your answer is posted for you: use this only to post somewhere else.",
    schema: z.object({
      channel: z.string().describe("a channel id (ch_…) or #name"),
      text: z.string().min(1).max(16000),
      thread: z.string().optional().describe("reply in this thread (its first message's id)"),
      request_id: z.string().optional(),
    }),
    run: (ctx, { channel, text, thread, request_id }) => {
      const user = chatPersonOf(ctx);
      const c = chatChannelFor(user, channel);
      requireChatWritable(user, c);
      const author = chatAuthorOf(ctx, user);
      const m = postMessage(c.id, author, { text, root: thread ?? null, requestId: request_id ? `tool:${user.id}:${request_id}` : undefined });
      return { id: m.id, channel: c.id, seq: m.seq, thread: m.root, author: chatWho(m) };
    },
  }),
  def({
    name: "chat_react",
    description: "React to a ChatForm message with an emoji (on: false takes it back), as yourself. Only where the person you work for may post. Takes no board.",
    schema: z.object({ message: z.string(), emoji: z.string().min(1).max(64), on: z.boolean().optional() }),
    run: (ctx, { message, emoji, on = true }) => {
      const user = chatPersonOf(ctx);
      const m = getMessage(message);
      if (!m) throw new HttpError(404, "no such message");
      const c = chatChannelFor(user, m.channel);
      requireChatWritable(user, c);
      const r = react(m.id, chatAuthorOf(ctx, user), emoji, on);
      return { id: r.id, reactions: r.reactions };
    },
  }),
];

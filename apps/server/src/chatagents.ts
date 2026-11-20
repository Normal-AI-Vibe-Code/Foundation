/**
 * Agents in ChatForm (docs/chatform.md §4, A1). Josh: "conversations between humans and agents,
 * potentially conversations that you are having with T3 Agent and agent sessions … agents to be able
 * to chat in this interface and clearly make themselves known."
 *
 * - **A mention is a turn.** A person's message that mentions an agent (`"agent:<Name>"` in its
 *   mentions), or any person's message in a conversation with an agent (kind `agent`, or a DM with
 *   one), starts a turn for that person. Foundation's own agents (Claude, the Shiba, crew names) run
 *   through agent.ts `startRun` with a `chat` context (the channel, its purpose, the last 30 messages
 *   of the channel or thread); one of this computer's T3 agents runs as a T3 thread. The reply is one
 *   message by the agent (`agentParty(name, via, forName = the person)`): posted when the first words
 *   arrive and updated as more do (at most every FLUSH_MS), tool steps as one line in its tail, an
 *   error or a Stop said plainly at its end. In a channel it answers in the thread of the message that
 *   asked; in a conversation with the agent, where it was asked (top level, or that thread).
 * - **Nothing starts without a person.** Only a message whose author is a person starts anything: an
 *   agent's message (agents never trigger agents), a ghost's (a bridge's inbound), a system line, and
 *   anything brought in (`origin` set, or a silent post, which no listener hears) start nothing.
 * - **One at a time.** One turn per (channel, thread, agent). A mention while one runs is queued, and
 *   later ones fold into that one follow-up: when the turn ends, one more turn starts, answering the
 *   newest message with everything said meanwhile in its transcript.
 * - **Caps.** Per person and per channel, a few at once and a few a minute (setChatAgentLimits);
 *   over a cap, the agent says so once in the thread instead of answering.
 * - **Stop.** The person who asked, or any member of the channel, stops a turn
 *   (`POST /api/chat/agents/turns/:id/stop`, by the turn's id or its reply's message id).
 * - **Memory.** Each (channel, agent) is one Foundation session (`ses_chat…`), so Claude Code's
 *   session resumes per person within it (agent.ts keys resume by board, person and session), and the
 *   transcript carries what everyone said; a T3 agent keeps one T3 thread per (channel, agent).
 *
 * T3 threads and Foundation sessions are shown as conversations read-only, mapped on read into
 * ChatMessage shapes (not copied into chat tables: T3's store is the source and is read as it is, so a
 * mirror would only lag it or double it). A person's message in a T3 conversation that Foundation's own
 * T3 holds sends the thread its next turn (t3host.ts `continueT3Thread`, `requirePerson`); a Vision
 * Code thread from another T3 says "Open in T3 to continue".
 */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { chatTitle, type AgentEvent, type ChatAgentRef, type ChatChannel, type ChatChannelView, type ChatMessage, type ChatParty, type UserInfo } from "@foundation/protocol";
import { config } from "./config.ts";
import { all, db, one, run } from "./db.ts";
import { HttpError, readJson, type Router } from "./http.ts";
import { requirePerson, requireUser } from "./auth.ts";
import {
  agentParty,
  canSeeChannel,
  channelView,
  createChannel,
  getChannel,
  getMessage,
  onChatMessage,
  pageMessages,
  personParty,
  postMessage,
  publish,
  react,
  registerChatAgents,
  requireChannel,
  updateMessage,
} from "./chat.ts";
import { chatTranscript } from "./chattools.ts";
import { followRun, sessionTurns, startRun, stopRun, titleOf } from "./agent.ts";
import { availableAgents } from "./posted.ts";
import { crewOn } from "./crew.ts";
import { listBoards } from "./boards.ts";
import { roster } from "./characters.ts";
import { COMPANY_BOARD } from "./today.ts";
import { continueT3Thread, interruptT3Thread, onT3Work, startT3Thread, t3Host, type T3Work } from "./t3host.ts";
import { t3Thread, t3Threads, type T3Item } from "./t3.ts";
import { t3Bound } from "./t3threads.ts";

db.exec(`
-- the T3 thread a (channel, agent) talks through, made by its first turn
create table if not exists chat_agent_threads (
  channel_id text not null,
  agent text not null,
  thread_id text not null,
  made_by text not null,
  at integer not null,
  primary key (channel_id, agent)
);
`);

// ---------- the agents that can be talked to ----------

export interface ChatAgentInfo {
  name: string;
  /** "claude" · "shiba" · "t3:<id>" · a crew member's own ("claude" or "t3:<id>") */
  via: string;
  kind: "claude" | "shiba" | "t3" | "crew";
  /** whose model it is, for the monogram (posted.ts providerOfT3) */
  provider: string;
  /** where the model runs */
  where: "cloud" | "this computer";
  /** what runs it: Foundation's own runtime, or this computer's T3 */
  host: "foundation" | "t3";
  /** in a sentence: what it runs on */
  service: string;
  state: "ready" | "needs sign-in" | "off";
  why?: string;
  /** the character it wears (characters.ts roster: agent name → character id), when one was chosen */
  character: string | null;
  /** the T3 agent instance, for kind t3 */
  t3?: string;
  /** can use Foundation's tools (chat and board) */
  tools: boolean;
}

function avatars(): Record<string, string> {
  try {
    return roster().avatars;
  } catch {
    return {};
  }
}

/** every agent a person can talk to here: Claude, the Shiba, each of T3's enabled agents, and crew at work now */
export function chatAgents(opts: { faces?: boolean } = {}): ChatAgentInfo[] {
  const { agents, t3 } = availableAgents();
  const faces: Record<string, string> = opts.faces === false ? {} : avatars();
  const out: ChatAgentInfo[] = [];
  const own = agents.find((a) => a.key === "claude");
  const ownState: ChatAgentInfo["state"] = own?.ready ? "ready" : "off";
  out.push({
    name: "Claude", via: "claude", kind: "claude", provider: "claude", where: "cloud", host: "foundation",
    service: own?.service ?? "not set up on this server", state: ownState, ...(own?.ready ? {} : { why: own?.why ?? "no agent runtime on this server" }),
    character: faces.Claude ?? null, tools: true,
  });
  out.push({
    name: "Shiba", via: "shiba", kind: "shiba", provider: "claude", where: "cloud", host: "foundation",
    service: "Foundation's guide from Today, on the same runtime as Claude", state: ownState, ...(own?.ready ? {} : { why: own?.why ?? "no agent runtime on this server" }),
    character: faces.Shiba ?? null, tools: true,
  });
  const host = t3Host();
  for (const a of agents) {
    if (!a.key.startsWith("t3:")) continue;
    const id = a.key.slice(3);
    const raw = host.agents.find((x) => x.id === id);
    const state: ChatAgentInfo["state"] = t3 !== "running" ? "off" : raw?.state === "ready" ? "ready" : raw?.state === "sign-in" ? "needs sign-in" : "off";
    // T3's own Claude is not Foundation's: it goes by "Claude (T3)" (@claude.t3)
    const name = out.some((x) => x.name.toLowerCase() === a.name.toLowerCase()) ? `${a.name} (T3)` : a.name;
    out.push({
      name, via: a.key, kind: "t3", provider: a.provider, where: a.where === "local" ? "this computer" : "cloud", host: "t3",
      service: `${a.service}, through T3 on this computer`, state, ...(state === "ready" ? {} : { why: t3 !== "running" ? "T3 isn't running on this computer (Settings → Agents starts it)" : a.why }),
      character: faces[name] ?? faces[a.name] ?? null, t3: id, tools: a.tools,
    });
  }
  const taken = new Set(out.map((a) => a.name.toLowerCase()));
  for (const b of safeBoards()) {
    for (const m of crewOn(b)) {
      if (taken.has(m.name.toLowerCase())) continue;
      taken.add(m.name.toLowerCase());
      const via = m.state.crew.via || "claude";
      const t3Agent = via.startsWith("t3:") ? out.find((a) => a.via === via) : undefined;
      out.push({
        name: m.name, via, kind: "crew", provider: t3Agent?.provider ?? "claude", where: t3Agent?.where ?? "cloud", host: "foundation",
        service: `at work on “${b}” for ${m.userName}; talked to here, it answers on ${t3Agent ? "Claude's runtime under its own name" : "Claude's runtime"}`,
        state: ownState, ...(own?.ready ? {} : { why: own?.why }), character: faces[m.name] ?? null, tools: true,
      });
    }
  }
  return out;
}

function safeBoards(): string[] {
  try {
    return listBoards().map((b) => b.id);
  } catch {
    return [];
  }
}

const findAgent = (name: string) => chatAgents({ faces: false }).find((a) => a.name.toLowerCase() === name.trim().toLowerCase());

// every agent that can be talked to can be @mentioned (chat.ts knownAgents → GET /api/chat agents, resolveMentions)
registerChatAgents((): ChatAgentRef[] => chatAgents({ faces: false }).map((a) => ({ name: a.name, via: a.via })));

// ---------- turns ----------

export interface ChatTurnView {
  id: string;
  channel: string;
  root: string | null;
  agent: string;
  via: string;
  by: string;
  byName: string;
  /** the message that asked */
  asked: string;
  /** the agent's reply, once it has one */
  messageId: string | null;
  status: "thinking" | "working" | "writing" | "waiting" | "done" | "stopped" | "error";
  doing?: string;
  startedAt: number;
  queued: number;
}

interface Turn extends ChatTurnView {
  key: string;
  party: ChatParty;
  user: UserInfo;
  runId?: string;
  t3Thread?: string;
  text: string;
  steps: string[];
  error?: string;
  stoppedBy?: string;
  lastFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  typing: ReturnType<typeof setInterval> | null;
  detach?: () => void;
  ended: boolean;
}

const turns = new Map<string, Turn>();
const byKey = new Map<string, Turn>();
/** the follow-up a busy (channel, thread, agent) owes: the newest message that asked, and how many asked meanwhile */
const pending = new Map<string, { message: ChatMessage; user: UserInfo; agent: ChatAgentInfo; root: string | null; count: number }>();

const limits = { personConcurrent: 2, personPerMinute: 8, channelConcurrent: 3, channelPerMinute: 12 };
/** tests (and an operator) tune the caps */
export function setChatAgentLimits(p: Partial<typeof limits>) {
  Object.assign(limits, p);
}
const starts: Array<{ at: number; by: string; channel: string }> = [];
const warned = new Map<string, number>();

const FLUSH_MS = () => Number(process.env.FOUNDATION_CHAT_FLUSH_MS ?? "300") || 300;

function capWhy(by: string, channel: string): string | null {
  const now = Date.now();
  while (starts.length && now - starts[0].at > 60_000) starts.shift();
  const live = [...turns.values()].filter((t) => !t.ended);
  if (live.filter((t) => t.by === by).length >= limits.personConcurrent) return `you have ${limits.personConcurrent} asks going already; ask again when one finishes`;
  if (starts.filter((s) => s.by === by).length >= limits.personPerMinute) return `that's ${limits.personPerMinute} asks in a minute from you; ask again in a moment`;
  if (live.filter((t) => t.channel === channel).length >= limits.channelConcurrent) return `this channel has ${limits.channelConcurrent} agent turns going; ask again when one finishes`;
  if (starts.filter((s) => s.channel === channel).length >= limits.channelPerMinute) return `this channel has had ${limits.channelPerMinute} agent turns this minute; ask again in a moment`;
  return null;
}

const sessionFor = (channel: string, agent: string) => `ses_chat${createHash("sha1").update(`${channel}|${agent.toLowerCase()}`).digest("hex").slice(0, 16)}`;
const turnKey = (channel: string, root: string | null, agent: string) => `${channel}|${root ?? ""}|${agent.toLowerCase()}`;

function userOf(id: string): UserInfo | undefined {
  return one<UserInfo>("select id, email, name, color, role from users where id = ?", id);
}

/** a person's message in a channel: which agents it asks, and where each answers */
function asks(m: ChatMessage, ch: ChatChannel): Array<{ agent: ChatAgentInfo; root: string | null }> {
  if (m.author.kind !== "person" || m.origin || m.type !== "text" || m.deletedAt || ch.archivedAt) return [];
  const names = new Set<string>();
  for (const x of m.mentions) if (x.startsWith("agent:")) names.add(x.slice(6));
  let conversation = false;
  if (ch.kind === "agent" && ch.agent && ch.origin?.service !== "t3") {
    names.add(ch.agent.name);
    conversation = true;
  }
  if (ch.kind === "dm") {
    const other = (ch.members ?? []).find((p) => p.kind === "agent");
    if (other) {
      names.add(other.name);
      conversation = true;
    }
  }
  const out: Array<{ agent: ChatAgentInfo; root: string | null }> = [];
  const seen = new Set<string>();
  for (const n of names) {
    const agent = findAgent(n);
    if (!agent || seen.has(agent.name)) continue;
    seen.add(agent.name);
    out.push({ agent, root: conversation ? m.root : (m.root ?? m.id) });
  }
  return out;
}

onChatMessage((m, ch) => {
  const wanted = asks(m, ch);
  if (!wanted.length) return;
  const user = userOf(m.author.id);
  if (!user) return;
  // after the post that called us has finished
  setImmediate(() => {
    for (const w of wanted) ask(m, ch.id, user, w.agent, w.root);
  });
});

function ask(m: ChatMessage, channel: string, user: UserInfo, agent: ChatAgentInfo, root: string | null) {
  const key = turnKey(channel, root, agent.name);
  const busy = byKey.get(key);
  if (busy && !busy.ended) {
    const p = pending.get(key);
    pending.set(key, { message: m, user, agent, root, count: (p?.count ?? 0) + 1 });
    busy.queued = (p?.count ?? 0) + 1;
    return;
  }
  begin(m, channel, user, agent, root, 0);
}

function begin(m: ChatMessage, channel: string, user: UserInfo, agent: ChatAgentInfo, root: string | null, folded: number) {
  const party = agentParty(agent.name, agent.via, user.name);
  const why = capWhy(user.id, channel);
  if (why) {
    const wkey = `${user.id}|${channel}`;
    if (Date.now() - (warned.get(wkey) ?? 0) > 60_000) {
      warned.set(wkey, Date.now());
      try {
        postMessage(channel, party, { text: `_Not now, ${user.name.split(/\s+/)[0]}: ${why}._`, root, requestId: `cap:${m.id}:${agent.name}` });
      } catch { /* the channel went */ }
    }
    return;
  }
  if (agent.state !== "ready") {
    try {
      postMessage(channel, party, { text: `_I can't answer here right now: ${agent.why ?? "I'm not set up on this server"}._`, root, requestId: `off:${m.id}:${agent.name}` });
    } catch { /* the channel went */ }
    return;
  }
  starts.push({ at: Date.now(), by: user.id, channel });
  const t: Turn = {
    id: `turn_${randomBytes(6).toString("hex")}`,
    key: turnKey(channel, root, agent.name),
    channel, root, agent: agent.name, via: agent.via, by: user.id, byName: user.name, asked: m.id,
    messageId: null, status: "thinking", startedAt: Date.now(), queued: 0,
    party, user, text: "", steps: [], lastFlush: 0, flushTimer: null, typing: null, ended: false,
  };
  turns.set(t.id, t);
  byKey.set(t.key, t);
  const typing = () => publish({ t: "typing", channel, root, party }, { channel });
  typing();
  t.typing = setInterval(typing, 1500);
  t.typing.unref?.();
  try {
    react(m.id, party, "👀", true);
  } catch { /* a removed message */ }
  if (agent.kind === "t3") void runT3(t, agent, m, folded);
  else runOwn(t, agent, m, folded);
}

// ---------- Foundation's own agents: startRun with a chat context ----------

const attr = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/"/g, "'").slice(0, 200);

function whereOf(c: ChatChannel, user: UserInfo): string {
  if (c.kind === "open" || c.kind === "private") return `#${c.name}`;
  if (c.kind === "agent") return `your conversation with ${user.name}`;
  if (c.kind === "portal") return `${chatTitle(c, user.id)} (a ${c.origin?.service ?? "bridged"} conversation)`;
  return `a direct conversation with ${chatTitle(c, user.id)}`;
}

/** the chat as the agent is told it: where, what it's for, and the last 30 messages of the thread (or channel) */
export function chatContext(c: ChatChannel, root: string | null, asked: string, user: UserInfo, agent: string): string {
  const askedMsg = getMessage(asked);
  const threadHasMore = root && (getMessage(root)?.replyCount ?? 0) > 0;
  const page = root && threadHasMore ? pageMessages(c.id, { root, limit: 30 }) : pageMessages(c.id, { limit: 30 });
  // a new thread: the channel's recent talk, with the message that asked last
  const msgs = page.messages.filter((m) => m.type !== "system");
  if (askedMsg && !msgs.some((m) => m.id === askedMsg.id)) msgs.push(askedMsg);
  const lines = chatTranscript(msgs).split("\n");
  const idx = msgs.findIndex((m) => m.id === asked);
  if (idx >= 0) lines[idx] = `${lines[idx]}   ← you were asked here`;
  return `<chat where="${attr(whereOf(c, user))}" kind="${c.kind}"${c.purpose ? ` purpose="${attr(c.purpose)}"` : ""}${c.topic ? ` topic="${attr(c.topic)}"` : ""} channel_id="${c.id}"${root ? ` thread="${root}"` : ""} person="${attr(user.name)}" you="${attr(agent)}">\n${lines.join("\n")}\n</chat>`;
}

export function chatSystem(agent: ChatAgentInfo, c: ChatChannel, user: UserInfo, threaded: boolean): string {
  const shiba = agent.kind === "shiba" ? "\nYou are the Shiba, the guide people meet on Foundation's Today page: warm, calm and direct, a companion rather than a cheerleader. Plain spoken sentences." : "";
  return `

You're speaking as ${agent.name} in ChatForm, Foundation's company chat, in ${whereOf(c, user)}. ${user.name} asked you something there. Your reply is posted for you as ${agent.name}, marked as an agent working for ${user.name}, ${threaded ? "in the thread under their message" : "in the conversation"}, and people watch it arrive. So:
- Answer briefly in markdown: a few sentences, a short list when it helps, no headings, no preamble.
- What was said is in <chat>: who said what and when, and the files they shared.
- Read more of the chat with chat_read, chat_search and chat_channels (only what ${user.name} can see). Don't use chat_post to answer: use it only when asked to post somewhere else.
- Your board tools act on the company board; when you make or change something there, say where it is.${shiba}`;
}

function runOwn(t: Turn, agent: ChatAgentInfo, asked: ChatMessage, folded: number) {
  const c = getChannel(t.channel);
  if (!c) return finish(t, "error", "the channel is gone");
  const prompt = folded ? `${asked.text}\n\n(${folded} more message${folded === 1 ? "" : "s"} asked you while you were answering; they're in <chat>.)` : asked.text;
  const r = startRun({
    boardId: COMPANY_BOARD,
    user: t.user,
    prompt,
    session: sessionFor(t.channel, agent.name),
    chat: { agent: agent.name, context: chatContext(c, t.root, asked.id, t.user, agent.name), system: chatSystem(agent, c, t.user, Boolean(t.root)) },
  });
  t.runId = r.id;
  let failed: string | undefined;
  const detach = followRun(
    r.id,
    t.user.id,
    (e: AgentEvent) => {
      if (t.ended) return;
      if (e.type === "text") {
        t.text += e.text;
        t.status = "writing";
        t.doing = undefined;
        schedule(t);
      } else if (e.type === "tool") {
        t.steps.push(e.name);
        t.status = "working";
        t.doing = stepWords(e.name);
        if (t.messageId) schedule(t);
      } else if (e.type === "status") {
        if (!t.text && (e.status === "thinking" || e.status === "working")) t.status = e.status;
      } else if (e.type === "error") failed = e.message;
    },
    () => {
      const stopped = Boolean(t.stoppedBy);
      finish(t, stopped ? "stopped" : failed ? "error" : "done", failed);
    },
  );
  t.detach = detach ?? undefined;
}

const STEP_WORDS: Record<string, string> = {
  chat_channels: "looked at your channels",
  chat_read: "read the chat",
  chat_search: "searched the chat",
  chat_post: "posted",
  chat_react: "reacted",
  read_board: "read the board",
  search: "searched Foundation",
};
const stepWords = (name: string) => STEP_WORDS[name] ?? name.replace(/_/g, " ");

function stepsLine(steps: string[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(stepWords(s), (counts.get(stepWords(s)) ?? 0) + 1);
  return [...counts].map(([w, n]) => (n > 1 ? `${w} ×${n}` : w)).join(" · ");
}

/** the reply as it stands: the words so far, then one quiet line for the steps (while working: what it's doing) */
function render(t: Turn, final: boolean): string {
  const body = t.text.trim();
  const parts: string[] = [];
  if (body) parts.push(body);
  if (!final) {
    if (t.doing) parts.push(`_⋯ ${t.doing}_`);
  } else {
    if (t.status === "stopped") parts.push(`_Stopped by ${t.stoppedBy ?? "a person"}${body ? " before I finished" : ""}._`);
    else if (t.status === "error") parts.push(body ? `_I couldn't finish: ${t.error ?? "something went wrong"}._` : `_I couldn't answer: ${t.error ?? "something went wrong"}._`);
    else if (!body) parts.push("_(I finished without anything to say.)_");
    if (t.steps.length) parts.push(`_${stepsLine(t.steps)}_`);
  }
  return parts.join("\n\n");
}

function flush(t: Turn, final = false) {
  if (t.flushTimer) clearTimeout(t.flushTimer);
  t.flushTimer = null;
  t.lastFlush = Date.now();
  const text = render(t, final);
  if (!text.trim()) return;
  try {
    if (!t.messageId) {
      const m = postMessage(t.channel, t.party, { text, root: t.root, requestId: t.id });
      t.messageId = m.id;
    } else if (getMessage(t.messageId)?.text !== text) updateMessage(t.messageId, { text });
  } catch (e) {
    console.error("chat agents: posting a reply failed", e);
  }
}

/** at most one write every FLUSH_MS while it types */
function schedule(t: Turn) {
  if (t.flushTimer) return;
  const wait = Math.max(0, FLUSH_MS() - (Date.now() - t.lastFlush));
  t.flushTimer = setTimeout(() => flush(t), wait);
  t.flushTimer.unref?.();
}

function finish(t: Turn, status: "done" | "stopped" | "error", error?: string) {
  if (t.ended) return;
  t.ended = true;
  t.status = status;
  t.doing = undefined;
  if (error && status === "error") t.error = error.split("\n")[0].slice(0, 300);
  if (t.typing) clearInterval(t.typing);
  t.typing = null;
  t.detach?.();
  flush(t, true);
  settleLastText(t);
  if (byKey.get(t.key) === t) byKey.delete(t.key);
  setTimeout(() => turns.delete(t.id), 60_000).unref?.();
  // the follow-up it owes: the newest ask, with what was said meanwhile in its transcript
  const p = pending.get(t.key);
  if (p) {
    pending.delete(t.key);
    setImmediate(() => begin(p.message, t.channel, p.user, p.agent, p.root, Math.max(0, p.count - 1)));
  }
}

/**
 * chat.ts sets a channel's list line (`lastText`) when a message is posted, not when it changes; a reply
 * posted at its first words would leave the list saying just those. At its end, a top-level reply that is
 * still the newest message puts its whole first line there.
 */
function settleLastText(t: Turn) {
  if (t.root !== null || !t.messageId) return;
  const m = getMessage(t.messageId);
  const newest = one<{ id: string }>("select id from chat_messages where channel_id = ? and root_id is null and type != 'system' order by seq desc limit 1", t.channel);
  if (!m || newest?.id !== m.id) return;
  const summary = m.text.replace(/\s+/g, " ").trim().slice(0, 140);
  if (!summary) return;
  run("update chat_channels set last_text = ? where id = ?", `${m.author.name}: ${summary}`, t.channel);
  const c = getChannel(t.channel);
  if (c) publish({ t: "channel", channel: c }, { channel: t.channel });
}

// ---------- one of this computer's T3 agents: a T3 thread per (channel, agent) ----------

const START_MS = () => Number(process.env.FOUNDATION_T3_START_MS ?? "45000") || 45_000;

async function runT3(t: Turn, agent: ChatAgentInfo, asked: ChatMessage, folded: number) {
  const c = getChannel(t.channel);
  if (!c || !agent.t3) return finish(t, "error", "the channel is gone");
  t.status = "working";
  t.doing = `asking ${agent.name} in T3 on this computer`;
  flush(t);
  const had = one<{ thread_id: string }>("select thread_id from chat_agent_threads where channel_id = ? and agent = ?", t.channel, agent.name.toLowerCase())?.thread_id;
  const live = had && t3Host().work.some((w) => w.id === had);
  const ask = `${t.user.name}${folded ? ` (and ${folded} more message${folded === 1 ? "" : "s"} meanwhile)` : ""}: ${asked.text}`;
  let worked = false;
  const off = onT3Work((id, w) => {
    if (id !== t.t3Thread || t.ended) return;
    followT3(t, w, () => (worked = true), () => worked);
  });
  const done = (status: "done" | "stopped" | "error", error?: string) => {
    off();
    finish(t, status, error);
  };
  t.detach = off;
  try {
    if (live) {
      t.t3Thread = had!;
      await continueT3Thread(had!, ask);
    } else {
      const brief = `You are ${agent.name}, answering in ChatForm, Foundation's company chat, in ${whereOf(c, t.user)}, for ${t.user.name}. Answer briefly in markdown; your last message is posted in the chat for you. You work in this folder only: say plainly what you made.\n\n${chatContext(c, t.root, asked.id, t.user, agent.name)}\n\n<ask from="${attr(t.user.name)}">\n${asked.text}\n</ask>`;
      const started = await startT3Thread({
        agent: agent.t3,
        title: titleOf(asked.text),
        text: brief,
        folder: join(config.dataDir, "t3-work", "chat", t.channel.replace(/[^a-zA-Z0-9_-]/g, "_")),
        projectTitle: `ChatForm · ${whereOf(c, t.user)}`.slice(0, 80),
      });
      t.t3Thread = started.threadId;
      run(
        "insert into chat_agent_threads (channel_id, agent, thread_id, made_by, at) values (?, ?, ?, ?, ?) on conflict(channel_id, agent) do update set thread_id = excluded.thread_id, made_by = excluded.made_by, at = excluded.at",
        t.channel, agent.name.toLowerCase(), started.threadId, t.user.id, Date.now(),
      );
    }
  } catch (e) {
    return done("error", (e as Error).message);
  }
  const now = t3Host().work.find((w) => w.id === t.t3Thread);
  if (now) followT3(t, now, () => (worked = true), () => worked);
  setTimeout(() => {
    if (!t.ended && !worked) done("error", "T3 never started on it; open it in T3 to see why");
  }, START_MS()).unref?.();
}

function followT3(t: Turn, w: T3Work | null, markWorked: () => void, worked: () => boolean) {
  if (!w) {
    t.detach?.();
    return finish(t, t.stoppedBy ? "stopped" : "error", "the thread was archived in T3");
  }
  if (w.state === "working") {
    markWorked();
    t.status = "working";
    t.doing = `working in T3 on ${w.model || "its model"}`;
    flush(t);
  } else if (w.state === "waiting") {
    markWorked();
    t.status = "waiting";
    t.doing = "waiting for a person in T3: its approvals are answered there";
    flush(t);
  } else if (w.state === "error") {
    t.detach?.();
    finish(t, "error", "T3 reported a problem with this thread; open it in T3 to see it");
  } else if (worked()) {
    // at rest after working: its answer, when T3's store can be read here
    void t3Thread(w.id)
      .then((th) => {
        const said = th?.items.filter((i) => i.kind === "assistant" && i.at >= t.startedAt - 2000).map((i) => i.text);
        t.text = said?.length ? said[said.length - 1] : "Finished in T3. Its answer is in the thread there: open it in T3 to read it.";
      })
      .catch(() => {
        t.text = "Finished in T3. Open it in T3 to read the answer.";
      })
      .finally(() => {
        t.detach?.();
        finish(t, t.stoppedBy ? "stopped" : "done");
      });
  }
}

// ---------- stop ----------

/** the person who asked, or a member of the channel, stops a turn (by its id, or its reply's or ask's message id) */
export async function stopTurn(user: UserInfo, ref: string): Promise<ChatTurnView> {
  const t = turns.get(ref) ?? [...turns.values()].find((x) => x.messageId === ref || x.asked === ref);
  if (!t) throw new HttpError(404, "no such turn");
  const c = requireChannel(user, t.channel);
  const member = channelView(user, c).me !== null;
  if (t.by !== user.id && !member) throw new HttpError(403, "only the person who asked, or someone in the channel, stops it");
  if (!t.ended) {
    t.stoppedBy = user.name;
    if (t.runId) stopRun(t.runId, t.by);
    if (t.t3Thread) {
      await interruptT3Thread(t.t3Thread).catch(() => undefined);
      t.detach?.();
      finish(t, "stopped");
    }
  }
  return view(t);
}

const view = (t: Turn): ChatTurnView => ({
  id: t.id, channel: t.channel, root: t.root, agent: t.agent, via: t.via, by: t.by, byName: t.byName, asked: t.asked,
  messageId: t.messageId, status: t.status, ...(t.doing ? { doing: t.doing } : {}), startedAt: t.startedAt, queued: t.queued,
});

/** turns going on (and just ended) in channels this person can see */
export function turnsFor(user: UserInfo, channel?: string): ChatTurnView[] {
  return [...turns.values()]
    .filter((t) => (!channel || t.channel === channel) && (!t.ended || Date.now() - t.startedAt < 60_000))
    .filter((t) => {
      const c = getChannel(t.channel);
      return Boolean(c && canSeeChannel(user, c));
    })
    .map(view);
}

/** tests: end every turn */
export function _resetChatAgents() {
  for (const t of turns.values()) {
    if (!t.ended) {
      t.stoppedBy = "the server";
      if (t.runId) stopRun(t.runId, t.by);
      t.detach?.();
      finish(t, "stopped");
    }
  }
  pending.clear();
  starts.length = 0;
  warned.clear();
}

// ---------- conversations: the person's own with an agent, sessions, T3 threads ----------

const isViewer = (u: UserInfo) => u.id !== "agent" && u.role !== "admin" && u.role !== "member";

/** the person's conversation with this agent (kind agent), made once */
export function openConversation(user: UserInfo, name: string): ChatChannel {
  const agent = findAgent(name);
  if (!agent) throw new HttpError(404, `no agent called “${name}” here`);
  const row = one<{ id: string }>(
    "select id from chat_channels where kind = 'agent' and created_by = ? and archived_at is null and origin_service is null and lower(json_extract(agent_json, '$.name')) = lower(?) and json_extract(agent_json, '$.session') is null order by created_at limit 1",
    user.id, agent.name,
  );
  if (row) return getChannel(row.id)!;
  return createChannel(personParty(user), {
    kind: "agent",
    purpose: `${user.name} and ${agent.name}: ${agent.service}`.slice(0, 250),
    agent: { name: agent.name, via: agent.via },
    members: [agentParty(agent.name, agent.via)],
  });
}

interface SessionRow {
  id: string;
  title: string;
  board: string;
  runs: number;
  status: string;
  updatedAt: number;
}

/** this person's Foundation agent sessions on every board (not chat turns, not the Shiba's), newest first */
export function sessionsFor(user: UserInfo, limit = 30): SessionRow[] {
  const rows = all<{ session_id: string; board_id: string; runs: number; updated: number }>(
    `select session_id, max(board_id) as board_id, count(*) as runs, max(created_at) as updated from agent_runs
      where created_by = ? and session_id is not null and session_id not like 'ses_shiba%' and session_id not like 'ses_chat%'
      group by session_id order by updated desc limit ?`,
    user.id, limit,
  );
  return rows.map((r) => {
    const first = one<{ prompt: string }>("select prompt from agent_runs where session_id = ? order by created_at asc limit 1", r.session_id);
    const last = one<{ status: string }>("select status from agent_runs where session_id = ? order by created_at desc limit 1", r.session_id);
    return { id: r.session_id, title: titleOf(first?.prompt ?? "A session"), board: r.board_id, runs: r.runs, status: last?.status ?? "done", updatedAt: r.updated };
  });
}

/** a message as the Agents tab shows a read-only transcript line (a T3 item, a session's turn) */
function shown(channel: string, i: number, author: ChatParty, text: string, at: number, type: ChatMessage["type"] = "text"): ChatMessage {
  return { id: `${channel}:${i}`, channel, seq: i + 1, author, type, text, root: null, createdAt: at, editedAt: null, deletedAt: null, files: [], reactions: [], replyCount: 0, lastReplyAt: null, pinned: false, mentions: [] };
}

/** a Foundation session's turns as messages: the person's ask, then the agent's words and a line for its steps */
export function sessionMessages(user: UserInfo, sessionId: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const ch = `session:${sessionId}`;
  for (const turn of sessionTurns(sessionId, user.id)) {
    out.push(shown(ch, out.length, personParty(user), turn.prompt, turn.at));
    const crew = turn.events.find((e): e is Extract<AgentEvent, { type: "crew" }> => e.type === "crew");
    const agent = agentParty(crew?.name ?? "Claude", "claude", user.name);
    const text = turn.events.filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("").trim();
    const steps = turn.events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool").map((e) => e.name);
    const err = turn.events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
    const body = [text, err ? `_${err.message.split("\n")[0]}_` : "", steps.length ? `_${stepsLine(steps)}_` : ""].filter(Boolean).join("\n\n");
    if (body) out.push(shown(ch, out.length, agent, body, turn.at + 1));
  }
  return out;
}

/** a T3 thread's items as messages: the person's turns, the agent's words, its reasoning and steps as quiet lines */
export function t3Messages(threadId: string, items: T3Item[], agentName: string, agentVia: string, personName: string): ChatMessage[] {
  const ch = `t3:${threadId}`;
  const agent = agentParty(agentName, agentVia);
  const person: ChatParty = { kind: "person", id: "t3-person", name: personName };
  const out: ChatMessage[] = [];
  for (const it of items) {
    if (it.kind === "user") out.push(shown(ch, out.length, person, it.text, it.at));
    else if (it.kind === "assistant") out.push(shown(ch, out.length, agent, it.text, it.at));
    else if (it.kind === "reasoning") out.push(shown(ch, out.length, agent, `_thinking: ${it.text.replace(/\s+/g, " ").slice(0, 600)}_`, it.at));
    else if (it.kind === "tool") out.push(shown(ch, out.length, agent, `_⚙ ${it.text}${it.ok === false ? " (failed)" : it.ok ? "" : " …"}_`, it.at));
    else out.push(shown(ch, out.length, { kind: "system", id: "system", name: "T3" }, `T3: ${it.text}`, it.at, "system"));
  }
  return out;
}

type ThreadStatus = "working" | "waiting" | "problem" | "idle";
interface ThreadRow {
  id: string;
  title: string;
  project: string;
  agent: string;
  via: string;
  status: ThreadStatus;
  updatedAt: number;
  /** foundation: this server's own T3 (a person can send it the next turn) · vision: Vision Code's own store (read here, continued there) */
  source: "foundation" | "vision";
  canContinue: boolean;
  why?: string;
  url?: string | null;
}

function hostThreadRow(w: T3Work): ThreadRow {
  const host = t3Host();
  const agent = host.agents.find((a) => a.id === w.agent);
  const status: ThreadStatus = w.state === "error" ? "problem" : w.state;
  const ready = host.state === "running" && agent?.state === "ready";
  return {
    id: w.id, title: w.title, project: w.project, agent: agent?.name ?? w.agent, via: `t3:${w.agent}`, status,
    updatedAt: Date.parse(w.updatedAt) || 0, source: "foundation", canContinue: ready,
    ...(ready ? {} : { why: host.state !== "running" ? "T3 isn't running on this computer" : `${agent?.name ?? "its agent"} isn't ready` }),
  };
}

export async function threadsList(): Promise<{ threads: ThreadRow[]; vision: { available: boolean; missing?: string } }> {
  const rows: ThreadRow[] = t3Host().work.map(hostThreadRow);
  const ids = new Set(rows.map((r) => r.id));
  const v = await t3Threads(30).catch(() => ({ available: false, threads: [], missing: "Vision Code's threads couldn't be read" }) as Awaited<ReturnType<typeof t3Threads>>);
  for (const t of v.threads) {
    if (ids.has(t.id)) continue;
    rows.push({
      id: t.id, title: t.title, project: t.project, agent: "Vision Code", via: "t3", status: t.status === "running" ? "working" : t.status === "error" ? "problem" : t.status,
      updatedAt: t.updatedAt, source: "vision", canContinue: false, why: "Open in T3 to continue: this thread is in Vision Code's own T3", url: t.url,
    });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return { threads: rows, vision: { available: v.available, ...(v.missing ? { missing: v.missing } : {}) } };
}

// ---------- routes ----------

const nameParam = (s: string) => decodeURIComponent(s).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40);

export function chatAgentRoutes(r: Router) {
  /** who can be talked to, the person's conversations, their Foundation sessions and T3's threads */
  r.get("/api/chat/agents", async (req) => {
    const user = requireUser(req);
    const agents = chatAgents();
    const conversations: ChatChannelView[] = all<{ id: string }>("select id from chat_channels where kind = 'agent' and archived_at is null order by last_post_at desc")
      .map((x) => getChannel(x.id)!)
      .filter((c) => c && canSeeChannel(user, c))
      .map((c) => channelView(user, c));
    const { threads, vision } = await threadsList();
    const host = t3Host();
    return {
      agents,
      conversations,
      sessions: user.id === "agent" ? [] : sessionsFor(user),
      threads,
      t3: { state: host.state, ...(host.detail ? { detail: host.detail } : {}), vision },
      turns: turnsFor(user),
    };
  });

  /** the person's conversation with an agent: made once per person and agent */
  r.post("/api/chat/agents/:name/open", (req) => {
    const user = requireUser(req);
    if (user.id === "agent") throw new HttpError(400, "the service token has no person to talk for");
    if (isViewer(user)) throw new HttpError(403, "View only: your account can't start conversations");
    const c = openConversation(user, nameParam(req.params.name));
    return { channel: channelView(user, c) };
  });

  r.get("/api/chat/agents/turns", (req) => {
    const user = requireUser(req);
    const channel = req.query.get("channel") || undefined;
    if (channel) requireChannel(user, channel);
    return { turns: turnsFor(user, channel) };
  });

  r.post("/api/chat/agents/turns/:id/stop", async (req) => {
    const user = requireUser(req);
    return { turn: await stopTurn(user, req.params.id) };
  });

  /** a Foundation session, read-only, as messages */
  r.get("/api/chat/agents/sessions/:id", (req) => {
    const user = requireUser(req);
    const s = sessionsFor(user, 200).find((x) => x.id === req.params.id);
    if (!s) throw new HttpError(404, "no such session");
    return { session: s, messages: sessionMessages(user, s.id) };
  });

  /** a T3 thread, read-only, as messages; `canContinue` says whether a person's message here sends it the next turn */
  r.get("/api/chat/agents/threads/:id", async (req) => {
    requireUser(req);
    const id = req.params.id;
    const w = t3Host().work.find((x) => x.id === id);
    const read = await t3Thread(id).catch(() => null);
    if (!w && !read) throw new HttpError(404, "no such T3 thread");
    const row = w ? hostThreadRow(w) : null;
    const bound = t3Bound(id);
    const personName = bound ? (userOf(bound.by)?.name ?? "A person") : "A person (in T3)";
    const agentName = row?.agent ?? "Vision Code";
    const messages = read ? t3Messages(id, read.items, agentName, row?.via ?? "t3", personName) : [];
    return {
      thread: row ?? {
        id, title: read!.thread.title, project: read!.thread.project, agent: agentName, via: "t3", status: read!.thread.status === "running" ? "working" : read!.thread.status === "error" ? "problem" : read!.thread.status,
        updatedAt: read!.thread.updatedAt, source: "vision", canContinue: false, why: "Open in T3 to continue: this thread is in Vision Code's own T3", url: read!.thread.url,
      },
      messages,
      plan: read?.plan ?? null,
      readable: Boolean(read),
      ...(read ? {} : { note: "T3 keeps this thread's words in its own store, which this server can't read: open it in T3 to read them." }),
    };
  });

  /** a person sends a T3 thread its next turn (it runs a model on someone's plan: a person's press) */
  r.post("/api/chat/agents/threads/:id/say", async (req) => {
    const user = requirePerson(req, "Sending a T3 thread its next turn");
    if (isViewer(user)) throw new HttpError(403, "View only: your account can't send work to T3");
    const body = await readJson<{ text?: unknown }>(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "say something");
    const w = t3Host().work.find((x) => x.id === req.params.id);
    if (!w) throw new HttpError(409, "Open in T3 to continue: this thread isn't in this server's T3");
    try {
      const out = await continueT3Thread(w.id, `${user.name}: ${text}`.slice(0, 16000));
      return { ok: true, threadId: out.threadId, model: out.model };
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });
}

// ---------- an agent's voice in a huddle (huddles.ts answer() looks for this) ----------

/** a reply as it's said aloud: no markdown marks, no links, one line */
export function spoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,!?])/g, "$1$2")
    .replace(/^\s*(?:#{1,6}|[-*•]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** the session a huddle is in now (its memory), else the huddle itself */
function huddleMemory(huddleId: string, agent: string): string {
  const live = one<{ id: string }>("select id from huddle_sessions where huddle_id = ? and ended_at is null order by started_at desc limit 1", huddleId)?.id;
  return `ses_huddle${createHash("sha1").update(`${live ?? huddleId}|${agent.toLowerCase()}`).digest("hex").slice(0, 16)}`;
}

/**
 * What an agent seated in a huddle says when it's addressed: a ChatForm turn (startRun with a `chat`
 * context, so no board cursor and the chat's tools), told the transcript so far and to answer in two or
 * three spoken sentences, no markdown. One memory per (huddle session, agent). Plain text comes back;
 * huddles.ts puts it in the transcript and every client speaks it.
 */
export async function huddleReply(ask: import("./huddles.ts").HuddleAgentAsk): Promise<string> {
  const ch = ask.channel ? getChannel(ask.channel) : undefined;
  const where = ch ? whereOf(ch, ask.user) : ask.board ? `a huddle on the grid ${listBoards().find((b) => b.id === ask.board)?.name ?? ask.board}` : "a huddle";
  const transcript = ask.lines.map((l) => `[${new Date(l.at).toISOString().slice(11, 19)}] ${l.speaker}${l.source === "agent" ? " (agent)" : l.source === "system" ? " (Foundation)" : ""}: ${l.text}`).join("\n");
  const context = `<huddle where="${attr(where)}" huddle_id="${ask.huddleId}"${ask.board ? ` grid="${attr(ask.board)}"` : ""} person="${attr(ask.user.name)}" you="${attr(ask.agent)}">\n${transcript}\n</huddle>`;
  const system = `

You're ${ask.agent}, an agent seated in a live video huddle (${where}) by ${ask.user.name}. Everything you write is spoken aloud to the people in the call by a voice, so:
- Answer in two or three short spoken sentences. No markdown, no lists, no headings, no links, no ids.
- What was said so far is in <huddle>, speaker by speaker. Answer the last thing said to you.
- Don't change anything on a board from here; if something should be done, say so and who might do it.`;
  const r = startRun({
    boardId: ask.board && listBoards().some((b) => b.id === ask.board) ? ask.board : COMPANY_BOARD,
    user: ask.user,
    prompt: `${ask.line.speaker} said to you: “${ask.line.text}”`,
    session: huddleMemory(ask.huddleId, ask.agent),
    chat: { agent: ask.agent, context, system, spoken: true },
  });
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let failed = "";
    const onAbort = () => stopRun(r.id, ask.user.id);
    ask.signal.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      ask.signal.removeEventListener("abort", onAbort);
      if (ask.signal.aborted) return reject(new Error("stopped"));
      const said = spoken(text);
      if (!said && failed) return reject(new Error(failed));
      resolve(said);
    };
    const detach = followRun(
      r.id,
      ask.user.id,
      (e: AgentEvent) => {
        if (e.type === "text") text += e.text;
        else if (e.type === "error") failed = e.message;
      },
      done,
    );
    if (!detach) done();
  });
}

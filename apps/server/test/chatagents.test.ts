/**
 * Agents in ChatForm (src/chatagents.ts, src/chattools.ts), through the scripted runtime
 * (FOUNDATION_AGENT_SCRIPT=1) and a stand-in T3 (t3-standin.ts), on real routes with real sessions.
 *
 * Checked: a person's mention gets a reply in its thread, by the agent, for that person, that grows
 * and then settles; agents never start agents; history brought in, a bridged message and a ghost's
 * start nothing; one turn per thread, a mention meanwhile folds into one follow-up; Stop, by the asker
 * or a member, never by an outsider; the caps; the chat tools see and post exactly where the person
 * may (a DM they're not in is missing; a viewer's agent posts only where the viewer is a member), are
 * idempotent and can't name their author; a person's conversation with an agent is made once and
 * answered at its top level; the agents list is honest with T3 off and on; a T3 agent answers through
 * one T3 thread per channel, its next mention is that thread's next turn, and only a person sends one.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChannelView, ChatMessage, ChatPage } from "@foundation/protocol";
import { writeStandin } from "./t3-standin.ts";
import type { ChatAgentInfo, ChatTurnView } from "../src/chatagents.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-chatagents-"));
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_SCRIPT_STEP_MS = "40";
process.env.FOUNDATION_CHAT_FLUSH_MS = "30";
process.env.FOUNDATION_CHAT_PREVIEWS = "0";
process.env.FOUNDATION_T3_PORT = String(24000 + Math.floor(Math.random() * 2000));
process.env.FOUNDATION_T3_READY_MS = "8000";
process.env.FOUNDATION_T3_START_MS = "4000";
// never this computer's own Vision Code store
process.env.T3CODE_HOME = join(dir, "no-vision");
const standin = writeStandin(dir);
process.env.T3_CLI = standin.cli;

const auth = await import("../src/auth.ts");
const { run } = await import("../src/db.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const agents = await import("../src/chatagents.ts");
const { runTool } = await import("../src/tools.ts");
const { closeBoards } = await import("../src/boards.ts");
const { startT3, stopT3 } = await import("../src/t3host.ts");

const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = auth.upsertUser("kai@formindustries.com", "Kai Moana");
const bob = auth.upsertUser("bob@formindustries.com", "Bob Stone");
const vic = auth.upsertUser("vic@formindustries.com", "Vic Viewer");
run("update users set role = 'viewer' where id = ?", vic.id);
vic.role = "viewer";
const cookieOf = (id: string) => `foundation_session=${auth.createSession(id)}`;
const C = { ada: cookieOf(ada.id), kai: cookieOf(kai.id), bob: cookieOf(bob.id), vic: cookieOf(vic.id) };
const adaAgent = auth.createSession(ada.id, 3600_000, "agent");

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  agents.chatAgentRoutes(r);
  server = createServer(async (rawReq, res) => {
    const req = rawReq as Parameters<Parameters<typeof r.get>[1]>[0];
    const url = new URL(req.url ?? "/", "http://local");
    req.query = url.searchParams;
    try {
      const m = r.match(req.method ?? "GET", url.pathname);
      if (!m) throw new HttpError(404, "not found");
      req.params = m.params;
      const out = await m.handler(req, res);
      if (!res.headersSent && out !== undefined) json(res, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, { error: (e as Error).message }, status);
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  agents._resetChatAgents();
  stopT3();
  server?.closeAllConnections();
  server?.close();
  closeBoards();
});

type Who = string | { bearer: string; agent?: string };
async function api<T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof who === "string") headers.cookie = who;
  else {
    headers.authorization = `Bearer ${who.bearer}`;
    if (who.agent) headers["x-foundation-agent"] = who.agent;
  }
  const res = await fetch(`http://${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* text */ }
  return { status: res.status, body: parsed as T, text };
}
const ok = async <T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown) => {
  const r = await api<T>(who, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${r.text}`);
  return r.body;
};
const say = (who: Who, channel: string, text: string, more: Record<string, unknown> = {}) =>
  ok<{ message: ChatMessage }>(who, "POST", `/api/chat/channels/${channel}/messages`, { text, ...more }).then((b) => b.message);
const thread = (channel: string, root: string) => chat.pageMessages(channel, { root, limit: 200 }).messages;
const agentReplies = (channel: string, root: string) => thread(channel, root).filter((m) => m.id !== root && m.author.kind === "agent");
const live = () => agents.turnsFor(ada).filter((t) => t.status !== "done" && t.status !== "stopped" && t.status !== "error");
const until = async (what: string, test: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) assert.fail(`waited ${ms} ms for: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const quiet = async () => {
  await until("no turns running", () => live().length === 0);
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

let general = "";

test("the agents list is honest with T3 off, and the composer can @ them", async () => {
  general = (await ok<{ channels: ChatChannelView[] }>(C.ada, "GET", "/api/chat")).channels.find((c) => c.name === "general")!.id;
  await ok(C.kai, "GET", "/api/chat"); // Kai joins #general by looking
  const out = await ok<{ agents: ChatAgentInfo[]; t3: { state: string }; threads: unknown[]; sessions: unknown[]; conversations: unknown[] }>(C.ada, "GET", "/api/chat/agents");
  const claude = out.agents.find((a) => a.name === "Claude")!;
  assert.equal(claude.state, "ready", "the scripted runtime is Claude's here");
  assert.equal(claude.host, "foundation");
  assert.ok(out.agents.find((a) => a.name === "Shiba" && a.via === "shiba"));
  assert.equal(out.agents.filter((a) => a.kind === "t3").length, 0, "no T3 agents while T3 is off");
  assert.equal(out.t3.state, "off");
  assert.deepEqual(out.threads, []);
  const listed = (await ok<{ agents: Array<{ name: string }> }>(C.ada, "GET", "/api/chat")).agents.map((a) => a.name);
  assert.ok(listed.includes("Claude") && listed.includes("Shiba"), `@ autocomplete offers them: ${listed}`);
});

test("a mention gets a reply in its thread, by the agent for the person, that grows and then settles", async () => {
  const changes = new Map<string, string[]>();
  const typing: string[] = [];
  const off = chat.onPublish((e) => {
    if (e.t === "message-changed" && e.message.author.kind === "agent") changes.set(e.message.id, [...(changes.get(e.message.id) ?? []), e.message.text]);
    if (e.t === "typing" && e.party.kind === "agent") typing.push(e.party.name);
  });
  const asked = await say(C.ada, general, "@claude what's on today?");
  assert.ok(asked.mentions.includes("agent:Claude"));
  await until("a reply", () => agentReplies(general, asked.id).length === 1);
  await quiet();
  off();
  const [reply] = agentReplies(general, asked.id);
  assert.equal(reply.root, asked.id, "in the thread of the message that asked");
  assert.equal(reply.author.name, "Claude");
  assert.equal(reply.author.via, "claude");
  assert.equal(reply.author.forName, "Ada Lovelace", "working for the person who asked");
  assert.match(reply.text, /You asked: “@claude what's on today\?”/);
  assert.match(reply.text, /looked at your channels/, "its steps in one quiet line");
  assert.doesNotMatch(reply.text, /⋯/, "nothing still working once it's done");
  const seen = changes.get(reply.id) ?? [];
  assert.ok(seen.length >= 2, `it was updated as it typed (${seen.length} changes)`);
  assert.ok(seen.some((t) => t.length < reply.text.length), "an earlier, shorter version went out first");
  assert.ok(typing.includes("Claude"), "people saw it typing");
  assert.ok(chat.getMessage(asked.id)!.reactions.some((r) => r.emoji === "👀" && r.by.includes("Claude")), "it said it saw the ask");
  // its own reply quotes "@claude": an agent's message starts nothing, so there's exactly one reply
  await settle();
  assert.equal(agentReplies(general, asked.id).length, 1);
});

test("agents never start agents; history, bridged messages and ghosts start nothing", async () => {
  const byAgent = await say({ bearer: adaAgent, agent: "Helper" }, general, "@claude are you there?");
  assert.equal(byAgent.author.kind, "agent");
  const old = chat.postMessage(general, chat.personParty(ada), { text: "@claude from Slack, long ago", origin: { service: "slack", externalId: "1700000000.000100" } }, { silent: true });
  const bridged = chat.postMessage(general, chat.personParty(ada), { text: "@claude bridged in", origin: { service: "whatsapp", externalId: "wamid.1" } });
  const gus = chat.ghostParty("whatsapp", "+15550001", "Gus");
  const ghost = chat.postMessage(general, gus, { text: "@claude hello from WhatsApp" });
  assert.ok(ghost.mentions.includes("agent:Claude"));
  await settle(400);
  assert.equal(live().length, 0);
  for (const m of [byAgent, old, bridged, ghost]) assert.equal(agentReplies(general, m.id).length, 0, `nothing answered “${m.text}”`);
});

test("one turn per thread: mentions meanwhile fold into one follow-up", async () => {
  const asked = await say(C.ada, general, "@claude slowly, tell me everything");
  await until("it starts", () => live().length === 1);
  await say(C.ada, general, "@claude and the parts list", { root: asked.id });
  await say(C.kai, general, "@claude and the suppliers too", { root: asked.id });
  assert.equal(live().length, 1, "still one turn");
  assert.equal(agents.turnsFor(ada, general).find((t) => t.asked === asked.id)?.queued, 2);
  await until("the follow-up", () => agentReplies(general, asked.id).length === 2, 15000);
  await quiet();
  const replies = agentReplies(general, asked.id);
  assert.equal(replies.length, 2, "one follow-up for both");
  assert.match(replies[1].text, /the suppliers too/, "answering the newest");
  assert.equal(replies[1].author.forName, "Kai Moana", "for the person whose ask it answers");
});

test("Stop: the asker or a member stops a turn, an outsider can't", async () => {
  const asked = await say(C.ada, general, "@claude slowly walk me through it");
  await until("a reply to stop", () => agentReplies(general, asked.id).length === 1);
  const reply = agentReplies(general, asked.id)[0];
  const outsider = await api(C.bob, "POST", `/api/chat/agents/turns/${reply.id}/stop`);
  assert.equal(outsider.status, 403, "Bob isn't in #general");
  const { turn } = await ok<{ turn: ChatTurnView }>(C.kai, "POST", `/api/chat/agents/turns/${reply.id}/stop`);
  assert.equal(turn.agent, "Claude");
  await quiet();
  const final = chat.getMessage(reply.id)!;
  assert.match(final.text, /Stopped by Kai Moana before I finished/);
  assert.equal(agents.turnsFor(ada, general).find((t) => t.messageId === reply.id)?.status, "stopped");
});

test("an error is said plainly", async () => {
  const asked = await say(C.ada, general, "@claude please fail now");
  await until("the reply", () => agentReplies(general, asked.id).length === 1);
  await quiet();
  assert.match(agentReplies(general, asked.id)[0].text, /I couldn't finish: the scripted runtime was asked to fail/);
});

test("caps: one person can't run more than their share; the agent says so once", async () => {
  agents._resetChatAgents();
  agents.setChatAgentLimits({ personConcurrent: 1 });
  try {
    const first = await say(C.ada, general, "@claude slowly, the first");
    await until("the first starts", () => live().length === 1);
    const second = await say(C.ada, general, "@claude the second");
    await until("a refusal", () => agentReplies(general, second.id).length === 1);
    assert.match(agentReplies(general, second.id)[0].text, /Not now, Ada: you have 1 asks going already/);
    await agents.stopTurn(ada, first.id);
    await quiet();
  } finally {
    agents.setChatAgentLimits({ personConcurrent: 2 });
    agents._resetChatAgents();
  }
});

test("the chat tools see and post exactly where the person may", async () => {
  const dm = (await ok<{ channel: ChatChannelView }>(C.kai, "POST", "/api/chat/channels", { kind: "dm", members: [bob.id] })).channel;
  await say(C.kai, dm.id, "the secret launch date is friday");
  const asAda = { boardId: "company", actor: "Claude", userId: ada.id };
  await assert.rejects(runTool(asAda, "chat_read", { channel: dm.id }), /no channel/);
  await assert.rejects(runTool(asAda, "chat_post", { channel: dm.id, text: "hi" }), /no channel/);
  assert.doesNotMatch(String(await runTool(asAda, "chat_channels", {})), new RegExp(dm.id));
  assert.equal(await runTool(asAda, "chat_search", { query: "secret launch" }), "no messages found");
  const asKai = { boardId: "company", actor: "Claude", userId: kai.id };
  assert.match(String(await runTool(asKai, "chat_read", { channel: dm.id })), /the secret launch date is friday/);
  assert.match(String(await runTool(asKai, "chat_search", { query: "secret launch" })), /Kai Moana: the «?secret»? «?launch»? date/);
  assert.match(String(await runTool(asAda, "chat_read", { channel: "#general" })), /\(m_[0-9a-f]+ #\d+\) .*Ada Lovelace: @claude what's on today\?/);

  // a viewer's agent: reads and posts where the viewer is a member, not in an open channel they aren't in
  const room = (await ok<{ channel: ChatChannelView }>(C.kai, "POST", "/api/chat/channels", { kind: "private", name: "launch-room", members: [vic.id] })).channel;
  const asVic = { boardId: "company", actor: "Claude", userId: vic.id };
  assert.match(String(await runTool(asVic, "chat_read", { channel: "#launch-room" })), /launch-room/);
  const posted = (await runTool(asVic, "chat_post", { channel: room.id, text: "Vic's agent checking in" })) as { id: string };
  assert.equal(chat.getMessage(posted.id)!.author.forName, "Vic Viewer");
  await assert.rejects(runTool(asVic, "chat_read", { channel: general }), /no channel/);
  await assert.rejects(runTool(asVic, "chat_post", { channel: general, text: "hi" }), /no channel/);
});

test("chat_post is idempotent and can't name its author", async () => {
  const ctx = { boardId: "company", actor: "Wren", userId: ada.id };
  const a = (await runTool(ctx, "chat_post", { channel: general, text: "posted once", request_id: "r-1" })) as { id: string };
  const b = (await runTool({ ...ctx }, "chat_post", { channel: general, text: "posted once", request_id: "r-1" })) as { id: string };
  assert.equal(a.id, b.id);
  // a separate server's memory: postMessage's own request id still holds
  const c = (await runTool({ ...ctx, boardId: "other" }, "chat_post", { channel: general, text: "posted once", request_id: "r-1" })) as { id: string };
  assert.equal(c.id, a.id);
  const forged = (await runTool(ctx, "chat_post", { channel: general, text: "who am I", author: { kind: "person", id: kai.id, name: "Kai Moana" }, as: "Kai Moana" })) as { id: string };
  const m = chat.getMessage(forged.id)!;
  assert.equal(m.author.kind, "agent");
  assert.equal(m.author.name, "Wren");
  assert.equal(m.author.forName, "Ada Lovelace");
  const reacted = (await runTool(ctx, "chat_react", { message: forged.id, emoji: "✅" })) as { reactions: Array<{ emoji: string; by: string[] }> };
  assert.deepEqual(reacted.reactions, [{ emoji: "✅", by: ["Wren"] }]);
});

test("a person's conversation with an agent is made once and answered at its top level", async () => {
  const one = await ok<{ channel: ChatChannelView }>(C.ada, "POST", "/api/chat/agents/Claude/open");
  const again = await ok<{ channel: ChatChannelView }>(C.ada, "POST", "/api/chat/agents/claude/open");
  assert.equal(one.channel.id, again.channel.id);
  assert.equal(one.channel.kind, "agent");
  assert.equal(one.channel.agent?.name, "Claude");
  assert.ok(one.channel.members?.some((p) => p.kind === "agent" && p.name === "Claude"));
  const kais = await ok<{ channel: ChatChannelView }>(C.kai, "POST", "/api/chat/agents/Claude/open");
  assert.notEqual(kais.channel.id, one.channel.id, "Kai's is his own");
  assert.equal((await api(C.vic, "POST", "/api/chat/agents/Claude/open")).status, 403);
  assert.equal((await api(C.ada, "POST", "/api/chat/agents/Nobody/open")).status, 404);
  const hi = await say(C.ada, one.channel.id, "hello, no mention needed");
  await until("an answer", () => chat.pageMessages(one.channel.id, {}).messages.some((m) => m.author.kind === "agent" && m.root === null && m.seq > hi.seq));
  await quiet();
  assert.match(chat.getChannel(one.channel.id)!.lastText ?? "", /^Claude: \*\*Claude\*\* here\. You asked: “hello, no mention needed”/, "the list line is the whole reply, not its first words");
  const listed = await ok<{ conversations: ChatChannelView[] }>(C.ada, "GET", "/api/chat/agents");
  assert.ok(listed.conversations.some((c) => c.id === one.channel.id));
  assert.ok(!listed.conversations.some((c) => c.id === kais.channel.id), "not Kai's");
  // the session of (channel, agent) carries the conversation
  const page = await ok<ChatPage>(C.ada, "GET", `/api/chat/channels/${one.channel.id}/messages`);
  assert.ok(page.messages.some((m) => m.author.kind === "agent" && /hello, no mention needed/.test(m.text)));
});

test("T3: its agents are listed honestly, answer through one thread per channel, and only a person sends a turn", async () => {
  assert.equal((await startT3("Ada")).state, "running");
  await until("T3's agents", () => agents.chatAgents().some((a) => a.kind === "t3"), 8000);
  const list = await ok<{ agents: ChatAgentInfo[]; t3: { state: string } }>(C.ada, "GET", "/api/chat/agents");
  assert.equal(list.t3.state, "running");
  const t3claude = list.agents.find((a) => a.via === "t3:claudeAgent")!;
  assert.equal(t3claude.name, "Claude (T3)", "not confused with Foundation's own Claude");
  assert.equal(t3claude.state, "ready");
  assert.equal(t3claude.host, "t3");
  const codex = list.agents.find((a) => a.via === "t3:codex");
  if (codex) assert.notEqual(codex.state, "ready", "an agent that isn't installed isn't ready");

  const dispatched = () => (existsSync(standin.file("dispatch.json")) ? (JSON.parse(readFileSync(standin.file("dispatch.json"), "utf8")) as Array<Record<string, any>>) : []);
  const tell = (c: object) => writeFileSync(standin.control, JSON.stringify({ ...c, n: Math.random() }));
  const asked = await say(C.ada, general, "@claude.t3 list the parts");
  assert.ok(asked.mentions.includes("agent:Claude (T3)"));
  await until("a thread started", () => dispatched().some((c) => c.type === "thread.turn.start"));
  const start = dispatched().find((c) => c.type === "thread.turn.start")!;
  assert.ok(start.bootstrap?.createThread, "the first turn makes the thread");
  assert.match(start.message.text, /answering in ChatForm/);
  assert.match(start.message.text, /list the parts/);
  await until("a working line", () => agentReplies(general, asked.id).some((m) => /T3/.test(m.text)));
  tell({ do: "finish", id: start.threadId });
  await quiet();
  const reply = agentReplies(general, asked.id)[0];
  assert.equal(reply.author.name, "Claude (T3)");
  assert.equal(reply.author.via, "t3:claudeAgent");
  assert.match(reply.text, /Finished in T3/, "it says honestly where the answer is when T3's store can't be read here");

  // the next mention in this channel is the same thread's next turn
  const next = await say(C.ada, general, "@claude.t3 and the suppliers");
  await until("a follow-up turn", () => dispatched().filter((c) => c.type === "thread.turn.start").length === 2);
  const follow = dispatched().filter((c) => c.type === "thread.turn.start")[1];
  assert.equal(follow.threadId, start.threadId);
  assert.equal(follow.bootstrap, undefined, "no new thread");
  tell({ do: "finish", id: start.threadId });
  await quiet();
  assert.equal(agentReplies(general, next.id).length, 1);

  // the thread as a conversation, and a person's message as its next turn (an agent's bearer can't)
  const threads = await ok<{ threads: Array<{ id: string; source: string; canContinue: boolean; status: string }> }>(C.ada, "GET", "/api/chat/agents");
  const row = threads.threads.find((t) => t.id === start.threadId)!;
  assert.equal(row.source, "foundation");
  assert.equal(row.canContinue, true);
  const shown = await ok<{ thread: { id: string }; messages: ChatMessage[]; readable: boolean; note?: string }>(C.ada, "GET", `/api/chat/agents/threads/${start.threadId}`);
  assert.equal(shown.readable, false);
  assert.match(shown.note ?? "", /open it in T3/);
  assert.equal((await api({ bearer: adaAgent }, "POST", `/api/chat/agents/threads/${start.threadId}/say`, { text: "go on" })).status, 403);
  await ok(C.ada, "POST", `/api/chat/agents/threads/${start.threadId}/say`, { text: "go on" });
  const third = dispatched().filter((c) => c.type === "thread.turn.start")[2];
  assert.equal(third.threadId, start.threadId);
  assert.match(third.message.text, /^Ada Lovelace: go on/);
  assert.equal((await api(C.ada, "POST", "/api/chat/agents/threads/nope/say", { text: "x" })).status, 409);
  tell({ do: "finish", id: start.threadId });
});

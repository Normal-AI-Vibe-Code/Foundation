/**
 * ChatForm's core server (docs/chatform.md §2): the store, who may do what, the hub and its socket,
 * search, unread, export, link previews (and their SSRF guard) and chat uploads. The routes run on a
 * real port through chatRoutes and the server's own upgrade handler, with real sessions: a person's
 * cookie, an agent's bearer, the service token, an app's ticket.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { ChatChannelView, ChatEvent, ChatMessage, ChatPage } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-chat-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);
delete process.env.FOUNDATION_CHAT_PREVIEWS;
delete process.env.FOUNDATION_CHAT_PREVIEWS_LOOPBACK;

const { one, run } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const { handleUpgrade, issueTicket } = await import("../src/sockets.ts");
const { storeFile, listFiles } = await import("../src/files.ts");
const { searchLocal } = await import("../src/search.ts");
const { focusFor } = await import("../src/today.ts");
const { closeBoards } = await import("../src/boards.ts");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const bob = auth.upsertUser("bob@formindustries.com", "Bob Stone");
const cy = auth.upsertUser("cy@formindustries.com", "Cy Twombly");
const vic = auth.upsertUser("vic@formindustries.com", "Vic Viewer");
run("update users set role = 'viewer' where id = ?", vic.id);
vic.role = "viewer";

const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), bob: cookieOf(bob.id), cy: cookieOf(cy.id), vic: cookieOf(vic.id) };
const adaAgent = auth.createSession(ada.id, 3600_000, "agent");
const bossAgent = auth.createSession(boss.id, 3600_000, "agent");
const SERVICE = process.env.FOUNDATION_SERVICE_TOKEN!;

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  const wss = new WebSocketServer({ noServer: true });
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
  server.on("upgrade", (req, socket, head) => handleUpgrade(wss, req, socket, head));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
const sockets: WebSocket[] = [];
after(() => {
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.terminate();
  server?.closeAllConnections();
  server?.close();
  closeBoards();
});

type Who = string | { bearer: string; agent?: string };
async function api<T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers; text: string }> {
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
  } catch {
    /* a download */
  }
  return { status: res.status, body: parsed as T, headers: res.headers, text };
}
const ok = async <T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown) => {
  const r = await api<T>(who, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${r.text}`);
  return r.body;
};
const post = (who: Who, channel: string, text: string, more: Record<string, unknown> = {}) =>
  ok<{ message: ChatMessage }>(who, "POST", `/api/chat/channels/${channel}/messages`, { text, ...more }).then((b) => b.message);
const mkChannel = (who: Who, body: Record<string, unknown>) => ok<{ channel: ChatChannelView }>(who, "POST", "/api/chat/channels", body).then((b) => b.channel);

/** a /chat socket that keeps what it hears */
async function listen(headers: Record<string, string>, query = "") {
  const ws = new WebSocket(`ws://${base}/chat${query}`, { headers });
  sockets.push(ws);
  ws.on("error", () => undefined);
  const events: ChatEvent[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (raw) => {
    events.push(JSON.parse(String(raw)));
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("unexpected-response", (_q, res) => fail(new Error(`refused ${res.statusCode}`)));
  });
  const next = async (pred: (e: ChatEvent) => boolean, ms = 2000): Promise<ChatEvent> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no such event; heard ${events.map((e) => e.t).join(",")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { ws, events, next, close: () => ws.close() };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- channels and who sees them ----------

let general = "";

test("GET /api/chat makes #general, puts a person in it once, and lists people and agents", async () => {
  const b = await ok<{ channels: ChatChannelView[]; people: Array<{ id: string; kind: string }>; agents: unknown[]; online: string[] }>(C.ada, "GET", "/api/chat");
  const g = b.channels.find((c) => c.name === "general");
  assert.ok(g, "#general exists");
  general = g.id;
  assert.equal(g.kind, "open");
  assert.ok(g.me, "Ada is in it");
  assert.equal(g.members, undefined, "an open channel sends a count, not its members");
  assert.ok(b.people.some((p) => p.id === bob.id && p.kind === "person"));
  assert.ok(Array.isArray(b.agents) && Array.isArray(b.online));
  // leaving sticks: the next visit doesn't put her back
  await ok(C.ada, "POST", `/api/chat/channels/${general}/leave`);
  const again = await ok<{ channels: ChatChannelView[] }>(C.ada, "GET", "/api/chat");
  assert.equal(again.channels.find((c) => c.id === general)?.me, null, "she can still read it, not a member");
  await ok(C.ada, "POST", `/api/chat/channels/${general}/join`);
  for (const c of [C.bob, C.cy, C.boss, C.vic]) await ok(c, "GET", "/api/chat");
  assert.ok(!chat.getChannel(general)!.memberCount || !one("select 1 from chat_members where channel_id = ? and party_id = ?", general, vic.id), "a viewer isn't put into #general");
});

test("a viewer can't make a channel, can't read an open one it isn't in, and posts where it's a member", async () => {
  assert.equal((await api(C.vic, "POST", "/api/chat/channels", { kind: "open", name: "vics" })).status, 403);
  assert.equal((await api(C.vic, "GET", `/api/chat/channels/${general}`)).status, 404, "an open channel is hidden from a viewer who isn't in it");
  assert.equal((await api(C.vic, "POST", `/api/chat/channels/${general}/join`)).status, 404);
  const priv = await mkChannel(C.ada, { kind: "private", name: "Design Review", members: [vic.id] });
  assert.equal(priv.name, "design-review");
  const m = await post(C.vic, priv.id, "a viewer, here by invitation");
  assert.equal(m.author.id, vic.id);
  const list = await ok<{ channels: ChatChannelView[] }>(C.vic, "GET", "/api/chat");
  assert.deepEqual(list.channels.map((c) => c.id), [priv.id], "the viewer sees only where it's a member");
  // and their upload to chat is theirs to attach
  const f = await storeFile(Buffer.from("viewer notes"), { name: "notes.txt", mime: "text/plain", boardId: "chat", userId: vic.id });
  assert.equal((await post(C.vic, priv.id, "", { files: [f.id] })).files[0].id, f.id);
});

test("private channels, DMs and groups are their members' only: not a third person's, not an admin's", async () => {
  const priv = await mkChannel(C.ada, { kind: "private", name: "secret-plans", members: [bob.id] });
  const dm = await mkChannel(C.ada, { kind: "dm", members: [bob.id] });
  assert.equal(dm.kind, "dm");
  assert.equal(dm.members?.length, 2);
  await post(C.ada, dm.id, "just between us");
  for (const who of [C.cy, C.boss]) {
    assert.equal((await api(who, "GET", `/api/chat/channels/${priv.id}`)).status, 404);
    assert.equal((await api(who, "GET", `/api/chat/channels/${dm.id}/messages`)).status, 404);
    assert.equal((await api(who, "POST", `/api/chat/channels/${dm.id}/messages`, { text: "hi" })).status, 404);
    assert.equal((await api(who, "GET", `/api/chat/channels/${dm.id}/export`)).status, 404);
    const list = await ok<{ channels: ChatChannelView[] }>(who, "GET", "/api/chat");
    assert.ok(!list.channels.some((c) => c.id === dm.id || c.id === priv.id));
  }
  // the admin can't remove a message in a DM it can't read either
  const m = (await ok<ChatPage>(C.bob, "GET", `/api/chat/channels/${dm.id}/messages`)).messages[0];
  assert.equal((await api(C.boss, "DELETE", `/api/chat/messages/${m.id}`, { confirm: true })).status, 404);
  // a DM is made once, from either side
  const fromBob = await mkChannel(C.bob, { kind: "dm", members: [ada.id] });
  assert.equal(fromBob.id, dm.id);
  assert.equal(chat.openDirect([chat.personParty(bob), chat.personParty(ada)]).id, dm.id);
  const group = await mkChannel(C.ada, { kind: "group", members: [bob.id, cy.id] });
  assert.equal(group.kind, "group");
  assert.equal((await mkChannel(C.cy, { kind: "group", members: [ada.id, bob.id] })).id, group.id);
  assert.equal((await api(C.ada, "POST", `/api/chat/channels/${dm.id}/leave`)).status, 400, "a DM can't be left");
  assert.equal((await api(C.ada, "POST", "/api/chat/channels", { kind: "open", name: "secret-plans" })).status, 409, "names are unique");
});

// ---------- who speaks ----------

test("a person posts as themselves; a request can't forge its author or turn an agent into a person", async () => {
  const m = await post(C.ada, general, "hello", { author: { kind: "person", id: bob.id, name: "Bob" }, as: "Bob Stone" });
  assert.deepEqual([m.author.kind, m.author.id, m.author.name], ["person", ada.id, ada.name]);
  const a = await post({ bearer: adaAgent, agent: "Wren" }, general, "I'm the agent", { author: { kind: "person", id: ada.id } });
  assert.equal(a.author.kind, "agent");
  assert.equal(a.author.name, "Wren");
  assert.equal(a.author.forName, ada.name, "says whom it works for");
  const b = await post({ bearer: adaAgent }, general, "named in the body", { as: "Ada Lovelace" });
  assert.equal(b.author.kind, "agent", "even named like a person, it's an agent");
  const s = await post({ bearer: SERVICE }, general, "from the service");
  assert.equal(s.author.kind, "agent");
  assert.equal(s.author.name, "Foundation Agent");
});

test("an agent posts where its person can, never edits or removes a person's message; edits are the author's; removal needs confirm", async () => {
  const dm = await mkChannel(C.bob, { kind: "dm", members: [cy.id] });
  assert.equal((await api({ bearer: adaAgent }, "POST", `/api/chat/channels/${dm.id}/messages`, { text: "sneaking in" })).status, 404, "not where its person can't read");
  const mine = await post(C.ada, general, "Ada's words");
  assert.equal((await api({ bearer: adaAgent }, "POST", `/api/chat/messages/${mine.id}`, { text: "rewritten" })).status, 403);
  assert.equal((await api({ bearer: adaAgent }, "DELETE", `/api/chat/messages/${mine.id}`, { confirm: true })).status, 403);
  assert.equal((await api({ bearer: bossAgent }, "DELETE", `/api/chat/messages/${mine.id}`, { confirm: true })).status, 403, "an admin's agent isn't the admin");
  assert.equal((await api(C.bob, "POST", `/api/chat/messages/${mine.id}`, { text: "Bob's now" })).status, 403);
  const edited = await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/messages/${mine.id}`, { text: "Ada's better words" });
  assert.equal(edited.message.text, "Ada's better words");
  assert.ok(edited.message.editedAt);
  assert.equal((await api(C.ada, "DELETE", `/api/chat/messages/${mine.id}`, {})).status, 400, "no confirm, no removal");
  // its own message, the agent edits and removes
  const its = await post({ bearer: adaAgent, agent: "Wren" }, general, "draft");
  assert.equal((await ok<{ message: ChatMessage }>({ bearer: adaAgent, agent: "Wren" }, "POST", `/api/chat/messages/${its.id}`, { text: "final" })).message.text, "final");
  assert.equal((await api({ bearer: adaAgent, agent: "Kestrel" }, "POST", `/api/chat/messages/${its.id}`, { text: "another agent" })).status, 403);
  // an admin (a person) removes anyone's in a channel they can read; the row stays, its text and files go
  const f = await storeFile(Buffer.from("to be removed"), { name: "gone.txt", mime: "text/plain", boardId: "chat", userId: ada.id });
  const withFile = await post(C.ada, general, "with a file", { files: [f.id] });
  const removed = await ok<{ message: ChatMessage }>(C.boss, "DELETE", `/api/chat/messages/${withFile.id}`, { confirm: true });
  assert.ok(removed.message.deletedAt);
  assert.equal(removed.message.text, "");
  assert.deepEqual(removed.message.files, []);
  assert.ok(one("select 1 from chat_messages where id = ?", withFile.id), "the row stays");
  assert.equal(one<{ archived_at: number | null }>("select archived_at from files where id = ?", f.id)?.archived_at, null, "the file is kept");
  assert.ok(one("select 1 from files where id = ?", f.id), "never deleted");
  assert.equal((await api(C.ada, "POST", `/api/chat/messages/${withFile.id}`, { text: "back" })).status, 409);
});

test("a retry with the same request_id returns the first message (and the first channel)", async () => {
  const a = await post(C.ada, general, "once", { request_id: "req-1" });
  const b = await post(C.ada, general, "once", { request_id: "req-1" });
  assert.equal(a.id, b.id);
  assert.equal(one<{ n: number }>("select count(*) n from chat_messages where request_id = 'req-1'")?.n, 1);
  const c1 = await mkChannel(C.ada, { kind: "open", name: "retry-me", request_id: "ch-1" });
  const c2 = await mkChannel(C.ada, { kind: "open", name: "retry-me", request_id: "ch-1" });
  assert.equal(c1.id, c2.id);
});

// ---------- threads, reactions, pins ----------

test("threads: replies stay out of the channel page, the root counts them", async () => {
  const ch = await mkChannel(C.ada, { kind: "open", name: "threads" });
  const root = await post(C.ada, ch.id, "a question");
  const r1 = await post(C.bob, ch.id, "an answer", { root: root.id });
  await post(C.cy, ch.id, "another", { root: r1.id }); // a reply to a reply joins the root's thread
  const page = await ok<ChatPage>(C.ada, "GET", `/api/chat/channels/${ch.id}/messages`);
  assert.ok(!page.messages.some((m) => m.root), "no replies in the channel's own page");
  const r = page.messages.find((m) => m.id === root.id)!;
  assert.equal(r.replyCount, 2);
  assert.deepEqual(r.repliers, [cy.name, bob.name]);
  assert.ok(r.lastReplyAt);
  const thread = await ok<ChatPage>(C.ada, "GET", `/api/chat/channels/${ch.id}/messages?root=${root.id}`);
  assert.deepEqual(thread.messages.map((m) => m.text), ["a question", "an answer", "another"]);
  await ok(C.bob, "DELETE", `/api/chat/messages/${r1.id}`, { confirm: true });
  assert.equal(chat.getMessage(root.id)!.replyCount, 1, "a removed reply leaves the count");
  const threads = await ok<{ threads: Array<{ root: ChatMessage }> }>(C.cy, "GET", "/api/chat/threads");
  assert.ok(threads.threads.some((t) => t.root.id === root.id));
  assert.equal((await api(C.ada, "POST", `/api/chat/channels/${general}/messages`, { text: "x", root: root.id })).status, 400, "a thread is in its own channel");
});

test("reactions and pins", async () => {
  const m = await post(C.ada, general, "react to me");
  await ok(C.bob, "POST", `/api/chat/messages/${m.id}/react`, { emoji: "👍", on: true });
  await ok(C.cy, "POST", `/api/chat/messages/${m.id}/react`, { emoji: "👍", on: true });
  const r = await ok<{ message: ChatMessage }>({ bearer: adaAgent, agent: "Wren" }, "POST", `/api/chat/messages/${m.id}/react`, { emoji: "🎉" });
  assert.deepEqual(r.message.reactions, [{ emoji: "👍", by: [bob.name, cy.name] }, { emoji: "🎉", by: ["Wren"] }]);
  const off = await ok<{ message: ChatMessage }>(C.bob, "POST", `/api/chat/messages/${m.id}/react`, { emoji: "👍", on: false });
  assert.deepEqual(off.message.reactions[0], { emoji: "👍", by: [cy.name] });
  const seqBefore = chat.getChannel(general)!.lastSeq;
  const p = await ok<{ message: ChatMessage }>(C.bob, "POST", `/api/chat/messages/${m.id}/pin`, { on: true });
  assert.equal(p.message.pinned, true);
  const ch = chat.getChannel(general)!;
  assert.ok(ch.pinned?.includes(m.id));
  const sys = chat.pageMessages(general, { after: seqBefore }).messages.find((x) => x.type === "system");
  assert.match(sys?.text ?? "", /Bob Stone pinned a message/);
  await ok(C.bob, "POST", `/api/chat/messages/${m.id}/pin`, { on: false });
  assert.ok(!chat.getChannel(general)!.pinned?.includes(m.id));
});

// ---------- unread and mentions ----------

test("unread, mentions (@handle, @channel, a DM), and mark unread from here", async () => {
  const ch = await mkChannel(C.ada, { kind: "private", name: "unread-test", members: [bob.id, cy.id] });
  const view = (who: string) => ok<{ channel: ChatChannelView }>(who, "GET", `/api/chat/channels/${ch.id}`).then((b) => b.channel);
  await ok(C.bob, "POST", `/api/chat/channels/${ch.id}/read`, {});
  await post(C.ada, ch.id, "hello all");
  const m2 = await post(C.ada, ch.id, "@bob.stone look at this");
  assert.deepEqual(m2.mentions, [bob.id]);
  await post(C.ada, ch.id, "and @channel too");
  let bv = await view(C.bob);
  assert.equal(bv.unread, 3);
  assert.equal(bv.me?.mentions, 2);
  const av = await view(C.ada);
  assert.equal(av.unread, 0, "your own messages are read");
  const u = await ok<{ total: number; mentions: number; channels: Array<{ id: string }> }>(C.bob, "GET", "/api/chat/unreads");
  assert.ok(u.channels.some((c) => c.id === ch.id) && u.mentions >= 2);
  await ok(C.bob, "POST", `/api/chat/channels/${ch.id}/read`, { seq: bv.lastSeq });
  bv = await view(C.bob);
  assert.deepEqual([bv.unread, bv.me?.mentions], [0, 0]);
  // mark unread from the @bob message: two unread again, both mentions
  await ok(C.bob, "POST", `/api/chat/channels/${ch.id}/read`, { seq: m2.seq - 1 });
  bv = await view(C.bob);
  assert.deepEqual([bv.unread, bv.me?.mentions], [2, 2]);
  // muted: nothing counts; mentions-only: mentions count
  await ok(C.bob, "POST", `/api/chat/channels/${ch.id}`, { notify: "mentions" });
  assert.equal((await view(C.bob)).unread, 2);
  await ok(C.bob, "POST", `/api/chat/channels/${ch.id}`, { notify: "none", starred: true });
  bv = await view(C.bob);
  assert.equal(bv.unread, 0);
  assert.equal(bv.me?.starred, true);
  // a DM message is a mention for the other side, and shows on Today
  const dm = await mkChannel(C.cy, { kind: "dm", members: [bob.id] });
  await post(C.cy, dm.id, "got a minute?");
  const dv = await view(C.bob).catch(() => null);
  assert.ok(dv);
  const d = await ok<{ channel: ChatChannelView }>(C.bob, "GET", `/api/chat/channels/${dm.id}`);
  assert.deepEqual([d.channel.unread, d.channel.me?.mentions], [1, 1]);
  const focus = focusFor(bob).find((f) => f.id === `message:${dm.id}`);
  assert.ok(focus, "Today lists the DM");
  assert.equal(focus.kind, "message");
  assert.equal(focus.href, `#/chat/chat/${dm.id}`);
});

// ---------- paging ----------

test("paging: newest, before, after, around, since", async () => {
  const ch = await mkChannel(C.ada, { kind: "open", name: "paging" });
  const seqs: number[] = [];
  for (let i = 1; i <= 30; i++) seqs.push((await post(C.ada, ch.id, `m${i}`)).seq);
  const texts = (p: ChatPage) => p.messages.map((m) => m.text);
  const newest = chat.pageMessages(ch.id, { limit: 10 });
  assert.deepEqual(texts(newest), Array.from({ length: 10 }, (_, i) => `m${21 + i}`));
  assert.deepEqual([newest.before, newest.after], [true, false]);
  const older = await ok<ChatPage>(C.bob, "GET", `/api/chat/channels/${ch.id}/messages?before=${seqs[20]}&limit=10`);
  assert.deepEqual(texts(older), Array.from({ length: 10 }, (_, i) => `m${11 + i}`));
  assert.deepEqual([older.before, older.after], [true, true]);
  const newer = chat.pageMessages(ch.id, { after: seqs[24], limit: 10 });
  assert.deepEqual(texts(newer), ["m26", "m27", "m28", "m29", "m30"]);
  assert.deepEqual([newer.before, newer.after], [true, false]);
  const around = chat.pageMessages(ch.id, { around: seqs[14], limit: 6 });
  assert.deepEqual(texts(around), ["m12", "m13", "m14", "m15", "m16", "m17"]);
  const t = Date.now();
  await sleep(5);
  await post(C.bob, ch.id, "late");
  await ok(C.cy, "POST", `/api/chat/messages/${newest.messages[0].id}/react`, { emoji: "👀" });
  const since = await ok<ChatPage>(C.ada, "GET", `/api/chat/channels/${ch.id}/messages?since=${t}`);
  assert.deepEqual(since.messages.filter((m) => m.type === "text").map((m) => m.text).sort(), ["late", "m21"], "what was made or changed since (and the system lines of who joined by writing)");
});

// ---------- search ----------

test("search: words, from:, in:, has:, dates, and only what the asker may read (also in ⌘K)", async () => {
  const secret = await mkChannel(C.ada, { kind: "private", name: "vault", members: [bob.id] });
  await post(C.ada, secret.id, "the zebra protocol is ready https://example.com/z");
  const open = await mkChannel(C.bob, { kind: "open", name: "zoo" });
  await post(C.bob, open.id, "a zebra escaped");
  const f = await storeFile(Buffer.from("stripes"), { name: "zebra-drawing.step", mime: "application/step", boardId: "chat", userId: bob.id });
  const withFile = await post(C.bob, open.id, "drawing attached", { files: [f.id] });
  type Hits = { hits: Array<{ message: ChatMessage; channel: { id: string; name: string }; snippet: string }> };
  const s = (who: string, q: string) => ok<Hits>(who, "GET", `/api/chat/search?q=${encodeURIComponent(q)}`).then((b) => b.hits);
  assert.equal((await s(C.ada, "zebra")).length, 3);
  assert.equal((await s(C.cy, "zebra")).length, 2, "Cy isn't in #vault");
  assert.equal((await s(C.boss, "zebra")).length, 2, "nor the admin");
  assert.deepEqual((await s(C.ada, "zebra from:bob")).map((h) => h.message.author.id), [bob.id, bob.id]);
  assert.deepEqual((await s(C.ada, "zebra in:vault")).map((h) => h.channel.id), [secret.id]);
  assert.deepEqual((await s(C.ada, "zebra has:link")).map((h) => h.channel.id), [secret.id]);
  assert.deepEqual((await s(C.ada, "has:file in:zoo")).map((h) => h.message.id), [withFile.id]);
  assert.equal((await s(C.ada, "zebra before:2000-01-01")).length, 0);
  assert.equal((await s(C.ada, '"zebra protocol"')).length, 1);
  assert.ok((await s(C.ada, "zebra"))[0].snippet.includes("«"), "the match is marked");
  // ⌘K: the same filter; chat uploads themselves never show
  const cmdk = (userId: string | undefined) => searchLocal("zebra", undefined, 30, undefined, chat.chatHitFilter(userId));
  assert.equal(cmdk(ada.id).filter((h) => h.source === "chat").length, 3);
  assert.equal(cmdk(cy.id).filter((h) => h.source === "chat").length, 2);
  assert.equal(cmdk(undefined).filter((h) => h.source === "chat").length, 0, "no person, no chat");
  assert.ok(!cmdk(ada.id).some((h) => h.source === "file" && h.id === `file:${f.id}`), "the chat upload isn't a ⌘K file hit");
  assert.ok(cmdk(ada.id).find((h) => h.source === "chat")?.url?.startsWith("#/chat/chat/"));
});

// ---------- the socket ----------

test("the /chat socket: hello, events only to who may read, rev counts, typing, presence", async () => {
  const [a, b, c, boss_] = await Promise.all([listen({ cookie: C.ada }), listen({ cookie: C.bob }), listen({ cookie: C.cy }), listen({ cookie: C.boss })]);
  const hello = await a.next((e) => e.t === "hello");
  assert.equal(hello.rev, 0);
  assert.equal((hello as Extract<ChatEvent, { t: "hello" }>).you, ada.id);
  const pres = (await c.next((e) => e.t === "presence" && [ada.id, bob.id, cy.id, boss.id].every((id) => (e as Extract<ChatEvent, { t: "presence" }>).online.includes(id)))) as Extract<ChatEvent, { t: "presence" }>;
  assert.ok(pres.online.includes(ada.id));
  const dm = await mkChannel(C.ada, { kind: "dm", members: [bob.id] });
  const sent = await post(C.ada, dm.id, "private words", { request_id: "sock-1" });
  const got = (await b.next((e) => e.t === "message" && e.message.id === sent.id)) as Extract<ChatEvent, { t: "message" }>;
  assert.equal(got.message.text, "private words");
  const mine = (await a.next((e) => e.t === "message" && e.message.id === sent.id)) as Extract<ChatEvent, { t: "message" }>;
  assert.equal(mine.requestId, "sock-1", "the sender's window can swap its pending copy");
  await b.next((e) => e.t === "read" && e.channel === dm.id && e.mentions >= 1);
  const pub = await post(C.bob, general, "everyone hears this");
  await c.next((e) => e.t === "message" && e.message.id === pub.id);
  await boss_.next((e) => e.t === "message" && e.message.id === pub.id);
  await sleep(150);
  assert.ok(!c.events.some((e) => (e.t === "message" || e.t === "channel") && JSON.stringify(e).includes(dm.id)), "a third person hears nothing of the DM");
  assert.ok(!boss_.events.some((e) => JSON.stringify(e).includes(dm.id)), "nor does an admin");
  for (const s of [a, b, c, boss_]) s.events.forEach((e, i) => assert.equal(e.rev, i, "rev counts up by one per event, from hello's 0"));
  // typing: to the other member, not back to the typer, not to outsiders, throttled
  a.ws.send(JSON.stringify({ t: "typing", channel: dm.id, root: null }));
  a.ws.send(JSON.stringify({ t: "typing", channel: dm.id, root: null }));
  const typing = (await b.next((e) => e.t === "typing")) as Extract<ChatEvent, { t: "typing" }>;
  assert.equal(typing.party.id, ada.id);
  assert.equal(typing.party.kind, "person");
  await sleep(150);
  assert.equal(b.events.filter((e) => e.t === "typing").length, 1, "throttled");
  assert.ok(!a.events.some((e) => e.t === "typing") && !c.events.some((e) => e.t === "typing"));
  // Cy typing into a DM she isn't in goes nowhere
  c.ws.send(JSON.stringify({ t: "typing", channel: dm.id }));
  await sleep(150);
  assert.equal(b.events.filter((e) => e.t === "typing").length, 1);
  // presence: Cy leaves
  c.close();
  await a.next((e) => e.t === "presence" && !(e as Extract<ChatEvent, { t: "presence" }>).online.includes(cy.id));
  for (const s of [a, b, boss_]) s.close();
});

test("the /chat socket opens with a ticket (the desktop app) and with an agent's bearer, which types as an agent", async () => {
  const res = { setHeader() {} };
  const app = auth.signIn(res as never, bob.id, true).session!;
  const fake = { headers: { authorization: `Bearer ${app}` }, url: "/api/ws-ticket", query: new URLSearchParams(), params: {} } as never;
  const { ticket } = issueTicket(fake, "/chat");
  const s = await listen({}, `?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(((await s.next((e) => e.t === "hello")) as Extract<ChatEvent, { t: "hello" }>).you, bob.id);
  await assert.rejects(listen({}, `?ticket=${encodeURIComponent(ticket)}`), /refused 401/, "a ticket opens one socket");
  await assert.rejects(listen({}), /refused 401/, "no session, no socket");
  const agent = await listen({ authorization: `Bearer ${adaAgent}` });
  agent.ws.send(JSON.stringify({ t: "typing", channel: general }));
  const t = (await s.next((e) => e.t === "typing")) as Extract<ChatEvent, { t: "typing" }>;
  assert.equal(t.party.kind, "agent");
  assert.equal(t.party.forName, ada.name);
  s.close();
  agent.close();
});

// ---------- export ----------

test("a channel downloads as JSON and as Markdown, threads and all", async () => {
  const ch = await mkChannel(C.ada, { kind: "open", name: "exported", topic: "for the archive" });
  const root = await post(C.ada, ch.id, "the **plan**");
  await post({ bearer: adaAgent, agent: "Wren" }, ch.id, "noted", { root: root.id });
  await ok(C.bob, "POST", `/api/chat/messages/${root.id}/react`, { emoji: "🚀" });
  const j = await api<{ channel: { id: string }; messages: ChatMessage[] }>(C.bob, "GET", `/api/chat/channels/${ch.id}/export?format=json`);
  assert.equal(j.status, 200);
  assert.match(j.headers.get("content-disposition") ?? "", /attachment; filename="exported-\d{4}-\d\d-\d\d\.json"/);
  assert.equal(j.body.channel.id, ch.id);
  assert.ok(j.body.messages.some((m) => m.root === root.id && m.author.kind === "agent"));
  const md = await api(C.bob, "GET", `/api/chat/channels/${ch.id}/export?format=md`);
  assert.match(md.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(md.text, /^# #exported/);
  assert.match(md.text, /> for the archive/);
  assert.match(md.text, /\*\*Ada Lovelace\*\* · \d\d:\d\d UTC\nthe \*\*plan\*\*\n🚀 Bob Stone/);
  assert.match(md.text, /> \*\*Wren \(agent, for Ada Lovelace\)\*\*/);
});

// ---------- chat uploads ----------

test("a chat upload: its uploader's, then its messages' readers'; attaching someone else's unseen file is refused", async () => {
  const f = await storeFile(Buffer.from("cad bytes"), { name: "part.step", mime: "application/step", boardId: "chat", userId: ada.id });
  const again = await storeFile(Buffer.from("cad bytes"), { name: "part.step", mime: "application/step", boardId: "chat", userId: bob.id });
  assert.notEqual(again.id, f.id, "the same bytes from someone else are their own file");
  assert.ok(chat.canSeeChatFile(ada, f.id));
  assert.ok(!chat.canSeeChatFile(bob, f.id));
  assert.equal((await api(C.bob, "POST", `/api/chat/channels/${general}/messages`, { text: "mine now", files: [f.id] })).status, 400);
  const dm = await mkChannel(C.ada, { kind: "dm", members: [bob.id] });
  const m = await post(C.ada, dm.id, "the part", { files: [f.id] });
  assert.deepEqual(m.files, [{ id: f.id, name: "part.step", mime: "application/step", size: 9 }]);
  assert.ok(chat.canSeeChatFile(bob, f.id), "Bob reads the DM");
  assert.ok(!chat.canSeeChatFile(cy, f.id), "Cy doesn't");
  assert.ok(!chat.canSeeChatFile(boss, f.id), "nor the admin");
  // Bob may forward it now that he can see it
  assert.equal((await post(C.bob, general, "forwarded", { files: [f.id] })).files[0].id, f.id);
  assert.ok(chat.canSeeChatFile(cy, f.id), "now in #general");
  assert.deepEqual(listFiles("chat"), [], "chat uploads aren't listed as a board's");
  assert.ok(!listFiles().some((x) => x.board_id === "chat"));
});

// ---------- link previews ----------

test("link previews: the SSRF guard, off under test by default, and a local stand-in when a test allows it", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::"])
    assert.equal(chat.isPublicAddress(ip), false, `${ip} is not public`);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(chat.isPublicAddress(ip), true, `${ip} is public`);
  assert.deepEqual(chat.linksIn("see https://a.example/x, and `https://code.example` and https://b.example/y. https://c.example https://d.example"), ["https://a.example/x", "https://b.example/y", "https://c.example"]);

  const site = createServer((req, res) => {
    if (req.url === "/to-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><title>Fallback</title><meta property="og:title" content="Rim drive &amp; hub"><meta property="og:description" content="The new one"><meta property="og:image" content="/pic.png"></head></html>`);
  });
  await new Promise<void>((d) => site.listen(0, "127.0.0.1", d));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  try {
    assert.equal(chat.previewsOn(), false, "off under the test runner unless a test turns it on");
    await assert.rejects(chat.linkPreview(`${url}/page`), /public address/, "loopback is refused");
    await assert.rejects(chat.linkPreview(`http://localhost:${new URL(url).port}/page`), /public address/, "a name that resolves to loopback too");
    await assert.rejects(chat.linkPreview("http://169.254.169.254/latest/meta-data/"), /public address/);
    assert.equal(await chat.linkPreview("file:///etc/passwd"), null);
    const quiet = await post(C.ada, general, `no preview for ${url}/page`);
    await sleep(200);
    assert.equal(chat.getMessage(quiet.id)!.previews, undefined);

    process.env.FOUNDATION_CHAT_PREVIEWS = "1";
    process.env.FOUNDATION_CHAT_PREVIEWS_LOOPBACK = "1";
    const p = await chat.linkPreview(`${url}/page`);
    assert.deepEqual(p, { url: `${url}/page`, title: "Rim drive & hub", description: "The new one", image: `${url}/pic.png`, site: "127.0.0.1" });
    await assert.rejects(chat.linkPreview(`${url}/to-metadata`), /public address/, "a redirect to a private address is refused at that hop");
    const s = await listen({ cookie: C.bob });
    const m = await post(C.ada, general, `look: ${url}/page`);
    const changed = (await s.next((e) => e.t === "message-changed" && e.message.id === m.id && Boolean(e.message.previews), 4000)) as Extract<ChatEvent, { t: "message-changed" }>;
    assert.equal(changed.message.previews?.[0].title, "Rim drive & hub");
    s.close();
  } finally {
    delete process.env.FOUNDATION_CHAT_PREVIEWS;
    delete process.env.FOUNDATION_CHAT_PREVIEWS_LOOPBACK;
    site.close();
  }
});

// ---------- the module surface other modules build on ----------

test("the surface: ghosts, origins, silent history, onChatMessage, setChannelHuddle, membership events", async () => {
  const ghost = chat.ghostParty("whatsapp", "+15550001", "Dana");
  assert.equal(ghost.kind, "ghost");
  assert.equal(chat.ghostParty("whatsapp", "+15550001", "Dana R").id, ghost.id, "made once per service and handle");
  const portal = chat.createChannel(chat.SYSTEM_PARTY, { kind: "portal", name: "Dana", origin: { service: "whatsapp", externalId: "chat-1" }, members: [chat.personParty(ada)] });
  assert.equal(chat.channelByOrigin("whatsapp", "chat-1")?.id, portal.id);
  assert.equal(chat.createChannel(chat.SYSTEM_PARTY, { kind: "portal", origin: { service: "whatsapp", externalId: "chat-1" } }).id, portal.id, "an origin is one channel");
  const heard: string[] = [];
  const off = chat.onChatMessage((m) => heard.push(m.text));
  // brought-in history: no listeners, no unread for someone caught up, no doubles
  const old = chat.postMessage(portal.id, ghost, { text: "from last year", origin: { service: "whatsapp", externalId: "wamid-1" }, createdAt: Date.UTC(2025, 0, 1) }, { silent: true });
  assert.equal(chat.postMessage(portal.id, ghost, { text: "from last year", origin: { service: "whatsapp", externalId: "wamid-1" } }, { silent: true }).id, old.id);
  assert.equal(chat.channelView(ada, chat.getChannel(portal.id)!).unread, 0);
  assert.deepEqual(heard, []);
  chat.postMessage(portal.id, ghost, { text: "hi now" });
  assert.deepEqual(heard, ["hi now"]);
  assert.equal(chat.channelView(ada, chat.getChannel(portal.id)!).me?.mentions, 1, "a portal message is for its people");
  off();
  chat.setChannelHuddle(portal.id, { id: "h1", board: "chat", liveSince: 1, people: ["Ada Lovelace"], recording: false });
  assert.equal(chat.getChannel(portal.id)!.huddle?.id, "h1");
  const card = chat.postMessage(portal.id, chat.personParty(ada), { type: "huddle", huddle: { id: "h1", startedAt: 1, people: ["Ada Lovelace"] } });
  assert.equal(chat.updateMessage(card.id, { huddle: { id: "h1", startedAt: 1, endedAt: 2, people: ["Ada Lovelace"] } }).huddle?.endedAt, 2);
  // adding to a private channel: a system line, and the newcomer starts caught up
  const priv = await mkChannel(C.ada, { kind: "private", name: "late-joiners" });
  await post(C.ada, priv.id, "before you came");
  await ok(C.ada, "POST", `/api/chat/channels/${priv.id}/members`, { add: [cy.id] });
  const cv = await ok<{ channel: ChatChannelView }>(C.cy, "GET", `/api/chat/channels/${priv.id}`);
  assert.equal(cv.channel.unread, 0);
  assert.ok(chat.pageMessages(priv.id).messages.some((m) => m.type === "system" && /Cy Twombly joined/.test(m.text)));
  assert.equal((await api(C.cy, "POST", `/api/chat/channels/${priv.id}/members`, { remove: [ada.id] })).status, 403, "only the maker or an admin removes others");
  await ok(C.ada, "POST", `/api/chat/channels/${priv.id}/members`, { remove: [cy.id] });
  assert.equal((await api(C.cy, "GET", `/api/chat/channels/${priv.id}`)).status, 404);
  // archive needs confirm and the maker (or an admin)
  assert.equal((await api(C.ada, "POST", `/api/chat/channels/${priv.id}/archive`, {})).status, 400);
  await ok(C.ada, "POST", `/api/chat/channels/${priv.id}/archive`, { confirm: true });
  assert.equal((await api(C.ada, "POST", `/api/chat/channels/${priv.id}/messages`, { text: "too late" })).status, 409);
});

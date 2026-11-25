/**
 * What was said to a person (`GET /api/chat/mentions`; chat.ts `mentionsFor`): the bell's list. Over the real
 * routes with real sessions: who it names, @channel and @here only for members, every message from someone
 * else in a DM or a group, never the asker's own, never a removed one, never a conversation they can't read
 * (an admin included), newest first, `limit` and `before`.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChannelView, ChatMention, ChatMessage } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-chatmentions-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
delete process.env.FOUNDATION_CHAT_PREVIEWS;

const { run } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const { closeBoards } = await import("../src/boards.ts");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const bob = auth.upsertUser("bob@formindustries.com", "Bob Stone");
const cy = auth.upsertUser("cy@formindustries.com", "Cy Twombly");
const vic = auth.upsertUser("vic@formindustries.com", "Vic Viewer");
run("update users set role = 'viewer' where id = ?", vic.id);

const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), bob: cookieOf(bob.id), cy: cookieOf(cy.id), vic: cookieOf(vic.id) };
const adaAgent = auth.createSession(ada.id, 3600_000, "agent");

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
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
  server?.closeAllConnections();
  server?.close();
  closeBoards();
});

type Who = string | { bearer: string; agent?: string };
async function api<T = Record<string, unknown>>(who: Who | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof who === "string") headers.cookie = who;
  else if (who) {
    headers.authorization = `Bearer ${who.bearer}`;
    if (who.agent) headers["x-foundation-agent"] = who.agent;
  }
  const res = await fetch(`http://${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, body: parsed as T, text };
}
const ok = async <T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown) => {
  const r = await api<T>(who, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${r.text}`);
  return r.body;
};
const post = (who: Who, channel: string, text: string, more: Record<string, unknown> = {}) =>
  ok<{ message: ChatMessage }>(who, "POST", `/api/chat/channels/${channel}/messages`, { text, ...more }).then((b) => b.message);
const mkChannel = (who: Who, body: Record<string, unknown>) => ok<{ channel: ChatChannelView }>(who, "POST", "/api/chat/channels", body).then((b) => b.channel);
const mentions = (who: Who, q = "") => ok<{ mentions: ChatMention[] }>(who, "GET", `/api/chat/mentions${q}`).then((b) => b.mentions);
const texts = (list: ChatMention[]) => list.map((x) => x.message.text);
const tick = () => new Promise((r) => setTimeout(r, 3));

test("signed out: refused", async () => {
  const r = await api(null, "GET", "/api/chat/mentions");
  assert.equal(r.status, 401);
});

test("named in an open channel, by others only; newest first; the channel says where", async () => {
  await ok(C.ada, "GET", "/api/chat");
  await ok(C.bob, "GET", "/api/chat");
  const ch = await mkChannel(C.ada, { kind: "open", name: "plans" });
  await post(C.ada, ch.id, "nothing for anyone");
  await tick();
  const first = await post(C.ada, ch.id, "@bob.stone the first");
  await tick();
  await post(C.bob, ch.id, "@bob.stone a note to myself");
  await tick();
  const second = await post(C.cy, ch.id, "@bob.stone the second, and @ada.lovelace");
  const got = await mentions(C.bob);
  assert.deepEqual(texts(got), [second.text, first.text], "newest first, never my own, never one that names nobody");
  assert.deepEqual(got[0].channel, { id: ch.id, name: "plans", kind: "open" });
  assert.equal(got[0].message.author.id, cy.id);
  // bob never joined #plans: an open channel he may read still tells him he was named
  assert.deepEqual(texts(await mentions(C.ada)), [second.text]);
  assert.deepEqual(await mentions(C.boss), []);
});

test("@channel and @here count for members only", async () => {
  const ch = await mkChannel(C.ada, { kind: "open", name: "announce" });
  await ok(C.bob, "POST", `/api/chat/channels/${ch.id}/join`, {});
  const all = await post(C.ada, ch.id, "@channel ship day");
  await tick();
  const here = await post(C.ada, ch.id, "@here lunch");
  const bobs = texts(await mentions(C.bob));
  assert.ok(bobs.includes(all.text) && bobs.includes(here.text));
  const cys = texts(await mentions(C.cy));
  assert.ok(!cys.includes(all.text) && !cys.includes(here.text), "not a member: @channel isn't to them");
  assert.ok(!texts(await mentions(C.ada)).includes(all.text), "the one who said it isn't told");
});

test("a DM and a group: every message from the others, to members only (not a third person, not an admin)", async () => {
  const dm = await mkChannel(C.cy, { kind: "dm", members: [bob.id] });
  const m1 = await post(C.cy, dm.id, "got a minute?");
  await tick();
  const m2 = await post(C.bob, dm.id, "yes");
  const bobs = await mentions(C.bob);
  assert.equal(bobs[0].message.id, m1.id);
  assert.equal(bobs[0].channel.kind, "dm");
  assert.equal(bobs[0].channel.name, "Cy Twombly", "a DM is named for the other side");
  assert.ok(!texts(bobs).includes(m2.text));
  assert.equal((await mentions(C.cy))[0].message.id, m2.id);
  for (const who of [C.ada, C.boss, C.vic]) {
    const ids = (await mentions(who)).map((x) => x.message.id);
    assert.ok(!ids.includes(m1.id) && !ids.includes(m2.id), "a DM is its members' only");
  }
  const group = await mkChannel(C.ada, { kind: "group", members: [bob.id, cy.id] });
  const g = await post(C.ada, group.id, "the three of us");
  assert.equal((await mentions(C.bob))[0].message.id, g.id);
  assert.equal((await mentions(C.cy))[0].message.id, g.id);
  assert.ok(!(await mentions(C.boss)).some((x) => x.message.id === g.id));
});

test("a private channel's mention reaches only who may read it, even when it names someone outside", async () => {
  const priv = await mkChannel(C.ada, { kind: "private", name: "secret", members: [bob.id] });
  const m = await post(C.ada, priv.id, "@bob.stone and @cy.twombly and @boss.person: the plan");
  assert.ok((await mentions(C.bob)).some((x) => x.message.id === m.id));
  assert.ok(!(await mentions(C.cy)).some((x) => x.message.id === m.id), "named, but can't read it: nothing");
  assert.ok(!(await mentions(C.boss)).some((x) => x.message.id === m.id), "an admin isn't a member");
});

test("removed messages go; an agent's message for its person is someone else's; system lines never count", async () => {
  const ch = await mkChannel(C.ada, { kind: "open", name: "tidy" });
  const m = await post(C.ada, ch.id, "@bob.stone soon gone");
  assert.ok((await mentions(C.bob)).some((x) => x.message.id === m.id));
  await ok(C.ada, "DELETE", `/api/chat/messages/${m.id}`, { confirm: true });
  assert.ok(!(await mentions(C.bob)).some((x) => x.message.id === m.id));
  const a = await post({ bearer: adaAgent, agent: "Wren" }, ch.id, "@ada.lovelace done, and @bob.stone should look");
  assert.equal(a.author.kind, "agent");
  assert.ok((await mentions(C.ada)).some((x) => x.message.id === a.id), "her agent's message names her: she's told");
  assert.ok((await mentions(C.bob)).some((x) => x.message.id === a.id));
  // joining writes a system line in the channel: nobody is told
  await ok(C.cy, "POST", `/api/chat/channels/${ch.id}/join`, {});
  assert.ok((await mentions(C.bob)).every((x) => x.message.type !== "system"));
});

test("limit (at most 100) and before page backwards", async () => {
  const dm = await mkChannel(C.ada, { kind: "dm", members: [vic.id] });
  const sent: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    sent.push(await post(C.ada, dm.id, `page ${i}`));
    await tick();
  }
  const two = await mentions(C.vic, "?limit=2");
  assert.deepEqual(texts(two), ["page 5", "page 4"]);
  const next = await mentions(C.vic, `?limit=3&before=${two[1].message.createdAt}`);
  assert.deepEqual(texts(next), ["page 3", "page 2", "page 1"]);
  assert.equal((await mentions(C.vic, "?limit=5000")).length, 6, "a silly limit is capped, not refused");
  assert.equal(chat.mentionsFor(vic, { limit: 0 }).length, 1);
});

test("an archived channel's mentions leave the list", async () => {
  const ch = await mkChannel(C.ada, { kind: "open", name: "old-news" });
  const m = await post(C.ada, ch.id, "@cy.twombly before it closed");
  assert.ok((await mentions(C.cy)).some((x) => x.message.id === m.id));
  await ok(C.ada, "POST", `/api/chat/channels/${ch.id}/archive`, { confirm: true });
  assert.ok(!(await mentions(C.cy)).some((x) => x.message.id === m.id));
});

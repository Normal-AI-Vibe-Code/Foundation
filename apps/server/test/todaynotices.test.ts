/**
 * Today's notifications (`GET /api/today`, today.ts `focusFor` and chat.ts `chatFocus`): what was said to a person
 * is listed on their Today and links back to where it happened. A chat item opens its channel at the message (a
 * thread's reply in its thread); a grid item names its card and the section it sits in. A DM and a private channel
 * reach only their members, admins included; and reading Today writes nothing.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChannelView, ChatMessage } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-todaynotices-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
delete process.env.FOUNDATION_CHAT_PREVIEWS;

const { one } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const { todayFor } = await import("../src/today.ts");
const { closeBoards, editBoard, ensureBoardRow } = await import("../src/boards.ts");
const { appendSection, putNote, uid } = await import("@foundation/protocol");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const bob = auth.upsertUser("bob@formindustries.com", "Bob Stone");
const cy = auth.upsertUser("cy@formindustries.com", "Cy Twombly");

const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), bob: cookieOf(bob.id), cy: cookieOf(cy.id) };

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  r.get("/api/today", (req) => todayFor(auth.requireUser(req)));
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

async function api<T = Record<string, unknown>>(who: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.cookie = who;
  const res = await fetch(`http://${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, body: parsed as T, text };
}
const ok = async <T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown) => {
  const r = await api<T>(who, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${r.text}`);
  return r.body;
};
const post = (who: string, channel: string, text: string, more: Record<string, unknown> = {}) =>
  ok<{ message: ChatMessage }>(who, "POST", `/api/chat/channels/${channel}/messages`, { text, ...more }).then((b) => b.message);
const mkChannel = (who: string, body: Record<string, unknown>) => ok<{ channel: ChatChannelView }>(who, "POST", "/api/chat/channels", body).then((b) => b.channel);
interface Item { id: string; kind: string; title: string; href: string; objectId?: string; sectionId?: string; sectionName?: string; board: string }
const today = (who: string) => ok<{ focus: Item[] }>(who, "GET", "/api/today").then((b) => b.focus);
const chatItem = async (who: string, channel: string) => (await today(who)).find((f) => f.id === `message:${channel}`);
const enc = encodeURIComponent;

test("signed out: refused", async () => {
  assert.equal((await api(null, "GET", "/api/today")).status, 401);
});

test("ChatForm's link to a message: its channel, its thread when it's a reply, at the message", () => {
  assert.equal(chat.chatHref("c1", { seq: 7, root_id: null }), "#/chat/chat/c1/at/7");
  assert.equal(chat.chatHref("c1", { seq: 9, root_id: "m1" }), "#/chat/chat/c1/thread/m1/at/9");
  assert.equal(chat.chatHref("c1", null), "#/chat/chat/c1");
});

test("a mention in a channel links to the message that named them; a reply's, to its thread at the reply", async () => {
  const ch = await mkChannel(C.ada, { kind: "private", name: "rim-drive", members: [bob.id] });
  await post(C.ada, ch.id, "first, nobody named");
  const m = await post(C.ada, ch.id, "@bob.stone the bearing loads are in");
  await post(C.ada, ch.id, "and something else, nobody named");
  let item = await chatItem(C.bob, ch.id);
  assert.ok(item, "on Bob's Today");
  assert.equal(item!.href, `#/chat/chat/${enc(ch.id)}/at/${m.seq}`, "at the message that named him");
  const r = await post(C.ada, ch.id, "@bob.stone and the torque curve", { root: m.id });
  item = await chatItem(C.bob, ch.id);
  assert.equal(item!.href, `#/chat/chat/${enc(ch.id)}/thread/${enc(m.id)}/at/${r.seq}`);
});

test("a DM is on its members' Today only, at the first message they haven't read; never an admin's or a third person's", async () => {
  const dm = await mkChannel(C.cy, { kind: "dm", members: [bob.id] });
  const m1 = await post(C.cy, dm.id, "got a minute?");
  await post(C.cy, dm.id, "it's about the stator");
  const bobs = await chatItem(C.bob, dm.id);
  assert.ok(bobs, "Bob sees the DM on Today");
  assert.equal(bobs!.href, `#/chat/chat/${enc(dm.id)}/at/${m1.seq}`, "at the first unread");
  for (const who of [C.ada, C.boss]) {
    const items = await today(who);
    assert.ok(!items.some((f) => f.href.includes(dm.id)), "a DM is its members' only, admins included");
    assert.ok(!JSON.stringify(items).includes("stator"), "not its words either");
  }
});

test("a private channel's mention reaches only its members, even when it names someone outside (an admin included)", async () => {
  const priv = await mkChannel(C.ada, { kind: "private", name: "secret-plan", members: [bob.id] });
  await post(C.ada, priv.id, "@bob.stone @cy.twombly @boss.person: the secret plan");
  assert.ok(await chatItem(C.bob, priv.id));
  for (const who of [C.cy, C.boss]) {
    const items = await today(who);
    assert.ok(!items.some((f) => f.href.includes(priv.id)), "named, but not a member: nothing");
    assert.ok(!JSON.stringify(items).includes("secret plan"));
  }
});

test("a grid tag names its card and the section it sits in, and opens there", async () => {
  ensureBoardRow("motors", "Motors");
  let noteId = "";
  let secId = "";
  editBoard("motors", "test", (doc) => {
    const sec = appendSection(doc, "Rim drive");
    secId = sec.id;
    noteId = uid("note");
    putNote(doc, { id: noteId, kind: "note", sectionId: sec.id, x: 0, y: 0, w: 300, h: 200, float: false, bornAt: Date.now(), text: "@Bob can you sign off the loads?" } as never);
  });
  const item = (await today(C.bob)).find((f) => f.id === `mention:motors:${noteId}`);
  assert.ok(item, "the tag is on Bob's Today");
  assert.equal(item!.objectId, noteId);
  assert.equal(item!.sectionId, secId);
  assert.equal(item!.sectionName, "Rim drive");
  assert.ok(item!.href.endsWith(`?board=motors&focus=${enc(noteId)}`), item!.href);
});

test("reading Today writes nothing: no read mark moves, no board changes", async () => {
  const dm = await mkChannel(C.ada, { kind: "dm", members: [cy.id] });
  await post(C.ada, dm.id, "ping");
  const mark = () => one<{ read_seq: number }>("select read_seq from chat_members where channel_id = ? and party_id = ?", dm.id, cy.id);
  const board = () => one<{ updated_at: number }>("select updated_at from boards where id = 'motors'");
  const before = [mark(), board()];
  await today(C.cy);
  await today(C.cy);
  assert.deepEqual([mark(), board()], before);
});

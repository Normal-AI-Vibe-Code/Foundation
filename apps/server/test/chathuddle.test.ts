/**
 * Huddles in ChatForm channels (H1), end to end on the server over real sockets and routes: a channel's
 * room, its card and the channel's state through a session; membership gates on the socket, the routes,
 * the transcript and the recordings (a DM's huddle is invisible to a third person and to an admin);
 * taking it to a grid keeps the call and mirrors its state (locked when the channel isn't open); the
 * session's hooks and event log for the replay; one screen share at a time; an agent seated by a person
 * answers through the scripted runtime; "don't record me" is recorded.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { ChatChannelView, ChatMessage, HuddleWire, PanelDoc } from "@foundation/protocol";
import type { HuddleSessionEvent } from "../src/huddles.ts";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-chathuddle-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_HUDDLE_END_GRACE_MS = "60";
process.env.FOUNDATION_AGENT_SCRIPT = "1";
delete process.env.FOUNDATION_CHAT_PREVIEWS;

const { run } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const huddles = await import("../src/huddles.ts");
const { handleUpgrade } = await import("../src/sockets.ts");
const { storeFile } = await import("../src/files.ts");
const { closeBoards, ensureBoardRow, editBoard, getBoard } = await import("../src/boards.ts");
const { boardMaps, appendSection, huddleStateOf } = await import("@foundation/protocol");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = auth.upsertUser("kai@formindustries.com", "Kai Moreno");
const cy = auth.upsertUser("cy@formindustries.com", "Cy Twombly");
for (const u of [ada, kai, cy]) run("update users set role = 'member' where id = ?", u.id);
const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), kai: cookieOf(kai.id), cy: cookieOf(cy.id) };
const adaAgent = auth.createSession(ada.id, 3600_000, "agent");

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  huddles.huddleRoutes(r);
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

type Who = string | { bearer: string };
async function api<T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof who === "string") headers.cookie = who;
  else headers.authorization = `Bearer ${who.bearer}`;
  const res = await fetch(`http://${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed as T, text };
}
const ok = async <T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown) => {
  const r = await api<T>(who, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${r.text}`);
  return r.body;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a huddle socket that keeps what it hears; `closed` resolves with the close code */
function enter(who: Who, path: string, send: boolean) {
  const headers: Record<string, string> = typeof who === "string" ? { cookie: who } : { authorization: `Bearer ${who.bearer}` };
  const ws = new WebSocket(`ws://${base}${path}?send=${send ? 1 : 0}`, { headers: headers.cookie ? { origin: "http://localhost:1430", ...headers } : headers });
  sockets.push(ws);
  ws.on("error", () => undefined);
  const heard: HuddleWire[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (raw) => {
    heard.push(JSON.parse(String(raw)));
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<number>((r) => {
    ws.on("close", (c) => r(c));
    ws.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0));
  });
  const next = async <T extends HuddleWire["t"]>(t: T, pred: (m: Extract<HuddleWire, { t: T }>) => boolean = () => true, timeout = 2500): Promise<Extract<HuddleWire, { t: T }>> => {
    const end = Date.now() + timeout;
    for (;;) {
      const i = heard.findIndex((m) => m.t === t && pred(m as Extract<HuddleWire, { t: T }>));
      if (i >= 0) return heard.splice(i, 1)[0] as Extract<HuddleWire, { t: T }>;
      if (Date.now() > end) throw new Error(`no ${t}; heard ${heard.map((m) => m.t).join(",")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { ws, heard, next, closed, say: (m: unknown) => ws.send(JSON.stringify(m)) };
}

const channel = (id: string) => chat.getChannel(id)!;
const card = (id: string) => chat.getMessage(id)!;
const start = (who: Who, ch: string, body: unknown = {}) => api<{ huddle: { id: string; board: string }; message: ChatMessage; socket: string }>(who, "POST", `/api/chat/channels/${ch}/huddle`, body);
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
};

const events: HuddleSessionEvent[] = [];
huddles.onHuddleSession((e) => events.push(e));

test("a channel's huddle: one card, the channel's state, people join and leave, it ends with its session", async () => {
  const general = chat.ensureGeneral();
  const s = await start(C.ada, general.id, { request_id: "h1" });
  assert.equal(s.status, 200, s.text);
  const id = s.body.huddle.id;
  assert.match(id, /^hd_/);
  assert.equal(s.body.socket, `/huddle/chat/${id}`);
  assert.equal(s.body.message.type, "huddle");
  assert.equal(s.body.message.author.name, "Ada Lovelace");
  assert.equal(channel(general.id).huddle?.id, id);
  assert.equal(channel(general.id).huddle?.board, "chat");
  // one live huddle per channel: Kai's start returns the same, and no second card
  const again = await start(C.kai, general.id);
  assert.equal(again.body.huddle.id, id);
  assert.equal(again.body.message.id, s.body.message.id);
  const page = chat.pageMessages(general.id);
  assert.equal(page.messages.filter((m) => m.type === "huddle").length, 1);

  const a = enter(C.ada, s.body.socket, true);
  await a.next("welcome");
  await until(() => channel(general.id).huddle?.people.join() === "Ada Lovelace");
  const k = enter(C.kai, s.body.socket, true);
  const wk = await k.next("welcome");
  assert.deepEqual(wk.peers.map((p) => p.name), ["Ada Lovelace"]);
  await a.next("peer-joined");
  await until(() => channel(general.id).huddle?.people.length === 2);
  assert.deepEqual(card(s.body.message.id).huddle?.people.sort(), ["Ada Lovelace", "Kai Moreno"]);
  const sessionId = card(s.body.message.id).huddle?.session;
  assert.ok(sessionId, "the card names its session");

  // signals reach their addressee; lines reach the other; recording shows on the channel
  a.say({ t: "signal", to: wk.you, data: { sdp: "x" } });
  assert.deepEqual((await k.next("signal")).data, { sdp: "x" });
  k.say({ t: "line", text: "The bracket needs a fillet", source: "typed" });
  assert.equal((await a.next("line")).line.speaker, "Kai Moreno");
  // Kai: don't record me; then Ada records
  k.say({ t: "optout", on: true });
  assert.equal((await a.next("peer-state", (m) => m.noRec === true)).id, wk.you);
  a.say({ t: "recording", on: true });
  assert.equal((await k.next("recording")).on, true);
  await until(() => channel(general.id).huddle?.recording === true);
  a.say({ t: "recording", on: false });
  await k.next("recording", (m) => !m.on);

  // a recording: Ada's own chat upload, linked to the card so the channel's readers can open it
  const f = await storeFile(Buffer.from("webm"), { name: "ada.webm", mime: "video/webm", boardId: "chat", userId: ada.id });
  const notMine = await api(C.kai, "POST", `/api/huddles/${id}/recordings`, { board: "chat", fileId: f.id, sessionId });
  assert.equal(notMine.status, 400, "someone else's upload isn't your recording");
  await ok(C.ada, "POST", `/api/huddles/${id}/recordings`, { board: "chat", fileId: f.id, sessionId, startedAt: Date.now() - 1000, endedAt: Date.now() });
  assert.equal(chat.canSeeChatFile(kai, f.id), true);

  // everyone leaves: after a moment the session ends, the card says so, the channel's state clears
  a.ws.close();
  k.ws.close();
  await until(() => Boolean(card(s.body.message.id).huddle?.endedAt));
  const h = card(s.body.message.id).huddle!;
  assert.equal(h.session, sessionId);
  assert.equal(h.recorded, true);
  assert.deepEqual(h.people.sort(), ["Ada Lovelace", "Kai Moreno"]);
  assert.equal(channel(general.id).huddle, null);
  const sess = huddles.readSession(sessionId!)!;
  assert.ok(sess.ended_at);
  assert.equal(sess.home, "chat");
  assert.equal(sess.channel, general.id);
  assert.deepEqual(sess.optedOut, ["Kai Moreno"]);
  assert.equal(sess.recordings?.length, 1);
  assert.ok(sess.recordings![0].stoppedAt);
  assert.equal(sess.media.length, 1);
  assert.deepEqual(
    events.filter((e) => e.session === sessionId).map((e) => e.type),
    ["start", "recording-on", "recording-off", "end"],
  );
  // an ended huddle can't be rejoined; a new start is a new huddle and card
  const late = enter(C.kai, s.body.socket, true);
  assert.equal(await late.closed, 4410);
  const fresh = await start(C.kai, general.id);
  assert.notEqual(fresh.body.huddle.id, id);
  // the Huddles tab lists it for both
  const listed = await ok<{ sessions: Array<{ id: string; channel?: { id: string } }> }>(C.kai, "GET", "/api/huddles/sessions");
  assert.ok(listed.sessions.some((x) => x.id === sessionId && x.channel?.id === general.id));
  const found = await ok<{ sessions: Array<{ id: string; snippet?: string }> }>(C.ada, "GET", "/api/huddles/sessions?q=fillet");
  assert.match(found.sessions.find((x) => x.id === sessionId)?.snippet ?? "", /fillet/);
});

test("a DM's huddle is the DM's: a third person and an admin can't see, join, listen, read or fetch", async () => {
  const dm = chat.openDirect([chat.personParty(ada), chat.personParty(kai)]);
  // only its members start one
  assert.equal((await start(C.cy, dm.id)).status, 404);
  assert.equal((await start(C.boss, dm.id)).status, 404);
  const s = await start(C.ada, dm.id);
  const id = s.body.huddle.id;
  const a = enter(C.ada, s.body.socket, true);
  await a.next("welcome");
  a.say({ t: "line", text: "secret plans", source: "typed" });
  await a.next("line");
  const sid = chat.getMessage(s.body.message.id)!.huddle!.session!;
  for (const who of [C.cy, C.boss]) {
    for (const send of [true, false]) assert.equal(await enter(who, s.body.socket, send).closed, 4403, "no seat, no listening in");
    assert.equal((await api(who, "GET", `/api/huddles/${id}?board=chat`)).status, 404);
    assert.equal((await api(who, "POST", `/api/huddles/${id}/lines`, { board: "chat", text: "hi" })).status, 404);
    assert.equal((await api(who, "GET", `/api/huddles/sessions/${sid}`)).status, 404);
    const live = await ok<{ live: Array<{ huddle: { id: string } }> }>(who, "GET", "/api/huddles/live");
    assert.ok(!live.live.some((l) => l.huddle.id === id));
    const listed = await ok<{ sessions: Array<{ id: string }> }>(who, "GET", "/api/huddles/sessions?q=secret");
    assert.ok(!listed.sessions.some((x) => x.id === sid));
  }
  assert.equal(huddles.sessionFor(cy, sid), null);
  assert.equal(huddles.sessionFor(boss, sid), null);
  assert.equal(huddles.sessionFor(kai, sid)?.lines[0].text, "secret plans");
  // the recording follows the DM
  const f = await storeFile(Buffer.from("webm2"), { name: "dm.webm", mime: "video/webm", boardId: "chat", userId: ada.id });
  await ok(C.ada, "POST", `/api/huddles/${id}/recordings`, { board: "chat", fileId: f.id, kind: "screen" });
  assert.equal(huddles.readSession(sid)!.media[0].kind, "screen");
  assert.equal(chat.canSeeChatFile(kai, f.id), true);
  assert.equal(chat.canSeeChatFile(cy, f.id), false);
  assert.equal(chat.canSeeChatFile(boss, f.id), false);
  // Kai sees it live and can listen
  const live = await ok<{ live: Array<{ huddle: { id: string } }> }>(C.kai, "GET", "/api/huddles/live");
  assert.ok(live.live.some((l) => l.huddle.id === id));
  a.ws.close();
  await until(() => Boolean(chat.getMessage(s.body.message.id)!.huddle!.endedAt));
});

test("agents can't start or join a channel's huddle; a viewer of nothing gets nothing", async () => {
  const general = chat.ensureGeneral();
  assert.equal((await start({ bearer: adaAgent }, general.id)).status, 403);
  const s = await start(C.ada, general.id);
  const bearer = enter({ bearer: adaAgent }, s.body.socket, true);
  assert.equal(await bearer.closed, 4403);
  assert.equal((await api({ bearer: adaAgent }, "POST", `/api/huddles/${s.body.huddle.id}/agents`, { name: "Wren" })).status, 403);
  assert.equal(await enter(C.ada, "/huddle/chat/hd_nope", true).closed, 4404);
});

test("taken to a grid: the same room, both still connected, a link in the channel, the state mirrored (locked when private)", async () => {
  ensureBoardRow("studio", "Studio");
  const sec = editBoard("studio", "test", (doc) => appendSection(doc, "Brackets"));
  const priv = chat.createChannel(chat.personParty(ada), { kind: "private", name: "bracket-team", members: [chat.personParty(kai)] });
  const s = await start(C.ada, priv.id);
  const id = s.body.huddle.id;
  const a = enter(C.ada, s.body.socket, true);
  const wa = await a.next("welcome");
  const k = enter(C.kai, s.body.socket, true);
  await k.next("welcome");
  await until(() => channel(priv.id).huddle?.people.length === 2);

  // Cy can see the grid but isn't in the channel: can't take it there
  assert.equal((await api(C.cy, "POST", `/api/huddles/${id}/place`, { board: "studio", section: sec.id })).status, 404);
  const placed = await ok<{ card: PanelDoc; message: ChatMessage }>(C.ada, "POST", `/api/huddles/${id}/place`, { board: "studio", section: sec.id, request_id: "p1" });
  assert.equal(placed.card.id, id, "the grid's card is the same huddle");
  assert.equal(placed.card.home, "chat");
  assert.equal(placed.card.name, "Ada Lovelace's huddle", "whose it is, not which conversation");
  assert.equal(placed.message.type, "link");
  assert.match(placed.message.text, /Ada Lovelace took the huddle to Studio › Brackets/);
  // once per board
  const twice = await ok<{ card: PanelDoc; message: ChatMessage | null }>(C.kai, "POST", `/api/huddles/${id}/place`, { board: "studio", section: sec.id });
  assert.equal(twice.message, null);
  assert.equal([...boardMaps(getBoard("studio").doc).objects.values()].filter((o) => o.id === id).length, 1);
  assert.equal(channel(priv.id).huddle?.board, "studio");
  assert.equal(channel(priv.id).huddle?.section, sec.id);
  assert.equal(card(s.body.message.id).huddle?.board, "studio");

  // the grid shows it live but locked: no names
  const mirror = huddleStateOf(getBoard("studio").doc, id)!;
  assert.equal(mirror.locked, true);
  assert.deepEqual(mirror.people, []);
  assert.ok(mirror.liveSince);
  a.say({ t: "recording", on: true });
  await k.next("recording");
  await until(() => huddleStateOf(getBoard("studio").doc, id)?.recording?.by === "");

  // nobody dropped: no one left, no one rejoined
  await sleep(100);
  assert.ok(!a.heard.some((m) => m.t === "peer-left" || m.t === "welcome"));
  assert.equal(huddles.huddleRoster("chat", id).length, 2);
  // from the grid: Cy (grid yes, channel no) can't join or read; Kai can join from the grid's card path
  assert.equal(await enter(C.cy, `/huddle/studio/${id}`, true).closed, 4403);
  assert.equal((await api(C.cy, "GET", `/api/huddles/${id}?board=studio`)).status, 403);
  const k2 = enter(C.kai, `/huddle/studio/${id}`, false);
  const wk2 = await k2.next("welcome");
  assert.ok(wk2.peers.some((p) => p.id === wa.you), "the grid's card is the same room");
  k2.ws.close();

  // the session knows where it went and when
  const sid = card(s.body.message.id).huddle!.session!;
  const sess = huddles.readSession(sid)!;
  assert.deepEqual(sess.places?.map((p) => [p.board, p.section, p.by]), [["studio", sec.id, "Ada Lovelace"]]);
  const ev = events.filter((e) => e.session === sid);
  assert.deepEqual(ev.map((e) => e.type), ["start", "placed", "recording-on"]);
  assert.equal(ev[2].board, "studio");
  assert.equal(ev[2].section, sec.id);

  a.ws.close();
  k.ws.close();
  await until(() => Boolean(huddleStateOf(getBoard("studio").doc, id)?.lastEndedAt));
  assert.equal(channel(priv.id).huddle, null);
  assert.equal(events.filter((e) => e.session === sid).at(-1)?.type, "end");
});

test("an open channel's huddle on a grid shows who's in it", async () => {
  const sec = editBoard("studio", "test", (doc) => appendSection(doc, "Open"));
  const open = chat.createChannel(chat.personParty(ada), { kind: "open", name: "shrouds" });
  const s = await start(C.ada, open.id);
  const a = enter(C.ada, s.body.socket, true);
  await a.next("welcome");
  await ok(C.ada, "POST", `/api/huddles/${s.body.huddle.id}/place`, { board: "studio", section: sec.id, x: 40, y: 60 });
  const st = huddleStateOf(getBoard("studio").doc, s.body.huddle.id)!;
  assert.deepEqual(st.people, ["Ada Lovelace"]);
  assert.equal(st.locked, undefined);
  const c = boardMaps(getBoard("studio").doc).objects.get(s.body.huddle.id) as PanelDoc;
  assert.equal(c.name, "Huddle · #shrouds");
  assert.deepEqual([c.x, c.y, c.float], [40, 60, true]);
  // Cy may join an open channel's huddle from the grid
  const cyIn = enter(C.cy, `/huddle/studio/${s.body.huddle.id}`, true);
  await cyIn.next("welcome");
  await until(() => (huddleStateOf(getBoard("studio").doc, s.body.huddle.id)?.people.length ?? 0) === 2);
  cyIn.ws.close();
  a.ws.close();
});

test("one screen share at a time: the server arbitrates", async () => {
  const general = chat.ensureGeneral();
  const s = await start(C.ada, general.id);
  const a = enter(C.ada, s.body.socket, true);
  const wa = await a.next("welcome");
  const k = enter(C.kai, s.body.socket, true);
  const wk = await k.next("welcome");
  const w = enter(C.cy, s.body.socket, false);
  await w.next("welcome");
  a.say({ t: "share", on: true, stream: "screen-a" });
  const sh = await k.next("sharing");
  assert.deepEqual([sh.id, sh.by, sh.stream], [wa.you, "Ada Lovelace", "screen-a"]);
  await w.next("sharing");
  // Kai asks while Ada shares: he's told who has it; nothing changes for the others
  k.say({ t: "share", on: true, stream: "screen-k" });
  assert.equal((await k.next("sharing")).id, wa.you);
  await sleep(60);
  assert.ok(!a.heard.some((m) => m.t === "sharing" && m.id === wk.you));
  // a watcher can't share
  w.say({ t: "share", on: true });
  await sleep(60);
  assert.ok(!a.heard.some((m) => m.t === "sharing" && m.by === "Cy Twombly"));
  // a newcomer hears who's sharing; Ada leaving ends her share
  const late = enter(C.boss, s.body.socket, false);
  await late.next("welcome");
  assert.equal((await late.next("sharing")).by, "Ada Lovelace");
  a.ws.close();
  assert.equal((await k.next("sharing", (m) => m.id === null)).by, null);
  k.say({ t: "share", on: true, stream: "screen-k" });
  assert.equal((await w.next("sharing", (m) => m.id === wk.you)).stream, "screen-k");
  for (const x of [k, w, late]) x.ws.close();
});

test("an agent seated by a person answers what's said to it, aloud and into the transcript; Stop hushes it", async () => {
  const general = chat.ensureGeneral();
  const s = await start(C.ada, general.id);
  const id = s.body.huddle.id;
  const a = enter(C.ada, s.body.socket, true);
  await a.next("welcome");
  const seated = await ok<{ agents: Array<{ name: string; by: string }> }>(C.ada, "POST", `/api/huddles/${id}/agents`, { name: "Wren" });
  assert.deepEqual(seated.agents.map((x) => [x.name, x.by]), [["Wren", "Ada Lovelace"]]);
  assert.deepEqual((await a.next("agents")).agents.map((x) => x.name), ["Wren"]);
  await until(() => channel(general.id).huddle?.agents?.join() === "Wren");

  // alone with one agent: everything is for it
  a.say({ t: "line", text: "What clearance do we need?", source: "speech" });
  const says = await a.next("agent-says");
  assert.equal(says.name, "Wren");
  assert.match(says.text, /Wren here\. I heard Ada Lovelace: “What clearance do we need\?”/);
  const line = await a.next("line", (m) => m.line.source === "agent");
  assert.equal(line.line.speaker, "Wren");
  await a.next("agents", (m) => m.agents[0]?.state === "talking");

  // with two people, only a line that names it
  const k = enter(C.kai, s.body.socket, true);
  await k.next("welcome");
  await sleep(1600);
  a.say({ t: "line", text: "Kai, are you there?", source: "speech" });
  await sleep(300);
  assert.ok(!k.heard.some((m) => m.t === "agent-says"), "not addressed: no answer");
  k.say({ t: "line", text: "wren what about the fillet", source: "speech" });
  assert.match((await a.next("agent-says")).text, /fillet/);
  // Stop: everyone hushes
  a.say({ t: "agent-stop" });
  await k.next("agent-hush");
  // the transcript keeps what the agent said; the session knows it was there
  const sid = card(s.body.message.id).huddle!.session!;
  const sess = huddles.readSession(sid)!;
  assert.equal(sess.lines.filter((l) => l.source === "agent").length, 2);
  assert.deepEqual(sess.agents, ["Wren"]);
  assert.equal(huddles.addressedAgent(["Wren"], 2, { text: "Hey @wren!", source: "typed" }), "Wren");
  assert.equal(huddles.addressedAgent(["Wren"], 2, { text: "wrench please", source: "typed" }), null);
  assert.equal(huddles.addressedAgent(["Wren"], 1, { text: "Wren here", source: "agent" }), null);
  // let it go
  await ok(C.kai, "POST", `/api/huddles/${id}/agents`, { name: "wren", remove: true });
  await a.next("agents", (m) => m.agents.length === 0);
  a.ws.close();
  k.ws.close();
});

test("a grid's own huddle still works as before over the server's socket path", async () => {
  ensureBoardRow("grid-h", "Grid H");
  const sec = editBoard("grid-h", "test", (doc) => appendSection(doc, "Room"));
  const h = huddles.huddleForInvite("grid-h", { name: "Ada" }, { id: "pnl_gridh", sectionId: sec.id, name: "Review", channel: "", x: 0, y: 0 });
  const a = enter(C.ada, `/huddle/grid-h/${h.id}`, true);
  await a.next("welcome");
  await until(() => huddleStateOf(getBoard("grid-h").doc, h.id)?.people.join() === "Ada Lovelace");
  const got = await ok<{ huddle: { id: string }; sessions: unknown[] }>(C.kai, "GET", `/api/huddles/${h.id}?board=grid-h`);
  assert.equal(got.sessions.length, 1);
  a.ws.close();
  await until(() => Boolean(huddleStateOf(getBoard("grid-h").doc, h.id)?.lastEndedAt));
  assert.equal(events.filter((e) => e.huddleId === h.id).map((e) => `${e.type}:${e.home}:${e.board}`).join(), "start:board:grid-h,end:board:grid-h");
});

test("listing channels shows the live huddle to members", async () => {
  const dm = chat.openDirect([chat.personParty(kai), chat.personParty(cy)]);
  const s = await start(C.kai, dm.id);
  const list = await ok<{ channels: ChatChannelView[] }>(C.cy, "GET", "/api/chat");
  assert.equal(list.channels.find((c) => c.id === dm.id)?.huddle?.id, s.body.huddle.id);
  const adaList = await ok<{ channels: ChatChannelView[] }>(C.ada, "GET", "/api/chat");
  assert.ok(!adaList.channels.some((c) => c.id === dm.id));
});

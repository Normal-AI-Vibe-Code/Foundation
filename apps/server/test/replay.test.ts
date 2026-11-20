/**
 * Replay and the clock (ChatForm R1) on the server, over real sockets and routes: a take starts when a
 * recorded session is on a grid (recording on, placed while recording, a grid's own huddle) and stops with
 * recording off or the end; bursts are merged; the caps stop it honestly; a restart closes it at its last
 * change; access (a channel member without the grid gets the conversation and no take; a non-member gets
 * nothing; an admin isn't special in a DM); the take's wire rebuilds the exact document at chosen times;
 * the agents' timeline says who said what and what changed; add_replay is refused for a viewer; nothing
 * writes a board while replaying; an agent's voice in a huddle through the scripted runtime; attaching from
 * the Vision Archive (a stand-in) and putting a chat file on a grid.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket, WebSocketServer } from "ws";
import type { HuddleWire, ReplayTimeline } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-replay-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_HUDDLE_END_GRACE_MS = "60";
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_REPLAY_BURST_MS = "80";
delete process.env.FOUNDATION_CHAT_PREVIEWS;

const { run, one } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const huddles = await import("../src/huddles.ts");
const replay = await import("../src/replay.ts");
const { runTool } = await import("../src/tools.ts");
const { handleUpgrade } = await import("../src/sockets.ts");
const { storeFile } = await import("../src/files.ts");
const { setMember } = await import("../src/members.ts");
const { closeBoards, createBoardRow, editBoard, getBoard, onBoardUpdate } = await import("../src/boards.ts");
const { boardMaps, appendSection, decodeTake, encodeTake, setNoteText, noteTextOf, TakePlayer } = await import("@foundation/protocol");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = auth.upsertUser("kai@formindustries.com", "Kai Moreno");
const cy = auth.upsertUser("cy@formindustries.com", "Cy Twombly");
const vic = auth.upsertUser("vic@formindustries.com", "Vic Viewer");
for (const u of [ada, kai, cy]) run("update users set role = 'member' where id = ?", u.id);
run("update users set role = 'viewer' where id = ?", vic.id);
const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), kai: cookieOf(kai.id), cy: cookieOf(cy.id), vic: cookieOf(vic.id) };

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  huddles.huddleRoutes(r);
  replay.replayRoutes(r);
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
  replay._forgetCaptures();
  server?.closeAllConnections();
  server?.close();
  closeBoards();
});

async function api<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://${base}${path}`, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* binary or text */
  }
  return { status: res.status, body: parsed as T, text, bytes: buf };
}
const ok = async <T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown) => {
  const r = await api<T>(cookie, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`);
  return r;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
};

function enter(cookie: string, path: string) {
  const ws = new WebSocket(`ws://${base}${path}?send=1`, { headers: { cookie, origin: "http://localhost:1430" } });
  sockets.push(ws);
  ws.on("error", () => undefined);
  const heard: HuddleWire[] = [];
  ws.on("message", (raw) => heard.push(JSON.parse(String(raw))));
  const opened = new Promise<void>((r) => ws.on("message", () => r()));
  return { ws, heard, opened, say: (m: unknown) => ws.send(JSON.stringify(m)) };
}

/** a grid with one section (a members-only one when `members` is given) */
function grid(name: string, members?: Array<{ id: string; role: "owner" | "editor" | "viewer" }>) {
  const id = createBoardRow(name);
  const sec = editBoard(id, "system", (doc) => appendSection(doc, "Brackets"));
  for (const m of members ?? []) setMember(id, m.id, m.role);
  return { id, section: sec.id };
}
const addNote = (board: string, section: string, text: string, name = "Note") =>
  editBoard(board, "agent", (doc) => {
    const id = `note_${Math.random().toString(36).slice(2, 9)}`;
    boardMaps(doc).objects.set(id, { id, kind: "note", sectionId: section, name, x: 0, y: 0, float: false, bornAt: Date.now(), w: 300, h: 200 });
    setNoteText(doc, id, text);
    return id;
  });
const moveCard = (board: string, id: string, x: number, y: number) =>
  editBoard(board, "agent", (doc) => {
    const m = boardMaps(doc);
    const o = m.objects.get(id)!;
    m.objects.set(id, { ...o, x, y, float: true });
  });
/** the board's cards and note texts, as JSON: what a rebuilt document must equal */
function stateOf(doc: Y.Doc) {
  const m = boardMaps(doc);
  const objects = Object.fromEntries([...m.objects.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, o]) => [k, { ...o, ...(o.kind === "note" ? { text: noteTextOf(doc, o) } : {}) }]));
  return JSON.stringify({ objects, sections: [...m.sections.keys()].sort() });
}
const takesOf = (session: string) => one<{ n: number }>("select count(*) as n from replay_takes where session_id = ?", session)!.n;
const parsedTakes = (session: string) =>
  JSON.parse(one<{ j: string }>("select json_group_array(json_object('id', id, 'board', board_id, 'ended', ended_at, 'updates', updates, 'truncated', truncated)) as j from (select * from replay_takes where session_id = ? order by started_at, rowid)", session)?.j ?? "[]") as Array<{ id: string; board: string; ended: number | null; updates: number; truncated: string | null }>;

/** a channel huddle with Ada (and Kai) in it, its session id, and the sockets */
async function liveHuddle(channelId: string, people = [C.ada, C.kai]) {
  const s = await ok<{ huddle: { id: string }; message: { id: string }; socket: string }>(people[0], "POST", `/api/chat/channels/${channelId}/huddle`, { request_id: `r${Math.random()}` });
  const socks = [];
  for (const p of people) {
    const x = enter(p, s.body.socket);
    await x.opened;
    socks.push(x);
  }
  await until(() => Boolean(chat.getMessage(s.body.message.id)?.huddle?.session));
  return { id: s.body.huddle.id, card: s.body.message.id, session: chat.getMessage(s.body.message.id)!.huddle!.session!, socks };
}
const leave = async (h: { socks: Array<{ ws: WebSocket }>; card: string }) => {
  for (const x of h.socks) x.ws.close();
  await until(() => Boolean(chat.getMessage(h.card)?.huddle?.endedAt), 4000);
};

test("a take: placed while recording starts it, bursts merge, recording off stops it; the wire rebuilds the exact board at chosen times", async () => {
  const general = chat.ensureGeneral();
  const g = grid("Bracket review");
  const before = addNote(g.id, g.section, "Before the call");
  const h = await liveHuddle(general.id);
  // recording first, then taken to the grid: the take starts at the placement
  h.socks[0].say({ t: "recording", on: true });
  await until(() => chat.getChannel(general.id)!.huddle?.recording === true);
  assert.equal(takesOf(h.session), 0, "not on a grid yet: nothing to keep");
  await ok(C.ada, "POST", `/api/huddles/${h.id}/place`, { board: g.id, section: g.section, request_id: "p1" });
  await until(() => replay.liveTakes().length === 1);
  const takeId = replay.liveTakes()[0];

  // the state at chosen times, as the live board was
  const snaps: Array<{ at: number; state: string }> = [{ at: Date.now(), state: stateOf(getBoard(g.id).doc) }];
  await sleep(30);
  // a burst: three edits within 80 ms are one kept change
  const n1 = addNote(g.id, g.section, "Kai: a 2 mm fillet", "Fillet");
  editBoard(g.id, "agent", (doc) => setNoteText(doc, n1, "Kai: a 2 mm fillet on the inside corner"));
  moveCard(g.id, before, 400, 40);
  await sleep(200);
  snaps.push({ at: Date.now(), state: stateOf(getBoard(g.id).doc) });
  await sleep(30);
  moveCard(g.id, n1, 820, 60);
  await sleep(200);
  snaps.push({ at: Date.now(), state: stateOf(getBoard(g.id).doc) });
  await sleep(30);
  editBoard(g.id, "agent", (doc) => boardMaps(doc).objects.delete(before));
  await sleep(200);
  snaps.push({ at: Date.now(), state: stateOf(getBoard(g.id).doc) });

  h.socks[0].say({ t: "recording", on: false });
  await until(() => replay.liveTakes().length === 0);
  const rows = parsedTakes(h.session);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updates, 3, "three bursts kept, the first one merged from three edits");
  assert.ok(rows[0].ended, "recording off ended it");
  // more edits after recording stopped aren't kept
  addNote(g.id, g.section, "after");
  await sleep(150);
  assert.equal(parsedTakes(h.session)[0].updates, 3);

  // the wire: framing round trip, then the exact document at each chosen time
  const r = await ok(C.kai, "GET", `/api/replay/takes/${takeId}`);
  const frames = decodeTake(r.bytes);
  assert.equal(frames.head.id, takeId);
  assert.equal(frames.updates.length, 3);
  assert.deepEqual(decodeTake(encodeTake(frames)).updates.map((u) => [u.at, u.update.length]), frames.updates.map((u) => [u.at, u.update.length]));
  const player = new TakePlayer(frames, 2);
  for (const s of snaps) assert.equal(stateOf(player.docAt(s.at)), s.state, `the board at +${s.at - frames.head.from} ms`);
  // backwards (from a checkpoint) and forwards again agree
  assert.equal(stateOf(player.docAt(snaps[0].at)), snaps[0].state);
  assert.equal(stateOf(player.docAt(snaps[3].at)), snaps[3].state);
  assert.equal(stateOf(player.docAt(snaps[1].at)), snaps[1].state);
  await leave(h);
});

test("a grid's own huddle records its board; the end stops the take; the timeline and the agents' text say what changed", async () => {
  const g = grid("Shroud");
  const hud = editBoard(g.id, "system", (doc) => {
    const id = "hud_shroud1";
    boardMaps(doc).objects.set(id, { id, kind: "panel", panel: "huddle", sectionId: g.section, name: "Shroud huddle", x: 0, y: 0, float: true, bornAt: Date.now(), w: 560, h: 420, ports: [] });
    return id;
  });
  const a = enter(C.ada, `/huddle/${g.id}/${hud}`);
  await a.opened;
  const k = enter(C.kai, `/huddle/${g.id}/${hud}`);
  await k.opened;
  await sleep(100);
  a.say({ t: "recording", on: true });
  await until(() => replay.liveTakes().length === 1);
  a.say({ t: "line", text: "Let's thicken the shroud to 3 mm", source: "typed" });
  await sleep(100);
  addNote(g.id, g.section, "Decision: shroud wall 3 mm", "Shroud");
  await sleep(200);
  // everyone leaves while recording: the end stops it
  a.ws.close();
  k.ws.close();
  await until(() => replay.liveTakes().length === 0);
  const sid = huddles.huddleArchive(g.id, hud, 1)[0].id;
  const t = (await ok<ReplayTimeline>(C.kai, "GET", `/api/replay/${sid}`)).body;
  assert.equal(t.session.home, "board");
  assert.equal(t.takes.length, 1);
  assert.equal(t.takes[0].board, g.id);
  assert.equal(t.takes[0].section, g.section);
  assert.equal(t.takes[0].sectionName, "Brackets");
  assert.ok(t.changes.length >= 1);
  assert.ok(t.lines.some((l) => l.text.includes("3 mm")));
  // the agents' timeline: who said what, and what changed on the grid, at offsets
  const text = String(await runTool({ boardId: g.id, actor: "Kai's agent", userId: kai.id }, "replay_timeline", { session: sid }));
  assert.match(text, /Shroud huddle/);
  assert.match(text, /\[\+\d\d:\d\d\] Ada Lovelace: Let's thicken the shroud to 3 mm/);
  assert.match(text, /grid Shroud › Brackets: an agent added a note “Shroud” in Brackets: “Decision: shroud wall 3 mm”/);
  assert.match(text, /Kept the grid Shroud › Brackets/);
});

test("caps: a take stops at its span or its bytes and says so; a restart closes it at its last change", async () => {
  const general = chat.ensureGeneral();
  const g = grid("Caps");
  const h = await liveHuddle(general.id, [C.ada]);
  await ok(C.ada, "POST", `/api/huddles/${h.id}/place`, { board: g.id, section: g.section, request_id: "pc" });
  process.env.FOUNDATION_REPLAY_MAX_MS = "400";
  h.socks[0].say({ t: "recording", on: true });
  await until(() => replay.liveTakes().length === 1);
  delete process.env.FOUNDATION_REPLAY_MAX_MS;
  addNote(g.id, g.section, "inside the span");
  await until(() => replay.liveTakes().length === 0, 2000);
  let rows = parsedTakes(h.session);
  assert.equal(rows.length, 1);
  assert.match(rows[0].truncated ?? "", /Stopped keeping the grid at \d+ s/);
  assert.equal(rows[0].updates, 1);

  // bytes: a second stretch with a tiny cap
  h.socks[0].say({ t: "recording", on: false });
  await sleep(80);
  process.env.FOUNDATION_REPLAY_MAX_BYTES = "200";
  h.socks[0].say({ t: "recording", on: true });
  await until(() => replay.liveTakes().length === 1);
  addNote(g.id, g.section, "x".repeat(400));
  await until(() => replay.liveTakes().length === 0, 2000);
  delete process.env.FOUNDATION_REPLAY_MAX_BYTES;
  rows = parsedTakes(h.session);
  assert.equal(rows.length, 2, "one take per recorded stretch");
  assert.match(rows[1].truncated ?? "", /MB of changes/);

  // a restart mid-take: the in-memory keeping is gone; the row is closed at its last change, saying why
  h.socks[0].say({ t: "recording", on: false });
  await sleep(80);
  h.socks[0].say({ t: "recording", on: true });
  await until(() => replay.liveTakes().length === 1);
  addNote(g.id, g.section, "kept before the restart");
  await sleep(200);
  replay._forgetCaptures();
  addNote(g.id, g.section, "after the restart: not kept");
  await sleep(150);
  assert.ok(replay.recoverOpenTakes() >= 1);
  rows = parsedTakes(h.session);
  const last = rows[2];
  assert.equal(last.updates, 1);
  assert.match(last.truncated ?? "", /server restarted/);
  const kept = one<{ at: number }>("select max(at) as at from replay_updates where take_id = ?", last.id)!.at;
  assert.equal(last.ended, kept);
  await leave(h);
});

test("access: the conversation without a grid you can't open; nothing for a non-member; an admin isn't special in a DM", async () => {
  // a private channel of Ada, Kai and Cy; the grid is Ada's and Kai's only
  const priv = chat.createChannel(chat.personParty(ada), { kind: "private", name: `bracket-${Date.now().toString(36)}`, members: [chat.personParty(kai), chat.personParty(cy)] });
  const g = grid("Members only", [
    { id: ada.id, role: "owner" },
    { id: kai.id, role: "editor" },
  ]);
  const h = await liveHuddle(priv.id);
  await ok(C.ada, "POST", `/api/huddles/${h.id}/place`, { board: g.id, section: g.section, request_id: "pa" });
  h.socks[0].say({ t: "recording", on: true });
  await until(() => replay.liveTakes().length === 1);
  addNote(g.id, g.section, "secret grid note");
  await sleep(150);
  chat.postMessage(priv.id, chat.personParty(kai), { text: "posted during the huddle" });
  h.socks[0].say({ t: "recording", on: false });
  await until(() => replay.liveTakes().length === 0);
  await leave(h);
  const takeId = parsedTakes(h.session)[0].id;

  const kaiT = (await ok<ReplayTimeline>(C.kai, "GET", `/api/replay/${h.session}`)).body;
  assert.equal(kaiT.takes.length, 1);
  assert.ok(kaiT.messages.some((m) => m.text === "posted during the huddle"), "the channel's messages during it");
  assert.equal(kaiT.gridHidden, undefined);
  // Cy: in the channel, not on the grid: the conversation, no take, and told so
  const cyT = (await ok<ReplayTimeline>(C.cy, "GET", `/api/replay/${h.session}`)).body;
  assert.equal(cyT.takes.length, 0);
  assert.equal(cyT.changes.length, 0);
  assert.equal(cyT.places.length, 0);
  assert.match(cyT.gridHidden ?? "", /a grid you can't open/);
  assert.ok(cyT.lines.length >= 1);
  assert.equal((await api(C.cy, "GET", `/api/replay/takes/${takeId}`)).status, 403);
  // Vic (a viewer, not in it) and the admin (not in it): nothing, not even that it exists
  assert.equal((await api(C.vic, "GET", `/api/replay/${h.session}`)).status, 404);
  assert.equal((await api(C.vic, "GET", `/api/replay/takes/${takeId}`)).status, 404);
  assert.equal((await api(C.boss, "GET", `/api/replay/${h.session}`)).status, 404, "an admin doesn't read a private channel's huddle");
  assert.equal((await api(C.boss, "GET", `/api/replay/takes/${takeId}`)).status, 404);
  // the agents' timeline obeys the same rule
  assert.match(String(await runTool({ boardId: "company", actor: "Vic's agent", userId: vic.id }, "replay_timeline", { session: h.session })), /No session/);

  // a DM: the admin isn't special
  const dm = chat.openDirect([chat.personParty(ada), chat.personParty(kai)]);
  const d = await liveHuddle(dm.id);
  await leave(d);
  assert.equal((await api(C.boss, "GET", `/api/replay/${d.session}`)).status, 404);
  assert.equal((await api(C.kai, "GET", `/api/replay/${d.session}`)).status, 200);
});

test("the clock card: add_replay puts it in the session's section once, refused for a viewer; replaying writes nothing to any board", async () => {
  const general = chat.ensureGeneral();
  const g = grid("Clock");
  const other = editBoard(g.id, "system", (doc) => appendSection(doc, "Elsewhere"));
  run("insert into board_roles (board_id, user_id, role, set_at) values (?, ?, 'viewer', ?)", g.id, kai.id, Date.now());
  const h = await liveHuddle(general.id, [C.ada]);
  await ok(C.ada, "POST", `/api/huddles/${h.id}/place`, { board: g.id, section: g.section, request_id: "pk" });
  h.socks[0].say({ t: "recording", on: true });
  await until(() => replay.liveTakes().length === 1);
  addNote(g.id, g.section, "during");
  await sleep(150);
  await leave(h);
  await until(() => replay.liveTakes().length === 0);

  // a viewer of this grid can't add it (a board write like any card)
  await assert.rejects(runTool({ boardId: g.id, actor: "Kai Moreno", userId: kai.id, person: true }, "add_replay", { session: h.session }), (e: Error & { status?: number }) => e.status === 403);
  // Ada can: it lands in the section the huddle was held over, once
  const one1 = (await runTool({ boardId: g.id, actor: "Ada Lovelace", userId: ada.id, person: true }, "add_replay", { session: h.session })) as { id: string; section: string };
  assert.equal(one1.section, g.section);
  const again = (await runTool({ boardId: g.id, actor: "Ada Lovelace", userId: ada.id, person: true }, "add_replay", { session: h.session })) as { id: string };
  assert.equal(again.id, one1.id, "asked twice, added once");
  const card = boardMaps(getBoard(g.id).doc).objects.get(one1.id)!;
  assert.equal(card.kind === "panel" && card.panel, "replay");
  assert.equal(card.kind === "panel" && card.sessionId, h.session);
  assert.equal(card.kind === "panel" && `${card.w}×${card.h}`, "360×120");
  // in another section when asked
  const there = (await runTool({ boardId: g.id, actor: "Ada's agent", userId: ada.id }, "add_replay", { session: h.session, section: other.id })) as { section: string };
  assert.equal(there.section, other.id);
  // a session the asker can't see: no card
  const priv = chat.createChannel(chat.personParty(kai), { kind: "private", name: `kai-${Date.now().toString(36)}` });
  const ph = await liveHuddle(priv.id, [C.kai]);
  await leave(ph);
  await assert.rejects(runTool({ boardId: g.id, actor: "Ada Lovelace", userId: ada.id, person: true }, "add_replay", { session: ph.session }), (e: Error & { status?: number }) => e.status === 404);

  // replaying (the timeline, every take, the agents' text) writes nothing to any board
  let writes = 0;
  const off = onBoardUpdate(() => writes++);
  const t = (await ok<ReplayTimeline>(C.ada, "GET", `/api/replay/${h.session}`)).body;
  assert.ok(t.takes.length >= 1);
  for (const k of t.takes) {
    const frames = decodeTake((await ok(C.ada, "GET", `/api/replay/takes/${k.id}`)).bytes);
    const p = new TakePlayer(frames);
    p.docAt(k.from);
    p.docAt(k.to ?? Date.now());
  }
  await runTool({ boardId: g.id, actor: "Ada's agent", userId: ada.id }, "replay_timeline", { session: h.session });
  off();
  assert.equal(writes, 0, "nothing written while looking back");
});

test("an agent's voice in a huddle: huddleReply runs a chat turn (scripted) and answers in plain spoken words", async () => {
  const { huddleReply, spoken } = await import("../src/chatagents.ts");
  const ctrl = new AbortController();
  const line = { id: "l1", at: Date.now(), speaker: "Kai Moreno", text: "Wren, how thick is the shroud?", source: "typed" as const };
  const said = await huddleReply({ agent: "Wren", user: ada, huddleId: "hd_test", lines: [line], line, signal: ctrl.signal });
  assert.equal(said, "Wren here. I heard Kai Moreno: “Wren, how thick is the shroud?”.");
  // the run was a chat turn kept as its own session
  const r = one<{ session_id: string }>("select session_id from agent_runs where prompt like '%how thick is the shroud%' order by created_at desc limit 1")!;
  assert.match(r.session_id, /^ses_huddle[0-9a-f]{16}$/);
  assert.equal(spoken("**Wren** here. See [the card](https://x). \n- one\n- two"), "Wren here. See the card. one two");
});

test("attaching: the Vision Archive (a stand-in) lists its projects and copies an asset in with where it came from; unreachable says so; a chat file goes onto a grid", async () => {
  // the Archive is down: honest
  process.env.VISION_ARCHIVE_URL = "http://127.0.0.1:9";
  const down = (await ok<{ available: boolean; why: string; origin: string }>(C.ada, "GET", "/api/chat/attach/vision")).body;
  assert.equal(down.available, false);
  assert.match(down.why, /isn't answering at http:\/\/127\.0\.0\.1:9/);

  // a stand-in Archive: the bridge's catalog and one asset's bytes
  const stl = Buffer.from("solid part\nendsolid part\n");
  const standin = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/api/bridge") return void res.writeHead(404).end();
    if (u.searchParams.get("asset") === "a-stl") return void res.writeHead(200, { "content-type": "model/stl" }).end(stl);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        version: 1,
        seed: false,
        items: [{ id: "i1", project: "airform-one", title: "Rim drive bracket", kind: "model", category: "Product", revision: 3, archived: false, assets: [{ id: "a-stl", name: "bracket.stl", kind: "model", mime: "model/stl", size: stl.length, url: "/api/assets/a-stl", sha256: "x" }] }],
        assets: [],
        reviews: [],
      }),
    );
  });
  await new Promise<void>((r) => standin.listen(0, "127.0.0.1", r));
  process.env.VISION_ARCHIVE_URL = `http://127.0.0.1:${(standin.address() as AddressInfo).port}`;
  try {
    const list = (await ok<{ available: boolean; projects: Array<{ name: string; items: Array<{ title: string; assets: Array<{ id: string; name: string }> }> }> }>(C.ada, "GET", "/api/chat/attach/vision")).body;
    assert.equal(list.available, true);
    assert.equal(list.projects[0].name, "airform-one");
    assert.equal(list.projects[0].items[0].assets[0].name, "bracket.stl");
    const got = (await ok<{ file: { id: string; name: string; board_id: string; about: string } }>(C.ada, "POST", "/api/chat/attach/vision", { asset: "a-stl" })).body.file;
    assert.equal(got.name, "bracket.stl");
    assert.equal(got.board_id, "chat");
    assert.match(got.about, /From the Vision Archive .*“Rim drive bracket”, airform-one, revision 3 · bracket\.stl/);
    assert.equal((await api(C.ada, "POST", "/api/chat/attach/vision", { asset: "../etc" })).status, 400, "only an Archive asset id, only from the configured Archive");

    // it's Ada's chat upload; posted in #general, Kai can see it; Kai puts it on a grid he can edit
    const general = chat.ensureGeneral();
    chat.postMessage(general.id, chat.personParty(ada), { text: "the bracket", files: [got.id] });
    const g = grid("CAD review");
    const placed = (await runTool({ boardId: g.id, actor: "Kai Moreno", userId: kai.id, person: true }, "place_file", { file: got.id, section: g.section })) as { id: string; file: string };
    const card = boardMaps(getBoard(g.id).doc).objects.get(placed.id)!;
    assert.equal(card.kind === "panel" && card.panel, "file");
    assert.equal(card.kind === "panel" && card.fileId, placed.file);
    assert.notEqual(placed.file, got.id, "the grid has its own record of the same bytes");
    // a file Cy can't see (a DM's) can't be placed by Cy
    const dm = chat.openDirect([chat.personParty(ada), chat.personParty(kai)]);
    const secret = await storeFile(Buffer.from("solid s\nendsolid s\n"), { name: "s.stl", mime: "model/stl", boardId: "chat", userId: ada.id });
    chat.postMessage(dm.id, chat.personParty(ada), { text: "", files: [secret.id] });
    await assert.rejects(runTool({ boardId: g.id, actor: "Cy Twombly", userId: cy.id, person: true }, "place_file", { file: secret.id }), (e: Error & { status?: number }) => e.status === 404);
  } finally {
    standin.closeAllConnections();
    standin.close();
    delete process.env.VISION_ARCHIVE_URL;
  }
});

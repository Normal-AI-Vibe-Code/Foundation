/**
 * The timeline (docs/timeline.md) on the server: a grid's history is kept from the document itself and rebuilt
 * exactly at chosen moments by a client's TakePlayer (a card since deleted is there, one added later is not);
 * events say who did what, from the session or the tool call, never a request's body; reading writes nothing to
 * any board; a members-only grid is 404 to anyone else (routes and the tool), a viewer reads; a conversation's
 * words reach only its members (an admin is no exception) and a removed message is gone; an agent's answer is
 * withheld from others once it read beyond the grid, and shown to its person; an agent's tool call is one event
 * per request_id, with the agent as actor and its person as `for`; a voice note is the transaction's person's;
 * the budget folds old history and it still rebuilds; thinning keeps the end state.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import type { ObjectDoc, TimelineSlice, TimelineEvent } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-timeline-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_SCRIPT_STEP_MS = "5";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";
process.env.FOUNDATION_TIMELINE_BURST_MS = "40";
process.env.FOUNDATION_TIMELINE_READ_MS = "80";
process.env.FOUNDATION_TIMELINE_CURSOR_MS = "30";
delete process.env.FOUNDATION_CHAT_PREVIEWS;

const { run, one, all } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const timeline = await import("../src/timeline.ts");
const { runTool, httpToolCtx } = await import("../src/tools.ts");
const { startRun, followRun } = await import("../src/agent.ts");
const { joinCrew, leaveCrew, _resetCrew } = await import("../src/crew.ts");
const { writeAsk } = await import("../src/machineasks.ts");
const { setMember } = await import("../src/members.ts");
const { attachConnection, closeBoards, createBoardRow, editBoard, getBoard, onBoardUpdate } = await import("../src/boards.ts");
const { boardMaps, appendSection, decodeTake, setNoteText, noteTextOf, TakePlayer, uid, TABLE_PORT, setTableCells } = await import("@foundation/protocol");
const { actorScope } = await import("../src/audit.ts");
await import("../src/flows.ts"); // its fills (origin "flows") run on timers: who armed one is not who did it

timeline.startTimeline();

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = auth.upsertUser("kai@formindustries.com", "Kai Moreno");
const vic = auth.upsertUser("vic@formindustries.com", "Vic Viewer");
for (const u of [ada, kai]) run("update users set role = 'member' where id = ?", u.id);
run("update users set role = 'viewer' where id = ?", vic.id);
const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), kai: cookieOf(kai.id), vic: cookieOf(vic.id) };

let server: Server;
let base = "";
const r = new Router();
chat.chatRoutes(r);
timeline.timelineRoutes(r);
before(async () => {
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
const awarenesses: awarenessProtocol.Awareness[] = [];
after(() => {
  for (const a of awarenesses) a.destroy();
  _resetCrew();
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
    /* binary */
  }
  return { status: res.status, body: parsed as T, text, bytes: buf };
}
const ok = async <T = Record<string, unknown>>(cookie: string, method: string, path: string) => {
  const res = await api<T>(cookie, method, path);
  assert.ok(res.status < 300, `${method} ${path} → ${res.status} ${res.text.slice(0, 300)}`);
  return res;
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const slice = async (cookie: string, board: string, q = "") => (await ok<TimelineSlice>(cookie, "GET", `/api/boards/${board}/timeline?from=0&to=${Date.now() + 1000}${q}`)).body;
const kinds = (s: TimelineSlice, kind: string) => s.events.filter((e) => e.kind === kind);

/** a person's browser on a board: its edits reach the server over its sync socket, and its pointer over awareness */
function personOn(boardId: string, user: { id: string; name: string }) {
  const server = getBoard(boardId).doc;
  const ws = Object.assign(new EventEmitter(), { readyState: 1, binaryType: "", send() {}, close() {} });
  attachConnection(boardId, ws as never, false, user.id);
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
  const aw = new awarenessProtocol.Awareness(local);
  awarenesses.push(aw);
  const edit = (fn: (d: Y.Doc) => void) => {
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server, Y.encodeStateVector(local)));
    const sv = Y.encodeStateVector(server);
    local.transact(() => fn(local));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(local, sv));
    ws.emit("message", Buffer.from(encoding.toUint8Array(enc)));
  };
  const point = (x: number, y: number) => say({ user: { name: user.name, color: "#c33" }, cursor: { x, y } });
  /** any presence this window claims, as it is sent */
  const say = (state: Record<string, unknown>) => {
    aw.setLocalState(state);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(aw, [aw.clientID]));
    ws.emit("message", Buffer.from(encoding.toUint8Array(enc)));
  };
  return { edit, point, say, leave: () => ws.emit("close"), local };
}

const note = (sectionId: string, name: string, extra: Partial<ObjectDoc> = {}): ObjectDoc => ({ id: uid("note"), kind: "note", sectionId, name, x: 0, y: 0, float: false, bornAt: Date.now(), w: 320, h: 200, ...extra }) as ObjectDoc;

/** a grid with one section (members-only when `members` is given) */
function grid(name: string, members?: Array<{ id: string; role: "owner" | "editor" | "viewer" }>) {
  const id = createBoardRow(name);
  const sec = editBoard(id, "system", (doc) => appendSection(doc, "Brackets"));
  for (const m of members ?? []) setMember(id, m.id, m.role);
  return { id, section: sec.id };
}

/** the board's cards and note texts: what a rebuilt document must equal */
function stateOf(doc: Y.Doc) {
  const m = boardMaps(doc);
  const objects = Object.fromEntries([...m.objects.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, o]) => [k, { ...o, ...(o.kind === "note" ? { text: noteTextOf(doc, o) } : {}) }]));
  return JSON.stringify({ objects, sections: [...m.sections.keys()].sort() });
}

test("add then delete a card: both events, the person's, in its section; history at a moment between holds the card, and not the one added later", async () => {
  const g = grid("Rim drive");
  const p = personOn(g.id, ada);
  p.point(10, 20);
  const card = note(g.section, "Fillet");
  p.edit((d) => boardMaps(d).objects.set(card.id, card));
  p.edit((d) => setNoteText(d, card.id, "a 2 mm fillet"));
  timeline.flushTimeline();
  await sleep(5);
  const between = Date.now();
  const withCard = stateOf(getBoard(g.id).doc);
  await sleep(5);
  p.edit((d) => boardMaps(d).objects.delete(card.id));
  timeline.flushTimeline();
  await sleep(5);
  const later = note(g.section, "Later");
  p.edit((d) => boardMaps(d).objects.set(later.id, later));
  p.point(40, 50);
  await sleep(80); // a pointer sample or two, and the burst
  timeline.flushTimeline();

  const s = await slice(C.ada, g.id);
  const add = kinds(s, "card.add").find((e) => e.object === card.id)!;
  const rm = kinds(s, "card.remove").find((e) => e.object === card.id)!;
  assert.ok(add && rm, "both the add and the remove");
  for (const e of [add, rm]) {
    assert.deepEqual([e.actor.kind, e.actor.id, e.actor.name], ["person", ada.id, "Ada Lovelace"]);
    assert.equal(e.section, g.section);
    assert.deepEqual(e.data, { card: "note", name: "Fillet" });
  }
  assert.ok(add.at <= rm.at);
  assert.equal(kinds(s, "card.edit").filter((e) => e.object === card.id).length, 0, "words written in the same burst as the card are its making, not an edit");
  assert.deepEqual(s.sections, [{ id: g.section, name: "Brackets" }]);
  assert.equal(s.density.length, 240);
  assert.ok(s.density.reduce((a, b) => a + b, 0) >= 3);
  // Ada is on the grid: a span that goes on
  const here = kinds(s, "person.here").find((e) => e.actor.id === ada.id)!;
  assert.equal(here.end, null);

  // the history, as a client plays it
  const res = await ok(C.kai, "GET", `/api/boards/${g.id}/history?from=0&to=${Date.now() + 1000}`);
  const frames = decodeTake(res.bytes);
  assert.equal(frames.head.board, g.id);
  assert.equal((frames.head as { start?: number }).start, s.start);
  const player = new TakePlayer(frames, 2);
  const at = (t: number) => boardMaps(player.docAt(t)).objects;
  assert.ok(at(between).has(card.id), "the card that was there then, though it is deleted now");
  assert.equal(noteTextOf(player.docAt(between), at(between).get(card.id)!), "a 2 mm fillet");
  assert.equal(stateOf(player.docAt(between)), withCard, "exactly the board as it was");
  assert.ok(!at(between).has(later.id), "a card added later isn't there yet");
  assert.ok(!at(Date.now()).has(card.id));
  assert.equal(stateOf(player.docAt(Date.now())), stateOf(getBoard(g.id).doc), "and now is now");
  assert.ok(frames.cursors.some((c) => c.who.some((w) => w.n === "Ada Lovelace" && w.x === 40)), "where Ada pointed");

  // she leaves: her span ends
  p.leave();
  await sleep(20);
  const after2 = await slice(C.ada, g.id);
  assert.ok(typeof kinds(after2, "person.here").find((e) => e.actor.id === ada.id)!.end === "number");
});

test("reading the timeline, the history and read_timeline writes nothing to any board", async () => {
  const g = grid("Quiet reading");
  editBoard(g.id, "agent", (doc) => boardMaps(doc).objects.set("n1", note(g.section, "One")));
  timeline.flushTimeline();
  let writes = 0;
  const off = onBoardUpdate(() => writes++);
  await ok(C.ada, "GET", `/api/boards/${g.id}/timeline`);
  await ok(C.ada, "GET", `/api/boards/${g.id}/timeline?section=${g.section}&from=0&to=${Date.now()}`);
  const h = await ok(C.ada, "GET", `/api/boards/${g.id}/history?from=0&to=${Date.now()}`);
  new TakePlayer(decodeTake(h.bytes)).docAt(Date.now());
  await runTool({ boardId: g.id, actor: "Ada's agent", userId: ada.id }, "read_timeline", {});
  off();
  assert.equal(writes, 0, "nothing written while looking back");
});

test("access: a members-only grid is 404 to anyone else, by both routes and the tool; a viewer reads; ranges are checked", async () => {
  const g = grid("Members only", [{ id: ada.id, role: "owner" }]);
  for (const path of [`/api/boards/${g.id}/timeline`, `/api/boards/${g.id}/history`]) {
    assert.equal((await api(C.kai, "GET", path)).status, 404, `${path} for a non-member`);
    assert.equal((await api(C.ada, "GET", path)).status, 200, `${path} for a member`);
  }
  assert.equal((await api(C.kai, "GET", `/api/boards/no-such-grid/timeline`)).status, 404);
  assert.match(String(await runTool({ boardId: g.id, actor: "Kai's agent", userId: kai.id }, "read_timeline", {})), /No grid/);
  // an open grid: a viewer may read both (nothing here is a write)
  const open = grid("Open to all");
  assert.equal((await api(C.vic, "GET", `/api/boards/${open.id}/timeline`)).status, 200);
  assert.equal((await api(C.vic, "GET", `/api/boards/${open.id}/history`)).status, 200);
  assert.match(String(await runTool({ boardId: open.id, actor: "Vic's agent", userId: vic.id }, "read_timeline", {})), /Timeline of/);
  // from/to/limit are numbers in order
  assert.equal((await api(C.ada, "GET", `/api/boards/${open.id}/timeline?from=10&to=5`)).status, 400);
  assert.equal((await api(C.ada, "GET", `/api/boards/${open.id}/timeline?from=abc`)).status, 400);
  assert.equal((await api(C.ada, "GET", `/api/boards/${open.id}/timeline?limit=99999`)).status, 400);
  assert.equal((await api(C.ada, "GET", `/api/boards/${open.id}/history?from=0&to=${Date.now() + 3 * 86_400_000}`)).status, 400);
  assert.equal((await api(C.ada, "GET", `/api/boards/${open.id}/history?from=0&to=${Date.now()}`)).status, 200, "from 1970: from where keeping began");
});

test("no route writes an event, and a body that names an actor is ignored", async () => {
  const g = grid("No writes");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    for (const path of [`/api/boards/${g.id}/timeline`, `/api/boards/${g.id}/history`, `/api/boards/${g.id}/timeline/events`]) assert.equal(r.match(method, path), null, `${method} ${path}`);
    assert.equal((await api(C.ada, method, `/api/boards/${g.id}/timeline`, { kind: "card.add", actor: { kind: "person", name: "Mallory" } })).status, 404);
  }
  // a person's tool call naming someone else: the call is theirs
  await runTool(httpToolCtx(g.id, ada, true), "add_note", { section: g.section, title: "Mine", markdown: "x", actor: "Mallory", by: "Mallory", actor_kind: "agent" } as never);
  timeline.flushTimeline();
  const s = await slice(C.ada, g.id);
  const add = kinds(s, "card.add").find((e) => e.data?.name === "Mine")!;
  assert.deepEqual([add.actor.kind, add.actor.name], ["person", "Ada Lovelace"]);
  assert.ok(!s.events.some((e) => e.actor.name === "Mallory"));
  assert.equal(kinds(s, "agent.tool").length, 0, "a person's own call is their edit, not an agent's step");
});

test("chat: a conversation's words reach only its members (an admin is no exception); a removed message is gone; a place link counts", async () => {
  const g = grid("Chat grid");
  const priv = chat.createChannel(chat.personParty(ada), { kind: "private", name: `rim-${Date.now().toString(36)}`, members: [chat.personParty(kai)] });
  const cardSec = editBoard(g.id, "system", (doc) => appendSection(doc, "Talk"));
  editBoard(g.id, "agent", (doc) => boardMaps(doc).objects.set("chat1", { id: "chat1", kind: "panel", panel: "chat", channel: priv.id, sectionId: cardSec.id, name: "Conversation", x: 0, y: 0, float: false, bornAt: Date.now(), w: 400, h: 560, ports: [] } as ObjectDoc));
  const said = chat.postMessage(priv.id, chat.personParty(ada), { text: "the shroud goes to 3 mm" });
  const gone = chat.postMessage(priv.id, chat.personParty(kai), { text: "oops, wrong channel" });
  chat.removeMessage(gone.id);
  const general = chat.ensureGeneral();
  const linked = chat.postMessage(general.id, chat.personParty(kai), { text: "see the bracket", place: { board: g.id, label: "Brackets", section: g.section } });

  const mine = (s: TimelineSlice) => kinds(s, "chat.message").map((e) => (e.data as { body: string }).body);
  const kaiS = await slice(C.kai, g.id);
  assert.deepEqual(mine(kaiS).sort(), ["see the bracket", "the shroud goes to 3 mm"]);
  const m = kinds(kaiS, "chat.message").find((e) => e.ref?.id === said.id)!;
  assert.equal(m.section, cardSec.id, "where its chat card is");
  assert.deepEqual(m.actor, { kind: "person", id: ada.id, name: "Ada Lovelace" });
  assert.equal(kinds(kaiS, "chat.message").find((e) => e.ref?.id === linked.id)!.section, g.section, "a place link's section");
  // the admin: not in the private channel, so the event isn't there at all (not redacted)
  const bossS = await slice(C.boss, g.id);
  assert.deepEqual(mine(bossS), ["see the bracket"]);
  assert.ok(!bossS.events.some((e) => e.ref?.id === said.id || e.ref?.id === gone.id));
  // a section's timeline: only what was said there
  const talk = await slice(C.kai, g.id, `&section=${cardSec.id}`);
  assert.deepEqual(mine(talk), ["the shroud goes to 3 mm"]);
  assert.ok(!JSON.stringify(kaiS).includes("oops"), "a removed message is absent");
  // the tool, as Kai's agent: the words are there for Kai's agent, not for one working for the admin
  assert.match(String(await runTool({ boardId: g.id, actor: "Kai's agent", userId: kai.id }, "read_timeline", {})), /3 mm/);
  assert.doesNotMatch(String(await runTool({ boardId: g.id, actor: "Boss's agent", userId: boss.id }, "read_timeline", {})), /3 mm/);
});

function finish(run: ReturnType<typeof startRun>, userId: string) {
  return new Promise<void>((done) => followRun(run.id, userId, () => undefined, () => done()));
}

test("an agent's run: a span in its section with its steps; its answer is shown to everyone unless it read beyond the grid, and always to its person", async () => {
  const g = grid("Agents grid");
  const open = startRun({ boardId: g.id, user: ada, prompt: "Make a section called “Supply” with the parts", section: g.section });
  await finish(open, ada.id);
  const closed = startRun({ boardId: g.id, user: ada, prompt: "Make a section called “Quiet” [private]", section: g.section });
  await finish(closed, ada.id);
  timeline.flushTimeline();
  assert.equal(one<{ s: string }>("select section_id as s from agent_runs where id = ?", open.id)?.s, g.section, "the run knows its section");

  const kaiS = await slice(C.kai, g.id);
  const adaS = await slice(C.ada, g.id);
  const answerOf = (s: TimelineSlice, runId: string) => kinds(s, "chat.answer").find((e) => e.ref?.id === runId)!;
  assert.ok((answerOf(kaiS, open.id).data as { body: string }).body.length > 0, "a run that read only the grid: its answer is the grid's");
  assert.equal(answerOf(kaiS, closed.id).data?.body, undefined);
  assert.match(answerOf(kaiS, closed.id).withheld ?? "", /beyond the grid/);
  assert.ok((answerOf(adaS, closed.id).data as { body: string }).body.length > 0, "its person reads it");
  assert.equal(answerOf(adaS, closed.id).withheld, undefined);
  // the ask is the person's (its words were on the board's activity)
  const ask = kinds(kaiS, "chat.ask").find((e) => e.ref?.id === open.id)!;
  assert.deepEqual([ask.actor.kind, ask.actor.id], ["person", ada.id]);
  assert.match((ask.data as { body: string }).body, /Supply/);
  // the run's span: in its section, ended, with its steps; the agent's steps are behind the scenes, as the agent for Ada
  const span = kinds(kaiS, "agent.run").find((e) => e.ref?.id === open.id)!;
  assert.equal(span.section, g.section);
  assert.equal(span.actor.kind, "agent");
  assert.equal(span.actor.for, "Ada Lovelace");
  assert.ok(typeof span.end === "number");
  assert.match(span.text, /^worked for Ada Lovelace: \d+ steps?$/);
  assert.ok(Number(/(\d+) step/.exec(span.text)![1]) >= 3);
  const steps = kinds(kaiS, "agent.tool").filter((e) => e.actor.id === span.actor.id);
  assert.ok(steps.some((e) => e.data?.tool === "add_table" && e.text === "added a table"));
  assert.ok(steps.every((e) => e.actor.for === "Ada Lovelace"));
  // what it made is in Changes, as the agent's
  const made = kinds(kaiS, "card.add").find((e) => e.data?.name === "Parts")!;
  assert.deepEqual([made.actor.kind, made.actor.id, made.actor.for], ["agent", span.actor.id, "Ada Lovelace"]);
});

test("an agent's tool call: agent.tool with the agent as actor and its person as `for`, once per request_id; reads are counted into one", async () => {
  const g = grid("Tools grid");
  const m = joinCrew({ boardId: g.id, userId: kai.id, userName: "Kai Moreno", runId: "run_tools", task: "x" });
  const ctx = { boardId: g.id, actor: m.name, userId: kai.id, crew: m.id };
  const a = await runTool(ctx, "add_note", { section: g.section, title: "Once", markdown: "x", request_id: "rq1" });
  const b = await runTool(ctx, "add_note", { section: g.section, title: "Once", markdown: "x", request_id: "rq1" });
  assert.deepEqual(a, b);
  for (let i = 0; i < 3; i++) await runTool(ctx, "read_board", {});
  await runTool(ctx, "run_code", { code: "const b = await foundation.read_board({});\nreturn 1;" });
  await sleep(120); // the reads' window closes
  timeline.flushTimeline();
  leaveCrew(m, "done", 0);
  const s = await slice(C.kai, g.id);
  const adds = kinds(s, "agent.tool").filter((e) => e.data?.tool === "add_note");
  assert.equal(adds.length, 1, "a replayed request_id records nothing new");
  assert.deepEqual([adds[0].actor.kind, adds[0].actor.id, adds[0].actor.name, adds[0].actor.for], ["agent", m.id, m.name, "Kai Moreno"]);
  assert.equal(adds[0].text, "added a note");
  assert.equal(adds[0].section, g.section);
  assert.ok(adds[0].object, "the card it made");
  const reads = kinds(s, "agent.tool").filter((e) => e.data?.tool === "read_board");
  assert.ok(reads.length >= 1 && reads.length <= 2, "chatty reads coalesce");
  assert.equal(reads.reduce((n, e) => n + Number(e.data?.n ?? 1), 0), 4, "three direct reads and one inside the script, counted");
  const code = kinds(s, "agent.code")[0];
  assert.deepEqual(code.data, { lines: 2, ok: true });
  assert.doesNotMatch(JSON.stringify(code), /foundation\.read_board/, "a script's length, never its text");
  assert.equal(kinds(s, "card.add").filter((e) => e.data?.name === "Once").length, 1);
});

test("a voice note: note.audio instead of card.add, the transaction's person as actor whatever the card says", async () => {
  const g = grid("Notes grid");
  const p = personOn(g.id, kai);
  const id = uid("media");
  p.edit((d) =>
    boardMaps(d).objects.set(id, {
      id,
      kind: "media",
      media: "audio",
      src: "/files/f_voice",
      sectionId: g.section,
      name: "Voice note",
      x: 0,
      y: 0,
      float: false,
      bornAt: Date.now(),
      w: 320,
      h: 96,
      note: { by: ada.id, byName: "Ada Lovelace", at: Date.now(), ms: 4200, fileId: "f_voice", mime: "audio/webm", peaks: [0.1, 0.5, 0.2] },
    } as ObjectDoc),
  );
  timeline.flushTimeline();
  p.leave();
  const s = await slice(C.ada, g.id);
  assert.equal(kinds(s, "card.add").length, 0);
  const n = kinds(s, "note.audio")[0];
  assert.deepEqual([n.actor.kind, n.actor.id, n.actor.name], ["person", kai.id, "Kai Moreno"], "who did it is the session's, never note.by");
  assert.deepEqual(n.ref, { type: "file", id: "f_voice" });
  assert.deepEqual((n.data as { note: unknown }).note, { fileId: "f_voice", mime: "audio/webm", ms: 4200, peaks: [0.1, 0.5, 0.2] });
  assert.equal(n.text, "left a voice note");
});

test("a machine's command an agent asked for: a terminal span with the command the card shows, ended with its exit; a socket can't forge one", async () => {
  const g = grid("Machine grid");
  const card = "pnl_machine1";
  editBoard(g.id, "system", (doc) => boardMaps(doc).objects.set(card, { id: card, kind: "panel", panel: "machine", sectionId: g.section, name: "Build box", x: 0, y: 0, float: false, bornAt: Date.now(), w: 760, h: 520, ports: [] } as ObjectDoc));
  const ask = { id: "ask_1", command: "make test", by: "Wren", for: "Ada Lovelace", state: "waiting" as const, at: Date.now() };
  writeAsk(g.id, card, ask);
  timeline.flushTimeline();
  let t = kinds(await slice(C.ada, g.id), "terminal");
  assert.equal(t.length, 1);
  assert.equal(t[0].end, null);
  writeAsk(g.id, card, { ...ask, state: "done", exitCode: 0, endedAt: Date.now() } as never);
  // a person's socket writing an ask is put back by the server, and is no event
  const p = personOn(g.id, kai);
  p.edit((d) => boardMaps(d).machineAsks.set(card, [{ id: "ask_fake", command: "rm -rf /", by: "Mallory", state: "waiting", at: Date.now() }]));
  timeline.flushTimeline();
  p.leave();
  t = kinds(await slice(C.ada, g.id), "terminal");
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].actor.kind, t[0].actor.name, t[0].actor.for, t[0].section], ["agent", "Wren", "Ada Lovelace", g.section]);
  assert.equal(typeof t[0].end, "number");
  assert.deepEqual(t[0].data, { command: "make test", exit: 0, state: "done" });
  assert.match(t[0].text, /ran a command in Build box: exit 0/);
});

test("huddles: a grid's own huddle is a span in its card's section; a private channel's huddle taken to the grid reaches only that channel's members", async () => {
  const g = grid("Huddle grid");
  editBoard(g.id, "system", (doc) => boardMaps(doc).objects.set("hud1", { id: "hud1", kind: "panel", panel: "huddle", sectionId: g.section, name: "Stand-up", x: 0, y: 0, float: false, bornAt: Date.now(), w: 560, h: 420, ports: [] } as ObjectDoc));
  const t0 = Date.now() - 60_000;
  run("insert into huddle_sessions (id, huddle_id, board_id, started_at, ended_at, people_json) values (?, ?, ?, ?, ?, ?)", "hs_own", "hud1", g.id, t0, t0 + 30_000, JSON.stringify(["Ada Lovelace", "Kai Moreno"]));
  const priv = chat.createChannel(chat.personParty(ada), { kind: "private", name: `hud-${Date.now().toString(36)}`, members: [chat.personParty(kai)] });
  run("insert into huddle_sessions (id, huddle_id, board_id, started_at, ended_at, people_json, channel, home) values (?, ?, 'chat', ?, ?, ?, ?, 'chat')", "hs_chan", "hd_x", t0, t0 + 20_000, JSON.stringify(["Ada Lovelace"]), priv.id);
  run("insert into huddle_events (session_id, at, type, by, board_id, section_id) values (?, ?, 'placed', ?, ?, ?)", "hs_chan", t0 + 1000, "Ada Lovelace", g.id, g.section);
  const huddles = async (cookie: string) => kinds(await slice(cookie, g.id), "huddle").map((e) => [e.ref?.id, e.section, e.end]);
  assert.deepEqual(await huddles(C.kai), [
    ["hs_chan", g.section, t0 + 20_000],
    ["hs_own", g.section, t0 + 30_000],
  ]);
  assert.deepEqual(await huddles(C.boss), [["hs_own", g.section, t0 + 30_000]], "the admin sees the grid's own huddle, not the private channel's");
});

test("the council: putting an agent on a section's council and taking it off are agent.seat events there, by the person who did it", async () => {
  const { postAgent, unpostAgent } = await import("../src/posted.ts");
  const g = grid("Council grid");
  const { seat } = postAgent(g.id, g.section, "claude-api", ada);
  unpostAgent(g.id, g.section, seat.id!, kai);
  const seats = kinds(await slice(C.ada, g.id), "agent.seat");
  assert.equal(seats.length, 2);
  assert.deepEqual(seats.map((e) => [e.section, e.actor.kind, e.actor.name, e.data?.on, e.data?.by]), [
    [g.section, "agent", seat.alias, true, "Ada Lovelace"],
    [g.section, "agent", seat.alias, false, "Kai Moreno"],
  ]);
});

test("the budget: over it, the oldest changes fold into a new base, start moves forward, and history still rebuilds", async () => {
  const g = grid("Budget grid");
  const n1 = note(g.section, "Long");
  editBoard(g.id, "agent", (doc) => boardMaps(doc).objects.set(n1.id, n1));
  timeline.flushTimeline();
  const start0 = (await slice(C.ada, g.id)).start;
  process.env.FOUNDATION_TIMELINE_MAX_MB = String(4 / 1024); // 4 KB
  try {
    for (let i = 0; i < 30; i++) {
      // fresh words each time (setNoteText writes only the difference)
      editBoard(g.id, "agent", (doc) => setNoteText(doc, n1.id, Array.from({ length: 12 }, () => Math.random().toString(36).slice(2)).join(" ")));
      timeline.flushTimeline();
      await sleep(2);
    }
  } finally {
    delete process.env.FOUNDATION_TIMELINE_MAX_MB;
  }
  const s = await slice(C.ada, g.id);
  assert.ok(s.start > start0, "history begins later now");
  const bytes = one<{ b: number }>("select coalesce(sum(length(blob)), 0) as b from timeline_updates where board_id = ?", g.id)!.b;
  assert.ok(bytes <= 4096, `kept changes are under the budget (${bytes} B)`);
  assert.ok(one<{ u: number }>("select min(upto) as u from timeline_base where board_id = ?", g.id)!.u > 0, "the first base went with the fold; history begins at a checkpoint");
  const frames = decodeTake((await ok(C.ada, "GET", `/api/boards/${g.id}/history?from=0&to=${Date.now() + 1}`)).bytes);
  assert.equal(frames.head.from, s.start, "asked from before it began: from where it begins");
  assert.equal(stateOf(new TakePlayer(frames).docAt(Date.now() + 1)), stateOf(getBoard(g.id).doc));
  assert.ok(kinds(s, "card.add").some((e) => e.object === n1.id), "events are never folded");
});

test("the document is untrusted: a card named 7, a note with no file, junk asks and links cost their own events, never the burst's history or anyone else's", async () => {
  const g = grid("Poison");
  timeline.flushTimeline();
  const p = personOn(g.id, ada);
  const honest = note(g.section, "Honest");
  editBoard(g.id, "agent", (d) => boardMaps(d).objects.set(honest.id, honest));
  p.edit((d) => {
    const m = boardMaps(d);
    m.objects.set("evil", { ...note(g.section, "x"), id: "evil", name: 7 as never, sectionId: { no: 1 } as never });
    m.objects.set("evil2", { id: "evil2", kind: "media", media: "audio", src: "/files/x", sectionId: g.section, name: "Not a note", x: 0, y: 0, float: false, bornAt: 1, w: 1, h: 1, note: { fileId: 5, ms: "long", peaks: "loud" } } as never);
    m.links.set("evil4", { id: "evil4", from: { panel: 3, port: "a" }, to: { panel: { x: 1 }, port: "b" } } as never);
  });
  editBoard(g.id, "machines", (d) => boardMaps(d).machineAsks.set("nothing", [null, 4, { id: { x: 1 }, state: 9 }, { id: "ask_junk", by: 12, command: { rm: 1 }, state: "waiting", at: "now" }] as never));
  timeline.flushTimeline();
  await sleep(5);
  const later = note(g.section, "Later");
  editBoard(g.id, "agent", (d) => boardMaps(d).objects.set(later.id, later));
  timeline.flushTimeline();
  p.leave();
  const s = await slice(C.ada, g.id);
  const adds = kinds(s, "card.add");
  assert.ok(adds.some((e) => e.object === honest.id), "the honest card in the same burst is on the timeline");
  assert.deepEqual(adds.find((e) => e.object === "evil")?.data, { card: "note", name: "7" }, "a number for a name is read as words");
  assert.equal(adds.find((e) => e.object === "evil")?.section, null);
  assert.equal(kinds(s, "note.audio").length, 0, "a note without a file isn't a note");
  assert.ok(adds.some((e) => e.object === "evil2"));
  assert.ok(kinds(s, "wire.add").some((e) => e.object === "evil4"));
  assert.equal(kinds(s, "terminal").length, 1, "only the one well-formed ask");
  // the history holds everything, the later server change included
  const frames = timeline.historyFor(g.id, 0, Date.now() + 1);
  assert.equal(stateOf(new TakePlayer(frames).docAt(Date.now() + 1)), stateOf(getBoard(g.id).doc));
  assert.ok(boardMaps(new TakePlayer(frames).docAt(Date.now() + 1)).objects.has(later.id));
});

test("request_id: a failed call and its successful retry are both shown; a replay of the success adds nothing", async () => {
  const g = grid("Retry");
  const g2 = grid("Retry two");
  const m = joinCrew({ boardId: g.id, userId: ada.id, userName: ada.name, runId: "run_retry", task: "t" });
  const ctx = { boardId: g.id, actor: m.name, userId: ada.id, crew: m.id };
  const c = note(g.section, "Card");
  await assert.rejects(runTool(ctx, "send_to_board", { id: c.id, to_board: g2.id, request_id: "r-1" }));
  editBoard(g.id, "system", (d) => boardMaps(d).objects.set(c.id, c));
  await runTool(ctx, "send_to_board", { id: c.id, to_board: g2.id, request_id: "r-1" });
  await runTool(ctx, "send_to_board", { id: c.id, to_board: g2.id, request_id: "r-1" });
  timeline.flushTimeline();
  leaveCrew(m, "done", 0);
  const sends = kinds(await slice(C.ada, g.id), "agent.tool").filter((e) => e.data?.tool === "send_to_board");
  assert.deepEqual(sends.map((e) => e.data?.ok), [false, true]);
});

test("a subsystem's timer is the subsystem's: flows' fill is not the person who wired the tables", async () => {
  const g = grid("Flows grid");
  const a = { id: uid("tbl"), kind: "table", sectionId: g.section, name: "Source", x: 0, y: 0, float: false, bornAt: Date.now(), w: 400, h: 300, cols: 2, rows: 2, ports: [{ id: TABLE_PORT, name: "rows", dir: "out", type: "table" }] } as unknown as ObjectDoc;
  const b = { id: uid("tbl"), kind: "table", sectionId: g.section, name: "Fed", x: 0, y: 0, float: false, bornAt: Date.now(), w: 400, h: 300, cols: 2, rows: 2, ports: [{ id: TABLE_PORT, name: "rows", dir: "in", type: "table" }] } as unknown as ObjectDoc;
  editBoard(g.id, "system", (d) => {
    boardMaps(d).objects.set(a.id, a);
    boardMaps(d).objects.set(b.id, b);
    setTableCells(d, a.id, { "0,0": "x", "0,1": "1" });
  });
  timeline.flushTimeline();
  await sleep(100);
  // a person's write request (index.ts runs it in actorScope) wires the tables; flows fills the fed one on a timer
  actorScope.run({ kind: "person", id: ada.id, name: ada.name }, () =>
    editBoard(g.id, "system", (d) => boardMaps(d).links.set("l1", { id: "l1", from: { panel: a.id, port: TABLE_PORT }, to: { panel: b.id, port: TABLE_PORT } })),
  );
  await sleep(250);
  timeline.flushTimeline();
  const s = await slice(C.ada, g.id);
  assert.deepEqual(kinds(s, "wire.add").map((e) => e.actor.name), ["Ada Lovelace"], "the wire is hers");
  const fed = s.events.filter((e) => e.object === b.id && e.kind === "card.edit");
  assert.ok(fed.length >= 1, "the fill shows");
  assert.ok(fed.every((e) => e.actor.kind === "system" && e.actor.name === "Flows"), "and it is Flows', not hers");
});

test("names come from the session: a label an agent gives itself (MCP ?as=) is only a claim", async () => {
  const g = grid("Claims");
  await runTool({ boardId: g.id, actor: "Zephyr", userId: ada.id }, "add_note", { section: g.section, title: "From MCP", markdown: "x" });
  await runTool({ boardId: g.id, actor: "Wren", userId: "agent" }, "add_note", { section: g.section, title: "From the service", markdown: "x" });
  timeline.flushTimeline();
  const s = await slice(C.ada, g.id);
  const tools = kinds(s, "agent.tool");
  assert.deepEqual(tools.map((e) => [e.actor.name, e.data?.as, e.data?.claimed]), [
    ["Ada Lovelace's agent", "Zephyr", true],
    ["Foundation Agent", "Wren", true],
  ]);
  assert.deepEqual(kinds(s, "card.add").map((e) => e.actor.name), ["Ada Lovelace's agent", "Foundation Agent"]);
  assert.ok(!JSON.stringify(s.events.map((e) => e.actor)).includes("Zephyr"));
});

test("who left a voice note is the timeline's word; without it, read_board says the card's word is a claim", async () => {
  const g = grid("Note owner");
  const p = personOn(g.id, kai);
  const voice = (id: string) => ({ id, kind: "media", media: "audio", src: "/files/f_v", sectionId: g.section, name: id, x: 0, y: 0, float: false, bornAt: Date.now(), w: 320, h: 96, note: { by: ada.id, byName: "Ada Lovelace", at: Date.now(), ms: 4200, fileId: "f_v", mime: "audio/webm" } }) as unknown as ObjectDoc;
  p.edit((d) => boardMaps(d).objects.set("seen", voice("seen")));
  timeline.flushTimeline();
  p.leave();
  // a note the timeline never saw left (written straight into the stored board, as from before keeping began)
  run("delete from timeline_events where board_id = ? and object_id = ?", g.id, "seen");
  p.edit((d) => boardMaps(d).objects.set("again", voice("again")));
  timeline.flushTimeline();
  const out = String(await runTool({ boardId: g.id, actor: "Ada Lovelace", userId: ada.id, person: true }, "read_board", {}));
  assert.match(out, /voice note "again" by Kai Moreno, 0:04 long/, "Kai's session added it, whatever the card says");
  assert.match(out, /voice note "seen" says it is by Ada Lovelace/);
  const card = (await runTool({ boardId: g.id, actor: "Ada Lovelace", userId: ada.id, person: true }, "read_card", { id: "again" })) as Record<string, unknown>;
  assert.equal(card.by, "Kai Moreno");
  assert.equal(card.says_by, undefined);
});

test("a viewer's ask is the asker's alone, and so is its answer", async () => {
  const g = grid("Viewer asks");
  run("insert into agent_runs (id, board_id, runtime, prompt, status, created_by, created_at, transcript_json) values (?, ?, 'script', ?, 'done', ?, ?, ?)", "run_view", g.id, "what is here?", vic.id, Date.now(), JSON.stringify([{ type: "text", text: "Three cards." }]));
  const r = { board: g.id, runId: "run_view", agent: { id: "crew_v", name: "Wren" }, user: { id: vic.id, name: vic.name } };
  timeline.runStarted({ ...r, ask: { shown: false } });
  timeline.runEnded({ ...r, answered: true, private: true, why: "ask" });
  const kaiS = await slice(C.kai, g.id);
  assert.match(kinds(kaiS, "chat.ask")[0].withheld ?? "", /Only the person who asked/);
  assert.match(kinds(kaiS, "chat.answer")[0].withheld ?? "", /only its person could read/);
  assert.equal(kinds(kaiS, "chat.answer")[0].data?.body, undefined);
  const vicS = await slice(C.vic, g.id);
  assert.equal(kinds(vicS, "chat.answer")[0].data?.body, "Three cards.");
});

test("pointers: a window can't save itself as an agent or under another name; the socket's person is who pointed", async () => {
  const g = grid("Pointers");
  const p = personOn(g.id, kai);
  // Kai's window says it is the agent Wren, with a crew presence of its own
  p.say({ user: { name: "Wren", color: "#000", agent: true }, cursor: { x: 7, y: 8 }, crew: { id: "crew_fake", target: { id: "x" } } });
  await sleep(60);
  p.say({ user: { name: "Wren", agent: true }, cursor: { x: "junk", y: null }, crew: { target: { id: 5 } } });
  await sleep(60);
  p.leave();
  timeline.flushTimeline();
  const frames = timeline.historyFor(g.id, 0, Date.now() + 1);
  const who = frames.cursors.flatMap((c) => c.who);
  assert.ok(who.length >= 1);
  assert.ok(who.every((w) => w.n === "Kai Moreno" && !w.a), JSON.stringify(who));
});

test("checkpoints: a long history keeps bases along the way, so the board at a late moment rebuilds from a short tail; too big a stretch is refused with a sentence", async () => {
  const g = grid("Checkpoints");
  const n1 = note(g.section, "Long");
  editBoard(g.id, "agent", (doc) => boardMaps(doc).objects.set(n1.id, n1));
  process.env.FOUNDATION_TIMELINE_MAX_MB = String(256 / 1024); // 256 KB: a checkpoint every 32 KB
  const snaps: Array<{ at: number; state: string }> = [];
  try {
    for (let i = 0; i < 60; i++) {
      editBoard(g.id, "agent", (doc) => setNoteText(doc, n1.id, Array.from({ length: 200 }, () => Math.random().toString(36).slice(2)).join(" ")));
      timeline.flushTimeline();
      if (i % 15 === 7) {
        await sleep(3);
        snaps.push({ at: Date.now(), state: stateOf(getBoard(g.id).doc) });
      }
      await sleep(2);
    }
    const bases = all<{ upto: number }>("select upto from timeline_base where board_id = ? order by upto", g.id);
    assert.ok(bases.length >= 3, `checkpoints were written (${bases.length})`);
    const tail = one<{ b: number }>("select coalesce(sum(length(blob)), 0) as b from timeline_updates where board_id = ? and seq > ?", g.id, bases.at(-1)!.upto)!.b;
    assert.ok(tail <= 40 * 1024, `the tail after the newest base is short (${tail} B)`);
    for (const s of snaps) {
      const f = timeline.historyFor(g.id, s.at, s.at + 1);
      assert.equal(stateOf(new TakePlayer(f).docAt(s.at)), s.state, "the board at that moment, from the nearest base");
      assert.equal(stateOf(new TakePlayer(timeline.historyFor(g.id, s.at, s.at + 1)).docAt(s.at)), s.state, "and again (from the cache)");
    }
    process.env.FOUNDATION_TIMELINE_HISTORY_MAX_MB = String(8 / 1024);
    const big = await api(C.ada, "GET", `/api/boards/${g.id}/history?from=0&to=${Date.now()}`);
    assert.equal(big.status, 413);
    assert.match((big.body as { error: string }).error, /ask for a shorter stretch/);
  } finally {
    delete process.env.FOUNDATION_TIMELINE_MAX_MB;
    delete process.env.FOUNDATION_TIMELINE_HISTORY_MAX_MB;
  }
});

test("thinning: a long stretch is at most a few steps, and ends exactly where the unthinned one does", async () => {
  const g = grid("Thin grid");
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) {
    const n = note(g.section, `N${i}`);
    ids.push(n.id);
    editBoard(g.id, "agent", (doc) => {
      boardMaps(doc).objects.set(n.id, n);
      setNoteText(doc, n.id, `text ${i}`);
      if (i % 3 === 2) boardMaps(doc).objects.delete(ids[i - 1]);
    });
    timeline.flushTimeline();
    await sleep(2);
  }
  const s = await slice(C.ada, g.id);
  const mid = s.start + 1;
  const full = timeline.historyFor(g.id, mid, Date.now() + 1, 10_000);
  const thin = timeline.historyFor(g.id, mid, Date.now() + 1, 4);
  assert.ok(thin.updates.length <= 4 && thin.updates.length >= 1);
  assert.ok(((thin.head as { thinned?: number }).thinned ?? 0) > 1);
  assert.ok(full.updates.length > thin.updates.length);
  assert.equal(thin.updates.at(-1)!.at, full.updates.at(-1)!.at, "the last step keeps the time of its last change");
  const end = Date.now() + 1;
  assert.equal(stateOf(new TakePlayer(thin).docAt(end)), stateOf(new TakePlayer(full).docAt(end)));
  assert.equal(stateOf(new TakePlayer(thin).docAt(end)), stateOf(getBoard(g.id).doc));
});

// ---------- 2026-11-26: every interaction, live, in one order ----------

test("a person's everyday work is all on the timeline, in one order, and the board at each step replays exactly; windows are nudged", async () => {
  const g = grid("Everyday");
  const sent: Uint8Array[] = [];
  // a window on the grid that hears the server (the person's own socket carries their edits)
  const listener = Object.assign(new EventEmitter(), { readyState: 1, binaryType: "", send: (d: Uint8Array) => sent.push(new Uint8Array(d)), close() {} });
  attachConnection(g.id, listener as never, false, kai.id);
  const p = personOn(g.id, ada);
  const states: Array<{ kind: string; object: string; state: string }> = [];
  const step = async (kind: string, object: string, fn: (d: Y.Doc) => void) => {
    p.edit(fn);
    timeline.flushTimeline();
    states.push({ kind, object, state: stateOf(getBoard(g.id).doc) });
    await sleep(8);
  };
  const n = note(g.section, "Brief");
  await step("card.add", n.id, (d) => boardMaps(d).objects.set(n.id, n));
  const t = { id: uid("tbl"), kind: "table", sectionId: g.section, name: "Parts", x: 400, y: 0, float: false, bornAt: Date.now(), w: 400, h: 300, cols: 2, rows: 2 } as unknown as ObjectDoc;
  await step("card.add", t.id, (d) => boardMaps(d).objects.set(t.id, t));
  await step("card.edit", t.id, (d) => setTableCells(d, t.id, { "0,0": "bolt", "0,1": "4" }));
  await step("card.place", n.id, (d) => boardMaps(d).objects.set(n.id, { ...boardMaps(d).objects.get(n.id)!, x: 120, y: 80 }));
  await step("card.place", t.id, (d) => boardMaps(d).objects.set(t.id, { ...boardMaps(d).objects.get(t.id)!, w: 520 }));
  const other = editBoard(g.id, "system", (doc) => appendSection(doc, "Bench"));
  await step("card.move", n.id, (d) => boardMaps(d).objects.set(n.id, { ...boardMaps(d).objects.get(n.id)!, sectionId: other.id }));
  const v = { id: uid("media"), kind: "media", media: "video", src: "/files/f_vid", sectionId: g.section, name: "Video note", x: 0, y: 400, float: false, bornAt: Date.now(), w: 320, h: 240, note: { by: ada.id, at: Date.now(), ms: 2100, fileId: "f_vid", mime: "video/webm" } } as unknown as ObjectDoc;
  await step("note.video", v.id, (d) => boardMaps(d).objects.set(v.id, v));
  await step("card.remove", t.id, (d) => boardMaps(d).objects.delete(t.id));
  await sleep(60);
  timeline.flushTimeline();

  const s = await slice(C.ada, g.id);
  const mine = s.events.filter((e) => e.actor.id === ada.id && e.kind !== "person.here");
  // each step is there, by Ada, in the order she did them
  assert.deepEqual(
    mine.map((e) => [e.kind, e.object]),
    states.map((x) => [x.kind, x.object]),
    JSON.stringify(mine.map((e) => e.text)),
  );
  assert.equal(mine.find((e) => e.kind === "card.place" && e.object === n.id)!.text, "moved “Brief”");
  assert.equal(mine.find((e) => e.kind === "card.place" && e.object === t.id)!.text, "resized “Parts”");
  // a second nudge of the same card within the quiet stretch is the same event
  p.edit((d) => boardMaps(d).objects.set(n.id, { ...boardMaps(d).objects.get(n.id)!, x: 140 }));
  timeline.flushTimeline();
  assert.equal(kinds(await slice(C.ada, g.id), "card.place").filter((e) => e.object === n.id).length, 1);
  // read twice, the same order
  assert.deepEqual((await slice(C.kai, g.id)).events.map((e) => e.id), (await slice(C.kai, g.id)).events.map((e) => e.id));

  // the board at each event's moment is exactly the board right after that step
  const frames = decodeTake((await ok(C.kai, "GET", `/api/boards/${g.id}/history?from=0&to=${Date.now() + 1000}`)).bytes);
  const player = new TakePlayer(frames, 2);
  for (const [i, e] of mine.entries()) assert.equal(stateOf(player.docAt(e.at)), states[i].state, `the board after ${e.kind} ${e.text}`);

  // the window was told, with nothing but a time: [2, at]
  await sleep(700);
  const nudges = sent.filter((m) => m[0] === 2);
  assert.ok(nudges.length >= 1, "the window heard that the timeline has something new");
  assert.ok(nudges.every((m) => m.length <= 10), "a nudge carries no content");
  p.leave();
  listener.emit("close");
});

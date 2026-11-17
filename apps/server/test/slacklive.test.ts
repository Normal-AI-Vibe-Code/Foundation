/**
 * The Slack board: a section for every channel, each kept current with its
 * channel. Slack is a stand-in here (SLACK_API_BASE) that serves channels,
 * top-level messages, replies' counts and real PNGs, and that can be posted
 * to mid-test.
 *
 * What's held: the board is made once; each section says how its connection
 * stands (live while the Slack app checks in, polling when it goes quiet,
 * waiting where the app isn't in the channel); the latest images come into
 * the archive and the section, newest first, and a new one moves the others;
 * a card someone moved stays where they put it; replies stay in threads;
 * nothing starts an agent until a person turns agents on, and then a crew
 * agent rewrites the summary under its own name and the server's digest
 * stops; a removed section stays removed; people can't write the `slack` map.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-slacklive-"));
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_SCRIPT_STEP_MS = "0";
process.env.FOUNDATION_CREW_TRAVEL_MS = "10";
process.env.FOUNDATION_SLACK_EVENT_MS = "20";
process.env.FOUNDATION_SLACK_SETTLE_MS = "20";
process.env.FOUNDATION_SLACK_FIRST_IMAGES = "2";
process.env.SLACK_BOT_TOKEN = "xoxb-test";
import { png } from "./fixtures/png.ts";

interface Msg {
  ts: string;
  user: string;
  text: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: Array<{ id: string; name: string; title?: string; mimetype: string; url_private_download: string }>;
}
let slack: Server;
let base = "";
const channels = [
  { id: "C0GENERAL1", name: "general", is_private: false, is_member: true, topic: { value: "Everything" } },
  { id: "C0DESIGN01", name: "design", is_private: false, is_member: true, topic: { value: "" } },
  { id: "C0RANDOM01", name: "random", is_private: false, is_member: false, topic: { value: "" } },
  { id: "G0SECRET01", name: "board-only", is_private: true, is_member: false, topic: { value: "" } },
];
const history = new Map<string, Msg[]>();
const calls: string[] = [];
const img = (id: string, name: string, title?: string) => ({ id, name, title, mimetype: "image/png", url_private_download: `${base}/download/${id}` });
/** post to the stand-in: newest first, like conversations.history answers */
function post(channel: string, m: Omit<Msg, "ts"> & { ts?: string }) {
  const list = history.get(channel) ?? [];
  const ts = m.ts ?? `${1_794_000_000 + list.length * 60}.000100`;
  list.unshift({ ...m, ts });
  history.set(channel, list);
  return ts;
}

before(async () => {
  slack = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== "Bearer xoxb-test") return res.writeHead(401).end();
    calls.push(url.pathname);
    const json = (o: unknown) => res.end(JSON.stringify(o));
    if (url.pathname === "/auth.test") return json({ ok: true, team: "Form (stand-in)", user: "foundation" });
    if (url.pathname === "/conversations.list") return json({ ok: true, channels });
    if (url.pathname === "/users.info") return json({ ok: true, user: { name: url.searchParams.get("user"), profile: { display_name: { U1: "Noa", U2: "Kai" }[url.searchParams.get("user") ?? ""] ?? "Someone" } } });
    if (url.pathname === "/conversations.history") {
      const ch = channels.find((c) => c.id === url.searchParams.get("channel"));
      if (!ch) return json({ ok: false, error: "channel_not_found" });
      if (!ch.is_member) return json({ ok: false, error: "not_in_channel" });
      return json({ ok: true, messages: history.get(ch.id) ?? [] });
    }
    if (url.pathname === "/conversations.join") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const ch = channels.find((c) => c.id === JSON.parse(body).channel);
        if (!ch || ch.is_private) return json({ ok: false, error: "method_not_supported_for_channel_type" });
        ch.is_member = true;
        json({ ok: true });
      });
      return;
    }
    const d = /^\/download\/(\w+)$/.exec(url.pathname);
    if (d) {
      res.writeHead(200, { "content-type": "image/png" });
      // F2 is tall, the rest wide: the section keeps each one's shape
      return res.end(d[1] === "F2" ? png(20, 40, [200, 122, 28]) : png(40, 20, [50, 91, 180]));
    }
    res.writeHead(404).end(JSON.stringify({ ok: false, error: "unknown_method" }));
  });
  await new Promise<void>((r) => slack.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(slack.address() as { port: number }).port}`;
  process.env.SLACK_API_BASE = base;

  post("C0GENERAL1", { user: "U1", text: "Welcome to the new office" });
  post("C0GENERAL1", { user: "U2", text: "Friday demo moved to 3pm", reply_count: 4 });
  post("C0DESIGN01", { user: "U1", text: "Shroud rev 1", subtype: "file_share", files: [img("F1", "shroud-rev1.png", "Shroud rev 1")] });
  post("C0DESIGN01", { user: "U2", text: "Thermal map from last night", subtype: "file_share", files: [img("F2", "thermal.png")] });
  post("C0DESIGN01", { user: "U1", text: "Shroud rev 2, thinner lip", subtype: "file_share", files: [img("F3", "shroud-rev2.png", "Shroud rev 2")] });
  post("C0DESIGN01", { user: "U2", text: "has joined the channel", subtype: "channel_join" });
  post("C0DESIGN01", { user: "U2", text: "a reply that stays in its thread", thread_ts: "1794000000.000100" });
});

const { upsertUser } = await import("../src/auth.ts");
const { run, all, one } = await import("../src/db.ts");
const { getBoard, closeBoards, listBoards } = await import("../src/boards.ts");
const { startRun } = await import("../src/agent.ts");
const live = await import("../src/slacklive.ts");
const { boardMaps, noteTextOf, slackSectionOf } = await import("@foundation/protocol");
import type { MediaDoc, SlackSectionState } from "@foundation/protocol";

const ada = upsertUser("ada@formindustries.com", "Ada");
run("update users set role = 'member' where id = ?", ada.id);

after(() => {
  live._resetSlackLive();
  live.setCurator(null);
  closeBoards();
  slack.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

let BOARD = "";
const doc = () => getBoard(BOARD).doc;
const sectionOf = (channel: string) => one<{ section_id: string }>("select section_id from slack_sections where board_id = ? and channel = ?", BOARD, channel)!.section_id;
const state = (channel: string) => slackSectionOf(doc(), sectionOf(channel)) as SlackSectionState;
const note = (id?: string) => noteTextOf(doc(), { id: id ?? "" });
const pictures = (channel: string) =>
  [...boardMaps(doc()).objects.values()].filter((o): o is MediaDoc => o.kind === "media" && o.sectionId === sectionOf(channel));

test("the Slack board: a section for every channel, read where the app is a member", async () => {
  const made = await live.buildSlackBoard(ada);
  BOARD = made.id;
  assert.equal(made.made, true);
  assert.deepEqual([made.channels, made.reading, made.waiting], [4, 2, 2]);
  assert.equal(listBoards().find((b) => b.id === BOARD)?.name, "Slack");

  const m = boardMaps(doc());
  const names = [...m.sections.values()].map((s) => s.name).sort();
  assert.deepEqual(names, ["#board-only", "#design", "#general", "#random"]);
  // a grid that fits them, no two sections in one cell
  const cells = new Set([...m.sections.values()].map((s) => `${s.c0},${s.r0}`));
  assert.equal(cells.size, 4);

  await until("the channels to be read", () => Boolean(state("C0DESIGN01").syncedAt && state("C0GENERAL1").syncedAt));

  // the Slack app's process hasn't checked in: read in turn, and the mark says so
  assert.equal(state("C0GENERAL1").state, "polling");
  assert.match(state("C0GENERAL1").detail ?? "", /isn't running/);
  // where the app isn't a member the section waits, and says what to do about it
  assert.equal(state("C0RANDOM01").state, "waiting");
  assert.match(state("C0RANDOM01").detail ?? "", /Press to have it join/);
  assert.equal(state("G0SECRET01").state, "waiting");
  assert.match(state("G0SECRET01").detail ?? "", /\/invite/);
  assert.equal(calls.filter((c) => c === "/conversations.join").length, 0, "nothing joins a channel by itself");

  // Latest: top-level messages, newest first, with who and what; replies and joins are left out
  const latest = note(state("C0GENERAL1").latestNote);
  assert.match(latest, /\*\*Kai\*\*[^\n]*\n\s+Friday demo moved to 3pm[\s\S]*4 replies/);
  assert.ok(latest.indexOf("Friday demo") < latest.indexOf("Welcome"), "newest first");
  const dl = note(state("C0DESIGN01").latestNote);
  assert.doesNotMatch(dl, /stays in its thread|has joined/);
  assert.match(dl, /1 image/);

  // Summary: the server's digest, and it says that's what it is
  assert.match(note(state("C0GENERAL1").summaryNote), /## #general[\s\S]*\*\*2 messages\*\* from 2 people[\s\S]*Most discussed:[\s\S]*Friday demo[\s\S]*not a written summary/);
  assert.equal(state("C0GENERAL1").summaryBy, undefined);

  // the latest two images (FOUNDATION_SLACK_FIRST_IMAGES) came into the archive and the section, each in its own shape
  const pics = pictures("C0DESIGN01");
  assert.equal(pics.length, 2);
  assert.equal(state("C0DESIGN01").images, 2);
  const [newest, older] = [pics.find((p) => /Shroud rev 2/.test(p.name))!, pics.find((p) => /Thermal map/.test(p.name))!];
  assert.ok(newest && older, "the first read takes the latest, not the oldest");
  assert.match(newest.name, /Shroud rev 2 · Noa/);
  assert.equal(newest.h, 160, "a 2:1 picture at 320 wide");
  assert.equal(older.h, 640, "a 1:2 picture at 320 wide");
  assert.deepEqual([newest.x, newest.y], [464, 0], "the newest leads");
  assert.deepEqual([older.x, older.y], [464 + 344, 0]);
  const files = all<{ name: string; mime: string }>("select name, mime from files where board_id = ? and archived_at is null", BOARD);
  assert.deepEqual(files.map((f) => f.name).sort(), ["shroud-rev2.png", "thermal.png"]);

  // building it again opens the one there is: no second board, no second section, no second copy of a picture
  const again = await live.buildSlackBoard(ada);
  assert.equal(again.id, BOARD);
  assert.equal(again.made, false);
  await sleep(120);
  assert.equal(boardMaps(doc()).sections.size, 4);
  assert.equal(pictures("C0DESIGN01").length, 2);
});

test("live: the Slack app checks in, and what's posted lands as it's posted", async () => {
  assert.equal(live.fromBridge({ type: "hello", team: "Form (stand-in)" }, { loopback: true }).boards, 1);
  await until("the sections to go live", () => state("C0GENERAL1").state === "live" && state("C0DESIGN01").state === "live");
  assert.equal(state("C0RANDOM01").state, "waiting", "a channel the app isn't in still waits");

  // someone moved the thermal map: it's theirs to place from here on
  const moved = pictures("C0DESIGN01").find((p) => /Thermal map/.test(p.name))!;
  getBoard(BOARD).doc.transact(() => boardMaps(doc()).objects.set(moved.id, { ...moved, x: 900, y: 700 }));

  post("C0DESIGN01", { user: "U2", text: "Manifold, printed", subtype: "file_share", files: [img("F4", "manifold.png")] });
  live.fromBridge({ type: "event", event: { type: "message", channel: "C0DESIGN01", subtype: "file_share" } }, { loopback: true });
  await until("the new image", () => pictures("C0DESIGN01").length === 3);

  const pics = pictures("C0DESIGN01");
  const manifold = pics.find((p) => /Manifold, printed/.test(p.name))!;
  const rev2 = pics.find((p) => /Shroud rev 2/.test(p.name))!;
  assert.deepEqual([manifold.x, manifold.y], [464, 0], "the new one takes the first place");
  assert.deepEqual([rev2.x, rev2.y], [464 + 344, 0], "and the one that was there moves along");
  const thermal = pics.find((p) => /Thermal map/.test(p.name))!;
  assert.deepEqual([thermal.x, thermal.y], [900, 700], "a card a person moved stays where they put it");
  assert.match(note(state("C0DESIGN01").latestNote), /Manifold, printed/);
  assert.equal(state("C0DESIGN01").images, 3);
  assert.match(note(state("C0DESIGN01").summaryNote), /3 images/);
  const activity = boardMaps(doc()).activity.toArray();
  assert.ok(activity.some((a) => a.who === "Slack" && /brought 1 image from #design/.test(a.text)));

  // an event for a channel with no section here, or a kind we don't follow, is nothing
  live.fromBridge({ type: "event", event: { type: "message", channel: "C0NOWHERE1" } }, { loopback: true });
  live.fromBridge({ type: "event", event: { type: "reaction_added" } }, { loopback: true });
});

test("a person has the app join a public channel; its section is read", async () => {
  post("C0RANDOM01", { user: "U1", text: "Lunch at the truck?" });
  await live.joinFor(BOARD, "C0RANDOM01", ada);
  assert.equal(calls.filter((c) => c === "/conversations.join").length, 1);
  assert.equal(state("C0RANDOM01").state, "live");
  assert.match(note(state("C0RANDOM01").latestNote), /Lunch at the truck/);
  assert.ok(boardMaps(doc()).activity.toArray().some((a) => a.who === "Ada" && /join #random/.test(a.text)));
  // a private channel can't be joined: it keeps waiting, with Slack's reason
  await assert.rejects(() => live.joinFor(BOARD, "G0SECRET01", ada));
  assert.equal(state("G0SECRET01").state, "waiting");
});

test("agents: nothing runs until a person turns them on; then one rewrites the summary under its own name", async () => {
  const runs = () => all<{ prompt: string; created_by: string; status: string }>("select prompt, created_by, status from agent_runs where board_id = ?", BOARD);
  live.setCurator((o) => startRun(o));

  // off: a new message is read in, and no agent starts
  post("C0GENERAL1", { user: "U1", text: "Shipping the fan Monday" });
  live.fromBridge({ type: "event", event: { type: "message", channel: "C0GENERAL1" } }, { loopback: true });
  await until("the message", () => /Shipping the fan/.test(note(state("C0GENERAL1").latestNote)));
  await sleep(150);
  assert.equal(runs().length, 0, "no agent turn without a person's say-so");
  assert.match(note(state("C0GENERAL1").summaryNote), /not a written summary/);

  // on: every section says who turned it on, and each channel with something to say gets its turn, one at a time
  live.setAgents(BOARD, ada, true);
  assert.equal(state("C0GENERAL1").agents?.by, "Ada");
  await until("the agents to finish", () => Boolean(state("C0GENERAL1").summaryBy && state("C0DESIGN01").summaryBy && state("C0RANDOM01").summaryBy), 10_000);

  const general = state("C0GENERAL1");
  const summary = note(general.summaryNote);
  assert.match(summary, /## #general[\s\S]*Shipping the fan Monday[\s\S]*Written from the last 3 messages/);
  assert.doesNotMatch(summary, /A digest the server made/);
  assert.ok(runs().every((r) => r.created_by === ada.id), "the runs are Ada's");
  assert.equal(runs().length, 3, "one turn per channel that had something new; none for the one that's waiting");
  // the agent signed its work, and put the section in order (cards docked into the flow)
  assert.ok(boardMaps(doc()).activity.toArray().some((a) => a.who === general.summaryBy && a.role === "agent" && a.for === "Ada"));
  const design = pictures("C0DESIGN01");
  assert.ok(design.every((p) => !p.float), "the agent arranged the section");
  assert.ok(design.some((p) => p.name === "Newest from #design"), "and named a picture");

  // from here the summary is the agent's: a new read doesn't put the digest back
  post("C0GENERAL1", { user: "U2", text: "Monday confirmed" });
  await live.syncChannel(BOARD, "C0GENERAL1");
  assert.match(note(state("C0GENERAL1").latestNote), /Monday confirmed/);
  assert.doesNotMatch(note(state("C0GENERAL1").summaryNote), /A digest the server made/);
  // a new picture in a section an agent arranged joins the flow, it doesn't go back to the server's columns
  post("C0DESIGN01", { user: "U1", text: "Lip detail", subtype: "file_share", files: [img("F5", "lip.png")] });
  await live.syncChannel(BOARD, "C0DESIGN01");
  assert.equal(pictures("C0DESIGN01").find((p) => /Lip detail/.test(p.name))?.float, false);

  // not again within the minimum wait (10 min by default), however much is posted
  await sleep(200);
  assert.equal(runs().length, 3);

  // off: the mark says so, and nothing is queued
  live.setAgents(BOARD, ada, false);
  assert.equal(state("C0GENERAL1").agents, undefined);
});

test("the Slack app goes quiet: sections fall back to being read in turn, and say so", async () => {
  live._bridgeGone();
  await live.tick();
  assert.equal(state("C0GENERAL1").state, "polling");
  assert.equal(state("G0SECRET01").state, "waiting");
  const status = await live.slackLiveStatus();
  assert.equal(status.app.live, false);
  assert.deepEqual([status.boards[0].sections, status.boards[0].polling, status.boards[0].waiting], [4, 3, 1]);
});

test("a section someone removed stays removed; a renamed channel renames its section", async () => {
  const gone = sectionOf("C0RANDOM01");
  getBoard(BOARD).doc.transact(() => boardMaps(doc()).sections.delete(gone));
  channels.find((c) => c.id === "C0DESIGN01")!.name = "industrial-design";
  channels.push({ id: "C0NEWCHAN1", name: "launch", is_private: false, is_member: true, topic: { value: "" } });
  post("C0NEWCHAN1", { user: "U1", text: "T minus ten days" });
  await live.refreshChannels();
  const names = [...boardMaps(doc()).sections.values()].map((s) => s.name).sort();
  assert.deepEqual(names, ["#board-only", "#general", "#industrial-design", "#launch"]);
  assert.equal(slackSectionOf(doc(), gone), undefined);
  await until("the new channel to be read", () => /T minus ten days/.test(note(state("C0NEWCHAN1").latestNote)));
});

test("people can't write the slack map: only the server says how a connection stands", async () => {
  const Y = await import("yjs");
  const { attachConnection } = await import("../src/boards.ts");
  const { WebSocketServer, WebSocket } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => attachConnection(BOARD, ws, false, ada.id));
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  await new Promise<void>((r) => ws.once("open", () => r()));
  const sec = sectionOf("C0GENERAL1");
  const before = structuredClone(state("C0GENERAL1"));
  // a forged update, as a socket would send it: a sync-update message carrying a write to `slack`
  const fake = new Y.Doc();
  Y.applyUpdate(fake, Y.encodeStateAsUpdate(doc()));
  const sv = Y.encodeStateVector(fake);
  fake.getMap("slack").set(sec, { ...before, state: "live", detail: "trust me", summaryBy: "Mallory" });
  const update = Y.encodeStateAsUpdate(fake, sv);
  const enc = await import("lib0/encoding");
  const e = enc.createEncoder();
  enc.writeVarUint(e, 0); // sync
  enc.writeVarUint(e, 2); // update
  enc.writeVarUint8Array(e, update);
  ws.send(enc.toUint8Array(e));
  await sleep(150);
  assert.deepEqual(state("C0GENERAL1"), before, "the forged state didn't stay");
  ws.close();
  wss.close();
});

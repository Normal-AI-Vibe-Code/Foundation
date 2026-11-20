/**
 * ChatForm's history (package I1): a Slack export (the fixture in fixtures/slack-export, zipped here with
 * the importer's own zip writer) and Slack's API (a stand-in on a port) come in through one mapping, once;
 * ChatForm's export holds only what the asker can see. Real routes on a real port, real sessions.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { readdir } from "node:fs/promises";
import type { ChatChannelView, ChatMessage, ChatPage } from "@foundation/protocol";
import type { ImportJob, ImportReport } from "../src/chatimport.ts";

const TMP = mkdtempSync(join(tmpdir(), "foundation-chatimport-"));
process.env.FOUNDATION_DATA_DIR = TMP;
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);
process.env.FOUNDATION_CHAT_PREVIEWS = "0";
delete process.env.SLACK_BOT_TOKEN;
process.env.SLACK_USER_TOKEN = "xoxp-test";

const FIXTURE = join(import.meta.dirname, "fixtures", "slack-export");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");

// ---------- stand-ins: Slack's file host and Slack's Web API ----------

const fileHits: string[] = [];
const files = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  fileHits.push(url.pathname + url.search);
  if (url.searchParams.get("t") === "xoxe-expired") return res.writeHead(403, { "content-type": "text/plain" }).end("expired");
  if (url.pathname.endsWith("/shroud.png") && url.searchParams.get("t") === "xoxe-ok") return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  // the API's files: no ?t=, the token in the header
  if (url.pathname.endsWith("/api-file.txt") && req.headers.authorization === "Bearer xoxp-test") return res.writeHead(200, { "content-type": "text/plain" }).end("from the api");
  res.writeHead(404).end();
});

const D1 = 1772442000;
const D3 = 1772614800;
const ts = (day: number, n: number) => `${day + n * 60}.${String(100 + n).padStart(6, "0")}`;
const apiCalls: string[] = [];
let limited = false;
const users = JSON.parse(readFileSync(join(FIXTURE, "users.json"), "utf8"));
const NEWBIE = { id: "U05NEW", name: "newbie", real_name: "Nell Newbie", profile: { real_name: "Nell Newbie", email: "nell@elsewhere.example" } };
const apiMsg = (user: string, t: string, text: string, more: Record<string, unknown> = {}) => ({ type: "message", user, ts: t, text, ...more });
const HISTORY: Record<string, Array<Array<Record<string, unknown>>>> = {
  // newest first, as Slack pages them; the first two are already here from the export
  C01GENERAL: [[apiMsg("U01ADA", `${D3 + 6000}.000100`, "topped up from the API"), apiMsg("U01ADA", ts(D1, 2), "Morning (already here)", { thread_ts: ts(D1, 2), reply_count: 2 })]],
  C09NEW: [
    [apiMsg("U05NEW", `${D3 + 7200}.000200`, "second, with a file", { files: [{ id: "F09API", name: "api-file.txt", mimetype: "text/plain", size: 12, url_private_download: "https://files.slack.com/files-pri/T0FORM-F09API/download/api-file.txt" }] })],
    [apiMsg("U01ADA", `${D3 + 7000}.000100`, "first in a channel the export didn't have", { thread_ts: `${D3 + 7000}.000100`, reply_count: 1 })],
  ],
  D01ADANOA: [[apiMsg("U02NOA", `${D3 + 9000}.000100`, "one more private word"), apiMsg("U02NOA", ts(D3, 0), "already here")]],
};
const REPLIES: Record<string, Array<Record<string, unknown>>> = {
  [`C09NEW:${D3 + 7000}.000100`]: [apiMsg("U01ADA", `${D3 + 7000}.000100`, "first", { thread_ts: `${D3 + 7000}.000100` }), apiMsg("U05NEW", `${D3 + 7100}.000100`, "a reply from the API", { thread_ts: `${D3 + 7000}.000100` })],
  [`C01GENERAL:${ts(D1, 2)}`]: [apiMsg("U01ADA", ts(D1, 2), "root"), apiMsg("U02NOA", ts(D1, 3), "already here", { thread_ts: ts(D1, 2) })],
};
const slackApi = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const method = url.pathname.slice(1);
  apiCalls.push(method + (url.searchParams.get("cursor") ? `#${url.searchParams.get("cursor")}` : ""));
  const send = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (req.headers.authorization !== "Bearer xoxp-test") return send({ ok: false, error: "invalid_auth" });
  const cursor = url.searchParams.get("cursor") ?? "";
  if (method === "auth.test") return send({ ok: true, user_id: "U01ADA", team: "Form" });
  if (method === "users.list") return cursor ? send({ ok: true, members: [users[2], NEWBIE] }) : send({ ok: true, members: [users[0], users[1]], response_metadata: { next_cursor: "u2" } });
  if (method === "conversations.list")
    return cursor
      ? send({ ok: true, channels: [{ id: "C09NEW", name: "api-only", is_private: true, is_group: true, created: D3 }, { id: "D01ADANOA", is_im: true, user: "U02NOA", created: D3 }] })
      : send({ ok: true, channels: [{ id: "C01GENERAL", name: "general", is_channel: true, created: D1 }], response_metadata: { next_cursor: "c2" } });
  if (method === "conversations.members") return send({ ok: true, members: url.searchParams.get("channel") === "C09NEW" ? ["U01ADA", "U05NEW"] : ["U01ADA", "U02NOA"] });
  if (method === "conversations.history") {
    if (!limited) {
      limited = true;
      return res.writeHead(429, { "retry-after": "0" }).end();
    }
    const pages = HISTORY[url.searchParams.get("channel") ?? ""] ?? [[]];
    const i = cursor ? Number(cursor) : 0;
    return send({ ok: true, messages: pages[i] ?? [], has_more: i + 1 < pages.length, ...(i + 1 < pages.length ? { response_metadata: { next_cursor: String(i + 1) } } : {}) });
  }
  if (method === "conversations.replies") return send({ ok: true, messages: REPLIES[`${url.searchParams.get("channel")}:${url.searchParams.get("ts")}`] ?? [] });
  send({ ok: false, error: "unknown_method" });
});

await new Promise<void>((r) => files.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => slackApi.listen(0, "127.0.0.1", r));
process.env.CHATIMPORT_TEST_FILE_ORIGIN = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
process.env.SLACK_API_BASE = `http://127.0.0.1:${(slackApi.address() as AddressInfo).port}`;

const { one, run, all } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const imp = await import("../src/chatimport.ts");
const { closeBoards } = await import("../src/boards.ts");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const bob = auth.upsertUser("bob@formindustries.com", "Bob Stone");
const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), bob: cookieOf(bob.id) };
const bossAgent = auth.createSession(boss.id, 3600_000, "agent");

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  imp.chatImportRoutes(r);
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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  files.close();
  slackApi.close();
  closeBoards();
});

type Who = string | { bearer: string };
async function api<T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof who === "string") headers.cookie = who;
  else headers.authorization = `Bearer ${who.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed as T };
}

type Job = ImportJob;
type Report = ImportReport;
async function finished(id: string): Promise<{ job: Job; report: Report }> {
  await imp.jobDone(id);
  const r = await api<{ job: Job; report: Report }>(C.boss, "GET", `/api/chat/history/jobs/${id}`);
  assert.equal(r.status, 200);
  assert.notEqual(r.body.job.state, "running");
  return r.body;
}

/** the fixture folder as a zip, written by the importer's writer */
async function zipFolder(dir: string, out: string, zip64 = false) {
  const ws = createWriteStream(out);
  const z = new imp.ZipWriter(ws, { zip64 });
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else await z.add(`${rel}${e.name}`, readFileSync(join(d, e.name)));
    }
  };
  await walk(dir, "");
  await z.finish();
  await new Promise<void>((r) => ws.end(r));
}

const ZIP = join(TMP, "slack-export.zip");
let uploadId = "";
let generalId = "";
let nativeId = "";
let adaUnreadBefore = 0;
const slackChannel = (id: string) => chat.channelByOrigin("slack", id)!;
const page = async (who: string, channel: string, q = "") => (await api<ChatPage>(who, "GET", `/api/chat/channels/${channel}/messages?limit=200${q}`)).body;

test("the zip reader reads what the writer writes, zip64 and all", async () => {
  await zipFolder(FIXTURE, ZIP);
  const z64 = join(TMP, "z64.zip");
  await zipFolder(FIXTURE, z64, true);
  for (const p of [ZIP, z64]) {
    const z = await imp.ZipReader.open(p);
    assert.ok(z.entries.has("users.json") && z.entries.has("general/2026-03-02.json"));
    assert.deepEqual(JSON.parse(await z.text("users.json")), JSON.parse(readFileSync(join(FIXTURE, "users.json"), "utf8")));
  }
  // a big stored entry streams back byte for byte
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  big.write("start", 0);
  const p = join(TMP, "big.zip");
  const ws = createWriteStream(p);
  const z = new imp.ZipWriter(ws);
  const src = new PassThrough();
  const done = z.addStream("big.bin", src);
  src.end(big);
  await done;
  await z.finish();
  await new Promise<void>((r) => ws.end(r));
  const back = await imp.ZipReader.open(p);
  const chunks: Buffer[] = [];
  for await (const c of await back.stream(back.entries.get("big.bin")!)) chunks.push(c as Buffer);
  assert.ok(Buffer.concat(chunks).equals(big));
});

test("only an admin, as a person, brings history in", async () => {
  // ChatForm's own #general already has a word in it, said between Slack's first and second day
  const g = chat.ensureGeneral();
  generalId = g.id;
  chat.addMember(g.id, chat.personParty(ada), { silent: true });
  nativeId = chat.postMessage(g.id, chat.personParty(boss), { text: "said in ChatForm before the move", createdAt: (D1 + 86400 - 3600) * 1000 }).id;
  adaUnreadBefore = chat.unreadsFor(ada).total;
  assert.equal(adaUnreadBefore, 2); // Boss joined, and said something

  const bobSees = await api<{ canImport: boolean; why?: string; token: { configured: boolean } }>(C.bob, "GET", "/api/chat/history");
  assert.equal(bobSees.body.canImport, false);
  assert.match(bobSees.body.why ?? "", /admin/);
  const bossSees = await api<{ canImport: boolean; token: { configured: boolean; kind: string } }>(C.boss, "GET", "/api/chat/history");
  assert.equal(bossSees.body.canImport, true);
  assert.deepEqual(bossSees.body.token, { configured: true, kind: "user" });

  const up = await fetch(`${base}/api/chat/history/upload?name=slack-export.zip`, { method: "POST", headers: { cookie: C.bob }, body: readFileSync(ZIP) });
  assert.equal(up.status, 403);
  for (const who of [C.bob, { bearer: bossAgent }] as Who[]) {
    assert.equal((await api(who, "POST", "/api/chat/history/import", { place: "x", path: "y" })).status, 403);
    assert.equal((await api(who, "POST", "/api/chat/history/pull", {})).status, 403);
  }
  const agentUp = await fetch(`${base}/api/chat/history/upload`, { method: "POST", headers: { authorization: `Bearer ${bossAgent}` }, body: "PK" });
  assert.equal(agentUp.status, 403);

  // the admin's upload streams to disk beside the database
  const ok = await fetch(`${base}/api/chat/history/upload?name=slack-export.zip`, { method: "POST", headers: { cookie: C.boss }, body: createReadStream(ZIP) as never, duplex: "half" } as RequestInit);
  assert.equal(ok.status, 200);
  const { upload } = (await ok.json()) as { upload: { id: string; size: number } };
  assert.equal(upload.size, statSync(ZIP).size);
  uploadId = upload.id;
});

test("a dry run says what would come in and writes nothing", async () => {
  const before = one<{ n: number }>("select count(*) as n from chat_messages")!.n;
  const r = await api<{ job: Job }>(C.boss, "POST", "/api/chat/history/import", { upload: uploadId, dryRun: true });
  assert.equal(r.status, 200);
  const { job, report } = await finished(r.body.job.id);
  assert.equal(job.state, "done");
  assert.equal(report.dryRun, true);
  assert.equal(one<{ n: number }>("select count(*) as n from chat_messages")!.n, before);
  assert.equal(chat.channelByOrigin("slack", "C02DESIGN"), undefined);
  assert.deepEqual(report.people.matched.map((m) => m.email), ["ada@formindustries.com"]);
  assert.equal(report.people.ghosts, 1);
  assert.equal(report.people.bots, 1);
  assert.deepEqual([report.totals.open, report.totals.private, report.totals.dm, report.totals.group], [3, 1, 1, 1]);
  assert.equal(report.totals.files, 2); // to fetch; a dry run doesn't know which links have expired
  assert.ok(report.totals.messages >= 20, `messages: ${report.totals.messages}`);
  assert.equal(fileHits.length, 0);
});

let firstTotals: Report["totals"];
test("an export comes in whole: people, channels, threads, reactions, pins, edits, files, mrkdwn", async () => {
  const r = await api<{ job: Job }>(C.boss, "POST", "/api/chat/history/import", { upload: uploadId, request_id: "imp-1" });
  const again = await api<{ job: Job; already: boolean }>(C.boss, "POST", "/api/chat/history/import", { upload: uploadId, request_id: "imp-1" });
  assert.equal(again.body.job.id, r.body.job.id);
  assert.equal(again.body.already, true);
  const { job, report } = await finished(r.body.job.id);
  assert.equal(job.state, "done", job.error);
  firstTotals = report.totals;

  // #general: merged into ChatForm's own, with Slack's id on it, in time order around the word said here
  const general = slackChannel("C01GENERAL");
  assert.equal(general.id, generalId);
  assert.ok(report.conversations.find((c) => c.slackId === "C01GENERAL")?.merged);
  const top = (await page(C.ada, generalId)).messages;
  const times = top.map((m) => m.createdAt);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const seqs = top.map((m) => m.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const nativeAt = top.findIndex((m) => m.id === nativeId);
  assert.ok(nativeAt > 0 && nativeAt < top.length - 1, "the ChatForm word sits between Slack's two days");

  const byText = (re: RegExp) => top.find((m) => re.test(m.text))!;
  const morning = byText(/^Morning/);
  // Ada is Ada (her email matched); the mrkdwn reads as markdown here
  assert.equal(morning.author.kind, "person");
  assert.equal(morning.author.id, ada.id);
  assert.match(morning.text, /Morning \*\*team\*\*! _Shroud rev 3_ is ~~nearly~~ done in #design\./);
  assert.match(morning.text, /cc @noa\.kim @here: see \[the spec\]\(https:\/\/formindustries\.com\/shroud\) or mail \[me\]\(mailto:ada@formindustries\.com\) 🚀 👍/);
  assert.match(morning.text, /`keep \*this\* literal` <tag> & @engineers on Mar 2nd/);
  assert.equal(morning.pinned, true);
  assert.ok(morning.editedAt && morning.editedAt > morning.createdAt);
  assert.equal(morning.createdAt, Math.round(Number(ts(D1, 2)) * 1000));
  // reactions: skin tones fold into one 👍, by the people who reacted; a custom emoji keeps its name
  const thumbs = morning.reactions.find((x) => x.emoji === "👍")!;
  assert.deepEqual([...thumbs.by].sort(), ["Ada Lovelace", "Noa Kim"]);
  assert.ok(morning.reactions.some((x) => x.emoji === ":party_parrot:"));
  assert.ok(one("select 1 from chat_reactions where message_id = ? and party_kind = 'person' and party_id = ?", morning.id, ada.id));
  // the thread
  assert.equal(morning.replyCount, 2);
  const thread = (await page(C.ada, generalId, `&root=${morning.id}`)).messages;
  assert.deepEqual(thread.map((m) => m.text), [morning.text, "Looks great @ada.lovelace, I'll check the lip", "Shipping Friday"]);
  const noaReply = thread[1];
  assert.equal(noaReply.author.kind, "ghost");
  assert.equal(noaReply.author.service, "slack");
  assert.equal(noaReply.author.name, "Noa Kim");
  assert.deepEqual(noaReply.mentions, [ada.id], "<@U01ADA> is a working mention of Ada here");
  // a bot is a ghost that says it's a bot, its attachment flattened
  const deploy = top.find((m) => /Deploy finished/.test(m.text))!;
  assert.equal(deploy.author.kind, "ghost");
  assert.equal(deploy.author.name, "deploybot (bot)");
  assert.match(deploy.author.handle ?? "", /^bot:/);
  assert.match(deploy.text, /> \*\*\[build #42\]\(https:\/\/ci\.formindustries\.com\/42\)\*\*\n> All checks \*\*green\*\*\n> \*\*Env\*\*: prod/);
  // files: the live link came in; the expired one is a named, sized placeholder with its Slack link
  const render = byText(/^the render/);
  assert.equal(render.files.length, 1);
  assert.equal(render.files[0].name, "shroud.png");
  assert.equal(render.files[0].size, PNG.length);
  assert.ok(chat.canSeeChatFile(ada, render.files[0].id));
  assert.ok(chat.canSeeChatFile(bob, render.files[0].id), "anyone who reads #general opens its files");
  const spec = byText(/^spec attached/);
  assert.equal(spec.files.length, 0);
  assert.match(spec.text, /📎 \*\*spec\.pdf\*\* \(200 KB\): not brought in, the link has expired \(HTTP 403\)\. \[Open in Slack\]\(https:\/\/form\.slack\.com\/files\/U01ADA\/F02SPEC\/spec\.pdf\)/);
  assert.equal(report.totals.files, 1);
  assert.equal(report.totals.filesMissing, 1);
  assert.ok(report.skipped.some((s) => /placeholder: the link has expired/.test(s.why) && s.count === 1));
  // block-only rich text, a /me, someone Slack's users.json didn't know, the housekeeping
  const agenda = byText(/Agenda/);
  assert.equal(agenda.text, "**Agenda** for @noa.kim 🎉\n- shroud\n- [Q2 plan](https://formindustries.com/q2)\n```\nnpm run ship\n```");
  assert.equal(byText(/waves/).text, "_waves at everyone_");
  assert.equal(byText(/hi from outside/).author.name, "Guest Person");
  const sys = top.filter((m) => m.type === "system").map((m) => m.text);
  assert.ok(sys.includes("Ada Lovelace joined."));
  assert.ok(sys.includes("Ada Lovelace set the topic: Shipping the shroud"));
  assert.ok(sys.includes("Ada Lovelace pinned a message."));
  assert.ok(sys.includes("Guest Person left."));
  assert.ok(sys.some((t) => /^A huddle in Slack: Standup · 15 min · Ada Lovelace, Noa Kim$/.test(t)));
  // what wasn't brought in as it was, and why
  const why = report.skipped.map((s) => s.why);
  assert.ok(why.includes('unknown subtype "weird_new_thing": brought in as a plain message'));
  assert.ok(why.some((w) => /^canvas/.test(w)));
  assert.ok(why.some((w) => /^integration log/.test(w)));
  assert.ok(why.some((w) => /^folder with no conversation/.test(w)));
  assert.match(imp.reportMarkdown(report), /## Skipped or changed[\s\S]*weird_new_thing/);

  // the other conversations
  const design = slackChannel("C02DESIGN");
  assert.equal(design.kind, "open");
  assert.equal(design.purpose, "Shroud, housings, renders");
  assert.match((await page(C.ada, design.id)).messages.at(-1)!.text, /rev 3 is in, see #general/);
  const old = slackChannel("C03OLD");
  assert.ok(old.archivedAt, "an archived Slack channel is archived here");
  const secret = slackChannel("G01SECRET");
  assert.equal(secret.kind, "private");
  assert.equal(secret.topic, "Don't tell anyone");
  assert.deepEqual(secret.members!.map((m) => m.name).sort(), ["Ada Lovelace", "Noa Kim"]);
  const dm = slackChannel("D01ADANOA");
  assert.equal(dm.kind, "dm");
  const group = slackChannel("G02MPIM");
  assert.equal(group.kind, "group");
  assert.deepEqual(group.members!.map((m) => m.name).sort(), ["Ada Lovelace", "Noa Kim", "deploybot (bot)"]);
  const groupMsgs = (await page(C.ada, group.id)).messages;
  assert.equal(new Set(groupMsgs.filter((m) => m.author.kind === "ghost" && /bot/.test(m.author.name)).map((m) => m.author.id)).size, 1, "a bot is one ghost whichever way it posts");
  assert.equal(groupMsgs.find((m) => /deploy/.test(m.text) && m.author.kind === "ghost")!.author.id, group.members!.find((m) => /bot/.test(m.name))!.id);

  // nothing came in as unread for the people who were caught up
  // (what Ada hadn't read in #general before, the two lines said in ChatForm, is all she has unread now)
  const unreads = await api<{ total: number; mentions: number; channels: Array<{ id: string; unread: number }> }>(C.ada, "GET", "/api/chat/unreads");
  assert.deepEqual(unreads.body.channels.map((c) => [c.id, c.unread]), [[generalId, adaUnreadBefore]]);
  assert.equal(unreads.body.mentions, 0);
});

test("imported DMs and private channels stay with their members; admins don't read them", async () => {
  const dm = slackChannel("D01ADANOA");
  const secret = slackChannel("G01SECRET");
  for (const id of [dm.id, secret.id]) {
    assert.equal((await api(C.ada, "GET", `/api/chat/channels/${id}`)).status, 200);
    assert.equal((await api(C.bob, "GET", `/api/chat/channels/${id}`)).status, 404);
    assert.equal((await api(C.boss, "GET", `/api/chat/channels/${id}`)).status, 404);
    assert.equal((await api(C.boss, "GET", `/api/chat/channels/${id}/messages`)).status, 404);
  }
  const list = await api<{ channels: ChatChannelView[] }>(C.bob, "GET", "/api/chat");
  assert.ok(!list.body.channels.some((c) => c.id === dm.id || c.id === secret.id));
  const found = await api<{ hits: unknown[] }>(C.bob, "GET", "/api/chat/search?q=private");
  assert.equal(found.body.hits.length, 0);
  assert.ok((await api<{ hits: unknown[] }>(C.ada, "GET", "/api/chat/search?q=private")).body.hits.length > 0);
});

test("bringing the same export in again adds nothing", async () => {
  const count = () => one<{ n: number }>("select count(*) as n from chat_messages")!.n;
  const chans = () => one<{ n: number }>("select count(*) as n from chat_channels")!.n;
  const reacts = () => one<{ n: number }>("select count(*) as n from chat_reactions")!.n;
  const before = [count(), chans(), reacts(), one<{ n: number }>("select count(*) as n from files")!.n];
  const r = await api<{ job: Job }>(C.boss, "POST", "/api/chat/history/import", { upload: uploadId });
  const { report } = await finished(r.body.job.id);
  assert.equal(report.totals.messages, 0);
  assert.equal(report.totals.already, firstTotals.messages);
  assert.deepEqual([count(), chans(), reacts(), one<{ n: number }>("select count(*) as n from files")!.n], before);
  // the folder, unzipped, is the same export: still nothing new
  const { job } = imp.startImport(boss, { kind: "export", path: FIXTURE });
  await imp.jobDone(job.id);
  assert.equal(imp.jobReport(job.id)!.totals.messages, 0);
  assert.equal(count(), before[0]);
});

test("a Slack person who signs in later becomes themselves", async () => {
  const dm = slackChannel("D01ADANOA");
  const noaGhost = dm.members!.find((m) => m.name === "Noa Kim")!;
  assert.equal(noaGhost.kind, "ghost");
  const noa = auth.upsertUser("noa@formindustries.com", "Noa Kim");
  // signing up is what links them (auth.upsertUser asks chatimport, a moment later)
  for (let i = 0; i < 100 && chat.getChannel(dm.id)!.members!.some((m) => m.kind === "ghost"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(imp.linkGhostsByEmail(noa), 0, "already themselves");
  const after = chat.getChannel(dm.id)!;
  assert.ok(after.members!.some((m) => m.kind === "person" && m.id === noa.id));
  assert.ok(!after.members!.some((m) => m.kind === "ghost"));
  const C_noa = cookieOf(noa.id);
  assert.equal((await api(C_noa, "GET", `/api/chat/channels/${dm.id}`)).status, 200);
  const msgs = (await page(C_noa, dm.id)).messages;
  assert.equal(msgs.find((m) => /private question/.test(m.text))!.author.id, noa.id);
  assert.deepEqual(msgs.find((m) => /call me/.test(m.text))!.reactions, [{ emoji: "❤️", by: ["Noa Kim"] }]);
  // the dm is now the dm of these two people: opening one finds it
  assert.equal(chat.openDirect([chat.personParty(ada), chat.personParty(noa)]).id, dm.id);
  // and Slack's ghost speaks as her from now on (a later import, the API)
  assert.equal(chat.ghostParty("slack", "U02NOA", "Noa Kim").kind, "person");
  assert.equal(all("select 1 from chat_messages where author_kind = 'ghost' and author_id = ?", noaGhost.id).length, 0);
});

test("Slack's API tops up: pages, a 429, replies, files with the token, and nothing doubled", async () => {
  const general = slackChannel("C01GENERAL");
  const dm = slackChannel("D01ADANOA");
  const n = (id: string) => one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", id)!.n;
  const [g0, d0] = [n(general.id), n(dm.id)];
  const r = await api<{ job: Job }>(C.boss, "POST", "/api/chat/history/pull", {});
  assert.equal(r.status, 200);
  const { job, report } = await finished(r.body.job.id);
  assert.equal(job.state, "done", job.error);
  assert.ok(apiCalls.includes("users.list#u2") && apiCalls.includes("conversations.list#c2") && apiCalls.includes("conversations.history#1"), apiCalls.join(" "));
  assert.ok(report.warnings.some((w) => /slow down 1 time/.test(w)));
  assert.equal(n(general.id), g0 + 1);
  assert.equal(n(dm.id), d0 + 1);
  assert.equal(report.totals.already, 3);
  const fresh = slackChannel("C09NEW");
  assert.equal(fresh.kind, "private");
  const msgs = (await page(C.ada, fresh.id)).messages;
  assert.deepEqual(msgs.map((m) => m.text), ["first in a channel the export didn't have", "second, with a file"]);
  assert.equal(msgs[0].replyCount, 1);
  assert.equal(msgs[1].author.name, "Nell Newbie");
  assert.equal(msgs[1].files[0]?.name, "api-file.txt");
  // the same again: nothing new
  const r2 = await api<{ job: Job }>(C.boss, "POST", "/api/chat/history/pull", {});
  const second = await finished(r2.body.job.id);
  assert.equal(second.report.totals.messages, 0);
});

test("the report downloads as Markdown", async () => {
  const id = imp.recentJobs(20).find((j) => j.kind === "export" && !j.dryRun)!.id;
  const res = await fetch(`${base}/api/chat/history/jobs/${id}/report`, { headers: { cookie: C.boss } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /slack-import-.*\.md/);
  assert.match(await res.text(), /^# Slack history: what came in/);
  assert.equal((await fetch(`${base}/api/chat/history/jobs/${id}/report`, { headers: { cookie: C.bob } })).status, 403);
});

test("ChatForm's export holds exactly what the asker can see", async () => {
  const grab = async (who: string, q = "") => {
    const res = await fetch(`${base}/api/chat/history/export${q}`, { headers: { cookie: who } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    const p = join(TMP, `export-${Math.random().toString(36).slice(2)}.zip`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(p, Buffer.from(await res.arrayBuffer()));
    return imp.ZipReader.open(p);
  };
  const dm = slackChannel("D01ADANOA");
  const secret = slackChannel("G01SECRET");
  const bobs = await grab(C.bob);
  const bobChannels = JSON.parse(await bobs.text("channels.json")) as ChatChannelView[];
  assert.ok(bobChannels.some((c) => c.id === generalId));
  assert.ok(!bobChannels.some((c) => c.id === dm.id || c.id === secret.id));
  const allText = (await Promise.all([...bobs.entries.keys()].map((k) => bobs.text(k)))).join("\n");
  assert.ok(!/private question|secret plans/i.test(allText), "nothing of a DM or private channel in someone else's export");
  assert.ok(![...bobs.entries.keys()].some((k) => k.startsWith("files/")));

  const adas = await grab(C.ada, "?files=1");
  const adaChannels = JSON.parse(await adas.text("channels.json")) as ChatChannelView[];
  assert.ok(adaChannels.some((c) => c.id === dm.id) && adaChannels.some((c) => c.id === secret.id));
  const general = [...adas.entries.keys()].find((k) => /^channels\/general\/messages\.json$/.test(k))!;
  const data = JSON.parse(await adas.text(general)) as { messages: ChatMessage[] };
  assert.ok(data.messages.some((m) => /^Morning/.test(m.text)));
  assert.match(await adas.text("channels/general/messages.md"), /# #general/);
  const people = JSON.parse(await adas.text("people.json")) as Array<{ name: string }>;
  assert.ok(people.some((p) => p.name === "deploybot (bot)"));
  const png = [...adas.entries.keys()].find((k) => k.startsWith("files/") && k.endsWith("shroud.png"))!;
  const chunks: Buffer[] = [];
  for await (const c of await adas.stream(adas.entries.get(png)!)) chunks.push(c as Buffer);
  assert.ok(Buffer.concat(chunks).equals(PNG));
  void run;
});

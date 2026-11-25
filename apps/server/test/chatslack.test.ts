/**
 * ChatForm's live Slack bridge (bridges/slack.ts) against a stand-in Slack (SLACK_API_BASE): linking (an
 * admin in person, never an agent), what comes in (people by email or as ghosts, threads, edits, deletions,
 * reactions, files, bots; once, however often Slack says so), what goes out (a person's words as "Name via
 * Foundation", in the thread; an agent's as a draft until a person sends it), its echo never mirrored back,
 * failures marked and retried once, rate limits obeyed, DMs never bridged, unlinking keeping everything.
 * And the sealed store for the keys the wizards are given (bridgesecrets.ts).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatPage } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-chatslack-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_SLACK_BRIDGE_EVENT_MS = "10";
for (const k of Object.keys(process.env)) if (/^(SLACK|WHATSAPP|INSTAGRAM|WECOM|GMAIL|GOOGLE)_/.test(k)) delete process.env[k];

// tokens are made at run time: nothing secret-shaped sits in the repository
const BOT = ["xo", "xb-"].join("") + "4242-" + Math.random().toString(36).slice(2, 14) + "abcdEFGH";

// ---------- the stand-in Slack ----------

interface Msg {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text: string;
  subtype?: string;
  thread_ts?: string;
  edited?: { user: string; ts: string };
  reactions?: Array<{ name: string; users: string[]; count: number }>;
  files?: Array<{ id: string; name: string; mimetype: string; size: number; url_private_download: string }>;
  metadata?: unknown;
}
const CH = {
  general: { id: "C0GENERAL1", name: "general", is_private: false, is_member: true },
  shop: { id: "C0SHOPFLR1", name: "shop-floor", is_private: false, is_member: true },
  outside: { id: "C0OUTSIDE1", name: "outside", is_private: false, is_member: false },
  secret: { id: "G0SECRET01", name: "board-only", is_private: true, is_member: false },
  dm: { id: "D0DIRECT01", name: "", is_private: false, is_im: true, is_member: true },
};
const PEOPLE: Record<string, { name: string; email?: string; bot?: boolean }> = {
  U0ADA: { name: "Ada Lovelace", email: "ada@formindustries.com" },
  U0SAM: { name: "Sam Okafor", email: "sam@elsewhere.example" },
  U0BOB: { name: "Bob Stone", email: "bob@formindustries.com" },
};
const history = new Map<string, Msg[]>();
const posts: Array<{ method: string; body: Record<string, unknown> }> = [];
const limited = new Map<string, number>();
const failing = new Map<string, string>();
let scopes = "channels:read,groups:read,channels:history,groups:history,channels:join,chat:write,chat:write.customize,users:read,users:read.email,files:read,reactions:read,files:write";
let tsN = 0;
const nextTs = () => `${Math.floor(Date.now() / 1000) + 100 + ++tsN}.000${String(tsN).padStart(3, "0")}`;
let slack: Server;
let slackBase = "";

function say(channel: string, m: Omit<Msg, "ts"> & { ts?: string }): string {
  const list = history.get(channel) ?? [];
  const ts = m.ts ?? nextTs();
  list.push({ ...m, ts });
  history.set(channel, list);
  return ts;
}
const find = (channel: string, ts: string) => (history.get(channel) ?? []).find((m) => m.ts === ts)!;

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
}

before(async () => {
  slack = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = url.pathname.slice(1);
    const json = (o: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(o));
    };
    // file bytes (an inbound file's private link, rewritten here by CHATIMPORT_TEST_FILE_ORIGIN) and our uploads
    if (url.pathname.startsWith("/files-pri/")) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("bracket drawing v2");
    }
    if (url.pathname.startsWith("/upload/")) {
      await bodyOf(req);
      posts.push({ method: "upload", body: { id: url.pathname.slice(8) } });
      return res.end("OK");
    }
    if (req.headers.authorization !== `Bearer ${BOT}`) return json({ ok: false, error: "invalid_auth" });
    const left = limited.get(method) ?? 0;
    if (left > 0) {
      limited.set(method, left - 1);
      res.writeHead(429, { "retry-after": "1" });
      return res.end();
    }
    const q = url.searchParams;
    const body = req.method === "POST" ? await bodyOf(req) : {};
    const arg = (k: string) => (req.method === "POST" ? (body[k] as string | undefined) : (q.get(k) ?? undefined));
    if (req.method === "POST") posts.push({ method, body });
    if (failing.has(method)) {
      const code = failing.get(method)!;
      failing.delete(method);
      return json({ ok: false, error: code });
    }
    const chan = Object.values(CH).find((c) => c.id === arg("channel") || c.id === arg("channel_id"));
    switch (method) {
      case "auth.test":
        return json({ ok: true, team: "Form Industries (stand-in)", url: "https://form-standin.slack.com/", user: "foundation", user_id: "U0FDN", bot_id: "B0FDN" }, { "x-oauth-scopes": scopes });
      case "conversations.info":
        if (!chan || (chan.id.startsWith("G") && !chan.is_member)) return json({ ok: false, error: "channel_not_found" });
        return json({ ok: true, channel: chan });
      case "conversations.list":
        return json({ ok: true, channels: Object.values(CH).filter((c) => !("is_im" in c)) });
      case "conversations.join":
        if (!chan || chan.is_private) return json({ ok: false, error: "method_not_supported_for_channel_type" });
        chan.is_member = true;
        return json({ ok: true });
      case "conversations.history": {
        if (!chan) return json({ ok: false, error: "channel_not_found" });
        if (!chan.is_member) return json({ ok: false, error: "not_in_channel" });
        const all = history.get(chan.id) ?? [];
        let top = all.filter((m) => !m.thread_ts || m.thread_ts === m.ts).map((m) => {
          const replies = all.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts);
          return replies.length ? { ...m, thread_ts: m.ts, reply_count: replies.length, latest_reply: replies[replies.length - 1].ts } : m;
        });
        const latest = q.get("latest");
        if (latest) top = top.filter((m) => (q.get("inclusive") ? Number(m.ts) <= Number(latest) : Number(m.ts) < Number(latest)));
        return json({ ok: true, messages: top.reverse().slice(0, Number(q.get("limit") ?? 100)) });
      }
      case "conversations.replies": {
        const all = history.get(chan?.id ?? "") ?? [];
        const root = q.get("ts")!;
        return json({ ok: true, messages: all.filter((m) => m.ts === root || m.thread_ts === root) });
      }
      case "users.info": {
        const p = PEOPLE[q.get("user") ?? ""];
        if (!p) return json({ ok: false, error: "user_not_found" });
        return json({ ok: true, user: { id: q.get("user"), name: p.name.split(" ")[0].toLowerCase(), real_name: p.name, profile: { real_name: p.name, email: p.email } } });
      }
      case "chat.postMessage": {
        if (!chan) return json({ ok: false, error: "channel_not_found" });
        if (!chan.is_member) return json({ ok: false, error: "not_in_channel" });
        const ts = say(chan.id, { bot_id: "B0FDN", username: body.username as string, text: body.text as string, subtype: "bot_message", ...(body.thread_ts ? { thread_ts: body.thread_ts as string } : {}), metadata: body.metadata });
        return json({ ok: true, channel: chan.id, ts });
      }
      case "chat.update": {
        const m = find(chan!.id, body.ts as string);
        m.text = body.text as string;
        return json({ ok: true });
      }
      case "chat.delete": {
        history.set(chan!.id, (history.get(chan!.id) ?? []).filter((m) => m.ts !== body.ts));
        return json({ ok: true });
      }
      case "files.getUploadURLExternal":
        return json({ ok: true, upload_url: `${slackBase}/upload/F0UP${tsN}`, file_id: `F0UP${tsN}` });
      case "files.completeUploadExternal": {
        const files = (body.files as Array<{ id: string; title: string }>).map((f) => ({ id: f.id, name: f.title, mimetype: "text/plain", size: 5, url_private_download: `https://files.slack.com/files-pri/T1/${f.id}/x` }));
        say(chan!.id, { bot_id: "B0FDN", text: body.initial_comment as string, subtype: "file_share", files, ...(body.thread_ts ? { thread_ts: body.thread_ts as string } : {}) });
        return json({ ok: true, files });
      }
    }
    json({ ok: false, error: "unknown_method" });
  });
  await new Promise<void>((r) => slack.listen(0, "127.0.0.1", () => r()));
  slackBase = `http://127.0.0.1:${(slack.address() as AddressInfo).port}`;
  process.env.SLACK_API_BASE = slackBase;
  process.env.CHATIMPORT_TEST_FILE_ORIGIN = slackBase;
});

const { one, all } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const bridges = await import("../src/chatbridges.ts");
const sb = await import("../src/bridges/slack.ts");
const secrets = await import("../src/bridgesecrets.ts");
const live = await import("../src/slacklive.ts");
const { storeFile } = await import("../src/files.ts");
const { closeBoards } = await import("../src/boards.ts");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const bob = auth.upsertUser("bob@formindustries.com", "Bob Stone");
const cookieOf = (id: string) => `foundation_session=${auth.createSession(id)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), bob: cookieOf(bob.id) };
const bossAgent = { bearer: auth.createSession(boss.id, 3600_000, "agent"), agent: "Wren" };
const adaAgent = { bearer: auth.createSession(ada.id, 3600_000, "agent"), agent: "Wren" };

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  bridges.chatBridgeRoutes(r);
  sb.chatSlackRoutes(r);
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
after(async () => {
  await sb.slackIdle();
  await bridges.bridgesIdle();
  sb._resetSlackBridge();
  live._resetSlackLive();
  server?.closeAllConnections();
  server?.close();
  slack?.close();
  closeBoards();
});

type Who = string | { bearer: string; agent?: string } | null;
async function api<T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (typeof who === "string") headers.cookie = who;
  else if (who) {
    headers.authorization = `Bearer ${who.bearer}`;
    if (who.agent) headers["x-foundation-agent"] = who.agent;
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
const page = (who: Who, channel: string) => ok<ChatPage>(who, "GET", `/api/chat/channels/${channel}/messages`).then((p) => p.messages);
const thread = (who: Who, channel: string, root: string) => ok<ChatPage>(who, "GET", `/api/chat/channels/${channel}/messages?root=${root}`).then((p) => p.messages);
const sent = (method = "chat.postMessage") => posts.filter((p) => p.method === method);
const read = async (channelId: string) => {
  await sb.readLinked(channelId);
  await sb.slackIdle();
};

let GENERAL = "";

test("the bot token is stored sealed, never returned or kept in plain text, and the import and the bridge use it", async () => {
  // nobody but an admin, in person
  assert.equal((await api(C.ada, "POST", "/api/chat/slack/token", { token: BOT })).status, 403);
  assert.equal((await api(bossAgent, "POST", "/api/chat/slack/token", { token: BOT })).status, 403);
  assert.equal((await api(C.boss, "POST", "/api/chat/slack/token", { token: "not-a-token" })).status, 400);
  const r = await api<{ view: { token: { set: boolean; source: string; tail?: string }; scopes: { missing: string[] | null; files: string } }; check: { ok: boolean; team: string } }>(C.boss, "POST", "/api/chat/slack/token", { token: BOT });
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.text.includes(BOT), "the token never comes back");
  assert.equal(r.body.view.token.source, "stored");
  assert.equal(r.body.view.token.tail, BOT.slice(-4));
  assert.equal(r.body.check.ok, true);
  assert.equal(r.body.check.team, "Form Industries (stand-in)");
  assert.deepEqual(r.body.view.scopes.missing, []);
  assert.equal(r.body.view.scopes.files, "upload");
  const row = one<{ sealed: string; last4: string }>("select sealed, last4 from chat_bridge_secrets where key = 'SLACK_BOT_TOKEN'")!;
  assert.ok(!row.sealed.includes(BOT.slice(5)), "sealed at rest");
  assert.equal(secrets.storedSecret("SLACK_BOT_TOKEN"), BOT);
  // after a restart it still reads (unsealed with data/secret.key)
  secrets._forgetSecretCache();
  assert.equal(secrets.storedSecret("SLACK_BOT_TOKEN"), BOT);
  const { slackImportToken } = await import("../src/chatimport.ts");
  assert.deepEqual(slackImportToken(), { token: BOT, kind: "bot" });
  // the audit log says it was set and by whom, never what
  const a = all<{ action: string; actor_id: string; target: string; args_hash: string | null }>("select action, actor_id, target from audit_log where action like 'bridge.key.%'");
  assert.ok(a.some((x) => x.action === "bridge.key.set" && x.actor_id === boss.id && x.target === "slack:SLACK_BOT_TOKEN"));
  assert.ok(!JSON.stringify(all("select * from audit_log")).includes(BOT));
});

test("a wizard's keys for another bridge land sealed; its adapter reads them; Check asks the provider", async () => {
  process.env.WHATSAPP_API_BASE = `${slackBase}/nowhere`;
  const { startStandin, standinEnv } = await import("../src/bridges/standin.ts");
  const st = await startStandin();
  Object.assign(process.env, standinEnv(st.base));
  try {
    const waToken = ["EAAG", Math.random().toString(36).slice(2), "wa"].join("");
    assert.equal((await api(C.ada, "POST", "/api/chat/bridges/whatsapp/keys", { keys: { WHATSAPP_TOKEN: waToken } })).status, 403);
    assert.equal((await api(C.boss, "POST", "/api/chat/bridges/whatsapp/keys", { keys: { SLACK_BOT_TOKEN: BOT } })).status, 400);
    const r = await ok<{ keys: Array<{ key: string; set: boolean; source: string; tail?: string }> }>(C.boss, "POST", "/api/chat/bridges/whatsapp/keys", { keys: { WHATSAPP_TOKEN: waToken, WHATSAPP_PHONE_NUMBER_ID: "1098765" } });
    assert.ok(!JSON.stringify(r).includes(waToken));
    assert.deepEqual(r.keys.filter((k) => k.set).map((k) => [k.key, k.source]), [["WHATSAPP_TOKEN", "stored"], ["WHATSAPP_PHONE_NUMBER_ID", "stored"]]);
    const check = await ok<{ check: { ok: boolean; said: string } }>(C.boss, "POST", "/api/chat/bridges/whatsapp/check", { step: "token" });
    assert.equal(check.check.ok, true, check.check.said);
    assert.match(check.check.said, /\+1 555-0100/);
    assert.equal(st.calls.filter((c) => c.path === "/graph/1098765").at(-1)?.headers.authorization, `Bearer ${waToken}`, "the stored token, not an env one");
    const addr = await ok<{ check: { ok: boolean; said: string } }>(C.boss, "POST", "/api/chat/bridges/whatsapp/check", { step: "address" });
    assert.equal(addr.check.ok, false, "localhost isn't reachable from Meta");
    const v = await ok<{ server: { reachable: boolean; publicUrl: string }; bridges: Array<{ service: string; keys?: unknown; hook?: string }> }>(C.boss, "GET", "/api/chat/bridges");
    assert.equal(v.server.reachable, false);
    assert.match(v.bridges.find((b) => b.service === "whatsapp")!.hook!, /\/api\/chat\/hooks\/whatsapp$/);
    const asAda = await ok<{ bridges: Array<{ keys?: unknown }> }>(C.ada, "GET", "/api/chat/bridges");
    assert.ok(asAda.bridges.every((b) => b.keys === undefined), "only admins see which keys are set");
  } finally {
    for (const k of ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) secrets.setSecret(boss, k, "");
    await st.close();
  }
});

test("linking: an admin in person; never an agent; DMs never; a private channel the app isn't in says so", async () => {
  assert.equal((await api(C.ada, "POST", "/api/chat/slack/links", { slackId: CH.general.id })).status, 403);
  assert.equal((await api(bossAgent, "POST", "/api/chat/slack/links", { slackId: CH.general.id })).status, 403);
  const dm = await api<{ error: string }>(C.boss, "POST", "/api/chat/slack/links", { slackId: CH.dm.id });
  assert.equal(dm.status, 400);
  assert.match(dm.body.error, /Direct messages aren't bridged/);
  const priv = await api<{ error: string }>(C.boss, "POST", "/api/chat/slack/links", { slackId: CH.secret.id });
  assert.equal(priv.status, 409);
  assert.match(priv.body.error, /\/invite @Foundation/);
  // a ChatForm dm can't be a Slack channel
  const d = chat.openDirect([chat.personParty(boss), chat.personParty(ada)]);
  assert.equal((await api(C.boss, "POST", "/api/chat/slack/links", { slackId: CH.general.id, channel: d.id })).status, 400);

  // #general here (no origin) is merged with Slack's #general, the importer's rule
  const here = chat.ensureGeneral();
  const r = await ok<{ link: { channel: string; slackName: string; state: string }; how: string }>(C.boss, "POST", "/api/chat/slack/links", { slackId: CH.general.id, request_id: "link-1" });
  assert.equal(r.how, "merged");
  assert.equal(r.link.channel, here.id);
  assert.equal(chat.getChannel(here.id)!.origin?.externalId, CH.general.id);
  GENERAL = here.id;
  // the same request again: the same link
  const again = await ok<{ link: { channel: string } }>(C.boss, "POST", "/api/chat/slack/links", { slackId: CH.general.id, request_id: "link-1" });
  assert.equal(again.link.channel, GENERAL);
  assert.equal(one<{ n: number }>("select count(*) as n from chat_slack_links")!.n, 1);
  // a public channel the app isn't in: linked, and reading it says to Join
  const out = await ok<{ link: { channel: string } }>(C.boss, "POST", "/api/chat/slack/links", { slackId: CH.outside.id });
  await read(out.link.channel);
  const v = await ok<{ links: Array<{ slackId: string; errorCode?: string; error?: string }> }>(C.ada, "GET", "/api/chat/slack");
  const o = v.links.find((l) => l.slackId === CH.outside.id)!;
  assert.equal(o.errorCode, "not_in_channel");
  assert.match(o.error!, /Press Join/);
  assert.equal((await api(C.ada, "POST", "/api/chat/slack/join", { slackId: CH.outside.id })).status, 403);
  await ok(C.boss, "POST", "/api/chat/slack/join", { slackId: CH.outside.id });
  await sb.slackIdle();
  assert.ok(!(await ok<{ links: Array<{ slackId: string; errorCode?: string }> }>(C.ada, "GET", "/api/chat/slack")).links.find((l) => l.slackId === CH.outside.id)!.errorCode);
  await ok(C.boss, "POST", `/api/chat/slack/links/${out.link.channel}/unlink`, { confirm: true });
});

let ROOT_TS = "";
test("in: a person by email, a ghost, a bot, a thread, a file and a reaction, each once and as its author", async () => {
  ROOT_TS = say(CH.general.id, { user: "U0ADA", text: "The *brackets* ship Friday <@U0SAM>" });
  say(CH.general.id, { user: "U0SAM", text: "Great, can you send the drawing?" });
  say(CH.general.id, { user: "U0SAM", text: "Got it", thread_ts: ROOT_TS });
  say(CH.general.id, { bot_id: "B0CI", username: "CI", subtype: "bot_message", text: "Build 42 passed" });
  say(CH.general.id, { user: "U0SAM", text: "Here it is", subtype: "file_share", files: [{ id: "F0DRAW", name: "drawing.txt", mimetype: "text/plain", size: 18, url_private_download: "https://files.slack.com/files-pri/T1/F0DRAW/drawing.txt" }] });
  find(CH.general.id, ROOT_TS).reactions = [{ name: "+1", users: ["U0SAM", "U0BOB"], count: 2 }];
  // Slack says so three times (the event, a redelivery, the poll) and two reads overlap
  live.fromBridge({ type: "event", event: { type: "message", channel: CH.general.id } }, { loopback: true });
  live.fromBridge({ type: "event", event: { type: "message", channel: CH.general.id } }, { loopback: true });
  await Promise.all([sb.readLinked(GENERAL), sb.readLinked(GENERAL), sb.pollOnce()]);
  await new Promise((r) => setTimeout(r, 80));
  await sb.slackIdle();
  live._bridgeGone();
  const msgs = (await page(C.ada, GENERAL)).filter((m) => m.origin?.service === "slack");
  assert.equal(msgs.length, 4, msgs.map((m) => m.text).join(" | "));
  const [first, second, bot, file] = msgs;
  assert.equal(first.author.kind, "person");
  assert.equal(first.author.id, ada.id, "matched by email");
  assert.match(first.text, /\*\*brackets\*\*/, "mrkdwn as markdown");
  assert.match(first.text, /@sam\.okafor/);
  assert.equal(second.author.kind, "ghost");
  assert.equal(second.author.name, "Sam Okafor");
  assert.match(bot.author.name, /CI \(bot\)/);
  assert.equal(file.files.length, 1);
  assert.equal(file.files[0].name, "drawing.txt");
  assert.equal(first.replyCount, 1);
  const t = await thread(C.ada, GENERAL, first.id);
  assert.equal(t.at(-1)!.text, "Got it");
  const thumbs = first.reactions.find((r) => r.emoji === "👍");
  assert.deepEqual(thumbs?.by.sort(), ["Bob Stone", "Sam Okafor"]);
  assert.equal(first.outbound, undefined, "what came in isn't sent anywhere");
  assert.equal(sent().length, 0, "nothing went to Slack");
});

test("in: an edit, a deletion and a reaction taken back follow Slack; reading again changes nothing", async () => {
  const root = find(CH.general.id, ROOT_TS);
  root.text = "The *brackets* ship Monday";
  root.edited = { user: "U0ADA", ts: nextTs() };
  root.reactions = [{ name: "+1", users: ["U0SAM"], count: 1 }];
  const gone = (history.get(CH.general.id) ?? []).find((m) => m.text === "Great, can you send the drawing?")!;
  history.set(CH.general.id, history.get(CH.general.id)!.filter((m) => m !== gone));
  await read(GENERAL);
  const all = await page(C.ada, GENERAL);
  const first = all.find((m) => m.origin?.externalId === `${CH.general.id}:${ROOT_TS}`)!;
  assert.match(first.text, /Monday/);
  assert.ok(first.editedAt);
  assert.deepEqual(first.reactions.find((r) => r.emoji === "👍")?.by, ["Sam Okafor"]);
  const removed = all.find((m) => m.origin?.externalId === `${CH.general.id}:${gone.ts}`);
  assert.ok(!removed || removed.deletedAt, "removed here too (the row stays)");
  assert.ok(one("select 1 from chat_messages where origin_id = ? and deleted_at is not null", `${CH.general.id}:${gone.ts}`), "kept as a removed row");
  const before = one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n;
  await read(GENERAL);
  await read(GENERAL);
  assert.equal(one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n, before);
});

test("out: a person's message goes once as “Name via Foundation”, a reply in its thread; the echo isn't mirrored back; no ping-pong", async () => {
  const m = (await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "On it, **two** boxes", request_id: "out-1" })).message;
  assert.equal(m.outbound?.state, "sending");
  await sb.slackIdle();
  const p = sent();
  assert.equal(p.length, 1);
  assert.equal(p[0].body.username, "Ada Lovelace via Foundation");
  assert.equal(p[0].body.text, "On it, *two* boxes");
  assert.equal((p[0].body.metadata as { event_payload: { source: string } }).event_payload.source, "chatform");
  assert.equal(chat.getMessage(m.id)!.outbound?.state, "sent");
  // a reply in the thread of a Slack message, and one in the thread of our own
  const root = (await page(C.ada, GENERAL)).find((x) => x.origin?.externalId === `${CH.general.id}:${ROOT_TS}`)!;
  await ok(C.bob, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "Monday works", root: root.id });
  await ok(C.bob, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "Two is right", root: m.id });
  await sb.slackIdle();
  const [, r1, r2] = sent();
  assert.equal(r1.body.thread_ts, ROOT_TS);
  assert.equal(r1.body.username, "Bob Stone via Foundation");
  assert.equal(r2.body.thread_ts, one<{ ts: string }>("select ts from chat_slack_out where message_id = ?", m.id)!.ts);
  // Slack now holds our three posts: reading them mirrors none, and nothing new goes out
  const count = one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n;
  for (let i = 0; i < 3; i++) await read(GENERAL);
  assert.equal(one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n, count, "no echo");
  assert.equal(sent().length, 3, "no ping-pong");
  // even if Foundation lost its note of what it sent, the tag keeps another server's (or its own) post out
  const ts = say(CH.general.id, { bot_id: "B0FDN", username: "Kai via Foundation", subtype: "bot_message", text: "from the other server", metadata: { event_type: "foundation_post", event_payload: { source: "chatform" } } });
  await read(GENERAL);
  assert.ok(!one("select 1 from chat_messages where origin_id = ?", `${CH.general.id}:${ts}`));
});

test("out: its author's edit and removal reach Slack; a file is uploaded (files:write) or named in a line (without)", async () => {
  const m = (await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "first try" })).message;
  await sb.slackIdle();
  const ts = one<{ ts: string }>("select ts from chat_slack_out where message_id = ?", m.id)!.ts;
  await ok(C.ada, "POST", `/api/chat/messages/${m.id}`, { text: "second try" });
  await sb.slackIdle();
  assert.equal(find(CH.general.id, ts).text, "second try");
  await ok(C.ada, "DELETE", `/api/chat/messages/${m.id}`, { confirm: true });
  await sb.slackIdle();
  assert.ok(!(history.get(CH.general.id) ?? []).some((x) => x.ts === ts), "removed in Slack");

  const f = await storeFile(Buffer.from("hello"), { name: "note.txt", mime: "text/plain", boardId: chat.CHAT_BOARD, userId: ada.id });
  await ok(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "the note", files: [f.id] });
  await sb.slackIdle();
  assert.equal(sent("files.completeUploadExternal").length, 1);
  assert.equal(posts.filter((p) => p.method === "upload").length, 1);
  // our upload comes back as the bot's file_share: not mirrored
  const n = one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n;
  await read(GENERAL);
  assert.equal(one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n, n);
  // without files:write: a line naming the file
  scopes = scopes.replace(",files:write", "");
  await ok(C.boss, "POST", "/api/chat/slack/check", {});
  await ok(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "another", files: [f.id] });
  await sb.slackIdle();
  assert.match(String(sent().at(-1)!.body.text), /📎 note\.txt \(in Foundation\)/);
  assert.equal(sent("files.completeUploadExternal").length, 1);
});

test("out: a failure is marked with why, and Try again sends it once", async () => {
  failing.set("chat.postMessage", "restricted_action");
  const before = sent().length;
  const m = (await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "will it go?" })).message;
  await sb.slackIdle();
  const failed = chat.getMessage(m.id)!;
  assert.equal(failed.outbound?.state, "failed");
  assert.match(failed.outbound!.error!, /don't let the app post/);
  // two presses with one request id, and a third with another: one send
  await ok(C.ada, "POST", `/api/chat/messages/${m.id}/send`, { request_id: "retry-1" });
  await ok(C.ada, "POST", `/api/chat/messages/${m.id}/send`, { request_id: "retry-1" });
  assert.equal((await api(C.ada, "POST", `/api/chat/messages/${m.id}/send`, { request_id: "retry-2" })).status, 409, "already sent");
  await sb.deliverSlack(m.id, "Ada Lovelace");
  assert.equal(chat.getMessage(m.id)!.outbound?.state, "sent");
  assert.equal(sent().length - before, 2, "the refused try and the one that went");
  assert.equal(sent().filter((p) => p.body.text === "will it go?").length, 2);
});

test("an agent's message in a linked channel is a draft: nothing reaches Slack until a person sends it", async () => {
  const before = sent().length;
  const d = (await ok<{ message: ChatMessage }>(adaAgent, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "Draft reply from Wren" })).message;
  assert.equal(d.author.kind, "agent");
  assert.equal(d.type, "draft");
  assert.equal(d.outbound?.state, "draft");
  await sb.slackIdle();
  assert.equal(sent().length, before, "nothing left");
  // an agent can't send it
  assert.equal((await api(adaAgent, "POST", `/api/chat/messages/${d.id}/send`, { request_id: "a1" })).status, 403);
  assert.equal(sent().length, before);
  const r = await ok<{ message: ChatMessage }>(C.bob, "POST", `/api/chat/messages/${d.id}/send`, { request_id: "send-draft", text: "Draft reply from Wren, checked" });
  assert.equal(r.message.outbound?.state, "sent");
  assert.equal(sent().length, before + 1);
  assert.equal(sent().at(-1)!.body.username, "Bob Stone via Foundation");
  assert.equal(sent().at(-1)!.body.text, "Draft reply from Wren, checked");
});

test("rate limits: a read waits out Retry-After; a send waits a short one and goes", async () => {
  limited.set("conversations.history", 1);
  const ts = say(CH.general.id, { user: "U0SAM", text: "after the wait" });
  await read(GENERAL);
  assert.ok(!one("select 1 from chat_messages where origin_id = ?", `${CH.general.id}:${ts}`), "the read stopped at the limit");
  await read(GENERAL);
  assert.ok(!one("select 1 from chat_messages where origin_id = ?", `${CH.general.id}:${ts}`), "and doesn't ask again inside the wait");
  await new Promise((r) => setTimeout(r, 1100));
  await read(GENERAL);
  assert.ok(one("select 1 from chat_messages where origin_id = ?", `${CH.general.id}:${ts}`), "after it, it comes");
  limited.set("chat.postMessage", 1);
  const m = (await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "patient" })).message;
  await sb.slackIdle();
  assert.equal(chat.getMessage(m.id)!.outbound?.state, "sent");
});

test("history brought in, then linked with a backfill: nothing is doubled", async () => {
  // as the importer leaves it: the channel and its messages with their origins
  const shop = chat.createChannel(chat.SYSTEM_PARTY, { kind: "open", name: "shop-floor", origin: { service: "slack", externalId: CH.shop.id } });
  const t1 = say(CH.shop.id, { user: "U0BOB", text: "Line 2 is back up" });
  const t2 = say(CH.shop.id, { user: "U0SAM", text: "Vane stock Thursday" });
  chat.postMessage(shop.id, chat.personParty(bob), { text: "Line 2 is back up", origin: { service: "slack", externalId: `${CH.shop.id}:${t1}` } }, { silent: true });
  const r = await ok<{ link: { channel: string }; how: string }>(C.boss, "POST", "/api/chat/slack/links", { slackId: CH.shop.id, backfill: true });
  assert.equal(r.how, "had");
  assert.equal(r.link.channel, shop.id);
  await sb.slackIdle();
  const msgs = (await page(C.boss, shop.id)).filter((m) => m.origin?.service === "slack");
  assert.deepEqual(msgs.map((m) => m.origin!.externalId), [`${CH.shop.id}:${t1}`, `${CH.shop.id}:${t2}`]);
});

test("the guide's channel table and its live test message (a person's press, read back from Slack)", async () => {
  assert.equal((await api(C.ada, "GET", "/api/chat/slack/channels")).status, 403);
  const t = await ok<{ channels: Array<{ id: string; link: unknown; lands: { how: string } }> }>(C.boss, "GET", "/api/chat/slack/channels");
  assert.ok(!t.channels.some((c) => c.id === CH.dm.id), "no DMs in the table");
  assert.ok(t.channels.find((c) => c.id === CH.general.id)!.link);
  assert.equal(t.channels.find((c) => c.id === CH.secret.id)!.lands.how, "create");
  const r = await ok<{ sent: boolean; confirmed: boolean; message: ChatMessage }>(C.boss, "POST", "/api/chat/slack/test", { channel: GENERAL, request_id: "test-1" });
  assert.equal(r.sent, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.message.outbound?.state, "sent");
  assert.match(String(sent().at(-1)!.body.text), /^Test from Foundation/);
});

test("pause stops both ways; unlink keeps every message and sends nothing more", async () => {
  assert.equal((await api(C.ada, "POST", `/api/chat/slack/links/${GENERAL}`, { state: "paused" })).status, 403);
  await ok(C.boss, "POST", `/api/chat/slack/links/${GENERAL}`, { state: "paused" });
  const before = sent().length;
  const m = (await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "while paused" })).message;
  assert.equal(m.outbound, undefined, "not on its way anywhere");
  await sb.slackIdle();
  assert.equal(sent().length, before);
  await ok(C.boss, "POST", `/api/chat/slack/links/${GENERAL}`, { state: "live" });
  await sb.slackIdle();

  const kept = one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n;
  assert.equal((await api(C.boss, "POST", `/api/chat/slack/links/${GENERAL}/unlink`, {})).status, 400, "needs confirm");
  assert.equal((await api(bossAgent, "POST", `/api/chat/slack/links/${GENERAL}/unlink`, { confirm: true })).status, 403);
  await ok(C.boss, "POST", `/api/chat/slack/links/${GENERAL}/unlink`, { confirm: true });
  assert.equal(one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", GENERAL)!.n, kept, "every message stays");
  assert.equal(chat.getChannel(GENERAL)!.origin?.externalId, CH.general.id, "it still knows its Slack channel");
  const m2 = (await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/channels/${GENERAL}/messages`, { text: "after unlink" })).message;
  assert.equal(m2.outbound, undefined);
  say(CH.general.id, { user: "U0SAM", text: "nobody hears this" });
  await sb.pollOnce();
  await sb.slackIdle();
  assert.equal(sent().length, before);
  assert.ok(!one("select 1 from chat_messages where text = 'nobody hears this'"));
});

test("the nudge: shown until Slack is linked or imported, dismissed per person on the server", async () => {
  // a fresh look: nothing links or imports in this test's own eyes but Bob hasn't dismissed it; channels from Slack exist, so no nudge
  const v = await ok<{ nudge: boolean; history: { channels: number } }>(C.bob, "GET", "/api/chat/slack");
  assert.ok(v.history.channels > 0);
  assert.equal(v.nudge, false);
  const d = await ok<{ view: { nudgeDismissed: boolean } }>(C.bob, "POST", "/api/chat/slack/nudge", { dismissed: true });
  assert.equal(d.view.nudgeDismissed, true);
  assert.equal((await api(adaAgent, "POST", "/api/chat/slack/nudge", { dismissed: true })).status, 403);
  assert.equal((await ok<{ nudgeDismissed: boolean }>(C.ada, "GET", "/api/chat/slack")).nudgeDismissed, false, "per person");
});

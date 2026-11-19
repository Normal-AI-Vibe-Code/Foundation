/**
 * ChatForm's bridges (B1): the framework and the four adapters against a local stand-in playing Meta's
 * Graph API, WeCom, Gmail and Google's OAuth (src/bridges/standin.ts). Real routes on a real port, real
 * sessions: a person's cookie, an agent's bearer, nobody at all (the webhooks).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChannelView, ChatMessage, ChatPage } from "@foundation/protocol";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-bridges-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_PUBLIC_URL = "http://127.0.0.1:16150";
delete process.env.FOUNDATION_BRIDGE_DEMO;
for (const k of Object.keys(process.env)) if (/^(WHATSAPP|INSTAGRAM|WECOM|GMAIL|GOOGLE)_/.test(k)) delete process.env[k];

const { startStandin, standinEnv, metaSignature, wecomCallback } = await import("../src/bridges/standin.ts");
const standin = await startStandin();
Object.assign(process.env, standinEnv(standin.base));

const SECRETS = {
  WHATSAPP_TOKEN: "EAAG-whatsapp-token-SECRET",
  WHATSAPP_PHONE_NUMBER_ID: "1098765",
  WHATSAPP_APP_SECRET: "wa-app-secret-SECRET",
  WHATSAPP_VERIFY_TOKEN: "wa-verify-SECRET",
  INSTAGRAM_ACCOUNT_ID: "17841400000",
  INSTAGRAM_APP_SECRET: "ig-app-secret-SECRET",
  INSTAGRAM_VERIFY_TOKEN: "ig-verify-SECRET",
  WECOM_CORP_ID: "wwcorp123",
  WECOM_AGENT_ID: "1000002",
  WECOM_SECRET: "wecom-secret-SECRET",
  WECOM_TOKEN: "QDG6eK",
  WECOM_AES_KEY: "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C",
  GMAIL_CLIENT_ID: "gmail-client.apps.googleusercontent.com",
  GMAIL_CLIENT_SECRET: "gmail-client-SECRET",
};
Object.assign(process.env, SECRETS);
// Instagram has no token yet: it must say so

const { one, run } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { Router, HttpError, json } = await import("../src/http.ts");
const chat = await import("../src/chat.ts");
const bridges = await import("../src/chatbridges.ts");
const { syncGmail } = await import("../src/bridges/gmail.ts");
const { wecomDecrypt, wecomEncrypt, wecomSignature } = await import("../src/bridges/wechat.ts");
const { closeBoards } = await import("../src/boards.ts");

const boss = auth.upsertUser("boss@formindustries.com", "Boss Person");
const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const bob = auth.upsertUser("bob@formindustries.com", "Bob Stone");
const cookieOf = (userId: string) => `foundation_session=${auth.createSession(userId)}`;
const C = { boss: cookieOf(boss.id), ada: cookieOf(ada.id), bob: cookieOf(bob.id) };
const adaAgent = auth.createSession(ada.id, 3600_000, "agent");

let server: Server;
let base = "";
before(async () => {
  const r = new Router();
  chat.chatRoutes(r);
  bridges.chatBridgeRoutes(r);
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
  await bridges.bridgesIdle();
  server?.closeAllConnections();
  server?.close();
  await standin.close();
  closeBoards();
});

type Who = string | { bearer: string; agent?: string } | null;
async function api<T = Record<string, unknown>>(who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined && typeof body !== "string") headers["content-type"] = "application/json";
  if (typeof who === "string") headers.cookie = who;
  else if (who) {
    headers.authorization = `Bearer ${who.bearer}`;
    if (who.agent) headers["x-foundation-agent"] = who.agent;
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
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
const post = (who: Who, channel: string, text: string) => ok<{ message: ChatMessage }>(who, "POST", `/api/chat/channels/${channel}/messages`, { text }).then((b) => b.message);
const page = (who: Who, channel: string) => ok<ChatPage>(who, "GET", `/api/chat/channels/${channel}/messages`).then((p) => p.messages);
const sendsTo = (path: string) => standin.calls.filter((c) => c.method === "POST" && c.path.includes(path));
const count = (sql: string, ...a: unknown[]) => one<{ n: number }>(sql, ...a)!.n;

/** a WhatsApp webhook as Meta sends it, signed (or not) */
function waHook(messages: unknown[], o: { contacts?: unknown[]; statuses?: unknown[] } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550001111", phone_number_id: SECRETS.WHATSAPP_PHONE_NUMBER_ID }, contacts: o.contacts ?? [{ wa_id: "447700900123", profile: { name: "Mei Tanaka" } }], messages, ...(o.statuses ? { statuses: o.statuses } : {}) } }] }],
  });
}
const hook = (service: string, body: string, headers: Record<string, string> = {}, query = "") => api(null, "POST", `/api/chat/hooks/${service}${query ? `?${query}` : ""}`, body, { "content-type": "application/json", ...headers });
const signedWa = async (body: string) => {
  const r = await hook("whatsapp", body, { "x-hub-signature-256": metaSignature(SECRETS.WHATSAPP_APP_SECRET, body) });
  await bridges.bridgesIdle();
  return r;
};
const waPortal = () => chat.channelByOrigin("whatsapp", "447700900123", SECRETS.WHATSAPP_PHONE_NUMBER_ID);

test("an admin chooses who a new portal goes to; others can't", async () => {
  assert.equal((await api(C.ada, "POST", "/api/chat/bridges/whatsapp", { inbox: [ada.id] })).status, 403);
  assert.equal((await api({ bearer: auth.createSession(boss.id, 3600_000, "agent") }, "POST", "/api/chat/bridges/whatsapp", { inbox: [ada.id] })).status, 403);
  for (const s of ["whatsapp", "instagram", "wechat"]) await ok(C.boss, "POST", `/api/chat/bridges/${s}`, { inbox: [ada.id] });
  const v = await ok<{ bridges: Array<{ service: string; settings: { inbox: string[] } }> }>(C.ada, "GET", "/api/chat/bridges");
  assert.deepEqual(v.bridges.find((b) => b.service === "whatsapp")!.settings.inbox, [ada.id]);
});

test("statuses: what's live, what's missing (by name, never by value)", async () => {
  const r = await api<{ bridges: Array<{ service: string; state: string; needs?: Array<{ key: string; set: boolean }>; steps?: string[] }> }>(C.bob, "GET", "/api/chat/bridges");
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.bridges.map((b) => [b.service, b]));
  assert.deepEqual(Object.keys(by), ["gmail", "whatsapp", "instagram", "wechat"]);
  assert.equal(by.whatsapp.state, "live");
  assert.equal(by.wechat.state, "live");
  assert.equal(by.instagram.state, "needs-setup");
  assert.deepEqual(by.instagram.needs!.filter((n) => !n.set).map((n) => n.key), ["INSTAGRAM_TOKEN"]);
  assert.ok(by.instagram.steps!.length >= 3);
  assert.equal(by.gmail.state, "needs-setup", "keys but no mailbox yet");
  for (const v of Object.values(SECRETS)) if (/SECRET/.test(v)) assert.ok(!r.text.includes(v), `the status leaked ${v}`);
});

test("webhook handshakes: Meta's verify token and WeCom's echostr", async () => {
  const good = await api(null, "GET", `/api/chat/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=${SECRETS.WHATSAPP_VERIFY_TOKEN}&hub.challenge=1158201444`);
  assert.equal(good.status, 200);
  assert.equal(good.text, "1158201444");
  assert.equal((await api(null, "GET", "/api/chat/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1")).status, 403);
  // WeCom: echostr is encrypted; the answer is its plain text, only when the signature is right
  const echostr = wecomEncrypt(SECRETS.WECOM_AES_KEY, "8329874832747", SECRETS.WECOM_CORP_ID);
  const sig = wecomSignature(SECRETS.WECOM_TOKEN, "1409659813", "1372623149", echostr);
  const q = new URLSearchParams({ msg_signature: sig, timestamp: "1409659813", nonce: "1372623149", echostr });
  const w = await api(null, "GET", `/api/chat/hooks/wechat?${q}`);
  assert.equal(w.status, 200);
  assert.equal(w.text, "8329874832747");
  q.set("msg_signature", "0".repeat(40));
  assert.equal((await api(null, "GET", `/api/chat/hooks/wechat?${q}`)).status, 401);
});

test("WeCom's signature and AES round trip with a known key", () => {
  assert.equal(wecomSignature("QDG6eK", "1409659813", "1372623149", "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo"), "65664ba4ebf14da066e746a9e3aa9aac1f19e4ef");
  assert.equal(wecomSignature("QDG6eK", "1409659813", "1372623149", "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo"), createHash("sha1").update(["QDG6eK", "1409659813", "1372623149", "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo"].sort().join("")).digest("hex"));
  const xml = "<xml><Content><![CDATA[你好, ChatForm]]></Content></xml>";
  const enc = wecomEncrypt(SECRETS.WECOM_AES_KEY, xml, "wx5823bf96d3bd56c7");
  assert.equal(Buffer.from(enc, "base64").length % 32, 0, "padded to 32");
  assert.deepEqual(wecomDecrypt(SECRETS.WECOM_AES_KEY, enc), { message: xml, receiveId: "wx5823bf96d3bd56c7" });
  assert.throws(() => wecomDecrypt(SECRETS.WECOM_AES_KEY, Buffer.alloc(48, 1).toString("base64")));
});

test("a signed WhatsApp message makes a portal, a ghost and a message with its picture archived", async () => {
  standin.media.set("wamedia1", { mime: "image/png", body: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") });
  const body = waHook([
    { from: "447700900123", id: "wamid.IN1", timestamp: String(Math.floor(Date.now() / 1000) - 60), type: "text", text: { body: "Hi, are the *brackets* ready?" } },
    { from: "447700900123", id: "wamid.IN2", timestamp: String(Math.floor(Date.now() / 1000) - 30), type: "image", image: { id: "wamedia1", mime_type: "image/png", caption: "the drawing" } },
  ]);
  const r = await signedWa(body);
  assert.equal(r.status, 200);
  const portal = waPortal();
  assert.ok(portal, "a portal");
  assert.equal(portal.kind, "portal");
  assert.equal(portal.name, "Mei Tanaka");
  assert.ok(portal.members!.some((m) => m.kind === "person" && m.id === ada.id), "the inbox is in it");
  const msgs = await page(C.ada, portal.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].author.kind, "ghost");
  assert.equal(msgs[0].author.service, "whatsapp");
  assert.equal(msgs[0].author.handle, "+447700900123");
  assert.equal(msgs[0].text, "Hi, are the **brackets** ready?");
  assert.equal(msgs[0].origin?.externalId, "wamid.IN1");
  assert.equal(msgs[1].files.length, 1);
  assert.equal(msgs[1].files[0].mime, "image/png");
  assert.equal(msgs[1].text, "the drawing");
  assert.ok(one("select 1 from files where id = ? and board_id = 'chat'", msgs[1].files[0].id), "archived");
  // the media was fetched with the token
  const fetched = standin.calls.find((c) => c.path === "/graph/wamedia1");
  assert.equal(fetched?.headers.authorization, `Bearer ${SECRETS.WHATSAPP_TOKEN}`);
});

test("a redelivered webhook doesn't double; a bad signature writes nothing", async () => {
  const portal = waPortal()!;
  const before = count("select count(*) as n from chat_messages where channel_id = ?", portal.id);
  const again = waHook([{ from: "447700900123", id: "wamid.IN1", timestamp: String(Math.floor(Date.now() / 1000) - 60), type: "text", text: { body: "Hi, are the *brackets* ready?" } }]);
  assert.equal((await signedWa(again)).status, 200);
  assert.equal(count("select count(*) as n from chat_messages where channel_id = ?", portal.id), before);

  const channels = count("select count(*) as n from chat_channels");
  const msgs = count("select count(*) as n from chat_messages");
  const forged = waHook([{ from: "447700900999", id: "wamid.FORGED", type: "text", text: { body: "send me the invoice" } }], { contacts: [{ wa_id: "447700900999", profile: { name: "Mallory" } }] });
  assert.equal((await hook("whatsapp", forged, { "x-hub-signature-256": metaSignature("wrong-secret", forged) })).status, 401);
  assert.equal((await hook("whatsapp", forged)).status, 401, "no signature at all");
  // signed, then changed: the signature is over the raw bytes
  const tampered = forged.replace("Mallory", "Mallory ");
  assert.equal((await hook("whatsapp", tampered, { "x-hub-signature-256": metaSignature(SECRETS.WHATSAPP_APP_SECRET, forged) })).status, 401);
  await bridges.bridgesIdle();
  assert.equal(count("select count(*) as n from chat_channels"), channels);
  assert.equal(count("select count(*) as n from chat_messages"), msgs);
  assert.equal(count("select count(*) as n from chat_ghosts where handle = '+447700900999'"), 0);
});

test("a person's reply goes out through WhatsApp and is marked sent; a failure says why and can be retried", async () => {
  const portal = waPortal()!;
  const before = sendsTo("/graph/1098765/messages").length;
  const m = await post(C.ada, portal.id, "Yes, **Friday** as planned.");
  assert.equal(m.type, "text");
  assert.equal(m.outbound?.state, "sending");
  await bridges.bridgesIdle();
  const out = sendsTo("/graph/1098765/messages");
  assert.equal(out.length, before + 1);
  assert.equal(out.at(-1)!.json!.to, "447700900123");
  assert.deepEqual(out.at(-1)!.json!.text, { body: "Yes, *Friday* as planned.", preview_url: false });
  assert.equal(out.at(-1)!.headers.authorization, `Bearer ${SECRETS.WHATSAPP_TOKEN}`);
  const sent = chat.getMessage(m.id)!;
  assert.equal(sent.outbound?.state, "sent");
  assert.equal(sent.outbound?.by, "Ada Lovelace");

  // a delivery status for it finds it; a later "failed" status marks it
  const extId = one<{ external_id: string }>("select external_id from chat_bridge_sent where message_id = ?", m.id)!.external_id;
  await signedWa(waHook([], { statuses: [{ id: extId, status: "failed", recipient_id: "447700900123", errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "Receiver is incapable of receiving this message" } }] }] }));
  assert.equal(chat.getMessage(m.id)!.outbound?.state, "failed");
  assert.match(chat.getMessage(m.id)!.outbound!.error!, /undeliverable/);

  standin.failing.add("/graph/1098765/messages");
  const bad = await post(C.ada, portal.id, "Second try");
  await bridges.bridgesIdle();
  const failed = chat.getMessage(bad.id)!;
  assert.equal(failed.outbound?.state, "failed");
  assert.match(failed.outbound!.error!, /24 hours/);
  assert.ok(!failed.outbound!.error!.includes(SECRETS.WHATSAPP_TOKEN));
  standin.failing.clear();
  const retried = await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/messages/${bad.id}/send`, { request_id: "retry-1" });
  assert.equal(retried.message.outbound?.state, "sent");
  // the same request again answers the first result, and sends nothing more
  const n = sendsTo("/graph/1098765/messages").length;
  assert.equal((await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/messages/${bad.id}/send`, { request_id: "retry-1" })).message.outbound?.state, "sent");
  assert.equal(sendsTo("/graph/1098765/messages").length, n);
  assert.equal((await api(C.ada, "POST", `/api/chat/messages/${bad.id}/send`, {})).status, 409, "already sent");
});

test("an agent's message in a portal is a draft: nothing leaves until a person sends it", async () => {
  const portal = waPortal()!;
  const before = sendsTo("/graph/").length;
  const d = await post({ bearer: adaAgent, agent: "Wren" }, portal.id, "Draft: Friday works, 9am delivery.");
  assert.equal(d.type, "draft");
  assert.equal(d.author.kind, "agent");
  assert.deepEqual({ state: d.outbound?.state, by: d.outbound?.by }, { state: "draft", by: "Wren" });
  await bridges.bridgesIdle();
  assert.equal(sendsTo("/graph/").length, before, "nothing sent");
  // the agent pressing send is refused, and still nothing goes
  const refused = await api({ bearer: adaAgent, agent: "Wren" }, "POST", `/api/chat/messages/${d.id}/send`, {});
  assert.equal(refused.status, 403);
  await bridges.bridgesIdle();
  assert.equal(sendsTo("/graph/").length, before);
  assert.equal(chat.getMessage(d.id)!.outbound?.state, "draft");
  // someone who isn't in the portal can't see it, let alone send it
  assert.equal((await api(C.bob, "POST", `/api/chat/messages/${d.id}/send`, {})).status, 404);
  // a person sends it, edited first
  const s = await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/messages/${d.id}/send`, { text: "Friday works: 9am delivery." });
  assert.equal(s.message.outbound?.state, "sent");
  assert.equal(s.message.outbound?.by, "Ada Lovelace");
  assert.equal(s.message.text, "Friday works: 9am delivery.");
  assert.equal(sendsTo("/graph/").length, before + 1);
  assert.equal((sendsTo("/graph/").at(-1)!.json!.text as { body: string }).body, "Friday works: 9am delivery.");
  // a second draft, discarded (needs confirm), never leaves
  const d2 = await post({ bearer: adaAgent, agent: "Wren" }, portal.id, "Draft two");
  assert.equal((await api(C.ada, "POST", `/api/chat/messages/${d2.id}/discard`, {})).status, 400);
  assert.equal((await api({ bearer: adaAgent }, "POST", `/api/chat/messages/${d2.id}/discard`, { confirm: true })).status, 403);
  const gone = await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/messages/${d2.id}/discard`, { confirm: true });
  assert.ok(gone.message.deletedAt);
  assert.equal((await api(C.ada, "POST", `/api/chat/messages/${d2.id}/send`, {})).status, 409);
});

test("the WhatsApp window refuses a late reply, naming templates; WhatsApp can't be started from here", async () => {
  const portal = waPortal()!;
  run("update chat_bridge_portals set last_inbound_at = ? where channel_id = ?", Date.now() - 25 * 3600_000, portal.id);
  const before = sendsTo("/graph/").length;
  const late = await post(C.ada, portal.id, "Sorry for the slow reply");
  await bridges.bridgesIdle();
  const m = chat.getMessage(late.id)!;
  assert.equal(m.outbound?.state, "failed");
  assert.match(m.outbound!.error!, /24-hour window closed/);
  assert.match(m.outbound!.error!, /template/);
  assert.equal(sendsTo("/graph/").length, before, "nothing sent");
  const v = await ok<{ bridges: Array<{ service: string; list: Array<{ id: string; window?: { open: boolean } }> }> }>(C.ada, "GET", "/api/chat/bridges");
  assert.equal(v.bridges.find((b) => b.service === "whatsapp")!.list.find((p) => p.id === portal.id)!.window!.open, false);
  const start = await api(C.ada, "POST", "/api/chat/portals", { service: "whatsapp", to: "+447700900555", text: "Hello" });
  assert.equal(start.status, 400);
  assert.match(start.text, /template/);
  // a new message from them opens it again
  await signedWa(waHook([{ from: "447700900123", id: "wamid.IN3", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Still there?" } }]));
  await ok(C.ada, "POST", `/api/chat/messages/${late.id}/send`, {});
  assert.equal(chat.getMessage(late.id)!.outbound?.state, "sent");
});

test("a portal is invisible to people who aren't in it", async () => {
  const portal = waPortal()!;
  assert.equal((await api(C.bob, "GET", `/api/chat/channels/${portal.id}`)).status, 404);
  assert.equal((await api(C.bob, "GET", `/api/chat/channels/${portal.id}/messages`)).status, 404);
  assert.equal((await api(C.bob, "POST", `/api/chat/channels/${portal.id}/messages`, { text: "hi" })).status, 404);
  const list = await ok<{ channels: ChatChannelView[] }>(C.bob, "GET", "/api/chat");
  assert.ok(!list.channels.some((c) => c.id === portal.id));
  const v = await ok<{ bridges: Array<{ service: string; list: Array<{ id: string }>; portals: number }> }>(C.bob, "GET", "/api/chat/bridges");
  assert.equal(v.bridges.find((b) => b.service === "whatsapp")!.list.length, 0);
  // admins don't read portals they aren't in either
  assert.equal((await api(C.boss, "GET", `/api/chat/channels/${portal.id}`)).status, 404);
});

test("hooks need no session; nothing else under /api/chat opens up", async () => {
  for (const [method, path] of [
    ["GET", "/api/chat"],
    ["GET", "/api/chat/bridges"],
    ["POST", "/api/chat/bridges/whatsapp"],
    ["POST", "/api/chat/messages/m_x/send"],
    ["POST", "/api/chat/messages/m_x/discard"],
    ["POST", "/api/chat/portals"],
    ["POST", "/api/chat/bridges/gmail/connect"],
    ["POST", `/api/chat/channels/${waPortal()!.id}/messages`],
  ] as const)
    assert.equal((await api(null, method, path, method === "POST" ? {} : undefined)).status, 401, `${method} ${path}`);
  assert.equal((await api(null, "POST", "/api/chat/hooks/nonsense", "{}")).status, 404);
  assert.equal((await hook("whatsapp", "x".repeat(1024 * 1024 + 10), { "x-hub-signature-256": "sha256=00" })).status, 413, "body capped");
});

test("WeCom: an encrypted, signed callback makes a portal; a reply goes out through message/send", async () => {
  const xml = `<xml><ToUserName><![CDATA[${SECRETS.WECOM_CORP_ID}]]></ToUserName><FromUserName><![CDATA[LiWei]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[样品已经寄出]]></Content><MsgId>7781</MsgId><AgentID>1000002</AgentID></xml>`;
  const cb = wecomCallback({ token: SECRETS.WECOM_TOKEN, aesKey: SECRETS.WECOM_AES_KEY, corpId: SECRETS.WECOM_CORP_ID, xml });
  const r = await api(null, "POST", `/api/chat/hooks/wechat?${cb.query}`, cb.body, { "content-type": "text/xml" });
  assert.equal(r.status, 200);
  assert.equal(r.text, "");
  await bridges.bridgesIdle();
  const portal = chat.channelByOrigin("wechat", "LiWei", `${SECRETS.WECOM_CORP_ID}:${SECRETS.WECOM_AGENT_ID}`)!;
  assert.ok(portal);
  assert.equal((await page(C.ada, portal.id))[0].text, "样品已经寄出");
  // another corp's message, or a bad signature: nothing
  const other = wecomCallback({ token: SECRETS.WECOM_TOKEN, aesKey: SECRETS.WECOM_AES_KEY, corpId: "wwsomeoneelse", xml });
  assert.equal((await api(null, "POST", `/api/chat/hooks/wechat?${other.query}`, other.body)).status, 401);
  const forged = wecomCallback({ token: "not-our-token", aesKey: SECRETS.WECOM_AES_KEY, corpId: SECRETS.WECOM_CORP_ID, xml });
  assert.equal((await api(null, "POST", `/api/chat/hooks/wechat?${forged.query}`, forged.body)).status, 401);

  const m = await post(C.ada, portal.id, "收到, thank you");
  await bridges.bridgesIdle();
  assert.equal(chat.getMessage(m.id)!.outbound?.state, "sent");
  const out = sendsTo("/wecom/cgi-bin/message/send").at(-1)!;
  assert.deepEqual(out.json, { touser: "LiWei", msgtype: "text", agentid: 1000002, text: { content: "收到, thank you" } });
  assert.equal(out.query.get("access_token"), "standin-token");
});

test("Instagram: needs setup until it has a token; then a signed DM comes in, an echo of ours doesn't double", async () => {
  const portalsBefore = count("select count(*) as n from chat_channels where kind = 'portal'");
  const dm = (mid: string, text: string, echo = false) =>
    JSON.stringify({ object: "instagram", entry: [{ id: SECRETS.INSTAGRAM_ACCOUNT_ID, time: Date.now(), messaging: [{ sender: { id: echo ? SECRETS.INSTAGRAM_ACCOUNT_ID : "IGSID42" }, recipient: { id: echo ? "IGSID42" : SECRETS.INSTAGRAM_ACCOUNT_ID }, timestamp: Date.now(), message: { mid, text, ...(echo ? { is_echo: true } : {}) } }] }] });
  const first = dm("igmid.IN1", "Do you take small batch orders?");
  assert.equal((await hook("instagram", first, { "x-hub-signature-256": metaSignature(SECRETS.INSTAGRAM_APP_SECRET, first) })).status, 200);
  await bridges.bridgesIdle();
  const portal = chat.channelByOrigin("instagram", "IGSID42", SECRETS.INSTAGRAM_ACCOUNT_ID)!;
  assert.ok(portal, "it receives without a token");
  assert.equal(count("select count(*) as n from chat_channels where kind = 'portal'"), portalsBefore + 1);
  const failed = await post(C.ada, portal.id, "We do!");
  await bridges.bridgesIdle();
  assert.match(chat.getMessage(failed.id)!.outbound!.error!, /isn't connected/);

  process.env.INSTAGRAM_TOKEN = "IGQ-token-SECRET";
  const sent = await ok<{ message: ChatMessage }>(C.ada, "POST", `/api/chat/messages/${failed.id}/send`, {});
  assert.equal(sent.message.outbound?.state, "sent");
  const out = sendsTo("/ig/").at(-1)!;
  assert.deepEqual(out.json, { recipient: { id: "IGSID42" }, message: { text: "We do!" } });
  const mid = one<{ external_id: string }>("select external_id from chat_bridge_sent where message_id = ?", failed.id)!.external_id;
  const echo = dm(mid, "We do!", true);
  const n = count("select count(*) as n from chat_messages where channel_id = ?", portal.id);
  await hook("instagram", echo, { "x-hub-signature-256": metaSignature(SECRETS.INSTAGRAM_APP_SECRET, echo) });
  await bridges.bridgesIdle();
  assert.equal(count("select count(*) as n from chat_messages where channel_id = ?", portal.id), n, "our own echo isn't shown twice");
  // an echo of something sent from the Instagram app shows as our side (the bridge's puppet)
  await ok(C.boss, "POST", "/api/chat/bridges/instagram", { puppet: ada.id });
  const phone = dm("igmid.FROMPHONE", "Sent from the app", true);
  await hook("instagram", phone, { "x-hub-signature-256": metaSignature(SECRETS.INSTAGRAM_APP_SECRET, phone) });
  await bridges.bridgesIdle();
  const last = (await page(C.ada, portal.id)).at(-1)!;
  assert.equal(last.text, "Sent from the app");
  assert.equal(last.author.kind, "person");
  assert.equal(last.author.id, ada.id);
  assert.equal(last.outbound, undefined, "not sent again");
  delete process.env.INSTAGRAM_TOKEN;
});

test("Gmail: connect by consent (tokens sealed), a labelled thread becomes a portal, our reply threads properly", async () => {
  const g = standin.gmail;
  // a thread that's labelled, one that isn't
  g.deliver({ threadId: "thrA", from: "Sam Okafor <sam@supplier.example>", subject: "Quote for 40 brackets", text: "Could you quote 40?\n\nOn Tue, Ada wrote:\n> earlier", messageId: "<a1@supplier.example>", attachment: { name: "drawing.pdf", mime: "application/pdf", body: Buffer.from("%PDF-1.4 standin") } });
  g.deliver({ threadId: "thrB", from: "News <news@spam.example>", subject: "Weekly digest", text: "not for Foundation", labels: ["INBOX"] });

  const connect = await ok<{ url: string }>(C.ada, "POST", "/api/chat/bridges/gmail/connect", {});
  const u = new URL(connect.url);
  assert.equal(u.origin + u.pathname, `${standin.base}/accounts/o/oauth2/v2/auth`);
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:16150/api/chat/bridges/gmail/callback");
  assert.equal((await api({ bearer: adaAgent }, "POST", "/api/chat/bridges/gmail/connect", {})).status, 403, "an agent doesn't connect a mailbox");
  const cb = await api(null, "GET", `/api/chat/bridges/gmail/callback?code=4/standin&state=${u.searchParams.get("state")}`);
  assert.equal(cb.status, 200, cb.text);
  assert.match(cb.text, /ops@formindustries\.com is connected/);
  assert.equal((await api(null, "GET", `/api/chat/bridges/gmail/callback?code=4/standin&state=${u.searchParams.get("state")}`)).status, 400, "a state works once");
  const row = one<{ secret: string; user_id: string }>("select secret, user_id from chat_gmail_accounts where email = 'ops@formindustries.com'")!;
  assert.equal(row.user_id, ada.id);
  assert.ok(!row.secret.includes("standin-refresh") && !row.secret.includes("ya29"), "tokens are sealed");

  await syncGmail();
  const portal = chat.channelByOrigin("gmail", "thrA", "ops@formindustries.com")!;
  assert.ok(portal, "the labelled thread is a portal");
  assert.equal(portal.name, "Quote for 40 brackets");
  assert.ok(!chat.channelByOrigin("gmail", "thrB", "ops@formindustries.com"), "the unlabelled one stays out");
  assert.ok(portal.members!.some((m) => m.id === ada.id), "the mailbox's owner is in it");
  const msgs = await page(C.ada, portal.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].author.kind, "ghost");
  assert.equal(msgs[0].author.handle, "sam@supplier.example");
  assert.equal(msgs[0].author.name, "Sam Okafor");
  assert.equal(msgs[0].text, "Could you quote 40?", "the quoted part trimmed");
  assert.equal(msgs[0].files[0]?.name, "drawing.pdf");

  // a new message in the thread comes in without the label; one in an unlabelled thread doesn't
  g.deliver({ threadId: "thrA", from: "Sam Okafor <sam@supplier.example>", subject: "Re: Quote for 40 brackets", text: "And by the 28th, please.", labels: ["INBOX"], messageId: "<a2@supplier.example>", references: "<a1@supplier.example>", replyTo: "orders@supplier.example" });
  g.deliver({ threadId: "thrB", from: "News <news@spam.example>", subject: "Weekly digest", text: "more", labels: ["INBOX"] });
  await syncGmail();
  assert.equal((await page(C.ada, portal.id)).length, 2);
  assert.ok(!chat.channelByOrigin("gmail", "thrB", "ops@formindustries.com"));

  // our reply: to the Reply-To, in the thread, with In-Reply-To and References
  const reply = await post(C.ada, portal.id, "Yes: by the 28th.");
  await bridges.bridgesIdle();
  assert.equal(chat.getMessage(reply.id)!.outbound?.state, "sent");
  const send = sendsTo("/google/gmail/v1/users/me/messages/send").at(-1)!;
  assert.equal(send.json!.threadId, "thrA");
  const raw = Buffer.from(String(send.json!.raw), "base64url").toString("utf8");
  assert.match(raw, /^From: ops@formindustries\.com$/m);
  assert.match(raw, /^To: orders@supplier\.example$/m);
  assert.match(raw, /^Subject: Re: Quote for 40 brackets$/m);
  assert.match(raw, /^In-Reply-To: <a2@supplier\.example>$/m);
  assert.match(raw, /^References: <a1@supplier\.example> <a2@supplier\.example>$/m);
  assert.ok(raw.includes(Buffer.from("Yes: by the 28th.").toString("base64")));
  // the sent message comes back through history: not shown twice
  await syncGmail();
  assert.equal((await page(C.ada, portal.id)).length, 3);
  // something sent from Gmail itself shows as the mailbox's owner
  g.deliver({ threadId: "thrA", from: "Ops <ops@formindustries.com>", to: "orders@supplier.example", subject: "Re: Quote for 40 brackets", text: "PS: invoice attached later.", labels: ["SENT"] });
  await syncGmail();
  const last = (await page(C.ada, portal.id)).at(-1)!;
  assert.equal(last.author.kind, "person");
  assert.equal(last.author.id, ada.id);
  const v = await ok<{ bridges: Array<{ service: string; state: string; detail: string; accounts?: Array<{ email: string }> }> }>(C.ada, "GET", "/api/chat/bridges");
  const gm = v.bridges.find((b) => b.service === "gmail")!;
  assert.equal(gm.state, "live");
  assert.match(gm.detail, /labelled “Foundation”/);
  assert.ok(!JSON.stringify(v).includes("standin-refresh"));
});

test("a person starts a mail conversation from our side", async () => {
  const r = await ok<{ channel: ChatChannelView }>(C.ada, "POST", "/api/chat/portals", { service: "gmail", to: "Kai <kai@client.example>", subject: "Samples", text: "Samples ship Monday.", request_id: "start-1" });
  assert.equal(r.channel.kind, "portal");
  assert.equal(r.channel.name, "Samples");
  const again = await ok<{ channel: ChatChannelView }>(C.ada, "POST", "/api/chat/portals", { service: "gmail", to: "kai@client.example", subject: "Samples", text: "Samples ship Monday.", request_id: "start-1" });
  assert.equal(again.channel.id, r.channel.id, "a retry makes nothing new");
  const msgs = await page(C.ada, r.channel.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].outbound?.state, "sent");
  assert.equal((await api({ bearer: adaAgent }, "POST", "/api/chat/portals", { service: "gmail", to: "x@y.example", subject: "s", text: "t" })).status, 403);
  assert.equal((await api(C.bob, "POST", "/api/chat/portals", { service: "gmail", to: "x@y.example", subject: "s", text: "t" })).status, 400, "bob has no mailbox");
});

test("the demo is off by default; on, it makes a marked sample portal that never sends", async () => {
  assert.equal((await api(C.boss, "POST", "/api/chat/bridges/whatsapp/demo", {})).status, 404);
  process.env.FOUNDATION_BRIDGE_DEMO = "1";
  try {
    assert.equal((await api(C.ada, "POST", "/api/chat/bridges/whatsapp/demo", {})).status, 403, "admins only");
    const d = await ok<{ channel: ChatChannelView }>(C.boss, "POST", "/api/chat/bridges/whatsapp/demo", {});
    assert.match(d.channel.topic, /^Demo/);
    const msgs = await page(C.boss, d.channel.id);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].files[0]?.name, "bracket-notes.txt");
    const before = sendsTo("/graph/").length;
    const m = await post(C.boss, d.channel.id, "Thanks!");
    await bridges.bridgesIdle();
    assert.match(chat.getMessage(m.id)!.outbound!.error!, /demo/);
    assert.equal(sendsTo("/graph/").length, before);
  } finally {
    delete process.env.FOUNDATION_BRIDGE_DEMO;
  }
});

test("a bridge turned off receives nothing and sends nothing", async () => {
  await ok(C.boss, "POST", "/api/chat/bridges/whatsapp", { enabled: false });
  const body = waHook([{ from: "447700900123", id: "wamid.OFF", type: "text", text: { body: "hello?" } }]);
  assert.equal((await signedWa(body)).status, 404);
  const m = await post(C.ada, waPortal()!.id, "anyone?");
  await bridges.bridgesIdle();
  assert.match(chat.getMessage(m.id)!.outbound!.error!, /turned off/);
  const v = await ok<{ bridges: Array<{ service: string; state: string }> }>(C.ada, "GET", "/api/chat/bridges");
  assert.equal(v.bridges.find((b) => b.service === "whatsapp")!.state, "off");
  await ok(C.boss, "POST", "/api/chat/bridges/whatsapp", { enabled: true });
});

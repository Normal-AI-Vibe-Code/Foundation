/**
 * ChatForm's bridges (docs/chatform.md §1 "Honest bridges", B1): mail, WhatsApp, Instagram and WeChat as
 * conversations here, the way Matrix bridges do it, simplified.
 *
 *  - A conversation over there is a **portal** channel (`kind: "portal"`, `origin {service, externalId,
 *    account}`); each person over there is a **ghost**. An inbound message is posted by its ghost with
 *    `origin` = the service's message id, so a redelivered webhook never doubles. What our side sent from
 *    the phone or from Gmail directly comes back as the linked person's (double puppeting) where the
 *    service says so.
 *  - **Nothing leaves without a person.** A person's message typed into a portal is sent out as it is
 *    posted (their Enter is the send); it shows `outbound` sending → sent or failed (with why, and Retry).
 *    An agent's message in a portal is stored as a `draft` and never sent: only a person's
 *    `POST /api/chat/messages/:id/send` sends it (they may edit it first). That is enforced here, in the
 *    post itself (chat.ts `beforeChatPost`), not by the client.
 *  - Each service is an adapter (`bridges/*.ts`) on its official API only, with one honest state: off,
 *    needs setup (which keys are missing, the steps), live, error.
 *  - Webhooks (`/api/chat/hooks/:service`) need no session: the service's signature over the raw body is
 *    the authentication. They're rate-limited, size-capped, answered at once and processed after.
 *  - Inbound files are downloaded into the archive under a size cap, only from the service's own hosts.
 *  - Who is in a new portal: the bridge's inbox (user ids an admin keeps; admins when it's empty), plus,
 *    for mail, the mailbox's owner.
 */

import { CHAT_FILES_MAX, type ChatBridgeStatus, type ChatChannel, type ChatParty, type UserInfo } from "@foundation/protocol";
import { all, db, one, run } from "./db.ts";
import { HttpError, readBody, readJson, type Req, type Router } from "./http.ts";
import { requirePerson, requireUser } from "./auth.ts";
import * as chat from "./chat.ts";
import { fileBytesSync, storeFile } from "./files.ts";
import type { BridgeAdapter, BridgeContext, BridgeService, InboundEvent, InboundFile, InboundMessage, InboundStatus, OutboundFile, Portal, ReplyWindow } from "./bridges/types.ts";
import { scrub } from "./bridges/common.ts";
import { gmailAccounts, gmailAdapter } from "./bridges/gmail.ts";
import { whatsapp } from "./bridges/whatsapp.ts";
import { instagram } from "./bridges/instagram.ts";
import { wechat } from "./bridges/wechat.ts";

export type { BridgeAdapter, BridgeService, InboundEvent, Portal } from "./bridges/types.ts";

db.exec(`
create table if not exists chat_bridges (
  service text primary key,
  settings_json text not null default '{}',
  last_event_at integer,
  last_error text
);
create table if not exists chat_bridge_portals (
  channel_id text primary key,
  service text not null,
  last_inbound_at integer,
  meta_json text not null default '{}',
  demo integer not null default 0
);
-- what Foundation sent out, by the service's id for it: its echo isn't shown twice, its delivery status finds it
create table if not exists chat_bridge_sent (
  service text not null,
  external_id text not null,
  message_id text not null,
  primary key (service, external_id)
);
create table if not exists chat_bridge_requests (
  user_id text not null,
  request_id text not null,
  result text not null,
  at integer not null,
  primary key (user_id, request_id)
);
`);

// ---------- the registry ----------

const adapters = new Map<BridgeService, BridgeAdapter>();
export const BRIDGE_ORDER: BridgeService[] = ["gmail", "whatsapp", "instagram", "wechat"];

export function registerBridge(a: BridgeAdapter) {
  adapters.set(a.service, a);
}
for (const a of [gmailAdapter, whatsapp, instagram, wechat]) registerBridge(a);

export const bridge = (service: string) => adapters.get(service as BridgeService);

interface Settings {
  enabled?: boolean;
  /** who is put in a new portal */
  inbox?: string[];
  /** the person our side's own messages (sent from the phone, the app) are drawn as */
  puppet?: string;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function settingsOf(service: string): Settings {
  return parse<Settings>(one<{ settings_json: string }>("select settings_json from chat_bridges where service = ?", service)?.settings_json, {});
}
function saveSettings(service: string, s: Settings) {
  run("insert into chat_bridges (service, settings_json) values (?, ?) on conflict(service) do update set settings_json = excluded.settings_json", service, JSON.stringify(s));
}
const enabled = (service: string) => settingsOf(service).enabled !== false;

function touch(service: string, error: string | null = null) {
  run("insert into chat_bridges (service, last_event_at, last_error) values (?, ?, ?) on conflict(service) do update set last_event_at = excluded.last_event_at, last_error = excluded.last_error", service, Date.now(), error);
}

/** a bridge's status, whole: the adapter's word, then the framework's (off, a recent failure, counts) */
export function bridgeStatus(service: BridgeService): ChatBridgeStatus {
  const a = adapters.get(service)!;
  const row = one<{ last_event_at: number | null; last_error: string | null }>("select last_event_at, last_error from chat_bridges where service = ?", service);
  const portals = one<{ n: number }>("select count(*) as n from chat_channels where kind = 'portal' and origin_service = ? and archived_at is null", service)?.n ?? 0;
  let s: ChatBridgeStatus;
  try {
    s = { ...a.status(), service, name: a.name, portals };
  } catch (e) {
    s = { service, name: a.name, state: "error", detail: scrub((e as Error).message), canSend: false, portals };
  }
  if (!enabled(service)) s = { ...s, state: "off", detail: `${a.name} is turned off: nothing comes in or goes out.`, canSend: false };
  else if (s.state === "live" && row?.last_error) s = { ...s, state: "error", detail: row.last_error };
  if (row?.last_event_at) s.lastEventAt = row.last_event_at;
  return s;
}

function changed(service: BridgeService) {
  chat.publish({ t: "bridge", bridge: bridgeStatus(service) }, "all");
}

// ---------- portals ----------

function portalOf(channel: ChatChannel): Portal | undefined {
  if (channel.kind !== "portal" || !channel.origin || !adapters.has(channel.origin.service as BridgeService)) return undefined;
  const row = one<{ last_inbound_at: number | null; meta_json: string; demo: number }>("select last_inbound_at, meta_json, demo from chat_bridge_portals where channel_id = ?", channel.id);
  return {
    channel,
    service: channel.origin.service as BridgeService,
    externalId: channel.origin.externalId,
    ...(channel.origin.account ? { account: channel.origin.account } : {}),
    meta: parse<Record<string, unknown>>(row?.meta_json, {}),
    lastInboundAt: row?.last_inbound_at ?? null,
    demo: Boolean(row?.demo),
  };
}

export function portalById(channelId: string): Portal | undefined {
  const c = chat.getChannel(channelId);
  return c ? portalOf(c) : undefined;
}

function mergeMeta(channelId: string, service: string, meta: Record<string, unknown> | undefined) {
  if (!meta || !Object.keys(meta).length) return;
  const row = one<{ meta_json: string }>("select meta_json from chat_bridge_portals where channel_id = ?", channelId);
  const next = { ...parse<Record<string, unknown>>(row?.meta_json, {}), ...meta };
  run("insert into chat_bridge_portals (channel_id, service, meta_json) values (?, ?, ?) on conflict(channel_id) do update set meta_json = excluded.meta_json", channelId, service, JSON.stringify(next));
}

const userById = (id: string) => one<UserInfo>("select id, email, name, color, role from users where id = ?", id);

/** who is put in a new portal: the inbox (admins when nobody's been chosen), plus the conversation's own (a mailbox's owner) */
function portalMembers(service: string, extra: string[] = []): ChatParty[] {
  const inbox = settingsOf(service).inbox ?? [];
  const ids = inbox.length ? inbox : all<{ id: string }>("select id from users where role = 'admin' order by created_at").map((u) => u.id);
  const out = new Map<string, ChatParty>();
  for (const id of [...ids, ...extra]) {
    const u = userById(id);
    if (u) out.set(u.id, chat.personParty(u));
  }
  return [...out.values()];
}

function makePortal(service: BridgeService, conv: InboundMessage["conversation"], demo: boolean): ChatChannel {
  const had = chat.channelByOrigin(service, conv.externalId, conv.account);
  if (had) return had;
  const name = adapters.get(service)!.name;
  const topic = demo ? `Demo · a sample made by FOUNDATION_BRIDGE_DEMO, not a real ${name} conversation. Nothing sent here leaves Foundation.` : (conv.topic ?? name);
  const ch = chat.createChannel(chat.SYSTEM_PARTY, { kind: "portal", name: conv.name || name, topic, origin: { service, externalId: conv.externalId, ...(conv.account ? { account: conv.account } : {}) }, members: portalMembers(service, conv.members) });
  run("insert into chat_bridge_portals (channel_id, service, meta_json, demo) values (?, ?, ?, ?) on conflict(channel_id) do nothing", ch.id, service, JSON.stringify(conv.meta ?? {}), demo ? 1 : 0);
  return ch;
}

// ---------- inbound ----------

const MAX_FILE = () => Math.max(1, Number(process.env.FOUNDATION_BRIDGE_MAX_FILE_MB) || 25) * 1024 * 1024;

function hostAllowed(a: BridgeAdapter, url: URL): boolean {
  const hosts = a.mediaHosts?.() ?? [];
  const h = url.host.toLowerCase();
  const name = url.hostname.toLowerCase();
  // plain http only for a base someone overrode on purpose (a stand-in, a proxy): it's listed by host:port
  if (url.protocol === "http:") return hosts.some((x) => !x.startsWith(".") && x.includes(":") && x === h);
  if (url.protocol !== "https:") return false;
  return hosts.some((x) => (x.startsWith(".") ? name.endsWith(x) : x === name || x === h));
}

/** an inbound file's bytes: given, or fetched from the service's own hosts (each redirect checked again), under the cap */
async function download(a: BridgeAdapter, f: InboundFile): Promise<{ body: Buffer; mime: string }> {
  const cap = MAX_FILE();
  if (f.size && f.size > cap) throw new Error(`${f.name} is larger than ${Math.round(cap / 1048576)} MB`);
  let { url, headers, mime, data } = f;
  if (!data && f.resolve) {
    const r = await f.resolve();
    url = r.url ?? url;
    headers = r.headers ?? headers;
    mime = r.mime ?? mime;
    data = r.data;
  }
  if (data) {
    if (data.length > cap) throw new Error(`${f.name} is larger than ${Math.round(cap / 1048576)} MB`);
    return { body: data, mime };
  }
  if (!url) throw new Error(`${f.name} came with no way to fetch it`);
  let target = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (!hostAllowed(a, target)) throw new Error(`${f.name} points somewhere ${a.name} doesn't serve files from`);
    let res: Response;
    try {
      res = await fetch(target, { headers: hop === 0 ? headers : undefined, redirect: "manual", signal: AbortSignal.timeout(60000) });
    } catch {
      throw new Error(`${f.name} couldn't be fetched`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      target = new URL(res.headers.get("location")!, target);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`${f.name} couldn't be fetched (${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > cap) throw new Error(`${f.name} is larger than ${Math.round(cap / 1048576)} MB`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > cap) throw new Error(`${f.name} is larger than ${Math.round(cap / 1048576)} MB`);
      chunks.push(Buffer.from(c));
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    // WeCom answers an expired token with JSON where the file should be
    if (type === "application/json" && !/json$/i.test(f.name)) throw new Error(`${f.name} couldn't be fetched (the service answered with an error)`);
    return { body: Buffer.concat(chunks), mime: mime && mime !== "application/octet-stream" ? mime : type || mime };
  }
  throw new Error(`${f.name}: too many redirects`);
}

const messageWithOrigin = (channelId: string, service: string, externalId: string) => Boolean(one("select 1 from chat_messages where channel_id = ? and origin_service = ? and origin_id = ?", channelId, service, externalId));

function authorFor(a: BridgeAdapter, e: InboundMessage, ghostName: string): ChatParty {
  if (e.from.self) {
    const who = (e.from.person && userById(e.from.person)) || (settingsOf(a.service).puppet && userById(settingsOf(a.service).puppet!));
    if (who) return chat.personParty(who);
  }
  return chat.ghostParty(a.service, e.from.handle, ghostName, e.from.avatar);
}

async function ingestMessage(a: BridgeAdapter, e: InboundMessage, demo: boolean) {
  // what Foundation itself sent, coming back: not shown twice (its thread notes still count)
  const ours = one<{ message_id: string }>("select message_id from chat_bridge_sent where service = ? and external_id = ?", a.service, e.externalId);
  if (ours) {
    const m = chat.getMessage(ours.message_id);
    if (m) mergeMeta(m.channel, a.service, e.conversation.meta);
    return;
  }
  const had = chat.channelByOrigin(a.service, e.conversation.externalId, e.conversation.account);
  if (had && messageWithOrigin(had.id, a.service, e.externalId)) return;
  let ghostName = e.from.name ?? "";
  if (!ghostName && !e.from.self && a.profile && !demo) {
    ghostName = (await a.profile(e.from.handle, e.conversation.account).catch(() => ({ name: undefined }))).name ?? "";
  }
  const ch = had ?? makePortal(a.service, { ...e.conversation, name: e.conversation.name || ghostName }, demo);
  const author = authorFor(a, e, ghostName || e.from.handle);
  if (author.kind === "ghost") chat.addMember(ch.id, author, { silent: true });
  const files: string[] = [];
  const missed: string[] = [];
  for (const f of (e.files ?? []).slice(0, CHAT_FILES_MAX)) {
    try {
      const { body, mime } = await download(a, f);
      const row = await storeFile(body, { name: f.name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) || "attachment", mime: mime || "application/octet-stream", boardId: chat.CHAT_BOARD, userId: `bridge:${a.service}` });
      files.push(row.id);
    } catch (err) {
      missed.push(scrub((err as Error).message));
    }
  }
  let text = e.text ?? "";
  if (missed.length) text = `${text}${text ? "\n\n" : ""}${missed.map((m) => `_(an attachment didn't come: ${m})_`).join("\n")}`;
  if (!text.trim() && !files.length) text = "_(an empty message)_";
  chat.postMessage(ch.id, author, { text, files, origin: { service: a.service, externalId: e.externalId, ...(e.conversation.account ? { account: e.conversation.account } : {}) }, createdAt: e.at && e.at < Date.now() + 60_000 ? e.at : undefined });
  mergeMeta(ch.id, a.service, e.conversation.meta);
  if (!e.from.self) run("update chat_bridge_portals set last_inbound_at = max(coalesce(last_inbound_at, 0), ?) where channel_id = ?", Math.min(e.at ?? Date.now(), Date.now()), ch.id);
}

function applyStatus(a: BridgeAdapter, s: InboundStatus) {
  const row = one<{ message_id: string }>("select message_id from chat_bridge_sent where service = ? and external_id = ?", a.service, s.externalId);
  const m = row && chat.getMessage(row.message_id);
  if (!m?.outbound) return;
  if (s.state === "failed") chat.updateMessage(m.id, { outbound: { ...m.outbound, state: "failed", error: s.error ?? `${a.name} couldn't deliver it` } });
  else if (m.outbound.state !== "sent") chat.updateMessage(m.id, { outbound: { ...m.outbound, state: "sent", error: undefined } });
}

/** events into the store, one at a time, in order; one that fails is said and the rest go on */
export async function ingest(service: BridgeService, events: InboundEvent[], opts: { demo?: boolean } = {}): Promise<void> {
  const a = adapters.get(service);
  if (!a) throw new HttpError(404, "no such bridge");
  let failed: string | null = null;
  for (const e of events) {
    try {
      if (e.kind === "status") applyStatus(a, e);
      else await ingestMessage(a, e, Boolean(opts.demo));
    } catch (err) {
      failed = scrub((err as Error).message);
      console.error(`bridges: ${service}: an inbound event didn't land: ${failed}`);
    }
  }
  if (!opts.demo) touch(service, null);
  changed(service);
}

// background work (webhook processing, sends), so tests and shutdown can wait for it
const pendingWork = new Set<Promise<unknown>>();
function later<T>(p: Promise<T>): Promise<T> {
  pendingWork.add(p);
  void p.catch(() => undefined).finally(() => pendingWork.delete(p));
  return p;
}
/** resolves once nothing the bridges started is still running */
export async function bridgesIdle(): Promise<void> {
  while (pendingWork.size) await Promise.allSettled([...pendingWork]);
}

// ---------- outbound ----------

const inflight = new Set<string>();

/** a portal's reply window as its adapter says it (none: no rule) */
export function windowOf(p: Portal): ReplyWindow | undefined {
  return adapters.get(p.service)?.window?.(p);
}

/** send a message out through its portal's adapter, marking it sending → sent or failed (with why) */
export async function deliver(messageId: string, by: string): Promise<void> {
  if (inflight.has(messageId)) return;
  inflight.add(messageId);
  const fail = (why: string) => {
    const m = chat.getMessage(messageId);
    if (m) chat.updateMessage(messageId, { outbound: { state: "failed", by, at: Date.now(), error: why } });
  };
  try {
    const m = chat.getMessage(messageId);
    if (!m || m.deletedAt) return;
    const p = portalById(m.channel);
    const a = p && adapters.get(p.service);
    if (!p || !a) return fail("This conversation has no bridge.");
    chat.updateMessage(messageId, { outbound: { state: "sending", by, at: Date.now() } });
    if (p.demo) return fail("This is a demo conversation: nothing leaves Foundation.");
    const st = bridgeStatus(p.service);
    if (st.state === "off") return fail(`${a.name} is turned off.`);
    if (!st.canSend || st.state === "needs-setup") return fail(`${a.name} isn't connected: ${st.detail}`);
    const w = a.window?.(p);
    if (w && !w.open) return fail(w.why ?? w.rule);
    const files: OutboundFile[] = [];
    for (const f of m.files) {
      const got = fileBytesSync(f.id);
      if (!got) return fail(`${f.name} isn't in the archive any more.`);
      files.push({ id: f.id, name: f.name, mime: f.mime, size: f.size, body: got.body });
    }
    if (!m.text.trim() && !files.length) return fail("Nothing to send.");
    const r = await a.send(p, { text: m.text, files });
    if (r.externalId) run("insert or ignore into chat_bridge_sent (service, external_id, message_id) values (?, ?, ?)", p.service, r.externalId, messageId);
    mergeMeta(p.channel.id, p.service, r.meta);
    chat.updateMessage(messageId, { outbound: { state: "sent", by, at: Date.now() } });
  } catch (e) {
    fail(scrub((e as Error).message) || "it failed");
  } finally {
    inflight.delete(messageId);
  }
}

// the rule, in the post itself: in a bridged portal an agent's words are a draft; a person's go out
chat.beforeChatPost((ctx, m) => {
  if (ctx.kind !== "portal" || ctx.silent || m.origin || !ctx.service || !adapters.has(ctx.service as BridgeService)) return;
  if (m.type && m.type !== "text" && m.type !== "draft") return;
  if (ctx.author.kind === "agent") return { ...m, type: "draft", outbound: { state: "draft", by: ctx.author.name, at: Date.now() } };
  if (ctx.author.kind === "person") return { ...m, type: "text", outbound: { state: "sending", by: ctx.author.name, at: Date.now() } };
  // anything else (a ghost without an origin, the system) is never sent
  return undefined;
});

chat.onChatMessage((m, ch) => {
  if (ch.kind !== "portal" || m.author.kind !== "person" || m.origin || m.outbound?.state !== "sending") return;
  void later(deliver(m.id, m.author.name));
});

// ---------- HTTP ----------

const isMember = (c: ChatChannel, userId: string) => (c.members ?? []).some((p) => p.kind === "person" && p.id === userId);

function remembered(userId: string, requestId: unknown): string | null {
  if (typeof requestId !== "string" || !requestId) return null;
  return one<{ result: string }>("select result from chat_bridge_requests where user_id = ? and request_id = ?", userId, requestId.slice(0, 120))?.result ?? null;
}
function remember(userId: string, requestId: unknown, result: string) {
  if (typeof requestId === "string" && requestId) run("insert or ignore into chat_bridge_requests (user_id, request_id, result, at) values (?, ?, ?, ?)", userId, requestId.slice(0, 120), result, Date.now());
}

/** what the Inbox tab draws for one bridge */
export interface BridgeView extends ChatBridgeStatus {
  settings: { enabled: boolean; inbox: string[]; puppet: string | null; inboxIsAdmins: boolean };
  list: Array<{ id: string; name: string; topic: string; lastPostAt: number; lastText?: string; unread: number; demo: boolean; window?: ReplyWindow }>;
  canStart: boolean;
  startRule?: string;
  accounts?: ReturnType<typeof gmailAccounts>;
}

function viewOf(service: BridgeService, user: UserInfo): BridgeView {
  const a = adapters.get(service)!;
  const s = settingsOf(service);
  const rows = all<{ id: string }>("select id from chat_channels where kind = 'portal' and origin_service = ? and archived_at is null order by last_post_at desc limit 200", service);
  const list: BridgeView["list"] = [];
  for (const r of rows) {
    const c = chat.getChannel(r.id);
    if (!c || !chat.canSeeChannel(user, c)) continue;
    const p = portalOf(c);
    const v = chat.channelView(user, c);
    const w = p && !p.demo ? a.window?.(p) : undefined;
    list.push({ id: c.id, name: c.name, topic: c.topic, lastPostAt: c.lastPostAt, ...(c.lastText ? { lastText: c.lastText } : {}), unread: v.unread, demo: Boolean(p?.demo), ...(w ? { window: w } : {}) });
  }
  return {
    ...bridgeStatus(service),
    settings: { enabled: s.enabled !== false, inbox: s.inbox ?? [], puppet: s.puppet ?? null, inboxIsAdmins: !(s.inbox ?? []).length },
    list,
    canStart: Boolean(a.startConversation),
    ...(a.startRule ? { startRule: a.startRule } : {}),
    ...(service === "gmail" ? { accounts: gmailAccounts().map((x) => (x.userId === user.id || user.role === "admin" ? x : { ...x, error: x.error ? "needs attention" : null })) } : {}),
  };
}

const demoOn = () => process.env.FOUNDATION_BRIDGE_DEMO === "1";

// webhooks: per address and service, at most HOOK_RATE a minute
const HOOK_RATE = 600;
const HOOK_MAX_BYTES = 1024 * 1024;
const hits = new Map<string, { n: number; until: number }>();
function rateLimit(req: Req, service: string) {
  const key = `${service}|${req.socket.remoteAddress ?? "?"}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.until < now) {
    if (hits.size > 5000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
    hits.set(key, { n: 1, until: now + 60_000 });
    return;
  }
  if (++h.n > HOOK_RATE) throw new HttpError(429, "slow down");
}

const ctxFor = (service: BridgeService): BridgeContext => ({
  ingest: (events) => ingest(service, events),
  portal: portalById,
  changed: () => changed(service),
});

let started = false;
/** begin each adapter's polling (Gmail); the server calls this once, tests don't need to */
export function startBridges() {
  if (started) return;
  started = true;
  for (const a of adapters.values()) if (enabled(a.service)) a.start?.(ctxFor(a.service));
}
export function stopBridges() {
  started = false;
  for (const a of adapters.values()) a.stop?.();
}

export function chatBridgeRoutes(r: Router) {
  // polling starts with the server (a test drives syncs itself)
  if (!process.env.NODE_TEST_CONTEXT) startBridges();
  // the adapters' own routes first (Gmail's connect, callback, disconnect), so they win over :service
  for (const a of adapters.values()) a.routes?.(r, ctxFor(a.service));

  r.get("/api/chat/bridges", (req) => {
    const user = requireUser(req);
    return { bridges: BRIDGE_ORDER.filter((s) => adapters.has(s)).map((s) => viewOf(s, user)), demo: demoOn(), admin: user.role === "admin" };
  });

  // settings: who's in a new portal, whose our side's own messages are, on or off. An admin, in person
  r.post("/api/chat/bridges/:service", async (req) => {
    const user = requirePerson(req, "Changing a bridge");
    if (user.role !== "admin") throw new HttpError(403, "Only an admin changes a bridge.");
    const service = req.params.service as BridgeService;
    if (!adapters.has(service)) throw new HttpError(404, "no such bridge");
    const body = await readJson<{ enabled?: unknown; inbox?: unknown; puppet?: unknown }>(req);
    const s = settingsOf(service);
    if (body.enabled !== undefined) s.enabled = body.enabled !== false;
    if (body.inbox !== undefined) {
      if (!Array.isArray(body.inbox) || body.inbox.some((x) => typeof x !== "string" || !userById(x))) throw new HttpError(400, "inbox: a list of user ids");
      s.inbox = [...new Set(body.inbox as string[])];
    }
    if (body.puppet !== undefined) {
      if (body.puppet !== null && (typeof body.puppet !== "string" || !userById(body.puppet))) throw new HttpError(400, "puppet: a user id, or null");
      s.puppet = (body.puppet as string | null) ?? undefined;
    }
    saveSettings(service, s);
    const a = adapters.get(service)!;
    if (s.enabled === false) a.stop?.();
    else if (started) a.start?.(ctxFor(service));
    changed(service);
    return { bridge: viewOf(service, user) };
  });

  // a sample conversation through the real pipeline, without any keys (FOUNDATION_BRIDGE_DEMO=1 only)
  r.post("/api/chat/bridges/:service/demo", async (req) => {
    if (!demoOn()) throw new HttpError(404, "not found");
    const user = requirePerson(req, "Making a demo conversation");
    if (user.role !== "admin") throw new HttpError(403, "Only an admin makes a demo conversation.");
    const a = adapters.get(req.params.service as BridgeService);
    if (!a) throw new HttpError(404, "no such bridge");
    const events = a.demo();
    await ingest(a.service, events, { demo: true });
    const first = events.find((e): e is InboundMessage => e.kind === "message")!;
    const ch = chat.channelByOrigin(a.service, first.conversation.externalId, first.conversation.account);
    if (ch && !isMember(ch, user.id)) chat.addMember(ch.id, chat.personParty(user), { silent: true });
    return { channel: ch ? chat.channelView(user, chat.getChannel(ch.id)!) : null };
  });

  // the services' webhooks. No session: the signature over the raw body is the authentication
  r.get("/api/chat/hooks/:service", (req, res) => {
    const a = adapters.get(req.params.service as BridgeService);
    if (!a?.verifyWebhook || !enabled(a.service)) throw new HttpError(404, "not found");
    rateLimit(req, a.service);
    const out = a.verifyWebhook(req);
    res.writeHead(out.status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(out.body) });
    res.end(out.body);
  });

  r.post("/api/chat/hooks/:service", async (req, res) => {
    const a = adapters.get(req.params.service as BridgeService);
    if (!a?.receive || !enabled(a.service)) throw new HttpError(404, "not found");
    rateLimit(req, a.service);
    const raw = await readBody(req, HOOK_MAX_BYTES);
    const { events, ack = "" } = await a.receive(req, raw); // 401 on a bad signature: nothing is read or written
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(ack) });
    res.end(ack);
    if (events.length) void later(ingest(a.service, events));
  });

  // a person sends a draft (an agent's, perhaps edited) or retries a failed message. Never an agent
  r.post("/api/chat/messages/:id/send", async (req) => {
    const user = requirePerson(req, "Sending a message out of Foundation");
    const body = await readJson<{ text?: unknown; request_id?: unknown }>(req);
    const m = chat.getMessage(req.params.id);
    if (!m) throw new HttpError(404, "no such message");
    const c = chat.requireChannel(user, m.channel);
    if (c.kind !== "portal" || !portalOf(c)) throw new HttpError(400, "only a message in a bridged conversation is sent out");
    if (!isMember(c, user.id)) throw new HttpError(403, "join this conversation first");
    if (c.archivedAt) throw new HttpError(409, "this conversation is archived");
    if (remembered(user.id, body.request_id) === m.id) return { message: chat.getMessage(m.id) };
    if (m.deletedAt) throw new HttpError(409, "that message was discarded");
    const state = m.outbound?.state;
    if (state !== "draft" && state !== "failed") throw new HttpError(409, state === "sent" ? "already sent" : state === "sending" ? "it's being sent" : "this message isn't one to send");
    if (inflight.has(m.id)) throw new HttpError(409, "it's being sent");
    if (typeof body.text === "string" && body.text !== m.text) {
      const mine = m.author.kind === "person" && m.author.id === user.id;
      if (m.type !== "draft" && !mine) throw new HttpError(403, "only its author edits a message");
      if (!body.text.trim() && !m.files.length) throw new HttpError(400, "say something");
      chat.updateMessage(m.id, { text: body.text }, { edited: true });
    }
    remember(user.id, body.request_id, m.id);
    await later(deliver(m.id, user.name));
    return { message: chat.getMessage(m.id) };
  });

  // a person throws a draft (or a failed message) away: removed like any message, its files stay archived
  r.post("/api/chat/messages/:id/discard", async (req) => {
    const user = requirePerson(req, "Discarding a draft");
    const body = await readJson<{ confirm?: unknown }>(req);
    const m = chat.getMessage(req.params.id);
    if (!m) throw new HttpError(404, "no such message");
    const c = chat.requireChannel(user, m.channel);
    if (!isMember(c, user.id)) throw new HttpError(403, "join this conversation first");
    if (body.confirm !== true) throw new HttpError(400, "discarding needs confirm: true");
    if (m.outbound?.state !== "draft" && m.outbound?.state !== "failed") throw new HttpError(409, "only a draft or a message that failed is discarded");
    return { message: chat.removeMessage(m.id) };
  });

  // a person starts a conversation from our side, where the service allows it (mail, WeCom; never WhatsApp or Instagram)
  r.post("/api/chat/portals", async (req) => {
    const user = requirePerson(req, "Starting a conversation outside Foundation");
    const body = await readJson<Record<string, unknown>>(req);
    const again = remembered(user.id, body.request_id);
    if (again) {
      const c = chat.getChannel(again);
      return { channel: c && chat.canSeeChannel(user, c) ? chat.channelView(user, c) : null };
    }
    const a = adapters.get(String(body.service ?? "") as BridgeService);
    if (!a) throw new HttpError(404, "no such bridge");
    if (!a.startConversation) throw new HttpError(400, a.startRule ?? `${a.name} can't start a conversation from here.`);
    const st = bridgeStatus(a.service);
    if (st.state === "off" || st.state === "needs-setup") throw new HttpError(409, `${a.name} isn't connected: ${st.detail}`);
    let started: Awaited<ReturnType<NonNullable<BridgeAdapter["startConversation"]>>>;
    try {
      started = await a.startConversation(user, body);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, scrub((e as Error).message));
    }
    const ch = makePortal(a.service, { ...started.conversation, members: [...(started.conversation.members ?? []), user.id] }, false);
    if (!isMember(ch, user.id)) chat.addMember(ch.id, chat.personParty(user), { silent: true });
    const m = chat.postMessage(ch.id, chat.personParty(user), { text: started.text, origin: { service: a.service, externalId: started.externalId, ...(started.conversation.account ? { account: started.conversation.account } : {}) }, outbound: { state: "sent", by: user.name, at: Date.now() } });
    run("insert or ignore into chat_bridge_sent (service, external_id, message_id) values (?, ?, ?)", a.service, started.externalId, m.id);
    remember(user.id, body.request_id, ch.id);
    changed(a.service);
    return { channel: chat.channelView(user, chat.getChannel(ch.id)!) };
  });
}

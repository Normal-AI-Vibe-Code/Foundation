/**
 * A stand-in for the services, for tests and for seeing the bridges work without any keys: one small local
 * HTTP server that answers as Meta's Graph API (WhatsApp under /graph, Instagram under /ig), WeCom (/wecom),
 * Gmail (/google) and Google's OAuth (/oauth, /accounts). Each adapter's API base is an env var, so pointing
 * them here is all it takes (`standinEnv(base)`); nothing in an adapter knows it is talking to a stand-in.
 * It keeps every call it was sent, so a test can see what went out.
 *
 * Not loaded by the server. `node --import tsx src/bridges/standin.ts [port]` runs it on its own.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hmacHex } from "./common.ts";
import { wecomEncrypt, wecomSignature } from "./wechat.ts";

export interface StandinCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
  json?: Record<string, unknown>;
}

interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string;
  payload: Record<string, unknown>;
}

/** a mailbox: labels, threads, history; `deliver` is a new message arriving */
class FakeGmail {
  email = "ops@formindustries.com";
  labels = [{ id: "Label_7", name: "Foundation" }, { id: "INBOX", name: "INBOX" }, { id: "SENT", name: "SENT" }];
  messages = new Map<string, FakeMessage>();
  attachments = new Map<string, Buffer>();
  history: Array<{ id: string; messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds: string[] } }>; labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }> }> = [];
  historyId = 1000;
  oldestHistory = 1000;
  private n = 0;

  deliver(m: { threadId?: string; from: string; to?: string; subject: string; text?: string; html?: string; labels?: string[]; messageId?: string; references?: string; replyTo?: string; attachment?: { name: string; mime: string; body: Buffer } }): FakeMessage {
    const id = `msg${++this.n}`;
    const threadId = m.threadId ?? `thr${this.n}`;
    const headers = [
      { name: "From", value: m.from },
      { name: "To", value: m.to ?? this.email },
      { name: "Subject", value: m.subject },
      { name: "Message-ID", value: m.messageId ?? `<${id}@mail.example>` },
      ...(m.references ? [{ name: "References", value: m.references }] : []),
      ...(m.replyTo ? [{ name: "Reply-To", value: m.replyTo }] : []),
    ];
    const parts: Array<Record<string, unknown>> = [];
    if (m.text !== undefined) parts.push({ partId: "0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: m.text.length, data: Buffer.from(m.text).toString("base64url") } });
    if (m.html !== undefined) parts.push({ partId: "1", mimeType: "text/html", filename: "", body: { size: m.html.length, data: Buffer.from(m.html).toString("base64url") } });
    if (m.attachment) {
      const att = `att${this.n}`;
      this.attachments.set(att, m.attachment.body);
      parts.push({ partId: "2", mimeType: m.attachment.mime, filename: m.attachment.name, body: { size: m.attachment.body.length, attachmentId: att } });
    }
    const msg: FakeMessage = { id, threadId, labelIds: m.labels ?? ["INBOX", "Label_7"], internalDate: String(Date.now()), payload: { mimeType: "multipart/mixed", headers, parts } };
    this.messages.set(id, msg);
    this.history.push({ id: String(++this.historyId), messagesAdded: [{ message: { id, threadId, labelIds: msg.labelIds } }] });
    return msg;
  }

  thread(id: string) {
    return [...this.messages.values()].filter((m) => m.threadId === id);
  }
}

export interface Standin {
  base: string;
  calls: StandinCall[];
  gmail: FakeGmail;
  /** media the Graph and WeCom stand-ins serve, by id */
  media: Map<string, { mime: string; body: Buffer }>;
  /** path fragments whose sends answer with an error (a test's way to make a send fail) */
  failing: Set<string>;
  close(): Promise<void>;
}

/** the env that points every adapter at the stand-in */
export function standinEnv(base: string): Record<string, string> {
  return {
    WHATSAPP_API_BASE: `${base}/graph`,
    INSTAGRAM_API_BASE: `${base}/ig`,
    WECOM_API_BASE: `${base}/wecom`,
    GMAIL_API_BASE: `${base}/google`,
    GOOGLE_OAUTH_BASE: `${base}/oauth`,
    GOOGLE_ACCOUNTS_BASE: `${base}/accounts`,
  };
}

/** sign a body as Meta does */
export const metaSignature = (appSecret: string, body: string | Buffer) => `sha256=${hmacHex(appSecret, Buffer.isBuffer(body) ? body : Buffer.from(body))}`;

/** a WeCom callback POST's query and XML body, encrypted and signed as WeCom does */
export function wecomCallback(o: { token: string; aesKey: string; corpId: string; xml: string; timestamp?: string; nonce?: string }) {
  const encrypt = wecomEncrypt(o.aesKey, o.xml, o.corpId);
  const timestamp = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? "n0nce";
  const q = new URLSearchParams({ msg_signature: wecomSignature(o.token, timestamp, nonce, encrypt), timestamp, nonce });
  return { query: q.toString(), body: `<xml><ToUserName><![CDATA[${o.corpId}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>` };
}

export async function startStandin(port = 0): Promise<Standin> {
  const calls: StandinCall[] = [];
  const gmail = new FakeGmail();
  const media = new Map<string, { mime: string; body: Buffer }>();
  const failing = new Set<string>();
  let n = 0;
  let base = "";

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://standin");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    let json: Record<string, unknown> | undefined;
    if ((req.headers["content-type"] ?? "").includes("json") && body.length) {
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        /* not JSON */
      }
    }
    const call: StandinCall = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body, json };
    calls.push(call);
    const send = (status: number, out: unknown) => {
      const data = Buffer.isBuffer(out) ? out : Buffer.from(JSON.stringify(out));
      res.writeHead(status, { "content-type": Buffer.isBuffer(out) ? "application/octet-stream" : "application/json" });
      res.end(data);
    };
    const p = url.pathname;
    const bearer = (req.headers.authorization ?? "").startsWith("Bearer ");
    const failed = [...failing].some((f) => p.includes(f));

    // ----- Graph: WhatsApp -----
    let m: RegExpExecArray | null;
    if ((m = /^\/graph\/([^/]+)\/messages$/.exec(p)) && req.method === "POST") {
      if (!bearer) return send(401, { error: { message: "no token" } });
      if (failed) return send(400, { error: { message: "(#131047) Re-engagement message", error_user_msg: "Message failed to send because more than 24 hours have passed" } });
      return send(200, { messaging_product: "whatsapp", contacts: [{ input: json?.to, wa_id: json?.to }], messages: [{ id: `wamid.standin.${++n}` }] });
    }
    if ((m = /^\/graph\/([^/]+)\/media$/.exec(p)) && req.method === "POST") return send(200, { id: `media.${++n}` });
    if ((m = /^\/graph\/([^/]+)$/.exec(p)) && req.method === "GET") {
      const f = media.get(m[1]);
      if (!bearer || !f) return send(404, { error: { message: "no such media" } });
      return send(200, { url: `${base}/media/${m[1]}`, mime_type: f.mime, id: m[1] });
    }
    if ((m = /^\/media\/([^/]+)$/.exec(p))) {
      const f = media.get(m[1]);
      if (!f) return send(404, { error: "none" });
      res.writeHead(200, { "content-type": f.mime, "content-length": f.body.length });
      return res.end(f.body);
    }
    // ----- Graph: Instagram -----
    if ((m = /^\/ig\/([^/]+)\/messages$/.exec(p)) && req.method === "POST") {
      if (failed) return send(400, { error: { message: "outside of allowed window" } });
      return send(200, { recipient_id: (json?.recipient as { id?: string })?.id, message_id: `igmid.standin.${++n}` });
    }
    if ((m = /^\/ig\/([^/]+)$/.exec(p)) && req.method === "GET") return send(200, { name: "Rosa Vale", username: "studio.vale", id: m[1] });
    // ----- WeCom -----
    if (p === "/wecom/cgi-bin/gettoken") return send(200, url.searchParams.get("corpsecret") ? { errcode: 0, errmsg: "ok", access_token: "standin-token", expires_in: 7200 } : { errcode: 41004, errmsg: "corpsecret missing" });
    if (p === "/wecom/cgi-bin/message/send") {
      if (url.searchParams.get("access_token") !== "standin-token") return send(200, { errcode: 40014, errmsg: "invalid access_token" });
      return send(200, failed ? { errcode: 81013, errmsg: "user not found" } : { errcode: 0, errmsg: "ok", msgid: `wc${++n}` });
    }
    if (p === "/wecom/cgi-bin/media/get") {
      const f = media.get(url.searchParams.get("media_id") ?? "");
      if (url.searchParams.get("access_token") !== "standin-token" || !f) return send(200, { errcode: 40007, errmsg: "invalid media_id" });
      res.writeHead(200, { "content-type": f.mime });
      return res.end(f.body);
    }
    if (p === "/wecom/cgi-bin/media/upload") return send(200, { errcode: 0, type: "file", media_id: `wm${++n}` });
    // ----- Google OAuth -----
    if (p === "/oauth/token" && req.method === "POST") {
      const f = new URLSearchParams(body.toString("utf8"));
      if (f.get("grant_type") === "authorization_code") return send(200, { access_token: "ya29.standin", refresh_token: "1//standin-refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send" });
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token")) return send(200, { access_token: "ya29.standin", expires_in: 3600 });
      return send(400, { error: "invalid_grant" });
    }
    if (p === "/oauth/revoke") return send(200, {});
    // ----- Gmail -----
    if (p.startsWith("/google/gmail/v1/users/me/")) {
      if (req.headers.authorization !== "Bearer ya29.standin") return send(401, { error: { message: "Invalid Credentials" } });
      const rest = p.slice("/google/gmail/v1/users/me".length);
      if (rest === "/profile") return send(200, { emailAddress: gmail.email, historyId: String(gmail.historyId) });
      if (rest === "/labels") return send(200, { labels: gmail.labels });
      if (rest === "/watch") return send(200, { historyId: String(gmail.historyId), expiration: String(Date.now() + 7 * 864e5) });
      if (rest === "/history") {
        const start = Number(url.searchParams.get("startHistoryId"));
        if (start < gmail.oldestHistory) return send(404, { error: { message: "Requested entity was not found." } });
        return send(200, { history: gmail.history.filter((h) => Number(h.id) > start), historyId: String(gmail.historyId) });
      }
      if (rest === "/threads") {
        const label = url.searchParams.get("labelIds");
        const ids = [...new Set([...gmail.messages.values()].filter((x) => !label || x.labelIds.includes(label)).map((x) => x.threadId))].reverse();
        return send(200, { threads: ids.map((id) => ({ id })) });
      }
      if ((m = /^\/threads\/([^/]+)$/.exec(rest))) return send(200, { id: m[1], messages: gmail.thread(m[1]) });
      if ((m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(rest))) {
        const a = gmail.attachments.get(m[2]);
        return a ? send(200, { size: a.length, data: a.toString("base64url") }) : send(404, { error: { message: "not found" } });
      }
      if (rest === "/messages/send" && req.method === "POST") {
        if (failed) return send(400, { error: { message: "Invalid To header" } });
        const raw = Buffer.from(String(json?.raw ?? ""), "base64url").toString("utf8");
        const head = raw.split(/\r\n\r\n/)[0];
        const h = (k: string) => new RegExp(`^${k}: (.*)$`, "im").exec(head)?.[1] ?? "";
        const sent = gmail.deliver({ threadId: (json?.threadId as string) || undefined, from: h("From"), to: h("To"), subject: h("Subject"), text: "(sent)", labels: ["SENT"], messageId: h("Message-ID"), references: h("References") || undefined });
        return send(200, { id: sent.id, threadId: sent.threadId, labelIds: ["SENT"] });
      }
      if ((m = /^\/messages\/([^/]+)$/.exec(rest))) {
        const x = gmail.messages.get(m[1]);
        return x ? send(200, x) : send(404, { error: { message: "not found" } });
      }
    }
    send(404, { error: { message: `the stand-in doesn't play ${req.method} ${p}` } });
  });

  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    calls,
    gmail,
    media,
    failing,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

// run on its own: `node --import tsx src/bridges/standin.ts 16190`
if (process.argv[1] && /standin\.ts$/.test(process.argv[1])) {
  const s = await startStandin(Number(process.argv[2]) || 0);
  s.media.set("media.demo", { mime: "image/png", body: Buffer.from("89504e470d0a1a0a", "hex") });
  console.log(`stand-in services at ${s.base}`);
  for (const [k, v] of Object.entries(standinEnv(s.base))) console.log(`  ${k}=${v}`);
  setInterval(() => {
    const out = s.calls.splice(0).filter((c) => c.method === "POST");
    for (const c of out) console.log(`  ${c.method} ${c.path} ${c.json ? JSON.stringify(c.json) : `${c.body.length} bytes`}`);
  }, 500);
}

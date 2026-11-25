/**
 * WeChat through WeCom (企业微信), the official route for a company: a self-built WeCom app whose callback
 * receives what people send it, and whose API sends replies. Each person who writes to the app is a portal
 * (origin: their WeCom userid, account: corp id and agent id) and a ghost.
 *
 *  - Callback (WeCom's "receive messages" setting): every request carries `msg_signature`, `timestamp` and
 *    `nonce`; the signature is sha1 of the sorted token, timestamp, nonce and encrypted payload. The GET
 *    check decrypts `echostr` and answers it; a POST's XML `<Encrypt>` is decrypted with the EncodingAESKey
 *    (AES-256-CBC, IV = the key's first 16 bytes, PKCS#7 to 32) and must name our corp id.
 *  - In: text, image, voice, video, file, location, link. Media is fetched by media id with the app's token.
 *  - Out: text and files (uploaded first), through message/send with an `access_token` fetched with the
 *    app secret and cached until it expires. WeCom's API takes that token as a query parameter: it goes
 *    only to WeCom's own host, and never into a log or an error.
 *  - Who it reaches: people in the company's WeCom, and WeChat users only through WeCom's own interop.
 *    Customers on personal WeChat are reached by WeCom's Customer Contact or WeChat Customer Service
 *    (微信客服) APIs, or a WeChat Official Account: other adapters, not built. Personal WeChat accounts
 *    have no official API at all, and Foundation doesn't drive one unofficially.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { HttpError, type Req } from "../http.ts";
import { apiBase, env, fetchJson, needsOf, overrideHost, safeEqual, scrub } from "./common.ts";
import type { AdapterStatus, BridgeAdapter, InboundEvent, InboundFile, OutboundFile } from "./types.ts";

const base = () => apiBase("WECOM_API_BASE", "https://qyapi.weixin.qq.com");
const corpId = () => env("WECOM_CORP_ID");
const agentId = () => env("WECOM_AGENT_ID");
const account = () => `${corpId()}:${agentId()}`;

// ---------- WeCom's callback crypto (exported for tests) ----------

export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}

function aesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new HttpError(503, "WECOM_AES_KEY must be WeCom's 43-character EncodingAESKey");
  return key;
}

export function wecomDecrypt(encodingAesKey: string, encrypted: string): { message: string; receiveId: string } {
  const key = aesKey(encodingAesKey);
  const d = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  d.setAutoPadding(false);
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(Buffer.from(encrypted.replace(/ /g, "+"), "base64")), d.final()]);
  } catch {
    throw new HttpError(400, "can't decrypt");
  }
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 32) throw new HttpError(400, "can't decrypt");
  const content = plain.subarray(16, plain.length - pad);
  const len = content.readUInt32BE(0);
  if (len > content.length - 4) throw new HttpError(400, "can't decrypt");
  return { message: content.subarray(4, 4 + len).toString("utf8"), receiveId: content.subarray(4 + len).toString("utf8") };
}

export function wecomEncrypt(encodingAesKey: string, message: string, receiveId: string): string {
  const key = aesKey(encodingAesKey);
  const msg = Buffer.from(message, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const body = Buffer.concat([randomBytes(16), len, msg, Buffer.from(receiveId, "utf8")]);
  const pad = 32 - (body.length % 32);
  const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.concat([body, Buffer.alloc(pad, pad)])), c.final()]).toString("base64");
}

/** WeCom's flat XML: the text of each top-level tag (CDATA or plain) */
export function flatXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<([A-Za-z_][\w]*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g)) out[m[1]] = m[2] ?? (m[3] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return out;
}

function checkSignature(q: URLSearchParams, encrypt: string) {
  const token = env("WECOM_TOKEN");
  if (!token || !env("WECOM_AES_KEY")) throw new HttpError(503, "WeCom's callback token and key aren't set");
  const sig = q.get("msg_signature") ?? "";
  if (!safeEqual(sig, wecomSignature(token, q.get("timestamp") ?? "", q.get("nonce") ?? "", encrypt))) throw new HttpError(401, "bad signature");
}

// ---------- the app's token ----------

let cached: { token: string; until: number; key: string } | null = null;
async function accessToken(): Promise<string> {
  const key = `${corpId()}|${env("WECOM_SECRET").slice(0, 6)}`;
  if (cached && cached.key === key && cached.until > Date.now()) return cached.token;
  const r = await fetchJson<{ errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }>(
    `${base()}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId())}&corpsecret=${encodeURIComponent(env("WECOM_SECRET"))}`,
    { what: "WeCom token" },
  );
  if (r.errcode || !r.access_token) throw new Error(`WeCom token: ${r.errcode} ${scrub(r.errmsg ?? "")}`);
  cached = { token: r.access_token, until: Date.now() + Math.max(60, (r.expires_in ?? 7200) - 300) * 1000, key };
  return r.access_token;
}

async function wecomPost<T extends { errcode?: number; errmsg?: string }>(path: string, body: unknown): Promise<T> {
  const tok = await accessToken();
  const r = await fetchJson<T>(`${base()}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(tok)}`, { what: "WeCom", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.errcode) {
    if (r.errcode === 40014 || r.errcode === 42001) cached = null; // a token WeCom no longer takes
    throw new Error(`WeCom: ${r.errcode} ${scrub(r.errmsg ?? "")}`);
  }
  return r;
}

async function uploadMedia(f: OutboundFile, type: "image" | "file"): Promise<string> {
  const tok = await accessToken();
  const form = new FormData();
  form.set("media", new Blob([new Uint8Array(f.body)], { type: f.mime }), f.name);
  const r = await fetchJson<{ errcode?: number; errmsg?: string; media_id?: string }>(`${base()}/cgi-bin/media/upload?type=${type}&access_token=${encodeURIComponent(tok)}`, { what: "WeCom upload", method: "POST", body: form, timeoutMs: 60000 });
  if (r.errcode || !r.media_id) throw new Error(`WeCom upload: ${r.errcode} ${scrub(r.errmsg ?? "")}`);
  return r.media_id;
}

function mediaFile(kind: string, mediaId: string, msgId: string, name?: string): InboundFile {
  const ext = kind === "image" ? ".jpg" : kind === "voice" ? ".amr" : kind === "video" ? ".mp4" : "";
  return {
    name: name || `${kind}-${msgId.slice(-6)}${ext}`,
    mime: kind === "image" ? "image/jpeg" : kind === "voice" ? "audio/amr" : kind === "video" ? "video/mp4" : "application/octet-stream",
    resolve: async () => ({ url: `${base()}/cgi-bin/media/get?access_token=${encodeURIComponent(await accessToken())}&media_id=${encodeURIComponent(mediaId)}` }),
  };
}

export const wechat: BridgeAdapter = {
  service: "wechat",
  name: "WeChat",

  status(): AdapterStatus {
    const needs = needsOf([
      ["WECOM_CORP_ID", "The company's WeCom corp id (My Company → Company Information)"],
      ["WECOM_AGENT_ID", "The self-built app's AgentId"],
      ["WECOM_SECRET", "The app's Secret, to send"],
      ["WECOM_TOKEN", "The callback Token set in the app's “Receive messages” settings"],
      ["WECOM_AES_KEY", "The callback EncodingAESKey (43 characters) from the same settings"],
    ]);
    const missing = needs.filter((n) => !n.set);
    if (missing.length)
      return {
        state: "needs-setup",
        detail: `Needs ${missing.map((n) => n.key).join(", ")}. Personal WeChat has no official API; this bridge is WeCom (企业微信).`,
        needs,
        canSend: false,
        steps: [
          "In the WeCom admin console (work.weixin.qq.com), App Management → Create an app. Note its AgentId and Secret: WECOM_AGENT_ID, WECOM_SECRET. The corp id is under My Company: WECOM_CORP_ID.",
          "In the app, set the trusted IP to this server's public address (WeCom refuses API calls from anywhere else).",
          "Under Receive messages → Set API, enter <public address>/api/chat/hooks/wechat, generate a Token and an EncodingAESKey and set them as WECOM_TOKEN and WECOM_AES_KEY. Restart the server first: WeCom checks the URL when you save.",
          "Set the app's visible range to the people who should reach it. To talk with customers on personal WeChat, WeCom's Customer Contact or WeChat Customer Service (微信客服) is the route (or a WeChat Official Account): not built yet.",
        ],
      };
    return { state: "live", detail: `Receiving messages to WeCom app ${agentId()}; replies go out through the app. Customers on personal WeChat aren't reachable this way yet.`, needs, canSend: true };
  },

  verifyWebhook(req: Req) {
    const q = req.query;
    const echostr = (q.get("echostr") ?? "").replace(/ /g, "+");
    try {
      checkSignature(q, echostr);
      const { message, receiveId } = wecomDecrypt(env("WECOM_AES_KEY"), echostr);
      if (receiveId !== corpId()) return { status: 403, body: "not our corp" };
      return { status: 200, body: message };
    } catch (e) {
      return { status: e instanceof HttpError ? e.status : 400, body: e instanceof HttpError ? e.message : "bad request" };
    }
  },

  async receive(req, raw) {
    const outer = flatXml(raw.toString("utf8"));
    const encrypt = outer.Encrypt ?? "";
    if (!encrypt) throw new HttpError(400, "no Encrypt");
    checkSignature(req.query, encrypt);
    const { message, receiveId } = wecomDecrypt(env("WECOM_AES_KEY"), encrypt);
    if (receiveId !== corpId()) throw new HttpError(401, "not our corp");
    const x = flatXml(message);
    const events: InboundEvent[] = [];
    const type = x.MsgType;
    if (type && type !== "event" && x.FromUserName) {
      const msgId = x.MsgId || `${x.FromUserName}-${x.CreateTime}`;
      const files: InboundFile[] = [];
      let text = "";
      if (type === "text") text = x.Content ?? "";
      else if (type === "image" || type === "voice" || type === "video" || type === "file") {
        if (x.MediaId) files.push(mediaFile(type, x.MediaId, msgId, x.FileName || x.Title));
      } else if (type === "location") text = `📍 ${x.Label || "A location"} (${x.Location_X}, ${x.Location_Y})`;
      else if (type === "link") text = `[${x.Title || x.Url}](${x.Url})${x.Description ? `\n${x.Description}` : ""}`;
      else text = `_(a ${type} message: open WeCom to see it)_`;
      const who = x.FromUserName;
      events.push({
        kind: "message",
        conversation: { externalId: who, account: account(), name: who, topic: `WeCom app ${agentId()}` },
        from: { handle: who },
        externalId: msgId,
        text,
        at: x.CreateTime ? Number(x.CreateTime) * 1000 : undefined,
        files,
      });
    }
    // WeCom wants an empty answer (or "success") within five seconds, or it tries again
    return { events, ack: "" };
  },

  async check(step) {
    if (step === "callback") return env("WECOM_TOKEN") && env("WECOM_AES_KEY") ? { ok: true, said: "Both are set. WeCom checks them itself when you save the callback URL in its console (it calls this server and expects the right answer)." } : { ok: false, said: `Still missing: ${["WECOM_TOKEN", "WECOM_AES_KEY"].filter((k) => !env(k)).join(", ")}.` };
    if (!corpId() || !env("WECOM_SECRET")) return { ok: false, said: `Paste ${!corpId() ? "the CorpID" : "the app's Secret"} first.` };
    cached = null;
    await accessToken();
    return { ok: true, said: `WeCom answered with an access token for ${corpId()}: the CorpID and Secret work together.${agentId() ? "" : " Paste the AgentId too."}` };
  },

  async send(portal, out) {
    const agentid = Number(agentId());
    let last: string | undefined;
    const text = out.text.trim();
    if (text) last = (await wecomPost<{ errcode?: number; errmsg?: string; msgid?: string }>("/cgi-bin/message/send", { touser: portal.externalId, msgtype: "text", agentid, text: { content: text.slice(0, 2000) } })).msgid;
    for (const f of out.files) {
      const kind = /^image\/(jpeg|png)$/.test(f.mime) && f.size <= 10 * 1024 * 1024 ? "image" : "file";
      const media_id = await uploadMedia(f, kind);
      last = (await wecomPost<{ errcode?: number; errmsg?: string; msgid?: string }>("/cgi-bin/message/send", { touser: portal.externalId, msgtype: kind, agentid, [kind]: { media_id } })).msgid ?? last;
    }
    return { externalId: last };
  },

  async startConversation(_by, body) {
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!/^[\w.@-]{1,64}$/.test(to)) throw new HttpError(400, "to: the person's WeCom userid");
    if (!text) throw new HttpError(400, "say something");
    const r = await wecomPost<{ errcode?: number; errmsg?: string; msgid?: string }>("/cgi-bin/message/send", { touser: to, msgtype: "text", agentid: Number(agentId()), text: { content: text.slice(0, 2000) } });
    return { conversation: { externalId: to, account: account(), name: to, topic: `WeCom app ${agentId()}` }, externalId: r.msgid ?? `sent-${Date.now()}`, text };
  },

  mediaHosts: () => ["qyapi.weixin.qq.com", ...overrideHost("WECOM_API_BASE")],

  demo(): InboundEvent[] {
    const id = `demo${Date.now().toString(36)}`;
    const conversation = { externalId: `${id}-wei`, account: "demo", name: "Li Wei (demo)", topic: "" };
    return [{ kind: "message", conversation, from: { handle: "demo-liwei", name: "Li Wei (demo)" }, externalId: `${id}-1`, at: Date.now() - 45_000, text: "样品已经寄出。The samples shipped this morning: tracking to follow." }];
  },
};

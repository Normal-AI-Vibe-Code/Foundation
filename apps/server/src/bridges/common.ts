/** Small helpers the adapters share: env, signatures, API bases, fetching JSON without leaking a credential. */

import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, type Req } from "../http.ts";

/** an env var, read when asked (tests and the Inbox see changes without a restart) */
export const env = (k: string) => (process.env[k] ?? "").trim();

/** which keys a bridge reads and whether each is set: never their values */
export const needsOf = (list: Array<[key: string, what: string, set?: boolean]>) => list.map(([key, what, set]) => ({ key, what, set: set ?? Boolean(env(key)) }));

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const hmacHex = (secret: string, raw: Buffer) => createHmac("sha256", secret).update(raw).digest("hex");

/** Meta's webhooks (WhatsApp, Instagram): `X-Hub-Signature-256: sha256=<hmac of the raw body with the app secret>` */
export function verifyMetaSignature(req: Req, raw: Buffer, secret: string) {
  if (!secret) throw new HttpError(503, "this bridge has no app secret set, so nothing it receives can be trusted");
  const h = req.headers["x-hub-signature-256"];
  const sig = Array.isArray(h) ? h[0] : h;
  if (!sig || !sig.startsWith("sha256=") || !safeEqual(sig.slice(7).toLowerCase(), hmacHex(secret, raw))) throw new HttpError(401, "bad signature");
}

/** Meta's GET handshake: hub.mode=subscribe and our verify token → the challenge, as plain text */
export function metaHandshake(req: Req, verifyToken: string): { status: number; body: string } {
  const q = req.query;
  if (!verifyToken) return { status: 503, body: "no verify token is set" };
  if (q.get("hub.mode") === "subscribe" && safeEqual(q.get("hub.verify_token") ?? "", verifyToken)) return { status: 200, body: q.get("hub.challenge") ?? "" };
  return { status: 403, body: "verify token doesn't match" };
}

/** an API base: the env override (tests' stand-in, a proxy) or the service's own */
export const apiBase = (key: string, fallback: string) => (env(key) || fallback).replace(/\/$/, "");

/** the host of an overridden base, which inbound files may also come from (a stand-in serves its own media) */
export function overrideHost(key: string): string[] {
  const v = env(key);
  if (!v) return [];
  try {
    return [new URL(v).host];
  } catch {
    return [];
  }
}

/** an error message with anything that looks like a credential taken out */
export const scrub = (s: string) =>
  s
    .replace(/(access_token|corpsecret|client_secret|refresh_token|code)=[^&\s"]+/gi, "$1=…")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer …")
    .slice(0, 400);

/** fetch JSON; a refusal becomes an Error carrying the service's own words (scrubbed), never the request */
export async function fetchJson<T>(url: string, init: RequestInit & { what: string; timeoutMs?: number }): Promise<T> {
  const { what, timeoutMs = 15000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`${what}: couldn't reach the service (${scrub((e as Error).message)})`);
  }
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const b = body as { error?: { message?: string; error_user_msg?: string } | string; error_description?: string; errmsg?: string };
    const why = typeof b.error === "object" ? (b.error?.error_user_msg ?? b.error?.message) : (b.error_description ?? b.error ?? b.errmsg);
    throw Object.assign(new Error(`${what}: ${res.status} ${scrub(String(why ?? res.statusText))}`), { status: res.status });
  }
  return body as T;
}

/** markdown's **bold** and ~~strike~~ as WhatsApp's *bold* and ~strike~ */
export const toWhatsAppText = (md: string) => md.replace(/\*\*([^*\n]+)\*\*/g, "*$1*").replace(/~~([^~\n]+)~~/g, "~$1~");
/** WhatsApp's *bold* and ~strike~ as markdown */
export const fromWhatsAppText = (t: string) => t.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, "$1**$2**").replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/gm, "$1~~$2~~");

export const HOUR = 3600_000;

/** the 24-hour customer-service window both Meta services set, from the customer's last message */
export function dayWindow(service: string, lastInboundAt: number | null, now = Date.now()) {
  const rule = `${service} lets a business reply only within 24 hours of the customer's last message.`;
  if (!lastInboundAt) return { open: false, rule, why: `${rule} They haven't written in this conversation, so it can only be opened by them (or, on WhatsApp, with a paid template message sent from WhatsApp Manager).` };
  const closesAt = lastInboundAt + 24 * HOUR;
  if (now < closesAt) return { open: true, rule, closesAt };
  const h = Math.floor((now - lastInboundAt) / HOUR);
  return {
    open: false,
    rule,
    closesAt,
    why:
      service === "WhatsApp"
        ? `The 24-hour window closed (their last message was ${h} hours ago). WhatsApp only reopens it with an approved template message, which Meta charges for: send one from WhatsApp Manager. Foundation never sends templates on its own.`
        : `The 24-hour window closed (their last message was ${h} hours ago). Instagram won't deliver this until they write again.`,
  };
}

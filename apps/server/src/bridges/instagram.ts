/**
 * Instagram direct messages through Meta's Instagram Messaging API (the Instagram API with Instagram Login,
 * graph.instagram.com). One professional account; each person who writes to it is a portal (origin: their
 * Instagram-scoped id, account: our Instagram account id) and a ghost.
 *
 *  - Webhook: the same GET handshake and `X-Hub-Signature-256` as WhatsApp, object `instagram`.
 *  - In: text and attachments (image, video, audio, file; their URLs are Meta's CDN, fetched under the cap).
 *    `is_echo` messages (sent from the Instagram app) show as our side's (the bridge's puppet person); an
 *    echo of a message Foundation sent is recognised by its id and not shown twice.
 *  - Out: text only. Instagram takes attachments by a public link, and this server's files are not public,
 *    so a message with files is refused rather than sent without them.
 *  - 24-hour window from their last message (the human-agent tag's 7 days needs Meta's review: not used).
 *  - Instagram never lets a business write first: no outbound conversations.
 */

import { HttpError, type Req } from "../http.ts";
import { apiBase, dayWindow, env, fetchJson, metaHandshake, needsOf, overrideHost, verifyMetaSignature } from "./common.ts";
import type { AdapterStatus, BridgeAdapter, InboundEvent, InboundFile, Portal } from "./types.ts";

const base = () => apiBase("INSTAGRAM_API_BASE", "https://graph.instagram.com/v21.0");
const token = () => env("INSTAGRAM_TOKEN");
const accountId = () => env("INSTAGRAM_ACCOUNT_ID");

interface IgMessaging {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: { mid: string; text?: string; is_echo?: boolean; is_deleted?: boolean; attachments?: Array<{ type: string; payload?: { url?: string } }> };
  read?: { mid: string };
}

const MIME: Record<string, string> = { image: "image/jpeg", video: "video/mp4", audio: "audio/mp4", file: "application/octet-stream" };

export const instagram: BridgeAdapter = {
  service: "instagram",
  name: "Instagram",

  status(): AdapterStatus {
    const needs = needsOf([
      ["INSTAGRAM_TOKEN", "A long-lived Instagram user access token with instagram_business_basic and instagram_business_manage_messages"],
      ["INSTAGRAM_ACCOUNT_ID", "The professional account's Instagram id"],
      ["INSTAGRAM_APP_SECRET", "The Meta app's secret, to check each webhook's signature"],
      ["INSTAGRAM_VERIFY_TOKEN", "Any long random string; the same one goes in the app's webhook settings"],
    ]);
    const missing = needs.filter((n) => !n.set);
    const window = "Replies only within 24 hours of their last message; Instagram never lets a business write first.";
    if (missing.length)
      return {
        state: "needs-setup",
        detail: `Needs ${missing.map((n) => n.key).join(", ")}.`,
        needs,
        canSend: false,
        window,
        steps: [
          "The company's Instagram must be a professional (business or creator) account.",
          "In Meta for Developers, add the Instagram product to the Business app and choose “API setup with Instagram login”. Add the account and generate a token; exchange it for a long-lived one and set INSTAGRAM_TOKEN (it lasts 60 days: refresh it before then).",
          "Set INSTAGRAM_ACCOUNT_ID to the account's id (shown beside it in API setup) and INSTAGRAM_APP_SECRET to the Instagram app secret.",
          "Pick a long random INSTAGRAM_VERIFY_TOKEN. Set the webhook callback to <public address>/api/chat/hooks/instagram with that token and subscribe to messages (and message_echoes).",
          "Until Meta approves the app (Advanced Access for instagram_business_manage_messages), only people with a role on the app can message it. Restart the server.",
        ],
      };
    return { state: "live", detail: `Receiving direct messages for account …${accountId().slice(-4)}; replies go out within 24 hours of their last message, text only.`, needs, canSend: true, window };
  },

  verifyWebhook: (req: Req) => metaHandshake(req, env("INSTAGRAM_VERIFY_TOKEN")),

  async receive(req, raw) {
    verifyMetaSignature(req, raw, env("INSTAGRAM_APP_SECRET"));
    let body: { object?: string; entry?: Array<{ id?: string; time?: number; messaging?: IgMessaging[] }> };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
    const events: InboundEvent[] = [];
    for (const entry of body.entry ?? []) {
      const account = entry.id ?? accountId();
      if (accountId() && account !== accountId()) continue;
      for (const ev of entry.messaging ?? []) {
        const msg = ev.message;
        if (!msg?.mid || msg.is_deleted || !ev.sender || !ev.recipient) continue;
        const echo = Boolean(msg.is_echo);
        const them = echo ? ev.recipient.id : ev.sender.id;
        const files: InboundFile[] = [];
        for (const [i, a] of (msg.attachments ?? []).entries()) {
          if (!a.payload?.url) continue;
          const mime = MIME[a.type] ?? "application/octet-stream";
          files.push({ name: `${a.type}-${msg.mid.slice(-6)}-${i + 1}${mime === "image/jpeg" ? ".jpg" : mime === "video/mp4" ? ".mp4" : mime === "audio/mp4" ? ".m4a" : ""}`, mime, url: a.payload.url });
        }
        const text = msg.text ?? (files.length ? "" : "_(a message Instagram doesn't share with apps: a story reply, a post or a reel)_");
        events.push({
          kind: "message",
          conversation: { externalId: them, account, name: `Instagram ${them.slice(-6)}`, topic: "Instagram direct messages" },
          from: echo ? { handle: account, name: "Us on Instagram", self: true } : { handle: them },
          externalId: msg.mid,
          text,
          at: ev.timestamp,
          files,
        });
      }
    }
    return { events };
  },

  async profile(handle: string) {
    if (!token()) return {};
    const p = await fetchJson<{ name?: string; username?: string }>(`${base()}/${encodeURIComponent(handle)}?fields=name,username`, { what: "Instagram profile", headers: { authorization: `Bearer ${token()}` } });
    const name = p.name && p.username ? `${p.name} (@${p.username})` : p.name || (p.username ? `@${p.username}` : undefined);
    return { name };
  },

  window: (portal: Portal) => dayWindow("Instagram", portal.lastInboundAt),

  async send(portal, out) {
    if (out.files.length) throw new Error("Instagram takes attachments only by a public link, and this server's files aren't public: send the words alone, or share the file another way.");
    const text = out.text.trim();
    if (!text) throw new Error("nothing to send");
    const r = await fetchJson<{ message_id?: string }>(`${base()}/${encodeURIComponent(portal.account || accountId())}/messages`, {
      what: "Instagram",
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: portal.externalId }, message: { text: text.slice(0, 1000) } }),
    });
    return { externalId: r.message_id };
  },

  mediaHosts: () => [".fbsbx.com", ".fbcdn.net", ".cdninstagram.com", ...overrideHost("INSTAGRAM_API_BASE")],

  startRule: "Instagram never lets a business write first: when someone messages the account, their conversation opens here.",

  demo(): InboundEvent[] {
    const id = `demo${Date.now().toString(36)}`;
    const conversation = { externalId: `${id}-ig`, account: "demo", name: "@studio.vale (demo)", topic: "" };
    const from = { handle: "demo-studio-vale", name: "@studio.vale (demo)" };
    return [{ kind: "message", conversation, from, externalId: `${id}-1`, at: Date.now() - 30_000, text: "Love the anodised finish in your last post. Do you take small batch orders?" }];
  },
};

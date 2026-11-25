/**
 * WhatsApp through Meta's WhatsApp Business Cloud API (the official route; unofficial libraries that drive
 * WhatsApp Web break its terms and get numbers banned). One business phone number; each customer's chat is
 * a portal (origin: their wa_id, account: our phone number id), each customer a ghost.
 *
 *  - Webhook: GET handshake with `hub.verify_token`; POST signed `X-Hub-Signature-256` (HMAC-SHA256 of the
 *    raw body with the app secret), checked before anything is read.
 *  - In: text, image, video, audio, voice, document, sticker, location, contacts (as words), and button
 *    replies. Media is fetched through the Graph API with the token (media id → short-lived URL → bytes).
 *  - Statuses (sent, delivered, read, failed) land on the message we sent.
 *  - Echoes (`smb_message_echoes`, when the number also runs the WhatsApp Business app): what someone sent
 *    from the phone shows as our side's message (the bridge's puppet person).
 *  - Out: text, and files (uploaded to the media endpoint first). Only inside the 24-hour customer-service
 *    window from their last message; outside it the send is refused, naming templates. Templates cost money
 *    and are never sent from here.
 */

import { HttpError, type Req } from "../http.ts";
import { apiBase, dayWindow, env, fetchJson, fromWhatsAppText, metaHandshake, needsOf, overrideHost, toWhatsAppText, verifyMetaSignature } from "./common.ts";
import type { AdapterStatus, BridgeAdapter, InboundEvent, InboundFile, OutboundFile, Portal } from "./types.ts";

const base = () => apiBase("WHATSAPP_API_BASE", "https://graph.facebook.com/v21.0");
const token = () => env("WHATSAPP_TOKEN");
const phoneId = () => env("WHATSAPP_PHONE_NUMBER_ID");

interface WaMedia {
  id: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}
interface WaMessage {
  from: string;
  to?: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  image?: WaMedia;
  video?: WaMedia;
  audio?: WaMedia;
  voice?: WaMedia;
  document?: WaMedia;
  sticker?: WaMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string }> }>;
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  reaction?: { emoji?: string; message_id?: string };
}
interface WaValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
  messages?: WaMessage[];
  message_echoes?: WaMessage[];
  statuses?: Array<{ id: string; status: string; recipient_id?: string; errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }> }>;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/aac": "aac", "application/pdf": "pdf" };

function mediaFile(kind: string, m: WaMedia, msgId: string): InboundFile {
  const mime = (m.mime_type ?? "application/octet-stream").split(";")[0].trim();
  const name = m.filename || `${kind}-${msgId.slice(-8)}.${EXT[mime] ?? "bin"}`;
  return {
    name,
    mime,
    resolve: async () => {
      // the media id → a short-lived URL (and its type), fetched with the same token
      const info = await fetchJson<{ url: string; mime_type?: string }>(`${base()}/${encodeURIComponent(m.id)}`, { what: "WhatsApp media", headers: { authorization: `Bearer ${token()}` } });
      return { url: info.url, headers: { authorization: `Bearer ${token()}` }, mime: info.mime_type };
    },
  };
}

/** a WhatsApp message as words and files */
function readMessage(m: WaMessage): { text: string; files: InboundFile[] } {
  const files: InboundFile[] = [];
  let text = "";
  switch (m.type) {
    case "text":
      text = fromWhatsAppText(m.text?.body ?? "");
      break;
    case "image":
    case "video":
    case "audio":
    case "voice":
    case "document":
    case "sticker": {
      const media = m[m.type as "image"];
      if (media?.id) files.push(mediaFile(m.type, media, m.id));
      text = fromWhatsAppText(media?.caption ?? "");
      break;
    }
    case "location":
      text = m.location ? `📍 ${[m.location.name, m.location.address].filter(Boolean).join(", ") || "A location"} (${m.location.latitude}, ${m.location.longitude})` : "📍 A location";
      break;
    case "contacts":
      text = (m.contacts ?? []).map((c) => `👤 ${c.name?.formatted_name ?? "A contact"} ${(c.phones ?? []).map((p) => p.phone).filter(Boolean).join(", ")}`.trim()).join("\n");
      break;
    case "button":
      text = m.button?.text ?? "";
      break;
    case "interactive":
      text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
      break;
    case "reaction":
      text = m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : "Removed a reaction";
      break;
    default:
      text = `_(a ${m.type} message: open WhatsApp to see it)_`;
  }
  return { text, files };
}

async function uploadMedia(f: OutboundFile): Promise<string> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", f.mime);
  form.set("file", new Blob([new Uint8Array(f.body)], { type: f.mime }), f.name);
  const out = await fetchJson<{ id: string }>(`${base()}/${encodeURIComponent(phoneId())}/media`, { what: "WhatsApp upload", method: "POST", headers: { authorization: `Bearer ${token()}` }, body: form, timeoutMs: 60000 });
  return out.id;
}

const kindOf = (mime: string) => (mime.startsWith("image/") && /jpeg|png/.test(mime) ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document");

export const whatsapp: BridgeAdapter = {
  service: "whatsapp",
  name: "WhatsApp",

  status(): AdapterStatus {
    const needs = needsOf([
      ["WHATSAPP_TOKEN", "A system user's permanent access token with whatsapp_business_messaging"],
      ["WHATSAPP_PHONE_NUMBER_ID", "The business phone number's id (WhatsApp Manager → API setup)"],
      ["WHATSAPP_APP_SECRET", "The Meta app's secret, to check each webhook's signature"],
      ["WHATSAPP_VERIFY_TOKEN", "Any long random string; the same one goes in the app's webhook settings"],
    ]);
    const missing = needs.filter((n) => !n.set);
    const window = "Replies only within 24 hours of the customer's last message; after that only a paid template, sent from WhatsApp Manager.";
    if (missing.length)
      return {
        state: "needs-setup",
        detail: `Needs ${missing.map((n) => n.key).join(", ")}.`,
        needs,
        canSend: false,
        window,
        steps: [
          "In Meta for Developers, make (or open) a Business app and add the WhatsApp product; connect the company's WhatsApp Business Account and phone number.",
          "In Business Settings → System users, make a system user, give it the app and the WhatsApp account, and generate a permanent token with whatsapp_business_messaging and whatsapp_business_management. Set WHATSAPP_TOKEN.",
          "Copy the phone number id from WhatsApp → API setup into WHATSAPP_PHONE_NUMBER_ID, and the app secret (App settings → Basic) into WHATSAPP_APP_SECRET.",
          "Pick a long random WHATSAPP_VERIFY_TOKEN. In WhatsApp → Configuration set the callback URL to <public address>/api/chat/hooks/whatsapp with that token, and subscribe to the messages field (and smb_message_echoes if the number also uses the WhatsApp Business app).",
          "Restart the server. A customer's message then opens a portal here; replies go out within the 24-hour window.",
        ],
      };
    return { state: "live", detail: `Receiving on phone number id …${phoneId().slice(-4)}; replies go out within 24 hours of a customer's last message.`, needs, canSend: true, window };
  },

  verifyWebhook: (req: Req) => metaHandshake(req, env("WHATSAPP_VERIFY_TOKEN")),

  async receive(req, raw) {
    verifyMetaSignature(req, raw, env("WHATSAPP_APP_SECRET"));
    let body: { object?: string; entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: WaValue }> }> };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
    const events: InboundEvent[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value;
        if (!v) continue;
        const account = v.metadata?.phone_number_id ?? "";
        // another number on the same app: not ours
        if (phoneId() && account && account !== phoneId()) continue;
        const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? ""]));
        for (const m of v.messages ?? []) {
          const { text, files } = readMessage(m);
          const name = names.get(m.from) || `+${m.from}`;
          events.push({
            kind: "message",
            conversation: { externalId: m.from, account, name, topic: `WhatsApp · +${m.from}` },
            from: { handle: `+${m.from}`, name },
            externalId: m.id,
            text,
            at: m.timestamp ? Number(m.timestamp) * 1000 : undefined,
            files,
          });
        }
        for (const m of v.message_echoes ?? []) {
          const to = m.to ?? "";
          if (!to) continue;
          const { text, files } = readMessage(m);
          events.push({
            kind: "message",
            conversation: { externalId: to, account, name: names.get(to) || `+${to}`, topic: `WhatsApp · +${to}` },
            from: { handle: `+${m.from}`, name: v.metadata?.display_phone_number ?? "Us", self: true },
            externalId: m.id,
            text,
            at: m.timestamp ? Number(m.timestamp) * 1000 : undefined,
            files,
          });
        }
        for (const s of v.statuses ?? []) {
          const state = s.status === "failed" ? "failed" : s.status === "read" ? "read" : s.status === "delivered" ? "delivered" : "sent";
          const err = s.errors?.[0];
          events.push({ kind: "status", externalId: s.id, state, ...(err ? { error: [err.title, err.error_data?.details ?? err.message].filter(Boolean).join(": ") } : {}) });
        }
      }
    }
    return { events };
  },

  window: (portal: Portal) => dayWindow("WhatsApp", portal.lastInboundAt),

  async send(portal, out) {
    const to = portal.externalId;
    const url = `${base()}/${encodeURIComponent(phoneId())}/messages`;
    const headers = { authorization: `Bearer ${token()}`, "content-type": "application/json" };
    let last: string | undefined;
    const files = out.files;
    const text = toWhatsAppText(out.text.trim());
    // one file can carry the words as its caption (not audio, which has none); otherwise the words go first
    const captionOn = files.length === 1 && kindOf(files[0].mime) !== "audio" && text.length <= 1024;
    if (text && !captionOn) {
      const r = await fetchJson<{ messages?: Array<{ id: string }> }>(url, { what: "WhatsApp", method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text.slice(0, 4096), preview_url: false } }) });
      last = r.messages?.[0]?.id;
    }
    for (const f of files) {
      const id = await uploadMedia(f);
      const kind = kindOf(f.mime);
      const media: Record<string, string> = { id };
      if (captionOn && text) media.caption = text;
      if (kind === "document") media.filename = f.name;
      const r = await fetchJson<{ messages?: Array<{ id: string }> }>(url, { what: "WhatsApp", method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: kind, [kind]: media }) });
      last = r.messages?.[0]?.id ?? last;
    }
    return { externalId: last };
  },

  mediaHosts: () => ["graph.facebook.com", ".fbsbx.com", ".fbcdn.net", ".whatsapp.net", ...overrideHost("WHATSAPP_API_BASE")],

  async check(step) {
    if (step === "secret") return env("WHATSAPP_APP_SECRET") && env("WHATSAPP_VERIFY_TOKEN") ? { ok: true, said: "Both are set. Meta's first webhook proves the app secret: a message with a bad signature is refused." } : { ok: false, said: `Still missing: ${["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"].filter((k) => !env(k)).join(", ")}.` };
    if (!token() || !phoneId()) return { ok: false, said: `Paste ${!token() ? "the access token" : "the phone number id"} first.` };
    const r = await fetchJson<{ display_phone_number?: string; verified_name?: string; id?: string }>(`${base()}/${encodeURIComponent(phoneId())}?fields=display_phone_number,verified_name`, { what: "WhatsApp", headers: { authorization: `Bearer ${token()}` } });
    return { ok: true, said: `WhatsApp answered: ${r.display_phone_number ?? `number ${r.id ?? phoneId()}`}${r.verified_name ? `, “${r.verified_name}”` : ""}. The token can use this number.` };
  },

  startRule: "WhatsApp only lets a business start a conversation with an approved template message, which Meta charges for. Foundation doesn't send templates: send one from WhatsApp Manager, and their reply opens a portal here.",

  demo(): InboundEvent[] {
    const id = `demo${Date.now().toString(36)}`;
    const conversation = { externalId: `${id}-15550101234`, account: "demo", name: "Mei Tanaka (demo)", topic: "" };
    const from = { handle: "+15550101234", name: "Mei Tanaka (demo)" };
    const now = Date.now();
    return [
      { kind: "message", conversation, from, externalId: `${id}-1`, at: now - 120_000, text: "Hi! Are the **40 brackets** still on for Friday?" },
      { kind: "message", conversation, from, externalId: `${id}-2`, at: now - 60_000, text: "Here's the drawing with the hole spacing we talked about.", files: [{ name: "bracket-notes.txt", mime: "text/plain", data: Buffer.from("Bracket B-40\nHole spacing: 32 mm\nFinish: anodised black\n") }] },
    ];
  },
};

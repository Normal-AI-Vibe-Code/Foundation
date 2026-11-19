// B1 real run: a live server on 16151, the stand-in Graph on 16190
import { createHmac } from "node:crypto";
const S = "http://127.0.0.1:16151";
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`${S}/api/chat/hooks/whatsapp`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const login = await fetch(`${S}/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "josh@formindustries.com", name: "Josh Run" }) });
const cookie = login.headers.get("set-cookie").split(";")[0];
const me = (await login.json()).user;
console.log("signed in", me.name, me.role);
const j = async (method, path, body, headers = {}) => {
  const r = await fetch(`${S}${path}`, { method, headers: { cookie, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};
await j("GET", "/api/chat");
const hs = await fetch(`${S}/api/chat/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=run-verify&hub.challenge=4242`);
console.log("handshake", hs.status, await hs.text());
const st = await j("GET", "/api/chat/bridges");
console.log("statuses", st.body.bridges.map((b) => `${b.service}:${b.state}`).join(" "), "| leaks token?", JSON.stringify(st.body).includes("run-token-xyz"));
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "555001", display_phone_number: "15550001" }, contacts: [{ wa_id: "447700900777", profile: { name: "Run Customer" } }], messages: [{ from: "447700900777", id: "wamid.RUN1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hello from the *real run*" } }] } }] }] });
const sig = "sha256=" + createHmac("sha256", "run-app-secret").update(body).digest("hex");
const bad = await fetch(`${S}/api/chat/hooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body });
console.log("bad signature", bad.status);
const good = await fetch(`${S}/api/chat/hooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
console.log("signed webhook", good.status);
await new Promise((r) => setTimeout(r, 500));
const list = await j("GET", "/api/chat");
const portal = list.body.channels.find((c) => c.kind === "portal" && c.origin?.service === "whatsapp");
console.log("portal", portal?.id, portal?.name, portal?.origin, "unread", portal?.unread);
const msgs = await j("GET", `/api/chat/channels/${portal.id}/messages`);
for (const m of msgs.body.messages) console.log("  ·", m.author.kind, m.author.name, m.author.handle ?? "", JSON.stringify(m.text));
const reply = await j("POST", `/api/chat/channels/${portal.id}/messages`, { text: "Thanks, **on it**.", request_id: "run-reply-1" });
console.log("reply posted", reply.status, reply.body.message.outbound);
await new Promise((r) => setTimeout(r, 800));
const after = await j("GET", `/api/chat/channels/${portal.id}/messages`);
console.log("reply now", after.body.messages.at(-1).outbound);
const demo = await j("POST", "/api/chat/bridges/wechat/demo", {});
console.log("demo", demo.status, demo.body.channel?.name, "|", demo.body.channel?.topic);

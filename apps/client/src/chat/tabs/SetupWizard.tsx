/**
 * A bridge's setup, one step per screen (Inbox → Set it up): a modal sheet with progress dots and Back /
 * Next. Each step says exactly what to do over there, with a button that opens the right console page, a
 * copy button for each value the console asks for (the webhook address, a verify token), fields for what
 * the console gives back, and **Check**, which asks the provider what can be asked now (only on that press).
 *
 * What's pasted goes to the server sealed (`POST /api/chat/bridges/:service/keys`) and never comes back:
 * a field says *set · stored by Ana · …x7Qa* at most. A verify token made here is shown once, to copy into
 * the console, before it's saved. Without a public https address the first step says so plainly, explains
 * the two ways round it, and lets an admin fill in the rest now. Someone who isn't an admin reads the same
 * steps and can copy a note asking an admin.
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { copyText, openOutside, randomKey, type BridgeView, type KeyState, type ServerFacts } from "./bridges";
import "./slackguide.css";

export type WizardService = "gmail" | "whatsapp" | "instagram" | "wechat";

interface Field {
  key: string;
  label: string;
  /** a value made here (a verify token, an AES key) that the person copies into the console */
  make?: number;
  placeholder?: string;
}
interface Link {
  label: string;
  url: string;
  /** the address may move; the step says what to look for if it has */
  unsure?: boolean;
}
interface Step {
  title: string;
  body: string[];
  links?: Link[];
  copy?: Array<{ label: string; value: (s: Ctx) => string }>;
  fields?: Field[];
  check?: string;
  address?: boolean;
}
interface Ctx {
  server: ServerFacts;
  hook: string;
}

const META_APPS: Link = { label: "Open Meta for Developers (your apps)", url: "https://developers.facebook.com/apps/" };
const SYSTEM_USERS: Link = { label: "Open Business settings → System users", url: "https://business.facebook.com/settings/system-users" };

export const WIZARDS: Record<WizardService, { name: string; mono: string; steps: Step[] }> = {
  gmail: {
    name: "Mail",
    mono: "M",
    steps: [
      {
        title: "Turn on the Gmail API",
        body: ["In Google Cloud Console, pick the project that holds Foundation's sign-in client (or make one for Foundation) and enable the Gmail API."],
        links: [{ label: "Open the Gmail API in Google Cloud", url: "https://console.cloud.google.com/apis/library/gmail.googleapis.com" }],
      },
      {
        title: "The consent screen",
        body: ["Make it Internal (the company's Workspace only: no Google review), and add the scopes gmail.readonly and gmail.send. Foundation reads only the threads under one label and sends only what a person writes."],
        links: [{ label: "Open the OAuth consent screen", url: "https://console.cloud.google.com/apis/credentials/consent" }],
      },
      {
        title: "The OAuth client",
        body: ["Under Credentials, make (or open) a Web application client and add this redirect URI to it. Then paste its client id and secret here."],
        links: [{ label: "Open Credentials", url: "https://console.cloud.google.com/apis/credentials" }],
        copy: [{ label: "Redirect URI", value: (c) => `${c.server.publicUrl}/api/chat/bridges/gmail/callback` }],
        fields: [
          { key: "GMAIL_CLIENT_ID", label: "Client id", placeholder: "…apps.googleusercontent.com" },
          { key: "GMAIL_CLIENT_SECRET", label: "Client secret" },
        ],
        check: "client",
      },
      {
        title: "Done: each person connects their own",
        body: ["In Gmail, make a label called “Foundation”: only threads under it come in. Then each person presses Connect your Gmail on the Mail card and approves on Google's page."],
      },
    ],
  },
  whatsapp: {
    name: "WhatsApp",
    mono: "Wa",
    steps: [
      { title: "Where Meta will reach this server", body: [], address: true, check: "address" },
      {
        title: "A Meta app with WhatsApp",
        body: ["In Meta for Developers, make a Business app (or open the company's), add the WhatsApp product, and connect the company's WhatsApp Business Account and phone number."],
        links: [META_APPS],
      },
      {
        title: "A permanent token",
        body: ["In Business settings → System users, make a system user, give it the app and the WhatsApp account, and generate a token with whatsapp_business_messaging and whatsapp_business_management. Paste it here."],
        links: [SYSTEM_USERS],
        fields: [{ key: "WHATSAPP_TOKEN", label: "Access token" }],
      },
      {
        title: "The phone number",
        body: ["In the app's WhatsApp → API setup, copy the phone number's id (not the number itself)."],
        links: [{ label: "Open WhatsApp Manager", url: "https://business.facebook.com/wa/manage/phone-numbers/", unsure: true }],
        fields: [{ key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number id", placeholder: "1098765…" }],
        check: "token",
      },
      {
        title: "The webhook",
        body: [
          "Copy the app secret from App settings → Basic and paste it here: every message Meta sends is checked against it.",
          "Make a verify token here, then in the app's WhatsApp → Configuration set the callback URL and that verify token, and subscribe to the messages field.",
        ],
        links: [META_APPS],
        copy: [{ label: "Callback URL", value: (c) => c.hook }],
        fields: [
          { key: "WHATSAPP_APP_SECRET", label: "App secret" },
          { key: "WHATSAPP_VERIFY_TOKEN", label: "Verify token", make: 40 },
        ],
        check: "secret",
      },
      { title: "Done", body: ["A customer's message now opens a conversation in the Inbox. Replies go out within WhatsApp's 24-hour window; paid templates are never sent from here."] },
    ],
  },
  instagram: {
    name: "Instagram",
    mono: "Ig",
    steps: [
      { title: "Where Meta will reach this server", body: [], address: true, check: "address" },
      {
        title: "A Meta app with Instagram",
        body: ["In Meta for Developers, open the company's app and add Instagram (API setup with Instagram login). Connect the company's Instagram professional account."],
        links: [META_APPS],
      },
      {
        title: "The account and its token",
        body: ["Generate a token for the account with instagram_business_basic and instagram_business_manage_messages, and copy the account's id."],
        links: [META_APPS],
        fields: [
          { key: "INSTAGRAM_TOKEN", label: "Access token" },
          { key: "INSTAGRAM_ACCOUNT_ID", label: "Account id" },
        ],
        check: "token",
      },
      {
        title: "The webhook",
        body: ["Paste the app secret (App settings → Basic). Make a verify token here, then set the callback URL and that token in the app's Instagram webhook settings and subscribe to messages."],
        links: [META_APPS],
        copy: [{ label: "Callback URL", value: (c) => c.hook }],
        fields: [
          { key: "INSTAGRAM_APP_SECRET", label: "App secret" },
          { key: "INSTAGRAM_VERIFY_TOKEN", label: "Verify token", make: 40 },
        ],
        check: "secret",
      },
      { title: "Done", body: ["A direct message to the account now opens a conversation in the Inbox. Replies go out within 24 hours of their last message."] },
    ],
  },
  wechat: {
    name: "WeChat",
    mono: "Wc",
    steps: [
      { title: "Where WeCom will reach this server", body: [], address: true, check: "address" },
      {
        title: "The company and its app",
        body: ["In the WeCom admin console, copy the CorpID (My Company → Company Information). Under App Management make a self-built app for Foundation and copy its AgentId and Secret."],
        links: [
          { label: "Open the WeCom admin console", url: "https://work.weixin.qq.com/wework_admin/frame#apps" },
          { label: "Company information", url: "https://work.weixin.qq.com/wework_admin/frame#profile", unsure: true },
        ],
        fields: [
          { key: "WECOM_CORP_ID", label: "CorpID" },
          { key: "WECOM_AGENT_ID", label: "AgentId" },
          { key: "WECOM_SECRET", label: "Secret" },
        ],
        check: "token",
      },
      {
        title: "Receiving messages",
        body: ["In the app's Receive Messages → Set API Receive, make a Token and an EncodingAESKey here, paste the URL and both there, and save. WeCom calls this server to check them. Add this server's public IP to the app's trusted IPs."],
        copy: [{ label: "URL", value: (c) => c.hook }],
        fields: [
          { key: "WECOM_TOKEN", label: "Token", make: 24 },
          { key: "WECOM_AES_KEY", label: "EncodingAESKey", make: 43 },
        ],
        check: "callback",
      },
      { title: "Done", body: ["A message to the app now opens a conversation in the Inbox; replies go out as the app."] },
    ],
  },
};

export function SetupWizard({ service, bridge, server, admin, onClose, onChanged, inline = false, startAt = 0 }: { service: WizardService; bridge: BridgeView | null; server: ServerFacts; admin: boolean; onClose: () => void; onChanged?: (b: BridgeView) => void; inline?: boolean; startAt?: number }) {
  const w = WIZARDS[service];
  const [at, setAt] = useState(startAt);
  const [keys, setKeys] = useState<KeyState[]>(bridge?.keys ?? []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; said: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => setKeys(bridge?.keys ?? []), [bridge?.keys]);
  useEffect(() => {
    setSaid(null);
    setErr(null);
  }, [at]);
  useEffect(() => {
    if (inline) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [inline, onClose]);
  const ctx: Ctx = { server, hook: bridge?.hook ?? `${server.publicUrl}/api/chat/hooks/${service}` };
  const step = w.steps[at];
  const last = at === w.steps.length - 1;
  const keyOf = (k: string) => keys.find((x) => x.key === k);
  const dirty = (step.fields ?? []).some((f) => draft[f.key]?.trim());

  const save = async () => {
    const out: Record<string, string> = {};
    for (const f of step.fields ?? []) if (draft[f.key]?.trim()) out[f.key] = draft[f.key].trim();
    if (!Object.keys(out).length) return true;
    const r = await api<{ keys: KeyState[]; bridge: BridgeView }>(`/api/chat/bridges/${service}/keys`, { method: "POST", json: { keys: out } });
    setKeys(r.keys);
    setDraft({});
    onChanged?.(r.bridge);
    return true;
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const check = () =>
    act(async () => {
      await save();
      const r = await api<{ check: { ok: boolean; said: string }; bridge: BridgeView }>(`/api/chat/bridges/${service}/check`, { method: "POST", json: { step: step.check } });
      setSaid(r.check);
      onChanged?.(r.bridge);
    });
  const copy = async (label: string, value: string) => {
    if (await copyText(value)) {
      setCopied(label);
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1600);
    }
  };
  const note = useMemo(() => `Could you set up ${w.name} for ChatForm on our Foundation server (${server.publicUrl})? Open ChatForm → Inbox → ${w.name} → Set it up: it walks through each step.`, [w.name, server.publicUrl]);

  const sheet = (
    <div className={`fx-sheet ${inline ? "is-inline" : ""}`} role="dialog" aria-modal={!inline} aria-label={`Set up ${w.name}`} data-wizard={service}>
      <header className="fx-head">
        <span className="fx-mono" aria-hidden>
          {w.mono}
        </span>
        <h2>Set up {w.name}</h2>
        <span className="fx-dots" aria-label={`Step ${at + 1} of ${w.steps.length}`}>
          {w.steps.map((_, i) => (
            <span key={i} className={`fx-dot ${i === at ? "is-on" : i < at ? "is-done" : ""}`} />
          ))}
        </span>
        {!inline && (
          <button type="button" className="fx-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </header>
      <div className="fx-body">
        <p className="fx-eyebrow">
          Step {at + 1} of {w.steps.length}
        </p>
        <h3 className="fx-title">{step.title}</h3>
        {step.address && <AddressStep server={server} />}
        {step.body.map((b, i) => (
          <p key={i} className="fx-text">
            {b}
          </p>
        ))}
        {step.links && (
          <div className="fx-links">
            {step.links.map((l) => (
              <button key={l.url} type="button" className="f-pill" onClick={() => openOutside(l.url)} data-open-url={l.url}>
                {l.label} ↗
              </button>
            ))}
            {step.links.some((l) => l.unsure) && <span className="fx-quiet">If a page has moved, look for it from the console's home.</span>}
          </div>
        )}
        {step.copy?.map((c) => {
          const v = c.value(ctx);
          return (
            <div key={c.label} className="fx-copy">
              <span className="fx-label">{c.label}</span>
              <code className="fx-value" title={v}>{v}</code>
              <button type="button" className="f-pill" onClick={() => void copy(c.label, v)}>
                {copied === c.label ? "Copied" : "Copy"}
              </button>
            </div>
          );
        })}
        {step.fields?.map((f) => {
          const k = keyOf(f.key);
          return (
            <label key={f.key} className="fx-field">
              <span className="fx-label">
                {f.label} <code>{f.key}</code>
              </span>
              <span className="fx-input-row">
                <input
                  type={f.make ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!admin || busy}
                  placeholder={k?.set ? `set${k.source === "env" ? " in the server's .env" : ""}${k.tail ? ` · …${k.tail}` : ""} (paste to replace)` : (f.placeholder ?? "paste it here")}
                  value={draft[f.key] ?? ""}
                  aria-invalid={err || said?.ok === false ? true : undefined}
                  aria-describedby={err ? `fx-err-${service}` : said?.ok === false ? `fx-said-${service}` : undefined}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  data-key={f.key}
                />
                {f.make && admin && (
                  <button type="button" className="f-pill" disabled={busy} onClick={(e) => (e.preventDefault(), setDraft((d) => ({ ...d, [f.key]: randomKey(f.make!) })))}>
                    Make one
                  </button>
                )}
                {f.make && draft[f.key] && (
                  <button type="button" className="f-pill" onClick={(e) => (e.preventDefault(), void copy(f.key, draft[f.key]))}>
                    {copied === f.key ? "Copied" : "Copy"}
                  </button>
                )}
              </span>
              <span className={`fx-keystate ${k?.set ? "is-set" : ""}`}>
                <span className={`f-dot ${k?.set ? "is-ok" : "is-warn"}`} />
                {k?.set ? `Set${k.source === "stored" ? `${k.setBy ? ` by ${k.setBy}` : ""}, sealed on the server` : " in the server's .env"}${k.tail ? ` · ends …${k.tail}` : ""}` : "Not set"}
                {f.make && draft[f.key] ? " · copy it into the console now: it isn't shown again once saved" : ""}
              </span>
            </label>
          );
        })}
        {said && (
          <p className={`fx-said ${said.ok ? "is-ok" : "is-bad"}`} id={`fx-said-${service}`} role={said.ok ? "status" : "alert"} data-check-said>
            <span className={`f-dot ${said.ok ? "is-ok" : "is-bad"}`} /> {said.said}
          </p>
        )}
        {err && <p className="inbox-err" id={`fx-err-${service}`} role="alert">{err}</p>}
        {!admin && (
          <div className="fx-ask">
            <p className="fx-quiet">Setting {w.name} up is an admin's: it connects the company's account for everyone on this server.</p>
            <button type="button" className="f-pill" onClick={() => void copy("note", note)}>
              {copied === "note" ? "Copied" : "Copy a note for an admin"}
            </button>
          </div>
        )}
      </div>
      <footer className="fx-foot">
        <button type="button" className="f-pill" disabled={at === 0 || busy} onClick={() => setAt((x) => x - 1)}>
          Back
        </button>
        <span className="fx-gap" />
        {admin && step.fields && (
          <button type="button" className="f-pill" disabled={busy || !dirty} onClick={() => void act(save)}>
            Save
          </button>
        )}
        {step.check && (admin || step.address) && (
          <button type="button" className="f-pill" disabled={busy} onClick={() => void check()} data-check={step.check}>
            {busy ? "Checking…" : "Check"}
          </button>
        )}
        {last ? (
          <button type="button" className="f-pill is-accent" disabled={busy} onClick={() => void act(async () => (await save(), onClose()))}>
            Finish
          </button>
        ) : (
          <button type="button" className="f-pill is-accent" disabled={busy} onClick={() => void act(async () => (admin && (await save()), setAt((x) => x + 1)))}>
            Next
          </button>
        )}
      </footer>
    </div>
  );
  if (inline) return sheet;
  return (
    <div className="fx-veil" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      {sheet}
    </div>
  );
}

/** the honest first step: can the service reach this server at all */
function AddressStep({ server }: { server: ServerFacts }) {
  return (
    <div className={`fx-address ${server.reachable ? "is-ok" : "is-warn"}`}>
      <p className="fx-text">
        <span className={`f-dot ${server.reachable ? "is-ok" : "is-warn"}`} />{" "}
        {server.reachable ? (
          <>
            This server's public address is <code>{server.publicUrl}</code>: public https, so the service can deliver messages to it.
          </>
        ) : (
          (server.why ?? `This server's public address is ${server.publicUrl}, which the service can't reach.`)
        )}
      </p>
      {!server.reachable && (
        <ul className="fx-ways">
          <li>
            <b>Later, the rack server.</b> A Foundation server with a public https address (its own domain) is what this is for: connect it there and messages arrive for everyone on it.
          </li>
          <li>
            <b>Now, a tunnel.</b> A tunnel (Cloudflare Tunnel, ngrok) gives this computer a public https address while it runs; set it as <code>FOUNDATION_PUBLIC_URL</code> and restart the server. Messages stop when this computer sleeps.
          </li>
        </ul>
      )}
      <p className="fx-quiet">You can fill in the other steps now either way; nothing arrives until the address works.</p>
    </div>
  );
}

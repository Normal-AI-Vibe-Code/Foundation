/**
 * ChatForm's Inbox tab (docs/chatform.md §3; B1): the bridges. Mail, WhatsApp, Instagram and WeChat, each
 * with its state dot and a sentence (from the server: `GET /api/chat/bridges`), and
 *  - when it isn't connected: which keys are set and which are missing (never their values) and the steps;
 *  - its portals: the conversations it brought in, newest first, each with its unread count and, where the
 *    service sets one, its reply window (open, closing, shut); pressing one opens it in the Chat tab;
 *  - for admins: who a new conversation goes to (the inbox), on or off, and (with FOUNDATION_BRIDGE_DEMO)
 *    a sample conversation through the real pipeline;
 *  - Mail: Connect mail (your own mailbox, by Google's consent), the label that bounds what comes in;
 *    starting a conversation where the service allows it (mail, WeCom), and saying why not where it doesn't.
 * Then the Slack history panel (I1's `History.tsx`, mounted when it's there).
 */

import { ErrorCard } from "../../components/ErrorCard";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import type { ChatBridgeStatus, ChatParty, UserInfo } from "@foundation/protocol";
import { api } from "../../lib/api";
import { goChat } from "../../lib/place";
import { useChat } from "../model";
import { PartyAvatar } from "../Avatar";
import { requestId } from "../logic";
import "./inbox.css";

interface ReplyWindow {
  open: boolean;
  rule: string;
  closesAt?: number;
  why?: string;
}
interface BridgeView extends ChatBridgeStatus {
  settings: { enabled: boolean; inbox: string[]; puppet: string | null; inboxIsAdmins: boolean };
  list: Array<{ id: string; name: string; topic: string; lastPostAt: number; lastText?: string; unread: number; demo: boolean; window?: ReplyWindow }>;
  canStart: boolean;
  startRule?: string;
  accounts?: Array<{ email: string; userId: string; label: string; labelFound: boolean; lastSyncAt: number | null; error: string | null }>;
}
interface Bridges {
  bridges: BridgeView[];
  demo: boolean;
  admin: boolean;
}

// I1's Slack history panel, when its file is there (a glob that finds nothing is an empty object)
const historyFile = import.meta.glob<{ default: ComponentType<{ user: UserInfo }> }>("./History.tsx");
const History = historyFile["./History.tsx"] ? lazy(historyFile["./History.tsx"]) : null;

const DOT: Record<ChatBridgeStatus["state"], string> = { off: "", "needs-setup": "is-warn", connecting: "is-warn is-live", live: "is-ok", error: "is-bad" };
const STATE: Record<ChatBridgeStatus["state"], string> = { off: "Off", "needs-setup": "Needs setup", connecting: "Connecting", live: "Live", error: "Needs attention" };

const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function windowWords(w: ReplyWindow): string {
  if (!w.open) return "Reply window shut";
  if (!w.closesAt) return "Reply window open";
  const h = Math.max(0, (w.closesAt - Date.now()) / 3600_000);
  return h < 1 ? `Window shuts in ${Math.max(1, Math.round(h * 60))} min` : `Window open · ${Math.floor(h)} h left`;
}

export default function InboxTab({ user, rest }: { user: UserInfo; rest: string }) {
  void rest;
  const [data, setData] = useState<Bridges | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<Bridges>("/api/chat/bridges").then((d) => (setData(d), setErr(null)), (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    void load();
    // the list follows what comes in (the chat socket carries the messages; this catches new portals and states)
    const t = setInterval(() => void load(), 20_000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => (clearInterval(t), window.removeEventListener("focus", focus));
  }, [load]);

  return (
    <div className="inbox" data-chat-tab="inbox">
      <div className="inbox-page">
        <p className="inbox-lede">
          Mail, WhatsApp, Instagram and WeChat as conversations here. What someone sends comes into a conversation of its own; what a person writes there goes out as they press Enter. An agent's reply waits as a draft until a person sends it.
        </p>
        {err && <ErrorCard message={err} />}
        {!data && !err && <div className="inbox-quiet">Asking the server…</div>}
        {data?.bridges.map((b) => <Bridge key={b.service} b={b} admin={data.admin} demo={data.demo} user={user} reload={load} />)}
        <section className="inbox-bridge" data-bridge="slack">
          <header className="inbox-head">
            <span className="f-dot is-ok" />
            <h2>Slack history</h2>
            <span className="inbox-state">Brought in</span>
          </header>
          {History ? (
            <Suspense fallback={<div className="inbox-quiet">Loading…</div>}>
              <History user={user} />
            </Suspense>
          ) : (
            <p className="inbox-detail">Slack's export comes in here once the history import is installed on this build.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Bridge({ b, admin, demo, user, reload }: { b: BridgeView; admin: boolean; demo: boolean; user: UserInfo; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ghost: ChatParty = { kind: "ghost", id: b.service, name: b.name, service: b.service };
  const setup = b.state === "needs-setup" || b.state === "error";

  return (
    <section className={`inbox-bridge is-${b.state}`} data-bridge={b.service}>
      <header className="inbox-head">
        <span className={`f-dot ${DOT[b.state]}`} />
        <h2>{b.name}</h2>
        <span className="inbox-state">{STATE[b.state]}</span>
        {b.portals > 0 && <span className="inbox-count">{b.portals === 1 ? "1 conversation" : `${b.portals} conversations`}</span>}
        {b.lastEventAt && <span className="inbox-count">last heard {ago(b.lastEventAt)}</span>}
      </header>
      <p className="inbox-detail">{b.detail}</p>
      {b.window && <p className="inbox-rule">{b.window}</p>}

      {b.service === "gmail" && <MailAccounts b={b} user={user} busy={busy} act={act} />}

      {setup && b.needs && b.needs.length > 0 && (
        <div className="inbox-needs" aria-label="What it reads">
          {b.needs.map((n) => {
            const optional = !n.set && /^Optional/i.test(n.what);
            return (
            <div key={n.key} className={`inbox-need ${n.set ? "is-set" : optional ? "is-optional" : ""}`}>
              <span className={`f-dot ${n.set ? "is-ok" : optional ? "" : "is-warn"}`} />
              <code>{n.key}</code>
              <span className="inbox-need-set">{n.set ? "set" : optional ? "optional" : "missing"}</span>
              <span className="inbox-need-what">{n.what}</span>
            </div>
            );
          })}
        </div>
      )}
      {setup && b.steps && b.steps.length > 0 && (
        <ol className="inbox-steps">
          {b.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}

      {b.list.length > 0 && (
        <div className="inbox-portals">
          {b.list.map((p) => (
            <button key={p.id} className="inbox-portal" onClick={() => goChat("chat", p.id)} title={p.topic}>
              <PartyAvatar party={{ ...ghost, id: p.id, name: p.name }} size={28} />
              <span className="inbox-portal-text">
                <span className="inbox-portal-name">
                  {p.name}
                  {p.demo && <span className="inbox-tag">Demo</span>}
                </span>
                <span className="inbox-portal-last">{p.lastText ?? p.topic}</span>
              </span>
              {p.window && (
                <span className={`inbox-window ${p.window.open ? "" : "is-shut"}`} title={p.window.why ?? p.window.rule}>
                  {windowWords(p.window)}
                </span>
              )}
              <span className="inbox-portal-when">{ago(p.lastPostAt)}</span>
              {p.unread > 0 && <span className="inbox-unread">{p.unread > 99 ? "99+" : p.unread}</span>}
            </button>
          ))}
        </div>
      )}
      {b.list.length === 0 && b.state === "live" && <p className="inbox-quiet">No conversations yet: the first message someone sends opens one here.</p>}

      <div className="inbox-acts">
        {b.state === "live" && b.canStart && (
          <button className="f-pill" disabled={busy} onClick={() => setStarting((s) => !s)}>
            {starting ? "Close" : b.service === "gmail" ? "New mail…" : "New message…"}
          </button>
        )}
        {b.state === "live" && !b.canStart && b.startRule && <span className="inbox-quiet">{b.startRule}</span>}
        {admin && demo && (
          <button className="f-pill" disabled={busy} onClick={() => void act(async () => { const r = await api<{ channel: { id: string } | null }>(`/api/chat/bridges/${b.service}/demo`, { method: "POST", json: {} }); if (r.channel) goChat("chat", r.channel.id); })}>
            Make a sample conversation
          </button>
        )}
      </div>
      {starting && <Start b={b} done={(id) => (setStarting(false), goChat("chat", id))} />}
      {admin && <Settings b={b} busy={busy} act={act} />}
      {note && <ErrorCard message={note} />}
    </section>
  );
}

function MailAccounts({ b, user, busy, act }: { b: BridgeView; user: UserInfo; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [label, setLabel] = useState("Foundation");
  const [confirm, setConfirm] = useState<string | null>(null);
  const mine = (b.accounts ?? []).some((a) => a.userId === user.id);
  const clientReady = !(b.needs ?? []).some((n) => (n.key === "GMAIL_CLIENT_ID" || n.key === "GMAIL_CLIENT_SECRET") && !n.set);
  return (
    <div className="inbox-mail">
      {(b.accounts ?? []).map((a) => (
        <div key={a.email} className="inbox-account">
          <span className={`f-dot ${a.error ? "is-bad" : a.labelFound ? "is-ok" : "is-warn"}`} />
          <span className="inbox-account-name">{a.email}</span>
          <span className="inbox-account-detail">
            {a.error ? a.error : `Threads labelled “${a.label}”${a.lastSyncAt ? ` · checked ${ago(a.lastSyncAt)}` : ""}`}
          </span>
          {(a.userId === user.id || user.role === "admin") &&
            (confirm === a.email ? (
              <span className="inbox-account-acts">
                <button className="f-pill chat-draft-bad" disabled={busy} onClick={() => void act(() => api("/api/chat/bridges/gmail/disconnect", { method: "POST", json: { email: a.email, confirm: true } }))}>
                  Disconnect
                </button>
                <button className="f-pill" onClick={() => setConfirm(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <span className="inbox-account-acts">
                <button className="f-pill" disabled={busy} onClick={() => void act(() => api("/api/chat/bridges/gmail/sync", { method: "POST", json: {} }))}>
                  Check now
                </button>
                <button className="f-pill" onClick={() => setConfirm(a.email)}>
                  Disconnect…
                </button>
              </span>
            ))}
        </div>
      ))}
      {clientReady && !mine && (
        <div className="inbox-connect">
          <label>
            <span>Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} aria-label="The Gmail label whose threads come in" />
          </label>
          <button
            className="f-pill is-accent"
            disabled={busy || !label.trim()}
            onClick={() =>
              void act(async () => {
                const r = await api<{ url: string }>("/api/chat/bridges/gmail/connect", { method: "POST", json: { label: label.trim() } });
                window.open(r.url, "_blank", "noopener");
              })
            }
          >
            Connect mail
          </button>
          <span className="inbox-quiet">Opens Google's page. Foundation asks to read your mail and send your replies; only threads under this label come in.</span>
        </div>
      )}
    </div>
  );
}

function Start({ b, done }: { b: BridgeView; done: (channelId: string) => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rid = useMemo(() => requestId(), []);
  const mail = b.service === "gmail";
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ channel: { id: string } }>("/api/chat/portals", { method: "POST", json: { service: b.service, to, subject, text, request_id: rid } });
      done(r.channel.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-start">
      <input placeholder={mail ? "To: name@example.com" : "To: their WeCom userid"} value={to} onChange={(e) => setTo(e.target.value)} />
      {mail && <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
      <textarea placeholder="Message" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="inbox-acts">
        <button className="f-pill is-accent" disabled={busy || !to.trim() || !text.trim() || (mail && !subject.trim())} onClick={() => void go()}>
          {busy ? "Sending…" : "Send"}
        </button>
        <span className="inbox-quiet">It goes out as you{mail ? ", from your own mailbox" : ""}.</span>
      </div>
      {err && <ErrorCard message={err} />}
    </div>
  );
}

function Settings({ b, busy, act }: { b: BridgeView; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { people } = useChat();
  const persons = people.filter((p) => p.kind === "person");
  const inbox = b.settings.inbox;
  const name = (id: string) => persons.find((p) => p.id === id)?.name ?? id;
  const save = (patch: Record<string, unknown>) => act(() => api(`/api/chat/bridges/${b.service}`, { method: "POST", json: patch }));
  return (
    <details className="inbox-settings">
      <summary>Who it goes to{b.settings.enabled ? "" : " · turned off"}</summary>
      <div className="inbox-setting">
        <span className="inbox-setting-name">New conversations go to</span>
        <span className="inbox-chips">
          {inbox.map((id) => (
            <span key={id} className="inbox-chip">
              {name(id)}
              <button aria-label={`Take ${name(id)} off`} disabled={busy} onClick={() => void save({ inbox: inbox.filter((x) => x !== id) })}>
                ✕
              </button>
            </span>
          ))}
          {b.settings.inboxIsAdmins && <span className="inbox-quiet">Nobody chosen: the admins</span>}
          <select value="" disabled={busy} onChange={(e) => e.target.value && void save({ inbox: [...inbox, e.target.value] })} aria-label="Add someone">
            <option value="">Add someone…</option>
            {persons
              .filter((p) => !inbox.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </span>
      </div>
      {b.service !== "gmail" && (
        <div className="inbox-setting">
          <span className="inbox-setting-name">Our own messages sent from the phone show as</span>
          <select value={b.settings.puppet ?? ""} disabled={busy} onChange={(e) => void save({ puppet: e.target.value || null })}>
            <option value="">The account itself</option>
            {persons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="inbox-setting">
        <span className="inbox-setting-name">{b.name}</span>
        <span className="inbox-seg" role="group">
          <button className={b.settings.enabled ? "is-current" : ""} disabled={busy} onClick={() => void save({ enabled: true })}>
            On
          </button>
          <button className={!b.settings.enabled ? "is-current" : ""} disabled={busy} onClick={() => void save({ enabled: false })}>
            Off
          </button>
        </span>
      </div>
    </details>
  );
}

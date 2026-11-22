/**
 * ChatForm's Inbox tab (docs/chatform.md §3; Josh: "The Inbox should give you information on what is
 * connected but also give you buttons that start the process of connecting your inbox to foundation or
 * foundation servers").
 *
 *  - **This Foundation** first: which server this window talks to (this computer or another), its version,
 *    and its public address; mail and messaging connections live on that server, so connecting here
 *    connects for everyone on it. *Change server…* opens the shell's server panel.
 *  - Then one card per service: a monogram in ink, the state in one line (*Connected as … since …*, *Not
 *    connected*, *Needs an admin*, the error and why), what's flowing (last in, last out), **the one
 *    forward button** that starts connecting from here, and the detail folded underneath (the keys, set or
 *    missing, never a value; the steps) for whoever does the setup.
 *     · Mail: *Connect your Gmail* (each person their own mailbox, by Google's consent in the browser; the
 *       card flips to Connected live); whose are connected (admins see every address, never a token);
 *       Disconnect, asked first. Without the server's Google client, the button explains in place and an
 *       admin gets *Set it up*.
 *     · Slack: linked channels, the history brought in, the transition guide (SlackGuide.tsx).
 *     · WhatsApp, Instagram, WeChat: company connections an admin makes, *Set it up* (SetupWizard.tsx).
 *  - It follows the server live: the chat socket's `{t:"bridge"}` events (bridges.ts `useBridges`), not a
 *    timer. `InboxView` draws it from data alone (the design page).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatBridgeStatus, ChatParty, UserInfo } from "@foundation/protocol";
import { api, authConfig, SERVER_NAME } from "../../lib/api";
import { goChat } from "../../lib/place";
import { useChat } from "../model";
import { PartyAvatar } from "../Avatar";
import { requestId } from "../logic";
import History from "./History";
import { SetupWizard, type WizardService } from "./SetupWizard";
import { LinkList, SlackGuide, useLinkActions } from "./SlackGuide";
import { ago, since, useBridges, type BridgeView, type Bridges, type ReplyWindow, type SlackView } from "./bridges";
import "./inbox.css";
import "./slackguide.css";

/** the shell's server panel opens on this event (another builder's ServerSwitch listens for it) */
export const OPEN_SERVER_PANEL = "foundation:open-server-panel";

const DOT: Record<ChatBridgeStatus["state"], string> = { off: "", "needs-setup": "is-warn", connecting: "is-warn is-live", live: "is-ok", error: "is-bad" };
const MONO: Record<string, string> = { gmail: "M", slack: "S", whatsapp: "Wa", instagram: "Ig", wechat: "Wc" };

function windowWords(w: ReplyWindow): string {
  if (!w.open) return "Reply window shut";
  if (!w.closesAt) return "Reply window open";
  const h = Math.max(0, (w.closesAt - Date.now()) / 3600_000);
  return h < 1 ? `Window shuts in ${Math.max(1, Math.round(h * 60))} min` : `Window open · ${Math.floor(h)} h left`;
}

export default function InboxTab({ user, rest }: { user: UserInfo; rest: string }) {
  const { data, err, load, waitFor } = useBridges();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void authConfig().then((c) => setVersion(c.version ?? null), () => setVersion(null));
  }, []);
  return (
    <div className="inbox" data-chat-tab="inbox">
      <div className="inbox-page">
        {err && <div className="inbox-err">{err}</div>}
        {!data && !err && <div className="inbox-quiet">Asking the server…</div>}
        {data && <InboxView data={data} user={user} version={version} reload={() => void load()} waitFor={waitFor} openGuide={rest === "slack-guide"} />}
      </div>
    </div>
  );
}

export function InboxView({ data, user, version, reload, waitFor, still = false, openGuide = false }: { data: Bridges; user: UserInfo; version: string | null; reload: () => void; waitFor?: (t: (b: Bridges) => boolean) => void; still?: boolean; openGuide?: boolean }) {
  const [wizard, setWizard] = useState<WizardService | null>(null);
  const [guide, setGuide] = useState(openGuide);
  const by = Object.fromEntries(data.bridges.map((b) => [b.service, b])) as Record<string, BridgeView>;
  return (
    <>
      <p className="inbox-lede">What's connected to this ChatForm, and the buttons that connect the rest. What someone sends from mail, WhatsApp, Instagram or WeChat comes into a conversation of its own; what a person writes there goes out as they press Enter. An agent's reply waits as a draft until a person sends it.</p>
      <ThisFoundation data={data} version={version} />
      {by.gmail && <MailCard b={by.gmail} user={user} admin={data.admin} still={still} reload={reload} waitFor={waitFor} setUp={() => setWizard("gmail")} />}
      <SlackCard view={data.slack} user={user} still={still} reload={reload} openGuide={() => setGuide(true)} />
      {(["whatsapp", "instagram", "wechat"] as const).map((s) => by[s] && <CompanyCard key={s} b={by[s]} admin={data.admin} demo={data.demo} still={still} reload={reload} setUp={() => setWizard(s)} />)}
      {wizard && <SetupWizard service={wizard} bridge={by[wizard] ?? null} server={data.server} admin={data.admin} onClose={() => (setWizard(null), reload())} onChanged={reload} />}
      {guide && <SlackGuide user={user} onClose={() => (setGuide(false), reload())} />}
    </>
  );
}

// ---------------------------------------------------------------- the server

function isLocal(origin: string) {
  try {
    const h = new URL(origin.includes("://") ? origin : `http://${origin}`).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function ThisFoundation({ data, version }: { data: Bridges; version: string | null }) {
  const here = isLocal(SERVER_NAME);
  return (
    <section className="inbox-bridge inbox-server" data-bridge="server">
      <header className="inbox-head">
        <span className="fx-mono" aria-hidden>
          F
        </span>
        <h2>This Foundation</h2>
        <span className="f-dot is-ok" />
        <span className="inbox-line">
          {SERVER_NAME}
          {here ? " · this computer" : ""}
          {version ? ` · version ${version}` : ""}
        </span>
        <span className="chat-head-gap" />
        <button className="f-pill" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SERVER_PANEL))} data-change-server>
          Change server…
        </button>
      </header>
      <p className="inbox-detail">
        Mail and messaging connections live on this server: connecting a service here connects it for everyone who uses {here ? "this computer's server" : SERVER_NAME}. Services reach it at <code>{data.server.publicUrl}</code>
        {data.server.reachable ? ", a public https address." : ": only from this computer or this network, so webhooks (WhatsApp, Instagram, WeChat) can't arrive yet. A rack server with its own address, or a tunnel, fixes that."}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- a card

function Card({ service, name, state, line, flow, children, acts, data }: { service: string; name: string; state: ChatBridgeStatus["state"]; line: ReactNode; flow?: string; children?: ReactNode; acts?: ReactNode; data?: string }) {
  return (
    <section className={`inbox-bridge is-${state}`} data-bridge={service} data-state={data ?? state}>
      <header className="inbox-head">
        <span className="fx-mono" aria-hidden>
          {MONO[service] ?? name[0]}
        </span>
        <h2>{name}</h2>
        <span className={`f-dot ${DOT[state]}`} />
        <span className="inbox-line" data-state-line>
          {line}
        </span>
        <span className="chat-head-gap" />
        <span className="inbox-forward">{acts}</span>
      </header>
      {flow && <p className="inbox-rule">{flow}</p>}
      {children}
    </section>
  );
}

function Keys({ b }: { b: BridgeView }) {
  const keys = b.keys ?? b.needs?.map((n) => ({ key: n.key, what: n.what, set: n.set, source: null as null, tail: undefined as string | undefined }));
  if (!keys?.length) return null;
  return (
    <div className="inbox-needs" aria-label="What it reads">
      {keys.map((n) => {
        const optional = !n.set && /^Optional/i.test(n.what);
        return (
          <div key={n.key} className={`inbox-need ${n.set ? "is-set" : optional ? "is-optional" : ""}`}>
            <span className={`f-dot ${n.set ? "is-ok" : optional ? "" : "is-warn"}`} />
            <code>{n.key}</code>
            <span className="inbox-need-set">{n.set ? `set${n.source === "stored" ? " here" : n.source === "env" ? " in .env" : ""}${n.tail ? ` · …${n.tail}` : ""}` : optional ? "optional" : "missing"}</span>
            <span className="inbox-need-what">{n.what}</span>
          </div>
        );
      })}
    </div>
  );
}

function Portals({ b }: { b: BridgeView }) {
  if (!b.list.length) return null;
  const ghost: ChatParty = { kind: "ghost", id: b.service, name: b.name, service: b.service };
  return (
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
  );
}

const flowOf = (b: BridgeView) => [b.portals ? `${b.portals === 1 ? "1 conversation" : `${b.portals} conversations`}` : "", b.lastEventAt ? `last heard ${ago(b.lastEventAt)}` : ""].filter(Boolean).join(" · ") || undefined;

// ---------------------------------------------------------------- mail

function MailCard({ b, user, admin, still, reload, waitFor, setUp }: { b: BridgeView; user: UserInfo; admin: boolean; still: boolean; reload: () => void; waitFor?: (t: (x: Bridges) => boolean) => void; setUp: () => void }) {
  const { people } = useChat();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [explain, setExplain] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [label, setLabel] = useState("Foundation");
  const accounts = b.accounts ?? [];
  const mine = accounts.find((a) => a.userId === user.id);
  const clientReady = !(b.needs ?? []).some((n) => (n.key === "GMAIL_CLIENT_ID" || n.key === "GMAIL_CLIENT_SECRET") && !n.set);
  const nameOf = (id: string) => (id === user.id ? "you" : (people.find((p) => p.id === id)?.name ?? "someone"));
  useEffect(() => {
    if (mine) setWaiting(false);
  }, [mine]);
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
  const connect = () =>
    act(async () => {
      const r = await api<{ url: string }>("/api/chat/bridges/gmail/connect", { method: "POST", json: { label: label.trim() || "Foundation" } });
      window.open(r.url, "_blank", "noopener");
      setWaiting(true);
      waitFor?.((x) => Boolean(x.bridges.find((y) => y.service === "gmail")?.accounts?.some((a) => a.userId === user.id)));
    });
  const state: ChatBridgeStatus["state"] = mine ? (mine.error ? "error" : "live") : !clientReady ? "needs-setup" : b.state === "error" ? "error" : "needs-setup";
  const line = mine
    ? mine.error
      ? `${mine.email}: ${mine.error}`
      : `Connected as ${mine.email} since ${since(mine.connectedAt ?? mine.lastSyncAt ?? Date.now())}${b.portals ? ` · ${b.portals === 1 ? "1 conversation" : `${b.portals} conversations`}` : ""}`
    : waiting
      ? "Waiting for you to approve it on Google's page…"
      : !clientReady
        ? "Needs an admin: the server has no Google sign-in client for mail yet"
        : "Not connected for you";
  return (
    <Card
      service="gmail"
      name="Mail"
      state={state}
      data={mine ? "connected" : waiting ? "waiting" : clientReady ? "not-connected" : "needs-admin"}
      line={line}
      flow={accounts.length ? `${accounts.length === 1 ? "1 mailbox" : `${accounts.length} mailboxes`} connected${b.lastEventAt ? ` · last heard ${ago(b.lastEventAt)}` : ""}` : undefined}
      acts={
        mine ? null : (
          <button className="f-pill is-accent" disabled={busy || still || waiting} onClick={() => (clientReady ? void connect() : setExplain(true))} data-connect-gmail>
            {waiting ? "Waiting…" : "Connect your Gmail"}
          </button>
        )
      }
    >
      {!mine && clientReady && (
        <p className="inbox-detail">
          Opens Google's page in your browser. Foundation asks to read your mail and send your replies; only threads under the label{" "}
          <input className="inbox-inline-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} aria-label="The Gmail label whose threads come in" /> come in, never the whole inbox.
        </p>
      )}
      {!mine && !clientReady && explain && (
        <div className="inbox-explain" data-needs-admin>
          <p className="inbox-detail">Before anyone can connect a mailbox, an admin adds Foundation's Google OAuth client to this server (once, for everyone). {admin ? "It takes about five minutes in Google Cloud Console." : "Ask an admin to open Inbox → Mail → Set it up."}</p>
          {admin && (
            <button className="f-pill is-accent" onClick={setUp} data-setup="gmail">
              Set it up
            </button>
          )}
        </div>
      )}
      {accounts.length > 0 && (
        <div className="inbox-mail">
          {accounts.map((a) => (
            <div key={a.email} className="inbox-account">
              <span className={`f-dot ${a.error ? "is-bad" : a.labelFound ? "is-ok" : "is-warn"}`} />
              <span className="inbox-account-name">{a.email}</span>
              <span className="inbox-account-detail">
                {nameOf(a.userId)} · {a.error ? a.error : `threads labelled “${a.label}”${a.lastSyncAt ? ` · checked ${ago(a.lastSyncAt)}` : ""}`}
              </span>
              {(a.userId === user.id || admin) && !still && (
                <span className="inbox-account-acts">
                  {confirm === a.email ? (
                    <>
                      <button className="f-pill chat-draft-bad" disabled={busy} onClick={() => void act(() => api("/api/chat/bridges/gmail/disconnect", { method: "POST", json: { email: a.email, confirm: true } })).then(() => setConfirm(null))}>
                        Disconnect
                      </button>
                      <button className="f-pill" onClick={() => setConfirm(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="f-pill" disabled={busy} onClick={() => void act(() => api("/api/chat/bridges/gmail/sync", { method: "POST", json: {} }))}>
                        Check now
                      </button>
                      <button className="f-pill" onClick={() => setConfirm(a.email)}>
                        Disconnect…
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <Portals b={b} />
      <Details b={b} admin={admin} setUp={setUp} />
      {note && <p className="inbox-err">{note}</p>}
    </Card>
  );
}

function Details({ b, admin, setUp, children }: { b: BridgeView; admin: boolean; setUp: () => void; children?: ReactNode }) {
  return (
    <details className="inbox-settings">
      <summary>Setup details{b.needs?.some((n) => !n.set && !/^Optional/i.test(n.what)) ? " · something missing" : ""}</summary>
      <Keys b={b} />
      {b.steps && b.steps.length > 0 && (
        <ol className="inbox-steps">
          {b.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {b.window && <p className="inbox-rule">{b.window}</p>}
      {admin && (
        <div className="inbox-acts">
          <button className="f-pill" onClick={setUp}>
            Open the setup steps
          </button>
        </div>
      )}
      {children}
    </details>
  );
}

// ---------------------------------------------------------------- WhatsApp, Instagram, WeChat

function CompanyCard({ b, admin, demo, still, reload, setUp }: { b: BridgeView; admin: boolean; demo: boolean; still: boolean; reload: () => void; setUp: () => void }) {
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
  const live = b.state === "live";
  const line = live ? `Connected · ${b.detail}` : b.state === "off" ? b.detail : b.state === "error" ? b.detail : admin ? "Not connected" : "Not connected · an admin sets it up";
  return (
    <Card
      service={b.service}
      name={b.name}
      state={b.state}
      line={line}
      flow={flowOf(b)}
      acts={
        <>
          {live && b.canStart && (
            <button className="f-pill" disabled={busy || still} onClick={() => setStarting((s) => !s)}>
              {starting ? "Close" : "New message…"}
            </button>
          )}
          {!live && (
            <button className={`f-pill ${admin ? "is-accent" : ""}`} disabled={still} onClick={setUp} data-setup={b.service}>
              {admin ? "Set it up" : "See the steps"}
            </button>
          )}
        </>
      }
    >
      {live && !b.canStart && b.startRule && <p className="inbox-rule">{b.startRule}</p>}
      <Portals b={b} />
      {b.list.length === 0 && live && <p className="inbox-quiet">No conversations yet: the first message someone sends opens one here.</p>}
      {starting && <Start b={b} done={(id) => (setStarting(false), goChat("chat", id))} />}
      <Details b={b} admin={admin} setUp={setUp}>
        {admin && <Settings b={b} busy={busy} act={act} />}
        {admin && demo && (
          <div className="inbox-acts">
            <button className="f-pill" disabled={busy} onClick={() => void act(async () => { const r = await api<{ channel: { id: string } | null }>(`/api/chat/bridges/${b.service}/demo`, { method: "POST", json: {} }); if (r.channel) goChat("chat", r.channel.id); })}>
              Make a sample conversation
            </button>
          </div>
        )}
      </Details>
      {note && <p className="inbox-err">{note}</p>}
    </Card>
  );
}

function Start({ b, done }: { b: BridgeView; done: (channelId: string) => void }) {
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rid = useMemo(() => requestId(), []);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ channel: { id: string } }>("/api/chat/portals", { method: "POST", json: { service: b.service, to, text, request_id: rid } });
      done(r.channel.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-start">
      <input placeholder="To: their WeCom userid" value={to} onChange={(e) => setTo(e.target.value)} />
      <textarea placeholder="Message" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="inbox-acts">
        <button className="f-pill is-accent" disabled={busy || !to.trim() || !text.trim()} onClick={() => void go()}>
          {busy ? "Sending…" : "Send"}
        </button>
        <span className="inbox-quiet">It goes out as you.</span>
      </div>
      {err && <p className="inbox-err">{err}</p>}
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
    <div className="inbox-settings-body">
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
    </div>
  );
}

// ---------------------------------------------------------------- Slack

function SlackCard({ view, user, still, reload, openGuide }: { view: SlackView; user: UserInfo; still: boolean; reload: () => void; openGuide: () => void }) {
  const [v, setV] = useState(view);
  useEffect(() => setV(view), [view]);
  const la = useLinkActions(setV, reload);
  const s = v.status;
  const live = v.links.filter((l) => l.state === "live").length;
  const line = !v.token.set
    ? `Not connected${v.history.channels ? ` · ${v.history.channels} conversations brought in` : ""}`
    : s.state === "error"
      ? s.detail
      : v.links.length
        ? `${live} of ${v.links.length} ${v.links.length === 1 ? "channel" : "channels"} in step${v.app?.team ? ` with ${v.app.team}` : ""} · ${v.mode === "events" ? "events from the Slack app" : `read every ${v.pollSeconds} s`}`
        : `Connected${v.app?.team ? ` to ${v.app.team}` : ""} · no channel linked yet`;
  const lastIn = Math.max(0, ...v.links.map((l) => l.lastInAt ?? 0));
  const lastOut = Math.max(0, ...v.links.map((l) => l.lastOutAt ?? 0));
  const flow = [lastIn ? `last in ${ago(lastIn)}` : "", lastOut ? `last out ${ago(lastOut)}` : "", v.history.lastImportAt ? `history brought in ${since(v.history.lastImportAt)}` : ""].filter(Boolean).join(" · ") || undefined;
  return (
    <Card
      service="slack"
      name="Slack"
      state={s.state}
      line={line}
      flow={flow}
      acts={
        <button className="f-pill is-accent" disabled={still} onClick={openGuide} data-open-guide>
          {!v.token.set && !v.history.channels ? "Start the Slack guide" : v.links.length ? "Open the Slack guide" : "Link channels"}
        </button>
      }
    >
      {v.links.length > 0 && <LinkList view={v} admin={v.admin && !still} busy={la.busy} asking={la.asking} setAsking={la.setAsking} act={la.act} setView={setV} reload={reload} />}
      {la.err && <p className="inbox-err">{la.err}</p>}
      <p className="inbox-rule">Direct messages are never bridged: Slack doesn't let an app post into them for people. Bring them in with the history instead.</p>
      {v.nudgeDismissed && !still && (
        <button className="inbox-link" onClick={() => void api("/api/chat/slack/nudge", { method: "POST", json: { dismissed: false } }).then(reload)}>
          Show “Coming from Slack?” in Chat again
        </button>
      )}
      <details className="inbox-settings">
        <summary>Slack history: bring it in, download everything</summary>
        {!still && <History user={user} />}
      </details>
    </Card>
  );
}


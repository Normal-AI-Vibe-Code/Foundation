/**
 * Which server this is, said plainly, and the office network (DESIGN §5 "Server switch"; docs/server.md):
 *  - `ServerAboutView`: this computer, another on your network, or a hosted Foundation; its address, version,
 *    what it serves (grids, files and ChatForm: conversations are kept on it), since when it's up, who's here,
 *    and (to an admin) where its data is.
 *  - `NetworkSectionView`: **On your network**: the switch (an admin at the server's computer), the addresses
 *    teammates type, with copy buttons, the page (built, or **Build the page**), **Invite someone**, who is
 *    signed in from other computers (**Sign out** per row), and the honest notes (plain http, the firewall,
 *    huddles' camera and microphone, the rack for later).
 *  - `ServerNote`: ChatForm strip's dim line, "on this computer · localhost:4410"; pressed, the server panel opens.
 * Presentational views take everything as props (shown on `#/design`); ServerSwitch.tsx owns the calls.
 */
import { SERVER } from "../lib/api";
import { setUi } from "../state/ui";
import { shortAddress } from "./model";
import { OPEN_SERVER_PANEL, WHERE_LABEL, WHERE_NOTE, peopleNow, servesLine, serverOlder, upSince, useServerInfo, whereIs, type Invite, type NetworkSession, type ServerInfo, type Where } from "./info";
import { CLIENT_DESCRIBE } from "../lib/version";
import "./server.css";

export function ServerAboutView({ info, current, now, app = CLIENT_DESCRIBE, onRestart }: { info: ServerInfo; current: string; now?: number; app?: string | null; onRestart?: () => void }) {
  const where = whereIs(current, info);
  // a server started from a checkout runs the code it started with while the app updates itself
  const older = serverOlder(info.build, app);
  return (
    <div className="server-about" data-where={where}>
      <div className="server-switch-option-head">
        <strong>{WHERE_LABEL[where]}</strong>
        <span className="server-about-version">v{info.version}</span>
      </div>
      <p className="server-switch-lede">
        {servesLine(info.serves)} Conversations are kept on this server.
      </p>
      <dl className="server-facts">
        <dt>Address</dt>
        <dd>
          <code>{shortAddress(info.address ?? current)}</code>
        </dd>
        {info.data && (
          <>
            <dt>Data</dt>
            <dd>
              <code>{info.data}</code>
            </dd>
          </>
        )}
        {info.startedAt && (
          <>
            <dt>Up</dt>
            <dd>{upSince(info.startedAt, now)}</dd>
          </>
        )}
        {info.build && (
          <>
            <dt>Code</dt>
            <dd>
              <code>{info.build}</code>
            </dd>
          </>
        )}
        {info.people !== undefined && (
          <>
            <dt>Here now</dt>
            <dd>{peopleNow(info.people)} connected</dd>
          </>
        )}
      </dl>
      {older && (
        <p className="server-about-older" role="status" data-older>
          <span>{older.words}</span>
          {onRestart ? (
            <button type="button" className="f-pill is-accent" onClick={onRestart}>
              Restart it
            </button>
          ) : (
            <span> Stop and start it where it runs.</span>
          )}
        </p>
      )}
    </div>
  );
}

export interface NetworkSectionProps {
  info: ServerInfo;
  invite: Invite | null;
  sessions: NetworkSession[];
  /** what's in flight: "switch", "invite", "build", or a session id signing out */
  busy?: string | null;
  error?: string | null;
  draft: { name: string; email: string };
  /** the text last copied, to say so on its button */
  copied?: string | null;
  now?: number;
  onToggle?: (on: boolean) => void;
  onDraft?: (d: { name: string; email: string }) => void;
  onInvite?: () => void;
  onDoneInvite?: () => void;
  onSignOut?: (id: string) => void;
  onBuild?: () => void;
  onCopy?: (text: string) => void;
}

const since = (t: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};

function CopyRow({ text, label, copied, onCopy }: { text: string; label?: string; copied?: string | null; onCopy?: (t: string) => void }) {
  return (
    <li className="server-net-addr">
      <code title={text}>{text}</code>
      {label && <span className="server-net-label">{label}</span>}
      <button type="button" className="f-pill server-net-copy" onClick={() => onCopy?.(text)}>
        {copied === text ? "Copied" : "Copy"}
      </button>
    </li>
  );
}

export function NetworkSectionView(p: NetworkSectionProps) {
  const n = p.info.network;
  if (!n) return null;
  const manage = Boolean(p.info.canManage);
  const fixed = n.setBy === "environment";
  const answering = n.listening.filter((l) => l.ok && l.answers);
  const failed = n.listening.filter((l) => !l.ok);
  const build = n.page.build;
  return (
    <section className="server-switch-option server-net" data-on={n.on || undefined} aria-label="On your network">
      <div className="server-switch-option-head">
        <strong>On your network</strong>
        <button
          type="button"
          role="switch"
          aria-checked={n.on}
          aria-label="Serve teammates on this network"
          className="egress-switch"
          disabled={!manage || fixed || p.busy === "switch"}
          data-tip={manage ? undefined : "An admin, at the computer this server runs on, turns this on"}
          onClick={() => p.onToggle?.(!n.on)}
        >
          <span className="egress-knob" />
        </button>
      </div>

      {!n.on && !n.wide && (
        <>
          <p className="server-switch-lede">Teammates on this network open Foundation in a browser at this computer’s address, with nothing to install. Off, only this computer reaches it.</p>
          {!manage && <p className="server-switch-hint">An admin, at the computer this server runs on, turns this on.</p>}
        </>
      )}
      {fixed && <p className="server-switch-hint">Set by this server’s environment (FOUNDATION_HOST, FOUNDATION_NETWORK), not by the switch.</p>}

      {n.on && (
        <>
          {n.urls.length > 0 ? (
            <>
              <p className="server-switch-lede">Teammates open one of these in any browser:</p>
              <ul className="server-net-list">
                {n.urls.map((u) => (
                  <CopyRow key={u.url} text={u.url} label={u.label} copied={p.copied} onCopy={p.onCopy} />
                ))}
              </ul>
            </>
          ) : (
            <p className="server-switch-error">This computer has no private network address to listen on.</p>
          )}
          {failed.map((l) => (
            <p key={l.address} className="server-switch-error">
              {l.address}: {l.error}
            </p>
          ))}
          {answering.length > 0 && (
            <p className="server-switch-hint">
              It answers at {answering.map((l) => l.address).join(", ")} from this computer: it’s listening. Windows may ask to allow Node.js on private networks the first time; press Allow there, or teammates can’t reach it.
            </p>
          )}

          <div className="server-net-row">
            <span className="server-switch-state">
              <i className="server-switch-dot" data-tone={n.page.built ? "ok" : build?.state === "building" ? "warn" : "bad"} />
              {n.page.built ? "The page is built: a browser is all teammates need" : build?.state === "building" ? "Building the page…" : "The page isn’t built here yet"}
            </span>
            {!n.page.built && manage && n.page.canBuild && build?.state !== "building" && (
              <button type="button" className="f-pill" onClick={p.onBuild} disabled={p.busy === "build"} data-tip="Runs this checkout's own build (vite) on this computer">
                Build the page
              </button>
            )}
          </div>
          {!n.page.built && !n.page.canBuild && (
            <p className="server-switch-hint">
              In a Foundation checkout, <code>npm run build</code> makes it. Or teammates point the Foundation app’s Server line at an address above.
            </p>
          )}
          {build?.state === "failed" && build.error && <p className="server-switch-error">{build.error}</p>}

          {manage && (
            <div className="server-net-block">
              <span className="f-eyebrow">Invite someone</span>
              {p.invite ? (
                <div className="server-net-invite">
                  <p className="server-switch-lede">
                    For <b>{p.invite.name}</b> · {p.invite.email}. Once, within 15 minutes, from another computer on this network.
                  </p>
                  <div className="server-net-code" aria-label="Their code">
                    {p.invite.code}
                  </div>
                  <p className="server-switch-hint">They open the link, or type their email and this code on the sign-in page.</p>
                  <ul className="server-net-list">
                    {p.invite.links.slice(0, 2).map((l) => (
                      <CopyRow key={l.url} text={l.url} copied={p.copied} onCopy={p.onCopy} />
                    ))}
                  </ul>
                  <div className="server-switch-actions">
                    <button type="button" className="f-pill" onClick={p.onDoneInvite}>
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  className="server-net-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    p.onInvite?.();
                  }}
                >
                  <input className="f-input server-switch-field" placeholder="Their name" value={p.draft.name} aria-label="Their name" onChange={(e) => p.onDraft?.({ ...p.draft, name: e.target.value })} />
                  <div className="server-switch-row">
                    <input className="f-input server-switch-field" placeholder="Their work email" type="email" value={p.draft.email} aria-label="Their work email" onChange={(e) => p.onDraft?.({ ...p.draft, email: e.target.value })} />
                    <button type="submit" className="f-pill is-accent" disabled={!p.draft.email.trim() || p.busy === "invite"}>
                      Invite
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {manage && (
            <div className="server-net-block">
              <span className="f-eyebrow">Signed in from other computers</span>
              {p.sessions.length === 0 ? (
                <p className="server-switch-hint">No one yet.</p>
              ) : (
                <ul className="server-net-people">
                  {p.sessions.map((s) => (
                    <li key={s.id}>
                      <span className="server-net-who">
                        <i className="server-switch-dot" data-tone={s.live > 0 ? "ok" : undefined} />
                        <b>{s.name}</b>
                        <span>
                          {s.ua} · {s.addr} · {since(s.created_at, p.now)}
                        </span>
                      </span>
                      <button type="button" className="f-pill" onClick={() => p.onSignOut?.(s.id)} disabled={p.busy === s.id}>
                        Sign out
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {p.error && <p className="server-switch-error" role="alert">{p.error}</p>}

          <ul className="server-net-notes">
            <li>Plain http: anyone on this network who can watch traffic could read it. Fine for trying it in the office; the rack server should have HTTPS.</li>
            <li>Huddles: a browser at an http:// address can’t use the camera or microphone. Teammates with the Foundation app, its Server line set to an address above, can.</li>
          </ul>
        </>
      )}
      <p className="server-switch-hint server-net-later">Later: a Foundation server on your rack. Install it, set its address, and point everyone’s app at it (docs/server.md).</p>
    </section>
  );
}

let wanted = false;
/** open the server panel from elsewhere: the side menu opens (the switch lives in its foot) and the switch opens */
export function openServerPanel() {
  wanted = true;
  setUi({ pane: true });
  requestAnimationFrame(() => window.dispatchEvent(new Event(OPEN_SERVER_PANEL)));
}
/** the switch, as it mounts, asks whether someone wanted it open */
export function takeServerPanelWish(): boolean {
  const w = wanted;
  wanted = false;
  return w;
}

export function ServerNoteView({ where, address, onPress }: { where: Where; address: string; onPress?: () => void }) {
  return (
    <button type="button" className="server-note" onClick={onPress} data-tip="The server ChatForm is on: open the server panel" data-server-note>
      {WHERE_NOTE[where]} · {shortAddress(address)}
    </button>
  );
}

/** ChatForm strip's right end: which server ChatForm is on, dim; pressed, the server panel */
export function ServerNote() {
  const current = (SERVER || window.location.origin).replace(/\/$/, "");
  const { info } = useServerInfo(true, 60_000);
  return <ServerNoteView where={whereIs(current, info)} address={current} onPress={openServerPanel} />;
}

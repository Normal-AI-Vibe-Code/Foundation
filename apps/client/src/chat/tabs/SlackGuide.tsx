/**
 * Coming from Slack (Josh: "a small pop-up that leads to a step by step guide with links and actions that
 * can import the slack channels, or build a bridge between them so that slack messages show up here and
 * vice versa to help the transition to foundation").
 *
 *  - `SlackNudge`: a quiet card in ChatForm's corner while Slack is neither linked nor brought in: *Coming
 *    from Slack?* with **Start** and **Not now** (remembered per person on the server; Inbox → Slack brings
 *    it back).
 *  - `SlackGuide`: the stepper sheet. The first screen picks a path:
 *     · **Move in**: Slack's export page (for the workspace named), what each plan's export holds, the zip
 *       dropped here (History's own upload → rehearsal → Bring it in → report), who's who (matched by email,
 *       Slack people kept as themselves until they sign in), then the first channel opens.
 *     · **Keep both in step**: the Slack app (token set? its scopes against what the bridge needs, ✓/✗; the
 *       manifest to paste, with Copy; api.slack.com/apps), the bot token pasted and checked, the channels
 *       table (Slack ↔ here, Link per row or all, Join, the history backfill), and a live test message.
 *    Both end on what is now linked or brought in, and how to undo it.
 * The actions are an admin's (the server checks); anyone else reads the steps and can copy a note to an admin.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { UserInfo } from "@foundation/protocol";
import { api } from "../../lib/api";
import { goChat } from "../../lib/place";
import { requestId } from "../logic";
import { ExportDrop, FilesCheck, JobView, ReportView, useSlackImport } from "./History";
import { ago, copyText, openOutside, type SlackLink, type SlackView } from "./bridges";
import "./slackguide.css";

export interface SlackChannelRow {
  id: string;
  name: string;
  private: boolean;
  member: boolean;
  members: number | null;
  topic: string;
  link: SlackLink | null;
  lands: { id: string | null; name: string; how: "imported" | "merge" | "create" };
}

type Path = "choose" | "import" | "bridge";
const IMPORT_STEPS = ["Export from Slack", "Bring the zip", "Who's who", "Done"];
const BRIDGE_STEPS = ["The Slack app", "The bot token", "Pick channels", "Try it", "Done"];

// ---------------------------------------------------------------- the nudge

export function SlackNudge({ user, tab }: { user: UserInfo; tab?: string }) {
  const [view, setView] = useState<SlackView | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api<SlackView>("/api/chat/slack").then(setView, () => setView(null)), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (tab && tab !== "chat") return null;
  return (
    <>
      {view?.nudge && !open && <NudgeCard onStart={() => setOpen(true)} onLater={() => void api<{ view: SlackView }>("/api/chat/slack/nudge", { method: "POST", json: { dismissed: true } }).then((r) => setView(r.view))} />}
      {open && <SlackGuide user={user} onClose={() => (setOpen(false), void load())} />}
    </>
  );
}

export function NudgeCard({ onStart, onLater, still = false }: { onStart: () => void; onLater: () => void; still?: boolean }) {
  return (
    <aside className={`fx-nudge ${still ? "is-still" : ""}`} aria-label="Coming from Slack?" data-slack-nudge>
      <span className="fx-mono" aria-hidden>
        S
      </span>
      <div className="fx-nudge-text">
        <b>Coming from Slack?</b>
        <span>Bring your channels across, or keep both in step while you move.</span>
      </div>
      <div className="fx-nudge-acts">
        <button type="button" className="f-pill is-accent" onClick={onStart} data-nudge-start>
          Start
        </button>
        <button type="button" className="f-pill" onClick={onLater} data-nudge-later>
          Not now
        </button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- the guide

export function SlackGuide({ user, onClose, start = "choose", inline = false, demo }: { user: UserInfo; onClose: () => void; start?: Path; inline?: boolean; demo?: { view: SlackView; channels: SlackChannelRow[]; step?: number } }) {
  const [path, setPath] = useState<Path>(start);
  const [at, setAt] = useState(demo?.step ?? 0);
  const [view, setView] = useState<SlackView | null>(demo?.view ?? null);
  const load = useCallback(() => (demo ? Promise.resolve() : api<SlackView>("/api/chat/slack").then(setView, () => undefined)), [demo]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (inline) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [inline, onClose]);
  const admin = user.role === "admin";
  const steps = path === "import" ? IMPORT_STEPS : path === "bridge" ? BRIDGE_STEPS : [];
  const go = (p: Path) => (setPath(p), setAt(0));

  const sheet = (
    <div className={`fx-sheet is-wide ${inline ? "is-inline" : ""}`} role="dialog" aria-modal={!inline} aria-label="From Slack to Foundation" data-slack-guide={path}>
      <header className="fx-head">
        <span className="fx-mono" aria-hidden>
          S
        </span>
        <h2>{path === "import" ? "Move in from Slack" : path === "bridge" ? "Keep Slack and ChatForm in step" : "From Slack to Foundation"}</h2>
        {steps.length > 0 && (
          <span className="fx-dots" aria-label={`Step ${at + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <span key={s} className={`fx-dot ${i === at ? "is-on" : i < at ? "is-done" : ""}`} title={s} />
            ))}
          </span>
        )}
        {!inline && (
          <button type="button" className="fx-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </header>
      <div className="fx-body">
        {steps.length > 0 && (
          <p className="fx-eyebrow">
            Step {at + 1} of {steps.length} · {steps[at]}
          </p>
        )}
        {path === "choose" && <Choose go={go} admin={admin} view={view} />}
        {path === "import" && <ImportPath at={at} admin={admin} />}
        {path === "bridge" && view && <BridgePath at={at} admin={admin} view={view} setView={setView} reload={load} demoChannels={demo?.channels} />}
        {!admin && path !== "choose" && <AskAdmin what={path === "import" ? "bring our Slack history into ChatForm" : "link our Slack channels to ChatForm"} />}
      </div>
      {path !== "choose" && (
        <footer className="fx-foot">
          <button type="button" className="f-pill" onClick={() => (at === 0 ? go("choose") : setAt((x) => x - 1))}>
            Back
          </button>
          <span className="fx-gap" />
          {at < steps.length - 1 ? (
            <button type="button" className="f-pill is-accent" onClick={() => setAt((x) => x + 1)} data-guide-next>
              Next
            </button>
          ) : (
            <button type="button" className="f-pill is-accent" onClick={onClose}>
              Close
            </button>
          )}
        </footer>
      )}
    </div>
  );
  if (inline) return sheet;
  return (
    <div className="fx-veil" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      {sheet}
    </div>
  );
}

function Choose({ go, admin, view }: { go: (p: Path) => void; admin: boolean; view: SlackView | null }) {
  return (
    <>
      <p className="fx-text">Two ways across. Many teams do both: bring the history in once, then keep the channels people still use in step until everyone has moved.</p>
      <div className="fx-paths">
        <button type="button" className="fx-path" onClick={() => go("import")} data-guide-path="import">
          <b>Move in</b>
          <span>Bring Slack's history here once: channels, threads, reactions, files, with who wrote what. Slack's export zip, dropped here.</span>
          {view && view.history.channels > 0 && <span className="fx-quiet">{view.history.channels} conversations came from Slack already.</span>}
        </button>
        <button type="button" className="fx-path" onClick={() => go("bridge")} data-guide-path="bridge">
          <b>Keep both in step</b>
          <span>Link channels: what's said in Slack appears here within seconds, and what's said here appears in Slack as “Name via Foundation”.</span>
          {view && view.links.length > 0 && <span className="fx-quiet">{view.links.length === 1 ? "1 channel is" : `${view.links.length} channels are`} linked.</span>}
        </button>
      </div>
      {!admin && <p className="fx-quiet">Both are an admin's to do. You can read the steps and copy a note asking one.</p>}
    </>
  );
}

function AskAdmin({ what }: { what: string }) {
  const [done, setDone] = useState(false);
  const note = `Could you ${what}? In Foundation open ChatForm → Inbox → Slack → Open the Slack guide: it walks through each step.`;
  return (
    <div className="fx-ask">
      <p className="fx-quiet">These steps are an admin's: they act for everyone on this server.</p>
      <button type="button" className="f-pill" onClick={() => void copyText(note).then(setDone)}>
        {done ? "Copied" : "Copy a note for an admin"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- move in

function ImportPath({ at, admin }: { at: number; admin: boolean }) {
  const [workspace, setWorkspace] = useState("");
  const imp = useSlackImport();
  const [linked, setLinked] = useState<number | null>(null);
  const ws = workspace.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.slack\.com.*$/, "").replace(/[^a-z0-9-]/g, "");
  const r = imp.report;
  if (at === 0)
    return (
      <>
        <p className="fx-text">A Slack owner or admin asks Slack for the export. Slack emails a link when it's ready (minutes for a small workspace, hours for a big one).</p>
        <label className="fx-field">
          <span className="fx-label">Your workspace's name (the part before .slack.com)</span>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="formindustries" data-workspace />
        </label>
        <div className="fx-links">
          <button type="button" className="f-pill is-accent" onClick={() => openOutside(ws ? `https://${ws}.slack.com/services/export` : "https://my.slack.com/services/export")} data-open-export>
            Open Slack's export page ↗
          </button>
        </div>
        <ul className="fx-ways">
          <li>
            <b>Free and Pro</b>: public channels only. Private channels and direct messages come later through the bridge's token (Keep both in step), as far as the app can see them.
          </li>
          <li>
            <b>Business+</b>: public channels, and everything once Slack approves an owner's request for a full export.
          </li>
          <li>
            <b>Enterprise Grid</b>: the org's owners export from the org's admin dashboard.
          </li>
        </ul>
        <p className="fx-quiet">Pick “Entire history”. Download the zip when Slack's email comes, then press Next.</p>
      </>
    );
  if (at === 1)
    return (
      <>
        <p className="fx-text">Drop the zip. A rehearsal reads it first and says what would come in; nothing is written until you press Bring it in. Bringing the same export in twice adds nothing.</p>
        {imp.err && <p className="inbox-err" role="alert">{imp.err}</p>}
        {imp.ov && <ExportDrop imp={imp} />}
        {imp.ov && !imp.can && <p className="hist-why">{imp.ov.why ?? "Only an admin brings in Slack history."}</p>}
        <FilesCheck imp={imp} />
        {imp.job && <JobView job={imp.job} />}
        {r && <ReportView report={r} jobId={imp.job?.id ?? ""} onError={imp.setErr} />}
        {imp.dryDone && (
          <div className="inbox-acts">
            <button type="button" className="f-pill is-accent" disabled={imp.locked} onClick={() => void imp.bringIn()} data-bring-in>
              Bring it in
            </button>
            <span className="inbox-quiet">Writes these messages into ChatForm, in their authors' names.</span>
          </div>
        )}
        {r && !r.dryRun && <p className="fx-said is-ok" role="status"><span className="f-dot is-ok" /> In. Press Next for who's who.</p>}
      </>
    );
  if (at === 2)
    return (
      <>
        <p className="fx-text">A Slack person whose email is someone's Foundation email is them here: their messages, reactions and channels are theirs. Everyone else stays as their Slack self (a Slack person) until they sign in to Foundation with that email; then it all becomes theirs.</p>
        {r ? (
          <>
            <p className="fx-text">
              <b>{r.people.matched.length}</b> matched by email · <b>{r.people.ghosts}</b> kept as Slack people · <b>{r.people.bots}</b> bots
            </p>
            {r.people.matched.length > 0 && (
              <ul className="fx-people">
                {r.people.matched.map((m) => (
                  <li key={m.email}>
                    <span className="f-dot is-ok" /> {m.name} <span className="fx-quiet">{m.email}</span> → {m.userName}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="fx-quiet">Bring an export in first (the step before) to see who matched.</p>
        )}
        <p className="fx-quiet">Someone whose Slack email differs from their Foundation one: change it in Slack (or have them sign in here with that email), then press Link people.</p>
        <div className="inbox-acts">
          <button type="button" className="f-pill" disabled={!admin} onClick={() => void api<{ linked: number }>("/api/chat/history/link", { method: "POST", json: {} }).then((x) => setLinked(x.linked), () => setLinked(0))}>
            Link people now
          </button>
          {linked !== null && <span className="inbox-quiet" role="status">{linked === 1 ? "1 Slack person became themselves" : `${linked} Slack people became themselves`}</span>}
        </div>
      </>
    );
  const first = r?.conversations.find((c) => c.kind === "open" && (c as { channel?: string }).channel) as { channel?: string; name: string } | undefined;
  return (
    <>
      {r && !r.dryRun ? (
        <p className="fx-text">
          <b>{r.totals.messages.toLocaleString()}</b> messages in <b>{r.totals.conversations}</b> conversations came in, with {r.totals.files} files.
        </p>
      ) : (
        <p className="fx-text">Nothing was brought in on this pass.</p>
      )}
      {first?.channel && (
        <div className="inbox-acts">
          <button type="button" className="f-pill is-accent" onClick={() => goChat("chat", first.channel!)}>
            Open {first.name}
          </button>
        </div>
      )}
      <p className="fx-quiet">To undo: an admin archives a brought-in channel (its messages stay, out of the way). Bringing the export in again adds nothing twice. Inbox → Slack keeps the report.</p>
    </>
  );
}

// ---------------------------------------------------------------- keep both in step

function ScopeList({ view }: { view: SlackView }) {
  const have = view.scopes.have;
  return (
    <ul className="fx-scopes" aria-label="What the Slack app may do">
      {[...view.scopes.need, ...view.scopes.optional].map((s) => {
        const ok = have ? have.includes(s) : null;
        const optional = view.scopes.optional.includes(s);
        return (
          <li key={s} className={ok ? "is-ok" : ok === false ? (optional ? "is-optional" : "is-bad") : ""}>
            <span aria-hidden>{ok ? "✓" : ok === false ? "✗" : "·"}</span>
            <code>{s}</code>
            {optional && <span className="fx-quiet">optional: {ok ? "files are uploaded to Slack" : "without it a file is named in a line"}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function BridgePath({ at, admin, view, setView, reload, demoChannels }: { at: number; admin: boolean; view: SlackView; setView: (v: SlackView) => void; reload: () => void; demoChannels?: SlackChannelRow[] }) {
  const [manifest, setManifest] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [channels, setChannels] = useState<SlackChannelRow[] | null>(demoChannels ?? null);
  const [backfill, setBackfill] = useState(true);
  const [testCh, setTestCh] = useState("");
  const [test, setTest] = useState<{ sent: boolean; confirmed: boolean; error?: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  useEffect(() => {
    if (at === 0 && manifest === null && !demoChannels) void api<{ manifest: string }>("/api/chat/slack/manifest").then((r) => setManifest(r.manifest), () => setManifest(""));
  }, [at, manifest, demoChannels]);
  const loadChannels = useCallback(() => {
    if (demoChannels || !admin) return;
    setErr(null);
    void api<{ channels: SlackChannelRow[] }>("/api/chat/slack/channels").then((r) => setChannels(r.channels), (e: Error) => setErr(e.message));
  }, [admin, demoChannels]);
  useEffect(() => {
    if (at === 2 && view.token.set) loadChannels();
  }, [at, view.token.set, loadChannels]);
  const act = async (fn: () => Promise<void>) => {
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
  const live = view.links.filter((l) => l.state === "live");
  useEffect(() => {
    if (!testCh && live[0]) setTestCh(live[0].channel);
  }, [testCh, live]);

  if (at === 0)
    return (
      <>
        <p className="fx-text">The bridge runs on the Foundation Slack app (the same one the Slack board uses). It needs these permissions:</p>
        <div className="fx-status">
          <span className={`f-dot ${view.token.set ? (view.app?.ok === false ? "is-bad" : "is-ok") : "is-warn"}`} />
          {view.token.set ? (view.app?.ok === false ? `The token is set, but Slack refused it: ${view.app.error}` : `A bot token is set${view.token.source === "stored" ? " (pasted here, sealed on the server)" : view.token.source === "env" ? " (in the server's .env)" : " (lent by the Slack app running on this computer)"}${view.app?.team ? ` · ${view.app.team}` : ""}.`) : "No bot token yet."}
        </div>
        <ScopeList view={view} />
        <p className="fx-text">No app yet, or a permission missing? Create (or update) it from this manifest: api.slack.com/apps → Create New App → From a manifest (or the app's App Manifest page), paste, save, and install it to the workspace again.</p>
        <div className="fx-links">
          <button type="button" className="f-pill" onClick={() => openOutside("https://api.slack.com/apps")} data-open-url="https://api.slack.com/apps">
            Open api.slack.com/apps ↗
          </button>
          <button type="button" className="f-pill" disabled={!manifest} onClick={() => manifest && void copyText(manifest).then(setCopied)} data-copy-manifest>
            {copied ? "Copied" : "Copy the manifest"}
          </button>
        </div>
        {manifest && <pre className="fx-pre">{manifest}</pre>}
        <p className="fx-quiet">
          For messages within a second, run the Slack app on the server's computer (Socket Mode; <code>npm run slack</code>). Without it ChatForm reads linked channels every {view.pollSeconds} s. Now: {view.mode === "events" ? "events arrive through the Slack app" : view.mode === "polling" ? "reading on a timer" : "off"}.
        </p>
      </>
    );
  if (at === 1)
    return (
      <>
        <p className="fx-text">In the app's settings, OAuth & Permissions → Bot User OAuth Token (it starts xoxb-). Paste it here: it's sealed on the server and never shown again, to anyone.</p>
        <label className="fx-field">
          <span className="fx-label">
            Bot token <code>SLACK_BOT_TOKEN</code>
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={!admin || busy}
            value={token}
            aria-invalid={err || view.app?.ok === false ? true : undefined}
            aria-describedby={err ? "slack-guide-err" : view.app?.ok === false ? "slack-check-said" : undefined}
            onChange={(e) => setToken(e.target.value)}
            placeholder={view.token.set ? `set${view.token.tail ? ` · …${view.token.tail}` : ""} (paste to replace)` : "xoxb-…"}
            data-slack-token
          />
        </label>
        <div className="inbox-acts">
          <button
            type="button"
            className="f-pill is-accent"
            disabled={!admin || busy || !token.trim()}
            onClick={() =>
              void act(async () => {
                const r = await api<{ view: SlackView }>("/api/chat/slack/token", { method: "POST", json: { token: token.trim() } });
                setToken("");
                setView(r.view);
              })
            }
            data-save-token
          >
            Save and check
          </button>
          <button type="button" className="f-pill" disabled={!admin || busy || !view.token.set} onClick={() => void act(async () => setView((await api<{ view: SlackView }>("/api/chat/slack/check", { method: "POST", json: {} })).view))} data-check-slack>
            Check
          </button>
        </div>
        {view.app && (
          <p className={`fx-said ${view.app.ok ? "is-ok" : "is-bad"}`} id="slack-check-said" role={view.app.ok ? "status" : "alert"} data-check-said>
            <span className={`f-dot ${view.app.ok ? "is-ok" : "is-bad"}`} /> {view.app.ok ? `Slack says: ${view.app.team ?? "the workspace"}, as @${view.app.bot ?? "foundation"}.` : view.app.error}
          </p>
        )}
        {view.app?.ok && <ScopeList view={view} />}
        {err && <p className="inbox-err" id="slack-guide-err" role="alert">{err}</p>}
      </>
    );
  if (at === 2)
    return (
      <>
        <p className="fx-text">
          Messages posted here will appear in Slack as <i>Name via Foundation</i>; messages in Slack appear here within a few seconds. An agent's reply in a linked channel waits as a draft until a person sends it. Direct messages are never bridged: Slack doesn't let an app post into them for people.
        </p>
        {!view.token.set && <p className="fx-quiet">Set the bot token first (the step before).</p>}
        {err && <p className="inbox-err" role="alert">{err}</p>}
        {channels && (
          <>
            <label className="hist-check is-inline">
              <input type="checkbox" checked={backfill} disabled={!admin} onChange={(e) => setBackfill(e.target.checked)} />
              Bring each channel's last 200 messages in as I link it (nothing already here is doubled)
            </label>
            <div className="fx-table" role="table" aria-label="Slack channels and where they land" data-slack-channels>
              {channels.map((c) => (
                <div key={c.id} className="fx-row" role="row" data-slack-row={c.name}>
                  <span className="fx-cell" role="cell" title={`#${c.name}`}>
                    <b>#{c.name}</b>
                    {c.private && <span className="fx-quiet"> · private</span>}
                    {c.members !== null && <span className="fx-quiet"> · {c.members}</span>}
                  </span>
                  <span className="fx-arrow" aria-hidden>
                    ↔
                  </span>
                  <span className="fx-cell" role="cell" title={`#${c.link ? c.link.name : c.lands.name}`}>
                    #{c.link ? c.link.name : c.lands.name} <span className="fx-quiet">{c.link ? (c.link.state === "paused" ? "paused" : "linked") : c.lands.how === "imported" ? "brought in" : c.lands.how === "merge" ? "same name here" : "new here"}</span>
                  </span>
                  <span className="fx-cell is-act" role="cell">
                    {c.link ? (
                      <span className="fx-ok">✓ Linked</span>
                    ) : !c.member && c.private ? (
                      <span className="fx-quiet">/invite @Foundation in Slack</span>
                    ) : !c.member ? (
                      <button type="button" className="f-pill" disabled={!admin || busy} onClick={() => void act(async () => (await api("/api/chat/slack/join", { method: "POST", json: { slackId: c.id } }), loadChannels()))}>
                        Join
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="f-pill is-accent"
                        disabled={!admin || busy}
                        onClick={() =>
                          void act(async () => {
                            const r = await api<{ view: SlackView }>("/api/chat/slack/links", { method: "POST", json: { slackId: c.id, backfill, request_id: requestId() } });
                            setView(r.view);
                            loadChannels();
                          })
                        }
                        data-link={c.name}
                      >
                        Link
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <div className="inbox-acts">
              <button
                type="button"
                className="f-pill"
                disabled={!admin || busy || !channels.some((c) => !c.link && c.member)}
                onClick={() =>
                  void act(async () => {
                    for (const c of channels.filter((x) => !x.link && x.member)) setView((await api<{ view: SlackView }>("/api/chat/slack/links", { method: "POST", json: { slackId: c.id, backfill, request_id: requestId() } })).view);
                    loadChannels();
                  })
                }
              >
                Link all the app is in
              </button>
              {busy && <span className="inbox-quiet" role="status">Linking…</span>}
            </div>
          </>
        )}
      </>
    );
  if (at === 3)
    return (
      <>
        <p className="fx-text">Send a test message: it's posted here as you, goes to Slack as “{"you"} via Foundation”, and is read back from Slack to confirm it arrived. Then say something in that Slack channel and watch it appear here.</p>
        {live.length ? (
          <div className="inbox-acts">
            <select value={testCh} onChange={(e) => setTestCh(e.target.value)} aria-label="Which linked channel" data-test-channel>
              {live.map((l) => (
                <option key={l.channel} value={l.channel}>
                  #{l.name} ↔ #{l.slackName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="f-pill is-accent"
              disabled={!admin || busy || !testCh}
              onClick={() =>
                void act(async () => {
                  setTest(null);
                  try {
                    setTest(await api<{ sent: boolean; confirmed: boolean }>("/api/chat/slack/test", { method: "POST", json: { channel: testCh, request_id: requestId() } }));
                  } catch (e) {
                    setTest({ sent: false, confirmed: false, error: (e as Error).message });
                  }
                })
              }
              data-send-test
            >
              Send a test message
            </button>
          </div>
        ) : (
          <p className="fx-quiet">Link a channel first (the step before).</p>
        )}
        {test && (
          <p className={`fx-said ${test.confirmed ? "is-ok" : "is-bad"}`} role={test.confirmed ? "status" : "alert"} data-test-result>
            <span className={`f-dot ${test.confirmed ? "is-ok" : "is-bad"}`} /> {test.confirmed ? "Sent, and Slack has it: the bridge works both ways from here." : test.sent ? "Sent, but it couldn't be read back yet." : `Not sent: ${test.error ?? "it failed"}`}
          </p>
        )}
        {testCh && (
          <button type="button" className="f-pill" onClick={() => goChat("chat", testCh)}>
            Open the channel here
          </button>
        )}
      </>
    );
  return (
    <>
      <p className="fx-text">{view.links.length ? `${view.links.length === 1 ? "1 channel is" : `${view.links.length} channels are`} linked:` : "Nothing is linked yet."}</p>
      <LinkList view={view} admin={admin} busy={busy} asking={asking} setAsking={setAsking} act={act} setView={setView} reload={reload} />
      <p className="fx-quiet">To undo: Pause stops both ways for a while; Unlink stops it for good. Neither deletes a message here or in Slack.</p>
      {err && <p className="inbox-err" role="alert">{err}</p>}
    </>
  );
}

/** the linked channels, with Pause / Resume and Unlink (asks first) */
export function LinkList({ view, admin, busy, asking, setAsking, act, setView, reload }: { view: SlackView; admin: boolean; busy: boolean; asking: string | null; setAsking: (x: string | null) => void; act: (fn: () => Promise<void>) => Promise<void>; setView: (v: SlackView) => void; reload: () => void }) {
  const post = (path: string, json: unknown) => act(async () => (setView((await api<{ view: SlackView }>(path, { method: "POST", json })).view), reload()));
  return (
    <div className="fx-links-list" data-slack-links>
      {view.links.map((l) => (
        <div key={l.channel} className="fx-link-row" data-slack-link={l.slackName}>
          <span className={`f-dot ${l.error ? "is-bad" : l.state === "live" ? "is-ok" : ""}`} />
          <button type="button" className="fx-link-name" onClick={() => goChat("chat", l.channel)}>
            #{l.name} <span className="fx-quiet">↔ Slack #{l.slackName}</span>
          </button>
          <span className="fx-quiet fx-link-when">
            {l.error ? l.error : l.state === "paused" ? "paused" : [l.lastInAt ? `in ${ago(l.lastInAt)}` : "", l.lastOutAt ? `out ${ago(l.lastOutAt)}` : ""].filter(Boolean).join(" · ") || `linked by ${l.linkedBy}`}
          </span>
          {admin && (
            <span className="fx-link-acts">
              {l.errorCode === "not_in_channel" && !l.private && (
                <button type="button" className="f-pill" disabled={busy} onClick={() => void post("/api/chat/slack/join", { slackId: l.slackId })}>
                  Join
                </button>
              )}
              {asking === l.channel ? (
                <>
                  <button type="button" className="f-pill chat-draft-bad" disabled={busy} onClick={() => void post(`/api/chat/slack/links/${l.channel}/unlink`, { confirm: true }).then(() => setAsking(null))} data-unlink-yes>
                    Unlink
                  </button>
                  <button type="button" className="f-pill" onClick={() => setAsking(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="f-pill" disabled={busy} onClick={() => void post(`/api/chat/slack/links/${l.channel}`, { state: l.state === "live" ? "paused" : "live" })}>
                    {l.state === "live" ? "Pause" : "Resume"}
                  </button>
                  <button type="button" className="f-pill" onClick={() => setAsking(l.channel)} data-unlink>
                    Unlink…
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** the guide's own state for a list of links, for the Inbox's Slack card */
export function useLinkActions(setView: (v: SlackView) => void, reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = useMemo(
    () => async (fn: () => Promise<void>) => {
      setBusy(true);
      setErr(null);
      try {
        await fn();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  return { busy, asking, setAsking, err, act, setView, reload };
}

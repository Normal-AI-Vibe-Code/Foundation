/**
 * This computer's cards (protocol localdev.ts; server localdev.ts). A project being built on the computer the
 * server runs on is a section of the "This computer" grid, and in it three cards the server keeps:
 *
 *   - **Preview**: the newest screenshot a session saw of the work, and the dev server the project declares.
 *   - **Progress**: the sessions on it (Claude Code in the desktop app or the CLI, T3 threads), newest first, each
 *     with its plan as a bar and its steps, its last wrap-up, its PR.
 *   - **Changes**: the checkout's branch, how far it is from upstream, the changed files and the last commits.
 *
 * Every card wears the **local pill** (On this computer, with the watch's dot): what it shows was read from this
 * computer, not written by a person or an agent on the board. Read only: nothing here writes the project.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { LOCAL_GRID_ID, boardMaps, localLive, type LocalNode, type LocalProject, type LocalSession, type LocalWatch } from "@foundation/protocol";
import { activeBoard, onBoardChange } from "../sync/board";
import { useFileSrc } from "../lib/fileSrc";
import type { PanelMeta } from "../state/store";
import { ComputerGlyph, T3Glyph } from "../shell/glyphs";
import { api } from "../lib/api";
import { loadGrids } from "../lib/grids";
import "./local.css";

/** is the open grid This computer */
export function useOnLocalGrid(): boolean {
  return useSyncExternalStore(onBoardChange, () => activeBoard()?.boardId === LOCAL_GRID_ID);
}

export interface LocalStatus {
  grid: string;
  connected: boolean;
  on: boolean;
  by: string | null;
  watch: LocalWatch | null;
  canConnect: boolean;
}
let statusCache: LocalStatus | null = null;
let statusAt = 0;
const statusFns = new Set<(s: LocalStatus | null) => void>();
async function refreshStatus(force = false) {
  if (!force && Date.now() - statusAt < 25_000) return statusCache;
  statusAt = Date.now();
  try {
    statusCache = await api<LocalStatus>("/api/local");
  } catch {
    statusCache = null;
  }
  for (const fn of statusFns) fn(statusCache);
  return statusCache;
}
/** where the watch of this computer stands, from anywhere (the side menu, Settings): asked every 30 s */
export function useLocalStatus(): [LocalStatus | null, () => Promise<LocalStatus | null>] {
  const [s, set] = useState<LocalStatus | null>(statusCache);
  useEffect(() => {
    statusFns.add(set);
    void refreshStatus();
    const t = setInterval(() => void refreshStatus(), 30_000);
    return () => {
      statusFns.delete(set);
      clearInterval(t);
    };
  }, []);
  return [s, () => refreshStatus(true)];
}

/** one key of a server-kept map on the open board, re-read when the server writes it */
function useServerMap<T>(map: "local" | "localWatch", key: string | undefined): T | undefined {
  const raw = useSyncExternalStore(
    (fn) => {
      let off = () => {};
      const watch = () => {
        off();
        const b = activeBoard();
        if (!b) return;
        const m = boardMaps(b.doc)[map];
        m.observe(fn);
        off = () => m.unobserve(fn);
      };
      watch();
      const offBoard = onBoardChange(() => (watch(), fn()));
      return () => (off(), offBoard());
    },
    () => {
      const b = activeBoard();
      const v = b && key ? boardMaps(b.doc)[map].get(key) : undefined;
      return v ? JSON.stringify(v) : "";
    },
  );
  return useMemo(() => (raw ? (JSON.parse(raw) as T) : undefined), [raw]);
}

export const useLocalProject = (key: string | undefined) => useServerMap<LocalProject>("local", key);
/** the watch, as the open board has it (only the This computer grid has one) */
export const useLocalWatchHere = () => useServerMap<LocalWatch>("localWatch", "state");

/** a time as people say it: just now, 4 min ago, 3 h ago, 2 d ago */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** the pill every local card wears: this was read from this computer (a live dot while it's watched) */
export function LocalPill({ watch, label = "On this computer" }: { watch: LocalWatch | undefined; label?: string }) {
  const live = localLive(watch);
  const tip = !watch ? "Read from this computer" : live ? `Read from this computer · looked ${ago(watch.scannedAt)} · connected by ${watch.byName}` : watch.on ? `Read from this computer · not looked since ${ago(watch.scannedAt)}` : `Read from this computer · watching stopped, shown as it was ${ago(watch.scannedAt)}`;
  return (
    <span className={`local-pill${live ? " is-live" : ""}`} data-tip={tip} aria-label={tip}>
      <ComputerGlyph size={12} />
      {label}
      <span className={`f-dot ${live ? "is-ok" : "is-warn"}`} aria-hidden />
    </span>
  );
}

const SOURCE: Record<LocalSession["source"], string> = { "claude-desktop": "Claude · desktop", "claude-cli": "Claude Code", t3: "T3" };

function SourceMark({ s }: { s: LocalSession["source"] }) {
  return s === "t3" ? <T3Glyph size={12} /> : <span className="local-claude" aria-hidden>✳</span>;
}

function StateWord({ s }: { s: LocalSession }) {
  const word = s.state === "working" ? "working" : s.state === "waiting" ? "waiting for a person" : s.state === "error" ? "hit a problem" : ago(s.at);
  return <span className={`local-state is-${s.state}`}>{s.state === "working" && <span className="f-dot is-agent is-live" aria-hidden />}{word}</span>;
}

function Steps({ s }: { s: LocalSession }) {
  if (!s.steps?.length) return null;
  const done = s.steps.filter((x) => x.state === "done").length;
  return (
    <div className="local-steps">
      <div className="local-bar" role="progressbar" aria-valuemin={0} aria-valuemax={s.steps.length} aria-valuenow={done} aria-label={`${done} of ${s.steps.length} steps`}>
        <span style={{ width: `${(done / s.steps.length) * 100}%` }} />
        <em>
          {done}/{s.steps.length}
        </em>
      </div>
      <ul>
        {s.steps.map((x, i) => (
          <li key={i} className={`is-${x.state}`}>
            <span className="local-tick" aria-hidden />
            {x.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="local-empty">{children}</p>;
}

function PreviewCard({ p }: { p: LocalProject }) {
  // a stand-in on #/design is a data: picture; on the grid it's the archive's file
  const src = useFileSrc(p.preview ? (p.preview.fileId.startsWith("data:") ? p.preview.fileId : `/files/${p.preview.fileId}`) : null);
  return (
    <div className="local-preview">
      <div className="local-shot">
        {p.preview ? src ? <img src={src} alt={`The newest screenshot of ${p.name}`} draggable={false} /> : <span className="local-shot-wait" /> : <Empty>No screenshot yet. A session that looks at its work in a browser leaves one here.</Empty>}
      </div>
      <div className="local-foot">
        {p.preview && (
          <span className="local-caption" data-tip={p.preview.session}>
            {p.preview.session} · {ago(p.preview.at)}
          </span>
        )}
        {p.server && (
          <a className={`local-server${p.server.live ? " is-live" : ""}`} href={p.server.url} target="_blank" rel="noreferrer" data-tip={p.server.live ? `Something answers on :${p.server.port} (${p.server.name}) · open it` : `${p.server.name} on :${p.server.port} isn't answering`}>
            <span className={`f-dot ${p.server.live ? "is-ok" : ""}`} aria-hidden />:{p.server.port}
            {p.server.live && " ↗"}
          </a>
        )}
      </div>
    </div>
  );
}

function ProgressCard({ p }: { p: LocalProject }) {
  if (!p.sessions.length) return <Empty>No sessions in the last few days.</Empty>;
  const [lead, ...rest] = p.sessions;
  return (
    <div className="local-progress">
      <div className="local-session is-lead">
        <div className="local-session-head">
          <SourceMark s={lead.source} />
          <span className="local-title">{lead.title}</span>
        </div>
        <div className="local-meta">
          <StateWord s={lead} />
          <span>{SOURCE[lead.source]}</span>
          {lead.worktree && <span className="local-code" data-tip="Runs in a worktree">⑂ {lead.worktree}</span>}
          {lead.pr && (
            <a href={lead.pr.url} target="_blank" rel="noreferrer">
              PR {lead.pr.number} ↗
            </a>
          )}
        </div>
        <Steps s={lead} />
        {lead.recap && <p className="local-recap">{lead.recap}</p>}
      </div>
      {rest.length > 0 && (
        <ul className="local-others">
          {rest.map((s) => {
            const done = s.steps?.filter((x) => x.state === "done").length ?? 0;
            return (
              <li key={s.id} data-tip={s.recap ?? s.title}>
                <SourceMark s={s.source} />
                <span className="local-title">{s.title}</span>
                {s.steps?.length ? (
                  <span className="local-n">
                    {done}/{s.steps.length}
                  </span>
                ) : null}
                <StateWord s={s} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ChangesCard({ p }: { p: LocalProject }) {
  const g = p.git;
  if (!g) return <Empty>{p.gone ? "This folder isn't on the computer any more." : "Not a git checkout, so there are no changes to show."}</Empty>;
  return (
    <div className="local-changes">
      <div className="local-branch">
        <span className="local-code">⑂ {g.branch || "detached"}</span>
        {g.ahead > 0 && <span className="local-n" data-tip="Commits not pushed">↑{g.ahead}</span>}
        {g.behind > 0 && <span className="local-n" data-tip="Commits not pulled">↓{g.behind}</span>}
        <span className="local-dirty">{g.dirty ? `${g.dirty} changed` : "clean"}</span>
      </div>
      {g.files.length > 0 && (
        <ul className="local-files">
          {g.files.map((f) => (
            <li key={f.path}>
              <span className={`local-st is-${f.status === "??" ? "new" : f.status.includes("D") ? "gone" : f.status.includes("A") ? "new" : "mod"}`}>{f.status === "??" ? "U" : f.status[0]}</span>
              <span className="local-path" data-tip={f.path}>
                {f.path}
              </span>
            </li>
          ))}
          {g.dirty > g.files.length && <li className="local-more">and {g.dirty - g.files.length} more</li>}
        </ul>
      )}
      {g.commits.length > 0 && (
        <>
          <div className="local-eyebrow">Last commits</div>
          <ul className="local-commits">
            {g.commits.map((c) => (
              <li key={c.sha}>
                <span className="local-code">{c.sha}</span>
                <span className="local-subject">{c.subject}</span>
                <span className="local-when">{ago(c.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function LocalBody({ panel }: { panel: PanelMeta }) {
  const p = useLocalProject(panel.source);
  const watch = useLocalWatchHere();
  return <LocalCard node={(panel.node as LocalNode | undefined) ?? "progress"} name={panel.name} project={p} watch={watch} />;
}

/** a local card's face, given what it shows (the grid's cards, and #/design's stand-ins) */
export function LocalCard({ node, name, project: p, watch }: { node: LocalNode; name: string; project: LocalProject | undefined; watch: LocalWatch | undefined }) {
  return (
    <div className={`local-card is-${node}`}>
      <div className="local-head">
        <span className="local-eyebrow">{node === "preview" ? "Preview" : node === "progress" ? "Progress" : "Changes"}</span>
        <LocalPill watch={watch} />
      </div>
      <div className="local-body">
        {!p ? <Empty>Waiting for this computer to say how {name.toLowerCase()} stands.</Empty> : node === "preview" ? <PreviewCard p={p} /> : node === "changes" ? <ChangesCard p={p} /> : <ProgressCard p={p} />}
      </div>
    </div>
  );
}

/** a section of the This computer grid: the computer's mark beside its council, and how many of its sessions work now */
export function LocalSectionChip({ projectKey }: { projectKey: string }) {
  const p = useLocalProject(projectKey);
  const watch = useLocalWatchHere();
  const live = localLive(watch);
  const working = p?.sessions.filter((s) => s.state === "working").length ?? 0;
  const tip = `${p?.path ?? "A project"} · read from this computer${live ? "" : " (not being watched now)"}`;
  return (
    <span className="sec-local-chip" data-tip={tip} aria-label={tip}>
      <ComputerGlyph size={13} />
      {working ? `${working} working here` : "Local"}
      <span className={`f-dot ${live ? "is-ok" : "is-warn"}`} aria-hidden />
    </span>
  );
}

/** the side menu's row for the This computer grid: the watch's dot */
export function LocalRowDot() {
  const [st] = useLocalStatus();
  // with the grid open, its own watch (live as the server writes it); elsewhere, the server's answer every 30 s
  const w = useLocalWatchHere() ?? st?.watch ?? undefined;
  const live = localLive(w);
  const tip = !st?.connected && !w ? "Not connected" : live ? `Connected to this computer · ${w?.projects ?? 0} projects, ${w?.working ?? 0} sessions working` : w?.on || st?.on ? "Connected, waiting for the first look" : "Watching stopped: shown as it was";
  return <span className={`f-dot pane-local-dot ${live ? "is-ok" : "is-warn"}${live && w?.working ? " is-live" : ""}`} data-tip={tip} aria-label={tip} />;
}

/** Settings → Places: connect this computer's projects as a grid (an admin, in person), or stop watching */
export function LocalConnect({ onOpen }: { onOpen(id: string): void }) {
  const [st, refresh] = useLocalStatus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (what: "connect" | "stop") => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/local/${what}`, { method: "POST", json: {} });
      await refresh();
      if (what === "connect") {
        // the grid is new to the list: read it again, so its tab and its row have its name
        await loadGrids();
        onOpen(LOCAL_GRID_ID);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const w = st?.watch ?? undefined;
  const live = localLive(w);
  return (
    <div className="services-list local-connect">
      <div className="services-row">
        <span className={`f-dot ${st?.on ? (live ? "is-ok" : "is-warn") : ""}`} />
        <span className="services-name">
          <ComputerGlyph size={13} /> This computer's projects
        </span>
        <span className="services-detail">{!st?.connected ? "Not connected" : st.on ? (w ? `${w.projects} projects · ${w.working} sessions working · looked ${ago(w.scannedAt)}` : "Looking for the first time…") : "Stopped"}</span>
        <span className="services-act">
          {st?.connected && (
            <button className="f-pill" onClick={() => onOpen(LOCAL_GRID_ID)}>
              Open the grid
            </button>
          )}
          {st?.canConnect &&
            (st.on ? (
              <button className="f-pill" disabled={busy} onClick={() => act("stop")}>
                Stop watching
              </button>
            ) : (
              <button className="f-pill is-accent" disabled={busy} onClick={() => act("connect")}>
                {busy ? "Connecting…" : st.connected ? "Watch again" : "Connect this computer"}
              </button>
            ))}
        </span>
        <span className="services-how">
          A grid of the projects being built here: a section each, with the newest screenshot, where the Claude Code and T3 sessions on it stand, and what changed in git. Read from Claude Code's transcripts, T3 and git, never written. Only you{st?.by ? ` (${st.by})` : ""} and admins can see it.
          {w?.note ? ` ${w.note}` : ""}
          {!st?.canConnect && !st?.connected ? " An admin, signed in here as themselves, connects it." : ""}
        </span>
      </div>
      {err && <div className="kb-error">{err}</div>}
    </div>
  );
}

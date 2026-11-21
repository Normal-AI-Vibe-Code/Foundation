/**
 * A machine in a section: a Linux machine or container on this computer's
 * engine (Kiri or Docker), started by a person, typed into by everyone who
 * can edit the board. The server (machines.ts) talks to the engine and writes
 * what's true into `panel.machine`; this card shows it and asks the server.
 *
 * States: no engine → a hatched well that says why and how to get one.
 * Not started → pick an image (a distro, one the engine has, or a saved image
 * from the archive) and press Start. Pulling/starting → the engine's progress.
 * Running → the shared terminal or, by the head's switch, the machine's
 * graphical desktop (MachineViewDesktop.tsx); its published ports as apps;
 * and its pipes, in and out (MachineViewIo.tsx). Stopped → Start again (the
 * disk is kept) or Remove (it isn't).
 *
 * Typing: a plain click in the terminal puts the caret there, the card goes
 * "in use" and says where the keys go; every key is then the shell's (the
 * app's shortcuts stand down: lib/keysHeld.ts) until Esc twice or a click
 * elsewhere.
 *
 * The terminal is xterm.js. Its colours are read from the tokens (a probe
 * element resolves each one, so night mixes come through) and re-read when
 * night turns. It mounts only while the card is on screen and big enough.
 */

import "@xterm/xterm/css/xterm.css";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { boardMaps, MACHINE_DISTROS, type MachineAsk, type MachineState } from "@foundation/protocol";
import { type PanelMeta } from "../state/store";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { askAgent, toast, useUi } from "../state/ui";
import { useOnScreen } from "./PanelView";
import { MACHINE_STATE_WORD, machineTone } from "./machinePage";
import { unscaleMouse } from "./scaledMouse";
import { putInUse } from "../lib/cardUse";
import { HOLDS_KEYS, escEscToLeave } from "../lib/keysHeld";
import { getUi, setUi } from "../state/ui";
import { KeysLine, useRingWidth } from "./MachineViewBits";
import { AgentUse, Desktop, ViewSwitch, useMachineView } from "./MachineViewDesktop";
import { IoView } from "./MachineViewIo";
import { desktopRecipe } from "./machineWords";
import { AgentGlyph, DesktopGlyph, GlobeGlyph, LockGlyph, PackageGlyph, PlayGlyph, PullGlyph, ShieldGlyph, StopGlyph, TerminalGlyph } from "../shell/glyphs";
import { HubSearch } from "./MachineHub";
import { AddressBar, MachineTitle } from "./MachineBar";
import { LocalVm } from "./LocalVm";
import { Access } from "./MachineAccess";
import { ClusterStart, ClusterView, PodWell } from "./MachineCluster";
import { copyText, mountTerminal, readClipboard, type MachineTerminal } from "./machineTerminal";
import { MachineTools, copiedWords, openMachineWindow, pastedWords, useFlash } from "./MachineTools";

export { themeFromTokens } from "./machineTerminal";

export { KeysLine };

interface EngineStatus {
  id: "kiri" | "docker";
  name: string;
  at?: string;
  up: boolean;
  version?: string;
  error?: string;
  /** Kiri installed here but not running: Start wakes it */
  asleep?: boolean;
}

const board = () => activeBoard()?.boardId ?? "company";

/**
 * A person's action on a machine card (start, stop, restart, remove). The
 * server takes it only from a person's browser session on a board they can
 * edit; the card and a page opened from its port both ask through here.
 */
export function machineAction(panelId: string, verb: "start" | "stop" | "restart" | "remove", json: Record<string, unknown> = {}) {
  return api<{ machine: MachineState }>(`/api/boards/${encodeURIComponent(board())}/machines/${panelId}/${verb}`, { method: "POST", json });
}

export function MachineBody({ panel }: { panel: PanelMeta }) {
  const [kind, setKind] = useState<"container" | "vm">(panel.machine?.wantVm ? "vm" : "container");
  if (panel.vm) return <LocalVm panel={panel} />;
  if (panel.machine?.state === "absent") return <div className="machine-body vm-picker"><div className="vm-kind" role="tablist" aria-label="Machine type"><button className={`f-pill${kind === "container" ? " is-accent" : ""}`} role="tab" aria-selected={kind === "container"} onClick={() => setKind("container")}>Container</button><button className={`f-pill${kind === "vm" ? " is-accent" : ""}`} role="tab" aria-selected={kind === "vm"} onClick={() => setKind("vm")}>Full OS / WildOS VM</button></div>{kind === "vm" ? <LocalVm panel={panel} /> : <ContainerMachineBody panel={panel} />}</div>;
  return <ContainerMachineBody panel={panel} />;
}

function ContainerMachineBody({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(host, 0.25);
  const ui = useUi();
  const viewer = ui.role === "viewer";
  const m = panel.machine!;
  const [engines, setEngines] = useState<EngineStatus[] | null>(null);
  const [view, setView] = useMachineView(panel.id);

  // while on screen, the server reads the engine back and writes what's true to the board
  useEffect(() => {
    if (!onScreen) return;
    let stop = false;
    const load = () =>
      api<{ engines: EngineStatus[] }>(`/api/boards/${encodeURIComponent(board())}/machines/${panel.id}`)
        .then((r) => !stop && setEngines(r.engines))
        .catch(() => {});
    void load();
    const t = setInterval(load, m.state === "pulling" || m.state === "starting" ? 1500 : 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [onScreen, panel.id, m.state]);

  const up = engines?.filter((e) => e.up) ?? [];
  const asleep = engines?.find((e) => e.asleep);
  // a machine on a sleeping Kiri waits for Kiri, not for whichever engine is up
  // one with no machine yet (or removed) starts on Kiri when it's installed, awake or not; else the first engine up
  const first = engines?.find((e) => e.id === "kiri" && (e.up || e.asleep)) ?? up[0];
  const engine = (m.engine === "kiri" && m.containerId && asleep) || ((m.containerId ? engines?.find((e) => e.id === m.engine && e.up) : undefined) ?? first);
  const noEngine = engines !== null && up.length === 0 && !asleep;

  return (
    <div ref={host} className={`machine-body is-${m.state}`}>
      {/* the head (2026-11-17, redrawn): the title row with the actions, then the views and the machine's address */}
      <MachineTitle panel={panel} m={m} viewer={viewer || noEngine} engineName={engine?.name} engineVersion={engine?.asleep ? "· asleep" : engine?.version} pill={<StatePill m={m} noEngine={noEngine && m.state !== "running"} away={Boolean(engine?.asleep && m.containerId)} />} />
      {m.state === "running" && (
        <div className="machine-nav-row">
          <ViewSwitch view={view} onView={setView} panelId={panel.id} only={m.pod ? ["terminal", "access"] : m.cluster?.role === "server" ? ["cluster", "terminal", "io", "access"] : m.cluster ? ["terminal", "io", "access"] : undefined} />
          <AddressBar panel={panel} m={m} viewer={viewer} />
        </div>
      )}
      <MachineAsks panelId={panel.id} viewer={viewer} />
      {m.state === "running" && <AgentUse panelId={panel.id} m={m} viewer={viewer} view={view} onWatch={() => setView("desktop")} />}
      {noEngine && m.state !== "running" ? (
        <NoEngine engines={engines!} />
      ) : m.state === "running" ? (
        !onScreen ? (
          <div className="machine-poster">{m.name} is running</div>
        ) : view === "desktop" ? (
          <Desktop panel={panel} m={m} viewer={viewer} />
        ) : view === "io" ? (
          <IoView panel={panel} viewer={viewer} />
        ) : view === "access" ? (
          <AccessWaiting panel={panel} m={m} viewer={viewer} />
        ) : view === "cluster" && m.cluster?.role === "server" ? (
          <ClusterView panel={panel} m={m} viewer={viewer} />
        ) : (
          <Terminal panelId={panel.id} name={m.name} canType={!viewer} />
        )
      ) : m.pod ? (
        <PodWell m={m} />
      ) : m.state === "pulling" || m.state === "starting" ? (
        <PullWell m={m} />
      ) : m.cluster ? (
        <ClusterStart m={m} viewer={viewer} />
      ) : m.state === "stopped" && m.containerId ? (
        <div className="machine-well machine-hero">
          <span className="machine-hero-mark">
            <StopGlyph size={22} />
          </span>
          <div className="machine-hero-title connector-offline-title">{engine?.asleep ? `${m.name} is out of reach` : `${m.name} is stopped`}</div>
          <div className="machine-hero-lede connector-offline-reason">{m.detail ?? "Its disk is kept: Start runs it again."}</div>
        </div>
      ) : (
        <Picker panel={panel} m={m} engine={engine} viewer={viewer} />
      )}
    </div>
  );
}

// ---------- agents' commands, waiting for a person ----------

/** answered asks stay on the card this long, so people see what became of them */
const ANSWERED_MS = 2 * 60_000;

/** the commands agents asked to run here: the board's `machineAsks`, written by the server alone */
/** the Access view, told how many of the agents' commands are waiting */
function AccessWaiting({ panel, m, viewer }: { panel: PanelMeta; m: MachineState; viewer: boolean }) {
  const asks = useMachineAsks(panel.id);
  return <Access panel={panel} m={m} viewer={viewer} waiting={asks.filter((a) => a.state === "waiting").length} />;
}

function useMachineAsks(panelId: string): MachineAsk[] {
  const [asks, setAsks] = useState<MachineAsk[]>([]);
  useEffect(() => {
    const b = activeBoard();
    if (!b) return;
    const map = boardMaps(b.doc).machineAsks;
    const read = () => setAsks(map.get(panelId) ?? []);
    read();
    const onChange = (e: { keysChanged: Set<string> }) => e.keysChanged.has(panelId) && read();
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [panelId]);
  return asks;
}

function MachineAsks({ panelId, viewer }: { panelId: string; viewer: boolean }) {
  const asks = useMachineAsks(panelId);
  const [now, setNow] = useState(() => Date.now());
  const live = asks.some((a) => a.state === "waiting" || a.state === "running");
  const recent = asks.some((a) => a.endedAt && now - a.endedAt < ANSWERED_MS);
  // tick while something waits (its time left) or an answer is still showing
  useEffect(() => {
    if (!live && !recent) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, recent]);
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (ask: MachineAsk, verdict: "run" | "decline" | "allow") => {
    setBusy(ask.id);
    try {
      await api(`/api/boards/${encodeURIComponent(board())}/machines/${panelId}/asks/${ask.id}/${verdict}`, { method: "POST", json: {} });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  const shown = asks.filter((a) => a.state === "waiting" || a.state === "running" || (a.endedAt && now - a.endedAt < ANSWERED_MS && a.state !== "withdrawn"));
  if (!shown.length) return null;
  return <MachineAskList asks={shown.slice(-3)} viewer={viewer} now={now} busy={busy} onAnswer={answer} />;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Asks on a machine card: waiting ones say which agent wants to run what and
 * why, with Run (a person's forward action, blue) and Decline; viewers see who
 * can answer. Running and answered ones are a line each. Also drawn on #/design.
 */
export function MachineAskList({ asks, viewer, now, busy, onAnswer }: { asks: MachineAsk[]; viewer: boolean; now: number; busy?: string | null; onAnswer?: (a: MachineAsk, verdict: "run" | "decline" | "allow") => void }) {
  return (
    <div className="machine-asks">
      {asks.map((a) =>
        a.tool ? (
          <AppToolAskRow key={a.id} a={a} viewer={viewer} busy={busy === a.id} onAnswer={onAnswer} />
        ) : a.state === "waiting" ? (
          <div key={a.id} className="machine-ask is-waiting">
            <div className="machine-ask-head">
              <span className="f-dot is-agent is-live" />
              <span className="machine-ask-who">✦ {a.by}</span>
              <span className="machine-ask-verb">wants to run{a.for && a.for !== a.by ? ` · for ${a.for}` : ""}</span>
              {a.expiresAt && <span className="machine-ask-left" data-tip="Unanswered by then, it gives up and nothing runs">{clock(a.expiresAt - now)}</span>}
            </div>
            <pre className="machine-ask-cmd">{a.command}</pre>
            {a.why && <div className="machine-ask-why">{a.why}</div>}
            <div className="machine-ask-actions">
              {viewer ? (
                <span className="machine-ask-note">View only: someone who can edit this board runs or declines it.</span>
              ) : (
                <>
                  <button className="f-pill is-accent" disabled={busy === a.id} onClick={() => onAnswer?.(a, "run")}>
                    Run
                  </button>
                  <button className="f-pill" disabled={busy === a.id} onClick={() => onAnswer?.(a, "decline")}>
                    Decline
                  </button>
                  <span className="machine-ask-terms">Runs once, as root, without a terminal · {a.by} gets what it prints</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div key={a.id} className={`machine-ask is-${a.state.replace(" ", "-")}`} data-tip={a.output ? `What it printed, the end of it: ${a.output.slice(-300)}` : undefined}>
            <div className="machine-ask-head">
              <span className={`f-dot ${a.state === "running" ? "is-warn is-live" : a.state === "done" && a.exitCode === 0 ? "is-ok" : a.state === "done" || a.state === "failed" ? "is-bad" : ""}`} />
              <code className="machine-ask-line">{a.command}</code>
              <span className="machine-ask-verb">
                {a.state === "running"
                  ? `running · ${a.decidedBy} ran it for ${a.by}`
                  : a.state === "done"
                    ? `${a.exitCode === undefined ? "ended" : `exit ${a.exitCode}`} · ${a.decidedBy} ran it for ${a.by}`
                    : a.state === "declined"
                      ? `${a.decidedBy} declined ${a.by}'s ask`
                      : a.state === "failed"
                        ? `couldn't start · ${a.decidedBy} ran it for ${a.by}`
                        : `nobody answered ${a.by}; nothing ran`}
              </span>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * An agent's ask to use a tool of a saved app (ADR-001 G3): which agent, which
 * app and tool, first use or changed, what the tool says it does, the
 * arguments this call would send, and the address Foundation would connect
 * to. Allow lets agents call that tool from now on (the agent calls again);
 * nothing runs on the press itself.
 */
function AppToolAskRow({ a, viewer, busy, onAnswer }: { a: MachineAsk; viewer: boolean; busy: boolean; onAnswer?: (a: MachineAsk, verdict: "allow" | "decline") => void }) {
  const t = a.tool!;
  if (a.state !== "waiting")
    return (
      <div className={`machine-ask is-${a.state.replace(" ", "-")}`}>
        <div className="machine-ask-head">
          <span className={`f-dot ${a.state === "allowed" ? "is-ok" : ""}`} />
          <code className="machine-ask-line">{a.command}</code>
          <span className="machine-ask-verb">{a.state === "allowed" ? `${a.decidedBy} allowed it · ${a.by} can call it again` : a.state === "declined" ? `${a.decidedBy} declined ${a.by}'s ask` : `${a.by}'s ask ended; nothing was called`}</span>
        </div>
      </div>
    );
  return (
    <div className="machine-ask is-waiting">
      <div className="machine-ask-head">
        <span className="f-dot is-agent is-live" />
        <span className="machine-ask-who">✦ {a.by}</span>
        <span className="machine-ask-verb">
          wants to use a tool of {t.app}
          {a.for && a.for !== a.by ? ` · for ${a.for}` : ""}
        </span>
      </div>
      <div className="machine-ask-why">
        <b>{a.command}</b> · {t.change === "first" ? "First use." : "Changed since it was allowed."}
        {t.description ? ` ${t.description}` : ""}
      </div>
      <pre className="machine-ask-cmd" data-tip="The arguments this call would send">{t.args}</pre>
      <div className="machine-ask-where" data-tip="The address Foundation would connect to: the saved app's, not the card's">
        {t.address}
      </div>
      <div className="machine-ask-actions">
        {viewer ? (
          <span className="machine-ask-note">View only: someone who can edit this board allows or declines it.</span>
        ) : (
          <>
            <button className="f-pill is-accent" disabled={busy} onClick={() => onAnswer?.(a, "allow")}>
              Allow
            </button>
            <button className="f-pill" disabled={busy} onClick={() => onAnswer?.(a, "decline")}>
              Decline
            </button>
            <span className="machine-ask-terms">Agents may call {a.command} from now on, until it changes · nothing runs on this press</span>
          </>
        )}
      </div>
    </div>
  );
}

/** agents' asks to use an app's tools, on the app's card (the board's `machineAsks`, written by the server alone) */
export function AppToolAsks({ panelId, viewer }: { panelId: string; viewer: boolean }) {
  const asks = useMachineAsks(panelId).filter((a) => a.tool);
  const [now, setNow] = useState(() => Date.now());
  const recent = asks.some((a) => a.endedAt && now - a.endedAt < ANSWERED_MS);
  useEffect(() => {
    if (!recent) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [recent]);
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (ask: MachineAsk, verdict: "run" | "decline" | "allow") => {
    setBusy(ask.id);
    try {
      await api(`/api/boards/${encodeURIComponent(board())}/apps/${panelId}/asks/${ask.id}/${verdict}`, { method: "POST", json: {} });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  const shown = asks.filter((a) => a.state === "waiting" || (a.endedAt && now - a.endedAt < ANSWERED_MS));
  if (!shown.length) return null;
  return (
    <div className="app-asks" onPointerDown={(e) => e.stopPropagation()}>
      <MachineAskList asks={shown.slice(-3)} viewer={viewer} now={now} busy={busy} onAnswer={answer} />
    </div>
  );
}

function StatePill({ m, noEngine, away }: { m: MachineState; noEngine: boolean; away?: boolean }) {
  if (away)
    return (
      <span className="machine-state is-warn">
        <span className="f-dot is-warn" />
        Out of reach
      </span>
    );
  const tone = noEngine ? "warn" : machineTone(m.state);
  return (
    <span className={`machine-state is-${tone}`}>
      <span className={`f-dot${tone === "idle" ? "" : ` is-${tone}`}${m.state === "running" || m.state === "pulling" || m.state === "starting" ? " is-live" : ""}`} />
      {noEngine ? "No engine" : MACHINE_STATE_WORD[m.state]}
    </span>
  );
}

/**
 * Pulling or starting (2026-11-17, redrawn): the centred column, the mark breathing, what it's doing, and a bar
 * of the bytes pulled when the engine says how many. Also drawn on #/design.
 */
export function PullWell({ m }: { m: Pick<MachineState, "state" | "detail" | "image" | "pull"> }) {
  const pct = m.pull && m.pull.total ? Math.min(100, (m.pull.done / m.pull.total) * 100) : null;
  return (
    <div className="machine-progress machine-hero machine-pull">
      <span className="machine-hero-mark is-busy">{m.state === "pulling" ? <PullGlyph size={22} /> : <PlayGlyph size={22} />}</span>
      <div className="machine-hero-title">{m.state === "pulling" ? `Pulling ${m.image ?? "the image"}` : "Starting"}</div>
      {pct !== null && (
        <div className="machine-pull-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
      )}
      <span className="machine-desk-said machine-copyable" onPointerDown={(e) => e.stopPropagation()}>
        <span className="f-dot is-warn is-live" />
        {m.detail ?? "Starting…"}
      </span>
    </div>
  );
}

function NoEngine({ engines }: { engines: EngineStatus[] }) {
  return (
    <>
      <div className="connector-offline">
        <div className="connector-offline-title">No container engine is running here</div>
        {engines.map((e) => (
          <div key={e.at ?? e.id} className="connector-offline-reason">
            {e.error ?? `${e.name}: not answering`}
          </div>
        ))}
        <div className="connector-offline-reason">
          Install Kiri (<code>npm run kiri:install</code> in Foundation's folder, or runkiri.com) or Docker Desktop; this card finds it by itself.
        </div>
      </div>
      <div className="connector-foot">
        <button className="f-pill is-agent" onClick={() => askAgent("The machine card says no container engine is running. Help me set up Kiri or Docker on this computer so Foundation can start machines (SPEC §6).")}>
          ✦ How do I set one up?
        </button>
      </div>
    </>
  );
}

interface EngineImage {
  tag: string;
  size: number;
}
interface ArchiveFile {
  id: string;
  name: string;
  size: number;
}

function Picker({ panel, m, engine, viewer }: { panel: PanelMeta; m: MachineState; engine?: EngineStatus; viewer: boolean }) {
  const [image, setImage] = useState(m.image ?? "");
  const [have, setHave] = useState<EngineImage[]>([]);
  const [tars, setTars] = useState<ArchiveFile[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [desk, setDesk] = useState(Boolean(m.wantDesktop));
  const [ports, setPorts] = useState((m.wantPorts ?? []).join(", "));
  useEffect(() => setImage(m.image ?? ""), [m.image]);
  useEffect(() => {
    if (!engine) return;
    api<{ images: EngineImage[] }>(`/api/machines/images?engine=${engine.id}`)
      .then((r) => setHave(r.images.slice(0, 8)))
      .catch(() => setHave([]));
    api<{ files: ArchiveFile[] }>(`/api/files?board=${encodeURIComponent(board())}`)
      .then((r) => setTars(r.files.filter((f) => /\.(tar|tar\.gz|tgz)$/i.test(f.name)).slice(0, 4)))
      .catch(() => setTars([]));
  }, [engine?.id]);

  const load = async (f: ArchiveFile) => {
    setLoading(f.id);
    try {
      const r = await api<{ images: string[] }>(`/api/boards/${encodeURIComponent(board())}/machines/load`, { method: "POST", json: { fileId: f.id, engine: engine?.id } });
      toast(`Loaded ${r.images.join(", ") || f.name}`, "ok");
      if (r.images[0]) setImage(r.images[0]);
      setHave((h) => [...r.images.map((tag) => ({ tag, size: f.size })), ...h]);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setLoading(null);
    }
  };
  return (
    <MachinePickerView
      m={m}
      proposedText={panel.text}
      engineName={engine?.name}
      asleep={Boolean(engine?.asleep)}
      image={image}
      have={have.map((h) => h.tag)}
      tars={tars}
      loading={loading}
      desk={desk}
      viewer={viewer}
      onImage={setImage}
      onLoad={(f) => void load(f as ArchiveFile)}
      onDesk={setDesk}
      ports={ports}
      onPorts={setPorts}
      start={<StartButton panel={panel} m={m} image={image} engine={engine} viewer={viewer} desktop={desk && desktopRecipe(image || m.image || "") !== "no"} ports={parsePorts(ports)} />}
    />
  );
}

/** a distro's name as it's written */
const DISTRO_NAME: Record<string, string> = { ubuntu: "Ubuntu", debian: "Debian", alpine: "Alpine", fedora: "Fedora", arch: "Arch", rocky: "Rocky", opensuse: "openSUSE" };

/**
 * Not started: what to start, in one centred column (2026-11-17, Josh: "design the vm start interface …
 * better centering, making the text larger, and using icons to indicate the right features"). A title at
 * 18 and what you get at 13.5; the distros as tiles, each with its name, its image in code type and the
 * icons of what it can have (a terminal always; a desktop where Add a desktop has a recipe); what the engine
 * has already and saved images as chips; a free field; **With a desktop** as a row led by its icon (greyed,
 * with the reason, for an image that can't have one); Start as the one blue action, wide, with its terms as
 * icon-led chips. Also drawn on #/design.
 */
export function MachinePickerView(p: {
  m: Pick<MachineState, "proposedBy" | "state" | "detail" | "image">;
  proposedText?: string;
  engineName?: string;
  asleep?: boolean;
  image: string;
  have: string[];
  tars: { id: string; name: string }[];
  loading?: string | null;
  desk: boolean;
  viewer: boolean;
  onImage?: (img: string) => void;
  onLoad?: (f: { id: string; name: string }) => void;
  onDesk?: (on: boolean) => void;
  ports?: string;
  onPorts?: (v: string) => void;
  hubStill?: Parameters<typeof HubSearch>[0]["still"];
  start: ReactNode;
}) {
  const { m, viewer } = p;
  const engine = p.engineName ?? "the engine";
  const recipe = desktopRecipe(p.image || m.image || "");
  return (
    <div className="machine-picker">
      <div className="machine-hero machine-picker-col">
        {m.proposedBy && (
          <div className="machine-proposed">
            <AgentGlyph size={14} /> Proposed by {m.proposedBy}
            {p.proposedText ? `: ${p.proposedText}` : ""}
          </div>
        )}
        {m.state === "error" && m.detail && (
          <div className="machine-error machine-copyable" onPointerDown={(e) => e.stopPropagation()}>
            {m.detail}
          </div>
        )}
        {m.state !== "error" && m.detail && !m.proposedBy && <div className="machine-note">{m.detail}</div>}
        <span className="machine-hero-mark">
          <TerminalGlyph size={22} />
        </span>
        <div className="machine-hero-title">Start a machine</div>
        <div className="machine-hero-lede">
          A Linux machine on {engine}, with a disk of its own and a terminal everyone here shares.{p.asleep ? ` ${engine} is asleep: Start wakes it.` : ""}
        </div>
        <div className="machine-distros" role="radiogroup" aria-label="A Linux machine">
          {MACHINE_DISTROS.map((d) => {
            const can = desktopRecipe(d.image) === "yes";
            return (
              <button key={d.id} role="radio" aria-checked={p.image === d.image} className={`machine-distro${p.image === d.image ? " is-on" : ""}`} disabled={viewer} onClick={() => p.onImage?.(d.image)} data-tip={can ? `${d.image} · a terminal, and a desktop if you want one` : `${d.image} · a terminal (no desktop recipe for it yet)`}>
                <span className="machine-distro-name">{DISTRO_NAME[d.id] ?? d.id}</span>
                <code className="machine-distro-image">{d.image.split("/").pop()}</code>
                <span className="machine-distro-feats" aria-hidden>
                  <TerminalGlyph size={14} />
                  {can && <DesktopGlyph size={14} />}
                </span>
              </button>
            );
          })}
        </div>
        {p.have.length > 0 && (
          <>
            <div className="f-eyebrow">On {engine} already</div>
            <div className="machine-chips">
              {p.have.map((tag) => (
                <button key={tag} className={`machine-chip is-code${p.image === tag ? " is-on" : ""}`} disabled={viewer} onClick={() => p.onImage?.(tag)}>
                  {tag}
                </button>
              ))}
            </div>
          </>
        )}
        {p.tars.length > 0 && (
          <>
            <div className="f-eyebrow">Saved images in the archive</div>
            <div className="machine-chips">
              {p.tars.map((f) => (
                <button key={f.id} className="machine-chip is-code" disabled={viewer || (p.loading ?? null) !== null} onClick={() => p.onLoad?.(f)} data-tip={`Load ${f.name} into ${engine} (docker load). The file stays in the archive.`}>
                  {p.loading === f.id ? "Loading…" : `⇪ ${f.name}`}
                </button>
              ))}
            </div>
          </>
        )}
        <HubSearch image={p.image} viewer={viewer} onImage={(i) => p.onImage?.(i)} still={p.hubStill} />
        {p.image && !MACHINE_DISTROS.some((d) => d.image === p.image) && (
          <div className="machine-picked">
            <PackageGlyph size={16} /> <code>{p.image}</code>
          </div>
        )}
        <label className="machine-ports-field" data-tip="Container ports to publish on 127.0.0.1: each gets an address on the card, a Foundation link and, if you open one, a public link">
          <GlobeGlyph size={16} />
          <span>Web ports</span>
          <input value={p.ports ?? ""} disabled={viewer} spellCheck={false} placeholder="8080, 3000" inputMode="numeric" onChange={(e) => p.onPorts?.(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Web ports" />
        </label>
        {!viewer && (
          <label className={`machine-option machine-with-desk${recipe === "no" ? " is-off" : ""}`} data-tip={recipe === "no" ? undefined : "Installed once it runs: an X server, XFCE and VNC, a few minutes. You can add it later too, from the card's Desktop view."}>
            <input type="checkbox" checked={p.desk && recipe !== "no"} disabled={recipe === "no"} onChange={(e) => p.onDesk?.(e.target.checked)} />
            <span className="machine-option-glyph">
              <DesktopGlyph />
            </span>
            <span className="machine-option-words">
              <b>With a desktop</b>
              <span>{recipe === "no" ? "No desktop recipe for this image yet: Ubuntu, Debian and Alpine have one" : recipe === "maybe" ? "If it's built on Debian, Ubuntu or Alpine · a few minutes more" : "See it and use it on this card · a few minutes more"}</span>
            </span>
          </label>
        )}
        {p.start}
      </div>
    </div>
  );
}

/** "8080, 3000" → [8080, 3000]: whole numbers 1–65535, eight at most */
export function parsePorts(text: string): number[] {
  return [...new Set((text.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0 && n < 65536))].slice(0, 8);
}

function StartButton({ panel, m, image, engine, viewer, desktop, ports }: { panel: PanelMeta; m: MachineState; image: string; engine?: EngineStatus; viewer: boolean; desktop?: boolean; ports?: number[] }) {
  const [busy, setBusy] = useState(false);
  if (viewer) return <div className="machine-note">View only: someone who can edit this board starts it.</div>;
  const start = async () => {
    setBusy(true);
    try {
      await api(`/api/boards/${encodeURIComponent(board())}/machines/${panel.id}/start`, { method: "POST", json: { image: image || undefined, engine: engine?.id, ...(ports?.length ? { ports } : {}), ...(desktop ? { desktop: true } : {}) } });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return <StartLine label={busy ? "Starting…" : `Start ${image || m.image || ""} on ${engine?.name ?? "the engine"}`} disabled={busy || !(image || m.image)} onStart={() => void start()} wakes={engine?.asleep ? engine.name : undefined} desktop={desktop} />;
}

/** Start, wide and blue, and its terms as icon-led chips. Also drawn on #/design. */
export function StartLine({ label, disabled, onStart, wakes, desktop }: { label: string; disabled?: boolean; onStart?: () => void; wakes?: string; desktop?: boolean }) {
  return (
    <div className="machine-start machine-hero-go">
      <button className="f-pill is-accent machine-hero-button" disabled={disabled} onClick={onStart}>
        {label}
      </button>
      <ul className="machine-hero-terms machine-terms">
        {wakes && <li>Wakes {wakes} first</li>}
        <li>
          <PullGlyph size={14} /> Pulls it if needed{desktop ? ", then installs a desktop" : ""}
        </li>
        <li>
          <LockGlyph size={14} /> Ports on 127.0.0.1 only
        </li>
        <li>
          <ShieldGlyph size={14} /> Nothing from this computer mounted
        </li>
      </ul>
    </div>
  );
}

// ---------- the terminal ----------

const Terminal = memo(function Terminal({ panelId, name, canType }: { panelId: string; name: string; canType: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  const boardId = useMemo(board, []);
  const mt = useRef<MachineTerminal | null>(null);
  // the caret is in the shell: the card says so, and it is in use (the wheel scrolls its scrollback)
  const [hasKeys, setHasKeys] = useState(false);
  const [hasSel, setHasSel] = useState(false);
  const [flash, say] = useFlash();
  const inUse = useUi().engaged === panelId;
  const well = useRef<HTMLDivElement>(null);
  useRingWidth(well, hasKeys);
  // a click elsewhere (or anything else that ends the card's use) takes the keys back from the shell
  useEffect(() => {
    if (!inUse && el.current?.contains(document.activeElement)) mt.current?.term.blur();
  }, [inUse]);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const t = mountTerminal(node, {
      boardId,
      panelId,
      canType,
      onNote: setNote,
      onPeople: setPeople,
      onCopied: (n) => say(n ? `Copied ${n} character${n === 1 ? "" : "s"}` : "Your browser didn't allow the copy", n ? "ok" : "warn"),
    });
    mt.current = t;
    const sel = t.term.onSelectionChange(() => setHasSel(t.term.hasSelection()));
    const onFocus = () => {
      setHasKeys(true);
      putInUse(panelId);
    };
    const onBlur = (e: FocusEvent) => {
      if (!node.contains(e.relatedTarget as Node | null)) setHasKeys(false);
    };
    // the one way out by keyboard: Esc twice (a single Esc is the shell's; both still reach it)
    const leave = escEscToLeave(() => {
      t.term.blur();
      if (getUi().engaged === panelId) setUi({ engaged: null });
    });
    const onEsc = (e: KeyboardEvent) => void leave(e);
    node.addEventListener("focusin", onFocus);
    node.addEventListener("focusout", onBlur);
    node.addEventListener("keydown", onEsc, true);
    // xterm measures in its own pixels; the board draws it scaled, so a selection landed off by the zoom (#53)
    const offMouse = unscaleMouse(node);
    return () => {
      offMouse();
      sel.dispose();
      node.removeEventListener("focusin", onFocus);
      node.removeEventListener("focusout", onBlur);
      node.removeEventListener("keydown", onEsc, true);
      mt.current = null;
      setHasKeys(false);
      t.dispose();
    };
  }, [boardId, panelId, canType]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async (text: string) => {
    if (!text) return say("Nothing to copy yet", "warn");
    say((await copyText(text)) ? copiedWords(text) : "Your browser didn't allow the copy", "ok");
  };
  const paste = async () => {
    const text = await readClipboard();
    if (text === null) return say("Your browser didn't let Foundation read the clipboard: press Ctrl+V in the terminal", "warn");
    if (!text) return say("Your clipboard is empty", "warn");
    mt.current?.paste(text);
    mt.current?.focus();
    say(pastedWords(text));
  };
  return (
    <>
      <div ref={well} className={`machine-term-wrap${hasKeys ? " has-keys" : ""}`}>
        {/* keys go to the shell, not the board's shortcuts (lib/keysHeld.ts) */}
        <div ref={el} className="machine-term wheel-own" {...{ [HOLDS_KEYS]: "" }} onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} />
        {hasKeys && canType && <KeysLine />}
        {!canType && <div className="machine-watching">View only: you're watching</div>}
        {people.length > 1 && (
          <div className="machine-people" data-tip={people.join(", ")}>
            {people.length} here
          </div>
        )}
        {note && <div className="machine-closed">{note}</div>}
      </div>
      <MachineTools
        view="terminal"
        canType={canType}
        canCopy={hasSel}
        flash={flash}
        onCopy={() => void copy(mt.current?.selection() ?? "")}
        onCopyAll={() => void copy(mt.current?.all() ?? "")}
        onPaste={() => void paste()}
        onPopOut={() => void openMachineWindow(boardId, panelId, "terminal", name, !canType)}
      />
    </>
  );
});

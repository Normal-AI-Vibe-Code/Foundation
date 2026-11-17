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
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { boardMaps, MACHINE_DISTROS, type MachineAsk, type MachineState } from "@foundation/protocol";
import { onNight } from "@foundation/ui";
import { addPanel, addSectionAdjacent, getState, type PanelMeta } from "../state/store";
import { api, openSocket } from "../lib/api";
import { activeBoard } from "../sync/board";
import { askAgent, toast, useUi } from "../state/ui";
import { useOnScreen } from "./PanelView";
import { MACHINE_STATE_WORD, machineTone, portUrl } from "./machinePage";
import { unscaleMouse } from "./scaledMouse";
import { putInUse } from "../lib/cardUse";
import { HOLDS_KEYS, escEscToLeave } from "../lib/keysHeld";
import { getUi, setUi } from "../state/ui";
import { KeysLine, useRingWidth } from "./MachineViewBits";
import { AgentUse, Desktop, ViewSwitch, useMachineView } from "./MachineViewDesktop";
import { IoStrip } from "./MachineViewIo";

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
      <div className="machine-head">
        <StatePill m={m} noEngine={noEngine && m.state !== "running"} away={Boolean(engine?.asleep && m.containerId)} />
        {engine && (
          <span className="machine-engine" data-tip={engine.asleep ? `${engine.name} is installed here and asleep: Start wakes it` : `${engine.name} ${engine.version ?? ""}: the engine this machine runs on`}>
            {engine.name} {engine.asleep ? "· asleep" : engine.version}
          </span>
        )}
        {m.image && <code className="machine-image">{m.image}</code>}
        {m.state === "running" && <ViewSwitch view={view} onView={setView} />}
        {m.state === "running" && <Ports panel={panel} m={m} />}
      </div>
      <MachineAsks panelId={panel.id} viewer={viewer} />
      {m.state === "running" && <AgentUse panelId={panel.id} m={m} viewer={viewer} view={view} onWatch={() => setView("desktop")} />}
      {noEngine && m.state !== "running" ? (
        <NoEngine engines={engines!} />
      ) : m.state === "running" ? (
        !onScreen ? (
          <div className="machine-poster">{m.name} is running</div>
        ) : view === "desktop" ? (
          <Desktop panel={panel} m={m} viewer={viewer} />
        ) : (
          <Terminal panelId={panel.id} canType={!viewer} />
        )
      ) : m.state === "pulling" || m.state === "starting" ? (
        <div className="machine-progress">
          <span className="f-dot is-warn is-live" />
          <span>{m.detail ?? "Starting…"}</span>
        </div>
      ) : m.state === "stopped" && m.containerId ? (
        <div className="machine-well">
          <div className="connector-offline-title">{engine?.asleep ? `${m.name} is out of reach` : `${m.name} is stopped`}</div>
          <div className="connector-offline-reason">{m.detail ?? "Its disk is kept: Start runs it again."}</div>
        </div>
      ) : (
        <Picker panel={panel} m={m} engine={engine} viewer={viewer} />
      )}
      {m.state === "running" && onScreen && <IoStrip panel={panel} viewer={viewer} />}
      {!noEngine && <Controls panel={panel} m={m} viewer={viewer} engine={engine} />}
    </div>
  );
}

// ---------- agents' commands, waiting for a person ----------

/** answered asks stay on the card this long, so people see what became of them */
const ANSWERED_MS = 2 * 60_000;

/** the commands agents asked to run here: the board's `machineAsks`, written by the server alone */
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
  const answer = async (ask: MachineAsk, verdict: "run" | "decline") => {
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
export function MachineAskList({ asks, viewer, now, busy, onAnswer }: { asks: MachineAsk[]; viewer: boolean; now: number; busy?: string | null; onAnswer?: (a: MachineAsk, verdict: "run" | "decline") => void }) {
  return (
    <div className="machine-asks">
      {asks.map((a) =>
        a.state === "waiting" ? (
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

/** a machine's published ports: each opens as a web page in the section, or in the browser */
function Ports({ panel, m }: { panel: PanelMeta; m: MachineState }) {
  if (!m.ports?.length) return null;
  return (
    <span className="machine-ports">
      {m.ports.map((p) => {
        const url = portUrl(p.host);
        return (
          <button
            key={p.port}
            className="f-pill machine-port"
            data-tip={`Port ${p.port} in the machine, on ${url} here. Opens it as a page in this section.`}
            onClick={() => {
              // a machine that fills its section gets a section beside it for the page (a card behind it would be hidden)
              const hosted = getState().sections[panel.sectionId]?.host === panel.id;
              const where = hosted ? addSectionAdjacent(panel.sectionId, "right") : panel.sectionId;
              // the page knows where it came from, so it follows the machine (stopped, removed, running again)
              if (where) addPanel(where, { panel: "link", name: `${m.name}:${p.port}`, url, text: `Port ${p.port} of the machine ${m.name}`, fromMachine: { panel: panel.id, port: p.port, name: m.name } });
            }}
          >
            :{p.port} ↗
          </button>
        );
      })}
    </span>
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

  const pick = (img: string) => setImage(img);
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
    <div className="machine-picker">
      {m.proposedBy && (
        <div className="machine-proposed">
          <span className="f-dot is-agent" /> Proposed by {m.proposedBy}
          {panel.text ? `: ${panel.text}` : ""}
        </div>
      )}
      {m.state === "error" && m.detail && <div className="machine-error">{m.detail}</div>}
      {m.state !== "error" && m.detail && !m.proposedBy && <div className="machine-note">{m.detail}</div>}
      <div className="f-eyebrow">A Linux machine</div>
      <div className="machine-chips">
        {MACHINE_DISTROS.map((d) => (
          <button key={d.id} className={`machine-chip${image === d.image ? " is-on" : ""}`} disabled={viewer} onClick={() => pick(d.image)} data-tip={d.image}>
            {d.id}
          </button>
        ))}
      </div>
      {have.length > 0 && (
        <>
          <div className="f-eyebrow">On {engine?.name ?? "the engine"} already</div>
          <div className="machine-chips">
            {have.map((h) => (
              <button key={h.tag} className={`machine-chip is-code${image === h.tag ? " is-on" : ""}`} disabled={viewer} onClick={() => pick(h.tag)}>
                {h.tag}
              </button>
            ))}
          </div>
        </>
      )}
      {tars.length > 0 && (
        <>
          <div className="f-eyebrow">Saved images in the archive</div>
          <div className="machine-chips">
            {tars.map((f) => (
              <button key={f.id} className="machine-chip is-code" disabled={viewer || loading !== null} onClick={() => void load(f)} data-tip={`Load ${f.name} into ${engine?.name ?? "the engine"} (docker load). The file stays in the archive.`}>
                {loading === f.id ? "Loading…" : `⇪ ${f.name}`}
              </button>
            ))}
          </div>
        </>
      )}
      <input
        className="machine-field"
        value={image}
        disabled={viewer}
        spellCheck={false}
        placeholder="or any image: postgres:17, nginx:1.27, ghcr.io/…"
        onChange={(e) => setImage(e.target.value.trim())}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {!viewer && (
        <label className="machine-with-desk" data-tip="Adds a graphical desktop (an X server, XFCE and VNC) once it runs: packages installed in the machine, a few minutes. Ubuntu, Debian and Alpine images. You can add it later too, from the card's Desktop view.">
          <input type="checkbox" checked={desk} onChange={(e) => setDesk(e.target.checked)} />
          With a desktop
        </label>
      )}
      <StartButton panel={panel} m={m} image={image} engine={engine} viewer={viewer} desktop={desk} />
    </div>
  );
}

function StartButton({ panel, m, image, engine, viewer, desktop }: { panel: PanelMeta; m: MachineState; image: string; engine?: EngineStatus; viewer: boolean; desktop?: boolean }) {
  const [busy, setBusy] = useState(false);
  if (viewer) return <div className="machine-note">View only: someone who can edit this board starts it.</div>;
  const start = async () => {
    setBusy(true);
    try {
      await api(`/api/boards/${encodeURIComponent(board())}/machines/${panel.id}/start`, { method: "POST", json: { image: image || undefined, engine: engine?.id, ...(desktop ? { desktop: true } : {}) } });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="machine-start">
      <button className="f-pill is-accent" disabled={busy || !(image || m.image)} onClick={() => void start()}>
        {busy ? "Starting…" : `Start ${image || m.image || ""} on ${engine?.name ?? "the engine"}`}
      </button>
      <span className="machine-terms">
        {engine?.asleep ? `Wakes ${engine.name} first · ` : ""}Pulls it if needed{desktop ? " · then installs a desktop in it" : ""} · ports on 127.0.0.1 only · nothing from this computer mounted
      </span>
    </div>
  );
}

function Controls({ panel, m, viewer, engine }: { panel: PanelMeta; m: MachineState; viewer: boolean; engine?: EngineStatus }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [arm, setArm] = useState(false);
  useEffect(() => {
    if (!arm) return;
    const t = setTimeout(() => setArm(false), 3000);
    return () => clearTimeout(t);
  }, [arm]);
  if (viewer || !m.containerId || m.state === "absent") return null;
  const act = async (verb: "start" | "stop" | "restart" | "remove") => {
    if (verb === "remove" && !arm) return setArm(true);
    setBusy(verb);
    setArm(false);
    try {
      await machineAction(panel.id, verb, verb === "remove" ? { confirm: true } : {});
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  const running = m.state === "running";
  return (
    <div className="machine-controls">
      {!running && m.state !== "pulling" && m.state !== "starting" && (
        <button className="f-pill is-accent" disabled={busy !== null} onClick={() => void act("start")}>
          {busy === "start" ? "Starting…" : `Start on ${engine?.name ?? "the engine"}`}
        </button>
      )}
      {running && (
        <>
          <button className="f-pill" disabled={busy !== null} onClick={() => void act("stop")} data-tip="Stop it. The disk is kept; Start runs it again.">
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button className="f-pill" disabled={busy !== null} onClick={() => void act("restart")}>
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
        </>
      )}
      <span className="machine-name" data-tip={`The container is machine-${m.name}: \`kiri machine shell ${m.name}\` reaches it too`}>
        {m.name}
      </span>
      <button className={`f-pill machine-remove${arm ? " is-armed" : ""}`} disabled={busy !== null} onClick={() => void act("remove")} data-tip="Remove the machine and its disk. The card stays.">
        {busy === "remove" ? "Removing…" : arm ? "Remove it and its disk?" : "Remove"}
      </button>
    </div>
  );
}

// ---------- the terminal ----------

const TOKENS = {
  background: "--color-abyss",
  foreground: "--color-frost",
  cursor: "--color-pulse",
  selectionBackground: "--color-pulse",
  black: "--color-frost",
  brightBlack: "--color-dim",
  red: "--color-bad",
  brightRed: "--color-bad",
  green: "--color-ok",
  brightGreen: "--color-ok",
  yellow: "--color-warn",
  brightYellow: "--color-warn",
  blue: "--color-pulse",
  brightBlue: "--color-pulse",
  magenta: "--color-agent",
  brightMagenta: "--color-agent",
  cyan: "--color-moss",
  brightCyan: "--color-moss",
  white: "--color-mist",
  brightWhite: "--color-frost",
} as const;

/** each token resolved to a colour xterm can paint (night mixes and all), through one probe element */
export function themeFromTokens(el: HTMLElement): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(TOKENS)) {
    probe.style.color = k === "selectionBackground" ? `color-mix(in srgb, var(${v}) 28%, transparent)` : `var(${v})`;
    out[k] = getComputedStyle(probe).color;
  }
  probe.remove();
  out.cursorAccent = out.background;
  return out as ITheme;
}

const Terminal = memo(function Terminal({ panelId, canType }: { panelId: string; canType: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  const boardId = useMemo(board, []);
  const xterm = useRef<XTerm | null>(null);
  // the caret is in the shell: the card says so, and it is in use (the wheel scrolls its scrollback)
  const [hasKeys, setHasKeys] = useState(false);
  const inUse = useUi().engaged === panelId;
  const well = useRef<HTMLDivElement>(null);
  useRingWidth(well, hasKeys);
  // a click elsewhere (or anything else that ends the card's use) takes the keys back from the shell
  useEffect(() => {
    if (!inUse && el.current?.contains(document.activeElement)) xterm.current?.blur();
  }, [inUse]);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const font = getComputedStyle(node).getPropertyValue("--font-code").trim() || "monospace";
    const term = new XTerm({
      fontFamily: font,
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: canType,
      disableStdin: !canType,
      scrollback: 3000,
      theme: themeFromTokens(node),
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    xterm.current = term;
    const onFocus = () => {
      setHasKeys(true);
      putInUse(panelId);
    };
    const onBlur = (e: FocusEvent) => {
      if (!node.contains(e.relatedTarget as Node | null)) setHasKeys(false);
    };
    // the one way out by keyboard: Esc twice (a single Esc is the shell's; both still reach it)
    const leave = escEscToLeave(() => {
      term.blur();
      if (getUi().engaged === panelId) setUi({ engaged: null });
    });
    const onEsc = (e: KeyboardEvent) => void leave(e);
    node.addEventListener("focusin", onFocus);
    node.addEventListener("focusout", onBlur);
    node.addEventListener("keydown", onEsc, true);
    // xterm measures in its own pixels; the board draws it scaled, so a selection landed off by the zoom (#53)
    const offMouse = unscaleMouse(node);
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    let done = false; // the shell ended or the machine stopped: don't reconnect
    const sendSize = () => {
      if (canType && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
      sendSize();
    };
    // a dropped socket (the server restarted, the network blinked) comes back on its own; the screen is replayed
    const connect = async () => {
      let s: WebSocket;
      try {
        s = await openSocket(`/machines/${encodeURIComponent(boardId)}/${encodeURIComponent(panelId)}/tty`);
      } catch {
        if (done || tries >= 6) return setNote((n) => n ?? "The terminal closed.");
        setNote("Reconnecting…");
        retry = setTimeout(connect, 600 * 2 ** tries++);
        return;
      }
      if (done) return void s.close();
      ws = s;
      s.binaryType = "arraybuffer";
      let fresh = true;
      s.onopen = () => {
        tries = 0;
        setNote(null);
        refit();
      };
      s.onmessage = (e) => {
        if (typeof e.data === "string") {
          const c = JSON.parse(e.data) as { t: string; text?: string; people?: string[] };
          if (c.t === "hello" || c.t === "people") setPeople(c.people ?? []);
          if (c.t === "exit" || c.t === "error") {
            done = true;
            setNote(c.text ?? "The terminal closed.");
          }
          return;
        }
        if (fresh) {
          term.reset(); // the server sends the whole screen first
          fresh = false;
        }
        term.write(new Uint8Array(e.data as ArrayBuffer));
      };
      s.onclose = () => {
        if (done || tries >= 6) return setNote((n) => n ?? "The terminal closed.");
        setNote("Reconnecting…");
        retry = setTimeout(connect, 600 * 2 ** tries++);
      };
    };
    void connect();
    const enc = new TextEncoder();
    const data = term.onData((d) => {
      if (canType && ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(refit, 80);
    });
    ro.observe(node);
    const offNight = onNight(() => {
      // the tokens fade over 1.4 s: repaint at the midpoint and at the end
      setTimeout(() => (term.options.theme = themeFromTokens(node)), 700);
      setTimeout(() => (term.options.theme = themeFromTokens(node)), 1500);
    });
    return () => {
      done = true; // a ticket still on its way opens nothing
      clearTimeout(t);
      clearTimeout(retry);
      ro.disconnect();
      offMouse();
      offNight();
      data.dispose();
      node.removeEventListener("focusin", onFocus);
      node.removeEventListener("focusout", onBlur);
      node.removeEventListener("keydown", onEsc, true);
      xterm.current = null;
      setHasKeys(false);
      // this socket is done: its late close mustn't say "closed" over the next one (StrictMode mounts twice)
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        ws.close();
      }
      term.dispose();
    };
  }, [boardId, panelId, canType]);
  return (
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
  );
});

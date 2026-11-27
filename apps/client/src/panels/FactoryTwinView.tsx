/**
 * FactoryForm's digital twin on a card (2026-11-27): the `factoryform-twin` connector (apps/server/src/factorytwin.ts),
 * drawn two ways by the card's `source`:
 *
 *  - **run** (the default): the simulated run FactoryForm is playing (task, station, step, time, state), always
 *    marked *Simulated*; the station twins, open alerts, and whether the twin page is older than its source.
 *  - **cad**: the twin as files to take away: the floor (glTF, DXF) and each station cell (glTF), as FactoryForm
 *    makes them now.
 *
 * Honest when FactoryForm isn't there: not answering (and why), or answering without the twin API (an older
 * build). Then an admin at the server's own computer has **Start FactoryForm**: FactoryForm's own launcher, run
 * on that press only (the server refuses anyone else). The frames showing FactoryForm load again once it answers.
 */

import { useEffect, useState } from "react";
import type { PanelMeta } from "../state/store";
import { isHosted } from "../state/store";
import { api } from "../lib/api";
import { onConnectorChange } from "../lib/connectorEvents";
import { useCapabilities } from "../lib/capabilities";
import { toast, useUi } from "../state/ui";
import "./factorytwin.css";

export const TWIN_CONNECTOR = "factoryform-twin";
/** a window event: `{ origin }`, frames showing that origin load again (PanelView's LiveFrame) */
export const RELOAD_FRAMES = "foundation:reload-frames";

export interface TwinRun {
  id: string;
  station: string;
  task: string;
  taskName?: string;
  steps?: number;
  state: string;
  t: number;
  seconds: number;
  step: { index: number; id: string; label: string } | null;
  by?: string | null;
  source?: string | null;
  simulated: true;
}

export type FactoryTwin =
  | {
      ok: true;
      base: string;
      revision: string | null;
      stale: boolean | null;
      facility: { id: string; name: string } | null;
      twins: Array<{ id: string; name: string }>;
      run: TwinRun | null;
      alertsOpen: number;
      pages: { app: string; floor: string; stations: Array<{ id: string; name: string; url: string }> };
      cad: Array<{ label: string; url: string; format: "glb" | "dxf"; what: string }>;
      stations: Array<{ id: string; provenance?: string }>;
    }
  | { ok: false; base: string; older: true; reason: string };

export interface TwinConnectorState {
  ok: boolean;
  summary: string;
  url: string;
  live?: boolean;
  provenance?: string;
  provenanceLabel?: string;
  detail?: { twin?: FactoryTwin };
  checkedAt: number;
}

const secs = (n: number) => (n >= 100 ? `${Math.round(n)} s` : `${n.toFixed(1)} s`);

function ago(at: number, now = Date.now()) {
  const s = Math.max(1, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

const RUN_TONE: Record<string, "ok" | "warn" | "idle"> = { running: "ok", paused: "warn" };

export interface TwinViewProps {
  name?: string;
  view: "run" | "cad";
  state: TwinConnectorState | null;
  /** an admin at a server that may start FactoryForm here */
  canStart: boolean;
  starting: boolean;
  onStart?: () => void;
}

/** the card as drawn: also the specimen on #/design */
export function FactoryTwinView({ name, view, state: st, canStart, starting, onStart }: TwinViewProps) {
  const twin = st?.detail?.twin;
  const older = Boolean(twin && !twin.ok);
  const down = Boolean(st && !st.ok);
  const reason = older && twin && !twin.ok ? twin.reason : (st?.summary.replace(/^offline — /, "") ?? "");
  const up = st?.ok && twin?.ok ? twin : null;
  return (
    <div className={`ftwin${down ? " is-offline" : ""}`}>
      {name && <div className="connector-name">{name}</div>}
      <div className="connector-head">
        <span className={`connector-status ${!st ? "is-checking" : st.ok ? "is-live" : "is-off"}`}>
          <span className={`f-dot ${!st ? "is-live" : st.ok ? "is-ok is-live" : "is-warn"}`} />
          {!st ? "Checking" : st.ok ? "Live" : older ? "Older FactoryForm" : "Offline"}
        </span>
        <span className="connector-role">{view === "cad" ? "The twin as CAD" : "FactoryForm's digital twin"}</span>
        {st?.live && (
          <span className="connector-live" title="Updates arrive live from FactoryForm's twin stream">
            live
          </span>
        )}
        {st?.provenance && (
          <span className="connector-provenance" title={st.provenance}>
            {st.provenanceLabel ?? "demo data"}
          </span>
        )}
      </div>

      {down ? (
        <div className="connector-offline">
          <div className="connector-offline-title">{older ? "This FactoryForm has no twin API" : "FactoryForm isn't answering"}</div>
          <div className="connector-offline-reason">{reason}</div>
          {canStart ? (
            <button type="button" className="f-pill is-accent ftwin-start" disabled={starting} onClick={onStart}>
              {starting ? "Starting FactoryForm…" : older ? "Start the current FactoryForm" : "Start FactoryForm"}
            </button>
          ) : (
            <div className="ftwin-hint">An admin at the computer this server runs on can start it here.</div>
          )}
          {starting && <div className="ftwin-hint">It builds its page first when that is out of date, which can take a minute or two.</div>}
        </div>
      ) : !up ? (
        <div className="connector-summary">Reaching FactoryForm…</div>
      ) : view === "cad" ? (
        <TwinCad twin={up} />
      ) : (
        <TwinRunView twin={up} />
      )}

      <div className="connector-foot">
        {up && (
          <a className="f-pill" href={view === "cad" ? up.pages.floor : up.pages.app} target="_blank" rel="noopener noreferrer">
            {view === "cad" ? "Floor twin ↗" : "Open FactoryForm ↗"}
          </a>
        )}
        {st && <span className="connector-checked">checked {ago(st.checkedAt)}</span>}
      </div>
    </div>
  );
}

function TwinRunView({ twin }: { twin: Extract<FactoryTwin, { ok: true }> }) {
  const run = twin.run;
  const share = run && run.seconds > 0 ? Math.min(1, Math.max(0, run.t / run.seconds)) : 0;
  return (
    <>
      {run ? (
        <div className="ftwin-run">
          <div className="ftwin-run-head">
            <span className="ftwin-sim" title="FactoryForm's runs are simulated: nothing here moves a robot">
              Simulated
            </span>
            <span className={`ftwin-state tone-${RUN_TONE[run.state] ?? "idle"}`}>{run.state}</span>
          </div>
          <div className="ftwin-task">{run.taskName ?? run.task}</div>
          <div className="ftwin-where">
            on <b>{run.station}</b>
            {run.by ? ` · run by ${run.by}` : ""}
          </div>
          <div className="ftwin-step">
            {run.step ? (
              <>
                Step {run.step.index + 1}
                {run.steps ? ` of ${run.steps}` : ""} · {run.step.label}
              </>
            ) : (
              "Between steps"
            )}
          </div>
          <div className="ftwin-bar" role="progressbar" aria-valuemin={0} aria-valuemax={run.seconds} aria-valuenow={run.t} aria-label="Time through the run">
            <span style={{ transform: `scaleX(${share})` }} />
          </div>
          <div className="ftwin-time">
            {secs(run.t)} of {secs(run.seconds)}
          </div>
        </div>
      ) : (
        <div className="ftwin-run is-empty">
          <div className="ftwin-task">No simulated run</div>
          <div className="ftwin-where">Nothing has run since FactoryForm started. Control starts runs; this card follows them as they move.</div>
        </div>
      )}
      <div className="connector-metrics">
        <div className="metric">
          <div className="metric-value">{twin.twins.length}</div>
          <div className="metric-label">Station twins</div>
        </div>
        <div className={`metric${twin.alertsOpen ? " tone-warn" : ""}`}>
          <div className="metric-value">{twin.alertsOpen}</div>
          <div className="metric-label">Open alerts</div>
        </div>
        <div className={`metric${twin.stale ? " tone-warn" : ""}`} title={twin.stale ? "FactoryForm's page was built before its latest source: npm run serve (or npm run build) in FactoryForm rebuilds it" : undefined}>
          <div className="metric-value is-word">{twin.stale === null ? "unknown" : twin.stale ? "stale" : "current"}</div>
          <div className="metric-label">Twin page</div>
        </div>
      </div>
    </>
  );
}

function TwinCad({ twin }: { twin: Extract<FactoryTwin, { ok: true }> }) {
  if (!twin.cad.length) return <div className="connector-summary is-small">FactoryForm has no floor or station twin to export yet.</div>;
  return (
    <ul className="ftwin-cad">
      {twin.cad.map((c) => (
        <li key={c.url}>
          <a href={c.url} target="_blank" rel="noopener noreferrer" download title={c.url}>
            <span className={`ftwin-format is-${c.format}`}>{c.format.toUpperCase()}</span>
            <span className="ftwin-cad-label">{c.label.replace(/ · (glTF|DXF)(,.*)?$/, "$2").replace(/^, /, "")}</span>
            <span className="ftwin-cad-what">{c.what}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** the card on a grid: reads the connector while on screen, refetches as FactoryForm's stream says it moved */
export function FactoryTwinBody({ panel, live }: { panel: PanelMeta; live: boolean }) {
  const ui = useUi();
  const caps = useCapabilities();
  const [st, setSt] = useState<TwinConnectorState | null>(null);
  const [starting, setStarting] = useState(false);
  const load = () =>
    api<TwinConnectorState>(`/api/connectors/${TWIN_CONNECTOR}`)
      .then((s) => setSt(s))
      .catch(() => {});
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const get = () =>
      api<TwinConnectorState>(`/api/connectors/${TWIN_CONNECTOR}`)
        .then((s) => !stop && setSt(s))
        .catch(() => {});
    void get();
    const t = setInterval(get, 20_000);
    const off = onConnectorChange(TWIN_CONNECTOR, () => void get());
    return () => {
      stop = true;
      clearInterval(t);
      off();
    };
  }, [live]);
  const start = async () => {
    setStarting(true);
    try {
      const r = await api<{ state: "started" | "running"; url: string }>("/api/factoryform/start", { method: "POST", json: {} });
      toast(r.state === "started" ? `FactoryForm started at ${r.url.replace(/^https?:\/\//, "")}` : "FactoryForm was already running", "ok");
      try {
        window.dispatchEvent(new CustomEvent(RELOAD_FRAMES, { detail: { origin: new URL(r.url).origin } }));
      } catch {
        /* not an address */
      }
      await load();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setStarting(false);
    }
  };
  const view = panel.source === "cad" ? "cad" : "run";
  return (
    <FactoryTwinView
      name={isHosted(panel) ? undefined : panel.name}
      view={view}
      state={st}
      canStart={ui.role === "admin" && caps.local.factoryform}
      starting={starting}
      onStart={() => void start()}
    />
  );
}

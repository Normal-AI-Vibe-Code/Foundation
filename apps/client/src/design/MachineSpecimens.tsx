/**
 * #/design → Machines, the parts redrawn on 2026-11-17 (Josh: "we can do a lot better with this Kiri interface"):
 * the head's two rows (actions in the title row; the views and the address bar with Share), Share's panel,
 * Docker Hub in Start, Access, the functions, a pull, and Kubernetes (a node's well, the Cluster tab). Drawn
 * with the real components, still: nothing here presses the server.
 */

import type { MachineState } from "@foundation/protocol";
import { AddressBar, MachineActions, SharePanel } from "../panels/MachineBar";
import { AccessView } from "../panels/MachineAccess";
import { FunctionsView } from "../panels/MachineFunctions";
import { HubSearch } from "../panels/MachineHub";
import { ClusterView, ClusterWell } from "../panels/MachineCluster";
import { ViewSwitch } from "../panels/MachineViewDesktop";
import { PullWell } from "../panels/MachineView";

const now = Date.now();
const running: MachineState = {
  name: "build-box",
  image: "ubuntu:24.04",
  engine: "kiri",
  state: "running",
  containerId: "c1",
  ports: [
    { port: 8080, host: 49153 },
    { port: 3000, host: 49154 },
  ],
  shares: [{ port: 8080, url: "https://dense-river-cat-bloom.trycloudflare.com", by: "Ada", at: now - 4 * 60_000 }],

  desktop: { state: "ready" } as MachineState["desktop"],
};
const card = { id: "pnl_demo", sectionId: "sec_demo", name: "build-box" };

function Pill({ tone, word }: { tone: "ok" | "warn" | "idle" | "bad"; word: string }) {
  return (
    <span className={`machine-state is-${tone}`}>
      <span className={`f-dot${tone === "idle" ? "" : ` is-${tone}`}${tone === "ok" ? " is-live" : ""}`} />
      {word}
    </span>
  );
}

function Head({ m, pill, armed, viewer = false }: { m: MachineState; pill: React.ReactNode; armed?: boolean; viewer?: boolean }) {
  return (
    <div className="machine-title-row">
      {pill}
      <span className="machine-title">{m.name}</span>
      <span className="machine-sub">
        <span className="machine-sub-engine">Kiri 0.1.18</span>
        <code className="machine-sub-image">{m.image}</code>
      </span>
      <MachineActions m={m} viewer={viewer} engineName="Kiri" armed={armed} />
    </div>
  );
}

export function MachineHeadSpecimens() {
  return (
    <>
      <div className="adapt-row">
        <div className="frame-card live-specimen" style={{ width: 900, height: 600 }}>
          <div className="machine-body is-running">
            <Head m={running} pill={<Pill tone="ok" word="Running" />} />
            <div className="machine-nav-row">
              <ViewSwitch view="access" panelId="pnl_demo" />
              <AddressBar panel={card} m={running} viewer={false} />
            </div>
            <AccessView panel={card} m={running} leave={{ agentsMay: { by: "Ada", at: now - 3 * 60_000 } }} viewer={false} waiting={1} now={now} />
          </div>
        </div>
      </div>
      <div className="adapt-row">
        <div className="frame-card live-specimen" style={{ width: 520, height: 160 }}>
          <div className="machine-body is-stopped">
            <Head m={{ ...running, state: "stopped", ports: undefined }} pill={<Pill tone="idle" word="Stopped" />} />
            <Head m={{ ...running, state: "stopped", ports: undefined }} pill={<Pill tone="idle" word="Stopped" />} armed />
          </div>
        </div>
        <div className="frame-card live-specimen" style={{ width: 400, height: 300 }}>
          <div className="machine-body is-pulling">
            <Head m={{ ...running, state: "pulling", containerId: undefined }} pill={<Pill tone="warn" word="Pulling" />} />
            <PullWell m={{ state: "pulling", image: "grafana/grafana:11.3.0", detail: "Pulling grafana/grafana:11.3.0: 121 MB of 196 MB", pull: { done: 121e6, total: 196e6 } }} />
          </div>
        </div>
      </div>
      <div className="adapt-row">
        <SharePanel panel={card} m={running} port={8080} viewer={false} still />
        <div className="frame-card live-specimen" style={{ width: 560, height: 520 }}>
          <div className="machine-body is-absent">
            <div className="machine-picker">
              <div className="machine-hero machine-picker-col">
                <HubSearch
                  image="postgres:17"
                  viewer={false}
                  onImage={() => {}}
                  still={{
                    q: "postgres",
                    repos: [
                      { name: "postgres", description: "The PostgreSQL object-relational database system provides reliability and data integrity.", stars: 14100, pulls: 1.2e9, official: true },
                      { name: "bitnami/postgresql", description: "Bitnami container image for PostgreSQL", stars: 290, pulls: 6.1e8, official: false },
                      { name: "postgis/postgis", description: "PostGIS spatial database extension with PostgreSQL", stars: 1100, pulls: 7.4e7, official: false },
                    ],
                    open: "postgres",
                    tags: [
                      { name: "17", size: 158e6 },
                      { name: "17-alpine", size: 106e6 },
                      { name: "16", size: 155e6 },
                      { name: "latest", size: 158e6 },
                    ],
                  }}
                />
                <label className="machine-ports-field">
                  <span>Web ports</span>
                  <input defaultValue="5432" aria-label="Web ports" />
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="adapt-row">
        <div className="frame-card live-specimen" style={{ width: 640, height: 560 }}>
          <div className="machine-body is-running">
            <div className="machine-io-view">
              <FunctionsView
                m={{
                  functions: [
                    { name: "trim-resize", about: "Trims the empty edges off each picture and fits it in 1024 × 1024", in: "images", out: "images", last: { at: now - 90_000, by: "Ada", ok: true, took: 6, made: 6, ms: 4200 } },
                    { name: "describe", about: "Says each picture's size and how many colours it has, as JSON", in: "images", out: "json", last: { at: now - 30_000, by: "Ada", ok: true, took: 2, made: 0, ms: 900, text: '[{"name":"001-ada.png","w":1024,"h":1024,"colors":5120}]' } },
                    { name: "sprite-sheet", about: "Lays every picture side by side in one sheet", in: "images", out: "images", last: { at: now - 10_000, by: "Kai", ok: false, took: 0, made: 0, ms: 300, said: "nothing came in" } },
                  ],
                }}
                wiring={{ "trim-resize": { total: 8, fresh: 2, from: ["Collected · Anime"], to: ["Processed · Anime"] }, describe: { total: 8, fresh: 8, from: ["Collected · Anime"], to: [] }, "sprite-sheet": { total: 0, fresh: 0, from: [], to: [] } }}
                viewer={false}
                now={now}
              />
            </div>
          </div>
        </div>
        <div className="frame-card live-specimen" style={{ width: 520, height: 560 }}>
          <div className="machine-body is-absent">
            <ClusterWell m={{ name: "lab-server", state: "absent", image: "rancher/k3s:v1.31.4-k3s1", cluster: { id: "c1", name: "lab", role: "server" } }} viewer={false} />
          </div>
        </div>
      </div>
      <div className="adapt-row">
        <div className="frame-card live-specimen" style={{ width: 760, height: 540 }}>
          <div className="machine-body is-running">
            <ClusterView
              panel={card}
              m={{ ...running, name: "lab-server", cluster: { id: "c1", name: "lab", role: "server" } }}
              viewer={false}
              still={{
                nodes: [
                  { name: "lab-server", ready: true, role: "server", card: "a" },
                  { name: "lab-worker-1", ready: true, role: "agent", card: "b" },
                  { name: "lab-worker-2", ready: false, role: "agent", card: "c" },
                ],
                pods: [
                  { ns: "default", name: "web", phase: "Running", node: "lab-worker-1", ready: "1/1", restarts: 0, image: "nginx:1.27", card: "d" },
                  { ns: "default", name: "cache", phase: "Pending", ready: "0/1", restarts: 0, image: "redis:7" },
                ],
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

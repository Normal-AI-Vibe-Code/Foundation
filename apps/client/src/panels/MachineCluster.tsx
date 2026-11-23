/**
 * Kubernetes on machine cards (2026-11-17, Josh: "options to start a kubernetes cluster and pods … moved out into
 * different sections in Foundation to see their terminal"; the server: apps/server/src/machinecluster.ts).
 *
 *   ClusterWell  a node not running yet: the cluster's mark, what it is (k3s, a server and n workers, each its
 *                own card), that its nodes run privileged and why, and Start the cluster (a person's press)
 *   ClusterView  the server's Cluster tab: its nodes (ready or not, each with the way to its card), every pod
 *                (phase, node, ready, restarts, image; Open as a card, Delete), Run a pod, Add a worker, and
 *                Copy kubeconfig (for kubectl on this computer, through the published 6443)
 *   PodWell      a pod's card whose pod isn't running: its phase in words
 */

import { ErrorCard } from "../components/ErrorCard";
import { useEffect, useState } from "react";
import type { MachineState, PanelDoc } from "@foundation/protocol";
import { api } from "../lib/api";
import { requestSnap } from "../state/store";
import { toast } from "../state/ui";
import { boardId } from "./MachineViewBits";
import { copyText } from "./machineTerminal";
import { ClusterGlyph, CopyGlyph, LockGlyph, PlayGlyph, PlusGlyph, PopOutGlyph, TrashGlyph, WarnGlyph } from "../shell/glyphs";

interface Node {
  name: string;
  ready: boolean;
  role: "server" | "agent";
  card?: string;
  version?: string;
}
interface Pod {
  ns: string;
  name: string;
  phase: string;
  node?: string;
  ready: string;
  restarts: number;
  image?: string;
  card?: string;
}

const base = () => `/api/boards/${encodeURIComponent(boardId())}/clusters`;

/** a node that isn't running: start the whole cluster. Also drawn on #/design. */
export function ClusterWell({ m, viewer, busy, onStart }: { m: MachineState; viewer: boolean; busy?: boolean; onStart?: () => void }) {
  const cl = m.cluster!;
  const server = cl.role === "server";
  return (
    <div className="machine-well machine-hero machine-cluster-well" data-cluster-well>
      <span className={`machine-hero-mark${m.state === "error" ? " is-warn" : ""}`}>{m.state === "error" ? <WarnGlyph size={22} /> : <ClusterGlyph size={22} />}</span>
      <div className="machine-hero-title">
        {server ? "The server" : "A worker"} of the cluster {cl.name}
      </div>
      <div className="machine-hero-lede machine-copyable" onPointerDown={(e) => e.stopPropagation()}>
        {m.state === "error" && m.detail ? m.detail : `Kubernetes (k3s) on machines of its own: a server and its workers, each a card you can move to any section, with its own terminal. ${server ? "Its Cluster tab shows the nodes and pods once it runs." : `It joins ${cl.server ?? "the server"} by name on the cluster's own network.`}`}
      </div>
      <ul className="machine-feats">
        <li>
          <ClusterGlyph />
          <span>
            <b>Every node a card</b> · move one anywhere to see its terminal
          </span>
        </li>
        <li>
          <PopOutGlyph />
          <span>
            <b>Pods as cards too</b> · open any pod and its terminal is kubectl exec into it
          </span>
        </li>
        <li className="is-warn">
          <LockGlyph />
          <span>
            <b>Privileged</b> · k3s needs it: a node can reach the engine's kernel that every machine here shares
          </span>
        </li>
      </ul>
      {viewer ? (
        <div className="machine-note">View only: someone who can edit this board starts it.</div>
      ) : (
        <div className="machine-hero-go">
          <button className="f-pill is-accent machine-hero-button" disabled={busy} onClick={onStart} data-cluster-start>
            <PlayGlyph size={15} /> {busy ? "Starting…" : m.state === "error" ? "Try again" : "Start the cluster"}
          </button>
          <ul className="machine-hero-terms machine-terms">
            <li>Pulls rancher/k3s (about 75 MB) · each node privileged · ports on 127.0.0.1 only</li>
          </ul>
        </div>
      )}
    </div>
  );
}

/** a node's well on a card: Start the cluster pressed through the server */
export function ClusterStart({ m, viewer }: { m: MachineState; viewer: boolean }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await api(`${base()}/${m.cluster!.id}/start`, { method: "POST", json: {} });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return <ClusterWell m={m} viewer={viewer} busy={busy} onStart={() => void start()} />;
}

/** a pod's card whose pod isn't running */
export function PodWell({ m }: { m: MachineState }) {
  return (
    <div className="machine-well machine-hero">
      <span className="machine-hero-mark">
        <ClusterGlyph size={22} />
      </span>
      <div className="machine-hero-title">
        The pod {m.pod?.ns}/{m.pod?.name}
      </div>
      <div className="machine-hero-lede">{m.detail ?? "Its cluster's server card reads it while it's on screen."}</div>
    </div>
  );
}

/** the Cluster tab. Also drawn on #/design (`still`). */
export function ClusterView({ panel, m, viewer, still }: { panel: Pick<PanelDoc, "id" | "sectionId">; m: MachineState; viewer: boolean; still?: { nodes: Node[]; pods: Pod[] } }) {
  const [nodes, setNodes] = useState<Node[]>(still?.nodes ?? []);
  const [pods, setPods] = useState<Pod[]>(still?.pods ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [image, setImage] = useState("nginx:1.27");
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  useEffect(() => {
    if (still) return;
    let stop = false;
    const load = () =>
      api<{ nodes: Node[]; pods: Pod[] }>(`${base()}/${panel.id}`)
        .then((r) => !stop && (setNodes(r.nodes), setPods(r.pods), setErr(null)))
        .catch((e) => !stop && setErr((e as Error).message));
    void load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [panel.id, still]);
  const go = async (what: string, path: string, json: object, ok?: string) => {
    setBusy(what);
    try {
      await api(`${base()}/${panel.id}${path}`, { method: "POST", json });
      if (ok) toast(ok, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  const copyConfig = async () => {
    try {
      const r = await api<{ kubeconfig: string }>(`${base()}/${panel.id}/kubeconfig`);
      toast((await copyText(r.kubeconfig)) ? "kubeconfig copied: save it as ~/.kube/config, or point KUBECONFIG at it" : "Your browser didn't allow the copy", "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  const shown = pods.filter((p) => showSystem || p.ns !== "kube-system");
  const ready = nodes.filter((n) => n.ready).length;
  return (
    <div className="machine-cluster" data-cluster-view={panel.id}>
      <div className="machine-cluster-head">
        <span className="machine-cluster-title">
          <ClusterGlyph size={18} /> {m.cluster?.name}
        </span>
        <span className="machine-cluster-sum">
          k3s · {ready} of {nodes.length} node{nodes.length === 1 ? "" : "s"} ready · {pods.filter((p) => p.ns !== "kube-system").length} pod{pods.length === 1 ? "" : "s"} of yours
        </span>
        {!viewer && (
          <>
            <button className="f-pill machine-cluster-btn" disabled={busy === "worker"} onClick={() => void go("worker", "/workers", {}, "A worker is laid: Start the cluster runs it")} data-cluster-worker>
              <PlusGlyph size={13} /> Add a worker
            </button>
            <button className="f-pill machine-cluster-btn" onClick={() => void copyConfig()} data-tip="For kubectl on this computer: the cluster's admin, through 127.0.0.1" data-cluster-kubeconfig>
              <CopyGlyph size={14} /> Copy kubeconfig
            </button>
          </>
        )}
      </div>
      {err && <ErrorCard message={err} />}
      <div className="machine-cluster-nodes">
        {nodes.map((n) => (
          <button key={n.name} type="button" className={`machine-cluster-node${n.ready ? " is-ready" : ""}`} onClick={() => n.card && requestSnap({ kind: "object", id: n.card })} disabled={!n.card} data-cluster-node={n.name} data-tip={n.card ? "Go to its card" : "Not a card on this board"}>
            <span className={`f-dot ${n.ready ? "is-ok" : "is-warn is-live"}`} />
            <span className="machine-cluster-node-name">{n.name}</span>
            <span className="machine-cluster-role">{n.role === "server" ? "server" : "worker"}</span>
          </button>
        ))}
      </div>
      <div className="machine-cluster-pods-head">
        <b>Pods</b>
        <label className="machine-cluster-sys">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Kubernetes' own
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="machine-cluster-none">No pods of yours yet: run one below.</div>
      ) : (
        <ul className="machine-cluster-pods">
          {shown.map((p) => {
            const k = `${p.ns}/${p.name}`;
            return (
              <li key={k} className="machine-cluster-pod" data-cluster-pod={p.name}>
                <span className={`f-dot ${p.phase === "Running" ? "is-ok" : p.phase === "Pending" ? "is-warn is-live" : p.phase === "Failed" ? "is-bad" : ""}`} />
                <span className="machine-cluster-pod-name">
                  <b>{p.name}</b>
                  <span>
                    {p.ns !== "default" ? `${p.ns} · ` : ""}
                    {p.phase} · {p.node ?? "no node yet"} · {p.ready} ready{p.restarts ? ` · ${p.restarts} restarts` : ""}
                  </span>
                </span>
                {p.image && <code className="machine-cluster-pod-image">{p.image}</code>}
                <button className="machine-addr-btn" disabled={viewer || busy === `open:${k}`} onClick={() => (p.card ? requestSnap({ kind: "object", id: p.card }) : void go(`open:${k}`, "/pods/open", { ns: p.ns, name: p.name }, `${p.name} opens as a card`))} data-tip={p.card ? "Go to its card" : "Open it as a card: its terminal is a shell in the pod"} data-cluster-open={p.name}>
                  <PopOutGlyph />
                </button>
                {!viewer && p.ns !== "kube-system" && (
                  <button
                    className={`machine-addr-btn is-remove${armed === k ? " is-armed" : ""}`}
                    disabled={busy === `del:${k}`}
                    onClick={() => {
                      if (armed !== k) return setArmed(k);
                      setArmed(null);
                      void go(`del:${k}`, "/pods/delete", { ns: p.ns, name: p.name, confirm: true });
                    }}
                    data-tip={armed === k ? "Press again to delete it" : "Delete the pod"}
                  >
                    <TrashGlyph />
                    {armed === k && <span>Delete?</span>}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!viewer && (
        <form
          className="machine-cluster-run"
          onSubmit={(e) => {
            e.preventDefault();
            void go("run", "/pods", { image, keep }, `Running a pod of ${image}`);
          }}
        >
          <input value={image} onChange={(e) => setImage(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} aria-label="The pod's image" placeholder="an image: nginx:1.27, redis:7…" />
          <label className="machine-cluster-keep" data-tip="For an image with nothing of its own to run (ubuntu, busybox): it sleeps, so you can open its terminal">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep it running
          </label>
          <button className="f-pill is-accent machine-cluster-btn" disabled={!image || busy === "run"} data-cluster-run>
            <PlayGlyph size={14} /> Run a pod
          </button>
        </form>
      )}
    </div>
  );
}

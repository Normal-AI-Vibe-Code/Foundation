/**
 * Kubernetes in a section (2026-11-17, Josh: "There should be options to start a kubernetes cluster and pods,
 * which I assume spawns multiple VMS in the section, which can be also moved out into different sections in
 * Foundation to see their terminal and their desktops"; asked which shape: "k3s across machines").
 *
 * A cluster is k3s (rancher/k3s) on machines of its own: one server and some workers, each an ordinary machine
 * card, laid in the section and free to be moved anywhere, with its own terminal. They share a network of their
 * own on the engine (`foundation-k8s-<id>`), where a worker reaches the server by its machine's name, and a
 * join token derived from this server's secret key (never written on the board). k3s needs its nodes
 * privileged (it manages cgroups; tried on Kiri 0.1.18 on 2026-11-17: refused without), so a cluster starts
 * only on a person's press, and its cards say so. The server publishes 6443 on 127.0.0.1 for a kubeconfig.
 *
 * The server's card has a Cluster view (its nodes, every pod, Run a pod, Add a worker, the kubeconfig), read
 * with kubectl in the server. A pod opens as a card of its own whose terminal is `kubectl exec` into it.
 */

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boardMaps, logActivity, machineName, uid, type MachineState, type PanelDoc } from "@foundation/protocol";
import { config } from "./config.ts";
import { editBoard, getBoard } from "./boards.ts";
import { HttpError } from "./http.ts";
import { engineCall, engineJson, execRaw, machineHooks, machinePanel, startMachine, writeMachine, type Engine } from "./machines.ts";

export const K3S_IMAGE = process.env.FOUNDATION_K3S_IMAGE ?? "rancher/k3s:v1.31.4-k3s1";
export const networkName = (id: string) => `foundation-k8s-${id}`;
const NODE_W = 620;
const NODE_H = 460;

/** the cluster's join token: from this server's secret key and the cluster's id, so it's never stored */
export function clusterToken(id: string, keyFile = join(config.dataDir, "secret.key")): string {
  const key = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : `foundation-${config.dataDir}`;
  return createHmac("sha256", key).update(`k3s:${id}`).digest("hex").slice(0, 48);
}

/** what a node is made with (on top of a machine's usual body) */
export function nodeCreate(m: MachineState, token: string): Record<string, unknown> {
  const cl = m.cluster!;
  const net = networkName(cl.id);
  const server = cl.role === "server";
  return {
    Cmd: server ? ["server", "--disable=traefik", "--write-kubeconfig-mode=644", `--tls-san=127.0.0.1`, `--node-name=${m.name}`] : ["agent", `--node-name=${m.name}`],
    Env: server ? [`K3S_TOKEN=${token}`] : [`K3S_URL=https://${cl.server}:6443`, `K3S_TOKEN=${token}`],
    Privileged: true,
    Tmpfs: { "/run": "", "/var/run": "" },
    NetworkMode: net,
    NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [m.name] } } },
  };
}

async function ensureNetwork(engine: Engine, id: string) {
  const name = networkName(id);
  const r = await engineCall(engine, "GET", `/networks/${encodeURIComponent(name)}`);
  if (r.status === 200) return;
  await engineJson(engine, "POST", "/networks/create", { Name: name, Driver: "bridge", Labels: { "dev.foundation.cluster": id } });
}

// a node's container: privileged, on the cluster's network, running k3s
machineHooks.creating.push(async (m, body, engine) => {
  if (!m.cluster) return;
  await ensureNetwork(engine, m.cluster.id);
  const extra = nodeCreate(m, clusterToken(m.cluster.id));
  const host = (body.HostConfig ?? {}) as Record<string, unknown>;
  body.Cmd = extra.Cmd;
  body.Env = extra.Env;
  body.NetworkingConfig = extra.NetworkingConfig;
  body.HostConfig = { ...host, Privileged: true, Tmpfs: extra.Tmpfs, NetworkMode: extra.NetworkMode };
});

// ---------- laying a cluster ----------

function nodeCard(sectionId: string, cl: NonNullable<MachineState["cluster"]>, name: string, by: string, ports?: number[]): PanelDoc {
  return {
    id: uid("pnl"),
    kind: "panel",
    panel: "machine",
    sectionId,
    name,
    x: 0,
    y: 0,
    float: false,
    bornAt: Date.now(),
    w: NODE_W,
    h: NODE_H,
    ports: [],
    text: `${cl.role === "server" ? "The server" : "A worker"} of the Kubernetes cluster ${cl.name}`,
    createdBy: by,
    machine: {
      name: machineName(name),
      image: K3S_IMAGE,
      state: "absent",
      cluster: cl,
      ...(ports ? { wantPorts: ports } : {}),
      detail: cl.role === "server" ? "Start the cluster to run it: k3s, privileged." : "Starts with its cluster.",
    },
  };
}

/** lays a cluster's cards in a section: a server and `workers` workers (nothing runs until a person starts it) */
export function layCluster(boardId: string, sectionId: string, opts: { name?: string; workers?: number }, by: string): { cluster: string; server: string; cards: string[] } {
  const workers = Math.max(0, Math.min(6, Math.round(opts.workers ?? 2)));
  const id = randomBytes(4).toString("hex");
  const name = machineName(opts.name?.trim() || `k8s-${id.slice(0, 4)}`).slice(0, 24);
  return editBoard(boardId, "machines", (doc) => {
    const m = boardMaps(doc);
    const sec = m.sections.get(sectionId);
    if (!sec) throw new HttpError(404, `no section ${sectionId} on this board`);
    const serverName = machineName(`${name}-server`);
    const server = nodeCard(sec.id, { id, name, role: "server" }, `${name}-server`, by, [6443]);
    const cards = [server, ...Array.from({ length: workers }, (_, i) => nodeCard(sec.id, { id, name, role: "agent", server: serverName }, `${name}-worker-${i + 1}`, by))];
    for (const c of cards) m.objects.set(c.id, c);
    logActivity(doc, { who: by, role: "human", text: `laid the Kubernetes cluster ${name} in ${sec.name}: a server and ${workers} worker${workers === 1 ? "" : "s"}`, objectId: server.id });
    return { cluster: id, server: server.id, cards: cards.map((c) => c.id) };
  });
}

/** every card of a cluster on a board, the server first */
export function clusterCards(boardId: string, clusterId: string): PanelDoc[] {
  const cards = [...boardMaps(getBoard(boardId).doc).objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "machine" && o.machine?.cluster?.id === clusterId && !o.machine.pod);
  return cards.sort((a, b) => (a.machine!.cluster!.role === "server" ? -1 : 0) - (b.machine!.cluster!.role === "server" ? -1 : 0));
}

/** starts every node that isn't running, the server first (a person's press: they run privileged) */
export async function startCluster(boardId: string, clusterId: string, person: string): Promise<{ started: number }> {
  const cards = clusterCards(boardId, clusterId);
  if (!cards.length) throw new HttpError(404, "no such cluster on this board");
  let started = 0;
  for (const c of cards) {
    if (c.machine?.state === "running") continue;
    await startMachine(boardId, c.id, person, { image: K3S_IMAGE });
    started++;
  }
  return { started };
}

/** a worker more, laid beside the others (Start the cluster runs it) */
export function addWorker(boardId: string, serverPanel: string, by: string): { card: string } {
  const server = machinePanel(boardId, serverPanel);
  const cl = server.machine?.cluster;
  if (!cl || cl.role !== "server") throw new HttpError(400, "that card isn't a cluster's server");
  const n = clusterCards(boardId, cl.id).length;
  return editBoard(boardId, "machines", (doc) => {
    const card = nodeCard(server.sectionId, { id: cl.id, name: cl.name, role: "agent", server: server.machine!.name }, `${cl.name}-worker-${n}`, by);
    boardMaps(doc).objects.set(card.id, card);
    logActivity(doc, { who: by, role: "human", text: `added a worker to the Kubernetes cluster ${cl.name}`, objectId: card.id });
    return { card: card.id };
  });
}

// ---------- reading it ----------

export interface ClusterNode {
  name: string;
  ready: boolean;
  role: "server" | "agent";
  card?: string;
  version?: string;
}
export interface ClusterPod {
  ns: string;
  name: string;
  phase: string;
  node?: string;
  ready: string;
  restarts: number;
  image?: string;
  since?: string;
  card?: string;
}

interface K8sList<T> {
  items?: T[];
}
interface K8sNode {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: { conditions?: Array<{ type?: string; status?: string }>; nodeInfo?: { kubeletVersion?: string } };
}
interface K8sPod {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  spec?: { nodeName?: string; containers?: Array<{ image?: string }> };
  status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean; restartCount?: number }> };
}

export function readNodes(json: string, cards: Record<string, string> = {}): ClusterNode[] {
  const list = JSON.parse(json) as K8sList<K8sNode>;
  return (list.items ?? []).map((n) => ({
    name: n.metadata?.name ?? "?",
    ready: Boolean(n.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")),
    role: n.metadata?.labels?.["node-role.kubernetes.io/control-plane"] !== undefined || n.metadata?.labels?.["node-role.kubernetes.io/master"] !== undefined ? "server" : "agent",
    ...(cards[n.metadata?.name ?? ""] ? { card: cards[n.metadata!.name!] } : {}),
    ...(n.status?.nodeInfo?.kubeletVersion ? { version: n.status.nodeInfo.kubeletVersion } : {}),
  }));
}

export function readPods(json: string, cards: Record<string, string> = {}): ClusterPod[] {
  const list = JSON.parse(json) as K8sList<K8sPod>;
  return (list.items ?? []).map((p) => {
    const cs = p.status?.containerStatuses ?? [];
    const key = `${p.metadata?.namespace}/${p.metadata?.name}`;
    return {
      ns: p.metadata?.namespace ?? "default",
      name: p.metadata?.name ?? "?",
      phase: p.status?.phase ?? "Unknown",
      ...(p.spec?.nodeName ? { node: p.spec.nodeName } : {}),
      ready: `${cs.filter((c) => c.ready).length}/${cs.length || p.spec?.containers?.length || 0}`,
      restarts: cs.reduce((n, c) => n + (c.restartCount ?? 0), 0),
      ...(p.spec?.containers?.[0]?.image ? { image: p.spec.containers[0].image } : {}),
      ...(p.metadata?.creationTimestamp ? { since: p.metadata.creationTimestamp } : {}),
      ...(cards[key] ? { card: cards[key] } : {}),
    };
  });
}

async function kubectl(boardId: string, serverPanel: string, args: string[], timeoutS = 20): Promise<string> {
  const r = await execRaw(boardId, serverPanel, ["kubectl", ...args], { timeoutS, maxBytes: 8 * 1024 * 1024 });
  if (r.exitCode !== 0) {
    const said = (r.stderr.trim() || r.stdout.toString("utf8").trim()).split("\n").slice(-2).join(" ").slice(-300);
    throw new HttpError(502, said || `kubectl ${args[0]} failed`);
  }
  return r.stdout.toString("utf8");
}

/** nodes and pods, as the server's kubectl sees them, with the card each is on; pod cards follow their pods */
export async function clusterStatus(boardId: string, serverPanel: string) {
  const server = machinePanel(boardId, serverPanel);
  const cl = server.machine?.cluster;
  if (!cl || cl.role !== "server") throw new HttpError(400, "that card isn't a cluster's server");
  const objects = [...boardMaps(getBoard(boardId).doc).objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "machine");
  const nodeCards = Object.fromEntries(objects.filter((o) => o.machine?.cluster?.id === cl.id && !o.machine.pod).map((o) => [o.machine!.name, o.id]));
  const podCards = Object.fromEntries(objects.filter((o) => o.machine?.pod?.server === serverPanel).map((o) => [`${o.machine!.pod!.ns}/${o.machine!.pod!.name}`, o.id]));
  if (server.machine?.state !== "running") return { cluster: cl, running: false, nodes: [] as ClusterNode[], pods: [] as ClusterPod[] };
  const [nodesJson, podsJson] = await Promise.all([kubectl(boardId, serverPanel, ["get", "nodes", "-o", "json"]), kubectl(boardId, serverPanel, ["get", "pods", "-A", "-o", "json"])]).catch((e: Error) => {
    // k3s takes a few seconds to answer after it starts
    throw new HttpError(503, `The cluster isn't answering yet (${e.message}). k3s takes about 20 seconds after it starts.`);
  });
  const nodes = readNodes(nodesJson, nodeCards);
  const pods = readPods(podsJson, podCards);
  // a pod's card says what its pod is doing; one whose pod went says so
  for (const [k, card] of Object.entries(podCards)) {
    const p = pods.find((x) => `${x.ns}/${x.name}` === k);
    const was = objects.find((o) => o.id === card)?.machine;
    const state: MachineState["state"] = p ? (p.phase === "Running" ? "running" : p.phase === "Pending" ? "starting" : p.phase === "Failed" ? "error" : "stopped") : "absent";
    const detail = p ? `${p.phase} on ${p.node ?? "no node yet"} · ${p.ready} ready` : "The pod is gone from the cluster.";
    if (was && (was.state !== state || was.detail !== detail)) writeMachine(boardId, card, { state, detail, pod: { ...was.pod!, ...(p?.node ? { node: p.node } : {}), phase: p?.phase ?? "Gone" } });
  }
  return { cluster: cl, running: true, nodes, pods };
}

/** the kubeconfig for this computer: the server's, pointed at its published 6443 */
export async function kubeconfig(boardId: string, serverPanel: string): Promise<string> {
  const host = machinePanel(boardId, serverPanel).machine?.ports?.find((p) => p.port === 6443)?.host;
  if (!host) throw new HttpError(409, "The cluster's server isn't running with 6443 published.");
  const r = await execRaw(boardId, serverPanel, ["cat", "/etc/rancher/k3s/k3s.yaml"], { timeoutS: 10 });
  if (r.exitCode !== 0) throw new HttpError(503, "The server has no kubeconfig yet: give it a few seconds after it starts.");
  return r.stdout.toString("utf8").replace(/https:\/\/127\.0\.0\.1:6443/g, `https://127.0.0.1:${host}`);
}

/** a pod name kubectl takes */
export const podName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "pod";

/** runs a pod (a person's press): an image, kept alive with sleep when it has nothing of its own to run */
export async function runPod(boardId: string, serverPanel: string, input: { name?: string; image: string; keep?: boolean }, person: string): Promise<{ name: string }> {
  const image = input.image.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,200}$/.test(image)) throw new HttpError(400, `“${image}” isn't an image name`);
  const name = podName(input.name || image.split("/").pop()!.split(":")[0]);
  const args = ["run", name, `--image=${image}`, "--restart=Never", ...(input.keep ? ["--command", "--", "sh", "-c", "trap 'exit 0' TERM; while :; do sleep 3600 & wait $!; done"] : [])];
  await kubectl(boardId, serverPanel, args, 30);
  editBoard(boardId, "machines", (doc) => logActivity(doc, { who: person, role: "human", text: `ran the pod ${name} (${image}) on the cluster ${machinePanel(boardId, serverPanel).machine?.cluster?.name ?? ""}`, objectId: serverPanel }));
  return { name };
}

/** deletes a pod (a person's press, confirmed): its card, if it has one, says it's gone */
export async function deletePod(boardId: string, serverPanel: string, ns: string, name: string, person: string, confirm: boolean) {
  if (!confirm) throw new HttpError(400, "Deleting a pod ends it. Send confirm: true to do it.");
  await kubectl(boardId, serverPanel, ["delete", "pod", "-n", ns, name, "--wait=false"], 30);
  editBoard(boardId, "machines", (doc) => logActivity(doc, { who: person, role: "human", text: `deleted the pod ${ns}/${name}`, objectId: serverPanel }));
  return { deleted: true };
}

/** a pod as a card of its own, in a section (the server's, unless another is named): its terminal is kubectl exec */
export function openPodCard(boardId: string, serverPanel: string, ns: string, name: string, sectionId: string | undefined, by: string): { card: string } {
  const server = machinePanel(boardId, serverPanel);
  if (!server.machine?.cluster) throw new HttpError(400, "that card isn't a cluster's server");
  const have = [...boardMaps(getBoard(boardId).doc).objects.values()].find((o) => o.kind === "panel" && o.machine?.pod?.server === serverPanel && o.machine.pod.ns === ns && o.machine.pod.name === name);
  if (have) return { card: have.id };
  return editBoard(boardId, "machines", (doc) => {
    const m = boardMaps(doc);
    const sec = sectionId && m.sections.get(sectionId) ? sectionId : server.sectionId;
    const card: PanelDoc = {
      id: uid("pnl"),
      kind: "panel",
      panel: "machine",
      sectionId: sec,
      name: `${name}`,
      x: 0,
      y: 0,
      float: false,
      bornAt: Date.now(),
      w: NODE_W,
      h: NODE_H,
      ports: [],
      text: `The pod ${ns}/${name} of the cluster ${server.machine!.cluster!.name}`,
      createdBy: by,
      machine: { name: machineName(name), state: "starting", image: "pod", pod: { server: serverPanel, ns, name }, detail: "Reading the pod…" },
    };
    m.objects.set(card.id, card);
    logActivity(doc, { who: by, role: "human", text: `opened the pod ${ns}/${name} as a card`, objectId: card.id });
    return { card: card.id };
  });
}

// a cluster's network goes with its last node: tried a moment after a node is removed (the engine refuses while
// any container is still on it, and that's fine)
machineHooks.ended.push((boardId, panelId, why) => {
  if (why !== "removed") return;
  let cl: MachineState["cluster"];
  let engineId: string | undefined;
  try {
    const m = machinePanel(boardId, panelId).machine;
    cl = m?.cluster;
    engineId = m?.engine;
  } catch {
    return;
  }
  if (!cl) return;
  const id = cl.id;
  setTimeout(() => {
    void (async () => {
      const { engineStatus } = await import("./machines.ts");
      for (const e of (await engineStatus()).filter((x) => x.up && (!engineId || x.id === engineId))) await engineCall(e, "DELETE", `/networks/${encodeURIComponent(networkName(id))}`).catch(() => {});
    })();
  }, 4000);
});

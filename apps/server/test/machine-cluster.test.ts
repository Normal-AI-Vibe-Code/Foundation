/**
 * Kubernetes across machines (2026-11-17): what a node is made with, its join token, and kubectl's answers read
 * into nodes and pods with the card each is on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterToken, networkName, nodeCreate, podName, readNodes, readPods } from "../src/machinecluster.ts";

test("a node is privileged, on its cluster's network, and a worker joins the server by name", () => {
  const server = nodeCreate({ name: "lab-server", state: "absent", cluster: { id: "c1", name: "lab", role: "server" } }, "tok");
  assert.equal(server.Privileged, true);
  assert.equal(server.NetworkMode, networkName("c1"));
  assert.deepEqual((server.Cmd as string[]).slice(0, 2), ["server", "--disable=traefik"]);
  assert.ok((server.Cmd as string[]).includes("--node-name=lab-server"));
  assert.deepEqual(server.Env, ["K3S_TOKEN=tok"]);
  assert.deepEqual(server.NetworkingConfig, { EndpointsConfig: { "foundation-k8s-c1": { Aliases: ["lab-server"] } } });
  const worker = nodeCreate({ name: "lab-worker-1", state: "absent", cluster: { id: "c1", name: "lab", role: "agent", server: "lab-server" } }, "tok");
  assert.equal(worker.Privileged, true);
  assert.deepEqual(worker.Env, ["K3S_URL=https://lab-server:6443", "K3S_TOKEN=tok"]);
  assert.equal((worker.Cmd as string[])[0], "agent");
});

test("the join token comes from the server's key and the cluster's id, and isn't stored", () => {
  const dir = mkdtempSync(join(tmpdir(), "fdn-k8s-"));
  const key = join(dir, "secret.key");
  writeFileSync(key, Buffer.alloc(32, 9).toString("base64"));
  const a = clusterToken("c1", key);
  assert.equal(a, clusterToken("c1", key));
  assert.notEqual(a, clusterToken("c2", key));
  assert.match(a, /^[0-9a-f]{48}$/);
  writeFileSync(key, Buffer.alloc(32, 7).toString("base64"));
  assert.notEqual(a, clusterToken("c1", key), "another Foundation's key, another token");
});

test("kubectl's nodes and pods, with the cards they're on", () => {
  const nodes = readNodes(
    JSON.stringify({
      items: [
        { metadata: { name: "lab-server", labels: { "node-role.kubernetes.io/control-plane": "true" } }, status: { conditions: [{ type: "Ready", status: "True" }], nodeInfo: { kubeletVersion: "v1.31.4+k3s1" } } },
        { metadata: { name: "lab-worker-1", labels: {} }, status: { conditions: [{ type: "Ready", status: "False" }] } },
      ],
    }),
    { "lab-server": "pnl_s", "lab-worker-1": "pnl_w" },
  );
  assert.deepEqual(nodes, [
    { name: "lab-server", ready: true, role: "server", card: "pnl_s", version: "v1.31.4+k3s1" },
    { name: "lab-worker-1", ready: false, role: "agent", card: "pnl_w" },
  ]);
  const pods = readPods(
    JSON.stringify({
      items: [
        { metadata: { name: "web", namespace: "default", creationTimestamp: "2026-11-17T07:00:00Z" }, spec: { nodeName: "lab-worker-1", containers: [{ image: "nginx:1.27" }] }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 2 }] } },
        { metadata: { name: "coredns-1", namespace: "kube-system" }, spec: { containers: [{ image: "coredns" }, { image: "x" }] }, status: { phase: "Pending" } },
      ],
    }),
    { "default/web": "pnl_web" },
  );
  assert.deepEqual(pods[0], { ns: "default", name: "web", phase: "Running", node: "lab-worker-1", ready: "1/1", restarts: 2, image: "nginx:1.27", since: "2026-11-17T07:00:00Z", card: "pnl_web" });
  assert.equal(pods[1].ready, "0/2");
  assert.equal(pods[1].node, undefined);
  assert.deepEqual(readPods("{}"), []);
});

test("a pod's name, as kubectl takes it", () => {
  assert.equal(podName("My Web App!"), "my-web-app");
  assert.equal(podName("nginx"), "nginx");
  assert.equal(podName("---"), "pod");
  assert.equal(podName("x".repeat(80)).length, 50);
});

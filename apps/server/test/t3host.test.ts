/**
 * Foundation's own T3 instance (src/t3host.ts), against a stand-in `t3`: a
 * small program that takes T3's bootstrap line on stdin, answers the same
 * HTTP sign-in (environment, token exchange, socket ticket) and streams
 * providers and threads over the same socket messages.
 *
 * Checked: T3's shapes are read into what the pane shows (and odd ones are
 * skipped); Start runs the program in a home of Foundation's own, signs in
 * with the one-time token, and lists agents and work as they change; a thread
 * that starts or is archived shows up or goes; Stop ends the program; a
 * program that dies says so; a missing program says where it looked. Nothing
 * here starts a thread. Who may press Start is `requirePerson` (index.ts),
 * checked in machines.test.ts.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const dir = mkdtempSync(join(tmpdir(), "foundation-t3host-"));
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
process.env.FOUNDATION_ADMIN_EMAILS = "";
process.env.FOUNDATION_T3_PORT = String(21000 + Math.floor(Math.random() * 2000));
process.env.FOUNDATION_T3_READY_MS = "8000";

// ---------- a stand-in t3 ----------
const wsPath = createRequire(import.meta.url).resolve("ws").replace(/\\/g, "/");
const standin = join(dir, "t3-standin.mjs");
const control = join(dir, "control.json");
writeFileSync(
  standin,
  `
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(import.meta.url)(${JSON.stringify(wsPath)});
let line = "";
for await (const b of process.stdin) line += b;
const boot = JSON.parse(line);
writeFileSync(${JSON.stringify(join(dir, "boot.json").replace(/\\/g, "/"))}, JSON.stringify({ ...boot, home: process.env.T3CODE_HOME, cwd: process.cwd(), args: process.argv.slice(2) }));
const control = ${JSON.stringify(control.replace(/\\/g, "/"))};
const provider = (instanceId, extra = {}) => ({ instanceId, driver: instanceId, displayName: instanceId === "claudeAgent" ? "Claude" : "Codex", enabled: true, installed: true, version: "1.0.0", status: "ready", auth: { status: "authenticated", label: "Team Subscription" }, models: [{ slug: "m1" }, { slug: "m2" }], ...extra });
const thread = (id, extra = {}) => ({ id, projectId: "p1", title: "Parts list", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, latestTurn: { state: "running" }, session: { status: "running", providerInstanceId: "claudeAgent" }, hasPendingApprovals: false, hasPendingUserInput: false, archivedAt: null, updatedAt: "2026-11-12T10:00:00.000Z", ...extra });
let bearer = null, ticket = null;
const http = createServer(async (req, res) => {
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/.well-known/t3/environment") return json(200, { environmentId: "env1", serverVersion: "0.0.44" });
  let body = ""; for await (const b of req) body += b;
  if (req.url === "/oauth/token") {
    const f = new URLSearchParams(body);
    if (f.get("subject_token") !== boot.desktopBootstrapToken || f.get("subject_token_type") !== "urn:t3:params:oauth:token-type:environment-bootstrap") return json(401, { error: "invalid_grant" });
    bearer = "bearer-" + Math.random().toString(36).slice(2);
    return json(200, { access_token: bearer });
  }
  if (req.url === "/api/auth/websocket-ticket") {
    if (req.headers.authorization !== "Bearer " + bearer) return json(401, {});
    ticket = "ticket-" + Math.random().toString(36).slice(2);
    return json(200, { ticket });
  }
  json(404, {});
});
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/ws" || u.searchParams.get("wsTicket") !== ticket) return sock.destroy();
  ticket = null; // one use
  wss.handleUpgrade(req, sock, head, (ws) => {
    const ids = {};
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m._tag !== "Request") return;
      ids[m.tag] = m.id;
      if (m.tag === "subscribeServerConfig") ws.send(JSON.stringify({ _tag: "Chunk", requestId: m.id, values: [{ version: 1, type: "snapshot", config: { providers: [provider("claudeAgent"), provider("codex", { installed: false, status: "error", auth: { status: "unknown" }, message: "Could not start Codex CLI" })] } }] }));
      if (m.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: m.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "Foundation" }], threads: [] } }, { kind: "synchronized" }] }));
      // anything else gets an answer, as T3 always gives one
      if (m.tag !== "subscribeServerConfig" && m.tag !== "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Failure", cause: { message: "unknown method " + m.tag } } }));
    });
    // the test drives what happens next through a file
    let seen = "";
    const t = setInterval(() => {
      if (!existsSync(control)) return;
      const text = readFileSync(control, "utf8");
      if (text === seen) return;
      seen = text;
      const c = JSON.parse(text);
      if (c.do === "thread") ws.send(JSON.stringify({ _tag: "Chunk", requestId: ids["orchestration.subscribeShell"], values: [{ kind: "thread-upserted", sequence: 1, thread: thread("t1", c.extra ?? {}) }, { kind: "something-new", sequence: 2 }] }));
      if (c.do === "codex-ready") ws.send(JSON.stringify({ _tag: "Chunk", requestId: ids.subscribeServerConfig, values: [{ version: 1, type: "providerStatuses", payload: { providers: [provider("claudeAgent"), provider("codex")] } }] }));
      if (c.do === "die") process.exit(3);
    }, 40);
    ws.on("close", () => clearInterval(t));
  });
});
http.listen(boot.port, boot.host);
`,
);

const { agentOf, workOf, startT3, stopT3, t3Host } = await import("../src/t3host.ts");

after(() => {
  stopT3();
});

const until = async (what: string, ok: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`waited ${ms} ms for: ${what} (state: ${JSON.stringify(t3Host())})`);
    await new Promise((r) => setTimeout(r, 30));
  }
};
const tell = (c: object) => writeFileSync(control, JSON.stringify({ ...c, n: Math.random() }));

test("a provider is read as an agent: ready, needs sign-in, missing, off", () => {
  const base = { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, installed: true, version: "2.1.3", status: "ready", auth: { status: "authenticated", label: "Claude Team Subscription" }, models: [{}, {}, {}] };
  // its models, by slug (one without a slug is skipped)
  assert.deepEqual(agentOf({ ...base, models: [{ slug: "m1", name: "Model One" }, { slug: "m2" }, { name: "no slug" }] })?.modelList, [{ slug: "m1", name: "Model One" }, { slug: "m2", name: "m2" }]);
  assert.deepEqual(agentOf(base), { id: "claudeAgent", driver: "claudeAgent", name: "Claude", enabled: true, installed: true, version: "2.1.3", state: "ready", account: "Claude Team Subscription", message: undefined, models: 3, modelList: [], where: "cloud", boardTools: false });
  assert.equal(agentOf({ ...base, auth: { status: "unauthenticated" }, status: "error" })?.state, "sign-in");
  assert.equal(agentOf({ ...base, installed: false, status: "error", message: "Could not start Codex CLI" })?.state, "missing");
  assert.equal(agentOf({ ...base, availability: "unavailable", unavailableReason: "No driver for kimi in this build" })?.message, "No driver for kimi in this build");
  assert.equal(agentOf({ ...base, enabled: false, status: "disabled" })?.state, "off");
  assert.equal(agentOf({ ...base, status: "error", auth: { status: "unknown" } })?.state, "error");
  // a named second instance of the same driver is its own agent
  assert.equal(agentOf({ ...base, instanceId: "claude-work", displayName: "Claude (work)" })?.id, "claude-work");
  for (const odd of [null, 3, "x", [], {}, { driver: "codex" }]) assert.equal(agentOf(odd), null);
});

test("a thread is read as work: working, waiting on a person, idle, failed; archived ones are left out", () => {
  const t = { id: "t1", projectId: "p1", title: "Parts list", modelSelection: { instanceId: "codex", model: "gpt-6" }, latestTurn: { state: "running" }, session: { status: "running", providerInstanceId: "codex-work" }, hasPendingApprovals: false, hasPendingUserInput: false, archivedAt: null, updatedAt: "2026-11-12T10:00:00.000Z" };
  const name = () => "Foundation";
  assert.deepEqual(workOf(t, name), { id: "t1", title: "Parts list", project: "Foundation", agent: "codex-work", model: "gpt-6", state: "working", updatedAt: "2026-11-12T10:00:00.000Z" });
  assert.equal(workOf({ ...t, hasPendingApprovals: true }, name)?.state, "waiting");
  assert.equal(workOf({ ...t, session: { status: "ready" }, latestTurn: { state: "completed" } }, name)?.state, "idle");
  assert.equal(workOf({ ...t, session: { status: "ready" }, latestTurn: { state: "completed" } }, name)?.agent, "codex");
  assert.equal(workOf({ ...t, session: { status: "error" } }, name)?.state, "error");
  assert.equal(workOf({ ...t, session: null, latestTurn: null }, name)?.state, "idle");
  assert.equal(workOf({ ...t, archivedAt: "2026-11-12T11:00:00.000Z" }, name), null);
  assert.equal(workOf({ title: "no id" }, name), null);
});

test("with no T3 program on this computer, Start says where it looked", async () => {
  process.env.T3_CLI = join(dir, "nowhere", "t3.exe");
  const s = await startT3("Ada");
  assert.equal(s.state, "error");
  assert.match(s.detail ?? "", /T3 program isn't on this computer/);
  assert.match(s.detail ?? "", /T3_CLI/);
  assert.deepEqual(s.agents, []);
});

test("Start runs T3 in Foundation's own home, signs in with the one-time token, and lists its agents", async () => {
  process.env.T3_CLI = standin;
  assert.equal(t3Host().state, "error"); // from the test before: Start again is allowed
  const s = await startT3("Ada");
  assert.equal(s.state, "running", s.detail);
  assert.equal(s.startedBy, "Ada");
  assert.equal(s.version, "0.0.44");
  const boot = JSON.parse(readFileSync(join(dir, "boot.json"), "utf8"));
  // its own home under Foundation's data (never Vision Code's), bound to this computer only, no browser opened
  assert.equal(boot.home, join(dir, "data", "t3"));
  assert.equal(boot.t3Home, boot.home);
  assert.equal(boot.host, "127.0.0.1");
  assert.equal(boot.noBrowser, true);
  assert.equal(boot.port, s.port);
  assert.deepEqual(boot.args, ["--bootstrap-fd", "0"]);
  assert.match(boot.desktopBootstrapToken, /^[0-9a-f]{48}$/);
  // a new home starts supervised
  assert.equal(JSON.parse(readFileSync(join(boot.home, "userdata", "settings.json"), "utf8")).defaultRuntimeMode, "approval-required");
  await until("the providers", () => t3Host().agents.length === 2);
  assert.deepEqual(t3Host().agents.map((a) => [a.id, a.state]), [["claudeAgent", "ready"], ["codex", "missing"]]);
  assert.deepEqual(t3Host().work, []);
  // a second Start while it runs starts nothing new
  assert.equal((await startT3("Kai")).startedBy, "Ada");
});

test("agents and work follow T3 as they change; shapes this build doesn't know are skipped", async () => {
  tell({ do: "codex-ready" });
  await until("Codex ready", () => t3Host().agents.find((a) => a.id === "codex")?.state === "ready");
  tell({ do: "thread" });
  await until("the thread", () => t3Host().work.length === 1);
  assert.deepEqual(t3Host().work[0], { id: "t1", title: "Parts list", project: "Foundation", agent: "claudeAgent", model: "claude-opus-5-5", state: "working", updatedAt: "2026-11-12T10:00:00.000Z" });
  tell({ do: "thread", extra: { hasPendingApprovals: true } });
  await until("waiting on a person", () => t3Host().work[0]?.state === "waiting");
  tell({ do: "thread", extra: { archivedAt: "2026-11-12T11:00:00.000Z" } });
  await until("archived: gone", () => t3Host().work.length === 0);
  assert.equal(t3Host().state, "running");
});

test("Stop ends the program and clears what it showed; a seeded home keeps a person's settings", async () => {
  const port = t3Host().port!;
  const s = stopT3();
  assert.equal(s.state, "off");
  assert.deepEqual([s.agents, s.work, s.port], [[], [], undefined]);
  // nothing answers on its port any more (the kill takes a moment on Windows)
  let answered = true;
  for (let i = 0; i < 40 && answered; i++) {
    answered = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
    if (answered) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(answered, false, "the stand-in still answers after Stop");
  const settings = join(dir, "data", "t3", "userdata", "settings.json");
  writeFileSync(settings, JSON.stringify({ defaultRuntimeMode: "full-access", mine: true }));
  assert.equal((await startT3("Ada")).state, "running");
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).mine, true);
});

test("a T3 that dies says so, and Start brings it back", async () => {
  await until("the streams", () => t3Host().agents.length === 2);
  tell({ do: "die" });
  await until("it's seen to have stopped", () => t3Host().state === "error");
  assert.match(t3Host().detail ?? "", /stopped on its own \(exit 3\)/);
  assert.deepEqual(t3Host().agents, []);
  tell({ do: "nothing" }); // the stand-in reads its orders when it starts: don't have it die again
  assert.equal((await startT3("Ada")).state, "running");
});

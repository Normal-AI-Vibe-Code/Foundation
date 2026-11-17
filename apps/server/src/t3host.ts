/**
 * Foundation's own T3 instance: the agent harness behind the agents pane.
 *
 * T3 Code's server (the same prebuilt `t3` Vision Code runs, unmodified) can
 * drive several coding agents from one place: Claude, Codex (OpenAI), Cursor,
 * Grok, OpenCode, Antigravity (Gemini), and more instances of any of them
 * with their own sign-in or endpoint. Foundation runs one of its own, apart
 * from Vision Code's: its own home (`<data>/t3`), its own port, its own
 * threads. The agents pane reads from it which agents this computer has and
 * what each is working on.
 *
 * Starting it runs a third-party program, so only a person starts or stops
 * it, from their browser (index.ts: requirePerson). Nothing here starts a
 * thread: listing agents and threads spends nothing.
 *
 * The start is Vision's (apps/vision/src-tauri/src/code_host.rs): the program
 * is given one line of JSON on stdin (`--bootstrap-fd 0`) with a port, a home
 * and a one-time token; when `/.well-known/t3/environment` answers, the token
 * is exchanged for a bearer (`POST /oauth/token`), the bearer for a socket
 * ticket (`POST /api/auth/websocket-ticket`), and two streams stay open:
 * `subscribeServerConfig` (the providers, as they come and go) and
 * `orchestration.subscribeShell` (the threads). The bearer lives in this
 * process's memory only.
 *
 * T3's messages are its own contract (packages/contracts in t3code, 0.0.44),
 * read defensively: an unknown shape is skipped, never a crash.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import { config } from "./config.ts";
import { findT3Cli, ON_PATH, t3Command } from "./t3paths.ts";

/** an agent T3 can run: one configured instance of a provider */
export interface T3Agent {
  /** T3's routing key ("claudeAgent", "codex", or a named instance) */
  id: string;
  /** which kind of agent drives it ("claudeAgent", "codex", "cursor", "grok", "opencode", "antigravity", …) */
  driver: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  /** ready: can take work now · sign-in: installed, not signed in · missing: its program isn't on this computer · off: disabled · error */
  state: "ready" | "sign-in" | "missing" | "off" | "error";
  /** the plan or account it's signed in to, when T3 knows */
  account?: string;
  /** why it isn't ready, in T3's words */
  message?: string;
  models: number;
  /** what it can run (at most 40, T3's order) and the one it runs unless told otherwise */
  modelList: Array<{ slug: string; name: string }>;
  model?: string;
  /** cloud: the work goes to a service · local: a model server on this computer */
  where: "cloud" | "local";
  /** added from Foundation (Kimi, DeepSeek): which, and the address it talks to */
  added?: { preset: string; baseUrl: string };
  /** a thread on it can read and write the board (Foundation's tools are on its launch line); else it works in its folder only */
  boardTools: boolean;
}

/** a thread in Foundation's T3: one agent's piece of work */
export interface T3Work {
  id: string;
  title: string;
  project: string;
  /** the agent instance it runs on */
  agent: string;
  model: string;
  state: "working" | "waiting" | "idle" | "error";
  updatedAt: string;
}

export interface T3HostStatus {
  state: "off" | "starting" | "running" | "error";
  /** why it's off or failed, or what it's doing while starting */
  detail?: string;
  port?: number;
  version?: string;
  startedBy?: string;
  since: number;
  agents: T3Agent[];
  work: T3Work[];
}

const HOME = () => join(config.dataDir, "t3");
const FIRST_PORT = () => {
  const v = Number(process.env.FOUNDATION_T3_PORT ?? "15783");
  return Number.isInteger(v) && v > 0 ? v : 15783;
};
const READY_MS = () => Number(process.env.FOUNDATION_T3_READY_MS ?? "60000") || 60_000;

let status: T3HostStatus = { state: "off", since: Date.now(), agents: [], work: [] };
let child: ChildProcess | null = null;
let ws: WebSocket | null = null;
let bearer: string | null = null;
let generation = 0;
const projects = new Map<string, { title: string; root?: string }>();
const threads = new Map<string, T3Work>();
let baseUrl: string | null = null;
let envId: string | null = null;

/** agents added from Foundation: where each runs and what it talks to. No keys: those are T3's */
const added = new Map<string, { preset: string; where: "cloud" | "local"; baseUrl: string; model: string }>();
const ADDED_FILE = () => join(HOME(), "foundation-agents.json");
function loadAdded() {
  added.clear();
  try {
    for (const [id, v] of Object.entries(JSON.parse(readFileSync(ADDED_FILE(), "utf8")) as Record<string, { preset: string; where: "cloud" | "local"; baseUrl: string; model: string }>)) added.set(id, v);
  } catch { /* none yet */ }
}
function saveAdded() {
  mkdirSync(HOME(), { recursive: true });
  writeFileSync(ADDED_FILE(), JSON.stringify(Object.fromEntries(added), null, 2));
}
/** what Foundation knows about an agent beyond what T3 says: where it runs */
function place(a: T3Agent): T3Agent {
  const x = added.get(a.id);
  const boardTools = withTools.has(a.id);
  if (!x) return { ...a, where: "cloud", boardTools };
  const mine = a.modelList.filter((m) => m.slug === x.model);
  return { ...a, where: x.where, model: x.model, models: 1, modelList: mine.length ? mine : [{ slug: x.model, name: x.model }], added: { preset: x.preset, baseUrl: x.baseUrl }, boardTools };
}

/** why an agent can't take work, in a few words */
export function t3AgentWhy(a: T3Agent): string {
  return a.state === "sign-in" ? "it needs signing in on this computer" : a.state === "missing" ? "it isn't installed on this computer" : a.state === "off" ? "it's turned off in T3" : (a.message ?? "it can't start");
}

/** told when a thread changes or goes (null) */
const workSubs = new Set<(id: string, work: T3Work | null) => void>();
export function onT3Work(fn: (id: string, work: T3Work | null) => void) {
  workSubs.add(fn);
  return () => workSubs.delete(fn);
}
const tellWork = (id: string, w: T3Work | null) => workSubs.forEach((f) => {
  try {
    f(id, w);
  } catch { /* a listener's own trouble */ }
});

export function t3Host(): T3HostStatus {
  return { ...status, agents: status.agents, work: [...threads.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) };
}

function set(patch: Partial<T3HostStatus>) {
  const stateChanged = patch.state !== undefined && patch.state !== status.state;
  status = { ...status, ...patch, ...(stateChanged ? { since: Date.now() } : {}) };
}

// ---------- reading T3's shapes ----------

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** T3's ServerProvider → what the pane shows */
export function agentOf(v: unknown): T3Agent | null {
  const p = obj(v);
  const id = str(p?.instanceId);
  if (!p || !id) return null;
  const auth = obj(p.auth);
  const enabled = p.enabled !== false;
  const installed = p.installed === true;
  const unavailable = p.availability === "unavailable";
  const state: T3Agent["state"] = !enabled || p.status === "disabled"
    ? "off"
    : unavailable || !installed
      ? "missing"
      : auth?.status === "unauthenticated"
        ? "sign-in"
        : p.status === "ready" || p.status === "warning"
          ? "ready"
          : "error";
  return {
    id,
    driver: str(p.driver) ?? id,
    name: str(p.displayName) ?? id,
    enabled,
    installed,
    version: str(p.version) ?? null,
    state,
    account: str(auth?.label) ?? str(auth?.type) ?? str(auth?.email),
    message: str(p.unavailableReason) ?? str(p.message),
    models: Array.isArray(p.models) ? p.models.length : 0,
    modelList: (Array.isArray(p.models) ? p.models : [])
      .map((m) => ({ slug: str(obj(m)?.slug) ?? "", name: str(obj(m)?.name) ?? str(obj(m)?.slug) ?? "" }))
      .filter((m) => m.slug)
      .slice(0, 40),
    where: "cloud",
    boardTools: false,
  };
}

/** T3's OrchestrationThreadShell → a piece of work (null: archived, or not a thread) */
export function workOf(v: unknown, projectName: (id: string) => string | undefined = (id) => projects.get(id)?.title): T3Work | null {
  const t = obj(v);
  const id = str(t?.id);
  if (!t || !id || t.archivedAt) return null;
  const session = obj(t.session);
  const turn = obj(t.latestTurn);
  const sel = obj(t.modelSelection);
  const state: T3Work["state"] = t.hasPendingApprovals === true || t.hasPendingUserInput === true
    ? "waiting"
    : session?.status === "error" || turn?.state === "error"
      ? "error"
      : session?.status === "running" || session?.status === "starting" || turn?.state === "running" || t.backgroundLiveness === "working"
        ? "working"
        : "idle";
  return {
    id,
    title: str(t.title) ?? "Untitled",
    project: projectName(str(t.projectId) ?? "") ?? "",
    agent: str(session?.providerInstanceId) ?? str(sel?.instanceId) ?? str(sel?.provider) ?? "",
    model: str(sel?.model) ?? "",
    state,
    updatedAt: str(t.updatedAt) ?? "",
  };
}

function takeProviders(list: unknown) {
  if (!Array.isArray(list)) return;
  set({ agents: list.map(agentOf).filter((a): a is T3Agent => !!a).map(place) });
}

/** one item of `subscribeServerConfig` */
export function onConfigItem(item: unknown) {
  const e = obj(item);
  if (!e) return;
  if (e.type === "snapshot") takeProviders(obj(e.config)?.providers);
  else if (e.type === "providerStatuses") takeProviders(obj(e.payload)?.providers);
}

/** one item of `orchestration.subscribeShell` */
export function onShellItem(item: unknown) {
  const e = obj(item);
  if (!e) return;
  const project = (p: unknown) => {
    const o = obj(p);
    const id = str(o?.id);
    if (id) projects.set(id, { title: str(o?.title) ?? "", root: str(o?.workspaceRoot) });
  };
  const thread = (t: unknown) => {
    const id = str(obj(t)?.id);
    if (!id) return;
    const w = workOf(t);
    if (w) threads.set(id, w);
    else threads.delete(id);
    tellWork(id, w);
  };
  if (e.kind === "snapshot") {
    const s = obj(e.snapshot);
    projects.clear();
    threads.clear();
    if (Array.isArray(s?.projects)) s.projects.forEach(project);
    if (Array.isArray(s?.threads)) s.threads.forEach(thread);
  } else if (e.kind === "project-upserted") project(e.project);
  else if (e.kind === "project-removed") projects.delete(str(e.projectId) ?? "");
  else if (e.kind === "thread-upserted") thread(e.thread);
  else if (e.kind === "thread-removed") {
    const id = str(e.threadId) ?? "";
    threads.delete(id);
    tellWork(id, null);
  }
}

// ---------- starting and stopping ----------

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

async function pickPort(): Promise<number> {
  const first = FIRST_PORT();
  for (let p = first; p < first + 20; p++) if (await portFree(p)) return p;
  throw new Error(`No free port for T3 between ${first} and ${first + 19}. Set FOUNDATION_T3_PORT where Foundation's server starts.`);
}

/** a new home starts supervised: a thread's tool calls that change something wait for a person (Vision's default too) */
function seedHome(home: string) {
  const dir = join(home, "userdata");
  mkdirSync(dir, { recursive: true });
  const settings = join(dir, "settings.json");
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ defaultRuntimeMode: "approval-required" }, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReady(base: string, gen: number): Promise<string | undefined> {
  const until = Date.now() + READY_MS();
  while (Date.now() < until) {
    if (gen !== generation) throw new Error("stopped");
    if (!child) throw new Error(status.detail ?? "T3 stopped before it was ready");
    try {
      const r = await fetch(`${base}/.well-known/t3/environment`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const j = (await r.json()) as { serverVersion?: string; environmentId?: string };
        envId = str(j.environmentId) ?? null;
        return str(j.serverVersion);
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`T3 didn't answer at ${base} within ${Math.round(READY_MS() / 1000)} s`);
}

async function exchange(base: string, token: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: token,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "Foundation",
    client_device_type: "desktop",
  });
  const r = await fetch(`${base}/oauth/token`, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
  const body = (await r.json().catch(() => ({}))) as { access_token?: string };
  if (!body.access_token) throw new Error(`T3 refused Foundation's sign-in (HTTP ${r.status})`);
  return body.access_token;
}

async function connect(base: string, gen: number) {
  if (gen !== generation || !bearer) return;
  const r = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5000) });
  const ticket = ((await r.json().catch(() => ({}))) as { ticket?: string }).ticket;
  if (!ticket) throw new Error(`T3 refused a socket ticket (HTTP ${r.status})`);
  const sock = new WebSocket(`${base.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=1&clientSurface=desktop`);
  ws = sock;
  const streams = new Map<string, (item: unknown) => void>([
    ["1", onConfigItem],
    ["2", onShellItem],
  ]);
  const send = (m: unknown) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(m));
  sock.on("open", () => {
    send({ _tag: "Request", id: "1", tag: "subscribeServerConfig", payload: {}, headers: [] });
    send({ _tag: "Request", id: "2", tag: "orchestration.subscribeShell", payload: {}, headers: [] });
  });
  sock.on("message", (data) => {
    let msg: { _tag?: string; requestId?: string; values?: unknown[] };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg._tag === "Ping") return void send({ _tag: "Pong" });
    if (msg._tag === "Exit") return onExit(msg as { requestId?: string; exit?: { _tag?: string; value?: unknown } });
    if (msg._tag !== "Chunk" || !msg.requestId) return;
    const take = streams.get(msg.requestId);
    for (const v of msg.values ?? []) {
      try {
        take?.(v);
      } catch { /* a shape this build doesn't know */ }
    }
    send({ _tag: "Ack", requestId: msg.requestId });
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (ws === sock) ws = null;
    // T3 still up: the streams come back (a fresh ticket each time)
    if (gen === generation && status.state === "running") setTimeout(() => void connect(base, gen).catch(() => {}), 1500);
  });
}

function killTree(c: ChildProcess) {
  if (c.pid && process.platform === "win32") execFile("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true }, () => {});
  else c.kill();
}

/** a person pressed Start. Resolves once T3 is running (or says why it isn't); a second press while it starts joins the first */
let starting: Promise<T3HostStatus> | null = null;
export function startT3(by: string): Promise<T3HostStatus> {
  if (status.state === "running") return Promise.resolve(t3Host());
  starting ??= run(by).finally(() => (starting = null));
  return starting;
}

async function run(by: string): Promise<T3HostStatus> {
  const gen = ++generation;
  projects.clear();
  threads.clear();
  set({ state: "starting", detail: "Finding the T3 program", startedBy: by, agents: [], port: undefined, version: undefined });
  try {
    // FOUNDATION_T3_CLI names Foundation's own T3 program apart from Vision Code's (T3_CLI), which hand-offs use
    const own = process.env.FOUNDATION_T3_CLI;
    const cli = own ? { found: own, tried: [own] } : findT3Cli();
    if (!cli.found) throw new Error(`The T3 program isn't on this computer. Looked in: ${cli.tried.join("; ")}. Install Vision Code, or set T3_CLI to a t3 program (t3.exe on Windows) where Foundation's server starts.`);
    if (cli.found !== ON_PATH && !existsSync(cli.found)) throw new Error(`The T3 program isn't on this computer at ${cli.found}. Install Vision Code, or set T3_CLI to a t3 program (t3.exe on Windows) where Foundation's server starts.`);
    const { cmd, pre } = t3Command(cli.found);
    const home = HOME();
    seedHome(home);
    const port = await pickPort();
    const token = randomBytes(24).toString("hex");
    const env: NodeJS.ProcessEnv = { ...process.env, T3CODE_HOME: home };
    for (const k of ["T3CODE_PORT", "T3CODE_MODE", "T3CODE_HOST", "T3CODE_DEV_AUTH_TOKEN"]) delete env[k];
    set({ detail: `Starting T3 on port ${port}`, port });
    const c = spawn(cmd, [...pre, "--bootstrap-fd", "0"], { cwd: home, env, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    child = c;
    let err = "";
    c.stderr?.on("data", (b: Buffer) => (err = (err + b).slice(-600)));
    c.on("error", (e) => {
      if (child === c) child = null;
      if (gen === generation) set({ state: "error", detail: `The T3 program at ${cli.found} wouldn't start: ${e.message}` });
    });
    c.on("exit", (code) => {
      if (child === c) child = null;
      if (gen !== generation) return;
      ws?.close();
      bearer = null;
      // stopped by a person is "off" (stopT3 moved the generation on); anything else is said
      set({ state: "error", detail: `T3 stopped on its own (exit ${code ?? "?"})${err.trim() ? `: ${err.trim().split("\n").pop()}` : ""}`, agents: [] });
      for (const id of [...threads.keys()]) tellWork(id, null);
      threads.clear();
    });
    c.stdin?.end(`${JSON.stringify({ mode: "desktop", noBrowser: true, port, t3Home: home, host: "127.0.0.1", desktopBootstrapToken: token, tailscaleServeEnabled: false, tailscaleServePort: 443 })}\n`);
    const base = `http://127.0.0.1:${port}`;
    baseUrl = base;
    loadAdded();
    const version = await waitReady(base, gen);
    bearer = await exchange(base, token);
    set({ state: "running", detail: undefined, version });
    await connect(base, gen);
    // once the socket answers: the board's tools on each Claude-driven agent (a failure here leaves agents working in their folders)
    // (before Start answers, so the first ask already has them)
    for (let i = 0; i < 40 && gen === generation && ws?.readyState !== WebSocket.OPEN; i++) await sleep(100);
    if (gen === generation) await ensureBoardTools().catch(() => {});
    return t3Host();
  } catch (e) {
    if (gen === generation) {
      if (child) killTree(child);
      child = null;
      bearer = null;
      if (status.state !== "error") set({ state: "error", detail: (e as Error).message });
    }
    return t3Host();
  }
}

/** a person pressed Stop: T3 and the agents it runs end; its threads are kept in its home */
export function stopT3(): T3HostStatus {
  generation++;
  ws?.close();
  ws = null;
  bearer = null;
  if (child) killTree(child);
  child = null;
  baseUrl = null;
  for (const w of waiting.values()) w.fail(new Error("T3 was stopped"));
  waiting.clear();
  projects.clear();
  for (const id of [...threads.keys()]) tellWork(id, null);
  threads.clear();
  set({ state: "off", detail: undefined, agents: [], port: undefined, version: undefined, startedBy: undefined });
  return t3Host();
}

// ---------- asking T3 for things (a request and its answer, on the same socket) ----------

let rpcSeq = 0;
const waiting = new Map<string, { ok(v: unknown): void; fail(e: Error): void }>();

function describeExit(exit: unknown) {
  const s = JSON.stringify(exit);
  const m = s.match(/"message":"([^"]{1,300})"/) ?? s.match(/"detail":"([^"]{1,300})"/);
  return m ? m[1] : s.slice(0, 300);
}

function onExit(msg: { requestId?: string; exit?: { _tag?: string; value?: unknown } }) {
  const w = msg.requestId ? waiting.get(msg.requestId) : undefined;
  if (!w || !msg.exit) return;
  waiting.delete(msg.requestId!);
  if (msg.exit._tag === "Success") w.ok(msg.exit.value);
  else w.fail(new Error(describeExit(msg.exit)));
}

function rpc(tag: string, payload: unknown, ms = 15_000): Promise<unknown> {
  const sock = ws;
  if (status.state !== "running" || !sock || sock.readyState !== WebSocket.OPEN) return Promise.reject(new Error("T3 isn't running. Start it from the agents pane."));
  const id = `r${++rpcSeq}`;
  return new Promise((ok, fail) => {
    const t = setTimeout(() => (waiting.delete(id), fail(new Error(`T3 didn't answer ${tag}`))), ms);
    waiting.set(id, { ok: (v) => (clearTimeout(t), ok(v)), fail: (e) => (clearTimeout(t), fail(e)) });
    sock.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });
}

/** an orchestration command, over T3's HTTP (the same commands its own client sends) */
async function dispatch(command: Record<string, unknown>) {
  if (status.state !== "running" || !bearer || !baseUrl) throw new Error("T3 isn't running. Start it from the agents pane.");
  const r = await fetch(`${baseUrl}/api/orchestration/dispatch`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`T3 refused ${String(command.type)} (HTTP ${r.status}): ${describeExit(await r.json().catch(() => ({})))}`);
}

// ---------- threads: a piece of work for one agent ----------

const normRoot = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Start a thread on a chosen agent, working in `folder`. This runs a model on
 * someone's plan or key, so only a person's press reaches here (index.ts).
 * Supervised: what the agent would change waits for a person, in T3.
 */
export async function startT3Thread(opts: { agent: string; model?: string; title: string; text: string; folder: string; projectTitle: string }): Promise<{ threadId: string; agent: T3Agent; model: string }> {
  const agent = status.agents.find((a) => a.id === opts.agent);
  if (!agent) throw new Error(`T3 has no agent "${opts.agent}".`);
  if (agent.state !== "ready") throw new Error(`${agent.name} can't take work: ${t3AgentWhy(agent)}.`);
  const model = opts.model || agent.model || agent.modelList[0]?.slug;
  if (!model) throw new Error(`${agent.name} has no model to run. Pick one.`);
  mkdirSync(opts.folder, { recursive: true });
  const want = normRoot(opts.folder);
  let projectId = [...projects.entries()].find(([, p]) => p.root && normRoot(p.root) === want)?.[0];
  const at = new Date().toISOString();
  if (!projectId) {
    projectId = randomUUID();
    await dispatch({ type: "project.create", commandId: randomUUID(), projectId, title: opts.projectTitle, workspaceRoot: opts.folder, createWorkspaceRootIfMissing: true, createdAt: at });
    projects.set(projectId, { title: opts.projectTitle, root: opts.folder });
  }
  const threadId = randomUUID();
  const modelSelection = { instanceId: agent.id, model };
  const title = opts.title.trim().slice(0, 80) || "Untitled";
  await dispatch({
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: opts.text, attachments: [] },
    modelSelection,
    titleSeed: title,
    runtimeMode: "approval-required",
    interactionMode: "default",
    bootstrap: { createThread: { projectId, title, modelSelection, runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null, createdAt: at } },
    createdAt: at,
  });
  return { threadId, agent, model };
}

/** stop a thread's turn (its agent stops; the thread is kept) */
export async function interruptT3Thread(threadId: string) {
  await dispatch({ type: "thread.turn.interrupt", commandId: randomUUID(), threadId, createdAt: new Date().toISOString() });
}

/**
 * A one-time link that opens T3's own page for a person (signed in by the
 * link), at a thread when given one: where a supervised thread's approvals
 * are answered and its whole transcript reads. Minted per press; never stored.
 */
export async function t3OpenLink(threadId?: string): Promise<string> {
  if (status.state !== "running" || !bearer || !baseUrl) throw new Error("T3 isn't running. Start it from the agents pane.");
  const r = await fetch(`${baseUrl}/api/auth/pairing-token`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ label: "Foundation" }), signal: AbortSignal.timeout(5000) });
  const credential = ((await r.json().catch(() => ({}))) as { credential?: string }).credential;
  if (!credential) throw new Error(`T3 refused a link (HTTP ${r.status})`);
  const next = threadId && envId ? `&next=${encodeURIComponent(`/${envId}/${threadId}`)}` : "";
  return `${baseUrl}/pair#token=${encodeURIComponent(credential)}${next}`;
}

// ---------- more agents: Kimi and DeepSeek, in the cloud or on this computer ----------

/**
 * T3 has no Kimi or DeepSeek driver. Both speak Anthropic's API, so each comes
 * in as another instance of T3's Claude agent pointed at their endpoint, with
 * a folder of its own (never this computer's Claude sign-in).
 *
 * cloud: the vendor's own endpoint and a person's API key (kept by T3, marked
 *        sensitive; Foundation never stores it or sends it back).
 * local: a model server on this computer (Ollama's address by default) and a
 *        model that's been pulled there. No key, nothing leaves the computer.
 */
export const T3_PRESETS: Record<string, { name: string; cloud: { baseUrl: string; model: string }; local: { baseUrl: string; model: string } }> = {
  // Claude on a person's own API key (2026-11-17): Anthropic's endpoint, cloud only. Beside it, T3's own
  // Claude agent is the one signed in with an account.
  claude: { name: "Claude (API key)", cloud: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" }, local: { baseUrl: "http://127.0.0.1:11434", model: "" } },
  kimi: { name: "Kimi", cloud: { baseUrl: "https://api.moonshot.ai/anthropic", model: "kimi-k3" }, local: { baseUrl: "http://127.0.0.1:11434", model: "" } },
  deepseek: { name: "DeepSeek", cloud: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro" }, local: { baseUrl: "http://127.0.0.1:11434", model: "" } },
};

export { isClaudeDriven };

const isLoopback = (url: string) => {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
};

export interface AddAgentInput {
  preset: string;
  where: "cloud" | "local";
  /** cloud only: the person's API key for that vendor */
  apiKey?: string;
  /** the model to run; cloud has a default, local needs one that's on this computer */
  model?: string;
  /** another address than the preset's (a region, a different local server) */
  baseUrl?: string;
}

export async function addT3Agent(input: AddAgentInput): Promise<T3Agent[]> {
  const preset = T3_PRESETS[input.preset];
  if (!preset) throw new Error(`No such agent to add: ${input.preset}. Known: ${Object.keys(T3_PRESETS).join(", ")}.`);
  if (input.where !== "cloud" && input.where !== "local") throw new Error("Say where it runs: cloud or local.");
  if (input.preset === "claude" && input.where === "local") throw new Error("Claude runs in the cloud: add it with an API key, or sign in with an account.");
  const d = preset[input.where];
  const base = (input.baseUrl ?? d.baseUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("The address must start with http:// or https://.");
  const model = (input.model ?? d.model).trim();
  if (!model) throw new Error(input.where === "local" ? "Name the model on this computer to run (one your local server has)." : "Name the model to run.");
  const key = (input.apiKey ?? "").trim();
  if (input.where === "local") {
    if (!isLoopback(base)) throw new Error(`A local agent's address must be on this computer (localhost). ${base} isn't.`);
  } else {
    if (isLoopback(base)) throw new Error("A cloud agent's address can't be on this computer. Add it as local.");
    if (!/^https:\/\//i.test(base)) throw new Error("A cloud agent's address must be https.");
    if (!key) throw new Error(`${preset.name}'s cloud needs an API key.`);
  }
  const id = `${input.preset}-${input.where}`;
  const name = input.where === "local" ? `${preset.name} (local)` : preset.name;
  const home = join(HOME(), "claude-homes", id);
  mkdirSync(home, { recursive: true });
  const settings = obj(await rpc("server.getSettings", {}));
  const instances = { ...(obj(settings?.providerInstances) ?? {}) };
  instances[id] = {
    driver: "claudeAgent",
    displayName: name,
    enabled: true,
    environment: [
      { name: "ANTHROPIC_BASE_URL", value: base, sensitive: false },
      // local servers take any token; a cloud key is T3's to keep, marked sensitive. Anthropic's own endpoint
      // takes its key as an API key (x-api-key), the others as a bearer token
      { name: "ANTHROPIC_AUTH_TOKEN", value: input.where === "local" ? "local" : input.preset === "claude" ? "" : key, sensitive: input.where === "cloud" && input.preset !== "claude" },
      { name: "ANTHROPIC_API_KEY", value: input.preset === "claude" ? key : "", sensitive: input.preset === "claude" },
      { name: "ANTHROPIC_MODEL", value: model, sensitive: false },
    ],
    config: { homePath: home, customModels: [{ slug: model, name: `${preset.name} · ${model}` }], launchArgs: BOARD_TOOL_ARGS },
  };
  await rpc("server.updateSettings", { patch: { providerInstances: instances } });
  added.set(id, { preset: input.preset, where: input.where, baseUrl: base, model });
  withTools.add(id);
  saveAdded();
  await rpc("server.refreshProviders", { instanceId: id }).catch(() => {});
  set({ agents: status.agents.map(place) });
  return status.agents;
}

export async function removeT3Agent(id: string): Promise<T3Agent[]> {
  if (!added.has(id)) throw new Error("Only agents added from Foundation can be removed here.");
  const settings = obj(await rpc("server.getSettings", {}));
  const instances = { ...(obj(settings?.providerInstances) ?? {}) };
  delete instances[id];
  await rpc("server.updateSettings", { patch: { providerInstances: instances } });
  added.delete(id);
  saveAdded();
  set({ agents: status.agents.filter((a) => a.id !== id) });
  return status.agents;
}

/** model servers on this computer that a local agent could use (Ollama's address; asked when the form opens) */
export async function localModels(base = T3_PRESETS.kimi.local.baseUrl): Promise<{ baseUrl: string; up: boolean; models: string[] }> {
  if (!isLoopback(base)) throw new Error("Only an address on this computer can be asked.");
  try {
    const r = await fetch(`${base.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { models?: Array<{ name?: string }> };
    return { baseUrl: base, up: r.ok, models: (j.models ?? []).map((m) => m.name ?? "").filter(Boolean) };
  } catch {
    return { baseUrl: base, up: false, models: [] };
  }
}

// ---------- the board's tools, for agents T3 runs ----------

/** the file an ask's folder holds: Foundation's tool server, bound to that ask's agent, person and board (t3threads.ts) */
export const BOARD_TOOLS_FILE = ".foundation-mcp.json";
/**
 * What a Claude-driven agent is launched with so a thread can reach the
 * board: the tool file in the folder it works in (a relative path: each ask
 * has its own folder, so each thread gets its own pass), the board's tools
 * allowed without an approval each (everything else a supervised thread does
 * still waits for a person), and no other tool servers: this computer's own
 * Claude connectors (mail, docs, trackers) stay out of a board agent's reach.
 */
export const BOARD_TOOL_ARGS = `--mcp-config ${BOARD_TOOLS_FILE} --allowedTools mcp__foundation --strict-mcp-config`;

const isClaudeDriven = (a: { driver: string }) => a.driver === "claudeAgent";
/** agents whose launch line carries the board's tools (asked of T3 at start and after adding one) */
const withTools = new Set<string>();

/**
 * Put the board's tools on every Claude-driven agent's launch line. A launch
 * line a person wrote in T3 is theirs: it's left as it is, and that agent
 * works in its folder without the board.
 */
async function ensureBoardTools() {
  const settings = obj(await rpc("server.getSettings", {}, 5000));
  withTools.clear();
  const builtIn = obj(obj(settings?.providers)?.claudeAgent);
  const args = str(builtIn?.launchArgs) ?? "";
  if (!args) await rpc("server.updateSettings", { patch: { providers: { claudeAgent: { launchArgs: BOARD_TOOL_ARGS } } } });
  if (!args || args === BOARD_TOOL_ARGS) withTools.add("claudeAgent");
  const instances = { ...(obj(settings?.providerInstances) ?? {}) } as Record<string, Record<string, unknown>>;
  let changed = false;
  for (const [id, inst] of Object.entries(instances)) {
    if (!added.has(id) || inst?.driver !== "claudeAgent") continue;
    const cfg = obj(inst.config) ?? {};
    const has = str(cfg.launchArgs) ?? "";
    if (!has) {
      instances[id] = { ...inst, config: { ...cfg, launchArgs: BOARD_TOOL_ARGS } };
      changed = true;
    }
    if (!has || has === BOARD_TOOL_ARGS) withTools.add(id);
  }
  if (changed) await rpc("server.updateSettings", { patch: { providerInstances: instances } });
  set({ agents: status.agents.map(place) });
}

// Foundation going away takes its T3 with it
process.once("exit", () => {
  if (child?.pid) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
      else child.kill();
    } catch { /* already gone */ }
  }
});

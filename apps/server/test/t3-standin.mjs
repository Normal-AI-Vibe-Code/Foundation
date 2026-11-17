/**
 * A stand-in `t3` for tests and the browser checks (see t3-standin.ts for what
 * it answers). Run as T3 is: the bootstrap line on stdin. Its files
 * (control.json in, dispatch.json and settings.json out) are in
 * T3_STANDIN_DIR. T3_STANDIN_FINISH_MS: a started thread finishes by itself
 * after that long (the browser checks have nobody to drive it).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
const DIR = process.env.T3_STANDIN_DIR || tmpdir();
const FINISH_MS = Number(process.env.T3_STANDIN_FINISH_MS || 0);
// the built-in Claude agent's launch line (T3_STANDIN_LAUNCH_ARGS: one a person already wrote)
let builtInArgs = process.env.T3_STANDIN_LAUNCH_ARGS || "";
// T3_STANDIN_USE_TOOLS: a started thread uses the tool file in its folder once (a note in its section), as an agent would
const USE_TOOLS = !!process.env.T3_STANDIN_USE_TOOLS;
const roots = {};
async function useTools(c) {
  try {
    const cfg = JSON.parse(readFileSync(join(roots[c.bootstrap.createThread.projectId], ".foundation-mcp.json"), "utf8")).mcpServers.foundation;
    const section = (/in the section “([^”]+)”/.exec(c.message.text) || [])[1];
    const who = (/^You are ([^,]+),/.exec(c.message.text) || [])[1];
    const r = await fetch(cfg.url, { method: "POST", headers: { ...cfg.headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_note", arguments: { section, title: "Checked by " + who, markdown: "Prices match the supplier list." } } }) });
    writeFileSync(join(DIR, "tools-used.json"), JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 400) }));
  } catch (e) {
    writeFileSync(join(DIR, "tools-used.json"), JSON.stringify({ error: String(e) }));
  }
}
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(import.meta.url)("ws");
let line = "";
for await (const b of process.stdin) line += b;
const boot = JSON.parse(line);
const control = join(DIR, "control.json");
const dispatched = [];
let instances = {};
let live = null;
const ids = {};
const provider = (instanceId, extra = {}) => ({ instanceId, driver: instanceId, displayName: instanceId === "claudeAgent" ? "Claude" : "Codex", enabled: true, installed: true, version: "1.0.0", status: "ready", auth: { status: "authenticated", label: "Team Subscription" }, models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }, { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" }], ...extra });
const providers = () => [
  provider("claudeAgent"),
  provider("codex", { installed: false, status: "error", auth: { status: "unknown" }, message: "Could not start Codex CLI", models: [] }),
  ...Object.entries(instances).map(([id, c]) => provider(id, { driver: c.driver, displayName: c.displayName, auth: { status: "unknown" }, models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }, ...((c.config && c.config.customModels) || []).map((m) => ({ slug: m.slug, name: m.name, isCustom: true }))] })),
];
const threads = {};
const send = (tag, values) => live && live.send(JSON.stringify({ _tag: "Chunk", requestId: ids[tag], values }));
const upsert = (t) => { threads[t.id] = t; send("orchestration.subscribeShell", [{ kind: "thread-upserted", sequence: 1, thread: t }]); };
let bearer = null, ticket = null;
const http = createServer(async (req, res) => {
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/.well-known/t3/environment") return json(200, { environmentId: "env1", serverVersion: "0.0.44" });
  let body = ""; for await (const b of req) body += b;
  if (req.url === "/oauth/token") {
    if (new URLSearchParams(body).get("subject_token") !== boot.desktopBootstrapToken) return json(401, {});
    bearer = "bearer-" + Math.random().toString(36).slice(2);
    return json(200, { access_token: bearer });
  }
  if (req.headers.authorization !== "Bearer " + bearer) return json(401, { message: "not signed in" });
  if (req.url === "/api/auth/websocket-ticket") { ticket = "ticket-" + Math.random().toString(36).slice(2); return json(200, { ticket }); }
  if (req.url === "/api/auth/pairing-token") return json(200, { id: "pl1", credential: "cred-" + Math.random().toString(36).slice(2), expiresAt: "2026-11-12T12:00:00Z" });
  if (req.url === "/api/orchestration/dispatch") {
    const c = JSON.parse(body);
    dispatched.push(c);
    writeFileSync(join(DIR, "dispatch.json"), JSON.stringify(dispatched));
    if (c.type === "project.create") roots[c.projectId] = c.workspaceRoot;
    if (c.type === "project.create") send("orchestration.subscribeShell", [{ kind: "project-upserted", sequence: 1, project: { id: c.projectId, title: c.title, workspaceRoot: c.workspaceRoot } }]);
    if (c.type === "thread.turn.start") {
      if (c.message.text.includes("REFUSE")) return json(400, { message: "the provider refused this turn" });
      const b = c.bootstrap.createThread;
      upsert({ id: c.threadId, projectId: b.projectId, title: b.title, modelSelection: c.modelSelection, latestTurn: { state: "running" }, session: { status: "running", providerInstanceId: c.modelSelection.instanceId }, hasPendingApprovals: false, hasPendingUserInput: false, archivedAt: null, updatedAt: new Date().toISOString() });
      if (USE_TOOLS) setTimeout(() => void useTools(c), 1500);
      if (FINISH_MS) setTimeout(() => threads[c.threadId] && upsert({ ...threads[c.threadId], latestTurn: { state: "completed" }, session: { status: "ready", providerInstanceId: c.modelSelection.instanceId } }), FINISH_MS);
    }
    if (c.type === "thread.turn.interrupt" && threads[c.threadId]) upsert({ ...threads[c.threadId], latestTurn: { state: "interrupted" }, session: { status: "interrupted", providerInstanceId: threads[c.threadId].modelSelection.instanceId } });
    return json(200, { sequence: dispatched.length });
  }
  json(404, {});
});
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/ws" || u.searchParams.get("wsTicket") !== ticket) return sock.destroy();
  ticket = null;
  wss.handleUpgrade(req, sock, head, (ws) => {
    live = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m._tag !== "Request") return;
      const done = (value) => ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Success", value } }));
      // what T3 sends back: a sensitive value is redacted
      const shown = () => Object.fromEntries(Object.entries(instances).map(([id, c]) => [id, { ...c, environment: (c.environment || []).map((e) => (e.sensitive ? { name: e.name, value: "", sensitive: true, valueRedacted: true } : e)) }]));
      if (m.tag === "subscribeServerConfig") { ids[m.tag] = m.id; send(m.tag, [{ version: 1, type: "snapshot", config: { providers: providers() } }]); }
      else if (m.tag === "orchestration.subscribeShell") { ids[m.tag] = m.id; send(m.tag, [{ kind: "snapshot", snapshot: { projects: [], threads: [] } }]); }
      else if (m.tag === "server.getSettings") done({ providers: { claudeAgent: { launchArgs: builtInArgs } }, providerInstances: shown() });
      else if (m.tag === "server.updateSettings") {
        const patch = m.payload.patch;
        if (patch.providers?.claudeAgent?.launchArgs !== undefined) { builtInArgs = patch.providers.claudeAgent.launchArgs; writeFileSync(join(DIR, "builtin.json"), JSON.stringify({ launchArgs: builtInArgs })); }
        if (!patch.providerInstances) return done({ providerInstances: shown() });
        const next = patch.providerInstances;
        // a redacted value sent back means "keep what you have"
        for (const [id, c] of Object.entries(next)) c.environment = (c.environment || []).map((e) => (e.valueRedacted ? (instances[id]?.environment || []).find((x) => x.name === e.name) || e : e));
        instances = next;
        writeFileSync(join(DIR, "settings.json"), JSON.stringify(instances));
        done({ providerInstances: shown() });
        send("subscribeServerConfig", [{ version: 1, type: "providerStatuses", payload: { providers: providers() } }]);
      } else if (m.tag === "server.refreshProviders") done({ providers: providers() });
      else ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Failure", cause: { message: "unknown method " + m.tag } } }));
    });
    let seen = "";
    const t = setInterval(() => {
      if (!existsSync(control)) return;
      const text = readFileSync(control, "utf8");
      if (text === seen) return;
      seen = text;
      const c = JSON.parse(text);
      const th = threads[c.id];
      if (!th) return;
      if (c.do === "finish") upsert({ ...th, latestTurn: { state: "completed" }, session: { status: "ready", providerInstanceId: th.modelSelection.instanceId }, hasPendingApprovals: false });
      if (c.do === "approve") upsert({ ...th, hasPendingApprovals: true });
      if (c.do === "fail") upsert({ ...th, latestTurn: { state: "error" }, session: { status: "error", providerInstanceId: th.modelSelection.instanceId } });
    }, 40);
    ws.on("close", () => clearInterval(t));
  });
});
http.listen(boot.port, boot.host);

/**
 * The server's own Claude over HTTP (docs/agent-harness.md §1 routes), against the real server in a folder of its
 * own, with a stand-in Anthropic on loopback (no network):
 * - every new route needs a person: an agent's bearer and the service token get 403; changes need an admin;
 * - the API key is checked, stored sealed, and never in any response or in the server's output;
 * - forgetting it needs confirm;
 * - a run's runtime comes from its seat's kind, never from the request (a `runtime` in the body is not read).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GOOD_KEY, startAnthropicStandin } from "./anthropic-standin.ts";

const serverDir = resolve(import.meta.dirname, "..");
const SERVICE = "s".repeat(40);

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

let child: ChildProcess;
let base = "";
let home = "";
const said = { out: "" };
const anthropic = await startAnthropicStandin();

before(async () => {
  home = mkdtempSync(join(tmpdir(), "foundation-claude-routes-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FOUNDATION_|SLACK_|ANTHROPIC_|GOOGLE_|GITHUB_|MESHY_|T3)/.test(k)) env[k] = v;
  Object.assign(env, {
    FOUNDATION_PORT: String(port),
    FOUNDATION_ROOT: home,
    FOUNDATION_EXIT_WITH_PARENT: "1",
    FOUNDATION_STARTER_DIR: "",
    FOUNDATION_DEV_LOGIN: "1",
    FOUNDATION_ALLOWLIST: "@example.test",
    FOUNDATION_ADMIN_EMAILS: "boss@example.test",
    FOUNDATION_SERVICE_TOKEN: SERVICE,
    FOUNDATION_CLAUDE_CLI: join(home, "no-claude"),
    ANTHROPIC_BASE_URL: anthropic.base,
    T3_CLI: join(home, "no-t3"),
    T3_URL: "http://127.0.0.1:9",
    FACTORYFORM_URL: "http://127.0.0.1:9",
  });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout!.on("data", (d) => (said.out += d));
  child.stderr!.on("data", (d) => (said.out += d));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 1200 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server didn't come up:\n${said.out}`);
});

after(async () => {
  child?.stdin?.end();
  child?.kill();
  await anthropic.close();
});

async function call(method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) Object.assign(headers, { cookie: opts.cookie, origin: "http://localhost:1430" });
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* a stream */
  }
  return { status: res.status, text, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const signIn = async (email: string) => (await call("POST", "/auth/dev", { body: { email, name: email.split("@")[0] } })).cookie;

const CHANGES: Array<[string, string, unknown]> = [
  ["PUT", "/api/agents/claude/key", { key: GOOD_KEY }],
  ["DELETE", "/api/agents/claude/key", { confirm: true }],
  ["PUT", "/api/agents/claude/model", { model: "claude-opus-5-5" }],
  ["PUT", "/api/agents/claude/federation", { organizationId: "6b5af527-c7f3-45d6-98e5-62dbdc91afcf", federationRuleId: "fdrl_abc123", identityTokenFile: join(tmpdir(), "x.jwt") }],
  ["DELETE", "/api/agents/claude/federation", { confirm: true }],
];

test("a person reads; an admin, in person, changes; agents and the service token can do neither", async () => {
  const ada = await signIn("ada@example.test");
  const boss = await signIn("boss@example.test");
  const agent = (await call("POST", "/api/agent/token", { cookie: ada })).json.token as string;
  assert.ok(agent);
  for (const bearer of [agent, SERVICE]) {
    for (const path of ["/api/agents/claude", "/api/agents/claude/models"]) assert.equal((await call("GET", path, { bearer })).status, 403, `${path} for ${bearer === SERVICE ? "the service token" : "an agent"}`);
    for (const [method, path, body] of CHANGES) {
      const r = await call(method, path, { bearer, body });
      assert.equal(r.status, 403, `${method} ${path}: ${r.text}`);
      assert.match(r.json.error, /needs a person/);
    }
  }
  for (const [method, path, body] of CHANGES) {
    const r = await call(method, path, { cookie: ada, body });
    assert.equal(r.status, 403, `${method} ${path} for a person who isn't an admin: ${r.text}`);
    assert.match(r.json.error, /Only an admin/);
  }
  const st = await call("GET", "/api/agents/claude", { cookie: ada });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.account.installed, false);
  assert.equal(st.json.account.signedIn, false);
  assert.deepEqual(st.json.api, { configured: false, source: null, model: "claude-opus-5-5" });
  assert.equal(st.json.federated.configured, false);
  assert.match(st.json.federated.why, /isn't set up/);
  const models = await call("GET", "/api/agents/claude/models", { cookie: ada });
  assert.equal(models.json.source, "builtin");
  void boss;
});

test("the key: checked, sealed, never said back or logged; forgetting it needs confirm; the default model is checked against the live list", async () => {
  const boss = await signIn("boss@example.test");
  const ada = await signIn("ada@example.test");
  const bad = await call("PUT", "/api/agents/claude/key", { cookie: boss, body: { key: `sk-ant-api03-${"x".repeat(40)}` } });
  assert.equal(bad.status, 400);
  const put = await call("PUT", "/api/agents/claude/key", { cookie: boss, body: { key: GOOD_KEY } });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json.api, { configured: true, source: "stored", last4: "GOOD", model: "claude-opus-5-5" });
  const piece = GOOD_KEY.slice(13, 40);
  for (const r of [put, await call("GET", "/api/agents/claude", { cookie: ada }), await call("GET", "/api/agents/available", { cookie: ada })]) assert.ok(!r.text.includes(piece), "never in a response");
  const models = await call("GET", "/api/agents/claude/models", { cookie: ada });
  assert.equal(models.json.source, "live");
  assert.equal(models.json.models[0].id, "claude-opus-5-5", "newest first");
  assert.equal((await call("PUT", "/api/agents/claude/model", { cookie: boss, body: { model: "claude-imaginary-9" } })).status, 400);
  assert.equal((await call("PUT", "/api/agents/claude/model", { cookie: boss, body: { model: "claude-haiku-5-5" } })).json.api.model, "claude-haiku-5-5");
  const db = new DatabaseSync(join(home, "data", "foundation.db"), { readOnly: true });
  const rows = JSON.stringify(db.prepare("select * from agent_settings").all());
  const audit = JSON.stringify(db.prepare("select * from audit_log").all());
  db.close();
  assert.ok(!rows.includes(piece), "sealed at rest");
  assert.ok(!audit.includes(piece) && audit.includes("agent.key.set"), "the audit says it was set, never what");
  assert.ok(!said.out.includes(piece), "never in the server's output");
  assert.equal((await call("DELETE", "/api/agents/claude/key", { cookie: boss, body: {} })).status, 400, "forgetting needs confirm");
  assert.equal((await call("DELETE", "/api/agents/claude/key", { cookie: boss, body: { confirm: true } })).json.api.configured, false);
});

test("a run's runtime is its seat's kind, never the request's", async () => {
  const ada = await signIn("ada@example.test");
  const seated = await call("POST", "/api/boards/company/agents", { cookie: ada, body: { place: "*", agent: "claude-api" } });
  assert.equal(seated.status, 200, seated.text);
  const seat = seated.json.seat as { id: string; alias: string; kind: string };
  assert.equal(seat.kind, "claude-api");
  // the request asks for the subscription; the seat is claude-api, which has no key now: it says so, and runs nothing
  const r = await call("POST", "/api/agent", { cookie: ada, body: { board: "company", prompt: "hello", seat: seat.id, runtime: "subscription" } });
  assert.match(r.text, /runs on Foundation's Anthropic API key, and none is set/);
  // by the name it goes by, the same
  const byName = await call("POST", "/api/agent", { cookie: ada, body: { board: "company", prompt: "hello", as: seat.alias, runtime: "subscription" } });
  assert.match(byName.text, /none is set/);
  assert.equal(anthropic.seen.filter((s) => s.path === "/v1/messages").length, 0);
});

test("an ask for a seat that isn't on the grid is 404, never the default agent", async () => {
  const ada = await signIn("ada@example.test");
  const a = await call("POST", "/api/agent", { cookie: ada, body: { board: "company", prompt: "hello", seat: "seat_nope000000" } });
  assert.equal(a.status, 404, a.text);
  assert.match(a.json.error, /No such seat/);
  const b = await call("POST", "/api/agent", { cookie: ada, body: { board: "company", prompt: "hello", as: "Nobody" } });
  assert.equal(b.status, 404, b.text);
});

test("where the identity token is kept is shown to admins only", async () => {
  const ada = await signIn("ada@example.test");
  const boss = await signIn("boss@example.test");
  const file = join(tmpdir(), "not-there-idp", "token.jwt");
  const set = await call("PUT", "/api/agents/claude/federation", { cookie: boss, body: { organizationId: "6b5af527-c7f3-45d6-98e5-62dbdc91afcf", federationRuleId: "fdrl_abc123", identityTokenFile: file } });
  assert.equal(set.status, 200, set.text);
  const forAda = await call("GET", "/api/agents/claude", { cookie: ada });
  assert.equal(forAda.json.federated.configured, false);
  assert.match(forAda.json.federated.why, /identity token file isn't there/);
  assert.ok(!forAda.text.includes("not-there-idp"), "no path for a person who isn't an admin");
  const forBoss = await call("GET", "/api/agents/claude", { cookie: boss });
  assert.ok(forBoss.text.includes("not-there-idp"), "the admin sees where");
  assert.equal((await call("DELETE", "/api/agents/claude/federation", { cookie: boss, body: { confirm: true } })).status, 200);
});

/**
 * The doors to what agents may send outside, and to the audit log, over HTTP against the real server
 * (started as person-gate.test.ts starts it: a folder of its own, no .env).
 *
 * - Anyone who can see a board reads its allowances; only a person who can edit it sets or takes one
 *   back. An agent's bearer and the service token are refused (they aren't a person), and so is a
 *   viewer. Every board starts with nothing allowed.
 * - An agent's bearer can't reach an outside service through a read route either: it gets the same
 *   sentence, and the log has an `asked` row.
 * - The audit log is read by an admin, in person: a member, an admin's agent and the service token are
 *   refused (and that refusal is itself recorded).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
let said = "";
let ada = "";
let boss = "";
let vic = "";
let adaAgent = "";
let bossAgent = "";
let home = "";

before(async () => {
  home = mkdtempSync(join(tmpdir(), "foundation-egress-doors-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FOUNDATION_|SLACK_|ANTHROPIC_|GOOGLE_|GITHUB_|GH_|MESHY_|T3)/.test(k)) env[k] = v;
  Object.assign(env, {
    FOUNDATION_PORT: String(port),
    FOUNDATION_ROOT: home,
    FOUNDATION_EXIT_WITH_PARENT: "1",
    FOUNDATION_STARTER_DIR: "",
    FOUNDATION_CLAUDE_CLI: join(home, "no-claude"),
    ANTHROPIC_API_KEY: "",
    T3_CLI: join(home, "no-t3"),
    T3_URL: "http://127.0.0.1:9",
    FACTORYFORM_URL: "http://127.0.0.1:9",
    FOUNDATION_DEV_LOGIN: "1",
    FOUNDATION_ALLOWLIST: "@example.test",
    FOUNDATION_ADMIN_EMAILS: "boss@example.test",
    FOUNDATION_SERVICE_TOKEN: SERVICE,
  });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout!.on("data", (d) => (said += d));
  child.stderr!.on("data", (d) => (said += d));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 1200 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!base || child.exitCode !== null) throw new Error(`the server didn't come up:\n${said}`);
  ada = await signIn("ada@example.test");
  boss = await signIn("boss@example.test");
  vic = await signIn("vic@example.test");
  const me = await call("GET", "/api/me", { cookie: vic });
  assert.equal((await call("POST", "/api/boards/company/people", { cookie: boss, body: { userId: me.json.user.id, role: "viewer" } })).status, 200);
  adaAgent = (await call("POST", "/api/agent/token", { cookie: ada })).json.token;
  bossAgent = (await call("POST", "/api/agent/token", { cookie: boss })).json.token;
  assert.ok(adaAgent && bossAgent);
});

after(() => {
  child?.stdin?.end();
  child?.kill();
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
    /* not JSON */
  }
  return { status: res.status, text, json };
}

async function signIn(email: string) {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name: email.split("@")[0] }) });
  assert.equal(res.status, 200, await res.text());
  return res.headers.get("set-cookie")!.split(";")[0];
}

const EGRESS = "/api/boards/company/egress";
const slack = (state: Record<string, any>, kind: string) => state.services.find((s: any) => s.service === "Slack").kinds.find((k: any) => k.kind === kind);

test("every board starts with nothing allowed; anyone who can see it reads that", async () => {
  for (const who of [{ cookie: ada }, { cookie: vic }, { bearer: adaAgent }]) {
    const r = await call("GET", EGRESS, who);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.services.every((s: any) => s.kinds.every((k: any) => k.allowed === false)));
    assert.ok(r.json.services.every((s: any) => s.badge === `External service · ${s.service}`));
  }
  const viewer = await call("GET", EGRESS, { cookie: vic });
  assert.equal(viewer.json.canChange, false);
  assert.match(viewer.json.who, /can edit this grid/);
});

test("an agent's bearer, the service token and a viewer can't set an allowance; a person who can edit can, and can take it back", async () => {
  const body = { service: "Slack", kind: "query" };
  for (const bearer of [adaAgent, bossAgent, SERVICE]) {
    const r = await call("POST", EGRESS, { bearer, body });
    assert.equal(r.status, 403, r.text);
    assert.match(r.json.error, /needs a person/);
  }
  const v = await call("POST", EGRESS, { cookie: vic, body });
  assert.equal(v.status, 403, v.text);
  assert.match(v.json.error, /View only/);
  assert.equal((await call("POST", EGRESS, { cookie: ada, body: { service: "Nowhere", kind: "query" } })).status, 400);

  const on = await call("POST", EGRESS, { cookie: ada, body });
  assert.equal(on.status, 200, on.text);
  assert.equal(slack(on.json, "query").allowed, true);
  assert.equal(slack(on.json, "query").allowedBy, "ada");
  assert.equal(slack(on.json, "read").allowed, false, "only that kind");
  const del = await call("DELETE", EGRESS, { bearer: adaAgent, body });
  assert.equal(del.status, 403, "an agent can't take it back either");
  const off = await call("DELETE", EGRESS, { cookie: ada, body });
  assert.equal(off.status, 200, off.text);
  assert.equal(slack(off.json, "query").allowed, false);
});

test("an agent's bearer can't reach a service through a read route; the refusal says why and is recorded", async () => {
  const r = await call("GET", "/api/repo?repo=form-industries/rim&board=company", { bearer: adaAgent });
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /Nothing was sent to GitHub: a person has to allow/);
  const s = await call("GET", "/api/search?q=rim&board=company", { bearer: adaAgent });
  assert.equal(s.status, 200, "the board's own results still come back");
  const log = await call("GET", "/api/audit?limit=500", { cookie: boss });
  const asked = log.json.rows.filter((x: any) => x.decision === "asked" && x.door === "route");
  assert.ok(asked.some((x: any) => x.action.startsWith("GET /api/repo") && x.service === "GitHub"), JSON.stringify(asked));
  assert.ok(asked.some((x: any) => x.action.startsWith("GET /api/search") && x.service === "GitHub"));
});

test("the audit log: an admin in person reads it; a member, an admin's agent and the service token don't", async () => {
  const r = await call("GET", "/api/audit?limit=500", { cookie: boss });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.chain.ok, true);
  const actions = r.json.rows.map((x: any) => x.action);
  for (const a of ["sign_in.dev", "agent_token.mint", "board_role.set", "egress.allow", "egress.revoke"]) assert.ok(actions.includes(a), `${a} is recorded`);
  assert.ok(r.json.rows.some((x: any) => x.action === "POST /api/boards/company/egress" && x.decision === "refused" && x.actor_kind === "service"), "the service token's refusal");
  assert.equal((await call("GET", "/api/audit", { cookie: ada })).status, 403);
  assert.equal((await call("GET", "/api/audit", { bearer: SERVICE })).status, 403);
  const agent = await call("GET", "/api/audit", { bearer: bossAgent });
  assert.equal(agent.status, 403);
  const after = await call("GET", "/api/audit?limit=500", { cookie: boss });
  assert.ok(after.json.rows.some((x: any) => x.action === "GET /api/audit" && x.decision === "refused" && x.actor_kind === "agent"), "an admin's agent asking is recorded");
  const board = await call("GET", "/api/audit?board=company&limit=500", { cookie: boss });
  assert.ok(board.json.rows.length > 0 && board.json.rows.every((x: any) => x.board_id === "company"));
});

test("an agent can't borrow the allowance of a board it can't see by naming it", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const made = await call("POST", "/api/boards", { cookie: boss, body: { name: "Members only" } });
  assert.equal(made.status, 200, made.text);
  const hidden = made.json.id as string;
  const bossId = (await call("GET", "/api/me", { cookie: boss })).json.user.id;
  const db = new DatabaseSync(join(home, "data", "foundation.db"));
  db.prepare("insert into board_members (board_id, user_id, role, source, added_at) values (?, ?, 'owner', 'test', ?)").run(hidden, bossId, Date.now());
  db.close();
  // a person on it allows GitHub reads and Slack, Flowform and GitHub queries there
  for (const body of [{ service: "GitHub", kind: "read" }, { service: "GitHub", kind: "query" }, { service: "Slack", kind: "query" }, { service: "Flowform", kind: "query" }]) {
    assert.equal((await call("POST", `/api/boards/${hidden}/egress`, { cookie: boss, body })).status, 200);
  }
  // Ada's agent names that board on a read route: nothing goes out, as on a board with nothing allowed
  const r = await call("GET", `/api/repo?repo=form-industries/rim&board=${hidden}`, { bearer: adaAgent });
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /Nothing was sent to GitHub: a person has to allow/);
  // search names a board only the caller can see: it answers like a missing one
  assert.equal((await call("GET", `/api/search?q=rim&board=${hidden}`, { bearer: adaAgent })).status, 404);
  assert.equal((await call("GET", `/api/search?q=rim&board=${hidden}`, { cookie: ada })).status, 404);
  assert.equal((await call("GET", "/api/search?q=rim&board=company", { bearer: adaAgent })).status, 200, "a board it can see still works");
});

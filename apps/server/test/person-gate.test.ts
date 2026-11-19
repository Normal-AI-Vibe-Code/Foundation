/**
 * A person is a person (ADR-001 §9 G0, G1, G2, G9, G10, G12; slice 1), over HTTP against the real
 * server, started as `npm run dev:server` starts it, in a folder of its own (no .env, fresh data).
 *
 * - Dev sign-in (no password) is off unless FOUNDATION_DEV_LOGIN=1, and /auth/config says so; on, it
 *   still refuses with no allowlist, from another computer (or through a proxy), and while
 *   Foundation's T3 runs here (its agents have a shell: a stand-in t3, as t3host.test.ts uses).
 * - Running a job, asking the agent, making an agent token, probing an app's address and saving an
 *   app are refused (403, "needs a person") to an agent's bearer and to the service token, and
 *   answered for a person (their browser's cookie, or their app's sign-in bearer).
 * - A viewer who is a person may still ask the agent, but may not probe an address.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeStandin } from "./t3-standin.ts";

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

interface Server {
  child: ChildProcess;
  base: string;
  home: string;
  said: { out: string };
}
const servers: Server[] = [];

/** the server in a folder of its own, with only these settings (nothing from this shell or a .env) */
async function start(extra: Record<string, string>): Promise<Server> {
  const home = mkdtempSync(join(tmpdir(), "foundation-person-gate-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FOUNDATION_|SLACK_|ANTHROPIC_|GOOGLE_|GITHUB_|MESHY_|T3)/.test(k)) env[k] = v;
  Object.assign(env, {
    FOUNDATION_PORT: String(port),
    FOUNDATION_ROOT: home,
    FOUNDATION_EXIT_WITH_PARENT: "1",
    FOUNDATION_STARTER_DIR: "",
    // no agent runtime: asking answers "No agent runtime", nothing is spent
    FOUNDATION_CLAUDE_CLI: join(home, "no-claude"),
    ANTHROPIC_API_KEY: "",
    T3_CLI: join(home, "no-t3"),
    T3_URL: "http://127.0.0.1:9",
    FACTORYFORM_URL: "http://127.0.0.1:9",
    ...extra,
  });
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const said = { out: "" };
  child.stdout!.on("data", (d) => (said.out += d));
  child.stderr!.on("data", (d) => (said.out += d));
  const s: Server = { child, base: `http://127.0.0.1:${port}`, home, said };
  servers.push(s);
  // up to two minutes: a loaded machine has taken a minute to boot it (tsx compiles on start)
  for (let i = 0; i < 1200 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${s.base}/api/health`)).ok) return s;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server didn't come up:\n${said.out}`);
}

after(() => {
  for (const s of servers) {
    s.child.stdin?.end();
    s.child.kill();
  }
});

async function call(s: Server, method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  // a person's browser sends its cookie from the client's page, and says so (origins.ts)
  if (opts.cookie) Object.assign(headers, { cookie: opts.cookie, origin: "http://localhost:1430" }, opts.headers ?? {});
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${s.base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* a stream, or nothing */
  }
  return { status: res.status, text, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

const devSignIn = (s: Server, email: string, more: Record<string, unknown> = {}) => call(s, "POST", "/auth/dev", { body: { email, name: email.split("@")[0], ...more } });

// ---------- dev sign-in ----------

test("dev sign-in is off by default, /auth/config says so, and the server says how to turn it on", async () => {
  const s = await start({});
  const cfg = await call(s, "GET", "/auth/config");
  assert.equal(cfg.json.devLogin, false);
  const r = await devSignIn(s, "ada@formindustries.com");
  assert.equal(r.status, 403);
  assert.match(r.json.error, /FOUNDATION_DEV_LOGIN=1/);
  assert.equal(r.cookie, "", "no session was made");
  assert.match(s.said.out, /dev login\s+off\. To sign in by email on this computer, add FOUNDATION_DEV_LOGIN=1 to \.env/);
});

test("dev sign-in turned on with an empty allowlist is refused (an empty allowlist would admit anyone)", async () => {
  const s = await start({ FOUNDATION_DEV_LOGIN: "1", FOUNDATION_ALLOWLIST: "" });
  assert.equal((await call(s, "GET", "/auth/config")).json.devLogin, true, "it is on, so the sign-in screen offers it");
  const r = await devSignIn(s, "anyone@anywhere.example");
  assert.equal(r.status, 403);
  assert.match(r.json.error, /needs an allowlist/);
});

// ---------- the main server: dev sign-in on, an allowlist, the service token, a stand-in T3 ----------

let main: Server;
let ada = ""; // a person's cookie
let adaApp = ""; // the same person's app bearer (kind `app`)
let agentBearer = ""; // a bearer an agent holds (kind `agent`)
let boss = "";
let vic = ""; // a viewer of the company board, who is a person

before(async () => {
  const standin = writeStandin(mkdtempSync(join(tmpdir(), "foundation-person-gate-t3-")));
  main = await start({
    FOUNDATION_DEV_LOGIN: "1",
    FOUNDATION_ALLOWLIST: "@example.test",
    FOUNDATION_ADMIN_EMAILS: "boss@example.test",
    FOUNDATION_SERVICE_TOKEN: SERVICE,
    FOUNDATION_T3_CLI: standin.cli,
    FOUNDATION_T3_PORT: String(22000 + Math.floor(Math.random() * 2000)),
    FOUNDATION_T3_READY_MS: "10000",
    T3_STANDIN_DIR: process.env.T3_STANDIN_DIR!,
  });
});

test("on: dev sign-in works from this computer for an allowlisted email, and not for one off the list", async () => {
  const r = await devSignIn(main, "ada@example.test");
  assert.equal(r.status, 200, r.text);
  assert.match(r.cookie, /^foundation_session=/);
  ada = r.cookie;
  const app = await devSignIn(main, "ada@example.test", { bearer: true });
  assert.equal(app.status, 200);
  adaApp = app.json.session;
  assert.ok(adaApp);
  assert.equal((await devSignIn(main, "eve@elsewhere.example")).status, 403);
  boss = (await devSignIn(main, "boss@example.test")).cookie;
  vic = (await devSignIn(main, "vic@example.test")).cookie;
  const vicId = (await call(main, "GET", "/api/me", { cookie: vic })).json.user.id;
  assert.equal((await call(main, "POST", "/api/boards/company/people", { cookie: boss, body: { userId: vicId, role: "viewer" } })).status, 200);
});

test("an agent token: a person makes it, it lasts 7 days, and neither an agent's token nor the service token can make one", async () => {
  const r = await call(main, "POST", "/api/agent/token", { cookie: ada });
  assert.equal(r.status, 200, r.text);
  agentBearer = r.json.token;
  assert.ok(agentBearer);
  // the person's own app (its sign-in bearer) is a person too
  assert.equal((await call(main, "POST", "/api/agent/token", { bearer: adaApp })).status, 200);

  const db = new DatabaseSync(join(main.home, "data", "foundation.db"), { readOnly: true });
  const rows = db.prepare("select created_at, expires_at from sessions where kind = 'agent'").all() as Array<{ created_at: number; expires_at: number }>;
  db.close();
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.expires_at - row.created_at, 7 * 864e5, "an agent token lasts a week");

  for (const bearer of [agentBearer, SERVICE]) {
    const no = await call(main, "POST", "/api/agent/token", { bearer });
    assert.equal(no.status, 403, no.text);
    assert.match(no.json.error, /Making an agent token needs a person/);
  }
});

/** each route that only a person may start: what a person gets, and that agents and the service token get 403 */
const ROUTES: Array<{ name: string; method: string; path: string; body: () => unknown; person: (r: Awaited<ReturnType<typeof call>>) => void }> = [
  {
    name: "running a job",
    method: "POST",
    path: "/api/jobs/job_none/run",
    body: () => ({}),
    // past the person gate, the route's own answer: there's no such job (a real one would run third-party code)
    person: (r) => {
      assert.equal(r.status, 404, r.text);
      assert.match(r.json.error, /no such job/);
    },
  },
  {
    name: "asking the agent",
    method: "POST",
    path: "/api/agent",
    body: () => ({ board: "company", prompt: "What's on this board?" }),
    // the run starts and says there's no runtime here (nothing is spent in a test)
    person: (r) => {
      assert.equal(r.status, 200, r.text);
      assert.match(r.text, /No agent runtime/);
    },
  },
  {
    name: "probing an app's address",
    method: "POST",
    path: "/api/apps/probe",
    body: () => ({ url: `${main.base}/api/health` }),
    person: (r) => assert.equal(r.status, 200, r.text),
  },
  {
    name: "saving an app",
    method: "POST",
    path: "/api/apps",
    body: () => ({ name: "Gate check", url: `${main.base}/api/health`, description: "made by person-gate.test.ts" }),
    person: (r) => {
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.app.name, "Gate check");
    },
  },
];

for (const route of ROUTES) {
  test(`${route.name}: refused to an agent's bearer and to the service token, answered for a person`, async () => {
    assert.ok(agentBearer, "an agent's bearer was made above");
    for (const [who, bearer] of [["an agent's bearer", agentBearer], ["the service token", SERVICE]] as const) {
      const r = await call(main, route.method, route.path, { bearer, body: route.body() });
      assert.equal(r.status, 403, `${who}: ${r.text}`);
      assert.match(r.json.error, /needs a person/, who);
    }
    // an agent's bearer sent with a person's cookie is still the agent
    assert.equal((await call(main, route.method, route.path, { bearer: agentBearer, cookie: ada, body: route.body() })).status, 403);
    route.person(await call(main, route.method, route.path, { cookie: ada, body: route.body() }));
    route.person(await call(main, route.method, route.path, { bearer: adaApp, body: route.body() }));
  });
}

test("a viewer who is a person may still ask the agent, but may not probe an address", async () => {
  const asked = await call(main, "POST", "/api/agent", { cookie: vic, body: { board: "company", prompt: "What's here?" } });
  assert.equal(asked.status, 200, asked.text);
  const probed = await call(main, "POST", "/api/apps/probe?board=company", { cookie: vic, body: { url: `${main.base}/api/health` } });
  assert.equal(probed.status, 403, probed.text);
  assert.match(probed.json.error, /View only/);
});

test("dev sign-in is refused while Foundation's T3 runs here, and works again once it stops", async () => {
  const started = await call(main, "POST", "/api/t3host/start", { cookie: ada });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.state, "running", started.text);
  const r = await devSignIn(main, "kai@example.test");
  assert.equal(r.status, 403);
  assert.match(r.json.error, /refused while T3 is running/);
  assert.equal(r.cookie, "");
  assert.equal((await call(main, "POST", "/api/t3host/stop", { cookie: ada })).status, 200);
  assert.equal((await devSignIn(main, "kai@example.test")).status, 200);
});

// ---------- the rule itself, for what can't be sent from here: another computer, a proxy ----------

test("dev sign-in's rule: only a loopback peer, and not one a proxy forwards", async () => {
  process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-person-gate-rule-"));
  process.env.FOUNDATION_DEV_LOGIN = "1";
  process.env.FOUNDATION_ALLOWLIST = "@example.test";
  const { devSignInRefusal } = await import("../src/auth.ts");
  const req = (addr: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: addr }, headers }) as unknown as Parameters<typeof devSignInRefusal>[0];
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(devSignInRefusal(req(addr), false), null, addr);
  for (const addr of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", ""]) assert.match(devSignInRefusal(req(addr), false) ?? "", /only from the computer the server runs on/, addr);
  assert.match(devSignInRefusal(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }), false) ?? "", /only from the computer/);
  assert.match(devSignInRefusal(req("127.0.0.1", { forwarded: "for=203.0.113.9" }), false) ?? "", /only from the computer/);
  assert.match(devSignInRefusal(req("127.0.0.1"), true) ?? "", /T3 is running/);
});

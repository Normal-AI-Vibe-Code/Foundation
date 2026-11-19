/**
 * A viewer reads; a viewer's press doesn't change or start anything on the board. Over HTTP against the real
 * server, started as `npm run dev:server` starts it, in a folder of its own (no .env, fresh data):
 *
 * - Running a job needs someone who can edit the job's board, not only see it: a viewer who is a person gets
 *   the view-only refusal, and the job stays queued.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const serverDir = resolve(import.meta.dirname, "..");
const SERVICE = "v".repeat(40);
const CLIENT = "http://localhost:1430";

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
let said = "";

before(async () => {
  home = mkdtempSync(join(tmpdir(), "foundation-viewer-reach-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FOUNDATION_|SLACK_|ANTHROPIC_|GOOGLE_|GITHUB_|MESHY_|T3)/.test(k)) env[k] = v;
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
  // up to two minutes: a loaded machine has taken a minute to boot it (tsx compiles on start)
  for (let i = 0; i < 1200 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server didn't come up:\n${said}`);
});

after(() => {
  child?.stdin?.end();
  child?.kill();
});

async function call(method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) Object.assign(headers, { cookie: opts.cookie, origin: CLIENT });
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
  return { status: res.status, text, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

const signIn = async (email: string) => {
  const r = await call("POST", "/auth/dev", { body: { email, name: email.split("@")[0] } });
  assert.equal(r.status, 200, r.text);
  return r.cookie;
};

let boss = "";
let vic = ""; // a member account who is a viewer of the company board, a person at their browser

test("set up: an admin, and a person who only views the company board", async () => {
  boss = await signIn("boss@example.test");
  vic = await signIn("vic@example.test");
  const vicId = (await call("GET", "/api/me", { cookie: vic })).json.user.id;
  assert.equal((await call("POST", "/api/boards/company/people", { cookie: boss, body: { userId: vicId, role: "viewer" } })).status, 200);
});

test("running a job: a viewer of the job's board who is a person gets the view-only refusal, and nothing starts", async () => {
  // a queued job on the company board (as an agent's reverse_engineer would leave it)
  const db = new DatabaseSync(join(home, "data", "foundation.db"));
  db.prepare("insert into jobs (id, kind, target, goal, board_id, status, created_by, created_at) values (?, ?, ?, ?, ?, 'queued', ?, ?)").run(
    "job_viewer",
    "rea",
    home,
    "made by viewer-reach.test.ts",
    "company",
    "agent",
    Date.now(),
  );
  const r = await call("POST", "/api/jobs/job_viewer/run", { cookie: vic, body: {} });
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /View only/);
  const row = db.prepare("select status from jobs where id = ?").get("job_viewer") as { status: string };
  db.close();
  assert.equal(row.status, "queued", "the job didn't start");
});

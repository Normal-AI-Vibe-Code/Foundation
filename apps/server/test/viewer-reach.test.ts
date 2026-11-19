/**
 * A viewer reads; a viewer's press doesn't change or start anything on the board. Over HTTP against the real
 * server, started as `npm run dev:server` starts it, in a folder of its own (no .env, fresh data):
 *
 * - Running a job needs someone who can edit the job's board, not only see it: a viewer who is a person gets
 *   the view-only refusal, and the job stays queued.
 * - A viewer who is a person may make an agent token (agent tokens carry no board scope of their own: the
 *   agent acts as the person, with the person's role), and that token is refused every write tool (each
 *   called with an input its schema accepts) and every route that needs a person.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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

// ---------- a viewer's agent token: made by a person, it reaches only what that viewer reaches ----------

/**
 * A value that a JSON schema accepts (from the tool's own zod schema): the first enum value or constant,
 * the smallest number in range, a string as long as it must be, an array as short as it may be, and each
 * required property. Enough to get past input checking, so the refusal tested is the role, not the input.
 */
function sample(s: Record<string, any>): unknown {
  if (!s || typeof s !== "object") return null;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.default !== undefined) return s.default;
  for (const k of ["anyOf", "oneOf"]) if (Array.isArray(s[k])) return sample(s[k].find((x: any) => x.type !== "null") ?? s[k][0]);
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map(sample));
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
  switch (type) {
    case "string":
      if (s.format === "uri") return "https://example.test/";
      return "x".repeat(Math.max(1, s.minLength ?? 1));
    case "number":
    case "integer":
      return s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    case "boolean":
      return true;
    case "array":
      return Array.from({ length: s.minItems ?? 0 }, () => sample(s.items ?? {}));
    default: {
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) out[k] = sample(s.properties?.[k] ?? {});
      return out;
    }
  }
}

let vicAgent = "";

test("a viewer who is a person may still make an agent token (a viewer's agent can only read)", async () => {
  const r = await call("POST", "/api/agent/token", { cookie: vic });
  assert.equal(r.status, 200, r.text);
  vicAgent = r.json.token;
  assert.ok(vicAgent);
  // it reads
  assert.equal((await call("POST", "/api/boards/company/tools/read_board", { bearer: vicAgent, body: {} })).status, 200);
});

test("a viewer's agent token is refused every write tool, with the view-only answer", async () => {
  process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-viewer-reach-tools-"));
  const { TOOLS } = await import("../src/tools.ts");
  const { READ_TOOLS } = await import("../src/roles.ts");
  const { zodToJsonSchema } = await import("zod-to-json-schema");
  const writes = TOOLS.filter((t) => !READ_TOOLS.has(t.name));
  assert.ok(writes.length > 30, `the board's write tools (${writes.length})`);
  const wrong: string[] = [];
  for (const t of writes) {
    const input = sample(zodToJsonSchema(t.schema, { $refStrategy: "none" }) as Record<string, any>);
    if (!t.schema.safeParse(input).success) {
      wrong.push(`${t.name}: the sample input doesn't pass its schema`);
      continue;
    }
    const r = await call("POST", `/api/boards/company/tools/${t.name}`, { bearer: vicAgent, body: input });
    if (r.status !== 403 || !/View only/.test(r.json.error ?? "")) wrong.push(`${t.name}: ${r.status} ${r.text.slice(0, 160)}`);
  }
  assert.deepEqual(wrong, [], "every write tool refused");
});

/** every route whose handler asks for a person (requirePerson, or isPerson for approving folders), read from index.ts */
function personRoutes(): Array<{ method: string; path: string }> {
  const src = readFileSync(join(serverDir, "src", "index.ts"), "utf8");
  const starts = [...src.matchAll(/\br\.(get|post|delete)\("([^"]+)"/g)];
  const out: Array<{ method: string; path: string }> = [];
  starts.forEach((m, i) => {
    // the handler alone: up to its closing line (comments after it belong to the next route)
    const rest = src.slice(m.index!, starts[i + 1]?.index ?? src.length);
    const firstLine = rest.slice(0, rest.indexOf("\n"));
    const body = /\);\s*$/.test(firstLine) ? firstLine : rest.slice(0, rest.indexOf("\n});") + 4);
    if (/requirePerson\(|isPerson\(req\)\s*,/.test(body)) out.push({ method: m[1].toUpperCase(), path: m[2] });
  });
  return out;
}

test("a viewer's agent token is refused every route that needs a person", async () => {
  const routes = personRoutes();
  assert.ok(routes.length >= 40, `routes that need a person (${routes.length})`);
  const wrong: string[] = [];
  for (const { method, path } of routes) {
    const concrete = path
      .replace(/:verdict/, path.includes("/machines/") ? "run" : "allow")
      .replace(/\/api\/boards\/:id/, "/api/boards/company")
      .replace(/:[a-z]+/gi, "none");
    const q = concrete.startsWith("/api/slack/board/") ? "?board=company" : "";
    const r = await call(method, concrete + q, { bearer: vicAgent, body: method === "GET" ? undefined : { board: "company", confirm: true } });
    if (r.status !== 403) wrong.push(`${method} ${path}: ${r.status} ${r.text.slice(0, 160)}`);
  }
  assert.deepEqual(wrong, [], "every person-only route refused");
});

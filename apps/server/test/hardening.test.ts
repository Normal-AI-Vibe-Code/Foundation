/**
 * The hardening slice (2026-11-18), over HTTP against the real server, started as `npm run dev:server`
 * starts it, in a folder of its own (no .env, fresh data):
 *
 * - Uploaded files can't run as the app: a file is shown in place only if it is a passive type (a picture,
 *   a video, a PDF, plain text, a 3D model); anything else (a page, an SVG, a script) comes back as a
 *   download of opaque bytes, and every file answer carries nosniff and a CSP sandbox.
 * - Only our own pages use the session cookie: a change or a socket signed in by the cookie must come from
 *   the client's page (or the desktop app's window, or FOUNDATION_CORS_ORIGINS); a bearer needs no Origin;
 *   CORS names exactly those pages; and every request must name this server (DNS rebinding).
 * - Agents' leave to use a machine's desktop is set only by a person's press (the socket side, and the leave's
 *   server-only map, are in tickets.test.ts and machines-desktop.test.ts).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

const serverDir = resolve(import.meta.dirname, "..");
const SERVICE = "h".repeat(40);
/** the client's page: what a person's browser sends as Origin (the server's default FOUNDATION_CLIENT_URL) */
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
let port = 0;
let home = "";
let said = "";

before(async () => {
  home = mkdtempSync(join(tmpdir(), "foundation-hardening-"));
  port = await freePort();
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

interface CallOpts {
  cookie?: string;
  bearer?: string;
  body?: unknown;
  raw?: Buffer | string;
  headers?: Record<string, string>;
  /** the page the request comes from; a cookie call comes from the client's page unless this says otherwise (null: no Origin) */
  origin?: string | null;
}
async function call(method: string, path: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const origin = opts.origin === undefined ? (opts.cookie ? CLIENT : null) : opts.origin;
  if (origin) headers.origin = origin;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, opts.headers ?? {});
  const body = opts.raw !== undefined ? opts.raw : opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, headers: res.headers, buf };
}

const signIn = async (email: string) => {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name: email.split("@")[0] }) });
  assert.equal(res.status, 200, await res.text());
  return res.headers.get("set-cookie")!.split(";")[0];
};

let ada = ""; // a person's cookie
let agent = ""; // Ada's agent's bearer

test("setup: a person and her agent's token", async () => {
  ada = await signIn("ada@example.test");
  const t = await call("POST", "/api/agent/token", { cookie: ada });
  assert.equal(t.status, 200, t.text);
  agent = t.json.token;
  assert.ok(agent);
});

// ---------- 3. only our own pages use the session cookie; the server answers only to its own names ----------

/** a raw request, for headers fetch won't let a test set (Host) */
function rawRequest(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; text: string }>((done, fail) => {
    const q = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => done({ status: res.statusCode ?? 0, text }));
    });
    q.on("error", fail);
    q.end(body);
  });
}

/** open a socket; its status if refused, 101 if it opened */
function openSocket(path: string, headers: Record<string, string>, extra: { host?: string } = {}) {
  return new Promise<number>((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { ...headers, ...(extra.host ? { host: extra.host } : {}) } });
    ws.once("open", () => (ws.close(), done(101)));
    ws.once("unexpected-response", (_q, res) => done(res.statusCode ?? 0));
    ws.once("error", () => done(-1));
  });
}

test("a cookie POST from another page on this computer is refused; the same from the client's page works", async () => {
  const foreign = await call("POST", "/api/agent/token", { cookie: ada, origin: "http://localhost:9999" });
  assert.equal(foreign.status, 403, foreign.text);
  assert.match(foreign.json.error, /A page at http:\/\/localhost:9999 can't use your Foundation sign-in/);
  for (const o of ["http://127.0.0.1:5173", "http://localhost:31441", "null", "https://evil.example"]) {
    assert.equal((await call("POST", "/api/agent/token", { cookie: ada, origin: o })).status, 403, o);
  }
  assert.equal((await call("POST", "/api/agent/token", { cookie: ada, origin: CLIENT })).status, 200);
  // the desktop app's own window, by its fixed origin
  assert.equal((await call("POST", "/api/agent/token", { cookie: ada, origin: "http://localhost:31440" })).status, 200);
  // no Origin: only if the browser says the request is its own page's (or typed in)
  const silent = await call("POST", "/api/agent/token", { cookie: ada, origin: null });
  assert.equal(silent.status, 403);
  assert.match(silent.json.error, /didn't say which page it came from/);
  assert.equal((await call("POST", "/api/agent/token", { cookie: ada, origin: null, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await call("POST", "/api/agent/token", { cookie: ada, origin: null, headers: { "sec-fetch-site": "same-site" } })).status, 403);
  assert.equal((await call("POST", "/api/agent/token", { cookie: ada, origin: null, headers: { "sec-fetch-site": "same-origin" } })).status, 200);
  // a read with the cookie is not a change: no Origin needed
  assert.equal((await call("GET", "/api/me", { cookie: ada, origin: null })).json.user?.email, "ada@example.test");
});

test("CORS answers exactly our own pages, not any localhost port", async () => {
  const pre = (origin: string) => fetch(`${base}/api/me`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
  assert.equal((await pre(CLIENT)).headers.get("access-control-allow-origin"), CLIENT);
  assert.equal((await pre("tauri://localhost")).headers.get("access-control-allow-origin"), "tauri://localhost");
  for (const o of ["http://localhost:9999", "http://127.0.0.1:1430", "http://localhost:4410", "https://evil.example"]) {
    assert.equal((await pre(o)).headers.get("access-control-allow-origin"), null, o);
  }
});

test("a bearer needs no Origin (agents, MCP, the service token)", async () => {
  const r = await call("POST", "/api/boards/company/tools/read_board", { bearer: agent, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call("POST", "/api/boards/company/tools/read_board", { bearer: SERVICE, body: {} })).status, 200);
  // a bearer beside a cookie is the bearer's request, from wherever
  assert.equal((await call("POST", "/api/boards/company/tools/read_board", { bearer: agent, cookie: ada, origin: "http://localhost:9999", body: {} })).status, 200);
});

test("a request that doesn't name this server (DNS rebinding) is refused, dev sign-in included", async () => {
  for (const host of ["evil.example", `evil.example:${port}`, "localhost:9999", `127.0.0.2:${port}`, `localhost.evil.example:${port}`]) {
    const r = await rawRequest("GET", "/api/health", { host });
    assert.equal(r.status, 421, host);
    assert.match(r.text, /doesn't answer to/);
  }
  const dev = await rawRequest("POST", "/auth/dev", { host: `evil.example:${port}`, "content-type": "application/json" }, JSON.stringify({ email: "boss@example.test", name: "x", bearer: true }));
  assert.equal(dev.status, 421, dev.text);
  assert.doesNotMatch(dev.text, /session/);
  // its own names: loopback on its port (or the client's), and the hosts of its public and client addresses
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost:1430"]) assert.equal((await rawRequest("GET", "/api/health", { host })).status, 200, host);
  assert.equal(await openSocket("/sync/company", { authorization: `Bearer ${agent}` }, { host: `evil.example:${port}` }), 421);
});

test("a socket opened with the cookie from another page is refused; from the client's page it opens", async () => {
  assert.equal(await openSocket("/sync/company", { cookie: ada, origin: "http://localhost:9999" }), 403);
  assert.equal(await openSocket("/machines/company/pnl_x/tty", { cookie: ada, origin: "http://localhost:9999" }), 403);
  assert.equal(await openSocket("/sync/company", { cookie: ada }), 403, "no Origin, no Sec-Fetch-Site");
  assert.equal(await openSocket("/sync/company", { cookie: ada, origin: CLIENT }), 101);
  // a bearer on the socket needs no Origin
  assert.equal(await openSocket("/sync/company", { authorization: `Bearer ${agent}` }), 101);
});

// ---------- 6. a members-only board's things stay its members' ----------

let boss = ""; // an admin's cookie
let bossAgent = ""; // the admin's agent's bearer
let mia = ""; // a member of the secret board
let secret = ""; // a members-only board Ada isn't on
let secretFile = ""; // a picture on it
let secretDoc = ""; // a text file on it

test("setup: a members-only board with a picture and a note file on it, that Ada isn't on", async () => {
  boss = await signIn("boss@example.test");
  mia = await signIn("mia@example.test");
  bossAgent = (await call("POST", "/api/agent/token", { cookie: boss })).json.token;
  assert.ok(bossAgent);
  const made = await call("POST", "/api/boards", { cookie: boss, body: { name: "Secret plans" } });
  assert.equal(made.status, 200, made.text);
  secret = made.json.id;
  const miaId = (await call("GET", "/api/me", { cookie: mia })).json.user.id;
  const db = new DatabaseSync(join(home, "data", "foundation.db"));
  db.prepare("insert into board_members (board_id, user_id, role, source, added_at) values (?, ?, 'editor', 'test', ?)").run(secret, miaId, Date.now());
  db.close();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const pic = await call("POST", `/api/files?board=${secret}&name=${encodeURIComponent("rotor secret.png")}`, { cookie: mia, raw: png, headers: { "content-type": "image/png" } });
  assert.equal(pic.status, 200, pic.text);
  secretFile = pic.json.file.id;
  const doc = await call("POST", `/api/files?board=${secret}&name=plan.txt`, { cookie: mia, raw: "the secret plan", headers: { "content-type": "text/plain" } });
  secretDoc = doc.json.file.id;
  // Ada can't see it at all
  assert.equal((await call("GET", `/files/${secretDoc}`, { cookie: ada })).status, 404);
});

test("a non-member's list, epoch, people, rename, agents and Slack shares don't reach a members-only board", async () => {
  for (const who of [{ cookie: ada }, { bearer: agent }]) {
    const list = await call("GET", "/api/boards", who);
    assert.equal(list.status, 200);
    assert.ok(!list.json.boards.some((b: { id: string }) => b.id === secret), "not listed");
    assert.equal((await call("GET", `/api/boards/${secret}/epoch`, who)).status, 404);
    assert.equal((await call("GET", `/api/boards/${secret}/people`, who)).status, 404);
    assert.equal((await call("POST", `/api/boards/${secret}`, { ...who, body: { name: "Mine now", url: "https://evil.example" } })).status, 404);
    assert.equal((await call("POST", `/api/boards/${secret}/agents`, { ...who, body: { place: "*", agent: "claude" } })).status, 404);
    assert.equal((await call("POST", `/api/boards/${secret}/agents/remove`, { ...who, body: { place: "*", agent: "claude" } })).status, 404);
    assert.equal((await call("POST", "/api/boards", { ...who, body: { name: "Inside", parent: secret } })).status, 404);
  }
  // a member still sees it
  assert.ok((await call("GET", "/api/boards", { cookie: mia })).json.boards.some((b: { id: string }) => b.id === secret));
  assert.equal((await call("GET", `/api/boards/${secret}/epoch`, { cookie: mia })).status, 200);
  // its huddle notes and links aren't Ada's to send anywhere (refused before Slack, which isn't connected here)
  assert.equal((await call("POST", "/api/slack/channels/C1/huddle-notes", { cookie: ada, body: { board: secret, huddleId: "h1" } })).status, 404);
  assert.equal((await call("POST", "/api/slack/channels/C1/share", { cookie: ada, body: { board: secret, title: "x" } })).status, 404);
});

test("a member of one board can't read another's files or pictures through the board tools", async () => {
  const tool = (name: string, input: unknown, who: CallOpts = { bearer: agent }) => call("POST", `/api/boards/company/tools/${name}`, { ...who, body: input });
  for (const who of [{ bearer: agent }, { cookie: ada }]) {
    const read = await tool("read_file", { file_id: secretDoc }, who);
    assert.notEqual(read.status, 200, read.text);
    assert.doesNotMatch(read.text, /secret plan/);
    const found = await tool("find_images", { query: "rotor secret", sources: ["files"] }, who);
    assert.equal(found.status, 200, found.text);
    assert.ok(!found.text.includes(secretFile), "the picture isn't found");
    const laid = await tool("lay_out", { title: "Borrowed", items: [{ ref: `file:${secretFile}` }] }, who);
    assert.ok(!laid.text.includes(`/files/${secretFile}`), laid.text);
    const put = await tool("collection_put", { collection: "nope", file_id: secretFile }, who);
    assert.notEqual(put.status, 200);
    assert.match(put.text, /no such file/);
  }
  // the board's member reads it (through a tool on that board)
  const own = await call("POST", `/api/boards/${secret}/tools/read_file`, { cookie: mia, body: { file_id: secretDoc } });
  assert.equal(own.status, 200, own.text);
  assert.match(own.text, /the secret plan/);
  // and other doors that take a file id
  assert.equal((await call("POST", "/api/huddles/h1/recordings", { cookie: ada, body: { board: "company", fileId: secretFile } })).status, 404);
});

test("roles: an admin's agent token can't change who may edit a board; the admin in person can", async () => {
  const vicId = (await call("GET", "/api/me", { cookie: await signIn("vic@example.test") })).json.user.id;
  for (const bearer of [bossAgent, SERVICE]) {
    const r = await call("POST", "/api/boards/company/people", { bearer, body: { userId: vicId, role: "viewer" } });
    assert.equal(r.status, 403, r.text);
    assert.match(r.json.error, /needs a person/);
  }
  assert.equal((await call("POST", "/api/boards/company/people", { cookie: ada, body: { userId: vicId, role: "viewer" } })).status, 403, "a member isn't an admin");
  assert.equal((await call("POST", "/api/boards/company/people", { cookie: boss, body: { userId: vicId, role: null } })).status, 200);
});

test("Vision Code's transcripts: an admin in person, not an agent's bearer, the service token or a member", async () => {
  for (const who of [{ bearer: agent }, { bearer: bossAgent }, { bearer: SERVICE }, { cookie: ada }]) {
    assert.equal((await call("GET", "/api/t3/threads", who)).status, 403, JSON.stringify(Object.keys(who)));
    assert.equal((await call("GET", "/api/t3/threads/t1", who)).status, 403);
  }
  assert.equal((await call("GET", "/api/t3/threads", { cookie: boss })).status, 200);
});

// ---------- 7. sending to Slack as a person needs the person ----------

test("posting, sharing, inviting, huddle notes, asks, a channel read that can start an agent and building the Slack board: refused to an agent's bearer and the service token", async () => {
  const doors: Array<[string, unknown]> = [
    ["/api/slack/channels/C1/messages", { text: "hello from an agent" }],
    ["/api/slack/channels/C1/share", { board: "company", title: "x" }],
    ["/api/slack/channels/C1/invite", { board: "company", huddleId: "h1" }],
    ["/api/slack/channels/C1/huddle-notes", { board: "company", huddleId: "h1" }],
    ["/api/asks", { board: "company", assignee: "someone@example.test", prompt: "click this link" }],
    ["/api/slack/board/sync?board=company", { channel: "C1" }],
    // building or re-reading the whole Slack board reads every channel, and a read can start an agent turn
    ["/api/slack/board", {}],
  ];
  for (const [path, body] of doors) {
    for (const bearer of [agent, SERVICE]) {
      const r = await call("POST", path, { bearer, body });
      assert.equal(r.status, 403, `${path}: ${r.text}`);
      assert.match(r.json.error, /needs a person/, path);
    }
    // a person gets past the gate (to Slack not being connected here, or the route's own answer)
    const p = await call("POST", path, { cookie: ada, body });
    assert.doesNotMatch(p.text, /needs a person/, path);
    assert.notEqual(p.status, 403, `${path}: ${p.text}`);
  }
});

// ---------- 5. asking this computer's model server: a person, an exact loopback origin ----------

test("the local model lookup: refused to an agent's bearer and the service token; a person may ask only a loopback origin", async () => {
  const q = (base: string) => `/api/t3host/local?base=${encodeURIComponent(base)}`;
  for (const bearer of [agent, SERVICE]) {
    const r = await call("GET", q("http://127.0.0.1:9"), { bearer });
    assert.equal(r.status, 403, r.text);
    assert.match(r.json.error, /needs a person/);
  }
  const ok = await call("GET", q("http://127.0.0.1:9"), { cookie: ada });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.up, false);
  for (const base of [`http://127.0.0.1:${port}/api/agent/token?`, `http://127.0.0.1:${port}/x`, "http://127.0.0.1:9?x", "http://u:p@127.0.0.1:9", "https://example.com"]) {
    const r = await call("GET", q(base), { cookie: ada });
    assert.equal(r.status, 400, base);
    assert.match(r.json.error, /Only a model server on this computer/);
  }
});

// ---------- 2. agents' leave to use a desktop: only a person's press ----------

test("letting agents use a desktop: refused to an agent's bearer and the service token, a person gets past the gate", async () => {
  for (const bearer of [agent, SERVICE]) {
    const r = await call("POST", "/api/boards/company/machines/pnl_none/agents", { bearer, body: { allow: true } });
    assert.equal(r.status, 403, r.text);
    assert.match(r.json.error, /needs a person/);
  }
  // past the person gate, the route's own answer: there's no such card here
  const p = await call("POST", "/api/boards/company/machines/pnl_none/agents", { cookie: ada, body: { allow: true } });
  assert.equal(p.status, 404, p.text);
  assert.match(p.json.error, /no such machine card/);
});

// ---------- 1. uploaded files can't run as the app ----------

const SANDBOX = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'";
const upload = (name: string, type: string, raw: Buffer | string, who: CallOpts = { bearer: agent }) =>
  call("POST", `/api/files?board=company&name=${encodeURIComponent(name)}`, { ...who, raw, headers: { "content-type": type } });

test("an HTML page an agent uploads is stored and served as opaque bytes to download, with nosniff and the sandbox", async () => {
  const page = "<!doctype html><script>fetch('/api/agent/token',{method:'POST'})</script>";
  const up = await upload("x.html", "text/html", page);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.file.mime, "application/octet-stream", "stored as opaque bytes, whatever the uploader said");
  assert.equal(up.json.file.name, "x.html", "the name is kept");
  const got = await call("GET", `/files/${up.json.file.id}`, { cookie: ada });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "application/octet-stream");
  assert.match(got.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''x\.html$/);
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(got.headers.get("content-security-policy"), SANDBOX);
  assert.equal(got.text, page, "the bytes are the same");
});

test("SVG, XHTML, XML, JavaScript, CSS and unknown types are downloads too", async () => {
  for (const [name, type] of [
    ["logo.svg", "image/svg+xml"],
    ["p.xhtml", "application/xhtml+xml"],
    ["d.xml", "text/xml"],
    ["a.js", "text/javascript"],
    ["m.mjs", "application/javascript"],
    ["s.css", "text/css"],
    ["w.bin", "application/x-whatever"],
    ["bad", "text/html; charset=utf-8"],
    ["mht.mht", "multipart/related"],
  ] as const) {
    const up = await upload(name, type, `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/> ${name}`);
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.file.mime, "application/octet-stream", name);
    const got = await call("GET", `/files/${up.json.file.id}`, { bearer: agent });
    assert.equal(got.headers.get("content-type"), "application/octet-stream", name);
    assert.match(got.headers.get("content-disposition") ?? "", /^attachment;/, name);
    assert.equal(got.headers.get("x-content-type-options"), "nosniff", name);
    assert.equal(got.headers.get("content-security-policy"), SANDBOX, name);
  }
});

test("a PNG stays a picture shown in place (with nosniff and the sandbox), and ranges still work", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
  const up = await upload("pic.png", "image/png", png);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.file.mime, "image/png");
  const got = await call("GET", `/files/${up.json.file.id}`, { cookie: ada });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.match(got.headers.get("content-disposition") ?? "", /^inline; filename\*=UTF-8''pic\.png$/);
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(got.headers.get("content-security-policy"), SANDBOX);
  assert.ok(got.buf.equals(png));

  const part = await call("GET", `/files/${up.json.file.id}`, { cookie: ada, headers: { range: "bytes=2-9" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 2-9/${png.length}`);
  assert.equal(part.headers.get("content-type"), "image/png");
  assert.equal(part.headers.get("content-security-policy"), SANDBOX);
  assert.ok(part.buf.equals(png.subarray(2, 10)));
  // a range on a download is still a range
  const html = await upload("r.html", "text/html", "0123456789abcdef");
  const r = await call("GET", `/files/${html.json.file.id}`, { cookie: ada, headers: { range: "bytes=-4" } });
  assert.equal(r.status, 206);
  assert.equal(r.text, "cdef");
  assert.match(r.headers.get("content-disposition") ?? "", /^attachment;/);
});

test("plain text, PDF, video and 3D models are shown in place; Markdown and Office documents keep their type but download", async () => {
  for (const [name, type, inline] of [
    ["n.txt", "text/plain", true],
    ["s.pdf", "application/pdf", true],
    ["v.mp4", "video/mp4", true],
    ["a.mp3", "audio/mpeg", true],
    ["m.glb", "model/gltf-binary", true],
    ["r.md", "text/markdown", false],
    ["d.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
  ] as const) {
    const up = await upload(name, type, `bytes of ${name}`);
    assert.equal(up.json.file.mime, type, `${name} keeps its type`);
    const got = await call("GET", `/files/${up.json.file.id}`, { cookie: ada });
    assert.equal(got.headers.get("content-type"), inline ? type : "application/octet-stream", name);
    assert.match(got.headers.get("content-disposition") ?? "", inline ? /^inline;/ : /^attachment;/, name);
    assert.equal(got.headers.get("content-security-policy"), SANDBOX, name);
  }
});

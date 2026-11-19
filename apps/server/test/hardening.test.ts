/**
 * The hardening slice (2026-11-18), over HTTP against the real server, started as `npm run dev:server`
 * starts it, in a folder of its own (no .env, fresh data):
 *
 * - Uploaded files can't run as the app: a file is shown in place only if it is a passive type (a picture,
 *   a video, a PDF, plain text, a 3D model); anything else (a page, an SVG, a script) comes back as a
 *   download of opaque bytes, and every file answer carries nosniff and a CSP sandbox.
 * - Agents' leave to use a machine's desktop is set only by a person's press (the socket side, and the leave's
 *   server-only map, are in tickets.test.ts and machines-desktop.test.ts).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

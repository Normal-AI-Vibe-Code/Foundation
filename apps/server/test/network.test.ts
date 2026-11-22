/**
 * On your network (network.ts), over HTTP against the real server in a folder of its own, and over this
 * computer's own LAN address (so the server sees a peer that isn't loopback: "another computer"):
 *
 * - off by default: loopback only, a LAN Host refused; GET /api/server tells a stranger nothing sensitive;
 * - the switch: an admin, in person, at this computer; on, it listens on the LAN address and answers to it
 *   (other names still refused), serves the built page there (types, cache, SPA fallback, nothing outside the
 *   folder, the message when there's no build), and not on loopback; off again, it's gone;
 * - invitations: minted only by an admin in person at this computer, for an allow-listed non-admin; redeemed
 *   once, by POST, from a private-network peer that isn't this computer, before it expires, rate-limited; the
 *   session is that person's, a member; an admin signs it out and its socket drops;
 * - this computer only: every LOCAL_ONLY door refuses a signed-in admin coming over the LAN;
 * - the cookie over plain http on a LAN address: HttpOnly, SameSite=Lax, never Secure; the LAN page's origin may
 *   use it, another page may not; and every step is in the audit log.
 *
 * Skipped (with a note) on a computer with no private LAN address.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

const serverDir = resolve(import.meta.dirname, "..");
const VIRTUAL = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|docker|vboxnet|veth|virbr|^br-|utun|Loopback/i;
const isLan = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const LAN = (() => {
  for (const [iface, list] of Object.entries(networkInterfaces())) for (const n of list ?? []) if (n.family === "IPv4" && !n.internal && isLan(n.address) && !VIRTUAL.test(iface)) return n.address;
  return null;
})();
const skip = LAN ? false : "this computer has no private LAN address to test with";

/** a port free on every address (the LAN listener takes the same port), from a block kept for this test (16761–16799) */
async function freePort(): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<boolean>((ok) => {
      const s = createServer();
      s.once("error", () => ok(false));
      s.listen(p, "0.0.0.0", () => s.close(() => ok(true)));
    });
  for (let p = 16761 + Math.floor(Math.random() * 20); p <= 16799; p++) if (await tryPort(p)) return p;
  for (let p = 16761; p <= 16799; p++) if (await tryPort(p)) return p;
  throw new Error("no free port in 16761–16799");
}

let child: ChildProcess;
let port = 0;
let home = "";
let page = "";
let said = "";
const loop = () => `http://127.0.0.1:${port}`;
const lanBase = () => `http://${LAN}:${port}`;
const lanOrigin = () => `http://${LAN}:${port}`;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "foundation-network-"));
  // the built page: a fixture, and a file beside it that must never be served
  page = join(home, "page");
  mkdirSync(join(page, "assets"), { recursive: true });
  writeFileSync(join(page, "index.html"), "<!doctype html><title>Foundation</title><div id=root></div>");
  writeFileSync(join(page, "assets", "index-AbCd1234.js"), "console.log('foundation')");
  writeFileSync(join(page, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(home, "outside.txt"), "not the page's");
  port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FOUNDATION_|SLACK_|ANTHROPIC_|GOOGLE_|GITHUB_|MESHY_|T3)/.test(k)) env[k] = v;
  Object.assign(env, {
    FOUNDATION_PORT: String(port),
    FOUNDATION_ROOT: home,
    FOUNDATION_PAGE_DIR: page,
    FOUNDATION_STARTER_DIR: "",
    FOUNDATION_CLAUDE_CLI: join(home, "no-claude"),
    ANTHROPIC_API_KEY: "",
    T3_CLI: join(home, "no-t3"),
    T3_URL: "http://127.0.0.1:9",
    FACTORYFORM_URL: "http://127.0.0.1:9",
    FOUNDATION_DEV_LOGIN: "1",
    FOUNDATION_ALLOWLIST: "@example.test",
    FOUNDATION_ADMIN_EMAILS: "boss@example.test",
  });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout!.on("data", (d) => (said += d));
  child.stderr!.on("data", (d) => (said += d));
  for (let i = 0; i < 1200 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${loop()}/api/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server didn't come up:\n${said}`);
});

after(() => {
  child?.stdin?.end();
  child?.kill();
});

interface Opts {
  cookie?: string;
  bearer?: string;
  body?: unknown;
  origin?: string | null;
  headers?: Record<string, string>;
}
async function call(base: string, method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.origin) headers.origin = o.origin;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: "manual" });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}
const local = (method: string, path: string, o: Opts = {}) => call(loop(), method, path, { origin: o.cookie ? "http://localhost:1430" : null, ...o });
const fromLan = (method: string, path: string, o: Opts = {}) => call(lanBase(), method, path, { origin: lanOrigin(), ...o });

/** a raw request, for a Host fetch won't let a test set, or a path it would normalise */
function raw(host: string, method: string, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((done, fail) => {
    const q = httpRequest({ host, port, method, path, headers }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => done({ status: res.statusCode ?? 0, text: t, headers: res.headers }));
    });
    q.on("error", fail);
    q.end();
  });
}

const devIn = async (email: string) => {
  const res = await fetch(`${loop()}/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name: email.split("@")[0] }) });
  assert.equal(res.status, 200, await res.text());
  return res.headers.get("set-cookie")!.split(";")[0];
};

let boss = ""; // an admin's cookie, from this computer
let ada = ""; // a member's cookie, from this computer
let bossAgent = ""; // the admin's agent token

test("setup: an admin, a member, and the admin's agent", { skip }, async () => {
  boss = await devIn("boss@example.test");
  ada = await devIn("ada@example.test");
  const t = await local("POST", "/api/agent/token", { cookie: boss });
  assert.equal(t.status, 200, t.text);
  bossAgent = t.json.token;
});

test("off by default: loopback only, a LAN name is refused, and nothing listens on the LAN address", { skip }, async () => {
  const info = await local("GET", "/api/server", { cookie: boss });
  assert.equal(info.json.kind, "local");
  assert.equal(info.json.network.on, false);
  assert.deepEqual(info.json.network.urls, []);
  const misnamed = await raw("127.0.0.1", "GET", "/api/health", { host: `${LAN}:${port}` });
  assert.equal(misnamed.status, 421);
  await assert.rejects(fetch(`${lanBase()}/api/health`, { signal: AbortSignal.timeout(3000) }));
});

test("GET /api/server tells a stranger what the server is, and nothing sensitive", { skip }, async () => {
  const anon = await local("GET", "/api/server");
  assert.equal(anon.status, 200);
  assert.equal(anon.json.name, "Foundation");
  assert.ok(anon.json.version);
  assert.deepEqual(anon.json.serves, ["grids", "files", "chat"]);
  for (const k of ["data", "address", "network", "people", "startedAt", "canManage", "chat"]) assert.equal(k in anon.json, false, `${k} leaked to an unauthenticated caller`);
  assert.equal(anon.text.includes(home.replace(/\\/g, "\\\\")), false, "the data folder leaked");
  // a member sees the server, not where its data is
  const member = await local("GET", "/api/server", { cookie: ada });
  assert.ok(member.json.startedAt);
  assert.equal(typeof member.json.people, "number");
  assert.equal("data" in member.json, false);
  assert.equal(member.json.canManage, false);
  const admin = await local("GET", "/api/server", { cookie: boss });
  assert.ok(String(admin.json.data).length > 0);
  assert.equal(admin.json.canManage, true);
});

test("the switch: a member, an agent's token and a refusal are refused; an admin at this computer turns it on", { skip }, async () => {
  assert.equal((await local("POST", "/api/server/network", { cookie: ada, body: { on: true } })).status, 403);
  assert.equal((await local("POST", "/api/server/network", { bearer: bossAgent, body: { on: true } })).status, 403);
  const on = await local("POST", "/api/server/network", { cookie: boss, body: { on: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.network.on, true);
  assert.equal(on.json.kind, "network");
  const l = on.json.network.listening.find((x: { address: string }) => x.address === LAN);
  assert.ok(l?.ok, JSON.stringify(on.json.network.listening));
  assert.equal(l.answers, true, "the LAN address answers from this computer");
  assert.ok(on.json.network.urls.some((u: { url: string }) => u.url === lanBase()));
});

test("on: it answers to its LAN name, and still refuses any other (DNS rebinding)", { skip }, async () => {
  const h = await call(lanBase(), "GET", "/api/health");
  assert.equal(h.status, 200);
  const evil = await raw(LAN!, "GET", "/api/health", { host: `evil.example:${port}` });
  assert.equal(evil.status, 421);
  const otherPort = await raw(LAN!, "GET", "/api/health", { host: `${LAN}:1` });
  assert.equal(otherPort.status, 421);
  // from the LAN, the doors are told honestly: Google can't finish here, an invitation can
  const cfg = await fromLan("GET", "/auth/config");
  assert.equal(cfg.json.invite, true);
  assert.equal(cfg.json.flowform, undefined);
  assert.equal(cfg.json.devLogin, false);
  assert.equal((await fromLan("GET", "/auth/flowform/start")).status, 403);
  const here = await local("GET", "/auth/config");
  assert.equal(here.json.invite, false);
  assert.ok(here.json.flowform);
});

test("the page: served at the LAN address with the right types and caching, SPA fallback, nothing outside its folder", { skip }, async () => {
  const index = await fromLan("GET", "/");
  assert.equal(index.status, 200);
  assert.match(String(index.headers.get("content-type")), /^text\/html/);
  assert.equal(index.headers.get("cache-control"), "no-cache");
  assert.match(String(index.headers.get("content-security-policy")), /frame-ancestors 'none'/);
  assert.match(index.text, /<div id=root>/);
  const js = await fromLan("GET", "/assets/index-AbCd1234.js");
  assert.equal(js.status, 200);
  assert.match(String(js.headers.get("content-type")), /^text\/javascript/);
  assert.match(String(js.headers.get("cache-control")), /immutable/);
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  const svg = await fromLan("GET", "/assets/logo.svg");
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal(svg.headers.get("cache-control"), "no-cache");
  // the hash router's paths all land on the page
  assert.match((await fromLan("GET", "/somewhere/deep")).text, /<div id=root>/);
  assert.equal((await fromLan("GET", "/assets/missing.js")).status, 404);
  // nothing outside the folder, however it's spelled
  for (const p of ["/../outside.txt", "/%2e%2e/outside.txt", "/assets/..%2f..%2foutside.txt", "/..%5coutside.txt", "/assets/%2e%2e%5c%2e%2e%5coutside.txt", "/%00index.html", "/assets/../../outside.txt"]) {
    const r = await raw(LAN!, "GET", p, { host: `${LAN}:${port}` });
    assert.equal(r.text.includes("not the page's"), false, `${p} reached a file outside the page folder`);
    assert.notEqual(r.status, 200, `${p}: ${r.status}`);
  }
  // the server's own paths stay the server's
  assert.equal((await fromLan("GET", "/api/me")).json.user, null);
  // not on loopback names: a machine's relayed page shares that origin, which is never trusted with the cookie
  const loopPage = await local("GET", "/");
  assert.equal(loopPage.status, 404);
});

test("the page: with no build, the address says so and names the command", { skip }, async () => {
  renameSync(join(page, "index.html"), join(page, "index.away"));
  try {
    const r = await fromLan("GET", "/");
    assert.equal(r.status, 503);
    assert.match(r.text, /npm run build/);
    assert.equal((await fromLan("GET", "/assets/index-AbCd1234.js")).status, 200, "files still serve");
  } finally {
    renameSync(join(page, "index.away"), join(page, "index.html"));
  }
});

let lanAda = ""; // Ada's cookie, signed in from "another computer" by invitation
let inviteLink = "";

test("an invitation: only an admin, in person, at this computer, for an allow-listed non-admin", { skip }, async () => {
  const body = { email: "ada@example.test", name: "Ada" };
  assert.equal((await local("POST", "/api/server/invites", { cookie: ada, body })).status, 403, "a member");
  assert.equal((await local("POST", "/api/server/invites", { bearer: bossAgent, body })).status, 403, "an agent's token");
  const overLan = await fromLan("POST", "/api/server/invites", { cookie: boss, body });
  assert.equal(overLan.status, 403, "an admin over the LAN");
  assert.match(overLan.json.error, /computer this server runs on/);
  assert.equal((await local("POST", "/api/server/invites", { cookie: boss, body: { email: "eve@elsewhere.test" } })).status, 403, "not on the allowlist");
  assert.equal((await local("POST", "/api/server/invites", { cookie: boss, body: { email: "boss@example.test" } })).status, 403, "an admin's email");
  const ok = await local("POST", "/api/server/invites", { cookie: boss, body });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  const link = ok.json.links.find((l: { url: string }) => l.url.startsWith(lanBase()));
  assert.ok(link, JSON.stringify(ok.json.links));
  const m = /#\/join\/([A-Za-z0-9_-]{43})$/.exec(link.url);
  assert.ok(m, `the code rides in the fragment: ${link.url}`);
  inviteLink = m![1];
  // stored hashed: neither the link's code nor the short code is in the database
  const d = new DatabaseSync(join(home, "data", "foundation.db"));
  const rows = JSON.stringify(d.prepare("select * from network_invites").all());
  d.close();
  assert.equal(rows.includes(inviteLink), false);
  assert.equal(rows.includes(ok.json.code), false);
});

test("redeeming: not from this computer, then once from the LAN, as that person, a member, with a LAN-safe cookie", { skip }, async () => {
  // this computer's loopback isn't "another computer on the network"
  const fromHere = await raw("127.0.0.1", "POST", "/auth/invite", { host: `${LAN}:${port}`, "content-type": "application/json" }).catch(() => null);
  assert.ok(fromHere && fromHere.status === 403, String(fromHere?.status));
  // nor is a request asked by a loopback name
  assert.equal((await local("POST", "/auth/invite", { body: { code: inviteLink } })).status, 403);
  // a page elsewhere can't sign this browser in
  assert.equal((await fromLan("POST", "/auth/invite", { origin: "http://evil.example", body: { code: inviteLink } })).status, 403);
  const r = await fromLan("POST", "/auth/invite", { body: { code: inviteLink } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.email, "ada@example.test");
  assert.equal(r.json.user.role, "member");
  const cookie = String(r.headers.get("set-cookie"));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.equal(cookie.includes(inviteLink), false);
  lanAda = cookie.split(";")[0];
  const me = await fromLan("GET", "/api/me", { cookie: lanAda });
  assert.equal(me.json.user.email, "ada@example.test");
  assert.equal(me.json.user.role, "member");
  // once
  const again = await fromLan("POST", "/auth/invite", { body: { code: inviteLink } });
  assert.equal(again.status, 400);
});

test("the short code works with the email it was made for, and not after it expires", { skip }, async () => {
  const a = await local("POST", "/api/server/invites", { cookie: boss, body: { email: "grace@example.test", name: "Grace" } });
  assert.equal((await fromLan("POST", "/auth/invite", { body: { email: "ada@example.test", short: a.json.code } })).status, 400, "another email");
  const ok = await fromLan("POST", "/auth/invite", { body: { email: "Grace@example.test", short: a.json.code.toLowerCase().replace("-", " ") } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.user.name, "Grace");
  // an expired one
  const b = await local("POST", "/api/server/invites", { cookie: boss, body: { email: "lin@example.test" } });
  const d = new DatabaseSync(join(home, "data", "foundation.db"));
  d.prepare("update network_invites set expires_at = 1 where email = 'lin@example.test'").run();
  d.close();
  const late = await fromLan("POST", "/auth/invite", { body: { email: "lin@example.test", short: b.json.code } });
  assert.equal(late.status, 400);
  assert.match(late.json.error, /expired or was already used/);
});

test("the LAN page's origin may use its cookie; another page may not", { skip }, async () => {
  const mine = await fromLan("POST", "/api/prefs", { cookie: lanAda, body: { key: "nope", value: 1 } });
  assert.notEqual(mine.status, 403, mine.text);
  const forged = await fromLan("POST", "/api/prefs", { cookie: lanAda, origin: "http://evil.example", body: { key: "nope", value: 1 } });
  assert.equal(forged.status, 403);
  // nor is another program's page on the same LAN address (another port: another origin)
  const crossed = await fromLan("POST", "/api/prefs", { cookie: lanAda, origin: `http://${LAN}:1`, body: { key: "nope", value: 1 } });
  assert.equal(crossed.status, 403);
  // CORS: the LAN page's origin and a teammate's desktop app (bearer) on the LAN name; never on loopback
  const pre = await call(lanBase(), "OPTIONS", "/api/me", { origin: "http://localhost:31440" });
  assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:31440");
  const preLoop = await call(loop(), "OPTIONS", "/api/me", { origin: lanOrigin() });
  assert.equal(preLoop.headers.get("access-control-allow-origin"), null);
});

test("this computer only: every LOCAL_ONLY door refuses a signed-in admin over the LAN", { skip }, async () => {
  const doors: Array<[string, string]> = [
    ["POST", "/api/host-terminal"],
    ["POST", "/api/host-browser"],
    ["GET", "/api/places"],
    ["POST", "/api/places"],
    ["GET", "/api/places/p1/list"],
    ["POST", "/api/places/p1/bring?board=company"],
    ["POST", "/api/chat/attach/place"],
    ["POST", "/api/server/network"],
    ["GET", "/api/server/invites"],
    ["POST", "/api/server/invites"],
    ["GET", "/api/server/sessions"],
    ["POST", "/api/server/sessions/ns_x/sign-out"],
    ["POST", "/api/server/page/build"],
    ["POST", "/api/chat/bridges/whatsapp"],
    ["POST", "/api/t3host/start"],
    ["POST", "/api/t3host/agents"],
    ["GET", "/api/t3host/local"],
    ["POST", "/api/t3host/open"],
    ["POST", "/api/boards/company/machines/m1/start"],
    ["POST", "/api/boards/company/machines/load"],
    ["POST", "/api/boards/company/clusters"],
    ["GET", "/api/boards/company/clusters/c1/kubeconfig"],
    ["POST", "/api/boards/company/collections/c1/machine"],
    ["POST", "/api/jobs/j1/run"],
    ["POST", "/api/apps"],
    ["POST", "/api/apps/probe"],
    ["POST", "/api/boards/company/apps/a1/asks/k1/allow"],
    ["POST", "/api/agent/token"],
    ["POST", "/api/plan/sync"],
    ["POST", "/api/boards/company/characters/c1/stages/model"],
  ];
  for (const [method, path] of doors) {
    const r = await fromLan(method, path, { cookie: boss, body: method === "POST" ? {} : undefined });
    assert.equal(r.status, 403, `${method} ${path}: ${r.status} ${r.text.slice(0, 120)}`);
    assert.match(r.json.error, /works only at the computer this server runs on/, `${method} ${path}`);
  }
  // the same admin at this computer isn't refused for where they are (the route answers for itself)
  const here = await local("GET", "/api/server/sessions", { cookie: boss });
  assert.equal(here.status, 200);
  // a machine's relayed port isn't on the LAN name; the built-in terminal's socket isn't from the LAN
  assert.equal((await fromLan("GET", "/m/company/m1/8080/", { cookie: boss })).status, 403);
  const sock = await new Promise<number>((done) => {
    const ws = new WebSocket(`ws://${LAN}:${port}/host/terminal/abcdefgh12345678?key=x`, { headers: { origin: lanOrigin(), cookie: boss } });
    ws.on("unexpected-response", (_q, res) => done(res.statusCode ?? 0));
    ws.on("open", () => done(101));
    ws.on("error", () => done(-1));
  });
  assert.equal(sock, 403);
});

test("an admin sees who is signed in from where, and Sign out ends it, socket and all", { skip }, async () => {
  const ws = new WebSocket(`ws://${LAN}:${port}/chat`, { headers: { origin: lanOrigin(), cookie: lanAda } });
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", fail);
  });
  const closed = new Promise<void>((ok) => ws.once("close", () => ok()));
  const list = await local("GET", "/api/server/sessions", { cookie: boss });
  const row = list.json.sessions.find((s: { email: string }) => s.email === "ada@example.test");
  assert.ok(row, JSON.stringify(list.json));
  assert.equal(row.addr, LAN);
  assert.equal(row.via, "invite");
  assert.ok(row.live >= 1, "her socket is counted");
  const people = await local("GET", "/api/server", { cookie: boss });
  assert.ok(people.json.people >= 1);
  const out = await local("POST", `/api/server/sessions/${row.id}/sign-out`, { cookie: boss, body: {} });
  assert.equal(out.status, 200, out.text);
  await Promise.race([closed, new Promise((_, no) => setTimeout(() => no(new Error("the socket stayed open")), 5000))]);
  assert.equal((await fromLan("GET", "/api/me", { cookie: lanAda })).json.user, null);
});

test("too many wrong codes from one address: refused for a while", { skip }, async () => {
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await fromLan("POST", "/auth/invite", { body: { email: "ada@example.test", short: "AAAAA-AAAAA" } })).status;
  assert.equal(last, 429);
  // even a good one, until it cools down
  const c = await local("POST", "/api/server/invites", { cookie: boss, body: { email: "max@example.test" } });
  assert.equal((await fromLan("POST", "/auth/invite", { body: { email: "max@example.test", short: c.json.code } })).status, 429);
});

test("every step is in the audit log", { skip }, async () => {
  const a = await local("GET", "/api/audit?limit=500", { cookie: boss });
  assert.equal(a.status, 200, a.text);
  const actions = a.json.rows.map((r: { action: string; decision: string; reason: string | null }) => `${r.action}|${r.decision}|${r.reason ?? ""}`);
  for (const want of ["server.network.on|allowed", "invite.mint|allowed", "invite.redeem|allowed", "invite.redeem|refused", "network.sign_out|allowed"]) assert.ok(actions.some((x: string) => x.startsWith(want)), `${want} in ${actions.join("\n")}`);
  assert.ok(actions.some((x: string) => x.endsWith("|refused|this computer only")), "a refused LAN door");
  assert.equal(a.json.chain.ok, true);
});

test("off again: the LAN address stops answering and its name is refused", { skip }, async () => {
  const off = await local("POST", "/api/server/network", { cookie: boss, body: { on: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.network.on, false);
  assert.equal(off.json.kind, "local");
  await assert.rejects(fetch(`${lanBase()}/api/health`, { signal: AbortSignal.timeout(3000) }));
  assert.equal((await raw("127.0.0.1", "GET", "/api/health", { host: `${LAN}:${port}` })).status, 421);
});

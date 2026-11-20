/**
 * The built-in terminal (hostterm.ts) runs whatever is typed on the server's computer, so: only a person opens
 * one (an agent's bearer, the service token and an agent session are refused), only an admin, and its socket
 * opens with nothing but the one-time key minted for that person: once, on its own path, before it expires; no
 * cookie, bearer or ticket opens it. Nothing runs until that socket opens. Run against the server's own upgrade
 * handler on a real port, with a real shell.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);

const auth = await import("../src/auth.ts");
const { handleUpgrade } = await import("../src/sockets.ts");
const { requestHostTerminal, hostTerminals, stopHostTerminals } = await import("../src/hostterm.ts");

const boss = auth.upsertUser("boss@formindustries.com", "Boss");
const ada = auth.upsertUser("ada@formindustries.com", "Ada");
assert.equal(boss.role, "admin");

let server: Server;
let base = "";
before(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => handleUpgrade(wss, req, socket, head));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  stopHostTerminals();
  server?.close();
  server?.closeAllConnections(); // a socket a failed test left open must not keep the run alive
});

type FakeReq = Parameters<typeof requestHostTerminal>[0];
const reqWith = (headers: Record<string, string>) => ({ headers, url: "/api/host-terminal", query: new URLSearchParams(), params: {} }) as unknown as FakeReq;
const cookieOf = (userId: string) => reqWith({ cookie: `foundation_session=${auth.createSession(userId)}` });
const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

function open(path: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((done) => {
    const ws = new WebSocket(base + path, { headers });
    ws.once("open", () => done({ ws }));
    ws.once("unexpected-response", (_req, res) => done({ status: res.statusCode }));
    ws.once("error", () => done({ status: -1 }));
  });
}

test("only a person who is an admin gets a terminal", () => {
  // the admin, in their browser
  assert.equal(statusOf(() => requestHostTerminal(cookieOf(boss.id))), 200);
  // a member, in their browser
  assert.equal(statusOf(() => requestHostTerminal(cookieOf(ada.id))), 403);
  // the service token (agents, MCP) is never a person
  assert.equal(statusOf(() => requestHostTerminal(reqWith({ authorization: `Bearer ${"s".repeat(40)}` }))), 403);
  // an agent's session, even the admin's own
  const agentSession = auth.createSession(boss.id, 60_000, "agent");
  assert.equal(statusOf(() => requestHostTerminal(reqWith({ authorization: `Bearer ${agentSession}` }))), 403);
  // nobody signed in
  assert.equal(statusOf(() => requestHostTerminal(reqWith({}))), 401);
  // asking runs nothing: no shell until a socket spends the key
  assert.equal(hostTerminals(), 0);
});

test("the key opens its socket once; nothing else opens it", async () => {
  const { id, key } = requestHostTerminal(cookieOf(boss.id));
  // no key, a wrong key, or the admin's own cookie instead of the key
  assert.equal((await open(`/host/terminal/${id}`)).status, 401);
  const again = requestHostTerminal(cookieOf(boss.id));
  assert.equal((await open(`/host/terminal/${again.id}?key=nope`)).status, 401);
  // a key tried wrongly is spent: the right one no longer works on that id either
  assert.equal((await open(`/host/terminal/${again.id}?key=${again.key}`)).status, 401);
  const third = requestHostTerminal(cookieOf(boss.id));
  assert.equal((await open(`/host/terminal/${third.id}`, { cookie: `foundation_session=${auth.createSession(boss.id)}` })).status, 401);

  // the first id was spent by the keyless try above; a fresh one, with the right key, once
  assert.equal((await open(`/host/terminal/${id}?key=${encodeURIComponent(key)}`)).status, 401);
  const fresh = requestHostTerminal(cookieOf(boss.id));
  const { ws } = await open(`/host/terminal/${fresh.id}?key=${encodeURIComponent(fresh.key)}`);
  assert.ok(ws, "the key opens the socket");
  assert.equal((await open(`/host/terminal/${fresh.id}?key=${encodeURIComponent(fresh.key)}`)).status, 401, "and only once");

  // a real shell: a line goes in, its output and a prompt with the folder come back
  const got: Array<{ t: string; data?: string; cwd?: string }> = [];
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  const until = async (ok: () => boolean, ms = 60_000) => {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out; got ${JSON.stringify(got).slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await until(() => got.some((m) => m.t === "prompt"));
  assert.equal(got.find((m) => m.t === "prompt")?.cwd, process.cwd());
  assert.equal(hostTerminals(), 1);
  const prompts = got.filter((m) => m.t === "prompt").length;
  ws.send(JSON.stringify({ t: "line", text: "echo foundation-term-ok" }));
  await until(() => got.filter((m) => m.t === "prompt").length > prompts);
  assert.match(got.filter((m) => m.t === "out").map((m) => m.data).join(""), /foundation-term-ok/);
  // closing the socket stops the shell
  ws.close();
  await until(() => hostTerminals() === 0);
});

test("the change log reads this checkout's commits, newest first", async () => {
  const { changelog, parseLog } = await import("../src/changelog.ts");
  assert.deepEqual(parseLog("abc1234\x1f2026-11-17T10:00:00Z\x1fAda\x1fA change\x1fwhy\n\x1e\nnot-a-hash\x1fx\x1fy\x1fz\x1e"), [{ hash: "abc1234", at: "2026-11-17T10:00:00Z", author: "Ada", subject: "A change", body: "why" }]);
  const log = await changelog(3);
  assert.equal(log.available, true);
  assert.equal(log.commits.length, 3);
  assert.ok(log.commits[0].at >= log.commits[2].at);
  const none = await changelog(3, tmpdir());
  assert.equal(none.available, false);
});

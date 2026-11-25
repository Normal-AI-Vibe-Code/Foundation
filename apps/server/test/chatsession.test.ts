/**
 * One sign-in (chatsession.ts): a Google sign-in on Foundation also signs the person in to the configured chat
 * server, with Google's own proof. A stand-in Google answers the token call with an ID token; a stand-in chat
 * server answers /auth/config and /auth/exchange. What is held here: the session is collected once, by the
 * Foundation session that earned it and by a person; the ID token goes to the configured origin and nowhere
 * else; a chat server that is slow, down or says no never fails or slows the sign-in; nothing secret is logged
 * or written to the data folder; an address that isn't https (or this computer) is not used.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOSTED = "https://foundation.example.com";
const DATA = mkdtempSync(join(tmpdir(), "foundation-test-"));
const SERVICE = "service-token-for-tests-0123456789abcdef";
process.env.FOUNDATION_DATA_DIR = DATA;
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.co";
process.env.FOUNDATION_ALLOWLIST = "@formindustries.co";
process.env.FOUNDATION_PUBLIC_URL = HOSTED;
process.env.FOUNDATION_SERVICE_TOKEN = SERVICE;
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
delete process.env.FOUNDATION_EXIT_WITH_PARENT;
delete process.env.FOUNDATION_CORS_ORIGINS;
delete process.env.FOUNDATION_CLIENT_URL;
delete process.env.FOUNDATION_CLIENT_DIR;
delete process.env.FOUNDATION_CHAT_SERVER;

// everything the server says while these run, to look through at the end
const said: string[] = [];
for (const k of ["log", "info", "warn", "error", "debug"] as const) {
  const real = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    said.push(a.map(String).join(" "));
    if (process.env.CHATSESSION_TEST_LOUD) real(...a);
  };
}
/** every secret these tests saw: Google's ID tokens and the chat server's bearers */
const secrets = new Set<string>();

const people: Record<string, { email: string; email_verified: boolean; name: string }> = {
  "code-ada": { email: "ada@formindustries.co", email_verified: true, name: "Ada Field" },
  "code-boss": { email: "boss@formindustries.co", email_verified: true, name: "The Boss" },
  "code-outsider": { email: "someone@gmail.com", email_verified: true, name: "Someone Else" },
};
const idTokenFor = (code: string) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ email: people[code].email, aud: "test-client.apps.googleusercontent.com" })).toString("base64url")}.sig-${code}`;

interface Hit {
  method: string;
  url: string;
  body: string;
  authorization?: string;
}
function listen(handler: (hit: Hit, res: ServerResponse, req: IncomingMessage) => void): Promise<{ server: Server; origin: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const hit = { method: req.method ?? "", url: req.url ?? "", body, authorization: req.headers.authorization };
      hits.push(hit);
      handler(hit, res, req);
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits })));
}
const answer = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

let google: Awaited<ReturnType<typeof listen>>;
let chat: Awaited<ReturnType<typeof listen>>;
let elsewhere: Awaited<ReturnType<typeof listen>>;
/** how the stand-in chat server behaves for the test at hand */
let mode: { exchange?: boolean; refuse?: boolean; slowMs?: number; slowConfigMs?: number; redirect?: boolean } = {};
let minted = 0;
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
const later = (ms: number, f: () => void) => {
  const t = setTimeout(() => (pendingTimers.delete(t), f()), ms);
  pendingTimers.add(t);
};

before(async () => {
  google = await listen((hit, res) => {
    if (hit.url === "/token" && hit.method === "POST") {
      const code = new URLSearchParams(hit.body).get("code") ?? "";
      if (!people[code]) return void answer(res, 400, {});
      secrets.add(idTokenFor(code));
      return void answer(res, 200, { access_token: `at-${code}`, id_token: idTokenFor(code) });
    }
    const who = people[(hit.authorization ?? "").replace(/^Bearer at-/, "")];
    if (hit.url === "/userinfo" && who) return void answer(res, 200, who);
    answer(res, 401, {});
  });
  elsewhere = await listen((_hit, res) => void answer(res, 200, { exchange: true, user: { id: "u_x" }, session: "from-elsewhere" }));
  chat = await listen((hit, res) => {
    if (hit.url === "/auth/config") {
      const say = () => answer(res, 200, { google: true, app: true, exchange: mode.exchange !== false });
      return void (mode.slowConfigMs ? later(mode.slowConfigMs, say) : say());
    }
    if (hit.url === "/auth/exchange" && hit.method === "POST") {
      if (mode.redirect) return void res.writeHead(307, { location: `${elsewhere.origin}/auth/exchange` }).end();
      const token = (JSON.parse(hit.body) as { id_token?: string }).id_token ?? "";
      const code = Object.keys(people).find((c) => idTokenFor(c) === token);
      if (mode.refuse || !code) return void answer(res, 401, { error: "That Google sign-in isn't one this server accepts." });
      const session = `chat-bearer-${++minted}-${"s".repeat(24)}`;
      secrets.add(session);
      const say = () => answer(res, 200, { user: { id: `c_${code}`, email: people[code].email, name: people[code].name, color: "#2f6fde", role: "member" }, session });
      return void (mode.slowMs ? later(mode.slowMs, say) : say());
    }
    if (hit.url === "/auth/logout") return void answer(res, 200, { ok: true });
    answer(res, 404, { error: "no such route" });
  });
  process.env.GOOGLE_OAUTH_BASE = google.origin;
  process.env.GOOGLE_USERINFO_URL = `${google.origin}/userinfo`;
  process.env.FOUNDATION_CHAT_SERVER = chat.origin;
});
after(() => {
  for (const t of pendingTimers) clearTimeout(t);
  for (const s of [google, chat, elsewhere]) {
    s.server.closeAllConnections();
    s.server.close();
  }
});

const load = async () => ({
  ff: await import("../src/flowform.ts"),
  auth: await import("../src/auth.ts"),
  cs: await import("../src/chatsession.ts"),
  db: await import("../src/db.ts"),
  config: (await import("../src/config.ts")).config,
});

beforeEach(async () => {
  const { cs, config } = await load();
  cs.resetChatSessions();
  Object.assign(cs.chatSessionLimits, { configMs: 3_000, exchangeMs: 5_000, holdMs: 5 * 60_000 });
  cs.chatSessionClock.now = () => Date.now();
  config.chatServer = chat.origin;
  mode = {};
  chat.hits.length = 0;
  elsewhere.hits.length = 0;
});

function req(path: string, headers: Record<string, string> = {}, method = "POST") {
  const url = new URL(path, HOSTED);
  return { method, url: path, headers: { host: "foundation.example.com", "x-forwarded-for": "203.0.113.7", ...headers }, params: {}, query: url.searchParams, socket: { remoteAddress: "127.0.0.1" } } as never;
}
function res() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const r = {
    headersSent: false,
    setHeader: (k: string, v: unknown) => void (out.headers[k.toLowerCase()] = v),
    getHeader: (k: string) => out.headers[k.toLowerCase()],
    writeHead: (s: number, h: Record<string, unknown> = {}) => {
      out.status = s;
      for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v;
      return r;
    },
    end: (b?: string) => void (out.body = b ?? ""),
  };
  return { r: r as never, out };
}
const cookiesOf = (h: unknown) => ([] as string[]).concat((h as string | string[]) ?? []);
const exchanges = () => chat.hits.filter((h) => h.url === "/auth/exchange");
const logouts = () => chat.hits.filter((h) => h.url === "/auth/logout");
async function until(what: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!what() && Date.now() < end) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(what(), "waited for something that didn't happen");
}

/** a browser's Google sign-in, as index.ts's /auth/google/callback finishes it: the cookie session */
async function webSignIn(code: string) {
  const { auth } = await load();
  const { url } = auth.googleStart();
  const state = new URL(url).searchParams.get("state")!;
  const user = await auth.googleCallback(code, state, state);
  const out = res();
  const began = Date.now();
  auth.signIn(out.r, user.id, false, auth.hashToken(state));
  const took = Date.now() - began;
  const session = /foundation_session=([^;]+)/.exec(String(out.out.headers["set-cookie"]))![1];
  return { user, session, took, cookie: { cookie: `foundation_session=${session}` } };
}

/** the app's Google sign-in: begin, Google in a browser, the press, the poll that hands the app its bearer */
async function appSignIn(code: string, press: "yes" | "no" | "none" = "yes") {
  const { ff } = await load();
  const begun = ff.beginDesktop(req("/auth/flowform/begin"));
  const state = new URL(begun.url).searchParams.get("state")!;
  const page = res();
  await ff.googleDesktopDone(req(`/auth/google/callback?code=${code}&state=${state}`, {}, "GET"), page.r);
  const confirm = cookiesOf(page.out.headers["set-cookie"]).find((c) => c.startsWith("foundation_ff_confirm=")) ?? "";
  const poll = () => ff.poll(req("/auth/flowform/poll?bearer=1", { authorization: `Bearer ${begun.poll}` }), res().r) as { status: string; session?: string };
  const beforePress = exchanges().length;
  if (press !== "none") ff.confirm(req(`/auth/flowform/confirm/${press}`, { cookie: confirm.split(";")[0], origin: "null", "sec-fetch-site": "same-origin" }), res().r, press);
  return { poll, beforePress };
}

const claim = async (headers: Record<string, string>, expect?: string) => (await load()).auth.chatSessionFor(req("/api/chat-session", headers), expect);

test("a browser's Google sign-in earns a ChatForm session, collected once by that session", async () => {
  const s = await webSignIn("code-ada");
  const got = await claim(s.cookie);
  assert.equal(got.server, chat.origin);
  assert.match(String(got.session), /^chat-bearer-/);
  assert.equal((got.user as { email: string }).email, "ada@formindustries.co");
  // Google's ID token, in the body of one POST to the configured chat server
  assert.equal(exchanges().length, 1);
  assert.deepEqual(JSON.parse(exchanges()[0].body), { id_token: idTokenFor("code-ada") });
  assert.ok(chat.hits.every((h) => !h.url.includes("eyJ")), "never in a URL");
  // once
  assert.deepEqual(await claim(s.cookie), { server: chat.origin, session: null });
  assert.equal(exchanges().length, 1);
});

test("the app's Google sign-in: nothing is exchanged before the press, then the app's own bearer collects it once", async () => {
  const s = await appSignIn("code-ada", "none");
  assert.equal(s.poll().status, "pending");
  assert.equal(exchanges().length, 0, "signed in at Google but not pressed: the chat server has heard nothing");

  const t = await appSignIn("code-ada");
  assert.equal(t.beforePress, 0);
  const app = t.poll();
  assert.equal(app.status, "ok");
  const got = await claim({ authorization: `Bearer ${app.session}` });
  assert.match(String(got.session), /^chat-bearer-/);
  assert.equal(exchanges().length, 1);
  assert.equal((await claim({ authorization: `Bearer ${app.session}` })).session, null);
});

test("Not me, someone off the allowlist, and sign-ins without Google's proof exchange nothing", async () => {
  const { auth } = await load();
  const no = await appSignIn("code-ada", "no");
  assert.equal(no.poll().status, "error");
  const outsider = await appSignIn("code-outsider", "none");
  assert.equal(outsider.poll().status, "error");
  await assert.rejects(webSignIn("code-outsider"), /allowlist/);
  // dev sign-in, an invitation, Google through Flowform: signIn with no proof
  const ada = auth.upsertUser("ada@formindustries.co", "Ada Field");
  const out = res();
  const { session } = auth.signIn(out.r, ada.id, true);
  assert.deepEqual(await claim({ authorization: `Bearer ${session}` }), { server: chat.origin, session: null });
  // a proof under one sign-in is not another sign-in's
  auth.signIn(res().r, ada.id, true, auth.hashToken("a state nobody was given"));
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(chat.hits.length, 0, "the chat server was never called");
});

test("another person's session, an agent's bearer, the service token and nobody at all collect nothing", async () => {
  const { auth } = await load();
  const s = await webSignIn("code-ada");
  const boss = auth.upsertUser("boss@formindustries.co", "The Boss");
  // another person, signed in and a person
  assert.deepEqual(await claim({ cookie: `foundation_session=${auth.createSession(boss.id)}` }), { server: chat.origin, session: null });
  // Ada's own other session (signed in before, or elsewhere) is not the one that earned it either
  assert.equal((await claim({ cookie: `foundation_session=${auth.createSession(s.user.id)}` })).session, null);
  // an agent acting for Ada, as a bearer or as a cookie; the service token; no session
  const agent = auth.createSession(s.user.id, 60_000, "agent");
  await assert.rejects(async () => claim({ authorization: `Bearer ${agent}` }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(async () => claim({ cookie: `foundation_session=${agent}` }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(async () => claim({ authorization: `Bearer ${SERVICE}` }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(async () => claim({}), (e: { status?: number }) => e.status === 401);
  // the browser's cookie riding along with an agent's bearer is the agent
  await assert.rejects(async () => claim({ ...s.cookie, authorization: `Bearer ${agent}` }), (e: { status?: number }) => e.status === 403);
  // and after all that it is still there for the session that earned it
  assert.match(String((await claim(s.cookie)).session), /^chat-bearer-/);
});

test("the ID token goes to the configured chat server only: not one the app names, and not where a redirect points", async () => {
  const s = await webSignIn("code-ada");
  // an app whose ChatForm is on some other server: nothing for it, nothing sent there, and nothing spent
  assert.deepEqual(await claim(s.cookie, elsewhere.origin), { server: chat.origin, session: null });
  assert.deepEqual(await claim(s.cookie, "https://evil.example"), { server: chat.origin, session: null });
  assert.equal(elsewhere.hits.length, 0);
  assert.match(String((await claim(s.cookie, chat.origin)).session), /^chat-bearer-/, "the app on the configured server still collects");
  assert.ok(chat.hits.length > 0 && exchanges().length === 1);

  // the chat server answers the exchange with a redirect: not followed, the token goes nowhere else
  mode = { redirect: true };
  const t = await webSignIn("code-boss");
  assert.deepEqual(await claim(t.cookie), { server: chat.origin, session: null });
  assert.equal(elsewhere.hits.length, 0);
});

test("a setting that isn't https (or this computer) is refused, and then nothing is held or sent", async () => {
  const { cs, config } = await load();
  for (const ok of ["https://foundation-chatserver.vercel.app", "https://chat.example.com/", "http://localhost:4420", "http://127.0.0.1:15555", "http://[::1]:15555"]) assert.equal(cs.chatServerOrigin(ok), new URL(ok).origin, ok);
  for (const bad of ["http://chat.example.com", "http://192.168.1.20:4420", "http://localhost.evil.example", "ftp://chat.example.com", "https://user:pass@chat.example.com", "chat.example.com", "javascript:alert(1)", "not a url"]) assert.equal(cs.chatServerOrigin(bad), null, bad);
  assert.equal(cs.chatServerOrigin(""), "");

  config.chatServer = "http://chat.example.com";
  const s = await webSignIn("code-ada");
  assert.deepEqual(await claim(s.cookie), { server: "", session: null });
  config.chatServer = "";
  const t = await webSignIn("code-ada");
  assert.deepEqual(await claim(t.cookie), { server: "", session: null });
  assert.equal(chat.hits.length, 0);
});

test("a chat server that is slow, down, refusing or without the route never fails the sign-in or holds it up", async () => {
  const { cs, config } = await load();
  Object.assign(cs.chatSessionLimits, { configMs: 250, exchangeMs: 250 });
  const within = async (headers: Record<string, string>, ms: number) => {
    const began = Date.now();
    const got = await claim(headers);
    assert.ok(Date.now() - began < ms, `the claim took ${Date.now() - began} ms`);
    return got;
  };

  // slow to exchange: the sign-in itself didn't wait, and the claim gives up at the limit
  mode = { slowMs: 1_500 };
  const slow = await webSignIn("code-ada");
  assert.ok(slow.took < 100, `sign-in took ${slow.took} ms`);
  assert.deepEqual(await within(slow.cookie, 1_000), { server: chat.origin, session: null });

  // slow to say whether it exchanges at all
  cs.resetChatSessions();
  mode = { slowConfigMs: 1_500 };
  const slowConfig = await webSignIn("code-ada");
  assert.ok(slowConfig.took < 100);
  assert.deepEqual(await within(slowConfig.cookie, 1_000), { server: chat.origin, session: null });
  assert.equal(exchanges().length, 1, "only the first, slow one: no token is sent to a server that hasn't said it exchanges");

  // it says no
  cs.resetChatSessions();
  mode = { refuse: true };
  const refused = await webSignIn("code-ada");
  assert.deepEqual(await within(refused.cookie, 1_000), { server: chat.origin, session: null });

  // an older chat server: no `exchange` in its config, so it is never sent a token
  cs.resetChatSessions();
  chat.hits.length = 0;
  mode = { exchange: false };
  const older = await webSignIn("code-ada");
  assert.deepEqual(await within(older.cookie, 1_000), { server: chat.origin, session: null });
  assert.equal(exchanges().length, 0);

  // nothing listening there
  cs.resetChatSessions();
  const gone = await listen(() => undefined);
  await new Promise((ok) => gone.server.close(ok));
  config.chatServer = gone.origin;
  const down = await webSignIn("code-ada");
  assert.ok(down.took < 100);
  assert.deepEqual(await within(down.cookie, 1_000), { server: gone.origin, session: null });

  // and the app's sign-in comes through the same
  const app = await appSignIn("code-ada");
  assert.equal(app.poll().status, "ok");
});

test("a ChatForm session nobody collects is ended at the chat server: on sign-out, and when its five minutes pass", async () => {
  const { auth, cs } = await load();
  const s = await webSignIn("code-ada");
  auth.clearSession(req("/auth/logout", s.cookie), res().r);
  await until(() => logouts().length === 1);
  assert.match(String(logouts()[0].authorization), /^Bearer chat-bearer-/);
  assert.equal((await claim({ cookie: `foundation_session=${auth.createSession(s.user.id)}` })).session, null);

  const t = await webSignIn("code-ada");
  await until(() => exchanges().length === 2);
  const real = Date.now;
  cs.chatSessionClock.now = () => real() + 5 * 60_000 + 1;
  assert.deepEqual(await claim(t.cookie), { server: chat.origin, session: null });
  await until(() => logouts().length === 2);
});

test("nothing secret is logged, and neither Google's ID token nor the chat bearer is written to the data folder", async () => {
  const { db } = await load();
  // a refusal and a failure were logged above, in words
  assert.ok(said.some((l) => /chat sign-in: .* answered 401/.test(l)));
  assert.ok(said.some((l) => /chat sign-in: .* (didn't answer in time|couldn't be reached)/.test(l)));
  assert.ok(secrets.size >= 4);
  const all = said.join("\n");
  for (const s of secrets) assert.ok(!all.includes(s), "a secret was logged");
  assert.ok(!all.includes("eyJhbGciOiJSUzI1NiJ9"), "no ID token in a log line");
  // flush SQLite's log into the file, then read every file the server wrote
  db.db.exec("pragma wal_checkpoint(truncate)");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  for (const f of files(DATA)) {
    const bytes = readFileSync(f).toString("latin1");
    for (const s of secrets) assert.ok(!bytes.includes(s), `a secret is in ${f}`);
  }
});

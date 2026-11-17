/**
 * Sign in with Google through flowform-server: the hand-off, the browser
 * binding, the desktop poll, and that flowform's bearer is kept encrypted (for
 * downloading the person's Flowform files; flowformfiles.ts), never in the clear.
 * A fake flowform answers /auth/me and /auth/logout on a loopback port.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "0123456789abcdef0123456789abcdef"; // flowform's session ids are uuid-simple
const people: Record<string, object> = {
  [TOKEN]: { user_id: "ff-1", display_name: "Noa Field", email: "noa@formindustries.com", email_verified: true, role: "admin" },
  // flowform's sign-up address isn't the Google identity's (josh@normallab.co vs josh@formindustries.co)
  ["f".repeat(32)]: { user_id: "ff-2", display_name: "Moved", email: "moved@normallab.co", email_verified: false, role: "user" },
  ["d".repeat(32)]: { user_id: "ff-2", display_name: "Moved", email: "moved@normallab.co", email_verified: false, role: "user" },
  ["e".repeat(32)]: { user_id: "ff-5", display_name: "Claimer", email: "taken@formindustries.com", email_verified: false, role: "user" },
  // a flowform server from before email_verified existed
  ["b".repeat(32)]: { user_id: "ff-4", display_name: "Older", email: "older@formindustries.com", role: "user" },
};
const revoked: string[] = [];
let fake: Server;

before(async () => {
  fake = createServer((req, res) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (req.url === "/auth/logout" && req.method === "POST") {
      revoked.push(bearer);
      return res.writeHead(204).end();
    }
    if (req.url === "/auth/me" && people[bearer] && !revoked.includes(bearer)) {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(people[bearer]));
    }
    res.writeHead(401).end();
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  process.env.FLOWFORM_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
after(() => fake.close());

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "";

// config reads FLOWFORM_URL at import, so import after the fake is listening
const load = async () => {
  const ff = await import("../src/flowform.ts");
  const { config } = await import("../src/config.ts");
  config.flowformUrl = process.env.FLOWFORM_URL!;
  return ff;
};

/** just enough of IncomingMessage / ServerResponse for the handlers */
function req(path: string, headers: Record<string, string> = {}, params: Record<string, string> = {}) {
  const url = new URL(path, "http://localhost:1430");
  return { headers: { host: "localhost:1430", ...headers }, params, query: url.searchParams } as never;
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
      r.headersSent = true;
      return r;
    },
    end: (b?: string) => void (out.body = b ?? ""),
  };
  return { r: r as never, out };
}
const cookiesOf = (h: unknown) => ([] as string[]).concat((h as string | string[]) ?? []);

test("web: flowform's Google login comes back to the browser that started it", async () => {
  const ff = await load();
  const start = res();
  ff.startWeb(req("/auth/flowform/start"), start.r);
  assert.equal(start.out.status, 302);
  const to = new URL(start.out.headers.location as string);
  assert.equal(to.origin, process.env.FLOWFORM_URL);
  assert.equal(to.pathname, "/auth/google/start");
  const cb = new URL(to.searchParams.get("cb")!);
  assert.equal(cb.origin, "http://localhost:1430"); // flowform's loopback rule
  const nonce = cb.pathname.split("/").pop()!;
  const attemptCookie = cookiesOf(start.out.headers["set-cookie"])[0].split(";")[0];

  // another browser can't finish it (no login fixation)
  const stranger = res();
  await ff.done(req(`/auth/flowform/done/${nonce}?session_token=${TOKEN}`, {}, { nonce }), stranger.r);
  assert.equal(stranger.out.status, 400);

  // …and that spent the attempt, so the real browser starts again
  const again = res();
  ff.startWeb(req("/auth/flowform/start"), again.r);
  const nonce2 = new URL(new URL(again.out.headers.location as string).searchParams.get("cb")!).pathname.split("/").pop()!;
  const cookie2 = cookiesOf(again.out.headers["set-cookie"])[0].split(";")[0];
  assert.notEqual(cookie2, attemptCookie);
  const fin = res();
  await ff.done(req(`/auth/flowform/done/${nonce2}?session_token=${TOKEN}`, { cookie: cookie2 }, { nonce: nonce2 }), fin.r);
  assert.equal(fin.out.status, 302);
  assert.equal(fin.out.headers.location, "/");
  assert.ok(cookiesOf(fin.out.headers["set-cookie"]).some((c) => c.startsWith("foundation_session=")));

  // flowform's bearer is kept for downloads (Josh, 2026-11-11), encrypted: not revoked, not in the clear
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(!revoked.includes(TOKEN));
  const { one } = await import("../src/db.ts");
  const kept = one<{ token: string }>("select s.token from flowform_sessions s join users u on u.id = s.user_id where u.email = ?", "noa@formindustries.com");
  assert.ok(kept && !kept.token.includes(TOKEN), "kept, and not readable in the database");
  assert.equal((await import("../src/flowformlink.ts")).unseal(kept.token), TOKEN);

  const row = one<{ role: string; flowform_user_id: string }>("select role, flowform_user_id from users where email = ?", "noa@formindustries.com");
  assert.equal(row?.flowform_user_id, "ff-1");
  assert.equal(row?.role, "admin"); // flowform admin → Foundation admin
});

test("desktop: the window polls, the system browser finishes", async () => {
  revoked.length = 0;
  people["a".repeat(32)] = { user_id: "ff-3", display_name: "Ari", email: "ari@formindustries.com", email_verified: true, role: "user" };
  const ff = await load();
  const begun = ff.beginDesktop(req("/auth/flowform/begin"));
  const nonce = new URL(new URL(begun.url).searchParams.get("cb")!).pathname.split("/").pop()!;

  const pending = res();
  assert.deepEqual(ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), pending.r), { status: "pending" });

  const page = res();
  const finishing = ff.done(req(`/auth/flowform/done/${nonce}?session_token=${"a".repeat(32)}`, {}, { nonce }), page.r);
  // the window polls while flowform is still answering /auth/me
  assert.deepEqual(ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), { status: "pending" });
  await finishing;
  assert.equal(page.out.status, 200);
  // flowform coming back twice is a replay
  const replay = res();
  await ff.done(req(`/auth/flowform/done/${nonce}?session_token=${"a".repeat(32)}`, {}, { nonce }), replay.r);
  assert.equal(replay.out.status, 400);
  assert.match(page.out.body, /signed in/);
  assert.equal(page.out.headers["set-cookie"], undefined); // the browser gets nothing

  const got = res();
  const out = ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), got.r) as { status: string; user: { email: string; role: string } };
  assert.equal(out.status, "ok");
  assert.equal(out.user.email, "ari@formindustries.com");
  assert.equal(out.user.role, "member");
  assert.ok(cookiesOf(got.out.headers["set-cookie"]).some((c) => c.startsWith("foundation_session=")));
  // collected once
  assert.throws(() => ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), /no such sign-in/);
});

test("an unverified flowform address names a new user but never claims an existing one", async () => {
  const ff = await load();
  const signIn = async (token: string) => {
    const begun = ff.beginDesktop(req("/auth/flowform/begin"));
    const nonce = new URL(new URL(begun.url).searchParams.get("cb")!).pathname.split("/").pop()!;
    await ff.done(req(`/auth/flowform/done/${nonce}?session_token=${token}`, {}, { nonce }), res().r);
    return ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r) as { status: string; user?: { id: string; email: string }; error?: string };
  };

  // nobody in Foundation has the address: the flowform account gets it
  const first = await signIn("f".repeat(32));
  assert.equal(first.status, "ok");
  assert.equal(first.user?.email, "moved@normallab.co");
  // and the same flowform account comes back to the same user
  const again = await signIn("d".repeat(32)); // a later flowform session, same account
  assert.equal(again.user?.id, first.user?.id);

  // someone already holds the address in Foundation: refused
  const { upsertUser } = await import("../src/auth.ts");
  upsertUser("taken@formindustries.com", "Owner");
  const claim = await signIn("e".repeat(32));
  assert.equal(claim.status, "error");
  assert.match(claim.error!, /can't confirm/);
});

test("an older flowform without email_verified still vouches for its Google sign-in", async () => {
  const ff = await load();
  const begun = ff.beginDesktop(req("/auth/flowform/begin"));
  const nonce = new URL(new URL(begun.url).searchParams.get("cb")!).pathname.split("/").pop()!;
  await ff.done(req(`/auth/flowform/done/${nonce}?session_token=${"b".repeat(32)}`, {}, { nonce }), res().r);
  const out = ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r) as { status: string; user: { email: string } };
  assert.equal(out.status, "ok");
  assert.equal(out.user.email, "older@formindustries.com");
});

const nonceOf = (url: string) => new URL(new URL(url).searchParams.get("cb")!).pathname.split("/").pop()!;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** a fresh copy of the module, as a restarted server (tsx watch) would load it: nothing carried in memory */
let restarts = 0;
const restart = async () => {
  await load();
  return (await import(`../src/flowform.ts?restart=${++restarts}`)) as typeof import("../src/flowform.ts");
};

test("a sign-in in flight survives a server restart, finishes once, and keeps no secret on disk", async () => {
  people["c".repeat(32)] = { user_id: "ff-6", display_name: "Rae", email: "rae@formindustries.com", email_verified: true, role: "user" };
  people["7".repeat(32)] = { user_id: "ff-7", display_name: "Kit", email: "kit@formindustries.com", email_verified: true, role: "user" };
  const first = await load();

  // web, with a return path; desktop, with its poll secret
  const start = res();
  first.startWeb(req("/auth/flowform/start?return=/b/plan"), start.r);
  const webNonce = nonceOf(start.out.headers.location as string);
  const browserCookie = cookiesOf(start.out.headers["set-cookie"])[0].split(";")[0];
  const begun = first.beginDesktop(req("/auth/flowform/begin"));
  const deskNonce = nonceOf(begun.url);

  // on disk, seen from another connection: both attempts, only hashes of their secrets
  const disk = new DatabaseSync(join(process.env.FOUNDATION_DATA_DIR!, "foundation.db"));
  const rows = disk.prepare("select * from flowform_attempts").all() as Array<Record<string, unknown>>;
  disk.close();
  const web = rows.find((r) => r.nonce_hash === sha(webNonce));
  const desk = rows.find((r) => r.nonce_hash === sha(deskNonce));
  assert.equal(web?.mode, "web");
  assert.equal(web?.browser_hash, sha(browserCookie.split("=")[1]));
  assert.equal(desk?.mode, "desktop");
  assert.equal(desk?.poll_hash, sha(begun.poll));
  const dump = JSON.stringify(rows);
  for (const s of [webNonce, deskNonce, browserCookie.split("=")[1], begun.poll]) assert.ok(!dump.includes(s), "a secret was stored in the clear");

  // the server restarts mid-sign-in; flowform comes back to the new process
  const second = await restart();
  assert.notEqual(second, first);
  const fin = res();
  await second.done(req(`/auth/flowform/done/${webNonce}?session_token=${"c".repeat(32)}`, { cookie: browserCookie }, { nonce: webNonce }), fin.r);
  assert.equal(fin.out.status, 302);
  assert.equal(fin.out.headers.location, "/b/plan");
  assert.ok(cookiesOf(fin.out.headers["set-cookie"]).some((c) => c.startsWith("foundation_session=")));
  // a replayed callback, even from the same browser, finds it spent
  const replay = res();
  await second.done(req(`/auth/flowform/done/${webNonce}?session_token=${"c".repeat(32)}`, { cookie: browserCookie }, { nonce: webNonce }), replay.r);
  assert.equal(replay.out.status, 400);
  assert.match(replay.out.body, /expired/);

  // desktop: the browser finishes on one process, the window collects on the next
  const page = res();
  await second.done(req(`/auth/flowform/done/${deskNonce}?session_token=${"7".repeat(32)}`, {}, { nonce: deskNonce }), page.r);
  assert.equal(page.out.status, 200);
  const again = await restart();
  const deskReplay = res();
  await again.done(req(`/auth/flowform/done/${deskNonce}?session_token=${"7".repeat(32)}`, {}, { nonce: deskNonce }), deskReplay.r);
  assert.equal(deskReplay.out.status, 400); // still a replay after the restart
  const got = res();
  const out = again.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), got.r) as { status: string; user: { email: string } };
  assert.equal(out.status, "ok");
  assert.equal(out.user.email, "kit@formindustries.com");
  assert.ok(cookiesOf(got.out.headers["set-cookie"]).some((c) => c.startsWith("foundation_session=")));
  assert.throws(() => again.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), /no such sign-in/);
  // nothing of either attempt is left
  const { one } = await import("../src/db.ts");
  assert.equal(one("select 1 from flowform_attempts where nonce_hash in (?, ?)", sha(webNonce), sha(deskNonce)), undefined);
});

test("an attempt older than 10 minutes is refused and swept", async () => {
  people["6".repeat(32)] = { user_id: "ff-8", display_name: "Lou", email: "lou@formindustries.com", email_verified: true, role: "user" };
  const ff = await restart();
  const { one } = await import("../src/db.ts");
  const t0 = Date.now();
  try {
    ff.attemptClock.now = () => t0;
    const begun = ff.beginDesktop(req("/auth/flowform/begin"));
    const deskNonce = nonceOf(begun.url);
    const start = res();
    ff.startWeb(req("/auth/flowform/start"), start.r);
    const webNonce = nonceOf(start.out.headers.location as string);
    const browserCookie = cookiesOf(start.out.headers["set-cookie"])[0].split(";")[0];
    const late = ff.beginDesktop(req("/auth/flowform/begin")); // finished just inside the window
    const lateNonce = nonceOf(late.url);

    ff.attemptClock.now = () => t0 + 10 * 60_000 - 1;
    await ff.done(req(`/auth/flowform/done/${lateNonce}?session_token=${"6".repeat(32)}`, {}, { nonce: lateNonce }), res().r);
    assert.equal((ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${late.poll}` }), res().r) as { status: string }).status, "ok");

    ff.attemptClock.now = () => t0 + 10 * 60_000 + 1;
    assert.throws(() => ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), /no such sign-in/);
    const desk = res();
    await ff.done(req(`/auth/flowform/done/${deskNonce}?session_token=${"6".repeat(32)}`, {}, { nonce: deskNonce }), desk.r);
    assert.equal(desk.out.status, 400);
    assert.match(desk.out.body, /expired/);
    const web = res();
    await ff.done(req(`/auth/flowform/done/${webNonce}?session_token=${"6".repeat(32)}`, { cookie: browserCookie }, { nonce: webNonce }), web.r);
    assert.equal(web.out.status, 400);
    assert.match(web.out.body, /expired/);
    // swept from the table, not just refused
    assert.equal(one("select 1 from flowform_attempts where nonce_hash in (?, ?)", sha(deskNonce), sha(webNonce)), undefined);
    assert.equal(one<{ n: number }>("select count(*) as n from flowform_attempts where expires_at <= ?", t0 + 10 * 60_000 + 1)?.n, 0);

    // the server stopped while /done was asking flowform: the attempt is spent with no answer, and the window hears so within a minute
    const t1 = t0 + 20 * 60_000;
    ff.attemptClock.now = () => t1;
    const cut = ff.beginDesktop(req("/auth/flowform/begin"));
    const { run } = await import("../src/db.ts");
    run("update flowform_attempts set used_at = ? where nonce_hash = ?", t1, sha(nonceOf(cut.url)));
    const ask = () => ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${cut.poll}` }), res().r) as { status: string; error?: string };
    ff.attemptClock.now = () => t1 + 30_000;
    assert.equal(ask().status, "pending");
    ff.attemptClock.now = () => t1 + 61_000;
    assert.deepEqual(ask(), { status: "error", error: "Sign-in was interrupted. Try again." });
    assert.throws(ask, /no such sign-in/);
  } finally {
    ff.attemptClock.now = () => Date.now();
  }
});

test("linking folds a flowform user into an existing one, and flowform then signs in as it", async () => {
  const ff = await load();
  const { upsertUser, createSession } = await import("../src/auth.ts");
  const { one, run } = await import("../src/db.ts");
  const devUser = upsertUser("josh.dev@gmail.com", "Josh");
  people["9".repeat(32)] = { user_id: "ff-josh", display_name: "Josh Leong", email: "josh@normallab.co", email_verified: false, role: "admin" };
  people["8".repeat(32)] = { user_id: "ff-josh", display_name: "Josh Leong", email: "josh@normallab.co", email_verified: false, role: "admin" };
  const signIn = async (token: string) => {
    const begun = ff.beginDesktop(req("/auth/flowform/begin"));
    const nonce = new URL(new URL(begun.url).searchParams.get("cb")!).pathname.split("/").pop()!;
    await ff.done(req(`/auth/flowform/done/${nonce}?session_token=${token}`, {}, { nonce }), res().r);
    return ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r) as { user: { id: string; email: string; role: string } };
  };
  const viaFlowform = (await signIn("9".repeat(32))).user;
  assert.equal(viaFlowform.email, "josh@normallab.co");
  run("insert into files (id, board_id, name, mime, size, sha256, uploaded_by, created_at) values ('f_link', 'company', 'a.step', 'model/step', 1, 'x', ?, 0)", viaFlowform.id);
  createSession(viaFlowform.id);

  const out = ff.linkAccounts("josh.dev@gmail.com", "josh@normallab.co");
  assert.equal(out.kept, "josh.dev@gmail.com");
  assert.equal(out.moved["files.uploaded_by"], 1);
  assert.ok(out.moved["sessions.user_id"] >= 2);
  assert.equal(one("select id from users where email = 'josh@normallab.co'"), undefined);
  assert.equal(one<{ uploaded_by: string }>("select uploaded_by from files where id = 'f_link'")?.uploaded_by, devUser.id);

  // the next Google sign-in through flowform is the kept user, admin from flowform
  const after = (await signIn("8".repeat(32))).user;
  assert.equal(after.id, devUser.id);
  assert.equal(after.email, "josh.dev@gmail.com");
  assert.equal(after.role, "admin");

  assert.throws(() => ff.linkAccounts("josh.dev@gmail.com", "josh.dev@gmail.com"), /same user/);
});

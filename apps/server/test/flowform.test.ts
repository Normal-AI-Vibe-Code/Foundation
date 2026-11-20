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

/** just enough of IncomingMessage / ServerResponse for the handlers; from this computer unless `peer` says otherwise */
function req(path: string, headers: Record<string, string> = {}, params: Record<string, string> = {}, peer = "127.0.0.1") {
  const url = new URL(path, "http://localhost:1430");
  return { headers: { host: "localhost:1430", ...headers }, params, query: url.searchParams, socket: { remoteAddress: peer } } as never;
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

/**
 * desktop: flowform came back to the browser at /done; the browser shows the confirm page, and the
 * person presses (or not). Returns the page /done answered with and the browser's press cookie.
 */
async function finishInBrowser(ff: typeof import("../src/flowform.ts"), nonce: string, token: string) {
  const page = res();
  await ff.done(req(`/auth/flowform/done/${nonce}?session_token=${token}`, {}, { nonce }), page.r);
  const press = cookiesOf(page.out.headers["set-cookie"]).find((c) => c.startsWith("foundation_ff_confirm="))?.split(";")[0] ?? "";
  return { page: page.out, press };
}
/** the person's press on that page, from the page itself */
function answer(ff: typeof import("../src/flowform.ts"), press: string, yes: boolean, headers: Record<string, string> = {}) {
  const out = res();
  ff.confirm(req(`/auth/flowform/confirm/${yes ? "yes" : "no"}`, { cookie: press, origin: "http://localhost:1430", "sec-fetch-site": "same-origin", ...headers }), out.r, yes ? "yes" : "no");
  return out.out;
}

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
  // the browser is asked, with the window's code, and gets no Foundation session of its own
  assert.match(page.out.body, /An app on a computer is asking to sign in/);
  assert.ok(page.out.body.includes(begun.code));
  assert.ok(!cookiesOf(page.out.headers["set-cookie"]).some((c) => c.startsWith("foundation_session=")));
  const press = cookiesOf(page.out.headers["set-cookie"]).find((c) => c.startsWith("foundation_ff_confirm="))!.split(";")[0];
  // until the press, the window gets nothing
  assert.deepEqual(ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), { status: "pending" });
  assert.equal(answer(ff, press, true).status, 200);

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
    const { press } = await finishInBrowser(ff, nonce, token);
    if (press) answer(ff, press, true);
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
  answer(ff, (await finishInBrowser(ff, nonce, "b".repeat(32))).press, true);
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

  // desktop: the browser finishes on one process, the person presses on the next, the window collects on a third
  const { page, press } = await finishInBrowser(second, deskNonce, "7".repeat(32));
  assert.equal(page.status, 200);
  assert.equal(answer(await restart(), press, true).status, 200);
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

    // a desktop sign-in is over in five minutes
    ff.attemptClock.now = () => t0 + 5 * 60_000 - 1;
    answer(ff, (await finishInBrowser(ff, lateNonce, "6".repeat(32))).press, true);
    assert.equal((ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${late.poll}` }), res().r) as { status: string }).status, "ok");

    ff.attemptClock.now = () => t0 + 5 * 60_000 + 1;
    assert.throws(() => ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), /no such sign-in/);
    const desk = res();
    await ff.done(req(`/auth/flowform/done/${deskNonce}?session_token=${"6".repeat(32)}`, {}, { nonce: deskNonce }), desk.r);
    assert.equal(desk.out.status, 400);
    assert.match(desk.out.body, /expired/);
    // the web attempt (ten minutes) is still live at five; it is refused after ten
    ff.attemptClock.now = () => t0 + 10 * 60_000 + 1;
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
    answer(ff, (await finishInBrowser(ff, nonce, token)).press, true);
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

test("desktop: only a person's app on this computer can begin, and it is given a code to show", async () => {
  const ff = await load();
  const { config } = await import("../src/config.ts");
  const { createSession, upsertUser } = await import("../src/auth.ts");
  const someone = upsertUser("begin@formindustries.com", "Bea");
  const agentBearer = createSession(someone.id, 60_000, "agent");
  const saved = config.serviceToken;
  config.serviceToken = "s".repeat(40);
  try {
    // an agent's bearer, an agent's cookie and the service token are refused
    assert.throws(() => ff.beginDesktop(req("/auth/flowform/begin", { authorization: `Bearer ${agentBearer}` })), /agent's token can't begin/);
    assert.throws(() => ff.beginDesktop(req("/auth/flowform/begin", { cookie: `foundation_session=${agentBearer}` })), /agent's session can't begin/);
    assert.throws(() => ff.beginDesktop(req("/auth/flowform/begin", { authorization: `Bearer ${config.serviceToken}` })), /service token can't begin/);
    // from another computer (or through a proxy that names another client): refused, unless this server is hosted
    assert.throws(() => ff.beginDesktop(req("/auth/flowform/begin", {}, {}, "192.168.1.20")), /only from the computer/);
    assert.throws(() => ff.beginDesktop(req("/auth/flowform/begin", { "x-forwarded-for": "10.0.0.9" })), /only from the computer/);
    const pub = config.publicUrl;
    config.publicUrl = "https://foundation.example.com";
    try {
      assert.equal(ff.hostedServer(), true);
      assert.equal(ff.beginRefusal(req("/auth/flowform/begin", {}, {}, "192.168.1.20")), null);
      // hosted or not, an agent is never let begin
      assert.match(ff.beginRefusal(req("/auth/flowform/begin", { authorization: `Bearer ${agentBearer}` }, {}, "192.168.1.20")) ?? "", /agent/);
    } finally {
      config.publicUrl = pub;
    }
    assert.equal(ff.hostedServer(), false);
    // the person's own app: a code of eight from an unambiguous alphabet, grouped
    const begun = ff.beginDesktop(req("/auth/flowform/begin"));
    assert.match(begun.code, /^[ABCDEFGHJKMNPQRTUVWXY346789]{4}-[ABCDEFGHJKMNPQRTUVWXY346789]{4}$/);
    assert.equal(begun.expiresIn, 300);
    const codes = new Set(Array.from({ length: 50 }, () => ff.signInCode()));
    assert.ok(codes.size > 45, "codes are random");
  } finally {
    config.serviceToken = saved;
  }
});

test("desktop: the poll gets a session only after the person presses This is me, exactly once", async () => {
  people["5".repeat(32)] = { user_id: "ff-9", display_name: "Pat", email: "pat@formindustries.com", email_verified: true, role: "user" };
  const ff = await load();
  const begun = ff.beginDesktop(req("/auth/flowform/begin"));
  const ask = () => ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r) as { status: string; session?: string };
  const { page, press } = await finishInBrowser(ff, nonceOf(begun.url), "5".repeat(32));
  assert.equal(page.status, 200);
  assert.match(page.body, /Pat/);
  assert.ok(page.body.includes(begun.code));
  assert.match(page.body, /This is me, sign that app in/);
  assert.match(page.body, /Not me/);
  // the page can't be framed (a press must be the person's own) and runs no script
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
  assert.match(press, /^foundation_ff_confirm=.+/);

  // signed in at Flowform, not pressed yet: nothing, however often it asks
  for (let i = 0; i < 3; i++) assert.deepEqual(ask(), { status: "pending" });
  // a press from another page, or with no press cookie, does nothing
  assert.equal(answer(ff, press, true, { origin: "https://evil.example" }).status, 403);
  assert.equal(answer(ff, press, true, { "sec-fetch-site": "cross-site" }).status, 403);
  assert.equal(answer(ff, "foundation_ff_confirm=guess", true).status, 400);
  assert.deepEqual(ask(), { status: "pending" });

  // the press: the next poll gets the app's session, and only that poll
  assert.equal(answer(ff, press, true).status, 200);
  assert.equal(answer(ff, press, true).status, 400, "a press is spent");
  const got = res();
  const out = ff.poll(req("/auth/flowform/poll?bearer=1", { authorization: `Bearer ${begun.poll}` }), got.r) as { status: string; session?: string; user: { email: string } };
  assert.equal(out.status, "ok");
  assert.equal(out.user.email, "pat@formindustries.com");
  assert.ok(out.session);
  assert.throws(ask, /no such sign-in/);
});

test("desktop: after Not me the window gets nothing, ever", async () => {
  people["4".repeat(32)] = { user_id: "ff-10", display_name: "Sam", email: "sam@formindustries.com", email_verified: true, role: "user" };
  const ff = await load();
  const { one } = await import("../src/db.ts");
  const before = one<{ n: number }>("select count(*) as n from sessions")!.n;
  const begun = ff.beginDesktop(req("/auth/flowform/begin"));
  const ask = () => ff.poll(req("/auth/flowform/poll?bearer=1", { authorization: `Bearer ${begun.poll}` }), res().r) as { status: string; session?: string; error?: string };
  const { press } = await finishInBrowser(ff, nonceOf(begun.url), "4".repeat(32));
  const no = answer(ff, press, false);
  assert.equal(no.status, 200);
  assert.match(no.body, /not signed in/);
  // a later "This is me" from the same browser is too late
  assert.equal(answer(ff, press, true).status, 400);
  const told = ask();
  assert.equal(told.status, "error");
  assert.equal(told.session, undefined);
  assert.throws(ask, /no such sign-in/);
  assert.throws(ask, /no such sign-in/);
  assert.equal(one<{ n: number }>("select count(*) as n from sessions")!.n, before, "no session was made");
});

test("desktop: a sign-in nobody presses for expires, and a late press does nothing", async () => {
  people["3".repeat(32)] = { user_id: "ff-11", display_name: "Lee", email: "lee@formindustries.com", email_verified: true, role: "user" };
  const ff = await load();
  const t0 = Date.now();
  try {
    ff.attemptClock.now = () => t0;
    const begun = ff.beginDesktop(req("/auth/flowform/begin"));
    const { press } = await finishInBrowser(ff, nonceOf(begun.url), "3".repeat(32));
    ff.attemptClock.now = () => t0 + 4 * 60_000;
    assert.deepEqual(ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), { status: "pending" }); // still waiting on the press
    ff.attemptClock.now = () => t0 + 5 * 60_000 + 1;
    assert.equal(answer(ff, press, true).status, 400);
    assert.throws(() => ff.poll(req("/auth/flowform/poll", { authorization: `Bearer ${begun.poll}` }), res().r), /no such sign-in/);
  } finally {
    ff.attemptClock.now = () => Date.now();
  }
});

test("web: where to land afterwards is a path on this site, never another site however it's spelled", async () => {
  const ff = await load();
  for (const ok of ["/", "/b/plan", "/?arrive", "/b/plan#x"]) assert.equal(ff.safeReturn(ok), ok);
  for (const bad of ["//evil.example", "/\\evil.example", "/\\/evil.example", "\\\\evil.example", "https://evil.example", "/b\nLocation: x", "/\tevil", "evil", "", null]) assert.equal(ff.safeReturn(bad), "/", String(bad));
  // and the attempt keeps that
  const start = res();
  ff.startWeb(req(`/auth/flowform/start?return=${encodeURIComponent("/\\evil.example")}`), start.r);
  const { one } = await import("../src/db.ts");
  assert.equal(one<{ return_to: string }>("select return_to from flowform_attempts where nonce_hash = ?", sha(nonceOf(start.out.headers.location as string)))?.return_to, "/");
});

test("Google's own sign-in comes back only to the browser that started it", async () => {
  const { config } = await import("../src/config.ts");
  const { googleStart, googleCallback, GOOGLE_STATE_COOKIE } = await import("../src/auth.ts");
  const saved = config.google.clientId;
  config.google.clientId = "test-client.apps.googleusercontent.com";
  try {
    const a = googleStart();
    const state = new URL(a.url).searchParams.get("state")!;
    assert.match(a.cookie, new RegExp(`^${GOOGLE_STATE_COOKIE}=${state}; Path=/auth/google; HttpOnly; SameSite=Lax`));
    // another browser (no cookie, or another sign-in's) is refused before Google is asked anything
    await assert.rejects(googleCallback("code", state, ""), /started in a different browser/);
    const b = googleStart();
    const other = new URL(googleStart().url).searchParams.get("state")!;
    await assert.rejects(googleCallback("code", new URL(b.url).searchParams.get("state")!, other), /started in a different browser/);
    // a state is spent once, whichever browser brought it
    await assert.rejects(googleCallback("code", state, state), /sign-in expired/);
  } finally {
    config.google.clientId = saved;
  }
});

/**
 * A hosted Foundation (FOUNDATION_PUBLIC_URL is an https address that isn't this computer) with its own
 * Google client: the browser signs in at Google and comes back to the hosted address; the desktop app
 * (on anyone's computer) begins a sign-in, shows a code, and gets its session only after the person's
 * press in the browser; someone off the allowlist gets nothing; the app's window may call a hosted
 * server; and the server serves the web client itself, never a file outside its folder and never in
 * place of its own routes. A stand-in Google answers the token and userinfo calls on a loopback port.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOSTED = "https://foundation.example.com";
process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.co";
process.env.FOUNDATION_ALLOWLIST = "@formindustries.co";
process.env.FOUNDATION_PUBLIC_URL = HOSTED;
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
delete process.env.FOUNDATION_EXIT_WITH_PARENT;
delete process.env.FOUNDATION_CORS_ORIGINS;
delete process.env.FOUNDATION_CLIENT_URL;
delete process.env.FOUNDATION_CLIENT_DIR;

/** the stand-in Google: a code is worth one access token, and a token names a person */
const people: Record<string, object> = {
  "code-ada": { email: "ada@formindustries.co", email_verified: true, name: "Ada Field" },
  "code-boss": { email: "boss@formindustries.co", email_verified: true, name: "The Boss" },
  "code-outsider": { email: "someone@gmail.com", email_verified: true, name: "Someone Else" },
  "code-unverified": { email: "new@formindustries.co", email_verified: false, name: "Unverified" },
};
const tokenCalls: URLSearchParams[] = [];
let google: Server;

before(async () => {
  google = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/token" && req.method === "POST") {
        const form = new URLSearchParams(body);
        tokenCalls.push(form);
        const code = form.get("code") ?? "";
        if (!people[code] || form.get("client_secret") !== "test-secret") return res.writeHead(400).end("{}");
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `at-${code}` }));
      }
      const who = people[(req.headers.authorization ?? "").replace(/^Bearer at-/, "")];
      if (req.url === "/userinfo" && who) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(who));
      res.writeHead(401).end("{}");
    });
  });
  await new Promise<void>((ok) => google.listen(0, "127.0.0.1", ok));
  const at = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
  process.env.GOOGLE_OAUTH_BASE = at;
  process.env.GOOGLE_USERINFO_URL = `${at}/userinfo`;
});
after(() => google.close());

/** a request as the proxy in front of a hosted server passes it on: the public name, someone else's address */
function req(path: string, headers: Record<string, string> = {}) {
  const url = new URL(path, HOSTED);
  return { method: "GET", url: path, headers: { host: "foundation.example.com", "x-forwarded-for": "203.0.113.7", ...headers }, params: {}, query: url.searchParams, socket: { remoteAddress: "127.0.0.1" } } as never;
}
function res() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: "", piped: false };
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
    // a file streamed to the response
    on: () => r,
    once: () => r,
    emit: () => true,
    write: (b: Buffer | string) => ((out.body += String(b)), true),
  };
  return { r: r as never, out };
}
const cookiesOf = (h: unknown) => ([] as string[]).concat((h as string | string[]) ?? []);
const load = async () => ({ ff: await import("../src/flowform.ts"), auth: await import("../src/auth.ts"), db: await import("../src/db.ts") });

/** the app begins; the person finishes Google in a browser, which lands on the callback */
async function desktopSignIn(code: string) {
  const { ff } = await load();
  const begun = ff.beginDesktop(req("/auth/flowform/begin"));
  const to = new URL(begun.url);
  const state = to.searchParams.get("state")!;
  const page = res();
  const handled = await ff.googleDesktopDone(req(`/auth/google/callback?code=${code}&state=${state}`), page.r);
  const press = cookiesOf(page.out.headers["set-cookie"]).find((c) => c.startsWith("foundation_ff_confirm=")) ?? "";
  const poll = (bearer = true) => ff.poll(req(`/auth/flowform/poll${bearer ? "?bearer=1" : ""}`, { authorization: `Bearer ${begun.poll}` }), res().r) as { status: string; session?: string; error?: string; user?: { email: string; role: string } };
  const answer = (yes: boolean) => {
    const out = res();
    ff.confirm(req(`/auth/flowform/confirm/${yes ? "yes" : "no"}`, { cookie: press.split(";")[0], origin: "null", "sec-fetch-site": "same-origin" }), out.r, yes ? "yes" : "no");
    return out.out;
  };
  return { begun, to, state, handled, page: page.out, press, poll, answer };
}

test("hosted: the server knows it is hosted and signs in with its own Google client", async () => {
  const { ff, auth } = await load();
  assert.equal(ff.hostedServer(), true);
  assert.equal(auth.googleSignIn(), true);
});

test("hosted desktop: the app on another computer begins, Google comes back to the hosted address, and the press releases one session", async () => {
  const { auth, db } = await load();
  const s = await desktopSignIn("code-ada");
  // Google's own page, asked to come back to the hosted address (never a loopback one), with the attempt as its state
  assert.equal(s.to.pathname, "/o/oauth2/v2/auth");
  assert.equal(s.to.searchParams.get("redirect_uri"), `${HOSTED}/auth/google/callback`);
  assert.equal(s.to.searchParams.get("client_id"), "test-client.apps.googleusercontent.com");
  assert.ok(!s.begun.url.includes(s.begun.poll), "the app's poll secret is in no URL");
  assert.equal(s.handled, true);
  assert.equal(s.page.status, 200);
  assert.match(s.page.body, /Ada Field/);
  assert.ok(s.page.body.includes(s.begun.code), "the browser shows the app's code back");
  // the press cookie is kept to https and to this site
  assert.match(s.press, /HttpOnly; SameSite=Strict/);
  assert.match(s.press, /; Secure/);
  // the exchange named the hosted callback and never put the secret in a URL
  const call = tokenCalls.at(-1)!;
  assert.equal(call.get("redirect_uri"), `${HOSTED}/auth/google/callback`);
  assert.equal(call.get("grant_type"), "authorization_code");

  // signed in at Google, not pressed yet: nothing
  assert.deepEqual(s.poll(), { status: "pending" });
  assert.equal(s.answer(true).status, 200);
  const got = s.poll();
  assert.equal(got.status, "ok");
  assert.equal(got.user?.email, "ada@formindustries.co");
  assert.equal(got.user?.role, "member", "someone new to the server is a member");
  assert.ok(got.session, "the app is handed a bearer (the cookie can't reach another site)");
  // the session is an app's (a person), stored hashed
  const row = db.one<{ kind: string }>("select kind from sessions where token = ?", auth.hashToken(got.session!));
  assert.equal(row?.kind, "app");
  assert.equal(db.one("select 1 as x from sessions where token = ?", got.session!), undefined, "never stored in the clear");
  assert.throws(() => s.poll(), /no such sign-in/, "collected once");
});

test("hosted desktop: an admin named in FOUNDATION_ADMIN_EMAILS arrives as an admin", async () => {
  const s = await desktopSignIn("code-boss");
  s.answer(true);
  assert.equal(s.poll().user?.role, "admin");
});

test("hosted desktop: someone off the allowlist, or with an unverified address, gets a page that says so and no session", async () => {
  const { db } = await load();
  const before = db.one<{ n: number }>("select count(*) as n from sessions")!.n;
  for (const [code, why] of [["code-outsider", /not on Foundation's allowlist/], ["code-unverified", /no verified email/]] as const) {
    const s = await desktopSignIn(code);
    assert.equal(s.page.status, 403);
    assert.match(s.page.body, why);
    assert.equal(s.press, "", "there is nothing to press");
    const told = s.poll();
    assert.equal(told.status, "error");
    assert.equal(told.session, undefined);
  }
  assert.equal(db.one("select 1 as x from users where email = ?", "someone@gmail.com"), undefined, "no user was made");
  assert.equal(db.one<{ n: number }>("select count(*) as n from sessions")!.n, before);
});

test("hosted desktop: cancelling at Google ends the attempt, a replayed callback finds it spent, and Not me gives the app nothing", async () => {
  const { ff } = await load();
  const begun = ff.beginDesktop(req("/auth/flowform/begin"));
  const state = new URL(begun.url).searchParams.get("state")!;
  const cancelled = res();
  assert.equal(await ff.googleDesktopDone(req(`/auth/google/callback?error=access_denied&state=${state}`), cancelled.r), true);
  assert.match(cancelled.out.body, /cancelled at Google/);
  const replay = res();
  assert.equal(await ff.googleDesktopDone(req(`/auth/google/callback?code=code-ada&state=${state}`), replay.r), true);
  assert.equal(replay.out.status, 400);

  const s = await desktopSignIn("code-ada");
  assert.match(s.answer(false).body, /not signed in/);
  assert.equal(s.poll().status, "error");
});

test("hosted web: the Google button goes to Google bound to this browser, and a state that is no app's is left to the web sign-in", async () => {
  const { ff, auth } = await load();
  const start = res();
  ff.startWeb(req("/auth/flowform/start?return=%2F%3Farrive"), start.r);
  assert.equal(start.out.status, 302);
  const to = new URL(start.out.headers.location as string);
  assert.equal(to.searchParams.get("redirect_uri"), `${HOSTED}/auth/google/callback`);
  const state = to.searchParams.get("state")!;
  const cookie = String(start.out.headers["set-cookie"]);
  assert.match(cookie, new RegExp(`^${auth.GOOGLE_STATE_COOKIE}=${state}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600; Secure`));
  // not a desktop attempt: the app's finish declines it, and the browser's own binding is what admits it
  assert.equal(await ff.googleDesktopDone(req(`/auth/google/callback?code=code-ada&state=${state}`), res().r), false);
  await assert.rejects(auth.googleCallback("code-ada", state, "another-browser"), /started in a different browser/);
  // the browser that started gets in, and its session cookie is kept to https
  const again = res();
  ff.startWeb(req("/auth/flowform/start"), again.r);
  const st2 = new URL(again.out.headers.location as string).searchParams.get("state")!;
  const user = await auth.googleCallback("code-ada", st2, st2);
  assert.equal(user.email, "ada@formindustries.co");
  const signed = res();
  auth.setSessionCookie(signed.r, auth.createSession(user.id));
  assert.match(String(signed.out.headers["set-cookie"]), /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
});

test("hosted without a Google client: sign-in says what is missing instead of sending anyone to Flowform", async () => {
  const { ff } = await load();
  const { config } = await import("../src/config.ts");
  const saved = config.google.clientSecret;
  config.google.clientSecret = "";
  try {
    assert.throws(() => ff.beginDesktop(req("/auth/flowform/begin")), /needs its own Google client/);
    assert.throws(() => ff.startWeb(req("/auth/flowform/start"), res().r), /needs its own Google client/);
  } finally {
    config.google.clientSecret = saved;
  }
});

test("hosted: the desktop app's window may call the server; any other page may not", async () => {
  const { hosted, allowedOrigins } = await import("../src/origins.ts");
  assert.equal(hosted(HOSTED), true);
  for (const local of ["http://localhost:4410", "http://127.0.0.1:4410", "http://[::1]:4410", "not a url"]) assert.equal(hosted(local), false, local);
  const allowed = allowedOrigins();
  assert.ok(allowed.has("http://localhost:31440") && allowed.has("tauri://localhost"));
  assert.ok(!allowed.has("http://localhost:5173") && !allowed.has("https://evil.example"));
});

test("the server serves the web client from its folder: pages, files, nothing outside it, and never in place of its own routes", async () => {
  const { clientFile, serveClient } = await import("../src/clientfiles.ts");
  const dir = mkdtempSync(join(tmpdir(), "foundation-client-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Foundation</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  writeFileSync(join(dir, "..", "outside.txt"), "no");

  assert.ok(clientFile(dir, "/index.html"));
  assert.ok(clientFile(dir, "/assets/app-abc123.js"));
  for (const bad of ["/../outside.txt", "/%2e%2e/outside.txt", "/assets/../../outside.txt", "/..%5coutside.txt", "/.env", "/%00", "/%E0%A4%A", "/assets"]) assert.equal(clientFile(dir, bad), null, bad);

  const get = (path: string, headers: Record<string, string> = { accept: "text/html" }, method = "GET") => {
    const out = res();
    const served = serveClient({ method, headers } as never, out.r, path, dir);
    return { served, ...out.out };
  };
  // the app, at / and at any page path a browser asks for
  for (const p of ["/", "/b/plan"]) {
    const page = get(p);
    assert.equal(page.served, true, p);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.equal(page.headers["cache-control"], "no-cache");
  }
  const js = get("/assets/app-abc123.js", {});
  assert.equal(js.served, true);
  assert.match(String(js.headers["content-type"]), /javascript/);
  assert.match(String(js.headers["cache-control"]), /immutable/);
  assert.equal(js.headers["x-content-type-options"], "nosniff");
  // the server's own paths stay the server's (a missing route is its JSON 404, not a page), as do writes
  for (const p of ["/api/nope", "/auth/nope", "/files/x", "/mcp", "/sync/company", "/m/1/"]) assert.equal(get(p).served, false, p);
  assert.equal(get("/", { accept: "text/html" }, "POST").served, false);
  // a missing file is not answered with the page, and a server without a client folder serves none
  assert.equal(get("/assets/missing.js", { accept: "*/*" }).served, false);
  assert.equal(get("/b/plan", { accept: "application/json" }).served, false);
  assert.equal(get("/", { accept: "*/*" }).served, true, "the address itself is always the app");
  assert.equal(serveClient({ method: "GET", headers: { accept: "text/html" } } as never, res().r, "/", ""), false);
});

/**
 * The desktop app's window (http://localhost:31440, tauri://localhost) is a page Foundation trusts with
 * the sign-in cookie only when the desktop app started this server (it sets FOUNDATION_EXIT_WITH_PARENT=1;
 * origins.ts startedForDesktop), or when FOUNDATION_CORS_ORIGINS lists it. Any other server can't tell that
 * port's page from another program's. (The desktop-started state over HTTP: hardening.test.ts, whose server
 * is started that way.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
delete process.env.FOUNDATION_EXIT_WITH_PARENT;
delete process.env.FOUNDATION_CORS_ORIGINS;

const WINDOW = "http://localhost:31440";
const CLIENT = "http://localhost:1430";

test("started for the desktop app, or listed: the window is trusted; otherwise it is not", async () => {
  const { originsFor, startedForDesktop } = await import("../src/origins.ts");
  assert.equal(startedForDesktop({ FOUNDATION_EXIT_WITH_PARENT: "1" }), true);
  assert.equal(startedForDesktop({}), false);
  assert.equal(startedForDesktop({ FOUNDATION_EXIT_WITH_PARENT: "0" }), false);

  const desktop = originsFor({ clientUrl: CLIENT, corsOrigins: [], desktop: true });
  assert.ok(desktop.has(WINDOW) && desktop.has("tauri://localhost") && desktop.has(CLIENT));

  const dev = originsFor({ clientUrl: CLIENT, corsOrigins: [], desktop: false });
  assert.ok(!dev.has(WINDOW) && !dev.has("tauri://localhost"));
  assert.ok(dev.has(CLIENT));

  const listed = originsFor({ clientUrl: CLIENT, corsOrigins: [`${WINDOW}/`], desktop: false });
  assert.ok(listed.has(WINDOW), "a person can still list it");
  assert.ok(!listed.has("tauri://localhost"));
});

test("a server not started by the desktop app refuses the window's cookie writes and gives it no CORS", async () => {
  const { allowedOrigins, cookieOriginRefusal, originAllowed } = await import("../src/origins.ts");
  assert.ok(!allowedOrigins().has(WINDOW));
  assert.equal(originAllowed(WINDOW), false);
  assert.equal(originAllowed("tauri://localhost"), false);
  const post = (origin: string) =>
    cookieOriginRefusal({ method: "POST", headers: { cookie: "foundation_session=abc", origin } } as never);
  assert.match(post(WINDOW) ?? "", /A page at http:\/\/localhost:31440 can't use your Foundation sign-in/);
  assert.equal(post(CLIENT), null, "the client's own page still can");
});

/**
 * The frame rules (panels/frameSandbox.ts; #80, 2026-11-18): every frame that shows an address from a card, an
 * app or a person's typing (an app card, a web page space, the built-in browser, T3's frame). Never Foundation
 * itself; always sandboxed; its own origin only for a saved app or the configured T3 address; and the bridge
 * names the frame's origin and hears only that frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWN_PAGE, SANDBOX, bridgeAccepts, bridgeTarget, foundationOrigins, frameAllow, frameFor, isLoopbackHost, type FrameContext } from "../src/panels/frameSandbox";

// the desktop app's page on 31440, its server on 4410; one saved app on this computer and one on the web
const ctx: FrameContext = {
  ...foundationOrigins("http://localhost:31440", ["http://localhost:4410", "", "http://127.0.0.1:4410"]),
  saved: ["http://127.0.0.1:3001", "https://airformdata.com"],
};

const refused = (url: string, c: FrameContext = ctx) => {
  const d = frameFor(url, c);
  return d.ok ? "" : d.reason;
};

test("Foundation's own origins and ports, from the page and its servers", () => {
  assert.deepEqual(ctx.ours.sort(), ["http://127.0.0.1:4410", "http://localhost:31440", "http://localhost:4410"]);
  assert.deepEqual(ctx.ports.sort(), ["31440", "4410"]);
  // a page that isn't on this computer adds no loopback port; tauri://localhost adds none either
  assert.deepEqual(foundationOrigins("https://foundation.example", ["https://api.foundation.example"]).ports, []);
  assert.deepEqual(foundationOrigins("tauri://localhost", ["http://127.0.0.1:4410"]).ports, ["4410"]);
});

test("never Foundation itself: the client's or the server's origin, or a loopback address on their ports", () => {
  for (const url of [
    "http://localhost:31440/e2e/frame.html",
    "/files/abc/report.html", // a relative address is the page's own
    "http://localhost:4410/files/abc",
    "http://127.0.0.1:4410/api/me",
    "http://[::1]:4410/",
    "http://0.0.0.0:4410/",
    "http://foundation.localhost:4410/",
    "http://127.1.2.3:31440/", // another loopback name for the client's port
    "http://2130706433:4410/", // 127.0.0.1 written as a number
  ])
    assert.equal(refused(url), OWN_PAGE, url);
});

test("only web addresses are framed: no data:, blob:, javascript:, about: or file:", () => {
  for (const url of ["data:text/html,<script>parent.x=1</script>", "about:blank", "javascript:alert(1)", "blob:http://localhost:31440/x", "file:///C:/secret.txt"]) assert.match(refused(url), /Only web pages/, url);
  assert.match(refused("http://"), /can't be opened/);
});

test("always sandboxed; its own origin (allow-same-origin) only for a saved app", () => {
  const app = frameFor("https://airformdata.com/rooms", ctx);
  assert.ok(app.ok);
  assert.equal(app.sandbox, `${SANDBOX} allow-same-origin`);
  const local = frameFor("http://127.0.0.1:3001/", ctx);
  assert.ok(local.ok && local.trusted, "a saved app on this computer keeps its origin");
  // anything else, typed or on a card, runs opaque: scripts but no same-origin
  for (const url of ["https://example.com/", "http://localhost:3001/" /* same port, another origin than the saved one */, "http://127.0.0.1:11502/" /* a machine's port */, "http://192.168.1.20:8080/"]) {
    const d = frameFor(url, ctx);
    assert.ok(d.ok, url);
    assert.equal(d.sandbox, SANDBOX, url);
    assert.ok(!d.sandbox.includes("allow-same-origin"), url);
    assert.ok(d.sandbox.includes("allow-scripts"), url);
  }
  assert.ok(!SANDBOX.includes("allow-same-origin") && !SANDBOX.includes("allow-top-navigation"));
});

test("T3's frame: the configured T3 address keeps its origin, and only in T3's frame", () => {
  const t3 = frameFor("http://localhost:3773/?pair=x", { ...ctx, t3: "http://localhost:3773" });
  assert.ok(t3.ok && t3.trusted);
  assert.equal(t3.sandbox, `${SANDBOX} allow-same-origin`);
  // the same address typed into the browser (no t3 in its context) runs opaque
  const typed = frameFor("http://localhost:3773/", ctx);
  assert.ok(typed.ok && !typed.trusted);
  // and T3 can't be pointed at Foundation
  assert.equal(refused("http://localhost:4410/", { ...ctx, t3: "http://localhost:4410" }), OWN_PAGE);
});

test("the bridge names the frame's own origin, never '*', and only a trusted frame is sent anything", () => {
  assert.equal(bridgeTarget(frameFor("https://airformdata.com/x", ctx)), "https://airformdata.com");
  assert.equal(bridgeTarget(frameFor("https://example.com/", ctx)), null, "an opaque frame has no origin to name");
  assert.equal(bridgeTarget(frameFor("http://localhost:4410/", ctx)), null);
});

test("the bridge hears only its own frame's window, from that frame's origin", () => {
  const win = { name: "the frame's window" };
  const other = { name: "another window" };
  const app = frameFor("https://airformdata.com/x", ctx);
  assert.equal(bridgeAccepts(app, { origin: "https://airformdata.com", source: win }, win), true);
  assert.equal(bridgeAccepts(app, { origin: "https://evil.example", source: win }, win), false, "the frame navigated elsewhere");
  assert.equal(bridgeAccepts(app, { origin: "https://airformdata.com", source: other }, win), false, "another window with the right origin");
  const opaque = frameFor("https://example.com/", ctx);
  assert.equal(bridgeAccepts(opaque, { origin: "null", source: win }, win), true);
  assert.equal(bridgeAccepts(opaque, { origin: "https://example.com", source: win }, win), false);
  assert.equal(bridgeAccepts(frameFor("http://localhost:4410/", ctx), { origin: "http://localhost:4410", source: win }, win), false);
  assert.equal(bridgeAccepts(app, { origin: "https://airformdata.com", source: null }, null), false, "no frame, nothing heard");
});

test("camera, microphone and clipboard reading only for a trusted frame", () => {
  assert.equal(frameAllow(frameFor("https://airformdata.com/", ctx), "fullscreen"), "clipboard-read; clipboard-write; camera; microphone; fullscreen");
  assert.equal(frameAllow(frameFor("https://example.com/", ctx), "fullscreen"), "clipboard-write; fullscreen");
});

test("loopback names", () => {
  for (const h of ["localhost", "LOCALHOST", "a.localhost", "127.0.0.1", "127.255.0.9", "[::1]", "::1", "0.0.0.0", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) assert.ok(isLoopbackHost(h), h);
  for (const h of ["example.com", "localhost.example.com", "128.0.0.1", "10.0.0.1", "[::2]"]) assert.ok(!isLoopbackHost(h), h);
});

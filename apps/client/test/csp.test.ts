/**
 * The pages' Content Security Policy (csp.ts): what it must say, and what it must never allow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CSP_HEADER, cspDirectives, cspString, framedBySelf } from "../csp";

const parse = (s: string) => Object.fromEntries(s.split(/;\s*/).map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

for (const [label, opts] of [
  ["the shell, built", {}],
  ["the shell, in dev", { dev: true }],
  ["the desktop page", { framedBySelf: true }],
  ["with a server", { servers: ["http://127.0.0.1:4410", "https://foundation.example.com"] }],
] as const) {
  test(`${label}: the required directives, and no wildcard script source`, () => {
    const p = parse(cspString(opts));
    assert.deepEqual(p["default-src"], ["'self'"]);
    assert.deepEqual(p["object-src"], ["'none'"]);
    assert.deepEqual(p["base-uri"], ["'self'"]);
    assert.deepEqual(p["form-action"], ["'self'"]);
    // scripts: our own, and WebAssembly; never a wildcard, never any scheme or host, never eval
    for (const src of p["script-src"]) {
      assert.ok(!src.includes("*"), `no wildcard in script-src: ${src}`);
      assert.ok(!/^(https?:|data:|blob:|wss?:)/.test(src), `no scheme or host in script-src: ${src}`);
    }
    assert.ok(p["script-src"].includes("'self'") && p["script-src"].includes("'wasm-unsafe-eval'"));
    assert.ok(!p["script-src"].includes("'unsafe-eval'"), "no dependency here needs eval");
    assert.equal(p["script-src"].includes("'unsafe-inline'"), "dev" in opts, "inline scripts only for Vite's dev preamble");
    // frames: only web addresses (each frame is fenced by frameSandbox.ts)
    assert.deepEqual(p["frame-src"].sort(), ["'self'", "http:", "https:"]);
    assert.deepEqual(p["worker-src"], ["'self'", "blob:"]);
    assert.ok(!p["default-src"].includes("*") && !Object.values(p).some((v) => (v as string[]).includes("*")), "no bare * anywhere");
  });
}

test("the shell may be framed by nothing; the machine desktop page only by the app itself", () => {
  assert.deepEqual(parse(cspString())["frame-ancestors"], ["'none'"]);
  assert.deepEqual(parse(cspString({ framedBySelf: true }))["frame-ancestors"], ["'self'"]);
  assert.equal(framedBySelf("/desktop.html"), true);
  assert.equal(framedBySelf("/desktop.html?panel=x"), true);
  assert.equal(framedBySelf("/"), false);
  assert.equal(framedBySelf("/index.html"), false);
  assert.equal(framedBySelf("/desktop.html.evil"), false);
});

test("the server's origin is named for connections and media, http and ws, and nothing that isn't a web address", () => {
  const d = cspDirectives({ servers: ["http://127.0.0.1:4410/", "javascript:alert(1)", "not a url"] });
  assert.ok(d["connect-src"].includes("http://127.0.0.1:4410") && d["connect-src"].includes("ws://127.0.0.1:4410"));
  assert.ok(d["media-src"].includes("http://127.0.0.1:4410") && !d["media-src"].some((s) => s.startsWith("ws")));
  assert.ok(!JSON.stringify(d).includes("javascript"));
});

test("it ships report-only (not tried inside the packaged desktop app)", () => {
  assert.equal(CSP_HEADER, "Content-Security-Policy-Report-Only");
});

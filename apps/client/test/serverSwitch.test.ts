import { test } from "node:test";
import assert from "node:assert/strict";
import { initialKind, isAbsoluteFolder, isLocalServer, pillState, serverOrigin, shortAddress, startsAtLaunch } from "../src/server/model";

test("this computer is loopback, by name or number, at any port", () => {
  assert.ok(isLocalServer("http://localhost:4410"));
  assert.ok(isLocalServer("http://127.0.0.1:4410"));
  assert.ok(isLocalServer("http://[::1]:4410"));
  assert.ok(isLocalServer("http://app.localhost:9000"));
  assert.ok(!isLocalServer("https://server.formresearch.ai"));
  assert.ok(!isLocalServer("not a url"));
});

test("an address as typed becomes a server origin", () => {
  assert.deepEqual(serverOrigin("server.formresearch.ai"), { ok: true, origin: "https://server.formresearch.ai" }, "a bare host is https");
  assert.deepEqual(serverOrigin("  https://server.formresearch.ai/some/path/ "), { ok: true, origin: "https://server.formresearch.ai" }, "only the origin");
  assert.deepEqual(serverOrigin("localhost:4410"), { ok: true, origin: "http://localhost:4410" }, "this computer is http");
  assert.deepEqual(serverOrigin("http://10.0.0.5:4410"), { ok: true, origin: "http://10.0.0.5:4410" });
  assert.equal(serverOrigin("").ok, false);
  assert.equal(serverOrigin("ftp://files.example.com").ok, false, "only http(s)");
  assert.equal(serverOrigin("javascript:alert(1)").ok, false);
  assert.equal(serverOrigin("https://").ok, false);
});

test("addresses read without their scheme", () => {
  assert.equal(shortAddress("http://localhost:4410"), "localhost:4410");
  assert.equal(shortAddress("https://server.formresearch.ai/"), "server.formresearch.ai");
});

test("only an absolute folder is offered to the desktop app", () => {
  assert.ok(isAbsoluteFolder("C:\\Dev\\Foundation"));
  assert.ok(isAbsoluteFolder("D:/work/Foundation"));
  assert.ok(isAbsoluteFolder("/Users/josh/Foundation"));
  assert.ok(!isAbsoluteFolder("Foundation"));
  assert.ok(!isAbsoluteFolder("..\\Foundation"));
});

test("the collapsed switch: a dot and a word", () => {
  assert.deepEqual(pillState("up", "running", true), { tone: "ok", word: "Connected" });
  assert.deepEqual(pillState("down", "stopped", true), { tone: "bad", word: "Not running" });
  assert.deepEqual(pillState("down", "unknown", false), { tone: "bad", word: "Can't reach" });
  assert.deepEqual(pillState("checking", "unknown", false), { tone: "warn", word: "Checking…" });
  assert.deepEqual(pillState("down", "starting", true), { tone: "warn", word: "Starting…" }, "starting wins over a failed check");
});

test("this computer's server: the built-in one unless a person picked, or started a checkout before", () => {
  assert.equal(initialKind(null, false, true), "builtIn", "a fresh install: the server the app carries");
  assert.equal(initialKind(null, true, true), "checkout", "someone who started a checkout here before");
  assert.equal(initialKind("builtIn", true, true), "builtIn", "a person's own pick wins");
  assert.equal(initialKind("checkout", false, true), "checkout");
  assert.equal(initialKind("builtIn", false, false), "checkout", "a build without its own server (tauri dev) has only a checkout");
  assert.equal(initialKind("nonsense", false, true), "builtIn");
});

test("only a server a person started and didn't stop starts again with the app", () => {
  assert.equal(startsAtLaunch("builtIn", true, false), "builtIn");
  assert.equal(startsAtLaunch("checkout", true, false), "checkout");
  assert.equal(startsAtLaunch(null, true, false), null, "never started here, or stopped: nothing starts");
  assert.equal(startsAtLaunch("builtIn", true, true), null, "something already answers there");
  assert.equal(startsAtLaunch("builtIn", false, false), null, "the app uses a remote server");
  assert.equal(startsAtLaunch("other", true, false), null);
});

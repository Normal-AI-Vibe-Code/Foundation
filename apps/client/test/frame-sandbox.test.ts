/**
 * #80: a page from Foundation's own origin can't lift its sandbox; a page from
 * elsewhere keeps its own origin, so its sign-in works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SANDBOX, sandboxFor } from "../src/panels/frameSandbox";

const ours = ["http://localhost:31440", "http://localhost:4410"];

test("our own pages and uploaded files run without allow-same-origin", () => {
  assert.equal(sandboxFor("http://localhost:31440/e2e/frame.html", ours), SANDBOX);
  assert.equal(sandboxFor("/files/abc/report.html", ours), SANDBOX, "a relative address is ours");
  assert.equal(sandboxFor("http://localhost:4410/files/abc", ours), SANDBOX, "the server's origin is ours too");
  assert.ok(!SANDBOX.includes("allow-same-origin"));
});

test("pages from elsewhere keep their own origin", () => {
  assert.equal(sandboxFor("https://airformdata.com/", ours), `${SANDBOX} allow-same-origin`);
  // a machine's port on this computer is another origin (another port)
  assert.equal(sandboxFor("http://127.0.0.1:11502/", ours), `${SANDBOX} allow-same-origin`);
  assert.equal(sandboxFor("http://localhost:3001/", ours), `${SANDBOX} allow-same-origin`);
});

test("addresses with no real origin get the strict sandbox", () => {
  assert.equal(sandboxFor("data:text/html,<script>parent.x=1</script>", ours), SANDBOX);
  assert.equal(sandboxFor("about:blank", ours), SANDBOX);
});

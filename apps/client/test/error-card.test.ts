import { test } from "node:test";
import assert from "node:assert/strict";
import { errorCopyText, errorParts } from "../src/lib/errorParts";
import { startHelp } from "../src/server/model";

const LOG = [
  "The server stopped (exit code: 1):",
  "[app 1795394649] Foundation started its server",
  "(node:51948) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.",
  "(Use `node --trace-warnings ...` to show where the warning was created)",
  "Foundation's server can't listen on 127.0.0.1:4410 (EACCES): another program holds that port, or Windows has reserved it.",
].join("\n");

test("a log's tail becomes a code, the line that says why, and the rest behind Details", () => {
  const p = errorParts(LOG);
  assert.equal(p.code, "EACCES");
  assert.match(p.summary, /^Foundation's server can't listen on 127\.0\.0\.1:4410/);
  assert.equal(p.detail, LOG);
});

test("one line is its own summary, with no Details", () => {
  const p = errorParts("Give the checkout's full path, like C:\Dev\Foundation.");
  assert.deepEqual(p, { code: null, summary: "Give the checkout's full path, like C:\Dev\Foundation.", detail: null });
});

test("without a system code, the exit is the code and the log's last telling line the summary", () => {
  const p = errorParts("The server stopped (exit code: 3):\n(node:1) ExperimentalWarning: x\nError: no such table: boards");
  assert.equal(p.code, "exit 3");
  assert.equal(p.summary, "Error: no such table: boards");
});

test("Copy carries the whole error and the way out", () => {
  assert.equal(errorCopyText(" a\nb ", "do this", "cmd"), "a\nb\n\ndo this\n\ncmd");
  assert.equal(errorCopyText("a", null, null), "a");
});

test("a reserved port on Windows comes with the command that frees it", () => {
  const h = startHelp(LOG, true);
  assert.match(h!.help, /reserved a block of ports that includes 4410/);
  assert.match(h!.command!, /excludedportrange protocol=tcp startport=4410 numberofports=1/);
  assert.equal(startHelp(LOG, false), null, "elsewhere EACCES is something else");
  assert.equal(startHelp("x (EADDRINUSE)", true)!.command, null);
  assert.equal(startHelp("Node is too old", true), null);
});

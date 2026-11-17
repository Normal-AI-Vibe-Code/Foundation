/**
 * What the board says about counts and dead services reads the way a person
 * would say it: "1 person", not "1 people"; "nothing is running at
 * 127.0.0.1:3001", not "fetch failed".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-words-"));
const { plural } = await import("../src/words.ts");
const { offlineReason } = await import("../src/connectors.ts");

test("counts agree with their number", () => {
  assert.equal(plural(1, "person", "people"), "1 person");
  assert.equal(plural(3, "person", "people"), "3 people");
  assert.equal(plural(0, "board"), "0 boards");
  assert.equal(plural(1, "card"), "1 card");
});

const failed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

test("a service that didn't answer says why", () => {
  assert.equal(offlineReason(failed("ECONNREFUSED"), "http://127.0.0.1:3001"), "nothing is running at 127.0.0.1:3001");
  assert.match(offlineReason(failed("ENOTFOUND"), "https://airformdata.com"), /^airformdata\.com can't be found/);
  assert.equal(offlineReason(new Error("timed out"), "http://localhost:1420"), "nothing answered at localhost:1420 within a few seconds");
  assert.equal(offlineReason(failed("UND_ERR_CONNECT_TIMEOUT"), "http://x.test"), "it didn't answer at x.test (UND_ERR_CONNECT_TIMEOUT)");
  assert.equal(offlineReason(new Error("no BomForm key here")), "no BomForm key here", "a reason that's already words stays");
});

test("the real fetch's refusal comes out in words", async () => {
  // a port nothing listens on
  const e = await fetch("http://127.0.0.1:9/").catch((err) => err);
  assert.match(offlineReason(e, "http://127.0.0.1:9"), /nothing is running at 127\.0\.0\.1:9|didn't answer/);
});

/**
 * The example settings people copy to `.env` don't turn on anything that weakens sign-in: dev sign-in
 * (email alone, no password) stays commented out, with a line saying it is for your own computer only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const example = readFileSync(resolve(import.meta.dirname, "../../../.env.example"), "utf8");
const live = (name: string) => example.split(/\r?\n/).filter((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));

test(".env.example leaves dev sign-in off: no uncommented FOUNDATION_DEV_LOGIN=1", () => {
  assert.deepEqual(live("FOUNDATION_DEV_LOGIN").filter((l) => /=\s*1\b/.test(l)), [], "dev sign-in must stay commented out in the example");
  assert.match(example, /^#\s*FOUNDATION_DEV_LOGIN=1\s*$/m, "it is still there, commented, for someone who wants it on their own computer");
  assert.match(example, /own computer only/, "and it says who it is for");
});

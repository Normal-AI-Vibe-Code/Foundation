/**
 * Which server this is, in words (src/server/where.ts): the server panel's first line and ChatForm's note.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WHERE_LABEL, WHERE_NOTE, peopleNow, servesLine, upSince, whereIs } from "../src/server/where.ts";

test("this computer, another on the network, or hosted: from the address and the server's word", () => {
  assert.equal(whereIs("http://localhost:4410", null), "this-computer");
  assert.equal(whereIs("http://127.0.0.1:4410", { kind: "network" }), "this-computer");
  assert.equal(whereIs("http://192.168.1.20:4410", null), "network");
  assert.equal(whereIs("http://172.16.0.46:4410", null), "network");
  assert.equal(whereIs("http://10.0.0.5:4410", null), "network");
  assert.equal(whereIs("http://JOSH-PC.local:4410", null), "network");
  assert.equal(whereIs("http://josh-pc:4410", null), "network");
  assert.equal(whereIs("https://foundation.formindustries.com", null), "hosted");
  assert.equal(whereIs("https://foundation.formindustries.com", { kind: "network" }), "network");
  // 172.32 is not private
  assert.equal(whereIs("http://172.32.0.1:4410", null), "hosted");
  assert.equal(WHERE_LABEL.network, "Another computer on your network");
  assert.equal(WHERE_NOTE["this-computer"], "on this computer");
});

test("since when it's up, how many are here, what it serves", () => {
  const start = new Date(2026, 10, 20, 9, 14).getTime();
  assert.equal(upSince(start, start + 30_000), "since 09:14 · just now");
  assert.equal(upSince(start, start + 25 * 60_000), "since 09:14 · 25 min");
  assert.equal(upSince(start, start + 3 * 3600_000), "since 09:14 · 3 h");
  assert.match(upSince(start, start + 3 * 86400_000), /^since \S+ \d+ 09:14 · 3 days$/);
  assert.equal(peopleNow(0), "no one");
  assert.equal(peopleNow(1), "1 person");
  assert.equal(peopleNow(4), "4 people");
  assert.equal(servesLine(["grids", "files", "chat"]), "Grids, files and ChatForm.");
});

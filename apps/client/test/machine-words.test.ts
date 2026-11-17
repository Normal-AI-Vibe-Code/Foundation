/**
 * A machine card's words when a press can't work, and its ring's width
 * (2026-11-17). The owner's Add a desktop said "not found" in a toast: his
 * server had been started before desktops existed and answered its router's
 * 404 for the route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopRefusal, ringWidth } from "../src/panels/machineWords.ts";

test("a server from before desktops: the card says the server is older and how to bring it up to date", () => {
  // what http://localhost:4410 answered POST /api/boards/:id/machines/:panel/desktop with on 2026-11-16: 404 {"error":"not found"}
  const said = desktopRefusal({ status: 404, message: "not found" }, "localhost:4410");
  assert.match(said, /^The Foundation server at localhost:4410 is older than this app and can't add a desktop yet\./);
  assert.match(said, /Restart it/);
  assert.match(said, /Nothing was changed in the machine\.$/);
  assert.match(desktopRefusal({ status: 404, message: "not found" }, "localhost:4410", "let agents use a desktop"), /can't let agents use a desktop yet/);
});

test("the server's own refusals are passed on in its words", () => {
  // a 404 that is an answer, not a missing route
  assert.equal(desktopRefusal({ status: 404, message: "no such machine card on this board" }, "x"), "no such machine card on this board");
  assert.equal(desktopRefusal({ status: 409, message: "box isn't running. Start it first." }, "x"), "box isn't running. Start it first.");
  assert.equal(desktopRefusal({ status: 403, message: "View only: someone who can edit “b” adds a desktop" }, "x"), "View only: someone who can edit “b” adds a desktop");
  assert.equal(desktopRefusal(new Error("Can't reach the Foundation server (localhost:4410). It isn't running, or this device points at the wrong one."), "x"), "Can't reach the Foundation server (localhost:4410). It isn't running, or this device points at the wrong one.");
  assert.equal(desktopRefusal({}, "x"), "The server didn't say why.");
  assert.equal(desktopRefusal(undefined, "x"), "The server didn't say why.");
});

test("the ring is 2 px on the screen: its width in the card's pixels is 2 over the scale the card is drawn at", () => {
  assert.equal(ringWidth(1), 2);
  assert.equal(ringWidth(0.63), 3.17);
  assert.equal(ringWidth(1.22), 1.64);
  assert.equal(ringWidth(0.5), 4);
  // held between 1 and 8 of the card's pixels, and never nonsense
  assert.equal(ringWidth(0.1), 8);
  assert.equal(ringWidth(4), 1);
  assert.equal(ringWidth(0), 2);
  assert.equal(ringWidth(Number.NaN), 2);
  for (const s of [0.3, 0.45, 0.63, 0.87, 1, 1.22, 1.9]) assert.ok(Math.abs(ringWidth(s) * s - 2) < 0.02, `2 px at ${s}`);
});

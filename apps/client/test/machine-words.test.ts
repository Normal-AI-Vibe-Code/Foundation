/**
 * A machine card's words when a press can't work, and its ring's width
 * (2026-11-17). The owner's Add a desktop said "not found" in a toast: his
 * server had been started before desktops existed and answered its router's
 * 404 for the route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipKey, desktopRecipe, desktopRefusal, joinRows, olderServer, ringWidth } from "../src/panels/machineWords.ts";

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

test("only a router's own 404 is a server older than the app", () => {
  assert.equal(olderServer({ status: 404, message: "not found" }), true);
  assert.equal(olderServer({ status: 404, message: " Not Found " }), true);
  assert.equal(olderServer({ status: 404, message: "no such machine card on this board" }), false);
  assert.equal(olderServer({ status: 500, message: "not found" }), false);
  assert.equal(olderServer(undefined), false);
  // and the words name where Restart is now (the side menu's foot, 2026-11-17), not the old corner
  assert.match(desktopRefusal({ status: 404, message: "not found" }, "localhost:4410"), /side menu/);
});

test("which images Add a desktop has a recipe for (apt or apk), as the Start picker marks them", () => {
  for (const i of ["ubuntu:24.04", "debian:trixie", "alpine:3.22", "docker.io/library/ubuntu:22.04", "ubuntu", "alpine@sha256:abc"]) assert.equal(desktopRecipe(i), "yes", i);
  for (const i of ["fedora:42", "archlinux:latest", "rockylinux:9", "opensuse/tumbleweed:latest", "quay.io/centos/centos:stream9"]) assert.equal(desktopRecipe(i), "no", i);
  for (const i of ["postgres:17", "nginx:1.27", "ghcr.io/me/tool:1", ""]) assert.equal(desktopRecipe(i), "maybe", i);
});

test("a terminal's copy and paste keys: Ctrl+C copies only with a selection, so it is still the shell's interrupt", () => {
  const k = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, type = "keydown") => ({ type, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  // Windows and Linux
  assert.equal(clipKey(k("KeyC", { ctrlKey: true }), false, false), null, "Ctrl+C with nothing selected: the interrupt");
  assert.equal(clipKey(k("KeyC", { ctrlKey: true }), true, false), "copy");
  assert.equal(clipKey(k("KeyC", { ctrlKey: true, shiftKey: true }), false, false), "copy");
  assert.equal(clipKey(k("KeyV", { ctrlKey: true }), false, false), "paste");
  assert.equal(clipKey(k("KeyV", { ctrlKey: true, shiftKey: true }), false, false), "paste");
  assert.equal(clipKey(k("KeyC", { ctrlKey: true }, "keyup"), true, false), null);
  assert.equal(clipKey(k("KeyC", { ctrlKey: true, altKey: true }), true, false), null);
  assert.equal(clipKey(k("KeyL", { ctrlKey: true }), true, false), null, "Ctrl+L is the shell's");
  // a Mac: ⌘ copies and pastes, Ctrl+C is the interrupt
  assert.equal(clipKey(k("KeyC", { metaKey: true }), true, true), "copy");
  assert.equal(clipKey(k("KeyC", { ctrlKey: true }), true, true), null);
});

test("Copy all joins the rows a terminal wrapped and leaves off the empty ones at the end", () => {
  assert.equal(
    joinRows([
      { text: "root@box:~# echo a-very-long-li", wrapped: false },
      { text: "ne", wrapped: true },
      { text: "a-very-long-line", wrapped: false },
      { text: "root@box:~# ", wrapped: false },
      { text: "", wrapped: false },
      { text: "  ", wrapped: false },
    ]),
    "root@box:~# echo a-very-long-line\na-very-long-line\nroot@box:~# ",
  );
  assert.equal(joinRows([]), "");
});

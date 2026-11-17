/**
 * A page opened from a machine's port follows the machine: live while it runs
 * and publishes the port, honest when it doesn't (stopped, starting, error,
 * removed, the card gone), never showing what it last loaded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { MachineState } from "@foundation/protocol";
import { MACHINE_STATE_WORD, machinePage } from "../src/panels/machinePage";

const from = { panel: "pnl_box", port: 80, name: "web-box" };
const card = (m: Partial<MachineState>) => ({ panel: "machine" as const, machine: { name: "web-box", state: "running", containerId: "c1", ports: [{ port: 80, host: 49731 }], ...m } as MachineState });

test("running and publishing the port: the live frame, at the host port the engine gave it", () => {
  assert.deepEqual(machinePage(from, card({}), false), { kind: "live", url: "http://127.0.0.1:49731" });
  // started again on a new host port: the page follows it
  assert.deepEqual(machinePage(from, card({ ports: [{ port: 80, host: 50112 }] }), true), { kind: "live", url: "http://127.0.0.1:50112" });
});

test("stopped: says so in the card's words, and only a person is offered Start", () => {
  const p = machinePage(from, card({ state: "stopped", ports: undefined, detail: "Stopped by Ada. Its disk is kept: Start runs it again." }), false);
  assert.equal(p.kind, "stopped");
  if (p.kind === "live") return;
  assert.equal(p.title, "Machine stopped — web-box isn't running");
  assert.equal(p.word, MACHINE_STATE_WORD.stopped);
  assert.equal(p.word, "Stopped");
  assert.equal(p.tone, "idle");
  assert.equal(p.reason, "Stopped by Ada. Its disk is kept: Start runs it again.");
  assert.equal(p.canStart, true);
  assert.equal(p.canShow, true);
  const v = machinePage(from, card({ state: "stopped", ports: undefined }), true);
  assert.equal(v.kind !== "live" && v.canStart, false, "a viewer isn't offered Start");
  assert.equal(v.kind !== "live" && v.canShow, true);
});

test("starting and pulling: amber, breathing, no Start; the page waits for it", () => {
  for (const state of ["starting", "pulling"] as const) {
    const p = machinePage(from, card({ state, ports: undefined }), false);
    assert.equal(p.kind, "starting");
    if (p.kind === "live") continue;
    assert.equal(p.tone, "warn");
    assert.equal(p.breathing, true);
    assert.equal(p.canStart, false);
    assert.equal(p.word, state === "starting" ? "Starting" : "Pulling");
  }
});

test("error: red, in the engine's words; a person may Start a machine that has a disk", () => {
  const p = machinePage(from, card({ state: "error", detail: "port is already allocated" }), false);
  assert.equal(p.kind, "error");
  if (p.kind === "live") return;
  assert.equal(p.tone, "bad");
  assert.equal(p.reason, "port is already allocated");
  assert.equal(p.canStart, true);
  const fresh = machinePage(from, card({ state: "error", containerId: undefined }), false);
  assert.equal(fresh.kind !== "live" && fresh.canStart, false);
});

test("removed (the card stays, the machine doesn't): it's gone, no Start from the page", () => {
  const p = machinePage(from, card({ state: "absent", containerId: undefined, ports: undefined, detail: "Removed by Ada, with its disk. Start makes a fresh one." }), false);
  assert.equal(p.kind, "removed");
  if (p.kind === "live") return;
  assert.equal(p.title, "Machine gone — web-box was removed");
  assert.equal(p.word, "Not started");
  assert.equal(p.canStart, false);
  assert.equal(p.canShow, true);
});

test("the machine card itself is gone from the board: says so by the name it had", () => {
  for (const c of [undefined, { panel: "link" as const }, { panel: "machine" as const }]) {
    const p = machinePage(from, c, false);
    assert.equal(p.kind, "gone");
    if (p.kind === "live") continue;
    assert.equal(p.title, "Machine gone — web-box isn't on the board any more");
    assert.equal(p.canStart, false);
    assert.equal(p.canShow, false);
  }
});

test("running without that port published: not the old page either", () => {
  const p = machinePage(from, card({ ports: [{ port: 8080, host: 49999 }] }), false);
  assert.equal(p.kind, "unpublished");
  if (p.kind === "live") return;
  assert.equal(p.word, "Running");
  assert.equal(p.canStart, false);
});

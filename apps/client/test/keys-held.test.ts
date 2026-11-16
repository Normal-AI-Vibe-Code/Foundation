/**
 * Leaving a machine by keyboard (lib/keysHeld.ts): Esc twice in half a second.
 * A single Esc is the machine's (vi needs it), and so is a slow second one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAVE_MS, escEscToLeave } from "../src/lib/keysHeld";

test("Esc twice leaves; once, slowly, or with a key between, it doesn't", () => {
  let t = 0;
  let left = 0;
  const key = escEscToLeave(() => left++, () => t);
  const press = (k: string, at: number, repeat = false) => {
    t = at;
    return key({ key: k, repeat });
  };
  assert.equal(press("Escape", 1000), false);
  assert.equal(left, 0, "one Esc is the machine's");
  assert.equal(press("Escape", 1000 + LEAVE_MS), true);
  assert.equal(left, 1);
  // it starts over: the next Esc is a first one
  assert.equal(press("Escape", 2000), false);
  assert.equal(press("Escape", 2000 + LEAVE_MS + 1), false, "too slow: a first Esc again");
  assert.equal(press("Escape", 2000 + LEAVE_MS + 200), true);
  assert.equal(left, 2);
  // a key between two Escs (vi: Esc, :, w, q, Esc) isn't a leave
  press("Escape", 5000);
  press(":", 5050);
  assert.equal(press("Escape", 5100), false);
  // holding Esc down repeats; a repeat is not a second press
  press("x", 6000);
  press("Escape", 6100);
  assert.equal(press("Escape", 6150, true), false);
  assert.equal(left, 2);
});

/**
 * ⌘/Ctrl-wheel through a card (lib/cardScroll.ts): the nearest pane with room
 * scrolls, then the ones around it; at the end the wheel is held while the
 * turning goes on, and zooms the grid again after a beat; a card with nothing
 * to scroll never takes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAT, hasRoom, overflows, wheelPixels, wheelVerdict, type Pane } from "../src/lib/cardScroll";

const pane = (top: number, height = 1000, view = 300): Pane => ({ scrollTop: top, scrollHeight: height, clientHeight: view, scrollLeft: 0, scrollWidth: 400, clientWidth: 400 });

test("a pane has room until its end, either way, with a pixel of slack for fractional sizes", () => {
  assert.equal(hasRoom(pane(0), 0, 100), true);
  assert.equal(hasRoom(pane(0), 0, -100), false, "at the top, up has nowhere to go");
  assert.equal(hasRoom(pane(700), 0, 100), false, "at the bottom, down has nowhere to go");
  assert.equal(hasRoom(pane(699.4), 0, 100), false, "a fraction short of the bottom is the bottom");
  assert.equal(hasRoom(pane(700), 0, -100), true);
  const wide: Pane = { ...pane(0, 300, 300), scrollWidth: 900, clientWidth: 400 };
  assert.equal(hasRoom(wide, 100, 0), true);
  assert.equal(hasRoom(wide, 0, 100), false);
  assert.equal(overflows(wide), true);
  assert.equal(overflows(pane(0, 300.6, 300)), false, "a rounding pixel isn't something to scroll");
});

test("over a card with nothing to scroll, or the paper, the wheel zooms the grid", () => {
  assert.deepEqual(wheelVerdict([], 0, 100, Infinity), { do: "zoom" });
  assert.deepEqual(wheelVerdict([], 0, 100, 0), { do: "zoom" });
});

test("the nearest pane with room scrolls; at its end the one around it does", () => {
  assert.deepEqual(wheelVerdict([pane(100), pane(0)], 0, 100, Infinity), { do: "scroll", pane: 0 });
  assert.deepEqual(wheelVerdict([pane(700), pane(0)], 0, 100, Infinity), { do: "scroll", pane: 1 });
  assert.deepEqual(wheelVerdict([pane(700), pane(0)], 0, -100, Infinity), { do: "scroll", pane: 0 });
});

test("at the end the wheel is held while the turning goes on, and zooms after a beat of quiet", () => {
  const end = [pane(700)];
  assert.deepEqual(wheelVerdict(end, 0, 100, 16), { do: "hold" }, "the turn that reached the end doesn't lurch into a zoom");
  assert.deepEqual(wheelVerdict(end, 0, 100, BEAT - 1), { do: "hold" });
  assert.deepEqual(wheelVerdict(end, 0, 100, BEAT), { do: "zoom" });
  assert.deepEqual(wheelVerdict(end, 0, 100, Infinity), { do: "zoom" }, "a card found already at its end zooms at once");
  // the other way there is room again, whenever
  assert.deepEqual(wheelVerdict(end, 0, -100, Infinity), { do: "scroll", pane: 0 });
});

test("wheel deltas: lines and pages become pixels, and ⇧ turns the wheel sideways", () => {
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false }), { dx: 0, dy: 100 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }), { dx: 0, dy: 48 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false }, 420), { dx: 0, dy: 420 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true }), { dx: 100, dy: 0 });
  assert.deepEqual(wheelPixels({ deltaX: 40, deltaY: 0, deltaMode: 0, shiftKey: true }), { dx: 40, dy: 0 }, "a wheel that's already sideways stays so");
});

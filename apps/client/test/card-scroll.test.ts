/**
 * Alt-wheel through a card (lib/cardScroll.ts): the nearest pane with room
 * scrolls, then the ones around it; at the end the wheel is held (Alt means
 * the card); a card with nothing to scroll never takes it. And the mark that
 * says so (lib/scrollHint.ts): what it remembers, and when it stops.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRoom, overflows, wheelPixels, wheelVerdict, type Pane } from "../src/lib/cardScroll";
import { LEARNED, ONE_SCROLL, afterScroll, altKey, dismissed, hintLabel, hintMarkup, hintWanted, readHint } from "../src/lib/scrollHint";

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

test("over a card with nothing to scroll, or the paper, Alt changes nothing: the wheel is the grid's", () => {
  assert.deepEqual(wheelVerdict([], 0, 100), { do: "pass" });
  assert.deepEqual(wheelVerdict([], 100, 0), { do: "pass" });
});

test("the nearest pane with room scrolls; at its end the one around it does", () => {
  assert.deepEqual(wheelVerdict([pane(100), pane(0)], 0, 100), { do: "scroll", pane: 0 });
  assert.deepEqual(wheelVerdict([pane(700), pane(0)], 0, 100), { do: "scroll", pane: 1 });
  assert.deepEqual(wheelVerdict([pane(700), pane(0)], 0, -100), { do: "scroll", pane: 0 });
});

test("at the end of a card the wheel is held: it never turns into a pan or a zoom of the grid", () => {
  const end = [pane(700)];
  assert.deepEqual(wheelVerdict(end, 0, 100), { do: "hold" });
  assert.deepEqual(wheelVerdict([pane(700), pane(700)], 0, 100), { do: "hold" });
  // the other way there is room again
  assert.deepEqual(wheelVerdict(end, 0, -100), { do: "scroll", pane: 0 });
  // sideways in a pane that only goes down: held too, the card has the wheel
  assert.deepEqual(wheelVerdict([pane(100)], 100, 0), { do: "hold" });
});

test("wheel deltas: lines and pages become pixels, and ⇧ turns the wheel sideways", () => {
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false }), { dx: 0, dy: 100 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }), { dx: 0, dy: 48 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false }, 420), { dx: 0, dy: 420 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true }), { dx: 100, dy: 0 });
  assert.deepEqual(wheelPixels({ deltaX: 40, deltaY: 0, deltaMode: 0, shiftKey: true }), { dx: 40, dy: 0 }, "a wheel that's already sideways stays so");
});

// ---------- the hint ----------

test("the hint is wanted until it's dismissed, or the person has Alt-scrolled three times", () => {
  assert.equal(LEARNED, 3);
  assert.equal(hintWanted(readHint(null)), true, "a new device sees it");
  assert.equal(hintWanted({ off: false, used: 2 }), true);
  assert.equal(hintWanted({ off: false, used: 3 }), false, "learned: it stops by itself");
  assert.equal(hintWanted(dismissed(readHint(null))), false, "dismissed: never again");
  assert.equal(hintWanted({ off: true, used: 0 }), false);
});

test("what's remembered survives the round trip, and rubbish reads as a new device", () => {
  assert.deepEqual(readHint(JSON.stringify({ off: true, used: 2 })), { off: true, used: 2 });
  assert.deepEqual(readHint(JSON.stringify(dismissed({ off: false, used: 1 }))), { off: true, used: 1 });
  assert.deepEqual(readHint("{"), { off: false, used: 0 });
  assert.deepEqual(readHint('{"off":"yes","used":"4"}'), { off: false, used: 0 });
  assert.deepEqual(readHint('{"used":-2}'), { off: false, used: 0 });
  assert.deepEqual(readHint(""), { off: false, used: 0 });
});

test("a turn of the wheel is one scroll, however many wheel events it is; three scrolls and it's learned", () => {
  let m = readHint(null);
  let last = -Infinity;
  const at = (t: number) => {
    m = afterScroll(m, t, last);
    last = t;
  };
  at(1000);
  assert.equal(m.used, 1);
  for (let t = 1016; t < 1400; t += 16) at(t); // the same turn going on
  assert.equal(m.used, 1);
  at(last + ONE_SCROLL - 1);
  assert.equal(m.used, 1, "still the same scroll");
  at(last + ONE_SCROLL);
  assert.equal(m.used, 2);
  at(last + 5000);
  assert.equal(m.used, 3);
  assert.equal(hintWanted(m), false);
  const same = afterScroll(m, last + 9000, last);
  assert.equal(same, m, "nothing more to count once it's learned");
  assert.equal(afterScroll({ off: true, used: 0 }, 5000, 0).off, true, "counting never brings a dismissed hint back");
});

test("the mark says the key as this machine writes it, has a way to put it away, and names itself with data-tip", () => {
  assert.equal(altKey(false), "Alt");
  assert.equal(altKey(true), "⌥");
  assert.equal(hintLabel(false), "Alt + scroll to scroll through this card");
  assert.equal(hintLabel(true), "Option + scroll to scroll through this card");
  const html = hintMarkup(false);
  assert.match(html, /class="scroll-hint-key">Alt</);
  assert.match(html, /class="scroll-hint-x"[^>]*data-tip="Got it"/);
  assert.doesNotMatch(html, /title=/, "roll-over labels are the app's own tip, never a title");
});

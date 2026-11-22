/**
 * ChatForm in the side menu and agents on a baseline (2026-11-20; src/chat/sideMenuLogic.ts):
 *  - pins: kept in the person's order, moved, let go of, never more than 100, and only those they can see;
 *  - where a row pulled over the kept rows lands;
 *  - which form an agent takes at a size (a figure from 20 px, the ✦ below), and how its still is framed
 *    so the window's foot cuts it chest up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIGURE_MIN, MAX_PINS, dropIndex, figureForm, figureFrame, pinAdd, pinMove, pinRemove, reconcilePins } from "../src/chat/sideMenuLogic.ts";

test("pinAdd keeps a conversation at the end, or where it's dropped; again, it moves there", () => {
  assert.deepEqual(pinAdd([], "a"), ["a"]);
  assert.deepEqual(pinAdd(["a", "b"], "c"), ["a", "b", "c"]);
  assert.deepEqual(pinAdd(["a", "b"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(pinAdd(["a", "b"], "c", 1), ["a", "c", "b"]);
  assert.deepEqual(pinAdd(["a", "b"], "c", 99), ["a", "b", "c"]);
  assert.deepEqual(pinAdd(["a", "b"], "c", -3), ["c", "a", "b"]);
  // already kept: moved, never twice
  assert.deepEqual(pinAdd(["a", "b", "c"], "a"), ["b", "c", "a"]);
  assert.deepEqual(pinAdd(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  // at most MAX_PINS
  const full = Array.from({ length: MAX_PINS }, (_, i) => `c${i}`);
  assert.equal(pinAdd(full, "new").length, MAX_PINS);
  assert.equal(pinAdd(full, "new", 0)[0], "new");
});

test("pinRemove lets one go and leaves the rest in order", () => {
  assert.deepEqual(pinRemove(["a", "b", "c"], "b"), ["a", "c"]);
  assert.deepEqual(pinRemove(["a"], "z"), ["a"]);
});

test("pinMove lands a row before the row that was at that place as drawn", () => {
  const l = ["a", "b", "c", "d"];
  assert.deepEqual(pinMove(l, "a", 2), ["b", "a", "c", "d"]); // before c
  assert.deepEqual(pinMove(l, "a", 4), ["b", "c", "d", "a"]); // the end
  assert.deepEqual(pinMove(l, "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(pinMove(l, "c", 1), ["a", "c", "b", "d"]);
  // onto itself, or just after itself: nothing moves
  assert.deepEqual(pinMove(l, "b", 1), l);
  assert.deepEqual(pinMove(l, "b", 2), l);
  // not kept: nothing
  assert.deepEqual(pinMove(l, "z", 0), l);
});

test("reconcilePins keeps only the conversations this person can see, in the pins' order, once each", () => {
  const sees = new Set(["general", "design", "dm-kai"]);
  assert.deepEqual(reconcilePins(["design", "gone", "general", "design", "dm-kai"], sees), ["design", "general", "dm-kai"]);
  assert.deepEqual(reconcilePins(["a", 3, null, "b"] as unknown[], () => true), ["a", "b"]);
  assert.deepEqual(reconcilePins([], sees), []);
  assert.deepEqual(reconcilePins(["x"], (id) => id !== "x"), []);
});

test("dropIndex: above a row's middle lands before it, below the last lands at the end", () => {
  const rows = [0, 34, 68].map((top) => ({ top, height: 34 }));
  assert.equal(dropIndex(-10, rows), 0);
  assert.equal(dropIndex(10, rows), 0);
  assert.equal(dropIndex(20, rows), 1);
  assert.equal(dropIndex(60, rows), 2);
  assert.equal(dropIndex(90, rows), 3);
  assert.equal(dropIndex(500, rows), 3);
  assert.equal(dropIndex(5, []), 0);
});

test("figureForm: a figure from 20 px up (timeline 36, Agents list 28, mentions 20), the ✦ on its tint below (switcher 18, a row's mark)", () => {
  assert.equal(FIGURE_MIN, 20);
  for (const s of [20, 24, 28, 32, 36, 88]) assert.equal(figureForm(s), "figure", `${s}`);
  for (const s of [10, 14, 18, 19]) assert.equal(figureForm(s), "spark", `${s}`);
});

test("figureFrame: the still is taller than its window, centred, raised so the head is near the top and the foot cuts at the chest", () => {
  const box = { w: 36, h: 36 };
  const p = figureFrame("portrait", box);
  // a 3:4 portrait shown from 9 % to 66 % of its height
  assert.ok(p.h > box.h * 1.6 && p.h < box.h * 1.9, `height ${p.h}`);
  assert.ok(Math.abs(p.w - p.h * 0.75) < 0.2);
  assert.ok(Math.abs(p.left - (box.w - p.w) / 2) < 0.1, "centred");
  assert.ok(p.top < 0 && p.top > -box.h * 0.25, `top ${p.top}`);
  // what shows ends inside the picture: the foot cuts it (nothing of the picture's own bottom edge shows)
  assert.ok(p.top + p.h > box.h + 5);
  // a picture's own shape wins over the role's guess
  const wide = figureFrame("portrait", box, 1);
  assert.ok(Math.abs(wide.w - wide.h) < 0.2);
  // a thumb (the model standing, square) and a front (head to toe) frame tighter on the top of the figure
  const t = figureFrame("thumb", box);
  const f = figureFrame("front", box);
  assert.ok(f.h > t.h && t.h > p.h * 0.9, `${f.h} ${t.h} ${p.h}`);
  // an unknown role reads as a portrait; a nonsense aspect is ignored
  assert.deepEqual(figureFrame("mavatar", box), p);
  assert.deepEqual(figureFrame("portrait", box, NaN), p);
  // it scales with the window
  const big = figureFrame("portrait", { w: 80, h: 88 });
  assert.ok(Math.abs(big.h / p.h - 88 / 36) < 0.01);
});

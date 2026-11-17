/**
 * #53: a terminal drawn at 50 % gets the pointer's place in its own pixels,
 * so a selection starts under the pointer, not twice as far from the corner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unscaledPoint } from "../src/panels/scaledMouse";

test("the pointer's place in the widget's own pixels", () => {
  const rect = { left: 100, top: 50 };
  // drawn at 50 %: 30 px on screen from the corner is 60 of its own
  assert.deepEqual(unscaledPoint(130, 80, rect, 0.5), { x: 160, y: 110 });
  // drawn at 200 %: halved
  assert.deepEqual(unscaledPoint(140, 90, rect, 2), { x: 120, y: 70 });
  // at 100 % nothing moves; the corner stays the corner at any scale
  assert.deepEqual(unscaledPoint(130, 80, rect, 1), { x: 130, y: 80 });
  assert.deepEqual(unscaledPoint(100, 50, rect, 0.37), { x: 100, y: 50 });
});

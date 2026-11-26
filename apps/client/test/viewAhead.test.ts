/**
 * Loading for where the camera is going (2026-11-25): the rect a picture must touch to start loading is the view now
 * joined to the view the camera's springs are heading for. Pure: no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aheadRect, intersects } from "../src/lib/viewAhead";

const view = { left: 0, top: 0, width: 1000, height: 800 };

test("at rest, ahead is the view with half a view around it", () => {
  const cam = { x: 0, y: 0, scale: 1 };
  const r = aheadRect(view, cam, cam);
  assert.deepEqual(r, { left: -500, top: -400, right: 1500, bottom: 1200 });
});

test("a zoom out reaches as far as the view it will land on, from its first frame", () => {
  const now = { x: 0, y: 0, scale: 1 };
  // zooming out 4× about the middle of the screen: the goal shows world [-1500, 2500] × [-1200, 2000]
  const goal = { x: 375, y: 300, scale: 0.25 };
  const r = aheadRect(view, now, goal, 0);
  assert.deepEqual(r, { left: -1500, top: -1200, right: 2500, bottom: 2000 });
  // a card two screens to the right is outside the old 100 % margin's reach but ahead now
  const card = { left: 2200, top: 300, right: 2400, bottom: 500 };
  assert.equal(intersects(r, card), true);
  assert.equal(intersects(aheadRect(view, now, now, 0), card), false);
});

test("a zoom in keeps the view it has (the goal is inside it)", () => {
  const now = { x: 0, y: 0, scale: 1 };
  const goal = { x: -1000, y: -800, scale: 3 };
  assert.deepEqual(aheadRect(view, now, goal, 0), { left: 0, top: 0, right: 1000, bottom: 800 });
});

test("a glide reaches where it lands", () => {
  const now = { x: 0, y: 0, scale: 1 };
  const goal = { x: -3000, y: 0, scale: 1 };
  const r = aheadRect(view, now, goal, 0);
  assert.equal(r.left, 0);
  assert.equal(r.right, 4000);
});

import { placeWords } from "../src/chat/logic";

test("a card dropped on a chat server of its own is sent as words that say where it is", () => {
  assert.equal(placeWords({ label: "Q4 plan", boardName: "Company" }), "🔗 Q4 plan · Company");
  assert.equal(placeWords({ label: "Q4 plan" }), "🔗 Q4 plan");
});

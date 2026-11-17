import { test } from "node:test";
import assert from "node:assert/strict";
import type { SearchHit } from "@foundation/protocol";
import { presets } from "../src/physics/spring.ts";
import { MAX_LEAN, PAPER, PICTURE_W, deal, fan, grabPoint, leanToward, pictureSize, trail } from "../src/lib/pickupMath.ts";
import { CLIP_MAX, parseClips, withClip } from "../src/state/clipboard.ts";

const hit = (id: string): SearchHit => ({ source: "file", id, title: id, snippet: "", score: 1 });

test("a held card leans into its motion, a little, and comes upright when the hand stops", () => {
  let lean = 0;
  for (let i = 0; i < 60; i++) lean = leanToward(lean, 5); // a fast sweep to the right
  assert.ok(lean > 2 && lean <= MAX_LEAN, `leans right, never past ${MAX_LEAN}°: ${lean}`);
  for (let i = 0; i < 60; i++) lean = leanToward(lean, -5);
  assert.ok(lean < -2 && lean >= -MAX_LEAN);
  for (let i = 0; i < 60; i++) lean = leanToward(lean, 0);
  assert.ok(Math.abs(lean) < 0.01, "upright at rest");
});

test("a stack is fanned under its top card, and the cards under it follow on looser springs", () => {
  assert.deepEqual(fan(0), { rotate: 0, dx: 0, dy: 0 });
  // the two under it turn opposite ways, each a little further down
  assert.ok(fan(1).rotate < 0 && fan(2).rotate > 0);
  assert.ok(fan(2).dy > fan(1).dy && fan(1).dy > 0);
  assert.ok(Math.abs(fan(2).rotate) <= 6, "a few degrees, not a spread hand");
  assert.equal(trail(presets.drag, 0), presets.drag);
  assert.ok(trail(presets.drag, 1).stiffness < presets.drag.stiffness);
  assert.ok(trail(presets.drag, 2).stiffness < trail(presets.drag, 1).stiffness);
  // looser, but never underdamped into a wobble: damping ratio c / (2·√k) stays near 1
  for (const i of [0, 1, 2]) {
    const s = trail(presets.drag, i);
    const ratio = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
    assert.ok(ratio > 0.7 && ratio < 1.2, `card ${i} settles without wobble: ${ratio.toFixed(2)}`);
  }
});

test("dealt cards land a step apart and never on top of one another", () => {
  const at = Array.from({ length: 14 }, (_, i) => deal(i));
  assert.deepEqual(at[0], { dx: 0, dy: 0 });
  assert.deepEqual(at[1], { dx: 28, dy: 28 });
  // the seventh starts a new run beside the first
  assert.equal(at[6].dy, 0);
  assert.ok(at[6].dx > 200);
  assert.equal(new Set(at.map((p) => `${p.dx},${p.dy}`)).size, at.length);
});

test("a picture keeps its shape in the hand, within a sane card; the hand stays where it pressed", () => {
  assert.deepEqual(pictureSize(1600, 1200), { w: PICTURE_W, h: 132 });
  assert.equal(pictureSize(4000, 400).h, PICTURE_W * 0.5, "a banner is held to half its width");
  assert.equal(pictureSize(400, 4000).h, Math.round(PICTURE_W * 1.4), "a tall strip is held too");
  assert.equal(pictureSize(0, 0).h, 132, "an unread picture is 4:3");
  // pressed three quarters along a 300 px row: three quarters along the slip of paper
  const g = grabPoint({ x: 325, y: 122 }, { left: 100, top: 100, width: 300, height: 44 }, PAPER);
  assert.deepEqual(g, { x: Math.round(0.75 * PAPER.w), y: Math.round(0.5 * PAPER.h) });
  // pressed at the very corner: still inside the card
  const c = grabPoint({ x: 100, y: 100 }, { left: 100, top: 100, width: 300, height: 44 }, PAPER);
  assert.ok(c.x > 0 && c.y > 0);
});

test("the clipboard keeps each thing once, newest first, and reads back only what it wrote", () => {
  let list: SearchHit[] = [];
  list = withClip(list, hit("a"));
  list = withClip(list, hit("b"));
  list = withClip(list, hit("a"));
  assert.deepEqual(list.map((h) => h.id), ["a", "b"]);
  for (let i = 0; i < 40; i++) list = withClip(list, hit(`n${i}`));
  assert.equal(list.length, CLIP_MAX);
  assert.equal(list[0].id, "n39");
  assert.deepEqual(parseClips(JSON.stringify([hit("a"), { nope: true }, null, hit("b")])).map((h) => h.id), ["a", "b"]);
  assert.deepEqual(parseClips("{not json"), []);
  assert.deepEqual(parseClips(JSON.stringify({ id: "a" })), []);
  assert.deepEqual(parseClips(null), []);
});

/**
 * The wheel zooms, a trackpad pans (2026-11-17): what kind each wheel event is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GAP_MS, wheelKind, wheelMemory, type WheelLike } from "../src/lib/wheelKind.ts";

const ev = (over: Partial<WheelLike>): WheelLike => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, timeStamp: 0, ...over });

test("a mouse wheel zooms: Chromium's 100 or 120 a notch, Firefox's lines", () => {
  const m = wheelMemory();
  assert.equal(wheelKind(ev({ deltaY: 100, timeStamp: 0 }), m), "zoom-mouse");
  assert.equal(wheelKind(ev({ deltaY: -120, timeStamp: 1000 }), m), "zoom-mouse");
  assert.equal(wheelKind(ev({ deltaY: 150, timeStamp: 2000 }), m), "zoom-mouse", "a 150 % display");
  assert.equal(wheelKind(ev({ deltaY: 3, deltaMode: 1, timeStamp: 3000 }), m), "zoom-mouse", "lines");
});

test("a trackpad's two-finger scroll pans, and the whole gesture stays a pan", () => {
  const m = wheelMemory();
  assert.equal(wheelKind(ev({ deltaY: 4.5, timeStamp: 0 }), m), "pan");
  assert.equal(wheelKind(ev({ deltaX: 2, deltaY: 30, timeStamp: 16 }), m), "pan");
  // a fast flick in the same gesture has big integer steps: still the trackpad's
  assert.equal(wheelKind(ev({ deltaY: 120, timeStamp: 32 }), m), "pan");
  // the wheel rests, then a mouse notch: a zoom again
  assert.equal(wheelKind(ev({ deltaY: 100, timeStamp: 32 + GAP_MS + 1 }), m), "zoom-mouse");
});

test("sideways or fractional steps are a trackpad's; Shift+wheel pans", () => {
  const m = wheelMemory();
  assert.equal(wheelKind(ev({ deltaX: 60, timeStamp: 0 }), m), "pan", "a tilt wheel goes sideways");
  assert.equal(wheelKind(ev({ deltaX: 12.5, timeStamp: 1000 }), m), "pan");
  assert.equal(wheelKind(ev({ deltaY: 100, shiftKey: true, timeStamp: 2000 }), m), "pan");
});

test("Ctrl+wheel zooms: a pinch follows the fingers, a mouse steps", () => {
  const m = wheelMemory();
  assert.equal(wheelKind(ev({ deltaY: 6, ctrlKey: true, timeStamp: 0 }), m), "zoom-pinch");
  assert.equal(wheelKind(ev({ deltaY: 100, ctrlKey: true, timeStamp: 1000 }), m), "zoom-mouse");
  assert.equal(wheelKind(ev({ deltaY: 100, metaKey: true, timeStamp: 2000 }), m), "zoom-mouse");
});

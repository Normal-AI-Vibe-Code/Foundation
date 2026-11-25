/**
 * The Character grid's rest and arrival (2026-11-25): what's kept and under which key, when a card plays, the order
 * pictures arrive in, and the cut that makes a still. Pure logic: no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARRIVAL_STEPS, arrivalOrder, arrivalStep, arrivalStyle } from "../src/lib/arrival";
import { derivedImageSrc, isDerivedImageSrc, isServerImagePath, loadDerivedImage, peekExactImage, withVersion, withWidthParam } from "../src/lib/imageCache";
import { CUTOUT_SIZE, cutGround, cutoutSize } from "../src/characters/cutoutCore";
import { LARGE_SCALE, modelStillParts, restPicture, wantsStage } from "../src/characters/stagePolicy";

// ---------- cache keys ----------

test("a picture's address names its version, so a file drawn again is never the kept one", () => {
  const path = "/api/characters/chr_1/files/front";
  assert.equal(withVersion(path, "file_a"), `${path}?v=file_a`);
  assert.notEqual(withVersion(path, "file_a"), withVersion(path, "file_b"));
  // no version, nothing added; said twice, added once; a local picture is left alone
  assert.equal(withVersion(path, undefined), path);
  assert.equal(withVersion(withVersion(path, "file_a"), "file_a"), `${path}?v=file_a`);
  assert.equal(withVersion("blob:http://x/1", "file_a"), "blob:http://x/1");
  // it is still the server's picture, and its width rides beside the version
  assert.equal(isServerImagePath(withVersion(path, "file_a")), true);
  assert.equal(withWidthParam(withVersion(path, "file_a"), 512), `${path}?v=file_a&w=512`);
});

test("a made picture's key holds everything it depends on: the file, the framing, the size", () => {
  const key = (file: string, framing: "bust" | "full", size?: number) => derivedImageSrc("model-still", modelStillParts("chr_1", file, framing, size));
  assert.equal(key("file_a", "full"), "derived:model-still/chr_1/file_a/full/640");
  assert.equal(isDerivedImageSrc(key("file_a", "full")), true);
  assert.equal(isServerImagePath(key("file_a", "full")), false, "nothing ever fetches it");
  const keys = new Set([key("file_a", "full"), key("file_b", "full"), key("file_a", "bust"), key("file_a", "full", 320)]);
  assert.equal(keys.size, 4, "a new model, another framing or another size is another picture");
  // parts can't run into each other
  assert.notEqual(derivedImageSrc("cutout", ["a/b", "c"]), derivedImageSrc("cutout", ["a", "b/c"]));
});

test("a made picture is made once, however many ask, and is in memory afterwards; one that can't be made is not kept", async () => {
  const src = derivedImageSrc("test", ["once", Date.now()]);
  let made = 0;
  const make = async () => {
    made++;
    await new Promise((r) => setTimeout(r, 5));
    return { blob: new Blob(["png"], { type: "image/png" }), width: 640, natural: [640, 640] as [number, number], alpha: true };
  };
  const [a, b] = await Promise.all([loadDerivedImage(src, make), loadDerivedImage(src, make)]);
  assert.equal(made, 1);
  assert.ok(a && b && a.url === b.url);
  assert.equal(peekExactImage(src, "orig")?.url, a.url, "there on the next frame, with no promise");
  await loadDerivedImage(src, make);
  assert.equal(made, 1, "and never made again while it's kept");

  const none = derivedImageSrc("test", ["none", Date.now()]);
  assert.equal(await loadDerivedImage(none, async () => null), null);
  assert.equal(peekExactImage(none, "orig"), null);
  let again = 0;
  await loadDerivedImage(none, async () => (again++, null));
  assert.equal(again, 1, "it's asked again next time");
  // a maker that throws is a picture that couldn't be made, not an error for the card
  assert.equal(await loadDerivedImage(derivedImageSrc("test", ["throws", Date.now()]), () => Promise.reject(new Error("no WebGL"))), null);
});

// ---------- still or live ----------

test("a card plays when it is in use or drawn large, and only when there is something to play, on screen", () => {
  const rest = { ready: true, onScreen: true, large: false, inUse: false };
  assert.equal(wantsStage(rest), false, "on screen at an ordinary size, nobody on it: its picture");
  assert.equal(wantsStage({ ...rest, inUse: true }), true, "the pointer is on it");
  assert.equal(wantsStage({ ...rest, large: true }), true, "it is what the screen is showing");
  assert.equal(wantsStage({ ...rest, large: true, inUse: true, onScreen: false }), false, "off screen, or drawn too small to be worth it");
  assert.equal(wantsStage({ ...rest, large: true, inUse: true, ready: false }), false, "nothing to play yet");
  assert.ok(LARGE_SCALE > 0.3 && LARGE_SCALE <= 1);
});

test("at rest a 3D character shows its model, drawn once under its clips file; a mesh avatar the portrait it is cut from", () => {
  assert.deepEqual(restPicture({ form: "model", framing: "full", files: { front: "f1", thumb: "f2", clips: "f9" } }), { kind: "render", file: "f9" });
  // not animated yet: the sheet, as before
  assert.deepEqual(restPicture({ form: "model", framing: "full", files: { front: "f1", thumb: "f2" } }), { kind: "picture", role: "front" });
  assert.deepEqual(restPicture({ form: "mesh", framing: "bust", files: { front: "f1", thumb: "f2", portrait: "f3", mavatar: "f4" } }), { kind: "picture", role: "portrait" });
  assert.deepEqual(restPicture({ form: "mesh", framing: "full", files: { front: "f1", portrait: "f3" } }), { kind: "picture", role: "front" });
  // never a role it doesn't have
  assert.deepEqual(restPicture({ form: "mesh", framing: "bust", files: { thumb: "f2" } }), { kind: "picture", role: "thumb" });
  assert.deepEqual(restPicture({ form: "model", framing: "bust", files: {} }), { kind: "none" });
});

// ---------- the wave ----------

test("pictures arrive from the middle of the screen outward: nearer first, never more than the last step", () => {
  assert.equal(arrivalStep(0), 0);
  assert.equal(arrivalStep(40), 0, "the ones in the middle show at once");
  assert.ok(arrivalStep(300) < arrivalStep(600));
  assert.equal(arrivalStep(900), ARRIVAL_STEPS);
  assert.equal(arrivalStep(50_000), ARRIVAL_STEPS, "a far one waits the longest step, not longer");
  for (const bad of [NaN, Infinity, -5]) assert.equal(arrivalStep(bad), 0);
  let last = 0;
  for (let d = 0; d <= 2000; d += 25) {
    const s = arrivalStep(d);
    assert.ok(s >= last && Number.isInteger(s), `monotonic whole steps at ${d}`);
    last = s;
  }
  const order = arrivalOrder([
    { id: "far", distance: 800 },
    { id: "mid", distance: 420 },
    { id: "centre", distance: 10 },
    { id: "mid-too", distance: 420 },
    { id: "near", distance: 160 },
  ]).map((x) => x.id);
  assert.deepEqual(order, ["centre", "near", "mid", "mid-too", "far"]);
  assert.equal(arrivalStyle(10), undefined, "nothing to say for a picture that shows at once");
  assert.deepEqual(arrivalStyle(600), { "--arrive-step": String(arrivalStep(600)) });
});

// ---------- the cut ----------

/** a w × h picture on a flat ground with a solid block in the middle */
function picture(w: number, h: number, ground: [number, number, number], figure: [number, number, number], alpha = 255) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = x >= w * 0.3 && x < w * 0.7 && y >= h * 0.2 && y < h * 0.9;
      const c = inside ? figure : ground;
      d.set([c[0], c[1], c[2], alpha], (y * w + x) * 4);
    }
  return d;
}

test("a flat ground is cut away from the border inward and the figure is kept whole", () => {
  const w = 40;
  const h = 50;
  const d = picture(w, h, [240, 238, 232], [40, 60, 120]);
  assert.equal(cutGround(d, w, h), true);
  const a = (x: number, y: number) => d[(y * w + x) * 4 + 3];
  assert.equal(a(0, 0), 0);
  assert.equal(a(w - 1, h - 1), 0);
  assert.equal(a(5, 25), 0, "the ground beside the figure");
  assert.equal(a(20, 25), 255, "the figure");
  assert.equal(a(13, 11), 255, "its edge is far from the ground's colour: solid");
});

test("a picture with nothing to cut is left exactly as it was", () => {
  const w = 40;
  const h = 50;
  // already clear
  const clear = picture(w, h, [240, 238, 232], [40, 60, 120], 0);
  const before = clear.slice();
  assert.equal(cutGround(clear, w, h), false);
  assert.deepEqual(clear, before);
  // corners that disagree: a photograph
  const photo = picture(w, h, [240, 238, 232], [40, 60, 120]);
  photo.set([10, 200, 30, 255], (1 * w + 1) * 4);
  assert.equal(cutGround(photo, w, h), false);
  // a pale figure on a pale ground: nearly all of it would go
  const pale = picture(w, h, [240, 238, 232], [236, 236, 230]);
  const palePixels = pale.slice();
  assert.equal(cutGround(pale, w, h), false);
  assert.deepEqual(pale, palePixels);
  // too small to have a ground
  assert.equal(cutGround(new Uint8ClampedArray(3 * 3 * 4), 3, 3), false);
});

test("a still is cut at 384 px on its longest side, never enlarged", () => {
  assert.equal(CUTOUT_SIZE, 384);
  assert.deepEqual(cutoutSize(512, 683), [288, 384]);
  assert.deepEqual(cutoutSize(1024, 512), [384, 192]);
  assert.deepEqual(cutoutSize(100, 80), [100, 80]);
  assert.deepEqual(cutoutSize(0, 0), [0, 0].map(() => 1));
});

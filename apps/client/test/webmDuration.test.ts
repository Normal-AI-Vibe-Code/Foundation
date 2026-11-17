/**
 * fixWebmDuration writes Segment → Info → Duration into a live (Chrome
 * MediaRecorder) WebM. Fixtures are built byte by byte, and every expected
 * output is spelled out too, so a pass means the exact bytes are right.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixWebmDuration, withWebmDuration } from "../src/utils/webmDuration";

const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const f64 = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return Array.from(b);
};
const f32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v);
  return Array.from(b);
};

// EBML header: EBMLVersion 1, DocType "webm" (11 bytes of children).
const EBML = [0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm")];
const SEGMENT_UNKNOWN = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const timecodeScale = (ns: number) => [0x2a, 0xd7, 0xb1, 0x83, (ns >> 16) & 0xff, (ns >> 8) & 0xff, ns & 0xff];
const MUXING_APP = [0x4d, 0x80, 0x86, ...ascii("Chrome")];
const duration64 = (v: number) => [0x44, 0x89, 0x88, ...f64(v)];
// A Cluster of unknown size: Timecode 0, one SimpleBlock.
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00, 0xa3, 0x85, 0x81, 0x00, 0x00, 0x80, 0xaa];

/** A live WebM: header, unknown-size Segment, Info (with `infoSize` as its size vint), a Cluster. */
const liveWebm = (infoSize: number[], infoKids: number[], after: number[] = []) =>
  bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, infoSize, infoKids, after, CLUSTER);

test("inserts Duration (ms) after TimecodeScale and grows Info's size", () => {
  const kids = [...timecodeScale(1_000_000), ...MUXING_APP]; // 7 + 9 = 16 bytes
  const input = liveWebm([0x90], kids);
  const out = fixWebmDuration(input, 3000.5);
  const expected = bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, [0x9b], timecodeScale(1_000_000), duration64(3000.5), MUXING_APP, CLUSTER);
  assert.deepEqual(out, expected);
  assert.equal(out.length, input.length + 11);
  // the Cluster is byte-for-byte what it was, at the end
  assert.deepEqual(out.subarray(out.length - CLUSTER.length), Uint8Array.from(CLUSTER));
  // the input isn't mutated
  assert.deepEqual(input, liveWebm([0x90], kids));
});

test("keeps an 8-byte Info size vint 8 bytes wide", () => {
  const kids = [...timecodeScale(1_000_000), ...MUXING_APP];
  const size8 = (n: number) => [0x01, 0, 0, 0, 0, 0, 0, n];
  const out = fixWebmDuration(liveWebm(size8(16), kids), 1234);
  assert.deepEqual(out, bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, size8(27), timecodeScale(1_000_000), duration64(1234), MUXING_APP, CLUSTER));
});

test("scales Duration by TimecodeScale, and defaults it to 1 ms ticks when absent", () => {
  // 500,000 ns per tick: 3 s is 6000 ticks
  const half = fixWebmDuration(liveWebm([0x87], timecodeScale(500_000)), 3000);
  assert.deepEqual(half, bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, [0x92], timecodeScale(500_000), duration64(6000), CLUSTER));
  // no TimecodeScale: Duration goes first, in ms
  const dflt = fixWebmDuration(liveWebm([0x89], MUXING_APP), 2500);
  assert.deepEqual(dflt, bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, [0x94], duration64(2500), MUXING_APP, CLUSTER));
});

test("overwrites an existing Duration in place, float64 or float32", () => {
  const kids64 = [...timecodeScale(1_000_000), ...duration64(0), ...MUXING_APP];
  const out64 = fixWebmDuration(liveWebm([0x9b], kids64), 4321.25);
  assert.deepEqual(out64, liveWebm([0x9b], [...timecodeScale(1_000_000), ...duration64(4321.25), ...MUXING_APP]));

  const dur32 = (v: number) => [0x44, 0x89, 0x84, ...f32(v)];
  const out32 = fixWebmDuration(liveWebm([0x8e], [...timecodeScale(1_000_000), ...dur32(1)]), 3000);
  assert.deepEqual(out32, liveWebm([0x8e], [...timecodeScale(1_000_000), ...dur32(3000)]));
});

test("a Void after Info gives up the room, so nothing after it moves", () => {
  const void16 = [0xec, 0x8e, ...new Array(14).fill(0)];
  const input = liveWebm([0x87], timecodeScale(1_000_000), void16);
  const out = fixWebmDuration(input, 3000);
  assert.equal(out.length, input.length);
  assert.deepEqual(out, bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, [0x92], timecodeScale(1_000_000), duration64(3000), [0xec, 0x83, 0, 0, 0], CLUSTER));
});

test("leaves alone what it can't patch safely", () => {
  const kids = timecodeScale(1_000_000);
  // a finished file (known Segment size) with no room: offsets in SeekHead/Cues could go stale
  const known = bytes(EBML, [0x18, 0x53, 0x80, 0x67, 0x80 | (5 + 7 + CLUSTER.length)], INFO_ID, [0x87], kids, CLUSTER);
  assert.equal(fixWebmDuration(known, 3000), known);
  // a SeekHead before Info
  const seekHead = [0x11, 0x4d, 0x9b, 0x74, 0x80];
  const sought = bytes(EBML, SEGMENT_UNKNOWN, seekHead, INFO_ID, [0x87], kids, CLUSTER);
  assert.equal(fixWebmDuration(sought, 3000), sought);
  // ...but a known-size file with an existing Duration is filled in place
  const filled = bytes(EBML, [0x18, 0x53, 0x80, 0x67, 0x80 | (5 + 18)], INFO_ID, [0x92], kids, duration64(0));
  assert.deepEqual(fixWebmDuration(filled, 99), bytes(EBML, [0x18, 0x53, 0x80, 0x67, 0x80 | (5 + 18)], INFO_ID, [0x92], kids, duration64(99)));
});

test("garbage, truncation and bad durations return the original", () => {
  const good = liveWebm([0x87], timecodeScale(1_000_000));
  const cases = [
    new Uint8Array(0),
    Uint8Array.from({ length: 300 }, (_, i) => (i * 73 + 11) & 0xff),
    bytes([0x00, 0x00, 0x00, 0x00]),
    good.subarray(0, EBML.length + SEGMENT_UNKNOWN.length + 6), // Info cut off
    bytes(EBML, SEGMENT_UNKNOWN, CLUSTER), // no Info before the media
    bytes([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // EBML header of unknown size
    bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, [0x84], [0x2a, 0xd7, 0xb1, 0x80], CLUSTER), // TimecodeScale of 0 bytes
  ];
  for (const c of cases) assert.equal(fixWebmDuration(c, 3000), c);
  for (const ms of [0, -1, NaN, Infinity]) assert.equal(fixWebmDuration(good, ms), good);
});

test("withWebmDuration patches a Blob's head and keeps the rest; a non-WebM Blob comes back as is", async () => {
  const input = liveWebm([0x87], timecodeScale(1_000_000));
  // a long tail past the 64 KiB head, so the splice is exercised
  const tail = Uint8Array.from({ length: 100_000 }, (_, i) => i & 0xff);
  const blob = new Blob([input, tail], { type: "video/webm" });
  const out = await withWebmDuration(blob, 3000);
  assert.equal(out.type, "video/webm");
  const got = new Uint8Array(await out.arrayBuffer());
  const want = bytes(EBML, SEGMENT_UNKNOWN, INFO_ID, [0x92], timecodeScale(1_000_000), duration64(3000), CLUSTER, tail);
  assert.deepEqual(got, want);

  const mp4 = new Blob([Uint8Array.from([0, 0, 0, 0x18, ...ascii("ftypmp42")])], { type: "video/mp4" });
  assert.equal(await withWebmDuration(mp4, 3000), mp4);
});

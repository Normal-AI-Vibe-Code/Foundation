/**
 * Voice and video notes (notes/recorder.ts): the format chosen per browser, the time cap and its countdown,
 * the wave's normalisation, and the state machine with fake tracks: the microphone opens only on record(),
 * and every track is stopped on stop, discard, close and failure. A failed upload keeps the clip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_NOTE_MAX_MS } from "@foundation/protocol";
import {
  clock,
  normalizePeaks,
  noteFileName,
  noteName,
  NoteRecording,
  openFailure,
  pickMime,
  samplesToLevels,
  timeLeft,
  videoCardSize,
  type RecorderEnv,
  type RecorderLike,
} from "../src/notes/recorder";

// ---------- the format ----------

test("Chrome records voice as WebM Opus, video as VP9", () => {
  const chrome = (t: string) => /webm/.test(t);
  assert.equal(pickMime("audio", chrome), "audio/webm;codecs=opus");
  assert.equal(pickMime("video", chrome), "video/webm;codecs=vp9,opus");
});

test("WebKit (Safari, the Mac app) records mp4", () => {
  const webkit = (t: string) => /mp4/.test(t);
  assert.equal(pickMime("audio", webkit), "audio/mp4");
  assert.equal(pickMime("video", webkit), "video/mp4");
});

test("nothing known: the recorder picks its own; a throwing isTypeSupported is a no", () => {
  assert.equal(pickMime("audio", () => false), undefined);
  assert.equal(pickMime("video", (t) => { if (t.includes("vp9")) throw new Error("?"); return t === "video/webm"; }), "video/webm");
});

// ---------- the cap ----------

test("a voice note runs 5 minutes, a video note 2; the countdown shows for the last 10 s", () => {
  assert.equal(MEDIA_NOTE_MAX_MS.audio, 300_000);
  assert.equal(MEDIA_NOTE_MAX_MS.video, 120_000);
  assert.deepEqual(timeLeft("audio", 0), { left: 300_000, countdown: false });
  assert.deepEqual(timeLeft("audio", 289_999), { left: 10_001, countdown: false });
  assert.deepEqual(timeLeft("audio", 290_000), { left: 10_000, countdown: true });
  assert.deepEqual(timeLeft("video", 200_000), { left: 0, countdown: true });
});

test("clock, names and the file's name", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(42_900), "0:42");
  assert.equal(clock(245_000), "4:05");
  assert.equal(noteName("audio", "Josh Leong"), "Voice note · Josh");
  assert.equal(noteName("video", "  "), "Video note · someone");
  const at = new Date(2026, 10, 25, 14, 32).getTime();
  assert.equal(noteFileName("audio", "Josh Leong", at, "audio/webm"), "voice-note-josh-2026-11-25-14-32.webm");
  assert.equal(noteFileName("audio", "Josh", at, "audio/mp4"), "voice-note-josh-2026-11-25-14-32.m4a");
  assert.equal(noteFileName("video", "Josh", at, "video/mp4"), "video-note-josh-2026-11-25-14-32.mp4");
});

test("a video card keeps the camera's shape at 320 on its long side", () => {
  assert.deepEqual(videoCardSize(1280, 720), { w: 320, h: 180 });
  assert.deepEqual(videoCardSize(720, 1280), { w: 180, h: 320 });
  assert.deepEqual(videoCardSize(0, 0), { w: 320, h: 180 });
});

// ---------- the wave ----------

test("peaks: 48 steps, the loudest is 1, silence keeps a hairline, two decimals", () => {
  const levels = Array.from({ length: 480 }, (_, i) => (i < 240 ? 0 : (i - 240) / 480));
  const p = normalizePeaks(levels)!;
  assert.equal(p.length, 48);
  assert.equal(Math.max(...p), 1);
  assert.equal(p[0], 0.04);
  assert.ok(p.every((v) => v >= 0.04 && v <= 1 && Math.round(v * 100) / 100 === v));
  // rising: never goes down
  for (let i = 1; i < p.length; i++) assert.ok(p[i] >= p[i - 1]);
});

test("peaks: fewer samples than steps still makes 48; none makes none; all silent is all hairline", () => {
  assert.equal(normalizePeaks([0.2, 0.4, 0.1])!.length, 48);
  assert.equal(normalizePeaks([]), undefined);
  assert.ok(normalizePeaks([0, 0, 0, 0])!.every((v) => v === 0.04));
  assert.ok(normalizePeaks([-0.5, 0.25])!.includes(1)); // loudness is its size
});

test("samples → RMS levels", () => {
  const s = new Float32Array(400).fill(0.5);
  const l = samplesToLevels(s, 4);
  assert.equal(l.length, 4);
  assert.ok(l.every((v) => Math.abs(v - 0.5) < 1e-6));
});

test("failures say what to do", () => {
  assert.match(openFailure("audio", { name: "NotAllowedError" }), /refused.*Allow it/);
  assert.match(openFailure("video", { name: "NotFoundError" }), /No camera/);
  assert.match(openFailure("audio", { name: "NotFoundError" }), /No microphone/);
  assert.match(openFailure("audio", { name: "NotReadableError" }), /in use/);
  assert.match(openFailure("audio", null, false), /secure page/);
});

// ---------- the state machine, on fakes ----------

class FakeTrack {
  stopped = false;
  constructor(public kind: string) {}
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  tracks: FakeTrack[];
  constructor(video: boolean) {
    this.tracks = [new FakeTrack("audio"), ...(video ? [new FakeTrack("video")] : [])];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  get live() {
    return this.tracks.filter((t) => !t.stopped).length;
  }
}
class FakeRecorder implements RecorderLike {
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public mimeType: string) {}
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: this.mimeType }) });
    queueMicrotask(() => this.onstop?.());
  }
}

function harness(opts: { refuse?: string; types?: (t: string) => boolean } = {}) {
  let t = 0;
  const timers = new Map<number, () => void>();
  let n = 0;
  const streams: FakeStream[] = [];
  const asked: MediaStreamConstraints[] = [];
  let level = 0.5;
  const env: RecorderEnv = {
    getUserMedia: async (c) => {
      asked.push(c);
      if (opts.refuse) throw Object.assign(new Error("no"), { name: opts.refuse });
      const s = new FakeStream(!!c.video);
      streams.push(s);
      return s as unknown as MediaStream;
    },
    isTypeSupported: opts.types ?? ((x) => /webm/.test(x)),
    makeRecorder: (_s, mime) => new FakeRecorder(mime ?? "audio/webm"),
    now: () => t,
    setInterval: (fn) => {
      timers.set(++n, fn);
      return n;
    },
    clearInterval: (h) => void timers.delete(h as number),
    meter: () => ({ level: () => (level = (level + 0.37) % 1), close() {} }),
    fixDuration: async (b) => b,
  };
  const advance = (ms: number) => {
    for (let k = 0; k < ms; k += 100) {
      t += 100;
      for (const fn of [...timers.values()]) fn();
    }
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { env, streams, asked, advance, flush, timers };
}

test("nothing is opened until Record; Stop stops every track and leads to review with a wave", async () => {
  const h = harness();
  const r = new NoteRecording(h.env, "audio");
  r.choose("audio");
  assert.equal(h.asked.length, 0, "choosing opens nothing");
  assert.equal(r.snap.state, "idle");
  const p = r.record();
  assert.equal(r.snap.state, "asking");
  await p;
  assert.equal(r.snap.state, "recording");
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].video, undefined, "a voice note never asks for the camera");
  h.advance(2000);
  assert.equal(r.snap.elapsed, 2000);
  r.stop();
  assert.equal(h.streams[0].live, 0, "the light goes out at Stop");
  await h.flush();
  assert.equal(r.snap.state, "review");
  assert.equal(r.snap.clip!.ms, 2000);
  assert.equal(r.snap.clip!.mime, "audio/webm");
  assert.equal(r.snap.clip!.peaks!.length, 48);
  assert.equal(h.timers.size, 0, "no timer left running");
  r.close();
});

test("a video note asks for camera and microphone, and has no wave", async () => {
  const h = harness();
  const r = new NoteRecording(h.env, "video");
  await r.record();
  assert.ok(h.asked[0].video);
  h.advance(1000);
  r.stop();
  await h.flush();
  assert.equal(r.snap.state, "review");
  assert.equal(r.snap.clip!.peaks, undefined);
  assert.equal(h.streams[0].live, 0);
});

test("the cap stops it by itself", async () => {
  const h = harness();
  const r = new NoteRecording(h.env, "video");
  await r.record();
  h.advance(MEDIA_NOTE_MAX_MS.video + 500);
  await h.flush();
  assert.equal(r.snap.state, "review");
  assert.equal(r.snap.clip!.ms, MEDIA_NOTE_MAX_MS.video);
  assert.equal(h.streams[0].live, 0);
});

test("discard while recording: no clip, no live track; Record again starts fresh", async () => {
  const h = harness();
  const r = new NoteRecording(h.env, "audio");
  await r.record();
  h.advance(500);
  r.discard();
  await h.flush();
  assert.equal(r.snap.state, "idle");
  assert.equal(r.snap.clip, null);
  assert.equal(h.streams[0].live, 0);
  await r.record();
  h.advance(300);
  r.stop();
  await h.flush();
  assert.equal(r.snap.state, "review");
  // record again from review: the old clip goes, a new stream opens
  await r.record();
  assert.equal(r.snap.state, "recording");
  assert.equal(r.snap.clip, null);
  assert.equal(h.streams.length, 3);
  r.close();
  assert.equal(h.streams[2].live, 0, "close stops the tracks");
});

test("closed while the browser asked: the stream that arrives late is stopped at once", async () => {
  const h = harness();
  const r = new NoteRecording(h.env, "audio");
  const p = r.record();
  r.close();
  await p;
  assert.equal(h.streams[0].live, 0);
  assert.equal(r.snap.state, "asking"); // nothing more is said to a closed recorder
});

test("refused: a sentence, nothing left open, and Record can be pressed again", async () => {
  const h = harness({ refuse: "NotAllowedError" });
  const r = new NoteRecording(h.env, "audio");
  await r.record();
  assert.equal(r.snap.state, "failed");
  assert.equal(r.snap.failure!.stage, "open");
  assert.match(r.snap.failure!.text, /refused/);
  r.choose("video"); // can still switch
  assert.equal(r.snap.kind, "video");
});

test("no mediaDevices (an insecure page): says so", async () => {
  const h = harness();
  const r = new NoteRecording({ ...h.env, getUserMedia: undefined }, "audio");
  await r.record();
  assert.equal(r.snap.state, "failed");
  assert.match(r.snap.failure!.text, /secure page/);
});

test("a failed upload keeps the clip; Try again leaves it", async () => {
  const h = harness();
  const r = new NoteRecording(h.env, "audio");
  await r.record();
  h.advance(1000);
  r.stop();
  await h.flush();
  const clip = r.snap.clip;
  let tries = 0;
  const send = async () => {
    tries++;
    if (tries === 1) throw new Error("network error");
    return { fileId: "f_abc" };
  };
  assert.equal(await r.leave(send), null);
  assert.equal(r.snap.state, "failed");
  assert.equal(r.snap.failure!.stage, "upload");
  assert.equal(r.snap.clip, clip, "the recording is still here");
  assert.equal(r.holdsClip, true);
  // Record is not offered over a kept clip
  await r.record();
  assert.equal(r.snap.state, "failed");
  assert.deepEqual(await r.leave(send), { fileId: "f_abc" });
  assert.equal(r.snap.state, "left");
  assert.equal(r.holdsClip, false);
});

/**
 * A call's devices (lib/media.ts), on a fake `navigator.mediaDevices`: a computer without a
 * camera still gets its microphone (and the camera is never asked for, since asking for an absent
 * one fails the whole request before any prompt); a refusal isn't asked again for the device that
 * was refused; a busy camera keeps the microphone; a remembered device that's gone falls back to
 * the default; and each refusal is said in words a person can act on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceError, openLocal, openOne } from "../src/lib/media";

type Fail = { audio?: string; video?: string; both?: string };
interface Fake {
  calls: MediaStreamConstraints[];
}

function track(kind: "audio" | "video", deviceId = `${kind}-1`) {
  return { kind, label: `${kind} device`, readyState: "live", enabled: true, stop() {}, getSettings: () => ({ deviceId }) } as unknown as MediaStreamTrack;
}

function fake(opts: { mics?: number; cams?: number; fail?: Fail; perms?: Record<string, PermissionState> }): Fake {
  const f: Fake = { calls: [] };
  const devices = [...Array(opts.mics ?? 1)].map((_, i) => ({ kind: "audioinput", deviceId: `a${i}`, label: "" })).concat([...Array(opts.cams ?? 1)].map((_, i) => ({ kind: "videoinput", deviceId: `v${i}`, label: "" })));
  const g = globalThis as unknown as { navigator: unknown; MediaStream: unknown };
  g.MediaStream = class {
    constructor(private t: MediaStreamTrack[] = []) {}
    getTracks() {
      return this.t;
    }
    getAudioTracks() {
      return this.t.filter((x) => x.kind === "audio");
    }
    getVideoTracks() {
      return this.t.filter((x) => x.kind === "video");
    }
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => devices,
        getUserMedia: async (c: MediaStreamConstraints) => {
          f.calls.push(c);
          const fail = c.audio && c.video ? (opts.fail?.both ?? opts.fail?.audio ?? opts.fail?.video) : c.audio ? opts.fail?.audio : opts.fail?.video;
          if (fail) throw Object.assign(new Error(fail), { name: fail });
          const id = (k: boolean | MediaTrackConstraints | undefined) => ((k as MediaTrackConstraints)?.deviceId as { exact?: string; ideal?: string })?.exact ?? ((k as MediaTrackConstraints)?.deviceId as { ideal?: string })?.ideal;
          const ts = [...(c.audio ? [track("audio", id(c.audio) ?? "a0")] : []), ...(c.video ? [track("video", id(c.video) ?? "v0")] : [])];
          return new (g.MediaStream as new (t: MediaStreamTrack[]) => MediaStream)(ts);
        },
      },
      permissions: { query: async ({ name }: { name: string }) => ({ state: opts.perms?.[name] ?? "prompt" }) },
    },
  });
  return f;
}

test("both devices: one request, so one prompt", async () => {
  const f = fake({});
  const r = await openLocal({ mic: true, cam: true }, {});
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].audio && f.calls[0].video);
  assert.equal(r.mic.state, "on");
  assert.equal(r.cam.state, "on");
  assert.equal(r.tracks.length, 2);
});

test("no camera: the microphone alone is asked for, and the call has it", async () => {
  const f = fake({ cams: 0 });
  const r = await openLocal({ mic: true, cam: true }, {});
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].video, undefined, "an absent camera is never asked for");
  assert.equal(r.mic.state, "on");
  assert.equal(r.cam.state, "none");
  assert.deepEqual(r.tracks.map((t) => t.kind), ["audio"]);
});

test("a camera the browser can't find after all: tried one at a time, the microphone kept", async () => {
  const f = fake({ fail: { both: "NotFoundError", video: "NotFoundError" } });
  const r = await openLocal({ mic: true, cam: true }, {});
  assert.equal(f.calls.length, 3);
  assert.equal(r.mic.state, "on");
  assert.equal(r.cam.state, "none");
});

test("a camera another app holds: the microphone kept, the camera said busy", async () => {
  fake({ fail: { both: "NotReadableError", video: "NotReadableError" } });
  const r = await openLocal({ mic: true, cam: true }, {});
  assert.equal(r.mic.state, "on");
  assert.equal(r.cam.state, "busy");
});

test("refused: not asked again for what was just refused; a device still allowed is opened", async () => {
  const f = fake({ fail: { both: "NotAllowedError", video: "NotAllowedError" }, perms: { microphone: "granted", camera: "denied" } });
  const r = await openLocal({ mic: true, cam: true }, {});
  assert.equal(f.calls.length, 2, "the joint request, then the microphone alone");
  assert.ok(f.calls[1].audio && !f.calls[1].video);
  assert.equal(r.mic.state, "on");
  assert.equal(r.cam.state, "blocked");
});

test("refused outright: nothing asked again, both blocked", async () => {
  const f = fake({ fail: { both: "NotAllowedError" } });
  const r = await openLocal({ mic: true, cam: true }, {});
  assert.equal(f.calls.length, 1);
  assert.equal(r.mic.state, "blocked");
  assert.equal(r.cam.state, "blocked");
  assert.equal(r.tracks.length, 0);
});

test("a remembered microphone that's gone: the default one instead", async () => {
  let n = 0;
  fake({});
  const md = (globalThis as unknown as { navigator: { mediaDevices: { getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> } } }).navigator.mediaDevices;
  const orig = md.getUserMedia;
  md.getUserMedia = async (c) => {
    if (n++ === 0) throw Object.assign(new Error("gone"), { name: "OverconstrainedError" });
    return orig(c);
  };
  const r = await openOne("mic", "unplugged");
  assert.equal(r.state.state, "on");
  assert.equal(n, 2);
});

test("a device chosen by name that's gone is not swapped for another", async () => {
  fake({ fail: { audio: "OverconstrainedError" } });
  const r = await openOne("mic", "unplugged", true);
  assert.equal(r.track, null);
  assert.equal(r.state.state, "none");
});

test("no devices reachable (not a secure page): said, not thrown", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  const r = await openLocal({ mic: true, cam: true }, {});
  assert.equal(r.mic.state, "unavailable");
  assert.equal(r.cam.state, "unavailable");
  assert.equal(r.tracks.length, 0);
});

test("refusals in words a person can act on", () => {
  assert.equal(deviceError("mic", { name: "NotAllowedError" }).state, "blocked");
  assert.match(deviceError("mic", { name: "NotAllowedError" }).message!, /Privacy › Microphone/);
  assert.equal(deviceError("cam", { name: "NotFoundError" }).state, "none");
  assert.equal(deviceError("cam", { name: "NotReadableError" }).state, "busy");
  assert.equal(deviceError("cam", new Error("odd")).state, "error");
});

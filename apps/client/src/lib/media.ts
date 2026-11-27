/**
 * The camera, the microphone and the speaker, for a huddle (and anything else that opens them).
 *
 * The browser is asked for each device on its own terms: a computer with a microphone and no
 * camera (or a camera another app holds) still gets its microphone. Asking for both in one
 * `getUserMedia` call fails the whole call with "device not found" before any permission prompt
 * appears, which is how a huddle used to fail on such a computer without ever asking.
 *
 * What each device is doing is a `DeviceState`, shown by the device chip in the call's controls.
 * The devices someone picked are remembered in this browser (a per-viewer convenience: if one is
 * gone, the browser's default is used instead).
 */

export type DeviceKind = "mic" | "cam";

export interface DeviceState {
  /** on: a live track · off: not asked for yet · none: no such device · blocked: permission refused · busy: another app holds it · unavailable: this page can't reach devices · error */
  state: "on" | "off" | "none" | "blocked" | "busy" | "unavailable" | "error";
  label?: string;
  deviceId?: string;
  message?: string;
}

export interface DeviceChoice {
  mic?: string;
  cam?: string;
  out?: string;
}

const KEY = "foundation-media-devices";

export function loadChoice(): DeviceChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as DeviceChoice;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function saveChoice(patch: DeviceChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadChoice(), ...patch }));
  } catch {
    /* storage off: the choice lasts this call */
  }
}

export const mediaConstraints = {
  cam: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } as MediaTrackConstraints,
  mic: { echoCancellation: true, noiseSuppression: true } as MediaTrackConstraints,
};

function constraint(kind: DeviceKind, deviceId: string | undefined, exact: boolean): MediaTrackConstraints {
  const base = mediaConstraints[kind];
  return deviceId ? { ...base, deviceId: exact ? { exact: deviceId } : { ideal: deviceId } } : base;
}

/** what a refusal means, in words a person can act on */
export function deviceError(kind: DeviceKind, e: unknown): DeviceState {
  const name = (e as DOMException)?.name;
  const what = kind === "mic" ? "microphone" : "camera";
  if (name === "NotAllowedError" || name === "SecurityError") return { state: "blocked", message: `The ${what} is blocked for Foundation. Allow it in the browser's site settings (the icon left of the address), or in Windows Settings › Privacy › ${kind === "mic" ? "Microphone" : "Camera"}, then press Allow.` };
  if (name === "NotFoundError" || name === "OverconstrainedError") return { state: "none", message: `No ${what} found.` };
  if (name === "NotReadableError" || name === "AbortError") return { state: "busy", message: `The ${what} is in use by another app, or Windows won't hand it over.` };
  return { state: "error", message: (e as Error)?.message ?? `Couldn't start the ${what}` };
}

export function canReachDevices() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** the Permissions API's word for a device (prompt where it can't be read) */
export async function permissionOf(kind: DeviceKind): Promise<PermissionState> {
  try {
    return (await navigator.permissions.query({ name: (kind === "mic" ? "microphone" : "camera") as PermissionName })).state;
  } catch {
    return "prompt";
  }
}

export async function listDevices(): Promise<{ mic: MediaDeviceInfo[]; cam: MediaDeviceInfo[]; out: MediaDeviceInfo[] }> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { mic: all.filter((d) => d.kind === "audioinput"), cam: all.filter((d) => d.kind === "videoinput"), out: all.filter((d) => d.kind === "audiooutput") };
  } catch {
    return { mic: [], cam: [], out: [] };
  }
}

/** a device's name, or a plain one before the browser has shared names (before permission) */
export function deviceName(d: Pick<MediaDeviceInfo, "label" | "kind">, i: number) {
  if (d.label) return d.label;
  return `${d.kind === "audioinput" ? "Microphone" : d.kind === "videoinput" ? "Camera" : "Speaker"} ${i + 1}`;
}

function stateOf(t: MediaStreamTrack): DeviceState {
  return { state: "on", label: t.label, deviceId: t.getSettings().deviceId };
}

/** one device on its own: a track, or why not */
export async function openOne(kind: DeviceKind, deviceId?: string, exact = false): Promise<{ track: MediaStreamTrack | null; state: DeviceState }> {
  if (!canReachDevices()) return { track: null, state: { state: "unavailable", message: "This window can't reach a camera or microphone (it needs https or localhost; the desktop app always can)." } };
  try {
    const s = await navigator.mediaDevices.getUserMedia(kind === "mic" ? { audio: constraint("mic", deviceId, exact) } : { video: constraint("cam", deviceId, exact) });
    const t = (kind === "mic" ? s.getAudioTracks() : s.getVideoTracks())[0] ?? null;
    return t ? { track: t, state: stateOf(t) } : { track: null, state: { state: "none" } };
  } catch (e) {
    // a remembered device that's gone: the default one instead
    if (deviceId && !exact && ((e as DOMException)?.name === "OverconstrainedError" || (e as DOMException)?.name === "NotFoundError")) return openOne(kind);
    return { track: null, state: deviceError(kind, e) };
  }
}

/**
 * The microphone and the camera for a call, each on its own: one prompt where the browser asks
 * for both, and whichever one works is kept when the other can't be had.
 */
export async function openLocal(want: { mic: boolean; cam: boolean }, choice: DeviceChoice = loadChoice()): Promise<{ tracks: MediaStreamTrack[]; mic: DeviceState; cam: DeviceState }> {
  const off: DeviceState = { state: "off" };
  if (!canReachDevices()) {
    const u = (await openOne("mic")).state;
    return { tracks: [], mic: want.mic ? u : off, cam: want.cam ? u : off };
  }
  const have = await listDevices();
  // only ask for a kind this computer has (an absent camera fails the whole request)
  const askMic = want.mic && have.mic.length > 0;
  const askCam = want.cam && have.cam.length > 0;
  const none = (kind: DeviceKind): DeviceState => (want[kind] ? { state: "none", message: `No ${kind === "mic" ? "microphone" : "camera"} found.` } : off);
  if (askMic && askCam) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: constraint("mic", choice.mic, false), video: constraint("cam", choice.cam, false) });
      const a = s.getAudioTracks()[0];
      const v = s.getVideoTracks()[0];
      return { tracks: s.getTracks(), mic: a ? stateOf(a) : none("mic"), cam: v ? stateOf(v) : none("cam") };
    } catch (e) {
      // refused outright: don't prompt again for what was just refused; anything else: one at a time
      if ((e as DOMException)?.name === "NotAllowedError") {
        const [pm, pc] = await Promise.all([permissionOf("mic"), permissionOf("cam")]);
        const m = pm === "granted" ? await openOne("mic", choice.mic) : { track: null, state: deviceError("mic", e) };
        const c = pc === "granted" ? await openOne("cam", choice.cam) : { track: null, state: deviceError("cam", e) };
        return { tracks: [m.track, c.track].filter((t): t is MediaStreamTrack => Boolean(t)), mic: m.state, cam: c.state };
      }
    }
  }
  const m = askMic ? await openOne("mic", choice.mic) : { track: null, state: none("mic") };
  const c = askCam ? await openOne("cam", choice.cam) : { track: null, state: none("cam") };
  return { tracks: [m.track, c.track].filter((t): t is MediaStreamTrack => Boolean(t)), mic: m.state, cam: c.state };
}

// ---------- the speaker: where the call's sound plays ----------

let sink = loadChoice().out ?? "";
const sinkSubs = new Set<() => void>();

export const canPickSpeaker = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

export function speaker() {
  return sink;
}
export function onSpeaker(fn: () => void) {
  sinkSubs.add(fn);
  return () => void sinkSubs.delete(fn);
}
export function setSpeaker(id: string) {
  sink = id;
  saveChoice({ out: id });
  for (const fn of sinkSubs) fn();
}
/** play an element's sound on the chosen speaker (where the browser lets a page choose) */
export function applySpeaker(el: HTMLMediaElement) {
  if (!canPickSpeaker) return;
  const e = el as HTMLMediaElement & { setSinkId(id: string): Promise<void>; sinkId?: string };
  if ((e.sinkId ?? "") === sink) return;
  e.setSinkId(sink).catch(() => {
    /* gone: the default plays */
  });
}

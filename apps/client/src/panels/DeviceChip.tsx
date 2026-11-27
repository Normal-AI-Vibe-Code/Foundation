/**
 * The device chip in a call's controls: a small headset that says whether my microphone and
 * camera are live (a dot: ok, warn, bad), and opens a picker for the microphone, the camera and
 * the speaker, with the microphone's level and, where the browser refused a device, why and
 * "Ask again" (the browser's permission prompt, on a person's press).
 *
 * It opens by itself once, on joining, when the microphone didn't come on: that's the moment a
 * person needs to know the call can't hear them.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { springs } from "@foundation/ui";
import type { HuddleRoom, RoomView } from "../lib/huddle";
import { canPickSpeaker, deviceName, listDevices, setSpeaker, speaker, type DeviceKind, type DeviceState } from "../lib/media";

type Lists = Awaited<ReturnType<typeof listDevices>>;

const trouble = (d: DeviceState) => d.state !== "on" && d.state !== "off";

export function deviceTone(view: Pick<RoomView, "mic" | "cam">): "ok" | "warn" | "bad" {
  if (view.mic.state !== "on") return "bad";
  if (trouble(view.cam)) return "warn";
  return "ok";
}

export function deviceTip(view: Pick<RoomView, "mic" | "cam">) {
  const say = (k: DeviceKind, d: DeviceState) => {
    const what = k === "mic" ? "Microphone" : "Camera";
    if (d.state === "on") return `${what}: ${d.label || "on"}`;
    if (d.state === "blocked") return `${what}: blocked`;
    if (d.state === "none") return `${what}: none found`;
    if (d.state === "busy") return `${what}: in use elsewhere`;
    if (d.state === "unavailable") return `${what}: can't be reached here`;
    if (d.state === "off") return `${what}: off`;
    return `${what}: not working`;
  };
  return `${say("mic", view.mic)} · ${say("cam", view.cam)}`;
}

export function DeviceChip({ room, view }: { room: HuddleRoom; view: RoomView }) {
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  const tone = deviceTone(view);
  // once, on joining: the microphone didn't come on, so say why right away
  useEffect(() => {
    if (opened.current || view.mic.state === "off") return;
    opened.current = true;
    if (trouble(view.mic)) setOpen(true);
  }, [view.mic]);
  return (
    <div className="huddle-ctl-anchor">
      <button className={`huddle-ctl huddle-devices is-${tone}`} data-tip={deviceTip(view)} aria-label={`Devices — ${deviceTip(view)}`} aria-expanded={open} data-huddle-devices={tone} onClick={() => setOpen((o) => !o)}>
        <HeadsetGlyph />
        <span className={`f-dot is-${tone}`} aria-hidden />
      </button>
      <AnimatePresence>{open && <DevicePop room={room} view={view} onClose={() => setOpen(false)} />}</AnimatePresence>
    </div>
  );
}

function DevicePop({ room, view, onClose }: { room: HuddleRoom; view: RoomView; onClose(): void }) {
  const [lists, setLists] = useState<Lists>({ mic: [], cam: [], out: [] });
  const [out, setOut] = useState(speaker());
  const box = useRef<HTMLDivElement>(null);
  // the lists, again whenever a device comes or goes (and once names are shared, after permission)
  useEffect(() => {
    let live = true;
    const load = () => void listDevices().then((l) => live && setLists(l));
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", load);
    };
  }, [view.mic.state, view.cam.state, view.mic.deviceId, view.cam.deviceId]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (box.current && t && !box.current.contains(t) && !t.closest?.(".huddle-devices")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const micTrack = view.local?.getAudioTracks()[0] ?? null;
  return (
    <motion.div ref={box} className="huddle-pop huddle-device-pop f-glass" role="dialog" aria-label="Devices" initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.98 }} transition={{ type: "spring", ...springs.pop }}>
      <div className="huddle-pop-head">Devices</div>
      <DeviceRow kind="mic" title="Microphone" state={view.mic} list={lists.mic} onPick={(id) => void room.useDevice("mic", id)} onRetry={() => void room.retryDevice("mic")}>
        {micTrack && view.mic.state === "on" && <Level track={micTrack} muted={view.muted} />}
      </DeviceRow>
      <DeviceRow kind="cam" title="Camera" state={view.cam} list={lists.cam} onPick={(id) => void room.useDevice("cam", id)} onRetry={() => void room.retryDevice("cam")} />
      {canPickSpeaker && lists.out.length > 0 && (
        <label className="huddle-device">
          <span className="huddle-device-title">Speaker</span>
          <select
            value={lists.out.some((d) => d.deviceId === out) ? out : ""}
            onChange={(e) => {
              setOut(e.target.value);
              setSpeaker(e.target.value);
            }}
            aria-label="Speaker"
          >
            {!lists.out.some((d) => d.deviceId === "default") && <option value="">The system's speaker</option>}
            {lists.out.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId === "default" ? "" : d.deviceId}>
                {deviceName(d, i)}
              </option>
            ))}
          </select>
        </label>
      )}
    </motion.div>
  );
}

export function DeviceRow({ kind, title, state, list, onPick, onRetry, children }: { kind: DeviceKind; title: string; state: DeviceState; list: MediaDeviceInfo[]; onPick(id: string): void; onRetry(): void; children?: React.ReactNode }) {
  const what = kind === "mic" ? "microphone" : "camera";
  const tone = state.state === "on" ? "ok" : state.state === "off" ? "" : kind === "mic" ? "bad" : "warn";
  const usable = list.filter((d) => d.deviceId);
  return (
    <div className="huddle-device" data-device={kind} data-state={state.state}>
      <span className="huddle-device-title">
        <span className={`f-dot${tone ? ` is-${tone}` : ""}`} aria-hidden />
        {title}
        <i>{state.state === "on" ? "connected" : state.state === "off" ? "off" : state.state === "blocked" ? "blocked" : state.state === "none" ? "none found" : state.state === "busy" ? "in use" : state.state === "unavailable" ? "unavailable" : "not working"}</i>
      </span>
      {usable.length > 0 && (
        <select value={state.state === "on" && usable.some((d) => d.deviceId === state.deviceId) ? state.deviceId : ""} onChange={(e) => e.target.value && onPick(e.target.value)} aria-label={title}>
          {(state.state !== "on" || !usable.some((d) => d.deviceId === state.deviceId)) && <option value="">{state.state === "on" ? state.label || `This ${what}` : `Choose a ${what}`}</option>}
          {usable.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {deviceName(d, i)}
            </option>
          ))}
        </select>
      )}
      {children}
      {state.state !== "on" && state.state !== "unavailable" && (
        <div className="huddle-device-why">
          {state.message && <p className="huddle-pop-note">{state.message}</p>}
          <button className="f-pill is-accent" onClick={onRetry} data-device-retry={kind}>
            {state.state === "off" ? `Turn the ${what} on` : state.state === "blocked" ? `Allow the ${what}` : "Ask again"}
          </button>
        </div>
      )}
      {state.state === "unavailable" && state.message && <p className="huddle-pop-note">{state.message}</p>}
    </div>
  );
}

/** the microphone's level, while the picker is open (so you can see it hears you) */
function Level({ track, muted }: { track: MediaStreamTrack; muted: boolean }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (typeof AudioContext === "undefined") return;
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(new MediaStream([track]));
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, (peak / 128) * 2.2)})`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      src.disconnect();
      void ac.close();
    };
  }, [track]);
  return (
    <span className={`huddle-level${muted ? " is-muted" : ""}`} aria-label={muted ? "Muted" : "Microphone level"} data-tip={muted ? "Muted: the room doesn't hear you" : undefined}>
      <span ref={bar} />
    </span>
  );
}

export function HeadsetGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2" />
      <rect x="2" y="9.5" width="3" height="4" rx="1" />
      <rect x="11" y="9.5" width="3" height="4" rx="1" />
    </svg>
  );
}

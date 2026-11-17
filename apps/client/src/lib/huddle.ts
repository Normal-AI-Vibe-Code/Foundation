/**
 * A huddle room in the browser: the WebRTC mesh behind a video portal.
 *
 * People who **join** send their camera and mic to everyone in the room;
 * people who only have the portal on screen **watch** (receive only, sound
 * off until they ask). Every pair where at least one side sends gets one
 * RTCPeerConnection, negotiated with the "perfect negotiation" pattern
 * (polite/impolite by connection id), so offers that cross never deadlock.
 * The server only relays signalling (/huddle/:board/:huddle) and keeps the
 * roster and archive; media never touches it.
 *
 * While joined, this browser transcribes its own mic (Web Speech) and sends
 * each finished phrase as a transcript line under the person's name, with
 * interim words as live captions. When someone presses Record, every
 * participant's browser records its own camera + mic and uploads it to the
 * huddle's archive when recording stops or they leave.
 *
 * One joined room at a time (module singleton), so a call survives panning
 * away from the portal; watch rooms belong to the portal on screen.
 *
 * `?fakecam` (dev) sends a drawn test pattern and a quiet tone instead of the
 * camera and mic, so two headless tabs can prove the path end to end.
 */

import { useSyncExternalStore } from "react";
import type { HuddleLine, HuddleWire } from "@foundation/protocol";
import { api, openSocket, uploadFile } from "./api";
import { withWebmDuration } from "../utils/webmDuration";

export interface PeerView {
  id: string;
  name: string;
  color: string;
  sending: boolean;
  muted: boolean;
  camOff: boolean;
  stream: MediaStream | null;
  state: RTCPeerConnectionState | "new";
}

export interface RoomView {
  status: "connecting" | "live" | "closed" | "error";
  error?: string;
  you?: string;
  sending: boolean;
  local: MediaStream | null;
  muted: boolean;
  camOff: boolean;
  peers: PeerView[];
  captions: Array<{ id: string; name: string; text: string }>;
  lines: HuddleLine[];
  recording: { by: string } | null;
  recordingSelf: boolean;
  uploads: number;
  speech: "on" | "off" | "unsupported" | "blocked" | "test";
}

interface Peer extends PeerView {
  pc: RTCPeerConnection | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function speechCtor(): (new () => SpeechRec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const fakeCam = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("fakecam");

export class HuddleRoom {
  private ws: WebSocket | null = null;
  private peers = new Map<string, Peer>();
  private subs = new Set<() => void>();
  private view: RoomView;
  private ice: RTCIceServer[] = [];
  private speechRec: SpeechRec | null = null;
  private captionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastCaption = 0;
  private recorder: { rec: MediaRecorder; chunks: Blob[]; startedAt: number; t0: number } | null = null;
  private stopFake: (() => void) | null = null;
  private closed = false;

  constructor(
    public readonly board: string,
    public readonly huddleId: string,
    public readonly sending: boolean,
    private readonly me: { name: string },
  ) {
    this.view = {
      status: "connecting",
      sending,
      local: null,
      muted: false,
      camOff: false,
      peers: [],
      captions: [],
      lines: [],
      recording: null,
      recordingSelf: false,
      uploads: 0,
      speech: "off",
    };
  }

  // ---------- store ----------

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  snapshot = () => this.view;
  private emit(patch: Partial<RoomView> = {}) {
    this.view = {
      ...this.view,
      ...patch,
      peers: [...this.peers.values()].map(({ id, name, color, sending, muted, camOff, stream, state }) => ({ id, name, color, sending, muted, camOff, stream, state })),
    };
    for (const fn of this.subs) fn();
  }

  // ---------- lifecycle ----------

  async start(opts: { recording?: boolean } = {}) {
    if (this.sending) {
      try {
        const local = fakeCam ? this.fakeStream() : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } }, audio: { echoCancellation: true, noiseSuppression: true } });
        if (this.closed) {
          for (const t of local.getTracks()) t.stop();
          return;
        }
        this.emit({ local });
      } catch (e) {
        this.emit({ status: "error", error: cameraError(e) });
        return;
      }
    }
    // the transcript so far (the live session, if there is one)
    api<{ sessions: Array<{ ended_at: number | null; lines: HuddleLine[] }> }>(`/api/huddles/${this.huddleId}?board=${encodeURIComponent(this.board)}`)
      .then((r) => {
        const live = r.sessions[0] && !r.sessions[0].ended_at ? r.sessions[0].lines : [];
        const seen = new Set(this.view.lines.map((l) => l.id));
        this.emit({ lines: [...live.filter((l) => !seen.has(l.id)), ...this.view.lines].sort((a, b) => a.at - b.at) });
      })
      .catch(() => {});
    void this.connect();
    if (this.sending) {
      this.startSpeech();
      if (opts.recording) this.startRecorder();
    }
  }

  private async connect() {
    let ws: WebSocket;
    try {
      ws = await openSocket(`/huddle/${encodeURIComponent(this.board)}/${encodeURIComponent(this.huddleId)}`, `send=${this.sending ? 1 : 0}`);
    } catch {
      if (!this.closed) this.emit({ status: "error", error: "Couldn't reach the server" });
      return;
    }
    if (this.closed) return void ws.close();
    this.ws = ws;
    ws.onmessage = (e) => void this.onWire(JSON.parse(String(e.data)) as HuddleWire);
    ws.onclose = (e) => {
      if (this.closed) return;
      this.emit({ status: e.code === 4404 ? "error" : "closed", error: e.code === 4404 ? "This huddle was removed" : "Connection lost" });
    };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.stopSpeech();
    this.stopRecorder();
    for (const p of this.peers.values()) p.pc?.close();
    this.peers.clear();
    for (const t of this.view.local?.getTracks() ?? []) t.stop();
    this.stopFake?.();
    for (const t of this.captionTimers.values()) clearTimeout(t);
    this.ws?.close();
    this.emit({ status: "closed", local: null });
  }

  private send(m: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // ---------- signalling ----------

  private async onWire(m: HuddleWire) {
    switch (m.t) {
      case "welcome":
        this.ice = m.ice as RTCIceServer[];
        this.emit({ status: "live", you: m.you });
        for (const p of m.peers) this.addPeer(p.id, p.name, p.color, p.sending);
        this.send({ t: "state", sending: this.sending, muted: this.view.muted, camOff: this.view.camOff });
        break;
      case "peer-joined":
        this.addPeer(m.id, m.name, m.color, m.sending);
        break;
      case "peer-left": {
        const p = this.peers.get(m.id);
        p?.pc?.close();
        this.peers.delete(m.id);
        this.emit({ captions: this.view.captions.filter((c) => c.id !== m.id) });
        break;
      }
      case "peer-state": {
        const p = this.peers.get(m.id);
        if (p) {
          p.muted = Boolean(m.muted);
          p.camOff = Boolean(m.camOff);
          this.emit();
        }
        break;
      }
      case "signal":
        await this.onSignal(m.from, m.data as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit });
        break;
      case "line":
        if (!this.view.lines.some((l) => l.id === m.line.id)) this.emit({ lines: [...this.view.lines, m.line] });
        // a finished phrase replaces that speaker's caption
        break;
      case "caption":
        this.showCaption(m.from, m.name, m.text);
        break;
      case "recording":
        this.emit({ recording: m.on ? { by: m.by } : null });
        if (this.sending) (m.on ? this.startRecorder() : this.stopRecorder());
        break;
    }
  }

  private addPeer(id: string, name: string, color: string, sending: boolean) {
    if (this.peers.has(id)) return;
    const you = this.view.you ?? "";
    const p: Peer = { id, name, color, sending, muted: false, camOff: false, stream: null, state: "new", pc: null, polite: you < id, makingOffer: false, ignoreOffer: false };
    this.peers.set(id, p);
    // a connection only where media flows one way or the other
    if (this.sending || sending) this.connectPeer(p);
    this.emit();
  }

  private connectPeer(p: Peer) {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    p.pc = pc;
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ t: "signal", to: p.id, data: { description: pc.localDescription } });
      } catch (e) {
        console.warn("huddle: offer failed", e);
      } finally {
        p.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => candidate && this.send({ t: "signal", to: p.id, data: { candidate } });
    pc.ontrack = ({ track, streams }) => {
      p.stream = streams[0] ?? p.stream ?? new MediaStream();
      if (!p.stream.getTracks().includes(track)) p.stream.addTrack(track);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      if (pc.connectionState === "failed") pc.restartIce();
      this.emit();
    };
    for (const t of this.view.local?.getTracks() ?? []) pc.addTrack(t, this.view.local!);
  }

  private async onSignal(from: string, data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    const p = this.peers.get(from);
    if (!p) return;
    if (!p.pc) this.connectPeer(p);
    const pc = p.pc!;
    try {
      if (data.description) {
        const collision = data.description.type === "offer" && (p.makingOffer || pc.signalingState !== "stable");
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === "offer") {
          await pc.setLocalDescription();
          this.send({ t: "signal", to: p.id, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!p.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn("huddle: signalling", e);
    }
  }

  // ---------- controls ----------

  setMuted(muted: boolean) {
    for (const t of this.view.local?.getAudioTracks() ?? []) t.enabled = !muted;
    this.emit({ muted });
    this.send({ t: "state", sending: this.sending, muted, camOff: this.view.camOff });
    if (muted) this.stopSpeech();
    else this.startSpeech();
  }

  setCamOff(camOff: boolean) {
    for (const t of this.view.local?.getVideoTracks() ?? []) t.enabled = !camOff;
    this.emit({ camOff });
    this.send({ t: "state", sending: this.sending, muted: this.view.muted, camOff });
  }

  /** ask everyone in the room to record themselves (or stop) */
  setRecording(on: boolean) {
    this.send({ t: "recording", on });
  }

  /** a typed line in the transcript */
  say(text: string) {
    if (!text.trim()) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ t: "line", text, source: "typed" });
    else void api(`/api/huddles/${this.huddleId}/lines`, { method: "POST", json: { board: this.board, text } });
  }

  // ---------- captions and transcript (this browser's own mic) ----------

  private showCaption(id: string, name: string, text: string) {
    const rest = this.view.captions.filter((c) => c.id !== id);
    this.emit({ captions: text ? [...rest, { id, name, text }] : rest });
    clearTimeout(this.captionTimers.get(id));
    this.captionTimers.set(
      id,
      setTimeout(() => this.emit({ captions: this.view.captions.filter((c) => c.id !== id) }), 3500),
    );
  }

  private startSpeech() {
    if (this.speechRec || this.view.muted || this.closed || fakeCam) {
      if (fakeCam) this.emit({ speech: "test" });
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) {
      this.emit({ speech: "unsupported" });
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) {
          this.send({ t: "line", text, source: "speech" });
          this.showCaption(this.view.you ?? "me", this.me.name, "");
        } else interim += `${text} `;
      }
      if (interim && Date.now() - this.lastCaption > 250) {
        this.lastCaption = Date.now();
        this.send({ t: "caption", text: interim.trim() });
        this.showCaption(this.view.you ?? "me", this.me.name, interim.trim());
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.speechRec = null;
        this.emit({ speech: "blocked" });
      }
    };
    rec.onend = () => {
      // the engine stops after silence; keep listening while joined and unmuted
      if (this.speechRec !== rec) return;
      setTimeout(() => {
        if (this.speechRec === rec && !this.closed) {
          try {
            rec.start();
          } catch {
            /* already started */
          }
        }
      }, 250);
    };
    this.speechRec = rec;
    try {
      rec.start();
      this.emit({ speech: "on" });
    } catch {
      this.speechRec = null;
      this.emit({ speech: "unsupported" });
    }
  }

  private stopSpeech() {
    const rec = this.speechRec;
    this.speechRec = null;
    rec?.abort();
    if (this.view.speech === "on") this.emit({ speech: "off" });
  }

  // ---------- recording: each person records themselves ----------

  private startRecorder() {
    const local = this.view.local;
    if (this.recorder || !local || typeof MediaRecorder === "undefined") return;
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(local, { mimeType, videoBitsPerSecond: 700_000 });
    // t0 is the monotonic clock at start; start to stop is the recording's length
    // (it's never paused), written into the WebM so the archive's player can seek.
    const r = { rec, chunks: [] as Blob[], startedAt: Date.now(), t0: performance.now() };
    rec.onstart = () => (r.t0 = performance.now());
    rec.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    rec.onstop = () => void this.upload(r.chunks, rec.mimeType || "video/webm", r.startedAt, performance.now() - r.t0);
    rec.start(5000);
    this.recorder = r;
    this.emit({ recordingSelf: true });
  }

  private stopRecorder() {
    const r = this.recorder;
    this.recorder = null;
    if (r && r.rec.state !== "inactive") r.rec.stop();
    if (this.view.recordingSelf) this.emit({ recordingSelf: false });
  }

  private async upload(chunks: Blob[], mime: string, startedAt: number, durationMs: number) {
    if (!chunks.length) return;
    const endedAt = Date.now();
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const type = mime.split(";")[0];
    const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const name = `huddle-${this.me.name.replace(/\W+/g, "-").toLowerCase()}-${stamp}.${ext}`;
    this.emit({ uploads: this.view.uploads + 1 });
    try {
      // Chrome's WebM has no Duration; write one in. On any failure this is the original bytes.
      const raw = new Blob(chunks, { type });
      const file = new File([ext === "webm" ? await withWebmDuration(raw, durationMs) : raw], name, { type });
      const up = await uploadFile(file, this.board);
      await api(`/api/huddles/${this.huddleId}/recordings`, { method: "POST", json: { board: this.board, fileId: up.id, startedAt, endedAt } });
    } catch (e) {
      console.warn("huddle: recording upload failed", e);
    } finally {
      this.emit({ uploads: this.view.uploads - 1 });
    }
  }

  // ---------- dev: a drawn camera ----------

  private fakeStream(): MediaStream {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 360;
    const g = c.getContext("2d")!;
    const css = getComputedStyle(document.documentElement);
    const tone = (v: string) => css.getPropertyValue(v).trim() || "#325bb4";
    const t0 = performance.now();
    let raf = 0;
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = tone("--color-panel");
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = tone("--color-pulse");
      g.beginPath();
      g.arc(320 + Math.cos(t * 1.3) * 180, 180 + Math.sin(t * 2.1) * 90, 38, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = tone("--color-frost");
      g.font = "600 34px system-ui";
      g.fillText(this.me.name, 28, 58);
      g.font = "500 18px ui-monospace, monospace";
      g.fillText(`test camera · ${t.toFixed(1)} s`, 28, 334);
      raf = window.setTimeout(draw, 66) as unknown as number;
    };
    draw();
    const video = c.captureStream(15);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.02;
    osc.frequency.value = 220 + Math.random() * 220;
    const dest = ac.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    this.stopFake = () => {
      clearTimeout(raf);
      osc.stop();
      void ac.close();
    };
    return new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  }
}

function cameraError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError") return "Camera and mic are blocked — allow them for Foundation in the browser, then join again";
  if (name === "NotFoundError") return "No camera or mic found";
  if (name === "NotReadableError") return "The camera is busy in another app";
  if (!navigator.mediaDevices) return "This window can't reach a camera (it needs https or localhost)";
  return (e as Error)?.message ?? "Couldn't start the camera";
}

// ---------- the one room you're in ----------

let joined: HuddleRoom | null = null;
const joinedSubs = new Set<() => void>();

function emitJoined() {
  for (const fn of joinedSubs) fn();
}

export function joinedRoom() {
  return joined;
}

export function onJoinedChange(fn: () => void) {
  joinedSubs.add(fn);
  return () => joinedSubs.delete(fn);
}

export function useJoinedRoom(): HuddleRoom | null {
  return useSyncExternalStore(onJoinedChange, joinedRoom);
}

export async function joinHuddle(board: string, huddleId: string, me: { name: string }, opts: { recording?: boolean } = {}) {
  if (joined?.huddleId === huddleId && joined.board === board) return joined;
  leaveHuddle();
  const room = new HuddleRoom(board, huddleId, true, me);
  joined = room;
  emitJoined();
  await room.start(opts);
  return room;
}

export function leaveHuddle() {
  const r = joined;
  joined = null;
  r?.stop();
  emitJoined();
}

const closedView: RoomView = {
  status: "closed",
  sending: false,
  local: null,
  muted: false,
  camOff: false,
  peers: [],
  captions: [],
  lines: [],
  recording: null,
  recordingSelf: false,
  uploads: 0,
  speech: "off",
};
const noop = () => () => {};

export function useRoom(room: HuddleRoom | null): RoomView {
  return useSyncExternalStore(room ? room.subscribe : noop, room ? room.snapshot : () => closedView);
}

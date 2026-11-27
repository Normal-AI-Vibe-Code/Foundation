/**
 * A huddle room in the browser: the WebRTC mesh behind a video call.
 *
 * People who **join** send their camera and mic to everyone in the room;
 * people who only have it on screen **watch** (receive only, sound off until
 * they ask). Every pair where at least one side sends gets one
 * RTCPeerConnection, negotiated with the "perfect negotiation" pattern
 * (polite/impolite by connection id), so offers that cross never deadlock.
 * The server only relays signalling (/huddle/:board/:huddle) and keeps the
 * roster and archive; media never touches it.
 *
 * A room is named by `{board, huddleId}`: a grid's card (`board` is the grid),
 * or a ChatForm channel's huddle (`board` is "chat", wherever it is shown: its
 * grid cards are views of the same room, so taking it to a grid never
 * renegotiates). `meta` carries what the call is called and its channel.
 *
 * While joined, this browser transcribes its own mic (Web Speech) and sends
 * each finished phrase as a transcript line under the person's name, with
 * interim words as live captions. When someone presses Record, every
 * participant's browser records its own camera + mic — unless they said
 * "don't record me" — and uploads it to the huddle's archive when recording
 * stops or they leave; a screen they share while recording is recorded too,
 * as a second file.
 *
 * One screen share at a time (the server arbitrates): a second video track on
 * its own MediaStream, announced first so receivers know which stream is the
 * screen. Agents seated in the room answer what's said to them: every client
 * speaks the answer aloud itself (speechSynthesis), which can be muted.
 *
 * One joined room at a time (module singleton), so a call survives moving
 * around Foundation; watch rooms belong to whatever is on screen.
 *
 * `?fakecam` (dev) sends a drawn test pattern and a quiet tone instead of the
 * camera and mic (and a drawn screen instead of getDisplayMedia), so two
 * headless tabs can prove the path end to end.
 */

import { useSyncExternalStore } from "react";
import type { HuddleLine, HuddleWire } from "@foundation/protocol";
import { api, openSocket, uploadFile } from "./api";
import { withWebmDuration } from "../utils/webmDuration";
import { loadChoice, openLocal, openOne, saveChoice, type DeviceKind, type DeviceState } from "./media";

export interface PeerView {
  id: string;
  name: string;
  color: string;
  sending: boolean;
  muted: boolean;
  camOff: boolean;
  /** said "don't record me" */
  noRec: boolean;
  stream: MediaStream | null;
  /** the screen they share, when they do */
  screen: MediaStream | null;
  state: RTCPeerConnectionState | "new";
}

export interface AgentSeat {
  name: string;
  by: string;
  state: "listening" | "thinking" | "talking";
}

export interface RoomView {
  status: "connecting" | "live" | "closed" | "error";
  error?: string;
  you?: string;
  sending: boolean;
  local: MediaStream | null;
  muted: boolean;
  camOff: boolean;
  /** what my microphone and camera are doing (the device chip) */
  mic: DeviceState;
  cam: DeviceState;
  peers: PeerView[];
  captions: Array<{ id: string; name: string; text: string }>;
  lines: HuddleLine[];
  recording: { by: string } | null;
  recordingSelf: boolean;
  uploads: number;
  speech: "on" | "off" | "unsupported" | "blocked" | "test";
  /** who shares a screen now (one at a time) */
  sharing: { id: string; by: string; stream?: string } | null;
  /** my own shared screen */
  screen: MediaStream | null;
  /** I said "don't record me" */
  noRec: boolean;
  agents: AgentSeat[];
  /** the agent this browser is speaking aloud right now */
  talking: string | null;
  /** agents' answers spoken aloud here */
  voice: boolean;
  captionsOn: boolean;
  /** a channel's huddle that ended (the last person left) */
  ended: boolean;
}

/** what a call is called and where it lives, for the chip that follows you (and Back) */
export interface HuddleMeta {
  name?: string;
  /** a ChatForm channel's huddle: its channel */
  channel?: string;
}

interface Peer extends PeerView {
  pc: RTCPeerConnection | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** stream ids announced as this peer's screen */
  screenIds: Set<string>;
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

type Recorder = { rec: MediaRecorder; chunks: Blob[]; startedAt: number; t0: number; kind: "camera" | "screen" };

export class HuddleRoom {
  private ws: WebSocket | null = null;
  private peers = new Map<string, Peer>();
  private subs = new Set<() => void>();
  private view: RoomView;
  private ice: RTCIceServer[] = [];
  private speechRec: SpeechRec | null = null;
  private captionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastCaption = 0;
  private recorders = new Map<Recorder["kind"], Recorder>();
  private stopFake: (() => void) | null = null;
  private stopFakeScreen: (() => void) | null = null;
  private shareWait: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private screenSenders = new Map<string, RTCRtpSender[]>();
  private signals: Promise<void> = Promise.resolve();
  private closed = false;
  /** the stream peers receive my tracks on: one id for the whole call, so a track added later joins the same stream on their side */
  private sendStream: MediaStream | null = null;
  /** a track whose device went away: its senders still hold it, so the next one replaces it */
  private lost: Partial<Record<DeviceKind, MediaStreamTrack>> = {};
  meta: HuddleMeta;

  constructor(
    public readonly board: string,
    public readonly huddleId: string,
    public readonly sending: boolean,
    private readonly me: { name: string },
    meta: HuddleMeta = {},
  ) {
    this.meta = meta;
    this.view = {
      status: "connecting",
      sending,
      local: null,
      muted: false,
      camOff: false,
      mic: { state: "off" },
      cam: { state: "off" },
      peers: [],
      captions: [],
      lines: [],
      recording: null,
      recordingSelf: false,
      uploads: 0,
      speech: "off",
      sharing: null,
      screen: null,
      noRec: false,
      agents: [],
      talking: null,
      voice: sending,
      captionsOn: true,
      ended: false,
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
      peers: [...this.peers.values()].map(({ id, name, color, sending, muted, camOff, noRec, stream, screen, state }) => ({ id, name, color, sending, muted, camOff, noRec, stream, screen, state })),
    };
    for (const fn of this.subs) fn();
  }

  // ---------- lifecycle ----------

  async start(opts: { recording?: boolean } = {}) {
    if (this.sending) {
      // each device on its own: a missing or refused camera never costs the microphone, and the
      // call goes ahead with whatever works (the device chip says what didn't, and asks again)
      let tracks: MediaStreamTrack[];
      let mic: DeviceState;
      let cam: DeviceState;
      if (fakeCam) {
        tracks = this.fakeStream().getTracks();
        mic = { state: "on", label: "Test tone" };
        cam = { state: "on", label: "Test camera" };
      } else ({ tracks, mic, cam } = await openLocal({ mic: true, cam: true }));
      if (this.closed) {
        for (const t of tracks) t.stop();
        return;
      }
      this.sendStream = new MediaStream(tracks);
      for (const t of tracks) this.watchTrack(t.kind === "audio" ? "mic" : "cam", t);
      this.emit({ local: new MediaStream(tracks), mic, cam, muted: mic.state !== "on", camOff: cam.state !== "on" });
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
      if (opts.recording) this.startRecorder("camera");
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
      if (e.code === 4410 || this.view.ended) return this.emit({ status: "closed", ended: true, error: "This huddle has ended" });
      if (e.code === 4403) return this.emit({ status: "error", error: "This huddle belongs to a conversation you're not in" });
      this.emit({ status: e.code === 4404 ? "error" : "closed", error: e.code === 4404 ? "This huddle was removed" : "Connection lost" });
    };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.stopSpeech();
    this.stopRecorder();
    this.hush();
    for (const p of this.peers.values()) p.pc?.close();
    this.peers.clear();
    for (const t of this.sendStream?.getTracks() ?? []) t.stop();
    for (const t of this.view.local?.getTracks() ?? []) t.stop();
    for (const t of this.view.screen?.getTracks() ?? []) t.stop();
    this.stopFake?.();
    this.stopFakeScreen?.();
    for (const t of this.captionTimers.values()) clearTimeout(t);
    this.ws?.close();
    this.emit({ status: "closed", local: null, screen: null });
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
        for (const p of m.peers) this.addPeer(p.id, p.name, p.color, p.sending, p.noRec);
        this.send({ t: "state", sending: this.sending, muted: this.view.muted, camOff: this.view.camOff });
        if (this.view.noRec) this.send({ t: "optout", on: true });
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
          if (m.noRec !== undefined) p.noRec = Boolean(m.noRec);
          this.emit();
        }
        break;
      }
      case "signal": {
        // one at a time, in order: a candidate handled while the description before it is still being set is lost
        const data = m.data as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
        this.signals = this.signals.then(() => this.onSignal(m.from, data)).catch(() => {});
        break;
      }
      case "line":
        if (!this.view.lines.some((l) => l.id === m.line.id)) this.emit({ lines: [...this.view.lines, m.line] });
        break;
      case "caption":
        this.showCaption(m.from, m.name, m.text);
        break;
      case "recording":
        this.emit({ recording: m.on ? { by: m.by } : null });
        if (this.sending) {
          if (m.on) {
            this.startRecorder("camera");
            if (this.view.screen) this.startRecorder("screen");
          } else this.stopRecorder();
        }
        break;
      case "sharing":
        this.onSharing(m);
        break;
      case "agents":
        this.emit({ agents: m.agents });
        break;
      case "agent-says":
        this.speakAloud(m.name, m.text);
        break;
      case "agent-hush":
        this.hush();
        break;
      case "ended":
        this.emit({ ended: true });
        break;
    }
  }

  private addPeer(id: string, name: string, color: string, sending: boolean, noRec = false) {
    if (this.peers.has(id)) return;
    const you = this.view.you ?? "";
    const p: Peer = { id, name, color, sending, muted: false, camOff: false, noRec, stream: null, screen: null, state: "new", pc: null, polite: you < id, makingOffer: false, ignoreOffer: false, screenIds: new Set() };
    if (this.view.sharing?.id === id && this.view.sharing.stream) p.screenIds.add(this.view.sharing.stream);
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
      const s = streams[0];
      if (s && p.screenIds.has(s.id)) {
        p.screen = s;
        track.onended = () => {
          if (p.screen === s) p.screen = null;
          this.emit();
        };
      } else {
        p.stream = s ?? p.stream ?? new MediaStream();
        if (!p.stream.getTracks().includes(track)) p.stream.addTrack(track);
      }
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      if (pc.connectionState === "failed") pc.restartIce();
      this.emit();
    };
    const send = this.sendStream;
    if (send) for (const t of send.getTracks()) pc.addTrack(t, send);
    // a screen I'm sharing reaches whoever arrives later too
    const scr = this.view.screen;
    if (scr) this.screenSenders.set(p.id, scr.getTracks().map((t) => pc.addTrack(t, scr)));
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
    // unmuting with no microphone yet: ask for one (a person's press)
    if (!muted && !this.sendStream?.getAudioTracks().length) return void this.retryDevice("mic");
    for (const t of this.view.local?.getAudioTracks() ?? []) t.enabled = !muted;
    this.emit({ muted });
    this.send({ t: "state", sending: this.sending, muted, camOff: this.view.camOff });
    if (muted) this.stopSpeech();
    else this.startSpeech();
  }

  setCamOff(camOff: boolean) {
    if (!camOff && !this.sendStream?.getVideoTracks().length) return void this.retryDevice("cam");
    for (const t of this.view.local?.getVideoTracks() ?? []) t.enabled = !camOff;
    this.emit({ camOff });
    this.send({ t: "state", sending: this.sending, muted: this.view.muted, camOff });
  }

  // ---------- devices ----------

  /** use another microphone or camera: the new one replaces the old for everyone, no renegotiation */
  async useDevice(kind: DeviceKind, deviceId: string) {
    if (!this.sending || fakeCam) return;
    saveChoice({ [kind]: deviceId });
    const { track, state } = await openOne(kind, deviceId, true);
    if (this.closed) return void track?.stop();
    if (!track) return this.emit({ [kind]: state });
    this.attach(kind, track);
  }

  /** ask for a device again (after it was blocked, busy or missing, or to turn it on): a person's press */
  async retryDevice(kind: DeviceKind) {
    if (!this.sending || fakeCam) return;
    const { track, state } = await openOne(kind, loadChoice()[kind]);
    if (this.closed) return void track?.stop();
    if (!track) return this.emit({ [kind]: state });
    this.attach(kind, track, true);
  }

  private attach(kind: DeviceKind, track: MediaStreamTrack, turnOn = false) {
    const send = (this.sendStream ??= new MediaStream());
    const old = (kind === "mic" ? send.getAudioTracks() : send.getVideoTracks())[0];
    const prev = old ?? this.lost[kind];
    delete this.lost[kind];
    const muted = kind === "mic" && turnOn ? false : this.view.muted;
    const camOff = kind === "cam" && turnOn ? false : this.view.camOff;
    track.enabled = kind === "mic" ? !muted : !camOff;
    for (const p of this.peers.values()) {
      if (!p.pc || p.pc.connectionState === "closed") continue;
      const sender = prev ? p.pc.getSenders().find((x) => x.track === prev) : undefined;
      if (sender) void sender.replaceTrack(track).catch((e) => console.warn("huddle: replace track", e));
      else p.pc.addTrack(track, send);
    }
    if (old) {
      send.removeTrack(old);
      old.onended = null;
      old.stop();
    }
    send.addTrack(track);
    this.watchTrack(kind, track);
    const changed = muted !== this.view.muted || camOff !== this.view.camOff;
    this.emit({ local: new MediaStream(send.getTracks()), [kind]: { state: "on", label: track.label, deviceId: track.getSettings().deviceId }, muted, camOff });
    if (changed) this.send({ t: "state", sending: this.sending, muted, camOff });
    if (kind === "mic" && !muted) this.startSpeech();
    // a recording of the old tracks ends with them; the next part starts on the new ones
    const r = this.recorders.get("camera");
    if (r) {
      this.recorders.delete("camera");
      if (r.rec.state !== "inactive") r.rec.stop();
      this.startRecorder("camera");
    } else if (this.view.recording && !this.view.noRec) this.startRecorder("camera");
  }

  /** a device unplugged (or taken by the system): say so, and keep its senders for the next one */
  private watchTrack(kind: DeviceKind, track: MediaStreamTrack) {
    track.onended = () => {
      if (this.closed || !this.sendStream?.getTracks().includes(track)) return;
      this.sendStream.removeTrack(track);
      this.lost[kind] = track;
      const patch: Partial<RoomView> = { local: new MediaStream(this.sendStream.getTracks()), [kind]: { state: "none", message: `The ${kind === "mic" ? "microphone" : "camera"} was disconnected. Pick another, or plug it back in and press Ask again.` } };
      if (kind === "mic") patch.muted = true;
      else patch.camOff = true;
      this.emit(patch);
      this.send({ t: "state", sending: this.sending, muted: this.view.muted, camOff: this.view.camOff });
      if (kind === "mic") this.stopSpeech();
    };
  }

  /** ask everyone in the room to record themselves (or stop) */
  setRecording(on: boolean) {
    this.send({ t: "recording", on });
  }

  /** "don't record me": my recorder never starts (and stops now if it runs); everyone sees I opted out */
  setNoRec(on: boolean) {
    this.emit({ noRec: on });
    this.send({ t: "optout", on });
    if (on) this.stopRecorder();
    else if (this.view.recording && this.sending) {
      this.startRecorder("camera");
      if (this.view.screen) this.startRecorder("screen");
    }
  }

  /** a typed line in the transcript */
  say(text: string) {
    if (!text.trim()) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ t: "line", text, source: "typed" });
    else void api(`/api/huddles/${this.huddleId}/lines`, { method: "POST", json: { board: this.board, text } });
  }

  setCaptions(on: boolean) {
    this.emit({ captionsOn: on });
  }

  /** agents' answers, spoken aloud in this browser (or not) */
  setVoice(on: boolean) {
    if (!on) this.hush();
    this.emit({ voice: on });
  }

  // ---------- screen share ----------

  /** share a screen (one per room: refused while someone else shares, with who) */
  async startShare(): Promise<void> {
    if (!this.sending || this.view.screen) return;
    const screen = fakeCam ? this.fakeScreen() : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    if (this.closed) return void screen.getTracks().forEach((t) => t.stop());
    try {
      await new Promise<void>((resolve, reject) => {
        this.shareWait = { resolve, reject };
        this.send({ t: "share", on: true, stream: screen.id });
        setTimeout(() => reject(new Error("The server didn't answer")), 5000);
      });
    } catch (e) {
      screen.getTracks().forEach((t) => t.stop());
      this.stopFakeScreen?.();
      throw e;
    } finally {
      this.shareWait = null;
    }
    for (const t of screen.getVideoTracks()) t.onended = () => this.stopShare();
    this.emit({ screen });
    for (const p of this.peers.values()) {
      if (!p.pc) continue;
      this.screenSenders.set(p.id, screen.getTracks().map((t) => p.pc!.addTrack(t, screen)));
    }
    if (this.view.recording && !this.view.noRec) this.startRecorder("screen");
  }

  stopShare() {
    const screen = this.view.screen;
    if (!screen) return;
    const r = this.recorders.get("screen");
    if (r) {
      this.recorders.delete("screen");
      if (r.rec.state !== "inactive") r.rec.stop();
    }
    for (const [id, senders] of this.screenSenders) {
      const pc = this.peers.get(id)?.pc;
      for (const s of senders) {
        try {
          pc?.removeTrack(s);
        } catch {
          /* closed */
        }
      }
    }
    this.screenSenders.clear();
    screen.getTracks().forEach((t) => t.stop());
    this.stopFakeScreen?.();
    this.stopFakeScreen = null;
    this.send({ t: "share", on: false });
    this.emit({ screen: null });
  }

  private onSharing(m: Extract<HuddleWire, { t: "sharing" }>) {
    const you = this.view.you;
    if (this.shareWait) {
      if (m.id === you) this.shareWait.resolve();
      else if (m.id) this.shareWait.reject(new Error(`${m.by} is sharing their screen`));
    }
    if (m.id && m.stream) this.peers.get(m.id)?.screenIds.add(m.stream);
    if (!m.id) for (const p of this.peers.values()) p.screen = null;
    this.emit({ sharing: m.id && m.by ? { id: m.id, by: m.by, ...(m.stream ? { stream: m.stream } : {}) } : null });
  }

  // ---------- agents ----------

  /** seat an agent in the room (a person's press) */
  inviteAgent(name: string) {
    return api(`/api/huddles/${this.huddleId}/agents`, { method: "POST", json: { board: this.board, name } });
  }
  dismissAgent(name: string) {
    return api(`/api/huddles/${this.huddleId}/agents`, { method: "POST", json: { board: this.board, name, remove: true } });
  }
  /** Stop: the agent's turn ends and everyone stops speaking it */
  stopAgents() {
    this.hush();
    this.send({ t: "agent-stop" });
  }

  private speakAloud(name: string, text: string) {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!this.view.voice || !synth || typeof SpeechSynthesisUtterance === "undefined") {
      // no voice here: the avatar still talks for as long as it would take to say
      this.emit({ talking: name });
      const ms = Math.min(20_000, 800 + (text.split(/\s+/).length / 2.6) * 1000);
      setTimeout(() => this.view.talking === name && this.emit({ talking: null }), ms);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    if (voices.length) {
      // each agent its own voice, the same one every time
      let h = 0;
      for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const local = voices.filter((v) => v.lang?.startsWith((navigator.language || "en").slice(0, 2)));
      const pool = local.length ? local : voices;
      u.voice = pool[h % pool.length];
    }
    u.onstart = () => this.emit({ talking: name });
    u.onend = u.onerror = () => this.view.talking === name && this.emit({ talking: null });
    synth.speak(u);
  }

  private hush() {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* no voice */
    }
    if (this.view.talking) this.emit({ talking: null });
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

  // ---------- recording: each person records themselves (and the screen they share) ----------

  private startRecorder(kind: Recorder["kind"]) {
    const stream = kind === "camera" ? this.view.local : this.view.screen;
    if (this.view.noRec || this.recorders.has(kind) || !stream?.getTracks().length || typeof MediaRecorder === "undefined") return;
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: kind === "screen" ? 1_200_000 : 700_000 });
    // t0 is the monotonic clock at start; start to stop is the recording's length
    // (it's never paused), written into the WebM so the archive's player can seek.
    const r: Recorder = { rec, chunks: [], startedAt: Date.now(), t0: performance.now(), kind };
    rec.onstart = () => (r.t0 = performance.now());
    rec.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    rec.onstop = () => void this.upload(r.chunks, rec.mimeType || "video/webm", r.startedAt, performance.now() - r.t0, kind);
    rec.start(5000);
    this.recorders.set(kind, r);
    this.emit({ recordingSelf: true });
  }

  private stopRecorder() {
    for (const r of this.recorders.values()) if (r.rec.state !== "inactive") r.rec.stop();
    this.recorders.clear();
    if (this.view.recordingSelf) this.emit({ recordingSelf: false });
  }

  private async upload(chunks: Blob[], mime: string, startedAt: number, durationMs: number, kind: Recorder["kind"]) {
    if (!chunks.length) return;
    const endedAt = Date.now();
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const type = mime.split(";")[0];
    const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const name = `huddle-${this.me.name.replace(/\W+/g, "-").toLowerCase()}${kind === "screen" ? "-screen" : ""}-${stamp}.${ext}`;
    this.emit({ uploads: this.view.uploads + 1 });
    try {
      // Chrome's WebM has no Duration; write one in. On any failure this is the original bytes.
      const raw = new Blob(chunks, { type });
      const file = new File([ext === "webm" ? await withWebmDuration(raw, durationMs) : raw], name, { type });
      // a channel's huddle: a chat upload (it opens for the channel's readers); a grid's: that grid's
      const up = await uploadFile(file, this.board);
      await api(`/api/huddles/${this.huddleId}/recordings`, { method: "POST", json: { board: this.board, fileId: up.id, startedAt, endedAt, kind } });
    } catch (e) {
      console.warn("huddle: recording upload failed", e);
    } finally {
      this.emit({ uploads: this.view.uploads - 1 });
    }
  }

  // ---------- dev: a drawn camera, a drawn screen ----------

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

  private fakeScreen(): MediaStream {
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 720;
    const g = c.getContext("2d")!;
    const css = getComputedStyle(document.documentElement);
    const tone = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
    const t0 = performance.now();
    let timer = 0;
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = tone("--color-abyss", "white");
      g.fillRect(0, 0, 1280, 720);
      g.strokeStyle = tone("--color-line-strong", "gray");
      for (let x = 0; x < 1280; x += 80) g.strokeRect(x, 0, 80, 720);
      g.fillStyle = tone("--color-agent", "purple");
      g.fillRect(140 + Math.sin(t) * 60, 200, 420, 240);
      g.fillStyle = tone("--color-frost", "black");
      g.font = "600 40px system-ui";
      g.fillText(`${this.me.name}'s screen`, 60, 100);
      timer = window.setTimeout(draw, 100) as unknown as number;
    };
    draw();
    const s = c.captureStream(10);
    this.stopFakeScreen = () => clearTimeout(timer);
    return s;
  }
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

// the browser checks read the joined call's state (like __chatform)
if (typeof window !== "undefined") (window as unknown as { __huddle?: () => RoomView | null }).__huddle = () => joined?.snapshot() ?? null;

export function useJoinedRoom(): HuddleRoom | null {
  return useSyncExternalStore(onJoinedChange, joinedRoom);
}

export async function joinHuddle(board: string, huddleId: string, me: { name: string }, opts: { recording?: boolean; meta?: HuddleMeta } = {}) {
  if (joined?.huddleId === huddleId && joined.board === board) {
    if (opts.meta) joined.meta = { ...joined.meta, ...opts.meta };
    return joined;
  }
  leaveHuddle();
  const room = new HuddleRoom(board, huddleId, true, me, opts.meta);
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

/** the room a grid's huddle card stands for: its own, or (a view of a channel's huddle) the channel's on board "chat" */
export function roomOfCard(panel: { id: string; home?: "chat" }, boardId: string): { board: string; huddleId: string } {
  return { board: panel.home === "chat" ? "chat" : boardId, huddleId: panel.id };
}

const closedView: RoomView = {
  status: "closed",
  sending: false,
  local: null,
  muted: false,
  camOff: false,
  mic: { state: "off" },
  cam: { state: "off" },
  peers: [],
  captions: [],
  lines: [],
  recording: null,
  recordingSelf: false,
  uploads: 0,
  speech: "off",
  sharing: null,
  screen: null,
  noRec: false,
  agents: [],
  talking: null,
  voice: false,
  captionsOn: true,
  ended: false,
};
const noop = () => () => {};

export function useRoom(room: HuddleRoom | null): RoomView {
  return useSyncExternalStore(room ? room.subscribe : noop, room ? room.snapshot : () => closedView);
}

/**
 * Recording a voice or video note (2026-11-25, Josh: "where you can leave a short video note for someone to
 * play back"). The logic, apart from the page: which format the browser can record, the time cap, the wave,
 * and the state machine
 *
 *   idle → asking → ready → recording → review → leaving → left
 *                                    ↘ failed (no device, refused, upload failed: the clip is kept)
 *
 * The microphone or camera is opened only by `record()`, which only a person's press of Record calls
 * (NoteRecorder.tsx): never on mount, hover or when the recorder opens. Every track is stopped when the
 * recording stops, on discard, on close, and on failure, so the browser's recording light goes out.
 *
 * Everything the browser gives is passed in (`RecorderEnv`), so the tests drive it with fakes.
 */

import { MEDIA_NOTE_MAX_MS } from "@foundation/protocol";

export type NoteKind = "audio" | "video";
export type RecState = "idle" | "asking" | "ready" | "recording" | "review" | "leaving" | "left" | "failed";

/** what the person can do next is said in a sentence; `stage` says whether a clip is kept to try again */
export interface RecFailure {
  stage: "open" | "record" | "upload";
  text: string;
}

export interface Clip {
  blob: Blob;
  mime: string;
  ms: number;
  peaks?: number[];
}

export interface RecSnapshot {
  state: RecState;
  kind: NoteKind;
  /** ms recorded so far (recording), or the clip's length (review on) */
  elapsed: number;
  /** the live camera or microphone, while it's open (a video note shows it as it records) */
  stream: MediaStream | null;
  clip: Clip | null;
  failure: RecFailure | null;
  /** the recent loudness (0..1), for the live meter */
  level: number;
}

/** the one thing a MediaRecorder must be for this file */
export interface RecorderLike {
  state: string;
  mimeType: string;
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface Meter {
  /** loudness now, 0..1 (RMS of the latest samples) */
  level(): number;
  close(): void;
}

export interface RecorderEnv {
  getUserMedia?(c: MediaStreamConstraints): Promise<MediaStream>;
  isTypeSupported(type: string): boolean;
  makeRecorder(stream: MediaStream, mimeType: string | undefined, kind: NoteKind): RecorderLike;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  /** a loudness meter on the stream's sound, or null where the browser can't */
  meter?(stream: MediaStream): Meter | null;
  /** write a WebM's duration in (Chrome's has none), so the player can seek */
  fixDuration?(blob: Blob, ms: number): Promise<Blob>;
}

/** the formats tried, best first. WebKit (Safari, the Mac app) records mp4; Chrome and Firefox WebM */
export const MIME_CHOICES: Record<NoteKind, string[]> = {
  audio: ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"],
  video: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"],
};

/** the first format this browser can record, or undefined (the recorder then picks its own) */
export function pickMime(kind: NoteKind, isTypeSupported: (t: string) => boolean): string | undefined {
  for (const t of MIME_CHOICES[kind]) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      /* an old isTypeSupported throws on what it doesn't know */
    }
  }
  return undefined;
}

/** the type a file is stored as: no codecs */
export const baseMime = (mime: string) => mime.split(";")[0].trim();

export const capMs = (kind: NoteKind) => MEDIA_NOTE_MAX_MS[kind];
/** the countdown shows for the last stretch */
export const COUNTDOWN_MS = 10_000;
/** how long is left, and whether the countdown shows */
export function timeLeft(kind: NoteKind, elapsed: number): { left: number; countdown: boolean } {
  const left = Math.max(0, capMs(kind) - elapsed);
  return { left, countdown: left <= COUNTDOWN_MS };
}

/** 0:42, 4:05 (ms → m:ss); whole seconds, rounded down so the end reads its length */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const PEAK_STEPS = 48;
/**
 * The drawn wave: the loudness samples taken while recording, folded into `steps` (the loudest in each), then
 * scaled so the loudest is 1 (on a square-root curve). A silent step keeps a hairline (0.04). Two decimals: it
 * is shared on the card.
 */
export function normalizePeaks(levels: ArrayLike<number>, steps = PEAK_STEPS): number[] | undefined {
  const n = levels.length;
  if (!n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a = Math.floor((i * n) / steps);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / steps));
    let m = 0;
    for (let j = a; j < b && j < n; j++) {
      const v = Math.abs(Number(levels[j]) || 0);
      if (v > m) m = v;
    }
    out.push(m);
  }
  const top = Math.max(...out);
  // on a square-root curve, as the ear hears it: one loud click doesn't flatten the rest of the voice
  return out.map((v) => Math.round(Math.max(0.04, top > 0 ? Math.sqrt(Math.min(1, v / top)) : 0) * 100) / 100);
}

/** a decoded clip's samples, as loudness per slice (RMS), for `normalizePeaks` */
export function samplesToLevels(samples: Float32Array, slices = PEAK_STEPS * 4): number[] {
  const out: number[] = [];
  const per = Math.max(1, Math.floor(samples.length / slices));
  for (let i = 0; i < samples.length; i += per) {
    let sum = 0;
    const end = Math.min(samples.length, i + per);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    out.push(Math.sqrt(sum / (end - i)));
  }
  return out;
}

/** "Voice note · Josh" */
export function noteName(kind: NoteKind, byName: string): string {
  const who = byName.trim().split(/\s+/)[0] || "someone";
  return `${kind === "audio" ? "Voice" : "Video"} note · ${who}`;
}

/** the file's name: voice-note-josh-2026-11-25-14-32.webm */
export function noteFileName(kind: NoteKind, byName: string, at: number, mime: string): string {
  const who = byName.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "someone";
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
  const ext = /mp4/.test(mime) ? (kind === "audio" ? "m4a" : "mp4") : /ogg/.test(mime) ? "ogg" : "webm";
  return `${kind === "audio" ? "voice" : "video"}-note-${who}-${stamp}.${ext}`;
}

/** the voice note's card: a player, not a picture */
export const VOICE_CARD = { w: 320, h: 100, minW: 240, maxW: 560 } as const;
/** a video note's card: the clip at its own shape, 280 on its long side by default */
export function videoCardSize(vw: number, vh: number): { w: number; h: number } {
  if (!(vw > 0 && vh > 0)) return { w: 320, h: 180 };
  const long = 320;
  const k = long / Math.max(vw, vh);
  return { w: Math.max(160, Math.round(vw * k)), h: Math.max(120, Math.round(vh * k)) };
}
export const VIDEO_CARD = { min: 160, max: 720 } as const;

/** "Josh · 14:32, Tue" (today and this week), "Josh · 14:32, 3 Nov" (older) */
export function whoWhen(byName: string, at: number, now = Date.now()): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const week = now - at < 6 * 86_400_000;
  const day = week ? d.toLocaleDateString("en-GB", { weekday: "short" }) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const who = byName.trim().split(/\s+/)[0] || "Someone";
  return `${who} · ${hm}, ${day}`;
}

/** what the browser's refusal means, in a sentence that says what to do */
export function openFailure(kind: NoteKind, e: unknown, secure = true): string {
  const dev = kind === "audio" ? "microphone" : "camera";
  const name = (e as { name?: string } | null)?.name ?? "";
  if (!secure) return `This page can't open a ${dev}: recording needs a secure page (https, or this computer's own address).`;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
    return `The ${dev} was refused. Allow it for Foundation in the browser's site settings (the icon left of the address), or in System Settings → Privacy → ${kind === "audio" ? "Microphone" : "Camera"} on a Mac, then press Record again.`;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError")
    return kind === "audio" ? "No microphone was found. Plug one in or choose one in your system's sound settings, then press Record again." : "No camera was found. Connect one, then press Record again, or leave a voice note instead.";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
    return `The ${dev} is in use by another app, or couldn't start. Close what's using it, then press Record again.`;
  return `The ${dev} didn't open${(e as Error)?.message ? `: ${(e as Error).message}` : ""}. Press Record to try again.`;
}

export interface LeaveResult {
  fileId: string;
}

/**
 * One note's recording, from Record to Leave. Listen with `subscribe`; read `snap`.
 */
export class NoteRecording {
  snap: RecSnapshot;
  private listeners = new Set<(s: RecSnapshot) => void>();
  private rec: RecorderLike | null = null;
  private chunks: Blob[] = [];
  private levels: number[] = [];
  private meter: Meter | null = null;
  private tick: unknown = null;
  private t0 = 0;
  private discarding = false;
  private closed = false;
  /** bumped by every record/discard/close: a late answer from an earlier one is let go */
  private run = 0;

  constructor(
    private env: RecorderEnv,
    kind: NoteKind = "audio",
  ) {
    this.snap = { state: "idle", kind, elapsed: 0, stream: null, clip: null, failure: null, level: 0 };
  }

  subscribe(fn: (s: RecSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<RecSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  /** voice or video: only before recording starts */
  choose(kind: NoteKind) {
    if (this.snap.state !== "idle" && !(this.snap.state === "failed" && this.snap.failure?.stage === "open")) return;
    this.emit({ kind, state: "idle", failure: null });
  }

  /** the person pressed Record: only now is the microphone (and camera) asked for */
  async record(): Promise<void> {
    const s = this.snap.state;
    if (this.closed || !(s === "idle" || s === "review" || (s === "failed" && this.snap.failure?.stage !== "upload"))) return;
    this.dropClip();
    const run = ++this.run;
    const kind = this.snap.kind;
    if (!this.env.getUserMedia) {
      this.emit({ state: "failed", failure: { stage: "open", text: openFailure(kind, null, false) } });
      return;
    }
    this.emit({ state: "asking", failure: null, elapsed: 0, level: 0 });
    let stream: MediaStream;
    try {
      stream = await this.env.getUserMedia(
        kind === "audio"
          ? { audio: { echoCancellation: true, noiseSuppression: true } }
          : { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } },
      );
    } catch (e) {
      if (run === this.run) this.emit({ state: "failed", failure: { stage: "open", text: openFailure(kind, e) } });
      return;
    }
    // closed, discarded or started again while the browser asked: this stream is let go at once
    if (run !== this.run || this.closed) {
      stopTracks(stream);
      return;
    }
    this.emit({ state: "ready", stream });
    try {
      const mime = pickMime(kind, this.env.isTypeSupported);
      const rec = this.env.makeRecorder(stream, mime, kind);
      this.rec = rec;
      this.chunks = [];
      this.levels = [];
      this.discarding = false;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      rec.onerror = () => {
        if (run !== this.run) return;
        this.release();
        this.emit({ state: "failed", failure: { stage: "record", text: "The recording stopped by itself. Press Record to try again." } });
      };
      rec.onstop = () => void this.finished(run, rec.mimeType || mime || (kind === "audio" ? "audio/webm" : "video/webm"));
      this.meter = this.env.meter?.(stream) ?? null;
      rec.start(1000);
      this.t0 = this.env.now();
      this.emit({ state: "recording", elapsed: 0 });
      this.tick = this.env.setInterval(() => this.onTick(), 100);
    } catch (e) {
      this.release();
      this.emit({ state: "failed", failure: { stage: "record", text: `This browser couldn't record ${kind === "audio" ? "sound" : "video"} here${(e as Error)?.message ? ` (${(e as Error).message})` : ""}.` } });
    }
  }

  private onTick() {
    if (this.snap.state !== "recording") return;
    const elapsed = this.env.now() - this.t0;
    const level = this.meter ? this.meter.level() : 0;
    if (this.meter) this.levels.push(level);
    this.emit({ elapsed, level });
    if (elapsed >= capMs(this.snap.kind)) this.stop();
  }

  /** Stop: the clip goes to review */
  stop() {
    if (this.snap.state !== "recording" || !this.rec) return;
    this.snap = { ...this.snap, elapsed: Math.min(capMs(this.snap.kind), this.env.now() - this.t0) };
    this.stopTick();
    try {
      if (this.rec.state !== "inactive") this.rec.stop();
      else void this.finished(this.run, this.rec.mimeType);
    } catch {
      void this.finished(this.run, this.rec.mimeType);
    }
    // the light goes out now, not when the last chunk lands
    this.releaseStream();
  }

  private async finished(run: number, mime: string) {
    const ms = this.snap.elapsed;
    this.rec = null;
    this.release();
    if (run !== this.run || this.discarding || this.closed) return;
    const type = baseMime(mime) || (this.snap.kind === "audio" ? "audio/webm" : "video/webm");
    let blob = new Blob(this.chunks, { type });
    this.chunks = [];
    if (!blob.size) {
      this.emit({ state: "failed", failure: { stage: "record", text: "Nothing was recorded. Press Record to try again." } });
      return;
    }
    if (/webm/.test(type) && this.env.fixDuration) blob = await this.env.fixDuration(blob, ms);
    if (run !== this.run || this.closed) return;
    const peaks = this.snap.kind === "audio" ? normalizePeaks(this.levels) : undefined;
    this.emit({ state: "review", clip: { blob, mime: type, ms, peaks }, level: 0 });
  }

  /** throw it away: nothing is kept, nothing is sent */
  discard() {
    this.run++;
    this.discarding = true;
    this.stopTick();
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    this.chunks = [];
    this.release();
    this.dropClip();
    this.emit({ state: "idle", elapsed: 0, failure: null, level: 0 });
  }

  /** the wave was missing (no meter here): read it from the clip itself */
  setPeaks(peaks: number[] | undefined) {
    if (!this.snap.clip || !peaks) return;
    this.emit({ clip: { ...this.snap.clip, peaks } });
  }

  /**
   * Leave it here: `send` uploads the clip and places the card; it throws when the upload fails, and then the
   * clip is kept and `leave` can be pressed again (Try again).
   */
  async leave(send: (clip: Clip) => Promise<LeaveResult>): Promise<LeaveResult | null> {
    const clip = this.snap.clip;
    const s = this.snap.state;
    if (!clip || !(s === "review" || (s === "failed" && this.snap.failure?.stage === "upload"))) return null;
    this.emit({ state: "leaving", failure: null });
    try {
      const r = await send(clip);
      if (this.closed) return r;
      this.emit({ state: "left" });
      return r;
    } catch (e) {
      if (!this.closed)
        this.emit({ state: "failed", failure: { stage: "upload", text: `It didn't upload${(e as Error)?.message ? ` (${(e as Error).message})` : ""}. Your recording is still here: try again.` } });
      return null;
    }
  }

  /** the recorder is put away: whatever is open is closed */
  close() {
    this.closed = true;
    this.run++;
    this.discarding = true;
    this.stopTick();
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    this.release();
    this.listeners.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** a clip waits to be left (closing would lose it) */
  get holdsClip(): boolean {
    return !!this.snap.clip && this.snap.state !== "left";
  }

  private dropClip() {
    if (this.snap.clip) this.snap = { ...this.snap, clip: null };
  }

  private stopTick() {
    if (this.tick !== null) this.env.clearInterval(this.tick);
    this.tick = null;
  }

  private releaseStream() {
    const st = this.snap.stream;
    if (st) stopTracks(st);
    if (st) this.emit({ stream: null });
  }

  private release() {
    this.stopTick();
    this.meter?.close();
    this.meter = null;
    this.releaseStream();
  }
}

export function stopTracks(stream: MediaStream) {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* gone */
    }
  }
}

// ---------- the browser's own ----------

/** the real browser, for the page (tests make their own) */
export function browserEnv(): RecorderEnv {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  const MR = typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined;
  return {
    getUserMedia: md?.getUserMedia ? (c) => md.getUserMedia(c) : undefined,
    isTypeSupported: (t) => !!MR && MR.isTypeSupported(t),
    makeRecorder: (stream, mimeType, kind) => {
      if (!MR) throw new Error("no MediaRecorder");
      const opts: MediaRecorderOptions = { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000, ...(kind === "video" ? { videoBitsPerSecond: 900_000 } : {}) };
      return new MR(stream, opts) as unknown as RecorderLike;
    },
    now: () => performance.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    meter: (stream) => audioMeter(stream),
    fixDuration: async (blob, ms) => (await import("../utils/webmDuration")).withWebmDuration(blob, ms),
  };
}

type AC = typeof AudioContext;
function audioContextCtor(): AC | undefined {
  const w = globalThis as unknown as { AudioContext?: AC; webkitAudioContext?: AC };
  return w.AudioContext ?? w.webkitAudioContext;
}

/** RMS loudness of the stream's sound, through an AnalyserNode */
export function audioMeter(stream: MediaStream): Meter | null {
  const Ctor = audioContextCtor();
  if (!Ctor || !stream.getAudioTracks().length) return null;
  try {
    const ctx = new Ctor();
    void ctx.resume?.().catch(() => {});
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    return {
      level() {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.min(1, Math.sqrt(sum / buf.length) * 4);
      },
      close() {
        try {
          src.disconnect();
        } catch {
          /* gone */
        }
        void ctx.close().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

/** a clip's wave read from the clip itself (where no meter ran while recording) */
export async function peaksFromBlob(blob: Blob): Promise<number[] | undefined> {
  const Ctor = audioContextCtor();
  if (!Ctor) return undefined;
  const ctx = new Ctor();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    return normalizePeaks(samplesToLevels(audio.getChannelData(0)));
  } catch {
    return undefined;
  } finally {
    void ctx.close().catch(() => {});
  }
}

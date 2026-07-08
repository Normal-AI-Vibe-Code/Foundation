/**
 * Synthesized interaction sounds — no assets, pure WebAudio.
 * Every sound is a tiny envelope over oscillators/filtered noise, kept
 * quiet and short so the app feels tactile rather than noisy.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;

function ac(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

// resume on the first user gesture (autoplay policy)
if (typeof window !== "undefined") {
  const unlock = () => {
    ac();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

function noise(): AudioBuffer | null {
  const a = ac();
  if (!a) return null;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

interface ToneOpts {
  type?: OscillatorType;
  from: number;
  to?: number;
  dur: number;
  gain?: number;
  delay?: number;
  glideExp?: boolean;
}

function tone({ type = "sine", from, to, dur, gain = 1, delay = 0 }: ToneOpts) {
  const a = ac();
  if (!a || muted || !master) return;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function hiss(opts: { dur: number; gain?: number; freq?: number; q?: number; delay?: number; sweepTo?: number }) {
  const a = ac();
  if (!a || muted || !master) return;
  const buf = noise();
  if (!buf) return;
  const t0 = a.currentTime + (opts.delay ?? 0);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.setValueAtTime(opts.freq ?? 2000, t0);
  if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + opts.dur);
  f.Q.value = opts.q ?? 1.2;
  const g = a.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(opts.gain ?? 0.5, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + opts.dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + opts.dur + 0.02);
}

export const sfx = {
  setMuted(v: boolean) {
    muted = v;
  },
  isMuted() {
    return muted;
  },

  /** faint tick — selection, context level changes, menu open */
  tick() {
    hiss({ dur: 0.03, gain: 0.25, freq: 5200, q: 2 });
    tone({ from: 1900, dur: 0.03, gain: 0.12, type: "triangle" });
  },

  /** creating / placing something new — warm pop up */
  pop(pitch = 1) {
    tone({ from: 340 * pitch, to: 660 * pitch, dur: 0.11, gain: 0.5, type: "sine" });
    hiss({ dur: 0.05, gain: 0.2, freq: 3200 });
  },

  /** docking / dropping into place — low thunk */
  drop() {
    tone({ from: 220, to: 110, dur: 0.1, gain: 0.55, type: "sine" });
    hiss({ dur: 0.035, gain: 0.28, freq: 900, q: 0.8 });
  },

  /** picking up / floating — light pluck upward */
  lift() {
    tone({ from: 500, to: 860, dur: 0.09, gain: 0.32, type: "triangle" });
  },

  /** camera snap navigation — soft airy whoosh */
  whoosh() {
    hiss({ dur: 0.22, gain: 0.22, freq: 700, sweepTo: 2400, q: 0.7 });
  },

  /** wire connected — two quick rising notes */
  connect() {
    tone({ from: 620, dur: 0.07, gain: 0.35, type: "sine" });
    tone({ from: 930, dur: 0.1, gain: 0.35, type: "sine", delay: 0.07 });
  },

  /** wire disconnected — falling note */
  disconnect() {
    tone({ from: 720, to: 320, dur: 0.14, gain: 0.35, type: "sine" });
  },

  /** deleting — descending double-knock */
  trash() {
    tone({ from: 340, to: 160, dur: 0.09, gain: 0.45, type: "square" });
    tone({ from: 200, to: 90, dur: 0.12, gain: 0.4, type: "sine", delay: 0.06 });
    hiss({ dur: 0.08, gain: 0.2, freq: 1400, delay: 0.02 });
  },

  /** structure change (split / new section) — paired pops */
  split() {
    tone({ from: 420, to: 560, dur: 0.07, gain: 0.4 });
    tone({ from: 560, to: 760, dur: 0.09, gain: 0.4, delay: 0.075 });
  },

  /** committing a cell edit — soft key thock */
  thock() {
    tone({ from: 1150, to: 700, dur: 0.045, gain: 0.3, type: "triangle" });
    hiss({ dur: 0.025, gain: 0.22, freq: 2600 });
  },

  /** recording started — gentle rising chirp */
  recordOn() {
    tone({ from: 520, to: 1040, dur: 0.14, gain: 0.34, type: "sine" });
  },

  /** recording stopped */
  recordOff() {
    tone({ from: 1040, to: 520, dur: 0.14, gain: 0.3, type: "sine" });
  },

  /** command understood — small two-note chime */
  chime() {
    tone({ from: 880, dur: 0.1, gain: 0.35 });
    tone({ from: 1320, dur: 0.16, gain: 0.3, delay: 0.09 });
  },

  /** command not understood — flat buzz */
  nope() {
    tone({ from: 220, dur: 0.12, gain: 0.3, type: "square" });
    tone({ from: 196, dur: 0.14, gain: 0.28, type: "square", delay: 0.1 });
  },
};

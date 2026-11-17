/**
 * @pacific/ui/orb — the agent's presence (ADR-031).
 *
 * A soft, frosted-glass orb of blurred colour that changes shape and hue and
 * answers sound. One fragment shader on the GPU, drawn at a fraction of the
 * screen's resolution (the orb is all blur, so it loses nothing and costs a
 * quarter as much), with a transparent background so it floats over paper or
 * the camera.
 *
 * Moods blend on springs, never cut:
 * - idle: a slow-breathing capsule, amber to white, lit from below;
 * - listening: cooler, blue and violet, swelling with the voice it hears;
 * - thinking: a teal-green field turning inside a rounder glass;
 * - speaking: warm orange and pink, round, banded like a waveform by its
 *   own voice.
 *
 * References: the board in `references.ts` (05, 07, 08, 12, 14, 17, 18, 19).
 * Without WebGL2, `createOrb` returns null and `OrbFallback` CSS shows
 * instead; under reduced motion the orb breathes slowly and does not wobble.
 */
import { createShaderSurface, type ShaderSurface } from "./gl";
import { Spring, presets } from "./motion";

export type OrbMood = "idle" | "listening" | "thinking" | "speaking";

export interface AudioLevels {
  /** overall loudness, 0..1 */
  level: number;
  low: number;
  mid: number;
  high: number;
}

export const SILENCE: AudioLevels = { level: 0, low: 0, mid: 0, high: 0 };

export const ORB_FRAG = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uDpr;
uniform float uTime;
uniform float uLevel;
uniform float uLow;
uniform float uMid;
uniform float uHigh;
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uWobble;  // 0 under reduced motion
uniform float uScale;   // share of the short side the orb fills
out vec4 outColor;

// --- noise ---
vec3 hash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash3(i), f), dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.02; a *= 0.5; }
  return s;
}
float grain(vec2 c, float t) {
  return fract(sin(dot(c + fract(t * 7.0) * 91.7, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

// four palettes, each: shadow, body, light
vec3 pal(int m, int k) {
  // idle: umber, amber, warm white (05, 12)
  if (m == 0) return k == 0 ? vec3(0.28, 0.14, 0.10) : k == 1 ? vec3(0.95, 0.56, 0.22) : vec3(1.0, 0.95, 0.86);
  // listening: indigo, blue, lilac (02, 08, 16)
  if (m == 1) return k == 0 ? vec3(0.20, 0.18, 0.52) : k == 1 ? vec3(0.33, 0.55, 0.95) : vec3(0.86, 0.82, 1.0);
  // thinking: deep teal, green, mint (17)
  if (m == 2) return k == 0 ? vec3(0.05, 0.33, 0.42) : k == 1 ? vec3(0.42, 0.80, 0.45) : vec3(0.88, 0.97, 0.86);
  // speaking: violet, orange-red, pink-gold (07, 18, 19)
  return k == 0 ? vec3(0.45, 0.15, 0.55) : k == 1 ? vec3(1.0, 0.38, 0.20) : vec3(1.0, 0.80, 0.62);
}
vec3 mood(int k, vec4 w) {
  return pal(0, k) * w.x + pal(1, k) * w.y + pal(2, k) * w.z + pal(3, k) * w.w;
}

void main() {
  vec2 frag = gl_FragCoord.xy / uDpr;
  float side = min(uResolution.x, uResolution.y);
  vec2 p = (frag - 0.5 * uResolution) / (0.5 * side * uScale);
  float t = uTime;

  float awake = max(max(uListen, uThink), uSpeak);
  vec4 w = vec4(max(0.0, 1.0 - uListen - uThink - uSpeak), uListen, uThink, uSpeak);
  w /= max(1e-3, w.x + w.y + w.z + w.w);

  // --- shape: a capsule at rest, a sphere when it speaks; breath + voice + wobble ---
  float breath = 0.03 * sin(t * 0.9);
  float swell = 0.10 * uLevel + 0.05 * uLow;
  float n = mix(3.2, 2.0, clamp(uSpeak + uThink * 0.6, 0.0, 1.0)); // superellipse power
  vec2 q = p * vec2(1.0, mix(0.86, 1.0, clamp(uSpeak + uThink, 0.0, 1.0))); // taller capsule at rest
  float r = pow(pow(abs(q.x), n) + pow(abs(q.y), n), 1.0 / n);
  float ang = atan(q.y, q.x);
  float wob = fbm(vec3(cos(ang) * 0.9, sin(ang) * 0.9, t * 0.3)) * (0.05 + 0.18 * uLevel + 0.08 * uThink) * uWobble;
  float radius = 0.78 + breath + swell + wob;
  float d = r - radius;                       // < 0 inside
  float soft = 0.08 + 0.05 * uThink + 0.03 * (1.0 - awake);
  float body = smoothstep(soft, -soft, d);

  // --- colour field: domain-warped, three lights drifting inside ---
  vec3 sp = vec3(p * 1.1, t * 0.08);
  vec2 warp = vec2(fbm(sp + vec3(0.0, 0.0, 3.1)), fbm(sp + vec3(5.2, 1.3, 0.0)));
  vec2 f = p + warp * (0.55 + 0.35 * uThink + 0.25 * uMid);
  // lit from below at rest (05), from within when active
  float lift = clamp(0.55 - f.y * 0.55 + 0.25 * uLevel, 0.0, 1.0);
  vec2 l1 = vec2(sin(t * 0.31), cos(t * 0.23)) * 0.45;
  vec2 l2 = vec2(cos(t * 0.19 + 2.0), sin(t * 0.27 + 1.0)) * 0.5;
  float g1 = exp(-dot(f - l1, f - l1) * 3.0);
  float g2 = exp(-dot(f - l2, f - l2) * 4.0) * (0.6 + 0.8 * uMid);
  vec3 col = mix(mood(0, w), mood(1, w), smoothstep(0.05, 0.75, lift + g1 * 0.35));
  col = mix(col, mood(2, w), smoothstep(0.55, 1.0, lift) * 0.85 + g2 * 0.35);
  col += mood(2, w) * 0.35 * uHigh * g1;

  // --- speaking: bands like a waveform (18), strongest with its own voice ---
  float bands = 0.5 + 0.5 * sin(p.y * (18.0 + 10.0 * uHigh) - t * 3.0 + warp.x * 4.0);
  float slice = mix(1.0, 0.55 + 0.45 * smoothstep(0.05, 0.8, bands), uSpeak * clamp(uLevel * 1.1, 0.0, 0.75));
  col *= mix(1.0, 0.8 + 0.2 * bands, uSpeak * uLevel);

  // --- glass: a hairline rim lit from the top-left, frost toward the edge (08, 17, 19) ---
  float rim = 0.45 * smoothstep(0.06, 0.0, abs(d + 0.07)) * (0.35 + 0.65 * smoothstep(-0.2, 0.9, dot(normalize(p + 1e-4), normalize(vec2(-0.6, 0.8)))));
  float frost = smoothstep(-0.45, 0.0, d);
  col = mix(col, mix(col, vec3(1.0), 0.35), frost * 0.45);
  col += rim * 0.28;

  // --- grain (05, 14, 16) ---
  col += grain(frag, t) * 0.07;

  // --- halo outside the glass ---
  float halo = exp(-max(d, 0.0) * 5.0) * (1.0 - body) * (0.22 + 0.35 * uLevel);
  float alpha = clamp(body * slice + halo, 0.0, 1.0);
  vec3 outc = mix(mood(1, w), col, body);
  outColor = vec4(outc * alpha, alpha); // premultiplied
}`;

/**
 * The presence (ADR-031, 2026-09-29 revision): the agent as the whole
 * background — a blurred, grainy human figure seen from behind and to the
 * side, lit from within (references 14, 16), in a room whose light follows
 * its mood: warm paper at rest, lilac and pink while it listens, frosted blue
 * while it thinks (08), a dusk bloom while it speaks (04). Your voice warms
 * its face; its own voice blooms around it. Opaque: it *is* the background.
 */
export const PRESENCE_FRAG = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uDpr;
uniform float uTime;
uniform float uLevel;
uniform float uLow;
uniform float uMid;
uniform float uHigh;
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uWobble;
uniform float uScale;   // figure size, 1 = fills the lower screen
out vec4 outColor;

vec3 hash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash3(i), f), dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}
float grain(vec2 c, float t) {
  return fract(sin(dot(c + fract(t * 7.0) * 91.7, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}
float sdEllipse(vec2 p, vec2 r) {
  float k = length(p / r);
  return (k - 1.0) * min(r.x, r.y);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// per mood: sky top, sky bottom, head, body, band, glow
vec3 P(int m, int k) {
  if (m == 0) { // rest: warm paper, violet head into peach (14)
    return k == 0 ? vec3(0.92, 0.87, 0.80) : k == 1 ? vec3(0.87, 0.81, 0.73) : k == 2 ? vec3(0.26, 0.15, 0.36)
         : k == 3 ? vec3(0.96, 0.62, 0.46) : k == 4 ? vec3(0.58, 0.34, 0.84) : vec3(1.0, 0.86, 0.72);
  }
  if (m == 1) { // listening: lilac and pink, a blue figure whose face warms (16)
    return k == 0 ? vec3(0.71, 0.65, 0.81) : k == 1 ? vec3(0.89, 0.62, 0.72) : k == 2 ? vec3(0.93, 0.94, 0.98)
         : k == 3 ? vec3(0.34, 0.50, 0.85) : k == 4 ? vec3(0.62, 0.72, 1.0) : vec3(1.0, 0.72, 0.34);
  }
  if (m == 2) { // thinking: frosted blue (08)
    return k == 0 ? vec3(0.90, 0.92, 0.96) : k == 1 ? vec3(0.66, 0.73, 0.84) : k == 2 ? vec3(0.62, 0.78, 0.86)
         : k == 3 ? vec3(0.29, 0.36, 0.72) : k == 4 ? vec3(0.78, 0.90, 0.96) : vec3(0.84, 0.95, 1.0);
  }
  // speaking: a dusk bloom (04), the figure lit amber from within
  return k == 0 ? vec3(0.93, 0.56, 0.40) : k == 1 ? vec3(0.36, 0.24, 0.33) : k == 2 ? vec3(0.99, 0.70, 0.52)
       : k == 3 ? vec3(0.82, 0.33, 0.40) : k == 4 ? vec3(1.0, 0.84, 0.45) : vec3(1.0, 0.94, 0.80);
}
vec3 M(int k, vec4 w) { return P(0, k) * w.x + P(1, k) * w.y + P(2, k) * w.z + P(3, k) * w.w; }

void main() {
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec2 uv = frag / uResolution;                  // 0..1, y up
  vec2 p = (frag - vec2(0.5 * uResolution.x, 0.0)) / uResolution.y * 2.0; // x centred, y 0 at bottom .. 2 at top
  float t = uTime;
  vec4 w = vec4(max(0.0, 1.0 - uListen - uThink - uSpeak), uListen, uThink, uSpeak);
  w /= max(1e-3, w.x + w.y + w.z + w.w);

  // --- the room: a soft vertical light, slowly drifting ---
  float drift = fbm(vec3(uv * 1.4, t * 0.05)) * 0.25;
  vec3 sky = mix(M(1, w), M(0, w), smoothstep(0.0, 1.0, uv.y + drift));

  // --- the figure: head and shoulders from behind, turned a little (14, 16) ---
  float breathe = 1.0 + 0.012 * sin(t * 0.8) * uWobble + 0.035 * uLevel;
  vec2 q = p / (uScale * breathe);
  q.x += 0.04 * sin(t * 0.21) * uWobble;
  vec2 hp = q - vec2(0.06, 1.1);
  float tilt = 0.12 + 0.05 * sin(t * 0.17) * uWobble;
  hp = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * hp;
  float head = sdEllipse(hp, vec2(0.27, 0.36));
  float neck = sdEllipse(q - vec2(0.0, 0.64), vec2(0.15, 0.28));
  float torso = sdEllipse(q - vec2(-0.04, 0.0), vec2(1.02, 0.6));
  float d = smin(smin(head, neck, 0.14), torso, 0.22);
  // the edge breathes and frays: noise in the silhouette, fuzz with the voice (16)
  d += (fbm(vec3(q * 2.2, t * 0.12)) * 0.06 + grain(frag * 0.5, t) * 0.012 * (0.3 + uHigh)) * uWobble;
  float soft = 0.035 + 0.045 * uThink + 0.015 * uListen;
  float body = smoothstep(soft, -soft, d);

  // --- light inside the figure: head colour into body colour, a band sweeping across (14) ---
  vec3 fp = vec3(q * 1.3, t * 0.07);
  vec2 warp = vec2(fbm(fp), fbm(fp + vec3(4.1, 2.3, 0.0)));
  float up = smoothstep(0.35, 1.25, q.y + warp.y * 0.35);
  vec3 col = mix(M(3, w), M(2, w), up);
  float s = dot(q + warp * 0.4, normalize(vec2(0.55, -0.83))) - 0.25 * sin(t * 0.23);
  col = mix(col, M(4, w), exp(-s * s * 7.0) * (0.55 + 0.3 * uMid));
  // the face, turned away from us, warms with the voice it hears or speaks (16)
  vec2 face = (hp - vec2(0.13, -0.05)) * vec2(1.0, 0.72);
  float glow = exp(-dot(face, face) * 13.0) * (0.25 + 1.1 * uLevel * (uListen + uSpeak) + 0.25 * uSpeak);
  col = mix(col, M(5, w), clamp(glow, 0.0, 1.0));
  // frost toward the edge, like light through skin and glass
  col = mix(col, mix(col, sky, 0.5), smoothstep(-0.25, 0.0, d) * 0.5);

  // --- bloom around the figure when it speaks (04) ---
  float halo = exp(-max(d, 0.0) * 3.5) * (1.0 - body);
  sky = mix(sky, M(5, w), halo * (0.12 + 0.55 * uSpeak * (0.4 + uLevel)));

  vec3 outc = mix(sky, col, body);
  outc *= 1.0 - 0.18 * pow(length(uv - vec2(0.5, 0.45)) * 1.2, 2.0);   // a soft vignette
  outc += grain(frag, t) * 0.085;                                         // film grain (05, 14, 16)
  outColor = vec4(outc, 1.0);
}`;

export const ORB_UNIFORMS = [
  "uLevel",
  "uLow",
  "uMid",
  "uHigh",
  "uListen",
  "uThink",
  "uSpeak",
  "uWobble",
  "uScale",
] as const;

/** Attack fast, release slow — how a meter should feel. Pure, so it is testable. */
export function smoothLevel(prev: number, next: number, dt: number, attack = 0.05, release = 0.35): number {
  const tau = next > prev ? attack : release;
  const k = 1 - Math.exp(-dt / tau);
  return prev + (next - prev) * k;
}

/** The mood weights a mood asks for (idle is what is left). */
export function moodTargets(m: OrbMood): { listen: number; think: number; speak: number } {
  return {
    listen: m === "listening" ? 1 : 0,
    think: m === "thinking" ? 1 : 0,
    speak: m === "speaking" ? 1 : 0,
  };
}

export interface Orb {
  setMood(m: OrbMood): void;
  /** feed a fresh reading every frame (or leave a meter attached) */
  setLevels(l: AudioLevels): void;
  /** a function polled each frame for levels, e.g. `() => meter.read()` */
  follow(source: (() => AudioLevels) | null): void;
  resize(): void;
  dispose(): void;
  readonly surface: ShaderSurface;
}

export interface OrbOptions {
  /** share of the canvas' css resolution to render at (the orb is blur: 0.5 is plenty) */
  resolution?: number;
  /** share of the short side the orb fills, 0..1 */
  scale?: number;
  reducedMotion?: boolean;
  /** "orb": a glass orb on a transparent canvas; "presence": the figure that is the whole background */
  variant?: "orb" | "presence";
}

/** Mount an orb (or the presence) into `container`; it fills the container. `null` without WebGL2. */
export function createOrb(container: HTMLElement, opts: OrbOptions = {}): Orb | null {
  const presence = opts.variant === "presence";
  const surface = createShaderSurface(container, presence ? PRESENCE_FRAG : ORB_FRAG, ORB_UNIFORMS, {
    className: "orb-canvas",
    alpha: !presence,
  });
  if (!surface) return null;
  const res = opts.resolution ?? 0.5;
  const reduced =
    opts.reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const listen = new Spring(0, presets.soft);
  const think = new Spring(0, presets.soft);
  const speak = new Spring(0, presets.soft);
  let levels: AudioLevels = { ...SILENCE };
  let target: AudioLevels = { ...SILENCE };
  let source: (() => AudioLevels) | null = null;
  let frame: number | null = null;
  let last = performance.now();
  let disposed = false;

  const resize = () => {
    const r = container.getBoundingClientRect();
    surface.resize(r.width * res, r.height * res);
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  resize();

  const tick = (now: number) => {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (source) target = source();
    levels = {
      level: smoothLevel(levels.level, target.level, dt),
      low: smoothLevel(levels.low, target.low, dt),
      mid: smoothLevel(levels.mid, target.mid, dt),
      high: smoothLevel(levels.high, target.high, dt, 0.03, 0.2),
    };
    surface.draw({
      uLevel: levels.level,
      uLow: levels.low,
      uMid: levels.mid,
      uHigh: levels.high,
      uListen: listen.value,
      uThink: think.value,
      uSpeak: speak.value,
      uWobble: reduced ? 0 : 1,
      uScale: opts.scale ?? (presence ? 1 : 0.82),
    });
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const pause = () => {
    if (document.hidden && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    } else if (!document.hidden && frame === null && !disposed) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  document.addEventListener("visibilitychange", pause);

  return {
    surface,
    setMood(m) {
      const t = moodTargets(m);
      listen.to(t.listen);
      think.to(t.think);
      speak.to(t.speak);
    },
    setLevels(l) {
      target = l;
    },
    follow(fn) {
      source = fn;
      if (!fn) target = { ...SILENCE };
    },
    resize,
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      ro?.disconnect();
      document.removeEventListener("visibilitychange", pause);
      surface.dispose();
    },
  };
}

/**
 * Loudness and three bands from a live stream (the microphone while
 * listening, the assistant's voice while speaking). Web Audio only; nothing
 * leaves the device.
 */
export class AudioMeter {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private node: MediaStreamAudioSourceNode | null = null;
  private time: Float32Array<ArrayBuffer>;
  private freq: Float32Array<ArrayBuffer>;
  /** the last raw RMS; exactly 0 means digital silence — a muted or switched-off device, not a quiet room */
  lastRms = -1;

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    this.time = new Float32Array(this.analyser.fftSize);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
  }

  /** Measure this stream. Call from a user gesture the first time (iOS needs it to resume audio). */
  attach(stream: MediaStream) {
    this.detach();
    void this.ctx.resume();
    if (stream.getAudioTracks().length === 0) return;
    this.node = this.ctx.createMediaStreamSource(stream);
    this.node.connect(this.analyser);
  }

  detach() {
    this.node?.disconnect();
    this.node = null;
  }

  read(): AudioLevels {
    if (!this.node) return SILENCE;
    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (const s of this.time) sum += s * s;
    const rms = Math.sqrt(sum / this.time.length);
    this.lastRms = rms;
    this.analyser.getFloatFrequencyData(this.freq);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const band = (lo: number, hi: number) => {
      const a = Math.max(1, Math.floor(lo / hz));
      const b = Math.min(this.freq.length - 1, Math.ceil(hi / hz));
      let s = 0;
      for (let i = a; i <= b; i++) s += Math.max(0, (this.freq[i] + 100) / 70); // -100..-30 dB → 0..1
      return Math.min(1, s / Math.max(1, b - a + 1));
    };
    return {
      level: levelFromRms(rms),
      low: band(60, 250),
      mid: band(250, 2000),
      high: band(2000, 8000),
    };
  }

  /** The latest stretch of sound (-1..1, the analyser's time domain), for drawing the voice; null with nothing attached. */
  samples(): Float32Array | null {
    if (!this.node) return null;
    this.analyser.getFloatTimeDomainData(this.time);
    return this.time;
  }

  close() {
    this.detach();
    void this.ctx.close();
  }
}

/** A speaking voice sits around 0.02–0.2 RMS; map that onto 0..1 on a log scale. */
export function levelFromRms(rms: number): number {
  if (rms <= 0.003) return 0;
  const db = 20 * Math.log10(rms); // -50 dB .. 0
  return Math.min(1, Math.max(0, (db + 50) / 40));
}

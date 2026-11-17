/**
 * @pacific/ui/shiba — the agent as an ethereal shiba (ADR-031, revised
 * 2026-09-29 on Josh's direction: "ethereal images of shibas instead of
 * people to be the avatar").
 *
 * Four forms (front, and three profiles) from Josh's images are uploaded once
 * as textures. The shader blurs them far past the source (a 24-tap disc),
 * warps them with slow noise so the animal is never quite still, and melts
 * one form into the next — shape-shifting, never cutting. Each mood grades
 * the same light: the forms' own warm paper at rest, lilac and blue while it
 * listens (the second image), frosted blue while it thinks, a dusk glow while
 * it speaks. When it speaks, soft waves ripple out through the background
 * only, with its voice.
 *
 * The same component shrinks to the bottom bar in camera mode (`compact`),
 * cropped to the head.
 */
import { createShaderSurface, type ShaderSurface } from "./gl";
import { Spring, presets } from "./motion";
import { moodTargets, smoothLevel, SILENCE, type AudioLevels, type OrbMood } from "./orb";
import front from "./assets/front.webp";
import listening from "./assets/listening-profile.webp";
import left from "./assets/profile-left.webp";
import right from "./assets/profile-right.webp";

type ImageModule = string | { src: string };
const url = (m: ImageModule) => (typeof m === "string" ? m : m.src);

/** The forms, in the order the idle shiba drifts through them. */
export const SHIBA_FORMS = [
  { id: "front", src: url(front) },
  { id: "profile-left", src: url(left) },
  { id: "listening", src: url(listening) },
  { id: "profile-right", src: url(right) },
] as const;

/** Which form each mood turns toward (index into SHIBA_FORMS); idle drifts. */
export function formFor(mood: OrbMood, idleIndex: number): number {
  if (mood === "listening") return 2;
  if (mood === "speaking") return 0;
  if (mood === "thinking") return 3;
  return idleIndex;
}

export const SHIBA_FRAG = `#version 300 es
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
uniform float uMorph;     // 0 = form A, 1 = form B
uniform float uAspA;      // image width / height
uniform float uAspB;
uniform float uCompact;   // 1 = the small head in the bottom bar
uniform float uContain;   // 1 = the whole animal in view, the room going on beside it (wide screens)
uniform float uCutout;    // 1 = only the animal: the room is transparent (the shiba over a camera, addendum 10)
uniform float uReady;     // 0 until the textures are in: show only the room
uniform sampler2D uA;
uniform sampler2D uB;
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

// fit a screen uv onto an image of aspect asp, with zoom and focus: cover
// (the phone) fills the screen; contain keeps the whole image in view and the
// room continues past its sides (tap() below)
vec2 fit(vec2 uv, float asp, float zoom, vec2 focus) {
  float sa = uResolution.x / uResolution.y;
  vec2 q = uv - 0.5;
  if ((sa < asp) == (uContain < 0.5)) q.x *= sa / asp; else q.y *= asp / sa;
  return focus + q / zoom;
}

// a soft disc blur: 24 taps on a golden-angle spiral
vec3 bgOf(sampler2D s) {
  return texture(s, vec2(0.03, 0.97)).rgb;
}
// outside the image, the room goes on in its own colour (no clamped smear)
vec3 tap(sampler2D s, vec2 p) {
  vec2 e = min(p, 1.0 - p);
  float inside = smoothstep(0.0, 0.12, min(e.x, e.y));
  // the room continues from the image's own side edges, keeping its vertical light
  float y = clamp(p.y, 0.02, 0.98);
  vec3 room = 0.5 * (texture(s, vec2(0.015, y)).rgb + texture(s, vec2(0.985, y)).rgb);
  return mix(room, texture(s, clamp(p, 0.0, 1.0)).rgb, inside);
}
vec3 blurred(sampler2D s, vec2 p, float r) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float rr = sqrt((fi + 0.5) / 24.0) * r;
    float a = fi * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * rr;
    float w = 1.0 - 0.5 * (rr / max(r, 1e-4));
    acc += tap(s, p + o) * w;
    wsum += w;
  }
  return acc / wsum;
}

// per mood: shadow, body, light (a gradient map for grading the forms)
vec3 G(int m, int k) {
  if (m == 1) return k == 0 ? vec3(0.36, 0.40, 0.78) : k == 1 ? vec3(0.64, 0.66, 0.96) : vec3(0.97, 0.80, 0.86); // listening: blue, lilac, pink
  if (m == 2) return k == 0 ? vec3(0.28, 0.36, 0.66) : k == 1 ? vec3(0.66, 0.78, 0.92) : vec3(0.93, 0.95, 0.98); // thinking: frost
  return k == 0 ? vec3(0.36, 0.16, 0.44) : k == 1 ? vec3(0.93, 0.42, 0.42) : vec3(1.0, 0.82, 0.62);            // speaking: dusk
}
vec3 gradeMap(int m, float l) {
  return l < 0.5 ? mix(G(m, 0), G(m, 1), l * 2.0) : mix(G(m, 1), G(m, 2), (l - 0.5) * 2.0);
}

void main() {
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec2 uv = frag / uResolution;
  float t = uTime;
  float morphing = sin(3.14159 * clamp(uMorph, 0.0, 1.0));

  // --- shape-shifting: a slow warp, stronger mid-morph and with the voice ---
  vec3 wp = vec3(uv * 2.1, t * 0.11);
  vec2 warp = vec2(fbm(wp), fbm(wp + vec3(5.2, 1.7, 0.0)));
  float amp = (0.016 + 0.04 * morphing + 0.035 * uLevel + 0.012 * uThink) * uWobble;
  // waves: when it speaks, the room ripples out from the animal
  vec2 centre = vec2(0.5, mix(0.55, 0.5, uCompact));
  vec2 dv = (uv - centre) * vec2(uResolution.x / uResolution.y, 1.0);
  float dist = length(dv);
  float ring = sin(dist * 15.0 - t * 3.2) * exp(-dist * 0.9);
  float speakAmp = uSpeak * (0.2 + 0.9 * uLevel);
  vec2 ripple = normalize(dv + 1e-4) * ring * 0.006 * speakAmp;
  vec2 p = uv + (warp - 0.5) * amp + ripple;
  float breathe = 1.0 + 0.012 * sin(t * 0.7) * uWobble + 0.03 * uLevel;
  float zoom = mix(0.84, 1.45, uCompact) * breathe;
  vec2 focus = mix(vec2(0.5, 0.44), vec2(0.5, 0.62), uCompact);

  // --- the two forms, blurred well past the source ---
  float r = (0.02 + 0.012 * uThink + 0.012 * morphing - 0.006 * uLevel) / zoom * mix(1.0, 1.4, uCompact);
  vec3 a = blurred(uA, fit(p, uAspA, zoom, focus), r);
  // the second form only while melting: at rest uB is uA, and its 24 taps would be the same work twice
  vec3 b = uMorph > 0.0 ? blurred(uB, fit(p, uAspB, zoom, focus), r) : a;
  vec3 bgA = bgOf(uA);
  vec3 bgB = bgOf(uB);
  float m = smoothstep(0.0, 1.0, uMorph);
  vec3 col = mix(a, b, m);
  vec3 bg = mix(bgA, bgB, m);
  float figure = smoothstep(0.05, 0.24, length(col - bg));

  // --- grade by mood: the forms' own colour at rest ---
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 graded = gradeMap(1, lum) * uListen + gradeMap(2, lum) * uThink + gradeMap(3, lum) * uSpeak;
  float gw = uListen + uThink + uSpeak;
  col = mix(col, graded / max(gw, 1e-3), clamp(gw, 0.0, 1.0) * (0.62 * uListen + 0.5 * uThink + 0.38 * uSpeak) / max(gw, 1e-3));
  bg = mix(bg, gradeMap(1, 0.92) * uListen + gradeMap(2, 0.95) * uThink + gradeMap(3, 0.88) * uSpeak + bg * (1.0 - gw), clamp(gw, 0.0, 1.0) * 0.6);

  // --- light: the voice lifts the animal from within; the waves wash the room ---
  vec3 lightCol = gradeMap(3, 0.95) * uSpeak + gradeMap(1, 0.95) * uListen + vec3(1.0, 0.9, 0.8) * (1.0 - uSpeak - uListen);
  col += lightCol * figure * uLevel * 0.22;
  vec3 waveTint = gradeMap(3, 0.52);
  col = mix(col, waveTint, (1.0 - figure) * smoothstep(0.2, 1.0, ring) * speakAmp * 0.45);
  col = mix(col, lightCol, (1.0 - figure) * smoothstep(0.2, 1.0, -ring) * speakAmp * 0.18);

  // before the forms arrive, only the room
  col = mix(mix(vec3(0.93, 0.88, 0.82), bg, uReady), col, uReady);
  col += grain(frag, t) * 0.07;
  float vign = 1.0 - 0.14 * pow(length(uv - 0.5) * 1.3, 2.0) * (1.0 - uCompact);
  // cut out: the animal alone, the room gone (premultiplied)
  float keep = mix(1.0, smoothstep(0.1, 0.6, figure) * uReady, uCutout);
  outColor = vec4(col * vign * keep, keep);
}`;

export const SHIBA_UNIFORMS = [
  "uLevel",
  "uLow",
  "uMid",
  "uHigh",
  "uListen",
  "uThink",
  "uSpeak",
  "uWobble",
  "uMorph",
  "uAspA",
  "uAspB",
  "uCompact",
  "uContain",
  "uCutout",
  "uReady",
] as const;

/** Seconds a form holds before drifting to the next, and how long the melt takes. */
export const HOLD_S = 11;
export const MORPH_S = 3.4;

export interface Shiba {
  setMood(m: OrbMood): void;
  setLevels(l: AudioLevels): void;
  follow(source: (() => AudioLevels) | null): void;
  dispose(): void;
  readonly surface: ShaderSurface;
}

/** Mount the shiba into `container`, filling it. `null` without WebGL2 (show the CSS fallback). */
export function createShiba(
  container: HTMLElement,
  opts: {
    compact?: boolean;
    resolution?: number;
    reducedMotion?: boolean;
    /** "cover" fills the screen (the phone); "contain" keeps the whole animal in a wide view (Vision Code) */
    fit?: "cover" | "contain";
    /** only the animal, on a transparent ground (over a camera) */
    cutout?: boolean;
    /**
     * Draw at most this many frames a second. The shiba moves slowly (it holds
     * a form for seconds), so a phone can draw it at 30 and keep its GPU and
     * battery for the camera; unset, it draws at the display's rate.
     */
    maxFps?: number;
  } = {},
): Shiba | null {
  const surface = createShaderSurface(container, SHIBA_FRAG, SHIBA_UNIFORMS, { className: "orb-canvas", alpha: !!opts.cutout });
  if (!surface) return null;
  const res = opts.resolution ?? (opts.compact ? 0.75 : 0.5);
  const reduced =
    opts.reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const listen = new Spring(0, presets.soft);
  const think = new Spring(0, presets.soft);
  const speak = new Spring(0, presets.soft);
  let mood: OrbMood = "idle";
  let levels: AudioLevels = { ...SILENCE };
  let target: AudioLevels = { ...SILENCE };
  let source: (() => AudioLevels) | null = null;
  const aspects = SHIBA_FORMS.map(() => 0.75);
  let ready = 0;
  let loaded = 0;
  // forms: `a` shown, `b` arriving; `morph` 0..1 while melting
  let a = 0;
  let b = 0;
  let morph = 0;
  let idle = 0;
  let held = 0;
  let frame: number | null = null;
  let last = performance.now();
  let disposed = false;

  SHIBA_FORMS.forEach((f, i) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (disposed) return;
      surface.setTexture(i, img);
      aspects[i] = img.naturalWidth / Math.max(1, img.naturalHeight);
      loaded++;
    };
    img.src = f.src;
  });
  surface.setSampler("uA", 0);
  surface.setSampler("uB", 0);

  const resize = () => {
    const r = container.getBoundingClientRect();
    surface.resize(r.width * res, r.height * res);
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  resize();

  const minFrameMs = opts.maxFps && opts.maxFps > 0 ? 1000 / opts.maxFps : 0;
  const tick = (now: number) => {
    if (disposed) return;
    // a frame early for the cap: wait for the next, drawing nothing (2 ms slack for a display's jitter)
    if (minFrameMs && now - last < minFrameMs - 2) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (source) target = source();
    levels = {
      level: smoothLevel(levels.level, target.level, dt),
      low: smoothLevel(levels.low, target.low, dt),
      mid: smoothLevel(levels.mid, target.mid, dt),
      high: smoothLevel(levels.high, target.high, dt, 0.03, 0.2),
    };
    if (loaded === SHIBA_FORMS.length) ready = Math.min(1, ready + dt / 1.2);

    // choose where to go: the mood's form, or the next one after a long hold at rest
    held += dt;
    if (morph === 0) {
      const want = mood === "idle" && held > HOLD_S ? (idle = (a + 1) % SHIBA_FORMS.length) : formFor(mood, idle);
      if (want !== a && !reduced) {
        b = want;
        morph = 0.0001;
      }
    } else {
      morph = Math.min(1, morph + dt / MORPH_S);
      if (morph >= 1) {
        a = b;
        morph = 0;
        held = 0;
      }
    }
    surface.setSampler("uA", a);
    surface.setSampler("uB", morph > 0 ? b : a);
    surface.draw({
      uLevel: levels.level,
      uLow: levels.low,
      uMid: levels.mid,
      uHigh: levels.high,
      uListen: listen.value,
      uThink: think.value,
      uSpeak: speak.value,
      uWobble: reduced ? 0 : 1,
      uMorph: morph,
      uAspA: aspects[a],
      uAspB: aspects[morph > 0 ? b : a],
      uCompact: opts.compact ? 1 : 0,
      uContain: opts.fit === "contain" ? 1 : 0,
      uCutout: opts.cutout ? 1 : 0,
      uReady: ready,
    });
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  // drawn only while it can be seen: not with the app in the background, and not while its screen is
  // hidden (a phone keeps Now mounted under the other tabs so a walk carries on, and its full-screen
  // shiba went on drawing there unseen)
  let onScreen = true;
  const pause = () => {
    const show = !document.hidden && onScreen && !disposed;
    if (!show && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    } else if (show && frame === null) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  document.addEventListener("visibilitychange", pause);
  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
          pause();
        })
      : null;
  io?.observe(container);

  return {
    surface,
    setMood(m) {
      mood = m;
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
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", pause);
      surface.dispose();
    },
  };
}

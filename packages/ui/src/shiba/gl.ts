/**
 * @pacific/ui/gl — the WebGL side of the design language (ADR-013).
 *
 * Small, dependency-free helpers both apps use for shader surfaces and
 * particles: compile a program, run a fragment shader over a fullscreen
 * triangle, and a field of drifting motes. Every surface is a `<canvas>`
 * behind ordinary DOM; when WebGL2 is missing the factory returns `null` and
 * the CSS underneath simply shows (the motion budget in `./motion` decides
 * whether to even try).
 *
 * Rules the helpers enforce: device-pixel ratio capped at 2; a fresh canvas
 * per instance (a lost context never comes back on the same canvas); context
 * loss stops the loop instead of throwing; `dispose()` releases the context.
 */

/** Static previews render only after a change. Multiple invalidations share one frame. */
export function createDemandRenderer(draw: () => void) {
  let frame: number | null = null;
  let disposed = false;
  return {
    invalidate() {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!disposed) draw();
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

/**
 * Keep a three.js view through a lost context. The system takes a WebGL context back when the Mac sleeps or switches
 * GPU, or when a page holds too many; three.js asks for it again on the same canvas, but what it drew into render
 * targets (the room's light, the shadows) doesn't come back with it, so the view is left blank or half-lit. `rebuild`
 * runs once the context is restored, or, if it stays lost while the canvas is on screen, at the next check: the caller
 * makes the view again on a fresh canvas. Returns the unsubscribe; call it before disposing the view.
 */
export function keepThroughContextLoss(canvas: HTMLCanvasElement, rebuild: () => void, every = 1500) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let done = false;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const go = () => {
    if (done) return;
    done = true;
    stop();
    rebuild();
  };
  const lost = () => {
    stop();
    // a hidden view waits until it's shown again, so it doesn't push a shown one's context out
    timer = setInterval(() => {
      if (canvas.isConnected && canvas.offsetParent !== null && canvas.clientWidth > 0) go();
    }, every);
  };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", go);
  return () => {
    done = true;
    stop();
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", go);
  };
}

/** The one vertex shader every fullscreen surface uses: a triangle that covers the clip space. */
export const FULLSCREEN_VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * The paper floor Vision's canvas stands on: warm paper (navy by night), film
 * grain, a camera-synced dot grid, a soft light under the pointer, a ripple
 * from the last click, a vignette. One fragment shader, one triangle.
 */
export const PAPER_FRAG = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec2 uOffset;     // camera translation (css px)
uniform float uScale;     // camera zoom
uniform vec2 uPointer;    // pointer in css px (surface-local)
uniform float uPointerIn; // 0..1 pointer presence
uniform vec2 uClick;      // last click position (css px)
uniform float uClickT;    // seconds since last click (large = none)
uniform float uTime;
uniform float uDpr;
uniform float uNight;     // 0 = paper, 1 = navy night (the design language's engine)
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 css = gl_FragCoord.xy / uDpr;
  css.y = uResolution.y - css.y; // flip to top-left origin

  // ----- paper base (void #f6f3ec by day, #0a111f by night) with a soft diagonal tint -----
  vec3 paper = mix(vec3(0.965, 0.953, 0.925), vec3(0.039, 0.067, 0.122), uNight);
  float diag = (css.x / uResolution.x + css.y / uResolution.y) * 0.5;
  paper -= diag * 0.012 * (1.0 - uNight * 0.8);

  // ----- film grain (animated subtly) -----
  float g = hash(css + floor(uTime * 2.0) * 17.0);
  paper += (g - 0.5) * 0.018;

  // ----- dot grid in world space (moves with camera) -----
  vec2 world = (css - uOffset) / uScale;
  float spacing = 28.0;
  vec2 cell = mod(world, spacing) - spacing * 0.5;
  float distToDot = length(cell) * uScale;
  float dotR = 1.1 * clamp(uScale, 0.5, 1.6);
  float dot_ = 1.0 - smoothstep(dotR - 0.7, dotR + 0.7, distToDot);
  // fade dots out when zoomed way out
  float gridFade = smoothstep(0.25, 0.5, uScale);
  vec3 dotColor = mix(vec3(0.72, 0.71, 0.69), vec3(0.24, 0.29, 0.38), uNight);
  paper = mix(paper, dotColor, dot_ * 0.55 * gridFade);

  // ----- pointer light: a soft warm glow that follows the cursor -----
  float d = length(css - uPointer);
  float light = exp(-d * d / (2.0 * 220.0 * 220.0)) * 0.05 * uPointerIn;
  paper += light;
  // brighten dots near pointer for a "magnetic" feel
  float near = exp(-d * d / (2.0 * 140.0 * 140.0)) * uPointerIn;
  paper = mix(paper, mix(vec3(0.42, 0.40, 0.38), vec3(0.58, 0.64, 0.74), uNight), dot_ * near * 0.5 * gridFade);

  // ----- click ripple: an expanding ring that lights the dots it crosses -----
  float cd = length(css - uClick);
  float ringR = uClickT * 900.0;
  float ring = exp(-pow(cd - ringR, 2.0) / (2.0 * 60.0 * 60.0));
  float ringFade = exp(-uClickT * 2.6);
  paper = mix(paper, mix(vec3(0.35, 0.33, 0.30), vec3(0.33, 0.72, 0.93), uNight), dot_ * ring * ringFade * 0.8 * gridFade);
  paper += ring * ringFade * 0.02;

  // ----- vignette -----
  vec2 uv = css / uResolution;
  float vig = smoothstep(1.25, 0.45, length(uv - 0.5) * 1.35);
  paper *= mix(0.965, 1.0, vig);

  outColor = vec4(paper, 1.0);
}`;

/** The names the paper shader expects; `createShaderSurface` looks them up once. */
export const PAPER_UNIFORMS = [
  "uResolution",
  "uOffset",
  "uScale",
  "uPointer",
  "uPointerIn",
  "uClick",
  "uClickT",
  "uTime",
  "uDpr",
  "uNight",
] as const;

/** Device pixel ratio, capped: beyond 2 the grain and blur cost more than they show. */
export function cappedDpr(): number {
  return Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 2);
}

/** The engine's night factor as the CSS transition currently has it (0 = paper). */
export function readNight(): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--night");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Compile and link; logs and returns `null` on failure so callers fall back to CSS. */
export function compileProgram(
  gl: WebGL2RenderingContext,
  vert: string,
  frag: string,
): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("shader compile:", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vert);
  const fs = compile(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("shader link:", gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

/** A uniform value: one float, or a vec2/vec3/vec4 as an array. */
export type UniformValue = number | readonly [number, number] | readonly [number, number, number];

export interface ShaderSurface {
  readonly canvas: HTMLCanvasElement;
  /** size the buffer to css px × dpr; repaints synchronously so a resize never shows black */
  resize(cssW: number, cssH: number): void;
  /** draw one frame with these uniforms (`uResolution`, `uDpr` and `uTime` are filled in) */
  draw(uniforms: Record<string, UniformValue>): void;
  /** true once the context was lost; the surface stays quiet after that */
  readonly lost: boolean;
  /** upload an image to texture unit `unit` (linear, clamped, flipped so y is up) */
  setTexture(unit: number, source: TexImageSource): void;
  /** point a sampler2D uniform at a texture unit */
  setSampler(name: string, unit: number): void;
  dispose(): void;
}

/**
 * A fragment shader over a fullscreen triangle in its own `<canvas>`, prepended
 * to `container` (so DOM after it stacks on top). `null` when WebGL2 is not
 * there — leave the CSS background in place and carry on.
 */
export function createShaderSurface(
  container: HTMLElement,
  frag: string,
  uniformNames: readonly string[],
  opts: { className?: string; alpha?: boolean } = {},
): ShaderSurface | null {
  const canvas = document.createElement("canvas");
  canvas.className = opts.className ?? "gl-surface";
  container.prepend(canvas);
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: false,
    stencil: false,
    alpha: opts.alpha ?? false,
    premultipliedAlpha: true,
    powerPreference: "high-performance",
  });
  if (!gl) {
    canvas.remove();
    return null;
  }
  const program = compileProgram(gl, FULLSCREEN_VERT, frag);
  if (!program) {
    canvas.remove();
    return null;
  }
  gl.useProgram(program);
  const locs = new Map<string, WebGLUniformLocation | null>();
  for (const n of new Set([...uniformNames, "uResolution", "uDpr", "uTime"])) {
    locs.set(n, gl.getUniformLocation(program, n));
  }
  // core-profile semantics want a VAO bound even with no attributes
  gl.bindVertexArray(gl.createVertexArray());
  const start = performance.now();
  let lost = false;
  let last: Record<string, UniformValue> = {};
  const textures = new Map<number, WebGLTexture>();
  const samplers = new Map<string, WebGLUniformLocation | null>();
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
  });

  const setUniform = (name: string, v: UniformValue) => {
    const loc = locs.get(name);
    if (loc === undefined || loc === null) return;
    if (typeof v === "number") gl.uniform1f(loc, v);
    else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    else gl.uniform3f(loc, v[0], v[1], v[2]);
  };

  const draw = (uniforms: Record<string, UniformValue>) => {
    if (lost || canvas.width === 0 || gl.isContextLost()) return;
    last = uniforms;
    const dpr = cappedDpr();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    setUniform("uResolution", [canvas.width / dpr, canvas.height / dpr]);
    setUniform("uDpr", dpr);
    setUniform("uTime", (performance.now() - start) / 1000);
    for (const [k, v] of Object.entries(uniforms)) setUniform(k, v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return {
    canvas,
    get lost() {
      return lost;
    },
    resize(cssW, cssH) {
      const dpr = cappedDpr();
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        // resizing clears the buffer to black and rAF is throttled during an
        // interactive window resize — repaint now so no black frame shows
        draw(last);
      }
    },
    draw,
    setTexture(unit, source) {
      if (lost || gl.isContextLost()) return;
      const tex = textures.get(unit) ?? gl.createTexture();
      if (!tex) return;
      textures.set(unit, tex);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },
    setSampler(name, unit) {
      if (lost || gl.isContextLost()) return;
      let loc = samplers.get(name);
      if (loc === undefined) {
        loc = gl.getUniformLocation(program, name);
        samplers.set(name, loc);
      }
      gl.useProgram(program);
      if (loc) gl.uniform1i(loc, unit);
    },
    dispose() {
      lost = true;
      for (const t of textures.values()) gl.deleteTexture(t);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

// ---------- motes: pollen by day, fireflies by night ----------

const MOTES_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aSeed; // x0 y0 (0..1 of the field), phase, size
uniform vec2 uResolution;
uniform vec2 uOffset;   // camera translation (css px) — motes live in world space
uniform float uScale;
uniform float uTime;
uniform vec2 uPointer;  // css px, surface-local
uniform float uPointerIn;
uniform float uDpr;
uniform float uDrift;   // px per second of wander
out float vFade;
out float vSeed;

void main() {
  float ph = aSeed.z * 6.2831853;
  float t = uTime;
  // wander: two slow sines per axis, each mote on its own phase; a slow rise like warm air
  vec2 world = aSeed.xy * uResolution / max(uScale, 0.0001);
  world.x += sin(t * 0.21 + ph) * uDrift + sin(t * 0.07 + ph * 1.7) * uDrift * 0.6;
  world.y += cos(t * 0.17 + ph * 1.3) * uDrift * 0.7 - mod(t * 6.0 + aSeed.z * 500.0, uResolution.y / max(uScale, 0.0001)) + uResolution.y * 0.5 / max(uScale, 0.0001);
  vec2 css = world * uScale + uOffset;
  // the pointer pushes motes away gently, like a hand through pollen
  vec2 d = css - uPointer;
  float dist = length(d) + 0.0001;
  float push = smoothstep(120.0, 0.0, dist) * 26.0 * uPointerIn;
  css += d / dist * push;
  // wrap inside the surface
  css = mod(css, uResolution);
  vec2 clip = css / uResolution * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  float size = (1.6 + aSeed.w * 2.6) * uDpr * clamp(uScale, 0.6, 1.4);
  gl_PointSize = size * 3.0;
  // each mote breathes on its own phase
  vFade = 0.45 + 0.55 * (0.5 + 0.5 * sin(t * 0.9 + ph * 3.0));
  vSeed = aSeed.w;
}`;

const MOTES_FRAG = `#version 300 es
precision highp float;
in float vFade;
in float vSeed;
uniform float uNight;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;
  // a soft disc with a brighter core
  float a = (1.0 - r) * (1.0 - r);
  float core = smoothstep(0.35, 0.0, r);
  // pollen amber by day (#c47a1e), a cool firefly by night (#54b8ee)
  vec3 day = vec3(0.77, 0.48, 0.12);
  vec3 night = vec3(0.33, 0.72, 0.93);
  vec3 c = mix(day, night, uNight);
  c = mix(c, vec3(1.0), core * 0.5);
  float alpha = a * vFade * uOpacity * mix(0.55, 0.9, uNight);
  outColor = vec4(c * alpha, alpha); // premultiplied
}`;

export interface MotesOptions {
  /** how many motes; 180 reads as pollen in a courtyard, 600 as a snowfall */
  count?: number;
  /** px per second of wander */
  drift?: number;
  className?: string;
}

/**
 * A field of drifting motes rendered as GPU points: pollen and dust in
 * sunlight by day, fireflies by night. They live in world space so a canvas
 * can pass its camera and the motes move with the paper; the pointer pushes
 * them aside. `null` without WebGL2.
 */
export class Motes {
  static create(container: HTMLElement, opts: MotesOptions = {}): Motes | null {
    const canvas = document.createElement("canvas");
    canvas.className = opts.className ?? "gl-surface";
    container.prepend(canvas);
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    if (!gl) {
      canvas.remove();
      return null;
    }
    const program = compileProgram(gl, MOTES_VERT, MOTES_FRAG);
    if (!program) {
      canvas.remove();
      return null;
    }
    return new Motes(canvas, gl, program, opts.count ?? 180, opts.drift ?? 18);
  }

  readonly uniforms = {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    pointerX: -9999,
    pointerY: -9999,
    pointerIn: 0,
    night: 0,
    opacity: 1,
  };
  private locs: Record<string, WebGLUniformLocation | null> = {};
  private start = performance.now();
  private lost = false;

  private constructor(
    readonly canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
    private program: WebGLProgram,
    readonly count: number,
    private drift: number,
  ) {
    gl.useProgram(program);
    for (const n of [
      "uResolution",
      "uOffset",
      "uScale",
      "uTime",
      "uPointer",
      "uPointerIn",
      "uDpr",
      "uDrift",
      "uNight",
      "uOpacity",
    ]) {
      this.locs[n] = gl.getUniformLocation(program, n);
    }
    // one seed per mote: position in the field, a phase and a size, all in 0..1
    const seeds = new Float32Array(count * 4);
    let s = 1234567 + count;
    const rnd = () => {
      // xorshift so a given count always deals the same field (evidence captures repeat)
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) % 100000) / 100000;
    };
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = rnd();
      seeds[i * 4 + 1] = rnd();
      seeds[i * 4 + 2] = rnd();
      seeds[i * 4 + 3] = rnd();
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  resize(cssW: number, cssH: number) {
    const dpr = cappedDpr();
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.draw();
    }
  }

  /** draw one frame from `uniforms`; call from the owner's rAF loop */
  draw() {
    const { gl, program, canvas, locs } = this;
    if (this.lost || canvas.width === 0 || gl.isContextLost()) return;
    const u = this.uniforms;
    const dpr = cappedDpr();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform2f(locs.uResolution, canvas.width / dpr, canvas.height / dpr);
    gl.uniform2f(locs.uOffset, u.offsetX, u.offsetY);
    gl.uniform1f(locs.uScale, u.scale);
    gl.uniform1f(locs.uTime, (performance.now() - this.start) / 1000);
    gl.uniform2f(locs.uPointer, u.pointerX, u.pointerY);
    gl.uniform1f(locs.uPointerIn, u.pointerIn);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uDrift, this.drift);
    gl.uniform1f(locs.uNight, u.night);
    gl.uniform1f(locs.uOpacity, u.opacity);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }

  dispose() {
    this.lost = true;
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }
}

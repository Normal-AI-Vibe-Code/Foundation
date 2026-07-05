/**
 * GPU shader background for each canvas panel.
 *
 * Renders: warm paper base + film grain + camera-synced dot grid
 * + a soft pointer-following light + vignette. All in one fragment shader,
 * one fullscreen triangle, zero draw-call overhead.
 */

const VERT = `#version 300 es
void main() {
  // fullscreen triangle
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec2 uOffset;     // camera translation (css px)
uniform float uScale;     // camera zoom
uniform vec2 uPointer;    // pointer in css px (panel-local)
uniform float uPointerIn; // 0..1 pointer presence
uniform float uTime;
uniform float uDpr;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 css = gl_FragCoord.xy / uDpr;
  css.y = uResolution.y - css.y; // flip to top-left origin

  // ----- paper base with a very soft diagonal tint -----
  vec3 paper = vec3(0.949, 0.945, 0.937);
  float diag = (css.x / uResolution.x + css.y / uResolution.y) * 0.5;
  paper -= diag * 0.012;

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
  vec3 dotColor = vec3(0.72, 0.71, 0.69);
  paper = mix(paper, dotColor, dot_ * 0.55 * gridFade);

  // ----- pointer light: a soft warm glow that follows the cursor -----
  float d = length(css - uPointer);
  float light = exp(-d * d / (2.0 * 220.0 * 220.0)) * 0.05 * uPointerIn;
  paper += light;
  // brighten dots near pointer for a "magnetic" feel
  float near = exp(-d * d / (2.0 * 140.0 * 140.0)) * uPointerIn;
  paper = mix(paper, vec3(0.42, 0.40, 0.38), dot_ * near * 0.5 * gridFade);

  // ----- vignette -----
  vec2 uv = css / uResolution;
  float vig = smoothstep(1.25, 0.45, length(uv - 0.5) * 1.35);
  paper *= mix(0.965, 1.0, vig);

  outColor = vec4(paper, 1.0);
}`;

export interface BackgroundUniforms {
  offsetX: number;
  offsetY: number;
  scale: number;
  pointerX: number;
  pointerY: number;
  pointerIn: number; // eased presence 0..1
}

export class ShaderBackground {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private locs: Record<string, WebGLUniformLocation | null> = {};
  private canvas: HTMLCanvasElement;
  private raf = 0;
  private start = performance.now();
  private disposed = false;

  readonly uniforms: BackgroundUniforms = {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    pointerX: -9999,
    pointerY: -9999,
    pointerIn: 0,
  };

  /** target pointer presence; eased in render loop */
  pointerTarget = 0;

  constructor(container: HTMLElement) {
    // own a fresh canvas per instance — a canvas whose WebGL context was
    // lost (dispose) can never yield a working context again
    const canvas = document.createElement("canvas");
    canvas.className = "gl-bg";
    container.prepend(canvas);
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) return; // graceful fallback: CSS background remains
    this.gl = gl;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("shader compile:", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("shader link:", gl.getProgramInfoLog(prog));
      return;
    }
    this.program = prog;
    gl.useProgram(prog);
    for (const name of [
      "uResolution",
      "uOffset",
      "uScale",
      "uPointer",
      "uPointerIn",
      "uTime",
      "uDpr",
    ]) {
      this.locs[name] = gl.getUniformLocation(prog, name);
    }
    // dummy VAO required by core profile semantics
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    this.loop();
  }

  resize(cssW: number, cssH: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      // resizing the buffer clears it to black, and rAF is throttled during
      // an interactive window resize — repaint synchronously to avoid a
      // black grid while the user drags the window edge
      this.renderFrame();
    }
  }

  private renderFrame() {
    const { gl, program } = this;
    if (!gl || !program || this.canvas.width === 0) return;
    if (gl.isContextLost()) return;
    const u = this.uniforms;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(program);
    gl.uniform2f(this.locs.uResolution, this.canvas.width / dpr, this.canvas.height / dpr);
    gl.uniform2f(this.locs.uOffset, u.offsetX, u.offsetY);
    gl.uniform1f(this.locs.uScale, u.scale);
    gl.uniform2f(this.locs.uPointer, u.pointerX, u.pointerY);
    gl.uniform1f(this.locs.uPointerIn, u.pointerIn);
    gl.uniform1f(this.locs.uTime, (performance.now() - this.start) / 1000);
    gl.uniform1f(this.locs.uDpr, dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private loop = () => {
    if (this.disposed) return;
    // ease pointer presence
    const u = this.uniforms;
    u.pointerIn += (this.pointerTarget - u.pointerIn) * 0.08;
    this.renderFrame();
    this.raf = requestAnimationFrame(this.loop);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const ext = this.gl?.getExtension("WEBGL_lose_context");
    ext?.loseContext();
    this.canvas.remove();
  }
}

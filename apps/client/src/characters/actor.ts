/**
 * A 3D character on stage: a skinned model with a clip per mood, a camera
 * that frames it from the chest up or head to toe, and one renderer that
 * draws every actor into its own element's rectangle.
 *
 * One renderer for the whole council, not one per seat (Vision's Motion Lab
 * note: a permanent renderer per card doesn't scale); the stage's canvas lies
 * over the seats and each actor is drawn with a scissor where its seat is.
 *
 * Learned in WildChild: play the clips' own GLB (Meshy's bare rigged GLB
 * loads with a broken skin); take the horizontal travel out of the hips so a
 * walk or a cheer stays on its spot; the clips disagree about scale, so the
 * figure is measured once, in its idle pose.
 */

import * as THREE from "three";
import { MOODS, type Mood } from "@foundation/protocol";

export type Framing = "bust" | "full";

// what the camera centres on and how much of the figure's height it sees (the figure is 1 tall, feet at 0)
const FRAME: Record<Framing, { centre: number; span: number }> = {
  bust: { centre: 0.67, span: 0.84 },
  full: { centre: 0.5, span: 1.22 },
};
const FOV = 24;
const FADE = 0.28;

function stayOnSpot(clip: THREE.AnimationClip) {
  for (const t of clip.tracks) {
    if (!/hips\.position$/i.test(t.name)) continue;
    const v = t.values;
    for (let i = 3; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
  }
}

export class Actor {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
  /** the seat this actor is drawn into */
  el: HTMLElement | null = null;
  private holder = new THREE.Group();
  /** scales the figure to 1 tall and stands it on the origin; `holder` above it takes the seat's turn */
  private facing = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<Mood, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private mood: Mood = "idle";
  private framing: Framing = "bust";
  /** 0 bust … 1 full, eased */
  private open = 0;
  private turn = 0;
  private turnTo = 0;
  loaded = false;
  private gone = false;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a4, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1.4, 2.6, 3.2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-2, 1.5, -2.5);
    this.scene.add(rim);
    this.holder.add(this.facing);
    this.scene.add(this.holder);
    this.place(1);
  }

  /** the bytes of a GLB with one clip per mood, in MOODS' order */
  async load(bytes: ArrayBuffer): Promise<void> {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    if (this.gone) return;
    const model = gltf.scene;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // a skinned mesh's bounds are its bind pose's: never cull it away mid-gesture
      m.frustumCulled = false;
    });
    this.mixer = new THREE.AnimationMixer(model);
    gltf.animations.forEach((clip, i) => {
      const mood = MOODS[i];
      if (!mood) return;
      stayOnSpot(clip);
      this.actions.set(mood, this.mixer!.clipAction(clip));
    });
    // measure it standing: the idle clip's first frame
    const idle = this.actions.get("idle");
    if (idle) {
      idle.play();
      this.mixer.update(0);
      this.current = idle;
    }
    this.facing.add(model);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const k = 1 / (size.y || 1);
    this.facing.scale.setScalar(k);
    // a seat's turn is about the figure's own middle, so centre it
    model.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
    this.loaded = true;
    this.play(this.mood, true);
  }

  setMood(mood: Mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    this.play(mood, false);
  }

  private play(mood: Mood, now: boolean) {
    const next = this.actions.get(mood) ?? this.actions.get("idle");
    if (!next || next === this.current) return;
    next.reset().setEffectiveWeight(1).play();
    if (this.current && !now) this.current.crossFadeTo(next, FADE, true);
    else this.current?.stop();
    this.current = next;
  }

  setFraming(f: Framing, now = false) {
    this.framing = f;
    if (now) this.open = f === "full" ? 1 : 0;
  }

  /** turn the figure a little (radians), eased: a seat leans toward what it's looking at */
  setTurn(rad: number) {
    this.turnTo = rad;
  }

  private place(aspect: number) {
    const a = FRAME.bust;
    const b = FRAME.full;
    const centre = a.centre + (b.centre - a.centre) * this.open;
    let span = a.span + (b.span - a.span) * this.open;
    // a narrow seat: see the whole width of a figure with its arms out
    if (aspect < 0.72) span *= 0.72 / aspect;
    const dist = span / 2 / Math.tan((FOV * Math.PI) / 360);
    this.camera.aspect = aspect;
    this.camera.position.set(0, centre, dist);
    this.camera.lookAt(0, centre, 0);
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, aspect: number) {
    const want = this.framing === "full" ? 1 : 0;
    const ease = 1 - Math.exp(-dt * 9);
    this.open += (want - this.open) * ease;
    this.turn += (this.turnTo - this.turn) * ease;
    this.holder.rotation.y = this.turn;
    this.mixer?.update(dt);
    this.place(aspect);
  }

  dispose() {
    this.gone = true;
    this.mixer?.stopAllAction();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        (mat as THREE.MeshStandardMaterial).map?.dispose();
        mat.dispose();
      }
    });
  }
}

/** one WebGL renderer drawing every actor into its element's place on the canvas */
export class AvatarStage {
  private renderer: THREE.WebGLRenderer;
  private actors = new Set<Actor>();
  private raf = 0;
  private last = 0;
  private w = 0;
  private h = 0;
  /** frames drawn, for the checks */
  frames = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    canvas.dataset.stage = "avatars";
  }

  add(actor: Actor, el: HTMLElement) {
    actor.el = el;
    this.actors.add(actor);
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  remove(actor: Actor) {
    this.actors.delete(actor);
    actor.el = null;
    if (!this.actors.size) this.clear();
  }

  private clear() {
    this.renderer.setScissorTest(false);
    this.renderer.clear();
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.actors.size) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const box = this.canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const w = Math.round(box.width);
    const h = Math.round(box.height);
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.renderer.setSize(w, h, false);
    }
    this.clear();
    this.renderer.setScissorTest(true);
    for (const a of this.actors) {
      if (!a.el) continue;
      const r = a.el.getBoundingClientRect();
      const x = r.left - box.left;
      const y = r.top - box.top;
      if (r.width < 2 || r.height < 2 || x + r.width < 0 || y + r.height < 0 || x > w || y > h) {
        // off the canvas: keep its clip's time moving, draw nothing
        a.update(dt, 1);
        continue;
      }
      a.update(dt, r.width / r.height);
      if (!a.loaded) continue;
      // WebGL's y runs up from the canvas's bottom edge
      const bottom = h - (y + r.height);
      this.renderer.setViewport(x, bottom, r.width, r.height);
      this.renderer.setScissor(x, bottom, r.width, r.height);
      this.renderer.render(a.scene, a.camera);
    }
    this.frames++;
    this.canvas.dataset.frames = String(this.frames);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.actors.clear();
    this.renderer.dispose();
  }
}

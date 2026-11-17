/**
 * CAD on a card, the way Vision's ModelForm reads it (Vision
 * apps/vision/src/modelform/mesh.ts): STEP and IGES through OpenCascade
 * (occt-import-js, WebAssembly, loaded only when a B-rep file is shown),
 * STL / OBJ / GLB through three.js's loaders. Everything runs here, in the
 * browser; nothing leaves the machine.
 */

import * as THREE from "three";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

type OcctMesh = {
  name?: string;
  color?: [number, number, number];
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
  index: { array: ArrayLike<number> };
};
type OcctResult = { success: boolean; meshes: OcctMesh[] };
type Occt = {
  ReadStepFile: (b: Uint8Array, p: object | null) => OcctResult;
  ReadIgesFile: (b: Uint8Array, p: object | null) => OcctResult;
};

/** coarser than Vision's slicer setting: a card is small, and it has to be quick */
const TESSELLATION = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.004, angularDeflection: 0.6 } as const;

let occt: Promise<Occt> | null = null;
function loadOcct(): Promise<Occt> {
  occt ??= (async () => {
    const mod = (await import("occt-import-js")) as unknown as { default: (o?: object) => Promise<Occt> };
    return mod.default({ locateFile: () => wasmUrl });
  })();
  return occt;
}

export const MODEL_EXT = /\.(step|stp|iges|igs|stl|obj|glb)$/i;

const material = (color?: [number, number, number]) =>
  new THREE.MeshStandardMaterial({
    color: color ? new THREE.Color(color[0], color[1], color[2]) : new THREE.Color("#c9cdd3"),
    metalness: 0.15,
    roughness: 0.55,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

export interface Model {
  object: THREE.Object3D;
  triangles: number;
  size: THREE.Vector3;
  units: "mm" | "as exported";
}

function measure(object: THREE.Object3D, units: Model["units"]): Model {
  let triangles = 0;
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangles += g.index ? g.index.count / 3 : (g.getAttribute("position")?.count ?? 0) / 3;
  });
  return { object, triangles: Math.round(triangles), size: new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()), units };
}

const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function loadModel(name: string, bytes: Uint8Array): Promise<Model> {
  const ext = (/\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? "") as string;
  switch (ext) {
    case ".step":
    case ".stp":
    case ".iges":
    case ".igs": {
      const o = await loadOcct();
      const r = ext === ".iges" || ext === ".igs" ? o.ReadIgesFile(bytes, TESSELLATION) : o.ReadStepFile(bytes, TESSELLATION);
      if (!r.success) throw new Error("OpenCascade couldn't read this file (damaged, or a STEP schema it doesn't know).");
      if (!r.meshes.length) throw new Error("No solid or surface geometry in this file.");
      const group = new THREE.Group();
      for (const m of r.meshes) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(Array.from(m.attributes.position.array), 3));
        if (m.attributes.normal) g.setAttribute("normal", new THREE.Float32BufferAttribute(Array.from(m.attributes.normal.array), 3));
        g.setIndex(Array.from(m.index.array));
        if (!m.attributes.normal) g.computeVertexNormals();
        group.add(new THREE.Mesh(g, material(m.color)));
      }
      return measure(group, "mm");
    }
    case ".stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const g = new STLLoader().parse(buf(bytes));
      g.deleteAttribute("normal"); // many exporters write zero normals
      g.computeVertexNormals();
      return measure(new THREE.Mesh(g, material()), "as exported");
    }
    case ".obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      return measure(new OBJLoader().parse(new TextDecoder().decode(bytes)), "as exported");
    }
    case ".glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      return measure((await new GLTFLoader().parseAsync(buf(bytes), "")).scene, "as exported");
    }
    default:
      throw new Error(`No 3D preview for ${ext || "this file"}.`);
  }
}

/**
 * A stage for one model: camera framed on it, soft studio light, CAD's Z-up
 * stood upright. `yaw`/`pitch` turn it.
 */
export function stage(model: Model, w: number, h: number, dark: boolean) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(dark ? 0xdfe8ff : 0xffffff, dark ? 0x101828 : 0xb9b2a4, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(2, 3, 4);
  scene.add(key);
  const pivot = new THREE.Group();
  const holder = new THREE.Group();
  if (model.units === "mm") holder.rotation.x = -Math.PI / 2; // CAD is Z-up
  holder.add(model.object);
  pivot.add(holder);
  scene.add(pivot);
  // centre it
  const box = new THREE.Box3().setFromObject(pivot);
  const centre = box.getCenter(new THREE.Vector3());
  holder.position.sub(centre);
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const camera = new THREE.PerspectiveCamera(32, w / h, radius / 100, radius * 100);
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  camera.position.set(0, 0, dist);
  let yaw = -0.7;
  let pitch = 0.45;
  const draw = () => {
    pivot.rotation.set(pitch, yaw, 0);
    renderer.render(scene, camera);
  };
  draw();
  return {
    canvas: renderer.domElement,
    turn(dy: number, dp: number) {
      yaw += dy;
      pitch = Math.max(-1.4, Math.min(1.4, pitch + dp));
      draw();
    },
    still: () => renderer.domElement.toDataURL("image/png"),
    dispose() {
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

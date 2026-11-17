// A stand-in Meshy for checks (MESHY_API_BASE): it takes image, model, rigging and animation tasks,
// finishes each on the second ask, and serves what a real one would: a PNG for an image (an eight-panel
// grid when the prompt asks for an expression sheet), and for a
// model or its clips a real GLB — a small skinned figure with Meshy's joint names and one clip per
// requested action, so the board's own viewer loads it and plays it. Nothing is charged anywhere.
//
//   GET /_sent   what it was asked to make, in order (endpoint and the request, images cut short)
//   GET /_png    a picture, for a check to use as inspiration
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const port = Number(process.argv[2] ?? 4445);
const base = `http://127.0.0.1:${port}`;

// ---------- a PNG ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
/**
 * A 3:4 picture: a figure's silhouette on a pale ground, tinted by `seed` so each is its own file. With
 * `grid`, a 4:3 expressions sheet instead: the same figure eight times, four across and two down, each a
 * little different (its eyes shut in the seventh, its mouth open in the sixth), as the real one is asked for.
 */
function png(seed, grid = false) {
  const w = grid ? 192 : 96, h = grid ? 144 : 128;
  const tint = [(seed * 53) % 200 + 40, (seed * 97) % 180 + 50, (seed * 151) % 160 + 70];
  const dark = tint.map((v) => Math.round(v * 0.35));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let c = [244, 241, 232];
      if (grid) {
        // each panel is 48 × 72: the 96 × 128 figure at half size
        const panel = Math.floor(y / 72) * 4 + Math.floor(x / 48);
        const px = (x % 48) * 2, py = (y % 72) * 2 - 8;
        const head = (px - 48) ** 2 + (py - 36) ** 2 < 18 ** 2;
        const body = Math.abs(px - 48) < 16 - (panel % 3) * 2 && py > 54 && py < 112;
        const eye = Math.abs(Math.abs(px - 48) - 7) < 3 && Math.abs(py - 32) < (panel === 6 ? 1 : 3);
        const mouth = Math.abs(px - 48) < 5 && Math.abs(py - 44) < (panel === 5 ? 4 : 1);
        if (eye || mouth) c = dark;
        else if (head || body) c = tint;
      } else {
        const head = (x - 48) ** 2 + (y - 36) ** 2 < 18 ** 2;
        const body = Math.abs(x - 48) < 16 && y > 54 && y < 112;
        if (head || body) c = tint;
      }
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- a GLB: a skinned figure of boxes, with a clip per action ----------
const JOINTS = [
  { name: "Hips", at: [0, 0.5, 0], parent: -1 },
  { name: "Spine", at: [0, 0.75, 0], parent: 0 },
  { name: "Head", at: [0, 1.05, 0], parent: 1 },
  { name: "LeftArm", at: [0.2, 0.95, 0], parent: 1 },
  { name: "RightArm", at: [-0.2, 0.95, 0], parent: 1 },
  { name: "LeftHand", at: [0.5, 0.95, 0], parent: 3 },
  { name: "RightHand", at: [-0.5, 0.95, 0], parent: 4 },
];
function glb(clipNames, seed) {
  const pos = [], nor = [], jnt = [], wgt = [], idx = [];
  const box = (c, s, joint) => {
    const [cx, cy, cz] = c, [sx, sy, sz] = s.map((v) => v / 2);
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    for (const [n, u, v] of faces) {
      const o = pos.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        pos.push(cx + (n[0] + u[0] * a + v[0] * b) * sx, cy + (n[1] + u[1] * a + v[1] * b) * sy, cz + (n[2] + u[2] * a + v[2] * b) * sz);
        nor.push(...n);
        jnt.push(joint, 0, 0, 0);
        wgt.push(1, 0, 0, 0);
      }
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
  };
  box([0, 0.72, 0], [0.34, 0.5, 0.2], 1); // torso
  box([0, 1.2, 0], [0.42, 0.4, 0.36], 2); // a big head
  box([0, 1.2, 0.19], [0.1, 0.06, 0.04], 2); // a nose, so the front is the front
  box([0.36, 0.95, 0], [0.3, 0.1, 0.1], 3);
  box([-0.36, 0.95, 0], [0.3, 0.1, 0.1], 4);
  box([0.1, 0.24, 0], [0.12, 0.48, 0.14], 0);
  box([-0.1, 0.24, 0], [0.12, 0.48, 0.14], 0);

  const parts = [];
  const views = [], accessors = [];
  let offset = 0;
  const add = (typed, type, comp, extra = {}) => {
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (b.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.length });
    parts.push(b, Buffer.alloc(pad));
    offset += b.length + pad;
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    accessors.push({ bufferView: views.length - 1, componentType: comp, count: typed.length / n, type, ...extra });
    return accessors.length - 1;
  };
  const P = new Float32Array(pos);
  const min = [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k)));
  const aPos = add(P, "VEC3", 5126, { min, max });
  const aNor = add(new Float32Array(nor), "VEC3", 5126);
  const aJnt = add(new Uint8Array(jnt), "VEC4", 5121);
  const aWgt = add(new Float32Array(wgt), "VEC4", 5126);
  const aIdx = add(new Uint16Array(idx), "SCALAR", 5123);
  const ibm = new Float32Array(JOINTS.length * 16);
  JOINTS.forEach((j, i) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j.at[0], -j.at[1], -j.at[2], 1], i * 16));
  const aIbm = add(ibm, "MAT4", 5126);

  // nodes: 0 the mesh, 1.. the joints (each placed relative to its parent)
  const nodes = [{ name: "figure", mesh: 0, skin: 0 }];
  JOINTS.forEach((j, i) => {
    const p = j.parent < 0 ? [0, 0, 0] : JOINTS[j.parent].at;
    nodes.push({ name: j.name, translation: [j.at[0] - p[0], j.at[1] - p[1], j.at[2] - p[2]], children: JOINTS.map((c, k) => (c.parent === i ? k + 1 : -1)).filter((k) => k > 0) });
  });
  for (const n of nodes) if (n.children && !n.children.length) delete n.children;

  const q = (axis, a) => [axis[0] * Math.sin(a / 2), axis[1] * Math.sin(a / 2), axis[2] * Math.sin(a / 2), Math.cos(a / 2)];
  const times = add(new Float32Array([0, 0.6, 1.2]), "SCALAR", 5126, { min: [0], max: [1.2] });
  const animations = clipNames.map((name, i) => {
    // each clip lifts the arms by its own amount, so one can be told from another
    const lift = 0.25 + i * 0.22;
    const rot = (sign) => add(new Float32Array([...q([0, 0, 1], 0), ...q([0, 0, 1], sign * lift), ...q([0, 0, 1], 0)]), "VEC4", 5126);
    const nod = add(new Float32Array([...q([1, 0, 0], 0), ...q([1, 0, 0], 0.15 + i * 0.03), ...q([1, 0, 0], 0)]), "VEC4", 5126);
    const samplers = [{ input: times, output: rot(1), interpolation: "LINEAR" }, { input: times, output: rot(-1), interpolation: "LINEAR" }, { input: times, output: nod, interpolation: "LINEAR" }];
    return { name, samplers, channels: [{ sampler: 0, target: { node: 4, path: "rotation" } }, { sampler: 1, target: { node: 5, path: "rotation" } }, { sampler: 2, target: { node: 3, path: "rotation" } }] };
  });

  const json = {
    asset: { version: "2.0", generator: "foundation meshy stand-in" },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor, JOINTS_0: aJnt, WEIGHTS_0: aWgt }, indices: aIdx, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [((seed * 53) % 200 + 40) / 255, ((seed * 97) % 180 + 50) / 255, ((seed * 151) % 160 + 70) / 255, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    skins: [{ joints: JOINTS.map((_, i) => i + 1), inverseBindMatrices: aIbm, skeleton: 1 }],
    animations: animations.length ? animations : undefined,
    buffers: [{ byteLength: offset }],
    bufferViews: views,
    accessors,
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const ch = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(bin.length, 0x004e4942), bin]);
}

// ---------- the API ----------
const tasks = new Map(); // id → { endpoint, body, asks, n }
const sent = [];
const cut = (v) => (typeof v === "string" && v.length > 80 ? `${v.slice(0, 40)}…(${v.length})` : Array.isArray(v) ? v.map(cut) : v);

createServer((req, res) => {
  const url = new URL(req.url, base);
  const say = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/_sent") return say(200, { sent });
  if (url.pathname === "/_png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(png(3));
  }
  const dl = /^\/dl\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (dl) {
    const t = tasks.get(dl[1]);
    if (!t) return say(404, { message: "no such file" });
    res.writeHead(200);
    if (dl[2].endsWith(".glb")) return res.end(glb(t.endpoint === "animations" ? (t.body.action_ids ?? [0]).map((a) => `Action_${a}`) : [], t.n));
    return res.end(png(t.n + (dl[2].startsWith("preview") ? 7 : 0), String(t.body.prompt ?? "").startsWith("Expression and pose sheet")));
  }
  if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) return say(401, { message: "no key" });
  const [, endpoint, id] = /^\/([a-z0-9-]+)(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
  if (endpoint === "balance") return say(200, { balance: 5000 - sent.length * 9 });
  if (req.method === "POST") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const n = sent.length + 1;
      const tid = `${endpoint}-${n}`;
      tasks.set(tid, { endpoint, body, asks: 0, n });
      sent.push({ endpoint, request: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, cut(v)])) });
      say(200, { result: tid });
    });
    return;
  }
  const t = tasks.get(id);
  if (!t) return say(404, { message: "Task not found" });
  t.asks++;
  if (t.asks < 2) return say(200, { id, status: "IN_PROGRESS", progress: 50 });
  const file = (name) => `${base}/dl/${id}/${name}`;
  const e = t.endpoint;
  say(200, {
    id,
    status: "SUCCEEDED",
    progress: 100,
    consumed_credits: e === "multi-image-to-3d" ? 30 : e === "rigging" ? 5 : e === "animations" ? 3 * (t.body.action_ids?.length ?? 1) : 9,
    image_urls: e.endsWith("-to-image") ? [file("image.png")] : undefined,
    model_urls: e === "multi-image-to-3d" ? { glb: file("model.glb") } : undefined,
    thumbnail_url: e === "multi-image-to-3d" ? file("preview.png") : undefined,
    result: e === "rigging" ? { rigged_character_glb_url: file("rigged.glb") } : e === "animations" ? { animation_glb_url: file("clips.glb") } : undefined,
  });
}).listen(port, "127.0.0.1", () => console.log(`meshy stand-in on ${base}`));

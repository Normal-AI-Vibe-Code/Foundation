#!/usr/bin/env node
// The server the desktop app carries: `apps/client/src-tauri/server/`, shipped as a Tauri resource and
// started from the server switch when a person picks Built in (src-tauri/src/local_server.rs, server.rs).
//
//   node scripts/desktop-server.mjs            build it (run by `npm run build:desktop`, so by `tauri build`)
//   node scripts/desktop-server.mjs --check    build it, start it on a spare port with a throwaway data
//                                              folder, ask /api/health, stop it
//
// Two parts:
//   index.mjs, extract-worker.mjs   apps/server bundled by esbuild (its dependencies inside; no node_modules)
//   node(.exe)                      a pinned Node, because the server needs `node:sqlite` with FTS5 (22.16+)
//                                   and the computer it's installed on may have an older Node or none
//
// Node is the official build, checked against the SHA-256 nodejs.org publishes for that release
// (https://nodejs.org/dist/v<version>/SHASUMS256.txt). On Windows the release has the bare node.exe, so
// if the Node running this script is that very file it is copied and nothing is downloaded. Otherwise
// it is downloaded once into src-tauri/target/node-cache/. To move to a new Node: change NODE_VERSION
// and the hashes below from that release's SHASUMS256.txt.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "22.22.0";
const DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;
/** what to fetch per platform, and its published SHA-256 (the bare exe on Windows, the tarball elsewhere) */
const NODE = {
  "win32-x64": { file: "win-x64/node.exe", sha256: "bae898add4643fcf890a83ad8ae56e20dce7e781cab161a53991ceba70c99ffb" },
  "win32-arm64": { file: "win-arm64/node.exe", sha256: "fd44256121597d6a3707f4c7730b4e3733eacb5a95cc78a099f601d7e7f8290d" },
  "darwin-arm64": { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640" },
  "darwin-x64": { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce" },
  "linux-x64": { file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: "c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744" },
  "linux-arm64": { file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`, sha256: "25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be" },
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = join(root, "apps/client/src-tauri");
const OUT = join(TAURI, "server");
const CACHE = join(TAURI, "target", "node-cache");
const win = process.platform === "win32";
const NODE_NAME = win ? "node.exe" : "node";

const die = (m) => {
  console.error(`\n  desktop-server: ${m}\n`);
  process.exit(1);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The pinned Node for this platform, as a file in the cache. */
async function pinnedNode() {
  const key = `${process.platform}-${process.arch}`;
  const pin = NODE[key];
  if (!pin) die(`no pinned Node for ${key}; add it to NODE from ${DIST}/SHASUMS256.txt`);
  const dir = join(CACHE, `v${NODE_VERSION}-${key}`);
  const bin = join(dir, NODE_NAME);
  const got = join(dir, pin.file.split("/").pop());
  mkdirSync(dir, { recursive: true });

  // Windows: the published hash is of node.exe itself, so the cache (and this very Node) can be checked directly
  if (win) {
    if (existsSync(bin) && sha256(bin) === pin.sha256) return bin;
    if (sha256(process.execPath) === pin.sha256) {
      copyFileSync(process.execPath, bin);
      console.log(`  node     v${NODE_VERSION} (the Node running this build; SHA-256 matches nodejs.org's)`);
      return bin;
    }
  } else if (existsSync(bin) && existsSync(got) && sha256(got) === pin.sha256) return bin;

  console.log(`  node     downloading ${DIST}/${pin.file}`);
  const res = await fetch(`${DIST}/${pin.file}`);
  if (!res.ok) die(`couldn't download Node: ${res.status} ${res.statusText}`);
  writeFileSync(got, Buffer.from(await res.arrayBuffer()));
  const sum = sha256(got);
  if (sum !== pin.sha256) {
    rmSync(got, { force: true });
    die(`the downloaded Node's SHA-256 is ${sum}, not the pinned ${pin.sha256}. Nothing was kept.`);
  }
  if (!win) {
    // bin/node out of the tarball (tar ships with macOS and every Linux)
    const r = spawnSync("tar", ["-xzf", got, "-C", dir, "--strip-components=2", `${pin.file.replace(/\.tar\.gz$/, "")}/bin/node`], { stdio: "inherit" });
    if (r.status !== 0) die("couldn't unpack Node");
    chmodSync(bin, 0o755);
  }
  return bin;
}

/** apps/server as two files: the server, and the worker it starts to read documents */
async function bundle() {
  const { build } = await import("esbuild");
  const r = await build({
    absWorkingDir: root,
    entryPoints: { index: "apps/server/src/index.ts", "extract-worker": "apps/server/src/extract-worker.ts" },
    outdir: OUT,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // ws's optional native speed-ups: absent here too, and it carries on without them
    external: ["bufferutil", "utf-8-validate"],
    // the CommonJS packages inside (ws, the Anthropic SDK's dependencies) call require()
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    legalComments: "none",
    logLevel: "warning",
    metafile: true,
  });
  for (const [file, o] of Object.entries(r.metafile.outputs)) console.log(`  bundle   ${file.split("/").pop()}  ${(o.bytes / 1e6).toFixed(1)} MB`);
}

/** the Node that will ship must be new enough and have FTS5: ask it */
function probe(node) {
  const code = "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('create virtual table t using fts5(x)');console.log(process.versions.node)";
  const r = spawnSync(node, ["--no-warnings", "-e", code], { encoding: "utf8" });
  if (r.status !== 0) die(`the bundled Node can't run the server (no FTS5?):\n${r.stderr}`);
  if (r.stdout.trim() !== NODE_VERSION) die(`the bundled Node says ${r.stdout.trim()}, expected ${NODE_VERSION}`);
}

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

/** start what was built the way the app does, with nothing of the repo in reach, and ask it for /api/health */
async function check() {
  const home = mkdtempSync(join(tmpdir(), "foundation-desktop-server-"));
  const port = Number(process.env.CHECK_PORT) || (await freePort());
  const child = spawn(join(OUT, NODE_NAME), ["--no-warnings", join(OUT, "index.mjs")], {
    cwd: home,
    env: { ...process.env, FOUNDATION_PORT: String(port), FOUNDATION_ROOT: home, FOUNDATION_DATA_DIR: join(home, "data"), FOUNDATION_EXIT_WITH_PARENT: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let exited = null;
  child.on("exit", (c) => (exited = c ?? -1));
  const t0 = Date.now();
  let health = null;
  while (Date.now() - t0 < 30_000 && exited === null) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        health = await r.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const up = Date.now() - t0;
  // closing stdin is how the app tells it to go
  child.stdin.end();
  const t1 = Date.now();
  while (exited === null && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
  if (exited === null) child.kill();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (!health?.ok) die(`the bundled server didn't answer on :${port}:\n${out}`);
  if (exited === null) die("the bundled server didn't stop when its stdin closed");
  console.log(`  check    answered /api/health on :${port} after ${up} ms; stopped ${Date.now() - t1} ms after stdin closed (exit ${exited})`);
}

const node = await pinnedNode();
mkdirSync(OUT, { recursive: true });
await bundle();
copyFileSync(node, join(OUT, NODE_NAME));
if (!win) chmodSync(join(OUT, NODE_NAME), 0o755);
probe(join(OUT, NODE_NAME));
console.log(`  node     ${NODE_NAME}  ${(statSync(join(OUT, NODE_NAME)).size / 1e6).toFixed(1)} MB  → ${OUT}`);
if (process.argv.includes("--check")) await check();

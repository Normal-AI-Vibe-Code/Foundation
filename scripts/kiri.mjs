#!/usr/bin/env node
/**
 * Kiri, the container engine Foundation's machines prefer (github.com/libracoder/kiri,
 * Apache-2.0). It speaks the Docker Engine API on \\.\pipe\kiri (Windows) or
 * ~/.kiri/run/docker.sock, and apps/server/src/machines.ts finds it there.
 *
 *   npm run kiri              start Kiri if it is installed (npm run dev does this too)
 *   npm run kiri:install      download the pinned release, check its SHA-256, install, start
 *   npm run kiri -- status    what is installed and whether the engine answers
 *
 * Windows: the per-user MSI (no administrator), then Kiri's own Linux imported
 * into WSL 2 as the distro `kiri`, then `kiri-win.exe --background --distro kiri`,
 * which serves the pipe. That is what Kiri's first-run window does when you
 * choose "Kiri Linux", minus the window. Docker Desktop, if present, stays
 * docker's default: nothing here changes docker contexts or PATH.
 *
 * macOS and Linux: the release is downloaded and checked, and the one command
 * that installs it is printed (a .dmg to open, a .deb or .rpm that needs sudo).
 *
 * To move to a new Kiri: change VERSION and the hashes below from the release's SHA256SUMS.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "0.1.18";
const RELEASE = `https://github.com/libracoder/kiri/releases/download/v${VERSION}`;
/** From the release's SHA256SUMS. A download that doesn't match is deleted, never run. */
const FILES = {
  "win32-x64": { file: `Kiri-${VERSION}-x86_64.msi`, sha256: "6ea27a576198065d19b4656eaf7f4993231c2aaa840181fe67b15ca8ec32f8f9" },
  "win32-arm64": { file: `Kiri-${VERSION}-arm64.msi`, sha256: "9d8ff28e2e009810364de57e01c78c33254b0a4614f2920a842048856675bc33" },
  "darwin-arm64": { file: `Kiri-${VERSION}-arm64.dmg`, sha256: "d142612e5765e6a13299d0afcfc4eb11a65ca2468d627497ce5450c8fc333121" },
  "darwin-x64": { file: `Kiri-${VERSION}-x86_64.dmg`, sha256: "8df5dfa2173864e2e2e4b5e1a25161a5ef620951bb0a1623ab722cf8b2d33091" },
  "linux-x64-deb": { file: `kiri_${VERSION}_amd64.deb`, sha256: "423be3e596df78e47f03256eb08492b9f1ddc27ab60f4623993fee5a3f74b5cf" },
  "linux-arm64-deb": { file: `kiri_${VERSION}_arm64.deb`, sha256: "ada276d6a6517a043bcff843dd2826777d06f8343188c2c93c2620bb563b8340" },
  "linux-x64-rpm": { file: `kiri-${VERSION}-1.x86_64.rpm`, sha256: "433841998448ddf779e69a1bbb5e0bea069cbf50fecea68b70ba4997eba3fee1" },
  "linux-arm64-rpm": { file: `kiri-${VERSION}-1.aarch64.rpm`, sha256: "30313f301c923c1cb7ef61a9f886e81384a5c970aeedf987ef602ad2d11a2d46" },
};

const win = process.platform === "win32";
/** Kiri's per-user folder on Windows (the MSI's INSTALLFOLDER). */
export const kiriDir = () => join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Kiri");
const DISTRO = "kiri";

/** Where Kiri's engine listens on this computer. */
export function kiriSocket() {
  if (process.env.KIRI_SOCKET) return process.env.KIRI_SOCKET;
  if (win) return "\\\\.\\pipe\\kiri";
  return posix.join(homedir(), ".kiri", "run", "docker.sock");
}

/** The engine's /_ping, or null when nothing answers within `ms`. */
export function ping(ms = 1500) {
  return new Promise((done) => {
    const req = request({ socketPath: kiriSocket(), path: "/_ping", method: "GET", timeout: ms }, (res) => {
      res.resume();
      done(res.statusCode === 200 ? true : null);
    });
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.on("error", () => done(null));
    req.end();
  });
}

/** The engine's /version (Kiri names itself in Platform.Name). */
function version() {
  return new Promise((done) => {
    const req = request({ socketPath: kiriSocket(), path: "/version", method: "GET", timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (b) => (body += b));
      res.on("end", () => {
        try {
          done(JSON.parse(body));
        } catch {
          done(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
    req.end();
  });
}

/** WSL prints UTF-16 to a pipe. */
function wslText(buf) {
  if (!buf?.length) return "";
  const utf16 = buf.length >= 2 && [1, 3, 5, 7].every((i) => i >= buf.length || buf[i] === 0);
  return (utf16 ? buf.toString("utf16le") : buf.toString("utf8")).replace(/\0/g, "");
}
function wslDistros() {
  const r = spawnSync("wsl.exe", ["-l", "-q"], { windowsHide: true });
  return r.status === 0 ? wslText(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null;
}
function installedVersion() {
  const r = spawnSync("reg", ["query", "HKCU\\Software\\Kiri", "/v", "Version"], { windowsHide: true, encoding: "utf8" });
  return r.status === 0 ? r.stdout.match(/Version\s+REG_SZ\s+(\S+)/)?.[1] ?? null : null;
}

/** What is here, for `status` and for the server's "no engine" card. */
export function kiriInstalled() {
  if (win) {
    const exe = join(kiriDir(), "kiri-win.exe");
    const distros = wslDistros();
    return { app: existsSync(exe), version: installedVersion(), wsl: distros !== null, distro: !!distros?.includes(DISTRO), exe };
  }
  const which = spawnSync(process.platform === "darwin" ? "sh" : "sh", ["-c", "command -v kiri"], { encoding: "utf8" });
  const app = which.status === 0 || existsSync("/Applications/Kiri.app");
  return { app, version: null, wsl: false, distro: false, exe: which.stdout?.trim() || null };
}

async function waitForEngine(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ping(1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Start Kiri if it is installed and not already serving. Never installs, and
 * never waits on a person: npm run dev calls it and carries on.
 * Returns "running" | "started" | "not-installed" | "failed: …".
 */
export async function startKiri({ waitMs = 60_000, log = console.log } = {}) {
  if (await ping()) return "running";
  const here = kiriInstalled();
  if (!here.app) return "not-installed";
  if (win) {
    if (!here.distro) return "not-installed";
    // Kiri's tray app: serves \\.\pipe\kiri and starts the engine in WSL (--background: no window).
    // Through `start`, so it isn't in our process tree: stopping npm run dev (taskkill /T) leaves it running.
    const q = (s) => `"${s.replace(/"/g, "")}"`;
    const line = `start "" /b ${[here.exe, "--background", "--distro", DISTRO].map(q).join(" ")}`;
    spawn("cmd.exe", ["/d", "/s", "/c", line], { cwd: kiriDir(), detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-g", "-a", "Kiri"], { detached: true, stdio: "ignore" }).unref();
  } else {
    const p = spawn("kiri", ["daemon"], { detached: true, stdio: "ignore" });
    p.unref();
  }
  log(`kiri: starting (engine on ${kiriSocket()})`);
  return (await waitForEngine(waitMs)) ? "started" : `failed: Kiri did not answer on ${kiriSocket()} within ${Math.round(waitMs / 1000)} s${win ? ` (its log: ${join(kiriDir(), "kiri-win.log")})` : ""}`;
}

/** Download a release file into the cache, checking its SHA-256 as it streams. */
async function fetchRelease({ file, sha256 }) {
  const dir = join(tmpdir(), "foundation-kiri", VERSION);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, file);
  if (existsSync(dest) && hashOf(dest) === sha256) return dest;
  console.log(`kiri: downloading ${RELEASE}/${file}`);
  const res = await fetch(`${RELEASE}/${file}`, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const part = `${dest}.part`;
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body);
  body.on("data", (b) => hash.update(b));
  await pipeline(body, createWriteStream(part));
  const got = hash.digest("hex");
  if (got !== sha256) {
    rmSync(part, { force: true });
    throw new Error(`${file} has SHA-256 ${got}, the release says ${sha256}: deleted, not installed`);
  }
  renameSync(part, dest);
  console.log(`kiri: ${file} matches the release's SHA-256 (${sha256.slice(0, 16)}…)`);
  return dest;
}
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { windowsHide: true });
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(wslText(r.stderr) || wslText(r.stdout)).trim().split(/\r?\n/)[0] ?? ""}`);
  return r;
}

export async function installKiri() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (win) {
    if (wslDistros() === null) throw new Error("WSL is not installed. Run `wsl --install` (it needs a restart), then npm run kiri:install again.");
    const have = kiriInstalled();
    if (have.app && have.version === VERSION) {
      console.log(`kiri: ${VERSION} is installed (${kiriDir()})`);
    } else {
      const msi = await fetchRelease(FILES[`win32-${arch}`]);
      const log = join(tmpdir(), "foundation-kiri", VERSION, "install.log");
      console.log(`kiri: installing ${VERSION} for this user into ${kiriDir()}${have.version ? ` (was ${have.version})` : ""}`);
      // a running Kiri holds its files; the MSI closes it, and we start it again below
      const r = spawnSync("msiexec.exe", ["/i", msi, "/qn", "/norestart", "/L*V", log], { windowsHide: true });
      if (r.status !== 0 && r.status !== 3010) throw new Error(`msiexec exited ${r.status} (its log: ${log})`);
    }
    if (!wslDistros()?.includes(DISTRO)) {
      const tar = join(kiriDir(), "kiri-linux.tar.gz");
      if (!existsSync(tar)) throw new Error(`${tar} is missing: the install did not finish`);
      console.log(`kiri: adding Kiri Linux to WSL as '${DISTRO}' (${join(kiriDir(), "wsl", DISTRO)})`);
      mkdirSync(join(kiriDir(), "wsl"), { recursive: true });
      run("wsl.exe", ["--import", DISTRO, join(kiriDir(), "wsl", DISTRO), tar, "--version", "2"], "wsl --import");
    }
  } else if (process.platform === "darwin") {
    const dmg = await fetchRelease(FILES[`darwin-${arch}`]);
    console.log(`kiri: open ${dmg}, drag Kiri to Applications and open it once; then npm run kiri`);
    return;
  } else {
    const rpm = existsSync("/usr/bin/rpm") && !existsSync("/usr/bin/dpkg");
    const pkg = await fetchRelease(FILES[`linux-${arch}-${rpm ? "rpm" : "deb"}`]);
    console.log(`kiri: install it with  sudo ${rpm ? "dnf install" : "apt install"} ${pkg}  then npm run kiri`);
    return;
  }
  const s = await startKiri();
  if (s.startsWith("failed")) throw new Error(s);
  await status();
}

export async function status() {
  const here = kiriInstalled();
  const v = (await ping()) ? await version() : null;
  console.log(`kiri: pinned ${VERSION}; installed ${here.app ? here.version ?? "yes" : "no"}${win ? `; WSL distro '${DISTRO}' ${here.distro ? "present" : "absent"}` : ""}`);
  console.log(v ? `kiri: engine up on ${kiriSocket()}: ${v.Platform?.Name ?? "?"} ${v.Version} (API ${v.ApiVersion}, ${v.Os}/${v.Arch})` : `kiri: no engine on ${kiriSocket()}`);
  return !!v;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const cmd = process.argv[2] ?? "start";
  try {
    if (cmd === "install") await installKiri();
    else if (cmd === "status") process.exitCode = (await status()) ? 0 : 1;
    else if (cmd === "start") {
      const s = await startKiri();
      if (s === "not-installed") {
        console.log("kiri: not installed here. npm run kiri:install downloads the pinned release and sets it up.");
        process.exitCode = 1;
      } else if (s.startsWith("failed")) {
        console.error(`kiri: ${s}`);
        process.exitCode = 1;
      } else await status();
    } else {
      console.error(`unknown command ${cmd}: start, install or status (${fileURLToPath(import.meta.url)})`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`kiri: ${e.message}`);
    process.exitCode = 1;
  }
}

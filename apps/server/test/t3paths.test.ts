/**
 * Finding Vision Code (T3) on macOS, Windows and Linux: where its CLI and its
 * home are looked for, that T3_CLI / T3CODE_HOME / T3_URL win, how a CLI is
 * started without a shell, and what a person is told when nothing is found.
 * Pure functions over a given platform, env and home: nothing here touches
 * this computer's Vision Code or its address.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findT3Cli, findT3Home, notFoundMessage, runtimeOrigin, t3Address, t3CliCandidates, t3Command, t3HomeCandidates, t3Url, DEFAULT_T3_URL, ON_PATH, type Where } from "../src/t3paths.ts";

const mac: Where = { platform: "darwin", arch: "arm64", env: {}, home: "/Users/ada" };
const win: Where = {
  platform: "win32",
  arch: "x64",
  env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local", SystemDrive: "C:", ProgramFiles: "C:\\Program Files", Path: "C:\\bin;C:\\npm" },
  home: "C:\\Users\\Ada",
};
const linux: Where = { platform: "linux", arch: "x64", env: { PATH: "/usr/local/bin:/usr/bin" }, home: "/home/ada" };
const nothing = () => false;

test("Vision's T3 home, per platform", () => {
  assert.deepEqual(t3HomeCandidates(mac), ["/Users/ada/Library/Application Support/co.normallab.vision/code"]);
  assert.deepEqual(t3HomeCandidates(win), ["C:\\Users\\Ada\\AppData\\Roaming\\co.normallab.vision\\code"]);
  assert.deepEqual(t3HomeCandidates({ ...win, env: {} }), ["C:\\Users\\Ada\\AppData\\Roaming\\co.normallab.vision\\code"], "no APPDATA: the usual Roaming");
  assert.deepEqual(t3HomeCandidates(linux), ["/home/ada/.local/share/co.normallab.vision/code"]);
  assert.deepEqual(t3HomeCandidates({ ...linux, env: { XDG_DATA_HOME: "/data" } }), ["/data/co.normallab.vision/code"]);
  // Vision's own override comes before the platform's place
  assert.deepEqual(t3HomeCandidates({ ...mac, env: { VISION_CODE_HOME: "/vc" } }), ["/vc", "/Users/ada/Library/Application Support/co.normallab.vision/code"]);
  // a home counts once it holds T3's store
  const store = "C:\\Users\\Ada\\AppData\\Roaming\\co.normallab.vision\\code\\userdata\\state.sqlite";
  assert.equal(findT3Home(win, (f) => f === store).found, "C:\\Users\\Ada\\AppData\\Roaming\\co.normallab.vision\\code");
  assert.equal(findT3Home(win, nothing).found, null);
});

test("Vision Code's CLI, per platform: checkouts, the installed app, then PATH", () => {
  assert.deepEqual(t3CliCandidates(mac), [
    "/Users/ada/Development/Vision/.tools/code-server/t3",
    "/Users/ada/Development/Vision/.tools/t3-server/node_modules/@t3code/t3-darwin-arm64/t3",
    "/Users/ada/Dev/Vision/.tools/code-server/t3",
    "/Users/ada/Dev/Vision/.tools/t3-server/node_modules/@t3code/t3-darwin-arm64/t3",
    "/Applications/Vision.app/Contents/Resources/code-server/t3",
    "/Users/ada/Applications/Vision.app/Contents/Resources/code-server/t3",
  ]);
  assert.deepEqual(t3CliCandidates(win), [
    "C:\\Users\\Ada\\Development\\Vision\\.tools\\code-server\\t3.exe",
    "C:\\Users\\Ada\\Development\\Vision\\.tools\\t3-server\\node_modules\\@t3code\\t3-win32-x64\\t3.exe",
    "C:\\Users\\Ada\\Dev\\Vision\\.tools\\code-server\\t3.exe",
    "C:\\Users\\Ada\\Dev\\Vision\\.tools\\t3-server\\node_modules\\@t3code\\t3-win32-x64\\t3.exe",
    "C:\\Dev\\Vision\\.tools\\code-server\\t3.exe",
    "C:\\Dev\\Vision\\.tools\\t3-server\\node_modules\\@t3code\\t3-win32-x64\\t3.exe",
    "C:\\Users\\Ada\\AppData\\Local\\Vision\\code-server\\t3.exe",
    "C:\\Program Files\\Vision\\code-server\\t3.exe",
  ]);
  assert.deepEqual(t3CliCandidates(linux), [
    "/home/ada/Development/Vision/.tools/code-server/t3",
    "/home/ada/Development/Vision/.tools/t3-server/node_modules/@t3code/t3-linux-x64/t3",
    "/home/ada/Dev/Vision/.tools/code-server/t3",
    "/home/ada/Dev/Vision/.tools/t3-server/node_modules/@t3code/t3-linux-x64/t3",
    "/usr/lib/Vision/code-server/t3",
  ]);

  // the first that exists wins; the installed app when there's no checkout
  assert.equal(findT3Cli(win, (f) => f.endsWith("Local\\Vision\\code-server\\t3.exe") || f.startsWith("C:\\Dev\\Vision")).found, "C:\\Dev\\Vision\\.tools\\code-server\\t3.exe");
  assert.equal(findT3Cli(win, (f) => f.endsWith("Local\\Vision\\code-server\\t3.exe")).found, "C:\\Users\\Ada\\AppData\\Local\\Vision\\code-server\\t3.exe");
  // then PATH: t3.exe, or npm's t3.cmd, on Windows; t3 elsewhere
  assert.equal(findT3Cli(win, (f) => f === "C:\\npm\\t3.cmd").found, "C:\\npm\\t3.cmd");
  assert.equal(findT3Cli(linux, (f) => f === "/usr/bin/t3").found, "/usr/bin/t3");
  const none = findT3Cli(win, nothing);
  assert.equal(none.found, null);
  assert.equal(none.tried.at(-1), ON_PATH);
});

test("T3_CLI, T3CODE_HOME and T3_URL win, and are taken as given", () => {
  const set: Where = { ...win, env: { ...win.env, T3_CLI: "D:\\tools\\t3.exe", T3CODE_HOME: "D:\\t3home", VISION_CODE_HOME: "E:\\vc" } };
  assert.deepEqual(t3CliCandidates(set), ["D:\\tools\\t3.exe"]);
  assert.deepEqual(t3HomeCandidates(set), ["D:\\t3home"], "no fallback to the real home once T3CODE_HOME is set");
  // even where nothing exists: the override is what's used (and what fails, loudly)
  assert.equal(findT3Cli(set, nothing).found, "D:\\tools\\t3.exe");
  assert.equal(findT3Home(set, nothing).found, "D:\\t3home");
  assert.equal(t3Url({ ...win, env: { T3_URL: "http://127.0.0.1:4999/" } }), "http://127.0.0.1:4999");
});

test("the CLI starts without a shell: scripts under Node, npm's .cmd through the script it wraps", () => {
  assert.deepEqual(t3Command("C:\\x\\t3.exe", win), { cmd: "C:\\x\\t3.exe", pre: [] });
  assert.deepEqual(t3Command("/opt/t3", linux), { cmd: "/opt/t3", pre: [] });
  assert.deepEqual(t3Command("C:\\x\\t3.cjs", win), { cmd: process.execPath, pre: ["C:\\x\\t3.cjs"] });
  assert.deepEqual(t3Command("/x/bin.mjs", mac), { cmd: process.execPath, pre: ["/x/bin.mjs"] });
  // the shim npm writes for a global `t3` (its bin is dist/bin.mjs)
  const shim = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\t3\\dist\\bin.mjs" %*\r\n`;
  assert.deepEqual(t3Command("C:\\npm\\t3.cmd", win, () => shim), { cmd: process.execPath, pre: ["C:\\npm\\node_modules\\t3\\dist\\bin.mjs"] });
  // a .cmd that isn't npm's is refused, not run through cmd.exe
  assert.throws(() => t3Command("C:\\x\\t3.cmd", win, () => "@echo off\r\nt3.exe %*\r\n"), /won't run through a shell.*T3_CLI/);
});

test("nothing found: the message lists every place looked and what to set", () => {
  const msg = notFoundMessage(findT3Cli(win, nothing), findT3Home(win, nothing));
  for (const p of [...t3CliCandidates(win), ...t3HomeCandidates(win), ON_PATH]) assert.ok(msg.includes(p), `names ${p}`);
  assert.match(msg, /Vision Code's CLI isn't on this computer/);
  assert.match(msg, /T3_CLI/);
  assert.match(msg, /T3CODE_HOME/);
  assert.match(msg, /T3_URL/);
  // only what's missing is asked for
  const homeOnly = notFoundMessage(findT3Cli(win, () => true), findT3Home(win, nothing));
  assert.doesNotMatch(homeOnly, /CLI isn't|T3_CLI/);
  assert.match(homeOnly, /T3CODE_HOME/);
});

test("the side pane's list says where it looked when the threads can't be read", async () => {
  const empty = mkdtempSync(join(tmpdir(), "t3-none-"));
  const keep = { T3CODE_HOME: process.env.T3CODE_HOME, T3_URL: process.env.T3_URL };
  process.env.T3CODE_HOME = empty;
  process.env.T3_URL = "http://127.0.0.1:9"; // never the real Vision Code
  try {
    const { t3Threads } = await import("../src/t3.ts");
    const r = await t3Threads();
    assert.equal(r.available, false);
    assert.ok(r.missing?.includes(empty), r.missing);
    assert.match(r.missing!, /T3CODE_HOME/);
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(empty, { recursive: true, force: true });
  }
});

// ---------- the address: T3_URL, else T3's server-runtime.json, else :3783 ----------

const winHome = "C:\\Users\\Ada\\AppData\\Roaming\\co.normallab.vision\\code";
const winStore = `${winHome}\\userdata\\state.sqlite`;
const winRuntime = `${winHome}\\userdata\\server-runtime.json`;
/** a Windows machine with Vision's store, and server-runtime.json saying `body` (or missing) */
const fsWith = (body: string | null) => ({
  exists: (f: string) => f === winStore,
  read: (f: string) => {
    if (f !== winRuntime || body === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return body;
  },
});
const address = (w: Where, body: string | null) => {
  const f = fsWith(body);
  return t3Address(w, f.exists, f.read);
};

test("the address comes from what Vision Code wrote when it started (it takes the next port when :3783 is taken)", () => {
  // the file as T3 0.0.44 writes it (this machine's, 2026-11-07)
  const real = '{"version":1,"pid":45496,"host":"127.0.0.1","port":3783,"origin":"http://127.0.0.1:3783","startedAt":"2026-10-04T03:08:28.715Z"}\n';
  assert.deepEqual(address(win, real), { url: "http://127.0.0.1:3783", from: winRuntime });
  const moved = '{"version":1,"pid":7,"host":"127.0.0.1","port":3784,"origin":"http://127.0.0.1:3784","startedAt":"2026-11-07T00:00:00.000Z"}';
  assert.equal(address(win, moved).url, "http://127.0.0.1:3784");
  // no origin it can use: host and port stand in; a wildcard host is this computer
  assert.equal(address(win, '{"version":1,"port":3790,"host":"0.0.0.0","origin":"nope"}').url, "http://127.0.0.1:3790");
  assert.equal(address(win, '{"version":1,"port":3791,"origin":"ftp://127.0.0.1:3791"}').url, "http://127.0.0.1:3791");
  // T3_URL wins over the file
  assert.deepEqual(address({ ...win, env: { ...win.env, T3_URL: "http://127.0.0.1:5000/" } }, moved), { url: "http://127.0.0.1:5000", from: "T3_URL" });
  // T3CODE_HOME says whose file
  const pinned: Where = { ...linux, env: { T3CODE_HOME: "/t3home" } };
  assert.equal(t3Address(pinned, () => false, (f) => (f === "/t3home/userdata/server-runtime.json" ? moved : "")).url, "http://127.0.0.1:3784");
});

test("no usable file: http://127.0.0.1:3783", () => {
  for (const body of [null, "", "not json", "null", "[]", "{}", '{"origin":""}', '{"port":"3784"}', '{"port":0}', '{"port":70000}', '{"port":3784.5}']) {
    assert.deepEqual(address(win, body), { url: DEFAULT_T3_URL, from: "the default" }, String(body));
  }
  // no Vision home at all: nothing is read
  let read = 0;
  assert.equal(t3Address(win, () => false, () => (read++, "{}")).url, DEFAULT_T3_URL);
  assert.equal(read, 0);
  assert.equal(runtimeOrigin("/nowhere", linux, () => { throw new Error("EACCES"); }), null, "unreadable");
});

test("messages name the address actually used, and where it came from", () => {
  const home = mkdtempSync(join(tmpdir(), "t3-runtime-"));
  mkdirSync(join(home, "userdata"));
  // a port nothing serves, outside the range Vision picks from (3783–3983): never a real Vision Code
  writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ version: 1, pid: 1, port: 9, origin: "http://127.0.0.1:9", startedAt: "" }));
  const keep = { T3CODE_HOME: process.env.T3CODE_HOME, T3_URL: process.env.T3_URL };
  process.env.T3CODE_HOME = home;
  delete process.env.T3_URL;
  try {
    assert.equal(t3Url(), "http://127.0.0.1:9");
    const msg = notFoundMessage({ found: null, tried: ["x"] }, null);
    assert.ok(msg.includes(`T3_URL to its address (now http://127.0.0.1:9, from ${join(home, "userdata", "server-runtime.json")})`), msg);
    process.env.T3_URL = "http://127.0.0.1:9/";
    assert.match(notFoundMessage({ found: null, tried: ["x"] }, null), /now http:\/\/127\.0\.0\.1:9, from T3_URL/);
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});

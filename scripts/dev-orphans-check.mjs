#!/usr/bin/env node
// Windows check that a hard-killed launcher leaves nothing behind (SPEC §7, Windows runs).
//
//   node scripts/dev-orphans-check.mjs                 both ways in: `node scripts/dev.mjs` and `npm run dev`
//   node scripts/dev-orphans-check.mjs --launcher F    the same against another copy of the launcher (F)
//
// Each run starts the real launcher on its own ports (above 15000) and data folder, without Kiri, waits for
// the server and Vite to answer, records every process under it, kills the launcher (or npm above it) with
// `taskkill /F` and no /T, as an IDE's stop button or Task Manager would, and expects every one of those
// processes gone and both ports closed within 10 s. Anything it started that is still running is then ended.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { descendants, processTable } from "./dev-watchdog.mjs";

if (process.platform !== "win32") {
  console.log("Windows only: elsewhere each child leads a process group and dev.mjs signals the groups.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const launcher = resolve(root, arg("--launcher") ?? "scripts/dev.mjs");
const SERVER_PORT = Number(process.env.CHECK_SERVER_PORT ?? 15441);
const CLIENT_PORT = Number(process.env.CHECK_CLIENT_PORT ?? 15431);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the walk itself, on a made-up table
{
  const t = 1_000_000;
  const table = [
    { pid: 20, ppid: 10, created: t + 5 }, // npm, under the shell (10) that died with the launcher
    { pid: 30, ppid: 20, created: t + 9 }, // tsx under npm
    { pid: 31, ppid: 30, created: t + 12 }, // the server under tsx
    { pid: 40, ppid: 33, created: t + 20 }, // Kiri: its `start` shell (33) has exited and was never ours
    { pid: 50, ppid: 10, created: t - 5000 }, // a child of an earlier process that had PID 10
    { pid: 60, ppid: 31, created: t + 1 }, // started before its "parent" 31: PID 31 was reused, not ours
  ];
  const got = descendants(table, new Map([[10, t]])).sort();
  if (JSON.stringify(got) !== JSON.stringify([20, 30, 31])) throw new Error(`walk: expected [20,30,31], got ${JSON.stringify(got)}`);
  console.log("walk: finds npm → tsx → server under a dead shell; leaves Kiri, an older PID 10's child and a reused PID alone");
}

const open = (port) =>
  new Promise((r) => {
    const s = net.connect({ port, host: "localhost" });
    s.once("connect", () => (s.destroy(), r(true)));
    s.once("error", () => r(false));
    s.setTimeout(1000, () => (s.destroy(), r(false)));
  });

for (const port of [SERVER_PORT, CLIENT_PORT])
  if (await open(port)) throw new Error(`:${port} is already in use; set CHECK_SERVER_PORT / CHECK_CLIENT_PORT`);

// npm itself (not npm.cmd, whose shell would be the process killed): its CLI beside this node, or beside npm.cmd on PATH
const npmCli = () => {
  const beside = (dir) => join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(beside(dirname(process.execPath)))) return beside(dirname(process.execPath));
  const where = spawnSync("where", ["npm.cmd"], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean);
  const found = where.map((p) => beside(dirname(p))).find(existsSync);
  if (!found) throw new Error("npm-cli.js not found");
  return found;
};
const viaNpm = () => [process.execPath, [npmCli(), "run", "dev"]];
const runs = arg("--launcher")
  ? [["node " + launcher.slice(root.length + 1), () => [process.execPath, [launcher]]]]
  : [
      ["node scripts/dev.mjs", () => [process.execPath, [launcher]]],
      ["npm run dev (npm killed)", viaNpm],
    ];

let failed = 0;
for (const [name, cmd] of runs) {
  console.log(`\n── ${name}`);
  const data = mkdtempSync(join(tmpdir(), "foundation-orphans-"));
  const watchdogLog = `${data}.watchdog.log`;
  const [exe, args] = cmd();
  const startedAt = Date.now();
  const top = spawn(exe, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      FOUNDATION_KIRI: "0",
      FOUNDATION_PORT: String(SERVER_PORT),
      FOUNDATION_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
      FOUNDATION_CLIENT_PORT: String(CLIENT_PORT),
      FOUNDATION_CLIENT_URL: `http://localhost:${CLIENT_PORT}`,
      FOUNDATION_DATA_DIR: data,
      FOUNDATION_WATCHDOG_LOG: watchdogLog,
    },
  });
  let out = "";
  for (const s of [top.stdout, top.stderr]) s.on("data", (b) => (out += b));
  const ours = new Map(); // pid → created, everything under `top` once it's up
  try {
    const t0 = Date.now();
    while (!((await open(SERVER_PORT)) && (await open(CLIENT_PORT)))) {
      if (top.exitCode !== null || Date.now() - t0 > 120_000) throw new Error(`never came up:\n${out}`);
      await wait(500);
    }
    console.log(`up in ${((Date.now() - t0) / 1000).toFixed(1)} s: server :${SERVER_PORT}, client :${CLIENT_PORT}`);
    await wait(1500); // let tsx's server child and Vite's helpers settle

    const table = processTable();
    const known = new Map([[top.pid, startedAt - 1000]]);
    for (const pid of descendants(table, known)) ours.set(pid, table.find((p) => p.pid === pid).created);
    const names = names_(ours);
    console.log(`${ours.size} processes: ${[...ours.keys()].map((p) => `${names.get(p) ?? "?"}:${p}`).join(" ")}`);

    const k = spawnSync("taskkill", ["/F", "/PID", String(top.pid)], { encoding: "utf8", windowsHide: true });
    const killedAt = Date.now();
    console.log(`taskkill /F /PID ${top.pid} → ${(k.stdout || k.stderr).trim()}`);

    let left = [];
    let ports = [];
    // poll cheaply (listing every process takes PowerShell a second or more, and would slow the watchdog's own);
    // once the PIDs are all gone, confirm with a full listing that none of ours is running under them
    const running = (pid) => {
      try {
        return process.kill(pid, 0);
      } catch (e) {
        return e.code === "EPERM";
      }
    };
    while (Date.now() - killedAt < 10_000) {
      left = [...ours.keys()].filter(running);
      ports = [];
      for (const p of [SERVER_PORT, CLIENT_PORT]) if (await open(p)) ports.push(p);
      if (!left.length && !ports.length) break;
      await wait(100);
    }
    const secs = ((Date.now() - killedAt) / 1000).toFixed(1);
    left = alive(ours);
    if (!left.length && !ports.length) console.log(`PASS: all ${ours.size} gone and both ports closed ${secs} s after the kill`);
    else {
      failed++;
      console.log(`FAIL after ${secs} s: still running ${left.map((p) => `${names.get(p) ?? "?"}:${p}`).join(" ") || "(none)"}; ports open ${ports.join(", ") || "(none)"}`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL: ${e.message}`);
  } finally {
    if (!ours.size) {
      const table = processTable() ?? [];
      for (const pid of descendants(table, new Map([[top.pid, startedAt - 1000]]))) ours.set(pid, table.find((p) => p.pid === pid).created);
    }
    const left = alive(ours);
    if (top.exitCode === null) left.push(top.pid);
    if (left.length) {
      spawnSync("taskkill", ["/F", ...left.flatMap((p) => ["/PID", String(p)])], { stdio: "ignore", windowsHide: true });
      console.log(`cleaned up ${left.length} left running`);
    }
    await wait(500);
    if (existsSync(watchdogLog)) console.log(`watchdog log:\n  ${readFileSync(watchdogLog, "utf8").trim().split("\n").join("\n  ")}`);
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(watchdogLog, { force: true });
  }
}

/** the PIDs in `ours` still running as the same process (same start time) */
function alive(ours) {
  const table = processTable() ?? [];
  return table.filter((p) => ours.get(p.pid) === p.created).map((p) => p.pid);
}

function names_(ours) {
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  const m = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const [name, pid] = line.split('","').map((s) => s.replace(/"/g, ""));
    if (ours.has(Number(pid))) m.set(Number(pid), name);
  }
  return m;
}

console.log(failed ? `\n${failed} of ${runs.length} failed` : `\nall ${runs.length} passed`);
process.exit(failed ? 1 : 0);

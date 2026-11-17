#!/usr/bin/env node
// The launcher's watchdog on Windows: when scripts/dev.mjs dies, however it dies, its children die too.
//
// Ctrl+C reaches every process in the console, and dev.mjs's own `taskkill /T` covers a clean stop. A hard
// kill (an IDE's stop button, Task Manager, TerminateProcess) runs neither. Node does put a launcher's
// direct children in a kill-on-close Job Object, but that job lets their children break away, so the
// shell dies and npm, tsx, Vite and the window carry on, holding their ports.
//
// So dev.mjs starts this detached (outside its tree and its job) with a pipe on stdin, and writes each
// child's PID and start time down it. When the pipe closes (the launcher is gone; Windows closes its
// handles however it ended) or the launcher's PID stops answering, this lists every process once, walks
// down from those children by parent PID (theirs may already be dead: the walk keeps going through them)
// and ends what it finds. A process only counts as a descendant if it started after its parent, so a
// reused PID is never mistaken for one of ours. Kiri is started through `start`, whose shell exits at
// once, so nothing links it to these children and it keeps running, as it should.
//
// macOS and Linux don't use this: there each child leads its own process group and dev.mjs signals those.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const win = process.platform === "win32";

/** In the launcher: start the watchdog and return `add(pid, startedAt)` to hand it each child. No-op off Windows. */
export function startWatchdog() {
  if (!win) return { add() {} };
  const w = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watch", String(process.pid)], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  w.on("error", () => {});
  w.stdin.on("error", () => {});
  w.unref();
  w.stdin.unref?.();
  return {
    add(pid, startedAt) {
      if (pid) w.stdin.write(JSON.stringify({ pid, t: startedAt }) + "\n");
    },
  };
}

/** Every process on the machine: { pid, ppid, created } (created in ms since the epoch). Null if it can't be listed. */
export function processTable() {
  const ps =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, " +
    "$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) }";
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((a) => a.length === 3 && a.every(Number.isFinite) && a[0] > 0)
    .map(([pid, ppid, created]) => ({ pid, ppid, created }));
}

/**
 * Grow `known` (pid → the earliest a process with that PID could have started and still be ours) with every
 * process in `table` descended from it, and return the PIDs in it that are still running. A parent in `known`
 * may be dead: its children still name it. A child counts only if it started after its parent.
 */
export function descendants(table, known) {
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table) {
      if (known.has(p.pid) || !known.has(p.ppid) || p.created < known.get(p.ppid)) continue;
      known.set(p.pid, p.created);
      grew = true;
    }
  }
  return table.filter((p) => known.has(p.pid) && p.created >= known.get(p.pid)).map((p) => p.pid);
}

/** End every running descendant of the registered children, a few passes in case something starts as we go. */
function sweep(known) {
  for (let pass = 0; pass < 4; pass++) {
    const table = processTable();
    if (!table) return log("couldn't list processes");
    const pids = descendants(table, known);
    log(`pass ${pass + 1}: ${pids.length ? pids.join(" ") : "nothing left"}`);
    if (!pids.length) return;
    const r = spawnSync("taskkill", ["/F", ...pids.flatMap((p) => ["/PID", String(p)])], { encoding: "utf8", windowsHide: true });
    log(`taskkill → ${r.status} ${(r.stdout + r.stderr).trim().replace(/\s*\r?\n\s*/g, " | ")}`);
  }
}

/** FOUNDATION_WATCHDOG_LOG=<file> records what the watchdog did (it has no console of its own) */
function log(s) {
  if (process.env.FOUNDATION_WATCHDOG_LOG) appendFileSync(process.env.FOUNDATION_WATCHDOG_LOG, `${new Date().toISOString()} ${process.pid} ${s}\n`);
}

function watch(launcher) {
  const known = new Map();
  let buf = "";
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    log(`launcher ${launcher} gone; children ${[...known.keys()].join(" ")}`);
    sweep(known);
    process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (s) => {
    buf += s;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      try {
        const { pid, t } = JSON.parse(buf.slice(0, i));
        // a second of slack: the clock that stamps process creation and Date.now() can disagree slightly
        if (Number.isInteger(pid) && pid > 0) known.set(pid, (Number(t) || 0) - 1000);
      } catch {
        /* not a line we wrote */
      }
    }
  });
  for (const e of ["end", "close", "error"]) process.stdin.on(e, fire);
  // belt and braces: the pipe closing is the signal, but check the PID too
  setInterval(() => {
    try {
      process.kill(launcher, 0);
    } catch (e) {
      if (e.code === "ESRCH") fire();
    }
  }, 1000);
}

if (process.argv[2] === "--watch") watch(Number(process.argv[3]));

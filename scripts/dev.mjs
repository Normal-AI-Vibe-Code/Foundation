#!/usr/bin/env node
// One command for local testing, with prefixed logs, on macOS, Linux and Windows:
//
//   npm run dev       the server (:4410) and the web client (:1430) → open http://localhost:1430
//   npm run desktop   the server and the desktop window (Tauri starts the client itself; needs Rust)
//
// Both also start Kiri, the engine machines run on, if it is installed (npm run kiri:install
// installs it; FOUNDATION_KIRI=0 leaves it alone). It runs on after Foundation stops, as Docker would.
import { spawn } from "node:child_process";
import { startWatchdog } from "./dev-watchdog.mjs";
import { startKiri } from "./kiri.mjs";
import { nodeIsNewEnough, oldNodeMessage } from "./node-check.mjs";

// before anything starts: on a Node that can't run the server, say so plainly and stop (node-check.mjs)
if (!nodeIsNewEnough()) {
  console.error(oldNodeMessage());
  process.exit(1);
}

const win = process.platform === "win32";
const desktop = process.argv.includes("--desktop");
// Windows: a hard kill of this launcher never reaches stop() below, so a watchdog outside its tree ends the children then
const watchdog = startWatchdog();

const procs = [
  ["server", "npm", ["run", "dev", "-w", "@foundation/server"], "\x1b[35m"],
  desktop
    ? ["desktop", "npm", ["run", "tauri", "-w", "@foundation/client", "--", "dev"], "\x1b[36m"]
    : ["client", "npm", ["run", "dev", "-w", "@foundation/client"], "\x1b[34m"],
].map(([name, cmd, args, color]) => {
  // npm is npm.cmd on Windows, which Node only starts through a shell (the arguments are fixed, above)
  // each child leads its own process group (macOS, Linux) so stopping it stops what npm started under it
  const startedAt = Date.now();
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env, shell: win, detached: !win });
  watchdog.add(p.pid, startedAt);
  const tag = `${color}${name.padEnd(7)}\x1b[0m │ `;
  const pipe = (s) => s.on("data", (b) => process.stdout.write(b.toString().replace(/^(?=.)/gm, tag)));
  pipe(p.stdout);
  pipe(p.stderr);
  p.on("exit", (code) => {
    console.log(`${tag}exited ${code}`);
    stopAll();
    process.exit(code ?? 0);
  });
  return p;
});

/** stop a child and everything it started: killing npm alone leaves vite, tsx and the window holding their ports */
function stop(p) {
  if (p.exitCode !== null) return;
  try {
    if (win) spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-p.pid, "SIGINT");
  } catch {
    /* already gone */
  }
}
function stopAll() {
  for (const p of procs) stop(p);
}
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    stopAll();
    process.exit(0);
  });
// Windows: `npm run dev` is npm → a shell → this. Killing npm (an IDE's stop button) takes the shell with it but
// not this, so stop when the parent goes (the watchdog then sees to the children)
const parent = process.ppid;
if (win)
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (e) {
      if (e.code !== "ESRCH") return;
      stopAll();
      process.exit(0);
    }
  }, 1000).unref();
console.log(
  desktop
    ? "\n  Foundation → the desktop window opens once the client is built  (server http://localhost:4410)\n"
    : "\n  Foundation → http://localhost:1430  (server http://localhost:4410)\n",
);

// Kiri alongside, without holding anything up: machines find it once it answers
if (process.env.FOUNDATION_KIRI !== "0") {
  const tag = "\x1b[33mkiri   \x1b[0m │ ";
  startKiri({ log: (s) => console.log(tag + s.replace(/^kiri: /, "")) })
    .then((s) => {
      if (s === "running") console.log(`${tag}already running`);
      else if (s === "started") console.log(`${tag}up: machines run on Kiri`);
      else if (s === "not-installed") console.log(`${tag}not installed (npm run kiri:install); machines use Docker if it runs`);
      else console.log(tag + s);
    })
    .catch((e) => console.log(`${tag}${e.message}`));
}

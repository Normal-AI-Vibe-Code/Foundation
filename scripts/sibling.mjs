#!/usr/bin/env node
/**
 * Run the company's other apps beside Foundation, from their own folders, on
 * the ports Foundation's connectors expect:
 *
 *   node scripts/sibling.mjs factoryform     FactoryForm API + app   :3001
 *   node scripts/sibling.mjs creation        Creation (Vite)          :5173  (its config says 1420 — Vision's port)
 *   node scripts/sibling.mjs creation-hub    Creation Hub             :4317
 *   node scripts/sibling.mjs dataroom [dir]  Airform Data Room (Next) :3010  (dir: a worktree, default AirformDataRoom)
 *   node scripts/sibling.mjs all             all of the above (npm run services)
 *
 * Sibling folders are found next to this repo (../FactoryForm, ../Creation),
 * or at FOUNDATION_SIBLINGS/<Name>.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.FOUNDATION_SIBLINGS ? resolve(process.env.FOUNDATION_SIBLINGS) : resolve(root, "..");

const SERVICES = {
  factoryform: { dir: "FactoryForm", cmd: "npm", args: ["start"], env: { PORT: "3001", HOST: "127.0.0.1" } },
  creation: { dir: "Creation", cmd: "npx", args: ["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], env: {} },
  "creation-hub": { dir: "Creation", cmd: "npm", args: ["run", "hub"], env: { CREATION_HUB_PORT: "4317" } },
  // webpack, not Turbopack: a worktree shares node_modules by symlink, which Turbopack refuses
  dataroom: { dir: process.argv[3] ?? process.env.DATAROOM_DIR ?? "AirformDataRoom", cmd: "npx", args: ["next", "dev", "--webpack", "-p", "3010"], env: {} },
};

const which = process.argv[2] ?? "all";
const names = which === "all" ? Object.keys(SERVICES) : [which];
const procs = [];
for (const name of names) {
  const s = SERVICES[name];
  if (!s) {
    console.error(`unknown service ${name} — one of: ${Object.keys(SERVICES).join(", ")}, all`);
    process.exit(2);
  }
  const cwd = join(base, s.dir);
  if (!existsSync(join(cwd, "package.json"))) {
    console.error(`${name}: ${cwd} not found — clone it next to Foundation or set FOUNDATION_SIBLINGS`);
    if (names.length === 1) process.exit(1);
    continue;
  }
  // npm and npx are .cmd files on Windows, which Node only starts through a shell (the arguments are fixed, above)
  const p = spawn(s.cmd, s.args, { cwd, env: { ...process.env, ...s.env }, stdio: names.length === 1 ? "inherit" : ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  if (names.length > 1) {
    const tag = `${name.padEnd(12)} │ `;
    const pipe = (st) => st.on("data", (b) => process.stdout.write(b.toString().replace(/^(?=.)/gm, tag)));
    pipe(p.stdout);
    pipe(p.stderr);
  }
  p.on("exit", (code) => {
    console.log(`${name} exited ${code}`);
    if (names.length === 1) process.exit(code ?? 0);
  });
  procs.push(p);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => procs.forEach((p) => p.kill(sig)));

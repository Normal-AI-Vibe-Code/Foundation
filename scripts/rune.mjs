#!/usr/bin/env node
// Build Foundation's Rune renderer (apps/rune, Rust) to wasm and put it where the client
// serves it: apps/client/public/rune/. The client only loads it when Settings → Renderer
// says Rune; without a build it says so and keeps the web renderer.
//
//   npm run rune:build          release (small; what a desktop build should carry)
//   npm run rune:build -- --dev fast to build, about twice the size
//   --if-able                   what the desktop build runs: without the Rust toolchain it says so and
//                               goes on (that app has no Rune and stays on the web renderer)
//
// Needs rustup (apps/rune/rust-toolchain.toml pins the toolchain and the wasm target) and
// the wasm-bindgen CLI at the version apps/rune/Cargo.toml pins.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "apps", "rune");
const out = join(root, "apps", "client", "public", "rune");
const dev = process.argv.includes("--dev");
const ifAble = process.argv.includes("--if-able");

const manifest = readFileSync(join(crate, "Cargo.toml"), "utf8");
const bindgen = /wasm-bindgen = "=([\d.]+)"/.exec(manifest)?.[1];
const rev = /rune = \{[^}]*rev = "([0-9a-f]+)"/.exec(manifest)?.[1] ?? "unknown";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.error || r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed${r.error ? `: ${r.error.message}` : ""}`);
    process.exit(r.status || 1);
  }
}

const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
const have = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
if (ifAble && (cargo.status !== 0 || have.status !== 0 || have.stdout.trim() !== `wasm-bindgen ${bindgen}`)) {
  console.warn(`
Rune renderer: not built (needs rustup and wasm-bindgen ${bindgen}; found ${cargo.status === 0 ? cargo.stdout.trim() : "no cargo"}, ${have.status === 0 ? have.stdout.trim() : "no wasm-bindgen"}).
This build has no Rune: Settings → Renderer will say so and the web renderer draws.
`);
  process.exit(0);
}
if (have.status !== 0 || have.stdout.trim() !== `wasm-bindgen ${bindgen}`) {
  console.error(`The wasm-bindgen CLI must be ${bindgen} (found: ${have.stdout?.trim() || "none"}).\n  cargo install wasm-bindgen-cli --version ${bindgen} --locked`);
  process.exit(2);
}

const profile = dev ? "dev" : "release";
run("cargo", ["build", "--target", "wasm32-unknown-unknown", ...(dev ? [] : ["--release"])], crate);
const wasm = join(crate, "target", "wasm32-unknown-unknown", dev ? "debug" : "release", "foundation_rune.wasm");
mkdirSync(out, { recursive: true });
run("wasm-bindgen", [wasm, "--target", "web", "--out-dir", out, "--out-name", "foundation_rune", "--no-typescript"], root);

// the app's face, as TrueType (apps/rune/fonts, from scripts/rune-fonts.py): Rune fetches these beside the wasm
const fonts = readdirSync(join(crate, "fonts")).filter((f) => f.endsWith(".ttf"));
mkdirSync(join(out, "fonts"), { recursive: true });
for (const f of fonts) cpSync(join(crate, "fonts", f), join(out, "fonts", f));

const bytes = statSync(join(out, "foundation_rune_bg.wasm")).size;
writeFileSync(join(out, "rune.json"), JSON.stringify({ rune: rev, profile, bytes, fonts: fonts.length, builtAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`\nRune renderer (${profile}, Rune ${rev.slice(0, 8)}): ${(bytes / 1048576).toFixed(1)} MB -> apps/client/public/rune/`);

/**
 * Every program Foundation's server starts goes through one door (child.ts, ADR-001 G13): its environment
 * is the allowlist plus what its caller names, so the server's keys reach no program that doesn't name
 * one, and only gh does (github.ts, the plan sync). No file under src/ but child.ts imports
 * node:child_process.
 *
 * Nothing runs here: the door's launchers are swapped for a recorder (setChildDeps), each caller is
 * driven through its own entry point, and what it would have started is checked. The server's
 * environment holds fake keys the whole time.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "foundation-child-door-"));
process.env.FOUNDATION_ROOT = dir; // no .env of the checkout's is read
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
process.env.FOUNDATION_WORK_DIR = join(dir, "work");
const claudeJs = join(dir, "claude.js");
writeFileSync(claudeJs, "");
process.env.FOUNDATION_CLAUDE_CLI = claudeJs;
delete process.env.FOUNDATION_AGENT_SCRIPT;

const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-not-real",
  SLACK_BOT_TOKEN: "xoxb-not-real",
  GITHUB_TOKEN: "ghp-not-real",
  GH_TOKEN: "gho-not-real",
  FOUNDATION_SERVICE_TOKEN: "s".repeat(40),
  MESHY_API_KEY: "msy-not-real",
  GOOGLE_CLIENT_SECRET: "g-not-real",
  DATAROOM_READ_TOKEN: "dr-not-real",
  FOO_PASSWORD: "hunter2",
};
// and some that aren't keys but aren't any program's business unless named
const OTHERS: Record<string, string> = {
  CLAUDE_CONFIG_DIR: join(dir, "claude-home"),
  CODEX_HOME: join(dir, "codex-home"),
  T3CODE_PORT: "1",
  T3CODE_DEV_AUTH_TOKEN: "t3-not-real",
  FOUNDATION_GH: join(dir, "gh"),
  FOUNDATION_ALLOWLIST: "@example.test",
};
Object.assign(process.env, SECRETS, OTHERS);
after(() => {
  for (const k of [...Object.keys(SECRETS), ...Object.keys(OTHERS)]) delete process.env[k];
});

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const GH_ALLOWED = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"];

const { childOptions, envFor, setChildDeps, spawnChild, execFileChild, execFileSyncChild } = await import("../src/child.ts");
const { config } = await import("../src/config.ts");
config.github.token = ""; // so github.ts goes to gh, as on a computer signed in with gh only

type Seen = { how: "spawn" | "execFile" | "execFileSync"; cmd: string; args: readonly string[]; opts: { env?: Record<string, string>; cwd?: string } };
const seen: Seen[] = [];

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  stdin = { writable: true, write: () => true, end: () => {} };
  kill() {
    return true;
  }
  unref() {
    return this;
  }
}
/** what a started program does next: nothing, by default */
let then: (c: FakeChild) => void = () => {};
let execOut = "";
setChildDeps({
  spawn: (cmd, args, opts) => {
    seen.push({ how: "spawn", cmd, args, opts: opts as Seen["opts"] });
    const c = new FakeChild();
    setImmediate(() => then(c));
    return c as never;
  },
  execFile: (cmd, args, opts, done) => {
    seen.push({ how: "execFile", cmd, args, opts: opts as Seen["opts"] });
    setImmediate(() => done(null, execOut, ""));
    return new FakeChild() as never;
  },
  execFileSync: (cmd, args, opts) => {
    seen.push({ how: "execFileSync", cmd, args, opts: opts as Seen["opts"] });
    if (cmd === "tar") throw new Error("not run in a test");
    return "";
  },
});

const take = (): Seen[] => seen.splice(0);
const one = (): Seen => {
  const s = take();
  assert.equal(s.length, 1, `one program started (${s.map((x) => x.cmd).join(", ")})`);
  return s[0];
};

/** no secret-looking name but the ones the caller names, every fake key absent unless named, and PATH there */
function clean(s: Seen, named: string[] = []) {
  const env = s.opts.env;
  assert.ok(env, `${s.cmd} was given an environment of its own`);
  for (const k of Object.keys(env)) if (SECRET.test(k)) assert.ok(named.includes(k), `${s.cmd} was given ${k}`);
  for (const k of Object.keys(SECRETS)) if (!named.includes(k)) assert.equal(env[k], undefined, `${s.cmd} got ${k}`);
  assert.ok(Object.keys(env).some((k) => k.toUpperCase() === "PATH"), `${s.cmd} can find programs`);
  assert.equal(env.FOUNDATION_ALLOWLIST, undefined, "nothing of Foundation's own settings it didn't name");
  return env;
}

// ---------- the door itself ----------

test("only child.ts imports node:child_process under apps/server/src", () => {
  const src = resolve(import.meta.dirname, "..", "src");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.[cm]?[jt]sx?$/.test(e.name)) files.push(join(d, e.name));
    }
  };
  walk(src);
  assert.ok(files.length > 20, "the server's sources were read");
  const IMPORTS = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](?:node:)?child_process["']/;
  const doors = files.filter((f) => IMPORTS.test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length + 1).replace(/\\/g, "/"));
  assert.deepEqual(doors, ["child.ts"]);
});

test("a program's options come only from childOptions, and the door builds its environment itself", () => {
  // a plain options object is refused
  assert.throws(() => spawnChild("x", [], { env: process.env } as never), /only with options from childOptions/);
  assert.throws(() => execFileChild("x", [], { env: process.env } as never), /only with options from childOptions/);
  assert.throws(() => execFileSyncChild("x", [], {} as never), /only with options from childOptions/);
  // so is an env handed to childOptions, or a value set under a secret's name
  assert.throws(() => childOptions({ extras: [] }, { env: process.env } as never), /comes from its spec/);
  assert.throws(() => childOptions({ extras: [], set: { MY_TOKEN: "x" } }), /looks like a secret/);
  assert.throws(() => childOptions({} as never), /extras named/);
  assert.equal(take().length, 0, "nothing started");
  // an env put on the options afterwards (or a spread over them) is never what the program gets
  const o = childOptions({ extras: [] }, { cwd: dir });
  spawnChild("x", [], { ...o, env: { ...process.env } as Record<string, string> });
  (o as { env: unknown }).env = process.env;
  spawnChild("y", [], o);
  for (const s of take()) clean(s);
  // values Foundation sets win over the server's, under one spelling on Windows
  const w = envFor({ extras: [], set: { TERM: "dumb" } }, { Path: "C:\\W", Term: "xterm", ANTHROPIC_API_KEY: "k" }, "win32");
  assert.deepEqual(w, { Path: "C:\\W", TERM: "dumb" });
});

// ---------- each caller ----------

test("REA jobs (jobs.ts): base only for rea-agents, Claude Code's login folder for the claude route", async () => {
  const { jobSpawnOptions } = await import("../src/jobs.ts");
  spawnChild("npx", [], jobSpawnOptions({ id: "job_door1" }, { route: "rea-agents" }));
  const rea = clean(one());
  assert.equal(rea.CLAUDE_CONFIG_DIR, undefined);
  spawnChild("claude", [], jobSpawnOptions({ id: "job_door1" }, { route: "claude" }));
  const cl = one();
  assert.equal(clean(cl).CLAUDE_CONFIG_DIR, OTHERS.CLAUDE_CONFIG_DIR);
  assert.equal(resolve(cl.opts.cwd!), resolve(dir, "work", "jobs", "job_door1"));
});

test("Claude Code (agent.ts): `claude --version` and a subscription turn get CLAUDE_CODE_ENV, no key", async () => {
  const { claudeStart, subscriptionSpawnOptions } = await import("../src/agent.ts");
  assert.ok(claudeStart().ok);
  const v = one();
  assert.equal(v.how, "execFileSync");
  assert.ok(v.args.includes("--version"));
  assert.equal(clean(v).CLAUDE_CONFIG_DIR, OTHERS.CLAUDE_CONFIG_DIR);
  spawnChild("claude", ["-p", "hi"], subscriptionSpawnOptions());
  const turn = one();
  assert.equal(clean(turn).ANTHROPIC_API_KEY, undefined, "claude -p would bill it");
  assert.equal(resolve(turn.opts.cwd!), resolve(dir, "work", "agent"));
});

test("Foundation's T3 (t3host.ts): its home, the agents' sign-in folders, no key and none of the server's T3CODE_*", async () => {
  process.env.FOUNDATION_T3_CLI = process.execPath; // never started: the recorder stands in
  process.env.FOUNDATION_T3_READY_MS = "300";
  process.env.FOUNDATION_T3_PORT = "18917";
  const { startT3, T3_ENV } = await import("../src/t3host.ts");
  const st = await startT3("tester");
  assert.equal(st.state, "error", "nothing answered, so it says so");
  const s = take();
  const t3 = s.find((x) => x.args.includes("--bootstrap-fd"));
  assert.ok(t3, "T3 was started");
  const env = clean(t3);
  const home = join(config.dataDir, "t3");
  assert.equal(env.T3CODE_HOME, home);
  assert.equal(resolve(t3.opts.cwd!), resolve(home), "its home is where it was (other code reads it there)");
  assert.equal(env.T3CODE_PORT, undefined);
  assert.equal(env.T3CODE_DEV_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, OTHERS.CLAUDE_CONFIG_DIR);
  assert.equal(env.CODEX_HOME, OTHERS.CODEX_HOME);
  assert.deepEqual([...T3_ENV].sort(), ["CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
  // on Windows a T3 that didn't come up is stopped with taskkill, through the same door
  const kill = s.filter((x) => x.cmd === "taskkill");
  if (process.platform === "win32") assert.equal(kill.length, 1, "taskkill ran");
  for (const k of kill) clean(k);
  delete process.env.FOUNDATION_T3_CLI;
});

test("Vision Code's t3 CLI (vision.ts): the allowlist only, to mint a hand-off session", async () => {
  process.env.T3_CLI = process.execPath;
  process.env.T3CODE_HOME = join(dir, "vision-home");
  then = (c) => c.emit("close", 1);
  const { startThread } = await import("../src/vision.ts");
  await assert.rejects(startThread(join(dir, "handoff"), "t", "x"), /t3 auth session issue failed/);
  then = () => {};
  const s = one();
  assert.ok(s.args.includes("issue"), s.args.join(" "));
  assert.ok(s.args.includes("--base-dir") && s.args.includes(join(dir, "vision-home")), "its home is on the command line");
  const env = clean(s);
  assert.equal(env.T3CODE_HOME, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  delete process.env.T3_CLI;
  delete process.env.T3CODE_HOME;
});

test("Kiri's launcher (machines.ts): the allowlist only", async () => {
  const { launchApart } = await import("../src/machines.ts");
  launchApart("C:\\Kiri\\kiri-win.exe", ["--background"], "win32");
  launchApart("open", ["-g", "-a", "Kiri"], "darwin");
  const s = take();
  assert.deepEqual(s.map((x) => x.cmd), ["cmd.exe", "open"]);
  for (const x of s) assert.equal(clean(x).CLAUDE_CONFIG_DIR, undefined);
});

test("gh (github.ts): gh's own credential and settings, and no other key", async () => {
  execOut = JSON.stringify({ full_name: "a/b", html_url: "https://github.com/a/b", default_branch: "main", pushed_at: "", private: false });
  const { repoInfo, GH_ENV } = await import("../src/github.ts");
  const info = await repoInfo("a/b");
  execOut = "";
  assert.equal(info.fullName, "a/b");
  const s = one();
  assert.equal(s.cmd, "gh");
  const env = clean(s, GH_ALLOWED);
  assert.equal(env.GITHUB_TOKEN, SECRETS.GITHUB_TOKEN);
  assert.equal(env.GH_TOKEN, SECRETS.GH_TOKEN);
  assert.deepEqual([...GH_ENV], ["GITHUB_TOKEN", "GH_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN"]);
  assert.equal(env.FOUNDATION_GH, undefined, "the plan sync's, not this one's");
});

test("the plan sync (plan.ts → scripts/plan.mjs → gh): gh's credential, the plan file, FOUNDATION_GH, no other key", async () => {
  const plan = join(dir, "plan.json");
  writeFileSync(plan, JSON.stringify({ about: "", repo: "a/b", syncedAt: null, columns: [], milestones: [], cards: [] }));
  process.env.FOUNDATION_PLAN_FILE = plan;
  then = (c) => c.emit("close", 1);
  const { syncPlan } = await import("../src/plan.ts");
  await assert.rejects(syncPlan({ id: "u1", email: "a@example.test", name: "Ada", color: "#000", role: "admin" }), /GitHub sync failed/);
  then = () => {};
  const s = one();
  assert.equal(s.cmd, process.execPath);
  const env = clean(s, GH_ALLOWED);
  assert.equal(env.GITHUB_TOKEN, SECRETS.GITHUB_TOKEN);
  assert.equal(env.GH_TOKEN, SECRETS.GH_TOKEN);
  assert.equal(env.FOUNDATION_PLAN_FILE, plan);
  assert.equal(env.FOUNDATION_GH, OTHERS.FOUNDATION_GH);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  delete process.env.FOUNDATION_PLAN_FILE;
});

test("the built-in terminal (hostterm.ts): a person's shell, without the server's keys", async () => {
  const { attachHostTerminal, stopHostTerminals } = await import("../src/hostterm.ts");
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send() {} });
  attachHostTerminal("door-term-1", ws as never, { id: "u1", email: "a@example.test", name: "Ada", color: "#000", role: "admin" });
  stopHostTerminals();
  const s = one();
  const env = clean(s);
  assert.equal(env.TERM, "dumb");
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

test("git (changelog.ts) and tar (flowform-import.ts): the allowlist only", async () => {
  const { changelog } = await import("../src/changelog.ts");
  await changelog(5, dir);
  const git = take();
  assert.equal(git.length, 2);
  for (const g of git) {
    assert.equal(g.cmd, "git");
    clean(g);
  }
  const { openBackup } = await import("../src/flowform-import.ts");
  const archive = join(dir, "backup.tar.gz");
  mkdirSync(dir, { recursive: true });
  writeFileSync(archive, "");
  assert.throws(() => openBackup(archive), /not run in a test/);
  const tar = one();
  assert.equal(tar.cmd, "tar");
  clean(tar);
});

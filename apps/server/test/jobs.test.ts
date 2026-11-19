/**
 * How a REA job starts (rea.ts, jobs.ts): the target is checked, and npx and
 * Claude Code are resolved per platform so nothing goes through a shell. On
 * Windows the npm `.cmd` shims are replaced by the script they wrap, run under
 * this Node; macOS and Linux run `npx` and `claude` as before. The target is
 * always one argument. A refused job says why on its card and runs nothing.
 *
 * Nothing here runs rea-agents or Claude Code or downloads anything: the
 * commands are worked out over a made-up file system. On Windows only, the
 * resolved npx runs with --version (npm itself), and a stand-in claude.cmd
 * shows the target arriving as one argument.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkTarget, claudeCommand, here, npxCommand, reaCommand, REA_DEFAULT_GOAL, type Runtime } from "../src/rea.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
process.env.FOUNDATION_WORK_DIR = join(dir, "work");

/** folders a person approved, in the made-up file systems below (a local target must be inside one) */
const PLACES = ["C:\\Apps", "C:\\Users\\Ada\\a & calc", "C:\\Program Files (x86)\\App", "/Applications", "/srv/foundation/apps", "/Users/ada/a & calc"];

/** a runtime over a made-up file system: `files` (path → text), `dirs`; links are not followed here (real is the path itself) */
function rt(platform: NodeJS.Platform, o: { files?: Record<string, string>; dirs?: string[]; env?: Record<string, string>; execPath?: string; cwd?: string; places?: string[]; home?: string; links?: Record<string, string> } = {}): Runtime {
  const files = o.files ?? {};
  const dirs = new Set(o.dirs ?? []);
  return {
    platform,
    env: o.env ?? {},
    execPath: o.execPath ?? (platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node"),
    cwd: o.cwd ?? (platform === "win32" ? "C:\\Foundation" : "/srv/foundation"),
    exists: (f) => f in files || dirs.has(f),
    isDir: (f) => dirs.has(f),
    read: (f) => {
      if (!(f in files)) throw new Error(`ENOENT ${f}`);
      return files[f];
    },
    real: (f) => o.links?.[f] ?? (f in files || dirs.has(f) ? f : null),
    home: o.home ?? (platform === "win32" ? "C:\\Users\\Ada" : "/Users/ada"),
    places: o.places ?? PLACES,
  };
}

const NPX_CLI = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js";
const NPM_SHIM = (script: string) => `@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*\r\n`;
const APP_WIN = "C:\\Apps\\Slack\\resources\\app.asar";
const APP_MAC = "/Applications/Slack.app/Contents/Resources/app.asar";
const REA = (target: string) => ["--registry=https://registry.npmjs.org/", "-y", "rea-agents@6.9.0", "analyze-javascript-application", target, "--json"];

test("npx on Windows: npm's npx-cli.js under this Node, never npx.cmd", () => {
  // next to the running Node (an ordinary install)
  assert.deepEqual(npxCommand(rt("win32", { files: { [NPX_CLI]: "" } })), { ok: true, cmd: "C:\\Program Files\\nodejs\\node.exe", pre: [NPX_CLI] });
  // a Node with no npm beside it: npm_execpath (set by `npm run`) names npm-cli.js, and npx-cli.js is its sibling
  const portable = "C:\\Temp\\node-v22\\node.exe";
  const viaExec = npxCommand(rt("win32", { execPath: portable, files: { [NPX_CLI]: "" }, env: { npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" } }));
  assert.deepEqual(viaExec, { ok: true, cmd: portable, pre: [NPX_CLI] });
  // or an npx.cmd on PATH (any case of the name): the script it points at, not the shim
  const roaming = "C:\\Users\\Ada\\AppData\\Roaming\\npm";
  const roamingCli = `${roaming}\\node_modules\\npm\\bin\\npx-cli.js`;
  const viaPath = npxCommand(rt("win32", { execPath: portable, env: { Path: `C:\\Windows;"${roaming}"` }, files: { [`${roaming}\\npx.cmd`]: NPM_SHIM("node_modules\\npm\\bin\\npx-cli.js"), [roamingCli]: "" } }));
  assert.deepEqual(viaPath, { ok: true, cmd: portable, pre: [roamingCli] });
  // none of them: refused, saying where it looked
  const none = npxCommand(rt("win32", { execPath: portable, env: { Path: "C:\\Windows" } }));
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : "", /npx-cli\.js.*C:\\Temp\\node-v22\\node_modules\\npm\\bin\\npx-cli\.js/s);
  // macOS and Linux: npx, as before
  assert.deepEqual(npxCommand(rt("darwin")), { ok: true, cmd: "npx", pre: [] });
  assert.deepEqual(npxCommand(rt("linux")), { ok: true, cmd: "npx", pre: [] });
});

test("Claude Code on Windows: claude.exe as is, an npm claude.cmd as the cli.js it wraps, otherwise refused", () => {
  const bin = "C:\\Users\\Ada\\.local\\bin";
  const npm = "C:\\Users\\Ada\\AppData\\Roaming\\npm";
  const env = { PATH: `${bin};${npm}` };
  assert.deepEqual(claudeCommand("claude", rt("win32", { env, files: { [`${bin}\\claude.exe`]: "" } })), { ok: true, cmd: `${bin}\\claude.exe`, pre: [] });
  // an .exe wins over a .cmd in the same folder (Windows' own order)
  assert.deepEqual(claudeCommand("claude", rt("win32", { env, files: { [`${npm}\\claude.cmd`]: "", [`${npm}\\claude.exe`]: "" } })), { ok: true, cmd: `${npm}\\claude.exe`, pre: [] });
  const cliJs = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  assert.deepEqual(claudeCommand("claude", rt("win32", { env, files: { [`${npm}\\claude.cmd`]: NPM_SHIM("node_modules\\@anthropic-ai\\claude-code\\cli.js"), [cliJs]: "" } })), {
    ok: true,
    cmd: "C:\\Program Files\\nodejs\\node.exe",
    pre: [cliJs],
  });
  // a .cmd with no script in it would need cmd.exe: refused, with what to set
  const odd = claudeCommand("claude", rt("win32", { env, files: { [`${npm}\\claude.cmd`]: "@echo off\r\nsomething.exe %*\r\n" } }));
  assert.equal(odd.ok, false);
  assert.match(!odd.ok ? odd.reason : "", /\.cmd script.*cmd\.exe.*FOUNDATION_CLAUDE_CLI/s);
  const missing = claudeCommand("claude", rt("win32", { env }));
  assert.match(!missing.ok ? missing.reason : "", /isn't on this computer's PATH/);
  // FOUNDATION_CLAUDE_CLI as a full path
  assert.deepEqual(claudeCommand("D:\\tools\\claude.exe", rt("win32", { files: { "D:\\tools\\claude.exe": "" } })), { ok: true, cmd: "D:\\tools\\claude.exe", pre: [] });
  // macOS and Linux: the CLI as configured, as before
  assert.deepEqual(claudeCommand("claude", rt("darwin")), { ok: true, cmd: "claude", pre: [] });
});

test("the exact REA command on win32 and darwin", () => {
  const win = rt("win32", { files: { [NPX_CLI]: "", [APP_WIN]: "", "C:\\Users\\Ada\\.local\\bin\\claude.exe": "" }, env: { Path: "C:\\Users\\Ada\\.local\\bin" } });
  const mac = rt("darwin", { files: { [APP_MAC]: "" } });
  const job = { target: APP_WIN, goal: "How does it sync?" };
  assert.deepEqual(reaCommand(job, "claude", win), { ok: true, route: "rea-agents", target: APP_WIN, cmd: "C:\\Program Files\\nodejs\\node.exe", argv: [NPX_CLI, ...REA(APP_WIN)] });
  assert.deepEqual(reaCommand({ ...job, target: APP_MAC }, "claude", mac), { ok: true, route: "rea-agents", target: APP_MAC, cmd: "npx", argv: REA(APP_MAC) });
  // a directory is an app too, and a relative path is made absolute (the job runs in its own work folder, not here)
  const macDir = rt("darwin", { dirs: ["/srv/foundation/apps/web"] });
  assert.deepEqual(reaCommand({ target: "apps/web", goal: "" }, "claude", macDir), { ok: true, route: "rea-agents", target: "/srv/foundation/apps/web", cmd: "npx", argv: REA("/srv/foundation/apps/web") });
  // a URL goes to Claude Code with REA's MCP: the target is inside the one prompt argument
  const url = "https://example.com/app";
  const w = reaCommand({ target: url, goal: "" }, "claude", win);
  const m = reaCommand({ target: url, goal: "" }, "claude", mac);
  assert.ok(w.ok && m.ok);
  assert.equal(w.cmd, "C:\\Users\\Ada\\.local\\bin\\claude.exe");
  assert.equal(m.cmd, "claude");
  for (const p of [w, m]) {
    assert.equal(p.route, "claude");
    assert.equal(p.argv.length, 4);
    assert.equal(p.argv[0], "-p");
    assert.ok(p.argv[1].startsWith(`Reverse-engineer ${url} for Form Industries`));
    assert.ok(p.argv[1].includes(`Goal: ${REA_DEFAULT_GOAL}`));
    assert.deepEqual(p.argv.slice(2), ["--output-format", "text"]);
  }
});

test("a target that looks like an option, or isn't a URL or a path, is refused before anything runs", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const r = rt(platform, { files: { [NPX_CLI]: "" } });
    for (const bad of ["--foo", "-rf", "--output-format=json", "https://x & calc", "x & calc", "file:///etc/passwd", "javascript://alert(1)", "", "  ", "https://ok.com\n--json", "C:\\nope\\app.asar"]) {
      const p = reaCommand({ target: bad, goal: "" }, "claude", r);
      assert.equal(p.ok, false, `${platform}: ${JSON.stringify(bad)} is refused`);
    }
    const opt = checkTarget("--foo", r);
    assert.match(!opt.ok ? opt.reason : "", /starts with "-".*option/);
  }
  // a bare host is a web address
  assert.deepEqual(checkTarget("github.com/morluto/rea", rt("darwin")), { ok: true, kind: "url", target: "github.com/morluto/rea" });
});

test("shell characters in a target stay one argument (or are refused where cmd.exe would see them)", () => {
  const url = "https://example.com/a?b=1&calc|whoami>out;$(id)`id`";
  for (const platform of ["win32", "darwin"] as const) {
    const r = rt(platform, { files: { [NPX_CLI]: "", "C:\\bin\\claude.exe": "" }, env: { PATH: "C:\\bin" } });
    const p = reaCommand({ target: url, goal: "x & calc" }, "claude", r);
    assert.ok(p.ok);
    assert.equal(p.argv.filter((a) => a.includes(url)).length, 1, "the URL is in exactly one argument");
    assert.equal(p.argv.length, 4);
    assert.ok(!p.argv.includes("calc"));
  }
  // an app folder named with & : one argument on macOS; on Windows npx would hand it to cmd.exe, so it's refused
  const macApp = "/Users/ada/a & calc";
  const mac = reaCommand({ target: macApp, goal: "" }, "claude", rt("darwin", { dirs: [macApp] }));
  assert.ok(mac.ok);
  assert.deepEqual(mac.argv, REA(macApp));
  const winApp = "C:\\Users\\Ada\\a & calc";
  const win = reaCommand({ target: winApp, goal: "" }, "claude", rt("win32", { dirs: [winApp], files: { [NPX_CLI]: "" } }));
  assert.equal(win.ok, false);
  assert.match(!win.ok ? win.reason : "", /cmd\.exe/);
  // parentheses and spaces (Program Files (x86)) are fine
  const x86 = "C:\\Program Files (x86)\\App\\resources\\app.asar";
  const ok = reaCommand({ target: x86, goal: "" }, "claude", rt("win32", { files: { [NPX_CLI]: "", [x86]: "" } }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.argv, [NPX_CLI, ...REA(x86)]);
});

test("a refused job says why on its card and doesn't run", async () => {
  const { run: runSql } = await import("../src/db.ts");
  runSql("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, 'member', ?)", "u", "u@formindustries.com", "Tester", "#325bb4", Date.now());
  const { runTool } = await import("../src/tools.ts");
  const { getBoard, closeBoards } = await import("../src/boards.ts");
  const { startJob, getJob, jobShown } = await import("../src/jobs.ts");
  const { boardMaps, appendSection } = await import("@foundation/protocol");
  after(() => closeBoards());
  const board = getBoard("jobs-board");
  board.doc.transact(() => appendSection(board.doc, "Research"));
  const ctx = { boardId: "jobs-board", actor: "test", userId: "u" };
  const q = (await runTool(ctx, "reverse_engineer", { target: "--foo", goal: "map it" })) as { job: string; card: string };
  const job = startJob(q.job, "jobs-board", "Tester", jobShown(getJob(q.job)!).shown);
  assert.equal(job.status, "error");
  assert.match(job.output, /starts with "-"/);
  const card = boardMaps(board.doc).objects.get(q.card) as { status: string; text: string };
  assert.equal(card.status, "error");
  assert.match(card.text, /^Didn't start: The target "--foo" starts with "-"/);
  assert.equal(getJob(q.job)!.status, "error");
});

test("on Windows: the resolved npx starts without a shell, and a claude.cmd's arguments arrive whole", { skip: process.platform !== "win32" && "Windows only" }, (t) => {
  const npx = npxCommand(here());
  assert.ok(npx.ok, !npx.ok ? npx.reason : "");
  const version = execFileSync(npx.cmd, [...npx.pre, "--version"], { encoding: "utf8", timeout: 60_000, windowsHide: true }).trim();
  t.diagnostic(`npx resolved to ${npx.cmd} ${npx.pre.join(" ")} → --version ${version}`);
  assert.match(version, /^\d+\.\d+\.\d+/);
  const claude = claudeCommand(process.env.FOUNDATION_CLAUDE_CLI || "claude", here());
  t.diagnostic(`claude resolves to ${claude.ok ? `${claude.cmd} ${claude.pre.join(" ")}`.trim() : `nothing: ${claude.reason}`}`);

  // a stand-in npm shim, claude.cmd → echo.cjs: reaCommand runs the script under Node, and argv comes through as built
  const shimDir = join(dir, "shim");
  mkdirSync(join(shimDir, "node_modules", "fake-claude"), { recursive: true });
  writeFileSync(join(shimDir, "node_modules", "fake-claude", "echo.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(shimDir, "claude.cmd"), NPM_SHIM("node_modules\\fake-claude\\echo.cjs"));
  const url = "https://example.com/a?b=1&calc";
  const plan = reaCommand({ target: url, goal: "x & echo pwned" }, join(shimDir, "claude.cmd"), here());
  assert.ok(plan.ok, !plan.ok ? plan.reason : "");
  assert.equal(plan.cmd, process.execPath);
  const res = spawnSync(plan.cmd, plan.argv, { encoding: "utf8", windowsHide: true });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), plan.argv.slice(1));
});

// ---------- ADR-001 G13: a pinned rea-agents, checked before it starts, with no keys and outside data/ ----------

// the boards these checks open are closed once the file is done (the refused-job check closes its own after itself)
after(async () => (await import("../src/boards.ts")).closeBoards());

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const SECRETS = { ANTHROPIC_API_KEY: "sk-ant-not-real", SLACK_BOT_TOKEN: "xoxb-not-real", GITHUB_TOKEN: "ghp-not-real", FOUNDATION_SERVICE_TOKEN: "s".repeat(40), MESHY_API_KEY: "msy-not-real", GOOGLE_CLIENT_SECRET: "g-not-real", FOO_PASSWORD: "hunter2" };
const isUnder = (child: string, parent: string) => {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** a child process that ran and finished at once (nothing really starts) */
function fakeChild(code = 0, out = "") {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  setImmediate(() => {
    if (out) c.stdout.emit("data", Buffer.from(out));
    c.emit("close", code);
  });
  return c as unknown as ChildProcess;
}

/** a REA job on a local app folder (the rea-agents route) */
async function queueAppJob() {
  const { run: runSql } = await import("../src/db.ts");
  runSql("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, 'member', ?)", "u", "u@formindustries.com", "Tester", "#325bb4", Date.now());
  const { runTool } = await import("../src/tools.ts");
  const { getBoard } = await import("../src/boards.ts");
  const { appendSection, boardMaps } = await import("@foundation/protocol");
  const board = getBoard("jobs-board");
  if (boardMaps(board.doc).sections.size === 0) board.doc.transact(() => appendSection(board.doc, "Research"));
  const app = join(dir, "places", "an-app");
  mkdirSync(app, { recursive: true });
  // the folder it is in is one a person approved (jobs.ts asks places.ts; here, a stand-in)
  const { setJobDeps } = await import("../src/jobs.ts");
  setJobDeps({ places: () => [realpathSync.native(join(dir, "places"))] });
  return (await runTool({ boardId: "jobs-board", actor: "test", userId: "u" }, "reverse_engineer", { target: app, goal: "map it" })) as { job: string; card: string };
}

async function until(what: string, ok: () => boolean) {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
}

test("the pinned rea-agents: a matching integrity passes, a different one or no answer refuses (no network)", async () => {
  const { checkReaIntegrity, REA_AGENTS } = await import("../src/rea.ts");
  assert.equal(REA_AGENTS.version, "6.9.0");
  let asked: string[] = [];
  assert.equal(
    await checkReaIntegrity(async (n, v) => {
      asked = [n, v];
      return REA_AGENTS.integrity;
    }),
    null,
  );
  assert.deepEqual(asked, ["rea-agents", "6.9.0"], "it asks for the exact pinned version");
  assert.match((await checkReaIntegrity(async () => "sha512-somethingElse==")) ?? "", /npm's registry says rea-agents@6\.9\.0 is sha512-somethingElse==, not .* Foundation pinned, so it didn't start/);
  assert.match((await checkReaIntegrity(async () => undefined)) ?? "", /is missing/);
  assert.match(
    (await checkReaIntegrity(async () => {
      throw new Error("offline");
    })) ?? "",
    /Couldn't check rea-agents@6\.9\.0.*offline.*didn't start/,
  );
});

test("a REA job starts the pinned version in a folder of its own, with no keys (ADR-001 G13)", async () => {
  const { startJob, getJob, setJobDeps, jobShown } = await import("../src/jobs.ts");
  const { checkReaIntegrity, REA_AGENTS } = await import("../src/rea.ts");
  const spawned: Array<{ cmd: string; argv: string[]; opts: SpawnOptions }> = [];
  Object.assign(process.env, SECRETS);
  try {
    setJobDeps({
      spawn: (cmd, argv, opts) => {
        spawned.push({ cmd, argv, opts });
        return fakeChild(0, '{"ok":true}');
      },
      integrity: () => checkReaIntegrity(async () => REA_AGENTS.integrity),
    });
    const q = await queueAppJob();
    startJob(q.job, "jobs-board", "Tester", jobShown(getJob(q.job)!).shown);
    await until("the job ran", () => getJob(q.job)!.status === "done");
  } finally {
    for (const k of Object.keys(SECRETS)) delete process.env[k];
  }
  assert.equal(spawned.length, 1);
  const { argv, opts } = spawned[0];
  assert.ok(argv.includes("rea-agents@6.9.0"), argv.join(" "));
  assert.ok(!argv.some((a) => a.includes("@latest")));
  const env = opts.env as Record<string, string>;
  for (const k of Object.keys(env)) assert.ok(!SECRET.test(k), `the job was given ${k}`);
  assert.ok(Object.keys(env).some((k) => k.toUpperCase() === "PATH"), "it can find programs");
  const cwd = String(opts.cwd);
  assert.ok(!isUnder(cwd, process.env.FOUNDATION_DATA_DIR!), `${cwd} is in data/`);
  assert.ok(isUnder(cwd, process.env.FOUNDATION_WORK_DIR!), `${cwd} is under the work folder`);
});

test("a REA job whose pinned version doesn't match the registry fails with a plain sentence and starts nothing", async () => {
  const { startJob, getJob, setJobDeps, jobShown } = await import("../src/jobs.ts");
  const { checkReaIntegrity } = await import("../src/rea.ts");
  const spawned: string[] = [];
  setJobDeps({
    spawn: (cmd) => {
      spawned.push(cmd);
      return fakeChild();
    },
    integrity: () => checkReaIntegrity(async () => "sha512-swapped=="),
  });
  const q = await queueAppJob();
  startJob(q.job, "jobs-board", "Tester", jobShown(getJob(q.job)!).shown);
  await until("the job failed", () => getJob(q.job)!.status === "error");
  assert.match(getJob(q.job)!.output, /npm's registry says rea-agents@6\.9\.0 is sha512-swapped==.*didn't start/);
  assert.equal(spawned.length, 0, "nothing started");
});

test("the Claude Code route of a REA job gets only Claude Code's own extras, in its own folder", async () => {
  const { jobSpawnOptions } = await import("../src/jobs.ts");
  Object.assign(process.env, SECRETS, { CLAUDE_CONFIG_DIR: join(dir, "claude-home") });
  try {
    const o = jobSpawnOptions({ id: "job_abc123" }, { route: "claude" });
    const env = o.env as Record<string, string>;
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "never the API key: claude -p would bill it");
    assert.equal(env.CLAUDE_CONFIG_DIR, join(dir, "claude-home"));
    for (const k of Object.keys(env)) assert.ok(!SECRET.test(k), k);
    assert.equal(resolve(String(o.cwd)), resolve(process.env.FOUNDATION_WORK_DIR!, "jobs", "job_abc123"));
    assert.equal((jobSpawnOptions({ id: "job_abc123" }, { route: "rea-agents" }).env as Record<string, string>).CLAUDE_CONFIG_DIR, undefined, "rea-agents doesn't get Claude Code's");
  } finally {
    for (const k of [...Object.keys(SECRETS), "CLAUDE_CONFIG_DIR"]) delete process.env[k];
  }
});

// ---------- what runs is what a person saw, on a folder a person approved ----------

test("a local target must be inside an approved folder, on its real path, and never home's or any hidden file, key or credential", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const W = platform === "win32";
    const P = (s: string) => (W ? `C:\\Users\\Ada\\${s.replace(/\//g, "\\")}` : `/Users/ada/${s}`);
    const place = P("Projects");
    const inside = P("Projects/app.asar");
    const file = P("Projects/notes.txt");
    const outside = P("Elsewhere/app.asar");
    const dotted = [P("Projects/.env"), P("Projects/.git/config"), P(".ssh/id_ed25519"), P(".aws/credentials"), P(".claude/settings.json"), P(".config/gh/hosts.yml"), P(".npmrc"), P("Projects/keys/server.pem")];
    const home = W ? "C:\\Users\\Ada" : "/Users/ada";
    const above = W ? "C:\\Users" : "/Users";
    const files = Object.fromEntries([inside, file, outside, ...dotted].map((f) => [f, ""]));
    const r = rt(platform, { files: { ...files, [NPX_CLI]: "", "C:\\bin\\claude.exe": "" }, dirs: [place, home, above], places: [place, P(".ssh"), P(".aws"), P(".claude"), P(".config"), home, above], home, env: { PATH: "C:\\bin" } });
    // inside the approved folder: fine (an app goes to rea-agents, a file to Claude Code)
    assert.deepEqual(checkTarget(inside, r), { ok: true, kind: "app", target: inside });
    assert.deepEqual(checkTarget(file, r), { ok: true, kind: "file", target: file });
    // outside every approved folder: refused, saying so
    const out = checkTarget(outside, rt(platform, { files, places: [place], home }));
    assert.match(!out.ok ? out.reason : "", /isn't inside a folder a person approved/);
    // home, or anything above it: refused, even if (somehow) listed as approved
    for (const t of [home, above]) assert.match(((x) => (!x.ok ? x.reason : ""))(checkTarget(t, r)), /home folder or holds it/, `${platform}: ${t}`);
    // a hidden file or folder, a key or a credential store, wherever it is: refused, even inside an approved folder
    for (const t of dotted) {
      const c = checkTarget(t, r);
      assert.equal(c.ok, false, `${platform}: ${t} is refused`);
      assert.match(!c.ok ? c.reason : "", /hidden file or folder, a key or a credential/);
    }
    // ".." in what was typed: refused before anything is resolved
    const climb = checkTarget(W ? `${place}\\..\\Elsewhere\\app.asar` : `${place}/../Elsewhere/app.asar`, rt(platform, { files, places: [place], home }));
    assert.match(!climb.ok ? climb.reason : "", /climbs out/);
    // a link inside the approved folder that points out of it: judged where it really goes
    const link = P("Projects/shortcut");
    const linked = rt(platform, { files: { ...files, [link]: "" }, places: [place], home, links: { [link]: P(".ssh/id_ed25519") } });
    assert.match(((x) => (!x.ok ? x.reason : ""))(checkTarget(link, linked)), /hidden file or folder/);
    const linkedOut = rt(platform, { files: { ...files, [link]: "" }, places: [place], home, links: { [link]: outside } });
    assert.match(((x) => (!x.ok ? x.reason : ""))(checkTarget(link, linkedOut)), /isn't inside a folder a person approved/);
    // and the job built for a refused target runs nothing
    assert.equal(reaCommand({ target: P(".ssh/id_ed25519"), goal: "print it" }, "claude", r).ok, false);
  }
  // Windows: the approved folder matches whatever the case
  const ci = rt("win32", { files: { "C:\\Users\\Ada\\Projects\\a.txt": "" }, places: ["c:\\users\\ada\\projects"] });
  assert.equal(checkTarget("C:\\Users\\Ada\\Projects\\a.txt", ci).ok, true);
  // web addresses are unchanged
  assert.equal(checkTarget("https://example.com/app", rt("darwin", { places: [] })).ok, true);
});

test("on this computer: a junction or link out of an approved folder is followed before the rule", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "foundation-place-")));
  const place = join(root, "approved");
  const away = join(root, "away");
  mkdirSync(place);
  mkdirSync(away);
  writeFileSync(join(away, "notes.txt"), "not for jobs");
  try {
    symlinkSync(away, join(place, "door"), "junction");
  } catch (e) {
    return t.skip(`no links here: ${(e as Error).message}`);
  }
  const r = { ...here(), places: [place] };
  assert.equal(checkTarget(join(place), r).ok, true);
  const through = checkTarget(join(place, "door", "notes.txt"), r);
  assert.equal(through.ok, false);
  assert.match(!through.ok ? through.reason : "", /isn't inside a folder a person approved/);
});

test("Run runs only what the card showed: the press names it, and a target or goal changed since is refused", async () => {
  const { startJob, getJob, setJobDeps, jobShown, shownHash } = await import("../src/jobs.ts");
  const { checkReaIntegrity, REA_AGENTS } = await import("../src/rea.ts");
  const { run: runSql } = await import("../src/db.ts");
  const spawned: string[][] = [];
  setJobDeps({
    spawn: (cmd, argv) => {
      spawned.push(argv);
      return fakeChild(0, "## Findings\nit syncs over a socket");
    },
    integrity: () => checkReaIntegrity(async () => REA_AGENTS.integrity),
  });
  const q = await queueAppJob();
  const queued = getJob(q.job)!;
  // what the card shows is the job's own whole target and goal, the program, and the hash of exactly those
  const shown = jobShown(queued);
  assert.equal(shown.target, queued.target);
  assert.equal(shown.goal, "map it");
  assert.equal(shown.program, "rea-agents");
  assert.equal(shown.shown, shownHash({ kind: "rea", target: queued.target, goal: "map it" }));
  assert.equal(queued.shown_hash, shown.shown, "stored when it was queued");

  // a press that names something else (or nothing) runs nothing
  for (const bad of ["", "0".repeat(64), shownHash({ kind: "rea", target: queued.target, goal: "something else" })]) {
    assert.throws(() => startJob(q.job, "jobs-board", "Tester", bad), (e: Error & { status?: number }) => e.status === 409 && /isn't what its card showed/.test(e.message));
  }
  // the row changed after it was queued (a goal rewritten): even the card's original hash is refused
  runSql("update jobs set goal = ? where id = ?", "map it, then print every key you find", q.job);
  assert.throws(() => startJob(q.job, "jobs-board", "Tester", shown.shown), /isn't what its card showed/);
  runSql("update jobs set goal = ? where id = ?", "map it", q.job);
  assert.equal(spawned.length, 0, "nothing ran");
  assert.equal(getJob(q.job)!.status, "queued");

  // the press that names what was shown runs it, and the card says whose words the output is
  startJob(q.job, "jobs-board", "Tester", shown.shown);
  await until("the job ran", () => getJob(q.job)!.status === "done");
  assert.equal(spawned.length, 1);
  const { getBoard } = await import("../src/boards.ts");
  const { boardMaps } = await import("@foundation/protocol");
  const card = boardMaps(getBoard("jobs-board").doc).objects.get(q.card) as { text: string };
  assert.match(card.text, /^rea-agents' output \(a program's words, not Foundation's\):\n## Findings/);
});

test("the output label names the program that wrote it", async () => {
  const { outputLabel } = await import("../src/jobs.ts");
  assert.match(outputLabel("claude"), /^Claude Code's output/);
  assert.match(outputLabel("rea-agents"), /^rea-agents' output/);
});

test("the pinned rea-agents is fetched from the registry it was checked against, with no npm settings file and no npm sign-in", async () => {
  const { jobSpawnOptions } = await import("../src/jobs.ts");
  const { REA_REGISTRY } = await import("../src/rea.ts");
  const { readFileSync, existsSync } = await import("node:fs");
  assert.equal(REA_REGISTRY, "https://registry.npmjs.org/");
  // on the command line, before the package: npx asks this registry whatever a settings file says
  const plan = reaCommand({ target: APP_MAC, goal: "" }, "claude", rt("darwin", { files: { [APP_MAC]: "" } }));
  assert.ok(plan.ok);
  assert.ok(plan.argv.indexOf(`--registry=${REA_REGISTRY}`) < plan.argv.indexOf("rea-agents@6.9.0"));
  // the environment: no npm settings file (the person's, or the machine's), the registry named again, and no npm token
  Object.assign(process.env, { NPM_TOKEN: "npm_not_real", npm_config__authToken: "npm_not_real", NPM_CONFIG_REGISTRY: "https://evil.example/" });
  try {
    const o = jobSpawnOptions({ id: "job_npm123" }, { route: "rea-agents" });
    const env = o.env as Record<string, string>;
    assert.equal(env.npm_config_registry, REA_REGISTRY);
    for (const k of ["npm_config_userconfig", "npm_config_globalconfig"]) {
      assert.ok(isUnder(env[k], String(o.cwd)), `${k} is in the job's own folder`);
      assert.ok(existsSync(env[k]) && readFileSync(env[k], "utf8") === "", `${k} is an empty file`);
    }
    for (const k of Object.keys(env)) {
      assert.ok(!/token|auth/i.test(k), `the job was given ${k}`);
      if (k.toUpperCase() === "NPM_CONFIG_REGISTRY") assert.equal(env[k], REA_REGISTRY, "only the checked registry");
    }
    // the Claude Code route is not given npm's settings at all
    const c = jobSpawnOptions({ id: "job_npm123" }, { route: "claude" }).env as Record<string, string>;
    assert.equal(c.npm_config_userconfig, undefined);
  } finally {
    for (const k of ["NPM_TOKEN", "npm_config__authToken", "NPM_CONFIG_REGISTRY"]) delete process.env[k];
  }
});

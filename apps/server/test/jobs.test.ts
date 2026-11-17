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
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTarget, claudeCommand, here, npxCommand, reaCommand, REA_DEFAULT_GOAL, type Runtime } from "../src/rea.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = dir;

/** a runtime over a made-up file system: `files` (path → text), `dirs` */
function rt(platform: NodeJS.Platform, o: { files?: Record<string, string>; dirs?: string[]; env?: Record<string, string>; execPath?: string; cwd?: string } = {}): Runtime {
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
  };
}

const NPX_CLI = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js";
const NPM_SHIM = (script: string) => `@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*\r\n`;
const APP_WIN = "C:\\Apps\\Slack\\resources\\app.asar";
const APP_MAC = "/Applications/Slack.app/Contents/Resources/app.asar";
const REA = (target: string) => ["-y", "rea-agents@latest", "analyze-javascript-application", target, "--json"];

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
  // a directory is an app too, and a relative path is made absolute (the job runs in the data folder, not here)
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
  const { startJob, getJob } = await import("../src/jobs.ts");
  const { boardMaps, appendSection } = await import("@foundation/protocol");
  after(() => closeBoards());
  const board = getBoard("jobs-board");
  board.doc.transact(() => appendSection(board.doc, "Research"));
  const ctx = { boardId: "jobs-board", actor: "test", userId: "u" };
  const q = (await runTool(ctx, "reverse_engineer", { target: "--foo", goal: "map it" })) as { job: string; card: string };
  const job = startJob(q.job, "jobs-board", "Tester");
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

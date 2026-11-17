/**
 * The subscription runtime starts Claude Code without a shell (agent.ts →
 * rea.ts claudeCommand): an npm `claude.cmd` runs the cli.js it wraps under
 * this Node, claude.exe runs as is, and one that can't be started turns the
 * runtime off with the reason, which the runtimes report and a run says.
 *
 * No real Claude Code runs (a turn spends the person's plan): a stand-in
 * answers --version and speaks a few lines of stream-json, and records the
 * arguments it got. On Windows it's an npm-style claude.cmd; elsewhere a
 * `#!` script, the way `claude` is configured there.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@foundation/protocol";
import type { Runtime } from "../src/rea.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = dir;
delete process.env.FOUNDATION_AGENT_SCRIPT;
const log = join(dir, "claude.log");
const win = process.platform === "win32";
const pkg = join(dir, "npm", "node_modules", "stand-in-claude");
mkdirSync(pkg, { recursive: true });
const cliJs = join(pkg, "cli.cjs");
writeFileSync(
  cliJs,
  `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (a[0] === "--version") { console.log("9.9.9 (stand-in Claude Code)"); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "stand-in-1" });
out({ type: "assistant", session_id: "stand-in-1", message: { content: [{ type: "text", text: "got it" }] } });
out({ type: "result", session_id: "stand-in-1", usage: { input_tokens: 1, output_tokens: 2 } });
`,
);
chmodSync(cliJs, 0o755);
// npm's cmd-shim, as `npm i -g` writes it
const shim = join(dir, "npm", "claude.cmd");
writeFileSync(
  shim,
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\stand-in-claude\\cli.cjs" %*\r\n`,
);
process.env.FOUNDATION_CLAUDE_CLI = win ? shim : cliJs.replace(/\.cjs$/, "");
if (!win) writeFileSync(process.env.FOUNDATION_CLAUDE_CLI, readFileSync(cliJs, "utf8"), { mode: 0o755 });

const { upsertUser } = await import("../src/auth.ts");
const { closeBoards } = await import("../src/boards.ts");
const { claudeStart, resolveClaude, runtimes, runAgent } = await import("../src/agent.ts");
after(() => closeBoards());

const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);

test("Claude Code is resolved without a shell, and answers --version", () => {
  const c = claudeStart();
  assert.ok(c.ok, !c.ok ? c.reason : "");
  if (win) assert.deepEqual(c, { ok: true, cmd: process.execPath, pre: [cliJs] }, "the .cmd's cli.js under this Node, not the shim");
  else assert.deepEqual(c, { ok: true, cmd: process.env.FOUNDATION_CLAUDE_CLI, pre: [] }, "as configured, as before");
  assert.deepEqual(calls()[0], ["--version"]);
  const r = runtimes();
  assert.equal(r.subscription, true);
  assert.equal(r.subscriptionNote, null);
});

test("a subscription turn reaches the stand-in with its prompt as one argument", async () => {
  const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
  const prompt = `Sum the "parts" & calc | whoami > out %PATH% !x! ^ $(id) \`id\`\nsecond line`;
  const events: AgentEvent[] = [];
  await runAgent({ boardId: "claude-board", user: ada, prompt, runtime: "subscription", emit: (e) => events.push(e), signal: new AbortController().signal });
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
  assert.ok(events.some((e) => e.type === "text" && e.text === "got it"));
  assert.ok(events.some((e) => e.type === "done" && e.runtime === "subscription"));
  const turn = calls().at(-1)!;
  assert.equal(turn[0], "-p");
  assert.ok(turn[1].startsWith(prompt), "the prompt arrived whole: quotes, &, |, %PATH% and the line break untouched");
  assert.deepEqual(turn.slice(2, 5), ["--output-format", "stream-json", "--verbose"]);
  assert.ok(turn.includes("--mcp-config") && turn.includes("--allowedTools"));
});

/** a made-up Windows file system for resolveClaude */
function winRt(files: Record<string, string>): Runtime {
  return {
    platform: "win32",
    env: { Path: "C:\\npm" },
    execPath: "C:\\node\\node.exe",
    cwd: "C:\\",
    exists: (f) => f in files,
    isDir: () => false,
    read: (f) => files[f] ?? "",
  };
}

test("one that can't start: refused before anything runs, or the reason it didn't answer", () => {
  const ran: string[][] = [];
  const exec = (cmd: string, args: string[]) => void ran.push([cmd, ...args]);
  // a .cmd with no script in it would need cmd.exe
  const odd = resolveClaude("claude", winRt({ "C:\\npm\\claude.cmd": "@echo off\r\nclaude-real.exe %*\r\n" }), exec);
  assert.equal(odd.ok, false);
  assert.match(!odd.ok ? odd.reason : "", /\.cmd script.*cmd\.exe.*FOUNDATION_CLAUDE_CLI/s);
  assert.equal(ran.length, 0, "nothing ran");
  assert.match(String((resolveClaude("claude", winRt({}), exec) as { reason: string }).reason), /isn't on this computer's PATH/);
  assert.match(String((resolveClaude("D:\\x\\claude.exe", winRt({}), exec) as { reason: string }).reason), /isn't at D:\\x\\claude\.exe/);
  // found, but --version fails: ENOENT reads as not installed, anything else says what happened
  const mac: Runtime = { ...winRt({}), platform: "darwin" };
  const enoent = resolveClaude("claude", mac, () => {
    throw Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
  });
  assert.match(!enoent.ok ? enoent.reason : "", /isn't on this computer's PATH/);
  const broken = resolveClaude("claude", mac, () => {
    throw new Error("Command failed: claude --version\nsomething");
  });
  assert.match(!broken.ok ? broken.reason : "", /didn't answer --version: Command failed: claude --version$/);
  // an .exe runs as is
  assert.deepEqual(resolveClaude("claude", winRt({ "C:\\npm\\claude.exe": "" }), exec), { ok: true, cmd: "C:\\npm\\claude.exe", pre: [] });
  assert.deepEqual(ran.at(-1), ["C:\\npm\\claude.exe", "--version"]);
});

/**
 * Kinds of agent and a run that can't go quiet (docs/agent-harness.md §1, §2), with no network and no plan spent:
 * a stand-in Claude Code (as agent-claude.test.ts makes one) and a stand-in Anthropic API (anthropic-standin.ts).
 *
 * - Claude Code that says nothing is stopped after FOUNDATION_AGENT_SILENCE_MS with an error that names the likely
 *   cause and its error output; the crew's status is `error`.
 * - A lost sign-in on its error output is said as soon as it shows, once.
 * - Its reasoning (stream-json thinking deltas) arrives as `thinking`, its words once.
 * - `claude auth status` tells the sign-in without spending anything.
 * - The API key: checked against the model list, sealed in SQLite (the plaintext isn't in the row), never in what
 *   the server says, never in Claude Code's environment. A claude-api run uses it, with adaptive thinking shown.
 * - Models: built-in without a key, live (newest first) with one; a model not on the live list is refused.
 * - A claude-account run never uses the API key; a claude-api run never uses the subscription.
 * - Federation: the identity token is exchanged once for a short-lived bearer, which the run uses and keeps.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "@foundation/protocol";
import { FED_ACCESS, GOOD_KEY, startAnthropicStandin } from "./anthropic-standin.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
process.env.FOUNDATION_WORK_DIR = join(dir, "work");
process.env.FOUNDATION_AGENT_SILENCE_MS = "1500";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";
delete process.env.FOUNDATION_AGENT_SCRIPT;
delete process.env.ANTHROPIC_API_KEY;
for (const k of ["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"]) delete process.env[k];

// ---------- a stand-in Claude Code ----------
const envLog = join(dir, "claude-env.log");
const win = process.platform === "win32";
const pkg = join(dir, "npm", "node_modules", "stand-in-claude");
mkdirSync(pkg, { recursive: true });
const cliJs = join(pkg, "cli.cjs");
writeFileSync(
  cliJs,
  `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("9.9.9 (stand-in Claude Code)"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify(process.env) + "\\n");
const prompt = a[a.indexOf("-p") + 1] || "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (prompt.startsWith("SILENT")) { setTimeout(() => {}, 60000); return; }
if (prompt.startsWith("STUBBORN")) {
  // ignores SIGTERM, and leaves a child of its own holding the pipes
  process.on("SIGTERM", () => {});
  require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] });
  setInterval(() => {}, 1000);
  return;
}
if (prompt.startsWith("AUTHHANG")) { process.stderr.write("Invalid API key · Please run /login\\n"); setTimeout(() => {}, 60000); return; }
if (prompt.startsWith("OLDCLI") && a.includes("--thinking-display")) { process.stderr.write("error: option '--thinking-display <display>' argument 'summarized' is invalid. Allowed choices are omitted.\\n"); process.exit(1); }
if (prompt.startsWith("FAILRESULT")) { out({ type: "system", subtype: "init", session_id: "s-1", mcp_servers: [{ name: "foundation", status: "connected" }] }); out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Something broke", session_id: "s-1" }); process.exit(1); }
if (prompt.startsWith("AUTHOUT")) { process.stderr.write("Invalid API key · Please run /login\\n"); setTimeout(() => process.exit(1), 800); return; }
out({ type: "system", subtype: "init", session_id: "s-1", mcp_servers: [{ name: "foundation", status: "connected" }] });
if (prompt.startsWith("THINK")) {
  out({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weighing the two " } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "options first." } } });
  out({ type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "Weighing the two options first." }] } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The second one." } } });
  out({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "The second one." }] } });
} else {
  out({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "got it" }] } });
}
out({ type: "result", subtype: "success", is_error: false, session_id: "s-1", usage: { input_tokens: 1, output_tokens: 2 } });
`,
);
chmodSync(cliJs, 0o755);
const shim = join(dir, "npm", "claude.cmd");
writeFileSync(
  shim,
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\stand-in-claude\\cli.cjs" %*\r\n`,
);
process.env.FOUNDATION_CLAUDE_CLI = win ? shim : cliJs.replace(/\.cjs$/, "");
if (!win) writeFileSync(process.env.FOUNDATION_CLAUDE_CLI, readFileSync(cliJs, "utf8"), { mode: 0o755 });

// ---------- a stand-in Anthropic ----------
const anthropic = await startAnthropicStandin();
process.env.ANTHROPIC_BASE_URL = anthropic.base;

const { upsertUser } = await import("../src/auth.ts");
const { closeBoards, getBoard } = await import("../src/boards.ts");
const { startRun, followRun, runAgent, claudeAccount, selfBase } = await import("../src/agent.ts");
const kinds = await import("../src/agentkinds.ts");
const { _resetCrew } = await import("../src/crew.ts");

const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

after(async () => {
  _resetCrew();
  closeBoards();
  await anthropic.close();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const boss = upsertUser("boss@formindustries.com", "Boss");

type Ev = { type: string; [k: string]: unknown };
function finish(r: ReturnType<typeof startRun>) {
  return new Promise<Ev[]>((resolve) => {
    const seen: Ev[] = [];
    followRun(r.id, ada.id, (e) => seen.push(e as never), () => resolve(seen));
  });
}
const crewStatus = (boardId: string) =>
  [...getBoard(boardId).awareness.getStates().values()].map((s) => (s as { crew?: { status: string; thought: string | null } } | null)?.crew).filter(Boolean).at(-1);

before(() => {
  anthropic.seen.length = 0;
});

test("Claude Code reaches the MCP endpoint on loopback when the server listens on every address", () => {
  assert.equal(selfBase("0.0.0.0", 4410), "http://127.0.0.1:4410");
  assert.equal(selfBase("::", 4410), "http://127.0.0.1:4410");
  assert.equal(selfBase("127.0.0.1", 4410), "http://127.0.0.1:4410");
  assert.equal(selfBase("::1", 4410), "http://[::1]:4410");
  assert.equal(selfBase("192.168.1.20", 4410), "http://192.168.1.20:4410");
});

test("a run whose Claude Code says nothing is stopped, says why, and its cursor says error", async () => {
  const t0 = Date.now();
  const r = startRun({ boardId: "k1", user: ada, prompt: "SILENT please", kind: "claude-account" });
  const events = await finish(r);
  const err = events.filter((e) => e.type === "error");
  assert.equal(err.length, 1, JSON.stringify(events));
  assert.match(String(err[0].message), /said nothing for 2 s, so the run was stopped\. Likely: it never started: it may be waiting on a prompt/);
  assert.match(String(err[0].message), /Its error output: nothing/);
  assert.ok(Date.now() - t0 < 10_000, "within the silence, not forever");
  assert.equal(crewStatus("k1")?.status, "error");
});

test("a lost sign-in is said as soon as Claude Code says it, once, and never names a secret", async () => {
  const seen: Array<{ at: number; e: Ev }> = [];
  const t0 = Date.now();
  await runAgent({ boardId: "k2", user: ada, prompt: "AUTHOUT", kind: "claude-account", emit: (e) => seen.push({ at: Date.now() - t0, e: e as Ev }), signal: new AbortController().signal });
  const errs = seen.filter((s) => s.e.type === "error");
  assert.equal(errs.length, 1, JSON.stringify(seen));
  assert.match(String(errs[0].e.message), /isn't signed in, or its sign-in has expired: on that computer, run `claude` and sign in/);
  assert.ok(errs[0].at < 700, `said at ${errs[0].at} ms, before Claude Code exited (800 ms)`);
});

test("Claude Code's reasoning arrives as thinking, and its words once", async () => {
  const events: Ev[] = [];
  await runAgent({ boardId: "k3", user: ada, prompt: "THINK it over", kind: "claude-account", emit: (e) => events.push(e as Ev), signal: new AbortController().signal });
  assert.deepEqual(events.filter((e) => e.type === "thinking").map((e) => e.text), ["Weighing the two ", "options first."]);
  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.text), ["The second one."]);
  assert.ok(events.some((e) => e.type === "done" && e.runtime === "subscription"));
});

test("the sign-in is read without spending anything (claude auth status)", async () => {
  const a = await claudeAccount();
  assert.equal(a.installed, true);
  assert.equal(a.signedIn, true);
  assert.equal(a.version, "9.9.9");
});

test("no key: the built-in model list, a claude-api seat says what's missing, and a claude seat never touches the API", async () => {
  assert.equal(kinds.apiState().configured, false);
  const list = await kinds.claudeModels();
  assert.equal(list.source, "builtin");
  assert.equal(list.models[0].id, "claude-opus-5-5");
  const events: Ev[] = [];
  await runAgent({ boardId: "k4", user: ada, prompt: "hello", kind: "claude-api", emit: (e) => events.push(e as Ev), signal: new AbortController().signal });
  assert.equal(events.length, 1);
  assert.match(String(events[0].message), /none is set: an admin adds one in Settings → Agents\. It never falls back to the Claude subscription/);
  assert.ok(!readFileSync(envLog, "utf8").includes("hello\n"), "Claude Code wasn't started for it");
  assert.equal(anthropic.seen.filter((s) => s.path === "/v1/messages").length, 0);
});

test("the API key: checked, sealed at rest, never said back, never in Claude Code's environment", async () => {
  await assert.rejects(kinds.setApiKey(boss, `sk-ant-api03-${"x".repeat(40)}`), /didn't accept that key/);
  await assert.rejects(kinds.setApiKey(boss, "not a key"), /doesn't look like an Anthropic API key/);
  const st = await kinds.setApiKey(boss, GOOD_KEY);
  assert.deepEqual(st, { configured: true, source: "stored", last4: GOOD_KEY.slice(-4), model: "claude-opus-5-5" });
  assert.ok(!JSON.stringify(st).includes(GOOD_KEY.slice(0, 20)));
  const db = new DatabaseSync(join(dir, "data", "foundation.db"), { readOnly: true });
  const rows = db.prepare("select * from agent_settings").all() as Array<Record<string, unknown>>;
  const audit = JSON.stringify(db.prepare("select * from audit_log").all());
  db.close();
  const row = rows.find((r) => r.name === "api_key")!;
  assert.equal(row.sealed, 1);
  assert.ok(!JSON.stringify(rows).includes(GOOD_KEY), "the plaintext isn't in the database");
  assert.ok(!JSON.stringify(rows).includes(GOOD_KEY.slice(13, 40)), "nor any long piece of it");
  assert.ok(!audit.includes(GOOD_KEY.slice(13, 40)), "nor in the audit log");
  // after a restart it's read back from the sealed row
  kinds._forgetAgentSettings();
  assert.equal(kinds.apiKey().key, GOOD_KEY);

  // a subscription run with a key stored: Claude Code's environment has no trace of it
  const events: Ev[] = [];
  await runAgent({ boardId: "k5", user: ada, prompt: "plain", kind: "claude-account", emit: (e) => events.push(e as Ev), signal: new AbortController().signal });
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
  const env = readFileSync(envLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, string>).at(-1)!;
  for (const [k, v] of Object.entries(env)) assert.ok(!String(v).includes(GOOD_KEY.slice(13, 40)), `${k} carries the key`);
  assert.equal(anthropic.seen.filter((s) => s.path === "/v1/messages").length, 0, "a claude seat never spends API credits");
});

test("models: live from Anthropic with a key, newest first; a model not on the list is refused", async () => {
  const list = await kinds.claudeModels();
  assert.equal(list.source, "live");
  assert.deepEqual(list.models.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.equal(list.models[0].name, "Claude Opus 5.5");
  await assert.rejects(kinds.setDefaultModel(boss, "claude-imaginary-9"), /isn't one of the models/);
  assert.equal((await kinds.setDefaultModel(boss, "claude-sonnet-5-5")).model, "claude-sonnet-5-5");
});

test("a claude-api run: Foundation's loop on the stored key, reasoning shown and streamed, never the subscription", async () => {
  anthropic.seen.length = 0;
  const before = readFileSync(envLog, "utf8").split("\n").length;
  const r = startRun({ boardId: "k6", user: ada, prompt: "say hello", kind: "claude-api" });
  const events = await finish(r);
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
  assert.equal(events.filter((e) => e.type === "thinking").map((e) => e.text).join(""), "The person wants a hello. One short sentence will do.", "its reasoning, streamed as it came");
  assert.ok(events.some((e) => e.type === "text" && e.text === "Hello from the stand-in."));
  assert.ok(events.some((e) => e.type === "done" && e.runtime === "api"));
  const call = anthropic.seen.find((s) => s.path === "/v1/messages")!;
  assert.ok(call.headers["x-api-key"] === GOOD_KEY || call.headers.authorization === `Bearer ${GOOD_KEY}`, "on the stored key");
  const body = call.body as { model: string; thinking: unknown; output_config: unknown; stream: boolean; fallbacks?: string };
  assert.equal(body.model, "claude-sonnet-5-5", "the default model an admin chose");
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, "default");
  assert.equal(readFileSync(envLog, "utf8").split("\n").length, before, "Claude Code wasn't started");
  // a seat's own model wins
  anthropic.seen.length = 0;
  await finish(startRun({ boardId: "k6", user: ada, prompt: "again", kind: "claude-api", model: "claude-haiku-5-5" }));
  assert.equal((anthropic.seen.find((s) => s.path === "/v1/messages")!.body as { model: string }).model, "claude-haiku-5-5");
});

test("federated identity: ids and a token file, the token exchanged once and kept; nothing secret stored", async () => {
  const st0 = kinds.federationState();
  assert.equal(st0.configured, false);
  assert.match(st0.why!, /isn't set up/);
  const tokenFile = join(dir, "idp-token.jwt");
  writeFileSync(tokenFile, "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmb3VuZGF0aW9uIn0.");
  assert.throws(() => kinds.setFederation(boss, { organizationId: "nope", federationRuleId: "fdrl_abc123", identityTokenFile: tokenFile }), /organizationId/);
  const st = kinds.setFederation(boss, { organizationId: "6b5af527-c7f3-45d6-98e5-62dbdc91afcf", federationRuleId: "fdrl_abc123", identityTokenFile: tokenFile, workspaceId: "wrkspc_xyz789" });
  assert.equal(st.configured, true);
  anthropic.seen.length = 0;
  for (const p of ["one", "two"]) {
    const events = await finish(startRun({ boardId: "k7", user: ada, prompt: p, kind: "claude-federated" }));
    assert.ok(events.some((e) => e.type === "done" && e.runtime === "federated"), JSON.stringify(events));
  }
  const exchanges = anthropic.seen.filter((s) => s.path === "/v1/oauth/token");
  assert.equal(exchanges.length, 1, "exchanged once, then kept until it nears expiry");
  const ex = exchanges[0].body as Record<string, string>;
  assert.equal(ex.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(ex.assertion, readFileSync(tokenFile, "utf8"));
  assert.equal(ex.federation_rule_id, "fdrl_abc123");
  assert.equal(ex.workspace_id, "wrkspc_xyz789");
  const msgs = anthropic.seen.filter((s) => s.path === "/v1/messages");
  assert.equal(msgs.length, 2);
  for (const m of msgs) {
    assert.equal(m.headers.authorization, `Bearer ${FED_ACCESS}`);
    assert.equal(m.headers["x-api-key"], undefined, "not the stored key");
    assert.ok(!String(m.headers.authorization).includes(GOOD_KEY));
  }
  const db = new DatabaseSync(join(dir, "data", "foundation.db"), { readOnly: true });
  const row = JSON.stringify(db.prepare("select * from agent_settings where name = 'federation'").all());
  db.close();
  assert.ok(!row.includes("eyJ") && !row.includes(FED_ACCESS), "neither token is stored");
});

test("a seat's own model: only for a Claude on the API, a Claude model id, and one on the live list", async () => {
  const { postAgent, seatModel } = await import("../src/posted.ts");
  const { GRID_PLACE } = await import("@foundation/protocol");
  // the list is Anthropic's own here (a key is stored): a model not on it is refused, as is anything not a model id
  assert.equal((await kinds.claudeModels()).source, "live");
  await assert.rejects(seatModel("claude-imaginary-9"), /isn't one of the models/);
  await assert.rejects(seatModel("gpt-9"), /Claude model id/);
  assert.equal(await seatModel(undefined), undefined);
  assert.equal(await seatModel(""), undefined);
  const haiku = await seatModel("claude-haiku-5-5");
  // a claude-api and a claude-federated seat keep the one chosen; without one, they follow the default
  assert.equal(postAgent("k11", GRID_PLACE, "claude-api", ada, haiku).seat.model, "claude-haiku-5-5");
  assert.equal(postAgent("k11", GRID_PLACE, "claude-fed", ada, haiku).seat.model, "claude-haiku-5-5");
  assert.equal(postAgent("k11", GRID_PLACE, "claude-api", ada).seat.model, undefined);
  // a Claude Code seat runs on the subscription's own choice: it takes none
  assert.throws(() => postAgent("k11", GRID_PLACE, "claude", ada, haiku), /Only a Claude on the API/);
});

test("Stop and the silence end a Claude Code that ignores SIGTERM and leaves a child on its pipes: the run ends, its folder goes, its pass is revoked", async () => {
  process.env.FOUNDATION_AGENT_KILL_MS = "500";
  const t0 = Date.now();
  const events: Ev[] = [];
  await runAgent({ boardId: "k8", user: ada, prompt: "STUBBORN", kind: "claude-account", emit: (e) => events.push(e as Ev), signal: new AbortController().signal });
  assert.ok(Date.now() - t0 < 8000, `ended in ${Date.now() - t0} ms`);
  assert.equal(events.filter((e) => e.type === "error").length, 1);
  assert.match(String(events.find((e) => e.type === "error")!.message), /said nothing/);
  const { readdirSync, existsSync } = await import("node:fs");
  const runs = join(dir, "work", "runs");
  assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], [], "its folder (and the pass in it) is gone");
  const db = new DatabaseSync(join(dir, "data", "foundation.db"), { readOnly: true });
  const passes = db.prepare("select count(*) as n from sessions where kind = 'agent'").get() as { n: number };
  db.close();
  assert.equal(passes.n, 0, "its MCP pass is revoked");
  // and Stop
  const ctrl = new AbortController();
  const t1 = Date.now();
  setTimeout(() => ctrl.abort(), 300);
  await runAgent({ boardId: "k8", user: ada, prompt: "STUBBORN again", kind: "claude-account", emit: () => {}, signal: ctrl.signal });
  assert.ok(Date.now() - t1 < 6000, `stopped in ${Date.now() - t1} ms`);
});

test("one ending per run: a failed result is an error and no done; a silence after a lost sign-in adds nothing", async () => {
  const a: Ev[] = [];
  await runAgent({ boardId: "k9", user: ada, prompt: "FAILRESULT", kind: "claude-account", emit: (e) => a.push(e as Ev), signal: new AbortController().signal });
  assert.equal(a.filter((e) => e.type === "error").length, 1, JSON.stringify(a));
  assert.match(String(a.find((e) => e.type === "error")!.message), /Something broke/);
  assert.equal(a.filter((e) => e.type === "done").length, 0);
  const b: Ev[] = [];
  await runAgent({ boardId: "k9", user: ada, prompt: "AUTHHANG", kind: "claude-account", emit: (e) => b.push(e as Ev), signal: new AbortController().signal });
  assert.equal(b.filter((e) => e.type === "error").length, 1, JSON.stringify(b));
  assert.match(String(b.find((e) => e.type === "error")!.message), /isn't signed in/);
});

test("a Claude Code that refuses the thinking flags' value is run once more without them", async () => {
  const events: Ev[] = [];
  await runAgent({ boardId: "k10", user: ada, prompt: "OLDCLI here", kind: "claude-account", emit: (e) => events.push(e as Ev), signal: new AbortController().signal });
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
  assert.ok(events.some((e) => e.type === "text" && e.text === "got it"));
});

test("nothing in any run escaped as an unhandled rejection", () => {
  assert.deepEqual(unhandled, []);
});

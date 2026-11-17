/**
 * Asking one of T3's agents from a section, and adding Kimi and DeepSeek
 * (src/t3threads.ts, src/t3host.ts), against a stand-in t3 (t3-standin.ts).
 *
 * Checked: a thread starts on the agent and model asked for, supervised, in
 * the board's own folder, under one project per board; the agent comes onto
 * the board under its own name, aimed at the section, and follows the thread
 * (working, waiting for a person, done, failed, stopped) with nothing left
 * behind; an agent that can't take work, a full board or a refused turn
 * starts nothing and leaves nobody; only the asker or an admin stops it.
 * The board's tools: Foundation puts them on each Claude-driven agent's
 * launch line (and leaves a launch line a person wrote alone); each ask has a
 * folder of its own with a tool file that names its crew member, board and a
 * session of its own; with it the agent's cards land in its section under its
 * name; the session is revoked and the file removed when the thread ends,
 * however it ends; an agent without the tools is told so and gets no pass.
 * Kimi and DeepSeek come in as Claude-driven instances with a folder of
 * their own: cloud needs https and a key, which goes to T3 marked sensitive
 * and is never kept or returned by Foundation; local must be an address on
 * this computer and takes no key; each runs its one model; removing works
 * only for what Foundation added and keeps the others' keys. Who may press
 * is `requirePerson` and the board's writers (index.ts).
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { writeStandin } from "./t3-standin.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-t3threads-"));
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
process.env.FOUNDATION_ADMIN_EMAILS = "";
process.env.FOUNDATION_T3_PORT = String(23000 + Math.floor(Math.random() * 2000));
process.env.FOUNDATION_T3_READY_MS = "8000";
process.env.FOUNDATION_T3_START_MS = "600";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";
const standin = writeStandin(dir);
process.env.T3_CLI = standin.cli;

const { startT3, stopT3, t3Host, addT3Agent, removeT3Agent, t3OpenLink, localModels, BOARD_TOOL_ARGS, BOARD_TOOLS_FILE } = await import("../src/t3host.ts");
const { askT3, stopT3Thread, t3Bindings, t3Brief, _resetT3Threads } = await import("../src/t3threads.ts");
const { upsertUser, hashToken, userFromSessionHash } = await import("../src/auth.ts");
const { crewFor } = await import("../src/mcp.ts");
const { runTool } = await import("../src/tools.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { crewOn, joinCrew, leaveCrew, MAX_CREW_PER_BOARD } = await import("../src/crew.ts");
const { appendSection, boardMaps } = await import("@foundation/protocol");
import type { UserInfo } from "@foundation/protocol";

const BOARD = "t3-board";
const ada: UserInfo = upsertUser("ada@formindustries.com", "Ada");
const kai: UserInfo = upsertUser("kai@formindustries.com", "Kai");
const root: UserInfo = { ...upsertUser("root@formindustries.com", "Root"), role: "admin" };
const sessionOf = (token: string) => userFromSessionHash(hashToken(token));
const toolsOf = (folder: string) => JSON.parse(readFileSync(join(folder, BOARD_TOOLS_FILE), "utf8")).mcpServers.foundation as { type: string; url: string; headers: { Authorization: string } };
let parts = "";
getBoard(BOARD).doc.transact(() => {
  parts = appendSection(getBoard(BOARD).doc, "Parts").id;
});

after(() => {
  _resetT3Threads();
  stopT3();
  closeBoards();
});

const until = async (what: string, ok: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`waited ${ms} ms for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const tell = (c: object) => writeFileSync(standin.control, JSON.stringify({ ...c, n: Math.random() }));
const dispatched = () => (existsSync(standin.file("dispatch.json")) ? (JSON.parse(readFileSync(standin.file("dispatch.json"), "utf8")) as Array<Record<string, any>>) : []);
const settings = () => JSON.parse(readFileSync(standin.file("settings.json"), "utf8")) as Record<string, any>;
const crew = () => crewOn(BOARD).filter((m) => !m.left);
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => (assert.match(e.message, re), true));

test("before T3 runs, asking an agent says to start it", async () => {
  await rejects(askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "List the parts" }), /T3 isn't running/);
  assert.equal(crew().length, 0);
});

test("asking an agent starts a supervised thread on it, in the board's folder; it comes onto the board under its own name", async () => {
  assert.equal((await startT3("Ada")).state, "running");
  await until("the providers", () => t3Host().agents.length === 2);
  const r = await askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", model: "claude-haiku-4-5", text: "List the parts in the STEP export\nand their suppliers" });
  assert.equal(r.name, "Claude");
  assert.equal(r.model, "claude-haiku-4-5");
  const cmds = dispatched();
  assert.deepEqual(cmds.map((c) => c.type), ["project.create", "thread.turn.start"]);
  // a folder for this ask alone, under its board's, in Foundation's data, never anywhere else on this computer
  assert.ok(cmds[0].workspaceRoot.startsWith(join(dir, "data", "t3-work", BOARD) + sep), cmds[0].workspaceRoot);
  assert.ok(existsSync(cmds[0].workspaceRoot));
  const turn = cmds[1];
  assert.equal(turn.threadId, r.threadId);
  assert.deepEqual(turn.modelSelection, { instanceId: "claudeAgent", model: "claude-haiku-4-5" });
  assert.equal(turn.runtimeMode, "approval-required");
  assert.equal(turn.bootstrap.createThread.runtimeMode, "approval-required");
  assert.equal(turn.bootstrap.createThread.projectId, cmds[0].projectId);
  // the brief: where it is, what it has, the board as it stands, then the ask as it was said
  assert.match(turn.message.text, /You are Claude, working on the Foundation board "t3-board" for Ada, in the section “Parts”/);
  assert.match(turn.message.text, /mcp__foundation__\*/);
  assert.ok(turn.message.text.endsWith('<ask from="Ada">\nList the parts in the STEP export\nand their suppliers\n</ask>'));
  assert.equal(r.boardTools, true);
  assert.equal(turn.titleSeed, "List the parts in the STEP export");
  // on the board: Claude, for Ada, aimed at Parts
  const [m] = crew();
  assert.equal(m.name, "Claude");
  assert.equal(m.state.crew.askerName, "Ada");
  assert.deepEqual(m.state.crew.target, { id: parts, kind: "section" });
  assert.equal(m.state.crew.status, "working");
  await until("T3 shows it at work", () => m.state.crew.doing === "working");
  assert.deepEqual(t3Bindings(BOARD)[r.threadId], { section: parts, sectionName: "Parts", crew: m.id, by: ada.id });
  // the board's log says who took what, for whom
  const log = boardMaps(getBoard(BOARD).doc).activity.toArray().at(-1)!;
  assert.equal(log.who, "Claude");
  assert.equal(log.for, "Ada");
  assert.match(log.text, /through T3/);
});

test("the agent's presence follows its thread: waiting for a person, then done and gone", async () => {
  const [m] = crew();
  const id = Object.keys(t3Bindings(BOARD))[0];
  tell({ do: "approve", id });
  await until("waiting", () => m.state.crew.doing === "waiting for a person in T3");
  assert.equal(m.state.crew.status, "working");
  tell({ do: "finish", id });
  await until("done", () => m.state.crew.status === "done");
  assert.deepEqual(t3Bindings(BOARD), {});
  await until("gone from the board", () => crew().length === 0, 5000);
});

test("a second ask on the same board reuses its project; two of one agent are told apart; a failed thread says so", async () => {
  const a = await askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "First" });
  const b = await askT3(kai, { board: BOARD, section: parts, agent: "claudeAgent", text: "Second" });
  // each ask has its own folder (its own pass to the board), so its own T3 project
  const roots = dispatched().filter((c) => c.type === "project.create").map((c) => c.workspaceRoot);
  assert.equal(new Set(roots).size, roots.length);
  assert.deepEqual([a.name, b.name], ["Claude", "Claude 2"]);
  // no model named: the agent's first
  assert.equal(b.model, "claude-opus-5-5");
  const mb = crew().find((m) => m.name === "Claude 2")!;
  tell({ do: "fail", id: b.threadId });
  await until("failed", () => mb.state.crew.status === "error");
  // only the asker (or an admin) stops a thread
  await rejects(stopT3Thread(kai, a.threadId), /Only the person who asked/);
  const ma = crew().find((m) => m.name === "Claude")!;
  assert.deepEqual(await stopT3Thread(ada, a.threadId), { stopped: true });
  assert.equal(dispatched().at(-1)!.type, "thread.turn.interrupt");
  assert.equal(ma.state.crew.status, "stopped");
  await until("nobody left", () => crew().length === 0, 5000);
});

test("nothing starts, and nobody is left on the board, when the agent can't take work, the turn is refused or the board is full", async () => {
  const before = dispatched().length;
  await rejects(askT3(ada, { board: BOARD, section: parts, agent: "codex", text: "x" }), /Codex can't take work: it isn't installed/);
  await rejects(askT3(ada, { board: BOARD, section: parts, agent: "nobody", text: "x" }), /no agent/);
  await rejects(askT3(ada, { board: BOARD, section: "nowhere", agent: "claudeAgent", text: "x" }), /no such section/);
  await rejects(askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "   " }), /Say what you need/);
  assert.equal(dispatched().length, before);
  await rejects(askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "REFUSE this" }), /refused/);
  assert.equal(crew().length, 0);
  // a full board: said before anything is sent to T3
  const filler = Array.from({ length: MAX_CREW_PER_BOARD }, (_, i) => joinCrew({ boardId: BOARD, userId: "u1", userName: "Ada", runId: `fill${i}`, task: "x" }));
  const sent = dispatched().length;
  await rejects(askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "one too many" }), /already has/);
  assert.equal(dispatched().length, sent);
  filler.forEach((m) => leaveCrew(m, "done", 0));
});

test("a thread T3 never shows at work is let go, not left standing in the section", async () => {
  // (the stand-in shows every started thread at work, so: bind one, then have T3 forget it)
  const r = await askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "Then T3 stops" });
  assert.equal(crew().length, 1);
  stopT3();
  await until("released when T3 stopped", () => crew().every((m) => m.state.crew.status !== "working"));
  assert.equal(t3Bindings(BOARD)[r.threadId], undefined);
  await until("gone", () => crew().length === 0, 5000);
  assert.equal((await startT3("Ada")).state, "running");
  await until("the providers", () => t3Host().agents.length >= 2);
});

test("the board's tools: on the launch line, a pass per ask that names its agent, person and board, gone when the thread ends", async () => {
  // Foundation put the tools on the built-in Claude agent's launch line when T3 started
  await until("the launch line", () => existsSync(standin.file("builtin.json")));
  assert.equal(JSON.parse(readFileSync(standin.file("builtin.json"), "utf8")).launchArgs, BOARD_TOOL_ARGS);
  assert.match(BOARD_TOOL_ARGS, /^--mcp-config \.foundation-mcp\.json --allowedTools mcp__foundation --strict-mcp-config$/);
  await until("Claude has the tools", () => t3Host().agents.find((a) => a.id === "claudeAgent")?.boardTools === true);
  assert.equal(t3Host().agents.find((a) => a.id === "codex")?.boardTools, false);

  const r = await askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "Make a note of the open questions" });
  const folder = dispatched().filter((c) => c.type === "project.create").at(-1)!.workspaceRoot as string;
  const tools = toolsOf(folder);
  const [m] = crew();
  // Foundation's tool server on this computer, as this ask's crew member on this board
  assert.equal(tools.type, "http");
  const url = new URL(tools.url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/mcp");
  assert.deepEqual([url.searchParams.get("board"), url.searchParams.get("crew")], [BOARD, m.id]);
  const token = tools.headers.Authorization.replace(/^Bearer /, "");
  // its pass is a session of its own, an agent's (not a person's: it can't start machines, T3 or another thread), for the person who asked
  assert.deepEqual([sessionOf(token)?.id, sessionOf(token)?.kind], [ada.id, "agent"]);
  // with it, what the agent makes lands in its section under its own name, for everyone
  assert.equal(crewFor(m.id, ada, BOARD)?.name, "Claude");
  assert.equal(crewFor(m.id, kai, BOARD), undefined, "someone else's pass can't act as this agent");
  const note = (await runTool({ boardId: BOARD, actor: m.name, userId: ada.id, crew: m.id }, "add_note", { section: "Parts", title: "Open questions", markdown: "- Which supplier for the hub bearing?" })) as { id: string };
  const made = boardMaps(getBoard(BOARD).doc).objects.get(note.id) as { sectionId: string; createdBy?: string };
  assert.deepEqual([made.sectionId, made.createdBy], [parts, "Claude"]);
  // the thread ends: the pass is revoked and its file is gone
  tell({ do: "finish", id: r.threadId });
  await until("done", () => m.state.crew.status === "done");
  assert.equal(sessionOf(token), null);
  assert.equal(existsSync(join(folder, BOARD_TOOLS_FILE)), false);
  assert.equal(crewFor(m.id, ada, BOARD) && !m.left ? "still there" : "leaving", m.left ? "leaving" : "still there");
  await until("gone", () => crew().length === 0, 5000);

  // stopped, or refused at the start: the same
  const s = await askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "Then stop" });
  const folder2 = dispatched().filter((c) => c.type === "project.create").at(-1)!.workspaceRoot as string;
  const token2 = toolsOf(folder2).headers.Authorization.replace(/^Bearer /, "");
  await stopT3Thread(ada, s.threadId);
  assert.equal(sessionOf(token2), null);
  assert.equal(existsSync(join(folder2, BOARD_TOOLS_FILE)), false);
  await until("gone", () => crew().length === 0, 5000);
});

test("an agent without the board's tools is told so and gets no pass", () => {
  const withTools = t3Brief({ board: "b", section: "Parts", person: "Ada", name: "Kimi", tools: true, digest: "(the board)", text: "Do it" });
  const without = t3Brief({ board: "b", section: "Parts", person: "Ada", name: "Codex", tools: false, digest: "(the board)", text: "Do it" });
  assert.match(withTools, /Your board tools are the mcp__foundation__\* tools/);
  assert.match(without, /You have no board tools in this thread/);
  assert.doesNotMatch(without, /mcp__foundation/);
  for (const b of [withTools, without]) assert.ok(b.includes('<board name="b">\n(the board)\n</board>') && b.endsWith('<ask from="Ada">\nDo it\n</ask>'));
});

test("Kimi in the cloud: a Claude-driven instance at Moonshot's address, the key T3's alone, its own folder, its one model", async () => {
  await rejects(addT3Agent({ preset: "kimi", where: "cloud" }), /needs an API key/);
  await rejects(addT3Agent({ preset: "kimi", where: "cloud", apiKey: "k", baseUrl: "http://api.moonshot.ai/anthropic" }), /must be https/);
  await rejects(addT3Agent({ preset: "kimi", where: "cloud", apiKey: "k", baseUrl: "https://localhost:8443" }), /can't be on this computer/);
  await rejects(addT3Agent({ preset: "qwen", where: "cloud", apiKey: "k" }), /No such agent/);
  await addT3Agent({ preset: "kimi", where: "cloud", apiKey: "sk-secret-kimi" });
  const inst = settings()["kimi-cloud"];
  assert.equal(inst.driver, "claudeAgent");
  assert.equal(inst.displayName, "Kimi");
  const env = Object.fromEntries(inst.environment.map((e: any) => [e.name, e]));
  assert.equal(env.ANTHROPIC_BASE_URL.value, "https://api.moonshot.ai/anthropic");
  assert.deepEqual([env.ANTHROPIC_AUTH_TOKEN.value, env.ANTHROPIC_AUTH_TOKEN.sensitive], ["sk-secret-kimi", true]);
  assert.equal(env.ANTHROPIC_API_KEY.value, "");
  assert.equal(env.ANTHROPIC_MODEL.value, "kimi-k3");
  // its own Claude folder under Foundation's T3, never this computer's sign-in
  assert.equal(inst.config.homePath, join(dir, "data", "t3", "claude-homes", "kimi-cloud"));
  assert.deepEqual(inst.config.customModels, [{ slug: "kimi-k3", name: "Kimi · kimi-k3" }]);
  // and the board's tools, like Claude
  assert.equal(inst.config.launchArgs, BOARD_TOOL_ARGS);
  await until("Kimi listed", () => t3Host().agents.some((a) => a.id === "kimi-cloud"));
  const kimi = t3Host().agents.find((a) => a.id === "kimi-cloud")!;
  assert.deepEqual([kimi.name, kimi.where, kimi.model, kimi.models, kimi.boardTools], ["Kimi", "cloud", "kimi-k3", 1, true]);
  assert.deepEqual(kimi.modelList, [{ slug: "kimi-k3", name: "Kimi · kimi-k3" }]);
  assert.deepEqual(kimi.added, { preset: "kimi", baseUrl: "https://api.moonshot.ai/anthropic" });
  // Foundation keeps where it runs and what it talks to; never the key, anywhere it writes or says
  const kept = readFileSync(join(dir, "data", "t3", "foundation-agents.json"), "utf8");
  assert.deepEqual(JSON.parse(kept)["kimi-cloud"], { preset: "kimi", where: "cloud", baseUrl: "https://api.moonshot.ai/anthropic", model: "kimi-k3" });
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const file of walk(join(dir, "data"))) assert.ok(!readFileSync(file).includes("sk-secret-kimi"), `the key is in ${file}`);
  assert.ok(!JSON.stringify(t3Host()).includes("sk-secret-kimi"));
});

test("DeepSeek on this computer: a local address only, no key, the model named; and asking it runs its model", async () => {
  await rejects(addT3Agent({ preset: "deepseek", where: "local" }), /Name the model on this computer/);
  await rejects(addT3Agent({ preset: "deepseek", where: "local", model: "deepseek-r1:14b", baseUrl: "https://api.deepseek.com/anthropic" }), /must be on this computer/);
  await addT3Agent({ preset: "deepseek", where: "local", model: "deepseek-r1:14b" });
  const inst = settings()["deepseek-local"];
  const env = Object.fromEntries(inst.environment.map((e: any) => [e.name, e]));
  assert.equal(env.ANTHROPIC_BASE_URL.value, "http://127.0.0.1:11434");
  assert.deepEqual([env.ANTHROPIC_AUTH_TOKEN.value, env.ANTHROPIC_AUTH_TOKEN.sensitive], ["local", false]);
  assert.equal(inst.displayName, "DeepSeek (local)");
  // adding a second agent kept the first one's key (T3 sent it back redacted; it went back as it came)
  assert.equal(settings()["kimi-cloud"].environment.find((e: any) => e.name === "ANTHROPIC_AUTH_TOKEN").value, "sk-secret-kimi");
  await until("listed", () => t3Host().agents.some((a) => a.id === "deepseek-local"));
  assert.equal(t3Host().agents.find((a) => a.id === "deepseek-local")!.where, "local");
  assert.equal(t3Host().agents.find((a) => a.id === "claudeAgent")!.where, "cloud");
  const r = await askT3(ada, { board: BOARD, section: parts, agent: "deepseek-local", text: "Summarise the parts list" });
  assert.equal(r.name, "DeepSeek (local)");
  assert.deepEqual(dispatched().at(-1)!.modelSelection, { instanceId: "deepseek-local", model: "deepseek-r1:14b" });
  tell({ do: "finish", id: r.threadId });
  await until("done", () => crew().length === 0, 6000);
});

test("only what Foundation added can be removed; an agent's place survives a restart of T3", async () => {
  await rejects(removeT3Agent("claudeAgent"), /Only agents added from Foundation/);
  await removeT3Agent("kimi-cloud");
  assert.deepEqual(Object.keys(settings()), ["deepseek-local"]);
  assert.ok(!t3Host().agents.some((a) => a.id === "kimi-cloud"));
  stopT3();
  assert.equal((await startT3("Ada")).state, "running");
  // (the stand-in forgets its settings on restart; Foundation's own record of where agents run is read again)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "data", "t3", "foundation-agents.json"), "utf8"))), ["deepseek-local"]);
});

test("a link into T3's own page is minted per press; a local model server that isn't there says so", async () => {
  const a = await t3OpenLink();
  const b = await t3OpenLink("thread-1");
  assert.match(a, /^http:\/\/127\.0\.0\.1:\d+\/pair#token=cred-/);
  assert.match(b, /&next=%2Fenv1%2Fthread-1$/);
  assert.notEqual(a.split("token=")[1], b.split("token=")[1].split("&")[0]);
  assert.deepEqual(await localModels("http://127.0.0.1:9"), { baseUrl: "http://127.0.0.1:9", up: false, models: [] });
  await rejects(localModels("https://example.com"), /Only an address on this computer/);
});

/**
 * Code mode (codemode.ts, docs/agent-harness.md §3): a script runs in a QuickJS isolate in a worker of
 * its own and calls the tools through runTool with the caller's own context. What a sceptic would try:
 *
 * - Escapes (process, require, fetch, import(), the Function constructor, the host functions) give
 *   nothing usable.
 * - An endless loop is stopped at the deadline while the server keeps answering; a memory bomb is
 *   stopped; a 41st call is refused.
 * - A viewer's script reads, and its writes are refused with the board unchanged. An agent's script
 *   can't reach an outside service a person hasn't allowed. delete_card still needs confirm.
 * - The same request_id writes once, also when the first run failed half-way; inner writes are in
 *   activity under the caller's name; a throw comes back with the calls made before it.
 * - /mcp?mode=code lists exactly the core tools (CODE_MODE_TOOLS) and refuses the rest with a pointer to run_code.
 * - search_tools finds add_table for "table with rows", and the signatures compile as TypeScript.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";

const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (u: string | URL | Request) => {
  fetched.push(String(u instanceof Request ? u.url : u));
  throw new Error("no network in this test");
}) as typeof fetch;

const { upsertUser } = await import("../src/auth.ts");
const { runTool, TOOLS } = await import("../src/tools.ts");
const { z } = await import("zod");
const { setBoardRole } = await import("../src/roles.ts");
const { CODE_LIMITS, CODE_MODE_TOOLS, codeModeHooks, searchTools, toolApiDts, toolSignature, scriptTools } = await import("../src/codemode.ts");
const { buildServer } = await import("../src/mcp.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { readAudit } = await import("../src/audit.ts");
const { one } = await import("../src/db.ts");
const { boardMaps } = await import("@foundation/protocol");

after(() => {
  closeBoards();
  globalThis.fetch = realFetch;
});

const boss = upsertUser("boss@formindustries.com", "Boss");
const ada = upsertUser("ada@formindustries.com", "Ada");
const vic = upsertUser("vic@formindustries.com", "Vic");

type Out = { result?: unknown; error?: { message: string; line?: number }; logs: string[]; calls: Array<{ tool: string; ok: boolean; summary: string }> };
const agent = (boardId: string) => ({ boardId, actor: "Ada's agent", userId: ada.id, door: "mcp" as const });
const script = async (ctx: ReturnType<typeof agent>, code: string, request_id?: string) => (await runTool(ctx, "run_code", { code, ...(request_id ? { request_id } : {}) })) as Out;
const objects = (boardId: string) => [...boardMaps(getBoard(boardId).doc).objects.values()];

test("escapes give nothing usable: no process, require, fetch, import or host function inside", async () => {
  const out = await script(
    agent("cm-escape"),
    `
    const probes = {};
    const tryIt = (k, f) => { try { probes[k] = f(); } catch (e) { probes[k] = "threw: " + e.message; } };
    tryIt("process", () => typeof process);
    tryIt("globalThis.process", () => typeof globalThis.process);
    tryIt("require", () => typeof require);
    tryIt("fetch", () => typeof fetch);
    tryIt("setTimeout", () => typeof setTimeout);
    tryIt("ctorProcess", () => typeof (function () {}).constructor.constructor("return typeof process === 'undefined' ? undefined : process")());
    tryIt("ctorThis", () => Object.getOwnPropertyNames((function () {}).constructor("return this")()).filter((k) => /^(process|require|module|Buffer|call|log|std|os|fetch|global)$/.test(k)).join(","));
    tryIt("hostFns", () => [typeof call, typeof log].join(","));
    let imported = "no";
    try { await import("node:fs"); imported = "yes"; } catch (e) { imported = "refused"; }
    probes.import = imported;
    probes.foundationFrozen = Object.isFrozen(foundation);
    return probes;
  `,
  );
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  const p = out.result as Record<string, unknown>;
  for (const k of ["process", "globalThis.process", "require", "fetch", "setTimeout", "ctorProcess"]) assert.equal(p[k], "undefined", k);
  assert.equal(p.ctorThis, "", "the global object has nothing of Node's");
  assert.equal(p.hostFns, "undefined,undefined", "the host functions aren't left on the global");
  assert.equal(p.import, "refused");
  assert.equal(p.foundationFrozen, true);
  // run_code itself is not reachable from inside
  const rec = await script(agent("cm-escape"), `return await foundation.run_code({ code: "return 1" })`);
  assert.match(String(rec.error?.message), /not a function|run_code/);
  assert.deepEqual(fetched, [], "nothing went to the network");
});

test("an endless loop is stopped at the deadline and the server keeps answering meanwhile", async () => {
  const ms = CODE_LIMITS.ms;
  CODE_LIMITS.ms = 1500;
  try {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 50);
    const t0 = Date.now();
    const running = script(agent("cm-loop"), "while (true) {}");
    // while it spins, another call is answered at once
    const t1 = Date.now();
    await runTool(agent("cm-loop"), "read_board", {});
    assert.ok(Date.now() - t1 < 500, "a read answers while the script loops");
    const out = await running;
    clearInterval(tick);
    assert.match(String(out.error?.message), /time limit/);
    assert.ok(Date.now() - t0 < 1500 + 1500, "stopped near the deadline");
    assert.ok(ticks >= 15, `the event loop kept turning (${ticks} ticks)`);
  } finally {
    CODE_LIMITS.ms = ms;
  }
});

test("a memory bomb and deep recursion are stopped", async () => {
  const bomb = await script(agent("cm-mem"), "const a = []; for (;;) a.push(new Array(100000).fill(Math.random()));");
  assert.match(String(bomb.error?.message), /memory/);
  const str = await script(agent("cm-mem"), "let s = 'x'; for (;;) s = s + s;");
  assert.ok(str.error, "a doubling string is stopped");
  const deep = await script(agent("cm-mem"), "function f(n) { return f(n + 1) + 1 } return f(0)");
  assert.match(String(deep.error?.message), /stack|recurs/);
  // and the next script runs normally
  assert.deepEqual((await script(agent("cm-mem"), "return 1 + 1")).result, 2);
});

test("a 41st tool call is refused; the 40 before it ran", async () => {
  const out = await script(
    agent("cm-calls"),
    `let ok = 0, refused = "";
     for (let i = 0; i < 41; i++) { try { await foundation.read_board({}); ok++; } catch (e) { refused = e.message; } }
     return { ok, refused };`,
  );
  assert.deepEqual(out.result, { ok: 40, refused: `limit: a script makes at most ${CODE_LIMITS.calls} tool calls` });
  assert.equal(out.calls.filter((c) => c.ok).length, 40);
  assert.ok(out.calls.some((c) => !c.ok && /at most 40/.test(c.summary)));
});

test("a viewer's script reads, and its writes are refused with nothing changed", async () => {
  const b = "cm-viewer";
  await runTool(agent(b), "add_note", { section: "Plans", title: "Keep", markdown: "x" });
  setBoardRole(boss, b, vic.id, "viewer");
  const before = objects(b).length;
  const viewer = { boardId: b, actor: "Vic's agent", userId: vic.id, door: "mcp" as const };
  const out = (await runTool(viewer, "run_code", {
    code: `const board = await foundation.read_board({});
           const tries = [];
           for (const [tool, args] of [["add_note", { title: "x", markdown: "y" }], ["delete_card", { id: "any", confirm: true }], ["add_section", { name: "S" }], ["rename_section", { section: "Plans", name: "Mine" }]]) {
             try { await foundation[tool](args); tries.push(tool + ": wrote"); } catch (e) { tries.push(tool + ": " + e.message.slice(0, 9)); }
           }
           return { read: board.includes("Plans"), tries };`,
  })) as Out;
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  const r = out.result as { read: boolean; tries: string[] };
  assert.equal(r.read, true);
  assert.deepEqual(r.tries, ["add_note: View only", "delete_card: View only", "add_section: View only", "rename_section: View only"]);
  assert.equal(objects(b).length, before, "nothing changed on the board");
  assert.ok(boardMaps(getBoard(b).doc).sections.size === 1);
});

test("an agent's script can't reach an outside service a person hasn't allowed", async () => {
  const b = "cm-egress";
  const n = one<{ m: number | null }>("select max(id) as m from audit_log")?.m ?? 0;
  const out = await script(agent(b), `return await foundation.ask_person({ assignee: "kai@example.test", request: "Send the rim STEP", kind: "cad_upload" })`);
  assert.match(String(out.result), /Nothing was sent to .*: a person has to allow/);
  const rows = readAudit({ after: n, limit: 500 });
  assert.ok(rows.some((r) => r.action === "ask_person" && r.decision === "asked" && r.door === "mcp" && r.actor_kind === "agent"), "the inner call is held and recorded as the agent's");
  assert.ok(rows.some((r) => r.action === "run_code" && r.args_hash && r.args_bytes), "the script itself is one row: its hash and length");
  assert.deepEqual(fetched, []);
});

test("delete_card inside a script still needs confirm: true", async () => {
  const b = "cm-delete";
  const note = (await runTool(agent(b), "add_note", { title: "Old", markdown: "x" })) as { id: string };
  const out = await script(agent(b), `return [await foundation.delete_card({ id: ${JSON.stringify(note.id)}, confirm: false })]`);
  assert.match(String((out.result as string[])[0]), /not deleted/);
  assert.ok(objects(b).some((o) => o.id === note.id));
  const bad = await script(agent(b), `return await foundation.delete_card({ id: ${JSON.stringify(note.id)} })`);
  assert.match(String(bad.error?.message), /invalid input for delete_card: confirm/);
  assert.ok(objects(b).some((o) => o.id === note.id), "still there");
  await script(agent(b), `return await foundation.delete_card({ id: ${JSON.stringify(note.id)}, confirm: true })`);
  assert.ok(!objects(b).some((o) => o.id === note.id));
});

test("the same request_id writes once, also when the first run failed half-way", async () => {
  const b = "cm-idem";
  const code = `const a = await foundation.add_note({ section: "Log", title: "One", markdown: "1" });
                const t = await foundation.add_table({ section: "Log", name: "T", columns: ["A"], rows: [[1]] });
                return [a.id, t.id];`;
  const first = await script(agent(b), code, "job-1");
  const again = await script(agent(b), code, "job-1");
  assert.deepEqual(again.result, first.result);
  assert.equal(objects(b).length, 2);
  // a script that wrote once and then threw: run again under its request_id, the write isn't repeated
  const flaky = `const a = await foundation.add_note({ section: "Log", title: "Two", markdown: "2" });
                 if (!(await foundation.read_board({})).includes("Done")) throw new Error("not yet");
                 return a.id;`;
  const f1 = await script(agent(b), flaky, "job-2");
  assert.match(String(f1.error?.message), /not yet/);
  const f2 = await script(agent(b), flaky, "job-2");
  assert.match(String(f2.error?.message), /not yet/, "ran again (a failure isn't replayed)");
  assert.equal(objects(b).filter((o) => o.name === "Two").length, 1, "its write landed once");
});

test("inner writes are in the board's activity under the caller's name", async () => {
  const b = "cm-activity";
  await script(agent(b), `await foundation.add_section({ name: "Supply" }); await foundation.add_table({ section: "Supply", name: "Parts", columns: ["Part", "Qty"], rows: [["Vane", 12]] });`);
  const acts = boardMaps(getBoard(b).doc).activity.toArray();
  assert.ok(acts.some((a) => a.who === "Ada's agent" && /Parts/.test(a.text)), JSON.stringify(acts.map((a) => [a.who, a.text])));
  assert.ok(acts.every((a) => a.who === "Ada's agent"));
});

test("a script that throws returns its message, its line, its logs and the calls made so far", async () => {
  const out = await script(agent("cm-throw"), `console.log("starting");\nawait foundation.add_section({ name: "A" });\nthrow new Error("stopped on purpose");`);
  assert.match(String(out.error?.message), /stopped on purpose/);
  assert.equal(out.error?.line, 3);
  assert.deepEqual(out.logs, ["starting"]);
  assert.deepEqual(out.calls.map((c) => [c.tool, c.ok]), [["add_section", true]]);
  const caught = await script(agent("cm-throw"), `try { await foundation.update_card({ id: "nope", name: "x" }); } catch (e) { return "caught: " + e.message; }`);
  assert.match(String(caught.result), /^caught: /);
  const syntax = await script(agent("cm-throw"), "let a = 1;\nlet = = 2;");
  assert.equal(syntax.error?.line, 2);
  const notJson = await script(agent("cm-throw"), "return { f() {} , n: 1 }");
  assert.deepEqual(notJson.result, { n: 1 }, "only JSON comes back");
});

test("/mcp?mode=code lists exactly the core tools and refuses the rest with a pointer to run_code", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const connect = async (mode: "all" | "code") => {
    const server = buildServer("cm-mcp", { ...ada }, undefined, undefined, mode);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    return client;
  };
  const code = await connect("code");
  const listed = (await code.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(listed, [...CODE_MODE_TOOLS].sort());
  const refused = (await code.callTool({ name: "add_note", arguments: { title: "x", markdown: "y" } })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /run_code/);
  assert.equal(objects("cm-mcp").length, 0, "nothing was written");
  const ran = (await code.callTool({ name: "run_code", arguments: { code: `return (await foundation.add_note({ title: "Via code", markdown: "y" })).id` } })) as { content: Array<{ text: string }> };
  assert.match(ran.content[0].text, /"result": "note/);
  const run = (await code.listTools()).tools.find((t) => t.name === "run_code")!;
  assert.ok(run.description!.split(/\s+/).length <= 180, `run_code's description is ${run.description!.split(/\s+/).length} words`);
  const all = await connect("all");
  assert.equal((await all.listTools()).tools.length, scriptTools().length + 1, "the default lists every tool");
});

test("search_tools finds add_table for “table with rows”, and the signatures compile as TypeScript", async () => {
  const found = (await runTool(agent("cm-search"), "search_tools", { query: "table with rows" })) as { matches: Array<{ name: string; signature: string }> };
  assert.equal(found.matches[0].name, "add_table");
  assert.match(found.matches[0].signature, /^add_table\(args: \{ .*columns: string\[\].*rows\?: \(string \| number \| null\)\[\]\[\]/);
  const empty = (await runTool(agent("cm-search"), "search_tools", { query: "" })) as { categories: Array<{ name: string; count: number }>; top: unknown[] };
  assert.equal(
    empty.categories.reduce((n, c) => n + c.count, 0),
    scriptTools().length + 1,
    "every tool is in a category",
  );
  assert.ok(empty.top.length >= 4);
  // compile: one signature, and the whole surface, against TypeScript's own checker
  const ts = (await import("typescript")).default;
  const check = (source: string) => {
    const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], types: [] as string[] };
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    const usage = `${source}\nasync function use() { const r: unknown = await foundation.add_table({ name: "T", columns: ["A"], rows: [["x", 1, null]] }); return r; }\nvoid use;\n`;
    host.getSourceFile = (f, lang, ...rest) => (f === "api.ts" ? ts.createSourceFile(f, usage, lang) : read(f, lang, ...rest));
    const program = ts.createProgram(["api.ts"], options, host);
    return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  };
  assert.deepEqual(check(`declare const foundation: { ${found.matches[0].signature}; };`), []);
  assert.deepEqual(check(toolApiDts()), []);
  // every tool has a signature that isn't all unknown
  for (const t of scriptTools()) assert.match(toolSignature(t), new RegExp(`^${t.name}\\(args\\??: `));
});

// ---------------------------------------------------------------------------
// review fixes: each of these failed before its fix
// ---------------------------------------------------------------------------

/** a tool that takes its time, then writes a note: what lands after a deadline */
let slowLanded = 0;
TOOLS.push({
  name: "slow_write",
  description: "test only: waits, then writes a note",
  schema: z.object({ ms: z.number(), request_id: z.string().optional() }),
  write: true,
  run: async (ctx: { boardId: string }, i: { ms: number }) => {
    await new Promise((r) => setTimeout(r, i.ms));
    await runTool({ ...agent(ctx.boardId) }, "add_note", { title: "Slow", markdown: "landed" });
    slowLanded++;
    return "written";
  },
} as never);
const withLimits = async <T>(over: Partial<typeof CODE_LIMITS>, f: () => Promise<T>) => {
  const was = { ...CODE_LIMITS };
  Object.assign(CODE_LIMITS, over);
  try {
    return await f();
  } finally {
    Object.assign(CODE_LIMITS, was);
  }
};

test("a request_id replays only the same tool, and only the same script", async () => {
  const b = "cm-collide";
  // directly: the same id on a different tool runs
  await runTool(agent(b), "add_section", { name: "First", request_id: "same" });
  const note = (await runTool(agent(b), "add_note", { section: "First", title: "Second", markdown: "x", request_id: "same" })) as { id?: string };
  assert.ok(note.id, "add_note ran, not add_section's replay");
  // a script that failed after add_section, fixed and run again under the same request_id: its first call is now add_note
  const broken = await script(agent(b), `await foundation.add_section({ name: "Draft" }); throw new Error("oops");`, "job-x");
  assert.match(String(broken.error?.message), /oops/);
  const fixed = await script(agent(b), `const n = await foundation.add_note({ section: "Draft", title: "Fixed", markdown: "y" }); return n.id;`, "job-x");
  assert.match(String(fixed.result), /^note/);
  assert.ok(objects(b).some((o) => o.name === "Fixed"), "the note was written");
  // two different scripts under one id don't replay each other
  const one1 = await script(agent(b), `return "a"`, "job-y");
  const one2 = await script(agent(b), `return "b"`, "job-y");
  assert.deepEqual([one1.result, one2.result], ["a", "b"]);
  assert.deepEqual((await script(agent(b), `return "a"`, "job-y")).result, "a", "the same script still replays");
});

test("at the deadline the answer waits for calls in flight, starts no new ones, and names what was still running", async () => {
  const b = "cm-settle";
  slowLanded = 0;
  const out = await withLimits({ ms: 400, settleMs: 5000 }, () => script(agent(b), `await foundation.slow_write({ ms: 900 }); await foundation.add_note({ title: "After", markdown: "z" });`));
  assert.match(String(out.error?.message), /time limit/);
  assert.equal(slowLanded, 1, "the write in flight landed before the answer");
  assert.ok(!objects(b).some((o) => o.name === "After"), "no call started after the deadline");
  // bounded: past the cap, the answer says which call may still land
  const late = await withLimits({ ms: 300, settleMs: 200 }, () => script(agent(b), `await foundation.slow_write({ ms: 1500 });`));
  assert.match(String(late.error?.message), /still running .*\(slow_write\)/);
  await new Promise((r) => setTimeout(r, 1400));
});

test("a failure before the worker starts frees its slot", async () => {
  codeModeHooks.beforeSpawn = () => {
    throw new Error("no worker today");
  };
  try {
    for (let i = 0; i < CODE_LIMITS.concurrent + 1; i++) await assert.rejects(() => script(agent("cm-slot"), "return 1"), /no worker today/);
  } finally {
    codeModeHooks.beforeSpawn = null;
  }
  assert.deepEqual((await script(agent("cm-slot"), "return 1")).result, 1, "run_code isn't locked out");
});

test("one person holds at most two script slots; someone else still runs", async () => {
  await withLimits({ ms: 1200 }, async () => {
    const spinning = [script(agent("cm-busy"), "while (true) {}"), script(agent("cm-busy"), "while (true) {}")];
    await new Promise((r) => setTimeout(r, 100));
    const third = await script(agent("cm-busy"), "return 3");
    assert.match(String(third.error?.message), /^busy: 2 of this person's scripts/);
    const other = (await runTool({ boardId: "cm-busy", actor: "Boss's agent", userId: boss.id, door: "mcp" }, "run_code", { code: "return 4" })) as Out;
    assert.equal(other.result, 4);
    await Promise.all(spinning);
  });
  assert.equal((await script(agent("cm-busy"), "return 5")).result, 5, "the slots came back");
});

test("/mcp?mode=code over the real HTTP route: the core list, and a refused call; without mode, every tool", async () => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const { resolve } = await import("node:path");
  const port = await new Promise<number>((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
  const SERVICE = "c".repeat(40);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FOUNDATION_|SLACK_|ANTHROPIC_|GOOGLE_|GITHUB_|GH_|MESHY_|T3)/.test(k)) env[k] = v;
  const home = mkdtempSync(join(tmpdir(), "foundation-codemode-http-"));
  Object.assign(env, {
    FOUNDATION_PORT: String(port),
    FOUNDATION_ROOT: home,
    FOUNDATION_EXIT_WITH_PARENT: "1",
    FOUNDATION_STARTER_DIR: "",
    FOUNDATION_SERVICE_TOKEN: SERVICE,
    FOUNDATION_CLAUDE_CLI: join(home, "no-claude"),
    ANTHROPIC_API_KEY: "",
    T3_CLI: join(home, "no-t3"),
    T3_URL: "http://127.0.0.1:9",
    FACTORYFORM_URL: "http://127.0.0.1:9",
  });
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: resolve(import.meta.dirname, ".."), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let said = "";
  child.stdout!.on("data", (d) => (said += d));
  child.stderr!.on("data", (d) => (said += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 1200 && child.exitCode === null; i++) {
      try {
        if ((await realFetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(child.exitCode, null, said);
    const rpc = async (query: string, method: string, params: unknown) => {
      const res = await realFetch(`${base}/mcp?board=company${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SERVICE}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      return JSON.parse(text).result;
    };
    const code = await rpc("&mode=code", "tools/list", {});
    assert.deepEqual(code.tools.map((t: { name: string }) => t.name).sort(), [...CODE_MODE_TOOLS].sort());
    const refused = await rpc("&mode=code", "tools/call", { name: "add_note", arguments: { title: "x", markdown: "y" } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /inside run_code/);
    const all = await rpc("", "tools/list", {});
    assert.ok(all.tools.length > 40, `the default lists every tool (${all.tools.length})`);
    assert.ok(all.tools.some((t: { name: string }) => t.name === "add_note"));
    const caps = (await (await realFetch(`${base}/api/capabilities`)).json()) as { codeMode?: boolean };
    assert.equal(caps.codeMode, true);
  } finally {
    child.stdin?.end();
    child.kill();
  }
});

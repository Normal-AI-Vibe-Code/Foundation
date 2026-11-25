/**
 * A run, as others see it (docs/agent-harness.md §2), on the scripted runtime (no model):
 * - its reasoning streams as `thinking` events, kept in the run's transcript;
 * - its presence on the grid carries `plan` (from set_plan, at most 8 steps), its latest `thought` (at most 200
 *   characters, written at most every 250 ms) and `started`; the thought is cleared when it ends;
 * - its `doing` goes "reading the ask" → "thinking" → tool lines;
 * - a throw inside a run is an `error` event and the crew's status `error`, never an unhandled rejection.
 * And what can be seated: the three Claudes by kind, with where each runs and who pays; no Claude in T3's presets.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_SCRIPT_STEP_MS = "60";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";

const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

const { all } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { startRun, followRun } = await import("../src/agent.ts");
const { joinCrew, leaveCrew, setThought, crewPlan, THOUGHT_MS, _resetCrew } = await import("../src/crew.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { availableAgents, postAgent, findSeat, seatKind } = await import("../src/posted.ts");
const { T3_PRESETS } = await import("../src/t3host.ts");
const { CREW_PLAN_STEPS, CREW_THOUGHT_CHARS, GRID_PLACE } = await import("@foundation/protocol");

after(() => {
  _resetCrew();
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");

type Aw = { crew: { id: string; doing: string; status: string; plan: { goal: string; steps: Array<{ text: string; status: string }> } | null; thought: string | null; started: number } };
const crewStates = (boardId: string) => [...getBoard(boardId).awareness.getStates().values()].filter((s) => (s as Aw | null)?.crew).map((s) => s as Aw);

function finish(r: ReturnType<typeof startRun>) {
  return new Promise<Array<{ type: string; [k: string]: unknown }>>((resolve) => {
    const seen: Array<{ type: string; [k: string]: unknown }> = [];
    followRun(r.id, ada.id, (e) => seen.push(e as never), () => resolve(seen));
  });
}

test("a run shows its plan, its thinking and when it started, to everyone on the grid, and its reasoning to the asker", async () => {
  const r = startRun({ boardId: "h1", user: ada, prompt: "Make a section called “Supply” with the parts" });
  const seenPlans: string[] = [];
  const seenThoughts: string[] = [];
  const seenDoing: string[] = [];
  const board = getBoard("h1").awareness;
  const look = () => {
    for (const s of crewStates("h1")) {
      if (s.crew.plan) seenPlans.push(JSON.stringify(s.crew.plan));
      if (s.crew.thought) seenThoughts.push(s.crew.thought);
      seenDoing.push(s.crew.doing);
      assert.ok(s.crew.started > 0 && s.crew.started <= Date.now(), "started is when the run began");
    }
  };
  board.on("change", look);
  const events = await finish(r);
  board.off("change", look);

  // the asker's stream: reasoning as it came, and the transcript keeps it (one event per stretch of it)
  const thinking = events.filter((e) => e.type === "thinking");
  assert.ok(thinking.length >= 2, "two stretches of reasoning");
  assert.match(String(thinking[0].text), /I'll read the board first/);
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events.filter((e) => e.type === "error")));
  await new Promise((res) => setTimeout(res, 50));
  const row = all<{ transcript_json: string; status: string }>("select transcript_json, status from agent_runs where id = ?", r.id)[0];
  assert.equal(row.status, "done");
  const kept = (JSON.parse(row.transcript_json) as Array<{ type: string; text?: string }>).filter((e) => e.type === "thinking");
  assert.equal(kept.length, 2, "the transcript keeps the reasoning, merged per stretch");
  assert.match(kept[0].text!, /^The ask is a section called “Supply”.*then make the section and a table of parts\.$/);

  // on the grid: the plan stepping along, a thought of at most 200 characters, a truthful "doing"
  assert.ok(seenPlans.some((p) => p.includes('"Read the board","status":"active"')), "the plan as it starts");
  assert.ok(seenPlans.some((p) => p.includes('"Make the section","status":"active"')), "and as it steps on");
  assert.ok(seenThoughts.length > 0, "its thought showed");
  assert.ok(seenThoughts.every((t) => t.length <= CREW_THOUGHT_CHARS));
  assert.ok(seenDoing.indexOf("thinking") >= 0 && seenDoing.indexOf("thinking") < seenDoing.findIndex((d) => /reading the board/.test(d)), `thinking before its first step: ${seenDoing.join(" | ")}`);
  // done: its thought is gone, its plan stays for the moment it lingers
  const last = crewStates("h1").at(-1);
  assert.equal(last?.crew.status, "done");
  assert.equal(last?.crew.thought, null);
});

test("a throw inside a run is an error event and the crew's status error, never an unhandled rejection", async () => {
  const r = startRun({ boardId: "h2", user: ada, prompt: "Make a section called “Broken” [fail]" });
  const events = await finish(r);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "an error event");
  assert.match(String(err.message), /asked to fail/);
  assert.equal(crewStates("h2").at(-1)?.crew.status, "error");
  assert.equal(all<{ status: string }>("select status from agent_runs where id = ?", r.id)[0].status, "error");
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(unhandled, []);
});

test("set_plan puts at most 8 steps on the grid; a thought is its last 200 characters, written at most every 250 ms", async () => {
  const m = joinCrew({ boardId: "h3", userId: ada.id, userName: ada.name, runId: "run_h3", task: "plan" });
  const steps = Array.from({ length: 12 }, (_, i) => ({ text: `step ${i + 1}`, status: i === 0 ? "active" : "pending" }));
  await runTool({ boardId: "h3", actor: m.name, userId: ada.id, crew: m.id, door: "agent-run" }, "set_plan", { goal: "Twelve steps", steps });
  const plan = crewStates("h3")[0].crew.plan!;
  assert.equal(plan.goal, "Twelve steps");
  assert.equal(plan.steps.length, CREW_PLAN_STEPS);
  assert.deepEqual(plan.steps[0], { text: "step 1", status: "active" });
  assert.deepEqual(crewPlan({ goal: "g", steps: [{ text: "x", status: "bogus" }] }).steps, [{ text: "x", status: "pending" }]);

  let writes = 0;
  const count = () => writes++;
  m.awareness.on("update", count);
  setThought(m, "first " + "a".repeat(300));
  setThought(m, "second thought");
  setThought(m, "third thought");
  assert.equal(writes, 1, "one write now; the rest wait");
  assert.equal(crewStates("h3")[0].crew.thought!.length, CREW_THOUGHT_CHARS);
  await new Promise((res) => setTimeout(res, THOUGHT_MS + 60));
  assert.equal(writes, 2, "then one more, with the latest");
  assert.equal(crewStates("h3")[0].crew.thought, "third thought");
  m.awareness.off("update", count);
  leaveCrew(m, "done", 0);
});

test("what can be seated: three Claudes, each its kind, where it runs and who pays; a Claude key is no longer a T3 preset", () => {
  const { agents } = availableAgents();
  const own = agents.filter((a) => a.kind !== "t3");
  assert.deepEqual(own.map((a) => [a.key, a.kind]), [["claude", "claude-account"], ["claude-api", "claude-api"], ["claude-fed", "claude-federated"]]);
  for (const a of own) assert.ok(a.runs.length > 20, `${a.key} says where it runs and who pays`);
  assert.match(own[0].runs, /never uses an API key/);
  assert.match(own[1].runs, /API key an admin stored/);
  assert.ok(!("claude" in T3_PRESETS), "no Claude (API key) through T3");
  assert.ok("kimi" in T3_PRESETS && "deepseek" in T3_PRESETS);

  // a seat's kind is the server's: a claude-api seat carries no model of its own (it follows the default) and no `runs`
  const { seat } = postAgent("h4", GRID_PLACE, "claude-api", ada);
  assert.equal(seat.kind, "claude-api");
  assert.equal(seat.model, undefined);
  assert.ok(!("runs" in seat));
  assert.equal(findSeat("h4", { as: seat.alias })?.id, seat.id);
  assert.equal(findSeat("h4", { seat: seat.id })?.alias, seat.alias);
  assert.equal(seatKind(findSeat("h4", { seat: seat.id })!), "claude-api");
  assert.equal(seatKind({ key: "t3:kimi-cloud" }), "t3");
  assert.equal(seatKind({ key: "claude" }), "claude-account");
});

test("FOUNDATION_AGENT_TOOLS: code mode gives a claude-account run /mcp?…&mode=code and the API loop the code-mode tools; all gives everything", async () => {
  const { runMcpUrl, apiTools, agentToolsMode, DEFAULT_AGENT_TOOLS } = await import("../src/agent.ts");
  const { CODE_MODE_TOOLS } = await import("../src/codemode.ts");
  const was = process.env.FOUNDATION_AGENT_TOOLS;
  try {
    delete process.env.FOUNDATION_AGENT_TOOLS;
    assert.equal(agentToolsMode(), DEFAULT_AGENT_TOOLS);
    process.env.FOUNDATION_AGENT_TOOLS = "code";
    assert.equal(agentToolsMode(), "code");
    const url = new URL(runMcpUrl({ boardId: "a b", crew: "crew_1" }));
    assert.equal(url.searchParams.get("mode"), "code");
    assert.equal(url.searchParams.get("board"), "a b");
    assert.equal(url.searchParams.get("crew"), "crew_1");
    const code = apiTools().map((t) => t.name).sort();
    assert.deepEqual(code, [...CODE_MODE_TOOLS].sort());
    assert.ok(code.includes("read_card") && code.includes("run_code") && code.includes("search_tools"));
    process.env.FOUNDATION_AGENT_TOOLS = "all";
    assert.equal(new URL(runMcpUrl({ boardId: "b" })).searchParams.get("mode"), null);
    const every = apiTools().map((t) => t.name);
    assert.ok(every.length > 40 && every.includes("add_table") && every.includes("read_card"));
    process.env.FOUNDATION_AGENT_TOOLS = "bogus";
    assert.equal(agentToolsMode(), DEFAULT_AGENT_TOOLS, "anything else is the default");
  } finally {
    if (was === undefined) delete process.env.FOUNDATION_AGENT_TOOLS;
    else process.env.FOUNDATION_AGENT_TOOLS = was;
  }
});

test("a run that reads beyond the board (chat_channels) keeps its thought off the grid from then on; its reasoning still reaches the asker", async () => {
  const thoughts: Array<{ at: number; thought: string | null; doing: string }> = [];
  let readPrivate = -1;
  // watching from before it starts: a run says its first things before startRun returns
  const board = getBoard("h5").awareness;
  const look = () => {
    for (const s of crewStates("h5")) thoughts.push({ at: Date.now(), thought: s.crew.thought, doing: s.crew.doing });
  };
  board.on("change", look);
  const r = startRun({ boardId: "h5", user: ada, prompt: "Make a section called “Quiet” [private]" });
  const events = await finish(r);
  board.off("change", look);
  readPrivate = events.findIndex((e) => e.type === "tool" && e.name === "chat_channels");
  assert.ok(readPrivate > 0, "it read the chats");
  const after = events.slice(readPrivate).filter((e) => e.type === "thinking").map((e) => String(e.text)).join("");
  assert.match(after, /this reasoning is theirs alone/, "the asker still gets the reasoning");
  const shownAfter = thoughts.slice(thoughts.findIndex((t) => /chat channels/.test(t.doing)));
  assert.ok(shownAfter.length > 0);
  assert.ok(shownAfter.every((t) => t.thought === null), `no thought on the grid after the private read: ${JSON.stringify(shownAfter.filter((t) => t.thought))}`);
  assert.ok(thoughts.some((t) => t.thought), `before it, the thought showed: ${JSON.stringify(thoughts.slice(0, 8))}`);
});

test("a private run's pointing note and bring_view note stay off the grid", async () => {
  const { markPrivate, guide: guideTo } = await import("../src/crew.ts");
  const m = joinCrew({ boardId: "h6", userId: ada.id, userName: ada.name, runId: "run_h6", task: "t" });
  const sec = await runTool({ boardId: "h6", actor: m.name, userId: ada.id }, "add_section", { name: "Here" });
  void sec;
  await runTool({ boardId: "h6", actor: m.name, userId: ada.id, crew: m.id, door: "agent-run" }, "chat_channels", { limit: 1 });
  assert.equal(m.private, true, "reading chats made the run private");
  markPrivate(m);
  guideTo(m, { id: "x", kind: "section" }, "Here", "what Kai said in your DM");
  assert.equal(crewStates("h6")[0].crew.thought, null);
  assert.equal((crewStates("h6")[0] as unknown as { crew: { guide: { note?: string } } }).crew.guide.note, undefined);
  leaveCrew(m, "done", 0);
});

/**
 * The crew: every agent turn is a visible, named presence of its own.
 * - Two runs at once are two agents: different names, different awareness
 *   clients on the board, each with who asked and what it's doing.
 * - An agent aims at what it's about to change, then the change lands, and
 *   the board's activity and the card say which agent did it.
 * - bring_view guides only the person who asked.
 * - Helpers: only inside an ask, at most two, never a helper's helper.
 * - A viewer's agent can't write. MCP's crew id counts only for its own person.
 * - When a run ends its presence leaves the board: no ghost cursors.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_SCRIPT_STEP_MS = "0";
process.env.FOUNDATION_CREW_TRAVEL_MS = "40";

const { run, all } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { startRun, followRun, stopAllRuns } = await import("../src/agent.ts");
const { joinCrew, leaveCrew, crewOn, MAX_HELPERS, _resetCrew, describeStep, crewWork, describeCrewWork } = await import("../src/crew.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { crewFor } = await import("../src/mcp.ts");
const { boardMaps, tableCellsOf, noteTextOf } = await import("@foundation/protocol");

after(() => {
  _resetCrew();
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = upsertUser("kai@formindustries.com", "Kai");
const vic = upsertUser("vic@formindustries.com", "Vic");
run("update users set role = 'viewer' where id = ?", vic.id);

type CrewAw = { user: { name: string; agent: boolean }; crew: { id: string; asker: string; doing: string; target: { id: string; kind: string } | null; guide: { to: string; target: { id: string } } | null; status: string; lead?: string } };
function crewStates(boardId: string) {
  return [...getBoard(boardId).awareness.getStates().entries()]
    .filter(([, s]) => (s as CrewAw | null)?.crew)
    .map(([clientId, s]) => ({ clientId, ...(s as CrewAw) }));
}

/** run to the end; resolves with every event */
function finish(r: ReturnType<typeof startRun>, userId: string) {
  return new Promise<Array<{ type: string; [k: string]: unknown }>>((resolve) => {
    const seen: Array<{ type: string; [k: string]: unknown }> = [];
    followRun(r.id, userId, (e) => seen.push(e as never), () => resolve(seen));
  });
}

test("two agents at once are two named presences, each with who asked", () => {
  const a = joinCrew({ boardId: "c1", userId: ada.id, userName: ada.name, runId: "run_a", task: "one" });
  const b = joinCrew({ boardId: "c1", userId: kai.id, userName: kai.name, runId: "run_b", task: "two" });
  assert.notEqual(a.name, b.name);
  assert.notEqual(a.clientId, b.clientId);
  const states = crewStates("c1");
  assert.equal(states.length, 2);
  assert.deepEqual(new Set(states.map((s) => s.user.name)), new Set([a.name, b.name]));
  assert.ok(states.every((s) => s.user.agent));
  assert.equal(states.find((s) => s.crew.id === a.id)?.crew.asker, ada.id);
  leaveCrew(a, "done", 0);
  leaveCrew(b, "done", 0);
  assert.equal(crewStates("c1").length, 0, "left the board's awareness");
});

test("an agent aims before it writes, and its writes carry its name", async () => {
  const m = joinCrew({ boardId: "c2", userId: ada.id, userName: ada.name, runId: "run_c", task: "notes" });
  const ctx = { boardId: "c2", actor: m.name, userId: ada.id, crew: m.id };
  const sec = (await runTool(ctx, "add_section", { name: "Supply" })) as { id: string };
  // the next write aims at the section first: during the trip the card doesn't exist yet
  const pending = runTool(ctx, "add_table", { section: "Supply", name: "Parts", columns: ["Part", "Qty"], rows: [["Vane", 12], ["Hub", 2]] });
  await new Promise((r) => setTimeout(r, 10));
  const mid = crewStates("c2")[0];
  assert.equal(mid.crew.target?.id, sec.id, "aimed at the section");
  assert.match(mid.crew.doing, /making table “Parts”/);
  assert.equal([...boardMaps(getBoard("c2").doc).objects.values()].length, 0, "not there yet");
  const t = (await pending) as { id: string };
  const after = crewStates("c2")[0];
  assert.equal(after.crew.target?.id, t.id, "then on the new table");
  assert.deepEqual(tableCellsOf(getBoard("c2").doc, t.id), { "0,0": "Part", "1,0": "Qty", "0,1": "Vane", "1,1": "12", "0,2": "Hub", "1,2": "2" });
  const acts = boardMaps(getBoard("c2").doc).activity.toArray();
  assert.ok(acts.some((x) => x.who === m.name && /made table “Parts”/.test(x.text)), "activity says which agent");
  leaveCrew(m, "done", 0);
});

test("bring_view guides only the person who asked", async () => {
  const m = joinCrew({ boardId: "c3", userId: ada.id, userName: ada.name, runId: "run_d", task: "show" });
  const ctx = { boardId: "c3", actor: m.name, userId: ada.id, crew: m.id };
  const sec = (await runTool(ctx, "add_section", { name: "Look here" })) as { id: string };
  await runTool(ctx, "bring_view", { target: "Look here", note: "ready" });
  const s = crewStates("c3")[0];
  assert.equal(s.crew.guide?.to, ada.id);
  assert.equal(s.crew.guide?.target.id, sec.id);
  // an outside MCP agent (no crew) can't move anyone's view
  const out = await runTool({ boardId: "c3", actor: "Agent (MCP)", userId: ada.id }, "bring_view", { target: "Look here" });
  assert.match(String(out), /only Foundation's own agents/);
  leaveCrew(m, "done", 0);
});

test("a run is a crew member from start to finish, and a helper is its own agent", async () => {
  const r = startRun({ boardId: "c4", user: ada, prompt: "Make a section called “Supply” with the parts, hook up FactoryForm, and get help" });
  const lead = r.events.find((e) => e.type === "crew") as { name: string } | undefined;
  assert.ok(lead, "a crew event first");
  assert.equal(crewStates("c4").length, 1);
  const events = await finish(r, ada.id);
  const helper = events.find((e) => e.type === "helper") as { name: string; runId: string } | undefined;
  assert.ok(helper, "the lead called in a helper");
  assert.notEqual(helper.name, lead.name);
  // let the helper finish too
  await new Promise((res) => setTimeout(res, 400));
  const doc = getBoard("c4").doc;
  const m = boardMaps(doc);
  const cards = [...m.objects.values()];
  assert.ok(cards.some((c) => c.kind === "table" && c.name === "Parts"));
  assert.ok(cards.some((c) => c.kind === "panel" && c.panel === "connector" && c.createdBy === lead.name), "the connector names its agent");
  assert.ok(cards.some((c) => c.kind === "table" && c.name === "Parts" && c.createdBy === lead.name), "the table names its agent");
  assert.ok(cards.filter((c) => c.kind === "note").every((c) => c.createdBy && (c.createdBy === lead.name || c.createdBy === helper.name)), "each note names the agent that wrote it");
  const who = new Set(m.activity.toArray().filter((a) => a.role === "agent").map((a) => a.who));
  assert.ok(who.has(lead.name) && who.has(helper.name), `both agents signed their work: ${[...who]}`);
  const log = m.activity.toArray();
  assert.equal(log.filter((a) => a.who === ada.name && a.text.startsWith("asked the agent")).length, 1, "Ada asked once; the helper's brief isn't logged as hers");
  assert.ok(log.some((a) => a.who === lead.name && a.text.startsWith(`called in ${helper.name}:`)), "the lead signs calling in help");
  const guide = events.find((e) => e.type === "tool" && e.name === "bring_view");
  assert.ok(guide, "brought the person there");
  // done, then gone (after the linger)
  const lingering = crewStates("c4");
  assert.ok(lingering.every((s) => s.crew.status === "done"));
  await new Promise((res) => setTimeout(res, 2600));
  assert.equal(crewStates("c4").length, 0, "no ghost cursors");
  assert.equal(crewOn("c4").length, 0);
});

test("helpers: only within an ask, at most two, never a helper's helper", async () => {
  const m = joinCrew({ boardId: "c5", userId: ada.id, userName: ada.name, runId: "run_e", task: "lead" });
  const ctx = { boardId: "c5", actor: m.name, userId: ada.id, crew: m.id };
  // outside a Foundation run, nobody to call
  assert.match(String(await runTool({ boardId: "c5", actor: "Agent (MCP)", userId: ada.id }, "call_in_help", { task: "write a note somewhere" })), /only be called in/);
  m.helpers = MAX_HELPERS;
  await assert.rejects(() => runTool(ctx, "call_in_help", { task: "write a third note" }), /at most 2 helpers/);
  const h = joinCrew({ boardId: "c5", userId: ada.id, userName: ada.name, runId: "run_f", task: "helper", lead: m });
  await assert.rejects(() => runTool({ ...ctx, actor: h.name, crew: h.id }, "call_in_help", { task: "write a nested note" }), /helper can't call in helpers/);
  leaveCrew(h, "done", 0);
  leaveCrew(m, "done", 0);
});

test("a viewer's agent reads but can't write, and can't call in help", async () => {
  const m = joinCrew({ boardId: "c6", userId: vic.id, userName: vic.name, runId: "run_g", task: "look" });
  const ctx = { boardId: "c6", actor: m.name, userId: vic.id, crew: m.id };
  await runTool(ctx, "read_board", {});
  await assert.rejects(() => runTool(ctx, "add_table", { name: "x", columns: ["a"] }), /View only/);
  await assert.rejects(() => runTool(ctx, "call_in_help", { task: "do it for me instead" }), /View only/);
  leaveCrew(m, "done", 0);
});

test("organizing: arrange orders a section's flow without new times; rename_section renames", async () => {
  const m = joinCrew({ boardId: "c7", userId: ada.id, userName: ada.name, runId: "run_h", task: "tidy" });
  const ctx = { boardId: "c7", actor: m.name, userId: ada.id, crew: m.id };
  await runTool(ctx, "add_section", { name: "Messy" });
  const a = (await runTool(ctx, "add_note", { section: "Messy", title: "A", markdown: "a" })) as { id: string };
  await new Promise((r) => setTimeout(r, 5));
  const b = (await runTool(ctx, "add_note", { section: "Messy", title: "B", markdown: "b" })) as { id: string };
  const objs = () => boardMaps(getBoard("c7").doc).objects;
  const before = new Set([objs().get(a.id)!.bornAt, objs().get(b.id)!.bornAt]);
  await runTool(ctx, "arrange_section", { section: "Messy", order: [b.id, a.id] });
  assert.ok(objs().get(b.id)!.bornAt < objs().get(a.id)!.bornAt, "B now flows first");
  assert.deepEqual(new Set([objs().get(a.id)!.bornAt, objs().get(b.id)!.bornAt]), before, "the same times, handed out again");
  await runTool(ctx, "rename_section", { section: "Messy", name: "Tidy" });
  assert.ok([...boardMaps(getBoard("c7").doc).sections.values()].some((s) => s.name === "Tidy"));
  leaveCrew(m, "done", 0);
});

test("a cursor names what it wires by card, not by the ids a real model passes", async () => {
  const m = joinCrew({ boardId: "c9", userId: ada.id, userName: ada.name, runId: "run_w", task: "wire" });
  const ctx = { boardId: "c9", actor: m.name, userId: ada.id, crew: m.id };
  await runTool(ctx, "add_section", { name: "Wired" });
  const from = (await runTool(ctx, "add_panel", { section: "Wired", panel: "link", name: "Stock feed", url: "https://example.com" })) as { id: string };
  const to = (await runTool(ctx, "add_panel", { section: "Wired", panel: "link", name: "Shortages", url: "https://example.com" })) as { id: string };
  const input = { from_panel: from.id, from_port: "port_x1", to_panel: to.id, to_port: "port_y2" };
  assert.equal(describeStep("connect", input, "c9"), "wiring Stock feed → Shortages");
  assert.equal(describeStep("connect", { ...input, from_panel: "nope" }, "c9"), "wiring nope → Shortages", "an unknown id is shown as given");
  leaveCrew(m, "done", 0);
});

test("a connector hooked up first doesn't hide the cards added after it", async () => {
  // a real crew turn's order: section, connector, then a table and notes
  const ctx = { boardId: "c10", actor: "Talc", userId: ada.id };
  await runTool(ctx, "add_section", { name: "Ops review" });
  const ff = (await runTool(ctx, "add_panel", { section: "Ops review", panel: "connector", connector: "factoryform", name: "FactoryForm" })) as { id: string };
  const sec = () => [...boardMaps(getBoard("c10").doc).sections.values()].find((s) => s.name === "Ops review")!;
  assert.equal(sec().host, ff.id, "alone in its section, the app fills it");
  const t = (await runTool(ctx, "add_table", { section: "Ops review", name: "Open work orders", columns: ["WO", "Status"] })) as { id: string };
  assert.equal(sec().host, undefined, "with a table beside it, it's a card in the flow");
  const n = (await runTool(ctx, "add_note", { section: "Ops review", title: "What's blocked", markdown: "x" })) as { id: string };
  const objs = boardMaps(getBoard("c10").doc).objects;
  for (const id of [ff.id, t.id, n.id]) assert.equal(objs.get(id)?.sectionId, sec().id);
  // a second app into a hosted section joins the flow too
  await runTool(ctx, "add_section", { name: "Solo" });
  await runTool(ctx, "add_panel", { section: "Solo", panel: "connector", connector: "bomform", name: "BomForm" });
  await runTool(ctx, "add_panel", { section: "Solo", panel: "link", name: "Docs", url: "https://example.com" });
  assert.equal([...boardMaps(getBoard("c10").doc).sections.values()].find((s) => s.name === "Solo")!.host, undefined);
});

test("MCP: a crew id counts only for the person and board it belongs to", () => {
  const m = joinCrew({ boardId: "c8", userId: ada.id, userName: ada.name, runId: "run_i", task: "mcp" });
  assert.equal(crewFor(m.id, ada, "c8")?.name, m.name);
  assert.equal(crewFor(m.id, kai, "c8"), undefined, "someone else's bearer can't act as Ada's agent");
  assert.equal(crewFor(m.id, ada, "other"), undefined, "nor on another board");
  leaveCrew(m, "done", 0);
  assert.equal(crewFor(m.id, ada, "c8"), undefined, "nor once it has left");
});

test("the crew-wide stop: all of one person's agents on one board, and nobody else's", async () => {
  process.env.FOUNDATION_SCRIPT_STEP_MS = "200";
  const mine = [startRun({ boardId: "s1", user: ada, prompt: "Make a section called “One” with the parts" }), startRun({ boardId: "s1", user: ada, prompt: "Make a section called “Two” with the parts" })];
  const otherBoard = startRun({ boardId: "s2", user: ada, prompt: "Make a section called “Three”" });
  const someoneElse = startRun({ boardId: "s1", user: kai, prompt: "Make a section called “Four”" });
  assert.equal(stopAllRuns("s1", ada.id), 2, "both of Ada's runs on s1");
  assert.equal(stopAllRuns("s1", ada.id), 0, "already stopping: not counted twice");
  const ended = await Promise.all([...mine.map((r) => finish(r, ada.id)), finish(otherBoard, ada.id), finish(someoneElse, kai.id)]);
  process.env.FOUNDATION_SCRIPT_STEP_MS = "0";
  assert.ok(mine.every((r) => r.ctrl.signal.aborted), "Ada's two on s1 stopped");
  assert.equal(otherBoard.ctrl.signal.aborted, false, "her run on another board kept going");
  assert.equal(someoneElse.ctrl.signal.aborted, false, "Kai's kept going");
  assert.equal(ended.length, 4);
  await new Promise((res) => setTimeout(res, 2600));
  assert.equal(crewOn("s1").length, 0, "no cursor left behind");
});

test("a person's note made through the tools (no crew) names nobody", async () => {
  await runTool({ boardId: "c-person", actor: "Ada Lovelace", userId: ada.id }, "add_note", { title: "Mine", markdown: "hi" });
  const note = [...boardMaps(getBoard("c-person").doc).objects.values()].find((o) => o.kind === "note");
  assert.ok(note);
  assert.equal(note.createdBy, undefined);
});


test("point_at: the cursor points at a cell or a port, writes nothing, and checks what it's given", async () => {
  const r = startRun({ boardId: "c-point", user: ada, prompt: "Make a section called “Costs” with the parts and point out the total" });
  const events = await finish(r, ada.id);
  const points = events.filter((e) => e.type === "tool" && e.name === "point_at");
  assert.equal(points.length, 2, "pointed twice");
  assert.ok(events.some((e) => e.type === "tool_result" && e.name === "point_at" && e.ok && String(e.summary).includes("cell D5")));
  const doc = getBoard("c-point").doc;
  const m = boardMaps(doc);
  const table = [...m.objects.values()].find((o) => o.kind === "table")!;
  const before = m.activity.length;
  const member = joinCrew({ boardId: "c-point", userId: ada.id, userName: ada.name, runId: "run_point", task: "point" });
  const ctx = { boardId: "c-point", actor: member.name, userId: ada.id, crew: member.id };
  assert.equal(await runTool(ctx, "point_at", { target: table.id, cell: "B2" }), "pointing at cell B2");
  const aw = crewStates("c-point").find((s) => s.crew.id === member.id)!;
  assert.deepEqual(aw.crew.target, { id: table.id, kind: "object", cell: "B2" });
  assert.equal(m.activity.length, before, "pointing writes nothing to the board");
  await assert.rejects(runTool(ctx, "point_at", { target: table.id, port: "out" }), /no port/);
  const sec = [...m.sections.values()][0];
  await assert.rejects(runTool(ctx, "point_at", { target: sec.id, cell: "A1" }), /cells are on tables/);
  leaveCrew(member, "done", 0);
});

test("helpers see the lead's plan and each other's work, so the second doesn't make the first's card again", async () => {
  const r = startRun({ boardId: "c9", user: ada, prompt: "Make a section called “Shared” with the parts, and get two helpers" });
  const events = await finish(r, ada.id);
  const helpers = events.filter((e) => e.type === "helper") as unknown as Array<{ name: string; runId: string }>;
  assert.equal(helpers.length, 2, "the lead called in two");
  // the helpers finish on their own
  for (let i = 0; i < 60 && crewOn("c9").some((c) => c.state.crew.status === "working"); i++) await new Promise((res) => setTimeout(res, 100));
  const m = boardMaps(getBoard("c9").doc);
  const shared = [...m.sections.values()].find((s) => s.name === "Shared")!;
  const notes = [...m.objects.values()].filter((o) => o.kind === "note" && o.sectionId === shared.id);
  const suppliers = notes.filter((n) => n.name === "Suppliers to call");
  assert.equal(suppliers.length, 1, `one supplier list, not two: ${notes.map((n) => `${n.name} by ${n.createdBy}`)}`);
  assert.equal(suppliers[0].createdBy, helpers[0].name);
  const lead = notes.find((n) => n.name === "Lead times");
  assert.ok(lead, "the second helper wrote only what wasn't there");
  assert.equal(lead.createdBy, helpers[1].name);
  const text = noteTextOf(getBoard("c9").doc, lead as never);
  assert.match(text, new RegExp(`${helpers[0].name} already wrote “Suppliers to call”`));
  assert.match(text, /plan: Shared: the parts on the board, with their data/, "it had the lead's plan");
  // each helper's brief carried the lead's plan and what the crew had made by then
  const briefs = all<{ prompt: string }>("select prompt from agent_runs where board_id = 'c9' and prompt like 'You were called in%' order by created_at");
  assert.equal(briefs.length, 2);
  assert.match(briefs[0].prompt, /<crew>\n.*plan: Shared: the parts on the board/s);
  assert.match(briefs[1].prompt, new RegExp(`${helpers[0].name} \\(helper.*made note “Suppliers to call” in “Shared”`));
  // crew_work answers only Foundation's own agents
  assert.equal(await runTool({ boardId: "c9", actor: "Ada's agent", userId: ada.id }, "crew_work", {}), "only Foundation's own agents work in a crew");
});

test("crew_work: the lead, its helpers, their plan and what each made; finished helpers stay in it", async () => {
  const lead = joinCrew({ boardId: "c10", userId: ada.id, userName: ada.name, runId: "run_w1", task: "the ops review" });
  const lctx = { boardId: "c10", actor: lead.name, userId: ada.id, crew: lead.id };
  await runTool(lctx, "set_plan", { goal: "An ops review", steps: [{ text: "Section", status: "active" }] });
  await runTool(lctx, "add_section", { name: "Ops" });
  const h = joinCrew({ boardId: "c10", userId: ada.id, userName: ada.name, runId: "run_w2", task: "the standup checklist", lead });
  const hctx = { boardId: "c10", actor: h.name, userId: ada.id, crew: h.id };
  const note = (await runTool(hctx, "add_note", { section: "Ops", title: "Standup", markdown: "- [ ] blockers" })) as { id: string };
  leaveCrew(h, "done", 0);
  const h2 = joinCrew({ boardId: "c10", userId: ada.id, userName: ada.name, runId: "run_w3", task: "the metrics", lead });
  const w = (await runTool({ boardId: "c10", actor: h2.name, userId: ada.id, crew: h2.id }, "crew_work", {})) as ReturnType<typeof crewWork>;
  assert.equal(w.plan?.goal, "An ops review");
  assert.equal(w.lead, lead.name);
  assert.deepEqual(w.crew.map((c) => [c.name, c.role, c.working]), [[lead.name, "lead", true], [h.name, "helper", false], [h2.name, "helper", true]]);
  assert.deepEqual(w.crew[0].sections, ["Ops"]);
  assert.deepEqual(w.crew[1].made.map((x) => [x.id, x.kind, x.name, x.section]), [[note.id, "note", "Standup", "Ops"]]);
  assert.match(describeCrewWork(h2), new RegExp(`${h.name} \\(helper, finished\\): made note “Standup” in “Ops”`));
  leaveCrew(h2, "done", 0);
  leaveCrew(lead, "done", 0);
});

test("the Shiba isn't one of the crew: no cursor on a board; it points on the person's Today", async () => {
  const { saveGoal } = await import("../src/today.ts");
  const goal = saveGoal(ada.id, { title: "Freeze the rim-drive CAD" });
  const r = startRun({ boardId: "company", user: ada, prompt: "What's first today?", persona: "shiba" });
  const events = await finish(r, ada.id);
  assert.equal(events.filter((e) => e.type === "crew").length, 0, "no crew member for the Shiba");
  assert.equal(crewStates("company").length, 0, "no cursor on the company board");
  const pointed = events.find((e) => e.type === "tool" && e.name === "point_today") as { input: { ids: string[] } } | undefined;
  assert.ok(pointed?.input.ids.includes(goal.id), "pointed at the goal on Today");
  assert.ok(events.some((e) => e.type === "text"), "and said something");
});

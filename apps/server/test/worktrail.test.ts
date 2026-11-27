/**
 * The agents' work trail (src/worktrail.ts): what each agent on a grid is doing, where, and on what, against a
 * stand-in T3 (t3-standin.ts) so a T3 thread is the real thing end to end.
 *
 * Checked: a T3 agent's board steps (through runTool, as its MCP calls arrive) land on its lane with the section and
 * card each touched, how long it took and whether it worked; the files it writes in its own folder show by name and
 * size, never the pass file; its home is the section it was asked in. The person who asked sees each step's arguments
 * and answer, and the run's reasoning; anyone else on the grid sees only the shape. Once a run has read beyond the grid
 * (PRIVATE_READS), others see no step words, no cards and no file names. concurrent_work tells one agent where the
 * others are, without their words. Reading the trail never writes the board. A run that ends is kept, not watched.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { writeStandin } from "./t3-standin.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-trail-"));
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
process.env.FOUNDATION_ADMIN_EMAILS = "";
process.env.FOUNDATION_T3_PORT = String(25000 + Math.floor(Math.random() * 2000));
process.env.FOUNDATION_T3_READY_MS = "8000";
process.env.FOUNDATION_T3_START_MS = "4000";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";
const standin = writeStandin(dir);
process.env.T3_CLI = standin.cli;

const { startT3, stopT3, t3Host } = await import("../src/t3host.ts");
const { askT3, _resetT3Threads } = await import("../src/t3threads.ts");
const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { crewOn, joinCrew, leaveCrew, markPrivate } = await import("../src/crew.ts");
const { trailLanes, trailNote, concurrentWork, _resetTrail } = await import("../src/worktrail.ts");
const { appendSection } = await import("@foundation/protocol");
import type { UserInfo } from "@foundation/protocol";

const BOARD = "trail-board";
const ada: UserInfo = upsertUser("ada@formindustries.com", "Ada");
const kai: UserInfo = upsertUser("kai@formindustries.com", "Kai");
let parts = "";
let notes = "";
getBoard(BOARD).doc.transact(() => {
  parts = appendSection(getBoard(BOARD).doc, "Parts").id;
  notes = appendSection(getBoard(BOARD).doc, "Notes").id;
});

after(() => {
  _resetT3Threads();
  _resetTrail();
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
const lane = (viewer: UserInfo, crew: string) => trailLanes(BOARD, viewer).find((l) => l.crew === crew)!;

let threadId = "";
let crewId = "";
let folder = "";

test("a T3 agent's board steps and the files it writes are its lane: where, on what, how it went", async () => {
  assert.equal((await startT3("Ada")).state, "running");
  await until("the providers", () => t3Host().agents.find((a) => a.id === "claudeAgent")?.boardTools === true, 8000);
  const r = await askT3(ada, { board: BOARD, section: parts, agent: "claudeAgent", text: "Note the open questions on the parts" });
  threadId = r.threadId;
  crewId = r.crew;
  folder = dispatched().filter((c) => c.type === "project.create").at(-1)!.workspaceRoot as string;
  // the brief tells it other agents may be at work, and where to look
  const brief = dispatched().filter((c) => c.type === "thread.turn.start").at(-1)!.message.text as string;
  assert.match(brief, /concurrent_work/);
  assert.match(brief, /work trail/);
  // before it does anything it stands in its home section
  const first = lane(ada, crewId);
  assert.equal(first.kind, "t3");
  assert.deepEqual(first.home, { id: parts, name: "Parts" });
  assert.equal(first.status, "working");
  assert.equal(first.thread, threadId);

  // its MCP calls go through runTool as its crew member
  const ctx = { boardId: BOARD, actor: r.name, userId: ada.id, crew: crewId, door: "mcp" as const };
  await runTool(ctx, "read_board", {});
  const note = (await runTool(ctx, "add_note", { section: "Parts", title: "Open questions", markdown: "- Which supplier for the hub bearing?", request_id: "q1" })) as { id: string };
  await assert.rejects(runTool(ctx, "read_card", { id: "nope" }));
  // and it writes code in its folder
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "src", "bom.ts"), "export const parts = [];\n");
  mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
  writeFileSync(join(folder, "node_modules", "x", "i.js"), "1");
  await until("the file shows", () => lane(ada, crewId).files.some((f) => f.path === "src/bom.ts"));

  const mine = lane(ada, crewId);
  const tools = mine.steps.filter((s) => s.kind === "tool");
  assert.deepEqual(tools.map((s) => s.tool), ["read_board", "add_note", "read_card"]);
  const add = tools[1];
  assert.equal(add.ok, true);
  assert.equal(add.read, false);
  assert.equal(add.section, parts);
  assert.equal(add.card, note.id);
  assert.equal(typeof add.ms, "number");
  assert.equal(tools[2].ok, false);
  // the asker sees what it was called with (never request_id) and what came back
  assert.equal((add.input as Record<string, unknown>).title, "Open questions");
  assert.equal("request_id" in (add.input as object), false);
  assert.ok(tools[2].summary);
  assert.deepEqual(mine.sections.find((s) => s.id === parts), { id: parts, name: "Parts", reads: 0, writes: 1 });
  assert.deepEqual(mine.cards.map((c) => [c.id, c.name, c.writes]), [[note.id, "Open questions", 1]]);
  // files by name and size; the pass and dependencies are never listed
  const f = mine.files.find((x) => x.path === "src/bom.ts")!;
  assert.equal(f.change, "added");
  assert.equal(f.bytes, 25);
  assert.ok(mine.files.every((x) => !x.path.includes(".foundation-mcp") && !x.path.includes("node_modules")));
});

test("anyone else on the grid sees the shape of it, not its arguments, answers or reasoning", () => {
  const m = crewOn(BOARD).find((x) => x.id === crewId)!;
  trailNote(m, "thought", "The hub bearing has two suppliers; ");
  trailNote(m, "thought", "ask which.");
  trailNote(m, "said", "Added the open questions.");
  const mine = lane(ada, crewId);
  assert.deepEqual(mine.steps.filter((s) => s.kind !== "tool").map((s) => [s.kind, s.summary]), [["thought", "The hub bearing has two suppliers; ask which."], ["said", "Added the open questions."]]);
  const theirs = lane(kai, crewId);
  assert.equal(theirs.mine, false);
  assert.ok(theirs.steps.every((s) => s.kind === "tool"), "no reasoning or words for anyone but the asker");
  assert.ok(theirs.steps.every((s) => s.input === undefined && s.summary === undefined));
  assert.deepEqual(theirs.steps.map((s) => s.tool), ["read_board", "add_note", "read_card"]);
  assert.ok(theirs.files.some((x) => x.path === "src/bom.ts"));
});

test("an agent asks where the others are: their sections, cards and files, never their words", async () => {
  const other = joinCrew({ boardId: BOARD, userId: kai.id, userName: kai.name, runId: "run_kai", task: "tidy the notes" });
  await runTool({ boardId: BOARD, actor: other.name, userId: kai.id, crew: other.id }, "add_note", { section: "Notes", title: "Tidy list", markdown: "x" });
  const told = (await runTool({ boardId: BOARD, actor: other.name, userId: kai.id, crew: other.id }, "concurrent_work", {})) as string;
  assert.match(told, new RegExp(`You are ${other.name}`));
  assert.match(told, /1 other agent is working/);
  assert.match(told, /Claude \(through T3, for Ada\) in “Parts”/);
  assert.match(told, /Writing in “Parts”/);
  assert.match(told, /“Open questions”/);
  assert.match(told, /src\/bom\.ts/);
  assert.doesNotMatch(told, /hub bearing|suppliers/, "never another run's words");
  // and the first agent sees the second
  assert.match(concurrentWork(BOARD, crewOn(BOARD).find((x) => x.id === crewId)), new RegExp(`${other.name} \\(Foundation's own, for Kai\\)`));
  leaveCrew(other, "done", 0);
  // a finished run is still on the trail, done
  assert.equal(lane(ada, other.id).status, "done");
});

test("once a run reads beyond the grid, others see only that it worked and where", () => {
  const m = crewOn(BOARD).find((x) => x.id === crewId)!;
  markPrivate(m);
  const theirs = lane(kai, crewId);
  assert.equal(theirs.private, true);
  assert.deepEqual(theirs.cards, []);
  assert.deepEqual(theirs.files, []);
  assert.ok(theirs.steps.every((s) => s.label === "reading" || s.label === "changing the grid"));
  assert.ok(theirs.steps.every((s) => s.card === null));
  assert.ok(theirs.sections.some((s) => s.id === parts), "where it stood is the grid's");
  // the asker still sees all of it
  assert.ok(lane(ada, crewId).files.length > 0);
  assert.doesNotMatch(concurrentWork(BOARD, undefined), /bom\.ts|Open questions/);
});

test("reading the trail never writes the board; a run that ends is kept and no longer watched", async () => {
  const before = Y.encodeStateVector(getBoard(BOARD).doc);
  trailLanes(BOARD, ada);
  trailLanes(BOARD, kai);
  concurrentWork(BOARD, undefined);
  assert.deepEqual(Y.encodeStateVector(getBoard(BOARD).doc), before);
  tell({ do: "finish", id: threadId });
  await until("done", () => lane(ada, crewId).status === "done");
  const n = lane(ada, crewId).files.length;
  writeFileSync(join(folder, "after.txt"), "late");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lane(ada, crewId).files.length, n, "its folder isn't watched once it has ended");
  assert.ok(lane(ada, crewId).ended);
});

/**
 * Session tabs: each agent session is its own conversation, listed per person
 * per board with its first ask as its title, replayed turn by turn; set_plan
 * is a board tool any runtime can call; and Vision Code's threads are read
 * from its own store — a missing store says "unavailable", never throws.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
const t3home = mkdtempSync(join(tmpdir(), "t3-test-"));
process.env.T3CODE_HOME = t3home;
process.env.T3_URL = "http://127.0.0.1:9"; // nothing listens: links come back null

const { run } = await import("../src/db.ts");
const { listSessions, sessionTurns } = await import("../src/agent.ts");
const { runTool } = await import("../src/tools.ts");
const { t3Threads, t3Thread } = await import("../src/t3.ts");

function addRun(id: string, session: string | null, user: string, prompt: string, at: number, board = "company") {
  run(
    "insert into agent_runs (id, board_id, runtime, prompt, status, transcript_json, created_by, created_at, session_id) values (?, ?, 'api', ?, 'done', ?, ?, ?, ?)",
    id, board, prompt, JSON.stringify([{ type: "text", text: `re: ${prompt}` }]), user, at, session,
  );
}

test("sessions group their runs, newest first, and stay with their person and board", () => {
  addRun("r1", "ses_aaaaaaaa", "u1", "Organize the fan work\nwith detail", 1000);
  addRun("r2", "ses_aaaaaaaa", "u1", "and the questions", 3000);
  addRun("r3", "ses_bbbbbbbb", "u1", "What's going on?", 2000);
  addRun("r4", "ses_cccccccc", "u2", "someone else's", 4000);
  addRun("r5", null, "u1", "the old dock conversation", 5000);
  addRun("r6", "ses_dddddddd", "u1", "another board", 6000, "other");

  const mine = listSessions("company", "u1");
  assert.deepEqual(mine.map((s) => s.id), ["ses_aaaaaaaa", "ses_bbbbbbbb"]);
  assert.equal(mine[0].title, "Organize the fan work"); // the first ask, first line
  assert.equal(mine[0].runs, 2);

  const turns = sessionTurns("ses_aaaaaaaa", "u1");
  assert.deepEqual(turns.map((t) => t.prompt), ["Organize the fan work\nwith detail", "and the questions"]);
  assert.equal(turns[0].events[0].type, "text");
  assert.deepEqual(sessionTurns("ses_aaaaaaaa", "u2"), []); // not yours, not shown
});

test("set_plan is a tool every runtime can call", async () => {
  const out = await runTool({ boardId: "company", actor: "test", userId: "u1" }, "set_plan", {
    goal: "Fan work in one place",
    steps: [
      { text: "Make the section", status: "done" },
      { text: "Move the cards", status: "active" },
    ],
  });
  assert.match(String(out), /1\/2 done/);
});

test("Vision Code: no store is 'unavailable'; a store lists live threads and replays one", async () => {
  const none = await t3Threads();
  assert.deepEqual({ ...none, missing: undefined }, { available: false, threads: [], missing: undefined });
  assert.match(none.missing!, /T3CODE_HOME is .*no userdata\/state\.sqlite/, "says where it looked");

  // the slice of T3's projection Foundation reads
  mkdirSync(join(t3home, "userdata"));
  const d = new DatabaseSync(join(t3home, "userdata", "state.sqlite"));
  d.exec(`
    create table projection_projects (project_id text primary key, title text not null, workspace_root text, scripts_json text, created_at text, updated_at text, deleted_at text);
    create table projection_threads (thread_id text primary key, project_id text not null, title text not null, updated_at text not null, deleted_at text, archived_at text, latest_user_message_at text, pending_approval_count integer not null default 0, pending_user_input_count integer not null default 0);
    create table projection_thread_sessions (thread_id text primary key, status text not null, last_error text);
    create table projection_thread_messages (message_id text primary key, thread_id text not null, role text not null, text text not null, created_at text not null);
    create table projection_thread_activities (activity_id text primary key, thread_id text not null, kind text not null, summary text not null, payload_json text not null, created_at text not null);
    create table projection_thread_proposed_plans (plan_id text primary key, thread_id text not null, plan_markdown text not null, created_at text, updated_at text);
    insert into projection_projects values ('p1', 'Vision', '/tmp', '[]', '', '', null);
    insert into projection_threads values ('t1', 'p1', 'Heat exchanger viewer', '2026-11-01T10:00:00Z', null, null, null, 1, 0);
    insert into projection_threads values ('t2', 'p1', 'Gone', '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', null, null, 0, 0);
    insert into projection_thread_sessions values ('t1', 'running', null);
    insert into projection_thread_messages values ('m1', 't1', 'user', 'Make the slicing viewer', '2026-11-01T10:00:00Z');
    insert into projection_thread_messages values ('m2', 't1', 'assistant', '  ', '2026-11-01T10:00:01Z');
    insert into projection_thread_messages values ('m3', 't1', 'assistant', 'On it.', '2026-11-01T10:00:02Z');
    insert into projection_thread_activities values ('a1', 't1', 'tool.started', 'Tool call', '{"toolCallId":"c1","detail":"Read: {}","status":"inProgress"}', '2026-11-01T10:00:03Z');
    insert into projection_thread_activities values ('a2', 't1', 'tool.completed', 'Tool call', '{"toolCallId":"c1","detail":"Read: viewer.ts","status":"completed"}', '2026-11-01T10:00:04Z');
    insert into projection_thread_proposed_plans values ('pl1', 't1', '1. Slice\n2. Render', '', '2026-11-01T10:00:05Z');
  `);
  d.close();

  const list = await t3Threads();
  assert.equal(list.available, true);
  assert.deepEqual(list.threads.map((t) => [t.title, t.project, t.status, t.url]), [["Heat exchanger viewer", "Vision", "waiting", null]]);

  const one = await t3Thread("t1");
  assert.ok(one);
  assert.deepEqual(one.items.map((i) => [i.kind, i.text, i.ok]), [
    ["user", "Make the slicing viewer", undefined],
    ["assistant", "On it.", undefined],
    ["tool", "Read: viewer.ts", true], // one step per call, its last state
  ]);
  assert.equal(one.plan, "1. Slice\n2. Render");
  assert.equal(await t3Thread("t2"), null); // deleted threads stay gone
});

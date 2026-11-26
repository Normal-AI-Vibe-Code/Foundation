/**
 * A council seat's last runs (agent.ts seatRuns, GET /api/agent/seat-runs): found by the name its cursor wore, failed
 * ones too, newest first, and only the asker's own (the transcript holds the agent's reasoning and what it read).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { run } = await import("../src/db.ts");
const { seatRuns } = await import("../src/agent.ts");

const put = (id: string, by: string, name: string | null, status: string, at: number, events: unknown[] = []) =>
  run(
    "insert into agent_runs (id, board_id, runtime, prompt, status, created_by, created_at, session_id, crew_name, transcript_json) values (?, 'g', 'subscription', ?, ?, ?, ?, ?, ?, ?)",
    id, `ask ${id}`, status, by, at, `ses_${id}`, name, JSON.stringify(events),
  );

test("a seat's last runs are the asker's own, by the name it wore, newest first, failures included", () => {
  put("r1", "ada", "Garnet", "done", 1);
  put("r2", "ada", "Garnet 2", "error", 3, [{ type: "tool", name: "app_tools", input: { panel: "p" } }, { type: "tool_result", name: "app_tools", ok: false, summary: "no MCP address" }, { type: "error", message: "gave up" }]);
  put("r3", "kai", "Garnet", "done", 4);
  put("r4", "ada", "Garnetta", "done", 5);
  put("r5", "ada", "Wren", "done", 6);
  const got = seatRuns("g", "ada", "Garnet");
  assert.deepEqual(got.map((r) => r.id), ["r2", "r1"]);
  assert.equal(got[0].status, "error");
  assert.equal(got[0].events.length, 3);
  assert.equal(got[0].session, "ses_r2");
  assert.deepEqual(seatRuns("g", "ada", "Garnet", 1).map((r) => r.id), ["r2"]);
  // a name with LIKE's wildcards matches only itself
  put("r6", "ada", "G_rnet x", "done", 7);
  assert.deepEqual(seatRuns("g", "ada", "G_rnet").map((r) => r.id), ["r6"]);
  assert.deepEqual(seatRuns("g", "ada", "  "), []);
});

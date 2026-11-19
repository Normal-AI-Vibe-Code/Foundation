/**
 * App-tool leave is keyed by board (apptools.ts, db.ts rekeyAppToolLeave): a database from before, where
 * a leave was keyed by app, tool and definition alone, is rebuilt keyed by board too, each row keeping the
 * board it was given on. A row with no board recorded applies to no board.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

test("an older database's leave keeps its board, and a leave on one board is not one on another", async () => {
  const { rekeyAppToolLeave } = await import("../src/db.ts");
  const old = new DatabaseSync(":memory:");
  old.exec(`create table app_tool_allowances (
    app_id text not null, tool text not null, def_hash text not null, allowed_by text not null,
    allowed_by_name text not null, board_id text, allowed_at integer not null, primary key (app_id, tool, def_hash))`);
  const put = old.prepare("insert into app_tool_allowances (app_id, tool, def_hash, allowed_by, allowed_by_name, board_id, allowed_at) values (?, ?, ?, ?, ?, ?, ?)");
  put.run("app_1", "make_part", "h1", "u_ada", "Ada", "scratch", 1);
  put.run("app_1", "export", "h2", "u_ada", "Ada", null, 2);
  rekeyAppToolLeave(old);
  const cols = old.prepare("pragma table_info(app_tool_allowances)").all() as Array<{ name: string; pk: number }>;
  assert.deepEqual(cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name), ["board_id", "app_id", "tool", "def_hash"]);
  const rows = old.prepare("select board_id, app_id, tool, def_hash, allowed_by from app_tool_allowances").all();
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ board_id: "scratch", app_id: "app_1", tool: "make_part", def_hash: "h1", allowed_by: "u_ada" }]);
  // run again: nothing changes
  rekeyAppToolLeave(old);
  assert.equal((old.prepare("select count(*) as n from app_tool_allowances").get() as { n: number }).n, 1);
  old.close();

  // in the live database: a leave on one board answers on that board only
  const { run } = await import("../src/db.ts");
  const { leaveFor } = await import("../src/apptools.ts");
  run("insert into app_tool_allowances (board_id, app_id, tool, def_hash, allowed_by, allowed_by_name, allowed_at) values (?, ?, ?, ?, ?, ?, ?)", "scratch", "app_1", "make_part", "h1", "u_ada", "Ada", 1);
  assert.equal(leaveFor("scratch", "app_1", "make_part", "h1"), "allowed");
  assert.equal(leaveFor("members-only", "app_1", "make_part", "h1"), "not yet allowed");
  assert.equal(leaveFor("scratch", "app_1", "make_part", "h2"), "changed since allowed");
});

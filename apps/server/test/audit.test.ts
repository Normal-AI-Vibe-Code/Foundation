/**
 * The audit log (audit.ts; SECURITY.md rule 8): one append-only table of who did what, for whom,
 * through which door, what was decided and who approved it.
 *
 * - A tool call's arguments are kept as a hash and a size only: a fake secret and a distinctive sentence
 *   in them appear nowhere in the table, whatever the door, the decision or the outcome.
 * - Each door is recorded as itself: a person at their browser (approved by themselves), an agent for
 *   its person, the service token; a viewer's refused write; an error.
 * - A person-gate refusal (an agent's bearer, the service token) is recorded with the route, and isPerson
 *   (which only asks) records nothing.
 * - The database refuses UPDATE and DELETE on the table (two triggers).
 * - The chain: verifyAudit walks it; a row changed through a raw connection, triggers dropped, is
 *   reported as the first broken link.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = mkdtempSync(join(tmpdir(), "foundation-audit-"));
process.env.FOUNDATION_DATA_DIR = dataDir;
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);

const { audit, canonical, ensureAuditSchema, readAudit, verifyAudit } = await import("../src/audit.ts");
const { runTool, httpToolCtx } = await import("../src/tools.ts");
const { upsertUser, createSession, requirePerson, isPerson } = await import("../src/auth.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { db } = await import("../src/db.ts");
const { closeBoards, getBoard } = await import("../src/boards.ts");
const { findSection } = await import("@foundation/protocol");

after(() => closeBoards());

const SECRET = "sk-ant-api03-ZZfakeKEYdoNOTuse0123456789abcdefXYZ";
const SENTENCE = "The heron counts nine lanterns over the quiet harbour";

const ada = upsertUser("ada@example.test", "Ada");
const boss = upsertUser("boss@example.test", "Boss");
db.prepare("update users set role = 'admin' where id = ?").run(boss.id);
const vic = upsertUser("vic@example.test", "Vic");
setBoardRole({ ...boss, role: "admin" }, "company", vic.id, "viewer");

const everything = () => JSON.stringify(db.prepare("select * from audit_log").all());
const last = () => readAudit({ limit: 500 }).at(-1)!;

test("arguments are kept as a hash and a size; a secret and a sentence in them are stored nowhere", async () => {
  const input = { section: "Harbour", title: `note ${SECRET}`, markdown: `${SENTENCE}. Key: ${SECRET}` };
  // a person at their browser, an agent for its person, the service token, a viewer (refused), and an error
  await runTool(httpToolCtx("company", ada, true), "add_note", input);
  await runTool({ boardId: "company", actor: "Ada's agent", userId: ada.id, door: "mcp" }, "add_note", input);
  await runTool({ boardId: "company", actor: "Agent (MCP)", userId: "agent", door: "mcp" }, "add_note", input);
  await assert.rejects(() => runTool({ boardId: "company", actor: "Vic's agent", userId: vic.id, door: "mcp" }, "add_note", input), /View only/);
  await assert.rejects(() => runTool({ boardId: "company", actor: "Ada's agent", userId: ada.id, door: "mcp" }, "update_card", { id: `nope_${SECRET}`, markdown: SENTENCE }), /no card/);
  await assert.rejects(() => runTool({ boardId: "company", actor: "Ada's agent", userId: ada.id, door: "mcp" }, "set_plan", { goal: SENTENCE, steps: "not a list" }), /invalid input/);

  const all = everything();
  assert.ok(!all.includes(SECRET), "the secret is nowhere in the table");
  assert.ok(!all.includes("sk-ant"), "nor any part of it");
  assert.ok(!all.includes("heron"), "the sentence is nowhere in the table");
  assert.ok(!all.includes("ada@example.test"), "no email");

  const rows = readAudit({ limit: 500 }).filter((r) => r.action === "add_note");
  assert.equal(rows.length, 4);
  const hash = createHash("sha256").update(canonical(input)).digest("hex");
  const section = findSection(getBoard("company").doc, "Harbour")!;
  for (const r of rows) {
    assert.equal(r.args_hash, hash, "the arguments' hash");
    assert.equal(r.args_bytes, Buffer.byteLength(canonical(input)));
    assert.equal(r.target, section.id, "the target is the section's id, not its name or anything typed");
  }
  const [person, agent, service, viewer] = rows;
  assert.deepEqual([person.actor_kind, person.door, person.decision, person.approved_by, person.result], ["person", "http", "allowed", ada.id, "ok"], "a person's own call approves itself");
  assert.deepEqual([agent.actor_kind, agent.for_person, agent.door, agent.decision, agent.approved_by, agent.result], ["agent", ada.id, "mcp", "allowed", null, "ok"]);
  assert.deepEqual([service.actor_kind, service.actor_id, service.for_person], ["service", "agent", null]);
  assert.deepEqual([viewer.decision, viewer.reason, viewer.result], ["refused", "view only", null]);
  const failed = readAudit({ limit: 500 }).find((r) => r.action === "update_card")!;
  assert.deepEqual([failed.decision, failed.result], ["allowed", "error"], "a call that ran and failed");
  assert.equal(failed.target, null, "an id that names nothing in Foundation isn't kept as the target");
  const invalid = readAudit({ limit: 500 }).find((r) => r.action === "set_plan")!;
  assert.deepEqual([invalid.decision, invalid.reason], ["refused", "invalid input"]);
});

test("a person-gate refusal is recorded with its route; isPerson only asks and records nothing", () => {
  const agentToken = createSession(ada.id, 3600_000, "agent");
  const req = (headers: Record<string, string>) => ({ headers, method: "POST", url: "/api/boards/company/machines/pnl_x/start", query: new URLSearchParams() }) as never;
  const before = readAudit({ limit: 500 }).length;
  assert.equal(isPerson(req({ authorization: `Bearer ${agentToken}` })), false);
  assert.equal(readAudit({ limit: 500 }).length, before, "isPerson records nothing");
  assert.throws(() => requirePerson(req({ authorization: `Bearer ${agentToken}` }), "Starting a machine"), /needs a person/);
  let r = last();
  assert.deepEqual([r.actor_kind, r.actor_id, r.for_person, r.door, r.action, r.board_id, r.decision], ["agent", `agent:${ada.id}`, ada.id, "route", "POST /api/boards/company/machines/pnl_x/start", "company", "refused"]);
  assert.match(r.reason!, /Starting a machine needs a person/);
  assert.throws(() => requirePerson(req({ authorization: `Bearer ${"s".repeat(40)}` }), "Starting a machine"), /needs a person/);
  r = last();
  assert.deepEqual([r.actor_kind, r.actor_id, r.decision], ["service", "agent", "refused"]);
  // a role change by someone who isn't an admin is refused, and recorded
  assert.throws(() => setBoardRole(ada, "company", vic.id, "member"), /Only an admin/);
  r = last();
  assert.deepEqual([r.action, r.decision, r.actor_id], ["board_role.set", "refused", ada.id]);
});

test("the database refuses to change or remove a row", () => {
  assert.ok(readAudit().length > 0);
  assert.throws(() => db.exec("update audit_log set target = 'changed' where id = 1"), /append-only/);
  assert.throws(() => db.exec("delete from audit_log where id = 1"), /append-only/);
  assert.throws(() => db.exec("delete from audit_log"), /append-only/);
  assert.equal(readAudit({ limit: 1 })[0].target === "changed", false);
});

test("the chain holds, and a row changed behind the triggers' back is the first broken link", () => {
  audit({ actor_kind: "person", actor_id: ada.id, door: "route", action: "test.mark", decision: "allowed" });
  const ok = verifyAudit();
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const rows = readAudit({ limit: 500 });
  assert.ok(rows.length >= 4);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash, "each row carries the hash of the one before");

  // someone with the file: drop the triggers and edit the third row
  const raw = new DatabaseSync(join(dataDir, "foundation.db"));
  raw.exec("drop trigger audit_log_no_update; drop trigger audit_log_no_delete;");
  assert.equal(raw.prepare("update audit_log set actor_name = 'someone else' where id = 3").run().changes, 1);
  raw.close();
  const broken = verifyAudit();
  assert.equal(broken.ok, false);
  assert.equal((broken as { brokenAt: number }).brokenAt, 3);
  assert.match((broken as { reason: string }).reason, /hash/);

  // a row taken out is found too (the ids skip)
  const raw2 = new DatabaseSync(join(dataDir, "foundation.db"));
  raw2.prepare("delete from audit_log where id = 2").run();
  raw2.close();
  const gap = verifyAudit();
  assert.equal(gap.ok, false);
  assert.equal((gap as { brokenAt: number }).brokenAt, 3, "the row after the gap is the first that doesn't hold");

  // the triggers come back with the schema
  ensureAuditSchema();
  assert.throws(() => db.exec("delete from audit_log where id = 1"), /append-only/);
});

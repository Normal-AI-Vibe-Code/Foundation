/**
 * Today: a person's goals are theirs alone; what wants them comes from what
 * Foundation knows (asks, @mentions, stages they own, their job); a viewer
 * keeps their own goals but still can't touch a board. The company's goals are
 * everyone's to read and the company board's writers' to set.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";

const { run, indexDoc } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { runTool } = await import("../src/tools.ts");
const { editBoard, closeBoards, ensureBoardRow } = await import("../src/boards.ts");
const { focusFor, listGoals, mentions, saveGoal, setProfile, todayDigest, todayFor, companyApps, saveCompanyGoal, listCompanyGoals } = await import("../src/today.ts");
const { boardMaps } = await import("@foundation/protocol");
const { getBoard } = await import("../src/boards.ts");
const { appendSection, putNote, uid, logActivity } = await import("@foundation/protocol");

after(() => closeBoards());

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = upsertUser("kai@formindustries.com", "Kai");
const vic = upsertUser("vic@formindustries.com", "Vic");
run("update users set role = 'viewer' where id = ?", vic.id);

test("mentions: @first, @full local part, word-bounded", () => {
  assert.ok(mentions(ada, "Can @Ada check the rim drive?"));
  assert.ok(mentions(ada, "cc @ada."));
  assert.ok(mentions(ada, "@ada@formindustries.com please"));
  assert.ok(!mentions(ada, "@adam owns this"));
  assert.ok(!mentions(ada, "Ada without an at sign"));
});

test("goals: add, progress to done, and only the owner may change them", () => {
  const g = saveGoal(ada.id, { title: "Certify the rim drive", detail: "Part 33 test plan" });
  assert.equal(g.status, "active");
  assert.equal(listGoals(ada.id).length, 1);
  assert.equal(listGoals(kai.id).length, 0);
  assert.throws(() => saveGoal(kai.id, { id: g.id, progress: 1 }), /no such goal of yours/);
  const done = saveGoal(ada.id, { id: g.id, progress: 1 });
  assert.equal(done.status, "done");
  assert.equal(done.progress, 1);
  assert.throws(() => saveGoal(ada.id, { title: "  " }), /needs a title/);
});

test("focus: asks to them, notes that tag them, stages they own, work matching their job", () => {
  ensureBoardRow("motors", "Motors");
  let noteId = "";
  let stageId = "";
  editBoard("motors", "test", (doc) => {
    const sec = appendSection(doc, "Rim drive");
    noteId = uid("note");
    putNote(doc, { id: noteId, kind: "note", sectionId: sec.id, x: 0, y: 0, w: 300, h: 200, float: false, bornAt: Date.now(), text: "Bearing loads\n@Ada can you sign off the bearing loads?" } as never);
    stageId = uid("pnl");
    doc.getMap("objects").set(stageId, { id: stageId, kind: "panel", panel: "stage", stage: "cad", name: "CAD", sectionId: sec.id, x: 0, y: 0, w: 460, h: 440, float: false, bornAt: Date.now(), ports: [], status: "open", assignee: "Ada", checklist: [{ text: "STEP attached", done: false }] });
    logActivity(doc, { who: "Ada Lovelace", role: "human", text: "moved a card" });
    logActivity(doc, { who: "Kai", role: "human", text: "added the stator note" });
  });
  run(
    "insert into asks (id, board_id, panel_id, assignee, kind, prompt, status, created_by, created_at, due_at) values ('ask_1', 'motors', null, 'ada@formindustries.com', 'cad_upload', 'Upload the latest stator STEP', 'open', 'Kai', ?, ?)",
    Date.now() - 3 * 864e5, Date.now() - 864e5,
  );
  run(
    "insert into asks (id, board_id, panel_id, assignee, kind, prompt, status, created_by, created_at) values ('ask_2', 'motors', null, 'Kai', 'cad_upload', 'Not for Ada', 'open', 'Ada', ?)",
    Date.now(),
  );
  indexDoc("board", "card_x", "motors", "Winding thermal model", "copper fill and thermal limits for the winding");
  setProfile(ada.id, { title: "Motor lead", focus: "winding, thermal" });

  const focus = focusFor(ada);
  const kinds = focus.map((f) => f.kind);
  assert.equal(focus[0].id, "ask:ask_1", "the overdue ask comes first");
  assert.equal(focus[0].tone, "bad");
  assert.ok(!focus.some((f) => f.title === "Not for Ada"));
  assert.ok(focus.some((f) => f.kind === "mention" && f.objectId === noteId && f.title.includes("sign off")));
  assert.ok(focus.some((f) => f.kind === "stage" && f.objectId === stageId));
  assert.ok(focus.some((f) => f.kind === "changes" && f.why.includes("Kai")), "others' changes on a board Ada works on");
  assert.ok(focus.some((f) => f.kind === "related" && f.title === "Winding thermal model"));
  assert.ok(kinds.indexOf("stage") < kinds.indexOf("mention"));
  assert.ok(focus.every((f) => f.href.includes("board=motors")));

  // Kai isn't tagged and owns nothing here
  assert.ok(!focusFor(kai).some((f) => f.kind === "mention" || f.kind === "stage"));
});

test("the page and the Shiba read the same Today", () => {
  const t = todayFor(ada);
  assert.equal(t.person.first, "Ada");
  assert.equal(t.profile.title, "Motor lead");
  assert.equal(t.sources.dataroom.connected, false);
  const names = companyApps().map((a) => a.name);
  for (const n of ["PartForm", "DeployForm", "FactoryForm", "HyperForm", "Vision"]) assert.ok(names.includes(n), n);
  const d = todayDigest(t);
  assert.match(d, /ask:ask_1/);
  assert.match(d, /Motor lead/);
});

test("a viewer keeps their own goals through the tools, and still can't write a board", async () => {
  const ctx = { boardId: "motors", actor: "Foundation Agent", userId: vic.id };
  const { goal } = (await runTool(ctx, "set_goal", { title: "Learn the fleet" })) as { goal: { id: string; title: string } };
  assert.equal(goal.title, "Learn the fleet");
  const t = (await runTool(ctx, "today", {})) as { goals: Array<{ id: string }> };
  assert.deepEqual(t.goals.map((g) => g.id), [goal.id]);
  assert.deepEqual(await runTool(ctx, "point_today", { ids: [goal.id] }), { pointed: [goal.id] });
  await assert.rejects(runTool(ctx, "add_note", { section: "Rim drive", title: "hi", markdown: "hi" }), /View only/);
  // and the agent can't reach someone else's goal
  await assert.rejects(runTool({ ...ctx, userId: kai.id }, "set_goal", { id: goal.id, status: "done" }), /no such goal of yours/);
});

test("company goals: everyone reads them, the company board's writers set them, and the owner has it in focus", async () => {
  const g = saveCompanyGoal(kai, { title: "Fly the PTHP demonstrator", detail: "First hover by Q1", owner: "Ada", dueAt: Date.now() + 30 * 864e5 });
  assert.match(g.id, /^cgoal_/);
  assert.equal(g.board, "company");
  // the same for everyone, viewers included; only writers may set them
  for (const who of [ada, kai, vic]) assert.deepEqual(todayFor(who).company.goals.map((x) => x.id), [g.id]);
  assert.equal(todayFor(kai).company.canSet, true);
  assert.equal(todayFor(vic).company.canSet, false);
  assert.throws(() => saveCompanyGoal(vic, { title: "Not mine to set" }), /View only/);
  assert.throws(() => saveCompanyGoal(vic, { id: g.id, progress: 1 }), /View only/);
  // the board it belongs to says so
  assert.ok(boardMaps(getBoard("company").doc).activity.toArray().some((e) => e.who === "Kai" && e.text.includes("Fly the PTHP demonstrator")));
  // whoever carries it sees it in focus, right after their asks; others don't
  const focus = focusFor(ada);
  const at = focus.findIndex((f) => f.id === `goal:${g.id}`);
  assert.ok(at >= 0 && focus[at].kind === "goal" && focus[at].why.includes("company goal you carry"));
  assert.ok(focus.slice(0, at).every((f) => f.kind === "ask"));
  assert.ok(!focusFor(kai).some((f) => f.kind === "goal"));
  assert.match(todayDigest(todayFor(vic)), /Company goals \(1; this person can read them, not change them\)/);
  // the Shiba sets them through the tool for a writer, and is refused for a viewer
  const ctx = { boardId: "company", actor: "Foundation Agent", userId: kai.id };
  const { goal } = (await runTool(ctx, "set_company_goal", { id: g.id, progress: 0.4, request_id: "r1" })) as { goal: { progress: number } };
  assert.equal(goal.progress, 0.4);
  await assert.rejects(runTool({ ...ctx, userId: vic.id }, "set_company_goal", { title: "Nope" }), /View only/);
  // and from another board the Shiba is on, it's still the company board that decides
  run("insert into board_roles (board_id, user_id, role, set_by, set_at) values ('company', ?, 'viewer', ?, ?)", kai.id, ada.id, Date.now());
  await assert.rejects(runTool({ ...ctx, boardId: "motors" }, "set_company_goal", { title: "Nope" }), /View only/);
  run("delete from board_roles where board_id = 'company' and user_id = ?", kai.id);
  // done: it stays in sight a while, out of the owner's focus
  saveCompanyGoal(kai, { id: g.id, status: "done" });
  assert.equal(listCompanyGoals()[0].status, "done");
  assert.equal(listCompanyGoals()[0].progress, 1);
  assert.ok(!focusFor(ada).some((f) => f.kind === "goal"));
});

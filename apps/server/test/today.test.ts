/**
 * Today: a person's goals are theirs alone; what wants them comes from what
 * Foundation knows (asks, @mentions, stages they own, their job); a viewer
 * keeps their own goals but still can't touch a board.
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
const { focusFor, listGoals, mentions, saveGoal, setProfile, todayDigest, todayFor, companyApps } = await import("../src/today.ts");
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
  for (const n of ["BomForm", "FactoryForm", "HyperForm", "Vision"]) assert.ok(names.includes(n), n);
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

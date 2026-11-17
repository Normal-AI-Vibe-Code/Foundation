/**
 * The plan board: everyone signed in reads it; only an admin, as a person,
 * moves a card; a move writes the file and marks the card until it's pushed,
 * and moving it back clears the mark.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "foundation-plan-"));
process.env.FOUNDATION_DATA_DIR = dir;
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_PLAN_FILE = join(dir, "plan.json");
copyFileSync(new URL("../../../docs/plan.json", import.meta.url), process.env.FOUNDATION_PLAN_FILE);

const { upsertUser } = await import("../src/auth.ts");
const { cardId, createPlanCard, movePlanCard, readPlan, syncPlan } = await import("../src/plan.ts");

const boss = upsertUser("boss@formindustries.com", "Boss");
const ada = upsertUser("ada@formindustries.com", "Ada");

test("the plan reads from the file", () => {
  const plan = readPlan()!;
  assert.ok(plan.cards.length > 10);
  assert.ok(plan.columns.some((c) => c.id === "next"));
});

// any card not in Next/Doing/Review: it's moved into Next first, so the test doesn't hang on the board's own state
const pick = () => readPlan()!.cards.find((c) => c.status === "backlog")!;

test("only an admin moves a card; a column must exist", () => {
  const card = pick();
  assert.throws(() => movePlanCard(ada, card.id, "doing"), /Only an admin/);
  assert.throws(() => movePlanCard(boss, card.id, "someday"), /No column/);
  assert.throws(() => movePlanCard(boss, "no-such-card", "doing"), /No card/);
});

test("a move writes the file and marks the card; moving back clears the mark", () => {
  const card = pick();
  const moved = movePlanCard(boss, card.id, "doing");
  assert.equal(moved.status, "doing");
  assert.equal(moved.moved?.from, "backlog");
  assert.equal(moved.moved?.by, "Boss");
  const onDisk = JSON.parse(readFileSync(process.env.FOUNDATION_PLAN_FILE!, "utf8"));
  assert.equal(onDisk.cards.find((c: { id: string }) => c.id === card.id).status, "doing");
  movePlanCard(boss, card.id, "review");
  assert.equal(readPlan()!.cards.find((c) => c.id === card.id)!.moved?.from, "backlog");
  const back = movePlanCard(boss, card.id, "backlog");
  assert.equal(back.moved, undefined);
});

test("a card id is the title's words, made unique", () => {
  assert.equal(cardId("Wires collide at the far end!", new Set()), "wires-collide-at-the-far-end");
  assert.equal(cardId("Wires collide at the far end", new Set(["wires-collide-at-the-far-end"])), "wires-collide-at-the-far-end-2");
  assert.equal(cardId("¿¿", new Set()), "card");
});

test("only an admin makes a card; a doubled press makes one; a hookup waits on a person", () => {
  assert.throws(() => createPlanCard(ada, { title: "Ada's idea for the board" }), /Only an admin/);
  assert.throws(() => createPlanCard(boss, { title: "no" }), /needs a title/);
  assert.throws(() => createPlanCard(boss, { title: "A thing with a bad kind", kind: "wish" }), /kind is bug/);
  assert.throws(() => createPlanCard(boss, { title: "A thing in no milestone", milestone: "someday" }), /No milestone/);
  const before = readPlan()!.cards.length;
  const bug = createPlanCard(boss, { title: "Wire landings blink on undo", kind: "bug", area: "Wires", request_id: "r-1" });
  const again = createPlanCard(boss, { title: "Wire landings blink on undo", kind: "bug", area: "Wires", request_id: "r-1" });
  assert.equal(again.id, bug.id);
  assert.equal(readPlan()!.cards.length, before + 1);
  assert.equal(bug.status, "backlog");
  assert.equal(bug.area, "wires");
  assert.equal(bug.issue, null);
  assert.match(bug.body, /Added by Boss/);
  const key = createPlanCard(boss, { title: "Set the Figma token", kind: "hookup" });
  assert.equal(key.status, "needs-you");
});

test("sync reads GitHub first, then sends only moved columns and new cards", async () => {
  // GitHub, as the stand-in holds it: every card that has an issue, one renamed there and one closed there
  const plan = readPlan()!;
  const withIssue = plan.cards.filter((c) => c.issue);
  const [renamed, closed, moving] = withIssue.filter((c) => c.status !== "done");
  const issues = withIssue.map((c) => ({
    number: c.issue,
    state: c.id === closed.id ? "closed" : c.status === "done" ? "closed" : "open",
    title: c.id === renamed.id ? "Renamed on GitHub" : c.title,
    body: `${c.body}\n\n**Milestone:** x · **Area:** ${c.area}\n\n<!-- plan:${c.id} -->\n`,
    labels: [{ name: "plan" }, { name: `kind: ${c.kind}` }, { name: `status: ${c.status}` }],
    milestone: null,
  }));
  const stateFile = join(dir, "gh.json");
  writeFileSync(stateFile, JSON.stringify({ issues, labels: [], milestones: [] }));
  process.env.FAKE_GH_STATE = stateFile;
  process.env.FOUNDATION_GH = fileURLToPath(new URL("./fixtures/fake-gh.mjs", import.meta.url));

  movePlanCard(boss, moving.id, "doing");
  const fresh = readPlan()!.cards.filter((c) => !c.issue);
  assert.ok(fresh.length >= 2, "the cards made above have no issue yet");

  await assert.rejects(() => syncPlan(ada), /Only an admin/);
  const { plan: after, summary } = await syncPlan(boss);
  assert.equal(summary.moved, 1);
  assert.equal(summary.created, fresh.length);

  const gh = JSON.parse(readFileSync(stateFile, "utf8"));
  const patch = gh.calls.find((c: { method: string; number: number }) => c.method === "PATCH" && c.number === moving.issue);
  assert.deepEqual(Object.keys(patch.body).sort(), ["labels", "state"], "a moved card sends its column, never its title or body");
  assert.ok(patch.body.labels.includes("status: doing"));
  assert.equal(gh.calls.filter((c: { method: string }) => c.method === "POST").length, fresh.length);

  const card = (id: string) => after.cards.find((c) => c.id === id)!;
  assert.equal(card(renamed.id).title, "Renamed on GitHub", "GitHub's words win");
  assert.equal(card(closed.id).status, "done", "an issue closed on GitHub (Fixes #N) is Done");
  assert.equal(card(moving.id).status, "doing");
  assert.equal(card(moving.id).moved, undefined, "synced: no longer marked");
  for (const f of fresh) assert.ok(Number.isInteger(card(f.id).issue), `${f.id} got an issue`);
  assert.ok(after.syncedAt);
});

test("sync says plainly when gh isn't there", async () => {
  process.env.FOUNDATION_GH = join(dir, "no-such-gh.exe");
  await assert.rejects(() => syncPlan(boss), /GitHub isn't reachable from this server|GitHub sync failed/);
});

test("a card made here whose issue already exists is linked, not made twice", async () => {
  process.env.FOUNDATION_GH = fileURLToPath(new URL("./fixtures/fake-gh.mjs", import.meta.url));
  const card = createPlanCard(boss, { title: "Landings shimmer after a split", kind: "bug" });
  const stateFile = process.env.FAKE_GH_STATE!;
  const gh = JSON.parse(readFileSync(stateFile, "utf8"));
  // the same card already reached GitHub (another server, or a sync cut short)
  const number = Math.max(...gh.issues.map((i: { number: number }) => i.number)) + 1;
  gh.issues.push({ number, state: "open", title: card.title, body: `x\n\n<!-- plan:${card.id} -->\n`, labels: [{ name: "plan" }, { name: "status: backlog" }], milestone: null });
  gh.calls = [];
  writeFileSync(stateFile, JSON.stringify(gh));
  const { plan, summary } = await syncPlan(boss);
  assert.equal(summary.created, 0, "no second issue");
  assert.equal(plan.cards.filter((c) => c.id === card.id).length, 1);
  assert.equal(plan.cards.find((c) => c.id === card.id)!.issue, number);
});

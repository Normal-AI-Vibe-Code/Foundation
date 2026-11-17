/**
 * Design pipelines: a STEP is measured on arrival; stages open in order and
 * hand their output down the wire; "request changes" at review reopens CAD
 * and Simulate.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "foundation-pipe-"));
process.env.FOUNDATION_DATA_DIR = dir;

const { stepSummary } = await import("../src/cad.ts");
const { run } = await import("../src/db.ts");
const { closeBoards, getBoard } = await import("../src/boards.ts");
const { startPipeline, attachToStage, completeStage, pipelineStages, describePipeline } = await import("../src/pipeline.ts");

after(() => closeBoards());

const step = readFileSync(new URL("./fixtures/shroud.step", import.meta.url), "utf8");

test("a STEP file reports its unit, size and products", () => {
  const s = stepSummary(step);
  assert.equal(s.unit, "mm");
  assert.deepEqual(s.bbox?.size, [212, 212, 64]);
  assert.equal(s.faces, 2);
  assert.ok(s.products.includes("FAN-SHROUD-A7"));
  assert.match(s.note, /212 × 212 × 64 mm/);
});

test("stages open in order, measure CAD, and hand off down the wire", async () => {
  const board = "pipe-test";
  const r = startPipeline(board, "Josh", { name: "Fan v3", goal: "A quieter rim-drive fan", cadOwner: "noa@formindustries.com", reviewers: ["josh"] });
  const doc = getBoard(board).doc;
  let stages = pipelineStages(doc, r.pipeline);
  assert.deepEqual(stages.map((s) => s.status), ["open", "idle", "idle", "idle", "idle", "idle"]);

  completeStage(board, stages[0].id, "Josh"); // brief
  completeStage(board, pipelineStages(doc, r.pipeline)[1].id, "Josh"); // concept
  stages = pipelineStages(doc, r.pipeline);
  assert.equal(stages[2].status, "open", "CAD opens after concept");

  // register the STEP as an uploaded file, then attach it to the CAD stage
  const sha = createHash("sha256").update(step).digest("hex");
  mkdirSync(join(dir, "files"), { recursive: true });
  writeFileSync(join(dir, "files", sha), step);
  run("insert into files (id, board_id, name, mime, size, sha256, created_at) values ('f_step', ?, 'shroud.step', 'model/step', ?, ?, ?)", board, step.length, sha, Date.now());
  const art = await attachToStage(board, stages[2].id, { fileId: "f_step" }, "Noa");
  assert.equal(art.kind, "cad");
  assert.match(art.note ?? "", /212 × 212 × 64 mm/);
  const cad = pipelineStages(doc, r.pipeline)[2];
  assert.ok(cad.checklist?.find((c) => /STEP uploaded/.test(c.text))?.done, "checklist ticks itself");

  completeStage(board, cad.id, "Noa");
  stages = pipelineStages(doc, r.pipeline);
  const outPort = stages[2].ports.find((p) => p.dir === "out")!;
  assert.equal((stages[2].outputs?.[outPort.id] as { fileId?: string })?.fileId, "f_step", "CAD goes out on the wire");
  assert.equal(stages[3].status, "open", "Simulate opens");

  completeStage(board, stages[3].id, "Josh"); // simulate
  const review = pipelineStages(doc, r.pipeline)[4];
  const back = completeStage(board, review.id, "Josh", "changes");
  assert.equal(back.sentBack, true);
  stages = pipelineStages(doc, r.pipeline);
  assert.equal(stages[2].status, "open", "changes reopen CAD");
  assert.equal(stages[3].status, "open", "changes reopen Simulate");
  assert.notEqual(stages[4].status, "done");

  assert.match(describePipeline(board, "Fan v3"), /03 · CAD \[open\].*212 × 212 × 64 mm/s, "found by product name (CAD reopened by the changes)");
  assert.match(describePipeline(board, "Design · Fan v3"), /01 · Brief/, "found by section name");

  completeStage(board, stages[4].id, "Josh", "approved");
  assert.equal(pipelineStages(doc, r.pipeline)[5].status, "open", "approval opens Release");
});

test("the first column keeps room on its left for the wire that turns back into it", async () => {
  const { LEFT_ROOM } = await import("../src/pipeline.ts");
  const r = startPipeline("pipe-room", "Josh", { name: "Room", goal: "Room to turn" });
  const stages = pipelineStages(getBoard("pipe-room").doc, r.pipeline);
  const xs = stages.map((s) => s.x);
  assert.equal(Math.min(...xs), LEFT_ROOM);
  assert.ok(LEFT_ROOM >= 28, "with the section's own 28 px pad, about 42 px to turn in");
  // Simulate (the first of the second row) sits under Brief, both in the roomy first column
  assert.equal(stages[3].x, stages[0].x);
});

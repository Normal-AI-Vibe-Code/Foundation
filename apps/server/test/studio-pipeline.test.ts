/**
 * The Character studio's pipeline row and a person's word on a character (2026-11-16).
 *
 *  - A new studio has three rows: Inspiration, Pipeline (a flow card per set), Characters.
 *  - A studio from before gets the row put in between, once; what was there keeps its place below.
 *  - A character a person makes is pending: it can be archived at any time, approved only once it's
 *    finished, and only approved (or older, unmarked) finished characters are offered as avatars.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_STARTER_DIR = "";

const { closeBoards, editBoard, getBoard, createBoardRow } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { run } = await import("../src/db.ts");
const { openStudio, upgradeStudio, createCharacter, setApproval, roster } = await import("../src/characters.ts");
const { boardMaps, characterChoosable, uid, DEFAULT_COL_W, DEFAULT_ROW_H } = await import("@foundation/protocol");

after(() => closeBoards());
const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const top = (id: string) => [...boardMaps(getBoard(id).doc).sections.values()].filter((s) => !s.parent);

test("a new studio: inspiration, the pipeline with a flow card per set, characters", () => {
  const { id, made } = openStudio(ada);
  assert.equal(made, true);
  const m = boardMaps(getBoard(id).doc);
  assert.equal(m.grid.get("tracks")!.rows.length, 3);
  for (const set of ["Anime", "Animals", "Abstract"]) {
    const row = (name: string) => top(id).find((s) => s.name === `${name} · ${set}`)!.r0;
    assert.deepEqual([row("Inspiration"), row("Pipeline"), row("Characters")], [0, 1, 2]);
    const pipe = top(id).find((s) => s.name === `Pipeline · ${set}`)!;
    const card = [...m.objects.values()].find((o) => o.sectionId === pipe.id && o.kind === "panel" && o.panel === "pipeline");
    assert.ok(card && card.kind === "panel");
    assert.equal(card.source, set.toLowerCase());
  }
  // opening it again changes nothing
  const before = top(id).length;
  assert.equal(openStudio(ada).made, false);
  assert.equal(top(id).length, before);
});

test("a studio from before the pipeline gets the row between, once; characters keep their place below", () => {
  const id = createBoardRow("Old studio");
  let chars = "";
  editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    m.grid.set("tracks", { cols: [DEFAULT_COL_W, DEFAULT_COL_W], rows: [DEFAULT_ROW_H, DEFAULT_ROW_H] });
    ["Anime", "Animals"].forEach((set, c) => {
      m.sections.set(`i${c}`, { id: `i${c}`, name: `Inspiration · ${set}`, c0: c, r0: 0, c1: c, r1: 0 });
      m.sections.set(`c${c}`, { id: `c${c}`, name: `Characters · ${set}`, c0: c, r0: 1, c1: c, r1: 1 });
    });
    chars = uid("pnl");
    m.objects.set(chars, { id: chars, kind: "panel", panel: "character", sectionId: "c1", name: "Mochi", x: 0, y: 0, float: false, bornAt: 1, w: 460, h: 620, ports: [] });
  });
  upgradeStudio(id);
  const m = boardMaps(getBoard(id).doc);
  assert.equal(m.grid.get("tracks")!.rows.length, 3);
  assert.deepEqual([m.sections.get("i1")!.r0, m.sections.get("c1")!.r0, m.sections.get("c1")!.r1], [0, 2, 2]);
  const pipe = top(id).filter((s) => s.name.startsWith("Pipeline · "));
  assert.deepEqual(pipe.map((s) => [s.name, s.c0, s.r0]).sort(), [["Pipeline · Animals", 1, 1], ["Pipeline · Anime", 0, 1]]);
  assert.equal(m.objects.get(chars)!.sectionId, "c1", "the card is where it was");
  upgradeStudio(id);
  assert.equal(top(id).filter((s) => s.name.startsWith("Pipeline · ")).length, 2, "once");
});

test("a character a person makes waits for approval: archived any time, approved only when finished, offered only when approved", () => {
  const { id } = openStudio(ada);
  const made = createCharacter(id, { name: ada.name, id: ada.id, human: true }, { name: "Pip", set: "abstract", form: "mesh", identity: "a dot" });
  assert.equal(made.approval, "pending");
  assert.equal(characterChoosable(made), false);
  assert.throws(() => setApproval(id, made.panelId, "approved", ada), /isn't finished yet/);
  assert.equal(setApproval(id, made.panelId, "archived", ada).approval, "archived");
  assert.equal(setApproval(id, made.panelId, "pending", ada).approval, "pending");

  // finished (its mesh avatar is in): now it can be approved, and only then is it one to choose
  const c = { ...made, files: { front: "f_1", portrait: "f_2", mavatar: "f_3" }, ready: true };
  run("update characters set state = ? where id = ?", JSON.stringify(c), made.id);
  assert.equal(characterChoosable(roster().characters.find((x) => x.id === made.id)!), false, "finished but pending");
  assert.equal(setApproval(id, made.panelId, "approved", ada).approval, "approved");
  assert.equal(characterChoosable(roster().characters.find((x) => x.id === made.id)!), true);
  assert.equal(boardMaps(getBoard(id).doc).characters.get(made.panelId)!.approval, "approved", "everyone on the grid sees it");
  setApproval(id, made.panelId, "archived", ada);
  assert.equal(characterChoosable(roster().characters.find((x) => x.id === made.id)!), false);
  assert.ok(roster().characters.some((x) => x.id === made.id), "archived is kept, not gone");

  // a character from before approvals (and the starter set) reads as approved
  assert.equal(characterChoosable({ ready: true }), true);
  assert.equal(characterChoosable({ ready: false }), false);
});

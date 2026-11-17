/**
 * Sections host apps (schema 2): the company board's connectors each get a
 * section of their own, laid out where their cards were; other sections
 * shift to make room and never overlap; wires keep their ends; and an app
 * opened into an empty section is hosted by it.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

// the person the tools act for: a member (an unknown id would be a viewer, and viewers can't write)
const { run: runSql } = await import("../src/db.ts");
runSql("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, 'member', ?)", "u", "u@formindustries.com", "Tester", "#325bb4", Date.now());
const { seedCompanyBoard } = await import("../src/seed.ts");
const { migrateBoard } = await import("../src/migrate.ts");
const { runTool } = await import("../src/tools.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { boardMaps, appendSection, BOARD_SCHEMA } = await import("@foundation/protocol");

after(() => closeBoards());

function cellsOf(s: { c0: number; c1: number; r0: number; r1: number }) {
  const out: string[] = [];
  for (let c = s.c0; c <= s.c1; c++) for (let r = s.r0; r <= s.r1; r++) out.push(`${c},${r}`);
  return out;
}

test("the company board migrates to one section per app, nothing overlapping", () => {
  seedCompanyBoard();
  const m = boardMaps(getBoard("company").doc);
  // a schema-1 board where "Apps" already holds one app card (processed after the split — the stale-read case)
  const apps = [...m.sections.values()].find((s) => s.name === "Apps")!;
  getBoard("company").doc.transact(() =>
    m.objects.set("pnl_app", { id: "pnl_app", kind: "panel", panel: "app", sectionId: apps.id, name: "Economics", x: 0, y: 0, float: false, bornAt: 1, w: 720, h: 520, url: "https://example.com", ports: [] }),
  );
  const linksBefore = JSON.stringify([...m.links.values()].map((l) => [l.from.panel, l.to.panel]).sort());
  assert.equal(migrateBoard("company"), true);
  assert.equal(m.meta.get("schema"), BOARD_SCHEMA);

  const sections = [...m.sections.values()];
  const connectors = [...m.objects.values()].filter((o) => o.kind === "panel" && o.panel === "connector");
  assert.equal(connectors.length, 6);
  for (const c of connectors) {
    const home = m.sections.get(c.sectionId)!;
    assert.equal(home.host, c.id, `${c.name} fills its own section`);
    assert.equal(home.name, c.name);
  }
  // every cell belongs to at most one section, and every section is inside the grid
  const tracks = m.grid.get("tracks")!;
  const seen = new Map<string, string>();
  for (const s of sections) {
    assert.ok(s.c1 < tracks.cols.length && s.r1 < tracks.rows.length, `${s.name} inside the grid`);
    for (const k of cellsOf(s)) {
      assert.ok(!seen.has(k), `${s.name} overlaps ${seen.get(k)} at ${k}`);
      seen.set(k, s.name);
    }
  }
  // the designed layout survives: design flows left to right along the top
  const at = (name: string) => sections.find((s) => s.name === name)!;
  assert.ok(at("Creation").c0 < at("Vision").c0 && at("Vision").c0 < at("BomForm").c0 && at("BomForm").c0 < at("Airform Data Room").c0);
  assert.ok(at("Foundation").r0 > at("Creation").r0, "Foundation sits under the design row");
  assert.equal(at("Apps").host, "pnl_app", "a section holding one app hosts it");
  assert.ok(at("Apps").r0 > at("Foundation").r0, "Apps moved down with the rows it was in");
  // the other sections moved out of the way, still whole
  assert.equal(sections.filter((s) => s.name === "Asks & agents" || s.name === "Apps" || s.name === "Design").length, 3);
  // wires are untouched — they now run section to section
  assert.equal(JSON.stringify([...m.links.values()].map((l) => [l.from.panel, l.to.panel]).sort()), linksBefore);
  // and it runs once
  assert.equal(migrateBoard("company"), false);
});

test("an app opened into an empty section becomes the section's app", async () => {
  const board = getBoard("host-board");
  board.doc.transact(() => appendSection(board.doc, "Tools"));
  const ctx = { boardId: "host-board", actor: "test", userId: "u" };
  const a = (await runTool(ctx, "add_panel", { panel: "app", name: "Quoter", url: "http://localhost:9999", section: "Tools" })) as { id: string };
  const m = boardMaps(board.doc);
  const sec = [...m.sections.values()].find((s) => s.name === "Tools")!;
  assert.equal(sec.host, a.id);
  // a second app isn't a second host, and the first stops filling the section:
  // a hosted app covers the section's body, so a card beside it would be hidden.
  // Both are cards in the flow, as "Show as a card" leaves them.
  const b = (await runTool(ctx, "add_panel", { panel: "app", name: "Other", url: "http://localhost:9998", section: "Tools" })) as { id: string };
  assert.equal(m.sections.get(sec.id)!.host, undefined);
  assert.equal(m.objects.get(a.id)?.sectionId, sec.id);
  assert.equal(m.objects.get(b.id)?.sectionId, sec.id);
});

/**
 * A section becomes a grid of its own (2026-11-17), and a grid that moves leaves a link behind.
 *
 *  - extract: a new grid inside this one, named after the section; the section keeps its place and
 *    now holds the card that stands for the grid; cards go with their note text, table cells, files
 *    and the wires among them; a wire across the section's edge is let go and the log says so; a
 *    character is still a character there; a section's council goes with it.
 *  - a machine, a huddle and a pipeline stage stay in the section; a Slack section is refused.
 *  - twice is once (the same request_id, and a section that already stands for a grid).
 *  - a viewer can't; a members-only grid's sub-grid is members-only too.
 *  - a section that is already a grid of sections becomes a grid with those sections.
 *  - a grid that leaves its parent (to the top, or into another) leaves its card there; the card
 *    wears the grid's name after a rename; the outline says where the grid is now.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-subgrids-"));
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_STARTER_DIR = "";
process.env.MESHY_API_KEY = "";

const { createBoardRow, listBoards, setBoardParent, updateBoardRow, getBoard, closeBoards, editBoard, leftoverLinks } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { one, run, all } = await import("../src/db.ts");
const { runTool } = await import("../src/tools.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { setMember, canSeeBoard } = await import("../src/members.ts");
const { storeFile } = await import("../src/files.ts");
const { createCharacter, roster } = await import("../src/characters.ts");
const { gridOutline, extractSection } = await import("../src/subgrids.ts");
const { _resetCrew } = await import("../src/crew.ts");
const { createAsk, resolveAsk } = await import("../src/hermes.ts");
const { GRID_PLACE, appendSection, boardMaps, noteTextOf, postedAgentsOf, putNote, tableCellMap, tableCellsOf, setTableCells } = await import("@foundation/protocol");
import type { ExtractResult } from "../src/subgrids.ts";
import type { ObjectDoc, PanelDoc, SectionDoc } from "@foundation/protocol";

after(() => {
  _resetCrew();
  closeBoards();
});

const boss = upsertUser("boss@formindustries.com", "Boss");
const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const ben = upsertUser("ben@formindustries.com", "Ben");
const ctx = (boardId: string, who = ada) => ({ boardId, actor: who.name, userId: who.id, person: true });
const row = (id: string) => listBoards().find((b) => b.id === id)!;
const maps = (id: string) => boardMaps(getBoard(id).doc);
const gridCards = (id: string) => [...maps(id).objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "grid");
const base = { x: 0, y: 0, float: false, bornAt: 1 };
const panel = (id: string, sectionId: string, kind: string, name: string, more: object = {}) => ({ id, kind: "panel", panel: kind, sectionId, name, ...base, w: 400, h: 300, ports: [], ...more }) as unknown as ObjectDoc;

/** a grid with a Design section (a note, a table, an image, an app wired to a note outside, a machine) and a Notes section */
async function programme(name: string) {
  const id = createBoardRow(name);
  const f = await storeFile(Buffer.from(`png of ${name}`), { name: "sketch.png", mime: "image/png", boardId: id, userId: ada.id });
  const made = editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    const design = appendSection(doc, "Design");
    const notes = appendSection(doc, "Notes");
    putNote(doc, { id: "note_a", kind: "note", sectionId: design.id, name: "Brief", ...base, w: 420, h: 300, text: "# Brief\nwhat we are making" });
    m.objects.set("tbl_a", { id: "tbl_a", kind: "table", sectionId: design.id, name: "Parts", ...base, cols: 3, rows: 4 });
    tableCellMap(doc, "tbl_a");
    setTableCells(doc, "tbl_a", { "0,0": "Bolt", "1,0": "=2*3" });
    m.objects.set("media_a", { id: "media_a", kind: "media", sectionId: design.id, name: "sketch.png", ...base, w: 300, h: 200, src: `/files/${f.id}`, media: "image", autoplay: false, muted: true });
    m.objects.set("map_a", { id: "map_a", kind: "map", sectionId: design.id, name: "Sites", ...base, w: 300, h: 200, sourceTableId: "tbl_a", pitched: false });
    m.objects.set("pnl_app", panel("pnl_app", design.id, "app", "Maker", { url: "https://example.com/", ports: [{ id: "p1", name: "parts", dir: "out" }] }));
    m.objects.set("pnl_app2", panel("pnl_app2", design.id, "app", "Taker", { url: "https://example.com/2", ports: [{ id: "p2", name: "bom", dir: "in" }] }));
    m.objects.set("pnl_mach", panel("pnl_mach", design.id, "machine", "Bench", { machine: { name: "bench", state: "absent" } }));
    putNote(doc, { id: "note_out", kind: "note", sectionId: notes.id, name: "Outside", ...base, w: 420, h: 300, text: "stays" });
    m.links.set("lnk_in", { id: "lnk_in", from: { panel: "pnl_app", port: "p1" }, to: { panel: "pnl_app2", port: "p2" } });
    m.links.set("lnk_cut", { id: "lnk_cut", from: { panel: "pnl_app", port: "p1" }, to: { panel: "note_out", port: "text" } });
    m.agents.set(design.id, [{ key: "claude", name: "Claude", provider: "claude", where: "cloud", service: "test", tools: true, by: ada.id, byName: ada.name, at: 1 }]);
    return { design, notes };
  });
  return { id, file: f, ...made };
}

test("a section becomes a grid inside this one: its cards move with their text, cells, files and wires; the section keeps its place and holds the grid's card", async () => {
  const p = await programme("Programme");
  const char = createCharacter(p.id, { name: "Ada", id: ada.id, human: true }, { name: "Pip", set: "abstract", form: "mesh", identity: "A green blob." });
  editBoard(p.id, "test", (doc) => {
    const m = boardMaps(doc);
    const c = m.objects.get(char.panelId)!;
    m.objects.set(c.id, { ...c, sectionId: p.design.id });
  });
  const before = { ...maps(p.id).sections.get(p.design.id)! };
  const tracksBefore = maps(p.id).grid.get("tracks");

  const out = (await runTool(ctx(p.id), "extract_section", { section: "Design", request_id: "x1" })) as ExtractResult;
  assert.equal(out.name, "Design");
  assert.equal(out.moved, 7, "the note, the table, the image, the map, two apps and the character");
  assert.deepEqual(out.stayed, [{ id: "pnl_mach", name: "Bench", kind: "machine" }]);
  assert.deepEqual(out.wires, { moved: 1, dropped: 1 });

  // the new grid: inside this one, one section the size the section was, everything in it
  assert.equal(row(out.board).parent, p.id);
  assert.equal(row(out.board).name, "Design");
  const there = getBoard(out.board).doc;
  const c = boardMaps(there);
  assert.equal(c.sections.size, 1);
  const sec = [...c.sections.values()][0];
  assert.equal(sec.name, "Design");
  assert.deepEqual(c.grid.get("tracks"), { cols: [tracksBefore!.cols[before.c0]], rows: [tracksBefore!.rows.slice(before.r0, before.r1 + 1).reduce((a, b) => a + b, 0)] });
  assert.equal(noteTextOf(there, c.objects.get("note_a") as never), "# Brief\nwhat we are making");
  assert.deepEqual(tableCellsOf(there, "tbl_a"), { "0,0": "Bolt", "1,0": "=2*3" });
  assert.equal((c.objects.get("map_a") as { sourceTableId: string }).sourceTableId, "tbl_a", "a map keeps its table when both moved");
  for (const id of ["note_a", "tbl_a", "media_a", "map_a", "pnl_app", "pnl_app2", char.panelId]) assert.equal(c.objects.get(id)?.sectionId, sec.id, id);
  // the image's file is the new grid's too; the first is never removed
  const fid = (c.objects.get("media_a") as { src: string }).src.replace("/files/", "");
  assert.notEqual(fid, p.file.id);
  assert.equal(one<{ board_id: string }>("select board_id from files where id = ?", fid)!.board_id, out.board);
  assert.ok(one("select id from files where id = ? and archived_at is null", p.file.id));
  // the wire among them went; the one that crossed the edge was let go
  assert.deepEqual([...c.links.keys()], ["lnk_in"]);
  // a character is still a character there
  assert.equal(c.characters.get(char.panelId)?.name, "Pip");
  assert.equal(one<{ board_id: string }>("select board_id from characters where id = ?", char.id)!.board_id, out.board);
  assert.ok(roster().characters.some((r) => r.id === char.id && r.boardId === out.board), "the roster finds it on the new grid");
  // the section's council went with it
  assert.equal(postedAgentsOf(there, sec.id)[0]?.key, "claude");

  // the grid it came from: the section where it was, the same size, with the grid's card and what had to stay
  const m = maps(p.id);
  const kept = m.sections.get(p.design.id)!;
  assert.deepEqual([kept.c0, kept.r0, kept.c1, kept.r1], [before.c0, before.r0, before.c1, before.r1]);
  assert.deepEqual(m.grid.get("tracks"), tracksBefore, "no section was added or taken away");
  assert.equal(m.sections.size, 3, "Design, Notes and the section the character was made in");
  const [card] = gridCards(p.id);
  assert.equal(card.board, out.board);
  assert.equal(card.sectionId, p.design.id);
  assert.equal(card.id, out.card);
  assert.equal(kept.host, undefined, "a machine stayed, so the grid's card sits beside it instead of filling the section");
  assert.deepEqual([...m.objects.values()].filter((o) => o.sectionId === p.design.id).map((o) => o.id).sort(), [card.id, "pnl_mach"].sort());
  for (const id of ["note_a", "tbl_a", "media_a", "map_a", "pnl_app", "pnl_app2", char.panelId]) assert.equal(m.objects.has(id), false, id);
  assert.equal(m.noteText.has("note_a"), false);
  assert.equal(m.cells.has("tbl_a"), false);
  assert.equal(m.characters.has(char.panelId), false);
  assert.equal(m.links.size, 0);
  assert.equal(postedAgentsOf(getBoard(p.id).doc, p.design.id).length, 0);
  assert.ok(m.objects.has("note_out"), "what was outside the section is untouched");
  const said = m.activity.toArray().at(-1)!;
  assert.equal(said.who, "Ada Lovelace");
  assert.equal(said.role, "human");
  assert.match(said.text, /made “Design” a grid of its own.*7 cards moved into it/);
  assert.match(said.text, /1 wire that crossed the section's edge was let go/);
  assert.match(said.text, /the machine “Bench” stayed here/);
  assert.match(boardMaps(there).activity.toArray().at(-1)!.text, /made this grid from the section “Design” of Programme/);

  // twice is once: the same request, and then the section that already stands for a grid
  assert.deepEqual(await runTool(ctx(p.id), "extract_section", { section: "Design", request_id: "x1" }), out);
  const again = (await runTool(ctx(p.id), "extract_section", { section: p.design.id })) as ExtractResult;
  assert.equal(again.already, true, "all that could move is the grid's own card: it's done already");
  assert.equal(again.board, out.board);
  assert.equal(listBoards().filter((b) => b.parent === p.id).length, 1);
});

test("a section with nothing that must stay: the grid's card fills it, and asking again answers with the same grid", async () => {
  const p = await programme("Fans");
  // an ask in the section: its answer has to find the card on the new grid
  const ask = createAsk({ boardId: p.id, actor: "Ada", userId: ada.id }, { assignee: "ben@formindustries.com", prompt: "Upload the latest CAD", kind: "upload", section: "Notes" });
  const out = extractSection(p.id, "Notes", { userId: ada.id, name: "Ada", role: "human" });
  assert.equal(out.moved, 2);
  assert.equal(one<{ board_id: string }>("select board_id from asks where id = ?", ask.id)!.board_id, out.board);
  await resolveAsk(ask.id, "Ben");
  assert.equal((maps(out.board).objects.get(ask.panelId) as PanelDoc).status, "done", "answered where the card is now");
  const m = maps(p.id);
  assert.equal(m.sections.get(p.notes.id)!.host, out.card);
  assert.equal(m.sections.get(p.notes.id)!.name, "Notes");
  // the wire from Maker to the note outside its section: Maker's end stays, the note's left
  assert.deepEqual([...m.links.keys()], ["lnk_in"]);
  assert.match(m.activity.toArray().at(-1)!.text, /1 wire that crossed/);
  const again = extractSection(p.id, p.notes.id, { userId: ada.id, name: "Ada", role: "human" });
  assert.equal(again.already, true);
  assert.equal(again.board, out.board);
  assert.equal(listBoards().filter((b) => b.parent === p.id).length, 1);
  // an empty section makes an empty grid with one section
  const empty = editBoard(p.id, "test", (d) => appendSection(d, "Later"));
  const e = extractSection(p.id, empty.id, { userId: ada.id, name: "Ada", role: "human" });
  assert.equal(e.moved, 0);
  assert.equal(maps(e.board).sections.size, 1);
  assert.equal(maps(p.id).sections.get(empty.id)!.host, e.card);
});

test("a section that is already a grid of sections becomes a grid with those sections at their places", () => {
  const id = createBoardRow("Rim drive");
  const { outer } = editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    const outer = appendSection(doc, "Motor");
    m.sections.set(outer.id, { ...outer, grid: { cols: [800, 600], rows: [700] } });
    m.sections.set("sec_in1", { id: "sec_in1", name: "Stator", c0: 0, r0: 0, c1: 0, r1: 0, parent: outer.id, grid: { cols: [400], rows: [300, 300] } } as SectionDoc);
    m.sections.set("sec_in2", { id: "sec_in2", name: "Rotor", c0: 1, r0: 0, c1: 1, r1: 0, parent: outer.id });
    m.sections.set("sec_deep", { id: "sec_deep", name: "Windings", c0: 0, r0: 0, c1: 0, r1: 0, parent: "sec_in1" });
    putNote(doc, { id: "note_w", kind: "note", sectionId: "sec_deep", name: "Turns", ...base, w: 420, h: 300, text: "42 turns" });
    putNote(doc, { id: "note_r", kind: "note", sectionId: "sec_in2", name: "Magnets", ...base, w: 420, h: 300, text: "N52" });
    m.objects.set("pnl_hud", panel("pnl_hud", "sec_in2", "huddle", "Standup"));
    m.agents.set(outer.id, [{ key: "claude", name: "Claude", provider: "claude", where: "cloud", service: "test", tools: true, by: ada.id, byName: ada.name, at: 1 }]);
    return { outer };
  });
  const out = extractSection(id, "Motor", { userId: "agent", name: "Wren", role: "agent", for: "Ada" });
  assert.equal(out.moved, 2);
  assert.equal(out.sections, 3);
  const c = maps(out.board);
  assert.deepEqual(c.grid.get("tracks"), { cols: [800, 600], rows: [700] });
  assert.equal(c.sections.get("sec_in1")!.parent, undefined, "its sections are the new grid's own");
  assert.deepEqual(c.sections.get("sec_in1")!.grid, { cols: [400], rows: [300, 300] });
  assert.equal(c.sections.get("sec_deep")!.parent, "sec_in1", "and a grid inside one of them is still inside it");
  assert.equal(noteTextOf(getBoard(out.board).doc, c.objects.get("note_w") as never), "42 turns");
  assert.equal(postedAgentsOf(getBoard(out.board).doc, GRID_PLACE)[0]?.key, "claude", "the council of the section that became the grid is the grid's");
  const m = maps(id);
  assert.equal(m.sections.size, 1, "the inner sections left with it");
  const kept = m.sections.get(outer.id)!;
  assert.equal(kept.grid, undefined);
  assert.equal(m.objects.get("pnl_hud")!.sectionId, outer.id, "the huddle stays, in the section itself now");
  assert.deepEqual(out.stayed.map((s) => s.kind), ["huddle"]);
  const said = m.activity.toArray().at(-1)!;
  assert.equal(said.role, "agent");
  assert.equal(said.for, "Ada");
});

test("refused in words: a viewer, a Slack section, a section that isn't there, a presentation", async () => {
  const p = await programme("Motors");
  setBoardRole(boss, p.id, ben.id, "viewer");
  await assert.rejects(() => runTool(ctx(p.id, ben), "extract_section", { section: "Design" }), /View only/);
  assert.equal(listBoards().filter((b) => b.parent === p.id).length, 0);
  assert.ok(maps(p.id).objects.has("note_a"), "nothing moved");
  editBoard(p.id, "slack", (doc) => boardMaps(doc).slack.set(p.notes.id, { channel: "C1", name: "motors", state: "polling" }));
  await assert.rejects(() => runTool(ctx(p.id), "extract_section", { section: "Notes" }), /follows #motors on Slack/);
  await assert.rejects(() => runTool(ctx(p.id), "extract_section", { section: "Nope" }), /No section “Nope”/);
  const deck = createBoardRow("Pitch", { kind: "deck" });
  editBoard(deck, "test", (d) => appendSection(d, "Title"));
  await assert.rejects(() => runTool(ctx(deck), "extract_section", { section: "Title" }), /slides/);
});

test("a members-only grid's sub-grid is members-only too, and a viewer of one is a viewer of the other", async () => {
  const p = await programme("Private");
  setMember(p.id, ada.id, "owner");
  setBoardRole(boss, p.id, ben.id, "viewer");
  const out = extractSection(p.id, "Notes", { userId: ada.id, name: "Ada", role: "human" });
  assert.equal(canSeeBoard(ada, out.board), true);
  assert.equal(canSeeBoard(ben, out.board), false, "someone who couldn't see the grid can't see what came out of it");
  assert.equal(one<{ role: string }>("select role from board_roles where board_id = ? and user_id = ?", out.board, ben.id)?.role, "viewer");
  // and the outline doesn't name a parent they can't see
  setMember(out.board, ben.id, "viewer");
  assert.equal(gridOutline(out.board, ben).parent, null);
  assert.equal(gridOutline(out.board, ada).parentName, "Private");
});

test("the preview's outline: tracks, each section's place, its cards as blocks, an image with its file", async () => {
  const p = await programme("Outline");
  const o = gridOutline(p.id, ada);
  assert.equal(o.name, "Outline");
  assert.equal(o.parent, null);
  assert.equal(o.tracks.cols.length, 2);
  assert.deepEqual(o.sections.map((s) => [s.name, s.c0, s.r0, s.cards]), [["Design", 0, 0, 7], ["Notes", 1, 0, 1]]);
  const design = o.sections[0];
  assert.deepEqual(design.items.map((i) => i.kind).sort(), ["app", "app", "image", "machine", "map", "note", "table"]);
  assert.equal(design.items.find((i) => i.kind === "image")!.thumb, `/files/${p.file.id}`);
  assert.ok(design.items.every((i) => i.w > 0 && i.h > 0));
  assert.equal(o.cards, 8);
});

test("a grid that leaves its parent leaves its card there: to the top, into another, and back", async () => {
  const p = await programme("Old home");
  const other = createBoardRow("New home");
  editBoard(other, "test", (d) => appendSection(d, "Section 1"));
  const out = extractSection(p.id, "Notes", { userId: ada.id, name: "Ada", role: "human" });
  const sections = maps(p.id).sections.size;

  // to the top: the card and its section stay, and the grid's log says where it went
  assert.deepEqual(setBoardParent(out.board, null), { ok: true });
  assert.equal(row(out.board).parent, null);
  assert.equal(gridCards(p.id).length, 1);
  assert.equal(maps(p.id).sections.size, sections);
  assert.equal(maps(p.id).sections.get(p.notes.id)!.host, out.card);
  assert.deepEqual(leftoverLinks(out.board), [p.id]);
  assert.match(maps(p.id).activity.toArray().at(-1)!.text, /“Notes” moved out of this grid: now at the top of All Grids/);
  assert.equal(gridOutline(out.board, ada).parent, null);

  // into another grid: that one gets its section; the old one still has its card
  setBoardParent(out.board, other);
  assert.equal(gridCards(other).length, 1);
  assert.equal(gridCards(p.id).length, 1);
  assert.equal(gridOutline(out.board, ada).parentName, "New home");

  // renamed: both cards wear the name
  updateBoardRow(out.board, { name: "Field notes" });
  assert.equal(gridCards(other)[0].name, "Field notes");
  assert.equal(gridCards(p.id)[0].name, "Field notes");
  assert.equal(maps(p.id).sections.get(p.notes.id)!.name, "Field notes");

  // from one parent to another: the one it left keeps a card too
  const third = createBoardRow("Third home");
  editBoard(third, "test", (d) => appendSection(d, "Section 1"));
  setBoardParent(out.board, third);
  assert.equal(gridCards(other).length, 1);
  assert.match(maps(other).activity.toArray().at(-1)!.text, /moved out of this grid: now inside Third home/);
  assert.deepEqual(leftoverLinks(out.board).sort(), [other, p.id].sort());

  // back into the first: the card that was left is its link again, not a second one
  setBoardParent(out.board, p.id);
  assert.equal(gridCards(p.id).length, 1);
  assert.equal(maps(p.id).sections.size, sections);
  assert.deepEqual(leftoverLinks(out.board).sort(), [other, third].sort());

  // a person removes a leftover card: it's just a card, and a later rename forgets it
  editBoard(other, "test", (doc) => {
    const m = boardMaps(doc);
    const card = [...m.objects.values()].find((o) => o.kind === "panel" && o.panel === "grid")!;
    m.objects.delete(card.id);
  });
  updateBoardRow(out.board, { name: "Field notes 2" });
  assert.deepEqual(leftoverLinks(out.board), [third]);
  assert.equal(all("select 1 from grid_leftovers where board_id = ?", other).length, 0);
});

test("a card for a grid inside the section goes with it: that grid is inside the new grid now", () => {
  const top = createBoardRow("Company");
  const kid = createBoardRow("Budget");
  editBoard(top, "test", (d) => appendSection(d, "Section 1"));
  setBoardParent(kid, top);
  const [card] = gridCards(top);
  // put the grid's card in an ordinary section with a note beside it
  const sec = editBoard(top, "test", (doc) => {
    const m = boardMaps(doc);
    const s = appendSection(doc, "Finance");
    const was = m.sections.get(card.sectionId)!;
    m.sections.set(was.id, { ...was, host: undefined });
    m.objects.set(card.id, { ...card, sectionId: s.id });
    putNote(doc, { id: "note_f", kind: "note", sectionId: s.id, name: "Plan", ...base, w: 420, h: 300, text: "numbers" });
    return s;
  });
  const out = extractSection(top, sec.id, { userId: ada.id, name: "Ada", role: "human" });
  assert.equal(row(kid).parent, out.board);
  assert.equal(row(out.board).parent, top);
  assert.equal(gridCards(out.board)[0].board, kid);
  assert.deepEqual(gridCards(top).map((c) => c.board), [out.board]);
  run("select 1");
});

// ---------- put back (plan: sub-grid-dissolve) ----------

test("a grid made from a section goes back into it: cards, text, cells, files, wires, characters and councils return, and the grid is archived", async () => {
  const p = await programme("Put back");
  // the machine has to be elsewhere for the grid to go back whole; it stays on its grid either way
  editBoard(p.id, "test", (doc) => boardMaps(doc).objects.delete("pnl_mach"));
  const char = createCharacter(p.id, { name: "Ada", id: ada.id, human: true }, { name: "Mo", set: "abstract", form: "mesh", identity: "A blue blob." });
  editBoard(p.id, "test", (doc) => {
    const m = boardMaps(doc);
    const c = m.objects.get(char.panelId)!;
    m.objects.set(c.id, { ...c, sectionId: p.design.id });
  });
  const before = { ...maps(p.id).sections.get(p.design.id)! };
  const out = extractSection(p.id, "Design", { userId: ada.id, name: "Ada", role: "human" });
  // more is written on the new grid before it goes back
  editBoard(out.board, "test", (doc) => putNote(doc, { id: "note_new", kind: "note", sectionId: p.design.id, name: "Later", ...base, w: 420, h: 300, text: "written there" }));

  // not without confirm
  assert.match(String(await runTool(ctx(p.id), "dissolve_grid", { section: "Design" })), /confirm/);
  assert.equal(row(out.board).parent, p.id);

  const back = (await runTool(ctx(p.id), "dissolve_grid", { section: "Design", confirm: true, request_id: "d1" })) as { board: string; moved: number; sections: number; wires: number };
  assert.equal(back.board, out.board);
  assert.equal(back.moved, 8, "the seven that went and the note written there");
  assert.equal(back.sections, 0, "a grid of one section gives its cards straight to the section");
  assert.equal(back.wires, 1);

  const m = maps(p.id);
  const sec = m.sections.get(p.design.id)!;
  assert.deepEqual([sec.c0, sec.r0, sec.c1, sec.r1], [before.c0, before.r0, before.c1, before.r1]);
  assert.equal(gridCards(p.id).length, 0, "the grid's card is gone");
  for (const id of ["note_a", "tbl_a", "media_a", "map_a", "pnl_app", "pnl_app2", "note_new", char.panelId]) assert.equal(m.objects.get(id)?.sectionId, p.design.id, id);
  const doc = getBoard(p.id).doc;
  assert.equal(noteTextOf(doc, m.objects.get("note_new") as never), "written there");
  assert.deepEqual(tableCellsOf(doc, "tbl_a"), { "0,0": "Bolt", "1,0": "=2*3" });
  assert.deepEqual([...m.links.keys()], ["lnk_in"]);
  assert.equal(m.characters.get(char.panelId)?.name, "Mo");
  assert.equal(one<{ board_id: string }>("select board_id from characters where id = ?", char.id)!.board_id, p.id);
  assert.equal(postedAgentsOf(doc, p.design.id)[0]?.key, "claude", "the council is the section's again");
  const fid = (m.objects.get("media_a") as { src: string }).src.replace("/files/", "");
  assert.equal(one<{ board_id: string }>("select board_id from files where id = ?", fid)!.board_id, p.id, "the image's file is this grid's");
  assert.match(m.activity.toArray().at(-1)!.text, /put the grid “Design” back into the section “Design”: 8 cards came with it/);

  // the other grid is archived, never deleted
  assert.equal(listBoards().some((b) => b.id === out.board), false);
  assert.ok(one<{ archived_at: number }>("select archived_at from boards where id = ?", out.board)?.archived_at);
  // the same request answers the same; a section with no grid's card says so
  assert.deepEqual(await runTool(ctx(p.id), "dissolve_grid", { section: "Design", confirm: true, request_id: "d1" }), back);
  await assert.rejects(() => runTool(ctx(p.id), "dissolve_grid", { section: "Design", confirm: true }), /doesn't stand for a grid/);
});

test("putting back: a grid of sections becomes the section's own grid; a machine there, a grid moved away and a viewer are refused", async () => {
  const p = await programme("Put back 2");
  editBoard(p.id, "test", (doc) => boardMaps(doc).objects.delete("pnl_mach"));
  const out = extractSection(p.id, "Notes", { userId: ada.id, name: "Ada", role: "human" });
  // the new grid grows a second section
  const extra = editBoard(out.board, "test", (doc) => {
    const s = appendSection(doc, "More");
    putNote(doc, { id: "note_more", kind: "note", sectionId: s.id, name: "More", ...base, w: 420, h: 300, text: "more" });
    return s;
  });

  // a viewer can't
  setBoardRole(boss, p.id, ben.id, "viewer");
  await assert.rejects(() => runTool(ctx(p.id, ben), "dissolve_grid", { section: "Notes", confirm: true }), /View only/);

  // a machine made there stays there: refused in words
  editBoard(out.board, "test", (doc) => boardMaps(doc).objects.set("pnl_m2", panel("pnl_m2", extra.id, "machine", "Rig", { machine: { name: "rig", state: "absent" } })));
  await assert.rejects(() => runTool(ctx(p.id), "dissolve_grid", { section: "Notes", confirm: true }), /the machine “Rig” stays on “Notes”/);
  editBoard(out.board, "test", (doc) => boardMaps(doc).objects.delete("pnl_m2"));

  // moved to the top: this grid holds only a link
  setBoardParent(out.board, null);
  await assert.rejects(() => runTool(ctx(p.id), "dissolve_grid", { section: "Notes", confirm: true }), /isn't inside this grid now/);
  setBoardParent(out.board, p.id);

  const back = (await runTool(ctx(p.id), "dissolve_grid", { section: "Notes", confirm: true })) as { sections: number };
  assert.equal(back.sections, 2);
  const m = maps(p.id);
  const notes = m.sections.get(p.notes.id)!;
  assert.ok(notes.grid, "the section is a grid of sections now");
  const inner = [...m.sections.values()].filter((s) => s.parent === p.notes.id);
  assert.deepEqual(inner.map((s) => s.name).sort(), ["More", "Notes"]);
  assert.ok(inner.every((s) => s.id !== p.notes.id), "a section that had this section's id got a new one");
  assert.equal(m.objects.get("note_out")?.sectionId, inner.find((s) => s.name === "Notes")!.id);
  assert.equal(m.objects.get("note_more")?.sectionId, extra.id);
});

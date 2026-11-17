/**
 * Collections (2026-11-17): the Character studio's process as a primitive on any grid, a collection that
 * gathers what its wired sources make, piping it into a section that lays the products out, and copies
 * dragged out of it.
 *
 *  - add_character_pipeline lays the nine nodes into a section with a collection wired from Output;
 *  - a stage node's wire brings that stage's pictures, Output's brings the finished characters, once each;
 *  - piped into a section, every item becomes a docked card there (a picture an image card at its own
 *    shape, a character a copy of its card), later items follow, a card someone removed isn't laid again;
 *  - a copy out is a card where it was let go; a character's copy is marked, never an avatar twice, and
 *    nothing can be pressed on it;
 *  - taking an item out needs confirm and leaves the cards made from it; a viewer can read, not write;
 *  - an Output node from before gets its own output once the studio is upgraded.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-collections-"));
process.env.FOUNDATION_STARTER_DIR = "";

const { closeBoards, editBoard, getBoard, createBoardRow } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { run } = await import("../src/db.ts");
const { storeFile } = await import("../src/files.ts");
const { runTool } = await import("../src/tools.ts");
const { createCharacter, openStudio, upgradeStudio, roster, setApproval, startStage } = await import("../src/characters.ts");
const { gather, stopGathering } = await import("../src/collections.ts");
const { appendSection, boardMaps, characterChoosable, uid, CHARACTER_STAGES, COLLECTION_IN, OUTPUT_PORT, PIPELINE_NODES } = await import("@foundation/protocol");
type PanelDoc = import("@foundation/protocol").PanelDoc;
type CharacterState = import("@foundation/protocol").CharacterState;

after(() => {
  stopGathering();
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const board = createBoardRow("Avatars");
const ctx = (userId = ada.id) => ({ boardId: board, actor: "Ada Lovelace", userId, person: true });
const tool = <T>(name: string, input: Record<string, unknown>, userId?: string) => runTool(ctx(userId), name, input) as Promise<T>;
const m = () => boardMaps(getBoard(board).doc);

/** a PNG's first bytes: enough for its size to be read */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** what a stage landing does to a character (the server's own write, as settle() makes it) */
function land(panelId: string, patch: (c: CharacterState) => void) {
  const c = structuredClone(m().characters.get(panelId)!);
  patch(c);
  c.ready = c.form === "model" ? Boolean(c.files.clips) : Boolean(c.files.mavatar);
  run("update characters set state = ? where panel_id = ?", JSON.stringify(c), panelId);
  editBoard(board, "characters", (doc) => boardMaps(doc).characters.set(panelId, c));
}

const sec = editBoard(board, "test", (doc) => appendSection(doc, "Section 1"));
let collection = "";
let mira = "";
let taro = "";

test("the character pipeline on any grid: nine nodes wired in order, and a collection gathering what Output makes", async () => {
  const out = await tool<{ section: string; collection: string; nodes: number }>("add_character_pipeline", { section: sec.id, set: "anime", request_id: "p1" });
  assert.equal(out.nodes, PIPELINE_NODES.length);
  collection = out.collection;
  assert.equal(m().sections.get(sec.id)!.name, "Pipeline · Anime", "the section is named for its set, which its nodes read");
  const nodes = [...m().objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "pipeline" && o.sectionId === sec.id);
  assert.deepEqual(nodes.map((n) => n.node).sort(), [...PIPELINE_NODES].sort());
  const output = nodes.find((n) => n.node === "output")!;
  const coll = m().objects.get(collection) as PanelDoc;
  assert.equal(coll.panel, "collection");
  assert.ok(coll.x >= output.x + output.w, "the collection stands after Output");
  const wire = [...m().links.values()].find((l) => l.to.panel === collection);
  assert.ok(wire, "Output is wired into it");
  assert.equal(wire.from.panel, output.id);
  assert.equal(output.ports.find((p) => p.id === wire.from.port)?.name, OUTPUT_PORT);
  assert.equal(coll.ports.find((p) => p.id === wire.to.port)?.name, COLLECTION_IN);
  assert.ok(m().grid.get("tracks")!.cols[sec.c0] >= coll.x + coll.w, "the column grew to hold the flow and the collection");
  // the same request again is the same answer, and there is one pipeline to a section
  assert.deepEqual(await tool("add_character_pipeline", { section: sec.id, set: "anime", request_id: "p1" }), out);
  await assert.rejects(tool("add_character_pipeline", { section: sec.id, set: "anime" }), /already has a pipeline/);
});

test("a stage node's wire brings its pictures, Output's the finished characters, each once", async () => {
  mira = createCharacter(board, { name: "Ada Lovelace", id: ada.id, human: true }, { name: "Mira", set: "anime", form: "mesh", section: sec.id }).panelId;
  taro = createCharacter(board, { name: "Ada Lovelace", id: ada.id, human: true }, { name: "Taro", set: "anime", form: "mesh", section: sec.id }).panelId;
  const sheet = (await storeFile(png(600, 900), { name: "mira-sheet.png", mime: "image/png", boardId: board, userId: ada.id })).id;
  land(mira, (c) => {
    c.files.front = sheet;
    c.stages.sheet = { state: "done" };
  });
  gather(board);
  assert.equal(m().collections.get(collection)?.items.length ?? 0, 0, "only Output is wired, and nothing is finished");

  // wire the Sheet node into the collection, as a person drags it
  const node = [...m().objects.values()].find((o): o is PanelDoc => o.kind === "panel" && o.panel === "pipeline" && o.node === "sheet" && o.sectionId === sec.id)!;
  const coll = m().objects.get(collection) as PanelDoc;
  editBoard(board, "test", (doc) =>
    boardMaps(doc).links.set("lnk_sheet", { id: "lnk_sheet", from: { panel: node.id, port: node.ports.find((p) => p.dir === "out")!.id }, to: { panel: collection, port: coll.ports.find((p) => p.dir === "in")!.id } }),
  );
  gather(board);
  let items = m().collections.get(collection)!.items;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].kind, items[0].key, items[0].src, items[0].from, items[0].w, items[0].h], ["image", `file:${sheet}`, `/files/${sheet}`, "Sheet · Anime", 600, 900]);
  assert.match(items[0].name, /Mira · sheet/);

  // Taro is finished: every stage done, its mesh avatar brought in
  land(taro, (c) => {
    for (const s of CHARACTER_STAGES.mesh) c.stages[s] = { state: "done" };
    c.files.thumb = sheet;
    c.files.mavatar = sheet;
  });
  gather(board);
  gather(board);
  items = m().collections.get(collection)!.items;
  assert.equal(items.length, 2, "gathering again brings nothing twice");
  const chr = items.find((i) => i.kind === "character")!;
  assert.equal(chr.name, "Taro");
  assert.equal(chr.from, "Output · Anime");
  assert.equal(chr.panel, taro);
});

test("piped into a section, everything is laid there docked; later items follow; a removed card isn't laid again", async () => {
  const shelf = editBoard(board, "test", (doc) => appendSection(doc, "Section 2"));
  const r = await tool<{ into: string; laid: number }>("collection_lay_out", { collection, section: shelf.id, request_id: "l1" });
  assert.deepEqual(r, { into: shelf.id, laid: 2 });
  assert.equal(m().sections.get(shelf.id)!.name, "Collected · Anime", "a section just made for it takes the collection's name");
  const laid = () => [...m().objects.values()].filter((o) => o.sectionId === shelf.id);
  const cards = laid();
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => !c.float), "docked: the section's flow arranges them");
  const pic = cards.find((c) => c.kind === "media")!;
  assert.deepEqual([pic.kind === "media" && pic.w, pic.kind === "media" && pic.h], [300, 450], "a picture keeps its shape");
  const copy = cards.find((c) => c.kind === "panel") as PanelDoc;
  assert.equal(copy.panel, "character");
  const cs = m().characters.get(copy.id)!;
  assert.equal(cs.name, "Taro");
  assert.ok(cs.copyOf, "it is marked a copy");
  assert.equal(characterChoosable(cs), false, "a copy is never offered as an avatar");
  setApproval(board, taro, "approved", ada);
  const listed = roster().characters.filter((c) => c.name === "Taro" && characterChoosable(c));
  assert.equal(listed.length, 1, "Taro is offered once, the original");

  // a picture put in by hand follows into the section
  const extra = (await storeFile(png(800, 600), { name: "pose.png", mime: "image/png", boardId: board, userId: ada.id })).id;
  await tool("collection_put", { collection, file_id: extra });
  gather(board);
  assert.equal(laid().length, 3);
  // someone removes a laid card: it stays removed
  editBoard(board, "test", (doc) => boardMaps(doc).objects.delete(pic.id));
  gather(board);
  assert.equal(laid().length, 2);
});

test("a copy dragged out lands where it was let go; nothing is pressed on a character's copy", async () => {
  const items = m().collections.get(collection)!.items;
  const chr = items.find((i) => i.kind === "character")!;
  const away = editBoard(board, "test", (doc) => appendSection(doc, "Moodboard"));
  const out = await tool<{ id: string; kind: string }>("collection_copy", { collection, item: chr.key, section: away.id, x: 120, y: 80, request_id: "c1" });
  assert.equal(out.kind, "character");
  const card = m().objects.get(out.id)!;
  assert.deepEqual([card.sectionId, card.x, card.y, card.float], [away.id, 120, 80, true]);
  assert.deepEqual(await tool("collection_copy", { collection, item: chr.key, section: away.id, x: 120, y: 80, request_id: "c1" }), out, "the same request makes one copy");
  const pic = items.find((i) => i.kind === "image")!;
  const img = await tool<{ id: string }>("collection_copy", { collection, item: pic.key, section: "Moodboard" });
  assert.equal(m().objects.get(img.id)!.kind, "media");
  assert.equal(m().objects.get(img.id)!.float, false, "without a place it joins the section's flow");
  await assert.rejects(startStage(board, out.id, "sheet", ada), /copy/);
  await assert.rejects(tool("collection_copy", { collection, item: "file:nope", section: away.id }), /has no item/);
});

test("taking an item out needs confirm and leaves the cards made from it; a viewer reads but can't write", async () => {
  const before = m().collections.get(collection)!.items;
  const cards = m().objects.size;
  assert.match(String(await tool("collection_take_out", { collection, item: before[0].key, confirm: false })), /not taken out/);
  assert.equal(m().collections.get(collection)!.items.length, before.length);
  await tool("collection_take_out", { collection, item: before[0].key, confirm: true });
  assert.equal(m().collections.get(collection)!.items.length, before.length - 1);
  assert.equal(m().objects.size, cards, "no card went with it");

  const vic = upsertUser("vic@formindustries.com", "Vic");
  run("update users set role = 'viewer' where id = ?", vic.id);
  const read = await tool<{ items: unknown[] }>("read_collection", { collection }, vic.id);
  assert.equal(read.items.length, before.length - 1);
  await assert.rejects(tool("collection_lay_out", { collection, section: null }, vic.id), /View only/);
  await assert.rejects(tool("collection_copy", { collection, item: before[1].key, section: sec.id }, vic.id), /View only/);
});

test("a studio's Output nodes from before get an output of their own, once", () => {
  const { id } = openStudio(ada);
  const outputs = () => [...boardMaps(getBoard(id).doc).objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "pipeline" && o.node === "output");
  assert.ok(outputs().length >= 3 && outputs().every((o) => o.ports.some((p) => p.dir === "out" && p.name === OUTPUT_PORT)), "a new studio's have one");
  // as they were before 2026-11-17: inputs only
  editBoard(id, "test", (doc) => {
    for (const o of outputs()) boardMaps(doc).objects.set(o.id, { ...o, ports: o.ports.filter((p) => p.dir === "in") });
  });
  upgradeStudio(id);
  upgradeStudio(id);
  for (const o of outputs()) assert.equal(o.ports.filter((p) => p.dir === "out").length, 1);
  void uid;
});

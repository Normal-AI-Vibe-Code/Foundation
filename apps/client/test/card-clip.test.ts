import { test } from "node:test";
import assert from "node:assert/strict";
import { cadLinked, type CadFeed } from "@foundation/protocol";
import { PASTE_STEP, clipOf, copyName, markerOf, parseMarker, pasteCards, placeFor, type ClipCard } from "../src/state/cardClip.ts";
import { feedWords } from "../src/cad/feedWords.ts";
import type { MapMeta, MediaMeta, NoteMeta, PanelMeta, TableMeta } from "../src/state/store.ts";

const base = { sectionId: "sec_a", x: 40, y: 60, float: true, bornAt: 1 };
const feed: CadFeed = { app: "pnl_bom", appName: "Airform BOM", tool: "get_part_model", args: { part: "FH-210" }, label: "Fan hub, rev C", state: "ok", by: "josh" };
const cad: PanelMeta = { ...base, id: "pnl_cad", name: "fan-hub.stl", panel: "file", w: 420, h: 340, ports: [{ id: "model", name: "model", dir: "in", type: "cad" }], fileId: "f_1", mime: "model/stl", feed, createdBy: "Wren" };
const clipped = (o: Parameters<typeof clipOf>[0], cells?: Record<string, string>): ClipCard => {
  const r = clipOf(o, cells);
  assert.ok("clip" in r, "refused" in r ? (r as { refuse: string }).refuse : "");
  return r.clip;
};

test("a copied CAD card keeps its file, its ports and its feed, and leaves who made it", () => {
  const c = clipped(cad);
  assert.equal(c.kind, "panel");
  const p = c.card as PanelMeta;
  assert.equal(p.fileId, "f_1");
  assert.equal(p.mime, "model/stl");
  assert.deepEqual(p.feed, feed, "feed stays, so the pasted card says it's unlinked");
  assert.deepEqual(p.ports, cad.ports);
  assert.equal(p.createdBy, undefined, "the copy is the person's");
  assert.equal(cad.createdBy, "Wren", "the original is untouched");
});

test("a pasted CAD card is an orphan: no wire comes with it, so it isn't linked", () => {
  const [{ card }] = pasteCards([clipped(cad)], { sectionId: "sec_b" }, { round: 1, now: 9, id: (p) => `${p}_new`, tableNames: [] });
  assert.equal(card.id, "pnl_new");
  assert.equal(card.bornAt, 9);
  const wired = [{ id: "lnk_1", from: { panel: "pnl_bom", port: "cad" }, to: { panel: "pnl_cad", port: "model" } }];
  assert.equal(cadLinked(wired, cad), true);
  assert.equal(cadLinked(wired, card as PanelMeta), false);
});

test("cards whose life is on the server aren't copied; per-card server state never is", () => {
  const huddle: PanelMeta = { ...base, id: "pnl_h", name: "Huddle", panel: "huddle", w: 560, h: 420, ports: [] };
  const agent: PanelMeta = { ...base, id: "pnl_ag", name: "Agent", panel: "agent", w: 420, h: 360, ports: [], sessionId: "s_1" };
  const box: PanelMeta = { ...base, id: "pnl_m", name: "Machine", panel: "machine", w: 760, h: 520, ports: [], machine: { name: "box", state: "absent" } };
  const grid: PanelMeta = { ...base, id: "pnl_g", name: "Child", panel: "grid", w: 720, h: 520, ports: [], board: "b_2" };
  for (const o of [huddle, agent, box, grid]) assert.ok("refuse" in clipOf(o), `${o.panel} is refused`);
  // a machine reached by URL is only a page: it copies, and per-card state is dropped
  const remote: PanelMeta = { ...base, id: "pnl_r", name: "Desk", panel: "machine", w: 760, h: 520, ports: [], url: "https://desk.example/vnc", status: "idle", sessionId: "x" };
  const c = clipped(remote).card as PanelMeta;
  assert.equal(c.url, "https://desk.example/vnc");
  assert.equal(c.status, undefined);
  assert.equal(c.sessionId, undefined);
  // still uploading: nothing to copy yet
  assert.ok("refuse" in clipOf({ ...cad, status: "running" }));
  const pic: MediaMeta = { ...base, id: "media_1", name: "shot.png", w: 200, h: 100, src: "blob:x", media: "image", autoplay: false, muted: true };
  assert.ok("refuse" in clipOf(pic));
  assert.ok("clip" in clipOf({ ...pic, src: "/files/f_9" }));
});

test("a note keeps its text, a table its cells and gets a name of its own, a map follows a table copied with it", () => {
  const note: NoteMeta = { ...base, id: "note_1", name: "Note 1", w: 480, h: 320, text: "Wall 2 mm, PETG" };
  const table: TableMeta = { ...base, id: "table_1", name: "Parts", cols: 4, rows: 8, pinned: true };
  const map: MapMeta = { ...base, id: "map_1", name: "Map", w: 400, h: 300, sourceTableId: "table_1", pitched: false };
  let k = 0;
  const out = pasteCards([clipped(note), clipped(table, { "0,0": "Hub", "1,0": "=A1" }), clipped(map)], { sectionId: "sec_a" }, { round: 1, now: 5, id: (p) => `${p}_n${++k}`, tableNames: ["Parts", "Parts copy"] });
  assert.equal((out[0].card as NoteMeta).text, "Wall 2 mm, PETG");
  const t = out[1].card as TableMeta;
  assert.equal(t.name, "Parts copy 2");
  assert.equal(t.pinned, undefined, "one pinned card to a section: the copy is a card");
  assert.deepEqual(out[1].cells, { "0,0": "Hub", "1,0": "=A1" });
  assert.equal((out[2].card as MapMeta).sourceTableId, t.id);
  assert.equal(new Set(out.map((o) => o.card.id)).size, 3);
  assert.ok(out.every((o) => !["note_1", "table_1", "map_1"].includes(o.card.id)));
});

test("a paste never lands exactly on top", () => {
  const o = { sectionId: "sec_a", x: 40, y: 60, float: true };
  // back into its own section: a step per paste
  assert.deepEqual(placeFor(o, { sectionId: "sec_a" }, 0, 1), { sectionId: "sec_a", x: 40 + PASTE_STEP, y: 60 + PASTE_STEP, float: true });
  assert.deepEqual(placeFor(o, { sectionId: "sec_a" }, 0, 2), { sectionId: "sec_a", x: 40 + 2 * PASTE_STEP, y: 60 + 2 * PASTE_STEP, float: true });
  // under the pointer: there, the next ones a step down and right
  assert.deepEqual(placeFor(o, { sectionId: "sec_b", at: { x: 100, y: 10 } }, 1, 1), { sectionId: "sec_b", x: 100 + PASTE_STEP, y: 10 + PASTE_STEP, float: true });
  assert.deepEqual(placeFor(o, { sectionId: "sec_b", at: { x: -20, y: -5 } }, 0, 1), { sectionId: "sec_b", x: 0, y: 0, float: true });
  // elsewhere, or a card in the flow: it joins the flow, which lays it out beside the others
  assert.deepEqual(placeFor(o, { sectionId: "sec_b" }, 0, 1), { sectionId: "sec_b", x: 0, y: 0, float: false });
  assert.deepEqual(placeFor({ ...o, float: false }, { sectionId: "sec_a" }, 0, 1), { sectionId: "sec_a", x: 0, y: 0, float: false });
});

test("the OS clipboard marker names one copy, and nothing else reads as one", () => {
  assert.equal(parseMarker(markerOf(1732540000000)), 1732540000000);
  assert.equal(parseMarker(" foundation-cards:7\n"), 7);
  for (const t of ["", null, undefined, "foundation-cards:", "foundation-cards:7 and more", "hello"]) assert.equal(parseMarker(t), null);
  assert.equal(copyName("Parts", []), "Parts copy");
  assert.equal(copyName("Parts", ["parts COPY"]), "Parts copy 2");
});

test("a fed CAD card says where its model comes from, and an unlinked one says it keeps its last model", () => {
  const now = Date.UTC(2026, 10, 25, 15, 0);
  const f: CadFeed = { ...feed, checkedAt: now - 10_000, changedAt: now - 3 * 3600_000 };
  const ok = feedWords(f, true, now);
  assert.equal(ok.source, "From Airform BOM · Fan hub, rev C");
  assert.equal(ok.when, "changed 3 h ago · checked just now");
  assert.equal(ok.tone, "ok");
  assert.equal(ok.note, null);
  const waiting = feedWords({ ...f, state: "waiting", note: "waiting for a person's Allow on Airform BOM's card" }, true, now);
  assert.equal(waiting.tone, "waiting");
  assert.match(waiting.note ?? "", /Allow on Airform BOM/);
  const bad = feedWords({ ...f, state: "error", note: "no part FH-210" }, true, now);
  assert.equal(bad.tone, "error");
  assert.equal(bad.note, "no part FH-210");
  const orphan = feedWords({ ...f, state: "error", note: "no part FH-210" }, false, now);
  assert.equal(orphan.tone, "unlinked");
  assert.equal(orphan.note, "Unlinked: keeps its last model");
  assert.equal(orphan.when, "changed 3 h ago");
  assert.equal(feedWords({ ...feed, label: undefined }, true, now).when, "", "never fetched: no times to show");
});

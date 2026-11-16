/**
 * Grids of grids, the agents assigned to a place, a person's settings, and Foundation's own grids
 * (2026-11-15).
 *
 *  - A grid put inside another gets a section on its parent that stands for it; taken out, that
 *    section goes; a loop is refused; the link wears the child's name.
 *  - An agent assigned to a section stays there (in the board's `agents` map, which only the server
 *    writes); what it is (service, cloud or local) is the server's reading, never the request's.
 *  - A setting is one of its known values, per person.
 *  - The plan and the design language are laid out once, as cards on a grid.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_AGENT_SCRIPT = "1";

const { createBoardRow, listBoards, setBoardParent, updateBoardRow, getBoard, closeBoards, editBoard, SERVER_MAPS } = await import("../src/boards.ts");
const { upsertUser } = await import("../src/auth.ts");
const { availableAgents, postAgent, unpostAgent, providerOfT3 } = await import("../src/posted.ts");
const { prefsOf, setPref, computerUseDefault } = await import("../src/prefs.ts");
const { openSystemGrid, SYSTEM_GRIDS } = await import("../src/systemgrids.ts");
const { joinCrew, leaveCrew, _resetCrew } = await import("../src/crew.ts");
const { DESIGN_CHAPTERS, GRID_PLACE, appendSection, boardMaps, postedAgentsOf } = await import("@foundation/protocol");

after(() => {
  _resetCrew();
  closeBoards();
});

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const row = (id: string) => listBoards().find((b) => b.id === id)!;
const links = (boardId: string) => [...boardMaps(getBoard(boardId).doc).objects.values()].filter((o) => o.kind === "panel" && o.panel === "grid");
const seed = (id: string) => editBoard(id, "test", (d) => appendSection(d, "Section 1"));

test("a grid put inside another: the row says so, and the parent grid gets a section that stands for it", () => {
  const fans = createBoardRow("Fans");
  const rim = createBoardRow("Rim drive");
  seed(fans);
  assert.equal(row(rim).parent, null);
  assert.deepEqual(setBoardParent(rim, fans), { ok: true });
  assert.equal(row(rim).parent, fans);
  const [card] = links(fans);
  assert.ok(card && card.kind === "panel");
  assert.equal(card.board, rim);
  assert.equal(card.name, "Rim drive");
  const m = boardMaps(getBoard(fans).doc);
  const sec = m.sections.get(card.sectionId)!;
  assert.equal(sec.host, card.id, "the card fills a section of its own");
  assert.equal(sec.name, "Rim drive");
  // again: nothing is made twice
  setBoardParent(rim, fans);
  assert.equal(links(fans).length, 1);
});

test("the section that stands for a child wears its name", () => {
  const fans = listBoards().find((b) => b.name === "Fans")!.id;
  const rim = listBoards().find((b) => b.name === "Rim drive")!.id;
  updateBoardRow(rim, { name: "Rim drive, rev B" });
  const [card] = links(fans);
  assert.equal(card.name, "Rim drive, rev B");
  assert.equal(boardMaps(getBoard(fans).doc).sections.get(card.sectionId)!.name, "Rim drive, rev B");
});

test("a loop is refused, in words; a page can't hold grids", () => {
  const fans = listBoards().find((b) => b.name === "Fans")!.id;
  const rim = listBoards().find((b) => b.name.startsWith("Rim drive"))!.id;
  const blade = createBoardRow("Blade");
  setBoardParent(blade, rim);
  assert.match((setBoardParent(fans, blade) as { error: string }).error, /inside Fans already/);
  assert.match((setBoardParent(fans, fans) as { error: string }).error, /inside itself/);
  assert.equal(row(fans).parent, null);
  const page = createBoardRow("Docs", { kind: "page", url: "https://example.com/" });
  assert.match((setBoardParent(blade, page) as { error: string }).error, /web page/);
  assert.match((setBoardParent("nope", fans) as { error: string }).error, /No such grid/);
});

test("moved to another grid, or back to the top: the old parent loses its section, the new one gains it", () => {
  const fans = listBoards().find((b) => b.name === "Fans")!.id;
  const rim = listBoards().find((b) => b.name.startsWith("Rim drive"))!.id;
  const motors = createBoardRow("Motors");
  seed(motors);
  const before = boardMaps(getBoard(fans).doc).sections.size;
  setBoardParent(rim, motors);
  assert.equal(links(fans).length, 0);
  assert.equal(boardMaps(getBoard(fans).doc).sections.size, before - 1, "the section that only stood for it is gone");
  assert.equal(links(motors).length, 1);
  setBoardParent(rim, null);
  assert.equal(row(rim).parent, null);
  assert.equal(links(motors).length, 0);
  // the grids' own sections were never touched
  assert.ok([...boardMaps(getBoard(motors).doc).sections.values()].some((s) => s.name === "Section 1"));
});

test("a section that stood for a child and holds something else is kept, without the child", () => {
  const top = createBoardRow("Programme");
  const kid = createBoardRow("Budget");
  seed(top);
  setBoardParent(kid, top);
  const [card] = links(top);
  editBoard(top, "test", (d) => {
    boardMaps(d).objects.set("note_x", { id: "note_x", kind: "note", sectionId: card.sectionId, name: "Kept", x: 0, y: 0, w: 200, h: 100, float: true, bornAt: Date.now() } as never);
  });
  setBoardParent(kid, null);
  const m = boardMaps(getBoard(top).doc);
  assert.ok(m.sections.has(card.sectionId));
  assert.equal(m.sections.get(card.sectionId)!.host, undefined);
  assert.ok(m.objects.has("note_x"));
});

test("agents that can be assigned: the server's own first; what each is comes from the server", () => {
  const { agents, t3 } = availableAgents();
  assert.equal(agents[0].key, "claude");
  assert.equal(agents[0].provider, "claude");
  assert.equal(agents[0].ready, true, "the scripted stand-in counts as a runtime in tests");
  assert.equal(t3, "off");
  assert.equal(providerOfT3({ driver: "codex", name: "Codex" }), "chatgpt");
  assert.equal(providerOfT3({ driver: "claudeAgent", name: "Kimi", added: { preset: "kimi", baseUrl: "https://api.moonshot.ai/anthropic" } }), "kimi");
  assert.equal(providerOfT3({ driver: "claudeAgent", name: "DeepSeek", added: { preset: "deepseek", baseUrl: "http://127.0.0.1:11434" } }), "deepseek");
  assert.equal(providerOfT3({ driver: "antigravity", name: "Antigravity" }), "gemini");
  assert.equal(providerOfT3({ driver: "claudeAgent", name: "Claude" }), "claude");
});

test("assigning an agent to a section: once, kept on the grid, said in the activity; taken off again", () => {
  const id = createBoardRow("Supply");
  const sec = seed(id);
  const one = postAgent(id, sec.id, "claude", ada);
  assert.equal(one.length, 1);
  assert.deepEqual({ key: one[0].key, name: one[0].name, where: one[0].where, byName: one[0].byName }, { key: "claude", name: "Claude", where: "cloud", byName: "Ada Lovelace" });
  assert.equal(postAgent(id, sec.id, "claude", ada).length, 1, "the same agent isn't on a council twice");
  assert.equal(postAgent(id, GRID_PLACE, "claude", ada).length, 1, "the grid's council is its own place");
  const doc = getBoard(id).doc;
  assert.equal(postedAgentsOf(doc, sec.id).length, 1);
  assert.ok(boardMaps(doc).activity.toArray().some((a) => /put Claude on the council of Section 1/.test(a.text)));
  assert.throws(() => postAgent(id, "sec_nope", "claude", ada), /No such section/);
  assert.throws(() => postAgent(id, sec.id, "t3:codex", ada), /isn't on this computer right now/);
  assert.throws(() => postAgent(id, sec.id, "gpt-9", ada), /No such agent/);
  assert.equal(unpostAgent(id, sec.id, "claude", ada).length, 0);
  assert.equal(boardMaps(doc).agents.has(sec.id), false);
  assert.equal(postedAgentsOf(doc, GRID_PLACE).length, 1);
});

test("who is on a council can't be forged over a socket: `agents` is the server's map", () => {
  assert.ok((SERVER_MAPS as readonly string[]).includes("agents"));
  const id = createBoardRow("Guarded");
  const sec = seed(id);
  postAgent(id, sec.id, "claude", ada);
  const board = getBoard(id);
  // a change that arrives as a peer's update (its origin is one of the board's sockets) is put back
  const fake = {} as never;
  board.conns.set(fake, { user: ada } as never);
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(board.doc));
  peer.getMap("agents").set(sec.id, [{ key: "evil", name: "Mallory", provider: "agent", where: "cloud", service: "", tools: true, by: "x", byName: "x", at: 1 }]);
  Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(peer), fake);
  board.conns.delete(fake);
  assert.deepEqual(postedAgentsOf(board.doc, sec.id).map((a) => a.key), ["claude"]);
});

test("an agent at work says which agent it is, so a council can seat it where that agent is assigned", () => {
  const id = createBoardRow("Crewed");
  seed(id);
  const own = joinCrew({ boardId: id, userId: ada.id, userName: ada.name, runId: "r1", task: "x" });
  const kimi = joinCrew({ boardId: id, userId: ada.id, userName: ada.name, runId: "r2", task: "x", name: "Kimi", via: "t3:kimi" });
  assert.equal(own.state.crew.via, "claude");
  assert.equal(kimi.state.crew.via, "t3:kimi");
  leaveCrew(own, "done", 0);
  leaveCrew(kimi, "done", 0);
});

test("a person's settings: known keys and values only, each person their own", () => {
  const kai = upsertUser("kai@formindustries.com", "Kai");
  assert.equal(prefsOf(ada.id).computer_use, "ask");
  assert.deepEqual(setPref(ada.id, "computer_use", "never"), { ok: true });
  assert.equal(computerUseDefault(ada.id), "never");
  assert.equal(computerUseDefault(kai.id), "ask");
  assert.match((setPref(ada.id, "computer_use", "always") as { error: string }).error, /one of: ask, never/);
  assert.match((setPref(ada.id, "root", "yes") as { error: string }).error, /No such setting/);
  assert.equal(prefsOf(ada.id).computer_use, "never");
});

test("Foundation's own grids are laid out once: the plan is a kanban in one section, the design language a section a chapter", () => {
  const plan = openSystemGrid("plan");
  assert.deepEqual(plan, { id: SYSTEM_GRIDS.plan.id, made: true });
  assert.equal(openSystemGrid("plan").made, false);
  const pm = boardMaps(getBoard(plan.id).doc);
  assert.equal(pm.sections.size, 1);
  const [sec] = [...pm.sections.values()];
  const card = pm.objects.get(sec.host!)!;
  assert.deepEqual([card.kind === "panel" && card.panel, card.kind === "panel" && card.source], ["kanban", "plan"]);

  const design = openSystemGrid("design");
  const dm = boardMaps(getBoard(design.id).doc);
  assert.equal(dm.sections.size, DESIGN_CHAPTERS.length);
  const sources = [...dm.objects.values()].map((o) => (o.kind === "panel" ? o.source : null)).sort();
  assert.deepEqual(sources, DESIGN_CHAPTERS.map((c) => c.id).sort());
  for (const s of dm.sections.values()) assert.ok(s.host, `${s.name} hosts its chapter`);
  assert.equal(listBoards().find((b) => b.id === design.id)!.name, "Design language");
});

/**
 * Note pages (docs/notes.md): a note of its own in the side pane, the same note on any grid.
 *
 * Invariants: writes name their board (a card's words are written on the page's board, never through the
 * grid that shows it); request_id answers a second call with the first one's result; archiving a page needs
 * confirm and deletes nothing; a viewer of a page can't write it by its socket or a tool, even from a grid
 * they can edit; a members-only page answers only to its members, as a page and on a grid.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";

const { run } = await import("../src/db.ts");
const { upsertUser } = await import("../src/auth.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { runTool } = await import("../src/tools.ts");
const { attachConnection, getBoard, closeBoards, listBoards, setBoardParent, createBoardRow } = await import("../src/boards.ts");
const { makeNotePage, notePageText, isArchivedNote } = await import("../src/notes.ts");
const { boardMaps, appendSection, noteTextOf, setNoteText, describeBoard, NOTE_BODY } = await import("@foundation/protocol");

after(() => closeBoards());

const boss = upsertUser("boss@formindustries.com", "Boss");
const ada = upsertUser("ada@formindustries.com", "Ada");
const kai = upsertUser("kai@formindustries.com", "Kai");

function grid(id: string) {
  const doc = getBoard(id).doc;
  if (boardMaps(doc).sections.size === 0) doc.transact(() => appendSection(doc, "Main"));
  return doc;
}
const as = (who: { id: string; name: string }, boardId: string) => ({ boardId, actor: who.name, userId: who.id, person: true });

test("a note page is a space of kind note whose board holds one note: its words, as markdown", () => {
  const page = makeNotePage({ title: "  Rotor   plan ", markdown: "# Rotor\n\n- [ ] balance it" });
  assert.equal(page.name, "Rotor plan");
  const row = listBoards().find((b) => b.id === page.id)!;
  assert.equal(row.kind, "note");
  const doc = getBoard(page.id).doc;
  const body = boardMaps(doc).objects.get(NOTE_BODY)!;
  assert.equal(body.kind, "note");
  assert.equal(noteTextOf(doc, body), "# Rotor\n\n- [ ] balance it");
  assert.equal(boardMaps(doc).sections.size, 0, "a page has no sections");
  assert.match(describeBoard(doc), /Note page "Rotor plan"[\s\S]*balance it/);
  // unnamed pages take a name nothing else has
  assert.equal(makeNotePage({}).name, "Untitled note");
  assert.equal(makeNotePage({}).name, "Untitled note 2");
});

test("pages nest in pages only, a loop is refused, and a child gets a page line in its parent's words", () => {
  const parent = makeNotePage({ title: "Parent", markdown: "Intro" });
  const child = makeNotePage({ title: "Child", parent: parent.id });
  assert.equal(listBoards().find((b) => b.id === child.id)!.parent, parent.id);
  assert.equal(notePageText(parent.id), `Intro\n\n[Child](note:${child.id})`);
  // the editor puts the line itself: link false leaves the parent's words alone
  const quiet = makeNotePage({ title: "Quiet", parent: parent.id, link: false });
  assert.ok(!notePageText(parent.id).includes(quiet.id));
  const g = createBoardRow("A grid");
  assert.deepEqual(setBoardParent(child.id, g), { error: "A note goes inside another note" });
  assert.deepEqual(setBoardParent(g, parent.id), { error: "A note holds only notes" });
  assert.deepEqual(setBoardParent(parent.id, child.id), { error: "Child is inside Parent already" });
});

test("place_note: the card on the grid is the page's note, not a copy; its words are written on the page's board", async () => {
  const doc = grid("g-place");
  const page = makeNotePage({ title: "Shared", markdown: "first words" });
  const out = (await runTool(as(ada, "g-place"), "place_note", { note: page.id, request_id: "p1" })) as { id: string; note: string };
  const card = boardMaps(doc).objects.get(out.id)!;
  assert.equal(card.kind, "note");
  assert.equal((card as { ref?: string }).ref, page.id);
  assert.equal(boardMaps(doc).noteText.get(out.id), undefined, "the grid keeps no words for it");
  // the same request_id answers again with the first result, and adds nothing
  const again = (await runTool(as(ada, "g-place"), "place_note", { note: page.id, request_id: "p1" })) as { id: string };
  assert.equal(again.id, out.id);
  const cards = [...boardMaps(doc).objects.values()].filter((o) => o.kind === "note");
  assert.equal(cards.length, 1);
  // read through the grid: the page's words
  assert.equal(((await runTool(as(ada, "g-place"), "read_card", { id: out.id })) as { markdown: string }).markdown, "first words");
  // an edit on the page is the card's words at once (one text)
  await runTool(as(ada, page.id), "update_card", { id: NOTE_BODY, markdown: "first words, then more" });
  assert.equal(((await runTool(as(ada, "g-place"), "read_card", { id: out.id })) as { markdown: string }).markdown, "first words, then more");
  // writing the words through the grid is refused: writes name their board
  await assert.rejects(() => runTool(as(ada, "g-place"), "update_card", { id: out.id, markdown: "smuggled" }), /write its words with update_card on that board/);
  assert.equal(notePageText(page.id), "first words, then more");
  // read_board on the grid says what the card shows
  assert.match(String(await runTool(as(ada, "g-place"), "read_board", {})), new RegExp(`shows the note page "${page.id}"`));
});

test("make_note_page: a grid's own note becomes a page, the card stays where it was and shows it", async () => {
  const doc = grid("g-make");
  const made = (await runTool(as(ada, "g-make"), "add_note", { title: "Old markdown note", markdown: "**kept** as written\n\n- a\n- b" })) as { id: string };
  const out = (await runTool(as(ada, "g-make"), "make_note_page", { id: made.id, request_id: "m1" })) as { id: string; card: string };
  assert.equal(out.card, made.id);
  const card = boardMaps(doc).objects.get(made.id) as { ref?: string; name: string };
  assert.equal(card.ref, out.id);
  assert.equal(boardMaps(doc).noteText.get(made.id), undefined, "one copy of the words");
  assert.equal(notePageText(out.id), "**kept** as written\n\n- a\n- b", "nothing rewritten");
  assert.equal(listBoards().find((b) => b.id === out.id)!.name, "Old markdown note");
  // asked again (another request): it is a page already
  const again = (await runTool(as(ada, "g-make"), "make_note_page", { id: made.id })) as { id: string; already?: boolean };
  assert.equal(again.id, out.id);
  assert.equal(again.already, true);
});

test("add_note_page: a page made by a tool, inside a page, placed on the grid named", async () => {
  const doc = grid("g-add");
  const parent = makeNotePage({ title: "Handbook" });
  const out = (await runTool(as(ada, "g-add"), "add_note_page", { title: "Onboarding", markdown: "> [!TIP] start here", parent: parent.id, place: true, request_id: "a1" })) as { id: string; card: string };
  assert.equal(listBoards().find((b) => b.id === out.id)!.parent, parent.id);
  assert.equal((boardMaps(doc).objects.get(out.card) as { ref?: string }).ref, out.id);
  assert.match(notePageText(parent.id), new RegExp(`\\[Onboarding\\]\\(note:${out.id}\\)`));
  const again = (await runTool(as(ada, "g-add"), "add_note_page", { title: "Onboarding", parent: parent.id, place: true, request_id: "a1" })) as { id: string };
  assert.equal(again.id, out.id, "the same request makes one page");
  assert.equal(listBoards().filter((b) => b.name === "Onboarding").length, 1);
});

test("archiving a page needs confirm, deletes nothing, and moves its children up", async () => {
  const doc = grid("g-arch");
  const page = makeNotePage({ title: "Old plan", markdown: "keep me" });
  const kid = makeNotePage({ title: "Old plan detail", parent: page.id });
  const placed = (await runTool(as(ada, "g-arch"), "place_note", { note: page.id })) as { id: string };
  assert.match(String(await runTool(as(ada, page.id), "archive_note_page", { confirm: false })), /not archived/);
  assert.ok(listBoards().some((b) => b.id === page.id));
  await runTool(as(ada, page.id), "archive_note_page", { confirm: true });
  assert.ok(!listBoards().some((b) => b.id === page.id), "it leaves the lists");
  assert.ok(isArchivedNote(page.id));
  assert.equal(listBoards().find((b) => b.id === kid.id)!.parent ?? null, null, "its child moved up to the top");
  assert.equal(noteTextOf(getBoard(page.id).doc, boardMaps(getBoard(page.id).doc).objects.get(NOTE_BODY)!), `keep me

[Old plan detail](note:${kid.id})`, "its words stay");
  assert.ok(boardMaps(doc).objects.get(placed.id), "the card on the grid stays");
  assert.equal(((await runTool(as(ada, "g-arch"), "read_card", { id: placed.id })) as { archived?: boolean }).archived, true);
  // a grid card can't be placed for an archived page
  await assert.rejects(() => runTool(as(ada, "g-arch"), "place_note", { note: page.id }), /No note page/);
  // archive_note_page runs only on a note page's own board
  await assert.rejects(() => runTool(as(ada, "g-arch"), "archive_note_page", { confirm: true }), /No note page/);
});

test("a viewer of a page can't write it: not by a tool, not by its socket, not from a grid they edit", async () => {
  grid("g-view");
  const page = makeNotePage({ title: "Read only for Kai", markdown: "as written" });
  setBoardRole(boss, page.id, kai.id, "viewer");
  // Kai can put it on a grid he edits (that writes the grid), and read it there
  const placed = (await runTool(as(kai, "g-view"), "place_note", { note: page.id })) as { id: string };
  assert.equal(((await runTool(as(kai, "g-view"), "read_card", { id: placed.id })) as { markdown: string }).markdown, "as written");
  // but the words are the page's, and the page says view only
  await assert.rejects(() => runTool(as(kai, page.id), "update_card", { id: NOTE_BODY, markdown: "mine" }), /View only/);
  await assert.rejects(() => runTool(as(kai, page.id), "archive_note_page", { confirm: true }), /View only/);
  await assert.rejects(() => runTool(as(kai, "g-view"), "update_card", { id: placed.id, markdown: "mine" }), /that board/);
  await assert.rejects(() => runTool(as(kai, "g-view"), "add_note_page", { title: "Inside", parent: page.id }), /View only/);
  // the page's socket, as a viewer's (attachConnection's readOnly is the page's role): the update is dropped
  const doc = getBoard(page.id).doc;
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(doc));
  local.transact(() => setNoteText(local, NOTE_BODY, "smuggled in"));
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(local, Y.encodeStateVector(doc)));
  const ws = Object.assign(new EventEmitter(), { readyState: 1, binaryType: "", sent: [] as Uint8Array[], send(d: Uint8Array) { this.sent.push(d); }, close() {} });
  attachConnection(page.id, ws as never, true, kai.id);
  ws.emit("message", Buffer.from(encoding.toUint8Array(enc)));
  assert.equal(notePageText(page.id), "as written");
});

test("a members-only page answers only to its members: not placed, not read through a grid", async () => {
  grid("g-secret");
  const page = makeNotePage({ title: "Board minutes", markdown: "secret words" });
  run("insert into board_members (board_id, user_id, role, source, added_at) values (?, ?, 'editor', 'test', ?)", page.id, ada.id, Date.now());
  await assert.rejects(() => runTool(as(kai, "g-secret"), "place_note", { note: page.id }), /No note page/);
  const placed = (await runTool(as(ada, "g-secret"), "place_note", { note: page.id })) as { id: string };
  const kaiReads = (await runTool(as(kai, "g-secret"), "read_card", { id: placed.id })) as { markdown: string | null; locked?: string };
  assert.equal(kaiReads.markdown, null);
  assert.ok(kaiReads.locked);
  assert.ok(!JSON.stringify(kaiReads).includes("secret words"));
  assert.equal(((await runTool(as(ada, "g-secret"), "read_card", { id: placed.id })) as { markdown: string }).markdown, "secret words");
  // a page Kai can't see isn't one he can nest into either
  await assert.rejects(() => runTool(as(kai, "g-secret"), "add_note_page", { title: "x", parent: page.id }), /No note page/);
});

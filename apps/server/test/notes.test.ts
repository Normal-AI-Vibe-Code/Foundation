/**
 * Notes two people can type in (schema 3): a note's text is a Y.Text, and the
 * editor (CodeMirror through y-codemirror.next, since 2026-11-08) turns each
 * keystroke into its own insert or delete at the writer's caret. Writes from
 * tools are the smallest edit, and boards from before move their text over
 * once. The writers here type the way the editor does: one character at a
 * time at a caret that someone else's words move past (an insert exactly at
 * the caret lands after it, as CodeMirror maps a cursor).
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

// the person the tools act for: a member (an unknown id would be a viewer, and viewers can't write)
const { run: runSql } = await import("../src/db.ts");
runSql("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, 'member', ?)", "u1", "u1@formindustries.com", "Tester", "#325bb4", Date.now());
const { boardMaps, noteTextOf, putNote, setNoteText, textDiff, BOARD_SCHEMA } = await import("@foundation/protocol");
const { migrateBoard } = await import("../src/migrate.ts");
const { runTool } = await import("../src/tools.ts");
const { getBoard, editBoard, closeBoards } = await import("../src/boards.ts");

after(() => closeBoards());

/** two replicas of one board, exchanging updates both ways */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const queue: Array<[Y.Doc, Uint8Array]> = [];
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "net" && queue.push([b, u]));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "net" && queue.push([a, u]));
  const deliver = () => {
    while (queue.length) {
      const [to, u] = queue.shift()!;
      Y.applyUpdate(to, u, "net");
    }
  };
  return { a, b, deliver };
}

const EDITOR = Symbol("editor");

/**
 * Someone writing in a note's open editor: a caret in their replica, moved by
 * what arrives from others the way CodeMirror maps a cursor, and each key one
 * insert at it (y-codemirror's sync writes a change where it happened).
 */
function writer(doc: Y.Doc, id: string, at: number) {
  const t = boardMaps(doc).noteText.get(id)!;
  let caret = at;
  t.observe((e) => {
    if (e.transaction.origin === EDITOR) return;
    let pos = 0;
    for (const d of e.delta) {
      if (d.retain) pos += d.retain;
      else if (typeof d.insert === "string") {
        if (pos < caret) caret += d.insert.length;
        pos += d.insert.length;
      } else if (d.delete) {
        if (pos < caret) caret -= Math.min(d.delete, caret - pos);
      }
    }
  });
  return {
    key(ch: string) {
      doc.transact(() => t.insert(caret, ch), EDITOR);
      caret += ch.length;
    },
    type(s: string) {
      for (const ch of s) this.key(ch);
    },
  };
}

const NOTE = { kind: "note" as const, sectionId: "s", name: "Plan", x: 0, y: 0, float: false, bornAt: 1, w: 400, h: 300 };

test("textDiff is the one middle edit", () => {
  assert.deepEqual(textDiff("hello world", "hello brave world"), { at: 6, remove: 0, insert: "brave " });
  assert.deepEqual(textDiff("abc", "ac"), { at: 1, remove: 1, insert: "" });
  assert.equal(textDiff("same", "same"), null);
});

test("two people typing in one note at once both keep their words", () => {
  const { a, b, deliver } = pair();
  a.transact(() => putNote(a, { ...NOTE, id: "note_1", text: "Goals:\n\nRisks:\n" }));
  deliver();
  // at the same moment: one writes under Goals, the other under Risks, keys interleaved as they cross the wire
  const ada = writer(a, "note_1", "Goals:\n".length);
  const kai = writer(b, "note_1", "Goals:\n\nRisks:\n".length);
  const [sa, sk] = ["- ship the fan\n", "- supplier slip\n"];
  for (let i = 0; i < Math.max(sa.length, sk.length); i++) {
    if (sa[i]) ada.key(sa[i]);
    if (sk[i]) kai.key(sk[i]);
    if (i % 3 === 0) deliver();
  }
  deliver();
  const want = "Goals:\n- ship the fan\n\nRisks:\n- supplier slip\n";
  assert.equal(noteTextOf(a, { id: "note_1" }), want);
  assert.equal(noteTextOf(b, { id: "note_1" }), want);
  // the card itself was never rewritten by typing
  assert.equal((boardMaps(a).objects.get("note_1") as { text?: string }).text, undefined);
});

test("two people typing into the very same word keep both words whole, never interleaved", () => {
  // every rhythm of delivery: after each key, every few keys, or only at the end
  for (const every of [1, 2, 3, 5, 1000]) {
    const { a, b, deliver } = pair();
    a.transact(() => putNote(a, { ...NOTE, id: "note_w", text: "- supplier slip\n" }));
    deliver();
    const at = "- sup".length;
    const ada = writer(a, "note_w", at);
    const kai = writer(b, "note_w", at);
    const [sa, sk] = ["[ada words]", "(kai words)"];
    for (let i = 0; i < sa.length; i++) {
      ada.key(sa[i]);
      kai.key(sk[i]);
      if (i % every === 0) deliver();
    }
    deliver();
    const got = noteTextOf(a, { id: "note_w" });
    assert.equal(noteTextOf(b, { id: "note_w" }), got);
    assert.ok([`- sup${sa}${sk}plier slip\n`, `- sup${sk}${sa}plier slip\n`].includes(got), `delivered every ${every}: ${JSON.stringify(got)}`);
  }
});

test("setNoteText writes the smallest edit, so a concurrent typist survives an agent's update", () => {
  const { a, b, deliver } = pair();
  a.transact(() => putNote(a, { ...NOTE, id: "note_2", name: "N", text: "Status: draft\n\nNotes" }));
  deliver();
  // the agent flips the status line while a person types at the end
  const noa = writer(b, "note_2", "Status: draft\n\nNotes".length);
  a.transact(() => setNoteText(a, "note_2", "Status: approved\n\nNotes"));
  noa.type(" from");
  deliver();
  noa.type(" Noa");
  deliver();
  assert.equal(noteTextOf(a, { id: "note_2" }), "Status: approved\n\nNotes from Noa");
  assert.equal(noteTextOf(b, { id: "note_2" }), noteTextOf(a, { id: "note_2" }));
});

test("schema 3: an older board's note text moves into its Y.Text once; tools read and write through it", async () => {
  const id = "notes-mig";
  editBoard(id, "test", (doc) => {
    const m = boardMaps(doc);
    m.meta.set("schema", 2);
    m.sections.set("sec_a", { id: "sec_a", name: "A", c0: 0, r0: 0, c1: 0, r1: 0 });
    m.objects.set("note_old", { id: "note_old", kind: "note", sectionId: "sec_a", name: "Old", x: 0, y: 0, float: false, bornAt: 1, w: 400, h: 300, text: "legacy words" });
  });
  assert.equal(migrateBoard(id), true);
  const doc = getBoard(id).doc;
  const m = boardMaps(doc);
  assert.equal(m.meta.get("schema"), BOARD_SCHEMA);
  assert.equal((m.objects.get("note_old") as { text?: string }).text, undefined);
  assert.equal(noteTextOf(doc, { id: "note_old" }), "legacy words");
  assert.equal(migrateBoard(id), false);

  const ctx = { boardId: id, actor: "test", userId: "u1" };
  const made = (await runTool(ctx, "add_note", { section: "A", title: "Fresh", markdown: "first draft" })) as { id: string };
  assert.equal(noteTextOf(doc, { id: made.id }), "first draft");
  await runTool(ctx, "update_card", { id: made.id, markdown: "second draft" });
  assert.equal(noteTextOf(doc, { id: made.id }), "second draft");
  assert.match(String(await runTool(ctx, "read_board", {})), /second draft/);
  await runTool(ctx, "delete_card", { id: made.id, confirm: true });
  assert.equal(m.noteText.has(made.id), false);
});

/**
 * A ChatForm conversation on a grid (`panel: "chat"`, 2026-11-25): `add_chat_card` is a board write like any card
 * (writes name their board; refused for a viewer of it; the same `request_id` is the first call's answer; asked
 * twice for a section, added once), and the board keeps a reference only: the conversation's id, and a name only
 * when the channel is open. A private channel's name, a direct message's people and every message stay ChatForm's;
 * someone who can't see the conversation can't put it on a grid, and is answered as if it didn't exist.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-chatcard-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
delete process.env.FOUNDATION_CHAT_PREVIEWS;

const { run } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const chat = await import("../src/chat.ts");
const { runTool, TOOLS } = await import("../src/tools.ts");
const { closeBoards, createBoardRow, editBoard, getBoard } = await import("../src/boards.ts");
const { boardMaps, appendSection } = await import("@foundation/protocol");
const Y = await import("yjs");

const ada = auth.upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = auth.upsertUser("kai@formindustries.com", "Kai Moreno");
const cy = auth.upsertUser("cy@formindustries.com", "Cy Twombly");
for (const u of [ada, kai, cy]) run("update users set role = 'member' where id = ?", u.id);

after(() => closeBoards());

function grid(name: string) {
  const id = createBoardRow(name);
  const sec = editBoard(id, "system", (doc) => appendSection(doc, "Brackets"));
  return { id, section: sec.id };
}
const cards = (board: string) => [...boardMaps(getBoard(board).doc).objects.values()].filter((o) => o.kind === "panel" && o.panel === "chat");
const as = (u: { id: string; name: string }, board: string, person = true) => ({ boardId: board, actor: u.name, userId: u.id, person });
const status = (n: number) => (e: Error & { status?: number }) => e.status === n;

test("add_chat_card puts an open channel on the named grid once, with its #name and nothing else of it", async () => {
  const general = chat.ensureGeneral();
  chat.postMessage(general.id, chat.personParty(ada), { text: "the torque spec is 14 Nm, don't tell the board" });
  const g = grid("Chat cards");
  const other = grid("Another grid");
  const one = (await runTool(as(ada, g.id), "add_chat_card", { channel: general.id })) as { id: string; section: string; channel: string };
  assert.equal(one.section, g.section);
  assert.equal(one.channel, general.id);
  const card = boardMaps(getBoard(g.id).doc).objects.get(one.id)!;
  assert.ok(card.kind === "panel" && card.panel === "chat");
  if (card.kind !== "panel") return;
  assert.equal(card.channel, general.id);
  assert.equal(card.name, `#${general.name}`);
  assert.equal(card.chatServer, undefined, "Foundation's own chat: no server named");
  assert.equal(`${card.w}×${card.h}`, "400×560");
  // exactly these fields: no topic, no members, no kind, no text
  assert.deepEqual(Object.keys(card).sort(), ["bornAt", "channel", "createdBy", "float", "h", "id", "kind", "name", "panel", "ports", "sectionId", "w", "x", "y"]);
  // asked twice for the section, added once; an agent working for Ada gets the same card
  const again = (await runTool(as(ada, g.id, false), "add_chat_card", { channel: general.id, section: g.section })) as { id: string };
  assert.equal(again.id, one.id);
  assert.equal(cards(g.id).length, 1);
  // the write named its board: the other grid has nothing
  assert.equal(cards(other.id).length, 0);
  // nothing said in the conversation is in the board's document
  const bytes = Buffer.from(Y.encodeStateAsUpdate(getBoard(g.id).doc)).toString("latin1");
  assert.ok(!bytes.includes("torque spec"), "no message text on the board");
});

test("the same request_id is answered with the first card", async () => {
  const general = chat.ensureGeneral();
  const g = grid("Idempotent");
  const second = editBoard(g.id, "system", (doc) => appendSection(doc, "Elsewhere"));
  const a = (await runTool(as(ada, g.id), "add_chat_card", { channel: general.id, section: g.section, request_id: "rq-chat-1" })) as { id: string };
  // a retry of that request, even pointing at another section, is the first call's answer
  const b = (await runTool(as(ada, g.id), "add_chat_card", { channel: general.id, section: second.id, request_id: "rq-chat-1" })) as { id: string };
  assert.equal(b.id, a.id);
  assert.equal(cards(g.id).length, 1);
  // a new request for the other section adds its own card there
  const c = (await runTool(as(ada, g.id), "add_chat_card", { channel: general.id, section: second.id, request_id: "rq-chat-2" })) as { id: string; section: string };
  assert.notEqual(c.id, a.id);
  assert.equal(c.section, second.id);
});

test("a viewer of the grid is refused, though they can read the conversation", async () => {
  const general = chat.ensureGeneral();
  const g = grid("View only");
  run("insert into board_roles (board_id, user_id, role, set_at) values (?, ?, 'viewer', ?)", g.id, kai.id, Date.now());
  await assert.rejects(runTool(as(kai, g.id), "add_chat_card", { channel: general.id }), status(403));
  assert.equal(cards(g.id).length, 0);
});

test("a private channel and a direct message: only someone in it can place it, and the board never gets its name", async () => {
  const g = grid("Private");
  const slug = `launch-secret-${Date.now().toString(36)}`;
  const priv = chat.createChannel(chat.personParty(ada), { kind: "private", name: slug, topic: "the unannounced thing" });
  // Cy isn't in it: it answers like a conversation that doesn't exist, and nothing is added
  await assert.rejects(runTool(as(cy, g.id), "add_chat_card", { channel: priv.id }), status(404));
  await assert.rejects(runTool(as(cy, g.id), "add_chat_card", { channel: "ch_nope" }), status(404));
  assert.equal(cards(g.id).length, 0);
  // Ada is: the card is a reference under a plain word
  const one = (await runTool(as(ada, g.id), "add_chat_card", { channel: priv.id })) as { id: string };
  const card = boardMaps(getBoard(g.id).doc).objects.get(one.id)!;
  assert.equal(card.name, "Conversation");
  const dm = chat.openDirect([chat.personParty(ada), chat.personParty(kai)]);
  const two = (await runTool(as(ada, g.id), "add_chat_card", { channel: dm.id })) as { id: string };
  assert.equal(boardMaps(getBoard(g.id).doc).objects.get(two.id)!.name, "Conversation");
  const bytes = Buffer.from(Y.encodeStateAsUpdate(getBoard(g.id).doc)).toString("latin1");
  assert.ok(!bytes.includes(slug), "the private channel's name isn't in the board's document");
  assert.ok(!bytes.includes("unannounced"), "nor its topic");
  assert.ok(!bytes.includes("Kai Moreno"), "nor who a direct message is with");
});

test("the tool says what it does to an agent, and is a write", () => {
  const t = TOOLS.find((x) => x.name === "add_chat_card")!;
  assert.ok(t, "add_chat_card is one of the board's tools");
  assert.equal((t as { write?: boolean }).write, true);
  assert.match(t.description, /reference/);
});

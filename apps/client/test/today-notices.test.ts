/**
 * Today's Notifications, the pure part (src/today/noticesLogic.ts): the bell's list of what was said to me and the
 * notes that tag me on a grid, newest first; each row's link lands where it happened (a chat message in its channel,
 * a reply in its thread, a note framed on its grid); seen follows the bell's; a server with no list falls back to
 * Today's own chat items; the rows are capped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ChatParty } from "@foundation/protocol";
import { noticeHref, placeHref, todayNotices } from "../src/today/noticesLogic";
import type { Notice } from "../src/chat/notifyLogic";
import type { FocusItem } from "../src/today/model";

const NOW = 1_800_000_000_000;
const KAI: ChatParty = { kind: "person", id: "u_kai", name: "Kai Moreno" } as ChatParty;
const WREN: ChatParty = { kind: "agent", id: "Wren", name: "Wren", via: "claude", forName: "Kai" } as ChatParty;
const msg = (id: string, author: ChatParty, at: number, text: string, channel: string, seq: number, root: string | null = null): ChatMessage =>
  ({ id, channel, seq, author, type: "text", text, root, createdAt: at, editedAt: null, deletedAt: null, files: [], reactions: [], replyCount: 0, lastReplyAt: null, pinned: false, mentions: [] }) as ChatMessage;

const NOTICES: Notice[] = [
  { id: "m1", why: "mention", channel: { id: "c rim", name: "rim-drive", kind: "open" }, message: msg("m1", KAI, NOW - 60_000, "@ada the stator", "c rim", 41, "root1") },
  { id: "m2", why: "direct", channel: { id: "dm1", name: "Kai Moreno", kind: "dm" }, message: msg("m2", KAI, NOW - 3_600_000, "got a minute?", "dm1", 3) },
  { id: "m3", why: "everyone", channel: { id: "gen", name: "general", kind: "open" }, message: msg("m3", WREN, NOW - 7_200_000, "@channel the report", "gen", 88) },
];
const TAG: FocusItem = { id: "mention:motors:note1", kind: "mention", title: "@Ada sign off the loads", why: "You're tagged in a note on Motors", board: "motors", boardName: "Motors", objectId: "note1", sectionId: "s1", sectionName: "Rim drive", href: "http://x/?board=motors&focus=note1", at: NOW - 1_800_000 };
const ASK: FocusItem = { id: "ask:a", kind: "ask", title: "Upload the STEP", why: "Kai asked you", board: "motors", boardName: "Motors", href: "#", at: NOW };
const CHAT_ITEM: FocusItem = { id: "message:dm1", kind: "message", title: "got a minute?", why: "1 new from Kai Moreno · 1 h ago", board: "chat", boardName: "ChatForm", href: "#/chat/chat/dm1/at/3", at: NOW - 3_600_000 };

test("the links land where it happened: a message in its channel, a reply in its thread, a note framed on its grid", () => {
  assert.equal(noticeHref(NOTICES[1]), "#/chat/chat/dm1/at/3");
  assert.equal(noticeHref(NOTICES[0]), "#/chat/chat/c%20rim/thread/root1/at/41");
  assert.equal(placeHref("motors", "note1"), "/?board=motors&focus=note1");
  assert.equal(placeHref("a b"), "/?board=a%20b");
});

test("chat and grid together, newest first; asks stay Todos; the grid row says its section", () => {
  const rows = todayNotices({ notices: NOTICES, seen: { allAt: 0, ids: ["m3"] }, focus: [ASK, TAG, CHAT_ITEM] });
  assert.deepEqual(rows.map((r) => r.id), ["chat:m1", "mention:motors:note1", "chat:m2", "chat:m3"]);
  const [mention, tag, dm, everyone] = rows;
  assert.equal(mention.why, "Kai Moreno · #rim-drive · mentioned you");
  assert.equal(dm.why, "Kai Moreno", "a DM says who, not where");
  assert.equal(everyone.tone, "agent");
  assert.deepEqual([mention.unseen, dm.unseen, everyone.unseen], [true, true, false], "seen is the bell's");
  assert.equal(tag.source, "grid");
  assert.equal(tag.why, "Tagged in a note in Rim drive");
  assert.equal(tag.where, "Motors");
  assert.equal(tag.href, "/?board=motors&focus=note1");
  assert.deepEqual(tag.open, { board: "motors", objectId: "note1" });
  assert.ok("notice" in mention.open && mention.open.notice.id === "m1", "a chat row opens the bell's notice (so it's seen there too)");
  assert.ok(!rows.some((r) => r.id === "message:dm1"), "with the bell's list, Today's own chat items aren't listed again");
});

test("a server with no list of its own: Today's chat items, each opening at its message", () => {
  const rows = todayNotices({ seen: { allAt: 0, ids: [] }, focus: [CHAT_ITEM, TAG] });
  assert.deepEqual(rows.map((r) => r.id), ["mention:motors:note1", "message:dm1"]);
  assert.deepEqual(rows[1].open, { hash: "#/chat/chat/dm1/at/3" });
  assert.equal(rows[1].href, "#/chat/chat/dm1/at/3");
});

test("a tag with no section still says where; the list is capped", () => {
  const bare = { ...TAG, sectionId: undefined, sectionName: undefined };
  assert.equal(todayNotices({ seen: { allAt: 0, ids: [] }, focus: [bare] })[0].why, "You're tagged in a note on Motors");
  const many = Array.from({ length: 20 }, (_, i) => ({ ...NOTICES[1], id: `d${i}`, message: { ...NOTICES[1].message, id: `d${i}`, createdAt: NOW - i } }));
  assert.equal(todayNotices({ notices: many, seen: { allAt: 0, ids: [] }, focus: [] }).length, 8);
  assert.equal(todayNotices({ notices: many, seen: { allAt: 0, ids: [] }, focus: [], limit: 3 }).length, 3);
});

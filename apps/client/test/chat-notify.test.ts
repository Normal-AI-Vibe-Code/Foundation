/**
 * What was said to me, the pure parts (src/chat/notifyLogic.ts): which arriving message is a notice, which a
 * device is told about, the list and its count, what's seen, the words of a notification, the bell without a
 * server list, and the @channel question. And ChatForm's files on a chat server (src/chat/serverLogic.ts): a GIF
 * is never asked for by width, a picture's kept box, an upload's limit in words; a link preview's shape
 * (src/chat/logic.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chatMentionHandles, type ChatChannelView, type ChatMention, type ChatMessage, type ChatParty } from "@foundation/protocol";
import {
  changeNotice,
  countWords,
  dropChannel,
  everyoneAsk,
  firstLine,
  isSeen,
  lookingAt,
  markAllSeen,
  markSeen,
  mergeNotices,
  noticeFor,
  noticeOf,
  NOTHING_SEEN,
  NOTICE_FRESH_MS,
  readSeen,
  tells,
  tellWords,
  titleWithCount,
  unseenCount,
  waitingRows,
  whyOf,
  type Notice,
} from "../src/chat/notifyLogic.ts";
import { chatPictureTier, isGif, pictureBox, sizeWords, tooBigBefore, uploadFailure, uploadLimitOf } from "../src/chat/serverLogic.ts";
import { parseRest, previewShape, restOf } from "../src/chat/logic.ts";

const NOW = 1_800_000_000_000;
const ME = "u_me";
const ADA: ChatParty = { kind: "person", id: "u_ada", name: "Ada Lovelace" };
const MYSELF: ChatParty = { kind: "person", id: ME, name: "Me" };
const WREN: ChatParty = { kind: "agent", id: "Wren", name: "Wren", forName: "Me" };

let n = 0;
const msg = (author: ChatParty, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => {
  n++;
  return { id: `m_${n}`, channel: "ch_1", seq: n, author, type: "text", text, root: null, createdAt: NOW - 1000, editedAt: null, deletedAt: null, files: [], reactions: [], replyCount: 0, lastReplyAt: null, pinned: false, mentions: [], ...extra };
};
type Ch = Pick<ChatChannelView, "kind" | "me" | "archivedAt">;
const member = (notify: "all" | "mentions" | "none" = "all", readSeq = 0) => ({ channel: "ch_1", readSeq, mentions: 0, notify, starred: false, joinedAt: 0 });
const ch = (kind: ChatChannelView["kind"], me: Ch["me"] = member(), archivedAt: number | null = null): Ch => ({ kind, me, archivedAt });

test("a notice: named anywhere I can read; @channel and @here only where I'm a member; every message in a DM or a group", () => {
  assert.equal(noticeFor(msg(ADA, "@me look", { mentions: [ME] }), ch("open"), ME, NOW), "mention");
  assert.equal(noticeFor(msg(ADA, "@me look", { mentions: [ME] }), ch("open", null), ME, NOW), "mention", "an open channel I haven't joined still tells me I was named");
  assert.equal(noticeFor(msg(ADA, "@channel ship", { mentions: ["channel"] }), ch("open"), ME, NOW), "everyone");
  assert.equal(noticeFor(msg(ADA, "@here lunch", { mentions: ["here"] }), ch("private"), ME, NOW), "everyone");
  assert.equal(noticeFor(msg(ADA, "@channel ship", { mentions: ["channel"] }), ch("open", null), ME, NOW), null, "not a member: @channel isn't to me");
  assert.equal(noticeFor(msg(ADA, "got a minute?"), ch("dm"), ME, NOW), "direct");
  assert.equal(noticeFor(msg(ADA, "the three of us"), ch("group"), ME, NOW), "direct");
  assert.equal(noticeFor(msg(ADA, "just talking"), ch("open"), ME, NOW), null);
  assert.equal(noticeFor(msg(ADA, "to someone else", { mentions: ["u_bob"] }), ch("open"), ME, NOW), null);
  // an agent's answer in my conversation with it is the conversation, not a notice; naming me is
  assert.equal(noticeFor(msg(WREN, "done"), ch("agent"), ME, NOW), null);
  assert.equal(noticeFor(msg(WREN, "@me done", { mentions: [ME] }), ch("open"), ME, NOW), "mention");
});

test("never my own, a removed one, a system line, an agent's unsent draft, brought-in history, a muted or archived conversation", () => {
  assert.equal(noticeFor(msg(MYSELF, "@me a note to self", { mentions: [ME] }), ch("open"), ME, NOW), null);
  assert.equal(noticeFor(msg(MYSELF, "mine"), ch("dm"), ME, NOW), null);
  assert.equal(noticeFor(msg(ADA, "", { mentions: [ME], deletedAt: NOW }), ch("open"), ME, NOW), null);
  assert.equal(noticeFor(msg({ kind: "system", id: "system", name: "ChatForm" }, "Ada joined", { type: "system" }), ch("dm"), ME, NOW), null);
  assert.equal(noticeFor(msg(WREN, "@me a draft reply", { type: "draft", mentions: [ME], outbound: { state: "draft" } }), ch("portal"), ME, NOW), null);
  assert.equal(noticeFor(msg(WREN, "@me still a draft", { mentions: [ME], outbound: { state: "draft" } }), ch("dm"), ME, NOW), null);
  assert.equal(noticeFor(msg(WREN, "@me sent by a person", { mentions: [ME], outbound: { state: "sent" } }), ch("dm"), ME, NOW), "mention");
  assert.equal(noticeFor(msg(ADA, "@me from Slack, years ago", { mentions: [ME], origin: { service: "slack", externalId: "1.2" } }), ch("open"), ME, NOW), null);
  assert.equal(noticeFor(msg(ADA, "@me old", { mentions: [ME], createdAt: NOW - NOTICE_FRESH_MS - 1 }), ch("open"), ME, NOW), null, "old when it lands: history, not news");
  assert.equal(noticeFor(msg(ADA, "@me", { mentions: [ME] }), ch("open", member("none")), ME, NOW), null, "Nothing means nothing");
  assert.equal(noticeFor(msg(ADA, "psst"), ch("dm", member("none")), ME, NOW), null);
  assert.equal(noticeFor(msg(ADA, "@me", { mentions: [ME] }), ch("open", member("mentions")), ME, NOW), "mention");
  assert.equal(noticeFor(msg(ADA, "@me", { mentions: [ME] }), ch("open", member(), NOW), ME, NOW), null, "archived");
  assert.equal(noticeFor(msg(ADA, "@me", { mentions: [ME] }), undefined, ME, NOW), null, "no view of the channel: nothing is told");
  assert.equal(noticeFor(msg(ADA, "@me", { mentions: [ME] }), ch("open"), undefined, NOW), null);
});

test("this device is told only when the setting is on, the browser allows it, and I'm not looking at it", () => {
  const on = { on: true, permission: "granted" as const, looking: false };
  assert.equal(tells("mention", on), true);
  assert.equal(tells("direct", on), true);
  assert.equal(tells(null, on), false);
  assert.equal(tells("mention", { ...on, on: false }), false);
  assert.equal(tells("mention", { ...on, permission: "default" }), false, "never asked: never told");
  assert.equal(tells("mention", { ...on, permission: "denied" }), false);
  assert.equal(tells("mention", { ...on, permission: "unsupported" }), false);
  assert.equal(tells("mention", { ...on, looking: true }), false);
});

test("looking at it: this window has focus and that conversation is open (a reply needs its thread open)", () => {
  const top = { channel: "ch_1", root: null };
  const reply = { channel: "ch_1", root: "m_root" };
  assert.equal(lookingAt(top, { channel: "ch_1", thread: null }, true), true);
  assert.equal(lookingAt(top, { channel: "ch_1", thread: null }, false), false, "the window isn't in front");
  assert.equal(lookingAt(top, { channel: "ch_2", thread: null }, true), false);
  assert.equal(lookingAt(top, { channel: null, thread: null }, true), false, "on a grid, not in ChatForm");
  assert.equal(lookingAt(reply, { channel: "ch_1", thread: null }, true), false, "the thread is shut");
  assert.equal(lookingAt(reply, { channel: "ch_1", thread: "m_root" }, true), true);
  assert.equal(lookingAt(reply, { channel: "ch_1", thread: "m_other" }, true), false);
});

const notice = (id: string, at: number, seq: number, why: Notice["why"] = "mention", channel = "ch_1", kind: ChatChannelView["kind"] = "open"): Notice => ({
  id,
  why,
  channel: { id: channel, name: kind === "dm" ? "Ada Lovelace" : "general", kind },
  message: msg(ADA, `said ${id}`, { id, channel, createdAt: at, seq, mentions: why === "mention" ? [ME] : [] }),
});

test("the list: each message once, newest first, capped; an edit follows, a removal and a gone channel leave", () => {
  const a = notice("a", NOW - 3000, 1), b = notice("b", NOW - 2000, 2), c = notice("c", NOW - 1000, 3);
  let list = mergeNotices([], [a, c]);
  list = mergeNotices(list, [b, { ...a, message: { ...a.message, text: "a, again" } }]);
  assert.deepEqual(list.map((x) => x.id), ["c", "b", "a"]);
  assert.equal(list[2].message.text, "a, again", "the newer copy wins");
  assert.deepEqual(mergeNotices(list, [], 2).map((x) => x.id), ["c", "b"]);
  // the same moment: the higher seq is newer
  assert.deepEqual(mergeNotices([], [notice("x", NOW, 5), notice("y", NOW, 6)]).map((x) => x.id), ["y", "x"]);
  const edited = changeNotice(list, { ...b.message, text: "b, edited" });
  assert.equal(edited.find((x) => x.id === "b")?.message.text, "b, edited");
  assert.deepEqual(changeNotice(list, { ...b.message, deletedAt: NOW }).map((x) => x.id), ["c", "a"]);
  assert.equal(changeNotice(list, msg(ADA, "not in the list")), list, "untouched: the same list");
  assert.deepEqual(dropChannel([...list, notice("d", NOW, 9, "direct", "ch_dm", "dm")], "ch_1").map((x) => x.id), ["d"]);
  assert.equal(dropChannel(list, "ch_none"), list);
});

test("the server's list: why each row is in it", () => {
  const row = (m: Partial<ChatMessage>, kind: ChatChannelView["kind"]): ChatMention => ({ message: msg(ADA, "x", m), channel: { id: "ch_1", name: "general", kind } });
  assert.equal(whyOf(row({ mentions: [ME] }, "open"), ME), "mention");
  assert.equal(whyOf(row({ mentions: [ME] }, "dm"), ME), "mention");
  assert.equal(whyOf(row({ mentions: ["channel"] }, "open"), ME), "everyone");
  assert.equal(whyOf(row({}, "dm"), ME), "direct");
  assert.equal(whyOf(row({}, "group"), ME), "direct");
  const made = noticeOf(row({ mentions: [ME] }, "private"), ME);
  assert.deepEqual([made.id, made.why, made.channel.kind], [made.message.id, "mention", "private"]);
});

test("seen: pressed one by one, Mark all read, and my read mark passing it; a muted conversation never counts", () => {
  const a = notice("a", NOW - 3000, 1), b = notice("b", NOW - 2000, 2), c = notice("c", NOW - 1000, 3);
  const d = notice("d", NOW - 500, 7, "direct", "ch_dm", "dm");
  const list = [d, c, b, a];
  assert.equal(unseenCount(list, NOTHING_SEEN), 4);
  let seen = markSeen(NOTHING_SEEN, "b");
  assert.equal(markSeen(seen, "b"), seen, "pressing it again changes nothing");
  assert.equal(unseenCount(list, seen), 3);
  assert.equal(isSeen(b, seen), true);
  // reading the channel to seq 1 (on any device) sees a
  const channels = { ch_1: { me: member("all", 1) }, ch_dm: { me: member("all", 0) } };
  assert.equal(isSeen(a, seen, channels), true);
  assert.equal(isSeen(c, seen, channels), false);
  assert.equal(unseenCount(list, seen, channels), 2);
  // marked unread from the first message again: a is back
  assert.equal(isSeen(a, seen, { ch_1: { me: member("all", 0) } }), false);
  // muted: in the list, not in the count
  assert.equal(unseenCount(list, seen, { ch_1: { me: member("none", 0) }, ch_dm: { me: member("all", 0) } }), 1);
  seen = markAllSeen(list, NOW);
  assert.equal(unseenCount(list, seen), 0);
  assert.equal(isSeen(notice("later", NOW + 10, 9), seen), false, "what's said after Mark all read is new");
  // a device whose clock runs behind the server's still clears what it shows
  assert.equal(unseenCount(list, markAllSeen(list, NOW - 60_000)), 0);
});

test("seen is read back from the device, whatever is there", () => {
  assert.deepEqual(readSeen(null), NOTHING_SEEN);
  assert.deepEqual(readSeen("not json"), NOTHING_SEEN);
  assert.deepEqual(readSeen("[1,2]"), { allAt: 0, ids: [] });
  assert.deepEqual(readSeen(JSON.stringify({ allAt: 5, ids: ["a", 3, "b"] })), { allAt: 5, ids: ["a", "b"] });
  assert.deepEqual(readSeen(JSON.stringify({ allAt: "soon" })), { allAt: 0, ids: [] });
  let seen = NOTHING_SEEN;
  for (let i = 0; i < 400; i++) seen = markSeen(seen, `n${i}`);
  assert.equal(seen.ids.length, 300, "the pressed ones are capped");
  assert.equal(seen.ids.at(-1), "n399");
});

test("a notification's words: who (and where, for a channel), then the first line as plain words", () => {
  const m = msg(ADA, "**Rev C** is up: see [the grid](https://example.com/g) `now`\nsecond line", { mentions: [ME] });
  assert.equal(firstLine(m), "Rev C is up: see the grid now");
  assert.deepEqual(tellWords({ id: m.id, message: m, channel: { id: "c", name: "fan-shroud", kind: "open" }, why: "mention" }), { title: "Ada Lovelace in #fan-shroud", body: "Rev C is up: see the grid now" });
  assert.equal(tellWords({ id: m.id, message: m, channel: { id: "c", name: "Ada Lovelace", kind: "dm" }, why: "direct" }).title, "Ada Lovelace");
  assert.equal(tellWords({ id: m.id, message: m, channel: { id: "c", name: "Ada Lovelace, Kai Moreno", kind: "group" }, why: "direct" }).title, "Ada Lovelace in Ada Lovelace, Kai Moreno");
  assert.equal(firstLine(msg(ADA, "\n\n  \nthird line is the first with words")), "third line is the first with words");
  assert.equal(firstLine(msg(ADA, "", { files: [{ id: "f", name: "shroud.gif", mime: "image/gif", size: 1 }] })), "shroud.gif");
  assert.equal(firstLine(msg(ADA, "", { files: [{ id: "f", name: "a.png", mime: "image/png", size: 1 }, { id: "g", name: "b.png", mime: "image/png", size: 1 }] })), "2 files");
  const long = firstLine(msg(ADA, "word ".repeat(80)));
  assert.ok(long.length <= 140 && long.endsWith("…"));
  assert.equal(firstLine(msg(ADA, "```\nlet x = 1\n```")), "code");
});

test("the count as shown, and in the window's title", () => {
  assert.equal(countWords(3), "3");
  assert.equal(countWords(128), "99+");
  assert.equal(titleWithCount("Foundation — Today", 3), "(3) Foundation — Today");
  assert.equal(titleWithCount("(3) Foundation — Today", 5), "(5) Foundation — Today", "never stacked");
  assert.equal(titleWithCount("(99+) Foundation — ChatForm", 0), "Foundation — ChatForm");
  assert.equal(titleWithCount("Foundation", 0), "Foundation");
  assert.equal(titleWithCount("(draft) Notes", 2), "(2) (draft) Notes", "only its own count is taken off");
});

test("without a server list the bell shows the conversations with something waiting, as the top bar's badge counts them", () => {
  const view = (id: string, kind: ChatChannelView["kind"], unread: number, mentions: number, extra: Partial<ChatChannelView> = {}, notify: "all" | "mentions" | "none" = "all"): ChatChannelView => ({
    id, kind, name: id, topic: "", purpose: "", createdBy: "u", createdAt: 0, archivedAt: null, lastSeq: 10, lastPostAt: 0, memberCount: 3, unread,
    me: { channel: id, readSeq: 0, mentions, notify, starred: false, joinedAt: 0 },
    ...extra,
  });
  const rows = waitingRows([
    view("general", "open", 9, 0),
    view("design", "private", 4, 2, { lastPostAt: 50, lastText: "sign off?" }),
    view("kai", "dm", 3, 3, { lastPostAt: 90 }),
    view("wren", "agent", 1, 1, { lastPostAt: 70 }),
    view("muted", "dm", 5, 5, {}, "none"),
    view("old", "open", 2, 2, { archivedAt: 1 }),
    { ...view("unjoined", "open", 0, 0), me: null },
  ]);
  assert.deepEqual(rows.map((r) => [r.channel, r.n, r.why]), [["kai", 3, "direct"], ["wren", 1, "direct"], ["design", 2, "mention"]]);
  assert.equal(rows[2].text, "sign off?");
});

test("@channel and @here ask first in a channel of more than five, never in a direct message, never from inside code", () => {
  const big = { kind: "open" as const, memberCount: 12 };
  assert.deepEqual(everyoneAsk("@channel ship day", big, chatMentionHandles), { word: "@channel", people: 12 });
  assert.deepEqual(everyoneAsk("lunch @here?", { kind: "private", memberCount: 6 }, chatMentionHandles), { word: "@here", people: 6 });
  assert.equal(everyoneAsk("@channel ship day", { kind: "open", memberCount: 5 }, chatMentionHandles), null, "a small channel: no question");
  assert.equal(everyoneAsk("@channel", { kind: "group", memberCount: 8 }, chatMentionHandles), null);
  assert.equal(everyoneAsk("type `@channel` to tell everyone", big, chatMentionHandles), null);
  assert.equal(everyoneAsk("@ada.lovelace only you", big, chatMentionHandles), null);
  assert.equal(everyoneAsk("@channel", null, chatMentionHandles), null);
});

// ---------------------------------------------------------------- files on a chat server

test("a GIF is asked for as the file it is, by its type or its name; other pictures by the drawn width", () => {
  assert.equal(isGif({ name: "party.gif", mime: "image/gif" }), true);
  assert.equal(isGif({ name: "pasted", mime: "image/gif" }), true, "a pasted GIF has no extension");
  assert.equal(isGif({ name: "PARTY.GIF", mime: "application/octet-stream" }), true);
  assert.equal(isGif({ name: "gif.png", mime: "image/png" }), false);
  assert.equal(chatPictureTier({ name: "pasted", mime: "image/gif" }, 512), "orig");
  assert.equal(chatPictureTier({ name: "a.gif", mime: "image/gif" }, 256), "orig");
  assert.equal(chatPictureTier({ name: "logo.svg", mime: "image/svg+xml" }, 512), "orig");
  assert.equal(chatPictureTier({ name: "a.png", mime: "image/png" }, 512), 512);
  assert.equal(chatPictureTier({ name: "a.jpg", mime: "image/jpeg" }, 256), 256);
  assert.equal(chatPictureTier({ name: "a.png", mime: "image/png" }, "orig"), "orig");
});

test("a picture's box is kept from the server's width and height, inside 360 by 280, never enlarged", () => {
  assert.deepEqual(pictureBox({ w: 480, h: 300 }), { width: 360, height: 225 });
  assert.deepEqual(pictureBox({ w: 300, h: 900 }), { width: 93, height: 280 });
  assert.deepEqual(pictureBox({ w: 120, h: 80 }), { width: 120, height: 80 });
  assert.equal(pictureBox({}), null);
  assert.equal(pictureBox({ w: 0, h: 10 }), null);
});

test("an upload's limit is read from what the server says, and said in words", () => {
  assert.equal(uploadLimitOf({ maxUpload: 4 * 1024 * 1024 }), 4194304);
  assert.equal(uploadLimitOf({ limits: { upload: 1000 } }), 1000);
  assert.equal(uploadLimitOf({ error: "That file is too big for this chat server: a file here holds at most 4 MB." }), 4194304);
  assert.equal(uploadLimitOf({ error: "at most 512 KB" }), 512 * 1024);
  assert.equal(uploadLimitOf({ error: "no" }), null);
  assert.equal(uploadLimitOf(null), null);
  assert.equal(uploadLimitOf({ features: ["files"] }), null, "a config that doesn't say: nothing is assumed");
  assert.equal(sizeWords(4 * 1024 * 1024), "4 MB");
  assert.equal(sizeWords(6.4 * 1024 * 1024), "6.4 MB");
  assert.equal(sizeWords(300 * 1024), "300 KB");
  const big = { name: "walk.mov", size: 6.4 * 1024 * 1024 };
  assert.equal(uploadFailure(big, 413, { error: "That file is too big for this chat server: a file here holds at most 4 MB." }, "chat.example.app"), "Too big for chat.example.app: it takes files up to 4 MB, and this one is 6.4 MB.");
  // a proxy's 413 with no words: the file's own size, and no limit is made up
  const bare = uploadFailure(big, 413, null, "chat.example.app");
  assert.ok(bare.includes("6.4 MB") && !bare.includes("up to"));
  assert.equal(uploadFailure(big, 413, null, "chat.example.app", 4194304), "Too big for chat.example.app: it takes files up to 4 MB, and this one is 6.4 MB.");
  assert.equal(uploadFailure({ name: "a.png", size: 10 }, 400, { error: "board: chat" }, "x"), "board: chat");
  assert.ok(uploadFailure({ name: "a.png", size: 10 }, 401, { error: "sign in" }, "chat.example.app").includes("Sign in again"));
  assert.ok(uploadFailure({ name: "a.png", size: 10 }, 0, null, "chat.example.app").includes("Can't reach chat.example.app"));
  assert.equal(tooBigBefore(big, null, "x"), null, "no limit known: it's sent, and the server says");
  assert.equal(tooBigBefore({ name: "a.png", size: 10 }, 4194304, "x"), null);
  assert.ok(tooBigBefore(big, 4194304, "chat.example.app")?.includes("up to 4 MB"));
});

test("a link preview: a card of the page's words, or the picture when the link is straight to one", () => {
  assert.equal(previewShape({ url: "https://example.com/a", title: "A page", description: "About it", image: "https://example.com/og.png" }), "card");
  assert.equal(previewShape({ url: "https://example.com/a", title: "A page" }), "card");
  assert.equal(previewShape({ url: "https://media.example.com/ship.gif", image: "https://media.example.com/ship.gif" }), "picture");
  assert.equal(previewShape({ url: "https://media.example.com/ship.gif", title: "ship.gif", image: "https://media.example.com/ship.gif" }), "picture");
  assert.equal(previewShape({ url: "https://example.com/photo.png", title: "A gallery page", image: "https://cdn.example.com/other.png" }), "card");
  assert.equal(previewShape({ url: "https://example.com/x" }), "card");
});

test("Recent mentions is a view of the Chat tab", () => {
  assert.equal(parseRest("mentions").view, "mentions");
  assert.equal(restOf({ view: "mentions" }), "mentions");
  assert.equal(parseRest("ch_1/thread/m_2/at/14").at, 14);
  assert.equal(restOf({ channel: "ch_1", thread: "m_2", at: 14 }), "ch_1/thread/m_2/at/14");
});

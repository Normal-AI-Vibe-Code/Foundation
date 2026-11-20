/**
 * ChatForm's pure parts on the client (src/chat/logic.ts): the timeline's layout (day rules, the New rule,
 * runs of one author within five minutes), a pending message meeting its echo, the composer's @ # : and its
 * toolbar, the quick switcher's fuzzy match, drafts on the device, and the badge's totals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatChannelView, ChatMessage, ChatParty } from "@foundation/protocol";
import {
  applyCompletion,
  applyFormat,
  bumpRoot,
  chatTotals,
  continues,
  failPending,
  findTrigger,
  fuzzyScore,
  layoutTimeline,
  markMentions,
  matchChannels,
  matchMentions,
  mergeMessages,
  parseRest,
  readDraft,
  restOf,
  retryPending,
  settlePending,
  toggleReaction,
  totalsWords,
  upsertMessage,
  writeDraft,
  type PendingMessage,
} from "../src/chat/logic.ts";

const ADA: ChatParty = { kind: "person", id: "u_ada", name: "Ada Lovelace", color: "x" };
const KAI: ChatParty = { kind: "person", id: "u_kai", name: "Kai Moreno" };
const WREN: ChatParty = { kind: "agent", id: "Wren", name: "Wren", forName: "Ada Lovelace" };

const T0 = new Date(2026, 10, 18, 9, 0).getTime();
let n = 0;
function msg(author: ChatParty, at: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  n++;
  return { id: `m_${n}`, channel: "ch_1", seq: n, author, type: "text", text: `hello ${n}`, root: null, createdAt: at, editedAt: null, deletedAt: null, files: [], reactions: [], replyCount: 0, lastReplyAt: null, pinned: false, mentions: [], ...extra };
}

test("a run from one author within five minutes is drawn as one; anyone else, a gap, a day or a card breaks it", () => {
  const a1 = msg(ADA, T0);
  const a2 = msg(ADA, T0 + 60_000);
  const a3 = msg(ADA, T0 + 7 * 60_000);
  const k1 = msg(KAI, T0 + 8 * 60_000);
  const w1 = msg(WREN, T0 + 8.5 * 60_000);
  const sys = msg(KAI, T0 + 9 * 60_000, { type: "system" });
  const k2 = msg(KAI, T0 + 9.5 * 60_000);
  const items = layoutTimeline([a1, a2, a3, k1, w1, sys, k2], { now: T0 + 3600_000 });
  const cont = items.filter((i) => i.kind === "message").map((i) => (i.kind === "message" ? i.continued : null));
  assert.deepEqual(cont, [false, true, false, false, false, false, false]);
  assert.equal(items[0].kind, "day");
  assert.equal(items[0].kind === "day" && items[0].label, "Today");
  // an agent writing for someone else isn't the same author as that agent writing for me
  assert.equal(continues({ ...w1 }, { ...w1, author: { ...WREN, forName: "Kai" }, createdAt: w1.createdAt + 1 }), false);
});

test("a day rule at each new day; the New rule above the first unread that isn't mine", () => {
  const y = msg(KAI, T0 - 86_400_000);
  const a = msg(ADA, T0);
  const k = msg(KAI, T0 + 1000);
  const items = layoutTimeline([y, a, k], { readSeq: y.seq, meId: ADA.id, now: T0 + 1000 });
  assert.deepEqual(
    items.map((i) => i.kind),
    ["day", "message", "day", "message", "new", "message"],
  );
  assert.equal(items[0].kind === "day" && items[0].label, "Yesterday");
  // nothing unread: no rule
  assert.ok(!layoutTimeline([y, a, k], { readSeq: k.seq, meId: ADA.id }).some((i) => i.kind === "new"));
});

test("pending messages follow what the server has, and sit under my own last message", () => {
  const a = msg(ADA, T0);
  const p: PendingMessage = { requestId: "rq_1", channel: "ch_1", root: null, text: "on its way", files: [], createdAt: T0 + 2000, state: "sending" };
  const items = layoutTimeline([a], { meId: ADA.id, pending: [p], now: T0 });
  const last = items.at(-1)!;
  assert.equal(last.kind, "pending");
  assert.equal(last.kind === "pending" && last.continued, true);
});

test("the echo and the POST's answer settle the pending copy once, whichever comes first", () => {
  const p: PendingMessage = { requestId: "rq_1", channel: "ch_1", root: null, text: "x", files: [], createdAt: T0, state: "sending" };
  const q: PendingMessage = { ...p, requestId: "rq_2" };
  const m = msg(ADA, T0);
  let pending = settlePending([p, q], "rq_1", m);
  assert.deepEqual(pending.map((x) => x.requestId), ["rq_2"]);
  const same = settlePending(pending, "rq_1", m);
  assert.equal(same, pending, "the second arrival changes nothing");
  let list = upsertMessage([], m);
  list = upsertMessage(list, m);
  assert.equal(list.length, 1, "an echo after the answer is the same message");
  // failed, then retried with the same request id
  pending = failPending(pending, "rq_2", "offline");
  assert.equal(pending[0].state, "failed");
  pending = retryPending(pending, "rq_2");
  assert.equal(pending[0].state, "sending");
  assert.equal(pending[0].requestId, "rq_2");
});

test("messages stay in seq order, without doubles, however they arrive", () => {
  const a = msg(ADA, T0), b = msg(KAI, T0 + 1), c = msg(ADA, T0 + 2);
  assert.deepEqual(upsertMessage([a, c], b).map((m) => m.id), [a.id, b.id, c.id]);
  assert.deepEqual(mergeMessages([b, c], [a, b, { ...c, text: "edited" }]).map((m) => m.text), [a.text, b.text, "edited"]);
});

test("a reply moves its root on once; the server's own change already counted it", () => {
  const root = msg(ADA, T0);
  const r = msg(KAI, T0 + 5000, { root: root.id });
  const once = bumpRoot(root, r);
  assert.equal(once.replyCount, 1);
  assert.deepEqual(once.repliers, ["Kai Moreno"]);
  assert.equal(bumpRoot(once, r), once);
});

test("reactions toggle by name, and an empty one goes", () => {
  const m = msg(ADA, T0);
  const on = toggleReaction(m, "👍", "Kai Moreno", true);
  assert.deepEqual(on.reactions, [{ emoji: "👍", by: ["Kai Moreno"] }]);
  assert.deepEqual(toggleReaction(on, "👍", "Kai Moreno", true).reactions[0].by, ["Kai Moreno"]);
  assert.deepEqual(toggleReaction(on, "👍", "Kai Moreno", false).reactions, []);
});

test("@ # and : at the caret; an emoji needs two letters; a word in the middle isn't a trigger", () => {
  assert.deepEqual(findTrigger("hi @ad", 6), { kind: "@", query: "ad", start: 3 });
  assert.deepEqual(findTrigger("@", 1), { kind: "@", query: "", start: 0 });
  assert.deepEqual(findTrigger("see #gen", 8), { kind: "#", query: "gen", start: 4 });
  assert.equal(findTrigger("nice :t", 7), null);
  assert.deepEqual(findTrigger("nice :ta", 8), { kind: ":", query: "ta", start: 5 });
  assert.equal(findTrigger("ada@normal.dev", 14), null);
  assert.equal(findTrigger("12:30", 5), null);
  const t = findTrigger("hi @ad there", 6)!;
  assert.deepEqual(applyCompletion("hi @ad there", t, "@ada.lovelace", 6), { text: "hi @ada.lovelace there", caret: 17 });
});

test("@ finds people by name or handle (a word's start first), then agents, then @channel and @here; never me", () => {
  const people: ChatParty[] = [ADA, KAI, { kind: "person", id: "u_kat", name: "Kat Adams" }];
  const agents = [{ name: "Wren" }, { name: "Kestrel" }];
  const k = matchMentions("k", people, agents, ADA.id);
  assert.deepEqual(k.map((o) => o.name), ["Kai Moreno", "Kat Adams", "Kestrel"]);
  assert.equal(k[0].handle, "kai.moreno");
  assert.equal(k[2].kind, "agent");
  assert.ok(!matchMentions("ada", people, agents, ADA.id).some((o) => o.id === ADA.id));
  assert.equal(matchMentions("ada", people, agents, ADA.id)[0].name, "Kat Adams");
  assert.deepEqual(matchMentions("he", people, agents, ADA.id).map((o) => o.handle), ["here"]);
  assert.ok(matchMentions("", people, agents, ADA.id).length <= 8);
});

test("# finds open and private channels, not dms or archived ones", () => {
  const ch = (id: string, name: string, kind: ChatChannelView["kind"], archivedAt: number | null = null) => ({ id, name, kind, archivedAt });
  const list = [ch("1", "general", "open"), ch("2", "design-review", "private"), ch("3", "", "dm"), ch("4", "gone", "open", 1), ch("5", "random", "open")];
  assert.deepEqual(matchChannels("", list).map((c) => c.name), ["design-review", "general", "random"]);
  assert.deepEqual(matchChannels("rev", list).map((c) => c.name), ["design-review"]);
});

test("the switcher's fuzzy match: exact, then a prefix, then letters in order with word starts first", () => {
  assert.ok(fuzzyScore("general", "general") > fuzzyScore("gen", "general"));
  assert.ok(fuzzyScore("gen", "general") > fuzzyScore("gnrl", "general"));
  assert.ok(fuzzyScore("dr", "design-review") > fuzzyScore("dr", "hydrant"));
  assert.equal(fuzzyScore("xyz", "general"), 0);
  assert.ok(fuzzyScore("#gen", "general") > 0);
  assert.ok(fuzzyScore("km", "Kai Moreno") > 0);
});

test("drafts: kept per channel and thread, an empty one leaves nothing, a broken store is no draft", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  writeDraft(store, "ch_1", "half a thought");
  writeDraft(store, "ch_1", "in the thread", "m_9");
  assert.equal(readDraft(store, "ch_1"), "half a thought");
  assert.equal(readDraft(store, "ch_1", "m_9"), "in the thread");
  writeDraft(store, "ch_1", "   ");
  assert.equal(readDraft(store, "ch_1"), "");
  assert.equal(m.size, 1);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } };
  assert.equal(readDraft(broken, "ch_1"), "");
  assert.doesNotThrow(() => writeDraft(broken, "ch_1", "x"));
  assert.equal(readDraft(null, "ch_1"), "");
});

test("the toolbar wraps the selection, or the lines for a list or a quote", () => {
  assert.deepEqual(applyFormat("make it bold", 8, 12, "bold"), { text: "make it **bold**", start: 10, end: 14 });
  assert.equal(applyFormat("x", 1, 1, "italic").text, "x__");
  assert.equal(applyFormat("a\nb", 0, 3, "list").text, "- a\n- b");
  assert.equal(applyFormat("said", 0, 4, "quote").text, "> said");
  const link = applyFormat("see this", 4, 8, "link");
  assert.equal(link.text, "see [this](https://)");
  assert.equal(link.text.slice(link.start, link.end), "https://");
});

test("mentions and channels are marked outside code; mine is louder", () => {
  const html = markMentions("hi @ada.lovelace and @kai. see #general <code>@not</code>", "ada.lovelace");
  assert.match(html, /<span class="chat-mention is-me">@ada\.lovelace<\/span>/);
  assert.match(html, /<span class="chat-mention">@kai<\/span>\./);
  assert.match(html, /data-channel-name="general">#general<\/span>/);
  assert.match(html, /<code>@not<\/code>/);
  assert.match(markMentions("@here look", "ada"), /is-me/);
});

test("the badge counts mentions and direct messages, muted and unjoined ones not at all", () => {
  const view = (kind: ChatChannelView["kind"], unread: number, mentions: number, notify: "all" | "mentions" | "none" = "all", joined = true): ChatChannelView =>
    ({ id: kind + unread, kind, name: "", topic: "", purpose: "", createdBy: "", createdAt: 0, archivedAt: null, lastSeq: 10, lastPostAt: 0, memberCount: 2, unread, me: joined ? { channel: "", readSeq: 0, mentions, notify, starred: false, joinedAt: 0 } : null });
  const t = chatTotals([view("open", 7, 2), view("dm", 3, 0), view("group", 1, 1), view("private", 4, 1, "none"), view("open", 9, 9, "all", false)]);
  assert.deepEqual(t, { mentions: 2, direct: 4, total: 6 });
  assert.equal(totalsWords(t), "2 mentions · 4 in direct messages");
  assert.equal(totalsWords({ mentions: 0, direct: 0, total: 0 }), "Nothing new for you");
});

test("the route's rest: a channel, a thread in it, a message in place, or a view", () => {
  assert.deepEqual(parseRest("ch_1/thread/m_2"), { channel: "ch_1", thread: "m_2", at: null, view: null, q: "" });
  assert.deepEqual(parseRest("ch_1/at/42"), { channel: "ch_1", thread: null, at: 42, view: null, q: "" });
  assert.equal(parseRest("search/from%3Aada%20hi").q, "from:ada hi");
  assert.equal(restOf({ channel: "ch_1", thread: "m_2" }), "ch_1/thread/m_2");
  assert.equal(restOf({ view: "search", q: "a b" }), "search/a%20b");
  assert.equal(parseRest(restOf({ view: "search", q: "in:general x/y" })).q, "in:general x/y");
});

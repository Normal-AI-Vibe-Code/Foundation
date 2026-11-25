/**
 * A ChatForm conversation on a grid (2026-11-25), the pure parts: what the board keeps for a chat card, what a
 * card is on this device (open, locked, on another server…) and its words, who its head draws, what this window
 * tells a chat server about the grid it has open, the merge of two servers' who-is-where, and Alt-wheel in a pane
 * that rests at its foot (the timeline).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatParty, WhereBoard } from "@foundation/protocol";
import { CHAT_CARD_NAME, cantSend, cardPeople, chatCardRef, chatCardState, elsewhereWords, lockedWords, peopleWords, whereToSay, type ChatCardFacts } from "../src/chat/gridChat.ts";
import { gridsOf, mergeWhere } from "../src/lib/whereLines.ts";
import { hasRoom, wheelVerdict, type Pane } from "../src/lib/cardScroll.ts";

const REMOTE = "https://chat.example.app";

test("the board keeps a reference: the id, the server when it isn't Foundation's own, and a name only for an open channel", () => {
  assert.deepEqual(chatCardRef({ id: "ch_1", kind: "open", name: "fan-shroud" }, ""), { panel: "chat", name: "#fan-shroud", channel: "ch_1" });
  assert.deepEqual(chatCardRef({ id: "ch_1", kind: "open", name: "fan-shroud" }, REMOTE), { panel: "chat", name: "#fan-shroud", channel: "ch_1", chatServer: REMOTE });
  // a private channel's name, a direct message's people, an agent's name: never the board's
  for (const kind of ["private", "dm", "group", "agent", "portal"] as const) {
    const ref = chatCardRef({ id: "ch_2", kind, name: "launch-secret" }, "");
    assert.equal(ref.name, CHAT_CARD_NAME);
    assert.ok(!JSON.stringify(ref).includes("launch-secret"), `${kind}: its name stays on the chat server`);
    assert.deepEqual(Object.keys(ref).sort(), ["channel", "name", "panel"]);
  }
});

const facts = (over: Partial<ChatCardFacts> = {}): ChatCardFacts => ({ channel: "ch_1", cardServer: undefined, hereServer: "", status: "live", loaded: true, has: true, asked: "no", ...over });

test("what a card is on this device", () => {
  assert.equal(chatCardState(facts()), "open");
  assert.equal(chatCardState(facts({ channel: undefined })), "unpicked");
  // made against another chat server than this device's: it says so, whatever this server happens to have under that id
  assert.equal(chatCardState(facts({ cardServer: REMOTE })), "elsewhere");
  assert.equal(chatCardState(facts({ cardServer: undefined, hereServer: REMOTE })), "elsewhere");
  assert.equal(chatCardState(facts({ cardServer: REMOTE, hereServer: "https://other.example.app" })), "elsewhere");
  assert.equal(chatCardState(facts({ cardServer: REMOTE, hereServer: REMOTE })), "open");
  assert.equal(chatCardState(facts({ cardServer: REMOTE, hereServer: REMOTE, status: "signin", has: false, loaded: false })), "signin");
  assert.equal(chatCardState(facts({ status: "unavailable", has: false })), "unavailable");
  // the list hasn't come, or the conversation is being asked for by id: waiting, never locked on a guess
  assert.equal(chatCardState(facts({ has: false, loaded: false })), "waiting");
  assert.equal(chatCardState(facts({ has: false, asked: "no" })), "waiting");
  assert.equal(chatCardState(facts({ has: false, asked: "asking" })), "waiting");
  // the chat server said no
  assert.equal(chatCardState(facts({ has: false, asked: "refused" })), "locked");
  // offline, a refusal may only be the network
  assert.equal(chatCardState(facts({ has: false, asked: "refused", status: "offline" })), "waiting");
});

test("the locked and elsewhere cards say why without saying what", () => {
  const l = lockedWords(false);
  assert.equal(l.title, "A conversation you're not in");
  assert.ok(!/#|private|direct/i.test(`${l.title} ${l.line}`), "not even what kind it is");
  assert.match(lockedWords(true).line, /add you/);
  const e = elsewhereWords(REMOTE, "");
  assert.equal(e.title, "A conversation on chat.example.app");
  assert.match(e.line, /Foundation's own server/);
  assert.equal(elsewhereWords(undefined, REMOTE).title, "A conversation on Foundation's own server");
  assert.match(elsewhereWords(undefined, REMOTE).line, /chat\.example\.app/);
});

test("who may write follows ChatForm's rule, not the grid's", () => {
  const me = { channel: "c", readSeq: 0, mentions: 0, notify: "all" as const, starred: false, joinedAt: 0 };
  assert.equal(cantSend({ archivedAt: null, me }, "viewer"), undefined, "a viewer who is a member writes");
  assert.match(cantSend({ archivedAt: null, me: null }, "viewer") ?? "", /View only/);
  assert.equal(cantSend({ archivedAt: null, me: null }, "member"), undefined);
  assert.match(cantSend({ archivedAt: 5, me }, "admin") ?? "", /archived/);
});

const ADA: ChatParty = { kind: "person", id: "u_ada", name: "Ada Lovelace" };
const KAI: ChatParty = { kind: "person", id: "u_kai", name: "Kai Moreno" };
const NOA: ChatParty = { kind: "person", id: "u_noa", name: "Noa Berg" };
const ME: ChatParty = { kind: "person", id: "u_me", name: "Josh Leong" };
const WREN: ChatParty = { kind: "agent", id: "Wren", name: "Wren" };

test("the head draws the conversation's people who are on this grid or online, each once, the ones here first, never me", () => {
  const where: WhereBoard = {
    people: [
      { id: "u_kai", name: "Kai Moreno", color: "#111" },
      { id: "u_me", name: "Josh Leong", color: "#222" },
      { id: "u_out", name: "Someone Else", color: "#333" },
    ],
    agents: [{ id: "crew_1", name: "Lark", hue: 1, via: "claude", status: "working", doing: "laying out the parts" }],
  };
  const who = cardPeople({ channel: { kind: "private", members: [ME, ADA, KAI, NOA, WREN] }, people: [ME, ADA, KAI, NOA], online: ["u_ada", "u_me"], where, meId: "u_me" });
  assert.deepEqual(who.faces.map((f) => [f.party.id, f.here, f.online]), [
    ["u_kai", true, false],
    ["u_ada", false, true],
  ]);
  // someone on the grid who isn't in a private conversation isn't drawn in its head; Noa is neither here nor online
  assert.ok(!who.faces.some((f) => f.party.id === "u_out" || f.party.id === "u_noa"));
  // the conversation's own agent, and the one at work on this grid
  assert.deepEqual(who.agents, [
    { name: "Lark", here: true, doing: "laying out the parts" },
    { name: "Wren", here: false },
  ]);
  assert.equal(peopleWords(who), "Kai Moreno is on this grid · Ada Lovelace is online · Lark is at work here");
});

test("an open channel sends no member list: its head draws from everyone the chat server lists", () => {
  const who = cardPeople({ channel: { kind: "open" }, people: [ME, ADA, KAI], online: [], where: { people: [{ id: "u_ada", name: "Ada Lovelace", color: "" }], agents: [] }, meId: "u_me" });
  assert.deepEqual(who.faces.map((f) => f.party.id), ["u_ada"]);
  // a direct message with nobody around: nobody drawn
  assert.deepEqual(cardPeople({ channel: { kind: "dm", members: [ME, KAI] }, people: [ME, KAI], online: [], meId: "u_me" }), { faces: [], agents: [] });
});

test("on a chat server of its own a person has another id there: matched by the id the merge carried, or by name", () => {
  const ADA_THERE: ChatParty = { kind: "person", id: "cs_77", name: "Ada Lovelace" };
  const KAI_THERE: ChatParty = { kind: "person", id: "cs_78", name: "kai  moreno" };
  const where: WhereBoard = { people: [{ id: "u_ada", name: "Ada L.", color: "", chatId: "cs_77" }, { id: "u_kai", name: "Kai Moreno", color: "" }], agents: [] };
  const who = cardPeople({ channel: { kind: "group", members: [ADA_THERE, KAI_THERE] }, people: [], online: [], where });
  assert.deepEqual(who.faces.map((f) => [f.party.id, f.here]), [
    ["cs_77", true],
    ["cs_78", true],
  ]);
});

test("what this window tells a chat server: the open grid's id, never its name, and only where it's asked for", () => {
  assert.deepEqual(whereToSay({ remote: true, features: ["channels", "where"], onGrid: true, boardId: "brd_1" }), { board: "brd_1", name: null });
  // away from the grids (Today, Settings, ChatForm): on none
  assert.deepEqual(whereToSay({ remote: true, features: ["where"], onGrid: false, boardId: "brd_1" }), { board: null, name: null });
  assert.deepEqual(whereToSay({ remote: true, features: ["where"], onGrid: true, boardId: null }), { board: null, name: null });
  // a server that doesn't have `where`, or doesn't say: nothing
  assert.equal(whereToSay({ remote: true, features: ["channels"], onGrid: true, boardId: "brd_1" }), null);
  assert.equal(whereToSay({ remote: true, features: null, onGrid: true, boardId: "brd_1" }), null);
  // Foundation's own server reads its grids itself
  assert.equal(whereToSay({ remote: false, features: ["where"], onGrid: true, boardId: "brd_1" }), null);
});

test("two servers' who-is-where: a person is listed once, Foundation's entry standing, and an unknown grid is dropped", () => {
  const own: Record<string, WhereBoard> = {
    brd_1: { people: [{ id: "u_ada", name: "Ada Lovelace", color: "#a" }], agents: [{ id: "crew_1", name: "Lark", hue: 1, via: "claude", status: "working" }] },
    brd_2: { people: [{ id: "u_kai", name: "Kai Moreno", color: "#k" }], agents: [] },
  };
  const chat: Record<string, WhereBoard> = {
    brd_1: {
      people: [
        { id: "cs_77", name: "ada lovelace", color: "#x" }, // Ada again, by the chat server's id
        { id: "cs_90", name: "Noa Berg", color: "#n" }, // on another computer's Foundation: only the chat server knows
      ],
      agents: [],
    },
    brd_secret: { people: [{ id: "cs_78", name: "Kai Moreno", color: "#k" }], agents: [] },
  };
  const knows = (id: string) => id === "brd_1" || id === "brd_2";
  const all = mergeWhere(own, chat, knows);
  assert.deepEqual(all.brd_1.people, [
    { id: "u_ada", name: "Ada Lovelace", color: "#a", chatId: "cs_77" },
    { id: "cs_90", name: "Noa Berg", color: "#n", chatId: "cs_90" },
  ]);
  assert.equal(all.brd_1.agents.length, 1, "agents are Foundation's own");
  assert.deepEqual(all.brd_2, own.brd_2);
  assert.equal(all.brd_secret, undefined, "a grid this person can't see is never shown, not even as “a grid”");
  // a conversation's member is found by either id
  assert.deepEqual(gridsOf(all, "cs_77"), ["brd_1"]);
  assert.deepEqual(gridsOf(all, "u_ada"), ["brd_1"]);
  assert.deepEqual(gridsOf(all, "cs_78"), []);
  // merging again changes nothing (the same event twice), and Foundation's answer isn't written to
  assert.deepEqual(mergeWhere(all, chat, knows), all);
  assert.equal(own.brd_1.people[0].chatId, undefined);
  // a grid only the chat server has people on, that this person can see
  assert.deepEqual(mergeWhere({}, { brd_2: { people: [{ id: "cs_78", name: "Kai Moreno", color: "#k" }], agents: [] } }, knows).brd_2.people.map((p) => p.id), ["cs_78"]);
});

test("Alt-wheel in a pane that rests at its foot (the timeline): up from the foot scrolls, down at the foot holds", () => {
  const foot: Pane = { scrollTop: 0, scrollHeight: 900, clientHeight: 300, scrollLeft: 0, scrollWidth: 300, clientWidth: 300, reversed: true };
  assert.equal(hasRoom(foot, 0, -40), true, "up from the foot");
  assert.equal(hasRoom(foot, 0, 40), false, "nothing below the foot");
  const top: Pane = { ...foot, scrollTop: -600 };
  assert.equal(hasRoom(top, 0, -40), false, "at the top");
  assert.equal(hasRoom(top, 0, 40), true);
  assert.deepEqual(wheelVerdict([foot], 0, 40), { do: "hold" });
  assert.deepEqual(wheelVerdict([foot], 0, -40), { do: "scroll", pane: 0 });
  // a pane the usual way round is as it was
  const plain: Pane = { ...foot, reversed: false };
  assert.equal(hasRoom(plain, 0, -40), false);
  assert.equal(hasRoom(plain, 0, 40), true);
});

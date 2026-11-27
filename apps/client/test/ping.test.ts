/**
 * Pinging (2026-11-27): who the right-click's Ping offers, in what order, and what the ping says; and when the
 * ping sounds. Pure: no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addRecent, agoWords, filterGroups, pingGroups, pingText, RECENT_MAX } from "../src/chat/pingLogic";
import { sounds } from "../src/chat/notifyLogic";
import type { WorkerDoc } from "@foundation/protocol";

const now = 1_800_000_000_000;
const H = 3_600_000;
const worker = (id: string, name: string, kind: "person" | "agent", ago: number, extra: Partial<WorkerDoc> = {}): WorkerDoc => ({ id, name, kind, firstAt: now - 100 * H, lastAt: now - ago, edits: 3, ...extra });

test("the groups: recent, on this card, here now, worked here; each party once, never me", () => {
  const g = pingGroups({
    meId: "u_me",
    now,
    recent: [
      { id: "u_kai", name: "Kai", kind: "person", at: now - 2 * H },
      { id: "u_me", name: "Me", kind: "person", at: now },
    ],
    card: { createdBy: "Wren", assignee: "Ada" },
    here: { people: [{ id: "u_kai", name: "Kai" }, { id: "u_lin", name: "Lin" }], agents: [{ name: "Wren", status: "working" }, { name: "Lark", status: "idle" }] },
    workers: [worker("u_ada", "Ada", "person", 3 * H), worker("agent:Wren", "Wren", "agent", H, { for: "Ada" }), worker("u_old", "Old", "person", 30 * 24 * H), worker("u_me", "Me", "person", 0)],
    people: [{ id: "u_ada", name: "Ada" }],
  });
  assert.deepEqual(
    g.map((x) => [x.id, x.rows.map((r) => `${r.name}:${r.detail}`)]),
    [
      ["recent", ["Kai:pinged 2h ago"]],
      ["card", ["Wren:made this", "Ada:assigned this"]],
      ["here", ["Lin:here now", "Lark:here now"]],
      ["worked", ["Old:worked here a while ago"]],
    ],
  );
  assert.equal(g[1].rows[0].id, "agent:Wren", "an agent is agent:<name>, as a chat mention names it");
});

test("a working agent here says so; a worker agent says whom it was for; nothing at all is no groups", () => {
  const g = pingGroups({ now, recent: [], here: { people: [], agents: [{ name: "Wren", status: "working" }] }, workers: [worker("agent:Lark", "Lark", "agent", 26 * H, { for: "Kai" })] });
  assert.deepEqual(g.flatMap((x) => x.rows.map((r) => r.detail)), ["working here now", "worked here yesterday · for Kai"]);
  assert.deepEqual(pingGroups({ now, recent: [], here: { people: [], agents: [] }, workers: [] }), []);
});

test("typing narrows by name, an @ ignored", () => {
  const g = pingGroups({ now, recent: [], here: { people: [{ id: "a", name: "Ada Lovelace" }, { id: "k", name: "Kai" }], agents: [] }, workers: [] });
  assert.deepEqual(filterGroups(g, "@love").flatMap((x) => x.rows.map((r) => r.name)), ["Ada Lovelace"]);
  assert.deepEqual(filterGroups(g, "zzz"), []);
});

test("the recent list: newest first, once each, bounded", () => {
  let list = addRecent([], { id: "a", name: "A", kind: "person" }, 1);
  list = addRecent(list, { id: "b", name: "B", kind: "person" }, 2);
  list = addRecent(list, { id: "a", name: "A", kind: "person" }, 3);
  assert.deepEqual(list.map((r) => r.id), ["a", "b"]);
  for (let i = 0; i < 30; i++) list = addRecent(list, { id: `p${i}`, name: `P${i}`, kind: "person" }, 10 + i);
  assert.equal(list.length, RECENT_MAX);
});

test("what a ping says, and how long ago reads", () => {
  assert.equal(pingText("ada.lovelace", "Q4 plan"), "@ada.lovelace 👋 pinged you about “Q4 plan”");
  assert.equal(agoWords(now - 30_000, now), "just now");
  assert.equal(agoWords(now - 5 * 60_000, now), "5m ago");
});

test("the ping sounds for a mention or a direct message I'm not looking at; never @channel, never when off", () => {
  assert.equal(sounds("mention", { on: true, looking: false }), true);
  assert.equal(sounds("direct", { on: true, looking: false }), true);
  assert.equal(sounds("everyone", { on: true, looking: false }), false);
  assert.equal(sounds("mention", { on: true, looking: true }), false);
  assert.equal(sounds("mention", { on: false, looking: false }), false);
  assert.equal(sounds(null, { on: true, looking: false }), false);
});

/**
 * The agent group on a section (lib/sectionCrew.ts): an agent is in the
 * section that holds what it aims at, a grid of sections counts the agents
 * inside it, and a lead with its helpers is one team.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { crewIsIn, crewTeams, sectionChain, sectionOfCrew, togetherWords, type CrewLike, type CrewWhere } from "../src/lib/sectionCrew";

// Parts holds a table; Shop is a grid that holds Bench, which holds a machine
const objects: Record<string, string> = { table1: "parts", machine1: "bench", lost: "gone" };
const parents: Record<string, string | undefined> = { parts: undefined, shop: undefined, bench: "shop" };
const where: CrewWhere = {
  sectionOfObject: (id) => objects[id],
  parentOf: (id) => parents[id],
  hasSection: (id) => id in parents,
};

const agent = (id: string, target: CrewLike["target"], lead?: string): CrewLike => ({ id, target, lead });
const self = (c: CrewLike) => c;

test("an agent is in the section it aims at, or the one that holds the card it aims at", () => {
  assert.equal(sectionOfCrew(agent("a", { id: "parts", kind: "section" }), where), "parts");
  assert.equal(sectionOfCrew(agent("a", { id: "table1", kind: "object" }), where), "parts");
});

test("an agent that hasn't aimed anywhere, or aims at something that's gone, is in no section", () => {
  assert.equal(sectionOfCrew(agent("a", null), where), null);
  assert.equal(sectionOfCrew(agent("a", { id: "nothing", kind: "object" }), where), null);
  assert.equal(sectionOfCrew(agent("a", { id: "lost", kind: "object" }), where), null);
  assert.equal(sectionOfCrew(agent("a", { id: "removed", kind: "section" }), where), null);
});

test("a free agent joins a section's group when it comes in and leaves when it moves on", () => {
  const wren = agent("wren", { id: "table1", kind: "object" });
  assert.equal(crewIsIn(wren, "parts", where), true);
  assert.equal(crewIsIn(wren, "bench", where), false);
  wren.target = { id: "machine1", kind: "object" };
  assert.equal(crewIsIn(wren, "parts", where), false);
  assert.equal(crewIsIn(wren, "bench", where), true);
});

test("a section that holds sections counts the agents inside them", () => {
  const wren = agent("wren", { id: "machine1", kind: "object" });
  assert.deepEqual(sectionChain("bench", where), ["bench", "shop"]);
  assert.equal(crewIsIn(wren, "shop", where), true);
  assert.equal(crewIsIn(wren, "parts", where), false);
});

test("a loop in the sections' parents ends the walk", () => {
  const loop: CrewWhere = { ...where, parentOf: (id) => (id === "a" ? "b" : "a") };
  assert.deepEqual(sectionChain("a", loop), ["a", "b"]);
});

test("a lead and its helpers are one team, the lead first; anyone else is on their own", () => {
  const crew = [agent("tern", null, "wren"), agent("basalt", null), agent("wren", null), agent("lark", null, "wren")];
  const teams = crewTeams(crew, self);
  assert.deepEqual(teams.map((t) => [t.id, t.members.map((m) => m.id), t.together]), [
    ["wren", ["wren", "tern", "lark"], true],
    ["basalt", ["basalt"], false],
  ]);
});

test("helpers whose lead is somewhere else are still a team here", () => {
  const teams = crewTeams([agent("tern", null, "wren"), agent("lark", null, "wren")], self);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].together, true);
});

test("what a group says about itself", () => {
  const words = (crew: CrewLike[]) => togetherWords(crewTeams(crew, self));
  assert.equal(words([]), "");
  assert.equal(words([agent("wren", null)]), "");
  assert.equal(words([agent("wren", null), agent("tern", null, "wren")]), "working together");
  assert.equal(words([agent("wren", null), agent("basalt", null), agent("onyx", null)]), "3 on their own");
  assert.equal(words([agent("wren", null), agent("tern", null, "wren"), agent("basalt", null)]), "2 teams");
});

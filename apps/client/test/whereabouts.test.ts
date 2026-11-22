/**
 * Who is where, on the side menu's rows and ChatForm's people (2026-11-21).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WhereBoard } from "@foundation/protocol";
import { gridsOf, hereLine, othersOn } from "../src/lib/whereLines.ts";

const all: Record<string, WhereBoard> = {
  company: {
    people: [
      { id: "u_ada", name: "Ada", color: "#e0564f" },
      { id: "u_me", name: "Josh", color: "#3f8f6b" },
    ],
    agents: [{ id: "crew_1", name: "Lark", hue: 2, via: "claude", status: "working", doing: "laying out the parts" }],
  },
  vision: { people: [{ id: "u_ada", name: "Ada", color: "#e0564f" }], agents: [] },
};

test("a grid's row counts the others, not me, and its agents", () => {
  const o = othersOn(all, "company", "u_me");
  assert.deepEqual(o.people.map((p) => p.id), ["u_ada"]);
  assert.equal(o.agents.length, 1);
  assert.deepEqual(othersOn(all, "nobody-here", "u_me"), { people: [], agents: [] });
});

test("the row's line says who is here and who is at work, and on what", () => {
  const o = othersOn(all, "company", "u_me");
  assert.equal(hereLine(o.people, o.agents), "Ada is here · Lark (laying out the parts) is at work");
  assert.equal(hereLine(all.company.people, []), "Ada and Josh are here");
  assert.equal(hereLine([], [{ id: "c", name: "Wren", hue: 0, via: "claude", status: "done" }]), "Wren is on it");
});

test("the grids a person is on", () => {
  assert.deepEqual(gridsOf(all, "u_ada"), ["company", "vision"]);
  assert.deepEqual(gridsOf(all, "u_me"), ["company"]);
  assert.deepEqual(gridsOf(all, "u_kai"), []);
});

/**
 * What rests under an agent's bar on the grid's council (lib/councilOpen.ts answersBySeat): its answer to the last
 * line said to it, for ten minutes; a later line it hasn't answered yet takes the older answer away; an answer this
 * reader can't read says why instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answersBySeat, type CouncilLine } from "../src/lib/councilOpen.ts";

const now = 1_000_000_000;
const line = (at: number, replies: CouncilLine["replies"]): CouncilLine => ({ id: `l${at}`, place: "board", text: "?", by: "Ada", mine: true, at, all: true, replies });

test("each seat's answer to the last line said to it, for ten minutes", () => {
  const a = answersBySeat(
    [
      line(now - 5 * 60_000, [{ name: "Wren", state: "answered", text: "Three parts short." }, { name: "Pip", state: "answered", withheld: "It read beyond the grid" }]),
      line(now - 60_000, [{ name: "Pip", state: "answered", text: "the laminations" }, { name: "Kimi", state: "elsewhere" }]),
    ],
    now,
  );
  assert.equal(a.get("Wren")?.text, "Three parts short.");
  assert.equal(a.get("Pip")?.text, "the laminations", "the later answer");
  assert.equal(a.has("Kimi"), false, "an agent answering in its own thread has nothing here");
});

test("a later line not answered yet takes the older answer away; an old one has gone; a withheld one says why", () => {
  const a = answersBySeat(
    [
      line(now - 20 * 60_000, [{ name: "Old", state: "answered", text: "long ago" }]),
      line(now - 4 * 60_000, [{ name: "Wren", state: "answered", text: "first" }, { name: "Pip", state: "answered", withheld: "It read beyond the grid" }]),
      line(now - 30_000, [{ name: "Wren", state: "working" }]),
    ],
    now,
  );
  assert.equal(a.has("Old"), false);
  assert.equal(a.has("Wren"), false);
  assert.equal(a.get("Pip")?.withheld, "It read beyond the grid");
  assert.equal(a.get("Pip")?.text, undefined);
});

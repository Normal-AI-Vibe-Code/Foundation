/**
 * A right-click menu's layout and its arrow keys (components/menuLayout.ts,
 * 2026-11-17): a section's menu is the council across the top, Add and Live
 * as two columns, and the grid's own actions as a row of icons with the
 * dangerous one last; a plain menu stays a list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { layoutMenu, nextSpot, type Counts, type MenuGroup, type MenuItem, type Spot } from "../src/components/menuLayout";

const tag = (group: MenuGroup, items: MenuItem[]): MenuItem[] => items.map((it) => ({ ...it, group }));
const SECTION: MenuItem[] = [
  { label: "Council: ask this section's agents…", agent: true },
  ...tag("add", [{ heading: "Add" }, { label: "Text box" }, { label: "Markdown note" }, { label: "Table" }]),
  ...tag("live", [{ heading: "Live" }, { label: "Agents card" }, { label: "Huddle" }]),
  ...tag("grid", [{ label: "Open as its own grid" }, { label: "Remove section…", danger: true }, { label: "Insert section left" }, { label: "Split column" }]),
];

test("a menu with groups is laid out in zones; the dangerous action goes last in the icon row", () => {
  const l = layoutMenu(SECTION);
  assert.equal(l.grouped, true);
  assert.deepEqual(l.top.map((i) => i.label), ["Council: ask this section's agents…"]);
  assert.deepEqual(l.add.map((i) => i.label), ["Text box", "Markdown note", "Table"]);
  assert.deepEqual(l.live.map((i) => i.label), ["Agents card", "Huddle"]);
  assert.deepEqual(l.grid.map((i) => i.label), ["Open as its own grid", "Insert section left", "Split column", "Remove section…"]);
  assert.deepEqual(l.captions, { add: "Add", live: "Live" });
});

test("a menu with no groups stays a list (an empty cell's, a table cell's)", () => {
  const items: MenuItem[] = [{ label: "Create section at B2" }, { divider: true }, { heading: "More" }, { label: "Create it and ask an agent to build it…", agent: true }];
  const l = layoutMenu(items);
  assert.equal(l.grouped, false);
  assert.deepEqual(l.top.map((i) => i.label), ["Create section at B2", "Create it and ask an agent to build it…"]);
  assert.deepEqual([l.add, l.live, l.grid], [[], [], []]);
});

test("the section's own list says where each thing sits, and keeps the names it had", () => {
  // read as text: the module itself pulls in the whole store and the app's styles
  const src = readFileSync(new URL("../src/components/sectionMenu.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const between = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
  const add = between('...tag("add", [', '...tag("live", [');
  const live = between('...tag("live", [', '...tag("grid", [');
  const grid = src.slice(src.indexOf('...tag("grid", ['));
  for (const l of ["Text box", "Markdown note", "Table", "Map", "Image, video or file…", "App or web page…"]) assert.ok(add.includes(`"${l}"`), `Add has ${l}`);
  for (const l of ["Agents card", "Huddle", "Slack channel", "Machine", "Character: 3D", "Character: mesh avatar", "All agents on this grid"]) assert.ok(live.includes(`"${l}"`), `Live has ${l}`);
  for (const l of ["Back up a level", "Open its grid", "Open as its own grid", "Fill the screen with it", "Insert section left", "Insert section right", "Insert section above", "Insert section below", "Split column", "Split row", "fill the section", "as a card", "Remove section…"])
    assert.ok(grid.includes(l), `the icon row has ${l}`);
  assert.ok(src.indexOf("Council: ask this section's agents…") < src.indexOf('...tag("add", ['), "the council leads");
  assert.doesNotMatch(src, /heading: "Sections"/, "the icon row has no caption");
});

const N: Counts = { top: 1, add: 6, live: 7, grid: 8 };
const go = (at: Spot | null, key: Parameters<typeof nextSpot>[2], col: "add" | "live" = "add", n = N) => nextSpot(n, at, key, col);

test("arrows: down from nowhere starts at the top; up from nowhere at the bottom", () => {
  assert.deepEqual(go(null, "ArrowDown"), { zone: "top", i: 0 });
  assert.deepEqual(go(null, "ArrowUp"), { zone: "grid", i: 0 });
  assert.deepEqual(go(null, "Home"), { zone: "top", i: 0 });
  assert.deepEqual(go({ zone: "add", i: 2 }, "End"), { zone: "grid", i: 7 });
});

test("arrows: down and up move within a column and on to the zone above or below", () => {
  assert.deepEqual(go({ zone: "top", i: 0 }, "ArrowDown"), { zone: "add", i: 0 });
  assert.deepEqual(go({ zone: "add", i: 0 }, "ArrowDown"), { zone: "add", i: 1 });
  assert.deepEqual(go({ zone: "add", i: 5 }, "ArrowDown"), { zone: "grid", i: 0 });
  assert.deepEqual(go({ zone: "live", i: 6 }, "ArrowDown", "live"), { zone: "grid", i: 0 });
  assert.deepEqual(go({ zone: "add", i: 0 }, "ArrowUp"), { zone: "top", i: 0 });
  assert.deepEqual(go({ zone: "live", i: 0 }, "ArrowUp", "live"), { zone: "top", i: 0 });
  assert.deepEqual(go({ zone: "grid", i: 3 }, "ArrowDown"), { zone: "top", i: 0 }, "off the end: round to the top");
  assert.deepEqual(go({ zone: "top", i: 0 }, "ArrowUp"), { zone: "grid", i: 0 }, "and off the top: round to the bottom");
});

test("arrows: left and right cross between the columns keeping the row, and walk the icon row", () => {
  assert.deepEqual(go({ zone: "add", i: 3 }, "ArrowRight"), { zone: "live", i: 3 });
  assert.deepEqual(go({ zone: "live", i: 6 }, "ArrowLeft", "live"), { zone: "add", i: 5 }, "a longer column's last row lands on the shorter one's last");
  assert.deepEqual(go({ zone: "add", i: 3 }, "ArrowLeft"), { zone: "add", i: 3 }, "nothing further left");
  assert.deepEqual(go({ zone: "live", i: 1 }, "ArrowRight", "live"), { zone: "live", i: 1 });
  assert.deepEqual(go({ zone: "grid", i: 0 }, "ArrowRight"), { zone: "grid", i: 1 });
  assert.deepEqual(go({ zone: "grid", i: 7 }, "ArrowRight"), { zone: "grid", i: 7 });
  assert.deepEqual(go({ zone: "grid", i: 0 }, "ArrowLeft"), { zone: "grid", i: 0 });
  assert.deepEqual(go({ zone: "top", i: 0 }, "ArrowRight"), { zone: "top", i: 0 });
});

test("arrows: up from the icon row returns to the column the keyboard was last in", () => {
  assert.deepEqual(go({ zone: "grid", i: 4 }, "ArrowUp", "add"), { zone: "add", i: 5 });
  assert.deepEqual(go({ zone: "grid", i: 4 }, "ArrowUp", "live"), { zone: "live", i: 6 });
  assert.deepEqual(go({ zone: "top", i: 0 }, "ArrowDown", "live"), { zone: "live", i: 0 });
});

test("arrows in a plain list: up and down through it, round at the ends; an empty menu goes nowhere", () => {
  const list: Counts = { top: 3, add: 0, live: 0, grid: 0 };
  assert.deepEqual(go(null, "ArrowDown", "add", list), { zone: "top", i: 0 });
  assert.deepEqual(go({ zone: "top", i: 0 }, "ArrowDown", "add", list), { zone: "top", i: 1 });
  assert.deepEqual(go({ zone: "top", i: 2 }, "ArrowDown", "add", list), { zone: "top", i: 0 });
  assert.deepEqual(go({ zone: "top", i: 0 }, "ArrowUp", "add", list), { zone: "top", i: 2 });
  assert.deepEqual(go(null, "ArrowUp", "add", list), { zone: "top", i: 2 });
  assert.equal(go(null, "ArrowDown", "add", { top: 0, add: 0, live: 0, grid: 0 }), null);
  // only a Live column (no Add): the keyboard still finds it
  assert.deepEqual(go({ zone: "top", i: 0 }, "ArrowDown", "add", { top: 1, add: 0, live: 2, grid: 0 }), { zone: "live", i: 0 });
});

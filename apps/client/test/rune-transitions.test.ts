/**
 * What eases and what lands when Rune is handed a new board (rune/transitions.ts).
 * Left unsaid, Rune springs whatever changed, so a pane opening or another
 * board arriving morphed the grid. Each rule is held here against real scenes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRemote, getState, requestRemoveSection, setActiveSection, type NoteMeta, type Section } from "../src/state/store";
import { TOKEN_VARS, buildScene, type Scene, type SceneTokens } from "../src/rune/scene";
import { sceneMotion, still } from "../src/rune/transitions";
import { readFileSync } from "node:fs";

const sec = (id: string, c0: number): Section => ({ id, name: id, c0, r0: 0, c1: c0, r1: 0 });
const note = (id: string, sectionId: string, bornAt: number, more: Partial<NoteMeta> = {}): NoteMeta => ({ id, sectionId, name: id, x: 0, y: 0, float: false, bornAt, w: 300, h: 200, text: `# ${id}`, ...more });
const board = (notes: Record<string, NoteMeta>, cols = [1560, 1560, 1560]) =>
  applyRemote({ grid: { cols, rows: [1160] }, sections: { A: sec("A", 0), B: sec("B", 1) }, notes, tables: {}, maps: {}, media: {}, panels: {}, links: {} });

const ink = (v: number) => Object.fromEntries(Object.keys(TOKEN_VARS).map((k) => [k, [v, v, v, 1]])) as SceneTokens;
const floor = { left: 272, top: 44, right: 0 };
const scene = (insets = floor, tokens = ink(0)) => buildScene(getState(), { insets, readOnly: false, tokens, paper: true });
const was = (s: Scene, id = "b/") => ({ scene: s, board: id, still: still(s) });
const here = { board: "b/", byHand: false };

board({ a1: note("a1", "A", 1), b1: note("b1", "B", 2, { float: true, x: 400, y: 300 }) });
setActiveSection("A");
const rest = scene();

test("the first board lands", () => {
  assert.deepEqual(sceneMotion(null, rest, here), { motion: "instant", rule: "first" });
});

test("another board lands, even when a hand asked for it and even if it looks the same", () => {
  assert.deepEqual(sceneMotion(was(rest), rest, { board: "other/", byHand: true }), { motion: "instant", rule: "board" });
  // a section opened as its own grid is another board too
  assert.equal(sceneMotion(was(rest), rest, { board: "b/A", byHand: true }).rule, "board");
});

test("the floor lands: a pane opening or being resized never drags the grid after it", () => {
  for (const insets of [{ ...floor, left: 0 }, { ...floor, right: 380 }, { ...floor, top: 0 }]) {
    assert.deepEqual(sceneMotion(was(rest), scene(insets), here), { motion: "instant", rule: "floor" });
    // nor when a tool on Rune's own toolbar opened the pane
    assert.equal(sceneMotion(was(rest), scene(insets), { ...here, byHand: true }).motion, "instant");
  }
});

test("a change of look eases: day and night, the selection, a question on a section", () => {
  assert.deepEqual(sceneMotion(was(rest), scene(floor, ink(1)), here), { motion: "animated", rule: "look" });
  setActiveSection("B");
  const picked = scene();
  assert.notDeepEqual(picked.sections.map((s) => s.active), rest.sections.map((s) => s.active));
  assert.equal(sceneMotion(was(rest), picked, here).rule, "look");
  requestRemoveSection("B");
  const asked = scene();
  assert.ok(asked.sections.some((s) => s.confirm));
  assert.equal(sceneMotion(was(picked), asked, here).rule, "look");
  requestRemoveSection(null);
  setActiveSection("A");
});

test("places, sizes and words from the store land", () => {
  const before = was(scene());
  // a card somewhere else (someone's edit, an agent's)
  board({ a1: note("a1", "A", 1), b1: note("b1", "B", 2, { float: true, x: 520, y: 300 }) });
  assert.deepEqual(sceneMotion(before, scene(), here), { motion: "instant", rule: "lands" });
  // a track being dragged
  board({ a1: note("a1", "A", 1), b1: note("b1", "B", 2, { float: true, x: 400, y: 300 }) }, [1700, 1560, 1560]);
  assert.equal(sceneMotion(before, scene(), here).rule, "lands");
  // text being typed, a card arriving
  board({ a1: note("a1", "A", 1, { text: "# a1\nmore" }), b1: note("b1", "B", 2, { float: true, x: 400, y: 300 }) });
  assert.equal(sceneMotion(before, scene(), here).rule, "lands");
  board({ a1: note("a1", "A", 1), b1: note("b1", "B", 2, { float: true, x: 400, y: 300 }), a2: note("a2", "A", 3) });
  assert.equal(sceneMotion(before, scene(), here).rule, "lands");
});

test("what a hand just did through Rune settles, on this board and this floor", () => {
  board({ a1: note("a1", "A", 1), b1: note("b1", "B", 2, { float: true, x: 400, y: 300 }) });
  const before = was(scene());
  board({ a1: note("a1", "A", 1), b1: note("b1", "B", 2, { float: true, x: 640, y: 420 }) });
  assert.deepEqual(sceneMotion(before, scene(), { ...here, byHand: true }), { motion: "animated", rule: "hand" });
});

test("the wasm entry point says one or the other for every scene", () => {
  const rs = readFileSync(new URL("../../rune/src/lib.rs", import.meta.url), "utf8");
  assert.match(rs, /pub fn set_scene\(json: String, animated: bool\)/);
  assert.match(rs, /if animated \{ tx\.animated\(\) \} else \{ tx\.instant\(\) \}/);
  const host = readFileSync(new URL("../src/rune/host.ts", import.meta.url), "utf8");
  assert.match(host, /mod\.setScene\(json, how\.motion === "animated"\)/);
});

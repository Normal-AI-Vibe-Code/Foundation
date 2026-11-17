/**
 * A hosted app fills its section, so anything a person adds there would be
 * hidden under it. Every add path makes the app a card in the flow beside the
 * new one instead, as an agent's add does on the server (cardSection).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { addMedia, addNote, addPanel, applyRemote, createMap, createTable, getState, type PanelMeta } from "../src/state/store";

const app: PanelMeta = { id: "app", sectionId: "S", name: "FactoryForm", panel: "connector", x: 0, y: 0, w: 460, h: 320, ports: [], float: false, bornAt: 1 } as PanelMeta;
function hostedBoard() {
  applyRemote({
    grid: { cols: [1200, 1200], rows: [900] },
    sections: { S: { id: "S", name: "FactoryForm", c0: 0, r0: 0, c1: 0, r1: 0, host: "app" }, T: { id: "T", name: "Empty", c0: 1, r0: 0, c1: 1, r1: 0 } },
    notes: {},
    tables: {},
    maps: {},
    media: {},
    panels: { app },
    links: {},
  });
}

const adds: Array<[string, () => { id: string }]> = [
  ["a table (⌘K, the section's ⊞)", () => createTable("S")],
  ["a map", () => createMap("S")],
  ["a note", () => addNote("S", "hi", { focus: false })],
  ["an image", () => addMedia("S", "/files/x.png", "image", "x.png", 400, 300, { focus: false })],
  ["a link panel", () => addPanel("S", { panel: "link", name: "Docs", url: "https://example.com" }, { focus: false })],
];

for (const [what, add] of adds) {
  test(`${what} added to an app's section: the app becomes a card beside it`, () => {
    hostedBoard();
    const made = add();
    const st = getState();
    assert.equal(st.sections.S.host, undefined, "the section no longer hosts the app");
    assert.ok(st.panels.app, "the app is still on the board, as a card");
    assert.equal(st.panels.app.sectionId, "S");
    assert.ok(made.id);
  });
}

test("an app opened into an empty section still becomes its app", () => {
  hostedBoard();
  const p = addPanel("T", { panel: "app", name: "Creation", url: "http://localhost:5173" }, { focus: false });
  assert.equal(getState().sections.T.host, p.id);
});

test("a card added to a section that hosts nothing leaves it alone", () => {
  hostedBoard();
  addNote("T", "x", { focus: false });
  assert.equal(getState().sections.S.host, "app");
  assert.equal(getState().sections.T.host, undefined);
});

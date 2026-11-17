/**
 * Live pages run only when drawn big enough (SPEC §5). The scale a card is
 * drawn at is the camera's zoom times its section's fit (store.drawnScale),
 * not the zoom alone: a page fitted to 40 % at zoom 0.5 is drawn at 20 %.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_FIT, applyRemote, drawnScale, expandSection, sectionFlow, type NoteMeta, type PanelMeta } from "../src/state/store";

const note = (i: number, sectionId: string): NoteMeta => ({ id: `${sectionId}${i}`, sectionId, name: `n${i}`, x: 0, y: 0, float: false, bornAt: i, w: 420, h: 300, text: "" });
const page = (id: string, sectionId: string): PanelMeta => ({ id, sectionId, name: id, panel: "app", url: "about:blank", x: 0, y: 0, float: false, bornAt: 1.5, w: 480, h: 360, ports: [] }) as unknown as PanelMeta;

applyRemote({
  grid: { cols: [1200, 1200], rows: [900] },
  sections: { Roomy: { id: "Roomy", name: "Roomy", c0: 0, r0: 0, c1: 0, r1: 0 }, Crowded: { id: "Crowded", name: "Crowded", c0: 1, r0: 0, c1: 1, r1: 0 } },
  notes: Object.fromEntries([note(0, "Roomy"), ...Array.from({ length: 30 }, (_, i) => note(i, "Crowded"))].map((n) => [n.id, n])),
  panels: { p1: page("p1", "Roomy"), p2: page("p2", "Crowded") },
  tables: {},
  maps: {},
  media: {},
  links: {},
});

test("a card in a roomy section is drawn at the zoom", () => {
  assert.equal(sectionFlow("Roomy").fit, 1);
  assert.equal(drawnScale(0.5, "Roomy"), 0.5);
});

test("a card in a crowded section is drawn at the zoom times the fit", () => {
  const fit = sectionFlow("Crowded").fit;
  assert.ok(fit < 0.7 && fit >= MIN_FIT, `fit ${fit}`);
  assert.ok(Math.abs(drawnScale(0.5, "Crowded") - 0.5 * fit) < 1e-9);
  assert.ok(drawnScale(0.5, "Crowded") < 0.3, "at zoom 0.5 it falls under the live-page line");
});

test("a hosted app (no section fit) and an expanded section are drawn at the zoom", () => {
  assert.equal(drawnScale(0.4, null), 0.4);
  expandSection("Crowded");
  assert.equal(drawnScale(0.5, "Crowded"), 0.5);
  expandSection(null);
});

/**
 * React renders per gesture (SPEC §5: no React render on the hot path).
 * `window.__renders` (src/state/renders.ts) counts each layer's renders; this
 * check builds a board with notes, a table bound to a map and two wired apps,
 * then counts renders around a press, a drag, a typing burst, a pan, a pinch
 * and someone else's edits. The dev server runs StrictMode, so every count is
 * doubled. Writes `renders.json` to RENDERS_OUT (or the e2e results folder).
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { CLIENT, person, settle } from "./helpers";

const OUT = process.env.RENDERS_OUT ?? "../../docs/evidence/e2e-results";

type W = { __renders: Record<string, number>; __foundation: { getState(): Record<string, Record<string, { id: string; name: string; sectionId?: string }>>; setState(x: object): void } };

test("renders per gesture: the whole-board layers stay still while one card changes", async ({ browser }) => {
  test.skip(Boolean(process.env.E2E_BUILD), "makes its map through the dev server's store module");
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Renders ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool = async (name: string, data: object) => {
    const r = await context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
    expect(r.ok(), `${name}: ${await r.text()}`).toBeTruthy();
    return ((await r.json()) as { result: { id: string } }).result;
  };

  for (const section of ["Notes A", "Notes B"]) {
    await tool("add_section", { name: section });
    for (let n = 0; n < 12; n++) await tool("add_note", { section, title: `${section} ${n}`, markdown: `## ${section} ${n}\n\n- a line\n- another` });
  }
  await tool("add_section", { name: "Data" });
  await tool("add_note", { section: "Data", title: "About the data", markdown: "Where people are." });
  const table = await tool("add_table", { section: "Data", name: "People", columns: ["Name", "Lat", "Lng"], rows: [["Ada", 51.5, -0.12], ["Grace", 40.7, -74]] });
  await tool("add_section", { name: "Apps" });
  await tool("add_note", { section: "Apps", title: "About the apps", markdown: "Two apps, wired." });
  const a = await tool("add_panel", { section: "Apps", panel: "app", name: "Source", url: `${CLIENT}/e2e/frame.html`, ports: [{ name: "out", dir: "out" }] });
  const b = await tool("add_panel", { section: "Apps", panel: "app", name: "Sink", url: `${CLIENT}/e2e/frame.html`, ports: [{ name: "in", dir: "in" }] });
  await tool("connect", { from_panel: a.id, from_port: "out", to_panel: b.id, to_port: "in", label: "data" });

  await page.goto(`/?board=${board}`);
  await page.waitForFunction(() => Object.keys((window as unknown as W).__foundation.getState().notes).length >= 26, undefined, { timeout: 30_000 });
  // a map bound to the table, made the way a person makes one (the store's own createMap)
  await page.evaluate(async (tableId) => {
    const store = await import(/* @vite-ignore */ `${location.origin}/src/state/store.ts`);
    const data = Object.values((window as unknown as W).__foundation.getState().sections).find((s) => s.name === "Data")!;
    const map = store.createMap(data.id);
    store.bindMap(map.id, tableId);
  }, table.id);
  await page.waitForFunction(() => Object.keys((window as unknown as W).__foundation.getState().maps).length === 1);
  await settle(page, 2000);

  const reset = () => page.evaluate(() => {
    const r = (window as unknown as W).__renders;
    for (const k of Object.keys(r)) delete r[k];
  });
  const read = () => page.evaluate(() => ({ ...(window as unknown as W).__renders }));
  const results: Array<{ action: string; renders: Record<string, number> }> = [];
  const count = async (action: string, act: () => Promise<void>) => {
    await reset();
    await act();
    await settle(page, 400);
    results.push({ action, renders: await read() });
  };
  const idOf = (name: string) => page.evaluate((n) => Object.values((window as unknown as W).__foundation.getState().notes).find((x) => x.name === n)!.id, name);
  const frame = async (id: string) => {
    await page.evaluate((i) => (window as unknown as W).__foundation.setState({ snapRequest: { kind: "object", id: i, nonce: Math.random() } }), id);
    await settle(page, 1500);
  };

  const note = await idOf("Notes A 0");
  await frame(note);
  const bar = (await page.locator(`[data-obj-id="${note}"] .frame-card`).boundingBox())!;

  await count("press a card", async () => {
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 12);
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.mouse.up();
  });
  await count("drag a card (60 moves)", async () => {
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 12);
    await page.waitForTimeout(250);
    await page.mouse.down();
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(bar.x + bar.width / 2 + Math.sin(i / 8) * 160, bar.y + 12 + Math.cos(i / 10) * 90);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  });
  const typed = await idOf("Notes A 3");
  await frame(typed);
  await page.locator(`[data-obj-id="${typed}"] .note-rendered`).dblclick();
  // the note editor is CodeMirror (feat/codemirror-notes): wait for it to mount and take the caret
  await page.locator(`[data-obj-id="${typed}"] .cm-editor .cm-content`).waitFor();
  await page.waitForFunction((i) => document.activeElement?.closest(`[data-obj-id="${i}"]`) !== null, typed);
  await count("type 30 characters in a note", async () => {
    await page.keyboard.press("End");
    await page.keyboard.type(" and thirty characters more ok", { delay: 30 });
  });
  await page.keyboard.press("Escape");
  await settle(page, 300);
  await page.mouse.move(720, 450);
  await count("pan (60 wheel events)", async () => {
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(i < 30 ? 16 : -16, 6);
      await page.waitForTimeout(16);
    }
  });
  await count("pinch zoom (60 ctrl-wheel events)", async () => {
    await page.keyboard.down("Control");
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, i < 30 ? -5 : 5);
      await page.waitForTimeout(16);
    }
    await page.keyboard.up("Control");
  });
  const other = await idOf("Notes B 5");
  await count("10 edits by someone else (a note in another section)", async () => {
    for (let i = 0; i < 10; i++) await tool("update_card", { id: other, markdown: `## Notes B 5\n\nedit ${i}` });
    await page.waitForFunction((id) => (window as unknown as { __foundation: { getState(): { notes: Record<string, { text: string }> } } }).__foundation.getState().notes[id]?.text.includes("edit 9"), other);
  });

  // the wires still draw: the table → map wire and the app wire, with the whole board in view
  await page.evaluate(() => (window as unknown as W).__foundation.setState({ snapRequest: { kind: "all", nonce: Math.random() } }));
  await settle(page, 1500);
  const wires = await page.evaluate(() => ({
    sheet: [...document.querySelectorAll(".wire-layer .wire-group path.pipe-wire")].filter((p) => (p.getAttribute("d") ?? "").length > 0).length,
    apps: [...document.querySelectorAll(".port-layer .pipe path.pipe-wire")].filter((p) => (p.getAttribute("d") ?? "").length > 0).length,
  }));
  await page.screenshot({ path: `${OUT}/board-with-wires.png` });
  expect(wires, "both wire layers draw their wire").toEqual({ sheet: 1, apps: 1 });

  const summary = { when: new Date().toISOString(), board: { notes: 26, tables: 1, maps: 1, apps: 2, wires: 2, sections: 4 }, strictMode: "dev server: every render counted twice", results };
  writeFileSync(`${OUT}/renders.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await context.close();

  // the board-wide layers: still through drags, typing and panning; a press renders the grid once (the active section moved)
  const of = (action: string) => results.find((r) => r.action.startsWith(action))!.renders;
  for (const action of ["drag", "type", "pan", "10 edits"]) {
    const r = of(action);
    for (const layer of ["GridViewport", "WireLayer", "MapView", "Present"]) expect(r[layer] ?? 0, `${layer} renders on ${action}`).toBe(0);
    // someone else's tool call can ring the card it touched: at most one render per edit
    expect(r.PortWires ?? 0, `PortWires renders on ${action}`).toBeLessThanOrEqual(action === "10 edits" ? 20 : 0);
  }
  expect(of("press").GridViewport ?? 0).toBeLessThanOrEqual(2);
  for (const layer of ["WireLayer", "PortWires", "MapView"]) expect(of("press")[layer] ?? 0, `${layer} renders on a press`).toBe(0);
});

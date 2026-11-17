/**
 * Two people on one board, in two browsers (Phase 1): typing in one note at
 * once, writing cells of one table at once, renaming a section — and both
 * end up looking at the same board. Then (2026-11-07) each sees where the
 * other is: pointer cursors on the board, named carets in a note, and ⌘Z
 * takes back only your own words. Since 2026-11-08 the note is CodeMirror on
 * the note's Y.Text (y-codemirror.next): two people typing into the very same
 * word keep two whole runs, never interleaved letters.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-08_codemirror-notes";
let ada: Page;
let kai: Page;
let board = "";

test.describe.configure({ mode: "serial" });

const state = (p: Page) =>
  p.evaluate(() => {
    const st = (window as unknown as { __foundation: { getState(): { sections: Record<string, { name: string }>; notes: Record<string, { name: string; text: string }> } } }).__foundation.getState();
    return { sections: Object.values(st.sections).map((s) => s.name).sort(), notes: Object.values(st.notes).map((n) => [n.name, n.text]) };
  });

test.beforeAll(async ({ browser }) => {
  // a fresh board, made by Ada; the server lays its first section
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await a.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Together ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  ada = a.page;
  await ada.goto(`/?board=${board}`);
  kai = (await person(browser, "Kai Test", "kai@normal.dev", board)).page;
  await ada.waitForFunction(() => (window as unknown as { __foundationBoard: () => { status: string } }).__foundationBoard().status === "live");
  // one note to share, made through the board tools (as an agent or a person's script would)
  await a.context.request.post(`${CLIENT}/api/boards/${board}/tools/add_note`, { data: { title: "Shared", markdown: "Goals:\n\nRisks:\n" } });
  await settle(ada, 800);
});

type Ed = { __view: { state: { doc: { toString(): string; length: number } }; dispatch(t: object): void; focus(): void } };

/** what the note's open editor holds */
const text = (ed: Locator) => ed.evaluate((el) => (el as unknown as Ed).__view.state.doc.toString());

/** frame the shared note, open it for writing, and put the caret at `at` (an index, "goals" = after "Goals:
", or the end) */
async function openShared(p: Page, at: "goals" | "end" | number) {
  const id = await p.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { notes: Record<string, { id: string; name: string }> } } }).__foundation.getState().notes).find((n) => n.name === "Shared")!.id);
  await p.evaluate((i) => (window as unknown as { __foundation: { setState(x: object): void } }).__foundation.setState({ snapRequest: { kind: "object", id: i, nonce: Math.random() } }), id);
  await settle(p, 1200);
  await p.locator(`[data-obj-id="${id}"] .note-rendered`).dblclick();
  // CodeMirror, loaded on first use, bound to the note's shared text
  const ed = p.locator(`[data-obj-id="${id}"] .cm-editor`);
  await ed.waitFor();
  await p.waitForFunction((i) => !!(document.querySelector(`[data-obj-id="${i}"] .cm-editor`) as unknown as Ed | null)?.__view, id);
  await ed.evaluate((el, where) => {
    const v = (el as unknown as Ed).__view;
    const doc = v.state.doc.toString();
    const pos = where === "goals" ? doc.indexOf("\n") + 1 : where === "end" ? doc.length : (where as number);
    v.focus();
    v.dispatch({ selection: { anchor: pos } });
  }, at);
  return ed;
}

test("both see one board, with one first section", async () => {
  const [a, k] = [await state(ada), await state(kai)];
  expect(a.sections).toEqual(["Section 1"]);
  expect(k).toEqual(a);
});

test("two people typing in one note at once both keep their words", async () => {
  const [ea, ek] = [await openShared(ada, "goals"), await openShared(kai, "end")];
  // interleaved keystrokes, as two people typing at the same time
  const a = "- ship the fan\n";
  const k = "- supplier slip\n";
  for (let i = 0; i < Math.max(a.length, k.length); i++) {
    if (a[i]) await ada.keyboard.type(a[i]);
    if (k[i]) await kai.keyboard.type(k[i]);
  }
  await settle(ada, 800);
  const want = "Goals:\n- ship the fan\n\nRisks:\n- supplier slip\n";
  expect(await text(ea)).toBe(want);
  expect(await text(ek)).toBe(want);
  await ada.screenshot({ path: `${SHOTS}/01_ada-note.png` });
  await kai.screenshot({ path: `${SHOTS}/02_kai-note.png` });
  await ada.keyboard.press("Escape");
  await kai.keyboard.press("Escape");
});

test("two people writing cells of one table at once both land", async () => {
  // Ada adds a table from the section's own tools
  const sec = await ada.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { sections: object } } }).__foundation.getState().sections)[0]);
  const card = ada.locator(`.section-card[data-section-id="${sec}"]`);
  await ada.evaluate(() => (window as unknown as { __foundation: { setState(x: object): void } }).__foundation.setState({ snapRequest: { kind: "all", nonce: Math.random() } }));
  await settle(ada, 1200);
  const box = (await card.boundingBox())!;
  await ada.mouse.move(box.x + 40, box.y + 8); // the pointer on the section calls its tools
  await card.locator('[aria-label="Add a table"]').click();
  await settle(ada, 1000);
  const id = await ada.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { tables: object } } }).__foundation.getState().tables)[0]);
  expect(id, "a table to write in").toBeTruthy();
  await kai.waitForFunction((t) => !!(window as unknown as { __foundation: { workbook: { getTable(id: string): unknown } } }).__foundation.workbook.getTable(t), id);
  // both write without having seen the other's cells
  const write = (p: Page, col: number, vals: string[]) =>
    p.evaluate(([t, c, v]) => {
      const wb = (window as unknown as { __foundation: { workbook: { setCell(t: string, c: number, r: number, raw: string): void } } }).__foundation.workbook;
      (v as string[]).forEach((raw, r) => wb.setCell(t as string, c as number, r, raw));
    }, [id, col, vals] as const);
  await Promise.all([write(ada, 0, ["Part", "Shroud", "Hub"]), write(kai, 1, ["Qty", "2", "=B2*3"])]);
  await settle(ada, 1000);
  const cells = (p: Page) =>
    p.evaluate((t) => {
      const tb = (window as unknown as { __foundation: { workbook: { getTable(id: string): { cells: Map<string, { raw: string }> } } } }).__foundation.workbook.getTable(t);
      return Object.fromEntries([...tb.cells].filter(([, c]) => c.raw).map(([k, c]) => [k, c.raw]).sort());
    }, id);
  const want = { "0,0": "Part", "0,1": "Shroud", "0,2": "Hub", "1,0": "Qty", "1,1": "2", "1,2": "=B2*3" };
  expect(await cells(ada)).toEqual(want);
  expect(await cells(kai)).toEqual(want);
});

test("a rename by one is seen by the other, and both boards match", async () => {
  await ada.evaluate(() => {
    const f = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> }; setState(x: object): void } }).__foundation;
    const st = f.getState();
    const s = Object.values(st.sections)[0];
    f.setState({ sections: { ...st.sections, [s.id]: { ...s, name: "Fan programme" } } });
  });
  await kai.waitForFunction(() => Object.values((window as unknown as { __foundation: { getState(): { sections: Record<string, { name: string }> } } }).__foundation.getState().sections).some((s) => s.name === "Fan programme"));
  expect(await state(kai)).toEqual(await state(ada));
});

test("each sees the other's pointer on the board", async () => {
  await ada.mouse.move(700, 420);
  await ada.mouse.move(720, 440, { steps: 4 });
  await kai.waitForFunction(() => [...document.querySelectorAll(".peer-cursor .peer-name")].some((n) => n.textContent === "Ada Test"));
  await kai.mouse.move(500, 300);
  await kai.mouse.move(520, 320, { steps: 4 });
  await ada.waitForFunction(() => [...document.querySelectorAll(".peer-cursor .peer-name")].some((n) => n.textContent === "Kai Test"));
});

test("each sees where the other is writing; ⌘Z takes back only your own words", async () => {
  const before = "Goals:\n- ship the fan\n\nRisks:\n- supplier slip\n";
  const [ea, ek] = [await openShared(ada, "goals"), await openShared(kai, "end")];
  expect(await text(ea)).toBe(before);
  // a named caret for the other person, in both editors
  await ada.locator(".note-caret-name", { hasText: "Kai Test" }).waitFor();
  await kai.locator(".note-caret-name", { hasText: "Ada Test" }).waitFor();
  await ada.keyboard.type("- tooling\n");
  await kai.keyboard.type("- late resin\n");
  await settle(ada, 700);
  const both = "Goals:\n- tooling\n- ship the fan\n\nRisks:\n- supplier slip\n- late resin\n";
  expect(await text(ea)).toBe(both);
  expect(await text(ek)).toBe(both);
  await ada.screenshot({ path: `${SHOTS}/05_ada-sees-kai-writing.png` });
  await kai.screenshot({ path: `${SHOTS}/06_kai-sees-ada-writing.png` });
  // Ada's undo takes back her line; Kai's stays, in both editors
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await ada.keyboard.press(`${mod}+z`);
  await settle(ada, 700);
  const undone = "Goals:\n- ship the fan\n\nRisks:\n- supplier slip\n- late resin\n";
  expect(await text(ea)).toBe(undone);
  expect(await text(ek)).toBe(undone);
  // and redo puts it back
  await ada.keyboard.press(`${mod}+Shift+z`);
  await settle(ada, 700);
  expect(await text(ek)).toBe(both);
  // Ada closes the note: a chip names whoever is still writing in it, until they stop
  await ada.keyboard.press("Escape");
  await ada.locator(".note-writer", { hasText: "Kai Test" }).waitFor();
  await ada.screenshot({ path: `${SHOTS}/07_ada-sees-kai-in-the-note.png` });
  await kai.keyboard.press("Escape");
  await expect(ada.locator(".note-writer")).toHaveCount(0);
});

test("two people typing into the very same word keep both words whole", async () => {
  const before = "Goals:\n- tooling\n- ship the fan\n\nRisks:\n- supplier slip\n- late resin\n";
  // both carets inside "supplier", after "sup"
  const at = before.indexOf("supplier") + 3;
  const [ea, ek] = [await openShared(ada, at), await openShared(kai, at)];
  expect(await text(ea)).toBe(before);
  // keystrokes interleaved, one each, as two people typing at once into one spot
  const a = "[ada words]";
  const k = "(kai words)";
  for (let i = 0; i < Math.max(a.length, k.length); i++) {
    if (a[i]) await ada.keyboard.type(a[i]);
    if (k[i]) await kai.keyboard.type(k[i]);
  }
  await settle(ada, 800);
  const got = await text(ea);
  expect(await text(ek)).toBe(got);
  // each run whole, in one order or the other, never letters shuffled together
  const head = before.slice(0, at);
  const tail = before.slice(at);
  expect([head + a + k + tail, head + k + a + tail]).toContain(got);
  await ada.screenshot({ path: `${SHOTS}/08_same-word_ada.png` });
  await kai.screenshot({ path: `${SHOTS}/09_same-word_kai.png` });
  // and each one's undo takes back only their own run
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await kai.keyboard.press(`${mod}+z`);
  await settle(kai, 700);
  expect(await text(ea)).toBe(head + a + tail);
  expect(await text(ek)).toBe(head + a + tail);
  await ada.keyboard.press(`${mod}+z`);
  await settle(ada, 700);
  expect(await text(ek)).toBe(before);
  await ada.keyboard.press("Escape");
  await kai.keyboard.press("Escape");
});

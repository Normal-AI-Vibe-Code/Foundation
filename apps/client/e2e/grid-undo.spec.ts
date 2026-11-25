/**
 * Image and video cards, picked up and put away, and the grid's undo (2026-11-24, Josh: "Image cards and
 * media cards need to be grabbable and movable around the grid, the UI to expand and remove them needs to be
 * improved as well, The expansion icon should be in the top right of the card, the remove or delete item can
 * be in a right mouse click context menu, or be deleted when selected by keyboard shortcut. these actions
 * should also be able to be undone. If we haven't implemented a strong sequence for undo and redo of actions
 * on the grid we should do so now."), in a real browser with real mouse moves and keys:
 *
 *  1. an image is picked up anywhere on it and moves; its full screen button is in its top-right corner
 *     and opens it full screen; it has no ✕
 *  2. Delete removes the selected image; the right-click menu's Remove does too; ⌘Z brings each back, ⇧⌘Z
 *     (and Ctrl+Y) takes it away again; a move is undone and redone as one step however many frames it took
 *  3. undo is yours: a second person's move of another card isn't undone by your ⌘Z, and sees yours undone
 *  4. the keys are the text's in a note: ⌘Z and Backspace there never touch the grid
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-24_media-undo";
const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#6f8f6a"/><circle cx="160" cy="100" r="60" fill="#d9c8a0"/></svg>')}`;

type Obj = { id: string; name: string; sectionId: string; x: number; y: number; float: boolean; autoplay?: boolean };
type State = { notes: Record<string, Obj>; media: Record<string, Obj>; sections: Record<string, { id: string; name: string }>; activeObjectId: string | null; focusLevel: string };
type Store = { getState(): State; setState(p: object): void };

let ada: Page;
let bo: Page;
let ctx: BrowserContext;
let board = "";
const PIC = "med_pic_u";
const CLIP = "med_vid_u";
let NOTE = "";

const tool = (name: string, data: object) => ctx.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
const media = (p: Page, id: string) =>
  p.evaluate((i) => {
    const m = (window as unknown as { __foundation: Store }).__foundation.getState().media[i];
    return m ? { x: Math.round(m.x), y: Math.round(m.y), float: m.float } : null;
  }, id);
const slot = (p: Page, id: string) => p.locator(`.obj-slot[data-obj-id="${id}"]`);
const mid = async (p: Page, sel: string) => {
  const b = (await p.locator(sel).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
};
const frame = (p: Page, id: string) => p.evaluate((i) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "object", id: i, nonce: Math.random() } }), id);
async function drag(p: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  await p.mouse.move(from.x, from.y, { steps: 6 });
  await p.waitForTimeout(200);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(from.x + (by.x * i) / 12, from.y + (by.y * i) / 12, { steps: 2 });
  await p.waitForTimeout(60);
  await p.mouse.up();
  await settle(p, 500);
}
async function click(p: Page, x: number, y: number, button: "left" | "right" = "left") {
  await p.mouse.move(x, y, { steps: 6 });
  await p.waitForTimeout(200);
  await p.mouse.down({ button });
  await p.waitForTimeout(40);
  await p.mouse.up({ button });
  await p.waitForTimeout(150);
}
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Undo ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  await tool("add_section", { name: "Media" });
  await tool("add_note", { section: "Media", title: "Beside", markdown: "# Beside\n\nWords beside the pictures." });
  await ada.goto(`/?board=${board}`);
  await waitLive(ada);
  await ada.evaluate(
    ([src, pic, clip]) => {
      const f = (window as unknown as { __foundation: Store }).__foundation;
      const s = f.getState();
      const sec = Object.values(s.sections).find((x) => x.name === "Media")!;
      const base = { x: 0, y: 0, float: false, bornAt: Date.now() };
      f.setState({
        media: {
          ...s.media,
          [pic]: { ...base, id: pic, sectionId: sec.id, name: "Picture", media: "image", src, w: 320, h: 200, autoplay: false, muted: true },
          [clip]: { ...base, id: clip, sectionId: sec.id, name: "Clip", media: "video", src: "/e2e/none.webm", w: 320, h: 200, autoplay: false, muted: true },
        },
      });
    },
    [PICTURE, PIC, CLIP],
  );
  NOTE = await ada.evaluate(() => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().notes).find((n) => n.name === "Beside")!.id);
  const b = await person(browser, "Bo Test", "bo@normal.dev", board);
  bo = b.page;
  await expect.poll(() => media(bo, PIC)).not.toBeNull();
  await expect.poll(() => media(bo, CLIP)).not.toBeNull();
});

test("1 · an image is picked up anywhere on it; full screen is top right; no ✕", async () => {
  await frame(ada, PIC);
  await settle(ada, 1400);
  const s = slot(ada, PIC);
  await expect(s.locator(".frame-corner")).toHaveCSS("opacity", "0");
  await expect(s.locator(".is-remove, .frame-grip")).toHaveCount(0);
  const c = await mid(ada, `.obj-slot[data-obj-id="${PIC}"] .frame-card`);
  await ada.mouse.move(c.x, c.y, { steps: 5 });
  await settle(ada, 500);
  await expect(s.locator(".frame-corner")).toHaveCSS("opacity", "1");
  await expect(s.locator(".frame-card")).toHaveCSS("cursor", "grab");
  const fs = (await s.locator(".frame-corner .fs-open").boundingBox())!;
  const scale = c.b.width / 320;
  expect(Math.abs(c.b.x + c.b.width - (fs.x + fs.width) - 8 * scale), "full screen sits 8 px in from the right").toBeLessThan(2.5);
  expect(Math.abs(fs.y - c.b.y - 8 * scale), "and 8 px down from the top").toBeLessThan(2.5);
  await ada.screenshot({ path: `${SHOTS}/01_image-hover-night.png`, clip: { x: c.b.x - 40, y: c.b.y - 40, width: c.b.width + 80, height: c.b.height + 80 } });

  // picked up by the picture itself
  const before = (await media(ada, PIC))!;
  await drag(ada, { x: c.x - 40, y: c.y + 20 }, { x: 120, y: 70 });
  const after = (await media(ada, PIC))!;
  expect(after.float, "picked up, it floats").toBe(true);
  expect(Math.hypot(after.x - before.x, after.y - before.y), "and it moved").toBeGreaterThan(60);
  await expect.poll(() => media(bo, PIC), { message: "the other person sees it move" }).toEqual(after);

  // the corner's full screen opens it
  const c2 = await mid(ada, `.obj-slot[data-obj-id="${PIC}"] .frame-card`);
  await ada.mouse.move(c2.x, c2.y, { steps: 4 });
  await settle(ada, 500);
  const btn = await mid(ada, `.obj-slot[data-obj-id="${PIC}"] .frame-corner .fs-open`);
  await click(ada, btn.x, btn.y);
  await expect(ada.locator(".fs-bar")).toBeVisible();
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/02_image-full-screen-night.png` });
  await ada.locator(".fs-bar button", { hasText: "Back to the grid" }).click();
  await expect(ada.locator(".fs-bar")).toHaveCount(0);
  await settle(ada, 600);
});

test("2 · Delete and the menu remove it; ⌘Z brings it back, ⇧⌘Z and Ctrl+Y take it again; a move is one step", async () => {
  await frame(ada, PIC);
  await settle(ada, 1400);
  const at = (await media(ada, PIC))!;

  // a move, undone and redone as one step
  const c = await mid(ada, `.obj-slot[data-obj-id="${PIC}"] .frame-card`);
  await drag(ada, { x: c.x - 30, y: c.y + 10 }, { x: -90, y: 50 });
  const moved = (await media(ada, PIC))!;
  expect(Math.hypot(moved.x - at.x, moved.y - at.y)).toBeGreaterThan(50);
  await ada.mouse.move(4, 450, { steps: 3 });
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(() => media(ada, PIC), { message: "⌘Z puts it back where it was, in one step" }).toEqual(at);
  await expect.poll(() => media(bo, PIC), { message: "for everyone" }).toEqual(at);
  await ada.keyboard.press(`${MOD}+Shift+z`);
  await expect.poll(() => media(ada, PIC), { message: "⇧⌘Z moves it again" }).toEqual(moved);

  // selected, Delete removes it
  await frame(ada, PIC);
  await settle(ada, 1400);
  const c2 = await mid(ada, `.obj-slot[data-obj-id="${PIC}"] .frame-card`);
  await click(ada, c2.x, c2.y);
  await expect.poll(() => ada.evaluate(() => (window as unknown as { __foundation: Store }).__foundation.getState().activeObjectId)).toBe(PIC);
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/03_image-selected-night.png`, clip: { x: c2.b.x - 40, y: c2.b.y - 40, width: c2.b.width + 80, height: c2.b.height + 80 } });
  await ada.keyboard.press("Delete");
  await expect.poll(() => media(ada, PIC), { message: "Delete removes the selected image" }).toBeNull();
  await expect(ada.locator(".toast", { hasText: "Removed Picture" })).toBeVisible();
  await ada.screenshot({ path: `${SHOTS}/04_removed-toast-night.png` });
  await expect.poll(() => media(bo, PIC)).toBeNull();
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(() => media(ada, PIC), { message: "⌘Z brings it back, where it was" }).toEqual(moved);
  await expect(slot(ada, PIC).locator("img")).toBeVisible();
  await expect.poll(() => media(bo, PIC), { message: "for everyone" }).toEqual(moved);
  await ada.keyboard.press(`${MOD}+y`);
  await expect.poll(() => media(ada, PIC), { message: "Ctrl+Y takes it away again" }).toBeNull();
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(() => media(ada, PIC)).toEqual(moved);

  // the right-click menu's Remove, with its key named; Backspace on the video
  await frame(ada, CLIP);
  await settle(ada, 1400);
  const v = await mid(ada, `.obj-slot[data-obj-id="${CLIP}"] .frame-card`);
  await click(ada, v.x, v.y, "right");
  const item = ada.locator(".context-menu .menu-item", { hasText: "Remove this video" });
  await expect(item).toBeVisible();
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/05_video-menu-night.png` });
  await item.click();
  await expect.poll(() => media(ada, CLIP), { message: "the menu's Remove removes it" }).toBeNull();
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(() => media(ada, CLIP), { message: "and ⌘Z brings it back" }).not.toBeNull();
  await frame(ada, CLIP);
  await settle(ada, 1400);
  const v2 = await mid(ada, `.obj-slot[data-obj-id="${CLIP}"] .frame-card`);
  await click(ada, v2.x, v2.y); // a tap selects it (and plays it)
  await ada.keyboard.press("Backspace");
  await expect.poll(() => media(ada, CLIP), { message: "Backspace removes the selected video" }).toBeNull();
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(() => media(ada, CLIP)).not.toBeNull();
});

test("3 · undo is yours: a teammate's move stays, and they see yours undone", async () => {
  await frame(ada, PIC);
  await frame(bo, CLIP);
  await settle(ada, 1400);
  const picAt = (await media(ada, PIC))!;
  // Ada moves the picture
  const c = await mid(ada, `.obj-slot[data-obj-id="${PIC}"] .frame-card`);
  await drag(ada, { x: c.x, y: c.y }, { x: 80, y: -40 });
  const picMoved = (await media(ada, PIC))!;
  expect(picMoved).not.toEqual(picAt);
  // then Bo moves the clip
  const v = await mid(bo, `.obj-slot[data-obj-id="${CLIP}"] .frame-card`);
  await drag(bo, { x: v.x - 40, y: v.y }, { x: 60, y: 60 });
  const clipMoved = (await media(bo, CLIP))!;
  await expect.poll(() => media(ada, CLIP)).toEqual(clipMoved);
  // Ada's undo takes back her move, not his
  await ada.keyboard.press(`${MOD}+z`);
  await expect.poll(() => media(ada, PIC), { message: "Ada's ⌘Z undoes Ada's move" }).toEqual(picAt);
  expect(await media(ada, CLIP), "and leaves Bo's").toEqual(clipMoved);
  await expect.poll(() => media(bo, PIC), { message: "Bo sees hers undone" }).toEqual(picAt);
  expect(await media(bo, CLIP)).toEqual(clipMoved);
});

test("4 · in a note, ⌘Z and Backspace are the note's", async () => {
  await frame(ada, NOTE);
  await settle(ada, 1400);
  const pic = (await media(ada, PIC))!;
  // the note as its markdown (CodeMirror, through its bar's Markdown button), with the caret in it
  await ada.locator(`.obj-slot[data-obj-id="${NOTE}"] .note-rendered`).hover();
  await ada.locator(`.obj-slot[data-obj-id="${NOTE}"] .note-md-btn`).click();
  await ada.locator(`.obj-slot[data-obj-id="${NOTE}"] .cm-content`).waitFor();
  await ada.waitForFunction((i) => document.activeElement?.closest(`[data-obj-id="${i}"]`) != null, NOTE);
  await ada.keyboard.press(`${MOD}+End`);
  await ada.keyboard.type(" More");
  await ada.keyboard.press("Backspace");
  await ada.keyboard.press(`${MOD}+z`);
  expect(await media(ada, PIC), "the grid didn't step back").toEqual(pic);
  await expect.poll(() => ada.evaluate((i) => (window as unknown as { __foundation: Store }).__foundation.getState().notes[i] !== undefined, NOTE), { message: "Backspace in a note never removes the note" }).toBe(true);
  await ada.keyboard.press("Escape");
});

test("5 · day: the corner and the selected image", async () => {
  await ada.emulateMedia({ colorScheme: "light" });
  await ada.reload();
  await waitLive(ada);
  await frame(ada, PIC);
  await settle(ada, 1600);
  const c = await mid(ada, `.obj-slot[data-obj-id="${PIC}"] .frame-card`);
  await click(ada, c.x, c.y);
  await ada.mouse.move(c.x + 10, c.y, { steps: 3 });
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/06_image-hover-selected-day.png`, clip: { x: c.b.x - 40, y: c.b.y - 40, width: c.b.width + 80, height: c.b.height + 80 } });
});

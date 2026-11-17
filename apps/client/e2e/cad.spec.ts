/**
 * CAD on a card (Phase 2): a STEP read by OpenCascade (as Vision reads it)
 * and an STL, each shown as the part with its size, turned by dragging,
 * day and night. The STEP is Vision's own fan export, read from the Vision
 * repo on this machine (not copied into this public repo); skipped without it.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-03_vision-loop";
const STEP = join(homedir(), "Development/Vision/docs/evidence/2026-10-29_fan-goals-manti/manti/exports/vane-board-5-fv50-1300-vanes.step");

/** a binary STL: a stepped block (so turning it shows) */
function stl(): Buffer {
  const tris: number[][] = [];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]) tris.push([...p[a], ...p[b], ...p[c]], [...p[a], ...p[c], ...p[d]]);
  };
  box(0, 0, 0, 60, 40, 10);
  box(10, 5, 10, 40, 35, 30);
  box(15, 10, 30, 30, 25, 45);
  const b = Buffer.alloc(84 + tris.length * 50);
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.forEach((v, k) => b.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  return b;
}

/** a file dropped on the board the way a person does (the board's own file input → ingest) */
async function cadCard(page: Page, name: string, bytes: Buffer, mime: string) {
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: mime, buffer: bytes });
}

for (const scheme of ["dark", "light"] as const) {
  test(`STEP and STL cards show the part, and turn (${scheme})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
    await page.emulateMedia({ colorScheme: scheme });
    const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `CAD ${scheme} ${Date.now().toString(36)}` } });
    const board = ((await made.json()) as { id: string }).id;
    await page.goto(`/?board=${board}`);
    await page.waitForFunction(() => (window as unknown as { __foundationBoard: () => { status: string } }).__foundationBoard()?.status === "live");
    const ids: string[] = [];
    if (existsSync(STEP)) {
      await cadCard(page, "vane-board.step", readFileSync(STEP), "model/step");
      ids.push("step");
    }
    await cadCard(page, "stepped-block.stl", stl(), "model/stl");
    ids.push("stl");
    await page.waitForFunction((n) => document.querySelectorAll(".cad-stage").length >= n, ids.length, { timeout: 30_000 });
    await page.evaluate(() => (window as unknown as { __foundation: { setState(x: object): void } }).__foundation.setState({ snapRequest: { kind: "all", nonce: Math.random() } }));
    // OpenCascade is a ~10 MB WebAssembly module: give the first read time
    await page.waitForFunction((n) => [...document.querySelectorAll<HTMLImageElement>(".cad-stage img")].filter((i) => i.naturalWidth > 0).length >= n, ids.length, { timeout: 60_000 });
    await settle(page, 800);
    const infos = await page.locator(".cad-info").allTextContents();
    expect(infos.length).toBe(ids.length);
    for (const i of infos) expect(i).toMatch(/\d+ × \d+ × \d+.* · [\d,]+ triangles/);
    await page.screenshot({ path: `${SHOTS}/cad-${scheme}.png` });
    // drag a part to turn it: the still changes
    const stage = page.locator(".cad-stage").last();
    const before = await stage.locator("img").getAttribute("src");
    const b = (await stage.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 30, { steps: 10 });
    await page.mouse.up();
    await settle(page, 300);
    expect(await stage.locator("img").getAttribute("src")).not.toBe(before);
    if (scheme === "dark") await page.screenshot({ path: `${SHOTS}/cad-turned.png` });
    await context.close();
  });
}

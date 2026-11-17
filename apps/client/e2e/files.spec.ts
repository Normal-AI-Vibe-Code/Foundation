/**
 * Adding files and finding what's inside them, in a real browser:
 *  - an image pasted onto the board lands where the pointer is, in the section under it;
 *  - a whole folder dropped on a section is walked (in batches, hidden files and
 *    node_modules left out) and comes in as a group in path order under a note naming it,
 *    through one upload tray;
 *  - the PDF and Word file in it become searchable by their words, and ⌘K and the search
 *    pane show the match marked;
 *  - a viewer's paste adds nothing, and the server refuses a viewer's upload.
 * Synthetic paste and drop events carry real Files; a folder is a stand-in entry tree
 * (a page can't make a real directory entry), walked by the app's own code.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-08_files-search";
const DOCS = "../server/test/fixtures/docs"; // from apps/client, where the runner starts
const BOARD = "files-e2e";
const b64 = (p: string) => readFileSync(`${DOCS}/${p}`).toString("base64");

type St = {
  sections: Record<string, { id: string; name: string }>;
  media: Record<string, { id: string; sectionId: string; name: string; src: string; float: boolean; x: number; y: number; bornAt: number }>;
  panels: Record<string, { id: string; sectionId: string; name: string; fileId?: string; status?: string; bornAt: number }>;
  notes: Record<string, { id: string; sectionId: string; text: string; bornAt: number }>;
};
const state = (page: Page) => page.evaluate(() => (window as unknown as { __foundation: { getState(): St } }).__foundation.getState()) as Promise<St>;

async function signIn(browser: import("@playwright/test").Browser, name: string, email: string, scheme: "dark" | "light"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const page = await context.newPage();
  return { context, page };
}

async function open(page: Page) {
  await page.goto(`/?rafshim&board=${BOARD}`);
  await waitLive(page);
  await settle(page, 1200);
}

let ada: { context: BrowserContext; page: Page };

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  ada = await signIn(browser, "Ada Admin", "admin@normal.dev", "dark");
  // a board of its own, so nothing else on the server's boards moves
  const made = await ada.context.request.post(`${CLIENT}/api/boards`, { data: { name: BOARD } });
  expect(made.ok(), await made.text()).toBeTruthy();
  await open(ada.page);
});

test.afterAll(async () => {
  await ada?.context.close();
});

test("an image pasted onto the board lands under the pointer, in that section", async () => {
  const page = ada.page;
  const sec = page.locator(".section-card[data-section-id]").first();
  const box = (await sec.boundingBox())!;
  const at = { x: Math.round(box.x + box.width * 0.6), y: Math.round(box.y + box.height * 0.55) };
  await page.mouse.move(at.x, at.y);
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(320, 200);
    const g = c.getContext("2d")!;
    g.fillStyle = "#325bb4";
    g.fillRect(0, 0, 320, 200);
    g.fillStyle = "#f6f3ec";
    g.fillRect(40, 40, 240, 120);
    const blob = await c.convertToBlob({ type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => Object.values((await state(page)).media).length, { timeout: 10_000 }).toBe(1);
  const m = Object.values((await state(page)).media)[0];
  expect(m.name).toMatch(/^Pasted image \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/);
  expect(m.float).toBe(true);
  await expect.poll(async () => Object.values((await state(page)).media)[0].src, { timeout: 15_000 }).toMatch(/^\/files\/f_/);
  // it sits where the pointer was: its card's top-left is just up-left of the pointer
  const card = (await page.locator(`[data-obj-id="${m.id}"] .frame-card`).first().boundingBox())!;
  expect(Math.abs(card.x - at.x)).toBeLessThan(card.width);
  expect(Math.abs(card.y - at.y)).toBeLessThan(60);
  expect(card.x).toBeLessThan(at.x);
  await page.screenshot({ path: `${SHOTS}/01_pasted-under-pointer_night.png` });
});

test("a folder dropped on a section comes in as a group, in order, through one tray", async () => {
  const page = ada.page;
  // the paste's tray has gone by itself
  await expect(page.locator(".upload-tray")).toBeHidden({ timeout: 6000 });
  // slow the uploads so the tray can be seen at work
  const cdp = await ada.context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 30, downloadThroughput: -1, uploadThroughput: 900 * 1024 });
  const secId = await page.locator(".section-card[data-section-id]").first().getAttribute("data-section-id");
  await page.evaluate(
    async ({ secId, pdf, docx }) => {
      const png = async (hex: string) => {
        const c = new OffscreenCanvas(640, 420);
        const g = c.getContext("2d")!;
        g.fillStyle = hex;
        g.fillRect(0, 0, 640, 420);
        // grain that won't compress, so each picture is most of a megabyte and the tray has something to show
        const img = g.getImageData(0, 0, 640, 420);
        for (let i = 0; i < img.data.length; i += 4) {
          const n = (Math.random() - 0.5) * 70;
          img.data[i] += n;
          img.data[i + 1] += n;
          img.data[i + 2] += n;
        }
        g.putImageData(img, 0, 0);
        return c.convertToBlob({ type: "image/png" });
      };
      const bytes = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
      const tree = {
        "Renders": {
          "front 2.png": await png("#325bb4"),
          "front 10.png": await png("#2e7d54"),
          "side.png": await png("#a16207"),
          ".DS_Store": new Blob(["x"]),
          "CAD": { "shroud.step": new Blob(["ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Osterlund fan shroud'),'2;1');\nENDSEC;\n"], { type: "model/step" }) },
          "Docs": {
            "intake-spec.pdf": new Blob([bytes(pdf)], { type: "application/pdf" }),
            "bracket.docx": new Blob([bytes(docx)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
          },
          "node_modules": { "left-out.js": new Blob(["//"]) },
        },
      } as Record<string, unknown>;
      // stand-in FileSystemEntry tree; readEntries hands entries over two at a time, then none
      type Node = Blob | { [k: string]: Node };
      const entry = (name: string, node: Node, path: string): unknown => {
        if (node instanceof Blob) {
          const file = new File([node], name, { type: node.type });
          return { name, isFile: true, isDirectory: false, fullPath: path, file: (ok: (f: File) => void) => ok(file) };
        }
        const kids = Object.entries(node).map(([k, v]) => entry(k, v, `${path}/${k}`));
        return {
          name, isFile: false, isDirectory: true, fullPath: path,
          createReader: () => {
            let i = 0;
            return { readEntries: (ok: (e: unknown[]) => void) => setTimeout(() => ok(kids.slice(i, (i += 2))), 1) };
          },
        };
      };
      const root = entry("Renders", tree.Renders as Node, "/Renders");
      const dt = new DataTransfer();
      dt.items.add(new File(["folder"], "Renders", { type: "" }));
      const real = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        return this.getAsFile()?.name === "Renders" ? (root as FileSystemEntry) : real.call(this);
      };
      const target = document.querySelector(`.section-card[data-section-id="${secId}"]`)!;
      target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      DataTransferItem.prototype.webkitGetAsEntry = real;
    },
    { secId, pdf: b64("spec.pdf"), docx: b64("doc.docx") },
  );
  // the tray, at work
  const tray = page.locator(".upload-tray");
  await expect(tray).toBeVisible({ timeout: 5000 });
  await expect(tray.locator(".upload-title")).toContainText(/Uploading \d+ of 6/);
  await expect(tray.locator(".upload-row")).toHaveCount(6);
  await expect(tray.locator(".upload-row-dir").first()).toHaveText("CAD/");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/02_folder-drop-tray-at-work_night.png` });
  await tray.screenshot({ path: `${SHOTS}/02b_tray-at-work_night.png` });
  // never more than three on their way at once
  const sending = await tray.locator(".upload-row.is-sending").count();
  expect(sending).toBeLessThanOrEqual(3);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await expect(tray.locator(".upload-title")).toHaveText("6 added", { timeout: 30_000 });
  await tray.screenshot({ path: `${SHOTS}/03_tray-all-added_night.png` });
  // the group: a note naming the folder, then the files in path order (numbers in order: 2 before 10)
  const st = await state(page);
  const cards = [
    ...Object.values(st.notes).filter((n) => n.sectionId === secId).map((n) => ({ name: n.text.split("\n")[0], bornAt: n.bornAt })),
    ...Object.values(st.media).filter((m) => m.sectionId === secId && !m.float).map((m) => ({ name: m.name, bornAt: m.bornAt })),
    ...Object.values(st.panels).filter((p) => p.sectionId === secId).map((p) => ({ name: p.name, bornAt: p.bornAt })),
  ].sort((a, b) => a.bornAt - b.bornAt);
  expect(cards.map((c) => c.name)).toEqual(["## Renders", "shroud.step", "bracket.docx", "intake-spec.pdf", "front 2.png", "front 10.png", "side.png"]);
  expect(Object.values(st.panels).every((p) => p.fileId && !p.status)).toBe(true);
  // and it goes by itself
  await expect(tray).toBeHidden({ timeout: 6000 });
  await settle(page, 600);
  await page.screenshot({ path: `${SHOTS}/04_folder-laid-out_night.png` });
});

test("what's inside the PDF and the Word file is found, the match marked, in ⌘K and the search pane", async ({ browser }) => {
  const page = ada.page;
  await expect
    .poll(async () => {
      const r = await page.request.get(`${CLIENT}/api/search?q=osterlund&board=${BOARD}&remote=0`);
      const hits = ((await r.json()) as { hits: Array<{ title: string; snippet: string }> }).hits;
      return hits.find((h) => h.title === "intake-spec.pdf")?.snippet ?? "";
    }, { timeout: 20_000 })
    .toMatch(/«Osterlund»/);
  for (const scheme of ["dark", "light"] as const) {
    const who = scheme === "dark" ? ada : await signIn(browser, "Ada Admin", "admin@normal.dev", "light");
    const p = who.page;
    if (scheme === "light") await open(p);
    const tag = scheme === "dark" ? "night" : "day";
    // ⌘K
    await p.keyboard.press("Control+K");
    await p.locator(".cmd input").fill("osterlund");
    const row = p.locator(".cmd-row.is-hit", { hasText: "intake-spec.pdf" });
    await expect(row).toBeVisible({ timeout: 8000 });
    await expect(row.locator(".cmd-row-hint mark").first()).toHaveText("Osterlund");
    await p.locator(".cmd input").fill("zephyrine");
    await expect(p.locator(".cmd-row.is-hit", { hasText: "bracket.docx" }).locator("mark").first()).toHaveText("Zephyrine", { timeout: 8000 });
    await p.locator(".cmd input").fill("torque");
    await expect(p.locator(".cmd-row.is-hit", { hasText: "intake-spec.pdf" })).toBeVisible({ timeout: 8000 });
    await settle(p, 500);
    await p.screenshot({ path: `${SHOTS}/05_cmdk-inside-documents_${tag}.png` });
    await p.keyboard.press("Escape");
    await settle(p, 400);
    // the search pane
    await p.keyboard.press("Control+F");
    await p.locator(".search-field").fill("osterlund");
    const srow = p.locator(".search-row", { hasText: "intake-spec.pdf" });
    await expect(srow.locator(".search-row-snip mark").first()).toHaveText("Osterlund", { timeout: 8000 });
    await expect(p.locator(".search-row", { hasText: "shroud.step" })).toBeVisible(); // the STEP header's description
    await settle(p, 500);
    await p.screenshot({ path: `${SHOTS}/06_search-pane-inside-documents_${tag}.png` });
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    if (scheme === "light") await who.context.close();
  }
});

test("a viewer's paste adds nothing, and the server refuses a viewer's upload", async ({ browser }) => {
  const kai = await signIn(browser, "Kai Viewer", "kai@normal.dev", "dark");
  const me = (await (await kai.context.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } };
  const set = await ada.context.request.post(`${CLIENT}/api/boards/${BOARD}/people`, { data: { userId: me.user.id, role: "viewer" } });
  expect(set.ok(), await set.text()).toBeTruthy();
  await open(kai.page);
  const before = Object.keys((await state(kai.page)).media).length;
  const box = (await kai.page.locator(".section-card[data-section-id]").first().boundingBox())!;
  await kai.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await kai.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(kai.page.locator(".toast")).toContainText("View only");
  await settle(kai.page, 600);
  expect(Object.keys((await state(kai.page)).media).length).toBe(before);
  expect(await kai.page.locator(".upload-tray").count()).toBe(0);
  const up = await kai.context.request.post(`${CLIENT}/api/files?board=${BOARD}&name=sneaky.txt`, { data: "hello", headers: { "content-type": "text/plain" } });
  expect(up.status()).toBe(403);
  await kai.context.close();
});

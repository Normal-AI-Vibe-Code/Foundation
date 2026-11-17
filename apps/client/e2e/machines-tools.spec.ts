/**
 * A machine's tools, its wells redrawn, and the machine in a window of its own (Josh, 2026-11-17: "I notice
 * sometimes the VM takes over Ctrl+scroll … I'm unable to click in and copy the text that I need … design the
 * vm start interface and add desktop feature a little better … quality of life terminal tools for copying
 * out text that are standardized, and the ability to full-screen the vm into another tab"), in a real
 * browser against the engine on this computer (skipped where none answers).
 *
 *   1. The wells: Start (distros as tiles with what each can have, With a desktop as a row, Start wide) and
 *      Add a desktop (centred, its icons), by day and by night, read from the screen.
 *   2. The terminal: Ctrl+C with a selection copies (and the shell gets no ^C); Ctrl+C without one is still
 *      the interrupt; Copy all takes the scrollback; Paste puts the clipboard in the shell.
 *   3. Ctrl+scroll over a machine that has the keys zooms the grid, and the machine keeps the keys.
 *   4. The window of its own: ⧉ opens machine.html with the same machine; keys typed there reach its shell.
 *   5. The desktop: the same tools row, Ctrl+scroll over the screen (inside the frame) zooms the grid, Paste
 *      types into the machine, and its window opens the desktop.
 *
 * Screenshots land in docs/evidence/2026-11-17_machine-tools/.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_machine-tools";
mkdirSync(SHOTS, { recursive: true });

type Tool = (name: string, data: object) => Promise<{ result?: any; error?: string }>;

async function engineUp(context: BrowserContext) {
  const r = (await (await context.request.get(`${CLIENT}/api/machines/engines`)).json()) as { engines: Array<{ id: string; up: boolean }> };
  return r.engines.some((e) => e.up);
}

async function newBoard(context: BrowserContext, name: string): Promise<{ board: string; tool: Tool }> {
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `${name} ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool: Tool = async (n, data) => (await context.request.post(`${CLIENT}/api/boards/${board}/tools/${n}`, { data })).json();
  return { board, tool };
}

const frameSection = (page: Page, card: string) =>
  page.evaluate((id) => {
    const f = (window as any).__foundation;
    f.setState({ snapRequest: { kind: "section", id: f.getState().panels[id].sectionId, nonce: Math.random() } });
  }, card);

/** how wide the card is drawn on the screen: the grid zoom, read off the card itself */
const drawnWidth = (page: Page, slot: string) => page.evaluate((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().width, slot);
const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const setClip = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
/** what the card's terminal shows, as text (xterm draws rows into the DOM) */
const screenText = (page: Page, scope = "") => page.locator(`${scope} .xterm-rows`).first().innerText();

/** what a well looks like, measured: centred, its type sizes, its icons */
const wellLayout = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const w = document.querySelector<HTMLElement>(s)!;
    const col = (w.querySelector(".machine-picker-col") as HTMLElement | null) ?? w;
    const box = col.getBoundingClientRect();
    const host = (w.closest(".machine-body") as HTMLElement).getBoundingClientRect();
    const title = col.querySelector<HTMLElement>(".machine-hero-title")!;
    const lede = col.querySelector<HTMLElement>(".machine-hero-lede");
    const go = col.querySelector<HTMLElement>(".machine-hero-button")!.getBoundingClientRect();
    return {
      // the column's middle and the button's middle against the card's middle
      offCentre: Math.abs(box.left + box.width / 2 - (host.left + host.width / 2)) / (host.width / w.offsetWidth || 1),
      buttonOffCentre: Math.abs(go.left + go.width / 2 - (box.left + box.width / 2)),
      titlePx: parseFloat(getComputedStyle(title).fontSize),
      ledePx: lede ? parseFloat(getComputedStyle(lede).fontSize) : 0,
      icons: col.querySelectorAll("svg").length,
      buttonH: col.querySelector<HTMLElement>(".machine-hero-button")!.offsetHeight,
    };
  }, sel);

test("a machine's wells, its tools, Ctrl+scroll, copy and paste, and its window of its own", async ({ browser }) => {
  test.setTimeout(1_200_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: CLIENT });
  const { board, tool } = await newBoard(context, "Tools");
  await tool("add_section", { name: "Box" });
  const card = (await tool("propose_machine", { section: "Box", name: `tools-${Date.now().toString(36)}`, image: "ubuntu" })).result.card as string;
  const slot = `[data-obj-id="${card}"]`;
  try {
    // ---- 1. Start, redrawn: by night and by day ----
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/?board=${board}`);
      await waitLive(page);
      await page.waitForFunction(() => Object.keys((window as any).__foundation.getState().panels).length > 0);
      await frameSection(page, card);
      await page.locator(`${slot} .machine-distro`).first().waitFor();
      await settle(page, 1500);
      await expect(page.locator(`${slot} .machine-distro`)).toHaveCount(7);
      // a desktop where there's a recipe: Ubuntu, Debian, Alpine carry its icon, the other four don't
      const feats = await page.locator(`${slot} .machine-distro-feats`).evaluateAll((els) => els.map((e) => e.querySelectorAll("svg").length));
      expect(feats).toEqual([2, 2, 2, 1, 1, 1, 1]);
      await page.locator(`${slot} .machine-distro`, { hasText: "Fedora" }).click();
      await expect(page.locator(`${slot} .machine-with-desk`)).toHaveClass(/is-off/);
      await expect(page.locator(`${slot} .machine-with-desk`)).toContainText("No desktop recipe");
      await page.locator(`${slot} .machine-distro`, { hasText: "Ubuntu" }).click();
      await expect(page.locator(`${slot} .machine-with-desk`)).not.toHaveClass(/is-off/);
      const l = await wellLayout(page, `${slot} .machine-picker`);
      expect(l.offCentre, "the column is centred in the card").toBeLessThan(2);
      expect(l.buttonOffCentre, "Start is centred under it").toBeLessThan(2);
      // larger type, and larger still on a wide card (the card fills its section here): 18 / 13.5 / 36 at least
      expect(l.titlePx).toBeGreaterThanOrEqual(18);
      expect(l.titlePx / l.ledePx).toBeCloseTo(18 / 13.5, 2);
      expect(l.buttonH).toBeGreaterThanOrEqual(36);
      await page.screenshot({ path: `${SHOTS}/01_start_${scheme === "dark" ? "night" : "day"}.png` });
    }

    // ---- start it (the card's own Start, as a person presses it) ----
    await page.locator(`${slot} .machine-hero-button`).click();
    await page.locator(`${slot} .machine-term .xterm, ${slot} .machine-error, ${slot} .machine-state.is-bad`).first().waitFor({ timeout: 300_000 });
    if (!(await page.locator(`${slot} .machine-term .xterm`).count())) {
      await page.screenshot({ path: `${SHOTS}/zz_start-failed.png` });
      throw new Error(`Start failed: ${await page.locator(`${slot} .machine-body`).innerText()}`);
    }
    await settle(page, 2500);
    await expect(page.locator(`${slot} .machine-tools [data-machine-tool]`)).toHaveCount(4); // copy, copy all, paste, window

    // ---- 2. the terminal: copy and paste ----
    const term = page.locator(`${slot} .machine-term`);
    await term.click();
    await expect(page.locator(`${slot} .xterm-helper-textarea`)).toBeFocused();
    await page.keyboard.type("echo copyme-$((6*7))\n");
    await expect.poll(() => screenText(page, slot)).toContain("copyme-42");
    await setClip(page, "nothing yet");
    // a word selected (double-click) and Ctrl+C: copied, and the shell got no interrupt
    const rows = page.locator(`${slot} .xterm-rows > div`);
    const n = await rows.count();
    let row = -1;
    for (let i = n - 1; i >= 0; i--) if ((await rows.nth(i).innerText()).trim() === "copyme-42") row = i;
    expect(row, "the echo's output row").toBeGreaterThanOrEqual(0);
    const rb = (await rows.nth(row).boundingBox())!;
    await page.mouse.dblclick(rb.x + 20, rb.y + rb.height / 2);
    await expect(page.locator(`${slot} [data-machine-tool="copy"]`)).toBeEnabled();
    await page.keyboard.press("Control+C");
    await expect.poll(() => clip(page)).toBe("copyme-42"); // a word to xterm runs over the dash
    await expect(page.locator(`${slot} .machine-tools-said`)).toContainText("Copied 9 characters");
    expect(await screenText(page, slot), "Ctrl+C on a selection is a copy, not an interrupt").not.toContain("^C");
    await page.screenshot({ path: `${SHOTS}/02_terminal_copied-a-selection.png` });
    // nothing selected: Ctrl+C is the shell's interrupt, as it always was
    await page.keyboard.type("sleep 30");
    await page.keyboard.press("Enter");
    await settle(page, 400);
    await page.keyboard.press("Control+C");
    await expect.poll(() => screenText(page, slot)).toContain("^C");
    // Copy all: the whole scrollback
    await page.locator(`${slot} [data-machine-tool="copy-all"]`).click();
    await expect.poll(() => clip(page)).toContain("echo copyme-$((6*7))");
    expect(await clip(page)).toContain("copyme-42");
    await expect(page.locator(`${slot} .machine-tools-said`)).toContainText(/Copied \d+ lines/);
    // Paste: this computer's clipboard into the shell
    await setClip(page, "echo pasted-$((2+3))");
    await page.locator(`${slot} [data-machine-tool="paste"]`).click();
    await expect(page.locator(`${slot} .machine-tools-said`)).toContainText("Pasted");
    await expect.poll(() => screenText(page, slot)).toContain("echo pasted-$((2+3))");
    await page.keyboard.press("Enter");
    await expect.poll(() => screenText(page, slot)).toContain("pasted-5");
    // and Ctrl+V does the same
    await setClip(page, "echo keyed-$((3+4))");
    await page.keyboard.press("Control+V");
    await expect.poll(() => screenText(page, slot)).toContain("echo keyed-$((3+4))");
    await page.keyboard.press("Enter");
    await expect.poll(() => screenText(page, slot)).toContain("keyed-7");
    await page.screenshot({ path: `${SHOTS}/03_terminal_pasted.png` });

    // ---- 3. Ctrl+scroll over the terminal with the keys: the grid zooms, the shell keeps the keys ----
    const tb = (await term.boundingBox())!;
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    const w0 = await drawnWidth(page, slot);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Control");
    await settle(page, 1300);
    const w1 = await drawnWidth(page, slot);
    expect(w1, "Ctrl+scroll over a terminal in use zooms the grid out").toBeLessThan(w0 * 0.95);
    await expect(page.locator(`${slot} .xterm-helper-textarea`)).toBeFocused();
    await expect(page.locator(`${slot} .machine-keys`)).toContainText("Keys go to this machine");
    await frameSection(page, card);
    await settle(page, 1500);

    // ---- 4. the terminal in a window of its own ----
    const [win] = await Promise.all([context.waitForEvent("page"), page.locator(`${slot} [data-machine-tool="window"]`).click()]);
    await win.waitForLoadState();
    expect(win.url()).toContain("/machine.html#board=");
    await win.locator(".machine-term .xterm").waitFor({ timeout: 30_000 });
    await expect(win.locator(".machine-window-name")).toHaveText(/^tools-/);
    await expect(win.locator(".machine-window-keys")).toContainText("Every key goes to the machine");
    await expect(win.locator(".xterm-helper-textarea")).toBeFocused();
    // no Foundation here: Ctrl+K, Ctrl+L and Ctrl+W are the shell's (no command bar, no upload, no closed tab)
    await win.keyboard.type("echo from-window-$((5*5))");
    await win.keyboard.press("Enter");
    await expect.poll(() => screenText(win)).toContain("from-window-25");
    await expect.poll(() => screenText(page, slot), "the card's terminal is the same shell").toContain("from-window-25");
    await expect(win.locator(".machine-tools [data-machine-tool]")).toHaveCount(4); // copy, copy all, paste, full screen
    await win.screenshot({ path: `${SHOTS}/04_terminal_in-a-window-of-its-own.png` });
    await win.close();

    // ---- 5. the desktop: Add a desktop, redrawn; then its tools ----
    await page.locator(`${slot} .machine-view-tab`, { hasText: "Desktop" }).click();
    const well = page.locator(`${slot} .machine-desk-well`);
    await expect(well).toContainText("has no desktop yet");
    const d = await wellLayout(page, `${slot} .machine-desk-well`);
    expect(d.offCentre).toBeLessThan(2);
    expect(d.buttonOffCentre).toBeLessThan(2);
    expect(d.titlePx).toBeGreaterThanOrEqual(18);
    expect(d.titlePx / d.ledePx).toBeCloseTo(18 / 13.5, 2);
    expect(d.icons, "the mark, three features and three terms").toBeGreaterThanOrEqual(7);
    await page.screenshot({ path: `${SHOTS}/05_add-a-desktop_night.png` });
    await page.emulateMedia({ colorScheme: "light" });
    await settle(page, 1800);
    await page.screenshot({ path: `${SHOTS}/05_add-a-desktop_day.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await settle(page, 1800);
    await well.getByRole("button", { name: "Add a desktop" }).click();
    await expect(page.locator(`${slot} .machine-desk-progress`)).toContainText("Adding a desktop", { timeout: 15_000 });
    await expect(page.locator(`${slot} .machine-desk-progress`)).toContainText(/Downloading|Unpacking|Setting up/, { timeout: 180_000 });
    await page.screenshot({ path: `${SHOTS}/06_installing.png` });
    const desk = page.frameLocator(`${slot} .machine-desk iframe`);
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 600_000 });
    await expect(page.locator(`${slot} .machine-closed`)).toHaveCount(0, { timeout: 60_000 });
    await settle(page, 2500);
    await expect(page.locator(`${slot} .machine-tools [data-machine-tool]`)).toHaveCount(3); // copy, paste, window
    await expect(page.locator(`${slot} [data-machine-tool="copy"]`)).toBeDisabled(); // nothing copied in the machine yet

    // use it, then Ctrl+scroll over the machine's screen: the grid zooms (the frame hands it up), the keys stay
    // the card is still in use from the presses before (Add a desktop): a click straight on the screen takes the keys
    // all the same (it went in and the keys line never came: the frame had the focus already)
    const shot = (await page.locator(`${slot} .machine-desk`).boundingBox())!;
    await page.mouse.click(shot.x + shot.width / 2, shot.y + shot.height / 2);
    await expect(page.locator(`${slot} .machine-keys`)).toContainText("Keys go to this desktop");
    const z0 = await drawnWidth(page, slot);
    await page.mouse.move(shot.x + shot.width / 2, shot.y + shot.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Control");
    await settle(page, 1300);
    const z1 = await drawnWidth(page, slot);
    expect(z1, "Ctrl+scroll over the desktop in use zooms the grid out, not the machine").toBeLessThan(z0 * 0.95);
    await expect(page.locator(`${slot} .machine-keys`)).toContainText("Keys go to this desktop");
    await frameSection(page, card);
    await settle(page, 1500);

    // Paste types this computer's clipboard where the machine's cursor is: into a terminal opened on the desktop
    await page.evaluate(async ({ b, c }) => {
      // the machine's own terminal opens a window on its desktop (a person could as well, from the panel)
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/machines/${b}/${c}/tty`);
      await new Promise((ok, bad) => {
        ws.addEventListener("open", ok, { once: true });
        ws.addEventListener("error", bad, { once: true });
      });
      ws.send(new TextEncoder().encode("DISPLAY=:1 setsid xfce4-terminal --geometry=100x20+80+80 >/dev/null 2>&1 &\n"));
      setTimeout(() => ws.close(), 500);
    }, { b: board, c: card });
    await settle(page, 4000);
    await page.mouse.click(8, 500);
    await settle(page, 400);
    const s2 = (await page.locator(`${slot} .machine-desk`).boundingBox())!;
    await page.mouse.click(s2.x + s2.width / 2, s2.y + s2.height / 2);
    await settle(page, 300);
    await page.mouse.click(s2.x + s2.width / 2, s2.y + s2.height / 2);
    await settle(page, 600);
    await setClip(page, "echo typed-in-$((8*8)) > /tmp/typed.txt\n");
    await page.locator(`${slot} [data-machine-tool="paste"]`).click();
    await expect(page.locator(`${slot} .machine-tools-said`)).toContainText("into the machine");
    await settle(page, 2500);
    await page.screenshot({ path: `${SHOTS}/07_desktop_pasted-into-the-machine.png` });
    // read back from the machine's shell what the desktop's terminal wrote
    await page.locator(`${slot} .machine-view-tab`, { hasText: "Terminal" }).click();
    await page.locator(`${slot} .machine-term`).click();
    await page.keyboard.type("cat /tmp/typed.txt\n");
    await expect.poll(() => screenText(page, slot), { timeout: 15_000 }).toContain("typed-in-64");
    await page.locator(`${slot} .machine-view-tab`, { hasText: "Desktop" }).click();
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await settle(page, 2000);

    // the desktop in a window of its own
    const [dwin] = await Promise.all([context.waitForEvent("page"), page.locator(`${slot} [data-machine-tool="window"]`).click()]);
    await dwin.waitForLoadState();
    expect(dwin.url()).toContain("show=desktop");
    await expect(dwin.frameLocator(".machine-desk iframe").locator("canvas")).toBeVisible({ timeout: 60_000 });
    await settle(dwin, 2500);
    await expect(dwin.locator(".machine-desk-ring")).toHaveCount(0);
    await dwin.screenshot({ path: `${SHOTS}/08_desktop_in-a-window-of-its-own.png` });
    await dwin.close();
    await page.screenshot({ path: `${SHOTS}/09_desktop_tools-row.png` });
  } finally {
    await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

test("#/design shows the wells, the tools row and the start picker, day and night", async ({ browser }) => {
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  try {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/#/design`);
      await page.locator(".machine-tools").first().waitFor({ timeout: 30_000 });
      await settle(page, 1200);
      const machines = page.locator(".machine-picker").first();
      await machines.scrollIntoViewIfNeeded();
      await settle(page, 500);
      await page.screenshot({ path: `${SHOTS}/design_${scheme === "dark" ? "night" : "day"}_start.png` });
      const wells = page.locator(".machine-desk-well").first();
      await wells.scrollIntoViewIfNeeded();
      await settle(page, 500);
      await page.screenshot({ path: `${SHOTS}/design_${scheme === "dark" ? "night" : "day"}_wells.png` });
      const tools = page.locator(".machine-tools").first();
      await tools.scrollIntoViewIfNeeded();
      await settle(page, 500);
      await page.screenshot({ path: `${SHOTS}/design_${scheme === "dark" ? "night" : "day"}_tools.png` });
      // the older-server well offers Restart beside Try again
      await expect(page.locator(".machine-desk-well", { hasText: "older than this app" }).getByRole("button", { name: "Restart the server" })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

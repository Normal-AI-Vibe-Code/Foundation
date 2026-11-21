/**
 * A machine you can type into, look at, hand to an agent and pipe through
 * (Josh, 2026-11-15), in a real browser against the engine on this computer
 * (Kiri or Docker; skipped where none answers: the server tests cover the
 * same ground on a stand-in engine).
 *
 *   1. Typing: a plain click in the terminal puts the caret there at the
 *      section's fit and zoomed out; what's typed reaches the shell; Ctrl+W,
 *      U, L and K are the shell's and open nothing in the app; a single Esc
 *      stays in the shell; Esc Esc leaves. The card says where keys go.
 *   2. On Ubuntu: Ctrl+C interrupts; a note is piped in, upper-cased by a
 *      command in the machine and piped out to another note; a desktop is
 *      added (packages installed in the machine), seen in the card, typed
 *      into; an agent is refused until a person lets it use the desktop, then
 *      looks, clicks and types, and the card says who is driving; the leave is
 *      taken back and the agent is refused again.
 *
 * The second is slow the first time (the desktop is ~250 packages): allow ten
 * minutes. Screenshots land in docs/evidence/2026-11-15_machines-desktop/.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-15_machines-desktop";
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

const termText = async (page: Page) => (await page.locator(".machine-term .xterm-rows").innerText()).replace(/[  ]+\n/g, "\n");

async function clickTerminal(page: Page) {
  const box = (await page.locator(".machine-term").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("typing into a machine: a click gives the caret, keys reach the shell, Esc Esc leaves", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  const { board, tool } = await newBoard(context, "Keys");
  await tool("add_section", { name: "Box" });
  const card = (await tool("propose_machine", { section: "Box", name: `keys-${Date.now().toString(36)}`, image: "alpine" })).result.card as string;
  expect((await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/start`, { data: {} })).status()).toBe(200);
  try {
    await page.goto(`/?board=${board}`);
    await page.waitForFunction(() => Object.keys((window as any).__foundation.getState().panels).length > 0);
    for (const zoom of ["fit", "far"] as const) {
      await frameSection(page, card);
      await settle(page, 1500);
      if (zoom === "far") {
        await page.mouse.move(700, 450);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, 300);
        await page.keyboard.up("Control");
        await settle(page, 1200);
      }
      await page.locator(".machine-term .xterm").waitFor({ timeout: 30_000 });
      await settle(page, 1200);
      const scale = await page.evaluate(() => {
        const n = document.querySelector<HTMLElement>(".machine-term")!;
        return n.getBoundingClientRect().width / n.offsetWidth;
      });
      // never at 100 %: the bug was a click that lost the caret at any other scale
      expect(Math.abs(scale - 1)).toBeGreaterThan(0.05);
      await expect(page.locator(".machine-keys")).toHaveCount(0);

      await clickTerminal(page);
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      await expect(page.locator(".machine-keys")).toContainText("Keys go to this machine");
      await expect(page.locator(".machine-term-wrap.has-keys")).toHaveCount(1);

      // letters that are the board's one-key shortcuts (a: agent layer, v: talk, p: present) are just letters here
      await page.keyboard.type(`echo ${zoom}-$((6*7)) a v p`, { delay: 15 });
      await page.keyboard.press("Enter");
      await expect.poll(() => termText(page)).toContain(`${zoom}-42 a v p`);
      expect(await page.evaluate(() => document.querySelector(".app")!.className)).not.toMatch(/presenting|agent-layer-on/);
      await expect(page.locator(".talk-sheet")).toHaveCount(0);

      // the shell's own keys: Ctrl+W deletes a word, Ctrl+U the line, Ctrl+K to the end, Ctrl+L clears the screen
      await page.keyboard.type("echo nope nope", { delay: 15 });
      await page.keyboard.press("Control+w");
      await page.keyboard.press("Control+u");
      await page.keyboard.type(`echo ${zoom}-ctl-ok junk`, { delay: 15 });
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Control+k");
      await page.keyboard.press("Control+l");
      await page.keyboard.press("Enter");
      await expect.poll(() => termText(page)).toMatch(new RegExp(`\\n${zoom}-ctl-ok\\n`));
      expect(await termText(page)).not.toContain("nope");
      // none of them reached the app: no command bar, no file picker, the caret still in the shell
      await expect(page.locator(".command-bar, .cmdk, [data-command-bar]")).toHaveCount(0);
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      if (zoom === "fit") await page.screenshot({ path: `${SHOTS}/01_typing-in-the-terminal.png` });
      else await page.screenshot({ path: `${SHOTS}/02_typing-zoomed-out.png` });

      // one Esc is the shell's; two leave
      await page.keyboard.press("Escape");
      await settle(page, 700);
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.locator(".machine-keys")).toHaveCount(0);
      await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
      // and now the board's keys are the board's again: typing goes nowhere near the shell
      const before = await termText(page);
      await page.keyboard.type("zzz");
      await settle(page, 300);
      expect(await termText(page)).toBe(before);

      // a click elsewhere leaves too
      await clickTerminal(page);
      await expect(page.locator(".machine-keys")).toHaveCount(1);
      await page.mouse.click(20, 450);
      await expect(page.locator(".machine-keys")).toHaveCount(0);
    }
  } finally {
    await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

test("Ctrl+C, pipes, a desktop, and an agent using it with a person's leave", async ({ browser }) => {
  test.setTimeout(900_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  const { board, tool } = await newBoard(context, "Desk");
  const name = `desk-${Date.now().toString(36)}`;
  await tool("add_section", { name: "Box" });
  await tool("add_section", { name: "Notes" });
  const card = (await tool("propose_machine", { section: "Box", name, image: "ubuntu" })).result.card as string;
  const input = (await tool("add_note", { section: "Notes", title: "Input", markdown: "hello from a note" })).result.id as string;
  const result = (await tool("add_note", { section: "Notes", title: "Result", markdown: "(nothing yet)" })).result.id as string;
  expect((await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/start`, { data: {} })).status()).toBe(200);
  // an agent's token: what MCP clients and the crew's runs hold
  const bearer = ((await (await context.request.post(`${CLIENT}/api/agent/token`)).json()) as { token: string }).token;
  const agent = async (n: string, data: object) => {
    const r = await fetch(`${CLIENT}/api/boards/${board}/tools/${n}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(data) });
    return { status: r.status, body: (await r.json()) as { result?: any; error?: string } };
  };
  const noteText = (id: string) => page.evaluate((i) => (window as any).__foundation.getState().notes[i]?.text as string, id);
  try {
    await page.goto(`/?board=${board}`);
    await page.waitForFunction(() => Object.keys((window as any).__foundation.getState().panels).length > 0);
    await frameSection(page, card);
    await page.locator(".machine-term .xterm").waitFor({ timeout: 30_000 });
    await settle(page, 1500);

    // ---- Ctrl+C interrupts (Kiri starts processes with SIGINT blocked; the card's shell clears that) ----
    await clickTerminal(page);
    await page.keyboard.type("sleep 60", { delay: 15 });
    await page.keyboard.press("Enter");
    await settle(page, 600);
    await page.keyboard.press("Control+c");
    await settle(page, 400);
    // interrupted: the prompt is back at once and the shell says it ended on SIGINT (130), not after a minute
    await page.keyboard.type("echo after-$?", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page), { timeout: 8000 }).toContain("after-130");

    // ---- pipes: a note in, a command in the machine, a note out ----
    // the pipes are the card's Ins & outs, a view beside Terminal and Desktop (2026-11-17)
    const showIo = async () => {
      await page.locator(".machine-view-tab", { hasText: "Ins & outs" }).click();
      await expect(page.locator(".machine-io-view")).toBeVisible();
    };
    const backToTerminal = async () => {
      await page.locator(".machine-view-tab", { hasText: "Terminal" }).click();
      await page.locator(".machine-term .xterm").waitFor();
      await settle(page, 600);
      await clickTerminal(page);
    };
    await showIo();
    await expect(page.locator(".machine-io")).toContainText("/foundation/in");
    await expect(page.locator(".machine-io-row").first()).toContainText("nothing wired");
    const wired = await tool("connect", { from_panel: input, from_port: "text", to_panel: card, to_port: "in" });
    expect(wired.result?.id).toBeTruthy();
    await tool("connect", { from_panel: card, from_port: "out", to_panel: result, to_port: "text" });
    // the strip names both ends, and shows what arrived
    await expect(page.locator(".machine-io-row").first()).toContainText("Note “Input”");
    await expect(page.locator(".machine-io-row").first()).toContainText("hello from a note", { timeout: 15_000 });
    await expect(page.locator(".machine-io-row").nth(1)).toContainText("Note “Result”");
    await backToTerminal();
    await page.keyboard.type("cat /foundation/in", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("hello from a note");
    await page.keyboard.type("tr a-z A-Z </foundation/in >/foundation/out", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect.poll(() => noteText(result), { timeout: 15_000 }).toBe("HELLO FROM A NOTE");
    await showIo();
    await expect(page.locator(".machine-io-row").nth(1)).toContainText("HELLO FROM A NOTE");
    await page.screenshot({ path: `${SHOTS}/03_piped-through-the-machine.png` });
    await backToTerminal();
    // it keeps flowing: a loop in the machine, the note changed, the other note follows; JSON comes out as JSON
    await page.keyboard.type("while sleep 1; do tr a-z A-Z </foundation/in >/foundation/out; done &", { delay: 10 });
    await page.keyboard.press("Enter");
    await tool("update_card", { id: input, markdown: "second value, piped live" });
    await expect.poll(() => noteText(result), { timeout: 20_000 }).toBe("SECOND VALUE, PIPED LIVE");
    await page.keyboard.type("kill %1; echo '{\"parts\": 3, \"ok\": true}' >/foundation/out", { delay: 10 });
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate((id) => {
        const p = (window as any).__foundation.getState().panels[id];
        return JSON.stringify(p.outputs?.[p.ports.find((x: any) => x.name === "out").id]);
      }, card), { timeout: 15_000 })
      .toBe('{"parts":3,"ok":true}');
    // the two notes, in their own section: what went in, and what came out the other side
    await tool("update_card", { id: input, markdown: "hello from a note" });
    await showIo();
    await expect(page.locator(".machine-io-row").first()).toContainText("hello from a note", { timeout: 15_000 });
    await backToTerminal();
    await page.keyboard.type("tr a-z A-Z </foundation/in >/foundation/out", { delay: 10 });
    await page.keyboard.press("Enter");
    await expect.poll(() => noteText(result), { timeout: 20_000 }).toBe("HELLO FROM A NOTE");
    await page.evaluate((id) => {
      const f = (window as any).__foundation;
      f.setState({ snapRequest: { kind: "section", id: f.getState().notes[id].sectionId, nonce: Math.random() } });
    }, input);
    await settle(page, 1800);
    await page.screenshot({ path: `${SHOTS}/04_note-in-note-out.png` });
    await frameSection(page, card);
    await settle(page, 1500);

    // ---- the desktop ----
    await page.locator(".machine-view-tab", { hasText: "Desktop" }).click();
    await expect(page.locator(".machine-desk-well")).toContainText("has no desktop yet");
    await page.screenshot({ path: `${SHOTS}/05_no-desktop-yet.png` });
    // an agent can't add one: it runs third-party code, so it needs a person at a browser
    const refused = await fetch(`${CLIENT}/api/boards/${board}/machines/${card}/desktop`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(403);
    await page.locator(".machine-desk-well button", { hasText: "Add a desktop" }).click();
    await expect(page.locator(".machine-desk-progress")).toContainText("Adding a desktop", { timeout: 10_000 });
    await settle(page, 6000);
    await page.screenshot({ path: `${SHOTS}/06_adding-a-desktop.png` });
    await expect(page.locator(".machine-desk iframe")).toHaveCount(1, { timeout: 600_000 });
    const desk = page.frameLocator(".machine-desk iframe");
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".machine-closed")).toHaveCount(0, { timeout: 30_000 });
    await settle(page, 4000);
    // the screen is the machine's 1280×800, drawn inside the card
    expect(await desk.locator("canvas").evaluate((c: HTMLCanvasElement) => `${c.width}x${c.height}`)).toBe("1280x800");
    await page.screenshot({ path: `${SHOTS}/07_the-desktop-in-the-card.png` });

    // the card is still in use from the press on Add a desktop; a click elsewhere ends that, and the desktop is only looked at
    await page.mouse.click(20, 450);
    await expect(page.locator(".machine-desk.is-in-use")).toHaveCount(0);
    // a terminal on the desktop that keeps what's typed into it (started from the card's shell)
    await page.locator(".machine-view-tab", { hasText: "Terminal" }).click();
    await page.locator(".machine-term .xterm").waitFor();
    await settle(page, 800);
    await clickTerminal(page);
    await page.keyboard.type("DISPLAY=:1 xfce4-terminal --geometry=100x30+200+120 -e 'sh -c \"cat > /tmp/typed.txt\"' >/dev/null 2>&1 &", { delay: 5 });
    await page.keyboard.press("Enter");
    await settle(page, 2500);
    await page.locator(".machine-view-tab", { hasText: "Desktop" }).click();
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".machine-closed")).toHaveCount(0, { timeout: 30_000 });
    await settle(page, 2500);
    const box = (await page.locator(".machine-desk").boundingBox())!;
    // a click on the terminal window inside the desktop: (640, 400) of the machine's screen is the card's middle
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".machine-desk.is-in-use")).toHaveCount(1);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".machine-keys")).toContainText("Keys go to this desktop");
    await page.keyboard.type("typed into the desktop from the board", { delay: 30 });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+d");
    await settle(page, 1200);
    await page.screenshot({ path: `${SHOTS}/08_desktop-in-use.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".machine-keys")).toHaveCount(0);
    await expect(page.locator(".machine-desk.is-in-use")).toHaveCount(0);
    // what was typed is in the machine
    await page.locator(".machine-view-tab", { hasText: "Terminal" }).click();
    await page.locator(".machine-term .xterm").waitFor();
    await settle(page, 800);
    await clickTerminal(page);
    await page.keyboard.type("echo \"[$(cat /tmp/typed.txt)]\"", { delay: 10 });
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page), { timeout: 8000 }).toContain("[typed into the desktop from the board]");

    // ---- a viewer watches the desktop: their pointer and keys never reach the machine ----
    await page.keyboard.type("DISPLAY=:1 xdotool mousemove 111 222", { delay: 5 });
    await page.keyboard.press("Enter");
    const kai = await person(browser, "Kai Viewer", "kai@normal.dev", board);
    const kaiId = ((await (await kai.context.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } }).user.id;
    // roles are an admin's to set
    const admin = await browser.newContext();
    await admin.request.post(`${CLIENT}/auth/dev`, { data: { name: "Admin", email: "admin@normal.dev" } });
    const set = await admin.request.post(`${CLIENT}/api/boards/${board}/people`, { data: { userId: kaiId, role: "viewer" } });
    expect(set.ok(), await set.text()).toBeTruthy();
    await admin.close();
    await kai.page.reload();
    await waitLive(kai.page);
    await frameSection(kai.page, card);
    await settle(kai.page, 1500);
    await kai.page.locator(".machine-view-tab", { hasText: "Desktop" }).click();
    await expect(kai.page.frameLocator(".machine-desk iframe").locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(kai.page.locator(".machine-closed")).toHaveCount(0, { timeout: 30_000 });
    await expect(kai.page.locator(".machine-desk .machine-watching")).toBeVisible();
    await expect(kai.page.locator(".machine-may button")).toHaveCount(0);
    const kb = (await kai.page.locator(".machine-desk").boundingBox())!;
    await kai.page.mouse.click(kb.x + kb.width / 2, kb.y + kb.height / 2);
    await kai.page.mouse.click(kb.x + kb.width / 2, kb.y + kb.height / 2);
    await kai.page.mouse.move(kb.x + kb.width / 3, kb.y + kb.height / 3, { steps: 5 });
    await kai.page.keyboard.type("a viewer's keys");
    await settle(kai.page, 1000);
    await expect(kai.page.locator(".machine-keys")).toHaveCount(0);
    await kai.page.screenshot({ path: `${SHOTS}/08c_a-viewer-watches.png` });
    // a viewer can't add a desktop or give agents leave, at the server
    expect((await kai.context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/agents`, { data: { allow: true } })).status()).toBe(403);
    expect((await kai.context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/desktop`, { data: {} })).status()).toBe(403);
    await kai.context.close();
    await page.keyboard.type("DISPLAY=:1 xdotool getmouselocation", { delay: 5 });
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page), { timeout: 8000 }).toContain("x:111 y:222");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // ---- full screen is the card's own: the screen fills the window and takes the pointer ----
    await page.locator(".machine-view-tab", { hasText: "Desktop" }).click();
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".machine-closed")).toHaveCount(0, { timeout: 30_000 });
    await page.mouse.click(20, 450);
    const fb = (await page.locator(".machine-desk").boundingBox())!;
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForFunction(() => !!document.fullscreenElement);
    await settle(page, 1200);
    const full = await page.evaluate(() => {
      const el = document.fullscreenElement as HTMLElement;
      const f = el.querySelector<HTMLElement>(".machine-desk iframe")!;
      const r = f.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, pointer: getComputedStyle(f).pointerEvents, shields: el.querySelectorAll(".machine-desk-shield").length };
    });
    expect(full.pointer).toBe("auto");
    expect(full.shields).toBe(0);
    expect(full.w).toBeGreaterThan(full.vw - 60);
    expect(full.h).toBeGreaterThan(full.vh * 0.6);
    await page.screenshot({ path: `${SHOTS}/08b_desktop-full-screen.png` });
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    await settle(page, 800);
    await page.locator(".machine-view-tab", { hasText: "Terminal" }).click();

    // ---- an agent and the desktop ----
    // no leave yet: nothing happens, the agent is told why, and the card offers the person the button
    const before = await agent("desktop_screenshot", { machine: name });
    expect(before.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(before.body)).toMatch(/hasn't let agents use/);
    await expect(page.locator(".machine-agent.is-asking")).toContainText("asks to use this desktop");
    await page.screenshot({ path: `${SHOTS}/09_an-agent-asks.png` });
    // a bearer can't give the leave
    const self = await fetch(`${CLIENT}/api/boards/${board}/machines/${card}/agents`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ allow: true }) });
    expect(self.status).toBe(403);
    // the person does, on the card
    await page.locator(".machine-agent.is-asking button", { hasText: "Let agents use this desktop" }).click();
    await expect(page.locator(".machine-agent.is-asking")).toHaveCount(0);
    const look = await agent("desktop_screenshot", { machine: name });
    expect(look.status).toBe(200);
    expect(look.body.result.screen).toBe("1280x800");
    writeFileSync(`${SHOTS}/10_what-the-agent-saw.png`, Buffer.from(look.body.result._image.base64, "base64"));
    await expect(page.locator(".machine-agent.is-driving")).toContainText("is using this desktop · looked at the screen");
    // through MCP (what Claude Code and the crew's subscription runs speak) the screen arrives as a picture, not as text
    const mcp = await fetch(`${CLIENT}/mcp?board=${board}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desktop_screenshot", arguments: { machine: name } } }),
    });
    const said = (await mcp.json()) as { result?: { content: Array<{ type: string; mimeType?: string; data?: string; text?: string }> } };
    expect(said.result?.content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(said.result!.content[0].mimeType).toBe("image/png");
    expect(Buffer.from(said.result!.content[0].data!, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(said.result!.content[1].text).not.toContain("_image");
    // it opens the file manager from the desktop's Home icon, goes to the pipes' folder by keyboard
    await agent("desktop_mouse", { machine: name, action: "double_click", x: 69, y: 180, look: false });
    await settle(page, 2500);
    await agent("desktop_key", { machine: name, keys: ["ctrl+l"], look: false });
    const typed = await agent("desktop_type", { machine: name, text: "/foundation\n" });
    expect(typed.status).toBe(200);
    await settle(page, 1500);
    const after = await agent("desktop_screenshot", { machine: name });
    writeFileSync(`${SHOTS}/11_after-the-agent-acted.png`, Buffer.from(after.body.result._image.base64, "base64"));
    await page.locator(".machine-agent.is-driving button", { hasText: "Watch" }).click();
    await expect(desk.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await agent("desktop_mouse", { machine: name, action: "move", x: 640, y: 400, look: false });
    await expect(page.locator(".machine-agent.is-driving")).toContainText("moved the pointer to (640, 400)");
    await expect(page.locator(".machine-agent-acts li").first()).toBeVisible();
    await settle(page, 1500);
    await page.screenshot({ path: `${SHOTS}/12_an-agent-driving.png` });
    // every action is in the board's activity, under the agent's name
    const acts = await page.evaluate(() => {
      const b = (window as any).__foundationBoard();
      return (b.doc.getArray("activity").toArray() as Array<{ who: string; role: string; text: string }>).filter((a) => /desktop/.test(a.text)).map((a) => `${a.role} ${a.who}: ${a.text}`);
    });
    expect(acts.join("\n")).toMatch(/agent Ada Test's agent: asked to use/);
    expect(acts.join("\n")).toMatch(/human Ada Test: let agents use/);
    expect(acts.join("\n")).toMatch(/agent Ada Test's agent: typed “\/foundation ?” on/);
    expect(acts.filter((a) => a.startsWith("agent")).length).toBeGreaterThanOrEqual(6);

    // ---- the crew: a named agent with its cursor on the card ----
    await page.mouse.click(20, 450);
    await page.keyboard.press("Space");
    await expect(page.locator('.talk-sheet[data-mode="typing"] .talk-field')).toBeFocused();
    await page.keyboard.type(`use the desktop of “${name}”`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".crew-cursor").first()).toBeVisible({ timeout: 20_000 });
    // a crew member, by its own name (not "Ada Test's agent", the token's)
    await expect(page.locator(".machine-agent-who")).not.toContainText("Ada Test's agent", { timeout: 30_000 });
    await expect(page.locator(".machine-agent.is-driving")).toContainText(/double-clicked \(69, 180\)|pressed ctrl\+l|typed/, { timeout: 30_000 });
    expect(await page.locator(".crew-cursor").first().getAttribute("data-target")).toContain(card);
    await page.screenshot({ path: `${SHOTS}/13_the-crew-on-the-desktop.png` });
    await expect(page.locator(".machine-agent.is-driving")).toContainText("typed “/foundation", { timeout: 30_000 });

    // ---- the leave is taken back ----
    await page.locator(".machine-may button", { hasText: "Stop" }).click();
    await expect(page.locator(".machine-may")).toContainText("Let agents use this desktop");
    const gone = await agent("desktop_mouse", { machine: name, action: "click", x: 10, y: 10 });
    expect(gone.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(gone.body)).toMatch(/hasn't let agents use/);
  } finally {
    await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

test("a machine in use on #/design, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1500 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const first = p.locator(".machine-io").first();
    await first.scrollIntoViewIfNeeded();
    await settle(p, 900);
    // the specimens: the keys line and ring, the pipes, an agent driving, an agent asking, the three wells
    await expect(p.locator(".machine-keys").first()).toContainText("Keys go to this machine");
    await expect(p.locator(".machine-agent.is-driving").first()).toContainText("is using this desktop");
    await expect(p.locator(".machine-agent.is-asking").first()).toContainText("asks to use this desktop");
    await expect(p.locator(".machine-desk-well").first()).toContainText("no desktop yet");
    const rows = p.locator(".adapt-row", { has: p.locator(".machine-view") });
    await rows.nth(0).screenshot({ path: `${SHOTS}/14_design-${scheme === "dark" ? "night" : "day"}-keys-and-pipes.png` });
    await rows.nth(1).screenshot({ path: `${SHOTS}/15_design-${scheme === "dark" ? "night" : "day"}-agents.png` });
    await rows.nth(2).screenshot({ path: `${SHOTS}/16_design-${scheme === "dark" ? "night" : "day"}-desktop-wells.png` });
    await ctx.close();
  }
});

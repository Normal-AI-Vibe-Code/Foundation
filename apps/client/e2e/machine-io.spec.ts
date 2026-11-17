/**
 * A machine's Ins & outs (2026-11-17, Josh: "the ins and outs should be another top level menu option … try to get that
 * vm to output something and pipe it into a card in the section on the right. It says JSON out right now, but I don't
 * see anything coming out"). Against the real engine on this computer (skipped without one), on a throwaway grid, with a
 * fresh machine that is removed at the end:
 *
 *   the head's Ins & outs tab → Out to a new note on the right → Write a test line
 *   → the note in the section to the right reads "Hello from <the machine> at <time>", and the out port says text.
 *
 *   E2E_SERVER_PORT=… E2E_CLIENT_PORT=… npm run e2e -w @foundation/client -- machine-io
 */

import { test, expect, type BrowserContext } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_council-seats";

async function engineUp(context: BrowserContext) {
  const r = (await (await context.request.get(`${CLIENT}/api/machines/engines`)).json()) as { engines: Array<{ id: string; up: boolean }> };
  return r.engines.some((e) => e.up);
}

test("Ins & outs: a machine writes a line, and it lands in a note in the section on the right", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await person(browser, "Admin", "admin@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Pipes ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool = async (n: string, data: object) => (await (await context.request.post(`${CLIENT}/api/boards/${board}/tools/${n}`, { data })).json()) as { result?: any; error?: string };
  await tool("add_section", { name: "Box" });
  const card = (await tool("propose_machine", { section: "Box", name: `pipes-${Date.now().toString(36)}`, image: "alpine" })).result.card as string;
  expect((await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/start`, { data: {} })).status()).toBe(200);
  try {
    await page.goto(`/?board=${board}`);
    await page.waitForFunction((id) => (window as any).__foundation.getState().panels[id]?.machine?.state === "running", card, { timeout: 120_000 });
    await page.evaluate((id) => {
      const f = (window as any).__foundation;
      f.setState({ snapRequest: { kind: "section", id: f.getState().panels[id].sectionId, nonce: Math.random() } });
    }, card);
    await settle(page, 1500);
    const box = page.locator(`[data-obj-id="${card}"]`);
    // the head: Terminal · Desktop · Ins & outs, and full screen beside them
    await expect(box.locator("[data-machine-view]")).toHaveText(["Terminal", "Desktop", "Ins & outs"]);
    await expect(box.locator("[data-machine-full]")).toBeVisible();
    await box.locator('[data-machine-view="io"]').click();
    const io = box.locator("[data-machine-io-view]");
    await expect(io).toBeVisible();
    // the ports come with the first look at a running machine; then Out can go somewhere
    await expect(io.locator("[data-machine-io-right]")).toBeEnabled({ timeout: 20_000 });
    await io.locator("[data-machine-io-right]").click();
    const note = await page.waitForFunction(
      (id) => {
        const st = (window as any).__foundation.getState();
        const home = st.sections[st.panels[id].sectionId];
        const right = Object.values(st.sections as Record<string, { id: string; c0: number }>).find((s) => s.c0 === home.c1 + 1);
        const n = right && Object.values(st.notes as Record<string, { id: string; sectionId: string }>).find((x) => x.sectionId === right.id);
        return n?.id ?? null;
      },
      card,
      { timeout: 10_000 },
    );
    const noteId = (await note.jsonValue()) as string;
    // a new section came in on the right and the view moved: frame the machine again before the next press
    await page.evaluate((id) => {
      const f = (window as any).__foundation;
      f.setState({ snapRequest: { kind: "section", id: f.getState().panels[id].sectionId, nonce: Math.random() } });
    }, card);
    await settle(page, 1500);
    await io.locator("[data-machine-io-try]").click();
    // the machine wrote it, the server read it back and wrote the note: the note shows the line
    await expect.poll(() => page.evaluate((id) => (window as any).__foundation.getState().notes[id]?.text ?? "", noteId), { timeout: 20_000 }).toMatch(/^Hello from \S+ at \d\d:\d\d:\d\d UTC/);
    await expect(io.locator("[data-machine-io-last] pre")).toContainText("Hello from");
    await expect(io.locator(".machine-io-kind")).toHaveText("text");
    // and the out port says what it carries now
    const outType = await page.evaluate((id) => (window as any).__foundation.getState().panels[id].ports.find((p: any) => p.dir === "out")?.type, card);
    expect(outType).toBe("text");
    await settle(page, 600);
    await page.evaluate(() => {
      const f = (window as any).__foundation;
      f.setState({ snapRequest: { kind: "all", nonce: Math.random() } });
    });
    await settle(page, 1200);
    await page.screenshot({ path: `${SHOTS}/04_machine-out-to-a-note.png` });
  } finally {
    await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

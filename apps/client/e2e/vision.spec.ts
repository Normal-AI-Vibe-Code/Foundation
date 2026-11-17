/**
 * The Vision loop on the board: a brief makes a hand-off card that waits for
 * a person; Run tries to start the Vision Code thread. Here there is no
 * Vision Code (the e2e server points T3 at nothing), so Run must fail clearly
 * on the card — the real start is checked against a stand-in in
 * apps/server/test/vision.test.ts and was run once against Vision Code.
 */

import { test, expect } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-03_vision-loop";

test("a brief waits on its card for Run; without Vision Code, Run says why", async ({ browser }) => {
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Vision ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  await page.goto(`/?board=${board}`);
  await page.waitForFunction(() => (window as unknown as { __foundationBoard: () => { status: string } }).__foundationBoard()?.status === "live");
  const r = await context.request.post(`${CLIENT}/api/boards/${board}/tools/vision_brief`, {
    data: { title: "Quieter rim fan", goal: "-3 dB at the same flow", simulate: "CFD at 1200 rpm", reviewers: ["kai@normal.dev"], section: "Section 1" },
  });
  const { handoff } = ((await r.json()) as { result: { handoff: string } }).result;
  await page.evaluate((id) => (window as unknown as { __foundation: { setState(x: object): void } }).__foundation.setState({ snapRequest: { kind: "object", id, nonce: Math.random() } }), handoff);
  await settle(page, 1500);
  const card = page.locator(`[data-obj-id="${handoff}"]`);
  await expect(card).toContainText("Press Run to start a Supervised Vision Code thread");
  // nobody is asked yet: reviewers are asked when results come back
  expect(await page.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { panels: Record<string, { panel: string }> } } }).__foundation.getState().panels).filter((p) => p.panel === "ask").length)).toBe(0);
  // with the pointer on the card (its bar showing), Run is still uncovered and pressable
  const run = card.getByRole("button", { name: "Run" });
  await run.hover();
  await settle(page, 300);
  const covered = await run.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top === el || el.contains(top));
  });
  expect(covered, "Run is under the card's bar").toBe(false);
  await page.screenshot({ path: `${SHOTS}/handoff-waiting.png` });
  await run.click();
  await expect(card).toContainText("Couldn't start Vision Code", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/handoff-no-vision-code.png` });
});

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
  // before Run the card shows what would run, from the job itself (not the card's text): the whole target and goal
  const what = card.locator(".agent-what");
  await expect(what.locator(".agent-what-target")).toHaveText("Quieter rim fan");
  await expect(what).toContainText("-3 dB at the same flow");
  await expect(what).toContainText("CFD at 1200 rpm");
  await expect(what).toContainText("kai@normal.dev");
  const jobId = await page.evaluate((id) => (window as unknown as { __foundation: { getState(): { panels: Record<string, { sessionId?: string }> } } }).__foundation.getState().panels[id]?.sessionId, handoff);
  expect(jobId, "the hand-off card names its job").toBeTruthy();
  const jobStatus = async () => ((await (await context.request.get(`${CLIENT}/api/jobs/${jobId}`)).json()) as { job: { status: string } }).job.status;
  // the server runs only what a card showed: a press naming anything else is refused, and nothing starts
  const stale = await context.request.post(`${CLIENT}/api/jobs/${jobId}/run`, { data: { shown: "0".repeat(64) } });
  expect(stale.status()).toBe(409);
  expect(await stale.text()).toContain("isn't what its card showed");
  expect(await jobStatus()).toBe("queued");
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
  // Run asks first, with the target and goal still on screen; Cancel starts nothing
  await run.click();
  await expect(what.locator(".agent-what-ask")).toHaveText("Run Vision Code on this, with this goal?");
  await expect(what).toContainText("-3 dB at the same flow");
  await what.getByRole("button", { name: "Cancel" }).click();
  await expect(what.locator(".agent-what-ask")).toHaveCount(0);
  await settle(page, 500);
  expect(await jobStatus(), "Cancel started nothing").toBe("queued");
  await card.getByRole("button", { name: "Run", exact: true }).click();
  await what.getByRole("button", { name: "Run it" }).click();
  await expect(card).toContainText("Couldn't start Vision Code", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/handoff-no-vision-code.png` });
});

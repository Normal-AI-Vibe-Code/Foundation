/**
 * Voice and construction. Saying something (V) sends it to the crew;
 * the agent's lay_out builds pages from images it finds — here from a stand-in
 * Slack (e2e/slack-standin.mjs) — as a grid, a mood board, a document and a
 * timeline, each checked for overlapping cards and photographed.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, frame, layoutProblems, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-03_build";
const CREW = "../../docs/evidence/2026-11-07_crew";
let page: Page;
let context: BrowserContext;
let board = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  ({ page, context } = await person(browser, "Ada Test", "ada@normal.dev"));
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `Build ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  // a microphone stand-in: speech recognition that "hears" a sentence
  await context.addInitScript(() => {
    class FakeRecognition {
      lang = "en-GB";
      interimResults = true;
      continuous = false;
      onresult: (e: unknown) => void = () => {};
      onend: () => void = () => {};
      onerror: (e: unknown) => void = () => {};
      private timers: number[] = [];
      start() {
        const say = (t: string) => this.onresult({ results: [[{ transcript: t }]] });
        this.timers.push(window.setTimeout(() => say("lay out all the images"), 300));
        this.timers.push(window.setTimeout(() => say("lay out all the images from Slack about the Airform PTHP"), 900));
        this.timers.push(window.setTimeout(() => this.onend(), 1400));
      }
      stop() {}
      abort() {
        this.timers.forEach(clearTimeout);
      }
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  });
  await page.goto(`/?board=${board}`);
  await page.waitForFunction(() => (window as unknown as { __foundationBoard: () => { status: string } }).__foundationBoard()?.status === "live");
});

const tool = async (name: string, data: object) => {
  const r = await context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
  expect(r.ok(), `${name}: ${await r.text()}`).toBeTruthy();
  return ((await r.json()) as { result: unknown }).result;
};

test("saying it (V) sends it to the crew", async () => {
  await page.keyboard.press("v");
  await expect(page.locator(".talk-heard")).toContainText("lay out all the images");
  await page.screenshot({ path: `${CREW}/08_v-listening.png` });
  // when the speaker stops, an agent of the crew takes it, by name, without a tab opening (2026-11-07)
  await expect(page.locator(".crew-row.is-mine").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".session.floor-pane")).toHaveCount(0);
  await expect(page.locator(".tab.is-board.is-current")).toHaveCount(1);
  await page.screenshot({ path: `${CREW}/09_v-sent-to-the-crew.png` });
  // let it finish (it brings the view to what it made) before the layouts below are framed
  await expect(page.locator(".crew-cursor")).toHaveCount(0, { timeout: 30_000 });
});

test("find_images finds the PTHP pictures in Slack, not the others", async () => {
  const r = (await tool("find_images", { query: "pthp" })) as { images: Array<{ ref: string; title: string; from: string }>; notes: string[] };
  expect(r.images.map((i) => i.ref).sort()).toEqual(["slack:F1", "slack:F2", "slack:F3", "slack:F4"]);
  expect(r.images[0].from).toMatch(/#airform-pthp/);
});

const styles: Array<{ style: string; title: string; intro?: string }> = [
  { style: "grid", title: "Airform PTHP · from Slack", intro: "Every picture shared in **#airform-pthp**, newest first." },
  { style: "board", title: "PTHP mood board" },
  { style: "document", title: "PTHP: where it stands", intro: "The stack, the thermal map, the printed manifold and the airflow test — in that order." },
  { style: "timeline", title: "PTHP over time" },
];

for (const [i, s] of styles.entries()) {
  test(`lay_out as a ${s.style}`, async () => {
    const out = (await tool("lay_out", {
      title: s.title,
      style: s.style,
      intro: s.intro,
      items: ["slack:F1", "slack:F2", "slack:F3", "slack:F4"].map((ref) => ({ ref })),
    })) as { section: string; images: number; skipped: string[] };
    expect(out.images).toBe(4);
    expect(out.skipped).toEqual([]);
    await page.waitForFunction((id) => !!document.querySelector(`.section-card[data-section-id="${id}"]`), out.section);
    await frame(page, "section", out.section);
    await settle(page, 1500); // images load
    // the cards in a laid-out section never overlap each other, and every image loaded
    const clash = await page.evaluate((id) => {
      const cards = [...document.querySelectorAll<HTMLElement>(`.section-card[data-section-id="${id}"] [data-obj-id] .frame-card`)].map((e) => e.getBoundingClientRect());
      const out: string[] = [];
      for (let a = 0; a < cards.length; a++)
        for (let b = a + 1; b < cards.length; b++) {
          const p = cards[a], q = cards[b];
          if (Math.min(p.right, q.right) - Math.max(p.left, q.left) > 1 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 1) out.push(`${a}×${b}`);
        }
      const broken = [...document.querySelectorAll<HTMLImageElement>(`.section-card[data-section-id="${id}"] img`)].filter((im) => im.complete && im.naturalWidth === 0).length;
      return { overlaps: out, broken, cards: cards.length };
    }, out.section);
    expect(clash.overlaps, "overlapping cards").toEqual([]);
    expect(clash.broken, "images that didn't load").toBe(0);
    const p = await layoutProblems(page);
    expect(p.cellClash).toEqual([]);
    expect(p.overlap).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/${String(i + 2).padStart(2, "0")}_${s.style}.png` });
  });
}

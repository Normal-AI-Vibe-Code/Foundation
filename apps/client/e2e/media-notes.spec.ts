/**
 * Voice and video notes in a real browser (2026-11-25), on Chromium's fake microphone and camera:
 *  - the recorder opens from a section's microphone and opens nothing until Record;
 *  - a 2 s voice note is recorded, reviewed, left: the card has its wave and its length, plays (the audio's
 *    time moves), and a second person sees it and plays it too; no track is left live;
 *  - the same for a video note, which never plays by itself and plays with its sound;
 *  - Discard leaves no card and no live track;
 *  - a viewer has no microphone in a section's tools.
 * Evidence: docs/evidence/2026-11-25_media-notes/ (night for Ada, day for Kai).
 */

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, frame, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-25_media-notes";

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
});
test.describe.configure({ mode: "serial" });

type Note = { by: string; byName: string; at: number; ms: number; fileId: string; mime: string; peaks?: number[] };
type St = {
  sections: Record<string, { id: string; name: string }>;
  media: Record<string, { id: string; sectionId: string; name: string; src: string; media: string; autoplay: boolean; muted: boolean; note?: Note }>;
};
const state = (page: Page) => page.evaluate(() => (window as unknown as { __foundation: { getState(): St } }).__foundation.getState()) as Promise<St>;
const notes = async (page: Page) => Object.values((await state(page)).media).filter((m) => m.note);

/** every stream the page opens is kept, so a check can see whether any track is still live */
async function watchStreams(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await orig(c);
      w.__streams.push(s);
      return s;
    };
  });
}
const streams = (page: Page) =>
  page.evaluate(() => {
    const all = (window as unknown as { __streams: MediaStream[] }).__streams ?? [];
    return { opened: all.length, live: all.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length };
  });

async function signIn(browser: Browser, name: string, email: string, scheme: "dark" | "light") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  await watchStreams(context);
  const page = await context.newPage();
  return { context, page };
}

let board = "";
let ada: { context: BrowserContext; page: Page };
let kai: { context: BrowserContext; page: Page };

async function open(page: Page) {
  await page.goto(`/?rafshim&board=${board}`);
  await waitLive(page);
  await settle(page, 1200);
  // the whole grid in view, the section header on the screen
  await frame(page, "all");
}
/** the Review section (a new grid may also have its first, empty one) */
const section = (page: Page) => page.locator(".section-card[data-section-id]").filter({ has: page.locator(".section-name", { hasText: "Review" }) }).first();
/** its tools show while the pointer is on it */
async function noteTool(page: Page) {
  // a note left is framed (as any new card): back to the whole grid, the header on the screen
  await frame(page, "all");
  await section(page).hover();
  await settle(page, 300);
  await section(page).locator("[data-note-open]").click();
}

async function record(page: Page, kind: "Voice" | "Video", ms = 2000) {
  await noteTool(page);
  const rec = page.locator("[data-note-recorder]");
  await expect(rec).toBeVisible();
  if (kind === "Video") await rec.getByRole("radio", { name: "Video" }).click();
  // opening the recorder, and choosing, opened nothing
  expect((await streams(page)).live).toBe(0);
  await page.locator("[data-note-record]").click();
  await expect(page.locator('[data-note-recorder="recording"]')).toBeVisible({ timeout: 10_000 });
  expect((await streams(page)).live).toBeGreaterThan(0);
  await page.waitForTimeout(ms);
  await page.locator("[data-note-stop]").click();
  await expect(page.locator('[data-note-recorder="review"]')).toBeVisible({ timeout: 10_000 });
  // the light is out at Stop
  expect((await streams(page)).live).toBe(0);
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  ada = await signIn(browser, "Ada Admin", "admin@normal.dev", "dark");
  const made = await ada.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Notes ${Date.now().toString(36)}` } });
  expect(made.ok(), await made.text()).toBeTruthy();
  board = ((await made.json()) as { id: string }).id;
  const tool = await ada.context.request.post(`${CLIENT}/api/boards/${board}/tools/add_section`, { data: { name: "Review" } });
  expect(tool.ok(), await tool.text()).toBeTruthy();
  await open(ada.page);
  kai = await signIn(browser, "Kai Member", "kai@normal.dev", "light");
  await open(kai.page);
});

test.afterAll(async () => {
  await ada?.context.close();
  await kai?.context.close();
});

test("a voice note: recorded, reviewed, left; it has its wave and length, plays, and another person plays it too", async () => {
  const page = ada.page;
  await record(page, "Voice", 2000);
  await page.screenshot({ path: `${SHOTS}/recorder-review-night.png` });
  await page.locator("[data-note-leave]").click();
  await expect(page.locator("[data-note-recorder]")).toHaveCount(0, { timeout: 15_000 });

  await expect.poll(async () => (await notes(page)).length, { timeout: 10_000 }).toBe(1);
  const [n] = await notes(page);
  expect(n.media).toBe("audio");
  expect(n.src).toBe(`/files/${n.note!.fileId}`);
  expect(n.autoplay).toBe(false);
  expect(n.muted).toBe(false);
  expect(n.name).toBe("Voice note · Ada");
  expect(n.note!.byName).toBe("Ada Admin");
  expect(n.note!.ms).toBeGreaterThan(1500);
  expect(n.note!.ms).toBeLessThan(4000);
  expect(n.note!.peaks?.length).toBe(48);

  const card = page.locator('[data-note-kind="audio"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".voice-bars rect")).toHaveCount(96); // the wave, drawn twice (unplayed and played)
  await expect(card.locator("[data-voice-time]")).toHaveText(/^0:0[1-3]$/);
  await settle(page, 600);
  await page.screenshot({ path: `${SHOTS}/voice-card-night.png` });

  await card.locator(".voice-play").click();
  await expect.poll(() => card.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
  await page.screenshot({ path: `${SHOTS}/voice-card-playing-night.png` });
  await card.locator(".voice-play").click(); // pause
  expect((await streams(page)).live).toBe(0);

  // Kai sees it, and plays it
  const theirs = kai.page.locator('[data-note-kind="audio"]');
  await expect(theirs).toBeVisible({ timeout: 15_000 });
  await expect(theirs.locator("[data-voice-time]")).toHaveText(/^0:0[1-3]$/);
  await theirs.locator(".voice-play").click();
  await expect.poll(() => theirs.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
  await kai.page.screenshot({ path: `${SHOTS}/voice-card-playing-day.png` });
  await theirs.locator(".voice-play").click();
});

test("a video note: never plays by itself, plays with its sound in place, and another person sees it", async () => {
  const page = ada.page;
  await record(page, "Video", 2000);
  await page.screenshot({ path: `${SHOTS}/recorder-video-review-night.png` });
  await page.locator("[data-note-leave]").click();
  await expect(page.locator("[data-note-recorder]")).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await notes(page)).filter((m) => m.media === "video").length, { timeout: 10_000 }).toBe(1);
  const v = (await notes(page)).find((m) => m.media === "video")!;
  expect(v.autoplay).toBe(false);
  expect(v.muted).toBe(false);
  expect(v.name).toBe("Video note · Ada");
  expect(v.note!.ms).toBeGreaterThan(1500);

  const card = page.locator('[data-note-kind="video"]');
  await expect(card).toBeVisible();
  await expect(card.locator("video")).toHaveCount(1, { timeout: 10_000 });
  await settle(page, 1500);
  // it stands still: no autoplay
  expect(await card.locator("video").evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/video-card-night.png` });
  await card.locator(".note-video-host").click();
  await expect.poll(() => card.locator("video").evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
  expect(await card.locator("video").evaluate((el: HTMLVideoElement) => el.muted)).toBe(false);
  await card.locator(".note-video-host").click(); // pause

  const theirs = kai.page.locator('[data-note-kind="video"]');
  await expect(theirs).toBeVisible({ timeout: 15_000 });
  await expect(theirs.locator("video")).toHaveCount(1, { timeout: 10_000 });
  await settle(kai.page, 1200);
  expect(await theirs.locator("video").evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  await kai.page.screenshot({ path: `${SHOTS}/video-card-day.png` });
  await theirs.locator(".note-video-host").click();
  await expect.poll(() => theirs.locator("video").evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
  await theirs.locator(".note-video-host").click();
});

test("Discard leaves no card and no live track", async () => {
  const page = ada.page;
  const before = (await notes(page)).length;
  await noteTool(page);
  await page.locator("[data-note-record]").click();
  await expect(page.locator('[data-note-recorder="recording"]')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/recorder-recording-night.png` });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator('[data-note-recorder="idle"]')).toBeVisible();
  expect((await streams(page)).live).toBe(0);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("[data-note-recorder]")).toHaveCount(0);
  await settle(page, 800);
  expect((await notes(page)).length).toBe(before);
  expect((await streams(page)).live).toBe(0);
});

test("a viewer has no microphone in a section's tools", async () => {
  const me = (await (await kai.context.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } };
  const set = await ada.context.request.post(`${CLIENT}/api/boards/${board}/people`, { data: { userId: me.user.id, role: "viewer" } });
  expect(set.ok(), await set.text()).toBeTruthy();
  await open(kai.page);
  await section(kai.page).hover();
  // a viewer's page is a viewer's (its section tools are put away), and the microphone isn't even drawn
  await expect(kai.page.locator("body.is-viewer")).toHaveCount(1, { timeout: 10_000 });
  await kai.page.screenshot({ path: `${SHOTS}/viewer-tools-day.png` });
  await expect(section(kai.page).locator("[data-note-open]")).toHaveCount(0);
  // the notes are still there to play
  await expect(kai.page.locator('[data-note-kind="audio"]')).toBeVisible();
});

test("the design page draws the cards and every state of the recorder, day and night, without opening a device", async () => {
  for (const [who, scheme] of [[ada, "night"], [kai, "day"]] as const) {
    const page = who.page;
    await page.goto(`/?rafshim#/design/cards`);
    const sec = page.locator("#design-voice-and-video-notes");
    await expect(sec).toBeVisible({ timeout: 20_000 });
    await sec.scrollIntoViewIfNeeded();
    await expect(sec.locator(".note-rec")).toHaveCount(11);
    await expect(sec.locator(".voice-player")).toHaveCount(6); // three cards, and the clip in review, leaving and a failed upload
    await settle(page, 600);
    await sec.screenshot({ path: `${SHOTS}/design-${scheme}.png` });
    expect((await streams(page)).opened).toBe(0);
  }
});

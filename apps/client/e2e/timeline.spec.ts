/**
 * The timeline (docs/timeline.md §3), in a real browser against the real server:
 *
 *  - the design page draws the band, the section's bar and the moment from fixtures, day and night;
 *  - on a fresh grid: a note added, a second, the first removed (it asks first); the tab's clock opens the band,
 *    which shows the three changes; scrubbing to between the second add and the removal draws the first note in
 *    its section while the live cards hide, for this person only, with the banner; Back to now restores;
 *  - a section's own clock scrubs only that section, and with the band open it detaches (its marker on the band,
 *    Follow the grid joins them again);
 *  - a second person sees none of the first's rewind; a viewer can open and scrub; nothing is written.
 *
 * Evidence: docs/evidence/2026-11-25_timeline/.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";
import { CLIENT, frame, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-25_timeline";

test.describe.configure({ mode: "serial" });
// the notes are recorded on Chromium's fake microphone and camera (media-notes.spec.ts)
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } });

let board = "";
let ada: Page;
let sec1 = "";
let sec2 = "";
let first = "";
let second = "";

type Ev = { kind: string; at: number; object?: string; section: string | null };
const events = (p: Page) => p.evaluate(() => ((window as unknown as { __timeline: { get(k: string): { slice: { events: Ev[] } | null } | null } }).__timeline.get("grid")?.slice?.events ?? []).map((e) => ({ kind: e.kind, at: e.at, object: e.object, section: e.section })));
const headT = (p: Page, key = "grid") => p.evaluate((k) => (window as unknown as { __timeline: { get(k: string): { head: { t: number | null } } | null } }).__timeline.get(k)?.head.t ?? null, key);

/** a person in a light room: day */
async function dayPerson(browser: Browser, name: string, email: string, b: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  await context.addInitScript(() => localStorage.getItem("foundation-wheel") ?? localStorage.setItem("foundation-wheel", "pan"));
  const page = await context.newPage();
  await page.goto(`/?board=${encodeURIComponent(b)}`);
  await waitLive(page);
  return { context, page };
}

/** press the track at time t (where it is drawn now) */
async function scrubTo(p: Page, key: string, t: number) {
  const track = p.locator(`[data-tl-track="${key}"]`);
  const [from, to] = [Number(await track.getAttribute("data-tl-from")), Number(await track.getAttribute("data-tl-to"))];
  const box = (await track.boundingBox())!;
  const x = box.x + ((t - from) / (to - from)) * box.width;
  const y = box.y + box.height / 2;
  // a drag that ends there (a press without moving would take the mark under it, and go to that mark's moment)
  await p.mouse.move(x - 12, y);
  await p.mouse.down();
  await p.mouse.move(x - 6, y, { steps: 2 });
  await p.mouse.move(x, y, { steps: 2 });
  await p.mouse.up();
}

test("the design page draws the timeline from fixtures, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await context.newPage();
    await p.goto("/#/design/floor");
    const demo = p.locator("[data-tl-demo]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator("[data-tl-band]")).toHaveCount(4);
    await expect(demo.locator("[data-tl-begins]").first()).toContainText("History begins");
    await expect(demo.locator("[data-tl-withheld]").first()).toBeVisible();
    await expect(demo.locator('[data-tl-note="note.audio"]').first()).toBeVisible();
    await expect(demo.locator('[data-tl-note="note.video"]').first()).toBeVisible();
    await expect(demo.locator("[data-tl-demo-section]")).toHaveCount(3);
    await expect(demo.locator("[data-tl-follow]")).toHaveCount(1);
    // every lane of the busy band has marks drawn
    expect(Number(await demo.locator("[data-tl-band]").first().locator("[data-tl-track]").getAttribute("data-tl-marks"))).toBeGreaterThan(30);
    await settle(p, 500);
    const day = scheme === "light" ? "day" : "night";
    await demo.locator("[data-tl-band]").first().screenshot({ path: `${SHOTS}/01_band-busy-${day}.png` });
    await demo.locator("[data-tl-band]").nth(2).screenshot({ path: `${SHOTS}/02_history-begins-${day}.png` });
    await demo.locator(".tldemo-bars").first().screenshot({ path: `${SHOTS}/03_section-bars-260-400-560-${day}.png` });
    await demo.locator(".tldemo-moment").screenshot({ path: `${SHOTS}/04_moment-${day}.png` });
    await context.close();
  }
});

test("a grid's timeline: three changes, the first note drawn as it was, Back to now", async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await a.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Timeline ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  ada = a.page;
  await ada.goto(`/?board=${board}`);
  await waitLive(ada);
  sec1 = await ada.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string }> } } }).__foundation.getState().sections)[0].id);
  const tool = async (name: string, data: object) => {
    const r = await a.context.request.post(`${CLIENT}/api/boards/${board}/tools/${name}`, { data });
    expect(r.ok(), await r.text()).toBe(true);
    return ((await r.json()) as { result: { id: string } }).result;
  };
  // the history keeps changes in bursts of 2 s: the steps are kept apart
  await settle(ada, 2500);
  first = (await tool("add_note", { title: "First note", markdown: "# Brief\n\nThe **first** thing written here\n\n- wall 2 mm\n- PETG" })).id;
  await settle(ada, 6000);
  second = (await tool("add_note", { title: "Second note", markdown: "The second" })).id;
  await settle(ada, 8000);
  // remove the first the way a person does: its ✕, which asks first when there's something to lose
  await frame(ada, "section", sec1);
  const slot = ada.locator(`.obj-slot[data-obj-id="${first}"]`);
  const card = slot.locator(".frame-card").first();
  if (await card.count()) {
    const b = (await card.boundingBox())!;
    await ada.mouse.move(b.x + b.width / 2, b.y + b.height * 0.6, { steps: 4 });
    await settle(ada, 500);
  }
  const x = slot.locator(".frame-header .is-remove");
  if (await x.isVisible().catch(() => false)) {
    await x.click();
    const pop = slot.locator(".frame-confirm");
    await settle(ada, 300);
    if (await pop.isVisible().catch(() => false)) await pop.locator(".confirm-btn.danger").click();
  }
  if (await slot.count()) {
    // the card's chrome isn't there to press (another builder's card menu in flux): the tool, which also asks for confirm
    const r = await a.context.request.post(`${CLIENT}/api/boards/${board}/tools/delete_card`, { data: { id: first, confirm: true } });
    expect(r.ok()).toBe(true);
  }
  await expect(slot).toHaveCount(0, { timeout: 5000 });
  await settle(ada, 3000);

  // the tab's clock opens the band
  const clock = ada.locator("[data-tab-time]");
  await expect(clock).toBeVisible();
  await clock.click();
  await expect(clock).toHaveClass(/is-on/);
  const band = ada.locator("[data-tl-band]");
  await expect(band).toBeVisible();
  const track = ada.locator('[data-tl-track="grid"]');
  await expect.poll(async () => Number(await track.getAttribute("data-tl-changes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  // a grid a minute old opens on All, fitted to its history: the unknown before it a small lead-in, the marks spread
  await expect(band.locator('[data-tl-range="all"]')).toHaveAttribute("aria-checked", "true");
  await expect(band.locator("[data-tl-span]")).toContainText("of history");
  const fit = async () => {
    const [from, to] = [Number(await track.getAttribute("data-tl-from")), Number(await track.getAttribute("data-tl-to"))];
    const start = await ada.evaluate(() => (window as unknown as { __timeline: { get(k: string): { slice: { start: number } } } }).__timeline.get("grid").slice.start);
    const es = await events(ada);
    const firstAdd = es.find((e) => e.kind === "card.add")!.at;
    return { unknown: (start - from) / (to - from), firstAt: (firstAdd - from) / (to - from), span: to - from };
  };
  await expect.poll(async () => (await fit()).unknown, { timeout: 10_000 }).toBeLessThanOrEqual(0.13);
  let f = await fit();
  expect(f.firstAt).toBeLessThan(0.7);
  expect(f.span).toBeLessThan(10 * 60_000);
  await settle(ada, 400);
  await band.screenshot({ path: `${SHOTS}/10_young-grid-band-all-night.png` });
  // the hour, on a grid this young, is clipped the same way and says so
  await band.locator('[data-tl-range="hour"]').click();
  await expect.poll(async () => (await fit()).span, { timeout: 10_000 }).toBeLessThan(10 * 60_000);
  f = await fit();
  expect(f.unknown).toBeLessThanOrEqual(0.13);
  await expect(band.locator("[data-tl-span]")).toBeVisible();
  const evs = await events(ada);
  const adds = evs.filter((e) => e.kind === "card.add");
  const removes = evs.filter((e) => e.kind === "card.remove" && e.object === first);
  expect(adds.find((e) => e.object === first), JSON.stringify(evs)).toBeTruthy();
  expect(adds.find((e) => e.object === second), JSON.stringify(evs)).toBeTruthy();
  expect(removes.length, JSON.stringify(evs)).toBe(1);
  // the band took its height from the grid: the floor's foot, and the bottom bar sits on it
  const h = await band.evaluate((el) => el.getBoundingClientRect().height);
  const hud = (await ada.locator(".hud-room").boundingBox())!;
  expect(Math.abs(hud.y + hud.height - (900 - h))).toBeLessThan(3);
  await ada.screenshot({ path: `${SHOTS}/05_grid-band-at-now-night.png` });

  // between the second add and the removal: the first note is drawn as it was, the live cards hide
  const tAdd = adds.find((e) => e.object === second)!.at;
  const tRemove = removes[0].at;
  await expect(ada.locator('[data-tl-track="grid"]')).toHaveAttribute("data-tl-from", /\d+/);
  await scrubTo(ada, "grid", tAdd + (tRemove - tAdd) / 2);
  const t = (await headT(ada))!;
  expect(t).toBeGreaterThan(tAdd);
  expect(t).toBeLessThan(tRemove);
  const past = ada.locator(`[data-tl-past="${sec1}"]`);
  await expect(past).toHaveCount(1);
  await expect(past.locator('[data-rp-card="First note"]')).toHaveCount(1, { timeout: 8000 });
  await expect(past.locator('[data-rp-card="Second note"]')).toHaveCount(1);
  // drawn as the note it was: its formatted text through the live note's renderer, at the live card's type size
  const old = past.locator('[data-rp-card="First note"]');
  await expect(old.locator(".note-rendered h1")).toHaveText("Brief");
  await expect(old.locator(".note-rendered strong")).toHaveText("first");
  await expect(old.locator(".note-rendered li")).toHaveCount(2);
  await expect(old).not.toContainText("**");
  const fs = async (sel: string) => ada.locator(sel).first().evaluate((el) => getComputedStyle(el).fontSize);
  expect(await fs(`[data-tl-past="${sec1}"] [data-rp-card="Second note"] .note-rendered`)).toBe(await fs(`.obj-slot[data-obj-id="${second}"] .note-rendered`));
  await expect(ada.locator(`.obj-slot[data-obj-id="${second}"]`)).toHaveCSS("opacity", "0");
  await expect(ada.locator("[data-tl-banner]")).toContainText("Looking at");
  // the keys that write stand down while looking back
  await ada.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ada.keyboard.press("Control+z");
  await settle(ada, 400);
  expect(await ada.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { notes: object } } }).__foundation.getState().notes).length)).toBe(1);
  await settle(ada, 500);
  await ada.screenshot({ path: `${SHOTS}/06_grid-rewound-night.png` });
  // a scrub drawn frame by frame: the pointer across the whole band and back, the time between frames kept
  {
    const box = (await ada.locator('[data-tl-track="grid"]').boundingBox())!;
    await ada.evaluate(() => {
      const w = window as unknown as { __tlFrames: number[]; __tlOn: boolean };
      w.__tlFrames = [];
      w.__tlOn = true;
      let last = performance.now();
      const tick = (t: number) => {
        w.__tlFrames.push(t - last);
        last = t;
        if (w.__tlOn) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const y = box.y + box.height / 2;
    await ada.mouse.move(box.x + box.width - 4, y);
    await ada.mouse.down();
    for (let i = 0; i <= 60; i++) await ada.mouse.move(box.x + box.width - 4 - (i / 60) * (box.width - 8), y);
    for (let i = 0; i <= 60; i++) await ada.mouse.move(box.x + 4 + (i / 60) * (box.width - 8), y);
    await ada.mouse.up();
    const fr = await ada.evaluate(() => {
      const w = window as unknown as { __tlFrames: number[]; __tlOn: boolean };
      w.__tlOn = false;
      return w.__tlFrames.slice(1).sort((a, b) => a - b);
    });
    const p = (q: number) => fr[Math.min(fr.length - 1, Math.floor(fr.length * q))];
    console.log(`scrub frames: ${fr.length}, median ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, worst ${fr[fr.length - 1].toFixed(1)} ms`);
    expect(p(0.5)).toBeLessThan(34);
  }
  // before the first add: no notes at all in the section
  await scrubTo(ada, "grid", adds.find((e) => e.object === first)!.at - 3000);
  await expect(past.locator("[data-rp-card]")).toHaveCount(0, { timeout: 8000 });

  // Back to now restores the live section
  await ada.locator("[data-tl-back]").click();
  await expect(past).toHaveCount(0);
  await expect(ada.locator(`.obj-slot[data-obj-id="${second}"]`)).toHaveCSS("opacity", "1");
  expect(await headT(ada)).toBeNull();
});

test("a section's clock scrubs only that section, and detaches from the grid's", async () => {
  // a second section, through the tools
  const r = await ada.context().request.post(`${CLIENT}/api/boards/${board}/tools/add_section`, { data: { name: "Bench" } });
  expect(r.ok()).toBe(true);
  sec2 = ((await r.json()) as { result: { id: string } }).result.id;
  await ada.locator(`[data-section-id="${sec2}"]`).waitFor();
  await frame(ada, "all");
  // the grid's band is still open: close it first, so the section's bar is alone
  await ada.locator("[data-tab-time]").click();
  await expect(ada.locator("[data-tl-band]")).toHaveCount(0);
  // the section's clock at rest: in its header with the council chip, quiet and plain to see, zoomed in too
  await frame(ada, "section", sec1);
  await ada.mouse.move(4, 450);
  await settle(ada, 600);
  const restClock = ada.locator(`[data-section-id="${sec1}"] .section-header .sec-time-head`);
  await expect(restClock).toBeVisible();
  expect((await restClock.boundingBox())!.width).toBeGreaterThanOrEqual(14);
  const rb = (await restClock.boundingBox())!;
  expect(rb.x >= 0 && rb.y >= 0 && rb.x + rb.width <= 1440 && rb.y + rb.height <= 900, "on the screen").toBe(true);
  await ada.screenshot({ path: `${SHOTS}/11_section-clock-at-rest-night.png`, clip: { x: 0, y: 0, width: 1440, height: 300 } });
  // the clock beside the name opens the section's timeline
  await restClock.click();
  const bar = ada.locator(`[data-tl-section="${sec1}"]`);
  await expect(bar).toBeVisible();
  // open, the clock is on in the tools and, at rest, in the header
  await expect(ada.locator(`[data-section-id="${sec1}"] .section-tools [data-sec-time="${sec1}"]`)).toHaveClass(/is-on/);
  await ada.mouse.move(4, 450);
  await ada.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(ada, 600);
  await expect(restClock).toBeVisible();
  await expect(restClock).toHaveClass(/is-on/);
  await frame(ada, "all");
  const key = `s:${sec1}`;
  const track = ada.locator(`[data-tl-track="${key}"]`);
  await expect(track).toBeVisible({ timeout: 10_000 });
  await track.focus();
  await ada.keyboard.press("Home");
  await expect(ada.locator(`[data-tl-past="${sec1}"]`)).toHaveCount(1);
  await expect(ada.locator(`[data-tl-past="${sec2}"]`)).toHaveCount(0);
  await expect(ada.locator("[data-tl-banner]")).toHaveCount(0);
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/07_section-bar-rewound-night.png` });

  // the grid's band opens too: scrubbing the section's bar now detaches it, its marker shows on the band
  await ada.keyboard.press("End");
  await ada.locator("[data-tab-time]").click();
  await expect(ada.locator("[data-tl-band]")).toBeVisible();
  await track.focus();
  await ada.keyboard.press("Home");
  await expect(bar.locator("[data-tl-follow]")).toBeVisible();
  await expect(ada.locator(`[data-tl-marker="${sec1}"]`)).toBeVisible();
  await expect(ada.locator(`[data-tl-past="${sec2}"]`)).toHaveCount(0);
  await bar.locator("[data-tl-follow]").click();
  await expect(bar.locator("[data-tl-follow]")).toHaveCount(0);
  await expect(ada.locator(`[data-tl-past="${sec1}"]`)).toHaveCount(0);
  await bar.locator("[data-tl-close]").click();
  await expect(bar).toHaveCount(0);
});

test("someone else on the grid sees none of it; a viewer can open and scrub", async ({ browser }) => {
  // Ada looks back at the start
  const band = ada.locator("[data-tl-band]");
  await expect(band).toBeVisible();
  await ada.locator('[data-tl-track="grid"]').focus();
  await ada.keyboard.press("Home");
  await expect(ada.locator(`[data-tl-past="${sec1}"]`)).toHaveCount(1);
  const notesBefore = await ada.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { notes: object } } }).__foundation.getState().notes).length);

  // Kai, a viewer on this grid
  const kai = await person(browser, "Kai Viewer", "kai@normal.dev", board);
  await expect(kai.page.locator("[data-tl-past]")).toHaveCount(0);
  await expect(kai.page.locator("[data-tl-banner]")).toHaveCount(0);
  await expect(kai.page.locator(`.obj-slot[data-obj-id="${second}"]`)).toHaveCSS("opacity", "1");
  const me = (await (await kai.context.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } };
  const admin = await browser.newContext();
  await admin.request.post(`${CLIENT}/auth/dev`, { data: { name: "Admin", email: "admin@normal.dev" } });
  const set = await admin.request.post(`${CLIENT}/api/boards/${board}/people`, { data: { userId: me.user.id, role: "viewer" } });
  expect(set.ok(), await set.text()).toBe(true);
  await admin.close();
  await kai.page.reload();
  await waitLive(kai.page);
  await expect(kai.page.locator("body.is-viewer")).toHaveCount(1);
  await kai.page.keyboard.press("h");
  await expect(kai.page.locator("[data-tl-band]")).toBeVisible();
  await expect.poll(async () => Number(await kai.page.locator('[data-tl-track="grid"]').getAttribute("data-tl-changes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await kai.page.locator('[data-tl-track="grid"]').focus();
  await kai.page.keyboard.press("Home");
  await expect(kai.page.locator(`[data-tl-past="${sec1}"]`)).toHaveCount(1);
  await settle(kai.page, 600);
  await kai.page.screenshot({ path: `${SHOTS}/08_viewer-scrubbing-night.png` });
  // Ada's view is still hers, and nothing was written by either
  await expect(ada.locator(`[data-tl-past="${sec1}"]`)).toHaveCount(1);
  expect(await ada.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { notes: object } } }).__foundation.getState().notes).length)).toBe(notesBefore);
  await kai.context.close();
  await ada.keyboard.press("Escape");
  await expect(ada.locator("[data-tl-past]")).toHaveCount(0);
});

test("day: the band and a rewind", async ({ browser }) => {
  const d = await dayPerson(browser, "Ada Test", "ada@normal.dev", board);
  await d.page.keyboard.press("h");
  await expect(d.page.locator("[data-tl-band]")).toBeVisible();
  await d.page.locator('[data-tl-range="hour"]').click();
  await expect.poll(async () => Number(await d.page.locator('[data-tl-track="grid"]').getAttribute("data-tl-changes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const evs = await events(d.page);
  const add2 = evs.find((e) => e.kind === "card.add" && e.object === second)!.at;
  const rm = evs.find((e) => e.kind === "card.remove")!.at;
  await scrubTo(d.page, "grid", add2 + (rm - add2) / 2);
  await expect(d.page.locator(`[data-tl-past="${sec1}"] [data-rp-card="First note"]`)).toHaveCount(1, { timeout: 8000 });
  await settle(d.page, 600);
  await d.page.screenshot({ path: `${SHOTS}/09_grid-rewound-day.png` });
  await d.page.keyboard.press("Escape");
  await d.page.locator('[data-tl-range="all"]').click();
  await settle(d.page, 1200);
  await d.page.locator("[data-tl-band]").screenshot({ path: `${SHOTS}/10_young-grid-band-all-day.png` });
  await d.context.close();
});

// ---------- 2026-11-25, second pass: what the first one left unchecked ----------

type Media = { id: string; sectionId: string; media: string; note?: { fileId: string } };
const noteCards = (p: Page) => p.evaluate(() => Object.values((window as unknown as { __foundation: { getState(): { media: Record<string, Media> } } }).__foundation.getState().media).filter((m) => m.note)) as Promise<Media[]>;

async function signedIn(browser: Browser, scheme: "dark" | "light" = "dark") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const page = await context.newPage();
  return { context, page };
}

/** a voice or video note recorded on Chromium's fake microphone and camera (e2e/media-notes.spec.ts) */
async function recordNote(p: Page, section: string, kind: "Voice" | "Video") {
  await frame(p, "all");
  await p.locator(`[data-section-id="${section}"] .section-header`).hover();
  await settle(p, 300);
  await p.locator(`[data-section-id="${section}"] [data-note-open]`).click();
  const rec = p.locator("[data-note-recorder]");
  await expect(rec).toBeVisible();
  if (kind === "Video") await rec.getByRole("radio", { name: "Video" }).click();
  await p.locator("[data-note-record]").click();
  await expect(p.locator('[data-note-recorder="recording"]')).toBeVisible({ timeout: 10_000 });
  await p.waitForTimeout(2000);
  await p.locator("[data-note-stop]").click();
  await expect(p.locator('[data-note-recorder="review"]')).toBeVisible({ timeout: 10_000 });
  await p.locator("[data-note-leave]").click();
  await expect(p.locator("[data-note-recorder]")).toHaveCount(0, { timeout: 15_000 });
}

/** the band closed and opened again: its slice read afresh */
async function reopen(p: Page) {
  if (await p.locator("[data-tl-band]").count()) await p.keyboard.press("h");
  await expect(p.locator("[data-tl-band]")).toHaveCount(0);
  await p.keyboard.press("h");
  await expect(p.locator('[data-tl-track="grid"]')).toBeVisible({ timeout: 15_000 });
}

test("a voice and a video note play from the moment, and still play after their cards are gone", async ({ browser }) => {
  const { context, page: p } = await signedIn(browser);
  await p.goto(`/?board=${board}`);
  await waitLive(p);
  await recordNote(p, sec1, "Voice");
  await settle(p, 2500);
  await recordNote(p, sec1, "Video");
  await expect.poll(async () => (await noteCards(p)).length, { timeout: 10_000 }).toBe(2);
  await settle(p, 2500);
  await p.mouse.move(4, 450);
  await reopen(p);
  await expect.poll(async () => (await events(p)).filter((e) => e.kind.startsWith("note.")).length, { timeout: 15_000 }).toBe(2);
  const play = async (kind: "note.audio" | "note.video") => {
    const at = (await events(p)).find((e) => e.kind === kind)!.at;
    await scrubTo(p, "grid", at + 500);
    const row = p.locator(`[data-tl-moment="grid"] [data-tl-note="${kind}"]`).first();
    await expect(row).toBeVisible();
    await row.locator(".tl-note-play").click();
    const el = row.locator(kind === "note.audio" ? "audio" : "video");
    await expect.poll(() => el.evaluate((m: HTMLMediaElement) => m.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
    return row;
  };
  const voice = await play("note.audio");
  await p.screenshot({ path: `${SHOTS}/12_voice-note-playing-from-the-moment-night.png` });
  await voice.locator(".tl-note-play").click();
  const video = await play("note.video");
  await p.locator('[data-tl-moment="grid"]').screenshot({ path: `${SHOTS}/13_video-note-playing-from-the-moment-night.png` });
  await video.locator(".tl-note-play").click();
  // the cards removed (the tool asks for confirm): the notes still play from the timeline
  for (const m of await noteCards(p)) {
    const r = await context.request.post(`${CLIENT}/api/boards/${board}/tools/delete_card`, { data: { id: m.id, confirm: true } });
    expect(r.ok()).toBe(true);
  }
  await expect.poll(async () => (await noteCards(p)).length).toBe(0);
  await p.keyboard.press("Escape");
  await reopen(p);
  await play("note.audio");
  await play("note.video");
  await context.close();
});

test("the band beside the councils, a narrow window and a short one; a write while looking back", async ({ browser }) => {
  const { context, page: p } = await signedIn(browser);
  await p.goto(`/?board=${board}`);
  await waitLive(p);
  await p.keyboard.press("h");
  const band = p.locator("[data-tl-band]");
  await expect(p.locator('[data-tl-track="grid"]')).toBeVisible({ timeout: 15_000 });
  const bandTop = async () => (await band.boundingBox())!.y;

  // the grid's council stands on the band, not under it; its buttons and the bottom bar stay reachable
  await p.locator("[data-council-open]").click();
  const place = p.locator(".council-place.is-board");
  await expect(place).toBeVisible();
  await settle(p, 900);
  const cb = (await place.boundingBox())!;
  expect(cb.y + cb.height).toBeLessThanOrEqual((await bandTop()) + 1);
  const hud = (await p.locator("[data-hud]").boundingBox())!;
  expect(hud.y + hud.height).toBeLessThanOrEqual((await bandTop()) + 1);
  await expect(p.locator("[data-council-open]")).toBeVisible();
  await p.screenshot({ path: `${SHOTS}/14_band-with-grid-council-night.png` });
  await p.locator("[data-council-open]").click();
  await expect(place).toHaveCount(0);

  // a section's council stands on its top edge: the band at the foot never covers it
  await frame(p, "all");
  await p.locator(`[data-section-id="${sec1}"] .section-header`).hover();
  await p.locator(`[data-section-id="${sec1}"] .section-tools .sec-council`).click();
  const sc = p.locator(".council-place.is-section");
  await expect(sc).toBeVisible();
  const sb = (await sc.boundingBox())!;
  expect(sb.y + sb.height).toBeLessThan(await bandTop());
  await settle(p, 600);
  await p.screenshot({ path: `${SHOTS}/14b_band-with-section-council-night.png` });
  await p.locator(`[data-section-id="${sec1}"] .section-header`).hover();
  await p.locator(`[data-section-id="${sec1}"] .section-tools .sec-council`).click();
  await p.mouse.move(4, 450);
  await settle(p, 400);

  // narrow: the names and the moment fold away, the nearest line rides the transport; the bar sits on the band
  await p.setViewportSize({ width: 860, height: 900 });
  await settle(p, 900);
  await expect(band.locator(".tl-moment")).toBeHidden();
  await expect(band.locator(".tl-names")).toBeHidden();
  const evs = await events(p);
  await scrubTo(p, "grid", evs.find((e) => e.kind === "card.add")!.at + 500);
  const hud2 = (await p.locator("[data-hud]").boundingBox())!;
  expect(hud2.y + hud2.height).toBeLessThanOrEqual((await bandTop()) + 1);
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await p.screenshot({ path: `${SHOTS}/15_narrow-860-night.png` });

  // short: the lanes fold to two rows, the grid keeps its paper
  await p.setViewportSize({ width: 1440, height: 700 });
  await settle(p, 900);
  await expect(band).toHaveClass(/is-short/);
  expect((await band.boundingBox())!.height).toBeLessThan(150);
  const hud3 = (await p.locator("[data-hud]").boundingBox())!;
  expect(hud3.y).toBeGreaterThan(300);
  expect(hud3.y + hud3.height).toBeLessThanOrEqual((await bandTop()) + 1);
  await p.screenshot({ path: `${SHOTS}/16_short-700-night.png` });

  // a key that would write, while looking back: the banner says it again; no toast lands on the lanes
  await p.setViewportSize({ width: 1440, height: 900 });
  await settle(p, 600);
  await scrubTo(p, "grid", evs.find((e) => e.kind === "card.add")!.at + 500);
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await p.keyboard.press("Delete");
  await expect(p.locator("[data-tl-banner]")).toHaveClass(/is-pulse/);
  await expect(p.locator(".toast")).toHaveCount(0);
  await context.close();
});

test("a server without the timeline route says so, and doesn't spin", async ({ browser }) => {
  const { context, page: p } = await signedIn(browser, "light");
  await p.route(/\/api\/boards\/[^/]+\/timeline/, (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) }));
  await p.goto(`/?board=${board}`);
  await waitLive(p);
  await p.keyboard.press("h");
  const why = p.locator("[data-tl-band] [data-tl-why]");
  await expect(why).toBeVisible({ timeout: 10_000 });
  await expect(why).toContainText("keeps no timeline");
  await expect(p.locator("[data-tl-band]")).toHaveAttribute("data-tl-state", "missing");
  await p.locator("[data-tl-band]").screenshot({ path: `${SHOTS}/17_route-missing-day.png` });
  await context.close();
});

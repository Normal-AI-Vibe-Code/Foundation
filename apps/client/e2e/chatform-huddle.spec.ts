/**
 * Huddles in ChatForm channels (H1, docs/chatform.md §1 "A huddle is a message"): two people in two
 * browsers with the drawn test camera (`?fakecam`). Ada starts a huddle in #general from the channel's
 * head; its card appears for Kai, who joins; each receives the other's video; a typed line reaches the
 * other; Ada shares a (drawn) screen and seats an agent that answers; Ada records; Ada takes the huddle to
 * a grid section and goes there: the grid's card is the same live call, and the other's video never stops
 * for more than a moment (measured as the longest gap between decoded frames). Both leave: the channel's
 * card shows it ended, with its recordings and Replay; the Huddles tab lists the session. A third person,
 * not in a private channel, can't see or join its huddle, and on a grid sees only whose huddle it is.
 * Ada's window is night, Kai's is day: screenshots of both into docs/evidence/2026-11-18_chatform/huddle-*.
 *
 *   E2E_SERVER_PORT=16331 E2E_CLIENT_PORT=16351 E2E_SLACK_PORT=16341 E2E_MESHY_PORT=16345 E2E_T3_PORT=16395 npm run e2e -w @foundation/client -- chatform-huddle.spec.ts
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = fileURLToPath(new URL("../../../docs/evidence/2026-11-18_chatform/", import.meta.url));

type Store = { loaded: boolean; status: string; me: { id: string } | null; channels: Record<string, { id: string; name: string; kind: string; huddle?: { id: string; board: string; people: string[] } | null }> };
const store = (p: Page) => p.evaluate(() => (window as unknown as { __chatform: () => Store }).__chatform());

/** a signed-in person in their own browser, in the light they asked for, with the drawn camera */
async function person(browser: Browser, name: string, email: string, scheme: "light" | "dark"): Promise<{ context: BrowserContext; page: Page; id: string }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  if (!res.ok()) throw new Error(`dev login for ${email}: ${res.status()} ${await res.text()}`);
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const me = (await (await context.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } };
  const page = await context.newPage();
  await page.goto(`/?fakecam&board=company`);
  await waitLive(page);
  await page.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().loaded === true, undefined, { timeout: 30_000 });
  return { context, page, id: me.user.id };
}

const toChannel = async (p: Page, id: string) => {
  await p.evaluate((c) => (window.location.hash = `#/chat/chat/${c}`), id);
  await expect(p.locator(`[data-channel-head="${id}"]`)).toBeVisible({ timeout: 15_000 });
};

/** the other person's video on this page is playing (decoded frames, a real size) */
const playing = (p: Page, sel: string) => p.evaluate((s) => [...document.querySelectorAll<HTMLVideoElement>(s)].some((v) => v.readyState >= 2 && v.videoWidth > 0 && (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 1) > 0), sel);

/**
 * Watch the call while it moves: the chip's video (it lives as long as the call, wherever you are), each
 * new decoded frame; and the call itself, each distinct "peer id : connection state" seen. A call that
 * renegotiated or dropped shows a second peer id or a state other than connected.
 */
const watchFrames = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __hgap?: { stamps: number[]; seen: Set<string>; stop: boolean }; __huddle: () => { peers: Array<{ id: string; state: string; sending: boolean }> } | null };
    w.__hgap = { stamps: [], seen: new Set(), stop: false };
    let last = -1;
    const tick = () => {
      if (w.__hgap!.stop) return;
      const v = document.querySelector<HTMLVideoElement>(".huddle-pip-face video");
      const n = v?.getVideoPlaybackQuality?.().totalVideoFrames ?? -1;
      if (n !== last && n > 0) w.__hgap!.stamps.push(performance.now());
      last = n;
      w.__hgap!.seen.add(
        (w.__huddle()?.peers ?? [])
          .filter((x) => x.sending)
          .map((x) => `${x.id}:${x.state}`)
          .join(","),
      );
      setTimeout(tick, 20);
    };
    tick();
  });
const longestGap = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __hgap: { stamps: number[]; seen: Set<string>; stop: boolean } };
    w.__hgap.stop = true;
    const s = w.__hgap.stamps;
    let gap = 0;
    for (let i = 1; i < s.length; i++) gap = Math.max(gap, s[i] - s[i - 1]);
    return { gap: Math.round(gap), frames: s.length, call: [...w.__hgap.seen] };
  });

test.describe.configure({ mode: "serial" });

test("#/design: the huddle row of the ChatForm chapter, day and night", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    const p = await c.newPage();
    await p.goto("/#/design");
    const row = p.locator(".hdemo");
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator(".hcard")).toHaveCount(2);
    await expect(row.locator('[data-huddle-agent="Wren"]')).toBeVisible();
    await settle(p, 900);
    await row.screenshot({ path: `${SHOTS}huddle-00_design-${scheme === "light" ? "day" : "night"}.png` });
    await c.close();
  }
});

test("a channel's huddle: start, join, video both ways, a line, a screen, an agent, record, take it to a grid, leave, the archive", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(SHOTS, { recursive: true });
  const ada = await person(browser, "Ada Lovelace", "ada@normal.dev", "dark");
  const kai = await person(browser, "Kai Moreno", "kai@normal.dev", "light");

  // a grid with a section for it to go to
  const gridName = `Bracket review ${Date.now().toString(36)}`;
  const made = await ada.context.request.post(`${CLIENT}/api/boards`, { data: { name: gridName } });
  const board = ((await made.json()) as { id: string }).id;
  await ada.context.request.post(`${CLIENT}/api/boards/${board}/tools/add_section`, { data: { name: "Brackets" } });

  const general = Object.values((await store(ada.page)).channels).find((c) => c.kind === "open" && c.name === "general")!;
  expect(general, "everyone is in #general").toBeTruthy();
  await toChannel(ada.page, general.id);
  await toChannel(kai.page, general.id);

  // Ada starts it from the head: the call docks above the timeline
  await ada.page.locator(`[data-huddle-start="${general.id}"]`).click();
  const adaDock = ada.page.locator("[data-huddle-dock]");
  await expect(adaDock).toBeVisible({ timeout: 15_000 });
  const huddleId = (await adaDock.getAttribute("data-huddle-dock"))!;
  expect(huddleId).toMatch(/^hd_/);

  // the card appears for Kai, live; he joins
  const kaiCard = kai.page.locator(`.hcard[data-huddle="${huddleId}"]`);
  await expect(kaiCard).toHaveAttribute("data-huddle-state", "live", { timeout: 15_000 });
  await kaiCard.locator("[data-huddle-join]").click();
  await expect(kai.page.locator(`[data-huddle-dock="${huddleId}"]`)).toBeVisible();

  // each receives the other's camera
  const peers = (p: Page) => p.evaluate(() => JSON.stringify((window as unknown as { __huddle: () => { status: string; peers: Array<{ name: string; state: string; stream: unknown; sending: boolean }> } | null }).__huddle()?.peers.map((x) => [x.name, x.state, Boolean(x.stream), x.sending])));
  await expect
    .poll(async () => (await playing(ada.page, '[data-huddle-tile="Kai Moreno"] video')) || `${await peers(ada.page)} / ${await peers(kai.page)}`, { timeout: 20_000 })
    .toBe(true);
  await expect.poll(() => playing(kai.page, '[data-huddle-tile="Ada Lovelace"] video'), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await store(kai.page)).channels[general.id]?.huddle?.people.slice().sort(), { timeout: 10_000 }).toEqual(["Ada Lovelace", "Kai Moreno"]);

  // a typed line reaches the other
  await ada.page.locator("[data-huddle-say]").fill("The bracket needs a 2 mm fillet on the inside corner");
  await ada.page.locator("[data-huddle-say]").press("Enter");
  await expect(kai.page.locator(".hdock .huddle-line", { hasText: "2 mm fillet" })).toBeVisible({ timeout: 10_000 });

  // Ada shares her (drawn) screen: it's large for Kai, the faces a strip under it
  await ada.page.getByRole("button", { name: "Share screen" }).click();
  await expect(kai.page.locator('[data-huddle-sharing="Ada Lovelace"]')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => playing(kai.page, ".huddle-screen video"), { timeout: 20_000 }).toBe(true);
  // only one at a time: Kai's share button waits
  await expect(kai.page.getByRole("button", { name: "Share screen" })).toBeDisabled();

  // an agent sits in: named, it answers (the scripted runtime), its seat shows for both
  await ada.page.getByRole("button", { name: "Invite an agent" }).click();
  await ada.page.getByLabel("Agent's name").fill("Wren");
  await ada.page.getByLabel("Agent's name").press("Enter");
  await expect(kai.page.locator('[data-huddle-agent="Wren"]')).toBeVisible({ timeout: 10_000 });
  await kai.page.locator("[data-huddle-say]").fill("Wren, is a 2 mm fillet enough?");
  await kai.page.locator("[data-huddle-say]").press("Enter");
  await expect(ada.page.locator(".hdock .huddle-line.is-agent", { hasText: "Wren here" })).toBeVisible({ timeout: 15_000 });

  // record: REC for both
  await ada.page.getByRole("button", { name: "Record", exact: true }).click();
  await ada.page.getByRole("button", { name: "Record everyone" }).click();
  await expect(kai.page.locator(".hdock .huddle-rec")).toBeVisible({ timeout: 10_000 });
  await settle(ada.page, 2500);
  await ada.page.screenshot({ path: `${SHOTS}huddle-01_in-call-sharing-night.png` });
  await kai.page.screenshot({ path: `${SHOTS}huddle-02_in-call-sharing-day.png` });
  await ada.page.getByRole("button", { name: "Stop sharing" }).click();
  await expect(kai.page.locator("[data-huddle-sharing]")).toHaveCount(0, { timeout: 10_000 });

  // take it to the grid, measuring the other's video on both sides the whole time
  await watchFrames(ada.page);
  await watchFrames(kai.page);
  await settle(ada.page, 1000);
  await ada.page.locator("[data-huddle-place]").click();
  await ada.page.getByLabel("Grid", { exact: true }).selectOption(board);
  await expect(ada.page.getByLabel("Section", { exact: true })).not.toBeDisabled({ timeout: 10_000 });
  await ada.page.locator("[data-huddle-take]").click();
  await expect(ada.page.locator("[data-huddle-go]")).toBeVisible({ timeout: 10_000 });
  // the channel says where it went; Kai's card offers the grid
  await expect(kai.page.locator(".chat-msg", { hasText: `Ada Lovelace took the huddle to ${gridName}` })).toBeVisible({ timeout: 10_000 });
  await expect(kaiCard.locator("[data-huddle-grid]")).toBeVisible({ timeout: 10_000 });
  await ada.page.locator("[data-huddle-go]").click();
  await waitLive(ada.page);
  const gridCard = ada.page.locator(`[data-obj-id="${huddleId}"]`);
  await expect(gridCard.locator(".huddle-body")).toBeVisible({ timeout: 20_000 });
  await expect(gridCard.locator(".huddle-status")).toHaveText(/Live · 2/, { timeout: 15_000 });
  await expect.poll(() => playing(ada.page, `[data-obj-id="${huddleId}"] [data-huddle-tile="Kai Moreno"] video`), { timeout: 15_000 }).toBe(true);
  await settle(ada.page, 2500);
  const gapAda = await longestGap(ada.page);
  const gapKai = await longestGap(kai.page);
  console.log(`taking it to a grid: longest gap between Kai's frames at Ada ${gapAda.gap} ms (${gapAda.frames} frames), Ada's at Kai ${gapKai.gap} ms (${gapKai.frames} frames); the call as each saw it: ${JSON.stringify([gapAda.call, gapKai.call])}`);
  // the same call throughout: one peer, one connection, connected the whole time (nothing renegotiated or rejoined)
  expect(gapAda.call, "Ada's call never changed").toHaveLength(1);
  expect(gapKai.call, "Kai's call never changed").toHaveLength(1);
  expect(gapAda.call[0]).toMatch(/^c_[0-9a-f]+:connected$/);
  expect(gapKai.call[0]).toMatch(/^c_[0-9a-f]+:connected$/);
  // and the picture kept coming: the drawn camera is painted on the page's main thread, so a busy machine can
  // hold a frame back for a moment; a renegotiation would be several seconds
  expect(gapAda.frames).toBeGreaterThan(30);
  expect(gapKai.frames).toBeGreaterThan(30);
  expect(gapAda.gap, "no gap at Ada longer than a moment").toBeLessThan(3000);
  expect(gapKai.gap, "no gap at Kai longer than a moment").toBeLessThan(3000);
  await ada.page.screenshot({ path: `${SHOTS}huddle-03_on-the-grid-night.png` });
  await kai.page.screenshot({ path: `${SHOTS}huddle-04_channel-after-taking-it-day.png` });

  // leave: the card in the channel ends, with recordings and Replay
  await kai.page.locator(".huddle-pip .huddle-leave").click();
  await ada.page.locator(".huddle-pip .huddle-leave").click();
  await expect(kaiCard).toHaveAttribute("data-huddle-state", "ended", { timeout: 20_000 });
  await expect(kaiCard.locator("[data-huddle-replay]")).toBeVisible();
  await expect(kaiCard.locator("[data-huddle-recordings]")).toBeVisible({ timeout: 30_000 });
  await expect(kaiCard.locator(".hcard-excerpt")).toContainText("2 mm fillet");
  await kaiCard.scrollIntoViewIfNeeded();
  await kaiCard.screenshot({ path: `${SHOTS}huddle-05_card-ended-day.png` });
  await toChannel(ada.page, general.id);
  const adaCard = ada.page.locator(`.hcard[data-huddle="${huddleId}"]`);
  await expect(adaCard).toHaveAttribute("data-huddle-state", "ended", { timeout: 10_000 });
  await adaCard.scrollIntoViewIfNeeded();
  await adaCard.screenshot({ path: `${SHOTS}huddle-06_card-ended-night.png` });

  // the Huddles tab lists the session; its page has the recordings and the transcript
  await kaiCard.locator("[data-huddle-replay]").click();
  await expect(kai.page.locator("[data-htab-detail]")).toBeVisible({ timeout: 10_000 });
  await expect(kai.page.locator("[data-htab-recording]").first()).toBeVisible({ timeout: 15_000 });
  await expect(kai.page.locator(".htab-transcript")).toContainText("2 mm fillet");
  await kai.page.screenshot({ path: `${SHOTS}huddle-07_session-day.png` });
  await kai.page.evaluate(() => (window.location.hash = "#/chat/huddles"));
  await expect(kai.page.locator("[data-htab-session]").first()).toBeVisible({ timeout: 10_000 });
  await ada.page.evaluate(() => (window.location.hash = "#/chat/huddles"));
  await expect(ada.page.locator("[data-htab-session]").first()).toBeVisible({ timeout: 10_000 });
  await ada.page.screenshot({ path: `${SHOTS}huddle-08_huddles-tab-night.png` });

  await ada.context.close();
  await kai.context.close();
});

test("a private channel's huddle: a third person can't see it, join it, or read it, and on a grid sees only whose it is", async ({ browser }) => {
  test.setTimeout(180_000);
  const ada = await person(browser, "Ada Lovelace", "ada@normal.dev", "dark");
  const kai = await person(browser, "Kai Moreno", "kai@normal.dev", "dark");
  const noa = await person(browser, "Noa Berg", "noa@normal.dev", "light");
  const made = await ada.context.request.post(`${CLIENT}/api/chat/channels`, { data: { kind: "private", name: `bracket-team-${Date.now().toString(36)}`, members: [kai.id], request_id: `p${Date.now()}` } });
  const priv = ((await made.json()) as { channel: { id: string } }).channel;
  await toChannel(ada.page, priv.id);
  await ada.page.locator(`[data-huddle-start="${priv.id}"]`).click();
  const dock = ada.page.locator("[data-huddle-dock]");
  await expect(dock).toBeVisible({ timeout: 15_000 });
  const huddleId = (await dock.getAttribute("data-huddle-dock"))!;

  // Noa: not in her list, not by its address, not by the routes, not on the socket
  expect(Object.keys((await store(noa.page)).channels)).not.toContain(priv.id);
  expect((await noa.context.request.post(`${CLIENT}/api/chat/channels/${priv.id}/huddle`, { data: {} })).status()).toBe(404);
  expect((await noa.context.request.get(`${CLIENT}/api/huddles/${huddleId}?board=chat`)).status()).toBe(404);
  const live = (await (await noa.context.request.get(`${CLIENT}/api/huddles/live`)).json()) as { live: Array<{ huddle: { id: string } }> };
  expect(live.live.map((l) => l.huddle.id)).not.toContain(huddleId);
  const code = await noa.page.evaluate(
    (id) =>
      new Promise<number>((done) => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/huddle/chat/${id}?send=1`);
        ws.onclose = (e) => done(e.code);
      }),
    huddleId,
  );
  expect(code, "the socket refuses her").toBe(4403);
  await noa.page.evaluate((c) => (window.location.hash = `#/chat/chat/${c}`), priv.id);
  await expect(noa.page.locator(".chat-tab-empty h2")).toHaveText("This conversation isn't here", { timeout: 10_000 });

  // taken to a grid Noa can see: she sees a locked card that says whose it is, and nothing about who's in it
  const board = ((await (await ada.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Open floor ${Date.now().toString(36)}` } })).json()) as { id: string }).id;
  await ada.context.request.post(`${CLIENT}/api/boards/${board}/tools/add_section`, { data: { name: "Floor" } });
  const outline = (await (await ada.context.request.get(`${CLIENT}/api/boards/${board}/outline`)).json()) as { sections: Array<{ id: string }> };
  const placed = await ada.context.request.post(`${CLIENT}/api/huddles/${huddleId}/place`, { data: { board, section: outline.sections[0].id, request_id: "e2e-place" } });
  expect(placed.ok(), await placed.text()).toBe(true);
  await noa.page.goto(`/?fakecam&board=${board}&focus=${huddleId}`);
  await waitLive(noa.page);
  const card = noa.page.locator(`[data-obj-id="${huddleId}"]`);
  await expect(card.locator("[data-huddle-locked]")).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Ada Lovelace's huddle");
  await expect(card).not.toContainText("Kai");
  await expect(card.getByRole("button", { name: /Join|Start the huddle|Listen in/ })).toHaveCount(0);
  await settle(noa.page, 800);
  await noa.page.screenshot({ path: `${SHOTS}huddle-09_locked-on-a-grid-day.png` });

  await ada.page.locator(".huddle-pip .huddle-leave").click();
  for (const x of [ada, kai, noa]) await x.context.close();
});

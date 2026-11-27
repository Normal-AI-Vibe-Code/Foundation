/**
 * A huddle's devices in a real browser (2026-11-26), on Chromium's fake microphone and camera.
 *
 * Before this, a huddle asked for the camera and the microphone in one request: on a computer
 * with a microphone and no camera the browser failed it ("device not found") before any
 * permission prompt, and the call never started. Now:
 *  - Ada has a microphone and no camera: she joins, Kai hears her (a live audio track arrives),
 *    and her device chip says the camera is missing (warn, not bad);
 *  - she picks another microphone in the chip: it replaces the old one for Kai without a new
 *    connection, and the old track is stopped;
 *  - Noa's microphone is blocked: she still joins (muted), the chip opens by itself with
 *    "Allow the microphone", and pressing it asks the browser again.
 * Evidence: docs/evidence/2026-11-26_huddle-devices/ (night for Ada, day for Noa).
 */

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-26_huddle-devices";

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
});
test.describe.configure({ mode: "serial" });

type Dev = { state: string; label?: string; deviceId?: string };
type View = { status: string; mic: Dev; cam: Dev; muted: boolean; camOff: boolean; local: MediaStream | null; peers: Array<{ name: string; stream: MediaStream | null }> };

/** what the joined call says, read in the page */
const call = (p: Page) =>
  p.evaluate(() => {
    const v = (window as unknown as { __huddle: () => View | null }).__huddle();
    if (!v) return null;
    return {
      status: v.status,
      mic: v.mic,
      cam: v.cam,
      muted: v.muted,
      camOff: v.camOff,
      local: (v.local?.getTracks() ?? []).map((t) => `${t.kind}:${t.readyState}`),
      peers: v.peers.map((x) => ({ name: x.name, audio: (x.stream?.getAudioTracks() ?? []).filter((t) => t.readyState === "live").length })),
    };
  });

/** a computer without a camera; or one whose microphone is blocked (until `__allowMic()`) */
async function devices(context: BrowserContext, kind: "no-camera" | "mic-blocked" | "all") {
  await context.addInitScript((k) => {
    const md = navigator.mediaDevices;
    const w = window as unknown as { __streams: MediaStream[]; __allowMic(): void; __asks: number };
    w.__streams = [];
    w.__asks = 0;
    let micBlocked = k === "mic-blocked";
    w.__allowMic = () => (micBlocked = false);
    const enumerate = md.enumerateDevices.bind(md);
    const gum = md.getUserMedia.bind(md);
    md.enumerateDevices = async () => (await enumerate()).filter((d) => !(k === "no-camera" && d.kind === "videoinput"));
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      w.__asks++;
      if (k === "no-camera" && c?.video) throw new DOMException("Requested device not found", "NotFoundError");
      if (micBlocked && c?.audio) throw new DOMException("Permission denied", "NotAllowedError");
      const s = await gum(c);
      w.__streams.push(s);
      return s;
    };
  }, kind);
}

async function signIn(browser: Browser, name: string, email: string, scheme: "dark" | "light", kind: "no-camera" | "mic-blocked" | "all") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  await devices(context, kind);
  // a blocked microphone beside a camera that's allowed: the Permissions API says so, as a real browser would
  if (kind === "mic-blocked") await context.grantPermissions(["camera"], { origin: CLIENT });
  return { context, page: await context.newPage() };
}

let board = "";
let huddle = "";
let ada: { context: BrowserContext; page: Page };
let kai: { context: BrowserContext; page: Page };
let noa: { context: BrowserContext; page: Page };

async function open(p: Page) {
  await p.goto(`/?rafshim&board=${board}`);
  await waitLive(p);
  await p.evaluate((i) => (window as unknown as { __foundation: { setState(x: object): void } }).__foundation.setState({ snapRequest: { kind: "object", id: i, nonce: Math.random() } }), huddle);
  await settle(p, 1200);
}
const card = (p: Page) => p.locator(`[data-obj-id="${huddle}"]`);
const joinButton = (p: Page) => card(p).getByRole("button", { name: /^(Join|Start the huddle)$/ });

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  ada = await signIn(browser, "Ada Test", "ada@normal.dev", "dark", "no-camera");
  const made = await ada.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Huddle devices ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  const opened = await ada.context.request.post(`${CLIENT}/api/boards/${board}/tools/open_huddle`, { data: { name: "Devices" } });
  const body = (await opened.json()) as { id?: string; result?: { id: string } };
  huddle = body.id ?? body.result!.id;
  kai = await signIn(browser, "Kai Test", "kai@normal.dev", "dark", "all");
  noa = await signIn(browser, "Noa Test", "noa@normal.dev", "light", "mic-blocked");
  await open(ada.page);
  await open(kai.page);
});

test.afterAll(async () => {
  for (const x of [ada, kai, noa]) await x?.context.close();
});

test("a microphone and no camera: the call starts, and is heard", async () => {
  await joinButton(ada.page).click();
  await expect.poll(async () => (await call(ada.page))?.status, { timeout: 15_000 }).toBe("live");
  const a = (await call(ada.page))!;
  expect(a.mic.state).toBe("on");
  expect(a.cam.state).toBe("none");
  expect(a.camOff).toBe(true);
  expect(a.muted).toBe(false);
  expect(a.local).toEqual(["audio:live"]);
  await expect(card(ada.page).locator("[data-huddle-devices]")).toHaveAttribute("data-huddle-devices", "warn");

  await joinButton(kai.page).click();
  // Kai hears Ada: a live audio track from her arrives
  await expect.poll(async () => (await call(kai.page))?.peers.find((p) => p.name === "Ada Test")?.audio ?? 0, { timeout: 20_000 }).toBe(1);
  await expect(card(kai.page).locator("[data-huddle-devices]")).toHaveAttribute("data-huddle-devices", "ok");

  await card(ada.page).locator("[data-huddle-devices]").click();
  const pop = ada.page.getByRole("dialog", { name: "Devices" });
  await expect(pop).toBeVisible();
  await expect(pop.locator('[data-device="mic"]')).toHaveAttribute("data-state", "on");
  await expect(pop.locator('[data-device="cam"]')).toHaveAttribute("data-state", "none");
  await settle(ada.page, 500);
  await ada.page.screenshot({ path: `${SHOTS}/01-no-camera-night.png` });
});

test("another microphone replaces the old one for everyone", async () => {
  const pop = ada.page.getByRole("dialog", { name: "Devices" });
  const select = pop.locator('[data-device="mic"] select');
  const options = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  const before = (await call(ada.page))!.mic.deviceId;
  const other = options.find((v) => v !== before && v !== "default" && v !== "communications");
  test.skip(!other, "this Chromium offers one fake microphone");
  await select.selectOption(other!);
  await expect.poll(async () => (await call(ada.page))!.mic.deviceId, { timeout: 10_000 }).toBe(other);
  const a = (await call(ada.page))!;
  expect(a.local).toEqual(["audio:live"]);
  // the old track was stopped; only the new one is live
  const live = await ada.page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);
  expect(live).toBe(1);
  // Kai still hears her, on the same connection
  await settle(kai.page, 800);
  expect((await call(kai.page))!.peers.find((p) => p.name === "Ada Test")?.audio).toBe(1);
});

test("a blocked microphone: joined and muted, the chip asks for it", async () => {
  await open(noa.page);
  await joinButton(noa.page).click();
  await expect.poll(async () => (await call(noa.page))?.status, { timeout: 15_000 }).toBe("live");
  const n = (await call(noa.page))!;
  expect(n.mic.state).toBe("blocked");
  expect(n.muted).toBe(true);
  expect(n.cam.state).toBe("on");
  const chip = card(noa.page).locator("[data-huddle-devices]");
  await expect(chip).toHaveAttribute("data-huddle-devices", "bad");
  // it opened by itself, with the way to allow it
  const pop = noa.page.getByRole("dialog", { name: "Devices" });
  await expect(pop).toBeVisible();
  const allow = pop.locator('[data-device-retry="mic"]');
  await expect(allow).toHaveText("Allow the microphone");
  await settle(noa.page, 500);
  await noa.page.screenshot({ path: `${SHOTS}/02-mic-blocked-day.png` });

  await noa.page.evaluate(() => (window as unknown as { __allowMic(): void }).__allowMic());
  await allow.click();
  await expect.poll(async () => (await call(noa.page))!.mic.state, { timeout: 10_000 }).toBe("on");
  expect((await call(noa.page))!.muted).toBe(false);
  await expect(chip).toHaveAttribute("data-huddle-devices", "ok");
  // and Ada hears Noa now
  await expect.poll(async () => (await call(ada.page))?.peers.find((p) => p.name === "Noa Test")?.audio ?? 0, { timeout: 20_000 }).toBe(1);
  await noa.page.screenshot({ path: `${SHOTS}/03-mic-allowed-day.png` });
});

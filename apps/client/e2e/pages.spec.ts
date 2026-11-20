/**
 * The company's apps on HyperForm, on Today and in Foundation (2026-11-19).
 *
 * Today lists HyperForm, PartForm, DeployForm and FactoryForm where they are hosted; a row opens one in your own
 * browser and ⤢ opens it in Foundation, where it takes over a new section of the grid as a page of the built-in
 * browser (the real one on the server's computer). Near, the page is live; far, the picture last kept of it stands
 * in. An agent with the person's leave reads it. Someone who isn't an admin sees the picture and ↗.
 *
 * DeployForm here is a stand-in page served by the checks (slack-standin.mjs): the real one is never opened.
 * Needs Edge or Chrome on this computer (the server drives it); the live part is skipped where there is none.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-19_hyperform";
const STANDIN = `http://127.0.0.1:${process.env.E2E_SLACK_PORT ?? 4440}/e2e/page.html`;

type Panel = { id: string; name: string; panel: string; url?: string; via?: string; seenAt?: number; sectionId: string };
type Store = { getState(): { panels: Record<string, Panel>; sections: Record<string, { id: string; name: string; host?: string }> } };
const state = (p: Page) => p.evaluate(() => (window as unknown as { __foundation: Store }).__foundation.getState());
const toToday = (p: Page) => p.evaluate(() => void (window.location.hash = "#/today"));

let admin: Page;
let ctx: BrowserContext;
// Kai signs in before the browser starts: sign-in by email alone is refused while it runs (it is a shell on this computer)
let kai: { context: BrowserContext; page: Page };
let hasBrowser = true;

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Admin", "admin@normal.dev");
  admin = a.page;
  ctx = a.context;
  await admin.evaluate(() => {
    localStorage.setItem("foundation-wheel", "zoom");
    localStorage.setItem("foundation-night", "0");
  });
  await admin.reload();
  await waitLive(admin);
  kai = await person(browser, "Kai", "kai@normal.dev");
  // is there a browser for the server to drive? (asking starts nothing)
  const asked = await ctx.request.post("/api/host-browser", { data: {} });
  hasBrowser = asked.ok();
});
test.afterAll(async () => {
  await kai?.context.close();
  await ctx?.close();
});

test("Today lists the four apps on HyperForm where they are hosted, each with a press that opens it in Foundation", async () => {
  await toToday(admin);
  const panel = admin.locator(".today-state");
  await expect(panel.locator(".today-app", { hasText: "HyperForm" })).toBeVisible();
  const href = (name: string) => panel.locator("a.today-app", { hasText: name }).getAttribute("href");
  expect(await href("HyperForm")).toBe("https://dock.apps.normallab.co/");
  expect(await href("PartForm")).toBe("https://partform.apps.normallab.co/");
  expect(await href("FactoryForm")).toBe("https://factory-form-factoryform.apps.normallab.co/");
  expect(await href("DeployForm")).toBe(STANDIN); // this run's stand-in (DEPLOYFORM_URL)
  // the first four, in the order people reach for them
  expect((await panel.locator(".today-app .today-row-title").allInnerTexts()).slice(0, 4)).toEqual(["HyperForm", "PartForm", "DeployForm", "FactoryForm"]);
  for (const id of ["hyperform", "partform", "deployform", "factoryform"]) await expect(panel.locator(`[data-app-open="${id}"]`)).toBeVisible();
  // an app nobody has given an address has no such press
  await expect(panel.locator(".today-app[data-unlinked]", { hasText: "FleetForm" })).toBeVisible();
  await expect(panel.locator('[data-app-open="fleetform"]')).toHaveCount(0);
  await settle(admin, 800);
  await admin.screenshot({ path: `${SHOTS}/01-today-apps-day.png` });
});

test("⤢ opens the app in Foundation: a new section it fills, live in the real browser; in use, its bar; an agent reads it", async () => {
  test.skip(!hasBrowser, "no Edge, Chrome or Chromium on this computer for the server to drive");
  test.setTimeout(150_000);
  await toToday(admin);
  const before = Object.keys((await state(admin)).sections).length;
  await admin.locator('[data-app-open="deployform"]').click();

  // on the grid, in a section of its own that it fills
  await expect.poll(() => admin.evaluate(() => window.location.hash)).toBe("#/board");
  const st = await state(admin);
  const card = Object.values(st.panels).find((p) => p.url === STANDIN)!;
  expect(card).toBeTruthy();
  expect(card.via).toBe("browser");
  expect(card.panel).toBe("app");
  expect(Object.keys(st.sections).length).toBe(before + 1);
  expect(st.sections[card.sectionId].host).toBe(card.id);
  expect(st.sections[card.sectionId].name).toBe("DeployForm");

  // near: the live page, drawn by the server's browser (no frame is made for it)
  const page = admin.locator(`[data-host-page="${card.id}"]`);
  await expect(page).toHaveAttribute("data-host-page-state", "live", { timeout: 60_000 });
  await expect(page.locator("canvas[data-browser-painted]")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  // the page is laid out at the card's own size, whatever the zoom: the canvas has the card's shape
  const off = () => page.locator("canvas").evaluate((c: HTMLCanvasElement) => Math.abs(c.width / c.height - (c.parentElement as HTMLElement).offsetWidth / (c.parentElement as HTMLElement).offsetHeight));
  await expect.poll(off, { timeout: 10_000 }).toBeLessThan(0.02);
  // and at its own width in CSS pixels (one image pixel each at this density), not the browser's default window
  expect(await page.locator("canvas").evaluate((c: HTMLCanvasElement) => Math.abs(c.width - (c.parentElement as HTMLElement).offsetWidth))).toBeLessThan(3);
  await settle(admin, 1200);
  await admin.screenshot({ path: `${SHOTS}/02-deployform-live-day.png` });

  // the picture of it is kept, and the board says when
  await expect.poll(async () => (await state(admin)).panels[card.id]?.seenAt ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  const pic = await ctx.request.get(`/api/boards/company/pages/${card.id}/picture`);
  expect(pic.ok()).toBe(true);
  expect(pic.headers()["content-type"]).toBe("image/jpeg");
  expect((await pic.body()).length).toBeGreaterThan(2000);

  // a plain click doesn't use the page; ⌘/Ctrl-click does: the bar, the address, and the keys
  await expect(page.locator(".host-page-bar")).toHaveCount(0);
  const box = (await page.boundingBox())!;
  await admin.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await settle(admin, 300);
  await expect(page.locator(".host-page-bar")).toHaveCount(0);
  await admin.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await admin.keyboard.down("ControlOrMeta");
  await admin.mouse.down();
  await admin.mouse.up();
  await admin.keyboard.up("ControlOrMeta");
  await expect(page.locator(".host-page-bar")).toBeVisible();
  await expect(page.locator("[data-host-page-addr]")).toHaveValue(STANDIN);

  // type into the page's field: click it (found through an agent's read, which needs the person's leave)
  const tool = async (name: string, input: object = {}) => (await (await ctx.request.post(`/api/boards/company/tools/${name}`, { data: input })).json()) as { result: unknown };
  expect(JSON.stringify((await tool("browser_read")).result)).toContain("isn't open to agents");
  await page.locator("[data-host-page-agents]").click();
  await expect(page.locator("[data-host-page-agents]")).toHaveAttribute("aria-pressed", "true");
  const tabs = (await tool("browser_tabs")).result as { tabs: Array<{ id: string; card?: string; title: string }> };
  const mine = tabs.tabs.find((t) => t.card === card.id)!;
  expect(mine?.title).toBe("DeployForm (stand-in)");
  await tool("browser_tabs", { select: mine.id });
  const read = JSON.stringify((await tool("browser_read")).result);
  expect(read).toContain("Three customers are being deployed");
  expect(read).toContain("Kapaa Works");
  const ref = /\[(ref_\d+)\][^[]*Find a customer/.exec(read)?.[1] ?? /Find a customer[^[]*\[(ref_\d+)\]/.exec(read)?.[1];
  expect(ref, read.slice(0, 600)).toBeTruthy();
  await tool("browser_type", { ref, text: "Hilo" });
  await expect.poll(async () => JSON.stringify((await tool("browser_read")).result), { timeout: 10_000 }).toContain("Finding: Hilo");
  await expect(page.locator(".btool-did")).toBeVisible();
  await settle(admin, 800);
  await admin.screenshot({ path: `${SHOTS}/03-deployform-in-use-agent.png` });
  await page.locator("[data-host-page-agents]").click();
  await admin.keyboard.press("Escape");
  await admin.keyboard.press("Escape");

  // pressing ⤢ again goes to the section it already has, and makes no second one
  await toToday(admin);
  await admin.locator('[data-app-open="deployform"]').click();
  await expect.poll(() => admin.evaluate(() => window.location.hash)).toBe("#/board");
  expect(Object.values((await state(admin)).panels).filter((p) => p.url === STANDIN).length).toBe(1);
  expect(Object.keys((await state(admin)).sections).length).toBe(before + 1);
});

test("far away the page is its picture, not a running page; near again it is live", async () => {
  test.skip(!hasBrowser, "no Edge, Chrome or Chromium on this computer for the server to drive");
  test.setTimeout(120_000);
  const card = Object.values((await state(admin)).panels).find((p) => p.url === STANDIN)!;
  const page = admin.locator(`[data-host-page="${card.id}"]`);
  await expect(page).toHaveAttribute("data-host-page-state", "live", { timeout: 60_000 });
  // zoom out until it is too small to read
  await admin.mouse.move(720, 450);
  for (let i = 0; i < 14 && (await page.getAttribute("data-host-page-state")) === "live"; i++) {
    await admin.mouse.wheel(0, 240);
    await settle(admin, 350);
  }
  await expect(page).toHaveAttribute("data-host-page-state", "picture");
  const img = page.locator("[data-host-page-picture]");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);
  await expect(page.locator(".host-page-seen")).toContainText("DeployForm · seen");
  await expect(page.locator("canvas")).toBeHidden();
  await settle(admin, 800);
  await admin.screenshot({ path: `${SHOTS}/04-deployform-far-picture.png` });

  // near again: live, with no press (this person started the browser on this visit)
  await admin.keyboard.press("Escape");
  await admin.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), card.sectionId);
  await expect(page).toHaveAttribute("data-host-page-state", "live", { timeout: 30_000 });
});

test("someone who isn't an admin sees the picture and a way out, and no live page; night", async () => {
  test.skip(!hasBrowser, "no Edge, Chrome or Chromium on this computer for the server to drive");
  {
    await expect.poll(async () => Object.values((await state(kai.page)).panels).some((p) => p.url === STANDIN && p.seenAt)).toBe(true);
    const card = Object.values((await state(kai.page)).panels).find((p) => p.url === STANDIN)!;
    await kai.page.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), card.sectionId);
    const page = kai.page.locator(`[data-host-page="${card.id}"]`);
    await expect(page).toHaveAttribute("data-host-page-state", "picture");
    await expect(page.locator("[data-host-page-picture]")).toBeVisible();
    await expect(page.getByText("Open in your browser")).toBeVisible();
    await expect(page.locator("[data-host-page-live]")).toHaveCount(0);
    await expect(page.locator("canvas")).toHaveCount(0);
    // and the server refuses them the browser itself
    expect((await kai.context.request.post("/api/host-browser", { data: { board: "company", card: card.id, url: STANDIN } })).status()).toBe(403);
    await settle(kai.page, 900);
    await kai.page.screenshot({ path: `${SHOTS}/05-member-picture-night.png` });
  }
});

test("#/design shows the app rows as Today has them", async () => {
  await admin.goto("/#/design");
  const apps = admin.locator("[data-design-apps]");
  await apps.scrollIntoViewIfNeeded();
  await expect(apps.locator(".today-app-pair")).toHaveCount(2);
  await expect(apps.locator(".today-app[data-unlinked]")).toHaveCount(1);
  await apps.locator(".today-app-pair").first().hover();
  await apps.screenshot({ path: `${SHOTS}/06-design-app-rows.png` });
});

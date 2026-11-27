/**
 * Today in a real browser: signing in lands on Today (not the board), the
 * Shiba's room draws, what's asked of you shows and opens its place on the
 * board, a goal added on the page sticks, the apps are in reach, and Boards
 * and back work. Asked what's first, the Shiba (the script runtime here)
 * says it and points at it on the page. The company's goals come first: a
 * member sets one on the page, the person who carries it has it in focus, and
 * the server refuses a viewer who tries to set one. What was said to you is
 * listed under Notifications, the bell right beside Today: a DM opens at the
 * message, a note that tags you frames its card on the grid, and an admin
 * outside the DM never has it on theirs.
 */
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CLIENT, settle } from "./helpers";

test("Today is home, inside Foundation: the side menu, the Shiba, todos and apps in its panel, and the way to a grid and back", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Tess Today", email: "tess@normal.dev" } });
  expect(res.ok()).toBeTruthy();
  // something asked of Tess on the company board
  const ask = await context.request.post(`${CLIENT}/api/asks`, { data: { board: "company", assignee: "tess@normal.dev", prompt: "Upload the e2e stator STEP", kind: "cad_upload" } });
  expect(ask.ok()).toBeTruthy();
  const page = await context.newPage();

  // a first run (nothing remembered on this device): Today, with the side menu open and the top bar there
  await page.goto("/?rafshim");
  await expect(page.locator(".today")).toBeVisible();
  await expect(page.locator(".top-bar")).toBeVisible();
  await expect(page.locator(".side-pane")).toBeVisible();
  // Today is the top bar's (in its top-left corner, since 2026-11-17), not a row of the side menu
  await expect(page.locator('.side-pane [data-place="today"]')).toHaveCount(0);
  await expect(page.locator(".top-bar .top-left [data-top-today]")).toHaveClass(/is-on/);
  // what's waiting (the ask above) is counted right beside the word
  await expect(page.locator(".top-bar [data-top-today] [data-today-badge]")).toBeVisible();
  // (Chats joined the side menu with ChatForm's second round, 4fc3e46)
  await expect(page.locator(".side-pane .pane-seg-btn")).toHaveText(["Recent", "All Grids", "Chats"]);
  await expect(page.locator(".today-line")).toContainText("Tess");
  await expect(page.locator(".shiba-room")).toBeVisible();
  // the room is the whole window, behind every panel; the side menu and the top bar are clear over it, in white
  const pane = (await page.locator(".side-pane").boundingBox())!;
  const room = (await page.locator(".today").boundingBox())!;
  expect(room.x).toBe(0);
  expect(room.y).toBe(0);
  expect(room.width).toBeGreaterThan(pane.width + 600);
  const chrome = await page.evaluate(() => {
    const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
    const ink = getComputedStyle(document.querySelector(".side-pane .pane-label")!).color.match(/\d+/g)!.map(Number);
    return { pane: bg(".side-pane"), ink };
  });
  expect(chrome.pane).toMatch(/rgba\(.*, 0\)|transparent/);
  expect(Math.min(...chrome.ink.slice(0, 3))).toBeGreaterThan(215);

  // the Today panel: no card, white type over the room
  const panel = page.locator(".today-state");
  await expect(panel.locator(".today-panel-title")).toHaveText("Today");
  const look = await panel.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el.querySelector(".today-panel-title")!).color }));
  expect(look.bg).toBe("rgba(0, 0, 0, 0)");
  expect(look.ink).toBe("rgb(255, 255, 255)");

  // the ask, among the todos, linking to its card on the board
  const row = page.locator(".today-row", { hasText: "Upload the e2e stator STEP" });
  await expect(row).toBeVisible();
  expect(await row.getAttribute("href")).toMatch(/^\/\?board=company&focus=/);

  // the company's apps, in the panel: the four on HyperForm are linked where they are hosted, FleetForm isn't linked yet
  for (const name of ["HyperForm", "PartForm", "DeployForm", "FactoryForm", "Vision"]) await expect(panel.locator(".today-app", { hasText: name })).toBeVisible();
  expect(await panel.locator("a.today-app", { hasText: "HyperForm" }).getAttribute("href")).toBe("https://dock.apps.normallab.co/");
  expect(await panel.locator("a.today-app", { hasText: "PartForm" }).getAttribute("href")).toBe("https://partform.apps.normallab.co/");
  expect(await panel.locator("a.today-app", { hasText: "FactoryForm" }).getAttribute("href")).toBe("https://factory-form-factoryform.apps.normallab.co/");
  await expect(panel.locator(".today-app[data-unlinked]", { hasText: "FleetForm" })).toBeVisible();

  // a todo added here is kept
  await page.getByLabel("Add a todo").fill("Ship Today to the team");
  await page.getByLabel("Add a todo").press("Enter");
  await expect(page.locator(".today-goal", { hasText: "Ship Today to the team" })).toBeVisible();
  await page.reload();
  const goal = page.locator(".today-goal", { hasText: "Ship Today to the team" });
  await expect(goal).toBeVisible();
  await goal.getByRole("button").click();
  await expect(goal).toHaveAttribute("data-done", "true");
  await settle(page);
  await page.screenshot({ path: "../../docs/evidence/2026-11-15_one-interface/today/e2e-today.png" });

  // the Shiba (the script runtime here: it reads Today, points, and says what's first):
  // its words are about the ask, and the ask's row lights up beside them
  await page.getByLabel("Ask the Shiba").fill("What's first today?");
  await page.getByLabel("Ask the Shiba").press("Enter");
  await expect(page.locator(".today-line")).toContainText("Upload the e2e stator STEP", { timeout: 15_000 });
  await expect(row).toHaveAttribute("data-pointed", "true");

  // to a grid from the side menu, and back
  await page.locator('.side-pane [data-grid-row="company"] .space-open').click();
  await expect(page).toHaveURL(/#\/board$/);
  await expect(page.locator(".today")).toHaveCount(0);
  await expect(page.locator(".side-pane")).toBeVisible();
  await page.locator(".top-bar [data-top-today]").click();
  await expect(page.locator(".today")).toBeVisible();

  // a link into the board goes straight there, not to Today
  await page.goto("/?board=company");
  await expect(page.locator(".today")).toHaveCount(0);
  await context.close();
});

test("the company's goals open Today: set on the page by a member, in focus for who carries them, refused for a viewer", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  expect((await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Gale Goals", email: "gale@normal.dev" } })).ok()).toBeTruthy();
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const page = await context.newPage();
  await page.goto("/?rafshim#/today");
  const company = page.getByRole("region", { name: "Company goals" });
  await expect(company).toBeVisible();

  // a member sets one on the page; it's the first group, above what wants them
  await page.getByLabel("Set a company goal").fill("Certify the rim drive for flight");
  await page.getByLabel("Set a company goal").press("Enter");
  const row = company.locator(".today-goal", { hasText: "Certify the rim drive for flight" });
  await expect(row).toBeVisible();
  expect(await page.locator(".today-state .today-group").first().getAttribute("aria-label")).toBe("Company goals");
  const { company: c } = (await (await context.request.get(`${CLIENT}/api/today`)).json()) as { company: { goals: Array<{ id: string; title: string }> } };
  const id = c.goals.find((g) => g.title === "Certify the rim drive for flight")!.id;

  // handed to someone, it's in their focus (and says who carries it on everyone's Today)
  expect((await context.request.post(`${CLIENT}/api/today/company-goals`, { data: { id, owner: "Gale", progress: 0.3, request_id: "e2e-own" } })).ok()).toBeTruthy();
  await page.reload();
  await expect(row).toContainText("Carried by Gale");
  await expect(page.locator(".today-row[data-kind=goal]", { hasText: "Certify the rim drive for flight" })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: "../../docs/evidence/2026-11-14_company-goals/01_today-company-goals_day.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(row).toBeVisible();
  await settle(page);
  await page.screenshot({ path: "../../docs/evidence/2026-11-14_company-goals/02_today-company-goals_night.png" });

  // a viewer of the company board reads them, can't set them (no box, and the server says no)
  const vee = await browser.newContext();
  expect((await vee.request.post(`${CLIENT}/auth/dev`, { data: { name: "Vee Viewer", email: "vee@normal.dev" } })).ok()).toBeTruthy();
  const veeId = ((await (await vee.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } }).user.id;
  const admin = await browser.newContext();
  expect((await admin.request.post(`${CLIENT}/auth/dev`, { data: { name: "Admin", email: "admin@normal.dev" } })).ok()).toBeTruthy();
  expect((await admin.request.post(`${CLIENT}/api/boards/company/people`, { data: { userId: veeId, role: "viewer" } })).ok()).toBeTruthy();
  const veeToday = (await (await vee.request.get(`${CLIENT}/api/today`)).json()) as { company: { canSet: boolean; goals: Array<{ id: string }> } };
  expect(veeToday.company.canSet).toBe(false);
  expect(veeToday.company.goals.map((g) => g.id)).toContain(id);
  const refused = await vee.request.post(`${CLIENT}/api/today/company-goals`, { data: { id, status: "done" } });
  expect(refused.status()).toBe(403);
  const veePage = await vee.newPage();
  await veePage.goto("/?rafshim#/today");
  await expect(veePage.getByRole("region", { name: "Company goals" }).locator(".today-goal", { hasText: "Certify the rim drive for flight" })).toBeVisible();
  await expect(veePage.getByLabel("Set a company goal")).toHaveCount(0);
  await expect(veePage.getByRole("button", { name: "Mark “Certify the rim drive for flight” done" })).toBeDisabled();
  for (const c of [vee, admin, context]) await c.close();
});

test("Today lists what was said to you, beside the bell: a DM opens at the message, a tag on a grid frames its note; day and night", async ({ browser }) => {
  test.setTimeout(150_000);
  const SHOTS = "../../docs/evidence/2026-11-26_today-notices";
  mkdirSync(SHOTS, { recursive: true });
  const stamp = Date.now().toString(36);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  expect((await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Nell Notice", email: "nell@normal.dev" } })).ok()).toBeTruthy();
  const nell = ((await (await context.request.get(`${CLIENT}/api/me`)).json()) as { user: { id: string } }).user.id;
  const kai = await browser.newContext();
  expect((await kai.request.post(`${CLIENT}/auth/dev`, { data: { name: "Kai Moreno", email: "kai@normal.dev" } })).ok()).toBeTruthy();
  const outsider = await browser.newContext();
  expect((await outsider.request.post(`${CLIENT}/auth/dev`, { data: { name: "Admin", email: "admin@normal.dev" } })).ok()).toBeTruthy();

  // Kai writes to Nell directly, and tags her in a note in a section of the company grid
  const made = await kai.request.post(`${CLIENT}/api/chat/channels`, { data: { kind: "dm", members: [nell], request_id: `dm-${stamp}` } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const dm = ((await made.json()) as { channel: { id: string } }).channel.id;
  const sent = await kai.request.post(`${CLIENT}/api/chat/channels/${dm}/messages`, { data: { text: `The stator quote ${stamp} is in. Shall I confirm it?`, request_id: `m-${stamp}` } });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const msg = ((await sent.json()) as { message: { id: string; seq: number } }).message;
  const section = `Stator ${stamp}`;
  const noted = await kai.request.post(`${CLIENT}/api/boards/company/tools/add_note`, { data: { section, title: "Loads", markdown: `@Nell please sign off the loads ${stamp}` } });
  expect(noted.ok(), await noted.text()).toBeTruthy();
  const noteId = ((await noted.json()) as { result: { id: string } }).result.id;

  // an admin who isn't in the DM: neither its words nor its link on their Today
  const theirs = JSON.stringify(await (await outsider.request.get(`${CLIENT}/api/today`)).json());
  expect(theirs).not.toContain(dm);
  expect(theirs).not.toContain(`quote ${stamp}`);

  const page = await context.newPage();
  await page.goto("/?rafshim#/today");
  await expect(page.locator(".today")).toBeVisible();
  // the bell sits right against Today, in the corner
  await expect(page.locator(".top-bar [data-top-today-pair] [data-top-bell]")).toBeVisible({ timeout: 30_000 });
  const notices = page.locator("[data-today-notices]");
  const chatRow = notices.locator(`[data-today-notice="chat:${msg.id}"]`);
  const gridRow = notices.locator(`[data-today-notice="mention:company:${noteId}"]`);
  await expect(chatRow).toBeVisible({ timeout: 20_000 });
  await expect(chatRow).toContainText(`The stator quote ${stamp}`);
  await expect(chatRow).toHaveAttribute("data-unseen", "true");
  expect(await chatRow.getAttribute("href")).toBe(`#/chat/chat/${dm}/at/${msg.seq}`);
  await expect(gridRow).toBeVisible();
  await expect(gridRow).toContainText(`Tagged in a note in ${section}`);
  expect(await gridRow.getAttribute("href")).toBe(`/?board=company&focus=${noteId}`);
  // what was said to her is under Notifications, not again under Todos
  await expect(page.getByRole("region", { name: "Notifications" })).toBeVisible();
  await expect(page.locator(".today-group:not(.today-notices) .today-row", { hasText: `loads ${stamp}` })).toHaveCount(0);
  await settle(page, 900);
  await page.locator(".today-state").screenshot({ path: `${SHOTS}/01_today-notifications-night.png` });
  await page.emulateMedia({ colorScheme: "light" });
  await settle(page, 600);
  await page.locator(".today-state").screenshot({ path: `${SHOTS}/02_today-notifications-day.png` });
  await page.screenshot({ path: `${SHOTS}/03_today-whole-day.png` });
  await page.emulateMedia({ colorScheme: "dark" });

  // the DM's row: ChatForm, at that message, flashed; and it's seen (here and on the bell)
  await chatRow.click();
  await expect(page).toHaveURL(new RegExp(`#/chat/chat/${dm}/at/${msg.seq}$`));
  await expect(page.locator(`.chat-msg[data-message="${msg.id}"]`)).toBeVisible({ timeout: 15_000 });
  await settle(page, 400);
  await page.screenshot({ path: `${SHOTS}/04_opened-at-the-message-night.png` });
  await page.locator(".top-bar [data-top-today]").click();
  await expect(chatRow).toBeVisible();
  await expect(chatRow).not.toHaveAttribute("data-unseen", "true");

  // the tag's row: the company grid, its note framed, in its section, without loading the app again
  await page.evaluate(() => ((window as unknown as { __todayMark: number }).__todayMark = 1));
  await gridRow.click();
  await expect(page.locator(".today")).toHaveCount(0);
  await page.waitForFunction((id) => {
    const st = (window as unknown as { __foundation?: { getState(): { snapRequest: { kind: string; id?: string } | null; notes: Record<string, unknown> } } }).__foundation?.getState();
    return !!st && !!st.notes[id] && st.snapRequest?.kind === "object" && st.snapRequest.id === id;
  }, noteId, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __todayMark?: number }).__todayMark), "the same page: no reload").toBe(1);
  await settle(page, 1200);
  await page.screenshot({ path: `${SHOTS}/05_opened-at-the-note-night.png` });

  // #/design: the pair and the Notifications specimens, night and day (night is kept from a first launch, so a fresh
  // window for each)
  for (const scheme of ["dark", "light"] as const) {
    const look = await browser.newContext({ viewport: { width: 1440, height: 2000 }, colorScheme: scheme });
    expect((await look.request.post(`${CLIENT}/auth/dev`, { data: { name: "Nell Notice", email: "nell@normal.dev" } })).ok()).toBeTruthy();
    const page = await look.newPage();
    await page.goto("/#/design");
    const name = scheme === "dark" ? "night" : "day";
    const specimens = page.locator(".design-today-state [data-today-notices]");
    await expect(specimens).toHaveCount(2);
    await expect(specimens.first().locator("[data-today-notice]")).toHaveCount(4);
    await expect(specimens.first().locator("[data-today-notice][data-unseen]")).toHaveCount(2);
    await specimens.first().scrollIntoViewIfNeeded();
    await settle(page, 600);
    await page.locator(".design-today-state").screenshot({ path: `${SHOTS}/06_design-notifications-${name}.png` });
    const pair = page.locator("[data-design-today-pair]");
    await pair.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await page.locator(".design-today-menu").screenshot({ path: `${SHOTS}/07_design-pair-${name}.png` });
    await look.close();
  }

  for (const c of [context, kai, outsider]) await c.close();
});

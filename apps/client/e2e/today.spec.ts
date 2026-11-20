/**
 * Today in a real browser: signing in lands on Today (not the board), the
 * Shiba's room draws, what's asked of you shows and opens its place on the
 * board, a goal added on the page sticks, the apps are in reach, and Boards
 * and back work. Asked what's first, the Shiba (the script runtime here)
 * says it and points at it on the page. The company's goals come first: a
 * member sets one on the page, the person who carries it has it in focus, and
 * the server refuses a viewer who tries to set one.
 */
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
  await expect(page.locator(".side-pane .pane-seg-btn")).toHaveText(["Recent", "All Grids"]);
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

  // the company's apps, in the panel; HyperForm says it isn't linked
  for (const name of ["BomForm", "FactoryForm", "HyperForm", "Vision"]) await expect(panel.locator(".today-app", { hasText: name })).toBeVisible();
  await expect(panel.locator(".today-app[data-unlinked]", { hasText: "HyperForm" })).toBeVisible();

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

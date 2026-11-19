/**
 * ChatForm, the place (docs/chatform.md §3, §5): two people in two browsers, and a third who must not see
 * their direct message. Ada opens ChatForm from the top bar and posts in #general; Kai, still on the grid,
 * gets the badge first, then reads it live. A thread reply, a reaction, an edit (↑ in an empty composer)
 * and a picture each reach the other without a reload. A dm is invisible to Noa, in the list and by its
 * address. Ctrl+K inside ChatForm is the quick switcher. And `#/design`'s ChatForm chapter, day and night
 * and at a narrow window. Screenshots go to docs/evidence/2026-11-18_chatform/.
 *
 *   E2E_SERVER_PORT=15931 E2E_CLIENT_PORT=15951 E2E_SLACK_PORT=15941 E2E_MESHY_PORT=15945 E2E_T3_PORT=15995 npm run e2e -w @foundation/client -- chatform.spec.ts
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = fileURLToPath(new URL("../../../docs/evidence/2026-11-18_chatform/", import.meta.url));

type Store = { loaded: boolean; status: string; channels: Record<string, { id: string; name: string; kind: string; unread: number; me: { mentions: number } | null }> };
const store = (p: Page) => p.evaluate(() => (window as unknown as { __chatform: () => Store }).__chatform());
const composer = (p: Page, where: "channel" | "thread" = "channel") => p.locator(`[data-chat-composer="${where}"] textarea`);
const message = (p: Page, text: string) => p.locator(".chat-timeline .chat-msg", { hasText: text });

async function openChat(p: Page) {
  await p.locator(".top-bar [data-top-chat]").click();
  await expect(p.locator(".chatform")).toBeVisible();
  await expect(p.locator(".top-bar [data-top-chat]")).toHaveClass(/is-on/);
  // no channel named: it lands on #general (everyone signed in is in it)
  await expect(p.locator('.chat-head [data-channel-head]').or(p.locator("[data-channel-head]"))).toBeVisible();
  await expect(p.locator(".chat-head-name")).toHaveText("general");
}

async function picture(p: Page): Promise<Buffer> {
  const url = await p.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 200;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 320, 200);
    grad.addColorStop(0, "steelblue");
    grad.addColorStop(1, "salmon");
    g.fillStyle = grad;
    g.fillRect(0, 0, 320, 200);
    g.fillStyle = "white";
    g.font = "bold 28px sans-serif";
    g.fillText("rev C", 120, 110);
    return c.toDataURL("image/png");
  });
  return Buffer.from(url.split(",")[1], "base64");
}

test.describe.configure({ mode: "serial" });

test("ChatForm on #/design: the chapter, day and night, and narrow", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  // each light in a fresh context: the first launch follows the system, and then the choice is kept
  for (const [scheme, width, name] of [["light", 1440, "01_design-day"], ["dark", 1440, "01_design-night"], ["light", 900, "02_design-narrow-900-day"]] as const) {
    const c = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme });
    const p = await c.newPage();
    await p.goto("/#/design");
    const section = p.locator(".design-section", { has: p.locator("h2", { hasText: /^ChatForm$/ }) });
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator(".chat-msg").first()).toBeVisible();
    await settle(p, 900);
    await section.screenshot({ path: `${SHOTS}${name}.png` });
    await c.close();
  }
});

test("two people: a post, the badge, live, a thread, a reaction, an edit, a picture, a private dm, the switcher", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const ada = await person(browser, "Ada Lovelace", "ada@normal.dev");
  const kai = await person(browser, "Kai Moreno", "kai@normal.dev");
  const noa = await person(browser, "Noa Berg", "noa@normal.dev");
  // each window's chat store has the list (and so #general) before anyone speaks
  for (const p of [ada.page, kai.page, noa.page]) await p.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().loaded === true);
  await expect.poll(async () => (await store(kai.page)).status, { timeout: 15_000 }).toBe("live");

  // Ada opens ChatForm from the top bar and says something that mentions Kai
  await openChat(ada.page);
  await composer(ada.page).fill("Morning! @kai.moreno the rev C shroud is ready for a look.");
  await composer(ada.page).press("Enter");
  await expect(message(ada.page, "rev C shroud is ready")).toBeVisible();

  // Kai, still on the grid: the badge says it first
  const badge = kai.page.locator(".top-bar [data-top-chat] [data-chat-badge]");
  await expect(badge).toHaveText("1", { timeout: 10_000 });
  await expect(kai.page.locator(".top-bar [data-top-chat]")).toHaveAttribute("data-tip", /1 mention/);
  await kai.page.screenshot({ path: `${SHOTS}03_kai-badge-on-the-grid.png`, clip: { x: 0, y: 0, width: 720, height: 120 } });

  // Kai opens it: the message is there, the New rule above it, and reading it clears the badge
  await openChat(kai.page);
  await expect(message(kai.page, "rev C shroud is ready")).toBeVisible();
  await expect(kai.page.locator(".chat-mention.is-me")).toHaveText("@kai.moreno");
  await expect(badge).toHaveCount(0, { timeout: 10_000 });

  // live: Ada says more, Kai sees it without a reload
  await composer(ada.page).fill("The STEP is in the drive; the print starts Friday.");
  await composer(ada.page).press("Enter");
  await expect(message(kai.page, "print starts Friday")).toBeVisible({ timeout: 10_000 });
  // typing shows on the other side
  await composer(kai.page).pressSequentially("On it", { delay: 40 });
  await expect(ada.page.locator(".chat-main .chat-typing")).toHaveText(/Kai Moreno is typing/, { timeout: 8000 });
  await composer(kai.page).fill("");

  // a thread: Kai replies to Ada's first message; Ada sees the summary move on
  const first = message(kai.page, "rev C shroud is ready");
  await first.hover();
  await first.getByRole("button", { name: "Reply in thread" }).click();
  await expect(kai.page.locator("[data-thread-pane]")).toBeVisible();
  await composer(kai.page, "thread").fill("Looks good. Is the lip printable without supports?");
  await composer(kai.page, "thread").press("Enter");
  await expect(kai.page.locator("[data-thread-pane] .chat-msg", { hasText: "without supports" })).toBeVisible();
  await expect(message(ada.page, "rev C shroud is ready").locator("[data-thread-summary]")).toContainText("1 reply", { timeout: 10_000 });

  // a reaction: Kai's 👍 on Ada's second message reaches Ada, with who on roll-over
  const second = message(kai.page, "print starts Friday");
  await second.hover();
  await second.locator(".chat-hoverbar-quick").first().click();
  const pill = message(ada.page, "print starts Friday").locator(".chat-reaction").first();
  await expect(pill).toContainText("1", { timeout: 10_000 });
  await expect(pill).toHaveAttribute("data-tip", /Kai Moreno reacted/);

  // an edit: ↑ in Ada's empty composer edits her last message; Kai sees the new words and "(edited)"
  await composer(ada.page).click();
  await composer(ada.page).press("ArrowUp");
  const edit = ada.page.locator(".chat-edit textarea");
  await expect(edit).toBeVisible();
  await edit.fill("The STEP is in the drive; the print starts Thursday night.");
  await edit.press("Enter");
  await expect(message(kai.page, "Thursday night")).toContainText("(edited)", { timeout: 10_000 });

  // a picture: Ada attaches one; it goes up as a chip, then shows inline for Kai
  await ada.page.locator('[data-chat-composer="channel"] input[type="file"]').setInputFiles({ name: "revC.png", mimeType: "image/png", buffer: await picture(ada.page) });
  await expect(ada.page.locator('[data-chat-composer="channel"] .chat-chip.is-done')).toBeVisible({ timeout: 15_000 });
  await composer(ada.page).fill("Here's the render.");
  await composer(ada.page).press("Enter");
  const img = message(kai.page, "Here's the render").locator(".chat-picture img");
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(320);
  await settle(kai.page, 600);
  await kai.page.screenshot({ path: `${SHOTS}04_kai-general-night.png` });

  // a dm: Ada starts one with Kai; Kai has it with its unread; Noa can't see it in the list or by its address
  await ada.page.locator('[data-side-section="direct"] .chat-side-add').click({ force: true });
  await ada.page.locator(".chat-modal .chat-people input").fill("Kai");
  await ada.page.locator(".chat-modal [data-person='Kai Moreno']").click();
  await ada.page.locator("[data-new-direct-start]").click();
  await expect(ada.page.locator(".chat-head-name")).toHaveText("Kai Moreno");
  await composer(ada.page).fill("Just between us: the budget is fine.");
  await composer(ada.page).press("Enter");
  await expect(message(ada.page, "Just between us")).toBeVisible();
  const dmId = (await store(ada.page)) && (await ada.page.evaluate(() => window.location.hash.split("/")[3]));
  expect(dmId).toMatch(/^ch_/);
  await expect(kai.page.locator(`[data-channel-row="${dmId}"]`).first()).toBeVisible({ timeout: 10_000 });
  await expect(kai.page.locator(`[data-channel-row="${dmId}"] .chat-count.is-accent`).first()).toHaveText("1");
  expect(Object.keys((await store(noa.page)).channels)).not.toContain(dmId);
  const noaList = await noa.context.request.get(`${CLIENT}/api/chat`);
  expect(((await noaList.json()) as { channels: Array<{ id: string }> }).channels.map((c) => c.id)).not.toContain(dmId);
  const noaRead = await noa.context.request.get(`${CLIENT}/api/chat/channels/${dmId}/messages`);
  expect(noaRead.status()).toBe(404);
  await openChat(noa.page);
  await expect(noa.page.locator(`[data-channel-row="${dmId}"]`)).toHaveCount(0);

  // the quick switcher: Ctrl+K inside ChatForm, a few letters, Enter
  await kai.page.locator(".chat-head-name").click();
  await kai.page.keyboard.press("Control+k");
  await expect(kai.page.locator("[data-chat-switcher]")).toBeFocused();
  await expect(kai.page.locator(".command-bar")).toHaveCount(0);
  await kai.page.keyboard.type("ada");
  await settle(kai.page, 500);
  await kai.page.screenshot({ path: `${SHOTS}05_switcher-night.png` });
  await kai.page.keyboard.press("Enter");
  await expect(kai.page.locator(".chat-head-name")).toHaveText("Ada Lovelace");
  await expect(message(kai.page, "Just between us")).toBeVisible();

  // search: the strip's field finds Ada's edited words; a result opens them in place, flashed
  await kai.page.locator("[data-chat-search]").fill("from:ada thursday");
  await kai.page.locator("[data-chat-search]").press("Enter");
  const hit = kai.page.locator("[data-search-hit]").first();
  await expect(hit).toContainText("Thursday night", { timeout: 10_000 });
  await hit.click();
  await expect(kai.page.locator(".chat-head-name")).toHaveText("general");
  await expect(kai.page.locator(".chat-msg.is-flash", { hasText: "Thursday night" })).toBeVisible();

  // day: the same place in the other light, with the thread open; and narrow
  await kai.page.emulateMedia({ colorScheme: "light" });
  await kai.page.goto(`/#/chat/chat`);
  await expect(kai.page.locator(".chatform")).toBeVisible();
  await kai.page.locator('[data-channel-name="general"]').first().click();
  await message(kai.page, "rev C shroud is ready").locator("[data-thread-summary]").click();
  await expect(kai.page.locator("[data-thread-pane] .chat-msg", { hasText: "without supports" })).toBeVisible();
  await settle(kai.page, 700);
  await kai.page.screenshot({ path: `${SHOTS}06_kai-thread-day.png` });
  await kai.page.setViewportSize({ width: 900, height: 820 });
  await settle(kai.page, 700);
  await kai.page.screenshot({ path: `${SHOTS}07_kai-thread-narrow-900-day.png` });
  // night, narrow, in a window of its own (the first launch follows the system); then with the side menu open beside it
  const night = await person(browser, "Kai Moreno", "kai@normal.dev");
  await night.page.setViewportSize({ width: 900, height: 820 });
  const hash = await kai.page.evaluate(() => window.location.hash);
  await night.page.goto(`/${hash}`);
  await expect(night.page.locator("[data-thread-pane] .chat-msg", { hasText: "without supports" })).toBeVisible();
  await settle(night.page, 900);
  await night.page.screenshot({ path: `${SHOTS}08_kai-thread-narrow-900-night.png` });
  await night.page.locator(".top-bar .pane-fold").click();
  await expect(night.page.locator(".side-pane")).toBeVisible();
  await night.page.locator("[data-thread-pane] .chat-head-btn").click();
  await settle(night.page, 900);
  await night.page.screenshot({ path: `${SHOTS}09_kai-narrow-900-side-menu-night.png` });
  await night.context.close();

  for (const x of [ada, kai, noa]) await x.context.close();
});

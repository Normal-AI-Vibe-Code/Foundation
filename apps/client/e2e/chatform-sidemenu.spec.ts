/**
 * ChatForm in the side menu, and agents on a baseline (2026-11-20; chat/SideChats.tsx, chat/carryChat.ts,
 * chat/pins.ts, chat/AgentFigure.tsx), in real browsers with real pointer moves:
 *
 * - Ada pulls #general out of ChatForm's list: the slip in the hand, the folded side menu opens at the
 *   window's edge and rings; let go over it, the selector shows **Chats** and the row. A reload keeps it
 *   (the server's `chat.pinned`). The three segments fit at the menu's narrowest (220).
 * - From a grid, pressing the row opens the chat full width with ChatForm's list folded; unfold brings it back.
 * - Kai posts: Ada's row in the side menu shows it unread, live.
 * - A second conversation kept from a row's menu; the two reordered by pulling; one taken out.
 * - Claude answers a mention: its figure stands on a baseline, no circle.
 * - Screenshots, day and night, into docs/evidence/2026-11-20_chatform-sidemenu/.
 *
 *   E2E_STARTER=<repo>/apps/server/starter/characters E2E_SERVER_PORT=16531 E2E_CLIENT_PORT=16551 E2E_SLACK_PORT=16541 E2E_MESHY_PORT=16545 E2E_T3_PORT=16595 npm run e2e -w @foundation/client -- chatform-sidemenu.spec.ts
 *
 * Without E2E_STARTER there are no characters: the agent is the ✦ on its line, and the check still holds.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = fileURLToPath(new URL("../../../docs/evidence/2026-11-20_chatform-sidemenu/", import.meta.url));

type Store = { loaded: boolean; status: string; channels: Record<string, { id: string; name: string; kind: string; unread: number }> };
const store = (p: Page) => p.evaluate(() => (window as unknown as { __chatform: () => Store }).__chatform());
const chatLoaded = (p: Page) => p.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().loaded === true);
const composer = (p: Page, where: "channel" | "thread" = "channel") => p.locator(`[data-chat-composer="${where}"] textarea`);
const message = (p: Page, text: string) => p.locator(".chat-timeline .chat-msg", { hasText: text });
const pins = (p: Page) => p.locator(".side-pane [data-chat-pin]");
const pinNames = (p: Page) => pins(p).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.chatPinName));
const serverPins = async (p: Page) => ((await (await p.context().request.get(`${CLIENT}/api/prefs`)).json()) as { lists: { "chat.pinned": string[] } }).lists["chat.pinned"];

/** a real press, pull and let go, in steps, as a hand does */
async function pull(p: Page, from: { x: number; y: number }, path: Array<{ x: number; y: number }>, opts: { shot?: string } = {}) {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  let at = from;
  for (const to of path) {
    const n = Math.max(6, Math.round(Math.hypot(to.x - at.x, to.y - at.y) / 18));
    for (let i = 1; i <= n; i++) {
      await p.mouse.move(at.x + ((to.x - at.x) * i) / n, at.y + ((to.y - at.y) * i) / n);
      await p.waitForTimeout(12);
    }
    at = to;
    await p.waitForTimeout(120);
  }
  if (opts.shot) {
    await p.waitForTimeout(350);
    await p.screenshot({ path: `${SHOTS}${opts.shot}.png` });
  }
  await p.mouse.up();
}
const centre = async (p: Page, sel: string) => {
  const b = (await p.locator(sel).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** the same person in a window of their own in day light, the side menu open on Chats */
async function inDay(browser: Browser, name: string, email: string, hash: string, floor: Record<string, unknown> = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email }, headers: { origin: CLIENT } });
  await context.addInitScript((f) => localStorage.setItem("foundation-floor", JSON.stringify({ pane: true, spacesView: "chats", ...f })), floor);
  const page = await context.newPage();
  await page.goto(`/${hash}`);
  await chatLoaded(page);
  return { context, page };
}

/** a signed-in person whose floor starts clean once (the menu folded), then is theirs across reloads */
async function person(browser: Browser, name: string, email: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email }, headers: { origin: CLIENT } });
  if (!res.ok()) throw new Error(`dev login for ${email}: ${res.status()}`);
  await context.addInitScript(() => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    sessionStorage.setItem("e2e-seeded", "1");
    localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false }));
    localStorage.setItem("foundation-wheel", "pan");
  });
  const page = await context.newPage();
  await page.goto("/?board=company");
  await waitLive(page);
  return { context, page };
}

test.describe.configure({ mode: "serial" });

test("a conversation pulled into the side menu, kept on the server, opened full width, live, reordered and let go; an agent on its baseline", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(SHOTS, { recursive: true });
  const ada = await person(browser, "Ada Lovelace", "ada@normal.dev");
  const kai = await person(browser, "Kai Moreno", "kai@normal.dev");
  const req = ada.context.request;
  const H = { headers: { origin: CLIENT } };

  // Claude wears a starter character, when the starter set is here (E2E_STARTER)
  const chars = ((await (await req.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ id: string; name: string; ready: boolean; files: Record<string, string>; approval?: string }> }).characters;
  const worn = chars.find((c) => c.ready && c.files.portrait && (c.approval ?? "approved") === "approved");
  if (worn) expect((await req.post(`${CLIENT}/api/characters/avatars`, { data: { name: "Claude", character: worn.id }, ...H })).ok()).toBe(true);

  // Ada in ChatForm, the side menu folded (helpers.person keeps a clean floor)
  await ada.page.goto("/#/chat/chat");
  await chatLoaded(ada.page);
  await expect(ada.page.locator(".chat-head-name")).toHaveText("general", { timeout: 15_000 });
  await expect(ada.page.locator(".side-pane")).toHaveCount(0);
  const general = (await store(ada.page)).channels;
  const generalId = Object.values(general).find((c) => c.name === "general")!.id;

  // she pulls #general out of the list: to the window's edge (the side menu opens), then over it, and lets go
  const row = await centre(ada.page, `.chat-sidebar [data-channel-row="${generalId}"]`);
  await pull(ada.page, row, [{ x: row.x + 30, y: row.y + 10 }, { x: 8, y: row.y + 40 }, { x: 120, y: 260 }], { shot: "01_slip-in-hand-over-menu-night" });
  await expect(ada.page.locator(".side-pane")).toBeVisible();
  await expect(ada.page.locator('[data-pane-seg="chats"]')).toHaveClass(/is-on/);
  await expect(pins(ada.page)).toHaveCount(1);
  await expect(pins(ada.page).first()).toHaveAttribute("data-chat-pin-name", "general");
  await expect(ada.page.locator(".chat-held")).toHaveCount(0, { timeout: 3000 });
  await expect(ada.page.locator(".is-held")).toHaveCount(0);
  await expect.poll(() => serverPins(ada.page)).toEqual([generalId]);
  // while she's in it, its row is the current one (selected, not hover)
  await expect(pins(ada.page).first()).toHaveClass(/is-current/);

  // a pull that ends anywhere else flies back: nothing is kept
  const design = (await (await req.post(`${CLIENT}/api/chat/channels`, { data: { kind: "open", name: "design", request_id: `rq-design-${Date.now()}` }, ...H })).json()) as { channel: { id: string } };
  await expect(ada.page.locator(`.chat-sidebar [data-channel-row="${design.channel.id}"]`)).toBeVisible({ timeout: 10_000 });
  const dRow = await centre(ada.page, `.chat-sidebar [data-channel-row="${design.channel.id}"]`);
  await pull(ada.page, dRow, [{ x: dRow.x + 300, y: dRow.y + 200 }]);
  await settle(ada.page, 500);
  await expect(pins(ada.page)).toHaveCount(1);

  // reload: still there (the server keeps it), the selector still on Chats
  await ada.page.reload();
  await chatLoaded(ada.page);
  await expect(ada.page.locator('[data-pane-seg="chats"]')).toHaveClass(/is-on/);
  await expect(pins(ada.page)).toHaveCount(1);
  await settle(ada.page, 600);
  await ada.page.locator(".side-pane").screenshot({ path: `${SHOTS}02_side-menu-chats-night.png` });

  // the three segments fit at the menu's narrowest (220): every word whole
  await ada.page.evaluate(() => {
    const f = JSON.parse(localStorage.getItem("foundation-floor") ?? "{}");
    localStorage.setItem("foundation-floor", JSON.stringify({ ...f, paneW: 220 }));
  });
  await ada.page.reload();
  await chatLoaded(ada.page);
  await expect(ada.page.locator(".side-pane")).toHaveCSS("width", "220px");
  const clipped = await ada.page.locator(".side-pane .pane-seg-btn").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent));
  expect(clipped).toEqual([]);
  await ada.page.locator(".side-pane .pane-pick").screenshot({ path: `${SHOTS}03_selector-at-220-night.png` });
  await ada.page.evaluate(() => {
    const f = JSON.parse(localStorage.getItem("foundation-floor") ?? "{}");
    localStorage.setItem("foundation-floor", JSON.stringify({ ...f, paneW: 272 }));
  });

  // from a grid, the row opens the chat full width, ChatForm's list folded
  await ada.page.goto("/#/board");
  await ada.page.reload();
  await expect(ada.page.locator(".chatform")).toHaveCount(0);
  await pins(ada.page).first().locator(".space-open").click();
  await expect(ada.page.locator(".chatform")).toBeVisible();
  await expect.poll(() => ada.page.evaluate(() => window.location.hash)).toBe(`#/chat/chat/${generalId}`);
  await expect(ada.page.locator(".chat-tab-chat")).toHaveClass(/is-list-folded/);
  await expect(ada.page.locator(".chat-sidebar")).toHaveCount(0);
  await expect(ada.page.locator("[data-chat-unfold]")).toBeVisible();
  await expect(pins(ada.page).first()).toHaveClass(/is-current/);
  // the conversation takes the area right of the side menu
  const area = (await ada.page.locator(".chat-main").boundingBox())!;
  const menu = (await ada.page.locator(".side-pane").boundingBox())!;
  expect(Math.abs(area.x - (menu.x + menu.width))).toBeLessThan(3);
  await settle(ada.page, 600);
  await ada.page.screenshot({ path: `${SHOTS}04_opened-full-width-night.png` });
  // unfold brings the list back
  await ada.page.locator("[data-chat-unfold]").click();
  await expect(ada.page.locator(".chat-sidebar")).toBeVisible();
  await expect(ada.page.locator(".chat-tab-chat")).not.toHaveClass(/is-list-folded/);

  // Ada back on a grid; Kai posts in #general: her row says so, live
  await ada.page.goto("/#/board");
  await kai.page.goto(`/#/chat/chat/${generalId}`);
  await chatLoaded(kai.page);
  await composer(kai.page).fill("the kiln schedule moved to Thursday");
  await composer(kai.page).press("Enter");
  await expect(message(kai.page, "the kiln schedule moved")).toBeVisible();
  await expect(pins(ada.page).first()).toHaveClass(/is-unread/, { timeout: 15_000 });
  await expect(pins(ada.page).first()).toHaveAttribute("data-unread", /^[1-9]/);
  await settle(ada.page, 500);
  await ada.page.locator(".side-pane").screenshot({ path: `${SHOTS}05_side-menu-unread-night.png` });

  // a second one kept from its row's menu (right-click), then the two reordered by pulling
  await ada.page.goto("/#/chat/chat");
  await ada.page.locator(`.chat-sidebar [data-channel-row="${design.channel.id}"]`).click({ button: "right" });
  await ada.page.locator(".context-menu, [role=menu]").getByText("Keep in the side menu").click();
  await expect.poll(() => pinNames(ada.page)).toEqual(["general", "design"]);
  const second = await centre(ada.page, `.side-pane [data-chat-pin="${design.channel.id}"] .space-open`);
  const first = (await ada.page.locator(`.side-pane [data-chat-pin="${generalId}"]`).boundingBox())!;
  await expect(ada.page.locator(".menu-backdrop")).toHaveCount(0);
  await pull(ada.page, second, [{ x: second.x, y: second.y - 10 }, { x: second.x, y: first.y + 6 }]);
  await expect.poll(() => pinNames(ada.page)).toEqual(["design", "general"]);
  await expect.poll(() => serverPins(ada.page)).toEqual([design.channel.id, generalId]);
  // its menu again says take it out
  await ada.page.locator(`.chat-sidebar [data-channel-row="${design.channel.id}"]`).click({ button: "right" });
  await expect(ada.page.locator(".context-menu, [role=menu]").getByText("Take out of the side menu")).toBeVisible();
  await ada.page.keyboard.press("Escape");

  // ✕ takes one out (it only leaves the side menu: #general is still hers in ChatForm)
  await ada.page.locator(`.side-pane [data-chat-pin="${generalId}"]`).hover();
  await ada.page.locator(`.side-pane [data-chat-pin="${generalId}"] .chat-pin-off`).click();
  await expect.poll(() => pinNames(ada.page)).toEqual(["design"]);
  await expect.poll(() => serverPins(ada.page)).toEqual([design.channel.id]);
  await expect(ada.page.locator(`.chat-sidebar [data-channel-row="${generalId}"]`)).toBeVisible();
  // put it back for the pictures
  await ada.page.locator(`.chat-sidebar [data-channel-row="${generalId}"]`).click({ button: "right" });
  await ada.page.locator(".context-menu, [role=menu]").getByText("Keep in the side menu").click();
  await expect.poll(() => pinNames(ada.page)).toEqual(["design", "general"]);

  // Claude answers a mention: in the thread, its figure stands on a baseline, never in a circle
  await ada.page.goto(`/#/chat/chat/${generalId}`);
  await expect(ada.page.locator(".chat-head-name")).toHaveText("general");
  await composer(ada.page).fill("@claude what's on the board this week?");
  await composer(ada.page).press("Enter");
  const summary = message(ada.page, "what's on the board this week?").locator("[data-thread-summary]");
  await expect(summary).toContainText("1 reply", { timeout: 25_000 });
  await summary.click();
  const reply = ada.page.locator("[data-thread-pane] .chat-msg.is-agent").first();
  await expect(reply).toContainText("looked at your channels", { timeout: 25_000 });
  const fig = reply.locator("[data-agent-figure]");
  await expect(fig).toBeVisible();
  await expect(fig).toHaveAttribute("data-figure-form", "figure");
  await expect(fig.locator("[data-figure-baseline]")).toHaveCount(1);
  const look = await fig.evaluate((el) => {
    const all = [el, ...el.querySelectorAll("*")] as HTMLElement[];
    const round = all.filter((e) => {
      const s = getComputedStyle(e);
      return s.borderRadius.includes("50%") || /circle|ellipse/.test(s.clipPath) || (parseFloat(s.borderTopLeftRadius) >= e.getBoundingClientRect().width / 2 - 0.5 && e.getBoundingClientRect().width > 4 && !e.matches(".chat-presence"));
    });
    const line = el.querySelector<HTMLElement>("[data-figure-baseline]")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const img = el.querySelector("img");
    return { round: round.map((e) => e.className), lineW: line.width, boxW: box.width, lineBottom: line.bottom, boxBottom: box.bottom, lineH: line.height, hasImg: !!img, imgLoaded: !!img && img.complete && img.naturalWidth > 0 };
  });
  expect(look.round).toEqual([]);
  expect(look.lineH).toBe(1);
  expect(Math.abs(look.lineW - look.boxW)).toBeLessThan(0.5);
  expect(Math.abs(look.lineBottom - look.boxBottom)).toBeLessThan(0.5);
  if (worn) expect(look.imgLoaded).toBe(true);
  // the text column is where a person's is
  const personText = (await message(ada.page, "what's on the board this week?").locator(".chat-msg-main").boundingBox())!;
  const agentText = (await reply.locator(".chat-msg-main").boundingBox())!;
  const threadPersonText = await ada.page.locator("[data-thread-pane] .chat-msg:not(.is-agent) .chat-msg-main").first().boundingBox();
  if (threadPersonText) expect(Math.abs(agentText.x - threadPersonText.x)).toBeLessThan(1);
  expect(personText.width).toBeGreaterThan(0);
  await settle(ada.page, 900);
  await reply.screenshot({ path: `${SHOTS}06_agent-on-baseline-thread-night.png` });
  await ada.page.screenshot({ path: `${SHOTS}07_thread-with-agent-night.png` });

  // the Agents tab: the list's faces and the head's figure on the head's hairline
  await ada.page.goto("/#/chat/agents");
  await ada.page.locator('[data-agent-row="Claude"]').click();
  await expect(ada.page.locator('[data-agent-head="Claude"]')).toBeVisible();
  const head = await ada.page.locator('[data-agent-head="Claude"] .cfa-face').evaluate((el) => {
    const s = getComputedStyle(el);
    const h = el.closest(".cfa-head")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { radius: s.borderRadius, h: r.height, gap: h.bottom - 1 - r.bottom };
  });
  expect(head.radius).toBe("0px");
  expect(head.h).toBeGreaterThanOrEqual(72);
  expect(head.h).toBeLessThanOrEqual(88);
  expect(Math.abs(head.gap)).toBeLessThan(0.6);
  await settle(ada.page, 1500);
  await ada.page.locator(".cfa-tab").screenshot({ path: `${SHOTS}08_agents-tab-head-night.png` });

  // day: the side menu with Chats (one unread), the chat opened full width, the thread, the Agents tab
  const day = await inDay(browser, "Ada Lovelace", "ada@normal.dev", `#/chat/chat/${generalId}`);
  await day.page.evaluate(() => localStorage.setItem("chatform-list-folded", "1"));
  await day.page.reload();
  await chatLoaded(day.page);
  await expect(day.page.locator(".chat-tab-chat")).toHaveClass(/is-list-folded/);
  await expect(pins(day.page)).toHaveCount(2);
  await settle(day.page, 1200);
  await day.page.screenshot({ path: `${SHOTS}09_opened-full-width-day.png` });
  await day.page.locator(".side-pane").screenshot({ path: `${SHOTS}10_side-menu-chats-day.png` });
  await day.page.goto(`/#/chat/chat/${generalId}/thread/${await message(day.page, "what's on the board this week?").getAttribute("data-message")}`);
  await expect(day.page.locator("[data-thread-pane] .chat-msg.is-agent").first()).toContainText("looked at your channels", { timeout: 15_000 });
  await settle(day.page, 1200);
  await day.page.locator("[data-thread-pane] .chat-msg.is-agent").first().screenshot({ path: `${SHOTS}11_agent-on-baseline-thread-day.png` });
  await day.page.screenshot({ path: `${SHOTS}12_thread-with-agent-day.png` });
  await day.page.goto("/#/chat/agents");
  await day.page.locator('[data-agent-row="Claude"]').click();
  await expect(day.page.locator('[data-agent-head="Claude"]')).toBeVisible();
  await settle(day.page, 1500);
  await day.page.locator(".cfa-tab").screenshot({ path: `${SHOTS}13_agents-tab-head-day.png` });
  // the slip in the hand, in day light, over the open side menu
  await day.page.goto(`/#/chat/chat/${generalId}`);
  await day.page.locator("[data-chat-unfold]").click();
  await expect(day.page.locator(".chat-sidebar")).toBeVisible();
  const kept = await centre(day.page, `.chat-sidebar [data-channel-row="${generalId}"]`);
  const menuBox = (await day.page.locator(".side-pane").boundingBox())!;
  await pull(day.page, kept, [{ x: kept.x + 40, y: kept.y + 20 }, { x: menuBox.x + 140, y: menuBox.y + 300 }], { shot: "14_slip-in-hand-over-menu-day" });
  await day.context.close();

  await ada.context.close();
  await kai.context.close();
});

test("#/design: the side menu's Chats, the slip, the folded chat and agents on the baseline, day and night", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const [scheme, name] of [["light", "15_design-day"], ["dark", "16_design-night"]] as const) {
    // 2× so a misaligned baseline shows
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const p = await c.newPage();
    await p.goto("/#/design");
    const part = p.locator("[data-design-sidemenu]");
    await part.scrollIntoViewIfNeeded();
    await expect(part.locator("[data-chat-pin]").first()).toBeVisible();
    await expect(part.locator("[data-agent-figure]").first()).toBeVisible();
    for (const [sel, what] of [[".chat-demo-row", "menu"], [".chat-demo-folded", "folded"], [".chat-demo-figures", "figures"]] as const) {
      const el = part.locator(sel).first();
      await el.scrollIntoViewIfNeeded();
      await settle(p, 700);
      await el.screenshot({ path: `${SHOTS}${name}-${what}.png` });
    }
    // every figure's line runs its window's width at its foot
    const lines = await part.locator('[data-figure-form="figure"]').evaluateAll((els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect();
        const l = e.querySelector("[data-figure-baseline]")!.getBoundingClientRect();
        return Math.abs(l.bottom - b.bottom) + Math.abs(l.width - b.width);
      }),
    );
    expect(lines.every((d) => d < 0.6)).toBe(true);
    await c.close();
  }
});

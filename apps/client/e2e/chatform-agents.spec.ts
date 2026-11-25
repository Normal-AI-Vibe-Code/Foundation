/**
 * Agents in ChatForm (docs/chatform.md §4 A1; server: apps/server/src/chatagents.ts), in two browsers, on
 * the server's scripted runtime (the real chat and board tools, no model, nothing spent).
 *
 * - Ada @-mentions Claude in #general (the composer offers it); Claude answers in that message's thread,
 *   marked as an agent (violet mark, its face, *for Ada*); Kai, in his own browser, sees the thread grow
 *   and reads the reply live.
 * - Ada opens the Agents tab: the agents she can talk to (face, whose model, where, ready), opens her
 *   conversation with Claude, asks something long; the head shows Claude live and working, a Stop button
 *   while the turn runs; Stop ends it and the reply says so.
 * - Day and night screenshots, `agents-` in docs/evidence/2026-11-18_chatform/.
 *
 *   E2E_SERVER_PORT=16231 E2E_CLIENT_PORT=16251 E2E_SLACK_PORT=16241 E2E_MESHY_PORT=16245 E2E_T3_PORT=16295 npm run e2e -w @foundation/client -- chatform-agents.spec.ts
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = fileURLToPath(new URL("../../../docs/evidence/2026-11-18_chatform/", import.meta.url));

type Store = { loaded: boolean; status: string; agents: Array<{ name: string }>; channels: Record<string, { id: string; name: string; kind: string }> };
const store = (p: Page) => p.evaluate(() => (window as unknown as { __chatform: () => Store }).__chatform());
const composer = (p: Page, where: "channel" | "thread" = "channel") => p.locator(`[data-chat-composer="${where}"] textarea`);
const message = (p: Page, text: string) => p.locator(".chat-timeline .chat-msg", { hasText: text });

async function toGeneral(p: Page) {
  await p.goto("/#/chat/chat");
  await expect(p.locator(".chatform")).toBeVisible();
  await p.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().loaded === true);
  await expect(p.locator(".chat-head-name")).toHaveText("general", { timeout: 15_000 });
}

/** the same person in a window of their own in day light (the first launch follows the system; after that the choice is kept) */
async function inDay(browser: Browser, name: string, email: string, hash: string, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light" });
  await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  const page = await context.newPage();
  await page.goto(`/${hash}`);
  await expect(page.locator(".chatform")).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().loaded === true);
  return { context, page };
}

test.describe.configure({ mode: "serial" });

test("a mention is answered in its thread by the agent, live for everyone; the Agents tab talks and stops", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const ada = await person(browser, "Ada Lovelace", "ada@normal.dev");
  const kai = await person(browser, "Kai Moreno", "kai@normal.dev");
  await toGeneral(ada.page);
  await toGeneral(kai.page);
  await expect.poll(async () => (await store(kai.page)).status, { timeout: 15_000 }).toBe("live");

  // the composer offers the agents the server registered
  expect((await store(ada.page)).agents.map((a) => a.name)).toEqual(expect.arrayContaining(["Claude", "Shiba"]));
  await composer(ada.page).click();
  await composer(ada.page).pressSequentially("@clau", { delay: 30 });
  await expect(ada.page.locator(".chat-ac [role=option]", { hasText: "Claude" }).first()).toBeVisible();
  await composer(ada.page).fill("@claude what should we look at first today?");
  await composer(ada.page).press("Enter");
  const asked = message(ada.page, "what should we look at first today?");
  await expect(asked).toBeVisible();

  // Kai sees the thread grow, live, and opens it: the reply is the agent's, unmistakably
  const summary = message(kai.page, "what should we look at first today?").locator("[data-thread-summary]");
  await expect(summary).toContainText("1 reply", { timeout: 20_000 });
  await summary.click();
  const reply = kai.page.locator("[data-thread-pane] .chat-msg.is-agent").first();
  await expect(reply).toBeVisible();
  await expect(reply.locator(".chat-msg-name")).toHaveText("Claude");
  await expect(reply.locator(".chat-agent-mark")).toHaveText("Agent");
  await expect(reply.locator(".chat-msg-for")).toHaveText("for Ada Lovelace");
  // an agent is a figure on a baseline, never a disc (2026-11-20; chat/AgentFigure.tsx)
  await expect(reply.locator("[data-agent-figure]")).toBeVisible();
  await expect(reply).toContainText("You asked:", { timeout: 20_000 });
  await expect(reply).toContainText("looked at your channels", { timeout: 20_000 });
  // the agent saw it first: 👀 on the ask
  await expect(message(kai.page, "what should we look at first today?").locator(".chat-reaction", { hasText: "👀" })).toBeVisible();
  await settle(kai.page, 700);
  await kai.page.screenshot({ path: `${SHOTS}agents-01_thread-reply-night.png` });
  const threadHash = await kai.page.evaluate(() => window.location.hash);
  const kaiDay = await inDay(browser, "Kai Moreno", "kai@normal.dev", threadHash);
  await expect(kaiDay.page.locator("[data-thread-pane] .chat-msg.is-agent").first()).toContainText("looked at your channels");
  await settle(kaiDay.page, 900);
  await kaiDay.page.screenshot({ path: `${SHOTS}agents-02_thread-reply-day.png` });
  await kaiDay.context.close();

  // the Agents tab: who Ada can talk to, then her conversation with Claude
  await ada.page.goto("/#/chat/agents");
  const row = ada.page.locator('[data-agent-row="Claude"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator(".provider-mark")).toBeVisible();
  await expect(row.locator(".cfa-state.is-ready")).toBeVisible();
  await expect(ada.page.locator('[data-agent-row="Shiba"]')).toBeVisible();
  await row.click();
  await expect(ada.page.locator("[data-agent-conversation]")).toBeVisible();
  await expect(ada.page.locator('[data-agent-head="Claude"]')).toBeVisible();
  await composer(ada.page).fill("Slowly, walk me through what's on the board this week.");
  await composer(ada.page).press("Enter");
  const stop = ada.page.locator("[data-agent-stop]");
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await expect(ada.page.locator("[data-agent-head]")).toHaveAttribute("data-mood", /thinking|talking/);
  const answer = ada.page.locator("[data-agent-conversation] .chat-msg.is-agent").last();
  await expect(answer).toContainText("Taking my time", { timeout: 20_000 });
  await expect(ada.page.locator("[data-agent-head]")).toHaveAttribute("data-mood", "talking");
  await settle(ada.page, 400);
  await ada.page.screenshot({ path: `${SHOTS}agents-03_conversation-typing-night.png` });
  await stop.click();
  await expect(answer).toContainText("Stopped by Ada Lovelace", { timeout: 15_000 });
  await expect(stop).toHaveCount(0, { timeout: 10_000 });
  await expect(ada.page.locator("[data-agent-head]")).toHaveAttribute("data-mood", "idle");
  // the conversation is listed as hers
  await expect(ada.page.locator("[data-conversation]").first()).toBeVisible();
  await settle(ada.page, 600);
  await ada.page.screenshot({ path: `${SHOTS}agents-04_conversation-stopped-night.png` });
  const convHash = await ada.page.evaluate(() => window.location.hash);
  const adaDay = await inDay(browser, "Ada Lovelace", "ada@normal.dev", convHash);
  await expect(adaDay.page.locator("[data-agent-conversation] .chat-msg.is-agent").last()).toContainText("Stopped by Ada Lovelace");
  await settle(adaDay.page, 900);
  await adaDay.page.screenshot({ path: `${SHOTS}agents-05_conversation-stopped-day.png` });
  await adaDay.page.setViewportSize({ width: 900, height: 820 });
  await settle(adaDay.page, 700);
  await adaDay.page.screenshot({ path: `${SHOTS}agents-06_conversation-narrow-900-day.png` });
  await adaDay.context.close();

  await ada.context.close();
  await kai.context.close();
});

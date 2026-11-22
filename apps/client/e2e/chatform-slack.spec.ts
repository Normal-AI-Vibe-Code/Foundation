/**
 * Coming from Slack, in a real browser (tabs/SlackGuide.tsx, tabs/Inbox.tsx; server: bridges/slack.ts),
 * against the stand-in Slack and the stand-in Google (e2e/slack-standin.mjs): nothing reaches the real ones.
 *
 *  - The nudge appears in ChatForm while Slack is neither linked nor brought in; Start opens the guide.
 *  - Keep both in step: the token checks against the stand-in, #general is linked, a message said "in Slack"
 *    appears in ChatForm within seconds as its author; Ada's message reaches Slack once as "Ada … via
 *    Foundation"; an agent's reply waits as a draft and nothing goes out; the link is undone from the Inbox.
 *  - Move in: a tiny export zip, files off, rehearsed then brought in.
 *  - Inbox: the Mail card's Connect, with the Google client set in the wizard, goes through a stand-in consent
 *    page and the card flips to Connected without a reload.
 * Screenshots, day and night, go to docs/evidence/2026-11-20_chatform-inbox-slack/.
 *
 *   E2E_SERVER_PORT=16631 E2E_CLIENT_PORT=16651 E2E_SLACK_PORT=16641 E2E_MESHY_PORT=16645 E2E_T3_PORT=16695 npm run e2e -w @foundation/client -- chatform-slack.spec.ts
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { test, expect, type Page } from "@playwright/test";
import { person, settle } from "./helpers";

const SHOTS = fileURLToPath(new URL("../../../docs/evidence/2026-11-20_chatform-inbox-slack/", import.meta.url));
const SLACK = `http://127.0.0.1:${process.env.E2E_SLACK_PORT ?? 4440}`;

type Sent = { method: string; channel: string; text: string; username?: string };
const sentToSlack = async (p: Page) => ((await (await p.request.get(`${SLACK}/_sent`)).json()) as { sent: Sent[] }).sent;
const message = (p: Page, text: string) => p.locator(".chat-timeline .chat-msg", { hasText: text });

/** a Slack export as a zip (stored, no compression): one channel, two people, three messages */
function exportZip(): Buffer {
  const files: Array<[string, string]> = [
    ["users.json", JSON.stringify([{ id: "UH1", name: "rosa", real_name: "Rosa Vale", profile: { real_name: "Rosa Vale", email: "rosa@elsewhere.example" } }, { id: "UH2", name: "ada", real_name: "Ada Lovelace", profile: { real_name: "Ada Lovelace", email: "ada@normal.dev" } }])],
    ["channels.json", JSON.stringify([{ id: "CHIST0001", name: "old-projects", created: 1_700_000_000, members: ["UH1", "UH2"], topic: { value: "From Slack" }, purpose: { value: "" } }])],
    ["old-projects/2023-11-14.json", JSON.stringify([
      { type: "message", user: "UH1", text: "The first fan shroud is printed", ts: "1700000100.000100" },
      { type: "message", user: "UH2", text: "Looks right to me", ts: "1700000200.000100" },
      { type: "message", user: "UH1", text: "Shipping it Friday", ts: "1700000300.000100" },
    ])],
  ];
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8");
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

test.describe.configure({ mode: "serial" });

test("the nudge, the guide's bridge path end to end, a draft held, unlinked from the Inbox", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const admin = await person(browser, "Admin Person", "admin@normal.dev");
  const ada = await person(browser, "Ada Lovelace", "ada@normal.dev");

  // the nudge: in Chat, while Slack is neither linked nor brought in
  await admin.page.goto("/#/chat/chat");
  const nudge = admin.page.locator("[data-slack-nudge]");
  await expect(nudge).toBeVisible({ timeout: 15_000 });
  await expect(nudge).toContainText("Coming from Slack?");
  await settle(admin.page, 500);
  await admin.page.screenshot({ path: `${SHOTS}01_nudge-night.png` });
  await nudge.locator("[data-nudge-start]").click();
  const guide = admin.page.locator("[data-slack-guide]");
  await expect(guide).toBeVisible();
  await admin.page.screenshot({ path: `${SHOTS}02_guide-choose-night.png` });

  // keep both in step: the app's permissions, the token checked against the stand-in
  await guide.locator('[data-guide-path="bridge"]').click();
  await expect(guide.locator(".fx-scopes")).toBeVisible();
  await expect(guide.locator("[data-copy-manifest]")).toBeEnabled();
  await guide.locator("[data-guide-next]").click();
  await guide.locator("[data-check-slack]").click();
  await expect(guide.locator("[data-check-said]")).toContainText("Form Industries (stand-in)");
  await guide.locator("[data-guide-next]").click();

  // pick channels: #general here and in Slack, linked
  const row = guide.locator('[data-slack-row="general"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await admin.page.screenshot({ path: `${SHOTS}03_guide-channels-night.png` });
  await row.locator("[data-link]").click();
  await expect(row).toContainText("Linked");
  await guide.locator("[data-guide-next]").click();

  // the live test: out and read back from Slack
  await guide.locator("[data-send-test]").click();
  await expect(guide.locator("[data-test-result]")).toContainText("Slack has it", { timeout: 15_000 });
  await admin.page.screenshot({ path: `${SHOTS}04_guide-test-night.png` });
  await guide.locator("[data-guide-next]").click();
  await expect(guide.locator('[data-slack-link="general"]')).toBeVisible();
  await guide.getByRole("button", { name: "Close" }).last().click();
  await expect(nudge).toHaveCount(0);

  // someone says something in Slack: it appears in ChatForm's #general within seconds, as them
  await ada.page.goto("/#/chat/chat");
  await expect(ada.page.locator(".chat-head-name")).toHaveText("general", { timeout: 15_000 });
  const said = `Hello from Slack ${Date.now().toString(36)}`;
  await ada.page.request.get(`${SLACK}/_post?channel=general&user=U2&text=${encodeURIComponent(said)}`);
  const fromSlack = message(ada.page, said);
  await expect(fromSlack).toBeVisible({ timeout: 10_000 });
  await expect(fromSlack.locator(".chat-msg-name")).toHaveText("Kai");
  await expect(fromSlack).toHaveClass(/is-ghost/);

  // Ada's message reaches Slack once, as her, via Foundation
  const before = (await sentToSlack(ada.page)).filter((s) => s.method === "chat.postMessage").length;
  const mine = `Hi Slack, Ada here ${Date.now().toString(36)}`;
  await ada.page.locator('[data-chat-composer="channel"] textarea').fill(mine);
  await ada.page.keyboard.press("Enter");
  await expect(message(ada.page, mine).locator('[data-outbound="sent"]')).toBeVisible({ timeout: 10_000 });
  await settle(ada.page, 3000); // a few polls: its echo must not come back, and it must not go twice
  const posts = (await sentToSlack(ada.page)).filter((s) => s.method === "chat.postMessage");
  expect(posts.length - before).toBe(1);
  expect(posts.at(-1)!.username).toBe("Ada Lovelace via Foundation");
  expect(posts.at(-1)!.text).toBe(mine);
  await expect(message(ada.page, mine)).toHaveCount(1);
  await ada.page.screenshot({ path: `${SHOTS}05_general-linked-night.png` });

  // an agent's reply in a linked channel waits as a draft: nothing goes to Slack
  const { token } = (await (await ada.page.request.post("/api/agent/token")).json()) as { token: string };
  const store = (await ada.page.evaluate(() => (window as unknown as { __chatform: () => { channels: Record<string, { id: string; name: string }> } }).__chatform())).channels;
  const general = Object.values(store).find((c) => c.name === "general")!;
  const r = await ada.page.request.post(`/api/chat/channels/${general.id}/messages`, { headers: { authorization: `Bearer ${token}`, "x-foundation-agent": "Wren" }, data: { text: "Wren's draft for Slack" } });
  expect(r.ok()).toBeTruthy();
  const draft = message(ada.page, "Wren's draft for Slack");
  await expect(draft.locator('[data-outbound="draft"]')).toBeVisible({ timeout: 10_000 });
  await settle(ada.page, 2000);
  expect((await sentToSlack(ada.page)).filter((s) => s.method === "chat.postMessage").length).toBe(posts.length);
  await ada.page.screenshot({ path: `${SHOTS}06_agent-draft-night.png` });

  // the Inbox's Slack card: linked, live; unlinked (asked first), and every message stays
  await admin.page.goto("/#/chat/inbox");
  const card = admin.page.locator('[data-bridge="slack"]');
  await expect(card.locator('[data-slack-link="general"]')).toBeVisible({ timeout: 10_000 });
  await admin.page.screenshot({ path: `${SHOTS}07_inbox-linked-night.png` });
  await card.locator("[data-unlink]").click();
  await card.locator("[data-unlink-yes]").click();
  await expect(card.locator('[data-slack-link="general"]')).toHaveCount(0);
  await expect(message(ada.page, mine)).toHaveCount(1);
  await admin.context.close();
  await ada.context.close();
});

test("move in: a small export, files off, rehearsed and brought in through the guide", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await person(browser, "Admin Person", "admin@normal.dev");
  await admin.page.goto("/#/chat/inbox/slack-guide");
  const guide = admin.page.locator("[data-slack-guide]");
  await expect(guide).toBeVisible({ timeout: 15_000 });
  await guide.locator('[data-guide-path="import"]').click();
  await guide.locator("[data-workspace]").fill("formindustries");
  await guide.locator("[data-guide-next]").click();
  await guide.locator("[data-import-files]").uncheck();
  await guide.locator('[data-export-drop] input[type="file"]').setInputFiles({ name: "slack-export.zip", mimeType: "application/zip", buffer: exportZip() });
  await expect(guide.locator(".hist-report h3")).toHaveText("What would come in", { timeout: 20_000 });
  await guide.locator("[data-bring-in]").click();
  await expect(guide.locator(".hist-report h3")).toHaveText("What came in", { timeout: 20_000 });
  await admin.page.screenshot({ path: `${SHOTS}08_guide-import-night.png` });
  await guide.locator("[data-guide-next]").click();
  await expect(guide).toContainText("matched by email");
  await guide.locator("[data-guide-next]").click();
  await guide.getByRole("button", { name: /Open #?old-projects/ }).click();
  await expect(admin.page.locator(".chat-head-name")).toHaveText("old-projects", { timeout: 10_000 });
  await expect(message(admin.page, "Shipping it Friday")).toBeVisible();
  await admin.context.close();
});

test("Inbox: Mail's Connect, after an admin sets the Google client in the wizard, flips to Connected live", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await person(browser, "Admin Person", "admin@normal.dev");
  await admin.page.goto("/#/chat/inbox");
  const mail = admin.page.locator('[data-bridge="gmail"]');
  await expect(mail).toHaveAttribute("data-state", "needs-admin", { timeout: 15_000 });
  await expect(admin.page.locator('[data-bridge="server"]')).toContainText("This Foundation");
  await admin.page.screenshot({ path: `${SHOTS}09_inbox-night.png`, fullPage: true });
  await mail.locator("[data-connect-gmail]").click();
  await expect(mail.locator("[data-needs-admin]")).toBeVisible();
  await mail.locator('[data-setup="gmail"]').click();
  const wiz = admin.page.locator('[data-wizard="gmail"]');
  await expect(wiz).toBeVisible();
  await wiz.getByRole("button", { name: "Next" }).click();
  await wiz.getByRole("button", { name: "Next" }).click();
  await wiz.locator('[data-key="GMAIL_CLIENT_ID"]').fill("e2e-client.apps.googleusercontent.com");
  await wiz.locator('[data-key="GMAIL_CLIENT_SECRET"]').fill(["e2e", "client", Date.now().toString(36)].join("-"));
  await wiz.locator('[data-check="client"]').click();
  await expect(wiz.locator("[data-check-said]")).toContainText("Both are set");
  await admin.page.screenshot({ path: `${SHOTS}10_wizard-gmail-night.png` });
  await wiz.getByRole("button", { name: "Next" }).click();
  await wiz.getByRole("button", { name: "Finish" }).click();
  await expect(mail).toHaveAttribute("data-state", "not-connected", { timeout: 10_000 });

  // Connect: the stand-in's consent page answers at once and sends the browser back to the server
  const popup = admin.page.context().waitForEvent("page");
  await mail.locator("[data-connect-gmail]").click();
  const consent = await popup;
  await expect(consent.locator("h2")).toHaveText("Mail connected", { timeout: 15_000 });
  await consent.close();
  // the card heard it (the socket, the short poll): no reload
  await expect(mail).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expect(mail.locator("[data-state-line]")).toContainText("Connected as admin@normal.dev");
  await admin.page.screenshot({ path: `${SHOTS}11_inbox-mail-connected-night.png`, fullPage: true });

  // day
  const day = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", storageState: await admin.context.storageState() });
  const dp = await day.newPage();
  await dp.goto("/#/chat/inbox");
  await expect(dp.locator('[data-bridge="gmail"]')).toHaveAttribute("data-state", "connected", { timeout: 20_000 });
  await settle(dp, 800);
  await dp.screenshot({ path: `${SHOTS}12_inbox-day.png`, fullPage: true });
  await day.close();
  await admin.context.close();
});

test("#/design: the Inbox, the wizard and the guide in the ChatForm chapter, day and night", async ({ browser }) => {
  for (const [scheme, name] of [["light", "13_design-inbox-day"], ["dark", "14_design-inbox-night"]] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-inbox-demo]");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator('[data-bridge="slack"]')).toBeVisible();
    // part by part, each scrolled into view (the design page draws what's on screen)
    const parts = demo.locator(":scope > .inbox, :scope > .design-chat-row, :scope > [data-slack-nudge]");
    for (let i = 0; i < (await parts.count()); i++) {
      await parts.nth(i).scrollIntoViewIfNeeded();
      await settle(p, 700);
      await parts.nth(i).screenshot({ path: `${SHOTS}${name}-${i + 1}.png` });
    }
    await c.close();
  }
});

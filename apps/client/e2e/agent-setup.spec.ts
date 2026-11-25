/**
 * Setting up an agent (2026-11-24, docs/agent-harness.md §1 and §4), in a real browser, on the real routes:
 * the e2e server's Anthropic is the server tests' stand-in (ANTHROPIC_BASE_URL, e2e/anthropic-standin-serve.ts),
 * so a key is checked, models are listed and a federated token is exchanged without reaching the network. The one
 * stand-in in the page is for a state the real server can't be put in: a server older than the app (404).
 * The e2e server runs the scripted agent (FOUNDATION_AGENT_SCRIPT), so each Claude way can take work here: its
 * line says so, and what it runs on (a scripted stand-in), and nothing else.
 *
 * - The first choice is the kind: Claude, or a T3 session.
 * - Claude offers exactly three ways (account on this computer, API key, federated), none says T3, and each says
 *   how it stands in one line.
 * - The key is sent once and never seen again: not in the page, not in any address asked for. The server's
 *   refusal shows in its own words; Forget… asks in place and confirms.
 * - The model list is newest first, the newest marked Latest, live from Anthropic once a key is stored.
 * - Federated identity: an admin's form, the server's refusal in its own words, saved → set (what's set, Change,
 *   Remove… asked in place); a non-admin is refused by the server (403) and gets no form.
 * - A seat's own model: picked when it's added, kept on the seat, shown in the council's agent info.
 * - A T3 session is its own kind, with its agents.
 * - The MCP commands (default and code mode) appear, with a token, only after Create a token.
 * - A section's council seats on that section, still after the council is put away.
 * - A server older than the app (404) gets today's flow and says so.
 * - Day and night, at 260, 400 and 560 px; Settings → Agents; #/design's Agent setup.
 */

import { test, expect, type Page, type BrowserContext, type Browser } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT, person, settle } from "./helpers";
import { GOOD_KEY } from "../../server/test/anthropic-standin.ts";

const SHOTS = "../../docs/evidence/2026-11-24_council-harness";
/** shaped like a key, and refused by (stand-in) Anthropic */
const BAD_KEY = ["sk", "ant", "api03", "x".repeat(40)].join("-");
const ORG = "6b5af527-c7f3-45d6-98e5-62dbdc91afcf";
/** the identity provider's token, where the server reads it (the server runs on this computer) */
const TOKEN_FILE = join(mkdtempSync(join(tmpdir(), "foundation-idp-")), "token.jwt");
writeFileSync(TOKEN_FILE, "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmb3VuZGF0aW9uIn0.");

test.describe.configure({ mode: "serial" });

let page: Page;
let ctx: BrowserContext;
/** every address the page asked for */
const asked: string[] = [];

type Status = { account: object; api: { configured: boolean; source: string | null; last4?: string; model: string }; federated: { configured: boolean; why?: string } };
const status = async (c: BrowserContext) => (await (await c.request.get(`${CLIENT}/api/agents/claude`)).json()) as Status;

const add = (p: Page = page) => p.locator("[data-add-agent]");
const way = (id: string, p: Page = page) => add(p).locator(`[data-add-way="${id}"]`);
const boardOf = (p: Page) => p.evaluate(() => (window as unknown as { __foundationBoard: () => { boardId: string } }).__foundationBoard().boardId);

async function openAdd(p: Page = page) {
  if ((await add(p).count()) === 0) {
    // the gear toggles the pane: press it only while the pane is shut
    if ((await p.locator('[data-agents-tab="add"]').count()) === 0) await p.locator("[data-hud-agents]").click();
    await p.locator('[data-agents-tab="add"]').click();
  }
  await expect(add(p)).toBeVisible();
}

/** a person who isn't an admin, in a browser of their own */
async function kai(browser: Browser) {
  return person(browser, "Kai Test", "kai@normal.dev");
}

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Admin", "admin@normal.dev");
  page = a.page;
  ctx = a.context;
  page.on("request", (r) => asked.push(r.url()));
});

test.afterAll(async () => {
  await ctx?.close();
});

test("the first choice is the kind; Claude has exactly three ways, none of them T3, each saying how it stands in one line", async () => {
  await openAdd();
  await expect(add().locator("[data-add-kind]")).toHaveCount(2);
  await expect(add().locator('[data-add-kind="claude"]')).toContainText("Run by Foundation itself");
  await expect(add().locator('[data-add-kind="t3"]')).toContainText("T3 Code runs the agent");
  await add().locator('[data-add-kind="claude"]').click();
  await expect(add().locator("[data-add-way]")).toHaveCount(3);
  expect(await add().locator("[data-add-way]").evaluateAll((ws) => ws.map((w) => (w as HTMLElement).dataset.addWay))).toEqual(["account", "api", "federated"]);
  await expect(way("account")).toContainText("Claude account on this computer");
  await expect(way("api")).toContainText("API key");
  await expect(way("federated")).toContainText("Federated identity");
  for (const id of ["account", "api", "federated"]) {
    await way(id).locator(".add-way-head").click();
    await expect(way(id).locator(".add-way-body")).toBeVisible();
    // nothing under Claude says T3, and nothing says stub
    const words = await add().locator("[data-add-connect]").innerText();
    expect(words).not.toMatch(/\bT3\b/);
    expect(words).not.toMatch(/stub/i);
    // one line for how it stands, and it agrees with the way's head
    await expect(way(id).locator("[data-setup-ready]")).toHaveCount(1);
    const ok = await way(id).getAttribute("data-add-way-ready");
    await expect(way(id).locator("[data-setup-ready]")).toHaveAttribute("data-ok", ok!);
    if (ok === "yes") await expect(way(id).locator("[data-setup-ready]")).toContainText("Ready ·");
  }
  // the account way says plainly it is this computer's sign-in, not a Claude Code window you have open
  await way("account").locator(".add-way-head").click();
  await expect(add().locator("[data-add-account-note]")).toContainText("Claude Code window you have open");
  await settle(page, 300);
  await page.screenshot({ path: `${SHOTS}/setup-01_claude-three-ways.png` });
});

test("the API key: refused in the server's own words, then stored and never seen again; Forget… asks in place", async () => {
  await way("api").locator(".add-way-head").click();
  const field = way("api").locator("[data-setup-key-input]");
  await expect(field).toHaveAttribute("type", "password");
  // a key (stand-in) Anthropic won't take: the server's own words, the field emptied
  await field.fill(BAD_KEY);
  await way("api").locator("[data-setup-key-store]").click();
  await expect(way("api").locator("[data-setup-key-error]")).toContainText("didn't accept that key", { timeout: 15_000 });
  await expect(field).toHaveValue("");
  // the good one: checked, kept, shown as its last four
  await field.fill(GOOD_KEY);
  await way("api").locator("[data-setup-key-store]").click();
  await expect(way("api").locator("[data-setup-last4]")).toHaveText(`••••${GOOD_KEY.slice(-4)}`, { timeout: 15_000 });
  await expect(way("api").locator("[data-setup-key-input]")).toHaveCount(0);
  await expect(way("api").locator("[data-setup-key-error]")).toHaveCount(0);
  // …and nowhere now: not in the page, not in a field, not in any address the page asked for
  for (const k of [GOOD_KEY, BAD_KEY]) {
    expect(await page.content()).not.toContain(k);
    expect(await page.evaluate((v) => [...document.querySelectorAll("input")].some((i) => i.value.includes(v)), k)).toBe(false);
    expect(asked.filter((u) => u.includes(k) || u.includes(encodeURIComponent(k)))).toEqual([]);
  }
  expect((await status(ctx)).api).toMatchObject({ configured: true, source: "stored", last4: GOOD_KEY.slice(-4) });
  // the model list: live from Anthropic, newest first, the newest marked Latest; never a typed model
  await expect(way("api").locator('[data-setup-models="live"]')).toBeVisible({ timeout: 10_000 });
  await expect(way("api").locator("[data-setup-models-source]")).toContainText("Live from Anthropic");
  expect(await way("api").locator("[data-setup-model]").evaluateAll((ms) => ms.map((m) => (m as HTMLElement).dataset.setupModel))).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  await expect(way("api").locator("[data-setup-model]").first()).toContainText("Latest");
  await expect(way("api").locator(".setup-latest")).toHaveCount(1);
  await expect(way("api").locator('input[type="text"]')).toHaveCount(0);
  await settle(page, 300);
  await page.screenshot({ path: `${SHOTS}/setup-02_api-key-stored-night.png` });
  // Forget… asks in place, and the server is sent confirm
  await way("api").locator("[data-setup-forget]").click();
  await expect(way("api").locator("[data-setup-confirm]")).toContainText("Forget the stored key?");
  await page.screenshot({ path: `${SHOTS}/setup-03_forget-asks.png` });
  const forgot = page.waitForRequest((r) => r.url().endsWith("/api/agents/claude/key") && r.method() === "DELETE");
  await way("api").locator("[data-setup-forget-yes]").click();
  expect(JSON.parse((await forgot).postData()!)).toEqual({ confirm: true });
  await expect(way("api").locator("[data-setup-key-input]")).toBeVisible();
  expect((await status(ctx)).api.configured).toBe(false);
});

test("federated identity: an admin's form, the server's refusal in its own words, saved and shown, removed after asking; a non-admin gets no form", async ({ browser }) => {
  await way("federated").locator(".add-way-head").click();
  const fed = way("federated");
  // not set up: the line is the server's own why, nothing else
  const why = (await status(ctx)).federated.why!;
  expect(why).toMatch(/Federated identity isn't set up/);
  await expect(fed.locator('[data-setup-fed="form"]')).toBeVisible();
  for (const f of ["organizationId", "federationRuleId", "serviceAccountId", "workspaceId", "identityTokenFile"]) await expect(fed.locator(`[data-setup-fed-input="${f}"]`)).toBeVisible();
  await expect(fed.locator(".setup-fed-hint")).toHaveCount(5);
  // a wrong id: refused, in the server's words
  await fed.locator('[data-setup-fed-input="organizationId"]').fill("not-an-org");
  await fed.locator('[data-setup-fed-input="federationRuleId"]').fill("fdrl_e2etest01");
  await fed.locator('[data-setup-fed-input="identityTokenFile"]').fill(TOKEN_FILE);
  await fed.locator("[data-setup-fed-save]").click();
  await expect(fed.locator("[data-setup-fed-error]")).toContainText("organizationId: the organization's id, a uuid");
  await page.screenshot({ path: `${SHOTS}/setup-04_federation-refused.png` });
  // right: saved, and shown as set
  await fed.locator('[data-setup-fed-input="organizationId"]').fill(ORG);
  await fed.locator('[data-setup-fed-input="workspaceId"]').fill("default");
  await fed.locator("[data-setup-fed-save]").click();
  await expect(fed.locator('[data-setup-fed="set"]')).toBeVisible();
  await expect(fed.locator('[data-setup-fed-value="organizationId"]')).toHaveText(ORG);
  await expect(fed.locator('[data-setup-fed-value="identityTokenFile"]')).toHaveText(TOKEN_FILE);
  await expect(fed.locator("[data-setup-fed-error]")).toHaveCount(0);
  await expect.poll(async () => (await status(ctx)).federated.configured).toBe(true);
  await expect(fed.locator("[data-setup-ready]")).toHaveAttribute("data-ok", "yes");
  await settle(page, 300);
  await page.screenshot({ path: `${SHOTS}/setup-05_federation-set.png` });

  // someone who isn't an admin: the server refuses them the setup, and the page offers none
  const k = await kai(browser);
  expect((await k.context.request.get(`${CLIENT}/api/agents/claude/federation`)).status()).toBe(403);
  expect((await k.context.request.put(`${CLIENT}/api/agents/claude/federation`, { data: { organizationId: ORG, federationRuleId: "fdrl_e2etest01", identityTokenFile: TOKEN_FILE } })).status()).toBe(403);
  // nor does how it stands tell them where the token is kept
  expect(JSON.stringify(await status(k.context))).not.toContain(TOKEN_FILE);
  await openAdd(k.page);
  await add(k.page).locator('[data-add-kind="claude"]').click();
  await way("federated", k.page).locator(".add-way-head").click();
  await expect(way("federated", k.page).locator("[data-setup-fed-admin]")).toContainText("An admin sets up federated identity");
  await expect(way("federated", k.page).locator("[data-setup-fed-input]")).toHaveCount(0);
  await expect(way("federated", k.page).locator("[data-setup-ready]")).toHaveCount(1);
  await k.page.screenshot({ path: `${SHOTS}/setup-06_federation-not-admin.png` });
  await k.context.close();

  // Remove… asks in place, then sends confirm; the form is back
  await fed.locator("[data-setup-fed-remove]").click();
  await expect(fed.locator("[data-setup-fed-confirm]")).toContainText("Remove federated identity?");
  const removed = page.waitForRequest((r) => r.url().endsWith("/api/agents/claude/federation") && r.method() === "DELETE");
  await fed.locator("[data-setup-fed-remove-yes]").click();
  expect(JSON.parse((await removed).postData()!)).toEqual({ confirm: true });
  await expect(fed.locator('[data-setup-fed="form"]')).toBeVisible();
  await expect.poll(async () => (await status(ctx)).federated.configured).toBe(false);
});

test("a T3 session is a kind of its own, with the agents it runs", async () => {
  await add().locator('[data-add-step="1"] .add-link').click();
  await add().locator('[data-add-kind="t3"]').click();
  await expect(add().locator("[data-add-t3-agent]")).toHaveCount(6);
  await add().locator('[data-add-t3-agent="chatgpt"]').click();
  await expect(way("t3-t3")).toContainText("Sign in with your ChatGPT account");
  await add().locator('[data-add-t3-agent="claude"]').click();
  await expect(add().locator("[data-add-way]")).toHaveCount(2);
  await settle(page, 300);
  await page.screenshot({ path: `${SHOTS}/setup-07_t3-session.png` });
});

test("Claude Code you run yourself: both commands, with a token, only after Create a token", async () => {
  // the server says it takes code mode
  const avail = (await (await ctx.request.get(`${CLIENT}/api/agents/available`)).json()) as { codeMode?: boolean };
  expect(avail.codeMode).toBe(true);
  await add().locator("[data-add-mcp-link]").first().click();
  const mcp = page.locator("[data-setup-mcp]");
  await expect(mcp).toBeVisible();
  await expect(mcp.locator("[data-setup-mcp-command]")).toHaveCount(0);
  expect(await mcp.innerText()).not.toMatch(/Bearer/);
  await mcp.locator("[data-setup-mcp-create]").click();
  await expect(mcp.locator("[data-setup-mcp-command]")).toHaveCount(2);
  const board = await boardOf(page);
  const plain = await mcp.locator('[data-setup-mcp-command="plain"]').innerText();
  const code = await mcp.locator('[data-setup-mcp-command="code"]').innerText();
  expect(plain).toMatch(/^claude mcp add foundation --transport http "https?:\/\/[^"]+\/mcp\?board=[^"&]+" --header "Authorization: Bearer [^"\s]{16,}"$/);
  expect(code).toMatch(/^claude mcp add foundation --transport http "https?:\/\/[^"]+\/mcp\?board=[^"&]+&mode=code" --header "Authorization: Bearer [^"\s]{16,}"$/);
  expect(plain).toContain(`board=${board}`);
  // one token for both, and never in the address
  expect(plain.split("Bearer ")[1]).toBe(code.split("Bearer ")[1]);
  expect(code.split('"')[1]).not.toMatch(/token|Bearer/);
  await expect(mcp.locator("[data-setup-mcp-diff]")).toContainText("seven tools");
  // the token works on the real /mcp, in code mode
  const token = plain.split("Bearer ")[1].replace(/"$/, "");
  const url = code.split('"')[1];
  const listed = await ctx.request.post(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" }, data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  expect(listed.ok(), await listed.text()).toBe(true);
  expect(await listed.text()).toContain("run_code");
  await settle(page, 300);
  await page.screenshot({ path: `${SHOTS}/setup-08_mcp-commands.png` });
  await mcp.getByRole("button", { name: "Close" }).click();
});

test("adding from a section's council seats on that section, even once the council is put away", async () => {
  const sec = await page.evaluate(() => {
    const f = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string; parent?: string }> }; setState(p: object): void } }).__foundation;
    const s = Object.values(f.getState().sections).find((x) => !x.parent)!;
    f.setState({ activeSectionId: s.id });
    return { id: s.id, name: s.name };
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.locator(".cmd-field input").fill("Council: the agents in");
  await page.locator(".cmd-row", { hasText: `Council: the agents in ${sec.name}` }).first().click();
  await expect(page.locator(".council")).toHaveAttribute("aria-label", `Council of ${sec.name}`);
  await page.locator(".council [data-council-add]").first().click();
  await expect(add()).toHaveAttribute("data-add-place", sec.id);
  await expect(add().locator(".add-lede")).toContainText(sec.name);
  // the council put away, the panel still adds to that section
  await page.keyboard.press("Escape");
  await expect(page.locator(".council")).toHaveCount(0);
  await expect(add()).toHaveAttribute("data-add-place", sec.id);
  await add().locator('[data-add-kind="claude"]').click();
  await way("account").locator(".add-way-head").click();
  await expect(way("account")).toHaveAttribute("data-add-way-ready", "yes");
  const board = await boardOf(page);
  const seated = page.waitForResponse((r) => r.url().includes(`/api/boards/${board}/agents`) && r.request().method() === "POST");
  await add().locator("[data-add-submit]").click();
  const r = await seated;
  expect(JSON.parse(r.request().postData()!)).toMatchObject({ place: sec.id, agent: "claude" });
  const { seat } = (await r.json()) as { seat: { id: string } };
  expect((await ctx.request.post(`${CLIENT}/api/boards/${board}/agents/remove`, { data: { place: sec.id, agent: seat.id } })).ok()).toBe(true);
});

test("a server older than the app: today's flow, and a line that says so", async () => {
  // the one state the real server can't be put in: it hasn't the Claude routes
  await page.route(/\/api\/agents\/claude(\/[a-z]+)?(\?.*)?$/, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) }));
  await openAdd();
  await add().locator('[data-add-kind="claude"]').click();
  await expect(add().locator("[data-add-older]").first()).toContainText("older than this app", { timeout: 10_000 });
  await expect(way("account")).toHaveAttribute("data-add-way-ready", "yes");
  await way("api").locator(".add-way-head").click();
  await expect(way("api").locator("[data-add-older]")).toContainText("older than this app");
  await page.screenshot({ path: `${SHOTS}/setup-09_older-server.png` });
  await page.unroute(/\/api\/agents\/claude(\/[a-z]+)?(\?.*)?$/);
});

test("day and night, at 260, 400 and 560 px; Settings → Agents; #/design", async ({ browser }) => {
  // set up as an admin would: a key and federated identity, so every way shows its set state
  expect((await ctx.request.put(`${CLIENT}/api/agents/claude/key`, { data: { key: GOOD_KEY } })).ok()).toBe(true);
  expect((await ctx.request.put(`${CLIENT}/api/agents/claude/federation`, { data: { organizationId: ORG, federationRuleId: "fdrl_e2etest01", identityTokenFile: TOKEN_FILE } })).ok()).toBe(true);
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Admin", email: "admin@normal.dev" } });
    await c.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
    const p = await c.newPage();
    await p.goto("/?board=company");
    await p.waitForFunction(() => (window as unknown as { __foundationBoard?: () => { status: string } | null }).__foundationBoard?.()?.status === "live", undefined, { timeout: 30_000 });
    await openAdd(p);
    await add(p).locator('[data-add-kind="claude"]').click();
    const day = scheme === "light" ? "day" : "night";
    for (const open of ["api", "federated"] as const) {
      await way(open, p).locator(".add-way-head").click();
      await expect(way(open, p).locator('[data-setup-models="live"]')).toBeVisible({ timeout: 10_000 });
      for (const w of [260, 400, 560]) {
        await p.evaluate((px) => {
          const pane = document.querySelector<HTMLElement>(".agents-pane");
          if (pane) pane.style.width = `${px}px`;
        }, w);
        await settle(p, 400);
        // nothing spills sideways at this width
        const spill = await p.evaluate(() => {
          const scroll = document.querySelector<HTMLElement>(".agents-pane .agents-scroll")!;
          return scroll.scrollWidth - scroll.clientWidth;
        });
        expect(spill, `${w}px spills`).toBeLessThanOrEqual(1);
        await way(open, p).scrollIntoViewIfNeeded();
        await p.locator(".agents-pane").screenshot({ path: `${SHOTS}/setup-1${open === "api" ? 0 : 1}_${open}-${w}-${day}.png` });
      }
    }
    // Settings → Agents: Claude's three ways, the key, the model, federation, the MCP block, T3 apart
    await p.goto("/#/settings/agents");
    const set = p.locator("[data-settings-claude]");
    await expect(set.locator("[data-settings-way]")).toHaveCount(3);
    expect(await set.innerText()).not.toMatch(/\bT3\b|stub/);
    await expect(set.locator("[data-setup-last4]")).toHaveText(`••••${GOOD_KEY.slice(-4)}`);
    await expect(set.locator("[data-setup-model]").first()).toContainText("Latest");
    await expect(set.locator('[data-setup-fed-value="organizationId"]')).toHaveText(ORG);
    await expect(p.locator("[data-settings-mcp] [data-setup-mcp-create]")).toBeVisible();
    await settle(p, 500);
    await p.screenshot({ path: `${SHOTS}/setup-15_settings-agents-${day}.png`, fullPage: true });
    // #/design → Agent setup (tall enough that a row of specimens fits the window)
    await p.setViewportSize({ width: 1440, height: 1600 });
    await p.goto("/#/design");
    const demo = p.locator('[data-design-section="Agent setup"]');
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator("[data-add-way]")).toHaveCount(9);
    const rows = demo.locator(".adapt-row");
    for (let i = 0; i < (await rows.count()); i++) {
      await rows.nth(i).scrollIntoViewIfNeeded();
      await settle(p, 500);
      await rows.nth(i).screenshot({ path: `${SHOTS}/setup-2${i}_design-${day}.png` });
    }
    await c.close();
  }
  // put back as it was, for what follows
  expect((await ctx.request.delete(`${CLIENT}/api/agents/claude/key`, { data: { confirm: true } })).ok()).toBe(true);
  expect((await ctx.request.delete(`${CLIENT}/api/agents/claude/federation`, { data: { confirm: true } })).ok()).toBe(true);
});

test("the real routes, end to end: status, a key checked with (stand-in) Anthropic and kept as its last four, the live model list, a claude-api seat with a model of its own on the grid's council", async ({ browser }) => {
  const ANTHROPIC = `http://127.0.0.1:${process.env.E2E_ANTHROPIC_PORT}`;
  const { page: p, context: c } = await person(browser, "Admin", "admin@normal.dev");
  const seen: string[] = [];
  p.on("request", (r) => seen.push(r.url()));
  // a fresh server: no key, federation not set up (its own why), the shipped model list
  const before = await status(c);
  expect(before.api).toMatchObject({ configured: false, source: null });
  expect(before.api.last4).toBeUndefined();
  expect(before.federated.configured).toBe(false);
  expect(before.federated.why ?? "").toMatch(/Federated identity isn't set up/);
  const builtin = (await (await c.request.get(`${CLIENT}/api/agents/claude/models`)).json()) as { models: Array<{ id: string }>; source: string };
  expect(builtin.source).toBe("builtin");
  expect(builtin.models[0].id).toBe("claude-opus-5-5");
  // a key that isn't one is refused before Anthropic is asked; a person who isn't an admin can't set one
  const bad = await c.request.put(`${CLIENT}/api/agents/claude/key`, { data: { key: "not-a-key" } });
  expect(bad.status()).toBe(400);
  const k = await browser.newContext();
  await k.request.post(`${CLIENT}/auth/dev`, { data: { name: "Kai Test", email: "kai@normal.dev" } });
  expect((await k.request.put(`${CLIENT}/api/agents/claude/key`, { data: { key: GOOD_KEY } })).status()).toBe(403);
  await k.close();
  expect((await status(c)).api.configured).toBe(false);

  // in the page: Claude → API key; the model waits for the key
  await openAdd(p);
  const pane = add(p);
  await expect(pane).toHaveAttribute("data-add-place", "*");
  await pane.locator('[data-add-kind="claude"]').click();
  const apiWay = way("api", p);
  await apiWay.locator(".add-way-head").click();
  await apiWay.locator("[data-setup-key-input]").fill(GOOD_KEY);
  await apiWay.locator("[data-setup-key-store]").click();
  // checked with Anthropic (the stand-in), kept, and shown only as its last four
  await expect(apiWay.locator("[data-setup-last4]")).toHaveText(`••••${GOOD_KEY.slice(-4)}`, { timeout: 20_000 });
  await expect(apiWay.locator("[data-setup-key-input]")).toHaveCount(0);
  expect(await p.content()).not.toContain(GOOD_KEY);
  expect(seen.filter((u) => u.includes(GOOD_KEY))).toEqual([]);
  const after = await status(c);
  expect(after.api).toMatchObject({ configured: true, source: "stored", last4: GOOD_KEY.slice(-4) });
  expect(JSON.stringify(after)).not.toContain(GOOD_KEY);
  // the stand-in was asked for its models with the key in a header, never in an address
  const askedA = (await (await c.request.get(`${ANTHROPIC}/_seen`)).json()) as Array<{ method: string; path: string; withKey: boolean; keyInPath: boolean }>;
  expect(askedA.some((a) => a.path === "/v1/models" && a.withKey)).toBe(true);
  expect(askedA.filter((a) => a.keyInPath)).toEqual([]);
  // the list is Anthropic's own now, newest first, the newest marked Latest
  await expect(apiWay.locator('[data-setup-models="live"]')).toBeVisible({ timeout: 10_000 });
  expect(await apiWay.locator("[data-setup-model]").evaluateAll((ms) => ms.map((m) => (m as HTMLElement).dataset.setupModel))).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  // choosing one gives this seat its own model; the server's default is left as it was
  const defaultBefore = (await status(c)).api.model;
  await apiWay.locator('[data-setup-model="claude-haiku-5-5"]').click();
  await expect(apiWay.locator('[data-setup-model="claude-haiku-5-5"]')).toHaveAttribute("aria-checked", "true");
  await expect(apiWay.locator("[data-setup-seat-model]")).toContainText("This seat runs the one chosen here");
  await expect(apiWay).toHaveAttribute("data-add-way-ready", "yes");
  await settle(p, 300);
  await p.screenshot({ path: `${SHOTS}/setup-12_real-routes-seat-model.png` });

  // seated on the grid's council, with its kind and its own model
  const seated = p.waitForResponse((r) => /\/api\/boards\/[^/]+\/agents$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await pane.locator("[data-add-submit]").click();
  const res = await seated;
  expect(res.ok(), await res.text()).toBe(true);
  expect(JSON.parse(res.request().postData()!)).toMatchObject({ place: "*", agent: "claude-api", model: "claude-haiku-5-5" });
  const { seat } = (await res.json()) as { seat: { id: string; key: string; kind: string; alias: string; model?: string } };
  expect(seat).toMatchObject({ key: "claude-api", kind: "claude-api", model: "claude-haiku-5-5" });
  expect((await status(c)).api.model).toBe(defaultBefore);
  // a model for a seat that can't take one, or not on the live list, is refused
  const board = await boardOf(p);
  expect((await c.request.post(`${CLIENT}/api/boards/${board}/agents`, { data: { place: "*", agent: "claude", model: "claude-haiku-5-5" } })).status()).toBe(400);
  expect((await c.request.post(`${CLIENT}/api/boards/${board}/agents`, { data: { place: "*", agent: "claude-api", model: "claude-imaginary-9" } })).status()).toBe(400);
  await p.keyboard.press("Escape");
  if ((await p.locator(".council").count()) === 0) await p.locator("[data-council-open]").click();
  const onCouncil = p.locator(`.council [data-council-seat="${seat.alias}"]`);
  await expect(onCouncil).toBeVisible({ timeout: 10_000 });
  await expect(onCouncil).toHaveAttribute("data-council-agent", "claude-api");
  await expect(onCouncil.locator("[data-council-offline]")).toHaveCount(0);
  // its details say the model it runs
  await onCouncil.locator(".council-bar-who").click();
  await expect(p.locator("[data-agent-info] .agent-info-code")).toHaveText("claude-haiku-5-5");
  await settle(p, 600);
  await p.screenshot({ path: `${SHOTS}/setup-13_real-routes-seated.png` });

  // put back as it was: the seat off, the key forgotten (with confirm; without, refused)
  expect((await c.request.post(`${CLIENT}/api/boards/${board}/agents/remove`, { data: { place: "*", agent: seat.id } })).ok()).toBe(true);
  expect((await c.request.delete(`${CLIENT}/api/agents/claude/key`, { data: {} })).status()).toBe(400);
  expect((await c.request.delete(`${CLIENT}/api/agents/claude/key`, { data: { confirm: true } })).ok()).toBe(true);
  expect((await status(c)).api.configured).toBe(false);
  await c.close();
});

/**
 * The agent group of a section, and the agents pane (2026-11-12), checked by
 * a second person. Ada asks aloud for a section with two helpers; the agents
 * run on the server's script runtime (the real board tools, no model).
 *
 * Kai, in his own browser:
 * - nothing stands above a section nobody works in;
 * - the agents that come into “Depot” join its group, one face each, and the
 *   group is up while his pointer is on the section and gone when it leaves;
 * - pinned, it stays up with the pointer elsewhere;
 * - a lead and its helpers read as one team (“working together”);
 * - the group opens into the agents pane on the right: the section first, its
 *   team in one block, lead first, and search gives way to it;
 * - when the work is done the agents leave the group, and the pinned tab says
 *   nobody's here.
 * - #/design, day and night.
 */

import { test, expect, type Page } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-12_section-agents";
let ada: Page;
let kai: Page;
let board = "";

test.describe.configure({ mode: "serial" });

const sectionId = (p: Page, name: string) =>
  p.evaluate((n) => {
    const st = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> } } }).__foundation.getState();
    return Object.values(st.sections).find((s) => s.name === n)?.id ?? null;
  }, name);

const frame = (p: Page, id: string | null) => p.evaluate((sid) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id: sid, nonce: Math.random() } }), id);

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await a.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Section agents ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  // a microphone stand-in that says whatever the test set in __say
  await a.context.addInitScript(() => {
    class FakeRecognition {
      lang = "en-GB";
      interimResults = true;
      continuous = false;
      onresult: (e: unknown) => void = () => {};
      onend: () => void = () => {};
      onerror: (e: unknown) => void = () => {};
      private timers: number[] = [];
      private ended = false;
      start() {
        const words = (window as unknown as { __say?: string[] }).__say ?? [];
        words.forEach((w, i) => this.timers.push(window.setTimeout(() => this.onresult({ results: [[{ transcript: w }]] }), 500 + i * 300)));
      }
      stop() {
        if (this.ended) return;
        this.ended = true;
        window.setTimeout(() => this.onend(), 30);
      }
      abort() {
        this.timers.forEach(clearTimeout);
      }
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  });
  ada = a.page;
  await ada.goto(`/?board=${board}`);
  kai = (await person(browser, "Kai Test", "kai@normal.dev", board)).page;
  for (const p of [ada, kai]) await p.waitForFunction(() => (window as unknown as { __foundationBoard: () => { status: string } }).__foundationBoard()?.status === "live");
  await settle(ada, 800);
});

test("agents that come into a section join its group; hover shows it, a pin keeps it, and it opens into the pane", async () => {
  // nobody at work: no section has a group
  await expect(kai.locator(".sec-crew")).toHaveCount(0);

  await ada.evaluate(() => ((window as unknown as { __say: string[] }).__say = ["make a section called “Depot” with the parts, and get two helpers"]));
  await ada.mouse.move(700, 500);
  await ada.keyboard.down("Space");
  await expect(ada.locator(".talk-heard")).toContainText("two helpers", { timeout: 4000 });
  await ada.keyboard.up("Space");

  const depot = await expect.poll(() => sectionId(kai, "Depot"), { timeout: 10_000 }).not.toBeNull().then(() => sectionId(kai, "Depot"));
  await frame(kai, depot);
  const card = kai.locator(`.section-card[data-section-id="${depot}"]`);
  const group = card.locator("> .sec-crew");

  // the lead is in Depot: its face is in the group
  await expect(group.locator(".crew-face")).toHaveCount(1, { timeout: 8000 });
  const lead = await group.locator(".crew-face").first().getAttribute("data-crew-face");
  expect(lead, "the lead has a name").toBeTruthy();

  // the pointer elsewhere: the group waits, unseen
  await kai.mouse.move(8, 880);
  await expect(group).toHaveCSS("opacity", "0", { timeout: 3000 });
  // on the section: it shows. Depot fills the view (its top edge is at the top bar), so the tab has come
  // down with the view: it's on the paper, under the bar, inside the section
  await card.hover({ position: { x: 200, y: 300 } });
  await expect(group).toHaveCSS("opacity", "1", { timeout: 3000 });
  await expect(group).toHaveClass(/is-stuck/);
  const stuck = (await group.boundingBox())!;
  expect(stuck.y, "under the top bar").toBeGreaterThanOrEqual(44);
  expect(stuck.x > 0 && stuck.x + stuck.width < 1440, "on screen").toBeTruthy();
  await kai.screenshot({ path: `${SHOTS}/00_kai-depot-fills-the-view.png` });
  // the whole board in view: the tab stands above the section's top edge
  await kai.keyboard.press("0");
  await settle(kai, 1100);
  await card.hover({ position: { x: 60, y: 60 } });
  await expect(group).not.toHaveClass(/is-stuck/);
  // at screen size, whatever the zoom: the tab is as tall on screen as it's drawn
  const [g, c] = [await group.boundingBox(), await card.boundingBox()];
  expect(Math.abs((g?.height ?? 0) - 30), `the tab's height on screen: ${g?.height}`).toBeLessThan(1.5);
  expect(g && c && g.y + g.height <= c.y + 1, `the tab is above the section (tab bottom ${g && g.y + g.height}, section top ${c?.y})`).toBeTruthy();

  // pinned: it stays with the pointer gone
  await group.locator(".sec-crew-btn").first().click();
  await expect(group).toHaveClass(/is-pinned/);
  await kai.mouse.move(8, 880);
  await settle(kai, 500);
  await expect(group).toHaveCSS("opacity", "1");

  // a helper comes in: it joins the group, and the lead and its helper are one team
  await expect.poll(() => group.locator(".crew-face").count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(group.locator(".sec-crew-team.is-together .crew-face").first()).toHaveAttribute("data-crew-face", lead!);
  await expect(group.locator(".sec-crew-words")).toHaveText("working together");
  await kai.screenshot({ path: `${SHOTS}/01_kai-depot-group-pinned.png` });

  // opened large, on the right: Depot first, its team in one block with the lead first
  await group.locator(".sec-crew-btn").nth(1).click();
  const pane = kai.locator(".agents-pane");
  await expect(pane).toBeVisible();
  const place = pane.locator(".agents-place").first();
  await expect(place).toHaveAttribute("data-agents-place", "Depot");
  await expect(place).toHaveClass(/is-at/);
  await expect(place.locator(".agents-team.is-together .agent-row").first()).toHaveAttribute("data-agent-row", lead!, { timeout: 8000 });
  await expect(place.locator(".agents-team.is-together .agents-team-label")).toContainText("Working together");
  await expect(place.locator(".agents-team.is-together .agent-row-role").first()).toHaveText("lead");
  await expect(place.locator(".agents-team.is-together .agent-row-role").nth(1)).toHaveText("helper");
  // Kai didn't ask: he can follow, but there's nothing of his to open or stop
  await expect(place.locator(".crew-row-btn.is-stop")).toHaveCount(0);
  await settle(kai, 700); // the grid's cards slide out from under the pane
  await kai.screenshot({ path: `${SHOTS}/02_kai-agents-pane.png` });

  // Ada asked: her pane has Open and Stop on her lead
  await ada.locator("[data-hud-agents]").click();
  await expect(ada.locator(".agents-pane .agent-row").first().locator(".crew-row-btn", { hasText: "Open" })).toBeVisible({ timeout: 8000 });
  await settle(ada, 700);
  await ada.screenshot({ path: `${SHOTS}/03_ada-agents-pane.png` });

  // search takes the pane's place, and gives it back
  await kai.locator(".hud-search").click();
  await kai.locator("[data-search-pin]").click();
  await expect(kai.locator(".search-pane")).toBeVisible();
  await expect(pane).toHaveCount(0);
  await kai.locator("[data-hud-agents]").click();
  await expect(pane).toBeVisible();
  await expect(kai.locator(".search-pane")).toHaveCount(0);

  // the work ends: the agents leave the group; pinned, the tab says nobody's here
  await expect(kai.locator(".crew-cursor")).toHaveCount(0, { timeout: 40_000 });
  await expect(group.locator(".crew-face")).toHaveCount(0, { timeout: 8000 });
  await expect(group).toHaveText(/No agents here/);
  await expect(pane.locator(".agents-head-n")).toHaveText("none at work");
  await kai.screenshot({ path: `${SHOTS}/04_kai-after-the-work.png` });

  // unpinned and empty: nothing stands above the section
  await group.locator(".sec-crew-btn").first().click();
  await expect(card.locator("> .sec-crew")).toHaveCount(0);
});

test("a section doesn't render because someone moved a pointer", async () => {
  const renders = () => kai.evaluate(() => (window as unknown as { __renders?: Record<string, number> }).__renders?.SectionView ?? -1);
  const before = await renders();
  test.skip(before < 0, "render counts aren't on in this build");
  for (let i = 0; i < 30; i++) await ada.mouse.move(300 + i * 12, 300 + (i % 5) * 20);
  await settle(kai, 400);
  expect(await renders(), "SectionView renders while Ada's pointer moved").toBe(before);
});

test("agents in a section on #/design, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const demo = p.locator(".sec-crew-demo").first();
    await demo.scrollIntoViewIfNeeded();
    await settle(p, 900);
    await demo.screenshot({ path: `${SHOTS}/05_design-${scheme === "dark" ? "night" : "day"}.png` });
    await ctx.close();
  }
});

test("this computer's agents: a person starts T3, asks an agent in a section, and it joins that section's group", async ({ browser }) => {
  // (this server's T3 is a stand-in that speaks T3's start, sign-in and streams: apps/server/test/t3-standin.mjs. No model runs.)
  // the admin signs in first: dev sign-in is refused while T3 runs (its agents have a shell here; ADR-001 G0)
  const admin = (await person(browser, "Root Test", "admin@normal.dev", board)).page;
  const pane = kai.locator(".agents-pane");
  await expect(pane).toBeVisible();
  const t3 = pane.locator(".t3-block");
  await expect(t3).toHaveAttribute("data-t3", "off");
  await expect(t3).toContainText("a person starts it");
  // an agent's token can't start it: only a person's browser
  const refused = await kai.context().request.post(`${CLIENT}/api/t3host/start`, { headers: { authorization: "Bearer not-a-person" }, failOnStatusCode: false });
  expect([401, 403]).toContain(refused.status());
  await expect(t3).toHaveAttribute("data-t3", "off");

  await t3.locator(".t3-start").click();
  await expect(t3).toHaveAttribute("data-t3", "running", { timeout: 15_000 });
  const cloud = t3.locator('[data-t3-where="cloud"]');
  await expect(cloud.locator('[data-t3-agent="claudeAgent"]')).toContainText("Team Subscription");
  await expect(cloud.locator('[data-t3-agent="codex"]')).toContainText("not installed on this computer");
  await expect(t3).toContainText("On this computer");
  await expect(t3).toContainText("None yet");
  // Codex can't take work: no Ask on it. Kai is a member: he can't add agents
  await expect(cloud.locator('[data-t3-agent="codex"] .crew-row-btn', { hasText: "Ask" })).toHaveCount(0);
  await expect(t3.locator(".t3-add-open")).toHaveCount(0);

  // Kai asks Claude for something in Depot
  const depot = await sectionId(kai, "Depot");
  await kai.locator(`.section-card[data-section-id="${depot}"] .section-header`).click({ position: { x: 200, y: 10 } });
  const claude = cloud.locator('[data-t3-agent="claudeAgent"]');
  await claude.locator(".crew-row-btn", { hasText: "Ask" }).click();
  await expect(claude.locator(".t3-ask-text")).toHaveAttribute("placeholder", "What should Claude do in Depot?");
  await expect(claude.locator(".t3-ask-note").last()).toContainText("writes the board");
  await claude.locator(".t3-ask-text").fill("Check the unit prices against the supplier list");
  await claude.locator(".t3-ask-model").selectOption("claude-haiku-4-5");
  await kai.screenshot({ path: `${SHOTS}/06_kai-asks-claude.png` });
  await claude.locator(".t3-ask-send").click();

  // Claude joins Depot's group, under its own name, on Ada's screen too; the pane lists it in Depot, for Kai
  const face = (p: Page) => p.locator(`.section-card[data-section-id="${depot}"] > .sec-crew .crew-face[data-crew-face="Claude"]`);
  await expect(face(kai)).toHaveCount(1, { timeout: 8000 });
  await expect(face(ada)).toHaveCount(1, { timeout: 8000 });
  await expect(pane.locator('.agents-place[data-agents-place="Depot"] .agent-row[data-agent-row="Claude"]')).toContainText("Check the unit prices");
  await expect(claude.locator(".t3-work")).toContainText("working", { timeout: 8000 });
  await kai.locator(`.section-card[data-section-id="${depot}"]`).hover({ position: { x: 300, y: 300 } });
  await settle(kai, 500);
  await kai.screenshot({ path: `${SHOTS}/07_kai-claude-in-depot.png` });
  // with its pass to the board, the agent's card lands in Depot under its own name, on both screens
  // (the stand-in uses the tool file in its folder the way an agent would: one note)
  type Note = { name: string; sectionId: string; createdBy?: string };
  const claudesNote = (p: Page) => p.evaluate((id) => Object.values((window as unknown as { __foundation: { getState(): { notes: Record<string, Note> } } }).__foundation.getState().notes).filter((n) => n.sectionId === id && n.name === "Checked by Claude").map((n) => n.createdBy), depot);
  await expect.poll(() => claudesNote(kai), { timeout: 8000 }).toEqual(["Claude"]);
  await expect.poll(() => claudesNote(ada), { timeout: 8000 }).toEqual(["Claude"]);
  await kai.screenshot({ path: `${SHOTS}/07b_claudes-card-in-depot.png` });
  // the thread ends (the stand-in finishes it): Claude leaves the group
  await expect(face(kai)).toHaveCount(0, { timeout: 20_000 });
  await expect(claude.locator(".t3-work")).toHaveCount(0);
  // while T3 runs, nobody else signs in without a password
  const late = await browser.newContext();
  const devRefused = await late.request.post(`${CLIENT}/auth/dev`, { data: { name: "Late Test", email: "late@normal.dev" }, failOnStatusCode: false });
  expect(devRefused.status()).toBe(403);
  expect(await devRefused.text()).toContain("T3 is running");
  await late.close();

  // an admin adds Kimi (cloud, a key) and DeepSeek (this computer, no key): two groups
  await admin.locator("[data-hud-agents]").click();
  const at3 = admin.locator(".agents-pane .t3-block");
  await expect(at3).toHaveAttribute("data-t3", "running", { timeout: 8000 });
  await at3.locator(".t3-add-open").click();
  const form = at3.locator(".t3-add");
  await expect(form).toContainText("api.moonshot.ai");
  await expect(form.locator(".t3-add-go")).toBeDisabled(); // no key yet
  await form.locator('input[type="password"]').fill("sk-test-not-a-real-key");
  await form.locator(".t3-add-go").click();
  await expect(at3.locator('[data-t3-where="cloud"] [data-t3-agent="kimi-cloud"]')).toContainText("api.moonshot.ai", { timeout: 8000 });
  await at3.locator(".t3-add-open").click();
  await form.locator(".pane-seg-btn", { hasText: "DeepSeek" }).click();
  await form.locator(".pane-seg-btn", { hasText: "This computer" }).click();
  await expect(form).toContainText("nothing leaves the computer");
  await expect(form.locator('input[type="password"]')).toHaveCount(0);
  await expect(form.locator(".t3-add-note")).toContainText("No model server answers", { timeout: 6000 });
  await form.locator(".t3-field input").first().fill("deepseek-r1:14b");
  await admin.screenshot({ path: `${SHOTS}/08_admin-adds-deepseek-local.png` });
  await form.locator(".t3-add-go").click();
  await expect(at3.locator('[data-t3-where="local"] [data-t3-agent="deepseek-local"]')).toContainText("127.0.0.1:11434", { timeout: 8000 });
  await expect(at3.locator('[data-t3-where="cloud"] [data-t3-agent="deepseek-local"]')).toHaveCount(0);
  // the key isn't anywhere on the page or in what the server says
  expect(await admin.content()).not.toContain("sk-test-not-a-real-key");
  expect(JSON.stringify(await (await admin.context().request.get(`${CLIENT}/api/t3host`)).json())).not.toContain("sk-test-not-a-real-key");
  await at3.scrollIntoViewIfNeeded();
  await admin.screenshot({ path: `${SHOTS}/09_admin-cloud-and-local.png` });
  // Kai sees both groups too (the pane reads T3 every few seconds)
  await expect(t3.locator('[data-t3-where="local"] [data-t3-agent="deepseek-local"]')).toHaveCount(1, { timeout: 8000 });
  // T3 stops before anyone else signs in (the next check, and the files after this one)
  expect((await admin.context().request.post(`${CLIENT}/api/t3host/stop`)).ok()).toBeTruthy();
  await admin.context().close();
});

// T3 stops before the next checks sign in (dev sign-in is refused while it runs)
test.afterAll(async () => {
  await kai?.context().request.post(`${CLIENT}/api/t3host/stop`, { failOnStatusCode: false });
});

test("this computer's agents on #/design, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const demo = p.locator('.sec-crew-demo .t3-block[data-t3="running"]').first();
    await demo.scrollIntoViewIfNeeded();
    await settle(p, 900);
    await p.locator(".sec-crew-demo .adapt-row").nth(1).screenshot({ path: `${SHOTS}/10_design-t3-${scheme === "dark" ? "night" : "day"}.png` });
    await expect(demo.locator('[data-t3-where="cloud"] .t3-agent')).toHaveCount(3);
    await expect(demo.locator('[data-t3-where="local"] .t3-agent')).toHaveCount(1);
    await expect(demo.locator(".t3-off").last()).toHaveText("Off in T3: Cursor, Grok");
    await ctx.close();
  }
});

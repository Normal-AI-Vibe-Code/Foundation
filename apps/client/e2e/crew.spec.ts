/**
 * The crew, checked by a second person and the board itself (2026-11-07).
 * Ada holds Space and asks aloud (a stand-in recogniser hears her); the agent
 * runs on the server's script runtime (FOUNDATION_AGENT_SCRIPT=1: the real
 * board tools, no model), so this is the same every time.
 *
 * - Space: held, the sheet rises and listens; a pointer pressed meanwhile is
 *   a pan and it stands down; a tap types instead.
 * - Kai, in his own browser, sees each agent by name, and its cursor is
 *   already in the section when the card it's making appears there.
 * - A lead calls in a helper: two named cursors, both signing the activity.
 * - Ada's view is brought to the section; Kai's isn't moved. Back returns Ada.
 * - Busy moving, Ada is asked first (Go) instead of being moved.
 * - Stop stops an agent; no cursor is left behind on either screen.
 * - #/design, day and night.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { CLIENT, person, settle } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-07_crew";
/** 2026-11-08: helpers that see each other's work, and people's own edits in the log */
const SHOTS2 = "../../docs/evidence/2026-11-08_crew-next";
let ada: Page;
let kai: Page;
let adaCtx: BrowserContext;
let board = "";

test.describe.configure({ mode: "serial" });

/** what the recogniser "hears" next: set per test before Space goes down */
async function willSay(p: Page, words: string[]) {
  await p.evaluate((w) => ((window as unknown as { __say: string[] }).__say = w), words);
}

/** two camera transforms within a couple of px (a spring settling), not a move somewhere else */
function sameView(a: string, b: string, px = 2) {
  const n = (s: string) => (s.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const x = n(a), y = n(b);
  return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < px);
}

const worldTransform = (p: Page) => p.evaluate(() => (document.querySelector(".world") as HTMLElement).style.transform);

const sectionId = (p: Page, name: string) =>
  p.evaluate((n) => {
    const st = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> } } }).__foundation.getState();
    return Object.values(st.sections).find((s) => s.name === n)?.id ?? null;
  }, name);

/** Kai's log: when each crew cursor first aimed at what, where it stood, and when each card first appeared */
async function startLog(p: Page) {
  await p.evaluate(() => {
    type Log = { names: string[]; aims: Array<{ t: number; name: string; target: string }>; born: Record<string, { t: number; section: string; kind: string; name: string }>; cursorAtBirth: Record<string, Array<{ name: string; x: number; y: number }>>; secAtBirth: Record<string, { left: number; right: number; top: number; bottom: number } | null> };
    const log: Log = { names: [], aims: [], born: {}, cursorAtBirth: {}, secAtBirth: {} };
    (window as unknown as { __crewLog: Log }).__crewLog = log;
    const st = () => (window as unknown as { __foundation: { getState(): Record<string, Record<string, { id: string; sectionId: string; name: string }>> } }).__foundation.getState();
    const known = new Set<string>();
    for (const k of ["notes", "tables", "panels", "maps", "media"]) for (const id of Object.keys(st()[k])) known.add(id);
    const last = new Map<string, string>();
    const tick = () => {
      const now = performance.now();
      const cursors = [...document.querySelectorAll<HTMLElement>(".crew-cursor")];
      for (const c of cursors) {
        const name = c.dataset.crewName!;
        if (!log.names.includes(name)) log.names.push(name);
        const target = c.dataset.target ?? "";
        if (target && last.get(name) !== target) {
          last.set(name, target);
          log.aims.push({ t: now, name, target });
        }
      }
      for (const k of ["notes", "tables", "panels"]) {
        for (const o of Object.values(st()[k])) {
          if (known.has(o.id)) continue;
          known.add(o.id);
          log.born[o.id] = { t: now, section: o.sectionId, kind: k, name: o.name };
          // the section's place on screen at the same instant (Kai's camera moves too)
          const sec = document.querySelector(`.section-card[data-section-id="${o.sectionId}"]`)?.getBoundingClientRect();
          log.secAtBirth[o.id] = sec ? { left: sec.left, right: sec.right, top: sec.top, bottom: sec.bottom } : null;
          log.cursorAtBirth[o.id] = cursors.map((c) => {
            const r = c.getBoundingClientRect();
            return { name: c.dataset.crewName!, x: r.left, y: r.top };
          });
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  adaCtx = a.context;
  const made = await a.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Crew ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  // a microphone stand-in that says whatever the test set in __say, a word group at a time
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

test("hold Space: the sheet rises and listens; a pan stands it down; a tap types", async () => {
  await willSay(ada, ["make a section"]);
  await ada.mouse.move(700, 500);
  await ada.keyboard.down("Space");
  await expect(ada.locator('.talk-sheet[data-mode="listening"]')).toBeVisible();
  // a pointer pressed while Space is held is a pan: the sheet stands down before it has heard anything
  await ada.mouse.down();
  await ada.mouse.move(640, 470, { steps: 4 });
  await ada.mouse.up();
  await ada.keyboard.up("Space");
  await expect(ada.locator(".talk-sheet")).toHaveCount(0);
  // a quick tap types instead
  await ada.keyboard.press("Space");
  await expect(ada.locator('.talk-sheet[data-mode="typing"] .talk-field')).toBeFocused();
  await ada.screenshot({ path: `${SHOTS}/01_tap-space-types.png` });
  await ada.keyboard.press("Escape");
  await expect(ada.locator(".talk-sheet")).toHaveCount(0);
});

test("asked aloud, an agent goes to work in the open: Kai sees its cursor reach the section before each card lands", async () => {
  await startLog(kai);
  const adaBefore = await worldTransform(ada);
  await willSay(ada, ["make a section called", "make a section called “Supply” with the parts, hook up FactoryForm, and get help"]);
  await ada.keyboard.down("Space");
  await expect(ada.locator(".talk-heard")).toContainText("hook up FactoryForm", { timeout: 4000 });
  await ada.screenshot({ path: `${SHOTS}/02_ada-holding-space.png` });
  await ada.keyboard.up("Space");

  // the crew at work, in Ada's sheet, and Kai's view of it
  await expect(ada.locator(".crew-row.is-mine").first()).toBeVisible({ timeout: 5000 });
  const supply = await expect.poll(() => sectionId(kai, "Supply"), { timeout: 10_000 }).not.toBeNull().then(() => sectionId(kai, "Supply"));
  // Kai frames the new section so he can watch the work land
  await kai.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), supply);
  await expect(kai.locator(".crew-cursor").first()).toBeVisible({ timeout: 5000 });
  // a framing of his own (a step out, the whole section in view), so the agent bringing *Ada* to Supply would show if it moved Kai too
  await settle(kai, 700);
  await kai.keyboard.press("-");
  await settle(kai, 900);
  const kaiOwn = await worldTransform(kai);
  // photographed once a crew cursor is really on his screen (clear of the top bar)
  await kai.waitForFunction(() => [...document.querySelectorAll(".crew-cursor.is-placed")].some((c) => {
    const r = c.getBoundingClientRect();
    return r.left > 0 && r.right < innerWidth - 200 && r.top > 70 && r.bottom < innerHeight - 140;
  }), undefined, { timeout: 8000 });
  await kai.screenshot({ path: `${SHOTS}/03_kai-watches-the-crew.png` });

  // Ada is brought to the section; Kai isn't moved
  await expect(ada.locator('.crew-guide[data-mode="brought"]')).toContainText("brought you to Supply", { timeout: 25_000 });
  await settle(ada, 900);
  await ada.screenshot({ path: `${SHOTS}/04_ada-brought-to-supply.png` });
  expect(await worldTransform(ada)).not.toBe(adaBefore);
  await expect(kai.locator(".crew-guide")).toHaveCount(0);

  const log = (await kai.evaluate(() => (window as unknown as { __crewLog: unknown }).__crewLog)) as {
    names: string[];
    aims: Array<{ t: number; name: string; target: string }>;
    born: Record<string, { t: number; section: string; kind: string; name: string }>;
    cursorAtBirth: Record<string, Array<{ name: string; x: number; y: number }>>;
    secAtBirth: Record<string, { left: number; right: number; top: number; bottom: number } | null>;
  };
  // two agents (the lead and the helper it called in), each by name
  expect(log.names.length, `names seen by Kai: ${log.names}`).toBeGreaterThanOrEqual(2);
  // each card the crew made in Supply: some agent had aimed at Supply (or the card) before it appeared,
  // and that agent's cursor stood inside the section when it did
  const made = Object.entries(log.born).filter(([, b]) => b.section === supply);
  expect(made.length, "cards made in Supply").toBeGreaterThanOrEqual(4);
  const lead: Array<{ card: string; ms: number }> = [];
  for (const [id, b] of made) {
    const aimed = log.aims.filter((a) => (a.target === supply || a.target === id) && a.t <= b.t);
    expect(aimed.length, `${b.name}: no cursor aimed at Supply before it appeared`).toBeGreaterThan(0);
    lead.push({ card: b.name, ms: Math.round(b.t - aimed[0].t) });
    const secRect = log.secAtBirth[id];
    expect(secRect, `${b.name}: its section wasn't drawn when it appeared`).toBeTruthy();
    const near = log.cursorAtBirth[id].some((c) => c.x >= secRect!.left - 4 && c.x <= secRect!.right && c.y >= secRect!.top - 4 && c.y <= secRect!.bottom);
    expect(near, `${b.name}: no crew cursor inside Supply when it appeared`).toBeTruthy();
  }
  console.log("cursor ahead of the card (ms):", JSON.stringify(lead));

  // Kai's camera stayed where he put it while Ada was brought to Supply
  const kaiAfter = await worldTransform(kai);
  expect(sameView(kaiAfter, kaiOwn), `Kai moved: ${kaiOwn} → ${kaiAfter}`).toBeTruthy();

  // the board's own activity says which agent did what
  const acts = (await kai.evaluate(() => (window as unknown as { __foundationBoard: () => { activity(): Array<{ who: string; role: string; text: string }> } }).__foundationBoard().activity())).filter((a) => a.role === "agent");
  const signers = new Set(acts.map((a) => a.who));
  for (const n of log.names) expect(signers.has(n), `${n} signed nothing: ${[...signers]}`).toBeTruthy();

  // Back returns Ada to where she was
  await ada.locator(".crew-guide-back").click();
  await settle(ada, 1400);
  const back = await worldTransform(ada);
  expect(sameView(back, adaBefore), `Back: ${back} vs ${adaBefore}`).toBeTruthy();

  // and when the work is done, nobody's left on either screen
  await expect(ada.locator(".crew-cursor")).toHaveCount(0, { timeout: 15_000 });
  await expect(kai.locator(".crew-cursor")).toHaveCount(0, { timeout: 5000 });
});

test("busy moving, Ada is asked first instead of moved", async () => {
  await willSay(ada, ["put notes in “Elsewhere”"]);
  await ada.keyboard.down("Space");
  await expect(ada.locator(".talk-heard")).toContainText("Elsewhere", { timeout: 4000 });
  await ada.keyboard.up("Space");
  // Ada keeps working the board (wheel nudges) while the agent works
  let asked = false;
  let before = "";
  for (let i = 0; i < 80 && !asked; i++) {
    before = await worldTransform(ada);
    await ada.mouse.move(400 + (i % 5) * 10, 600);
    await ada.mouse.wheel(0, i % 2 ? 2 : -2);
    await ada.waitForTimeout(250);
    asked = (await ada.locator('.crew-guide[data-mode="asked"]').count()) > 0;
  }
  expect(asked, "asked first while busy").toBeTruthy();
  await expect(ada.locator(".crew-guide")).toContainText("wants to show you Elsewhere");
  await ada.screenshot({ path: `${SHOTS}/05_asked-first-while-busy.png` });
  // not moved: the camera is where Ada's own wheel left it
  await settle(ada, 900);
  const still = await worldTransform(ada);
  await settle(ada, 900);
  expect(sameView(await worldTransform(ada), still), "not moved while asking").toBeTruthy();
  void before;
  await ada.locator(".crew-guide .f-pill.is-agent").click(); // Go
  await settle(ada, 1200);
  expect(sameView(await worldTransform(ada), still, 20), "Go moved the view").toBeFalsy();
  await expect(ada.locator('.crew-guide[data-mode="brought"]')).toBeVisible();
});

test("Stop stops an agent; nothing is left behind", async () => {
  await expect(ada.locator(".crew-cursor")).toHaveCount(0, { timeout: 15_000 });
  const count = () => kai.evaluate(() => Object.keys((window as unknown as { __foundation: { getState(): { tables: object } } }).__foundation.getState().tables).length);
  await willSay(ada, ["make a section called “Stopped” with the parts"]);
  await ada.keyboard.down("Space");
  await expect(ada.locator(".talk-heard")).toContainText("Stopped", { timeout: 4000 });
  await ada.keyboard.up("Space");
  const stop = ada.locator(".crew-row.is-mine .crew-row-btn.is-stop").first();
  await expect(stop).toBeVisible({ timeout: 5000 });
  await stop.click();
  await expect(kai.locator(".crew-cursor.is-stopped")).toHaveCount(1, { timeout: 5000 });
  await kai.screenshot({ path: `${SHOTS}/06_stopped-seen-by-kai.png` });
  const tables = await count();
  await settle(kai, 2500);
  expect(await count(), "no more cards after Stop").toBe(tables);
  await expect(kai.locator(".crew-cursor")).toHaveCount(0, { timeout: 6000 });
  await expect(ada.locator(".crew-cursor")).toHaveCount(0, { timeout: 2000 });
});

test("two helpers see the lead's plan and each other's work: one supplier list, not two; Kai's own edit is his in the log", async () => {
  await expect(ada.locator(".crew-cursor")).toHaveCount(0, { timeout: 15_000 });
  await startLog(kai);
  await willSay(ada, ["make a section called “Shared” with the parts, and get two helpers"]);
  await ada.keyboard.down("Space");
  await expect(ada.locator(".talk-heard")).toContainText("two helpers", { timeout: 4000 });
  await ada.keyboard.up("Space");
  const shared = await expect.poll(() => sectionId(kai, "Shared"), { timeout: 10_000 }).not.toBeNull().then(() => sectionId(kai, "Shared"));
  await kai.evaluate((id) => (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: { kind: "section", id, nonce: Math.random() } }), shared);
  // the lead and both helpers come and go; the notes they leave say who made what
  type Note = { name: string; sectionId: string; createdBy?: string };
  const notes = () => kai.evaluate((id) => Object.values((window as unknown as { __foundation: { getState(): { notes: Record<string, Note> } } }).__foundation.getState().notes).filter((n) => n.sectionId === id).map((n) => ({ name: n.name, by: n.createdBy })), shared);
  await expect.poll(async () => (await notes()).map((n) => n.name).sort().join(","), { timeout: 30_000 }).toBe("Lead times,Suppliers to call,What's here");
  await expect(kai.locator(".crew-cursor")).toHaveCount(0, { timeout: 15_000 });
  const made = await notes();
  const names = (await kai.evaluate(() => (window as unknown as { __crewLog: { names: string[] } }).__crewLog.names)) as string[];
  expect(names.length, `agents Kai saw: ${names}`).toBe(3);
  const suppliers = made.filter((n) => n.name === "Suppliers to call");
  const leadTimes = made.find((n) => n.name === "Lead times")!;
  expect(suppliers.length, "one supplier list").toBe(1);
  expect(leadTimes.by && leadTimes.by !== suppliers[0].by, "the second helper wrote the lead times").toBeTruthy();
  // the second helper's note says it saw the first one's, and the lead's plan
  const text = await kai.evaluate((n) => {
    const b = (window as unknown as { __foundationBoard: () => { doc: { getMap(k: string): { get(id: string): { toString(): string } | undefined } } } }).__foundationBoard();
    const st = (window as unknown as { __foundation: { getState(): { notes: Record<string, { id: string; name: string }> } } }).__foundation.getState();
    const id = Object.values(st.notes).find((x) => x.name === n)!.id;
    return b.doc.getMap("noteText").get(id)?.toString() ?? "";
  }, "Lead times");
  expect(text).toContain(`${suppliers[0].by} already wrote “Suppliers to call”`);
  expect(text).toContain("plan: Shared: the parts on the board, with their data");
  await settle(kai, 600);
  await kai.screenshot({ path: `${SHOTS2}/20_two-helpers-one-list.png` });

  // Kai renames the section by hand (his own sync socket): the board's activity says it was Kai, not an agent
  await kai.evaluate((id) => {
    const b = (window as unknown as { __foundationBoard: () => { doc: { transact(f: () => void): void; getMap(k: string): { get(id: string): object; set(id: string, v: object): void } } } }).__foundationBoard();
    const secs = b.doc.getMap("sections");
    b.doc.transact(() => secs.set(id, { ...(secs.get(id) as object), name: "Shared parts" }));
  }, shared);
  type Act = { who: string; role: string; text: string; for?: string };
  const acts = () => ada.evaluate(() => (window as unknown as { __foundationBoard: () => { activity(): Act[] } }).__foundationBoard().activity());
  await expect.poll(async () => (await acts()).some((a) => a.who === "Kai Test" && a.role === "human" && a.text === "renamed the section “Shared” to “Shared parts”"), { timeout: 8000 }).toBeTruthy();
  const agentLines = (await acts()).filter((a) => a.role === "agent" && names.includes(a.who));
  expect(new Set(agentLines.map((a) => a.who)).size, "each of the three signed its work").toBe(3);
  expect(agentLines.every((a) => a.for === "Ada Test"), "every agent line says whom it worked for").toBeTruthy();
  // the space's own pane shows it (people and activity left the side pane, 2026-11-10)
  await ada.keyboard.press("Control+i");
  await expect(ada.locator(".activity-row").first()).toBeVisible({ timeout: 4000 });
  await settle(ada, 700);
  await ada.locator(".space-info").screenshot({ path: `${SHOTS2}/21_activity-person-and-agents.png` });
  await ada.keyboard.press("Control+i");
});

test("the crew on #/design, day and night", async ({ browser }) => {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await ctx.newPage();
    await p.goto("/#/design");
    const demo = p.locator(".crew-demo").first();
    await demo.scrollIntoViewIfNeeded();
    await settle(p, 900);
    await demo.screenshot({ path: `${SHOTS}/07_design-crew-${scheme === "dark" ? "night" : "day"}.png` });
    await ctx.close();
  }
  void adaCtx;
});

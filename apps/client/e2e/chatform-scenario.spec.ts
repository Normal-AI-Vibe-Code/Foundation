/**
 * The ChatForm scenario, end to end (R1; Josh: "upload CAD files … have a video conversation on them, where
 * our portraits or agents are speaking with us, and … replay them … with a small time primitive that can
 * re-wind the clock in a certain region or section"). Two people, two browsers, the drawn test camera
 * (`?fakecam`), the scripted agent runtime:
 *
 *   Ada drops a STEP file and an STL into #general → both render inline (the STL as a turnable still) → she
 *   opens the STL on a grid section → starts a huddle, Kai joins → she takes the huddle to that section →
 *   records → seats Wren, who answers Kai → during the recording Kai writes a note on the section and moves
 *   the CAD card, at known times → recording off, both leave → the channel's card is ended and recorded →
 *   Replay (Huddles tab): both recordings, the lines (the agent's too), the take; before Kai's note the
 *   section is without it, after it with it; the videos track the transport → Put the clock on its grid →
 *   scrubbing the clock card rewinds that section for Ada only (Kai's view unchanged) → Back to now.
 *
 * Ada's window is night, Kai's day: screenshots into docs/evidence/2026-11-18_chatform/scenario-*.
 *
 *   E2E_SERVER_PORT=16431 E2E_CLIENT_PORT=16451 E2E_SLACK_PORT=16441 E2E_MESHY_PORT=16445 E2E_T3_PORT=16495 npm run e2e -w @foundation/client -- chatform-scenario.spec.ts
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CLIENT, settle, waitLive } from "./helpers";

const SHOTS = fileURLToPath(new URL("../../../docs/evidence/2026-11-18_chatform/", import.meta.url));

type Store = { loaded: boolean; channels: Record<string, { id: string; name: string; kind: string; huddle?: { id: string; board: string; people: string[] } | null }> };
const store = (p: Page) => p.evaluate(() => (window as unknown as { __chatform: () => Store }).__chatform());

async function person(browser: Browser, name: string, email: string, scheme: "light" | "dark"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  if (!res.ok()) throw new Error(`dev login for ${email}: ${res.status()}`);
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const page = await context.newPage();
  await page.goto(`/?fakecam&board=company`);
  await waitLive(page);
  await page.waitForFunction(() => (window as unknown as { __chatform?: () => Store }).__chatform?.().loaded === true, undefined, { timeout: 30_000 });
  return { context, page };
}
const toChannel = async (p: Page, id: string) => {
  await p.evaluate((c) => (window.location.hash = `#/chat/chat/${c}`), id);
  await expect(p.locator(`[data-channel-head="${id}"]`)).toBeVisible({ timeout: 15_000 });
};
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}scenario-${name}.png` });

/** a small STEP (AP214) with a product and a few points: the server's summary reads it */
const STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Foundation scenario bracket'),'2;1');
FILE_NAME('bracket.step','2026-11-18T12:00:00',('Ada'),('Form Industries'),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1=PRODUCT('rim-bracket','Rim drive bracket','',(#2));
#2=PRODUCT_CONTEXT('',#3,'mechanical');
#3=APPLICATION_CONTEXT('automotive design');
#10=CARTESIAN_POINT('',(0.,0.,0.));
#11=CARTESIAN_POINT('',(40.,0.,0.));
#12=CARTESIAN_POINT('',(40.,24.,0.));
#13=CARTESIAN_POINT('',(0.,24.,6.));
#20=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
ENDSEC;
END-ISO-10303-21;
`;

/** a tiny valid binary STL: a tetrahedron, 40 × 30 × 20 mm */
function stl(): Buffer {
  const v = [
    [0, 0, 0],
    [40, 0, 0],
    [0, 30, 0],
    [0, 0, 20],
  ];
  const tris = [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ];
  const b = Buffer.alloc(84 + tris.length * 50);
  b.write("foundation scenario bracket", 0);
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    t.forEach((vi, k) => v[vi].forEach((c, j) => b.writeFloatLE(c, o + 12 + k * 12 + j * 4)));
  });
  return b;
}

test.describe.configure({ mode: "serial" });

test("#/design: the replay row of the ChatForm chapter, day and night", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    const p = await c.newPage();
    await p.goto("/#/design");
    const row = p.locator("[data-rp-demo]");
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator("[data-rp-clock]")).toHaveCount(2);
    await expect(row.locator("[data-rp-locked]")).toBeVisible();
    await expect(row.locator(".rp-banner")).toContainText("2:14");
    await expect(row.locator('[data-rp-card="Decision"]').first()).toBeVisible();
    await settle(p, 900);
    const sc = scheme === "light" ? "day" : "night";
    await row.locator(".rpdemo-section").scrollIntoViewIfNeeded();
    await settle(p, 400);
    await p.screenshot({ path: `${SHOTS}scenario-00_design-clock-${sc}.png` });
    await row.locator(".rpdemo-full").scrollIntoViewIfNeeded();
    await settle(p, 400);
    await row.locator(".rpdemo-full").screenshot({ path: `${SHOTS}scenario-00_design-replay-${sc}.png` });
    await c.close();
  }
});

test("CAD in a channel, a recorded huddle on a grid with an agent, its replay, and the clock that rewinds a section", async ({ browser }) => {
  test.setTimeout(360_000);
  mkdirSync(SHOTS, { recursive: true });
  const ada = await person(browser, "Ada Lovelace", "ada@normal.dev", "dark");
  const kai = await person(browser, "Kai Moreno", "kai@normal.dev", "light");

  // a grid with a section for the review
  const gridName = `Bracket review ${Date.now().toString(36)}`;
  const board = ((await (await ada.context.request.post(`${CLIENT}/api/boards`, { data: { name: gridName } })).json()) as { id: string }).id;
  const sec = ((await (await ada.context.request.post(`${CLIENT}/api/boards/${board}/tools/add_section`, { data: { name: "Brackets" } })).json()) as { result: { id: string } }).result.id;

  const general = Object.values((await store(ada.page)).channels).find((c) => c.kind === "open" && c.name === "general")!;
  await toChannel(ada.page, general.id);
  await toChannel(kai.page, general.id);

  // 1. Ada drops a STEP and an STL into #general: both render inline, with their facts
  await ada.page.locator('[data-chat-composer="channel"] input[type=file]').setInputFiles([
    { name: "bracket.step", mimeType: "application/step", buffer: Buffer.from(STEP) },
    { name: "bracket.stl", mimeType: "model/stl", buffer: stl() },
  ]);
  await expect(ada.page.locator('[data-chat-composer="channel"] .chat-chip.is-done')).toHaveCount(2, { timeout: 20_000 });
  await ada.page.locator('[data-chat-composer="channel"] textarea').fill("Rim drive bracket, rev C: the STEP and a print mesh");
  await ada.page.locator('[data-chat-composer="channel"] textarea').press("Enter");
  const kaiStl = kai.page.locator('[data-cad-attachment="bracket.stl"]').last();
  await expect(kaiStl).toBeVisible({ timeout: 15_000 });
  await expect(kaiStl.locator(".cad-stage img")).toBeVisible({ timeout: 20_000 });
  await expect(kaiStl.locator(".cad-info")).toContainText("40 × 30 × 20");
  const adaStep = ada.page.locator('[data-cad-attachment="bracket.step"]').last();
  await expect(adaStep.locator(".chat-file-meta")).toContainText("rim-bracket", { timeout: 15_000 });
  await settle(ada.page, 1200);
  await shot(ada.page, "01_cad-in-channel-night");
  await shot(kai.page, "02_cad-in-channel-day");

  // 2. she opens the STL on the grid's section
  const adaStl = ada.page.locator('[data-cad-attachment="bracket.stl"]').last();
  await adaStl.locator("[data-cad-open-grid]").click();
  await ada.page.getByLabel("Grid", { exact: true }).selectOption(board);
  await expect(ada.page.getByLabel("Section", { exact: true }).locator(`option[value="${sec}"]`)).toHaveCount(1, { timeout: 10_000 });
  await ada.page.getByLabel("Section", { exact: true }).selectOption(sec);
  await ada.page.locator("[data-place-take]").click();
  await expect(ada.page.locator("[data-place-go]")).toBeVisible({ timeout: 10_000 });
  const cadOf = async () => {
    const r = (await (await ada.context.request.get(`${CLIENT}/api/boards/${board}/outline`)).json()) as { sections: Array<{ id: string; items: Array<{ id: string; name: string }> }> };
    return r.sections.find((s) => s.id === sec)?.items.find((i) => i.name === "bracket.stl")?.id ?? "";
  };
  await expect.poll(cadOf).not.toBe("");
  const cadId = await cadOf();
  await ada.page.getByRole("button", { name: "Stay here" }).click();

  // 3. a huddle in the channel; Kai joins
  await ada.page.locator(`[data-huddle-start="${general.id}"]`).click();
  const adaDock = ada.page.locator("[data-huddle-dock]");
  await expect(adaDock).toBeVisible({ timeout: 15_000 });
  const huddleId = (await adaDock.getAttribute("data-huddle-dock"))!;
  const kaiCard = kai.page.locator(`.hcard[data-huddle="${huddleId}"]`);
  await expect(kaiCard).toHaveAttribute("data-huddle-state", "live", { timeout: 15_000 });
  await kaiCard.locator("[data-huddle-join]").click();
  await expect.poll(async () => (await store(kai.page)).channels[general.id]?.huddle?.people.length, { timeout: 20_000 }).toBe(2);

  // 4. taken to the section, then recorded
  await ada.page.locator("[data-huddle-place]").click();
  await ada.page.getByLabel("Grid", { exact: true }).selectOption(board);
  await expect(ada.page.getByLabel("Section", { exact: true }).locator(`option[value="${sec}"]`)).toHaveCount(1, { timeout: 10_000 });
  await ada.page.getByLabel("Section", { exact: true }).selectOption(sec);
  await ada.page.locator("[data-huddle-take]").click();
  await expect(ada.page.locator("[data-huddle-go]")).toBeVisible({ timeout: 10_000 });
  await ada.page.getByRole("button", { name: "Stay here" }).click();
  await ada.page.getByRole("button", { name: "Record", exact: true }).click();
  await ada.page.getByRole("button", { name: "Record everyone" }).click();
  await expect(kai.page.locator(".hdock .huddle-rec")).toBeVisible({ timeout: 10_000 });
  await expect(adaDock.locator("[data-bring-file]")).toBeVisible();

  // 5. Wren sits in and answers Kai
  await ada.page.getByRole("button", { name: "Invite an agent" }).click();
  await ada.page.getByLabel("Agent's name").fill("Wren");
  await ada.page.getByLabel("Agent's name").press("Enter");
  await expect(kai.page.locator('[data-huddle-agent="Wren"]')).toBeVisible({ timeout: 10_000 });
  await ada.page.keyboard.press("Escape");
  await kai.page.locator("[data-huddle-say]").fill("Wren, is a 2 mm fillet enough on the bracket?");
  await kai.page.locator("[data-huddle-say]").press("Enter");
  await expect(ada.page.locator(".hdock .huddle-line.is-agent", { hasText: "Wren here" })).toBeVisible({ timeout: 20_000 });
  await settle(ada.page, 1500);
  await shot(ada.page, "03_huddle-recording-with-agent-night");

  // 6. Kai goes to the grid (the call stays), writes a note there and moves the CAD card, at known times
  await kaiCard.locator("[data-huddle-grid]").click();
  await waitLive(kai.page);
  await expect(kai.page.locator(`[data-obj-id="${cadId}"]`)).toHaveCount(1, { timeout: 20_000 });
  await settle(kai.page, 2500);
  const beforeNote = Date.now();
  await settle(kai.page, 1200);
  const note = await kai.page.evaluate(
    async ({ board, sec }) => (await (await fetch(`/api/boards/${board}/tools/add_note`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ section: sec, title: "Kai's note", markdown: "Fillet: 2 mm inside, 1 mm outside (Wren agrees)" }) })).json()) as { result: { id: string } },
    { board, sec },
  );
  const noteAt = Date.now();
  await expect(kai.page.locator(`[data-obj-id="${note.result.id}"]`)).toHaveCount(1, { timeout: 10_000 });
  await settle(kai.page, 2000);
  // the CAD card moved by Kai's own hand, through his synced board
  await kai.page.evaluate((id) => {
    const b = (window as unknown as { __foundationBoard: () => { doc: import("yjs").Doc } }).__foundationBoard();
    const objects = b.doc.getMap("objects") as unknown as Map<string, Record<string, unknown>> & { set(k: string, v: unknown): void };
    const o = objects.get(id)!;
    b.doc.transact(() => objects.set(id, { ...o, float: true, x: 760, y: 40 }));
  }, cadId);
  const movedAt = Date.now();
  await settle(kai.page, 2500);
  await shot(kai.page, "04_kai-on-the-grid-during-day");

  // 7. recording off, both leave: the channel's card is ended and recorded
  await ada.page.getByRole("button", { name: "Record", exact: true }).click();
  await ada.page.getByRole("button", { name: "Stop recording" }).click();
  await settle(ada.page, 800);
  await kai.page.locator(".huddle-pip .huddle-leave").click();
  await ada.page.locator(".hdock .huddle-leave, .huddle-pip .huddle-leave").first().click();
  const adaCard = ada.page.locator(`.hcard[data-huddle="${huddleId}"]`);
  await expect(adaCard).toHaveAttribute("data-huddle-state", "ended", { timeout: 20_000 });
  await expect(adaCard.locator(".huddle-rec")).toBeVisible();
  await expect(adaCard.locator("[data-huddle-recordings]")).toBeVisible({ timeout: 40_000 });
  await adaCard.scrollIntoViewIfNeeded();
  await adaCard.screenshot({ path: `${SHOTS}scenario-05_card-ended-recorded-night.png` });

  // 8. Replay from the Huddles tab
  await adaCard.locator("[data-huddle-replay]").click();
  const replay = ada.page.locator("[data-rp-session]");
  await expect(replay).toBeVisible({ timeout: 20_000 });
  const sid = (await replay.getAttribute("data-rp-session"))!;
  const t = (await (await ada.context.request.get(`${CLIENT}/api/replay/${sid}`)).json()) as { session: { startedAt: number }; media: Array<{ person: string }>; lines: Array<{ source: string }>; takes: Array<{ id: string; updates: number }> };
  expect(t.media.map((m) => m.person).sort()).toEqual(["Ada Lovelace", "Kai Moreno"]);
  expect(t.lines.some((l) => l.source === "agent")).toBe(true);
  expect(t.takes.length).toBe(1);
  expect(t.takes[0].updates).toBeGreaterThanOrEqual(2);
  await expect(replay.locator("video[data-rp-video]")).toHaveCount(2);
  await expect(replay.locator(".rp-line.is-agent")).toHaveCount(1);
  const take = replay.locator("[data-rp-take]");
  await expect(take).toBeVisible();
  const seekTo = (ms: number) => ada.page.evaluate((v) => (window as unknown as { __replayClock: { seek(t: number): void } }).__replayClock.seek(v), ms);
  const t0 = t.session.startedAt;
  await seekTo(beforeNote - t0);
  await expect(take.locator(`[data-rp-card="Kai's note"]`)).toHaveCount(0);
  await expect(take.locator('[data-rp-card="bracket.stl"]')).toHaveCount(1);
  await settle(ada.page, 600);
  await replay.screenshot({ path: `${SHOTS}scenario-06_replay-before-note-night.png` });
  await seekTo(noteAt - t0 + 600);
  await expect(take.locator(`[data-rp-card="Kai's note"]`)).toHaveCount(1);
  // the CAD card's place before and after Kai moved it
  const cadX = () => take.locator(`[data-rp-obj="${cadId}"]`).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  const xBefore = await cadX();
  await seekTo(movedAt - t0 + 800);
  await expect.poll(cadX, { timeout: 3000 }).toBeGreaterThan(xBefore + 300);
  // the videos track the transport: play two seconds, then each <video> is where the clock says
  await seekTo(noteAt - t0 - 3000);
  await ada.page.evaluate(() => (window as unknown as { __replayClock: { play(): void } }).__replayClock.play());
  await settle(ada.page, 2500);
  const sync = await ada.page.evaluate(() => {
    const c = (window as unknown as { __replayClock: { t: number } }).__replayClock;
    return [...document.querySelectorAll<HTMLVideoElement>("video[data-rp-video]")].map((v) => ({ who: v.dataset.rpVideo, err: Math.abs(v.currentTime - (c.t - Number(v.dataset.rpOffset)) / 1000), paused: v.paused, ready: v.readyState }));
  });
  console.log(`video sync while playing: ${JSON.stringify(sync)}`);
  for (const s of sync) expect(s.err, `${s.who}'s recording on the clock`).toBeLessThan(0.35);
  await replay.screenshot({ path: `${SHOTS}scenario-07_replay-playing-night.png` });
  await ada.page.evaluate(() => (window as unknown as { __replayClock: { pause(): void } }).__replayClock.pause());
  // scrub latency in the Huddles tab: seek, then the section's cards are redrawn
  const lat = await ada.page.evaluate(async ({ a, b }) => {
    const c = (window as unknown as { __replayClock: { seek(t: number): void } }).__replayClock;
    const out: number[] = [];
    for (let i = 0; i < 6; i++) {
      const to = i % 2 ? b : a;
      const want = i % 2 ? 1 : 0;
      const s = performance.now();
      c.seek(to);
      while (document.querySelectorAll(`[data-rp-take] [data-rp-card="Kai's note"]`).length !== want) await new Promise((r) => requestAnimationFrame(r));
      out.push(performance.now() - s);
    }
    return out;
  }, { a: beforeNote - t0, b: noteAt - t0 + 600 });
  console.log(`scrub latency (seek → section redrawn), ms: ${lat.map((x) => x.toFixed(1)).join(", ")}`);

  // 9. Put the clock on its grid: Ada goes there; scrubbing the clock card rewinds only that section, only for her
  await replay.locator(`[data-rp-put="${board}"]`).click();
  await waitLive(ada.page);
  const clockCard = ada.page.locator("[data-rp-clock]");
  await expect(clockCard).toBeVisible({ timeout: 20_000 });
  await expect(clockCard).toHaveAttribute("data-rp-rewound", "0");
  await settle(ada.page, 1500);
  await shot(ada.page, "08_clock-on-the-grid-night");
  // scrub to just before Kai's note: a press on the clock's bar at that point
  const bar = clockCard.locator("[data-rp-bar]");
  const box = (await bar.boundingBox())!;
  const dur = (await (await ada.context.request.get(`${CLIENT}/api/replay/${sid}`)).json()) as { session: { endedAt: number } };
  const frac = (beforeNote - t0) / (dur.session.endedAt - t0);
  await ada.page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
  const rewind = ada.page.locator(`[data-rp-rewind="${sec}"]`);
  await expect(rewind).toHaveCount(1, { timeout: 5000 });
  await expect(clockCard).toHaveAttribute("data-rp-rewound", "1");
  await expect(rewind.locator(`[data-rp-card="Kai's note"]`)).toHaveCount(0);
  await expect(rewind.locator('[data-rp-card="bracket.stl"]')).toHaveCount(1);
  await expect(ada.page.locator(`[data-rp-banner="${sec}"]`)).toContainText("into");
  // Kai, on the same grid, sees it as it is
  await expect(kai.page.locator("[data-rp-rewind]")).toHaveCount(0);
  await expect(kai.page.getByText("Fillet: 2 mm inside, 1 mm outside").first()).toBeVisible();
  await settle(ada.page, 1200);
  await shot(ada.page, "09_section-rewound-night");
  await shot(kai.page, "10_kai-unchanged-day");
  // forward past the note: it's there in the rewound section
  const box2 = (await bar.boundingBox())!; // the card's hover bar makes room from the top: the bar has moved
  await ada.page.mouse.click(box2.x + box2.width * Math.min(0.98, (noteAt - t0 + 1500) / (dur.session.endedAt - t0)), box2.y + box2.height / 2);
  await settle(ada.page, 300);
  await expect(rewind.locator(`[data-rp-card="Kai's note"]`)).toHaveCount(1, { timeout: 5000 });
  // Back to now
  await ada.page.locator("[data-rp-back]").click();
  await expect(ada.page.locator("[data-rp-rewind]")).toHaveCount(0);
  await expect(clockCard).toHaveAttribute("data-rp-rewound", "0");
  await expect(ada.page.locator(`[data-obj-id="${note.result.id}"]`)).not.toHaveCount(0);
  // and nothing on the board changed by looking back: Kai's note and the moved card are as he left them
  const after = (await (await kai.context.request.get(`${CLIENT}/api/boards/${board}/outline`)).json()) as { sections: Array<{ id: string; items: Array<{ id: string; x: number }> }> };
  const items = after.sections.find((s) => s.id === sec)!.items;
  expect(items.find((i) => i.id === cadId)?.x).toBe(760);
  expect(items.some((i) => i.id === note.result.id)).toBe(true);
  await settle(ada.page, 800);
  await shot(ada.page, "11_back-to-now-night");

  // day: Kai's own look at the replay, and the clock on his grid
  await kai.page.evaluate((s) => (window.location.hash = `#/chat/huddles/${s}`), sid);
  await expect(kai.page.locator("[data-rp-session]")).toBeVisible({ timeout: 20_000 });
  await kai.page.evaluate((v) => (window as unknown as { __replayClock: { seek(t: number): void } }).__replayClock.seek(v), noteAt - t0 + 600);
  await settle(kai.page, 1200);
  await shot(kai.page, "12_replay-day");
  await ada.context.close();
  await kai.context.close();
});

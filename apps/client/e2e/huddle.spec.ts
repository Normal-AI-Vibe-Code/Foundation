/**
 * A huddle's live state isn't lost to a move (schema 6, 2026-11-07): two
 * people in two browsers with the drawn test camera (`?fakecam`). Ada drags
 * the huddle card, frame after frame, while Kai joins; then Ada joins too.
 * Each browser shows who's in it from the board's `huddles` map, and the
 * card Ada's drag wrote never carries that state.
 */

import { test, expect, type Page } from "@playwright/test";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-07_huddle-state-race";
let ada: Page;
let kai: Page;
let board = "";
let huddle = "";

test.describe.configure({ mode: "serial" });

type Seen = { people: string[] | null; cardHuddle: unknown; mapPeople: string[] | null; x: number | null; float: boolean | null };

/** what one browser holds: the store's panel, and the shared doc's card and map entry */
const seen = (p: Page, id: string) =>
  p.evaluate((i): Seen => {
    const w = window as unknown as {
      __foundation: { getState(): { panels: Record<string, { huddle?: { people: string[] } }> } };
      __foundationBoard: () => { doc: { getMap(n: string): { get(k: string): Record<string, unknown> | undefined } } };
    };
    const doc = w.__foundationBoard().doc;
    const card = doc.getMap("objects").get(i);
    const entry = doc.getMap("huddles").get(i) as { people: string[] } | undefined;
    return {
      people: w.__foundation.getState().panels[i]?.huddle?.people ?? null,
      cardHuddle: card?.huddle ?? null,
      mapPeople: entry?.people ?? null,
      x: (card?.x as number) ?? null,
      float: (card?.float as boolean) ?? null,
    };
  }, id);

async function open(p: Page) {
  await p.goto(`/?board=${board}&fakecam`);
  await waitLive(p);
  await p.evaluate((i) => (window as unknown as { __foundation: { setState(x: object): void } }).__foundation.setState({ snapRequest: { kind: "object", id: i, nonce: Math.random() } }), huddle);
  await settle(p, 1200);
}

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  const made = await a.context.request.post(`${CLIENT}/api/boards`, { data: { name: `Huddle race ${Date.now().toString(36)}` } });
  board = ((await made.json()) as { id: string }).id;
  ada = a.page;
  const k = await person(browser, "Kai Test", "kai@normal.dev", board);
  kai = k.page;
  const opened = await a.context.request.post(`${CLIENT}/api/boards/${board}/tools/open_huddle`, { data: { name: "Race" } });
  const body = (await opened.json()) as { id?: string; result?: { id: string } };
  huddle = body.id ?? body.result!.id;
  await open(ada);
  await open(kai);
});

test.afterAll(async () => {
  await ada?.context().close();
  await kai?.context().close();
});

test("a card dragged while someone joins keeps who's in it", async () => {
  // Ada drags the card for a second (a store write per frame, each sending the whole card) while Kai joins
  const drag = ada.evaluate(async (i) => {
    const f = (window as unknown as { __foundation: { getState(): { panels: Record<string, object> }; setState(x: object): void } }).__foundation;
    for (let n = 0; n < 60; n++) {
      const st = f.getState();
      f.setState({ panels: { ...st.panels, [i]: { ...st.panels[i], float: true, x: 40 + n * 4, y: 60 } } });
      await new Promise((r) => setTimeout(r, 16));
    }
  }, huddle);
  const join = kai.locator(`[data-obj-id="${huddle}"]`).getByRole("button", { name: "Start the huddle" }).click();
  await Promise.all([drag, join]);
  await settle(ada, 1500);

  for (const p of [ada, kai]) {
    const s = await seen(p, huddle);
    expect(s.people, "the store shows Kai in it").toEqual(["Kai Test"]);
    expect(s.mapPeople, "from the server's huddles map").toEqual(["Kai Test"]);
    expect(s.cardHuddle, "the card carries no huddle state").toBeNull();
    expect([s.x, s.float], "and the drag landed").toEqual([40 + 59 * 4, true]);
  }
  await expect(ada.locator(`[data-obj-id="${huddle}"] .huddle-status`)).toHaveText(/Live · 1/);
  await ada.screenshot({ path: `${SHOTS}/01_ada-dragged-while-kai-joined.png` });
});

test("the second person joins; both see two, and leaving shows one", async () => {
  await ada.locator(`[data-obj-id="${huddle}"]`).getByRole("button", { name: "Join" }).click();
  await settle(ada, 2500);
  for (const p of [ada, kai]) {
    expect((await seen(p, huddle)).people?.slice().sort()).toEqual(["Ada Test", "Kai Test"]);
    await expect(p.locator(`[data-obj-id="${huddle}"] .huddle-status`)).toHaveText(/Live · 2/);
  }
  // each receives the other's camera
  for (const p of [ada, kai]) await expect.poll(() => p.evaluate(() => [...document.querySelectorAll("video")].filter((v) => v.readyState >= 2 && v.videoWidth > 0).length), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await ada.screenshot({ path: `${SHOTS}/02_ada-two-in-the-huddle.png` });
  await kai.screenshot({ path: `${SHOTS}/03_kai-two-in-the-huddle.png` });

  await kai.locator(".huddle-pip .huddle-leave").click();
  await settle(ada, 1500);
  expect((await seen(ada, huddle)).people).toEqual(["Ada Test"]);
  await expect(ada.locator(`[data-obj-id="${huddle}"] .huddle-status`)).toHaveText(/Live · 1/);
});

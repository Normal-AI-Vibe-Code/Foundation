/**
 * The council and the Character studio, in a real browser (2026-11-14).
 * Meshy is a stand-in (e2e/meshy-standin.mjs: real PNGs and a real skinned
 * GLB with a clip per mood, nothing charged); the agents run the server's
 * script runtime (the real board tools, no model).
 *
 * - ⌘K opens the Character studio: one board, a column per set.
 * - A character goes through its stages on its card, a press at a time, each
 *   button saying its cost first; when the clips land it's "on the council"
 *   and the card plays it live, a mood at a time.
 * - A press with an agent's bearer is refused: spending needs a person.
 * - A mesh avatar's stages are sheet, expressions, portrait and a .mavatar brought in.
 * - With nobody at work the council is the bench: the characters there are.
 * - An agent at work sits in the council under its own name, on its cursor's
 *   colour, wearing a character; it's drawn live (one canvas for every seat),
 *   stands head to toe when pressed, and can be given another character.
 * - A section's council holds only the agents in that section (⌘K).
 * - #/design, day and night.
 */

import { test, expect, type Page, type BrowserContext, type Locator } from "@playwright/test";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-15_one-interface/council";
/** 2026-11-24: one bar over each head, the run card, the one silhouette, seats as wide as their figures */
const NEW = "../../docs/evidence/2026-11-24_council-harness";
// the card at rest and waking (2026-11-25)
const PERF = "../../docs/evidence/2026-11-25_character-grid-perf";
const MESHY = `http://127.0.0.1:${process.env.E2E_MESHY_PORT ?? "4445"}`;
let ada: Page;
let ctx: BrowserContext;
let studio = "";
let work = "";

test.describe.configure({ mode: "serial" });

type Store = { getState(): { sections: Record<string, { id: string; name: string }>; allSections: Record<string, { id: string; name: string }>; panels: Record<string, { id: string; panel: string; name: string; sectionId: string }> }; setState(p: object): void };
const boardId = (p: Page) => p.evaluate(() => (window as unknown as { __foundationBoard: () => { boardId: string } }).__foundationBoard().boardId);
const frame = (p: Page, name: string) =>
  p.evaluate((n) => {
    const f = (window as unknown as { __foundation: Store }).__foundation;
    const card = Object.values(f.getState().panels).find((x) => x.panel === "character" && x.name === n);
    if (card) f.setState({ snapRequest: { kind: "object", id: card.id, nonce: Math.random() } });
    return card?.id ?? null;
  }, name);
const card = (p: Page, name: string) => p.locator(`[data-character-card="${name}"]`);
const stage = (p: Page, name: string, s: string) => card(p, name).locator(`[data-char-stage="${s}"]`);
/**
 * The line to an agent, measured where it's drawn: its own opacity and every ancestor's, its background's alpha, and
 * what is on top at its centre and near its left end. The stage canvas takes no pointer, and elementFromPoint skips
 * what takes none: for the check it takes the pointer, so a canvas painted over the line would be what's hit.
 */
async function lineOnTop(seat: Locator) {
  return seat.locator("[data-council-say]").evaluate((form) => {
    const alpha = (c: string) => {
      if (c === "transparent") return 0;
      const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(c);
      if (slash) return slash[1].endsWith("%") ? Number(slash[1].slice(0, -1)) / 100 : Number(slash[1]);
      const parts = /\(([^)]*)\)/.exec(c)?.[1].split(",") ?? [];
      return parts.length === 4 ? Number(parts[3]) : 1;
    };
    let drawn = 1;
    for (let el: Element | null = form; el; el = el.parentElement) drawn *= Number(getComputedStyle(el).opacity);
    const stages = [...document.querySelectorAll<HTMLElement>(".council-stage")];
    stages.forEach((c) => (c.style.pointerEvents = "auto"));
    const r = form.getBoundingClientRect();
    const at = (x: number) => document.elementFromPoint(x, r.top + r.height / 2);
    const mid = at(r.left + r.width / 2);
    const left = at(r.left + 14);
    stages.forEach((c) => (c.style.pointerEvents = ""));
    const cs = getComputedStyle(form);
    return { opacity: Number(cs.opacity), drawn, alpha: alpha(cs.backgroundColor), background: cs.backgroundColor, centre: !!mid && form.contains(mid), left: !!left && form.contains(left), hit: mid ? `${mid.tagName}.${mid.className}` : "nothing", rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], window: [innerWidth, innerHeight] };
  });
}
async function expectLineOnTop(seat: Locator, when: string) {
  const m = await lineOnTop(seat);
  expect(m, `${when}: ${JSON.stringify(m)}`).toMatchObject({ opacity: 1, drawn: 1, alpha: 1, centre: true, left: true });
}

/**
 * Every figure inside its seat and drawn whole at the sides (the picture's own drawn box, not only its button), and no two
 * seats' figures overlapping.
 */
async function figuresFit(council: Locator) {
  return council.evaluate((c) => {
    const bad: string[] = [];
    const seats = [...c.querySelectorAll<HTMLElement>(".council-seat:not(.council-ghost)")];
    const figs = seats.map((seat) => {
      const name = seat.dataset.councilSeat ?? "?";
      const sb = seat.getBoundingClientRect();
      const crop = seat.querySelector(".council-crop")!.getBoundingClientRect();
      const fig = seat.querySelector(".council-figure")!.getBoundingClientRect();
      // what is drawn: a mesh avatar's canvas, a still's picture as fitted, else the avatar's box (3D is scissored to it)
      let drawn = seat.querySelector(".avatar")!.getBoundingClientRect();
      const mesh = seat.querySelector<HTMLElement>(".avatar-mesh.is-live > .avatar-canvas");
      const img = seat.querySelector<HTMLImageElement>(".council-figure > img.avatar-still");
      if (mesh) drawn = mesh.getBoundingClientRect();
      else if (img?.naturalWidth) {
        const w = Math.min(drawn.width, (drawn.height * img.naturalWidth) / img.naturalHeight);
        drawn = new DOMRect(drawn.left + (drawn.width - w) / 2, drawn.top, w, drawn.height);
      }
      if (fig.left < sb.left - 1 || fig.right > sb.right + 1) bad.push(`${name}: figure ${fig.left}–${fig.right} outside its seat ${sb.left}–${sb.right}`);
      if (drawn.left < crop.left - 1 || drawn.right > crop.right + 1) bad.push(`${name}: drawn ${drawn.left.toFixed(1)}–${drawn.right.toFixed(1)} cut at the sides by ${crop.left.toFixed(1)}–${crop.right.toFixed(1)}`);
      return { name, l: fig.left, r: fig.right, w: drawn.width, kind: mesh ? "mesh" : img ? "still" : seat.querySelector(".avatar-3d") ? "3d" : "none" };
    });
    for (let i = 0; i < figs.length; i++) for (let j = i + 1; j < figs.length; j++) if (figs[i].l < figs[j].r - 1 && figs[j].l < figs[i].r - 1) bad.push(`${figs[i].name} and ${figs[j].name} overlap`);
    return { bad, figs };
  });
}

/**
 * Day or night through the real engine (⌘K → Night / Day, what the orb does), then wait until the look has settled: the
 * tokens' --night has reached its end (the fade is 1.4 s) and the grid's paper has followed, so no shot is taken mid-fade.
 */
async function look(p: Page, night: boolean) {
  // the command toggles; its words are whichever the bar showed when it opened
  for (let i = 0; i < 2 && (await p.evaluate(() => document.documentElement.classList.contains("is-night"))) !== night; i++) {
    // the side menu's orb; the menu is opened for it and folded again if it was folded
    const orb = p.locator(".side-pane .night-orb").first();
    const folded = !(await orb.isVisible());
    if (folded) await p.locator(".pane-fold").click();
    await orb.click();
    if (folded) await p.locator(".pane-fold").click();
    await settle(p, 200);
  }
  await expect.poll(() => p.evaluate(() => document.documentElement.classList.contains("is-night")), { timeout: 5000 }).toBe(night);
  await expect
    .poll(() => p.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--night"))), { timeout: 5000 })
    .toBe(night ? 1 : 0);
  await expect
    .poll(() => p.evaluate((n) => { const u = (window as unknown as { __foundationBg?: { uniforms: { night: number } } }).__foundationBg?.uniforms.night; return u === undefined || u === n; }, night ? 1 : 0), { timeout: 5000 })
    .toBe(true);
  await settle(p, 300);
}

/** the bar over a seat's head, centred on its figure (px off), and how many lines to type into the seat holds, and where */
async function oneBar(seat: Locator) {
  return seat.evaluate((el) => {
    const bars = el.querySelectorAll(".council-bar");
    const bar = bars[0]?.getBoundingClientRect();
    const crop = el.querySelector(".council-crop")!.getBoundingClientRect();
    return {
      bars: bars.length,
      off: bar ? Math.abs(bar.left + bar.width / 2 - (crop.left + crop.width / 2)) : 99,
      says: el.querySelectorAll("[data-council-say]").length,
      saysInBar: el.querySelectorAll(".council-bar [data-council-say]").length,
      barAboveHead: bar ? bar.bottom <= crop.top + 1 : false,
    };
  });
}

/** the run card's bottom against the window's (and its last line against its own bottom: nothing cut inside it) */
async function cardInWindow(seat: Locator) {
  return seat.evaluate((el) => {
    const card = el.querySelector(".run-card")!.getBoundingClientRect();
    const last = el.querySelector(".run-card > :last-child")!.getBoundingClientRect();
    return { bottom: card.bottom, window: innerHeight, lastInside: last.bottom <= card.bottom + 1 };
  });
}

/** the run card inside the window (its bottom above the window's) and clear of the bottom bar, its last line inside it */
async function expectCardInWindow(p: Page, seat: Locator, size: string) {
  const card = await cardInWindow(seat);
  expect(card.bottom, `${size}: ${JSON.stringify(card)}`).toBeLessThan(card.window);
  expect(card.lastInside, `${size}: its last line is inside it`).toBe(true);
  const hud = (await p.locator("[data-hud]").boundingBox())!;
  const c = (await seat.locator(".run-card").boundingBox())!;
  const overHud = c.x < hud.x + hud.width && hud.x < c.x + c.width && c.y < hud.y + hud.height && hud.y < c.y + c.height;
  expect(overHud, `${size}: the card stays clear of the bottom bar`).toBe(false);
}

/** WCAG contrast of an element's text against the first solid background behind it */
async function contrastOf(el: Locator) {
  return el.evaluate((node) => {
    const rgb = (c: string) => {
      const n = (/\(([^)]*)\)/.exec(c)?.[1] ?? "").replace(/srgb\s*/, "").split(/[\s,/]+/).filter(Boolean).map(Number);
      const srgb = c.startsWith("color(");
      return { v: n.slice(0, 3).map((x) => (srgb ? x : x / 255)), a: n.length > 3 ? n[3] : 1 };
    };
    const lum = (v: number[]) => v.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
    let bg: number[] | null = null;
    for (let e: Element | null = node; e && !bg; e = e.parentElement) {
      const b = rgb(getComputedStyle(e).backgroundColor);
      if (b.a > 0.95) bg = b.v;
    }
    const fg = rgb(getComputedStyle(node).color).v;
    const [a, b] = [lum(fg), lum(bg ?? [1, 1, 1])].sort((x, y) => y - x);
    return Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10;
  });
}

/** frames the stage has drawn so far (it counts them on its canvas) */
const frames = (p: Page, sel: string) => p.locator(sel).first().evaluate((c) => Number((c as HTMLElement).dataset.frames ?? 0));

async function press(p: Page, name: string, s: string, words: RegExp) {
  const row = stage(p, name, s);
  const button = row.locator("button.f-pill");
  await expect(button).toHaveText(words);
  await button.click();
  await expect(row).toHaveAttribute("data-char-state", "done", { timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  const a = await person(browser, "Ada Test", "ada@normal.dev");
  ada = a.page;
  ctx = a.context;
});

test("⌘K opens the Character studio: one board, inspiration, the pipeline and characters, a column per set", async () => {
  await ada.keyboard.press("Control+k");
  await ada.keyboard.type("Character studio");
  await ada.locator(".cmd-row", { hasText: "Open the Character studio" }).first().click();
  await expect.poll(() => boardId(ada), { timeout: 15_000 }).toMatch(/^character-studio/);
  await waitLive(ada);
  studio = await boardId(ada);
  const names = await ada.evaluate(() => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections).map((s) => s.name).sort());
  expect(names).toEqual(["Characters · Abstract", "Characters · Animals", "Characters · Anime", "Foundation avatars", "Inspiration · Abstract", "Inspiration · Animals", "Inspiration · Anime", "Pipeline · Abstract", "Pipeline · Animals", "Pipeline · Anime"]);
  // between a set's inspiration and its characters, the flow: a node card per stage and a way to start one there
  // (e2e/character-studio.spec.ts walks it)
  await expect(ada.locator('[data-pipe-node][data-pipe-set="animals"]')).toHaveCount(9);
  await expect(ada.locator('[data-pipe-node="output"][data-pipe-set="animals"]')).toContainText("0 approved");
  await expect(ada.locator('[data-pipe-node="sheet"][data-pipe-set="animals"] [data-pipe-new]')).toHaveCount(1);
  // opening it again opens the same one
  const again = await ctx.request.post(`${CLIENT}/api/characters/studio`);
  expect(await again.json()).toEqual({ id: studio, made: false });
});

test("a 3D character, a press at a time: each button says its cost, the card shows what came back, and the last stage puts it on the council", async () => {
  // two pictures of inspiration, and a character drawn from one of them
  const picture = await (await ctx.request.get(`${MESHY}/_png`)).body();
  const up = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/inspiration?set=Animals&name=shiba.png`, { headers: { "content-type": "image/png" }, data: picture });
  expect(up.ok(), await up.text()).toBe(true);
  const ref = ((await up.json()) as { file: string }).file;
  const made = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters`, { data: { name: "Mochi", set: "animals", form: "model", identity: "A cheerful shiba in a teal scarf.", refs: [ref], height: 0.7 } });
  expect(made.ok(), await made.text()).toBe(true);

  await expect.poll(() => frame(ada, "Mochi")).not.toBeNull();
  await settle(ada, 1600);
  const c = card(ada, "Mochi");
  await expect(c).toBeVisible();
  await expect(c.locator(".char-pick.is-on")).toHaveCount(1); // drawn from the picture it was given
  await expect(c.locator(".char-foot")).toContainText("credits left");
  // only the next stage can be pressed; the ones after it wait
  await expect(stage(ada, "Mochi", "views").locator("button")).toHaveCount(0);
  await ada.screenshot({ path: `${SHOTS}/10_card-new.png` });

  // the stand-in is one for every check on this server: count from what it had been asked before these presses
  const asked = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: unknown[] }).sent.length;
  await press(ada, "Mochi", "sheet", /Draw the sheet · 9/);
  await expect(c.locator('[data-char-file="front"] img')).toBeVisible();
  // the expressions sheet is its own press, and the views wait for it
  await expect(stage(ada, "Mochi", "views").locator("button")).toHaveCount(0);
  await press(ada, "Mochi", "expressions", /Draw the expressions · 9/);
  await expect(c.locator('[data-char-file="expressions"] img')).toBeVisible();
  await press(ada, "Mochi", "views", /Draw the back and side · 18/);
  await expect(c.locator('[data-char-file="back"] img')).toBeVisible();
  await expect(c.locator('[data-char-file="side"] img')).toBeVisible();
  await press(ada, "Mochi", "model", /Make the model · 30/);
  await press(ada, "Mochi", "rig", /Fit the skeleton · 5/);
  await expect(c).not.toHaveAttribute("data-character-ready", "true");
  await press(ada, "Mochi", "clips", /Animate the moods · 24/);
  await expect(c).toHaveAttribute("data-character-ready", "true");
  // finished, and waiting on a person's word before anyone can wear it
  await expect(c.locator(".char-tag.is-pending")).toHaveText("waiting for approval");

  // what the stand-in was asked for, in order: the pipeline's six stages (the sheet, the expressions, two views, …)
  const sent = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: Array<{ endpoint: string; request: Record<string, unknown> }> }).sent.slice(asked);
  expect(sent.map((s) => s.endpoint)).toEqual(["image-to-image", "image-to-image", "image-to-image", "image-to-image", "multi-image-to-3d", "rigging", "animations"]);
  expect(String(sent[0].request.prompt)).toMatch(/^Front view\. A cheerful shiba in a teal s/); // the stand-in keeps the first 40 characters
  expect(String(sent[1].request.prompt)).toMatch(/^Expression and pose sheet/);
  expect((sent[6].request.action_ids as number[]).length).toBe(8);

  // the card plays it: a live model, its clip changing with the mood. The sheet is longer than its card now
  // and the last press was at its foot: back up to the stage, the pointer on it (the card under the pointer plays)
  await c.locator(".char-view").hover();
  const live = c.locator(".avatar-3d");
  await expect(live).toHaveClass(/is-live/, { timeout: 15_000 });
  const before = await frames(ada, `[data-character-card="Mochi"] canvas.avatar-canvas`);
  await c.locator(".char-mood", { hasText: /^happy$/ }).click();
  await expect(live).toHaveAttribute("data-mood", "happy");
  await expect.poll(() => frames(ada, `[data-character-card="Mochi"] canvas.avatar-canvas`)).toBeGreaterThan(before + 10);
  await settle(ada, 500);
  await ada.screenshot({ path: `${SHOTS}/11_card-ready-happy.png` });
});

test("a card rests on its picture: the model drawn once and kept; under the pointer it plays, cross-faded, and goes back", async () => {
  // (2026-11-25, characters/stagePolicy.ts) every card on screen used to play. Now a card away from the pointer and
  // not drawn large holds a picture: no canvas of its own, no frames
  const c = card(ada, "Mochi");
  const poster = c.locator(".avatar-poster");
  await ada.mouse.move(700, 40);
  // drawn large it goes on playing by itself (it's what the screen is showing): step back until it isn't
  const zoom = async (dy: number) => {
    await ada.mouse.move(700, 450);
    await ada.keyboard.down("Control");
    await ada.mouse.wheel(0, dy);
    await ada.keyboard.up("Control");
    await ada.mouse.move(700, 40);
  };
  let steps = 0;
  for (; steps < 12 && Number(await c.evaluate((e) => e.getBoundingClientRect().width)) > 300; steps++) await zoom(40);
  await expect(poster).not.toHaveAttribute("data-poster", "live", { timeout: 10_000 });
  await expect(c.locator("canvas")).toHaveCount(0, { timeout: 5_000 });
  // the picture is the 3D model itself, drawn once (characters/portrait.ts), not the sheet it was made from
  await expect(poster).toHaveAttribute("data-poster", "render", { timeout: 20_000 });
  const still = c.locator(".avatar-rest img.avatar-render");
  await expect(still).toBeVisible();
  const drawn = await still.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const k = document.createElement("canvas");
    k.width = img.naturalWidth;
    k.height = img.naturalHeight;
    const g = k.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, k.width, k.height).data;
    let solid = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 200) solid++;
    return { w: img.naturalWidth, h: img.naturalHeight, corner: d[3], solid: solid / (k.width * k.height) };
  });
  expect(drawn.w).toBe(640);
  expect(drawn.corner, "drawn on a clear ground").toBe(0);
  expect(drawn.solid, "and there is a figure in it").toBeGreaterThan(0.03);
  // kept under the clips file's id: in the image cache between launches
  const kept = await ada.evaluate(async () => (await (await caches.open("foundation-image-cache-v3")).keys()).map((r) => decodeURIComponent(r.url)).filter((u) => u.includes("derived:model-still/")));
  expect(kept.length).toBeGreaterThan(0);
  expect(kept[0]).toMatch(/derived:model-still\/chr_[^/]+\/[^/]+\/full\/640/);
  await ada.screenshot({ path: `${PERF}/e2e-card-at-rest.png` });

  // the pointer on it: the live character over the picture; off it, back to the picture and the canvas is let go
  await c.locator(".char-view").hover();
  await expect(poster).toHaveAttribute("data-poster", "live", { timeout: 15_000 });
  await expect(c.locator(".avatar-3d")).toHaveClass(/is-live/);
  await expect.poll(async () => Number(await c.locator(".avatar-3d").evaluate((e) => getComputedStyle(e).opacity))).toBe(1);
  await ada.mouse.move(700, 40);
  await expect(poster).toHaveAttribute("data-poster", "render", { timeout: 10_000 });
  await expect(c.locator("canvas")).toHaveCount(0, { timeout: 5_000 });
  // back to where the board was, for the checks after this one
  for (; steps > 0; steps--) await zoom(-40);
  await settle(ada, 600);
});

test("a finished character waits for a person's approval; approved, it's one an agent can wear", async () => {
  const mochi = card(ada, "Mochi");
  await expect(mochi.locator("[data-char-approval]")).toHaveAttribute("data-char-approval", "pending");
  const before = ((await (await ctx.request.get(`${CLIENT}/api/characters`)).json()) as { characters: Array<{ name: string; approval?: string }> }).characters.find((c) => c.name === "Mochi")!;
  expect(before.approval).toBe("pending");
  await mochi.locator("[data-char-approval] .f-pill.is-accent").dispatchEvent("click");
  await expect(mochi.locator("[data-char-approval]")).toHaveAttribute("data-char-approval", "approved");
  await expect(mochi.locator(".char-tag.is-ready")).toHaveText("on the council");
});

test("a press with an agent's bearer is refused: spending credits needs a person at a browser", async () => {
  const id = await frame(ada, "Mochi");
  const token = ((await (await ctx.request.post(`${CLIENT}/api/agent/token`)).json()) as { token: string }).token;
  const sentBefore = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: unknown[] }).sent.length;
  const res = await ctx.request.post(`${CLIENT}/api/boards/${studio}/characters/${id}/stages/sheet`, { headers: { authorization: `Bearer ${token}` }, data: {} });
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: string }).error).toMatch(/needs a person/);
  const sentAfter = ((await (await ctx.request.get(`${MESHY}/_sent`)).json()) as { sent: unknown[] }).sent.length;
  expect(sentAfter).toBe(sentBefore);
});

test("the grid's council stands on the window's bottom edge, no panel; with nobody assigned it is silhouettes to fill; an agent added stands at rest, live, with its marks", async () => {
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
  await expect(council).toHaveAttribute("data-council", "0");
  // nobody yet: one silhouette, asleep, and a small one peeking from behind it that adds (2026-11-24); nothing to type into
  await expect(council.locator(".council-ghost")).toHaveCount(1);
  await expect(council.locator("[data-council-eye]")).toHaveCount(2);
  await expect(council.locator(".council-ghost-small")).toHaveCount(1);
  await expect(council.locator("[data-council-add]")).toHaveCount(1);
  await expect(council.locator("input")).toHaveCount(0);
  // the small one is about 40 % of the big one, and stands at its bottom right
  await settle(ada, 900);
  const ghostBoxes = await council.evaluate((c) => {
    const big = c.querySelector(".council-ghost .council-crop")!.getBoundingClientRect();
    const small = c.querySelector(".council-ghost-small")!.getBoundingClientRect();
    return { bigH: c.querySelector<HTMLElement>(".council-ghost .council-figure")!.getBoundingClientRect().height, smallH: small.height, bigRight: big.right, smallRight: small.right, bigBottom: big.bottom, smallBottom: small.bottom };
  });
  expect(ghostBoxes.smallH / ghostBoxes.bigH).toBeGreaterThan(0.35);
  expect(ghostBoxes.smallH / ghostBoxes.bigH).toBeLessThan(0.45);
  expect(ghostBoxes.smallRight).toBeGreaterThan(ghostBoxes.bigRight);
  expect(Math.abs(ghostBoxes.smallBottom - ghostBoxes.bigBottom)).toBeLessThan(2);
  // the same silhouette however often it's drawn (chosen once for the grid)
  const ghostIs = () => council.locator(".council-ghost .council-figure").getAttribute("data-fig-id");
  const firstGhost = await ghostIs();
  await settle(ada, 300);
  expect(await ghostIs()).toBe(firstGhost);
  await look(ada, false);
  await ada.screenshot({ path: `${NEW}/01_grid-council-empty-day.png` });
  await look(ada, true);
  await ada.screenshot({ path: `${NEW}/01_grid-council-empty-night.png` });
  await look(ada, false);
  // it stands on the window's bottom edge, as wide as the open paper; the grid isn't pushed anywhere
  await settle(ada, 700);
  const bar = (await ada.locator(".council-place.is-board").boundingBox())!;
  const paper = await ada.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".side-pane");
    return { left: pane ? pane.getBoundingClientRect().right : 0, right: window.innerWidth };
  });
  expect(Math.abs(bar.y + bar.height - (await ada.evaluate(() => window.innerHeight)))).toBeLessThan(2);
  expect(await ada.evaluate(() => getComputedStyle(document.querySelector(".council-place")!).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(Math.abs(bar.x - paper.left)).toBeLessThan(2);
  expect(Math.abs(bar.x + bar.width - paper.right)).toBeLessThan(2);
  const insetTop = await ada.evaluate(() => Number(getComputedStyle(document.querySelector(".world-mask")!).getPropertyValue("--floor-t").replace("px", "")));
  expect(insetTop).toBe(44);

  // a silhouette opens the agents panel on Add an agent: who (already listed: nothing to look for), connect, avatar, add
  await council.locator("[data-council-add]").first().click();
  const add = ada.locator("[data-add-agent]");
  await expect(add.locator('[data-add-kind="claude"]')).toContainText("ready");
  await expect(add.locator('[data-add-step="2"]')).toHaveAttribute("data-add-state", "wait");
  await add.locator('[data-add-kind="claude"]').click();
  // Claude has three ways to be connected (2026-11-24: account, API key, federated; T3 is a kind of its own); the one that already is, is the one open
  await expect(add.locator("[data-add-way]")).toHaveCount(3);
  await expect(add.locator('[data-add-way="account"]')).toHaveAttribute("data-add-way-ready", "yes");
  await expect(add.locator('[data-add-way="account"]')).toHaveClass(/is-on/);
  // one line says how the way stands (2026-11-24): ready, and what it runs on
  await expect(add.locator('[data-add-connect="ready"] [data-setup-ready="account"]')).toContainText("Ready ·");
  // another way lays out its steps: the key's page, the key, the model (or, on a server older than the app, says so)
  await add.locator('[data-add-way="api"] .add-way-head').click();
  await expect(add.locator('[data-add-way="api"] [data-way-step], [data-add-way="api"] [data-add-older]').first()).toBeVisible();
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/12c_ways-to-connect.png` });
  await add.locator('[data-add-way="account"] .add-way-head').click();
  // an avatar is chosen already (the approved character), so skipping the step still gives it a face
  await expect(add.locator(".add-avatar.is-on")).toHaveAttribute("data-add-avatar", "Mochi");
  await settle(ada, 300);
  await ada.screenshot({ path: `${SHOTS}/12a_adding-an-agent.png` });
  await add.locator("[data-add-submit]").click();
  await expect(ada.locator("[data-add-agent]")).toHaveCount(0);
  const seat = council.locator('[data-council-agent="claude"]');
  await expect(seat).toBeVisible();
  await expect(seat).toHaveClass(/is-idle/);
  await expect(council).toHaveAttribute("data-council", "1");
  // one silhouette however many agents there are, and the small one to add another
  await expect(council.locator(".council-ghost")).toHaveCount(1);
  await expect(council.locator("[data-council-add]")).toHaveCount(1);
  // over its head, one bar: whose model, its name, that it runs in the cloud, and that it's connected
  const headBar = seat.locator("[data-council-bar]");
  await expect(headBar).toHaveCount(1);
  await expect(headBar.locator('.provider-mark[data-provider="claude"]')).toBeVisible();
  await expect(headBar.locator('[data-council-where="cloud"]')).toBeVisible();
  await expect(seat.locator("[data-council-offline]")).toHaveCount(0);
  // the bar is paper, not glass
  expect(await headBar.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
  // nothing to type into until it's pressed: rolling over only lifts it
  await seat.locator(".council-crop").hover();
  await expect(seat.locator("[data-council-say]")).toHaveCount(0);
  // pressed: the bar over its head becomes the line to it, with the mic and ✕, above the head (not under the figure)
  await seat.locator(".council-figure").click({ position: { x: 40, y: 40 } });
  await expect(seat.locator("[data-council-say] input")).toBeFocused();
  await expect(seat.locator("[data-council-mic]")).toBeVisible();
  await expect(seat.locator("[data-council-say-close]")).toBeVisible();
  await settle(ada, 400);
  // one bar (2026-11-24, second pass): the line is a row of the bar over its head, its name and marks still there
  const pressed = await oneBar(seat);
  expect(pressed, JSON.stringify(pressed)).toMatchObject({ bars: 1, says: 1, saysInBar: 1, barAboveHead: true });
  // and no other line to type into anywhere on the council (the line to all of them is put away)
  await expect(council.locator("[data-council-say]")).toHaveCount(1);
  expect(pressed.off).toBeLessThanOrEqual(2);
  await expect(seat.locator("[data-council-bar] [data-council-name]")).toBeVisible();
  await expect(seat.locator('[data-council-bar] [data-council-where="cloud"]')).toBeVisible();
  const line = (await seat.locator("[data-council-say]").boundingBox())!;
  const crop = (await seat.locator(".council-crop").boundingBox())!;
  expect(line.y + line.height).toBeLessThanOrEqual(crop.y + 1);
  // focused and empty, then typing, then held: opaque and on top of the stage and every figure, each time
  await look(ada, false);
  await seat.locator("[data-council-say] input").focus();
  await expectLineOnTop(seat, "grid, day, focused and empty");
  await ada.keyboard.type("how many parts are short?");
  await expectLineOnTop(seat, "grid, day, typing");
  await expect(seat.locator("[data-council-bar] [data-council-name]")).toBeVisible();
  await ada.screenshot({ path: `${NEW}/02_grid-say-typing-day.png` });
  await ada.mouse.click(10, 300);
  await expect(seat.locator("[data-council-say] input")).toHaveValue("how many parts are short?");
  await expectLineOnTop(seat, "grid, day, held (focus elsewhere)");
  // by night, and in the room (Today's look): still paper, still on top
  await look(ada, true);
  await expectLineOnTop(seat, "grid, night, held");
  await ada.screenshot({ path: `${NEW}/03_grid-say-held-night.png` });
  await ada.evaluate(() => (document.documentElement.dataset.theme = "room"));
  await settle(ada, 300);
  await expectLineOnTop(seat, "grid, room, held");
  await ada.evaluate(() => (document.documentElement.dataset.theme = "paper"));
  await look(ada, false);
  // Esc clears it, then puts it away; the council stays
  await seat.locator("[data-council-say] input").focus();
  await ada.keyboard.press("Escape");
  await expect(seat.locator("[data-council-say] input")).toHaveValue("");
  await ada.keyboard.press("Escape");
  await expect(seat.locator("[data-council-say]")).toHaveCount(0);
  await expect(council).toHaveCount(1);
  // ✕ puts it away too
  await seat.locator(".council-figure").click({ position: { x: 40, y: 40 } });
  await seat.locator("[data-council-say-close]").click();
  await expect(seat.locator("[data-council-say]")).toHaveCount(0);
  await ada.locator(".agent-info button[aria-label='Close agent details']").click();
  // at rest, too, the bar is centred on its figure
  const rest = await oneBar(seat);
  expect(rest, JSON.stringify(rest)).toMatchObject({ bars: 1, says: 0 });
  expect(rest.off).toBeLessThanOrEqual(2);
  // the seat is as wide as its figure: drawn whole at the sides
  const fit = await figuresFit(council);
  expect(fit.bad, JSON.stringify(fit.figs)).toEqual([]);
  // its own name over its head, in its bar (a seat's name, not "Claude"); it wears a character, live, and a bead says whose model it is
  const seatName = (await seat.locator("[data-council-name]").innerText()).trim();
  expect(seatName).not.toBe("");
  expect(seatName).not.toBe("Claude");
  await expect(seat.locator(".avatar-3d")).toHaveClass(/is-live/, { timeout: 15_000 });
  await expect(seat.locator('.provider-mark[data-provider="claude"]')).toBeVisible();
  const n = await frames(ada, ".council-stage");
  await expect.poll(() => frames(ada, ".council-stage")).toBeGreaterThan(n + 10);
  await settle(ada, 400);
  await ada.screenshot({ path: `${SHOTS}/12_grid-council-claude-at-rest.png` });

  // the assignment is the grid's, kept by the server
  const posted = await ada.evaluate(() => {
    const b = (window as unknown as { __foundationBoard: () => { doc: { getMap(n: string): { toJSON(): Record<string, Array<{ key: string; byName: string }>> } } } }).__foundationBoard();
    return b.doc.getMap("agents").toJSON();
  });
  expect(posted["*"].map((a) => a.key)).toEqual(["claude"]);
  expect(posted["*"][0].byName).toBe("Ada Test");

  // pressed: the agent on the right, and the council keeps to the paper that's left
  await seat.locator(".council-figure").click({ position: { x: 40, y: 40 } });
  const info = ada.locator(".agent-info");
  await expect(info).toBeVisible();
  await expect(info.locator('[data-agent-where="cloud"]')).toContainText("In the cloud");
  await expect(info).toContainText("To the whole grid, by Ada Test");
  await expect(info.locator(".avatar-3d")).toHaveAttribute("data-framing", "full");
  await settle(ada, 500);
  const moved = (await ada.locator(".council-place.is-board").boundingBox())!;
  const infoBox = (await info.boundingBox())!;
  expect(Math.abs(moved.x + moved.width - infoBox.x)).toBeLessThan(2);
  await settle(ada, 600);
  await ada.screenshot({ path: `${SHOTS}/12b_agent-pane.png` });
  // the pane's facts are legible by day and by night (the look settled first)
  for (const night of [false, true]) {
    await look(ada, night);
    for (const dd of await info.locator(".agent-info-facts dd").all()) expect(await contrastOf(dd), `${night ? "night" : "day"}: ${await dd.innerText()}`).toBeGreaterThanOrEqual(4.5);
    await ada.screenshot({ path: `${NEW}/11_agent-pane-${night ? "night" : "day"}.png` });
  }
  await look(ada, false);

  // taken off, the seat goes, for good
  await info.locator(".agent-info-off").click();
  await expect(council).toHaveAttribute("data-council", "0");
  await ada.locator("body").press("Escape");
  await expect(council).toHaveCount(0);
  await expect(info).toHaveCount(0);
});

test("an agent at work stands in the council on its cursor's colour, wearing a character; its bar says what it's doing, the strip over the bar doesn't, and a second person sees its run card", async ({ browser }) => {
  const made = await ctx.request.post(`${CLIENT}/api/boards`, { data: { name: `Council ${Date.now().toString(36)}` } });
  work = ((await made.json()) as { id: string }).id;
  await ada.goto(`/?board=${work}`);
  await waitLive(ada);
  // Kai watches the same grid, with its council open
  const kai = (await person(browser, "Kai Test", "kai@normal.dev", work)).page;
  await waitLive(kai);
  await kai.locator("[data-council-open]").click();
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
  await expect(council).toHaveAttribute("data-council", "0");
  // a line to everyone, from the council's own buttons: with nobody assigned it goes to Claude
  await council.locator("[data-council-all]").click();
  await council.locator(".council-tools-say .council-say-text").fill("make a section called “Supply” with the parts");
  await council.locator(".council-tools-say .council-say-text").press("Enter");

  const seat = council.locator(".council-seat:not(.council-ghost)").first();
  await expect(seat).toBeVisible({ timeout: 10_000 });
  const name = (await seat.getAttribute("data-council-seat"))!;
  // it arrives with a wave, then gets on with it
  await expect(seat).toHaveAttribute("data-mood", "waving");
  // Kai sees it over the same seat on his council, with its run card, while it hasn't gone into a section yet (an agent
  // asked from Ada's grid council is that council's on her screen; on his it belongs where it works)
  const kaiSeat = kai.locator(`.council [data-council-seat="${name}"]`);
  await expect(kaiSeat).toBeVisible({ timeout: 10_000 });
  await expect(kaiSeat.locator("[data-run-card]")).toBeVisible();
  await expect(kaiSeat.locator("[data-council-doing]")).toBeVisible();
  // Kai didn't ask: no Stop for him
  await expect(kaiSeat.locator("[data-council-stop]")).toHaveCount(0);
  const kaiBar = await oneBar(kaiSeat);
  expect(kaiBar.off, JSON.stringify(kaiBar)).toBeLessThanOrEqual(2);
  // the plan, if the server carries it on the crew's awareness (docs/agent-harness.md §2); an older one sends none
  const planned = await kaiSeat
    .locator(".run-card.has-plan")
    .waitFor({ timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  test.info().annotations.push({ type: "plan on awareness", description: planned ? "yes: Kai's card shows the plan" : "no: the server sent no plan; the card stayed the working chip" });
  console.log(`[council] plan on Kai's card: ${planned}`);
  await kai.screenshot({ path: `${NEW}/05_kai-sees-the-run-card.png` });
  // the seat stands on the colour its cursor has
  const cursor = ada.locator(".crew-cursor", { hasText: name }).first();
  await expect(cursor).toBeVisible({ timeout: 10_000 });
  const colours = await ada.evaluate((n) => {
    const seat = document.querySelector<HTMLElement>(`[data-council-seat="${n}"]`)!;
    const cur = [...document.querySelectorAll<HTMLElement>(".crew-cursor")].find((c) => c.textContent?.includes(n))!;
    const read = (el: HTMLElement) => getComputedStyle(el).getPropertyValue("--crew").trim();
    return { seat: read(seat), cursor: read(cur) };
  }, name);
  expect(colours.seat).not.toBe("");
  expect(colours.seat).toBe(colours.cursor);
  // under its cursor's name it says which agent it is; it wears the character, live, and says what its cursor says
  await expect(seat.locator("[data-council-name]")).toHaveText(name);
  await expect(seat).toHaveAttribute("data-council-agent", "claude");
  await expect(seat.locator(".avatar-3d")).toHaveClass(/is-live/, { timeout: 15_000 });
  await expect(seat.locator("[data-council-name]")).toHaveAttribute("data-tip", /.+/);
  await expect.poll(async () => seat.getAttribute("data-mood"), { timeout: 10_000 }).toMatch(/thinking|working/);
  // 2026-11-24: what it's doing is in the bar over its head, alive, with Follow, Open and Stop for Ada (she asked)
  const doing = seat.locator("[data-council-doing]");
  await expect(doing).toBeVisible();
  await expect.poll(async () => (await doing.innerText()).trim().length).toBeGreaterThan(3);
  await expect(seat.locator("[data-council-follow]")).toBeVisible();
  await expect(seat.locator("[data-council-open-run]")).toBeVisible();
  await expect(seat.locator("[data-council-stop]")).toBeVisible();
  expect(await seat.locator(".council-bar-live > i").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("council-beat");
  // …and not in the strip over the bottom bar: it has a head to hang it on
  await expect(ada.locator(`.talk-sheet [data-crew-row="${name}"]`)).toHaveCount(0);
  await expect(ada.locator(".talk-sheet.is-roster")).toHaveCount(0);
  // its run card, beside its head; and Kai sees one over the same seat
  await expect(seat.locator("[data-run-card]")).toBeVisible();
  const fitWorking = await figuresFit(council);
  expect(fitWorking.bad, JSON.stringify(fitWorking.figs)).toEqual([]);
  const workingBar = await oneBar(seat);
  expect(workingBar.off, JSON.stringify(workingBar)).toBeLessThanOrEqual(2);
  // the run card never runs past the window's bottom edge, nor under the bottom bar (1440 × 900 here; 1280 × 700 in the next check)
  await expectCardInWindow(ada, seat, "1440×900");
  // pressed while it works: still one bar, what it's doing above the line to it
  await seat.locator(".council-figure").click({ position: { x: 40, y: 40 } });
  await expect(seat.locator("[data-council-say] input")).toBeFocused();
  const workingPressed = await oneBar(seat);
  expect(workingPressed, JSON.stringify(workingPressed)).toMatchObject({ bars: 1, says: 1, saysInBar: 1, barAboveHead: true });
  // and no other line to type into anywhere on the council (the line to all of them is put away)
  await expect(council.locator("[data-council-say]")).toHaveCount(1);
  expect(workingPressed.off).toBeLessThanOrEqual(2);
  if ((await seat.getAttribute("class"))?.includes("is-working")) await expect(seat.locator("[data-council-bar] [data-council-doing]")).toBeVisible();
  await settle(ada, 250);
  await ada.screenshot({ path: `${NEW}/04b_grid-working-pressed-day.png` });
  await ada.keyboard.press("Escape");
  await expect(seat.locator("[data-council-say]")).toHaveCount(0);
  await ada.screenshot({ path: `${SHOTS}/13_council-agent-at-work.png` });
  await ada.screenshot({ path: `${NEW}/04_grid-agent-at-work-day.png` });

  // pressed: its pane shows it head to toe, with what it was asked and who for
  await seat.locator(".council-figure").click({ position: { x: 40, y: 40 } });
  const info = ada.locator(".agent-info");
  await expect(info).toHaveAttribute("data-agent-info", name);
  await expect(info.locator(".avatar-3d")).toHaveAttribute("data-framing", "full");
  await expect(info).toContainText("Supply");
  await expect(info).toContainText("for Ada");
  await expect(info).toContainText("Not assigned: it's here for one ask");
  await settle(ada, 700);
  await ada.screenshot({ path: `${SHOTS}/14_council-seat-selected.png` });

  // done: it cheers, then leaves; the council is empty again
  await expect.poll(async () => (await council.locator(".council-seat:not(.council-ghost)").count()) === 0 || (await seat.getAttribute("data-mood")) === "happy", { timeout: 40_000 }).toBe(true);
  await expect(council).toHaveAttribute("data-council", "0", { timeout: 20_000 });
  await kai.context().close();
});

test("a person's own ask from the voice sheet opens the grid's council by itself, and its work shows over the agent's head, not in the strip", async () => {
  await ada.locator("body").press("Escape");
  await expect(ada.locator(".council")).toHaveCount(0);
  // this one by night, in a short window: the run card must still end above the window's bottom edge
  await ada.setViewportSize({ width: 1280, height: 700 });
  await look(ada, true);
  // a tap of Space opens the sheet for typing
  await ada.locator("body").press("Space");
  const field = ada.locator(".talk-field");
  await expect(field).toBeVisible();
  await field.fill("make a section called “Yard” with the parts");
  await field.press("Enter");
  const council = ada.locator(".council-place.is-board .council");
  await expect(council).toBeVisible({ timeout: 10_000 });
  const seat = council.locator(".council-seat:not(.council-ghost)").first();
  await expect(seat.locator("[data-council-doing]")).toBeVisible({ timeout: 10_000 });
  const name = (await seat.getAttribute("data-council-seat"))!;
  await expect(ada.locator(`.talk-sheet [data-crew-row="${name}"]`)).toHaveCount(0);
  await expect(ada.locator(".talk-sheet.is-roster")).toHaveCount(0);
  await expect(seat.locator("[data-run-card]")).toBeVisible();
  await expectCardInWindow(ada, seat, "1280×700");
  const bar = await oneBar(seat);
  expect(bar.off, JSON.stringify(bar)).toBeLessThanOrEqual(2);
  await settle(ada, 250);
  await ada.screenshot({ path: `${NEW}/06_voice-ask-opens-the-council-night-1280x700.png` });
  await seat.locator(".council-figure").click({ position: { x: 40, y: 40 } });
  await expect(seat.locator("[data-council-say] input")).toBeFocused();
  expect(await oneBar(seat)).toMatchObject({ bars: 1, says: 1, saysInBar: 1, barAboveHead: true });
  // and no other line to type into anywhere on the council (the line to all of them is put away)
  await expect(council.locator("[data-council-say]")).toHaveCount(1);
  await settle(ada, 250);
  await ada.screenshot({ path: `${NEW}/04b_grid-working-pressed-night.png` });
  await ada.keyboard.press("Escape");
  await ada.locator(".agent-info button[aria-label='Close agent details']").click();
  await expect(council).toHaveAttribute("data-council", "0", { timeout: 40_000 });
  await ada.setViewportSize({ width: 1440, height: 900 });
  await look(ada, false);
});

test("a section's council stands on top of its section and holds only that section's agents", async () => {
  await ada.keyboard.press("Escape");
  const sectionNamed = (n: string) => ada.evaluate((name) => Object.values((window as unknown as { __foundation: Store }).__foundation.getState().sections).find((s) => s.name === name)?.id ?? null, n);
  const councilOf = async (id: string, name: string) => {
    await ada.evaluate((sid) => (window as unknown as { __foundation: Store }).__foundation.setState({ activeSectionId: sid }), id);
    await ada.keyboard.press("Control+k");
    // the bar keeps what was last typed: write over it
    await ada.locator(".cmd-field input").fill("Council: the agents in");
    await ada.locator(".cmd-row", { hasText: `Council: the agents in ${name}` }).first().click();
    await expect(ada.locator(".council")).toHaveAttribute("aria-label", `Council of ${name}`);
  };
  const supply = (await sectionNamed("Supply"))!;
  expect(supply).not.toBeNull();
  // a second ask: an agent builds another section, and is at work there for a while
  await ada.locator("[data-council-open]").click();
  const council = ada.locator(".council");
await council.locator("[data-council-all]").click();
  await council.locator(".council-tools-say .council-say-text").fill("make a section called “Depot” with the parts, hook up FactoryForm, and get help");
  await council.locator(".council-tools-say .council-say-text").press("Enter");
  await expect.poll(() => sectionNamed("Depot"), { timeout: 20_000 }).not.toBeNull();
  const depot = (await sectionNamed("Depot"))!;
  await expect(council.locator(".council-seat:not(.council-ghost)").first()).toBeVisible({ timeout: 10_000 });

  // Supply's council: nobody belongs there and nobody is at work there
  await councilOf(supply, "Supply");
  await expect(ada.locator(".council-place.is-section")).toHaveCount(1);
  await expect(council).toHaveAttribute("data-council", "0");
  // it stands on its section's top edge, as wide as the section, over what's above; the section itself doesn't move
  const over = async (id: string) => {
    await settle(ada, 700);
    const card = ada.locator(`.section-card[data-section-id="${id}"]`);
    await expect(card.locator(".council-place.is-section")).toHaveCount(1);
    const sec = (await card.boundingBox())!;
    const band = (await card.locator(".council-place.is-section").boundingBox())!;
    const head = (await card.locator(".section-header").boundingBox())!;
    expect(Math.abs(band.x - sec.x)).toBeLessThan(3);
    expect(Math.abs(band.width - sec.width)).toBeLessThan(4);
    expect(Math.abs(band.y + band.height - sec.y)).toBeLessThan(3);
    expect(head.y - sec.y).toBeLessThan(6);
  };
  await over(supply);
  // Depot's council: the agent building it was asked from the grid's council, so it stays the grid's while it works
  // (2026-11-17: "every section has a different council"); Depot's has nobody of its own
  await councilOf(depot, "Depot");
  await expect(council).toHaveAttribute("data-council", "0");
  await over(depot);
  await ada.screenshot({ path: `${SHOTS}/16_council-of-a-section.png` });
  await ada.keyboard.press("Escape");
  await expect(council).toHaveCount(0);

  // a seat of Supply's own: pressed, the line over its head is opaque and on top, as on the grid's
  const posted = await ctx.request.post(`${CLIENT}/api/boards/${work}/agents`, { data: { place: supply, agent: "claude" } });
  expect(posted.ok(), await posted.text()).toBe(true);
  // Supply in view (its council stands at its right, on its top edge)
  await ada.evaluate((sid) => (window as unknown as { __foundation: Store }).__foundation.setState({ snapRequest: { kind: "section", id: sid, nonce: Math.random() } }), supply);
  await settle(ada, 1200);
  await councilOf(supply, "Supply");
  const seat = council.locator('[data-council-agent="claude"]');
  await expect(seat).toBeVisible();
  await expect(council.locator(".council-ghost")).toHaveCount(1);
  await settle(ada, 900);
  await seat.locator(".council-figure").click({ position: { x: 40, y: 40 } });
  await expect(seat.locator("[data-council-say] input")).toBeFocused();
  await settle(ada, 400);
  await look(ada, false);
  await seat.locator("[data-council-say] input").focus();
  await expectLineOnTop(seat, "section, day, focused and empty");
  await ada.keyboard.type("what's short here?");
  await expectLineOnTop(seat, "section, day, typing");
  const fit = await figuresFit(council);
  expect(fit.bad, JSON.stringify(fit.figs)).toEqual([]);
  const sectionBar = await oneBar(seat);
  expect(sectionBar, JSON.stringify(sectionBar)).toMatchObject({ bars: 1, says: 1, saysInBar: 1, barAboveHead: true });
  // and no other line to type into anywhere on the council (the line to all of them is put away)
  await expect(council.locator("[data-council-say]")).toHaveCount(1);
  expect(sectionBar.off).toBeLessThanOrEqual(2);
  await ada.screenshot({ path: `${NEW}/07_section-say-typing-day.png` });
  await look(ada, true);
  await seat.locator("[data-council-say] input").focus();
  await expectLineOnTop(seat, "section, night, typing");
  await ada.screenshot({ path: `${NEW}/08_section-say-typing-night.png` });
  await ada.evaluate(() => (document.documentElement.dataset.theme = "room"));
  await settle(ada, 300);
  await expectLineOnTop(seat, "section, room, typing");
  await ada.evaluate(() => (document.documentElement.dataset.theme = "paper"));
  await look(ada, false);
  await seat.locator("[data-council-say] input").focus();
  // Esc in the line clears it, then puts it away; then the council closes
  await ada.keyboard.press("Escape");
  await expect(seat.locator("[data-council-say] input")).toHaveValue("");
  await ada.keyboard.press("Escape");
  await expect(seat.locator("[data-council-say]")).toHaveCount(0);
  await ada.locator("body").press("Escape");
  await expect(council).toHaveCount(0);
});

test("#/design shows the council and the agent's pane, day and night", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await c.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    const p = await c.newPage();
    await p.goto("/#/design");
    const demo = p.locator("[data-design-council]");
    await demo.scrollIntoViewIfNeeded();
    const main = demo.locator(".council").first();
    await expect(main.locator(".council-seat:not(.council-ghost)")).toHaveCount(4);
    // a working seat with a plan and a thought, a pending one, an idle one, an offline one
    await expect(main.locator('[data-run-card="working"].has-plan')).toHaveCount(1);
    await expect(main.locator(".run-thought")).toHaveCount(1);
    await expect(main.locator('[data-run-card="pending"]')).toHaveCount(1);
    await expect(main.locator("[data-council-doing]")).toHaveCount(1);
    await expect(main.locator("[data-council-offline]")).toHaveCount(1);
    await expect(main.locator("[data-council-bar]")).toHaveCount(4);
    await expect(main.locator(".provider-mark")).not.toHaveCount(0);
    // one sleeping silhouette and the small one that adds
    await expect(main.locator(".council-ghost")).toHaveCount(1);
    await expect(main.locator("[data-council-eye]")).toHaveCount(2);
    await expect(main.locator("[data-council-add]")).toHaveCount(1);
    // the line, pressed open over a head
    await expect(demo.locator("[data-design-council-say] [data-council-say]")).toBeVisible();
    await expect(demo.locator("[data-council-talk]")).toContainText("To all 4");
    await expect(demo.locator(".design-agent-info").first()).toContainText("ChatGPT");
    await expect(demo.locator("[data-design-agent-working] .run-card.is-full .run-step")).toHaveCount(5);
    await settle(p, 1400);
    const fit = await figuresFit(main);
    expect(fit.bad, JSON.stringify(fit.figs)).toEqual([]);
    await demo.locator("[data-design-council-say]").scrollIntoViewIfNeeded();
    await settle(p, 300);
    await expectLineOnTop(demo.locator("[data-design-council-say] .council-seat").first(), `design, ${scheme}`);
    // the pressed demo: one bar, its name and marks over the line
    const hotSeat = demo.locator("[data-design-council-say] .council-seat").first();
    expect(await oneBar(hotSeat)).toMatchObject({ bars: 1, says: 1, saysInBar: 1 });
    await expect(demo.locator("[data-design-council-say] [data-council-eye]")).toHaveCount(2);
    await expect(hotSeat.locator("[data-council-bar] [data-council-name]")).toBeVisible();
    // each part in view on its own (an element taller than the window isn't painted past it): nothing clipped
    const when = scheme === "light" ? "day" : "night";
    await demo.screenshot({ path: `${SHOTS}/15_design-${when}.png` });
    const parts: Array<[string, string]> = [
      ["[data-design-council-main]", "a_council"],
      ["[data-design-council-say]", "b_pressed"],
      [".design-council-run", "c_run-cards"],
      ["[data-design-agent-working] .agent-info-now", "d_agent-pane-run-card"],
    ];
    for (const [sel, name] of parts) {
      const part = demo.locator(sel);
      await part.scrollIntoViewIfNeeded();
      await settle(p, 400);
      // its top and bottom inside the window: the shot holds all of it
      const box = (await part.boundingBox())!;
      expect(box.y, `${name} top`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(900);
      await part.screenshot({ path: `${NEW}/09${name}-${when}.png` });
    }
    // the run cards on the page: none cut inside (their last line within them)
    for (const card of await demo.locator(".run-card").all()) {
      const ok = await card.evaluate((el) => (el.lastElementChild ? el.lastElementChild.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1 : true));
      expect(ok).toBe(true);
    }
    await c.close();
  }
});

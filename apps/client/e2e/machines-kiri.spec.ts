/**
 * The machine card redrawn, and what came with it (Josh, 2026-11-17: "we can do a lot better with this Kiri
 * interface … see its web, address … buttons and selectors much larger … permissions panel … Start, restart
 * and remove in the top bar … docker hub … a kubernetes cluster and pods … the sharing of the link … functions
 * that are able to reach into the VM … an example of that on the Character studio … Scroll wheel should be zoom
 * … the window buttons should contrast in the today mode"), in a real browser against the engine on this
 * computer (the machine parts skip where none answers).
 *
 *   1. The wheel: a mouse wheel zooms the grid; a trackpad's small steps pan it.
 *   2. Today: the window's buttons are white over the room.
 *   3. A machine's head: Start from Docker Hub's answers and the tiles, the title row's actions, the address,
 *      the Foundation link through this server (a stranger gets the sign-in page), Share, a public link (with
 *      the stand-in cloudflared when E2E_CLOUDFLARED is set), Access.
 *   4. The studio's example: Process in a machine on a collection → Start puts ImageMagick and three functions
 *      in → Run trims two pictures → they land in the second collection; describe writes JSON.
 *   5. Kubernetes: a cluster laid in a section, started, both nodes ready, a pod run, opened as a card, a shell
 *      in it, deleted; every node removed.
 *
 * Screenshots land in docs/evidence/2026-11-17_machine-card/.
 */

import { test, expect, request as pwRequest, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { CLIENT, person, settle, waitLive } from "./helpers";

const SHOTS = "../../docs/evidence/2026-11-17_machine-card";
mkdirSync(SHOTS, { recursive: true });

type Tool = (name: string, data: object) => Promise<{ result?: any; error?: string }>;

async function engineUp(context: BrowserContext) {
  const r = (await (await context.request.get(`${CLIENT}/api/machines/engines`)).json()) as { engines: Array<{ id: string; up: boolean }> };
  return r.engines.some((e) => e.up);
}
async function newBoard(context: BrowserContext, name: string): Promise<{ board: string; tool: Tool }> {
  const made = await context.request.post(`${CLIENT}/api/boards`, { data: { name: `${name} ${Date.now().toString(36)}` } });
  const board = ((await made.json()) as { id: string }).id;
  const tool: Tool = async (n, data) => (await context.request.post(`${CLIENT}/api/boards/${board}/tools/${n}`, { data })).json();
  return { board, tool };
}
const state = (p: Page) => p.evaluate(() => (window as any).__foundation.getState());
const frame = (page: Page, card: string) =>
  page.evaluate((id) => {
    const f = (window as any).__foundation;
    f.setState({ snapRequest: { kind: "section", id: f.getState().panels[id].sectionId, nonce: Math.random() } });
  }, card);
const drawnWidth = (page: Page, sel: string) => page.evaluate((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect(), sel);
const screenText = (page: Page, scope: string) => page.locator(`${scope} .xterm-rows`).first().innerText();

test("the wheel zooms, a trackpad pans; Today's window buttons are white", async ({ browser }) => {
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  const { board, tool } = await newBoard(context, "Wheel");
  await tool("add_section", { name: "Notes" });
  const note = (await tool("add_note", { section: "Notes", title: "A note", markdown: "something to measure" })).result;
  const noteId = (note?.card ?? note?.id ?? note?.panel) as string;
  try {
    await page.goto(`/?board=${board}`);
    await waitLive(page);
    await settle(page, 1500);
    void noteId;
    const sel = ".section-card";
    const a = await drawnWidth(page, sel);
    // a mouse wheel's notch (100 px, whole, one axis) over the paper: a zoom about the pointer
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 100);
    await settle(page, 1200);
    const b = await drawnWidth(page, sel);
    expect(b.width, "a mouse wheel zooms out").toBeLessThan(a.width * 0.95);
    await page.mouse.wheel(0, -100);
    await settle(page, 1200);
    const c = await drawnWidth(page, sel);
    expect(c.width, "and back in").toBeGreaterThan(b.width * 1.05);
    // a trackpad's two-finger scroll: small, fractional, with a sideways part: a pan, the same size
    await settle(page, 400);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(1.5, 6.5);
    await settle(page, 600);
    const d = await drawnWidth(page, sel);
    expect(Math.abs(d.width - c.width), "a pan keeps the size").toBeLessThan(1);
    expect(d.top, "and moves the paper").toBeLessThan(c.top - 20);
    // Today: the window's own buttons (the desktop app draws them) are white over the room
    await page.locator("[data-top-today]").click();
    await page.waitForFunction(() => document.querySelector(".shell.is-place-today"));
    await page.evaluate(() => {
      const w = document.createElement("div");
      w.className = "window-controls";
      w.innerHTML = '<button class="win-btn">_</button><button class="win-btn is-close">×</button>';
      document.body.appendChild(w);
    });
    const look = await page.evaluate(() => {
      const b = document.querySelector(".window-controls .win-btn") as HTMLElement;
      return { color: getComputedStyle(b).color, filter: getComputedStyle(b).filter };
    });
    expect(look.color).toBe("rgb(255, 255, 255)");
    expect(look.filter).toContain("drop-shadow");
    await settle(page, 600);
    await page.screenshot({ path: `${SHOTS}/01_today-window-buttons.png`, clip: { x: 1100, y: 0, width: 340, height: 120 } });
  } finally {
    await context.close();
  }
});

test("a machine's head, its address, the Foundation link, Share, Access and Docker Hub", async ({ browser }) => {
  test.setTimeout(600_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: CLIENT });
  const { board, tool } = await newBoard(context, "Head");
  await tool("add_section", { name: "Box" });
  const card = (await tool("propose_machine", { section: "Box", name: `web-${Date.now().toString(36)}` })).result.card as string;
  const slot = `[data-obj-id="${card}"]`;
  try {
    await page.goto(`/?board=${board}`);
    await waitLive(page);
    await page.waitForFunction(() => Object.keys((window as any).__foundation.getState().panels).length > 0);
    await frame(page, card);
    await page.locator(`${slot} .machine-distro`).first().waitFor();
    await settle(page, 1200);

    // Docker Hub: a few letters, its answers as rows, a row's tags as chips, a chip the image
    const hub = page.locator(`${slot} .machine-hub-field input`);
    await hub.fill("redis");
    const rows = page.locator(`${slot} [data-hub-repo]`);
    const hubUp = await rows
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (hubUp) {
      await expect(page.locator(`${slot} [data-hub-repo="redis"] .machine-hub-badge`)).toHaveText("Official");
      await page.locator(`${slot} [data-hub-repo="redis"]`).click();
      const tag = page.locator(`${slot} [data-hub-tag]`).first();
      await tag.waitFor({ timeout: 15_000 });
      const t = await tag.getAttribute("data-hub-tag");
      await tag.click();
      await expect(page.locator(`${slot} .machine-picked code`)).toHaveText(`redis:${t}`);
      await page.screenshot({ path: `${SHOTS}/02_start_docker-hub.png` });
    } else test.info().annotations.push({ type: "hub", description: `Docker Hub didn't answer: ${await page.locator(`${slot} .machine-hub-err`).innerText().catch(() => "no rows")}` });
    // then Alpine (busybox has a web server), with port 8080
    await hub.fill("");
    await page.locator(`${slot} .machine-distro`, { hasText: "Alpine" }).click();
    await page.locator(`${slot} .machine-ports-field input`).fill("8080");
    await page.locator(`${slot} .machine-hero-button`).click();
    await page.locator(`${slot} .machine-term .xterm`).waitFor({ timeout: 180_000 });
    await settle(page, 2000);

    // the title row: the name, and Stop, Restart, Remove as big buttons
    await expect(page.locator(`${slot} .machine-title`)).toHaveText(/^web-/);
    const acts = page.locator(`${slot} .machine-actions .machine-act`);
    await expect(acts).toHaveCount(3);
    for (const h of await acts.evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight))) expect(h).toBeGreaterThanOrEqual(32);
    await expect(page.locator(`${slot} .machine-view-tab`)).toHaveCount(4);
    // a web page in the machine
    await page.locator(`${slot} .machine-term`).click();
    // (Alpine's busybox has no httpd; busybox-extras does. The marker is computed, so the typed line can't match it)
    await page.keyboard.type(`apk add -q --no-cache busybox-extras && mkdir -p /srv && printf '<a href="/x.html">x</a> served-by-busybox' > /srv/index.html && echo ok-x > /srv/x.html && busybox-extras httpd -p 8080 -h /srv && echo up-$((6*7))\n`);
    await expect.poll(() => screenText(page, slot), { timeout: 60_000 }).toContain("up-42");
    // the address: 127.0.0.1 and the port the engine gave, copied
    const url = (await page.locator(`${slot} .machine-address-url`).innerText()).trim();
    expect(url).toMatch(/^127\.0\.0\.1:\d+$/);
    await page.locator(`${slot} .machine-addr-btn[aria-label="Copy the address"]`).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`http://${url}`);
    await page.screenshot({ path: `${SHOTS}/03_head_address.png` });

    // the Foundation link: relayed by this server, links kept under it; a stranger is asked to sign in
    const link = `${CLIENT}/m/${board}/${card}/8080/`;
    const got = await context.request.get(link);
    expect(got.status()).toBe(200);
    const html = await got.text();
    expect(html).toContain("served-by-busybox");
    expect(html).toContain(`href="/m/${board}/${card}/8080/x.html"`);
    expect(await (await context.request.get(`${CLIENT}/m/${board}/${card}/8080/x.html`)).text()).toContain("ok-x");
    const stranger = await pwRequest.newContext();
    expect((await stranger.get(link)).status()).toBe(401);
    await stranger.dispose();

    // Share: the Foundation link copied, then a public link (the stand-in cloudflared, or the words for none)
    await page.locator(`${slot} [data-machine-share]`).click();
    const share = page.locator(`${slot} [data-machine-share-panel]`);
    await expect(share).toBeVisible();
    await share.locator('[data-machine-share-copy="foundation"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/m/${board}/${card}/8080/$`));
    await share.locator("[data-machine-share-public]").click();
    if (process.env.E2E_CLOUDFLARED) {
      await expect(share).toContainText("trycloudflare.com", { timeout: 20_000 });
      await expect(page.locator(`${slot} .machine-address-public`)).toContainText("Public");
      await page.screenshot({ path: `${SHOTS}/04_share_public-link.png` });
      await share.locator("[data-machine-share-stop]").click();
      await expect(page.locator(`${slot} .machine-address-public`)).toHaveCount(0, { timeout: 10_000 });
    } else {
      await expect(share).toContainText("cloudflared isn't on this computer", { timeout: 10_000 });
      await page.screenshot({ path: `${SHOTS}/04_share_no-cloudflared.png` });
    }
    await page.keyboard.press("Escape");

    // Access: a row each, with icons
    await page.locator(`${slot} [data-machine-view="access"]`).click();
    await expect(page.locator(`${slot} [data-access]`)).toHaveCount(5);
    await expect(page.locator(`${slot} [data-access] .machine-access-icon`)).toHaveCount(5);
    await page.screenshot({ path: `${SHOTS}/05_access.png` });
    for (const scheme of ["light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await settle(page, 1600);
      await page.screenshot({ path: `${SHOTS}/05_access_day.png` });
    }
  } finally {
    await context.request.post(`${CLIENT}/api/boards/${board}/machines/${card}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

/** a picture with empty margins round a disc, made in the page, uploaded to the archive */
async function picture(page: Page, board: string, name: string, hue: number): Promise<string> {
  return page.evaluate(
    async ({ board, name, hue }) => {
      const c = document.createElement("canvas");
      c.width = 320;
      c.height = 220;
      const g = c.getContext("2d")!;
      g.fillStyle = `hsl(${hue} 70% 50%)`;
      g.beginPath();
      g.arc(160, 110, 50, 0, Math.PI * 2);
      g.fill();
      const blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), "image/png"));
      const r = await fetch(`/api/files?board=${encodeURIComponent(board)}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "image/png" }, body: blob });
      return ((await r.json()) as { file: { id: string } }).file.id;
    },
    { board, name, hue },
  );
}

test("the studio's example: a collection's pictures through a machine's function into another collection", async ({ browser }) => {
  test.setTimeout(900_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  const { board, tool } = await newBoard(context, "Studio");
  await tool("add_section", { name: "Flow" });
  const laid = await tool("add_character_pipeline", { section: "Flow", set: "Demo" });
  expect(laid.error ?? null).toBeNull();
  let machine = "";
  try {
    await page.goto(`/?board=${board}`);
    await waitLive(page);
    await page.waitForFunction(() => Object.values((window as any).__foundation.getState().panels).some((p: any) => p.panel === "collection"));
    const coll = (Object.values((await state(page)).panels) as any[]).find((p) => p.panel === "collection");
    for (const [i, hue] of [20, 200].entries()) await tool("collection_put", { collection: coll.id, file_id: await picture(page, board, `disc-${i + 1}.png`, hue) });
    await frame(page, coll.id);
    await settle(page, 1500);
    // Process in a machine: a machine and a second collection, wired through fn:trim-resize
    await page.locator(`[data-obj-id="${coll.id}"] [data-coll-machine]`).click();
    await page.waitForFunction(() => Object.values((window as any).__foundation.getState().panels).some((p: any) => p.panel === "machine"));
    const st = await state(page);
    machine = (Object.values(st.panels) as any[]).find((p) => p.panel === "machine").id;
    const out = (Object.values(st.panels) as any[]).find((p) => p.panel === "collection" && p.id !== coll.id);
    expect(out.name).toMatch(/^Processed · /);
    const links = Object.values(st.links) as any[];
    expect(links.some((l) => l.from.panel === coll.id && l.to.panel === machine), "collection → machine").toBe(true);
    expect(links.some((l) => l.from.panel === machine && l.to.panel === out.id), "machine → collection").toBe(true);
    await settle(page, 1200);
    await page.screenshot({ path: `${SHOTS}/06_process-in-a-machine_laid.png` });
    // its Start: Ubuntu, then ImageMagick and the three functions go in by themselves
    const slot = `[data-obj-id="${machine}"]`;
    await settle(page, 1500); // the card brings the machine into view
    await page.locator(`${slot} .machine-hero-button`).click();
    await page.locator(`${slot} .machine-term .xterm`).waitFor({ timeout: 240_000 }).catch(async (e) => {
      await page.screenshot({ path: `${SHOTS}/zz_studio-start.png` });
      const seen = await page.evaluate(async (sel) => {
        const els = [...document.querySelectorAll<HTMLElement>(sel)];
        return Promise.all(els.map((el) => new Promise((ok) => { const io = new IntersectionObserver(([x]) => { io.disconnect(); const r = el.getBoundingClientRect(); ok({ hit: x.isIntersecting, ratio: x.intersectionRatio, w: r.width, ow: el.offsetWidth, x: r.x, y: r.y, inSection: !!el.closest(".section-content"), clipped: x.intersectionRect.width, seen: el.dataset.seen, big: el.dataset.big, all: [...document.querySelectorAll(".machine-body")].map((b) => (b as HTMLElement).dataset.seen + "/" + (b as HTMLElement).dataset.big) }); }, { rootMargin: "200px" }); io.observe(el); })));
      }, `${slot} .machine-body`);
      throw new Error(`seen: ${JSON.stringify(seen)}
${e.message}
the card said: ${await page.locator(`${slot} .machine-body`).innerText().catch(() => "?")}`);
    });
    await page.locator(`${slot} [data-machine-view="io"]`).click();
    await expect(page.locator(`${slot} [data-machine-fn="trim-resize"]`)).toBeVisible({ timeout: 420_000 });
    await expect(page.locator(`${slot} [data-machine-fn]`)).toHaveCount(3);
    await expect(page.locator(`${slot} [data-machine-fn="trim-resize"]`)).toContainText("2 new", { timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/07_functions.png` });
    // Run: the two pictures, trimmed to their discs, in the second collection
    const [ran] = await Promise.all([page.waitForResponse((r) => r.url().includes("/functions/trim-resize/run"), { timeout: 300_000 }), page.locator(`${slot} [data-machine-fn-run="trim-resize"]`).click()]);
    expect(ran.status(), `the run: ${await ran.text()}`).toBe(200);
    await expect
      .poll(async () => ((await tool("read_collection", { collection: out.id })).result?.items ?? []).length, { timeout: 120_000 })
      .toBe(2)
      .catch(async (e) => {
        await page.screenshot({ path: `${SHOTS}/zz_studio-run.png` });
        const toasts = await page.locator(".toast, [role=status]").allInnerTexts().catch(() => []);
        throw new Error(`${(e as Error).message}
the function said: ${await page.locator(`${slot} [data-machine-fn="trim-resize"]`).innerText()}
toasts: ${toasts.join(" | ")}`);
      });
    const items = (await tool("read_collection", { collection: out.id })).result.items as Array<{ src: string; name: string }>;
    for (const it of items) {
      const size = await page.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return { w: img.naturalWidth, h: img.naturalHeight };
      }, it.src);
      // trimmed to the disc (100 × 100 and an edge of antialiasing), not the 320 × 220 it came as
      expect(size.w, it.name).toBeLessThan(120);
      expect(size.h, it.name).toBeLessThan(120);
    }
    await expect(page.locator(`${slot} [data-machine-fn="trim-resize"]`)).toContainText("2 in, 2 out");
    await expect(page.locator(`${slot} [data-machine-fn="trim-resize"]`)).toContainText("0 new");
    // describe writes JSON: shown under it
    await page.locator(`${slot} [data-machine-fn-run="describe"]`).click();
    await expect(page.locator(`${slot} [data-machine-fn="describe"] .machine-fn-text`)).toContainText('"w":320', { timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/08_functions_ran.png` });
    await frame(page, out.id);
    await settle(page, 1500);
    await page.screenshot({ path: `${SHOTS}/09_processed-collection.png` });
  } finally {
    if (machine) await context.request.post(`${CLIENT}/api/boards/${board}/machines/${machine}/remove`, { data: { confirm: true } });
    await context.close();
  }
});

test("Kubernetes: a cluster in a section, its nodes ready, a pod run, opened as a card with a shell, deleted", async ({ browser }) => {
  test.setTimeout(900_000);
  const { context, page } = await person(browser, "Ada Test", "ada@normal.dev");
  test.skip(!(await engineUp(context)), "no container engine answers on this computer");
  const { board, tool } = await newBoard(context, "Cluster");
  await tool("add_section", { name: "K8s" });
  const cards: string[] = [];
  try {
    await page.goto(`/?board=${board}`);
    await waitLive(page);
    const section = (Object.values((await state(page)).sections) as any[]).find((s) => s.name === "K8s").id;
    const laid = await (await context.request.post(`${CLIENT}/api/boards/${board}/clusters`, { data: { section, name: `lab${Date.now().toString(36).slice(-4)}`, workers: 1 } })).json();
    cards.push(...laid.cards);
    const server = laid.server as string;
    const slot = `[data-obj-id="${server}"]`;
    await page.waitForFunction((id) => !!(window as any).__foundation.getState().panels[id], server);
    await frame(page, server);
    await expect(page.locator(`${slot} [data-cluster-well]`)).toBeVisible();
    await settle(page, 1200);
    await page.screenshot({ path: `${SHOTS}/10_cluster_laid.png` });
    await page.locator(`${slot} [data-cluster-start]`).click();
    // the server's Cluster tab: both nodes ready
    await page.locator(`${slot} [data-machine-view="cluster"]`).click({ timeout: 240_000 });
    await expect(page.locator(`${slot} .machine-cluster-node.is-ready`)).toHaveCount(2, { timeout: 300_000 });
    await page.screenshot({ path: `${SHOTS}/11_cluster_nodes-ready.png` });
    // a pod: busybox, kept running
    await page.locator(`${slot} .machine-cluster-run input:not([type])`).fill("busybox:1.36");
    await page.locator(`${slot} .machine-cluster-keep input`).check();
    await page.locator(`${slot} [data-cluster-run]`).click();
    const pod = page.locator(`${slot} [data-cluster-pod="busybox"]`);
    await expect(pod).toContainText("Running", { timeout: 180_000 });
    await page.screenshot({ path: `${SHOTS}/12_cluster_pod-running.png` });
    // opened as a card of its own: a shell in the pod
    await page.locator(`${slot} [data-cluster-open="busybox"]`).click();
    await page.waitForFunction(() => Object.values((window as any).__foundation.getState().panels).some((p: any) => p.machine?.pod?.name === "busybox"));
    const podCard = (Object.values((await state(page)).panels) as any[]).find((p) => p.machine?.pod?.name === "busybox").id as string;
    cards.push(podCard);
    const ps = `[data-obj-id="${podCard}"]`;
    await frame(page, podCard);
    await page.locator(`${ps} .machine-term .xterm`).waitFor({ timeout: 60_000 });
    await settle(page, 1500);
    await page.locator(`${ps} .machine-term`).click();
    await page.keyboard.type("echo hi-from-pod-$((40+2)) && hostname\n");
    await expect.poll(() => screenText(page, ps), { timeout: 20_000 }).toContain("hi-from-pod-42");
    expect(await screenText(page, ps)).toContain("busybox");
    await page.screenshot({ path: `${SHOTS}/13_pod-card_shell.png` });
    // deleted: its card says it's gone
    await frame(page, server);
    await settle(page, 1200);
    const del = page.locator(`${slot} [data-cluster-pod="busybox"] .machine-addr-btn.is-remove`);
    await del.click();
    await del.click();
    await expect(page.locator(`${slot} [data-cluster-pod="busybox"]`)).toHaveCount(0, { timeout: 60_000 });
  } finally {
    for (const c of cards) await context.request.post(`${CLIENT}/api/boards/${board}/machines/${c}/remove`, { data: { confirm: true } }).catch(() => {});
    await context.close();
  }
});

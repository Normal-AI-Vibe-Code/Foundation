/**
 * Foundation for Chrome, loaded into a real Chromium: a new tab opens Today
 * (signed in, with the person's own day), and the toolbar popup reads Today
 * from the extension's own origin with Foundation's sign-in cookie (the
 * question SPEC §7 left open). Built against this run's client, like a
 * company build is against the hosted Foundation.
 *
 * STORE_ASSETS=1 also makes the Chrome Web Store's images from what the
 * extension really shows: apps/extension/store/ (1280×800 screenshots, the
 * 440×280 promo tile, the 1400×560 marquee).
 */
import { chromium, expect, request, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT } from "./helpers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ext = join(root, "apps/extension/dist/unpacked");
const evidence = join(root, "docs/evidence/2026-11-11_chrome-extension");
const store = join(root, "apps/extension/store");

test("Foundation for Chrome: a new tab is Today, and the popup reads it with the sign-in", async () => {
  test.setTimeout(120_000);
  execFileSync(process.execPath, [join(root, "apps/extension/build.mjs")], { env: { ...process.env, FOUNDATION_URL: CLIENT }, stdio: "ignore" });
  mkdirSync(evidence, { recursive: true });

  // a day worth showing: Kai asks Ada for things; Ada has goals and says what she works on
  const kai = await request.newContext();
  expect((await kai.post(`${CLIENT}/auth/dev`, { data: { name: "Kai Moana", email: "kai@normal.dev" } })).ok()).toBeTruthy();
  for (const prompt of ["Upload the latest stator STEP for the PTHP build", "Sign off the bearing loads before Friday's review"]) {
    expect((await kai.post(`${CLIENT}/api/asks`, { data: { board: "company", assignee: "ada@normal.dev", prompt, kind: "cad_upload" } })).ok()).toBeTruthy();
  }

  const profile = mkdtempSync(join(tmpdir(), "foundation-chrome-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // extensions load in Chromium's new headless mode
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    expect((await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Park", email: "ada@normal.dev" } })).ok()).toBeTruthy();
    for (const g of [
      { title: "Freeze the rim-drive CAD for the PTHP build", detail: "Stator and bearings signed off", progress: 0.6, dueAt: Date.now() + 8 * 864e5 },
      { title: "Get Today in front of the team", progress: 0.35, dueAt: Date.now() + 2 * 864e5 },
      { title: "Onboard Kai to FactoryForm work orders", progress: 0.8 },
    ]) {
      expect((await context.request.post(`${CLIENT}/api/today/goals`, { data: g })).ok()).toBeTruthy();
    }
    await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));

    // a new tab: the extension's page, which hands off to Today at Foundation
    const page = context.pages()[0] ?? (await context.newPage());
    const seen: string[] = [];
    page.on("framenavigated", (f) => f === page.mainFrame() && seen.push(f.url()));
    await page.goto("chrome://newtab").catch(() => {
      /* the override replaces itself at once; the wait below is the check */
    });
    await page.waitForURL(`${CLIENT}/?from=chrome#/today`, { timeout: 20_000 });
    await expect(page.locator(".today")).toBeVisible();
    await expect(page.locator(".today-line")).toContainText("Ada");
    await expect(page.locator(".today-row", { hasText: "Upload the latest stator STEP" })).toBeVisible();
    const id = seen.map((u) => /^chrome-extension:\/\/([a-p]{32})\/newtab\.html/.exec(u)?.[1]).find(Boolean);
    expect(id, `the new tab went through the extension (saw ${seen.join(" → ")})`).toBeTruthy();
    await page.waitForTimeout(1500); // the Shiba's room fades in
    await page.screenshot({ path: join(evidence, "01_new-tab-is-today.png") });

    // the popup, from the extension's origin: Foundation's cookie goes with it (SameSite=Lax, a permitted host)
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator("#hello")).toHaveText("Ada, 2 things want you.");
    await expect(popup.locator("#focus-list")).toContainText("Sign off the bearing loads");
    await expect(popup.locator("#goal-list")).toContainText("Freeze the rim-drive CAD");
    await expect(popup.locator("#state")).toHaveText("");
    await popup.locator("body").screenshot({ path: join(evidence, "02_popup-signed-in.png") });
    // the store's picture shows the address a company build has, not this run's localhost
    const release = JSON.parse(readFileSync(join(root, "apps/extension/release.json"), "utf8"));
    await popup.locator("#where").evaluate((n, url) => (n.textContent = url.replace(/^https?:\/\//, "")), release.foundationUrl.value as string);
    const popupPng = await popup.locator("body").screenshot();

    // signed out, it says so and still offers the apps
    const signedOut = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "foundation-chrome-")), {
      channel: "chromium",
      viewport: { width: 360, height: 640 },
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    const out = await signedOut.newPage();
    await out.goto(`chrome-extension://${id}/popup.html`);
    await expect(out.locator("#state")).toContainText("You're signed out of Foundation");
    await expect(out.locator("#apps")).toContainText("FactoryForm");
    await out.locator("body").screenshot({ path: join(evidence, "03_popup-signed-out.png") });
    // the privacy page the store links to opens without a sign-in, day and night
    await out.setViewportSize({ width: 1280, height: 800 });
    for (const scheme of ["light", "dark"] as const) {
      await out.emulateMedia({ colorScheme: scheme });
      await out.goto(`${CLIENT}/#/privacy`);
      await out.reload(); // the night engine reads the scheme as the page loads (the second goto is only a hash change)
      await expect(out.getByRole("heading", { name: "Privacy" })).toBeVisible();
      await expect(out.locator(".privacy-body")).toContainText("One thing: the address of the company's Foundation");
      await out.screenshot({ path: join(evidence, `04_privacy-${scheme === "light" ? "day" : "night"}.png`) });
    }
    await signedOut.close();

    if (process.env.STORE_ASSETS) {
      rmSync(store, { recursive: true, force: true });
      mkdirSync(store, { recursive: true });
      const todayPng = await page.screenshot({ path: join(store, "screenshot-1-today.png") });
      const tokens = readFileSync(join(ext, "tokens.css"), "utf8").replace("url(fonts/hanken-grotesk.woff2)", `url(data:font/woff2;base64,${readFileSync(join(ext, "fonts/hanken-grotesk.woff2")).toString("base64")})`);
      const b64 = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;
      const art = await context.newPage();
      const draw = async (w: number, h: number, body: string, file: string) => {
        await art.setViewportSize({ width: w, height: h });
        await art.setContent(`<!doctype html><html><head><style>${tokens}${STORE_CSS}</style></head><body>${body}</body></html>`);
        await art.evaluate(() => document.fonts.ready);
        await art.screenshot({ path: join(store, file) });
      };
      // the popup as Chrome shows it: under the toolbar, over Today
      await draw(1280, 800, `<img class="bg" src="${b64(todayPng)}"><div class="toolbar"><i class="ring"></i></div><img class="popup" src="${b64(popupPng)}">`, "screenshot-2-popup.png");
      await draw(440, 280, `<div class="tile"><i class="ring big"></i><div><b>Foundation</b><span>Today, on every new tab</span></div></div>`, "promo-small.png");
      await draw(1400, 560, `<div class="marquee"><div class="copy"><i class="ring big"></i><b>Foundation</b><span>Every new tab opens your Today: the Shiba, what wants you, your goals, and every company app.</span></div><img src="${b64(todayPng)}"></div>`, "promo-marquee.png");
    }
  } finally {
    await context.close();
    await kai.dispose();
  }
});

/** the store images, on Foundation's tokens (day) */
const STORE_CSS = `
html, body { margin: 0; height: 100%; background: var(--color-void); color: var(--color-frost); font-family: var(--font-sans); overflow: hidden; }
.ring { display: inline-block; width: 28px; height: 28px; border-radius: 50%; box-sizing: border-box; border: 3px solid var(--color-agent); background: var(--color-void); }
.ring.big { width: 72px; height: 72px; border-width: 7px; flex: none; }
.bg { position: absolute; inset: 0; width: 100%; filter: saturate(0.9); }
.toolbar { position: absolute; top: 0; left: 0; right: 0; height: 44px; display: flex; justify-content: flex-end; align-items: center; padding: 0 18px; background: var(--color-panel); border-bottom: 1px solid var(--color-line); }
.popup { position: absolute; top: 48px; right: 12px; width: 360px; border-radius: var(--radius-card); box-shadow: var(--shadow-pane); border: 1px solid var(--color-line); }
.tile { height: 100%; display: flex; align-items: center; gap: 22px; padding: 0 40px; background: var(--color-void); }
.tile b, .marquee b { display: block; font: 600 var(--text-40) / 1 var(--font-display); letter-spacing: -0.02em; }
.tile span { display: block; margin-top: 10px; color: var(--color-mist); font: 400 var(--text-16) / 1.3 var(--font-sans); }
.marquee { height: 100%; display: grid; grid-template-columns: 520px 1fr; align-items: center; background: var(--color-void); }
.marquee .copy { padding: 0 56px; display: flex; flex-direction: column; gap: 18px; }
.marquee .copy span { color: var(--color-mist); font: 400 var(--text-20) / 1.4 var(--font-sans); }
.marquee img { width: 820px; border-radius: var(--radius-pane) 0 0 var(--radius-pane); box-shadow: var(--shadow-pane); }
`;

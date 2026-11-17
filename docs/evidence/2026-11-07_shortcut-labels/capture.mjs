// Key labels per platform, day and night, on #/design and on the board.
//
//   npm run dev                       (the server and the client on :1430)
//   node docs/evidence/2026-11-07_shortcut-labels/capture.mjs before|after
//
// Headless Chromium on any OS: the platform is emulated (navigator.platform and
// navigator.userAgentData.platform), which is all lib/keys.ts reads.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = process.env.CLIENT ?? "http://localhost:1430";
const phase = process.argv[2] ?? "after";
const out = join(dirname(fileURLToPath(import.meta.url)), phase);
mkdirSync(out, { recursive: true });

const PLATFORMS = {
  windows: { platform: "Win32", uad: "Windows" },
  mac: { platform: "MacIntel", uad: "macOS" },
};
const platforms = phase === "before" ? ["windows"] : ["windows", "mac"];
const report = [];

const browser = await chromium.launch();
for (const name of platforms) {
  for (const night of [false, true]) {
    const tag = `${name}-${night ? "night" : "day"}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: night ? "dark" : "light" });
    const p = PLATFORMS[name];
    await context.addInitScript(({ p, night }) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => p.platform });
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => ({ platform: p.uad, brands: [], mobile: false }) });
      localStorage.setItem("foundation-night", night ? "1" : "0");
      localStorage.setItem("foundation-floor", JSON.stringify({ pane: true, tabs: [], tab: null, search: false }));
    }, { p, night });
    const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name: "Ada Test", email: "ada@normal.dev" } });
    if (!res.ok()) throw new Error(`dev login: ${res.status()} ${await res.text()}`);
    const page = await context.newPage();

    // #/design (tall enough that the whole Key labels section is on screen)
    await page.setViewportSize({ width: 1440, height: 2400 });
    await page.goto(`${CLIENT}/?rafshim#/design`);
    await page.waitForSelector(".design-page");
    await page.waitForTimeout(600);
    const keysSection = page.locator(".design-section", { has: page.locator("h2", { hasText: "Key labels" }) });
    if (await keysSection.count()) {
      await keysSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await keysSection.screenshot({ path: join(out, `design-keys_${tag}.png`) });
    }
    await page.locator(".controls-row").first().screenshot({ path: join(out, `design-controls_${tag}.png`) });
    await page.locator(".oncall-hud").first().screenshot({ path: join(out, `design-hud_${tag}.png`) });

    // the board
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${CLIENT}/?rafshim`);
    await page.waitForFunction(() => (window).__foundationBoard?.()?.status === "live", undefined, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.locator(".hud").screenshot({ path: join(out, `board-hud_${tag}.png`) });
    await page.locator(".top-bar").screenshot({ path: join(out, `board-topbar_${tag}.png`) });
    await page.locator(".side-pane").first().screenshot({ path: join(out, `board-sidepane_${tag}.png`) });
    // an empty section's welcome: focus that section and frame it (F)
    const spot = await page.evaluate(() => {
      const card = document.querySelector(".section-empty")?.closest(".section-card");
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const y = Math.max(r.top, 60) + 12;
      return y < Math.min(r.bottom, innerHeight) ? { x: (Math.max(r.left, 300) + Math.min(r.right, innerWidth)) / 2, y } : null;
    });
    if (spot) {
      await page.mouse.click(spot.x, spot.y);
      await page.keyboard.press("f");
      await page.waitForTimeout(1500);
      await page.locator(".section-empty .empty-card").first().screenshot({ path: join(out, `board-welcome_${tag}.png`) });
      await page.keyboard.press("0");
      await page.waitForTimeout(1200);
    }
    // a roll-over label with its key
    await page.locator(".top-bar .tab-new").hover();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(out, `board-tip_${tag}.png`), clip: { x: 0, y: 0, width: 420, height: 110 } });

    // ⌘K / Ctrl+K, with a term so the "ask the agent" row shows its key
    await page.mouse.move(720, 500);
    await page.keyboard.press(name === "mac" ? "Meta+K" : "Control+K");
    await page.waitForSelector(".cmd");
    await page.keyboard.type("zzqx nothing");
    await page.waitForTimeout(3200);
    await page.locator(".cmd").screenshot({ path: join(out, `board-commands_${tag}.png`) });

    // every key chip on screen: one line, nothing clipped
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll(".f-kbd")]
        .filter((el) => el.getClientRects().length)
        .map((el) => ({ text: el.textContent, h: Math.round(el.getBoundingClientRect().height), clipped: el.scrollWidth > el.clientWidth + 1 })),
    );
    report.push({ tag, chips });
    await context.close();
  }
}
await browser.close();
console.log(JSON.stringify(report, null, 1));

// Evidence for the server switch: #/design day and night, and the live switch on the sign-in page
// with the page pointed at a server on another origin (the desktop app's transport).
//   node capture.mjs [client origin=http://localhost:15430] [server=http://localhost:4410]
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const client = process.argv[2] ?? "http://localhost:15430";
const server = process.argv[3] ?? "http://localhost:4410";
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: scheme });
    await page.goto(`${client}/#/design`);
    const h = page.locator("h2, h3", { hasText: /^Server switch$/ });
    await h.waitFor();
    await h.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1600);
    const section = h.locator("xpath=ancestor::section[1]");
    await section.screenshot({ path: join(here, `03-design-${scheme === "light" ? "day" : "night"}.png`) });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  await page.goto(`${client}/`);
  await page.evaluate((s) => localStorage.setItem("foundation-server", s), server);
  await page.reload();
  const pill = page.locator(".server-switch-pill");
  await pill.waitFor();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(here, "04-sign-in-closed.png") });
  await pill.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(here, "05-sign-in-open.png") });
  await page.fill('input[aria-label="Remote server address"]', "ftp://files");
  await page.press('input[aria-label="Remote server address"]', "Enter");
  await page.waitForTimeout(400);
  await page.locator(".server-switch-panel").screenshot({ path: join(here, "06-bad-address.png") });
  console.log("ok");
} finally {
  await browser.close();
}

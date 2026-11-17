// Drive a check build of the desktop app over WebView2's debugging port (CDP), to try the built-in
// server from the server switch. The check build is `tauri build --no-bundle` with its own name,
// identifier and window port (FOUNDATION_DESKTOP_PORT=31450), run with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=19334 and FOUNDATION_DESKTOP_HOME
// pointed at a throwaway folder, so the installed Foundation and its data are never touched.
//
//   node drive.mjs shot <name>        screenshot the window into this folder
//   node drive.mjs text               the page's visible text
//   node drive.mjs eval "<js>"        evaluate in the page, print JSON
//   node drive.mjs click "<selector>" click the first match
//   node drive.mjs fill "<selector>" "<value>"   fill, then Enter
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, arg] = process.argv.slice(2);
const port = process.env.CDP_PORT ?? "19334";
const origin = process.env.WINDOW_ORIGIN ?? "http://localhost:31450";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(origin));
  if (!page) throw new Error(`no window at ${origin}`);
  if (cmd === "shot") {
    const file = join(here, `${arg ?? "window"}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  } else if (cmd === "text") {
    console.log((await page.innerText("body")).slice(0, 3000));
  } else if (cmd === "eval") {
    console.log(JSON.stringify(await page.evaluate(arg), null, 2));
  } else if (cmd === "fill") {
    // fill "<selector>" "<value>", then Enter
    await page.locator(arg).first().fill(process.argv[4] ?? "");
    await page.locator(arg).first().press("Enter");
    await page.waitForTimeout(1500);
    console.log("filled", arg);
  } else if (cmd === "click") {
    await page.locator(arg).first().click();
    await page.waitForTimeout(800);
    console.log("clicked", arg);
  } else {
    console.log(page.url());
  }
} finally {
  await browser.close().catch(() => {});
}

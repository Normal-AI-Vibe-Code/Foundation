// Drive the installed desktop app's real window over WebView2's debugging port (CDP).
// Launch the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=19333 first.
//
//   node drive-app.mjs shot <name>            screenshot the window into this folder
//   node drive-app.mjs text                   the page's visible text
//   node drive-app.mjs eval "<js>"            evaluate an expression in the page, print JSON
//   node drive-app.mjs click "<selector>"     click the first match
//   node drive-app.mjs fill "<selector>" "<value>"
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, arg] = process.argv.slice(2);
const port = process.env.CDP_PORT ?? "19333";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("http://localhost:31440"));
  if (!page) throw new Error("no Foundation window on that port");
  if (cmd === "shot") {
    const file = join(here, `${arg ?? "window"}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  } else if (cmd === "text") {
    console.log((await page.innerText("body")).slice(0, 4000));
  } else if (cmd === "eval") {
    console.log(JSON.stringify(await page.evaluate(arg), null, 2));
  } else if (cmd === "fill") {
    // fill "<selector>" "<value>"
    await page.locator(arg).first().fill(process.argv[4] ?? "");
    console.log("filled", arg);
  } else if (cmd === "click") {
    await page.locator(arg).first().click();
    await page.waitForTimeout(800);
    console.log("clicked", arg);
  } else {
    console.log(page.url());
  }
} finally {
  // a CDP connection: closing it detaches, the app keeps running
  await browser.close().catch(() => {});
}

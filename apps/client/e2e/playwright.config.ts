/**
 * End-to-end checks in a real browser: two people on one board, sections
 * moved and split without visual faults, and a frame-time trace. Runs its own
 * server on a fresh data folder (:4430) and its own client (:1450), so it
 * never touches the dev board or another session's servers.
 *
 *   npm run e2e -w @foundation/client
 */

import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standinLauncher } from "../../server/test/t3-standin.ts";

const data = mkdtempSync(join(tmpdir(), "foundation-e2e-"));
// Ports can move: Windows (Hyper-V/WSL) reserves blocks of the dynamic range at
// boot, and on some machines that range starts at 1024 (SPEC §7).
const SERVER_PORT = process.env.E2E_SERVER_PORT ?? "4430";
const CLIENT_PORT = process.env.E2E_CLIENT_PORT ?? "1450";
const SLACK_PORT = process.env.E2E_SLACK_PORT ?? "4440";
const MESHY_PORT = process.env.E2E_MESHY_PORT ?? "4445";
process.env.E2E_MESHY_PORT = MESHY_PORT;
process.env.E2E_CLIENT_PORT = CLIENT_PORT;
// the stand-in Slack also serves the stand-in live app (helpers.ts FRAME): on its own origin, not Foundation's
process.env.E2E_SLACK_PORT = SLACK_PORT;
export const CLIENT = `http://localhost:${CLIENT_PORT}`;

export default defineConfig({
  testDir: ".",
  outputDir: "../../../docs/evidence/e2e-results",
  timeout: 90_000,
  workers: 1, // one board, one server: tests take turns
  reporter: [["list"]],
  use: {
    baseURL: CLIENT,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    actionTimeout: 10_000,
    // the checks' own calls (context.request) sign in by cookie like the page does, and say they come from the
    // client's page as the browser would: the server refuses a cookie change from any other page (origins.ts)
    extraHTTPHeaders: { origin: CLIENT },
  },
  webServer: [
    {
      command: `node slack-standin.mjs ${SLACK_PORT}`,
      cwd: ".",
      url: `http://127.0.0.1:${SLACK_PORT}/auth.test`,
      reuseExistingServer: false,
      timeout: 20_000,
      ignoreHTTPSErrors: true,
    },
    {
      // a stand-in Meshy (e2e/meshy-standin.mjs): the character pipeline runs end to end and nothing is charged
      command: `node meshy-standin.mjs ${MESHY_PORT}`,
      cwd: ".",
      url: `http://127.0.0.1:${MESHY_PORT}/_sent`,
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `npx tsx src/index.ts`,
      cwd: "../../server",
      env: {
        FOUNDATION_PORT: SERVER_PORT,
        FOUNDATION_DATA_DIR: data,
        FOUNDATION_CLIENT_URL: CLIENT,
        FOUNDATION_ADMIN_EMAILS: "admin@normal.dev",
        FOUNDATION_DEV_LOGIN: "1",
        // the Browser tool opens on an empty tab here: a check never opens the real HyperForm
        FOUNDATION_BROWSER_HOME: "about:blank",
        // DeployForm here is a stand-in page (slack-standin.mjs): a check never opens the real one (pages.spec.ts)
        DEPLOYFORM_URL: `http://127.0.0.1:${SLACK_PORT}/e2e/page.html`,
        // a stand-in Slack (e2e/slack-standin.mjs); no agent runtime, so a check never spends an agent turn
        SLACK_API_BASE: `http://127.0.0.1:${SLACK_PORT}`,
        SLACK_USER_TOKEN: "xoxp-standin",
        SLACK_BOT_TOKEN: "xoxb-standin",
        MESHY_API_BASE: `http://127.0.0.1:${MESHY_PORT}`,
        MESHY_API_KEY: "msy-standin",
        // the checks make their own characters: no starter set (E2E_STARTER names a folder to bring one in)
        FOUNDATION_STARTER_DIR: process.env.E2E_STARTER ?? "",
        // Foundation's avatars never push from a check: off, unless E2E_AVATARS_REPO names a throwaway checkout
        FOUNDATION_AVATARS_REPO: process.env.E2E_AVATARS_REPO ?? "",
        FOUNDATION_MESHY_POLL_MS: "250",
        FOUNDATION_CLAUDE_CLI: "/nonexistent/claude",
        // the crew's agents run a fixed playbook through the real board tools (no model, nothing spent)
        FOUNDATION_AGENT_SCRIPT: "1",
        FOUNDATION_SCRIPT_STEP_MS: "450",
        // never the real Vision Code: hand-offs here fail to start, and say why
        T3_CLI: "/nonexistent/t3",
        T3_URL: "http://127.0.0.1:9",
        T3CODE_HOME: "/nonexistent/t3home",
        // Foundation's own T3 (the agents pane) is a stand-in that speaks T3's start, sign-in and streams; no model runs
        // (its settings ride in its launcher: T3 is started with the allowlisted environment only, never the server's)
        // and it uses its pass to the board once, as an agent would (a note in the section it was sent to)
        FOUNDATION_T3_CLI: standinLauncher(data, { T3_STANDIN_DIR: data, T3_STANDIN_FINISH_MS: "6000", T3_STANDIN_USE_TOOLS: "1" }),
        FOUNDATION_T3_PORT: process.env.E2E_T3_PORT ?? "15790",
        ANTHROPIC_API_KEY: "",
      },
      url: `http://127.0.0.1:${SERVER_PORT}/api/me`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // E2E_BUILD=1: the production build (what the packaged app ships), with the test page beside it
      command: process.env.E2E_BUILD
        ? `npx vite build && node -e "require('fs').cpSync('e2e/frame.html','dist/e2e/frame.html')" && npx vite preview --port ${CLIENT_PORT} --strictPort`
        : `npx vite --port ${CLIENT_PORT} --strictPort`,
      cwd: "..",
      env: { FOUNDATION_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`, ...(process.env.E2E_BUILD ? { VITE_E2E_HOOKS: "1" } : {}) },
      url: CLIENT,
      reuseExistingServer: false,
      timeout: process.env.E2E_BUILD ? 240_000 : 60_000,
    },
  ],
});

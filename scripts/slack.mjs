#!/usr/bin/env node
// npm run slack: run Foundation's Slack app (apps/slack-agent) with the Slack CLI.
//
// The app is the live line from Slack to the Slack board: while it runs, each
// section's Slack mark reads Live and what's posted lands as it's posted. It
// needs the Slack CLI signed in to the workspace (slack login) and
// FOUNDATION_SERVICE_TOKEN in Foundation's .env (the app reads it from there).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const win = process.platform === "win32";
const candidates = win
  ? [join(homedir(), "AppData", "Local", "slack-cli", "bin", "slack.exe"), join(homedir(), ".slack-cli", "bin", "slack.exe")]
  : [join(homedir(), ".slack", "bin", "slack")];
const cli = candidates.find((p) => existsSync(p));
if (!cli) {
  console.error("The Slack CLI isn't installed. See https://docs.slack.dev/tools/slack-cli/ and run `slack login` once it is.");
  process.exit(1);
}
const dir = fileURLToPath(new URL("../apps/slack-agent", import.meta.url));
const child = spawn(cli, ["run", "--org-workspace-grant=all", ...process.argv.slice(2)], { cwd: dir, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

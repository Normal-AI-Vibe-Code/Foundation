#!/usr/bin/env node
/**
 * ChatForm on a scratch copy: its own server (:14411) and page (:15431) on an empty data folder in the
 * system's temp directory, so it can be looked at beside the Foundation that is really running (:4410,
 * the real data) without touching it. Dev sign-in is on; the bridges' demo conversations can be made
 * from Inbox. Nothing here is kept: the folder is made fresh each start.
 *
 *   node scripts/chatform-demo.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = 14411;
const CLIENT = 15431;
const data = mkdtempSync(join(tmpdir(), "chatform-demo-"));
const env = {
  ...process.env,
  FOUNDATION_PORT: String(SERVER),
  FOUNDATION_DATA_DIR: data,
  FOUNDATION_DEV_LOGIN: "1",
  FOUNDATION_ADMIN_EMAILS: "josh@normal.dev",
  FOUNDATION_CLIENT_URL: `http://localhost:${CLIENT}`,
  FOUNDATION_SERVER_URL: `http://127.0.0.1:${SERVER}`,
  FOUNDATION_CLIENT_PORT: String(CLIENT),
  FOUNDATION_BRIDGE_DEMO: "1",
  FOUNDATION_T3_PORT: "15790",
};
const win = process.platform === "win32";
const kids = [
  spawn("npx", ["tsx", "src/index.ts"], { cwd: join(root, "apps", "server"), env, stdio: "inherit", shell: win }),
  spawn("npx", ["vite", "--port", String(CLIENT), "--strictPort"], { cwd: join(root, "apps", "client"), env, stdio: "inherit", shell: win }),
];
console.log(`ChatForm demo: http://localhost:${CLIENT}/#/chat  (data: ${data})`);
const stop = () => {
  for (const k of kids) {
    if (win && k.pid) spawn("taskkill", ["/pid", String(k.pid), "/t", "/f"], { stdio: "ignore" });
    else k.kill();
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const k of kids) k.on("exit", stop);

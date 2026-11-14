/**
 * Server configuration from the environment (and an optional `.env` beside
 * the repo root). Every integration is off until its key is present — the
 * server always starts, offline, with dev login.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The repo's root when run from source. The desktop app runs a bundled copy from its install folder
// (scripts/desktop-server.mjs) and names its own folder instead (FOUNDATION_ROOT: the app's data
// directory), so `.env` and `data/` are looked for there, never beside the program.
const root = process.env.FOUNDATION_ROOT ? resolve(process.env.FOUNDATION_ROOT) : resolve(import.meta.dirname, "../../..");

for (const file of [resolve(root, ".env"), resolve(root, "apps/server/.env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k: string, d = "") => process.env[k] ?? d;

const port = Number(env("FOUNDATION_PORT", "4410"));

export const config = {
  root,
  port,
  host: env("FOUNDATION_HOST", "127.0.0.1"),
  publicUrl: env("FOUNDATION_PUBLIC_URL", `http://localhost:${port}`),
  clientUrl: env("FOUNDATION_CLIENT_URL", "http://localhost:1430"),
  /** more page origins that may call this server with credentials (comma-separated), beyond the client, localhost and the desktop app */
  /** the oldest client this server still works with (x.y.z; unset: any). Older ones get no board socket and are told to update (clientversion.ts) */
  minClient: env("FOUNDATION_MIN_CLIENT").trim(),
  corsOrigins: env("FOUNDATION_CORS_ORIGINS")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),
  dataDir: resolve(root, env("FOUNDATION_DATA_DIR", "data")),
  /** comma-separated emails or @domain entries allowed to sign in */
  allowlist: env("FOUNDATION_ALLOWLIST", "@formindustries.com,@normal.dev,josh.leong@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  adminEmails: env("FOUNDATION_ADMIN_EMAILS", "josh.leong@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** dev login (pick a name, no password) — on unless explicitly disabled */
  devLogin: env("FOUNDATION_DEV_LOGIN", "1") !== "0",
  /** flowform-server: Foundation signs in with flowform's Google login (same server, same client) */
  flowformUrl: env("FLOWFORM_URL", "https://server.formresearch.ai"),
  /** the Flowform client version Foundation's file downloads declare: Flowform's file routes refuse older clients (426, "1.9.0 or newer", 2026-11-11) */
  flowformClientVersion: env("FLOWFORM_CLIENT_VERSION", "1.9.0"),
  /** admit flowform "viewer" accounts too (default: users and admins only) */
  flowformAdmitViewers: env("FLOWFORM_ADMIT_VIEWERS", "0") === "1",
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
  },
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
    model: env("FOUNDATION_AGENT_MODEL", "claude-opus-5-5"),
  },
  /** run agent turns through Claude Code on this machine (subscription) */
  claudeCli: env("FOUNDATION_CLAUDE_CLI", "claude"),
  slack: { token: env("SLACK_USER_TOKEN") || env("SLACK_BOT_TOKEN") },
  github: { token: env("GITHUB_TOKEN"), org: env("FOUNDATION_GITHUB_ORG", "") },
  /** live company apps (connectors) */
  connectors: {
    factoryform: env("FACTORYFORM_URL", "http://127.0.0.1:3001"),
    dataroom: env("DATAROOM_URL", "https://airformdata.com"),
    vision: env("VISION_URL", "http://localhost:1420"),
  },
  /** bearer token other services/agents use for /mcp and /api when not signed in */
  serviceToken: env("FOUNDATION_SERVICE_TOKEN"),
};

export type Config = typeof config;

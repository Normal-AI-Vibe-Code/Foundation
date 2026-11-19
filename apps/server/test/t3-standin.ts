/**
 * A stand-in `t3` for tests that go past listing: it takes T3's bootstrap
 * line, signs Foundation in the same way, and then behaves like T3 0.0.44
 * where Foundation touches it:
 *
 * - `POST /api/orchestration/dispatch`: keeps every command (dispatch.json);
 *   `project.create` and `thread.turn.start` show up on the shell stream as T3
 *   would show them (a thread at work on the agent asked for);
 *   `thread.turn.interrupt` puts the thread at rest.
 * - `server.getSettings` / `server.updateSettings` / `server.refreshProviders`
 *   over the socket: provider instances are kept (settings.json) and listed
 *   as providers, with Claude's catalogue plus the instance's custom models,
 *   and a sensitive value comes back redacted, as T3 sends it.
 * - `POST /api/auth/pairing-token`: a one-time credential.
 *
 * The test drives the rest through control.json: {do:"finish"|"approve"|"fail", id}.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A launcher for the stand-in in `dir` that gives it its settings (T3_STANDIN_*) itself: Foundation starts T3
 * with the allowlisted environment only (child.ts), so the server's own variables never reach it.
 */
export function standinLauncher(dir: string, settings: Record<string, string>): string {
  const cli = join(dir, "t3-standin-run.mjs");
  writeFileSync(cli, `Object.assign(process.env, ${JSON.stringify(settings)});\nawait import(${JSON.stringify(new URL("./t3-standin.mjs", import.meta.url).href)});\n`);
  return cli;
}

/** point the stand-in (t3-standin.mjs) at a folder for its files; returns where they are */
export function writeStandin(dir: string): { cli: string; control: string; file: (name: string) => string } {
  process.env.T3_STANDIN_DIR = dir;
  return { cli: standinLauncher(dir, { T3_STANDIN_DIR: dir }), control: join(dir, "control.json"), file: (name) => join(dir, name) };
}

/**
 * npm run import:flowform -w @foundation/server -- <backup> [options]
 *
 *   <backup>              flowform's data backup: current.tar.gz, or its extracted data/ directory
 *   --media-dir <dir>     a local mirror of flowform's media bucket (object keys as paths)
 *   --media-flowform      fetch media through flowform's /media/url as FLOWFORM_IMPORT_TOKEN's person
 *                         (only rooms that person is a member of)
 *   --room <id>           only this room (repeatable)
 *   --default-room <id>   flowform's default room (default "flowform"): imported open to everyone
 *   --dry-run             rehearse against a copy of Foundation's database; nothing here changes
 *   --json <file>         also write the full report as JSON
 *
 * Run it with Foundation's server stopped: the server holds boards in memory
 * and would compact over what the import wrote. Re-running is safe.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const value = (name: string) => values(name)[0];
const backup = args.find((a, i) => !a.startsWith("--") && !["--media-dir", "--room", "--default-room", "--json"].includes(args[i - 1] ?? ""));

if (!backup || flag("--help")) {
  console.log("usage: import:flowform <current.tar.gz | data-dir> [--media-dir DIR | --media-flowform] [--room ID]… [--dry-run] [--json FILE]");
  process.exit(backup ? 0 : 2);
}

const { config } = await import("./config.ts");

// the server must be down (it would compact its in-memory boards over the import)
const up = await fetch(`http://127.0.0.1:${config.port}/api/me`, { signal: AbortSignal.timeout(800) }).then(
  () => true,
  () => false,
);
if (up) {
  console.error(`Foundation's server is running on :${config.port}. Stop it, then import (it would overwrite the imported boards when it compacts).`);
  process.exit(1);
}

if (flag("--dry-run")) {
  // rehearse on a consistent copy of the database and an empty files dir
  const live = join(config.dataDir, "foundation.db");
  const dir = mkdtempSync(join(tmpdir(), "foundation-dry-"));
  if (existsSync(live)) {
    const db = new DatabaseSync(live, { readOnly: true });
    db.exec(`vacuum into '${join(dir, "foundation.db").replace(/'/g, "''")}'`);
    db.close();
  }
  config.dataDir = dir;
  process.env.FOUNDATION_DATA_DIR = dir;
}

const { importFlowform, openBackup, dirMedia, flowformMedia, describeReport } = await import("./flowform-import.ts");
const { closeBoards } = await import("./boards.ts");

let media;
if (value("--media-dir")) media = dirMedia(resolve(value("--media-dir")!));
else if (flag("--media-flowform")) {
  const token = process.env.FLOWFORM_IMPORT_TOKEN;
  if (!token) {
    console.error("--media-flowform needs FLOWFORM_IMPORT_TOKEN in the environment (a flowform session for a person in the rooms)");
    process.exit(2);
  }
  media = flowformMedia(config.flowformUrl, token);
}

const opened = openBackup(resolve(backup));
const report = await importFlowform({
  dir: opened.dir,
  label: resolve(backup),
  media,
  rooms: values("--room"),
  defaultRoom: value("--default-room"),
  dryRun: flag("--dry-run"),
  log: (l) => console.log(`· ${l}`),
});
closeBoards();
opened.close();
if (flag("--dry-run")) rmSync(config.dataDir, { recursive: true, force: true }); // the rehearsal copy
console.log(`\n${describeReport(report)}`);
if (value("--json")) writeFileSync(resolve(value("--json")!), JSON.stringify(report, null, 2));

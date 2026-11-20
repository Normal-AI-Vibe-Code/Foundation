#!/usr/bin/env node
/**
 * Bring a Slack export into ChatForm from the command line (docs/chatform.md, package I1).
 *
 *   npm run chat:import -- <export.zip | export-folder> [--no-files] [--dry-run] [--max-file-mb N] [--md report.md] [--json report.json]
 *
 *   --dry-run        read the whole export and print what would come in; nothing is written
 *   --no-files       leave files out (each becomes a named, sized placeholder with its Slack link)
 *   --max-file-mb N  files bigger than this stay in Slack (default 100)
 *   --md / --json    also write the report there
 *
 * It writes into the configured data directory (FOUNDATION_DATA_DIR, else ./data), the same database
 * the server uses, through the server's own modules. Bringing the same export in twice adds nothing, so a
 * run that stopped can simply be run again. The report is kept with the import (Inbox → Slack history).
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "tsx/esm/api";

register();

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const takesValue = new Set(["--max-file-mb", "--md", "--json"]);
const path = args.find((a, i) => !a.startsWith("--") && !takesValue.has(args[i - 1] ?? ""));

if (!path || flag("--help")) {
  console.log("usage: npm run chat:import -- <export.zip | folder> [--no-files] [--dry-run] [--max-file-mb N] [--md FILE] [--json FILE]");
  process.exit(path ? 0 : 2);
}

const { config } = await import("../apps/server/src/config.ts");
const imp = await import("../apps/server/src/chatimport.ts");

const dryRun = flag("--dry-run");
const maxMb = Number(value("--max-file-mb") ?? 0);
console.error(`${dryRun ? "Rehearsing" : "Bringing in"} ${resolve(path)} → ${config.dataDir}${dryRun ? " (dry run: nothing is written)" : ""}`);

let last = 0;
const { job } = imp.startImport(null, {
  kind: "export",
  path: resolve(path),
  dryRun,
  files: !flag("--no-files"),
  ...(maxMb > 0 ? { maxFileBytes: maxMb * 1048576 } : {}),
  onProgress: (p) => {
    if (Date.now() - last < 500 && p.state === "running") return;
    last = Date.now();
    console.error(`  ${p.done}/${p.total} conversations · ${p.messages} messages · ${p.files} files${p.channel ? ` · ${p.channel}` : ""}`);
  },
});
await imp.jobDone(job.id);
const report = imp.jobReport(job.id);
const final = imp.getJob(job.id);
if (!report) {
  console.error("No report: the import didn't run.");
  process.exit(1);
}
const md = imp.reportMarkdown(report);
console.log(md);
if (value("--md")) writeFileSync(value("--md"), md);
if (value("--json")) writeFileSync(value("--json"), JSON.stringify(report, null, 2));
if (final?.state !== "done") {
  console.error(`Stopped: ${final?.error ?? final?.state}`);
  process.exit(1);
}
console.error(`${dryRun ? "Dry run" : "Import"} ${job.id} done.`);
process.exit(0);

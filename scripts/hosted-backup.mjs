#!/usr/bin/env node
// A hosted Foundation's backup (docs/hosting.md): a copy of the data folder that can be restored from.
//
//   node scripts/hosted-backup.mjs [--data <folder>] [--to <folder>] [--keep <n>] [--every <hours>]
//
//   <to>/db/<YYYY-MM-DD_HHMM>/foundation.db   the database as one consistent file (SQLite `vacuum into`,
//                                             taken while the server runs), with secret.key beside it
//   <to>/files/<sha256…>                      the file archive: content-addressed, so a file is copied once
//                                             and never changed. Nothing is ever removed from it
//                                             (uploaded files are archived, never deleted).
//
// The newest <keep> database copies are kept (default 14); older ones are removed. `--every <hours>` stays
// running and repeats (the compose file's backup service). Defaults: FOUNDATION_ROOT/data → /backups.
//
// secret.key unseals the tokens kept in the database (bridges, Flowform sessions): a backup holds both, so
// keep backups as private as the server itself.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const DATA = resolve(arg("--data", join(process.env.FOUNDATION_ROOT ?? ".", process.env.FOUNDATION_DATA_DIR ?? "data")));
const TO = resolve(arg("--to", process.env.FOUNDATION_BACKUP_DIR ?? "/backups"));
const KEEP = Math.max(1, Number(arg("--keep", process.env.FOUNDATION_BACKUP_KEEP ?? "14")) || 14);
const EVERY = Number(arg("--every", "0")) || 0;

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace("T", "_").replace(":", "");

/** copy what's in `from` and not yet in `to` (same name and size), folders included; returns how many files */
function copyNew(from, to) {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) n += copyNew(a, b);
    else if (e.isFile() && !(existsSync(b) && statSync(b).size === statSync(a).size)) {
      copyFileSync(a, b);
      n++;
    }
  }
  return n;
}

export function backup() {
  const dbFile = join(DATA, "foundation.db");
  if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile} (has the server started once?)`);
  const dir = join(TO, "db", stamp());
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "foundation.db");
  rmSync(out, { force: true });
  // one consistent file, whatever the server is writing meanwhile
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec(`vacuum into '${out.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  // the copy opens and is whole
  const check = new DatabaseSync(out, { readOnly: true });
  const ok = check.prepare("pragma integrity_check").get();
  check.close();
  if (Object.values(ok ?? {})[0] !== "ok") throw new Error(`the copy at ${out} failed its integrity check`);
  if (existsSync(join(DATA, "secret.key"))) copyFileSync(join(DATA, "secret.key"), join(dir, "secret.key"));
  const files = copyNew(join(DATA, "files"), join(TO, "files"));
  // the newest KEEP database copies stay; the file archive is never pruned
  const copies = readdirSync(join(TO, "db")).filter((n) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(n)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - KEEP))) rmSync(join(TO, "db", old), { recursive: true, force: true });
  console.log(`backup ${stamp()}: database ${(statSync(out).size / 1e6).toFixed(1)} MB → ${dir}; ${files} new file${files === 1 ? "" : "s"} → ${join(TO, "files")}; ${Math.min(copies.length, KEEP)} database cop${Math.min(copies.length, KEEP) === 1 ? "y" : "ies"} kept`);
}

const once = () => {
  try {
    backup();
    return true;
  } catch (e) {
    console.error(`backup failed: ${e.message}`);
    return false;
  }
};

if (EVERY > 0) {
  // the first one a minute after start (the server makes the database on its first run), then on the hour count
  setTimeout(once, 60_000);
  setInterval(once, EVERY * 3600_000);
} else process.exit(once() ? 0 : 1);

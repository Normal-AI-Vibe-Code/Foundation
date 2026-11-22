#!/usr/bin/env node
// Restore a hosted Foundation backup snapshot created by scripts/hosted-backup.mjs.
//
//   node scripts/hosted-restore.mjs --from <backupDir> --to <dataDir> [--snapshot <YYYY-MM-DD_HHMM>] --confirm
//
// Invariants enforced:
//  - Requires `--confirm` (or `confirm: true` when called programmatically) before overwriting foundation.db.
//  - Runs `pragma integrity_check` on the backup's SQLite snapshot BEFORE touching the destination folder.
//  - Removes stale WAL/SHM files (`foundation.db-wal`, `foundation.db-shm`) so SQLite opens the restored snapshot cleanly.
//  - Merges `<from>/files/` into `<to>/files/` without ever deleting existing archived files in `<to>/files/`.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { copyNew } from "./hosted-backup.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);

export function listSnapshots(fromDir) {
  const dbRoot = join(resolve(fromDir), "db");
  if (!existsSync(dbRoot)) return [];
  return readdirSync(dbRoot)
    .filter((n) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(n) && existsSync(join(dbRoot, n, "foundation.db")))
    .sort();
}

export function restoreBackup({ from, to, snapshot, confirm, quiet = false } = {}) {
  if (confirm !== true) {
    throw new Error("Restoring overwrites foundation.db in the destination data directory. Pass --confirm (confirm: true) to proceed.");
  }
  if (!from) throw new Error("Missing backup source folder (--from <backupDir>).");
  if (!to) throw new Error("Missing destination data folder (--to <dataDir>).");

  const fromDir = resolve(from);
  const toDir = resolve(to);
  const snapshots = listSnapshots(fromDir);
  const chosen = snapshot || snapshots[snapshots.length - 1];
  if (!chosen) {
    throw new Error(`No database snapshots found under ${join(fromDir, "db")}.`);
  }

  const snapDir = join(fromDir, "db", chosen);
  const srcDb = join(snapDir, "foundation.db");
  if (!existsSync(srcDb)) {
    throw new Error(`Snapshot ${chosen} has no database at ${srcDb}.`);
  }

  // Verify snapshot integrity BEFORE touching the destination directory.
  const check = new DatabaseSync(srcDb, { readOnly: true });
  let integrity = "";
  try {
    const row = check.prepare("pragma integrity_check").get();
    integrity = String(Object.values(row ?? {})[0] ?? "");
  } finally {
    check.close();
  }
  if (integrity !== "ok") {
    throw new Error(`Backup snapshot at ${srcDb} failed pragma integrity_check (${integrity || "corrupt"}). Destination was not touched.`);
  }

  mkdirSync(toDir, { recursive: true });
  mkdirSync(join(toDir, "files"), { recursive: true });

  const destDb = join(toDir, "foundation.db");
  rmSync(`${destDb}-wal`, { force: true });
  rmSync(`${destDb}-shm`, { force: true });
  copyFileSync(srcDb, destDb);

  const srcKey = join(snapDir, "secret.key");
  const hasSecretKey = existsSync(srcKey);
  if (hasSecretKey) {
    copyFileSync(srcKey, join(toDir, "secret.key"));
  }

  // Merge archived files without ever deleting existing files in destination (invariant: uploaded files are archived, never deleted).
  const filesRestored = copyNew(join(fromDir, "files"), join(toDir, "files"));

  // Verify the destination database after copy as well.
  const verifyDest = new DatabaseSync(destDb, { readOnly: true });
  try {
    const row = verifyDest.prepare("pragma integrity_check").get();
    if (Object.values(row ?? {})[0] !== "ok") {
      throw new Error(`Restored database at ${destDb} failed pragma integrity_check.`);
    }
  } finally {
    verifyDest.close();
  }

  if (!quiet) {
    console.log(
      `restore ${chosen}: database ${(statSync(destDb).size / 1e6).toFixed(1)} MB → ${destDb}; ${filesRestored} archive file${filesRestored === 1 ? "" : "s"} merged → ${join(toDir, "files")}`,
    );
  }
  return { snapshot: chosen, dbPath: destDb, filesRestored, hasSecretKey };
}

const isMain = Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  try {
    restoreBackup({
      from: arg("--from", process.env.FOUNDATION_BACKUP_DIR ?? "/backups"),
      to: arg("--to", join(process.env.FOUNDATION_ROOT ?? ".", process.env.FOUNDATION_DATA_DIR ?? "data")),
      snapshot: arg("--snapshot", undefined),
      confirm: process.argv.includes("--confirm"),
    });
  } catch (e) {
    console.error(`restore failed: ${(e).message}`);
    process.exit(1);
  }
}

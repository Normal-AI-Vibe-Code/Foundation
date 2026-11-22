/**
 * Hosted server boundary (#229), admin people role management (#227),
 * backup/restore with ChatForm messages & archived files (#228), and
 * hosted environment preflight validation (#228).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOSTED_URL = "https://foundation.example.com";
process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-hosted-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.co";
process.env.FOUNDATION_ALLOWLIST = "@formindustries.co,@normallab.co";
process.env.FOUNDATION_PUBLIC_URL = HOSTED_URL;
delete process.env.FOUNDATION_ALLOW_HOST_TOOLS;
delete process.env.APPDATA;
delete process.env.LOCALAPPDATA;

const { config } = await import("../src/config.ts");
const { createSession, upsertUser } = await import("../src/auth.ts");
const { readAudit, verifyAudit } = await import("../src/audit.ts");
const { HttpError, Router } = await import("../src/http.ts");
const {
  allowHostTools,
  hostedFeatureReason,
  listServerUsers,
  localFeatureAllowed,
  requireLocalFeature,
  serverCapabilities,
  setServerUserRole,
} = await import("../src/hosted.ts");
const { requestHostTerminal } = await import("../src/hostterm.ts");
const { requestHostBrowser } = await import("../src/hostbrowser.ts");
const { registerVmRoutes } = await import("../src/vmroutes.ts");
const { engineStatus, loadImage, removeMachine, restartMachine, startMachine, stopMachine } = await import("../src/machines.ts");
const { addT3Agent, enableT3Agent, localModels, removeT3Agent, startT3, stopT3, t3Host } = await import("../src/t3host.ts");
const { approvePlace, bringFromPlace, listPlace, removePlace } = await import("../src/places.ts");
const { connectLocal, localStatus, stopLocal } = await import("../src/localdev.ts");

type BackupFn = (opts?: { data?: string; to?: string; keep?: number; snapshot?: string; quiet?: boolean }) => {
  snapshot: string;
  dbPath: string;
  filesCopied: number;
  kept: number;
};
type RestoreBackupFn = (opts?: { from?: string; to?: string; snapshot?: string; confirm?: boolean; quiet?: boolean }) => {
  snapshot: string;
  dbPath: string;
  filesRestored: number;
  hasSecretKey: boolean;
};
type ValidateHostedEnvFn = (vars?: Record<string, string>) => {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const scriptUrl = (name: string) => new URL(`../../../scripts/${name}`, import.meta.url).href;
const { backup } = (await import(scriptUrl("hosted-backup.mjs"))) as { backup: BackupFn };
const { restoreBackup } = (await import(scriptUrl("hosted-restore.mjs"))) as { restoreBackup: RestoreBackupFn };
const { validateHostedEnv } = (await import(scriptUrl("hosted-preflight.mjs"))) as { validateHostedEnv: ValidateHostedEnvFn };

const boss = upsertUser("boss@formindustries.co", "The Boss");
const ada = upsertUser("ada@formindustries.co", "Ada Field");
const kai = upsertUser("kai@normallab.co", "Kai Chen");

function personReq(userId: string, path = "/api/test", method = "POST") {
  const token = createSession(userId);
  const url = new URL(path, HOSTED_URL);
  return {
    method,
    url: path,
    headers: {
      host: "foundation.example.com",
      cookie: `foundation_session=${token}`,
    },
    params: { id: "company", panel: "pnl_1" },
    query: url.searchParams,
    socket: { remoteAddress: "127.0.0.1" },
  } as never;
}

function assertHttp403(fn: () => unknown, pattern = /turned off on a hosted Foundation server/) {
  assert.throws(
    fn,
    (err: unknown) => err instanceof HttpError && err.status === 403 && pattern.test(err.message),
  );
}

async function assertAsyncHttp403(fn: () => Promise<unknown>, pattern = /turned off on a hosted Foundation server/) {
  await assert.rejects(
    fn,
    (err: unknown) => err instanceof HttpError && err.status === 403 && pattern.test(err.message),
  );
}

test("serverCapabilities: hosted mode disables local-computer features unless FOUNDATION_ALLOW_HOST_TOOLS=1", () => {
  config.publicUrl = HOSTED_URL;
  delete process.env.FOUNDATION_ALLOW_HOST_TOOLS;

  const hostedCaps = serverCapabilities();
  assert.equal(hostedCaps.hosted, true);
  assert.equal(hostedCaps.allowHostTools, false);
  assert.equal(hostedCaps.chat, true);
  assert.deepEqual(hostedCaps.images, { serverLevels: true, widths: [64, 256, 512, 1024, 2048] });
  for (const key of ["terminal", "browser", "machines", "vms", "t3", "vision", "places", "localDev"] as const) {
    assert.equal(hostedCaps.local[key], false, `expected ${key} to be false in hosted mode`);
    assert.equal(localFeatureAllowed(key), false);
    assert.match(hostedFeatureReason(key), /turned off on a hosted Foundation server/);
    assertHttp403(() => requireLocalFeature(key));
  }

  // Explicitly unlocking host tools re-enables them on a hosted server
  process.env.FOUNDATION_ALLOW_HOST_TOOLS = "1";
  try {
    assert.equal(allowHostTools(), true);
    const unlocked = serverCapabilities();
    assert.equal(unlocked.hosted, true);
    assert.equal(unlocked.allowHostTools, true);
    for (const key of ["terminal", "browser", "machines", "vms", "t3", "vision", "places", "localDev"] as const) {
      assert.equal(unlocked.local[key], true, `expected ${key} to be true when FOUNDATION_ALLOW_HOST_TOOLS=1`);
    }
  } finally {
    delete process.env.FOUNDATION_ALLOW_HOST_TOOLS;
  }

  // Local loopback server enables all local features by default
  config.publicUrl = "http://localhost:4410";
  try {
    const localCaps = serverCapabilities();
    assert.equal(localCaps.hosted, false);
    assert.equal(localCaps.allowHostTools, false);
    for (const key of ["terminal", "browser", "machines", "vms", "t3", "vision", "places", "localDev"] as const) {
      assert.equal(localCaps.local[key], true, `expected ${key} to be true in local mode`);
    }
  } finally {
    config.publicUrl = HOSTED_URL;
  }
});

test("hosted boundary: terminal, browser, machines, vms, t3, places and localDev refuse with 403 and honest reasons", async () => {
  config.publicUrl = HOSTED_URL;
  delete process.env.FOUNDATION_ALLOW_HOST_TOOLS;

  // 1. Built-in terminal
  assertHttp403(() => requestHostTerminal(personReq(boss.id, "/api/host-terminal")));

  // 2. Built-in browser
  assertHttp403(() => requestHostBrowser(personReq(boss.id, "/api/host-browser")));

  // 3. Container machines
  assert.deepEqual(await engineStatus(true), []);
  await assertAsyncHttp403(() => startMachine("company", "pnl_1", boss.name, { image: "alpine:3.20" }));
  await assertAsyncHttp403(() => stopMachine("company", "pnl_1", boss.name));
  await assertAsyncHttp403(() => restartMachine("company", "pnl_1", boss.name));
  await assertAsyncHttp403(() => removeMachine("company", "pnl_1", boss.name, true));
  await assertAsyncHttp403(() => loadImage("company", "file_1", boss.name));

  // 4. Local QEMU VMs (vmroutes)
  const vmRouter = new Router();
  registerVmRoutes(vmRouter);
  const hostMatch = vmRouter.match("GET", "/api/vms/host");
  assert.ok(hostMatch);
  const vmHostStatus = (await hostMatch.handler(personReq(boss.id, "/api/vms/host", "GET"), {} as never)) as {
    available: boolean;
    hosted?: boolean;
    note: string;
  };
  assert.equal(vmHostStatus.available, false);
  assert.equal(vmHostStatus.hosted, true);
  assert.match(vmHostStatus.note, /turned off on a hosted Foundation server/);

  const vmStartMatch = vmRouter.match("POST", "/api/boards/company/vms/pnl_1/start");
  assert.ok(vmStartMatch);
  await assertAsyncHttp403(async () => {
    const req = personReq(boss.id, "/api/boards/company/vms/pnl_1/start", "POST") as { params: Record<string, string> };
    req.params = vmStartMatch.params;
    await vmStartMatch.handler(req as never, {} as never);
  });

  // 5. Local T3 host
  const t3 = t3Host();
  assert.equal(t3.state, "off");
  assert.match(t3.detail ?? "", /turned off on a hosted Foundation server/);
  await assertAsyncHttp403(() => startT3(boss.name));
  assertHttp403(() => stopT3());
  await assertAsyncHttp403(() => addT3Agent({ preset: "kimi", where: "local", model: "kimi" }));
  await assertAsyncHttp403(() => enableT3Agent("claudeAgent"));
  await assertAsyncHttp403(() => removeT3Agent("kimi-local"));
  await assertAsyncHttp403(() => localModels());

  // 6. Places (local folders)
  const placeDir = mkdtempSync(join(tmpdir(), "foundation-place-"));
  assertHttp403(() => approvePlace(boss, true, { path: placeDir, name: "Drawings" }));
  assertHttp403(() => removePlace(boss, true, "pl_123", true));
  await assertAsyncHttp403(() => listPlace("pl_123"));
  await assertAsyncHttp403(() => bringFromPlace(boss, "pl_123", "a.txt", "company"));

  // 7. Local projects watch (localDev)
  const loc = localStatus(boss, true) as { connected: boolean; canConnect: boolean; hosted?: boolean; note?: string };
  assert.equal(loc.connected, false);
  assert.equal(loc.canConnect, false);
  assert.equal(loc.hosted, true);
  assert.match(loc.note ?? "", /turned off on a hosted Foundation server/);
  await assertAsyncHttp403(() => connectLocal(boss, true));
  assertHttp403(() => stopLocal(boss, true));

  // Re-enabling via FOUNDATION_ALLOW_HOST_TOOLS=1 unblocks host terminal and places
  process.env.FOUNDATION_ALLOW_HOST_TOOLS = "1";
  try {
    const term = requestHostTerminal(personReq(boss.id, "/api/host-terminal"));
    assert.ok(term.id && term.key);
    const approved = approvePlace(boss, true, { path: placeDir, name: "Drawings" });
    assert.equal(approved.name, "Drawings");
  } finally {
    delete process.env.FOUNDATION_ALLOW_HOST_TOOLS;
  }
});

test("admin people management: listServerUsers, role changes, last-admin guard, and audit log", () => {
  const initial = listServerUsers();
  assert.ok(initial.length >= 3);
  assert.equal(initial[0].email, "boss@formindustries.co");
  assert.equal(initial[0].role, "admin");

  // Non-admin cannot change roles
  assertHttp403(() => setServerUserRole(ada, kai.id, "viewer"), /Only an admin/);

  // Invalid role is rejected with 400
  assert.throws(
    () => setServerUserRole(boss, kai.id, "superadmin" as never),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  // Unknown target user is rejected with 404
  assert.throws(
    () => setServerUserRole(boss, "u_missing_person", "viewer"),
    (err: unknown) => err instanceof HttpError && err.status === 404,
  );

  // Last admin cannot demote themselves
  assert.throws(
    () => setServerUserRole(boss, boss.id, "member"),
    (err: unknown) =>
      err instanceof HttpError && err.status === 400 && /At least one admin must stay on this server/.test(err.message),
  );

  // Admin promotes Ada to admin, then demotes Kai to viewer
  const afterPromote = setServerUserRole(boss, ada.id, "admin");
  assert.equal(afterPromote.find((u) => u.id === ada.id)?.role, "admin");

  const afterViewer = setServerUserRole(boss, kai.id, "viewer");
  assert.equal(afterViewer.find((u) => u.id === kai.id)?.role, "viewer");

  // With two admins (Boss and Ada), Ada can be demoted back to member
  const afterDemoteAda = setServerUserRole(boss, ada.id, "member");
  assert.equal(afterDemoteAda.find((u) => u.id === ada.id)?.role, "member");

  // Audit log recorded the role changes and the hash chain verifies
  const auditRows = readAudit({ limit: 50 }).filter((r) => r.action === "user.role");
  assert.ok(auditRows.length >= 3);
  assert.ok(auditRows.some((r) => r.target === "ada@formindustries.co -> admin" && r.actor_id === boss.id));
  assert.ok(auditRows.some((r) => r.target === "kai@normallab.co -> viewer" && r.actor_id === boss.id));
  assert.equal(verifyAudit().ok, true);
});

test("backup and restore end-to-end: preserves SQLite chat messages and archived files, excludes image cache, requires confirm", () => {
  const srcData = mkdtempSync(join(tmpdir(), "foundation-backup-src-"));
  const backupDir = mkdtempSync(join(tmpdir(), "foundation-backup-dst-"));
  mkdirSync(join(srcData, "files"), { recursive: true });
  mkdirSync(join(srcData, "cache", "images", "deadbeef"), { recursive: true });

  // Create a SQLite database with chat messages and a file row
  const dbPath = join(srcData, "foundation.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    pragma journal_mode = wal;
    create table chat_channels (id text primary key, name text not null);
    create table chat_messages (id text primary key, channel_id text not null, author text not null, text text not null);
    create table files (id text primary key, name text not null, sha256 text not null, size integer not null);
  `);
  db.prepare("insert into chat_channels (id, name) values (?, ?)").run("ch_general", "general");
  db.prepare("insert into chat_messages (id, channel_id, author, text) values (?, ?, ?, ?)").run(
    "msg_1",
    "ch_general",
    "Ada Field",
    "Rim-drive stator test passed at 4,200 RPM.",
  );
  const fileSha = "a".repeat(64);
  const fileBytes = Buffer.from("archived-cad-step-content-v1", "utf8");
  db.prepare("insert into files (id, name, sha256, size) values (?, ?, ?, ?)").run("f_1", "stator.step", fileSha, fileBytes.length);
  db.close();

  writeFileSync(join(srcData, "secret.key"), "secret-key-bytes-32-chars-minimum");
  writeFileSync(join(srcData, "files", fileSha), fileBytes);
  writeFileSync(join(srcData, "cache", "images", "deadbeef", "64.jpg"), Buffer.from("cached-lqip"));

  // Run backup
  const snap = backup({ data: srcData, to: backupDir, snapshot: "2026-11-21_1500", quiet: true });
  assert.equal(snap.snapshot, "2026-11-21_1500");
  assert.equal(snap.filesCopied, 1);
  assert.equal(existsSync(join(backupDir, "db", "2026-11-21_1500", "foundation.db")), true);
  assert.equal(existsSync(join(backupDir, "db", "2026-11-21_1500", "secret.key")), true);
  assert.equal(existsSync(join(backupDir, "files", fileSha)), true);
  assert.equal(existsSync(join(backupDir, "cache")), false, "image cache must not be copied into backups");

  // Mutate database and add a newer archived file in srcData
  const mutated = new DatabaseSync(dbPath);
  mutated.exec("delete from chat_messages");
  mutated.close();
  const extraSha = "b".repeat(64);
  writeFileSync(join(srcData, "files", extraSha), Buffer.from("newer-upload-never-deleted", "utf8"));

  // Restore without confirm must be refused
  assert.throws(
    () => restoreBackup({ from: backupDir, to: srcData, confirm: false, quiet: true }),
    /confirm/i,
  );

  // Restore with confirm: true restores the original DB and merges files without deleting extraSha
  const restored = restoreBackup({ from: backupDir, to: srcData, confirm: true, quiet: true });
  assert.equal(restored.snapshot, "2026-11-21_1500");
  assert.equal(restored.hasSecretKey, true);

  const checkDb = new DatabaseSync(dbPath, { readOnly: true });
  const integrity = checkDb.prepare("pragma integrity_check").get() as Record<string, string>;
  assert.equal(Object.values(integrity)[0], "ok");
  const msg = checkDb.prepare("select author, text from chat_messages where id = 'msg_1'").get() as {
    author: string;
    text: string;
  };
  const fileRow = checkDb.prepare("select name, sha256 from files where id = 'f_1'").get() as {
    name: string;
    sha256: string;
  };
  checkDb.close();

  assert.equal(msg.author, "Ada Field");
  assert.equal(msg.text, "Rim-drive stator test passed at 4,200 RPM.");
  assert.equal(fileRow.name, "stator.step");
  assert.equal(fileRow.sha256, fileSha);
  assert.deepEqual(readFileSync(join(srcData, "files", fileSha)), fileBytes);
  assert.equal(existsSync(join(srcData, "files", extraSha)), true, "existing archived files in destination are never deleted");
});

test("validateHostedEnv: catches unsafe dev login, localhost domain, missing Google credentials, and passes clean production config", () => {
  const bad = validateHostedEnv({
    FOUNDATION_DOMAIN: "localhost",
    FOUNDATION_DEV_LOGIN: "1",
    FOUNDATION_ALLOWLIST: "@example.com",
    FOUNDATION_ADMIN_EMAILS: "you@example.com",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "placeholder",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /loopback/i.test(e)));
  assert.ok(bad.errors.some((e) => /FOUNDATION_DEV_LOGIN=1/i.test(e)));
  assert.ok(bad.errors.some((e) => /FOUNDATION_ALLOWLIST/i.test(e)));
  assert.ok(bad.errors.some((e) => /FOUNDATION_ADMIN_EMAILS/i.test(e)));
  assert.ok(bad.errors.some((e) => /GOOGLE_CLIENT_ID/i.test(e)));
  assert.ok(bad.errors.some((e) => /GOOGLE_CLIENT_SECRET/i.test(e)));

  const warnCom = validateHostedEnv({
    FOUNDATION_DOMAIN: "foundation.formindustries.co",
    FOUNDATION_ALLOWLIST: "@formindustries.com",
    FOUNDATION_ADMIN_EMAILS: "josh@formindustries.co",
    GOOGLE_CLIENT_ID: "1234567890-abc.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "google-oauth-client-secret-configured",
  });
  assert.equal(warnCom.ok, true);
  assert.ok(warnCom.warnings.some((w) => /@formindustries\.co/.test(w)));

  const clean = validateHostedEnv({
    FOUNDATION_DOMAIN: "foundation.formindustries.co",
    FOUNDATION_ALLOWLIST: "@formindustries.co,@normallab.co",
    FOUNDATION_ADMIN_EMAILS: "josh@formindustries.co",
    GOOGLE_CLIENT_ID: "1234567890-abc.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "google-oauth-client-secret-configured",
    FOUNDATION_ICE_SERVERS: '[{"urls":"turn:turn.formindustries.co:3478"}]',
  });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.errors, []);
});

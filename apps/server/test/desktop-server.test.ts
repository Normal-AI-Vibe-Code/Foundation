/**
 * The server as the desktop app runs it (apps/client/src-tauri/src/server.rs): its own folder
 * for `.env` and `data/` (FOUNDATION_ROOT), gone when the app's end of stdin closes, and one
 * plain line when its port is taken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const serverDir = resolve(import.meta.dirname, "..");

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

function start(home: string, port: number) {
  const env: NodeJS.ProcessEnv = { ...process.env, FOUNDATION_PORT: String(port), FOUNDATION_ROOT: home, FOUNDATION_EXIT_WITH_PARENT: "1", FOUNDATION_STARTER_DIR: "" };
  // the folder decides these, not whatever this shell has set
  for (const k of ["FOUNDATION_DATA_DIR", "FOUNDATION_DEV_LOGIN", "FOUNDATION_PUBLIC_URL"]) delete env[k];
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const said = { out: "" };
  child.stdout!.on("data", (d) => (said.out += d));
  child.stderr!.on("data", (d) => (said.out += d));
  const exit = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
  return { child, said, exit };
}

async function up(port: number, child: ChildProcess): Promise<{ ok?: boolean; name?: string } | null> {
  // up to two minutes: a loaded machine has taken a minute to boot it (tsx compiles on start)
  for (let i = 0; i < 1200 && child.exitCode === null; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return (await r.json()) as { ok?: boolean; name?: string };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"timeout">((ok) => setTimeout(() => ok("timeout"), ms).unref())]);

test("the app's server keeps to its own folder, says who it is, and leaves when the app does", async () => {
  const home = mkdtempSync(join(tmpdir(), "foundation-desktop-"));
  // dev login is off by default, so the folder's .env turning it on is what shows the file was read
  writeFileSync(join(home, ".env"), "FOUNDATION_DEV_LOGIN=1\n");
  const port = await freePort();
  const a = start(home, port);
  try {
    const health = await up(port, a.child);
    assert.ok(health, `the server didn't come up:\n${a.said.out}`);
    assert.equal(health.ok, true);
    assert.equal(health.name, "foundation", "the app tells a Foundation server from another program on the port by this");
    assert.ok(existsSync(join(home, "data", "foundation.db")), "its database is under FOUNDATION_ROOT, not the repo's data/");
    const cfg = (await (await fetch(`http://127.0.0.1:${port}/auth/config`)).json()) as { devLogin: boolean };
    assert.equal(cfg.devLogin, true, "it read .env from FOUNDATION_ROOT");

    // a second server on the same port says why in one line and exits, rather than hanging on
    const b = start(mkdtempSync(join(tmpdir(), "foundation-desktop-")), port);
    assert.equal(await within(b.exit, 30_000), 1, `a second server on a taken port should exit 1:\n${b.said.out}`);
    assert.match(b.said.out, /can't listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);

    // the app quits (or dies): its end of the pipe closes
    a.child.stdin!.end();
    assert.equal(await within(a.exit, 10_000), 0, "the server exits by itself once stdin closes");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`), "and nothing is left on the port");
  } finally {
    a.child.kill();
  }
});

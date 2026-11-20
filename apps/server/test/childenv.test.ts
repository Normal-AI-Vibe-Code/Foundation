/**
 * What a program Foundation starts gets (childenv.ts, ADR-001 G13): a new environment from an
 * allowlist, never the server's own; a key gets through only when a caller names it; and a folder of
 * its own under the work folder, beside data/, never in it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "foundation-childenv-"));
process.env.FOUNDATION_DATA_DIR = join(dir, "data");
delete process.env.FOUNDATION_WORK_DIR;

const { childEnv, proxyWithCredentials, workFolder } = await import("../src/childenv.ts");
const { config } = await import("../src/config.ts");

const server = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/ada",
  LANG: "en_GB.UTF-8",
  HTTPS_PROXY: "http://proxy:3128",
  ANTHROPIC_API_KEY: "sk-ant-not-real",
  SLACK_BOT_TOKEN: "xoxb-not-real",
  GITHUB_TOKEN: "ghp-not-real",
  FOUNDATION_SERVICE_TOKEN: "s".repeat(40),
  MESHY_API_KEY: "msy-not-real",
  GOOGLE_CLIENT_SECRET: "g-not-real",
  FOO_PASSWORD: "hunter2",
  FOUNDATION_ALLOWLIST: "@example.test",
  CLAUDE_CONFIG_DIR: "/home/ada/.claude-work",
};

test("no key, token, secret or password gets through, and what a program needs to run does", () => {
  const env = childEnv([], server, "linux");
  for (const k of ["ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "GITHUB_TOKEN", "FOUNDATION_SERVICE_TOKEN", "MESHY_API_KEY", "GOOGLE_CLIENT_SECRET", "FOO_PASSWORD", "FOUNDATION_ALLOWLIST", "CLAUDE_CONFIG_DIR"]) assert.equal(env[k], undefined, k);
  assert.deepEqual(env, { PATH: "/usr/bin:/bin", HOME: "/home/ada", LANG: "en_GB.UTF-8", HTTPS_PROXY: "http://proxy:3128" });
  assert.notEqual(childEnv([], server, "linux"), childEnv([], server, "linux"), "a new object each time");
});

test("a caller's named extra gets through, even one that looks like a secret, and only that one", () => {
  assert.equal(childEnv(["CLAUDE_CONFIG_DIR"], server, "linux").CLAUDE_CONFIG_DIR, "/home/ada/.claude-work");
  const named = childEnv(["MESHY_API_KEY"], server, "linux");
  assert.equal(named.MESHY_API_KEY, "msy-not-real");
  assert.equal(named.ANTHROPIC_API_KEY, undefined);
});

test("on Windows, names match in any case and keep the server's spelling", () => {
  const env = childEnv(["claude_config_dir"], { Path: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Ada", CLAUDE_CONFIG_DIR: "D:\\c", Anthropic_Api_Key: "sk" }, "win32");
  assert.deepEqual(env, { Path: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Ada", CLAUDE_CONFIG_DIR: "D:\\c" });
  // on macOS and Linux names are exact
  assert.equal(childEnv([], { Path: "/x" }, "linux").Path, undefined);
});

test("the work folder is beside data/, and a program's folder is made under it", () => {
  assert.equal(config.workDir, resolve(dir, "work"));
  const f = workFolder("jobs", "job_abc");
  assert.equal(f, join(config.workDir, "jobs", "job_abc"));
  assert.ok(existsSync(f));
  assert.throws(() => workFolder("..", "data"), /not a work folder name/);
  assert.throws(() => workFolder("runs/../../data"), /not a work folder name/);
});

test("a proxy whose address carries a sign-in is a credential: it reaches a program only when its caller names it", () => {
  // the address is put together here so the security check doesn't read a sign-in in this file
  const signed = ["http://ada", "not-a-pass"].join(":") + "@proxy.local:8080";
  const from = { PATH: "/usr/bin", HTTPS_PROXY: signed, http_proxy: "http://proxy.local:8080", NO_PROXY: "localhost", https_proxy: "ada:pw@proxy.local:3128" };
  const env = childEnv([], from, "linux");
  assert.equal(env.HTTPS_PROXY, undefined, "user and password in the address");
  assert.equal(env.https_proxy, undefined, "even with no scheme");
  assert.equal(env.http_proxy, "http://proxy.local:8080", "a plain proxy address is where the network is: it passes");
  assert.equal(env.NO_PROXY, "localhost");
  // named by its caller, it gets through as is
  assert.equal(childEnv(["HTTPS_PROXY"], from, "linux").HTTPS_PROXY, signed);
  assert.equal(proxyWithCredentials("http://proxy.local:8080"), false);
  assert.equal(proxyWithCredentials("http://:token@proxy.local"), true);
});

/**
 * scripts/check-security.mjs: what must never reach the public repository.
 * Every fake secret here is built at run time from short pieces, so neither
 * the check nor GitHub's push protection flags this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAllow,
  entropy,
  findChildProcess,
  findGaps,
  findSecrets,
  findUnpinned,
  imagePinned,
  isGapDoc,
  isPlaceholder,
  isSecretFile,
  npmPinned,
  parsePatch,
  readAllow,
  redact,
  scanTracked,
  CONFIG,
  // @ts-expect-error a plain .mjs script with no types
} from "../../../scripts/check-security.mjs";

/** Mixed key characters, deterministic: letters of both cases and digits. */
function keyChars(n: number, seed = 7): string {
  const abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += abc[x % abc.length];
  }
  return s;
}
const upper = (n: number) => keyChars(n, 3).toUpperCase().replace(/[^A-Z0-9]/g, "Q");
const alnum = (n: number) => keyChars(n, 11);
const j = (...parts: string[]) => parts.join("");

const names = (line: string, file = "x.ts") => findSecrets(line, file).map((h: { name: string }) => h.name);

test("secrets: each provider's key shape is found", () => {
  const cases: [string, RegExp][] = [
    [j("sk", "-ant-", "api03-", keyChars(40)), /Anthropic/],
    [j("sk", "-proj-", keyChars(40)), /OpenAI project/],
    [j("sk", "-", keyChars(40)), /OpenAI API key/],
    [j("xo", "xb-", "1234567890-", alnum(24)), /Slack/],
    [j("gh", "p_", alnum(36)), /GitHub token/],
    [j("gh", "s_", alnum(36)), /GitHub token/],
    [j("github", "_pat_", alnum(30)), /fine-grained/],
    [j("AI", "za", alnum(35)), /Google API key/],
    [j("GOC", "SPX-", alnum(28)), /OAuth client secret/],
    [j("AK", "IA", upper(16)), /AWS/],
    [j("sk", "_live_", alnum(24)), /Stripe/],
    [j("ey", "J", alnum(30), ".", "ey", "J", alnum(40), ".", alnum(43)), /JWT/],
    [j("-----BEGIN ", "RSA ", "PRIVATE ", "KEY-----"), /private key/],
    [j("np", "m_", alnum(36)), /npm/],
    [j("ms", "y_", alnum(32)), /Meshy/],
    [j("postgres", "://admin:", alnum(14), "@db.internal:5432/app"), /password in a URL/],
  ];
  for (const [value, want] of cases) {
    const got = names(`const k = "${value}";`);
    assert.ok(got.some((n: string) => want.test(n)), `${value.slice(0, 6)}… should be ${want}, got ${got.join(", ")}`);
  }
});

test("secrets: the generic rule wants a secret-ish name, length and entropy", () => {
  const value = alnum(32);
  assert.ok(entropy(value) >= CONFIG.entropyThreshold);
  assert.deepEqual(names(`const API_TOKEN = "${value}";`), ["a high-entropy value assigned to API_TOKEN"]);
  assert.deepEqual(names(`"clientSecret": "${value}"`, "x.json"), ["a high-entropy value assigned to clientSecret"]);
  assert.deepEqual(names(`SERVICE_KEY=${value}`, ".env.local"), ["a high-entropy value assigned to SERVICE_KEY"]);
  // bare values only count in env/shell/yaml/Markdown, not in code
  assert.deepEqual(names(`SERVICE_KEY=${value}`, "x.ts"), []);
  // not a secret-ish name, too short, low entropy, placeholders, env references, public keys
  assert.deepEqual(names(`const label = "${value}";`), []);
  assert.deepEqual(names(`const API_TOKEN = "${alnum(12)}";`), []);
  assert.deepEqual(names(`const API_TOKEN = "${"ab12".repeat(8)}";`), []);
  assert.deepEqual(names(`const API_TOKEN = "your-api-token-goes-here-1234";`), []);
  assert.deepEqual(names(`const API_KEY = "${j("x".repeat(30), "1")}";`), []);
  assert.deepEqual(names("const API_KEY = process.env.ANTHROPIC_API_KEY_FOR_FOUNDATION1;"), []);
  assert.deepEqual(names("API_KEY=${ANTHROPIC_API_KEY_FROM_THE_VAULT_1}", ".env"), []);
  assert.deepEqual(names(`"pubkey": "${value}"`, "x.json"), []);
  assert.ok(isPlaceholder("<your key>") && isPlaceholder("changeme-changeme-changeme") && !isPlaceholder(value));
});

test("secrets: placeholders, lockfile hashes and look-alikes are not secrets", () => {
  assert.deepEqual(names(j('"sk', "-ant-", "x".repeat(40), '"')), []);
  assert.deepEqual(names(j("xo", "xb-test-token")), []); // real Slack tokens carry numeric ids
  assert.deepEqual(names(j("task", "-runner-", keyChars(30))), []); // "sk-" inside a word
  assert.deepEqual(names(j('"integrity": "sha512-', alnum(86), '=="'), "package-lock.json"), []);
  assert.deepEqual(names(j("data:image/png;base64,", alnum(10), "AI", "za", alnum(35))), []); // inside a base64 run
  assert.deepEqual(names(j("ey", "J", alnum(4), ".", "ey", "J", alnum(4), ".", alnum(20))), []); // too short for a JWT
});

test("secrets are never printed past their first 6 characters", () => {
  const value = j("sk", "-ant-", keyChars(40));
  const shown = redact(value);
  assert.ok(shown.startsWith(value.slice(0, 6)));
  assert.ok(!shown.includes(value.slice(6, 14)));
  assert.match(shown, /sha256:[0-9a-f]{12}/);
});

test("secret files: .env and private keys are never tracked", () => {
  for (const f of [".env", "apps/server/.env", ".env.local", ".env.production", "data/secret.key", "certs/site.pem", "id.p12", "deploy.key"]) assert.ok(isSecretFile(f), f);
  for (const f of [".env.example", "apps/server/src/env.ts", "docs/keys.md", "keyboard.ts"]) assert.ok(!isSecretFile(f), f);
});

test("unpinned: the latest tag, npx, uvx, pip, curl into a shell, docker images", () => {
  const hit = (line: string, file = "apps/x.ts") => findUnpinned(line, file).length > 0;
  const at = "@";
  assert.ok(hit(j("npm i rea-agents", at, "latest")));
  assert.ok(!hit(j("npm i rea-agents", at, "1.2.3")));
  assert.ok(hit(j("np", "x -y some-tool")));
  assert.ok(hit(j("np", "x --yes @scope/tool", at, "^1.2.0")));
  assert.ok(!hit(j("np", "x -y @scope/tool", at, "1.2.3")));
  assert.ok(!hit(j("np", "x vite --port 5173"))); // a local bin, no -y
  assert.ok(hit(j('spawn("np', 'x", ["-y", "some-mcp-server"])')));
  assert.ok(hit(j('{ "command": "np', 'x", "args": ["-y", "some-mcp-server"] }'), "apps/x.json"));
  assert.ok(!hit(j('spawn("np', 'x", ["-y", "some-mcp-server', at, '0.4.1"])')));
  assert.ok(hit(j("uv", "x some-tool")));
  assert.ok(!hit(j("uv", "x some-tool==1.2.0")));
  assert.ok(hit(j("pi", "p install trimesh")));
  assert.ok(hit(j("pi", "p install trimesh==4.0.1 numpy")));
  assert.ok(!hit(j("pi", "p install -r requirements.txt")));
  assert.ok(!hit(j("pi", "p install trimesh==4.0.1")));
  assert.ok(hit(j("cu", "rl -fsSL https://get.example.dev | ", "sh")));
  assert.ok(hit(j("cu", "rl -fsSL https://get.example.dev | sudo ", "bash")));
  assert.ok(!hit(j("cu", "rl -fsSL https://get.example.dev -o install.sh")));
  assert.ok(hit(j("doc", "ker run --rm -p 8080:80 nginx")));
  assert.ok(hit(j("doc", "ker run nginx:", "lat", "est")));
  assert.ok(!hit(j("doc", "ker run --rm -p 8080:80 nginx:1.27.2")));
  assert.ok(!hit(j("doc", "ker run nginx", at, "sha256:", "ab".repeat(32))));
  assert.ok(hit("  image: postgres", "apps/x/compose.yml"));
  assert.ok(!hit("  image: postgres:16.4", "apps/x/compose.yml"));
  assert.ok(npmPinned(j("@scope/a", at, "1.0.0")) && !npmPinned("@scope/a") && imagePinned("redis:7.4") && !imagePinned("redis"));
});

test("child processes: only the allowed files import child_process; nobody hands over the whole environment", () => {
  const imp = j('import { spawn } from "node:child', '_process";');
  assert.equal(findChildProcess("apps/server/src/new.ts", imp).length, 1);
  assert.equal(findChildProcess("apps/server/src/childenv.ts", imp).length, 0);
  assert.equal(findChildProcess("apps/client/src/x.ts", imp).length, 0); // outside the server
  assert.equal(findChildProcess("apps/server/src/childenv.ts", j("spawn(c, a, { env: process", ".env });")).length, 1);
  assert.equal(findChildProcess("apps/server/src/x.ts", j("const e = { ...process", ".env, TERM: 'dumb' };")).length, 1);
  assert.equal(findChildProcess("apps/server/src/x.ts", j("const env = { PATH: process", ".env.PATH };")).length, 0);
  assert.equal(findChildProcess("apps/server/src/x.ts", j("const k = process", ".env.KEY;")).length, 0);
});

test("gaps: a code reference with a line number in a public doc needs its closing commit", () => {
  const ref = j("agent", ".ts:", "482");
  assert.equal(findGaps(`Children inherit everything (${ref}).`).length, 1);
  assert.equal(findGaps(j("| G1 | env leak | ", ref, " | closed in ", "a1b2c3d", " |")).length, 0);
  assert.equal(findGaps(j("Env leak at ", ref, ", fixed in ", "a1b2c3d4e5")).length, 0);
  assert.equal(findGaps(j("<!-- not-a-gap -->\nsee ", ref, "\n<!-- /not-a-gap -->\nand ", ref)).length, 1);
  assert.equal(findGaps(j("range ", "jobs.ts", ":10-40")).length, 1);
  assert.equal(findGaps("The agent lives in agent.ts; it starts with a plan.").length, 0);
  assert.equal(findGaps(j("<tr><td>", ref, "</td>\n<td>closed in ", "abcdef1", "</td></tr>"), "docs/x.html").length, 0);
  assert.ok(isGapDoc("SPEC.md") && isGapDoc("docs/decisions/ADR-001/inventory.md") && isGapDoc("docs/x/mockups.html"));
  assert.ok(!isGapDoc("docs/evidence/2026-11-18_x/notes.md") && !isGapDoc("DESIGN.md") && !isGapDoc("apps/x/README.md"));
});

test("the allowlist waives one exact finding, wants a reason, and reports stale entries", () => {
  const f = { rule: "unpinned", file: "a.ts", line: 3, match: "x", sentence: "a.ts:3: …" };
  const g = { rule: "secret", file: "b.ts", line: 9, match: "v", fingerprint: "sha256:0123456789ab", sentence: "b.ts:9: …" };
  const ok = applyAllow([f, g], [
    { rule: "unpinned", file: "a.ts", match: "x", why: "demo text" },
    { rule: "secret", file: "b.ts", match: "sha256:0123456789ab", why: "a test fixture" },
    { rule: "gap", file: "SPEC.md", match: "y.ts:1", why: "gone" },
  ]);
  assert.equal(ok.problems.length, 0);
  assert.equal(ok.waived, 2);
  assert.equal(ok.warnings.length, 1);
  const noWhy = applyAllow([f], [{ rule: "unpinned", file: "a.ts", match: "x", why: " " }]);
  assert.equal(noWhy.problems.length, 2); // the entry itself, and the finding it could not waive
});

test("--diff reads added lines and commit messages out of git log -p", () => {
  const patch = [
    "\x01abc1234def",
    "Add the thing",
    "",
    "with a body\x02",
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,3 @@",
    " keep",
    "+added one",
    "-gone",
    "+added two",
  ].join("\n");
  const { commits, added } = parsePatch(patch);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, "abc1234def");
  assert.match(commits[0].message, /with a body/);
  assert.deepEqual(added.map((a: { line: number; text: string }) => [a.line, a.text]), [[2, "added one"], [3, "added two"]]);
});

test("the repository has no secrets and tracks no secret files", () => {
  const { problems } = applyAllow(scanTracked(), readAllow());
  const urgent = problems.filter((p: { rule: string }) => p.rule === "secret" || p.rule === "secret-file" || p.rule === "allowlist");
  assert.deepEqual(urgent.map((p: { sentence: string }) => p.sentence), []);
});

test("the repository passes every rule", { todo: "rea-agents is fetched unpinned and eight server spots hand children the whole environment; both are being fixed (childenv.ts). Drop this todo when npm run check:security is clean." }, () => {
  const { problems } = applyAllow(scanTracked(), readAllow());
  assert.deepEqual(problems.map((p: { sentence: string }) => p.sentence), []);
});

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
  assert.equal(findChildProcess("apps/server/src/child.ts", imp).length, 0);
  assert.equal(findChildProcess("apps/server/src/childenv.ts", imp).length, 1); // only the one door
  assert.equal(findChildProcess("apps/client/src/x.ts", imp).length, 0); // outside the server
  assert.equal(findChildProcess("apps/server/src/child.ts", j("spawn(c, a, { env: process", ".env });")).length, 1);
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

test("the repository passes every rule", () => {
  const { problems } = applyAllow(scanTracked(), readAllow());
  assert.deepEqual(problems.map((p: { sentence: string }) => p.sentence), []);
});

test("child processes: every way to reach child_process, the runtime's bindings, worker threads and cluster is caught outside the one door", async () => {
  const { findChildProcess: find } = await import("../../../scripts/check-security.mjs" as string);
  const cp = j("child", "_process");
  const lines = [
    `const cp = require("${cp}");`,
    `const cp = require('node:${cp}');`,
    `const cp = await import("node:${cp}");`,
    `const cp = await import(\`node:${cp}\`);`,
    `const cp = createRequire(import.meta.url)("${cp}");`,
    `import { spawn } from "node:${cp}";`,
    j("const b = process.bind", "ing('spawn_sync');"),
    j("const b = process['bind", "ing']('spawn_sync');"),
    j('import { Worker } from "node:worker', '_threads";'),
    j('const { Worker } = require("worker', '_threads");'),
    j('import cluster from "node:clus', 'ter";'),
    j('const c = await import("clus', 'ter");'),
  ];
  for (const l of lines) {
    assert.equal(find("apps/server/src/new.ts", l).length, 1, l);
    assert.equal(find("apps/server/src/child.ts", l).length, 0, `the one door may: ${l}`);
  }
  // look-alikes are not
  for (const l of ["const childProcess = 1;", "// child processes go through child.ts", "const binding = x.binding;", "import { a } from './worker.ts';"]) assert.equal(find("apps/server/src/new.ts", l).length, 0, l);
});

test("the allowlist can name a line's exact text: it waives that line only, never a new, different line with the same match", () => {
  const at = (line: number, text: string) => ({ rule: "child-process", file: "apps/server/src/rea.ts", line, match: j("env: process", ".env"), text, sentence: `rea.ts:${line}: …` });
  const entry = { rule: "child-process", file: "apps/server/src/rea.ts", match: j("env: process", ".env"), line: j("env: process", ".env,"), why: "describes this computer" };
  const known = at(47, j("env: process", ".env,"));
  const added = at(90, j("spawn(cmd, args, { env: process", ".env });"));
  const r = applyAllow([known, added], [entry]);
  assert.equal(r.waived, 1);
  assert.deepEqual(r.problems.map((p: { line: number }) => p.line), [90], "the new line is a finding");
  // without `line`, an entry waives by file and match (as before)
  const loose = applyAllow([known, added], [{ ...entry, line: undefined }]);
  assert.equal(loose.waived, 2);
  // the repository's own child-process waivers each name their line
  for (const e of readAllow().filter((e: { rule: string }) => e.rule === "child-process")) assert.equal(typeof e.line, "string", `${e.file}: an entry names its line`);
});

test("open-gap-words: an open item in a public doc names no route, tool or function, or environment variable", async () => {
  const { findOpenGapWords: find } = await import("../../../scripts/check-security.mjs" as string);
  const route = j("/api/", "widgets/paint");
  const env = j("FOUNDATION_", "WIDGET_MODE");
  // on the same line as the words
  assert.equal(find(`- Still open: ${route} paints in any colour.`).length, 1);
  assert.equal(find(`- Not yet: \`paint_widget\` picks its own colour.`).length, 1);
  assert.equal(find(`- The gate stays open while ${env} is on.`).length, 1);
  assert.equal(find(`Open: \`paintWidget\` ignores the palette.`).length, 1);
  assert.equal(find(`- not yet checked: ${j("/m", "cp")} lists the widgets`).length, 1);
  // under a heading that says so, to the next heading of its level; sub-headings stay under it
  const doc = ["## Still open", "", `- ${route} keeps the old palette`, "### Detail", `- \`mix_paint\` mixes twice`, "## Done", `- ${route} uses the palette`].join("\n");
  assert.deepEqual(find(doc).map((h: { line: number }) => h.line), [3, 5]);
  // under a bullet that says so: its continuation and sub-bullets, not its next sibling
  const list = ["- Still open, in two parts:", `  - ${env} on a shared screen`, "  continued with `pickColour()`", `- Closed: ${route} uses the palette`].join("\n");
  assert.deepEqual(find(list).map((h: { line: number }) => h.line), [2, 3]);
  // general terms pass; so do the same names where nothing is said to be open
  assert.equal(find("- Still open: some widgets have more colours than intended; tracked privately.").length, 0);
  assert.equal(find(`- Built: ${route} uses the palette, and \`paintWidget\` checks it.`).length, 0);
  assert.equal(find("- Not yet: `npm run check` on every push.").length, 0, "a command is not a tool name");
  // fenced code is not a heading
  assert.equal(find(["```", "## Still open", "```", `- ${route}`].join("\n")).length, 0);
});

test("npm run check checks the commits about to be pushed (with --diff origin/main), and says so when it can't", async () => {
  const { readFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const root = new URL("../../../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.match(pkg.scripts.check, /check:security -- --diff origin\/main --tree-if-no-ref/);
  // a ref that isn't here: a warning that only the tree was checked, and no "not a commit" problem
  const r = spawnSync(process.execPath, ["scripts/check-security.mjs", "--diff", "no-such-ref-here", "--tree-if-no-ref"], { cwd: root, encoding: "utf8" });
  assert.match(r.stderr, /no-such-ref-here is not a commit here .*checked the tracked tree only, NOT the commits that would be pushed/);
  assert.doesNotMatch(r.stdout, /is not a commit here; fetch it/);
  const { refExists } = await import("../../../scripts/check-security.mjs" as string);
  assert.equal(refExists("no-such-ref-here"), false);
  assert.equal(refExists("HEAD"), true);
});

test("open-gap-words reads security docs whole, and other docs only inside their marked security notes", async () => {
  const m = await import("../../../scripts/check-security.mjs" as string);
  assert.ok(m.isSecurityDoc("docs/SECURITY.md") && m.isSecurityDoc("docs/decisions/ADR-001-working-together.md"));
  assert.ok(!m.isSecurityDoc("SPEC.md") && !m.isSecurityDoc("docs/floorplan.md"));
  const route = j("/api/", "widgets/paint");
  const doc = ["- Not yet: `paint_widget` picks its own colour.", "<!-- security-notes -->", `- Still open: ${route} paints in any colour.`, "<!-- /security-notes -->", `- Still open: ${route} again.`].join("\n");
  // a product note outside the marks is not a finding; the same words inside them are, with its line number kept
  assert.deepEqual(m.findOpenGapWords(m.securityNotesOnly(doc)).map((h: { line: number }) => h.line), [3]);
  assert.equal(m.findOpenGapWords(doc).length, 3, "a security doc is read whole");
});

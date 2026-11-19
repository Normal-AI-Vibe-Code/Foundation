/**
 * Repo reads stay inside a repository's name (github.ts): `read_repo`, `find_repo` and the GitHub helpers
 * build API paths only from owner/name in GitHub's own characters, a path inside a repo only from checked,
 * encoded segments, and, with FOUNDATION_GITHUB_OWNERS set, only for the owners it names. A stand-in
 * transport records every path that would be asked of GitHub, so "refused before any request" is checked.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-github-"));
process.env.GITHUB_TOKEN = "";
process.env.FOUNDATION_GITHUB_ORG = "";
process.env.FOUNDATION_GITHUB_OWNERS = "";

const gh = await import("../src/github.ts");
const { config } = await import("../src/config.ts");
const { runTool } = await import("../src/tools.ts");
const { upsertUser } = await import("../src/auth.ts");
const { closeBoards } = await import("../src/boards.ts");

after(() => closeBoards());

const asked: string[] = [];
gh.githubTransport.get = async <T>(path: string): Promise<T> => {
  asked.push(path);
  if (path.endsWith("/readme")) return { content: Buffer.from("# Hello").toString("base64"), encoding: "base64" } as T;
  if (path.includes("/commits")) return [{ sha: "abcdef0123", html_url: "https://github.com/x", commit: { message: "first\nmore", author: { name: "Ada", date: "2026-11-18" } } }] as T;
  if (path.startsWith("/user/repos")) {
    return [
      { full_name: "form-industries/foundation", html_url: "", description: "the company brain", homepage: null, default_branch: "main", pushed_at: "", language: "TypeScript", private: true },
      { full_name: "stranger/foundation-clone", html_url: "", description: "foundation", homepage: null, default_branch: "main", pushed_at: "", language: null, private: false },
    ] as T;
  }
  return { full_name: path.split("/").slice(2, 4).join("/"), html_url: "", description: null, homepage: null, default_branch: "main", pushed_at: "", language: null, private: false } as T;
};

const ada = upsertUser("ada@formindustries.com", "Ada");
const ctx = { boardId: "company", actor: "Ada's agent", userId: ada.id };

beforeEach(() => {
  asked.length = 0;
  config.github.owners = [];
});

test("path traversal, query and fragment injection are refused before anything is asked of GitHub", async () => {
  for (const repo of [
    "org/private-repo/contents/.env?x=",
    "org/private-repo/contents/.env#",
    "org/repo?ref=x",
    "org/repo#readme",
    "../../user",
    "org/..",
    "../repo",
    "org/re..po",
    "org/repo/../../other/repo",
    "org/re po",
    "org%2frepo/x",
    ".hidden/repo",
    "org/-repo",
    "",
    "org",
    "https://github.com/../../user",
  ]) {
    await assert.rejects(() => runTool(ctx, "read_repo", { repo }), /isn't a GitHub repository/, `read_repo ${repo}`);
    assert.throws(() => gh.checkRepo(repo), gh.RepoRefused, repo);
    await assert.rejects(() => gh.repoReadme(repo), /isn't a GitHub repository/, `repoReadme ${repo}`);
    await assert.rejects(() => gh.repoInfo(repo), /isn't a GitHub repository/);
    await assert.rejects(() => gh.repoCommits(repo), /isn't a GitHub repository/);
  }
  assert.equal(asked.length, 0, `nothing was asked of GitHub: ${asked.join()}`);
});

test("a normal repository is read, by name or by its address", async () => {
  const out = (await runTool(ctx, "read_repo", { repo: "Form-Industries/foundation.app" })) as { readme: string; commits: Array<{ sha: string }> };
  assert.equal(out.readme, "# Hello");
  assert.equal(out.commits[0].sha, "abcdef0");
  assert.deepEqual(asked.sort(), ["/repos/Form-Industries/foundation.app/commits?per_page=8", "/repos/Form-Industries/foundation.app/readme"]);
  asked.length = 0;
  await runTool(ctx, "read_repo", { repo: "https://github.com/form-industries/foundation.git" });
  assert.ok(asked.includes("/repos/form-industries/foundation/readme"), asked.join());
  asked.length = 0;
  // an address with more after the name is that repository, and only that
  await runTool(ctx, "read_repo", { repo: "https://github.com/form-industries/foundation/blob/main/.env?x=1#y" });
  assert.ok(asked.every((p) => p.startsWith("/repos/form-industries/foundation/")), asked.join());
  asked.length = 0;
  assert.equal(((await runTool(ctx, "find_repo", { app_url_or_name: "form-industries/foundation" })) as { fullName: string }).fullName, "form-industries/foundation");
  assert.deepEqual(asked, ["/repos/form-industries/foundation"]);
});

test("a path inside a repository is checked segment by segment and encoded", () => {
  assert.equal(gh.contentsPath("org/repo", "docs/a b#c?.md"), "/repos/org/repo/contents/docs/a%20b%23c%3F.md");
  for (const file of ["../secret", "docs/../../x", "./a", "a//b", "/abs", "a/", "", "a/./b"]) {
    assert.throws(() => gh.contentsPath("org/repo", file), /isn't a path inside a repository/, file);
  }
  assert.throws(() => gh.contentsPath("org/repo/x", "a"), /isn't a GitHub repository/);
});

test("FOUNDATION_GITHUB_OWNERS: other owners are refused before any request; search keeps to the list", async () => {
  config.github.owners = ["form-industries"];
  await assert.rejects(() => runTool(ctx, "read_repo", { repo: "stranger/thing" }), /reads GitHub repositories of form-industries only \(FOUNDATION_GITHUB_OWNERS\), not stranger's/);
  await assert.rejects(() => runTool(ctx, "find_repo", { app_url_or_name: "https://github.com/stranger/thing" }), /not stranger's/);
  assert.equal(await gh.discoverRepo("https://github.com/stranger/thing"), null);
  assert.equal(asked.length, 0, "nothing was asked about another owner's repository");
  // the owner on the list, in any case
  await runTool(ctx, "read_repo", { repo: "FORM-INDUSTRIES/foundation" });
  assert.ok(asked.includes("/repos/FORM-INDUSTRIES/foundation/readme"));
  // a search answers only the listed owners' repositories
  const found = (await runTool(ctx, "find_repo", { app_url_or_name: "foundation" })) as Array<{ fullName: string }>;
  assert.deepEqual(found.map((r) => r.fullName), ["form-industries/foundation"]);
  // unset: any owner, as before
  config.github.owners = [];
  asked.length = 0;
  await runTool(ctx, "read_repo", { repo: "stranger/thing" });
  assert.ok(asked.includes("/repos/stranger/thing/readme"));
});

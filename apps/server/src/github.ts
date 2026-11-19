/**
 * GitHub: find the repository behind an app, read its README and recent
 * commits, search the org's repos. Uses GITHUB_TOKEN when set, otherwise the
 * `gh` CLI's login on this machine (local dev), otherwise unauthenticated
 * public API (60 req/h).
 */

import { childOptions, execFileText, type ExecFileOptions } from "./child.ts";
import { config } from "./config.ts";
import { guardEgress } from "./egressguard.ts";

/**
 * What `gh` gets beyond the allowlist (child.ts): its own credential and settings, and nothing else of
 * the server's. gh reads a token from GH_TOKEN or GITHUB_TOKEN (GH_ENTERPRISE_TOKEN for an Enterprise
 * host, GH_HOST to pick the host), else its login under GH_CONFIG_DIR (default: the home folder, in BASE).
 * Only gh's callers name these: github.ts here, and the plan sync (plan.ts, scripts/plan.mjs runs gh).
 */
export const GH_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN"] as const;

const exec = (cmd: string, args: string[], opts: Omit<ExecFileOptions, "env">) => execFileText(cmd, args, childOptions<ExecFileOptions>({ extras: GH_ENV }, opts));

let ghCliOk: boolean | null = null;

async function api<T>(path: string): Promise<T> {
  if (config.github.token) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${config.github.token}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return (await res.json()) as T;
  }
  if (ghCliOk !== false) {
    try {
      const { stdout } = await exec("gh", ["api", path.replace(/^\//, "")], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
      ghCliOk = true;
      return JSON.parse(stdout) as T;
    } catch (e) {
      if (ghCliOk === null) ghCliOk = false;
      else throw e;
    }
  }
  const res = await fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export interface RepoInfo {
  fullName: string;
  url: string;
  description: string | null;
  homepage: string | null;
  defaultBranch: string;
  pushedAt: string;
  language: string | null;
  private: boolean;
}

interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  homepage: string | null;
  default_branch: string;
  pushed_at: string;
  language: string | null;
  private: boolean;
}

const toInfo = (r: GhRepo): RepoInfo => ({
  fullName: r.full_name,
  url: r.html_url,
  description: r.description,
  homepage: r.homepage,
  defaultBranch: r.default_branch,
  pushedAt: r.pushed_at,
  language: r.language,
  private: r.private,
});

/** how an API path is fetched: tests put a stand-in here, to see exactly what would be asked of GitHub */
export const githubTransport: { get: <T>(path: string) => Promise<T> } = { get: (path) => api(path) };

/** every request to GitHub: an agent's call reaches it only where a person allowed it (egress.ts), before the transport */
async function ghGet<T>(path: string): Promise<T> {
  guardEgress("GitHub");
  return githubTransport.get<T>(path);
}

// ---------- what a repository name may be ----------
//
// Every API path is built from a repository's owner and name. Unchecked, a "repo" like
// `org/private/contents/.env?x=` turns a README read into a read of any file the token can see. So a repo is
// exactly owner/name in GitHub's own characters, nothing more; a path inside one is split into checked,
// encoded segments; and FOUNDATION_GITHUB_OWNERS, when set, names the only owners Foundation reads.

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** a refusal in plain words, before anything is asked of GitHub */
export class RepoRefused extends Error {}

/** owner/name exactly as GitHub spells a repository, or null */
function cleanRepo(s: string): string | null {
  const r = s.trim().replace(/\.git$/, "");
  return REPO.test(r) && !r.includes("..") ? r : null;
}

/** a repository named by owner/name or its github.com address, or null when it isn't one */
export function parseRepo(input: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(input);
  return cleanRepo(m ? `${m[1]}/${m[2]}` : input);
}

/** the owners Foundation reads (FOUNDATION_GITHUB_OWNERS), or null for any */
const ownersAllowed = () => (config.github.owners.length ? config.github.owners : null);

/** may Foundation read this owner's repositories (FOUNDATION_GITHUB_OWNERS; unset: any) */
export function ownerAllowed(owner: string): boolean {
  const list = ownersAllowed();
  return !list || list.includes(owner.toLowerCase());
}

/** the repository as owner/name, or a plain refusal: not a repository's name, or an owner not on the list */
export function checkRepo(input: string): string {
  const repo = parseRepo(input);
  if (!repo) throw new RepoRefused(`“${input.slice(0, 120)}” isn't a GitHub repository: write owner/name (letters, digits, . _ -) or its github.com address.`);
  const owner = repo.split("/")[0];
  if (!ownerAllowed(owner)) throw new RepoRefused(`Foundation reads GitHub repositories of ${ownersAllowed()!.join(", ")} only (FOUNDATION_GITHUB_OWNERS), not ${owner}'s.`);
  return repo;
}

/** /repos/owner/name, each part encoded */
function repoBase(input: string): string {
  const [owner, name] = checkRepo(input).split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** the API path of a file inside a repository: each segment checked (no empty, . or ..) and encoded */
export function contentsPath(repo: string, file: string): string {
  const parts = file.split("/");
  if (!file || parts.some((p) => p === "" || p === "." || p === "..")) throw new RepoRefused(`“${file.slice(0, 120)}” isn't a path inside a repository: name a file like docs/readme.md, without empty parts, . or ..`);
  return `${repoBase(repo)}/contents/${parts.map(encodeURIComponent).join("/")}`;
}

export async function repoInfo(repo: string): Promise<RepoInfo> {
  return toInfo(await ghGet<GhRepo>(repoBase(repo)));
}

export async function repoReadme(repo: string): Promise<string> {
  const r = await ghGet<{ content: string; encoding: string }>(`${repoBase(repo)}/readme`);
  return Buffer.from(r.content, r.encoding as BufferEncoding).toString("utf8");
}

export async function repoCommits(repo: string, n = 8) {
  const rows = await ghGet<Array<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }>>(
    `${repoBase(repo)}/commits?per_page=${Math.max(1, Math.min(100, Math.floor(n) || 8))}`,
  );
  return rows.map((c) => ({ sha: c.sha.slice(0, 7), url: c.html_url, message: c.commit.message.split("\n")[0], author: c.commit.author.name, date: c.commit.author.date }));
}

/**
 * The company's repos that match a query. With GITHUB_ORG set, GitHub's search
 * inside that org; otherwise the repos this login can see (its own, its
 * orgs', where it collaborates), matched here. Never all of GitHub: a search
 * for "supply" should find our supply-chain repo, not strangers'.
 */
export async function searchRepos(q: string, limit = 8): Promise<RepoInfo[]> {
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 8));
  // only the owners Foundation reads (FOUNDATION_GITHUB_OWNERS), whatever GitHub answers
  const ours = (r: RepoInfo) => ownerAllowed(r.fullName.split("/")[0] ?? "");
  if (config.github.org) {
    const r = await ghGet<{ items: GhRepo[] }>(`/search/repositories?q=${encodeURIComponent(q)}+org:${encodeURIComponent(config.github.org)}&per_page=${n}`);
    return r.items.map(toInfo).filter(ours);
  }
  return matchRepos(await myRepos(), q).filter(ours).slice(0, n);
}

let mine: { at: number; repos: RepoInfo[] } | null = null;
const MINE_TTL = 5 * 60_000;

/** The repos this login can see, newest push first (cached five minutes). Empty without a login. */
async function myRepos(): Promise<RepoInfo[]> {
  if (mine && Date.now() - mine.at < MINE_TTL) return mine.repos;
  const repos: RepoInfo[] = [];
  for (let page = 1; page <= 3; page++) {
    const rows = await ghGet<GhRepo[]>(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`).catch(() => [] as GhRepo[]);
    repos.push(...rows.map(toInfo));
    if (rows.length < 100) break;
  }
  mine = { at: Date.now(), repos };
  return repos;
}

/** Every word of the query in the repo's name or description; name hits first. */
export function matchRepos(repos: RepoInfo[], q: string): RepoInfo[] {
  const words = q.toLowerCase().split(/[\s/_-]+/).filter(Boolean);
  if (!words.length) return [];
  const hay = (r: RepoInfo) => `${r.fullName} ${r.description ?? ""}`.toLowerCase();
  const hits = repos.filter((r) => words.every((w) => hay(r).includes(w)));
  const inName = (r: RepoInfo) => words.every((w) => r.fullName.toLowerCase().includes(w));
  return [...hits.filter(inName), ...hits.filter((r) => !inName(r))];
}

/**
 * Find the repo behind a running app: an explicit GitHub URL wins; then a
 * repo whose homepage matches the app's host; then a name search on the
 * host's first label (vercel/netlify/pages deployments are usually named
 * after the repo).
 */
export async function discoverRepo(appUrl: string): Promise<RepoInfo | null> {
  const direct = parseRepo(appUrl);
  if (direct) return ownerAllowed(direct.split("/")[0]) ? repoInfo(direct).catch(() => null) : null;
  let host: string;
  try {
    host = new URL(appUrl).hostname;
  } catch {
    return null;
  }
  const label = host.split(".")[0].replace(/-(git-[\w-]+|[a-z0-9]{9})$/, "");
  if (!label || label === "localhost" || /^\d+$/.test(label)) return null;
  const candidates = await searchRepos(label, 10).catch(() => []);
  const byHome = candidates.find((c) => c.homepage && c.homepage.includes(host));
  if (byHome) return byHome;
  const byName = candidates.find((c) => c.fullName.split("/")[1].toLowerCase() === label.toLowerCase());
  return byName ?? null;
}

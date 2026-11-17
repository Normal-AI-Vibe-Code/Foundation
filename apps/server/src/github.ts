/**
 * GitHub: find the repository behind an app, read its README and recent
 * commits, search the org's repos. Uses GITHUB_TOKEN when set, otherwise the
 * `gh` CLI's login on this machine (local dev), otherwise unauthenticated
 * public API (60 req/h).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";

const exec = promisify(execFile);

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

export function parseRepo(input: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(input) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(input.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function repoInfo(repo: string): Promise<RepoInfo> {
  return toInfo(await api<GhRepo>(`/repos/${repo}`));
}

export async function repoReadme(repo: string): Promise<string> {
  const r = await api<{ content: string; encoding: string }>(`/repos/${repo}/readme`);
  return Buffer.from(r.content, r.encoding as BufferEncoding).toString("utf8");
}

export async function repoCommits(repo: string, n = 8) {
  const rows = await api<Array<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }>>(
    `/repos/${repo}/commits?per_page=${n}`,
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
  if (config.github.org) {
    const r = await api<{ items: GhRepo[] }>(`/search/repositories?q=${encodeURIComponent(q)}+org:${config.github.org}&per_page=${limit}`);
    return r.items.map(toInfo);
  }
  return matchRepos(await myRepos(), q).slice(0, limit);
}

let mine: { at: number; repos: RepoInfo[] } | null = null;
const MINE_TTL = 5 * 60_000;

/** The repos this login can see, newest push first (cached five minutes). Empty without a login. */
async function myRepos(): Promise<RepoInfo[]> {
  if (mine && Date.now() - mine.at < MINE_TTL) return mine.repos;
  const repos: RepoInfo[] = [];
  for (let page = 1; page <= 3; page++) {
    const rows = await api<GhRepo[]>(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`).catch(() => [] as GhRepo[]);
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
  if (direct) return repoInfo(direct).catch(() => null);
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

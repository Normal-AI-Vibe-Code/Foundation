/**
 * Docker Hub, for a machine card's image picker (2026-11-17, Josh: "The Loading and choosing VM image can be
 * better and I would like to integrate with docker hub if possible"). Docker Hub's public search and tags
 * (no account, no key) are asked from here, not the page, so the browser needn't reach hub.docker.com and
 * the answers are cached for a minute. Only the search words go out. Pulling is still the engine's own
 * (machines.ts `pull`), from whatever registry the name says.
 */

import { HttpError } from "./http.ts";

export interface HubRepo {
  /** what Start takes: "postgres" for an official image, "grafana/grafana" otherwise */
  name: string;
  description: string;
  stars: number;
  pulls: number;
  official: boolean;
}

export interface HubTag {
  name: string;
  /** bytes, the largest of its platforms */
  size: number;
  updated?: string;
}

const HUB = process.env.FOUNDATION_DOCKER_HUB ?? "https://hub.docker.com";
const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 60_000;

async function hubJson<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(`${HUB}${path}`, { signal: ctl.signal, headers: { accept: "application/json", "user-agent": "Foundation (machine image picker)" } });
  } catch (e) {
    throw new HttpError(502, `Docker Hub didn't answer (${(e as Error).name === "AbortError" ? "8 s passed" : (e as Error).message}). Is this computer online?`);
  } finally {
    clearTimeout(t);
  }
  if (res.status === 404) throw new HttpError(404, "Docker Hub has no such repository.");
  if (res.status === 429) throw new HttpError(429, "Docker Hub says too many searches from here for now: try again in a minute.");
  if (!res.ok) throw new HttpError(502, `Docker Hub answered ${res.status}.`);
  const value = (await res.json()) as T;
  cache.set(path, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}

interface RawRepo {
  repo_name?: string;
  short_description?: string;
  star_count?: number;
  pull_count?: number;
  is_official?: boolean;
}

/** a search result as Start wants it (an official image by its short name, "library/" left off) */
export function hubRepo(r: RawRepo): HubRepo {
  const name = (r.repo_name ?? "").replace(/^library\//, "");
  return { name, description: (r.short_description ?? "").trim(), stars: r.star_count ?? 0, pulls: r.pull_count ?? 0, official: Boolean(r.is_official) || !name.includes("/") };
}

export async function hubSearch(q: string): Promise<HubRepo[]> {
  const words = q.trim().slice(0, 80);
  if (!words) return [];
  const r = await hubJson<{ results?: RawRepo[] }>(`/v2/search/repositories/?query=${encodeURIComponent(words)}&page_size=12`);
  // an official image first (the one a person usually means), then as Docker Hub ranked them
  return (r.results ?? []).map(hubRepo).filter((x) => x.name).sort((a, b) => Number(b.official) - Number(a.official));
}

/** "postgres" → library/postgres; "grafana/grafana" as it is; anything with a registry host isn't Docker Hub's */
export function hubPath(repo: string): string | null {
  const r = repo.trim().toLowerCase();
  if (!/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)?$/.test(r)) return null;
  return r.includes("/") ? r : `library/${r}`;
}

export async function hubTags(repo: string): Promise<HubTag[]> {
  const path = hubPath(repo);
  if (!path) throw new HttpError(400, `“${repo}” isn't a Docker Hub repository name.`);
  const r = await hubJson<{ results?: Array<{ name?: string; full_size?: number; last_updated?: string; images?: Array<{ size?: number }> }> }>(`/v2/repositories/${path}/tags?page_size=16&ordering=last_updated`);
  return (r.results ?? [])
    .filter((t) => t.name)
    .map((t) => ({ name: t.name!, size: Math.max(t.full_size ?? 0, ...(t.images ?? []).map((i) => i.size ?? 0)), updated: t.last_updated }))
    // latest first, then the newest
    .sort((a, b) => Number(b.name === "latest") - Number(a.name === "latest"));
}

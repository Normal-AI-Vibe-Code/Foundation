/**
 * The app registry: every vibe-coded app, dashboard, tool and machine the
 * company runs, so anyone (or any agent) can drop it on a board, find its
 * repo, and wire it to others. Probing an app reads its manifest when it has
 * one (`/.well-known/foundation.json`: name, ports, mcp) and otherwise its
 * page title; the GitHub repo is discovered from the URL.
 */

import { randomBytes } from "node:crypto";
import type { Port } from "@foundation/protocol";
import { all, one, run } from "./db.ts";
import { discoverRepo } from "./github.ts";

export interface AppRow {
  id: string;
  name: string;
  url: string | null;
  repo: string | null;
  mcp: string | null;
  description: string | null;
  ports_json: string;
  created_by: string | null;
  created_at: number;
}

export interface Manifest {
  name?: string;
  description?: string;
  mcp?: string;
  repo?: string;
  ports?: Array<Omit<Port, "id">>;
}

export function listApps() {
  return all<AppRow>("select * from apps order by created_at desc").map((a) => ({ ...a, ports: JSON.parse(a.ports_json) as Port[] }));
}

export function saveApp(a: { name: string; url?: string; repo?: string; mcp?: string; description?: string; ports?: Array<Omit<Port, "id">> }, by: string) {
  const existing = a.url ? one<AppRow>("select * from apps where url = ?", a.url) : undefined;
  const id = existing?.id ?? `app_${randomBytes(5).toString("hex")}`;
  if (existing) {
    run(
      "update apps set name = ?, repo = coalesce(?, repo), mcp = coalesce(?, mcp), description = coalesce(?, description), ports_json = ? where id = ?",
      a.name, a.repo ?? null, a.mcp ?? null, a.description ?? null, JSON.stringify(a.ports ?? JSON.parse(existing.ports_json)), id,
    );
  } else {
    run(
      "insert into apps (id, name, url, repo, mcp, description, ports_json, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, a.name, a.url ?? null, a.repo ?? null, a.mcp ?? null, a.description ?? null, JSON.stringify(a.ports ?? []), by, Date.now(),
    );
  }
  return one<AppRow>("select * from apps where id = ?", id)!;
}

/** Look at a URL: manifest, title, frame policy, repo. Fast, bounded, never throws. */
export async function probeApp(url: string) {
  const out: { url: string; name?: string; description?: string; repo?: string; mcp?: string; ports?: Manifest["ports"]; embeddable: boolean; reason?: string } = { url, embeddable: true };
  const timed = (p: Promise<Response>) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 4000))]);
  try {
    const res = await timed(fetch(url, { redirect: "follow" }));
    const xfo = res.headers.get("x-frame-options");
    const csp = res.headers.get("content-security-policy") ?? "";
    if (xfo && /deny|sameorigin/i.test(xfo)) {
      out.embeddable = false;
      out.reason = `the site forbids framing (X-Frame-Options: ${xfo})`;
    } else if (/frame-ancestors\s+('none'|'self')/i.test(csp)) {
      out.embeddable = false;
      out.reason = "the site forbids framing (CSP frame-ancestors)";
    }
    const html = (await res.text()).slice(0, 200_000);
    out.name = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim();
    out.description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})/i.exec(html)?.[1];
  } catch (e) {
    out.reason = `couldn't reach it: ${(e as Error).message}`;
  }
  try {
    const m = await timed(fetch(new URL("/.well-known/foundation.json", url)));
    if (m.ok) {
      const man = (await m.json()) as Manifest;
      Object.assign(out, { name: man.name ?? out.name, description: man.description ?? out.description, mcp: man.mcp, repo: man.repo, ports: man.ports });
    }
  } catch {
    /* no manifest */
  }
  if (!out.repo) {
    const repo = await discoverRepo(url).catch(() => null);
    if (repo) out.repo = repo.fullName;
  }
  return out;
}

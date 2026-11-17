/**
 * Vision Code (T3) sessions, read where T3 keeps them: its own projection
 * store (`<T3CODE_HOME>/userdata/state.sqlite`), opened read-only. No token,
 * no pairing, nothing written — Foundation lists the threads in the side pane
 * and replays one in a session tab; continuing a thread happens in Vision
 * Code itself (the tab links there).
 *
 * T3's tables are its own projection, not an API, so every read is defensive:
 * a missing store or a changed column answers "unavailable", never a crash.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findT3Home, notFoundMessage, t3Url } from "./t3paths.ts";

/** where T3's store is, looked up when used: T3CODE_HOME, or Vision's home on this platform */
let db: { path: string; db: DatabaseSync } | null = null;
let missing: string | null = null;
function open(): DatabaseSync | null {
  const home = findT3Home();
  const path = home.found ? join(home.found, "userdata", "state.sqlite") : null;
  if (db && db.path === path) return db.db;
  db?.db.close();
  db = null;
  if (!path || !existsSync(path)) {
    missing = process.env.T3CODE_HOME
      ? `T3CODE_HOME is ${process.env.T3CODE_HOME}, but there's no userdata/state.sqlite in it. Point it at Vision Code's data folder, or unset it to look in the usual places.`
      : notFoundMessage(null, { found: null, tried: home.tried });
    return null;
  }
  try {
    db = { path, db: new DatabaseSync(path, { readOnly: true }) };
    missing = null;
    return db.db;
  } catch (e) {
    missing = `Vision Code's threads are at ${path}, but they couldn't be read: ${(e as Error).message}`;
    return null;
  }
}

let envId: { base: string; id: string | null; at: number } = { base: "", id: null, at: 0 };
/** T3's environment id at this address, for links into Vision Code (cached a minute per address) */
async function environmentId(base: string): Promise<string | null> {
  if (envId.base === base && Date.now() - envId.at < 60_000) return envId.id;
  try {
    const r = await fetch(`${base}/.well-known/t3/environment`, { signal: AbortSignal.timeout(1200) });
    const j = (await r.json()) as { environmentId?: string };
    envId = { base, id: j.environmentId ?? null, at: Date.now() };
  } catch {
    envId = { base, id: null, at: Date.now() };
  }
  return envId.id;
}

export interface T3Thread {
  id: string;
  title: string;
  project: string;
  status: "running" | "waiting" | "idle" | "error";
  pending: number;
  updatedAt: number;
  url: string | null;
}

function statusOf(session: string | null, pending: number, error: string | null): T3Thread["status"] {
  if (pending > 0) return "waiting";
  if (error) return "error";
  if (session === "running" || session === "starting") return "running";
  return "idle";
}

/** `missing` says, when they can't be read, where Foundation looked and what to set */
export async function t3Threads(limit = 24): Promise<{ available: boolean; threads: T3Thread[]; missing?: string }> {
  const d = open();
  if (!d) return { available: false, threads: [], missing: missing ?? undefined };
  const base = t3Url();
  const env = await environmentId(base);
  try {
    const rows = d
      .prepare(
        `select t.thread_id, t.title, p.title as project, t.updated_at, t.pending_approval_count + t.pending_user_input_count as pending,
                s.status, s.last_error
           from projection_threads t
           join projection_projects p on p.project_id = t.project_id
           left join projection_thread_sessions s on s.thread_id = t.thread_id
          where t.deleted_at is null and t.archived_at is null
          order by coalesce(t.latest_user_message_at, t.updated_at) desc
          limit ?`,
      )
      .all(limit) as Array<{ thread_id: string; title: string; project: string; updated_at: string; pending: number; status: string | null; last_error: string | null }>;
    return {
      available: true,
      threads: rows.map((r) => ({
        id: r.thread_id,
        title: r.title,
        project: r.project,
        status: statusOf(r.status, r.pending, r.last_error),
        pending: r.pending,
        updatedAt: Date.parse(r.updated_at) || 0,
        url: env ? `${base}/${env}/${r.thread_id}` : null,
      })),
    };
  } catch (e) {
    return { available: false, threads: [], missing: `Vision Code's threads couldn't be read (its store may have changed): ${(e as Error).message}` };
  }
}

export interface T3Item {
  kind: "user" | "assistant" | "reasoning" | "tool" | "error";
  text: string;
  at: number;
  ok?: boolean;
}

/** one thread as a conversation: messages, tool steps and the latest proposed plan */
export async function t3Thread(id: string): Promise<{ thread: T3Thread; items: T3Item[]; plan: string | null } | null> {
  const d = open();
  if (!d) return null;
  const head = (await t3Threads(500)).threads.find((t) => t.id === id);
  if (!head) return null;
  const items: T3Item[] = [];
  for (const m of d
    .prepare("select role, text, created_at from projection_thread_messages where thread_id = ? order by created_at asc limit 400")
    .all(id) as Array<{ role: string; text: string; created_at: string }>) {
    const text = m.text.trim();
    if (!text) continue;
    const kind = m.role === "user" ? "user" : m.role === "reasoning" ? "reasoning" : "assistant";
    items.push({ kind, text, at: Date.parse(m.created_at) || 0 });
  }
  // tool steps: one per call, its last state wins
  const tools = new Map<string, T3Item>();
  for (const a of d
    .prepare("select kind, summary, payload_json, created_at from projection_thread_activities where thread_id = ? order by created_at asc limit 1000")
    .all(id) as Array<{ kind: string; summary: string; payload_json: string; created_at: string }>) {
    let p: { toolCallId?: string; detail?: string; status?: string; message?: string } = {};
    try {
      p = JSON.parse(a.payload_json);
    } catch { /* keep the summary */ }
    const at = Date.parse(a.created_at) || 0;
    if (a.kind.startsWith("tool.") && p.toolCallId) {
      const prev = tools.get(p.toolCallId);
      const text = (p.detail ?? a.summary).slice(0, 160);
      const ok = p.status === "failed" ? false : p.status === "completed" ? true : undefined;
      if (prev) Object.assign(prev, { text, ok });
      else {
        const it: T3Item = { kind: "tool", text, at, ok };
        tools.set(p.toolCallId, it);
        items.push(it);
      }
    } else if (a.kind === "runtime.error") items.push({ kind: "error", text: p.message ?? a.summary, at });
  }
  items.sort((x, y) => x.at - y.at);
  const plan = (d.prepare("select plan_markdown from projection_thread_proposed_plans where thread_id = ? order by updated_at desc limit 1").get(id) as { plan_markdown?: string } | undefined)?.plan_markdown ?? null;
  return { thread: head, items, plan };
}

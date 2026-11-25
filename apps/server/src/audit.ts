/**
 * The audit log: one append-only table saying who did what, for whom,
 * through which door, where the thing acted on runs, what was decided and
 * who approved it (ADR-001 §9 "Audit"; SECURITY.md rule 8).
 *
 * What a row never holds: argument values, results, message text, file
 * contents, tokens, and no email beyond the actor's own id and name. An
 * argument is kept as the sha256 of its canonical JSON and its size, so two
 * calls with the same arguments can be matched without either being readable.
 * `target` is a short identifier (a card id, an app's name, a service), never
 * content.
 *
 * Append-only in the database itself: triggers abort any UPDATE or DELETE on
 * the table, and nothing in the server does either. Each row carries the hash
 * of the row before it and a hash over its own fields, so an edit made with
 * the triggers dropped shows when the chain is walked (verifyAudit). A chain
 * kept by the process that writes it shows later edits only to someone who
 * holds a recent head; handing the head to peers is for a later slice.
 *
 * Recording is one line at each point (`audit({...})`), so it is hard to forget.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { all, db, one } from "./db.ts";

export type ActorKind = "person" | "agent" | "app" | "service";
export type Door = "http" | "mcp" | "agent-run" | "socket" | "route";
export type Provenance = "ours-local" | "ours-cloud" | "external";
export type Decision = "allowed" | "asked" | "refused";

export interface AuditInput {
  actor_kind: ActorKind;
  actor_id?: string | null;
  actor_name?: string | null;
  for_person?: string | null;
  board_id?: string | null;
  door: Door;
  action: string;
  target?: string | null;
  provenance?: Provenance | null;
  service?: string | null;
  decision: Decision;
  reason?: string | null;
  approved_by?: string | null;
  result?: "ok" | "error" | null;
  /** the arguments: hashed and measured here, never stored */
  args?: unknown;
}

export interface AuditRow {
  id: number;
  at: number;
  actor_kind: ActorKind;
  actor_id: string | null;
  actor_name: string | null;
  for_person: string | null;
  board_id: string | null;
  door: Door;
  action: string;
  target: string | null;
  provenance: Provenance | null;
  service: string | null;
  decision: Decision;
  reason: string | null;
  approved_by: string | null;
  result: "ok" | "error" | null;
  args_hash: string | null;
  args_bytes: number | null;
  prev_hash: string;
  hash: string;
}

/** the table and the two triggers that keep it append-only; idempotent */
export function ensureAuditSchema() {
  db.exec(`
create table if not exists audit_log (
  id integer primary key autoincrement,
  at integer not null,
  actor_kind text not null check (actor_kind in ('person', 'agent', 'app', 'service')),
  actor_id text,
  actor_name text,
  for_person text,
  board_id text,
  door text not null check (door in ('http', 'mcp', 'agent-run', 'socket', 'route')),
  action text not null,
  target text,
  provenance text check (provenance is null or provenance in ('ours-local', 'ours-cloud', 'external')),
  service text,
  decision text not null check (decision in ('allowed', 'asked', 'refused')),
  reason text,
  approved_by text,
  result text check (result is null or result in ('ok', 'error')),
  args_hash text,
  args_bytes integer,
  prev_hash text not null,
  hash text not null
);
create index if not exists audit_log_board on audit_log(board_id, id);
create trigger if not exists audit_log_no_update before update on audit_log
  begin select raise(abort, 'the audit log is append-only'); end;
create trigger if not exists audit_log_no_delete before delete on audit_log
  begin select raise(abort, 'the audit log is append-only'); end;
`);
}
ensureAuditSchema();

/** JSON with object keys sorted, so the same value always hashes the same */
export function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null) ?? "null";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** the fields a row's hash covers, in a fixed order (everything but `hash`) */
const HASHED = ["id", "at", "actor_kind", "actor_id", "actor_name", "for_person", "board_id", "door", "action", "target", "provenance", "service", "decision", "reason", "approved_by", "result", "args_hash", "args_bytes", "prev_hash"] as const;
const rowHash = (r: Omit<AuditRow, "hash">) => sha(canonical(HASHED.map((k) => r[k] ?? null)));

const GENESIS = "0".repeat(64);
/** a short field: one line, bounded */
const short = (s: string | null | undefined, n: number) => (s == null || s === "" ? null : String(s).replace(/\s+/g, " ").trim().slice(0, n) || null);

/**
 * Append one row. Never throws into its caller: a failure to record is said
 * on the console (the action it describes has its own outcome).
 */
export function audit(a: AuditInput): number | null {
  try {
    const argsText = a.args === undefined ? null : canonical(a.args);
    const last = one<{ id: number; hash: string }>("select id, hash from audit_log order by id desc limit 1");
    const row: Omit<AuditRow, "hash"> = {
      id: (last?.id ?? 0) + 1,
      at: Date.now(),
      actor_kind: a.actor_kind,
      actor_id: short(a.actor_id, 120),
      actor_name: short(a.actor_name, 120),
      for_person: short(a.for_person, 120),
      board_id: short(a.board_id, 120),
      door: a.door,
      action: short(a.action, 120) ?? "?",
      target: short(a.target, 160),
      provenance: a.provenance ?? null,
      service: short(a.service, 120),
      decision: a.decision,
      reason: short(a.reason, 200),
      approved_by: short(a.approved_by, 200),
      result: a.result ?? null,
      args_hash: argsText === null ? null : sha(argsText),
      args_bytes: argsText === null ? null : Buffer.byteLength(argsText),
      prev_hash: last?.hash ?? GENESIS,
    };
    const hash = rowHash(row);
    db.prepare(
      `insert into audit_log (id, at, actor_kind, actor_id, actor_name, for_person, board_id, door, action, target, provenance, service, decision, reason, approved_by, result, args_hash, args_bytes, prev_hash, hash)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...(HASHED.map((k) => row[k] ?? null) as never[]), hash);
    return row.id;
  } catch (e) {
    console.error(`audit: couldn't record ${a.action}: ${(e as Error).message}`);
    return null;
  }
}

/** rows, oldest first: those after `after` (an id), for one board when given */
export function readAudit(opts: { board?: string | null; after?: number; limit?: number } = {}): AuditRow[] {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100) || 100));
  const after = Math.max(0, Math.floor(opts.after ?? 0) || 0);
  return opts.board
    ? all<AuditRow>("select * from audit_log where id > ? and board_id = ? order by id limit ?", after, opts.board, limit)
    : all<AuditRow>("select * from audit_log where id > ? order by id limit ?", after, limit);
}

/** walk the whole chain: the first row whose hash or link doesn't hold, or ok */
export function verifyAudit(): { ok: true; rows: number; head: string } | { ok: false; rows: number; brokenAt: number; reason: string } {
  let prev = GENESIS;
  let n = 0;
  let expectId = 1;
  for (const r of db.prepare("select * from audit_log order by id").iterate() as Iterable<AuditRow>) {
    n++;
    if (r.id !== expectId) return { ok: false, rows: n, brokenAt: r.id, reason: `a row is missing before ${r.id}` };
    if (r.prev_hash !== prev) return { ok: false, rows: n, brokenAt: r.id, reason: "its link to the row before doesn't match" };
    const { hash, ...rest } = r;
    if (rowHash(rest) !== hash) return { ok: false, rows: n, brokenAt: r.id, reason: "its fields don't match its hash" };
    prev = hash;
    expectId++;
  }
  return { ok: true, rows: n, head: prev };
}

// ---------- the call being recorded ----------
//
// A tool call (runTool) or a gated route runs inside a scope that says what was
// decided for it: whether it is gated (an agent, not a person acting directly),
// which outside services it may reach, and who approved it. Code deep inside
// (an app's press, the network seams in egress.ts) reads and adds to it, so a
// tool's own body needs no change to be recorded or held.

export interface CallScope {
  /** an agent's call (not a person acting directly): outside services are held unless allowed */
  gated: boolean;
  /** outside services this call may reach */
  allowed: Set<string>;
  /** who approved what this call sends (a standing leave or a press) */
  approvedBy: Set<string>;
  /** a press was asked for, and nothing was sent */
  asked?: string;
  /** services held at the network seam during the call */
  held: Set<string>;
  /** set for a gated route (not a tool call): the seam records its own `asked` row */
  route?: { action: string; board: string | null; actor: { kind: ActorKind; id: string; name: string; for?: string | null } };
}

export const callScope = new AsyncLocalStorage<CallScope>();

/** the person who approved what the current call sends (an app tool's press, a standing leave) */
export function noteApproval(personId: string | null | undefined) {
  const s = callScope.getStore();
  if (s && personId) s.approvedBy.add(personId);
}

/** the current call asked a person for a press and sent nothing */
export function noteAsked(why: string) {
  const s = callScope.getStore();
  if (s) s.asked = why;
}

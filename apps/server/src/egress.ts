/**
 * Sending outside is explicit (SECURITY.md rule 8; ADR-001 §9, the outgoing
 * gate).
 *
 * Every board tool says what it sends and where (`sends` on its definition in
 * tools.ts): the service, the kind of thing sent, and where that service runs
 * (ours, on this computer; ours, in our cloud; or an external service).
 *
 * An agent's call that would send to an external service runs only if a
 * person has allowed that kind of send to that service from that board, and
 * the allowance is still there. Otherwise nothing is sent: the agent is told,
 * in a sentence, that a person has to allow it, and an `asked` row goes in the
 * audit log. A person calling a tool directly from their own browser or app
 * is the approval, and is recorded as such.
 *
 * Allowances are per (board, service, kind), set and taken back by a person
 * who can edit the board (on a members-only board, its owner or an admin),
 * from their own browser or app. Every board starts with nothing allowed.
 *
 * Two tools keep their own gate and need nothing here: an app's tools (each
 * needs a person's press, apptools.ts) and calling in a helper (model spend,
 * only from a crew run a person started, at most two per ask).
 *
 * The network seams (Slack, GitHub and Flowform clients) call `guardEgress`
 * before anything leaves, so a call that was let through for one service can't
 * reach another: a search allowed to query Slack doesn't query GitHub.
 *
 * Private things are refused, not filtered (`contentRefusal`): a send that
 * names or includes something from a members-only board the acting person
 * can't see, or, for a message, from a members-only board other than the one
 * the call names, is refused whole. It is never sent with that part removed.
 */

import type { UserInfo } from "@foundation/protocol";
import { audit, type ActorKind, type CallScope, type Provenance } from "./audit.ts";
import { config } from "./config.ts";
import { all, db, one, run } from "./db.ts";
import { EgressHeld, guardEgress, heldSentence, listWords, type SendKind } from "./egressguard.ts";
import { HttpError } from "./http.ts";
import { boardIsRestricted, boardRole as memberRole, canSeeBoard } from "./members.ts";
import { canWrite } from "./roles.ts";

export { EgressHeld, guardEgress, heldSentence };
export type { Provenance, SendKind };

/** what a tool sends, and where (tools.ts `sends`) */
export interface Send {
  service: string;
  kind: SendKind;
  provenance: Provenance;
  /** only some calls send this (e.g. lay_out reaches Slack only for a Slack image): a test of the call's input */
  when?: (input: Record<string, unknown>, boardId: string) => boolean;
  /** the tool still does its own part without this service (search answers from the board); a held service is skipped, not the call */
  partial?: boolean;
  /** this send has a gate of its own that a person keeps (said in words); the allowances here don't apply to it */
  ownGate?: string;
}

db.exec(`
create table if not exists egress_allowances (
  board_id text not null,
  service text not null,
  kind text not null,
  allowed_by text not null,
  allowed_by_name text not null,
  allowed_at integer not null,
  primary key (board_id, service, kind)
);
`);

// ---------- the services a person can allow ----------

/** the external services the board tools send to, the kinds each takes, and what each kind sends, in words */
export const SERVICES: Array<{ service: string; configured: () => boolean; kinds: Partial<Record<SendKind, string>> }> = [
  {
    service: "Slack",
    configured: () => Boolean(config.slack.token || process.env.SLACK_BOT_TOKEN),
    kinds: {
      query: "Search words, to find messages and pictures in Slack",
      read: "Which channel or file to read, to read its messages or copy a picture in",
      message: "A message an agent writes, sent to a teammate as a direct message",
    },
  },
  {
    service: "GitHub",
    configured: () => true,
    kinds: {
      query: "Search words, to find the company's repositories",
      read: "Which repository to read, to read its README and recent commits",
    },
  },
  {
    service: "Flowform",
    configured: () => Boolean(config.flowformUrl),
    kinds: {
      query: "Search words, to find files in your Flowform",
      read: "Requests to Flowform's own tools, to read your Flowform boards and files as you",
    },
  },
];

export function serviceKind(service: string, kind: string): { service: string; kind: SendKind } | null {
  const s = SERVICES.find((x) => x.service.toLowerCase() === service.toLowerCase());
  if (!s || !(kind in s.kinds)) return null;
  return { service: s.service, kind: kind as SendKind };
}

// ---------- allowances ----------

export interface Allowance {
  board_id: string;
  service: string;
  kind: SendKind;
  allowed_by: string;
  allowed_by_name: string;
  allowed_at: number;
}

export function allowanceFor(boardId: string, service: string, kind: SendKind): Allowance | undefined {
  return one<Allowance>("select * from egress_allowances where board_id = ? and service = ? and kind = ?", boardId, service, kind);
}

export function allowancesOn(boardId: string): Allowance[] {
  return all<Allowance>("select * from egress_allowances where board_id = ? order by service, kind", boardId);
}

/** who may change what agents on this board may send: someone who can edit it; on a members-only board, its owner or an admin */
export function egressRefusal(user: UserInfo, boardId: string): string | null {
  if (user.id === "agent") return "The service token can't change what agents may send.";
  if (!canWrite(user.id, boardId)) return "View only: someone who can edit this grid decides what its agents may send outside.";
  if (boardIsRestricted(boardId) && user.role !== "admin" && memberRole(boardId, user.id) !== "owner") return "On a members-only grid, its owner or an admin decides what its agents may send outside.";
  return null;
}

/** who can change it, in a line for people who can't */
export function whoDecides(boardId: string) {
  return boardIsRestricted(boardId) ? "This grid's owner or an admin can change these." : "Anyone who can edit this grid can change these.";
}

/** allow (on) or take back (off) one kind of send to one service from one board; the person's own press (the route asks requirePerson) */
export function setAllowance(boardId: string, person: UserInfo, service: string, kind: SendKind, on: boolean, door: "route" = "route") {
  const why = egressRefusal(person, boardId);
  if (why) {
    audit({ actor_kind: "person", actor_id: person.id, actor_name: person.name, board_id: boardId, door, action: on ? "egress.allow" : "egress.revoke", target: `${service}:${kind}`, provenance: "external", service, decision: "refused", reason: why });
    throw new HttpError(403, why);
  }
  if (on) {
    run(
      "insert into egress_allowances (board_id, service, kind, allowed_by, allowed_by_name, allowed_at) values (?, ?, ?, ?, ?, ?) on conflict(board_id, service, kind) do update set allowed_by = excluded.allowed_by, allowed_by_name = excluded.allowed_by_name, allowed_at = excluded.allowed_at",
      boardId, service, kind, person.id, person.name, Date.now(),
    );
  } else run("delete from egress_allowances where board_id = ? and service = ? and kind = ?", boardId, service, kind);
  audit({ actor_kind: "person", actor_id: person.id, actor_name: person.name, board_id: boardId, door, action: on ? "egress.allow" : "egress.revoke", target: `${service}:${kind}`, provenance: "external", service, decision: "allowed", approved_by: person.id, result: "ok" });
}

/** what the board's pane shows: every service, configured or not, each kind with its state */
export function egressState(boardId: string, user: UserInfo) {
  const rows = allowancesOn(boardId);
  const why = egressRefusal(user, boardId);
  return {
    services: SERVICES.map((s) => ({
      service: s.service,
      provenance: "external" as const,
      badge: `External service · ${s.service}`,
      configured: s.configured(),
      kinds: Object.entries(s.kinds).map(([kind, sends]) => {
        const a = rows.find((r) => r.service === s.service && r.kind === kind);
        return { kind, sends, allowed: Boolean(a), ...(a ? { allowedBy: a.allowed_by_name, allowedAt: a.allowed_at } : {}) };
      }),
    })),
    canChange: !why,
    who: whoDecides(boardId),
    ...(why ? { why } : {}),
  };
}

// ---------- the gate ----------

/** the sends of a tool that this call would make */
export function sendsFor(sends: Send[] | undefined, input: Record<string, unknown>, boardId: string): Send[] {
  return (sends ?? []).filter((s) => !s.when || s.when(input, boardId));
}

/** an agent's call: which external sends are allowed (and by whom), and which are held */
export function decide(boardId: string, sends: Send[]) {
  const held: Send[] = [];
  const allowed: Send[] = [];
  const approvedBy = new Set<string>();
  for (const s of sends) {
    if (s.provenance !== "external" || s.ownGate) {
      allowed.push(s);
      continue;
    }
    const a = allowanceFor(boardId, s.service, s.kind);
    if (a) {
      allowed.push(s);
      approvedBy.add(a.allowed_by);
    } else held.push(s);
  }
  // a service is reachable only if every kind this call sends to it is allowed
  const services = new Set(allowed.map((s) => s.service));
  for (const h of held) services.delete(h.service);
  return { held, allowed, approvedBy, services };
}

const list = listWords;

// ---------- routes an agent could reach a service through directly ----------

/**
 * Read routes that reach an outside service on a caller's word. A person's
 * own request goes through as it is; an agent's (an agent bearer, the service
 * token) reaches only the services allowed on the board it names (?board=),
 * the same allowances as its tools. With no board named, nothing is allowed.
 */
const ROUTE_SENDS: Array<{ method: string; path: RegExp; sends: Array<{ service: string; kind: SendKind }> }> = [
  { method: "GET", path: /^\/api\/search$/, sends: [{ service: "Slack", kind: "query" }, { service: "GitHub", kind: "query" }, { service: "Flowform", kind: "query" }] },
  { method: "GET", path: /^\/api\/repo$/, sends: [{ service: "GitHub", kind: "read" }] },
  { method: "GET", path: /^\/api\/slack\/channels(\/[^/]+)?$/, sends: [{ service: "Slack", kind: "read" }] },
  { method: "GET", path: /^\/api\/flowform\/(tools|rooms)(\/.*)?$/, sends: [{ service: "Flowform", kind: "read" }] },
  { method: "POST", path: /^\/api\/flowform\/(tools\/[^/]+|files\/[^/]+\/bring)$/, sends: [{ service: "Flowform", kind: "read" }] },
  { method: "GET", path: /^\/files\/flowform\//, sends: [{ service: "Flowform", kind: "read" }] },
];

/** the scope an agent's request to one of those routes runs in, or null (a person, or another route) */
export function routeScope(method: string, path: string, board: string | null, actor: { kind: ActorKind; id: string; name: string; for?: string | null }): CallScope | null {
  const r = ROUTE_SENDS.find((x) => x.method === (method === "HEAD" ? "GET" : method) && x.path.test(path));
  if (!r) return null;
  const allowed = new Set<string>();
  if (board) for (const s of new Set(r.sends.map((x) => x.service))) if (r.sends.filter((x) => x.service === s).every((x) => allowanceFor(board, x.service, x.kind))) allowed.add(s);
  return { gated: true, allowed, approvedBy: new Set(), held: new Set(), route: { action: `${method} ${path}`.slice(0, 120), board, actor } };
}

// ---------- private things are refused, not filtered ----------

/** every string in a tool's input */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** the board a Foundation id (a card, a file, an ask, a huddle) belongs to, if it is one */
function boardOfId(id: string): string | null {
  return (
    one<{ board_id: string | null }>("select board_id from files where id = ?", id)?.board_id ??
    one<{ board_id: string | null }>("select board_id from search_fts where source in ('board', 'huddle') and (ref = ? or ref like ? || '/%') and board_id is not null limit 1", id, id)?.board_id ??
    one<{ board_id: string }>("select board_id from asks where id = ? or panel_id = ?", id, id)?.board_id ??
    null
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Why this send is refused whole, or null. It is refused if what it would
 * send names or includes something from a members-only board the acting
 * person can't see; and, for a message (`message: true`), from any
 * members-only board other than the one the call names.
 *
 * What counts as naming or including: a Foundation id of a card, file, ask or
 * huddle on such a board (also inside a /files/ address); the board's own id
 * when it is a made-up slug (has a hyphen or a digit) or its full name when it
 * is at least 8 characters; and any sentence of 40 characters or more copied
 * from a card, file or huddle on it. Paraphrase is not caught.
 */
export function contentRefusal(o: { userId: string; boardId: string; input: unknown; message: boolean; to: string[] }): string | null {
  const text = strings(o.input).join("\n");
  if (!text.trim()) return null;
  const restricted = all<{ board_id: string }>("select distinct board_id from board_members").map((r) => r.board_id);
  if (!restricted.length) return null;
  const user: UserInfo =
    o.userId === "agent"
      ? { id: "agent", email: "", name: "service", color: "", role: "member" }
      : (one<UserInfo>("select id, email, name, color, role from users where id = ?", o.userId) ?? { id: o.userId, email: "", name: "", color: "", role: "viewer" });
  const unseen = new Set(restricted.filter((b) => !canSeeBoard(user, b)));
  const elsewhere = new Set(o.message ? restricted.filter((b) => b !== o.boardId) : []);
  const watched = new Set([...unseen, ...elsewhere]);
  if (!watched.size) return null;
  const to = list(o.to) || "outside";
  const say = (b: string) =>
    unseen.has(b)
      ? `Refused, and nothing was sent to ${to}: it names or includes something from a members-only grid this person can't see. It isn't sent with that part left out either; send it without it.`
      : `Refused, and nothing was sent to ${to}: a message from this board can't carry something from another members-only grid. It isn't sent with that part left out either; send it from that grid, or without it.`;

  // ids: note_…, pnl_…, f_…, ask_… (also inside /files/<id>)
  for (const m of text.matchAll(/\b([a-z]{1,8}_[a-z0-9]{6,32})\b/gi)) {
    const b = boardOfId(m[1]);
    if (b && watched.has(b)) return say(b);
  }
  // the board itself, by a made-up id or a long enough name
  for (const b of watched) {
    const row = one<{ id: string; name: string }>("select id, name from boards where id = ?", b);
    const names = [row && /[-0-9]/.test(row.id) ? row.id : null, row && row.name.trim().length >= 8 ? row.name.trim() : null].filter((x): x is string => !!x);
    if (names.some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text))) return say(b);
  }
  // a sentence copied from a card, file or huddle there
  const segments = [...new Set(text.split(/[\n\r]+|(?<=[.!?])\s+/).map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s.length >= 40))].slice(0, 24);
  if (segments.length) {
    const marks = [...watched].map(() => "?").join(",");
    for (const seg of segments) {
      const hit = one<{ board_id: string }>(`select board_id from search_fts where board_id in (${marks}) and instr(lower(title || ' ' || body), lower(?)) > 0 limit 1`, ...watched, seg);
      if (hit) return say(hit.board_id);
    }
  }
  return null;
}

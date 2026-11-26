/**
 * The timeline (docs/timeline.md): what happened on a grid, and the grid as it was. Two records, both kept by
 * the server alone; no route writes either.
 *
 * **History** is the board document over time: a base (`timeline_base`, written the first time a board opens
 * here, and again whenever old history is folded under the budget), then every change after it
 * (`timeline_updates`), captured at the one place every board write passes (boards.ts `onBoardUpdate`), merged
 * into bursts of ~2 s with `Y.mergeUpdates`, each with its time and who made it. Pointers are sampled once a
 * second while anyone is connected and something moved (`timeline_cursors`, kept 14 days). The present's own
 * log (`board_updates`, compacted every 500 writes) is untouched: this is a second, append-only log.
 * `historyFor` answers with a Replay take's frames (protocol replay.ts): the board at `from`, then the changes
 * up to `to`, thinned to at most ~400 steps, and the pointers.
 *
 * Rebuilding is exact with a server doc that garbage-collects: an update is kept as the doc emitted it (with
 * its content), and Yjs turns a deleted item into a GC struct only when its parent type is deleted too, so a
 * later change never needs content that GC took. A board whose history missed changes (a crash between a
 * board write and a flush) is caught up when it next opens, from the state vector kept with each flush.
 *
 * **Events** (`timeline_events`) are one line per thing that happened, in a lane. The Changes lane is read from
 * the document itself (the sections, objects and links maps, note text and cells), per transaction, so each
 * change has its origin: a person's sync socket is that person; a tool call is the actor its `runTool` put in
 * `actorScope` (audit.ts); a person's own HTTP write is that person; anything else is the server ("system").
 * Never a request body. Chat messages and huddles are not copied here: they are read from chat's and the
 * huddles' own tables when a timeline is asked for, as far as that reader may read them (chat.ts
 * `canSeeChannel`, huddles.ts `sessionFor`), and are absent otherwise.
 */

import * as Y from "yjs";
import { randomBytes } from "node:crypto";
import {
  boardMaps,
  encodeTake,
  findSection,
  type CursorSample,
  type HistoryHead,
  type MediaNoteInfo,
  type TakeFrames,
  type TimelineActor,
  type TimelineEvent,
  type TimelineRef,
  type TimelineSlice,
  type UserInfo,
} from "@foundation/protocol";
import { all, db, one, run } from "./db.ts";
import { getBoard, liveBoardIds, nudgeTimeline, onBoardOpen, onBoardsClosed, onBoardUpdate, socketUserId, whoIsOn, type Board } from "./boards.ts";
import { actorScope, type ScopeActor } from "./audit.ts";
import { canSeeBoard } from "./members.ts";
import { canSeeChannel, getChannel } from "./chat.ts";
import { sessionFor } from "./huddles.ts";
import { HttpError, type Router } from "./http.ts";
import { requireUser } from "./auth.ts";

db.exec(`
create table if not exists timeline_base (
  board_id text not null,
  at integer not null,
  upto integer not null default 0,
  blob blob not null
);
create index if not exists timeline_base_board on timeline_base(board_id, at);
create table if not exists timeline_updates (
  board_id text not null,
  seq integer not null,
  at integer not null,
  blob blob not null,
  by text,
  primary key (board_id, seq)
);
create index if not exists timeline_updates_at on timeline_updates(board_id, at);
create table if not exists timeline_cursors (
  board_id text not null,
  at integer not null,
  json text not null
);
create index if not exists timeline_cursors_board on timeline_cursors(board_id, at);
create index if not exists timeline_cursors_at on timeline_cursors(at);
create table if not exists timeline_boards (
  board_id text primary key,
  sv blob,
  seq integer not null default 0,
  bytes integer not null default 0
);
create table if not exists timeline_events (
  id text primary key,
  board_id text not null,
  section_id text,
  at integer not null,
  end_at integer,
  kind text not null,
  actor_kind text not null,
  actor_id text,
  actor_name text not null,
  actor_for text,
  object_id text,
  text text not null,
  ref_type text,
  ref_id text,
  ref_within text,
  data_json text,
  request_key text
);
create index if not exists timeline_events_board on timeline_events(board_id, at);
create index if not exists timeline_events_kind on timeline_events(board_id, kind, at);
create unique index if not exists timeline_events_request on timeline_events(board_id, request_key) where request_key is not null;
`);
// checkpoints (2026-11-25, review): bytes of changes since the newest base, and that base's size
for (const sql of ["alter table timeline_boards add column since integer not null default 0", "alter table timeline_boards add column base_bytes integer not null default 0", "create index if not exists timeline_base_upto on timeline_base(board_id, upto)", "create index if not exists timeline_events_object on timeline_events(board_id, object_id)"]) {
  try {
    db.exec(sql);
  } catch {
    /* already there */
  }
}

// ---------- limits (env for tests) ----------

const num = (name: string, d: number) => {
  const v = Number(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** changes this close together are one kept burst */
const burstMs = () => num("FOUNDATION_TIMELINE_BURST_MS", 2000);
/** a card's edits by one actor are one event until they pause this long */
const editQuietMs = () => num("FOUNDATION_TIMELINE_EDIT_QUIET_MS", 60_000);
/** a card dragged or resized about by one actor is one event until they leave it alone this long */
const placeQuietMs = () => num("FOUNDATION_TIMELINE_PLACE_QUIET_MS", 20_000);
/** the windows on a grid hear "something new" at most this often (nudgeTimeline) */
const nudgeMs = () => num("FOUNDATION_TIMELINE_NUDGE_MS", 600);
/** reads by one agent with one tool within this long are one event, counted */
const readCoalesceMs = () => num("FOUNDATION_TIMELINE_READ_MS", 30_000);
/** a person who comes back within this long is still on the same stretch */
const hereGraceMs = () => num("FOUNDATION_TIMELINE_HERE_MS", 60_000);
/** pointers are sampled this often while anyone is on the grid */
const cursorMs = () => num("FOUNDATION_TIMELINE_CURSOR_MS", 1000);
const cursorDays = () => num("FOUNDATION_TIMELINE_CURSOR_DAYS", 14);
/** history kept per grid, in MB (changes and checkpoints; the newest base is kept whatever its size) */
const maxBytes = () => num("FOUNDATION_TIMELINE_MAX_MB", DEFAULT_MAX_MB) * 1024 * 1024;
export const DEFAULT_MAX_MB = 256;
/**
 * A checkpoint (a new base, from the live board at a flush) is written once this many bytes of changes follow the
 * newest base, or half that base's size if it is bigger: a rebuild then applies a base and a bounded tail.
 */
const checkpointBytes = (baseBytes: number) => Math.max(Math.min(1024 * 1024, maxBytes() / 8), baseBytes / 2);
/** the most a history answer carries; a stretch that holds more is refused with a sentence (413) */
const historyMaxBytes = () => num("FOUNDATION_TIMELINE_HISTORY_MAX_MB", 24) * 1024 * 1024;

/** a stretch of history is sent as at most this many steps, however long */
export const HISTORY_STEPS = 400;
/** and at most this many pointer samples */
export const HISTORY_CURSORS = 4000;
/** the density bar's steps */
export const DENSITY_STEPS = 240;

const SPAN_KINDS = ["person.here", "agent.run", "terminal", "huddle"];
const CHANGE_KINDS = ["card.add", "card.remove", "card.move", "card.place", "card.rename", "card.edit", "section.add", "section.remove", "section.rename", "section.move", "wire.add", "wire.remove", "note.audio", "note.video"];

// ---------- who did it ----------

/** a server subsystem's origin, in words (any other origin is "Foundation") */
const SYSTEM_NAMES: Record<string, string> = {
  system: "Foundation",
  agent: "Foundation",
  slack: "Slack",
  characters: "Characters",
  machines: "Machines",
  posted: "The council",
  t3: "T3",
  flows: "Flows",
  cadfeed: "CAD feed",
  pipeline: "The pipeline",
  jobs: "Jobs",
  huddle: "Huddles",
  hermes: "Asks",
  digest: "The digest",
  vision: "Vision",
  local: "Local projects",
  "local-vms": "Local machines",
  "desktop-leave": "Machines",
  today: "Today",
  seed: "Foundation",
};

/**
 * The origins a request's or a tool call's own write uses, read where editBoard is called (2026-11-25): "agent"
 * (every board tool, touch(), replay's and flows' cards laid by a tool, cadfeed's wiring from a tool), "system"
 * (a person's routes: a grid filed in a grid, a huddle made for an invite, a section made its own grid; none of
 * its call sites is a timer) and "posted" (the council routes). Only these consult `actorScope`; every other origin
 * is a subsystem at work, even when a timer it armed inside someone's request still carries that request's scope.
 */
const ACTOR_ORIGINS = new Set(["agent", "system", "posted"]);

interface Actor extends TimelineActor {
  /** an agent's person, by id (kept for reading rules, never shown) */
  forId?: string;
}

/** who made this transaction: the socket's person, the tool call or person's request in flight, else the server. null: not an event (a load, a migration, the server-map guard) */
function actorOfOrigin(board: Board, origin: unknown): Actor | null {
  if (origin === "load" || origin === "migrate" || origin === "server-map-guard") return null;
  if (origin && typeof origin === "object") {
    const id = socketUserId(origin);
    if (id) return { kind: "person", id, name: "" };
    if (board.conns.has(origin as never)) return { kind: "person", name: "Someone" };
  }
  const key = typeof origin === "string" ? origin.slice(0, 40) : "system";
  const s = scopedFor(origin);
  if (s) return { kind: s.kind, ...(s.id ? { id: s.id } : {}), name: s.name, ...(s.for ? { for: s.for } : {}), ...(s.forId ? { forId: s.forId } : {}) };
  return { kind: "system", id: key, name: SYSTEM_NAMES[key] ?? "Foundation" };
}

/** the actor in scope, for an origin that is a request's or a tool's own write (null/undefined origins too: a bare transact) */
function scopedFor(origin: unknown): ScopeActor | undefined {
  if (origin !== null && origin !== undefined && !(typeof origin === "string" && ACTOR_ORIGINS.has(origin))) return undefined;
  return actorScope.getStore();
}

const userNames = new Map<string, string>();
function userName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  let n = userNames.get(id);
  if (n === undefined) {
    n = one<{ name: string }>("select name from users where id = ?", id)?.name ?? "";
    if (userNames.size > 2000) userNames.clear();
    userNames.set(id, n);
  }
  return n || undefined;
}
const named = (a: Actor): Actor => (a.kind === "person" && !a.name ? { ...a, name: userName(a.id) ?? "Someone" } : a);
const actorKey = (a: Actor) => `${a.kind}:${a.id ?? a.name}`;

// ---------- events: recording ----------

export interface NewEvent {
  board: string;
  section?: string | null;
  at?: number;
  end?: number | null;
  kind: string;
  actor: Actor | TimelineActor;
  object?: string | null;
  text: string;
  ref?: TimelineRef;
  /** keys starting with "_" are the server's own (reading rules) and never leave it */
  data?: Record<string, unknown>;
  /** a replayed request records nothing new (runTool's request_id key) */
  requestKey?: string | null;
}

const newId = () => `tle_${randomBytes(8).toString("hex")}`;

// The board document is untrusted input: any editor's socket can write any shape into it (a name that is a number,
// a note without a file, a link with no ends). Everything read from it goes through these.
/** a string, or a finite number as words; anything else is the fallback */
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : d);
/** an id: a short string, or null */
const idOf = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const clip = (s: unknown, n: number) => {
  const t = str(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function insertEvent(e: NewEvent): string {
  const id = newId();
  const a = e.actor as Actor;
  const r = run(
    `insert or ignore into timeline_events (id, board_id, section_id, at, end_at, kind, actor_kind, actor_id, actor_name, actor_for, object_id, text, ref_type, ref_id, ref_within, data_json, request_key)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    e.board,
    idOf(e.section),
    numOf(e.at) ?? Date.now(),
    numOf(e.end),
    e.kind,
    a.kind,
    idOf(a.id),
    clip(a.name, 120) || "Someone",
    clip(a.for, 120) || null,
    idOf(e.object),
    clip(e.text, 300),
    e.ref && idOf(e.ref.id) ? e.ref.type : null,
    e.ref ? idOf(e.ref.id) : null,
    e.ref ? idOf(e.ref.within) : null,
    e.data && Object.keys(e.data).length ? JSON.stringify(e.data) : null,
    e.requestKey ?? null,
  );
  if (!r.changes && e.requestKey) return one<{ id: string }>("select id from timeline_events where board_id = ? and request_key = ?", e.board, e.requestKey)?.id ?? id;
  nudge(e.board);
  return id;
}

/** each grid's pending "something new" (trailing: the last thing recorded in a stretch is always told) */
const nudges = new Map<string, ReturnType<typeof setTimeout>>();
function nudge(boardId: string) {
  if (nudges.has(boardId)) return;
  const t = actorScope.exit(() =>
    setTimeout(() => {
      nudges.delete(boardId);
      try {
        nudgeTimeline(boardId, Date.now());
      } catch {
        /* a window that went away */
      }
    }, nudgeMs()),
  );
  t.unref?.();
  nudges.set(boardId, t);
}

/** record one event where its thing happened; returns its id (a replayed request key returns the first one's). Never throws into its caller. */
export function recordEvent(e: NewEvent): string | null {
  try {
    return insertEvent(e);
  } catch (err) {
    console.error(`timeline: couldn't record ${e.kind}: ${(err as Error).message}`);
    return null;
  }
}

/** a span ends (or, with patch, ends saying more: its text, more data) */
export function endEvent(id: string | null | undefined, end = Date.now(), patch?: { text?: string; data?: Record<string, unknown> }) {
  if (!id) return;
  try {
    if (patch?.data) {
      const was = one<{ data_json: string | null }>("select data_json from timeline_events where id = ?", id);
      const data = { ...(was?.data_json ? (JSON.parse(was.data_json) as Record<string, unknown>) : {}), ...patch.data };
      run("update timeline_events set data_json = ? where id = ?", JSON.stringify(data), id);
    }
    if (patch?.text) run("update timeline_events set text = ? where id = ?", clip(patch.text, 300), id);
    run("update timeline_events set end_at = ? where id = ?", end, id);
  } catch (err) {
    console.error(`timeline: couldn't end an event: ${(err as Error).message}`);
  }
}

// ---------- history: keeping it ----------

interface Change {
  t: "obj" | "sec" | "link" | "edit" | "asks";
  action?: "add" | "update" | "delete";
  id: string;
  now?: unknown;
  was?: unknown;
  actor: Actor;
  /** when it was seen (the quiet stretches are measured on this) */
  at: number;
  /** when it is on the timeline: its burst's time (flushLive) */
  stamp?: number;
}

interface Live {
  id: string;
  board: Board;
  buf: Uint8Array[];
  bufBy: Set<string>;
  bufAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  changes: Change[];
  cursorTimer: ReturnType<typeof setInterval> | null;
  lastCursors: string;
  here: Map<string, string>;
  left: Map<string, { id: string; at: number }>;
  hereQueued: boolean;
  unwatch: Array<() => void>;
}

const lives = new Map<string, Live>();
let started = false;

function baseOf(boardId: string) {
  return one<{ at: number }>("select at from timeline_base where board_id = ? limit 1", boardId);
}

interface BoardKeep {
  sv: Uint8Array | null;
  seq: number;
  /** every kept byte: changes and bases */
  bytes: number;
  /** bytes of changes since the newest base */
  since: number;
  /** the newest base's size */
  base_bytes: number;
}

function boardRow(boardId: string) {
  return one<BoardKeep>("select sv, seq, bytes, since, base_bytes from timeline_boards where board_id = ?", boardId);
}

/** a document is between transactions (its state is exactly what history holds after a flush) */
const settled = (doc: Y.Doc) => !doc.isDestroyed && (doc as unknown as { _transaction: unknown })._transaction === null;

/**
 * A checkpoint: the live board as a new base at the last kept change, so a rebuild applies a base and a short
 * tail. Valid only right after a flush (outside any transaction), when the live document is exactly history's state.
 */
function writeCheckpoint(boardId: string, doc: Y.Doc, at: number, seq: number) {
  const blob = Y.encodeStateAsUpdate(doc);
  run("insert into timeline_base (board_id, at, upto, blob) values (?, ?, ?, ?)", boardId, at, seq, blob);
  run("update timeline_boards set since = 0, base_bytes = ?, bytes = bytes + ? where board_id = ?", blob.length, blob.length, boardId);
}

/**
 * A board opens: its first base when it has none (a grid from before this server began keeping), and the
 * changes history missed (a crash before a flush) when it has one.
 */
function keepFromHere(b: Board) {
  const now = Date.now();
  const sv = Y.encodeStateVector(b.doc);
  if (!baseOf(b.id)) {
    const blob = Y.encodeStateAsUpdate(b.doc);
    run("insert into timeline_base (board_id, at, upto, blob) values (?, ?, 0, ?)", b.id, now, blob);
    run(
      "insert into timeline_boards (board_id, sv, seq, bytes, since, base_bytes) values (?, ?, 0, ?, 0, ?) on conflict(board_id) do update set sv = excluded.sv, bytes = excluded.bytes, since = 0, base_bytes = excluded.base_bytes",
      b.id,
      sv,
      blob.length,
      blob.length,
    );
    return;
  }
  const row = boardRow(b.id);
  if (!row?.sv || Buffer.compare(Buffer.from(row.sv), Buffer.from(sv)) === 0) return;
  const missed = Y.encodeStateAsUpdate(b.doc, row.sv);
  const seq = row.seq + 1;
  run("insert into timeline_updates (board_id, seq, at, blob, by) values (?, ?, ?, ?, ?)", b.id, seq, now, missed, "Foundation (kept when the grid next opened)");
  run("update timeline_boards set sv = ?, seq = ?, bytes = bytes + ?, since = since + ? where board_id = ?", sv, seq, missed.length, missed.length, b.id);
}

function attach(b: Board): Live {
  const had = lives.get(b.id);
  if (had && had.board === b) return had;
  if (had) forget(had);
  keepFromHere(b);
  const l: Live = { id: b.id, board: b, buf: [], bufBy: new Set(), bufAt: 0, timer: null, changes: [], cursorTimer: null, lastCursors: "", here: new Map(), left: new Map(), hereQueued: false, unwatch: [] };
  lives.set(b.id, l);
  watchDoc(l);
  const onAware = () => awarenessMoved(l);
  b.awareness.on("change", onAware);
  l.unwatch.push(() => b.awareness.off("change", onAware));
  return l;
}

function forget(l: Live) {
  flushLive(l);
  if (l.timer) clearTimeout(l.timer);
  if (l.cursorTimer) clearInterval(l.cursorTimer);
  for (const off of l.unwatch) off();
  // people on it now leave with it (a restart, a test's closeBoards)
  for (const [, id] of l.here) endEvent(id);
  lives.delete(l.id);
}

function schedule(l: Live) {
  // armed outside whoever's scope queued the change: the flush is the server's own
  l.timer ??= actorScope.exit(() => setTimeout(() => flushLive(l), burstMs()));
  l.timer.unref?.();
}

onBoardUpdate((boardId, update, at, origin) => {
  if (!started) return;
  const l = lives.get(boardId);
  // a board loaded before keeping began is attached now: its base already holds this change
  if (!l) {
    try {
      attach(getBoard(boardId));
    } catch (e) {
      console.error("timeline: couldn't start keeping a grid", e);
    }
    return;
  }
  l.buf.push(update);
  l.bufAt = at;
  if (origin === "migrate") l.bufBy.add("Foundation (migration)");
  else {
    const id = socketUserId(origin);
    if (id) l.bufBy.add(`u:${id}`);
    else {
      const s = scopedFor(origin);
      if (s) l.bufBy.add(s.kind === "person" && s.id ? `u:${s.id}` : s.name);
      else if (typeof origin === "string") l.bufBy.add(SYSTEM_NAMES[origin] ?? "Foundation");
    }
  }
  schedule(l);
});

/** run inside one SQLite transaction (a flush's rows land together) */
function inTx(fn: () => void) {
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) return fn();
  db.exec("begin");
  try {
    fn();
    db.exec("commit");
  } catch (e) {
    try {
      db.exec("rollback");
    } catch {
      /* nothing open */
    }
    throw e;
  }
}

/** write what a board gathered: its burst of changes, as one row, and the events they make, in one transaction */
function flushLive(l: Live) {
  if (l.timer) clearTimeout(l.timer);
  l.timer = null;
  if (!l.buf.length && !l.changes.length) return;
  const buf = l.buf;
  const by = [...l.bufBy].map((b) => (b.startsWith("u:") ? (userName(b.slice(2)) ?? "Someone") : b));
  const changes = l.changes;
  const at = l.bufAt;
  l.buf = [];
  l.bufBy = new Set();
  l.changes = [];
  // 1. history: the burst and the state vector, in a transaction of their own (no event can undo them)
  if (buf.length) {
    let merged: Uint8Array | null = null;
    try {
      merged = buf.length === 1 ? buf[0] : Y.mergeUpdates(buf);
      const m = merged;
      inTx(() => {
        const row = boardRow(l.id) ?? { seq: 0, bytes: 0, sv: null, since: 0, base_bytes: 0 };
        const seq = row.seq + 1;
        run("insert into timeline_updates (board_id, seq, at, blob, by) values (?, ?, ?, ?, ?)", l.id, seq, at, m, [...new Set(by)].join(", ").slice(0, 300) || null);
        const sv = l.board.doc.isDestroyed ? row.sv : Y.encodeStateVector(l.board.doc);
        run(
          "insert into timeline_boards (board_id, sv, seq, bytes, since, base_bytes) values (?, ?, ?, ?, ?, ?) on conflict(board_id) do update set sv = excluded.sv, seq = excluded.seq, bytes = excluded.bytes, since = excluded.since",
          l.id,
          sv,
          seq,
          row.bytes + m.length,
          row.since + m.length,
          row.base_bytes,
        );
        // a checkpoint when the tail after the newest base has grown (the live board is history's state right now)
        if (row.since + m.length >= checkpointBytes(row.base_bytes) && settled(l.board.doc)) writeCheckpoint(l.id, l.board.doc, at, seq);
      });
      // the grid's history moved on: windows that show it read it again
      nudge(l.id);
    } catch (e) {
      // kept for the next flush, so the chain of changes isn't broken (the state vector wasn't moved)
      console.error("timeline: couldn't keep a burst", e);
      if (merged) l.buf.unshift(merged);
      else l.buf.unshift(...buf);
      l.bufAt = Math.max(l.bufAt, at);
    }
  }
  // 2. events: each change on its own, so one malformed card costs its own event and nothing else.
  // An event is stamped with the time of the burst that keeps its change (never before it): the board at an
  // event's moment then always holds that event's change, and events of one burst keep the order they happened in.
  if (changes.length) {
    if (buf.length) for (const c of changes) c.stamp = Math.max(c.at, at);
    try {
      inTx(() => eventsFromChanges(l, changes));
    } catch (e) {
      console.error("timeline: couldn't keep a burst's events", e);
    }
  }
  try {
    foldIfOver(l.id);
  } catch (e) {
    console.error("timeline: couldn't fold old history", e);
  }
}

/** write every board's gathered burst now (tests, shutdown, before reading) */
export function flushTimeline() {
  for (const l of lives.values()) flushLive(l);
  for (const p of [...pendingReads.values()]) flushRead(p);
}

function flushBoard(boardId: string) {
  const l = lives.get(boardId);
  if (l) flushLive(l);
  for (const p of [...pendingReads.values()]) if (p.ev.board === boardId) flushRead(p);
}

/**
 * Over the budget: history before a later checkpoint is let go. The oldest checkpoint whose dropping brings the
 * grid under half its budget becomes where history begins (`start` moves forward to it); the changes and bases
 * before it are deleted. Nothing is replayed: a fold is a few deletes, whatever the size. A grid with no later
 * checkpoint (history from before checkpoints) gets one from the live board first, when it is settled.
 */
function foldIfOver(boardId: string) {
  const row = boardRow(boardId);
  const max = maxBytes();
  if (!row || row.bytes <= max) return;
  const bases = all<{ upto: number; at: number; size: number }>("select upto, at, length(blob) as size from timeline_base where board_id = ? order by upto", boardId);
  if (bases.length < 2) {
    const l = lives.get(boardId);
    if (!l || !settled(l.board.doc) || l.buf.length || row.since === 0) return;
    writeCheckpoint(boardId, l.board.doc, one<{ at: number }>("select max(at) as at from timeline_updates where board_id = ?", boardId)?.at ?? Date.now(), row.seq);
    return foldIfOver(boardId);
  }
  // what dropping everything before each later base frees, oldest first
  let keep = bases[bases.length - 1];
  for (const b of bases.slice(1)) {
    const freedUpdates = one<{ n: number }>("select coalesce(sum(length(blob)), 0) as n from timeline_updates where board_id = ? and seq <= ?", boardId, b.upto)?.n ?? 0;
    const freedBases = bases.filter((x) => x.upto < b.upto).reduce((n, x) => n + x.size, 0);
    if (row.bytes - freedUpdates - freedBases <= max / 2) {
      keep = b;
      break;
    }
  }
  inTx(() => {
    run("delete from timeline_updates where board_id = ? and seq <= ?", boardId, keep.upto);
    run("delete from timeline_base where board_id = ? and upto < ?", boardId, keep.upto);
    const left = one<{ n: number }>("select (select coalesce(sum(length(blob)), 0) from timeline_updates where board_id = ?) + (select coalesce(sum(length(blob)), 0) from timeline_base where board_id = ?) as n", boardId, boardId)?.n ?? 0;
    run("update timeline_boards set bytes = ? where board_id = ?", left, boardId);
  });
  historyCache.clear();
}

// ---------- the changes lane: the document's own maps ----------

/** what a change touches, observed per transaction: queued only, turned into events at the flush */
function watchDoc(l: Live) {
  const doc = l.board.doc;
  const m = boardMaps(doc);
  const queue = (c: Change) => {
    l.changes.push(c);
    schedule(l);
  };
  const keyed = (t: Change["t"], map: Y.Map<unknown>) => (ev: Y.YMapEvent<unknown>) => {
    const actor = actorOfOrigin(l.board, ev.transaction.origin);
    if (!actor) return;
    const at = Date.now();
    for (const [id, ch] of ev.changes.keys) queue({ t, action: ch.action, id, now: map.get(id), was: ch.oldValue, actor, at });
  };
  const onSec = keyed("sec", m.sections as Y.Map<unknown>);
  const onObj = keyed("obj", m.objects as Y.Map<unknown>);
  const onLink = keyed("link", m.links as Y.Map<unknown>);
  // the machines' asks: only the server writes them (a socket's write is put back by boards.ts guardServerMaps)
  const onAsks = (ev: Y.YMapEvent<unknown>) => {
    const o = ev.transaction.origin;
    if (o && typeof o === "object") return;
    if (o === "server-map-guard" || o === "load" || o === "migrate") return;
    const at = Date.now();
    for (const id of ev.keysChanged) queue({ t: "asks", id, now: m.machineAsks.get(id), actor: { kind: "system", name: "Machines" }, at });
  };
  // words and cells: an edit of that card
  const deep = (map: Y.Map<unknown>) => (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction) => {
    const actor = actorOfOrigin(l.board, tr.origin);
    if (!actor) return;
    const at = Date.now();
    const ids = new Set<string>();
    for (const e of events) {
      if (e.target === map) for (const k of (e as Y.YMapEvent<unknown>).keysChanged) ids.add(k);
      else if (typeof e.path[0] === "string") ids.add(e.path[0]);
    }
    for (const id of ids) queue({ t: "edit", id, actor, at });
  };
  const onText = deep(m.noteText as Y.Map<unknown>);
  const onCells = deep(m.cells as Y.Map<unknown>);
  m.sections.observe(onSec as never);
  m.objects.observe(onObj as never);
  m.links.observe(onLink as never);
  m.machineAsks.observe(onAsks as never);
  m.noteText.observeDeep(onText as never);
  m.cells.observeDeep(onCells as never);
  l.unwatch.push(() => {
    if (doc.isDestroyed) return;
    m.sections.unobserve(onSec as never);
    m.objects.unobserve(onObj as never);
    m.links.unobserve(onLink as never);
    m.machineAsks.unobserve(onAsks as never);
    m.noteText.unobserveDeep(onText as never);
    m.cells.unobserveDeep(onCells as never);
  });
}

/** a card as the timeline reads it: every field coerced (the document is untrusted input), or null when it isn't a card */
interface CardView {
  id: string;
  /** the board's word for it: "note", "table", "image", a panel's kind */
  kind: string;
  name: string;
  section: string | null;
  media: string | null;
  /** a voice or video note's facts, only when they are well formed */
  note: MediaNoteInfo | null;
  raw: Record<string, unknown>;
}

/** a note's facts when they hold together: a file id, a type, a length; a wave of at most 96 numbers in 0..1 */
function noteInfoOf(v: unknown): MediaNoteInfo | null {
  const n = rec(v);
  const fileId = idOf(n?.fileId);
  const ms = numOf(n?.ms);
  if (!n || !fileId || ms === null || ms < 0) return null;
  const peaks = Array.isArray(n.peaks) ? n.peaks.slice(0, 96).map((p) => Math.max(0, Math.min(1, numOf(p) ?? 0))) : null;
  return { fileId, mime: clip(n.mime, 80) || "application/octet-stream", ms: Math.round(ms), ...(peaks ? { peaks } : {}) };
}

function cardOf(id: string, v: unknown): CardView | null {
  const o = rec(v);
  if (!o) return null;
  const media = o.kind === "media" ? str(o.media, "image") || "image" : null;
  const note = media === "audio" || media === "video" ? noteInfoOf(o.note) : null;
  const kind = o.kind === "panel" ? clip(o.panel, 30) || "card" : media ? (note ? `${media} note` : media) : clip(o.kind, 30) || "card";
  return { id, kind, name: clip(o.name, 200), section: idOf(o.sectionId), media, note, raw: o };
}

interface SectionView {
  id: string;
  name: string;
  c0: number | null;
  r0: number | null;
  c1: number | null;
  r1: number | null;
}
function sectionOf(id: string, v: unknown): SectionView | null {
  const s = rec(v);
  if (!s) return null;
  return { id, name: clip(s.name, 200), c0: numOf(s.c0), r0: numOf(s.r0), c1: numOf(s.c1), r1: numOf(s.r1) };
}

const KIND_WORD: Record<string, string> = { note: "a note", table: "a table", map: "a map", image: "a picture", video: "a video", audio: "a sound", file: "a file", link: "a page", app: "an app", machine: "a machine", chat: "a conversation", huddle: "a huddle", agent: "an agent card", ask: "an ask", grid: "a grid" };
const kindWord = (k: string) => KIND_WORD[k] ?? `a ${k} card`;
const q = (s: unknown) => `“${clip(s, 60) || "untitled"}”`;
/** what about a card counts as an edit of its settings (not where it sits, its size, its name or section) */
const LAYOUT = new Set(["x", "y", "w", "h", "float", "bornAt", "name", "sectionId", "z"]);
function settingsChanged(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (LAYOUT.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
  }
  return false;
}

/** each card+actor's last edit, so a stretch of typing is one event */
const editSeen = new Map<string, number>();
/** a machine ask's open span (bounded: an ask whose card went away never ends here, and recoverOpenSpans ends it) */
const askSpans = new Map<string, string>();
const ASK_SPANS_MAX = 2000;

function eventsFromChanges(l: Live, changes: Change[]) {
  const doc = l.board.doc;
  const live = doc.isDestroyed ? null : boardMaps(doc);
  const secName = (id: string | null) => (id && live ? clip(rec(live.sections.get(id))?.name, 200) || undefined : undefined);
  const quiet = editQuietMs();
  // a card made in this burst: what it was filled with, laid out as or wired to in the same burst is its making
  // (an agent's add_note writes the card, then its words), not an edit; what comes in a later burst is
  const born = new Set<string>();
  for (const c of changes) if (c.t === "obj" && c.action === "add") born.add(c.id);
  for (const c of changes) {
    try {
      eventFromChange(l, c, live, secName, quiet, born);
    } catch (e) {
      // one malformed change costs its own event, never the burst's history or anyone else's events
      console.error(`timeline: couldn't read a change to ${clip(c.id, 60)}: ${(e as Error).message}`);
    }
  }
  if (editSeen.size > 5000) for (const [k, t] of editSeen) if (Date.now() - t > quiet) editSeen.delete(k);
}

function eventFromChange(l: Live, c: Change, live: ReturnType<typeof boardMaps> | null, secName: (id: string | null) => string | undefined, quiet: number, born: Set<string> = new Set()) {
  const a = named(c.actor);
  const ev = (e: Omit<NewEvent, "board" | "actor" | "at">) => insertEvent({ board: l.id, at: c.stamp ?? c.at, actor: a, ...e });
  const sn = (id: string | null) => {
    const n = secName(id);
    return n ? { _sn: n } : {};
  };
  if (c.t === "obj") {
    const now = c.now === undefined ? null : cardOf(c.id, c.now);
    const was = c.was === undefined ? null : cardOf(c.id, c.was);
    if (c.action === "add" && now) {
      if (now.note) noteEvent(c, l.id, now, a, secName(now.section));
      else ev({ section: now.section, kind: "card.add", object: now.id, text: `added ${kindWord(now.kind)} ${q(now.name)}`, data: { card: now.kind, name: now.name, ...sn(now.section) } });
    } else if (c.action === "delete" && was) {
      ev({ section: was.section, kind: "card.remove", object: was.id, text: `removed ${kindWord(was.kind)} ${q(was.name)}`, data: { card: was.kind, name: was.name, ...sn(was.section) } });
    } else if (c.action === "update" && now && was) {
      const base = { card: now.kind, name: now.name };
      if (now.section !== was.section) ev({ section: now.section, kind: "card.move", object: now.id, text: `moved ${q(now.name)} to ${q(secName(now.section) ?? "another section")}`, data: { ...base, from: was.section, ...sn(now.section) } });
      // dragged or resized inside its section: a person's or an agent's hand, not the server laying cards out
      else if (a.kind !== "system" && !born.has(now.id) && placeChanged(now.raw, was.raw)) placeOnce(c, l.id, now, was, a);
      if (now.name !== was.name) ev({ section: now.section, kind: "card.rename", object: now.id, text: `renamed ${q(was.name)} to ${q(now.name)}`, data: { ...base, was: was.name } });
      if (now.note && !was.note) noteEvent(c, l.id, now, a, secName(now.section));
      else if (a.kind !== "system" && !born.has(now.id) && settingsChanged(now.raw, was.raw)) editOnce(c, l.id, now, a, quiet);
    }
  } else if (c.t === "edit") {
    if (born.has(c.id)) return;
    const o = live ? cardOf(c.id, live.objects.get(c.id)) : null;
    if (o) editOnce(c, l.id, o, a, quiet);
  } else if (c.t === "sec") {
    const now = c.now === undefined ? null : sectionOf(c.id, c.now);
    const was = c.was === undefined ? null : sectionOf(c.id, c.was);
    if (c.action === "add" && now) ev({ section: now.id, kind: "section.add", text: `added the section ${q(now.name)}`, data: { name: now.name } });
    else if (c.action === "delete" && was) ev({ section: was.id, kind: "section.remove", text: `removed the section ${q(was.name)}`, data: { name: was.name } });
    else if (c.action === "update" && now && was) {
      if (now.name !== was.name) ev({ section: now.id, kind: "section.rename", text: `renamed the section ${q(was.name)} to ${q(now.name)}`, data: { name: now.name, was: was.name } });
      // the same span somewhere else (a resize or a split isn't a move)
      const span = (s: SectionView) => (s.c0 !== null && s.c1 !== null && s.r0 !== null && s.r1 !== null ? `${s.c1 - s.c0}x${s.r1 - s.r0}` : null);
      const moved = (now.c0 !== was.c0 || now.r0 !== was.r0) && span(now) !== null && span(now) === span(was);
      if (moved) ev({ section: now.id, kind: "section.move", text: `moved the section ${q(now.name)}`, data: { name: now.name } });
    }
  } else if (c.t === "link") {
    if (c.action === "update") return;
    const link = rec(c.now ?? c.was);
    if (!link) return;
    const fromId = idOf(rec(link.from)?.panel);
    const toId = idOf(rec(link.to)?.panel);
    const from = fromId && live ? cardOf(fromId, live.objects.get(fromId)) : null;
    const to = toId && live ? cardOf(toId, live.objects.get(toId)) : null;
    const words = `${q(from?.name ?? "a card")} to ${q(to?.name ?? "a card")}`;
    ev({ section: from?.section ?? null, kind: c.action === "add" ? "wire.add" : "wire.remove", object: c.id, text: c.action === "add" ? `wired ${words}` : `unwired ${words}`, data: { from: fromId, to: toId } });
  } else if (c.t === "asks") askEvents(l, c, live);
}

/** where a card sits and how big it is, inside its section (a move to another section is card.move) */
const PLACE = ["x", "y", "w", "h", "float"] as const;
function placeChanged(a: Record<string, unknown>, b: Record<string, unknown>) {
  return PLACE.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
const placeSeen = new Map<string, number>();
/** one card.place per card and actor for each stretch of dragging and resizing: "moved" or "resized" by what changed first */
function placeOnce(c: Change, boardId: string, now: CardView, was: CardView, a: Actor) {
  const key = `${boardId}|${now.id}|${actorKey(a)}`;
  const last = placeSeen.get(key);
  placeSeen.set(key, c.at);
  if (placeSeen.size > 5000) for (const [k, t] of placeSeen) if (c.at - t > placeQuietMs()) placeSeen.delete(k);
  if (last !== undefined && c.at - last < placeQuietMs()) return;
  const sized = JSON.stringify(now.raw.w) !== JSON.stringify(was.raw.w) || JSON.stringify(now.raw.h) !== JSON.stringify(was.raw.h);
  insertEvent({ board: boardId, at: c.stamp ?? c.at, actor: a, section: now.section, kind: "card.place", object: now.id, text: `${sized ? "resized" : "moved"} ${q(now.name)}`, data: { card: now.kind, name: now.name, how: sized ? "size" : "place" } });
}

/** one card.edit per card and actor for each stretch of work */
function editOnce(c: Change, boardId: string, o: CardView, a: Actor, quiet: number) {
  const key = `${boardId}|${o.id}|${actorKey(a)}`;
  const last = editSeen.get(key);
  editSeen.set(key, c.at);
  if (last !== undefined && c.at - last < quiet) return;
  insertEvent({ board: boardId, at: c.stamp ?? c.at, actor: a, section: o.section, kind: "card.edit", object: o.id, text: `edited ${q(o.name)}`, data: { card: o.kind, name: o.name } });
}

/** a voice or video note left: who left it is the transaction's person, never the card's own `note.by` */
function noteEvent(c: Change, boardId: string, o: CardView, a: Actor, sn?: string) {
  const note = o.note!;
  insertEvent({
    board: boardId,
    at: c.stamp ?? c.at,
    actor: a,
    section: o.section,
    kind: o.media === "audio" ? "note.audio" : "note.video",
    object: o.id,
    text: o.media === "audio" ? "left a voice note" : "left a video note",
    ref: { type: "file", id: note.fileId },
    data: { note, card: o.kind, name: o.name, ...(sn ? { _sn: sn } : {}) },
  });
}

/** who left a voice or video note on this card, as the timeline recorded it (the session's word, not the card's); null when history began after */
export function noteLeftBy(boardId: string, cardId: string): string | null {
  try {
    return one<{ n: string }>("select actor_name as n from timeline_events where board_id = ? and object_id = ? and kind in ('note.audio', 'note.video') order by at limit 1", boardId, cardId)?.n ?? null;
  } catch {
    return null;
  }
}

const ENDED: Record<string, string> = { done: "ran", declined: "was declined", "timed out": "waited, and nobody answered", withdrawn: "withdrew", failed: "couldn't start", allowed: "was allowed" };

/** a machine's commands that agents asked to run: a span from the ask to its end. The command is on the card for everyone on the grid (the board's `machineAsks`), so its text is here too */
function askEvents(l: Live, c: Change, live: ReturnType<typeof boardMaps> | null) {
  const list = Array.isArray(c.now) ? (c.now as unknown[]) : [];
  const card = live ? rec(live.objects.get(c.id)) : null;
  const machine = card?.kind === "panel" ? clip(rec(card.machine)?.name, 60) || clip(card.name, 60) || "a machine" : "a machine";
  const section = idOf(card?.sectionId);
  for (const raw of list) {
    try {
      const a = rec(raw);
      const askId = idOf(a?.id);
      if (!a || !askId || a.tool) continue; // not an ask, or an app tool's leave rather than a command
      const state = str(a.state);
      const open = state === "waiting" || state === "running";
      let span = askSpans.get(askId);
      if (!span) {
        const found = one<{ id: string }>("select id from timeline_events where board_id = ? and kind = 'terminal' and ref_id = ?", l.id, askId)?.id;
        if (found && !open) continue; // kept and ended already (the card keeps its last few answered asks)
        const actor: Actor = { kind: "agent", name: clip(a.by, 80) || "An agent", ...(clip(a.for, 80) ? { for: clip(a.for, 80) } : {}) };
        span = found ?? insertEvent({ board: l.id, at: numOf(a.at) ?? c.at, actor, section, kind: "terminal", object: c.id, text: `asked to run a command in ${machine}`, ref: { type: "machine", id: askId, within: c.id }, data: { command: clip(a.command, 2000) } });
        askSpans.set(askId, span);
        if (askSpans.size > ASK_SPANS_MAX) askSpans.delete(askSpans.keys().next().value!);
      }
      if (!open) {
        const exit = numOf(a.exitCode) ?? undefined;
        endEvent(span, numOf(a.endedAt) ?? c.at, { text: `${state === "done" ? `ran a command in ${machine}` : `its command in ${machine} ${ENDED[state] ?? clip(state, 30)}`}${exit !== undefined ? `: exit ${exit}` : ""}`, data: { command: clip(a.command, 2000), ...(exit !== undefined ? { exit } : {}), state: clip(state, 30) } });
        askSpans.delete(askId);
      }
    } catch (e) {
      console.error(`timeline: couldn't read a machine's ask: ${(e as Error).message}`);
    }
  }
}

// ---------- people, and where they pointed ----------

/**
 * Who is pointing where now (replay.ts cursorsNow, the same CursorSample), by boards.ts whoIsOn's rule: a presence
 * a sync socket owns is that socket's person (their name and colour from their account, never an agent, whatever
 * the window claims); one no socket owns counts only as an agent (crew presence, or the server's own agent ring).
 */
function cursorsNow(b: Board): CursorSample["who"] {
  const out: CursorSample["who"] = [];
  const owner = new Map<number, string>();
  for (const [ws, ids] of b.conns) {
    const uid = socketUserId(ws);
    for (const c of ids) owner.set(c, uid ?? "");
  }
  for (const [clientId, s] of b.awareness.getStates()) {
    const st = rec(s);
    if (!st) continue;
    const cursor = rec(st.cursor);
    const x = numOf(cursor?.x);
    const y = numOf(cursor?.y);
    if (owner.has(clientId)) {
      const uid = owner.get(clientId);
      const person = uid ? one<{ name: string; color: string | null }>("select name, color from users where id = ?", uid) : undefined;
      if (!person || x === null || y === null) continue;
      out.push({ n: clip(person.name, 80), ...(person.color ? { c: clip(person.color, 20) } : {}), x: Math.round(x), y: Math.round(y) });
      continue;
    }
    const user = rec(st.user);
    const crew = rec(st.crew);
    const n = clip(user?.name, 80);
    if (!n || !(crew || user?.agent === true)) continue;
    const target = idOf(rec(crew?.target)?.id);
    if (x !== null && y !== null) out.push({ n, x: Math.round(x), y: Math.round(y), a: 1 });
    else if (target) out.push({ n, a: 1, t: target });
  }
  return out;
}

function sampleCursors(l: Live) {
  if (!l.board.conns.size || l.board.doc.isDestroyed) {
    if (l.cursorTimer) clearInterval(l.cursorTimer);
    l.cursorTimer = null;
    return;
  }
  try {
    const key = JSON.stringify(cursorsNow(l.board));
    if (key === l.lastCursors) return;
    l.lastCursors = key;
    run("insert into timeline_cursors (board_id, at, json) values (?, ?, ?)", l.id, Date.now(), key);
  } catch {
    /* the board closed */
  }
}

function awarenessMoved(l: Live) {
  if (l.board.conns.size && !l.cursorTimer) {
    l.cursorTimer = actorScope.exit(() => setInterval(() => sampleCursors(l), cursorMs()));
    l.cursorTimer.unref?.();
  }
  if (l.hereQueued) return;
  l.hereQueued = true;
  queueMicrotask(() => {
    l.hereQueued = false;
    try {
      peopleHere(l);
    } catch (e) {
      console.error("timeline: couldn't keep who is here", e);
    }
  });
}

/** a person's first connection opens their span; their last closing ends it; back within a minute, it goes on */
function peopleHere(l: Live) {
  if (l.board.doc.isDestroyed) return;
  const now = Date.now();
  const on = new Set(whoIsOn(l.id).people.map((p) => p.id));
  for (const id of on) {
    if (l.here.has(id)) continue;
    const back = l.left.get(id);
    if (back && now - back.at < hereGraceMs()) {
      run("update timeline_events set end_at = null where id = ?", back.id);
      l.here.set(id, back.id);
      l.left.delete(id);
      continue;
    }
    const ev = recordEvent({ board: l.id, at: now, kind: "person.here", actor: { kind: "person", id, name: userName(id) ?? "Someone" }, text: "on the grid" });
    if (ev) l.here.set(id, ev);
  }
  for (const [id, ev] of l.here) {
    if (on.has(id)) continue;
    endEvent(ev, now);
    l.here.delete(id);
    l.left.set(id, { id: ev, at: now });
  }
  for (const [id, x] of l.left) if (now - x.at > hereGraceMs()) l.left.delete(id);
}

/** spans left open by a restart: ended at the grid's last kept change after them (or where they began) */
export function recoverOpenSpans(): number {
  const tracked = new Set<string>([...askSpans.values()]);
  for (const l of lives.values()) for (const id of l.here.values()) tracked.add(id);
  for (const id of runSpans.values()) tracked.add(id);
  const open = all<{ id: string; board_id: string; at: number; kind: string; ref_type: string | null; ref_id: string | null }>(
    `select id, board_id, at, kind, ref_type, ref_id from timeline_events where end_at is null and kind in (${SPAN_KINDS.map(() => "?").join(", ")})`,
    ...SPAN_KINDS,
  ).filter((e) => !tracked.has(e.id));
  for (const e of open) {
    const ran = e.ref_type === "run" && e.ref_id ? one<{ f: number | null }>("select finished_at as f from agent_runs where id = ?", e.ref_id)?.f : null;
    const last = one<{ at: number | null }>("select max(at) as at from timeline_updates where board_id = ? and at >= ?", e.board_id, e.at)?.at;
    run("update timeline_events set end_at = ? where id = ?", Math.max(e.at, ran ?? last ?? e.at), e.id);
  }
  return open.length;
}

function pruneCursors() {
  try {
    run("delete from timeline_cursors where at < ?", Date.now() - cursorDays() * 86_400_000);
  } catch (e) {
    console.error("timeline: couldn't prune old pointers", e);
  }
}

/** start keeping every grid's history and events, from the boards already open and each one as it opens (index.ts) */
export function startTimeline() {
  if (started) return;
  started = true;
  recoverOpenSpans();
  pruneCursors();
  setInterval(pruneCursors, 3600_000).unref();
  onBoardOpen((b) => {
    try {
      attach(b);
    } catch (e) {
      console.error("timeline: couldn't start keeping a grid", e);
    }
  });
  for (const id of liveBoardIds()) attach(getBoard(id));
  onBoardsClosed(() => {
    for (const l of [...lives.values()]) forget(l);
    for (const p of [...pendingReads.values()]) flushRead(p);
  });
}

/** tests: the grids being kept */
export function _liveTimelines(): string[] {
  return [...lives.keys()];
}

// ---------- behind the scenes: agents' tool calls ----------

const TOOL_WORDS: Record<string, string> = {
  read_board: "read the board",
  read_card: "read a card",
  search: "searched",
  set_plan: "set its plan",
  focus: "pointed something out",
  point_at: "pointed something out",
  bring_view: "brought someone's view to something",
  crew_work: "looked at its crew's work",
  search_tools: "looked for a tool",
  update_card: "changed a card",
  delete_card: "removed a card",
  move_card: "moved a card",
  read_timeline: "read the timeline",
  machine_run: "asked to run a command",
};
/** a tool's name in a few words: no argument values */
export function toolWords(name: string): string {
  if (TOOL_WORDS[name]) return TOOL_WORDS[name];
  const [verb, ...rest] = name.split("_");
  const thing = rest.join(" ");
  if (!thing) return `used ${name}`;
  const a = /^[aeiou]/.test(thing) ? "an" : "a";
  if (verb === "add") return `added ${a} ${thing}`;
  if (verb === "read") return `read ${thing}`;
  if (verb === "update" || verb === "set" || verb === "edit") return `changed ${thing}`;
  if (verb === "delete" || verb === "remove") return `removed ${thing}`;
  if (verb === "move") return `moved ${thing}`;
  return `used ${name.replace(/_/g, " ")}`;
}

interface PendingRead {
  key: string;
  ev: NewEvent;
  n: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingReads = new Map<string, PendingRead>();
/** how many tool calls each agent (by its crew id) has made, for its run's line */
const toolCounts = new Map<string, number>();

function flushRead(p: PendingRead) {
  clearTimeout(p.timer);
  pendingReads.delete(p.key);
  recordEvent({ ...p.ev, text: p.n > 1 ? `${p.ev.text} (${p.n} times)` : p.ev.text, data: { ...p.ev.data, ...(p.n > 1 ? { n: p.n } : {}) } });
}

/**
 * runTool (tools.ts), after an agent's call was allowed and ran: one event in the Behind the scenes lane. A
 * replayed request_id never gets here (runTool answers it before running). Reads by one agent with one tool are
 * one event per 30 s, counted. run_code is `agent.code`, with its length and never its text.
 */
export function recordToolCall(c: { board: string; tool: string; ok: boolean; actor: ScopeActor; read: boolean; target?: string | null; made?: string | null; requestKey?: string | null; codeLines?: number }) {
  try {
    if (c.actor.kind !== "agent") return;
    if (c.actor.id && toolCounts.has(c.actor.id)) toolCounts.set(c.actor.id, (toolCounts.get(c.actor.id) ?? 0) + 1);
    let object: string | null = null;
    let section: string | null = null;
    const l = lives.get(c.board);
    const m = (c.target || c.made) && l && !l.board.doc.isDestroyed ? boardMaps(l.board.doc) : null;
    if (m) {
      const o = (c.target ? m.objects.get(c.target) : undefined) ?? (c.made ? m.objects.get(c.made) : undefined);
      if (o) {
        object = o.id;
        section = o.sectionId;
      } else if (c.target && m.sections.has(c.target)) section = c.target;
    }
    const isCode = c.tool === "run_code";
    const ev: NewEvent = {
      board: c.board,
      at: Date.now(),
      actor: c.actor,
      section,
      object,
      kind: isCode ? "agent.code" : "agent.tool",
      text: isCode ? `ran a script of ${c.codeLines ?? 0} line${c.codeLines === 1 ? "" : "s"}` : toolWords(c.tool),
      // a label the caller gave itself (MCP ?as=) rides along as a claim; who it is comes from the session
      data: { ...(isCode ? { lines: c.codeLines ?? 0, ok: c.ok } : { tool: c.tool, ok: c.ok }), ...(c.actor.claim ? { as: c.actor.claim, claimed: true } : {}) },
      // only a call that worked takes its request_id: a failed one may be run again with the same id, and that try is shown too
      requestKey: c.ok ? (c.requestKey ?? null) : null,
    };
    if (!c.read || isCode || (c.ok && c.requestKey)) {
      recordEvent(ev);
      return;
    }
    const key = `${c.board}|${c.actor.kind}:${c.actor.id ?? c.actor.name}|${c.tool}|${c.ok}`;
    const had = pendingReads.get(key);
    if (had) {
      had.n++;
      return;
    }
    const p: PendingRead = { key, ev, n: 1, timer: actorScope.exit(() => setTimeout(() => flushRead(p), readCoalesceMs())) };
    p.timer.unref?.();
    pendingReads.set(key, p);
  } catch (e) {
    console.error("timeline: couldn't record a tool call", e);
  }
}

/** how many tool calls an agent (its crew id) has made so far */
export function toolCountOf(agentId: string | undefined): number {
  return agentId ? (toolCounts.get(agentId) ?? 0) : 0;
}

// ---------- agents' runs ----------

const runSpans = new Map<string, string>();

/** a run starts on a board (agent.ts startRun; T3 asks): its span, and the person's ask */
export function runStarted(r: { board: string; section?: string | null; runId: string; agent: { id: string; name: string }; user: { id: string; name: string }; ask?: { shown: boolean; body?: string } }) {
  const actor: Actor = { kind: "agent", id: r.agent.id, name: r.agent.name, for: r.user.name };
  if (r.ask) {
    recordEvent({
      board: r.board,
      section: r.section ?? null,
      kind: "chat.ask",
      actor: { kind: "person", id: r.user.id, name: r.user.name },
      text: `asked ${r.agent.name}`,
      ref: { type: "run", id: r.runId },
      data: { _run: r.runId, _by: r.user.id, _shown: r.ask.shown, ...(r.ask.body !== undefined ? { _body: r.ask.body } : {}) },
    });
  }
  toolCounts.set(r.agent.id, 0);
  const id = recordEvent({ board: r.board, section: r.section ?? null, kind: "agent.run", actor, text: `working for ${r.user.name}`, ref: { type: "run", id: r.runId } });
  if (id) runSpans.set(r.runId, id);
  return id;
}

/**
 * A run ends. `answer`: it said something back; `private`: it read beyond the grid (crew.ts `markPrivate`, the
 * rule its reasoning follows), so others on the grid don't get its words. The words stay in the run's own
 * transcript (agent_runs) and are read from there per reader.
 */
export function runEnded(r: { board: string; section?: string | null; runId: string; agent: { id: string; name: string }; user: { id: string; name: string }; answered: boolean; private: boolean; why?: "read" | "ask" }) {
  const steps = toolCountOf(r.agent.id);
  toolCounts.delete(r.agent.id);
  for (const p of [...pendingReads.values()]) if (p.ev.actor.id === r.agent.id) flushRead(p);
  endEvent(runSpans.get(r.runId), Date.now(), { text: `worked for ${r.user.name}: ${steps} step${steps === 1 ? "" : "s"}`, data: { steps } });
  runSpans.delete(r.runId);
  if (r.answered) {
    recordEvent({
      board: r.board,
      section: r.section ?? null,
      kind: "chat.answer",
      actor: { kind: "agent", id: r.agent.id, name: r.agent.name, for: r.user.name },
      text: `answered ${r.user.name}`,
      ref: { type: "run", id: r.runId },
      data: { _run: r.runId, _by: r.user.id, _private: r.private, ...(r.private && r.why ? { _why: r.why } : {}) },
    });
  }
}

// ---------- reading ----------

interface EventRow {
  /** the row's place in the order the server recorded (rowid) */
  n?: number;
  id: string;
  board_id: string;
  section_id: string | null;
  at: number;
  end_at: number | null;
  kind: string;
  actor_kind: TimelineActor["kind"];
  actor_id: string | null;
  actor_name: string;
  actor_for: string | null;
  object_id: string | null;
  text: string;
  ref_type: TimelineRef["type"] | null;
  ref_id: string | null;
  ref_within: string | null;
  data_json: string | null;
}

const NOT_YOURS_ANSWER = "It read beyond the grid while it worked: only the person it worked for reads its answer";
const NOT_YOURS_ANSWER_ASK = "It answered an ask only its person could read: only they read the answer";
const NOT_YOURS_ASK = "Only the person who asked reads what they asked";

function answerOf(runId: string): { by: string | null; prompt: string | null; text: string } {
  const r = one<{ created_by: string; prompt: string; transcript_json: string | null }>("select created_by, prompt, transcript_json from agent_runs where id = ?", runId);
  if (!r) return { by: null, prompt: null, text: "" };
  let text = "";
  try {
    const t = JSON.parse(r.transcript_json ?? "[]") as Array<{ type: string; text?: string }>;
    text = t
      .filter((e) => e.type === "text" && e.text)
      .map((e) => e.text!.trim())
      .filter(Boolean)
      .join("\n\n");
  } catch {
    /* no transcript */
  }
  return { by: r.created_by, prompt: r.prompt, text: text.length > 4000 ? `${text.slice(0, 3999)}…` : text };
}

/** one stored event as this reader gets it: the server's own keys never leave; an ask's and an answer's words only as far as they may */
function eventFor(r: EventRow, reader: UserInfo): TimelineEvent {
  const raw = r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : {};
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_")) data[k] = v;
  let withheld: string | undefined;
  if (r.kind === "chat.ask" || r.kind === "chat.answer") {
    const runId = String(raw._run ?? "");
    const mine = raw._by === reader.id;
    if (r.kind === "chat.ask") {
      if (raw._shown || mine) {
        const body = typeof raw._body === "string" ? raw._body : runId ? answerOf(runId).prompt : null;
        if (body) data.body = body;
      } else withheld = NOT_YOURS_ASK;
    } else if (!raw._private || mine) {
      const a = runId ? answerOf(runId).text : "";
      if (a) data.body = a;
    } else withheld = raw._why === "ask" ? NOT_YOURS_ANSWER_ASK : NOT_YOURS_ANSWER;
  }
  return {
    id: r.id,
    board: r.board_id,
    section: r.section_id,
    at: r.at,
    ...(SPAN_KINDS.includes(r.kind) ? { end: r.end_at } : {}),
    kind: r.kind,
    actor: { kind: r.actor_kind, ...(r.actor_id ? { id: r.actor_id } : {}), name: r.actor_name, ...(r.actor_for ? { for: r.actor_for } : {}) },
    ...(r.object_id ? { object: r.object_id } : {}),
    text: r.text,
    ...(r.ref_type && r.ref_id ? { ref: { type: r.ref_type, id: r.ref_id, ...(r.ref_within ? { within: r.ref_within } : {}) } } : {}),
    ...(Object.keys(data).length ? { data } : {}),
    ...(withheld ? { withheld } : {}),
  };
}

/** the sections a section's timeline covers: itself and every section inside it, as the grid is now */
function sectionsUnder(doc: Y.Doc, section: string): Set<string> {
  const out = new Set([section]);
  const secs = [...boardMaps(doc).sections.values()];
  for (let grew = true, n = 0; grew && n < 32; n++) {
    grew = false;
    for (const s of secs) if (typeof s?.parent === "string" && typeof s.id === "string" && out.has(s.parent) && !out.has(s.id)) (out.add(s.id), (grew = true));
  }
  return out;
}

/** ChatForm messages on this grid, for this reader only: in a conversation with a chat card here (on this server), or sent with a link to this grid */
function chatMessages(reader: UserInfo, boardId: string, doc: Y.Doc, from: number, to: number, limit: number, under: Set<string> | null): TimelineEvent[] {
  const cards = new Map<string, string>();
  for (const raw of boardMaps(doc).objects.values()) {
    const o = rec(raw);
    const ch = idOf(o?.channel);
    if (o && o.kind === "panel" && o.panel === "chat" && ch && !o.chatServer && !cards.has(ch)) cards.set(ch, idOf(o.sectionId) ?? "");
  }
  const chans = [...cards.keys()];
  const rows = all<{ id: string; channel_id: string; created_at: number; author_json: string; author_kind: string; text: string; extra_json: string | null; root_id: string | null }>(
    `select id, channel_id, created_at, author_json, author_kind, text, extra_json, root_id from chat_messages
      where deleted_at is null and type not in ('system', 'draft') and created_at > ? and created_at <= ?
        and (${chans.length ? `channel_id in (${chans.map(() => "?").join(", ")}) or ` : ""}(extra_json like ? escape '!' and json_extract(extra_json, '$.place.board') = ?))
      order by created_at desc limit ?`,
    from,
    to,
    ...chans,
    `%${boardId.replace(/[!%_]/g, (x) => `!${x}`)}%`,
    boardId,
    limit,
  );
  const seen = new Map<string, ReturnType<typeof getChannel> | null>();
  const out: TimelineEvent[] = [];
  for (const r of rows) {
    if (!seen.has(r.channel_id)) {
      const ch = getChannel(r.channel_id);
      seen.set(r.channel_id, ch && canSeeChannel(reader, ch) ? ch : null);
    }
    const ch = seen.get(r.channel_id);
    if (!ch) continue; // not a member: the event isn't there at all
    let place: { board?: string; section?: string } | undefined;
    try {
      place = r.extra_json ? (JSON.parse(r.extra_json) as { place?: { board?: string; section?: string } }).place : undefined;
    } catch {
      /* none */
    }
    const section = place?.board === boardId && place.section ? place.section : (cards.get(r.channel_id) || null);
    if (under && (!section || !under.has(section))) continue;
    let author: { kind?: string; id?: string; name?: string } = {};
    try {
      author = JSON.parse(r.author_json) as typeof author;
    } catch {
      /* the row's own */
    }
    const where = ch.kind === "open" && ch.name ? `#${ch.name}` : ch.kind === "dm" || ch.kind === "group" ? "a direct conversation" : ch.name ? `#${ch.name}` : "a conversation";
    out.push({
      id: `chat:${r.id}`,
      board: boardId,
      section,
      at: r.created_at,
      kind: "chat.message",
      actor: { kind: author.kind === "person" ? "person" : author.kind === "agent" ? "agent" : "system", ...(author.id ? { id: author.id } : {}), name: author.name ?? "Someone" },
      text: `wrote in ${where}`,
      ref: { type: "chat", id: r.id, within: r.channel_id },
      data: { body: r.text },
    });
  }
  return out;
}

/** huddles held on this grid (its own huddle cards, or a channel's taken to it), as far as this reader may see each session */
function huddleSpans(reader: UserInfo, boardId: string, doc: Y.Doc, from: number, to: number, under: Set<string> | null): TimelineEvent[] {
  const rows = all<{ id: string; huddle_id: string; board_id: string; started_at: number; ended_at: number | null }>(
    `select id, huddle_id, board_id, started_at, ended_at from huddle_sessions
      where started_at <= ? and (ended_at is null or ended_at >= ?)
        and (board_id = ? or id in (select session_id from huddle_events where type = 'placed' and board_id = ?))
      order by started_at limit 200`,
    to,
    from,
    boardId,
    boardId,
  );
  const out: TimelineEvent[] = [];
  for (const r of rows) {
    const s = sessionFor(reader, r.id);
    if (!s) continue;
    const section =
      r.board_id === boardId
        ? (idOf(rec(boardMaps(doc).objects.get(r.huddle_id))?.sectionId) ?? null)
        : (one<{ section_id: string | null }>("select section_id from huddle_events where session_id = ? and type = 'placed' and board_id = ? order by at limit 1", r.id, boardId)?.section_id ?? null);
    if (under && (!section || !under.has(section))) continue;
    const people = s.people ?? [];
    out.push({
      id: `huddle:${r.id}`,
      board: boardId,
      section,
      at: r.started_at,
      end: r.ended_at,
      kind: "huddle",
      actor: { kind: "person", name: people[0] ?? "Someone" },
      text: people.length ? `a huddle with ${people.join(", ")}` : "a huddle",
      ref: { type: "huddle", id: r.id },
    });
  }
  return out;
}

/** when keeping began for this grid (null: not yet) */
function startOf(boardId: string): number | null {
  return one<{ at: number | null }>("select min(at) as at from timeline_base where board_id = ?", boardId)?.at ?? null;
}

/** the grid, loaded (a read never writes it: loading only reads its log) */
function liveDoc(boardId: string): Y.Doc {
  return getBoard(boardId).doc;
}

export interface SliceQuery {
  section?: string | null;
  from: number;
  to: number;
  limit?: number;
}

/** the timeline of a grid (or a section of it) for one reader: who may read what is in docs/timeline.md "Who may read what" */
export function timelineFor(reader: UserInfo, boardId: string, qy: SliceQuery): TimelineSlice {
  flushBoard(boardId);
  const from = qy.from;
  const to = qy.to;
  const limit = Math.max(1, Math.min(2000, Math.floor(qy.limit ?? 500)));
  const doc = liveDoc(boardId);
  const section = qy.section || null;
  const under = section ? sectionsUnder(doc, section) : null;
  const inSec = under ? ` and section_id in (${[...under].map(() => "?").join(", ")})` : "";
  const secArgs = under ? [...under] : [];
  const rows = all<EventRow>(`select rowid as n, * from timeline_events where board_id = ? and at >= ? and at <= ?${inSec} order by at desc, rowid desc limit ?`, boardId, from, to, ...secArgs, limit + 1);
  // spans that began before the range and were still going in it
  const spans = all<EventRow>(
    `select rowid as n, * from timeline_events where board_id = ? and kind in (${SPAN_KINDS.map(() => "?").join(", ")}) and at < ? and (end_at is null or end_at >= ?)${inSec} order by at desc, rowid desc limit ?`,
    boardId,
    ...SPAN_KINDS,
    from,
    from,
    ...secArgs,
    limit,
  );
  // one order, the same for every reader and every read: time, then the order the server recorded them in
  const order = new Map<string, number>();
  for (const r of [...rows, ...spans]) order.set(r.id, r.n ?? 0);
  let events = [...rows, ...spans].map((r) => eventFor(r, reader));
  events.push(...chatMessages(reader, boardId, doc, from, to, limit + 1, under), ...huddleSpans(reader, boardId, doc, from, to, under));
  events.sort((a, b) => a.at - b.at || (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const more = events.length > limit;
  if (more) events = events.slice(events.length - limit);

  // the bar's texture: the grid's kept changes, or a section's change events
  const span = Math.max(1, to - from);
  const density = new Array<number>(DENSITY_STEPS).fill(0);
  const buckets = under
    ? all<{ b: number; n: number }>(
        `select cast((at - ?) * ${DENSITY_STEPS} / ? as integer) as b, count(*) as n from timeline_events where board_id = ? and at >= ? and at <= ? and kind in (${CHANGE_KINDS.map(() => "?").join(", ")})${inSec} group by b`,
        from,
        span,
        boardId,
        from,
        to,
        ...CHANGE_KINDS,
        ...secArgs,
      )
    : all<{ b: number; n: number }>(`select cast((at - ?) * ${DENSITY_STEPS} / ? as integer) as b, count(*) as n from timeline_updates where board_id = ? and at >= ? and at <= ? group by b`, from, span, boardId, from, to);
  for (const r of buckets) density[Math.min(DENSITY_STEPS - 1, Math.max(0, r.b))] += r.n;

  // the sections named: as they are called now, or were when an event last saw them
  const secs = boardMaps(doc).sections;
  const ids = new Set<string>();
  if (section) ids.add(section);
  for (const e of events) if (e.section) ids.add(e.section);
  const sections: TimelineSlice["sections"] = [];
  for (const id of ids) {
    const now = secs.get(id);
    if (now) {
      sections.push({ id, name: clip(rec(now)?.name, 200) || "a section" });
      continue;
    }
    const last = one<{ data_json: string | null; kind: string }>("select data_json, kind from timeline_events where board_id = ? and section_id = ? and data_json is not null order by at desc limit 1", boardId, id);
    let name = "a section";
    try {
      const d = last?.data_json ? (JSON.parse(last.data_json) as { name?: string; _sn?: string }) : {};
      name = (last?.kind.startsWith("section.") ? d.name : d._sn) ?? d._sn ?? name;
    } catch {
      /* the default */
    }
    sections.push({ id, name, gone: true });
  }
  const now = Date.now();
  return { board: boardId, section, from, to, start: startOf(boardId) ?? now, now, events, density, sections, ...(more ? { more: true } : {}) };
}

/** the timeline as short lines, for an agent (read_timeline); `words` says whether a conversation's or an answer's words are in it */
export function timelineText(reader: UserInfo, boardId: string, qy: SliceQuery): { text: string; words: boolean } {
  const s = timelineFor(reader, boardId, qy);
  const names = new Map(s.sections.map((x) => [x.id, x.gone ? `${x.name} (gone)` : x.name]));
  const utc = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
  let words = false;
  const lines = s.events.map((e) => {
    const where = e.section ? ` in “${names.get(e.section) ?? e.section}”` : "";
    const who = `${e.actor.name}${e.actor.kind === "agent" ? ` (agent${e.actor.for ? `, for ${e.actor.for}` : ""})` : ""}`;
    const end = e.end === null ? " (still going)" : e.end ? ` until ${utc(e.end)}` : "";
    const body = typeof e.data?.body === "string" ? e.data.body : null;
    if (body && (e.kind === "chat.message" || e.kind === "chat.answer")) words = true;
    return `[${utc(e.at)}] ${who} ${e.text}${where}${end}${body ? `: ${clip(body, 300)}` : ""}${e.withheld ? ` (${e.withheld})` : ""}`;
  });
  const head = `Timeline of “${boardId}”${s.section ? ` › ${names.get(s.section) ?? s.section}` : ""}, ${utc(s.from)}–${utc(s.to)} UTC. History begins ${utc(s.start)} UTC.${s.more ? " Only the newest are listed: ask for a shorter stretch for the rest." : ""}`;
  return { text: `${head}\n\n${lines.join("\n") || "(nothing happened in this stretch)"}`, words };
}

/** the boards at a moment, rebuilt lately (key: board, base, the last change in it), newest last */
const historyCache = new Map<string, Uint8Array>();
const HISTORY_CACHE_ITEMS = 8;
const HISTORY_CACHE_ITEM_BYTES = 8 * 1024 * 1024;

/**
 * The grid as it was: its state at `from` as the base, then the kept changes up to `to`, thinned to at most
 * `steps` (neighbours merged with Y.mergeUpdates; each step keeps the time of its last change), and the pointers
 * kept for the stretch (thinned to at most HISTORY_CURSORS). Before `start` nothing is known: `from` is clamped.
 * Reading writes nothing to the board: the base is rebuilt on a scratch document.
 */
export function historyFor(boardId: string, from: number, to: number, steps = HISTORY_STEPS): TakeFrames {
  flushBoard(boardId);
  let start = startOf(boardId);
  if (start === null) {
    liveDoc(boardId);
    start = startOf(boardId);
  }
  if (start === null) {
    // not kept here (the timeline isn't running): only the present is known
    const now = Date.now();
    const head: HistoryHead = { id: `history:${boardId}`, board: boardId, section: null, from: now, to: now, updates: 0, truncated: null, start: now };
    return { head, base: Y.encodeStateAsUpdate(liveDoc(boardId)), updates: [], cursors: [] };
  }
  const f = Math.max(from, start);
  const t = Math.max(to, f);
  const base =
    one<{ at: number; upto: number; blob: Uint8Array }>("select at, upto, blob from timeline_base where board_id = ? and at <= ? order by at desc, upto desc limit 1", boardId, f) ??
    one<{ at: number; upto: number; blob: Uint8Array }>("select at, upto, blob from timeline_base where board_id = ? order by at, upto limit 1", boardId)!;
  // what this answer would carry: refused with a sentence when it can't fit (thinning merges, it doesn't shrink much)
  const tail = one<{ n: number; b: number; last: number | null }>("select count(*) as n, coalesce(sum(length(blob)), 0) as b, max(seq) as last from timeline_updates where board_id = ? and seq > ? and at <= ?", boardId, base.upto, f)!;
  const stretch = one<{ b: number }>("select coalesce(sum(length(blob)), 0) as b from timeline_updates where board_id = ? and seq > ? and at > ? and at <= ?", boardId, base.upto, f, t)!.b;
  const cap = historyMaxBytes();
  if (base.blob.length + tail.b + stretch > cap * 1.5 || stretch > cap) {
    throw new HttpError(413, `This stretch of the grid's history holds ${Math.round(stretch / 1048576)} MB of changes, more than one answer carries (${Math.round(cap / 1048576)} MB): ask for a shorter stretch.`);
  }
  // the board at `from`: the nearest base before it (a checkpoint, so the tail is short), and a small cache by what it holds
  const key = `${boardId}|${base.upto}|${tail.last ?? base.upto}`;
  let baseAt = historyCache.get(key);
  if (baseAt) {
    historyCache.delete(key);
    historyCache.set(key, baseAt);
  } else {
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, base.blob);
    if (tail.n) for (const u of db.prepare("select blob from timeline_updates where board_id = ? and seq > ? and at <= ? order by seq").iterate(boardId, base.upto, f) as Iterable<{ blob: Uint8Array }>) Y.applyUpdate(scratch, u.blob);
    baseAt = Y.encodeStateAsUpdate(scratch);
    scratch.destroy();
    if (baseAt.length <= HISTORY_CACHE_ITEM_BYTES) {
      historyCache.set(key, baseAt);
      if (historyCache.size > HISTORY_CACHE_ITEMS) historyCache.delete(historyCache.keys().next().value!);
    }
  }

  const count = one<{ n: number }>("select count(*) as n from timeline_updates where board_id = ? and seq > ? and at > ? and at <= ?", boardId, base.upto, f, t)?.n ?? 0;
  const per = Math.max(1, Math.ceil(count / Math.max(1, steps)));
  const updates: TakeFrames["updates"] = [];
  let group: Uint8Array[] = [];
  let groupAt = 0;
  for (const u of db.prepare("select at, blob from timeline_updates where board_id = ? and seq > ? and at > ? and at <= ? order by seq").iterate(boardId, base.upto, f, t) as Iterable<{ at: number; blob: Uint8Array }>) {
    group.push(new Uint8Array(u.blob));
    groupAt = u.at;
    if (group.length >= per) {
      updates.push({ at: groupAt, update: group.length === 1 ? group[0] : Y.mergeUpdates(group) });
      group = [];
    }
  }
  if (group.length) updates.push({ at: groupAt, update: group.length === 1 ? group[0] : Y.mergeUpdates(group) });

  const nCursors = one<{ n: number }>("select count(*) as n from timeline_cursors where board_id = ? and at > ? and at <= ?", boardId, f, t)?.n ?? 0;
  const cursorRows =
    nCursors <= HISTORY_CURSORS
      ? all<{ at: number; json: string }>("select at, json from timeline_cursors where board_id = ? and at > ? and at <= ? order by at, rowid", boardId, f, t)
      : all<{ at: number; json: string }>(
          "select min(at) as at, json from timeline_cursors where board_id = ? and at > ? and at <= ? group by cast((at - ?) / ? as integer) order by at",
          boardId,
          f,
          t,
          f,
          Math.max(1, Math.ceil((t - f) / HISTORY_CURSORS)),
        );
  const cursors: CursorSample[] = cursorRows.map((c) => ({ at: c.at, who: JSON.parse(c.json) as CursorSample["who"] }));
  const head: HistoryHead = { id: `history:${boardId}:${f}:${t}`, board: boardId, section: null, from: f, to: t, updates: updates.length, truncated: null, start, ...(per > 1 ? { thinned: per } : {}) };
  return { head, base: baseAt, updates, cursors };
}

// ---------- routes ----------

/** a grid this person may see, or 404 (a members-only grid answers like a missing one) */
function seeBoard(user: UserInfo, boardId: string) {
  if (!one("select 1 from boards where id = ?", boardId) || !canSeeBoard(user, boardId)) throw new HttpError(404, "no such board");
}

/** how far past now `to` may reach (a client's clock a little ahead); `from` before keeping began is fine: nothing is there */
const MAX_AHEAD_MS = 86_400_000;

function rangeOf(query: URLSearchParams): { from: number; to: number } {
  const now = Date.now();
  const n = (k: string) => {
    const v = query.get(k);
    if (v === null || v === "") return undefined;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new HttpError(400, `${k} is a time in ms since 1970`);
    return Math.floor(x);
  };
  const to = n("to") ?? now;
  const from = n("from") ?? to - 86_400_000;
  if (!(from < to)) throw new HttpError(400, "from comes before to");
  if (to > now + MAX_AHEAD_MS) throw new HttpError(400, "to is a moment that has been, or now");
  return { from, to };
}

export function timelineRoutes(r: Router) {
  r.get("/api/boards/:id/timeline", (req) => {
    const u = requireUser(req);
    seeBoard(u, req.params.id);
    const { from, to } = rangeOf(req.query);
    const rawLimit = req.query.get("limit");
    const limit = rawLimit === null || rawLimit === "" ? 500 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new HttpError(400, "limit is 1 to 2000");
    const section = req.query.get("section") || null;
    if (section && (section.length > 80 || !/^[\w:*.-]+$/.test(section))) throw new HttpError(400, "section is a section's id");
    return timelineFor(u, req.params.id, { section: section === "*" ? null : section, from, to, limit });
  });
  r.get("/api/boards/:id/history", (req, res) => {
    const u = requireUser(req);
    seeBoard(u, req.params.id);
    const { from, to } = rangeOf(req.query);
    const body = Buffer.from(encodeTake(historyFor(req.params.id, from, to)));
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length), "cache-control": "no-store" });
    res.end(body);
    return undefined;
  });
}

/** a section of this grid, by its id or name (read_timeline) */
export function sectionRef(boardId: string, ref: string | undefined): string | null {
  if (!ref) return null;
  return findSection(liveDoc(boardId), ref)?.id ?? ref;
}

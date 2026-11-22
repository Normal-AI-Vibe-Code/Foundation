/**
 * SQLite through node:sqlite (no native build step). One file under
 * FOUNDATION_DATA_DIR holds users, sessions, board update logs, files, the
 * full-text index, apps, asks and agent runs.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, "files"), { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, "foundation.db"));

/** set when the search index was rebuilt; files.ts re-extracts file text */
export let needsFileReindex = false;

db.exec(`
pragma journal_mode = wal;
pragma synchronous = normal;
pragma foreign_keys = on;

create table if not exists users (
  id text primary key,
  email text unique not null,
  name text not null,
  color text not null,
  role text not null default 'member',
  created_at integer not null
);

create table if not exists sessions (
  token text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
);

-- One-time WebSocket tickets (sockets.ts): a client that can't send its
-- session on a socket (the desktop app on a hosted server, where the cookie is
-- cross-site and a WebSocket can't carry a header) trades its bearer for one
-- of these and puts it in the socket's URL. It is never the session: only its
-- sha256 is kept, it lives 30 seconds, it opens the one socket path it was
-- issued for, and it is deleted as it is read.
create table if not exists ws_tickets (
  ticket_hash text primary key,
  session_hash text not null,
  user_id text not null references users(id) on delete cascade,
  path text not null,
  created_at integer not null,
  expires_at integer not null
);

create table if not exists boards (
  id text primary key,
  name text not null,
  created_at integer not null,
  updated_at integer not null
);

-- Yjs updates, appended; compacted into one row per board when it grows
create table if not exists board_updates (
  seq integer primary key autoincrement,
  board_id text not null,
  update_blob blob not null,
  at integer not null
);
create index if not exists board_updates_board on board_updates(board_id, seq);

-- uploaded media is archived, never deleted (carried over from flowform-server)
create table if not exists files (
  id text primary key,
  board_id text,
  name text not null,
  mime text not null,
  size integer not null,
  sha256 text not null,
  uploaded_by text,
  created_at integer not null,
  archived_at integer
);


create table if not exists apps (
  id text primary key,
  name text not null,
  url text,
  repo text,
  mcp text,
  description text,
  ports_json text not null default '[]',
  created_by text,
  created_at integer not null
);

-- A person's leave for agents to call one tool of one saved app, on one board
-- (apptools.ts, ADR-001 G3). Keyed by the board it was given on and by the
-- tool's definition as it was listed when they pressed Allow (sha256 of name,
-- description and input schema): another board, or a tool whose definition
-- changes, needs a new press.
create table if not exists app_tool_allowances (
  board_id text not null,
  app_id text not null,
  tool text not null,
  def_hash text not null,
  allowed_by text not null,
  allowed_by_name text not null,
  allowed_at integer not null,
  primary key (board_id, app_id, tool, def_hash)
);

create table if not exists asks (
  id text primary key,
  board_id text not null,
  panel_id text,
  assignee text not null,
  kind text not null,
  prompt text not null,
  status text not null default 'open',
  created_by text not null,
  created_at integer not null,
  due_at integer,
  last_nudged_at integer,
  resolved_file_id text
);

create table if not exists vision_handoffs (
  id text primary key,
  board_id text not null,
  section_id text,
  brief_note text,
  title text not null,
  folder text not null,
  thread_id text,
  thread_url text,
  reviewers_json text not null default '[]',
  seen_json text not null default '[]',
  reviewed integer not null default 0,
  status text not null,
  created_by text not null,
  created_at integer not null
);

create table if not exists board_roles (
  board_id text not null,
  user_id text not null references users(id) on delete cascade,
  role text not null,
  set_by text,
  set_at integer not null,
  primary key (board_id, user_id)
);

create table if not exists agent_runs (
  id text primary key,
  board_id text not null,
  runtime text not null,
  prompt text not null,
  status text not null,
  transcript_json text not null default '[]',
  input_tokens integer default 0,
  output_tokens integer default 0,
  created_by text,
  created_at integer not null,
  finished_at integer
);

-- Who may open a board. A board with no rows is open to every signed-in
-- person (the company board); a board with rows is members-only (admins and
-- the service token always pass). Roles are flowform's room roles.
create table if not exists board_members (
  board_id text not null,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  source text not null default 'foundation',
  added_at integer not null,
  primary key (board_id, user_id)
);
create index if not exists board_members_user on board_members(user_id);

-- The flowform importer's ledger: what each flowform thing became here, the
-- hash of the source it was made from, and the hash of what was written (a
-- re-run only rewrites what nobody has changed in Foundation since).
create table if not exists flowform_imports (
  kind text not null,
  flowform_id text not null,
  foundation_id text not null,
  source_hash text not null,
  written_hash text,
  imported_at integer not null,
  primary key (kind, flowform_id)
);

-- Sign-ins in flight through flowform (flowform.ts): kept here, not in
-- memory, so a server restart mid-sign-in doesn't make the person click
-- again. Every secret is stored as its sha256 (only ever compared): the
-- callback nonce, the web browser's binding cookie, the desktop poll secret.
-- A row lives 10 minutes and is consumed once.
create table if not exists flowform_attempts (
  nonce_hash text primary key,
  mode text not null check (mode in ('web', 'desktop')),
  browser_hash text,
  poll_hash text unique,
  return_to text not null default '/',
  created_at integer not null,
  expires_at integer not null,
  used_at integer,
  result_user_id text,
  result_error text
);

-- The daily digest (digest.ts): one row per board per local day. The note it
-- wrote (null once that note was reused for a newer day), the window its
-- activity covers, and what it saw: the board's sections and cards and every
-- connector's reading, which the next day compares with. Only the newest
-- row keeps its JSON; older rows are just the record of the day.
create table if not exists digest_days (
  board_id text not null,
  day text not null,
  note_id text,
  since integer not null,
  written_at integer not null,
  base_json text,
  seen_json text,
  primary key (board_id, day)
);

create table if not exists jobs (
  id text primary key,
  kind text not null,
  target text not null,
  goal text not null default '',
  board_id text,
  status text not null,
  output text not null default '',
  created_by text,
  created_at integer not null,
  finished_at integer
);
`);

// Full-text index. unicode61 without stemming: people type prefixes of part
// numbers and app names ("factory" → FactoryForm, "0330" → 03304-10027), and a
// stemmer turns query prefixes into stems that no longer match.
const FTS_SQL = `create virtual table search_fts using fts5(
  source unindexed, ref unindexed, board_id unindexed, title, body,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3 4'
)`;
{
  const existing = db.prepare("select sql from sqlite_master where name = 'search_fts'").get() as { sql: string } | undefined;
  if (existing && existing.sql.includes("porter")) {
    db.exec("drop table search_fts");
    console.log("search index: rebuilt without stemming (boards re-index on load; files re-index below)");
  }
  if (!existing || existing.sql.includes("porter")) {
    try {
      db.exec(FTS_SQL);
    } catch (e) {
      // Node before 22.16 ships a SQLite without FTS5: say that, not "SQL logic error" (scripts/node-check.mjs)
      if (/fts5/i.test((e as Error).message))
        throw new Error(
          `Foundation's server needs Node 22.16 or newer (this is ${process.versions.node}): its SQLite has no full-text search (FTS5). Install a newer Node and start again.`,
        );
      throw e;
    }
    needsFileReindex = Boolean(existing);
  }
}

// app-tool leave was once keyed by app, tool and definition alone: rebuilt keyed by board too, each row
// keeping the board it was given on (a row with no board recorded applies to no board, so it isn't kept)
export function rekeyAppToolLeave(d: DatabaseSync) {
  if ((d.prepare("pragma table_info(app_tool_allowances)").all() as Array<{ name: string; pk: number }>).some((c) => c.name === "board_id" && c.pk > 0)) return;
  d.exec(`
    begin;
    alter table app_tool_allowances rename to app_tool_allowances_unboarded;
    create table app_tool_allowances (
      board_id text not null,
      app_id text not null,
      tool text not null,
      def_hash text not null,
      allowed_by text not null,
      allowed_by_name text not null,
      allowed_at integer not null,
      primary key (board_id, app_id, tool, def_hash)
    );
    insert or ignore into app_tool_allowances (board_id, app_id, tool, def_hash, allowed_by, allowed_by_name, allowed_at)
      select board_id, app_id, tool, def_hash, allowed_by, allowed_by_name, allowed_at from app_tool_allowances_unboarded where board_id is not null;
    drop table app_tool_allowances_unboarded;
    commit;
  `);
}
rekeyAppToolLeave(db);

// additive migrations — each is idempotent
for (const sql of [
  "alter table asks add column stage_panel_id text",
  // spaces (2026-11-10): a board is a space; its canvas is a grid, a deck of slides or a web page (url),
  // and it may sit in a project folder ("Fans/Rim drive"); null kind = grid, null folder = loose
  "alter table boards add column kind text",
  "alter table boards add column folder text",
  "alter table boards add column url text",
  // grids of grids (2026-11-15): a grid may sit inside another; null parent = at the top of All Grids
  "alter table boards add column parent text",
  // themes and apps (2026-11-18): a grid may pin its own look ('day' | 'night'; null = paper, following the orb),
  // and a space may be an app opened as a tab (kind 'app'): `app` names it ('t3', or null for one at a url)
  "alter table boards add column theme text",
  "alter table boards add column app text",
  "alter table users add column flowform_user_id text",
  // agent sessions: each tab is its own conversation, resumable after a restart
  "alter table agent_runs add column session_id text",
  "alter table agent_runs add column claude_session text",
  "create index if not exists agent_runs_session on agent_runs(session_id, created_at)",
  // what a session is for: 'browser' (the sign-in cookie), 'app' (a person's app holding a bearer), 'agent' (/api/agent/token); null = before kinds
  "alter table sessions add column kind text",
  // files: what an import said about where it came from (kept so a re-index keeps it), and the text
  // read out of documents, by content (filetext.ts)
  "alter table files add column about text",
  // a socket ticket says whether a person asked for it (1) or an agent did (0; null: before this): a machine's
  // terminal and desktop take input from a person only (sockets.ts)
  "alter table ws_tickets add column person integer",
  // a desktop sign-in is like a device sign-in (flowform.ts): the code the window shows, the finishing
  // browser's press cookie (hashed), and when the person pressed "This is me"
  "alter table flowform_attempts add column code text",
  "alter table flowform_attempts add column confirm_hash text",
  "alter table flowform_attempts add column confirmed_at integer",
  // what a job's card showed when it was queued (jobs.ts shownHash): Run must name it, and the row must still match
  "alter table jobs add column shown_hash text",
  "alter table files add column width integer",
  "alter table files add column height integer",
  "create index if not exists files_sha on files(sha256)",
  `create table if not exists file_text (
     sha256 text primary key, v integer not null, status text not null,
     text text not null default '', error text, at integer not null
   )`,
]) {
  try {
    db.exec(sql);
  } catch {
    /* already applied */
  }
}

export type Row = Record<string, unknown>;

/**
 * Statements are compiled once and kept by their SQL text: compiling one on every call was 7.6 % of the
 * server's busy time (profiled 2026-11-20). Each call below runs a statement to its end before returning,
 * so one statement is never in use twice, and SQLite recompiles a kept statement itself when the schema
 * changes. The oldest is dropped past STATEMENTS_KEPT, for SQL built with a varying number of placeholders.
 */
const STATEMENTS_KEPT = 500;
const statements = new Map<string, StatementSync>();

function statement(sql: string): StatementSync {
  let st = statements.get(sql);
  if (st) return st;
  st = db.prepare(sql);
  if (statements.size >= STATEMENTS_KEPT) statements.delete(statements.keys().next().value as string);
  statements.set(sql, st);
  return st;
}

/** how many statements are kept (for tests) */
export const keptStatements = () => statements.size;

export function one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return statement(sql).get(...(params as never[])) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return statement(sql).all(...(params as never[])) as T[];
}

export function run(sql: string, ...params: unknown[]) {
  return statement(sql).run(...(params as never[]));
}

/** Replace a document in the full-text index. */
export function indexDoc(source: string, ref: string, boardId: string | null, title: string, body: string) {
  run("delete from search_fts where source = ? and ref = ?", source, ref);
  run(
    "insert into search_fts (source, ref, board_id, title, body) values (?, ?, ?, ?, ?)",
    source,
    ref,
    boardId,
    title,
    body.slice(0, 200_000),
  );
}

/** take a document out of the index; with `boardId`, only that board's entry (a card that moved to another grid keeps its id) */
export function unindexDoc(source: string, ref: string, boardId?: string) {
  if (boardId !== undefined) run("delete from search_fts where source = ? and ref = ? and board_id = ?", source, ref, boardId);
  else run("delete from search_fts where source = ? and ref = ?", source, ref);
}

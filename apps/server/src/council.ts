/**
 * The council's conversation, kept (plan *council-replies-in-panel*, 2026-11-27). A line to a council (a
 * section's, or the grid's) starts an ask for each agent it went to; until now the line lived in the window
 * that said it and each answer only in its agent's session. Here each line is kept per grid and place, with
 * the sessions it started, and read back with each agent's answer, so the agents panel's Council tab shows the
 * whole conversation after a reload and to everyone on the grid.
 *
 * What holds:
 *  - who said a line is the session's to say (the person signed in), never the request's;
 *  - only someone who may change the grid says something to its council (a viewer reads);
 *  - an answer reaches a reader by the timeline's rule (timeline.ts `answerFor`): the person it worked for
 *    always, anyone else on the grid only if its run read nothing beyond the grid and its ask was shown;
 *  - a session named by a line counts only for runs that person started on this grid, after the line: a
 *    request can't point a line at someone else's run;
 *  - the same `request_id` twice keeps one line.
 */

import { randomBytes } from "node:crypto";
import type { UserInfo } from "@foundation/protocol";
import { all, db, one, run } from "./db.ts";
import { HttpError } from "./http.ts";
import { answerFor } from "./timeline.ts";

db.exec(`
create table if not exists council_lines (
  id text primary key,
  board_id text not null,
  place text not null,
  text text not null,
  to_json text not null,
  all_seats integer not null default 0,
  sessions_json text not null default '[]',
  by_user text not null,
  by_name text not null,
  request_id text,
  at integer not null
);
create index if not exists council_lines_place on council_lines (board_id, place, at);
create unique index if not exists council_lines_request on council_lines (board_id, by_user, request_id);
`);

/** at most this many lines a place keeps answering with (the oldest go first) */
const KEEP = 200;
/** a run counts for a line if it started no earlier than this before the line was written (the line is written after the asks go) */
const BEFORE_MS = 30_000;

export interface CouncilSeatAsk {
  /** the seat's name, as the line was said to it */
  name: string;
  /** the agent session the ask started (the server's own agent); none for an agent that keeps its own thread (T3) */
  session?: string;
}

export interface CouncilLineInput {
  place: string;
  text: string;
  to: CouncilSeatAsk[];
  all?: boolean;
  request_id?: string;
}

export interface CouncilReply {
  name: string;
  /** working: its run hasn't ended; answered: what it said (or why this reader can't read it); none: it ended without a word; elsewhere: its answer is in its own thread */
  state: "waiting" | "working" | "answered" | "none" | "elsewhere";
  text?: string;
  withheld?: string;
  session?: string;
}

export interface CouncilLine {
  id: string;
  place: string;
  text: string;
  by: string;
  mine: boolean;
  at: number;
  all: boolean;
  replies: CouncilReply[];
}

interface Row {
  id: string;
  board_id: string;
  place: string;
  text: string;
  to_json: string;
  all_seats: number;
  sessions_json: string;
  by_user: string;
  by_name: string;
  at: number;
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

/** keep a line said to a council; `by` is the person signed in */
export function addCouncilLine(boardId: string, by: UserInfo, input: CouncilLineInput): CouncilLine {
  const place = clean(input.place, 120);
  const text = clean(input.text, 8000);
  if (!place) throw new HttpError(400, "Say which council: the grid's, or a section's");
  if (!text) throw new HttpError(400, "Nothing was said");
  const to = (Array.isArray(input.to) ? input.to : []).slice(0, 24).map((t) => ({ name: clean(t?.name, 80) || "Claude", ...(clean(t?.session, 80) ? { session: clean(t.session, 80) } : {}) }));
  const requestId = clean(input.request_id, 120) || null;
  if (requestId) {
    const had = one<Row>("select * from council_lines where board_id = ? and by_user = ? and request_id = ?", boardId, by.id, requestId);
    if (had) return lineFor(had, by);
  }
  const row: Row = {
    id: `cl_${randomBytes(8).toString("hex")}`,
    board_id: boardId,
    place,
    text,
    to_json: JSON.stringify(to.map((t) => t.name)),
    all_seats: input.all ? 1 : 0,
    sessions_json: JSON.stringify(to),
    by_user: by.id,
    by_name: by.name,
    at: Date.now(),
  };
  run(
    "insert into council_lines (id, board_id, place, text, to_json, all_seats, sessions_json, by_user, by_name, request_id, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.id, row.board_id, row.place, row.text, row.to_json, row.all_seats, row.sessions_json, row.by_user, row.by_name, requestId, row.at,
  );
  // a place keeps its last KEEP lines
  run("delete from council_lines where board_id = ? and place = ? and id not in (select id from council_lines where board_id = ? and place = ? order by at desc limit ?)", boardId, place, boardId, place, KEEP);
  return lineFor(row, by);
}

/** a council's conversation on a grid, oldest first, each line with its agents' answers as this reader may have them */
export function councilLines(boardId: string, place: string, reader: UserInfo, limit = 60): CouncilLine[] {
  const rows = all<Row>("select * from council_lines where board_id = ? and place = ? order by at desc limit ?", boardId, place, Math.max(1, Math.min(KEEP, limit)));
  return rows.reverse().map((r) => lineFor(r, reader));
}

function lineFor(r: Row, reader: UserInfo): CouncilLine {
  let asks: CouncilSeatAsk[] = [];
  try {
    asks = JSON.parse(r.sessions_json) as CouncilSeatAsk[];
  } catch {
    /* a line without its asks */
  }
  return {
    id: r.id,
    place: r.place,
    text: r.text,
    by: r.by_name,
    mine: r.by_user === reader.id,
    at: r.at,
    all: Boolean(r.all_seats),
    replies: asks.map((a) => replyFor(r, a, reader)),
  };
}

function replyFor(line: Row, ask: CouncilSeatAsk, reader: UserInfo): CouncilReply {
  if (!ask.session) return { name: ask.name, state: "elsewhere" };
  // the run this line started: that person's, on this grid, in that session, from the line on
  const runRow = one<{ id: string }>(
    "select id from agent_runs where session_id = ? and created_by = ? and board_id = ? and created_at >= ? order by created_at limit 1",
    ask.session, line.by_user, line.board_id, line.at - BEFORE_MS,
  );
  const session = line.by_user === reader.id ? { session: ask.session } : {};
  if (!runRow) return { name: ask.name, state: "waiting", ...session };
  const a = answerFor(runRow.id, reader);
  if (a.state === "running") return { name: ask.name, state: "working", ...session };
  if (a.state === "none") return { name: ask.name, state: "none", ...session };
  return { name: ask.name, state: "answered", ...(a.text ? { text: a.text } : {}), ...(a.withheld ? { withheld: a.withheld } : {}), ...session };
}

/**
 * Replay and the clock (ChatForm R1): a recorded session's **takes** (the grid's changes kept with it), its
 * **timeline**, and the state of a section at any moment.
 *
 * A take starts when a session is recording and on a grid: a grid huddle's own board, or a board a
 * channel's huddle was taken to (huddles.ts onHuddleSession: recording-on, placed while recording, and a
 * start while recording). It keeps a base (Y.encodeStateAsUpdate of the board then) and every change
 * applied to the board after, with its time (boards.ts onBoardUpdate), bursts within 250 ms merged with
 * Y.mergeUpdates; and, at most five times a second, where people's pointers and agents' aims were
 * (awareness, which is not document state: a light track of its own). It stops at recording-off or the
 * session's end; at 45 minutes or 48 MB of changes it stops early and says so (`truncated`). A take is
 * evidence, like a recording: nothing here deletes one. A take left open by a restart is closed at its
 * last kept change, and says why.
 *
 * Nothing here writes a board while looking back: reading a timeline or a take only reads. The one write
 * is adding the clock card (`add_replay`, a board write like any card, refused for a viewer).
 *
 * Access: a session through huddles.ts sessionFor (a channel's huddle: its members; a grid's: the board's
 * people). A take also needs the board: someone in the channel who can't open that grid gets the
 * conversation without the grid, and the timeline says so.
 */

import * as Y from "yjs";
import { randomBytes } from "node:crypto";
import { boardMaps, encodeTake, logActivity, noteTextOf, REPLAY_CARD, tableCellsOf, uid, type ObjectDoc, type PanelDoc, type ReplayTimeline, type TakeFrames, type UserInfo, type CursorSample } from "@foundation/protocol";
import { all, db, one, run } from "./db.ts";
import { editBoard, getBoard, listBoards, onBoardUpdate, socketUserId } from "./boards.ts";
import { onHuddleSession, readSession, sessionFor, type HuddleSession } from "./huddles.ts";
import { HttpError, readJson, type Router } from "./http.ts";
import { requireUser } from "./auth.ts";
import { canSeeBoard } from "./members.ts";
import { canWrite } from "./roles.ts";
import { canSeeChatFile, getChannel, getMessage } from "./chat.ts";
import { isCad, shareFileWith, storeFile } from "./files.ts";
import { bringFromPlace } from "./places.ts";
import { visionArchiveAsset, visionArchiveListing } from "./vision.ts";

db.exec(`
create table if not exists replay_takes (
  id text primary key,
  session_id text not null,
  board_id text not null,
  section_id text,
  started_at integer not null,
  ended_at integer,
  base_blob blob not null,
  updates integer not null default 0,
  bytes integer not null default 0,
  truncated text,
  started_by text
);
create index if not exists replay_takes_session on replay_takes(session_id, started_at);
create table if not exists replay_updates (
  take_id text not null,
  seq integer not null,
  at integer not null,
  blob blob not null,
  by text,
  primary key (take_id, seq)
);
create table if not exists replay_cursors (
  take_id text not null,
  at integer not null,
  json text not null
);
create index if not exists replay_cursors_take on replay_cursors(take_id, at);
`);

// ---------- limits (env for tests) ----------

const num = (name: string, d: number) => {
  const v = Number(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** the longest a take keeps the grid */
const maxSpanMs = () => num("FOUNDATION_REPLAY_MAX_MS", 45 * 60_000);
/** the most bytes of changes a take keeps (the base is kept whatever its size) */
const maxBytes = () => num("FOUNDATION_REPLAY_MAX_BYTES", 48 * 1024 * 1024);
/** changes this close together are one burst */
const burstMs = () => num("FOUNDATION_REPLAY_BURST_MS", 250);
/** pointers are sampled this often (5 Hz) */
const CURSOR_MS = 200;

const spanWords = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

// ---------- keeping a take ----------

interface Capture {
  take: string;
  session: string;
  board: string;
  started: number;
  buf: Uint8Array[];
  bufBy: Set<string>;
  bufLast: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  spanTimer: ReturnType<typeof setTimeout>;
  cursorTimer: ReturnType<typeof setInterval>;
  lastCursors: string;
  seq: number;
  bytes: number;
  updates: number;
}

const captures = new Map<string, Capture>();
const byBoard = new Map<string, Set<Capture>>();

const nameOfUser = (id: string | undefined) => (id ? (one<{ name: string }>("select name from users where id = ?", id)?.name ?? null) : null);

/** who made a change: the person behind a sync socket, an agent's or the server's own write by its origin */
function whoOf(origin: unknown): string | null {
  const person = nameOfUser(socketUserId(origin));
  if (person) return person;
  if (origin === "agent") return "an agent";
  return null;
}

onBoardUpdate((boardId, update, at, origin) => {
  const set = byBoard.get(boardId);
  if (!set?.size) return;
  for (const c of set) {
    try {
      c.buf.push(update);
      c.bufLast = at;
      const who = whoOf(origin);
      if (who) c.bufBy.add(who);
      c.flushTimer ??= setTimeout(() => flush(c), burstMs());
    } catch (e) {
      console.error("replay: couldn't keep a change", e);
    }
  }
});

function flush(c: Capture) {
  if (c.flushTimer) clearTimeout(c.flushTimer);
  c.flushTimer = null;
  if (!c.buf.length) return;
  const merged = c.buf.length === 1 ? c.buf[0] : Y.mergeUpdates(c.buf);
  const by = [...c.bufBy].join(", ") || null;
  c.buf = [];
  c.bufBy.clear();
  c.seq++;
  c.updates++;
  c.bytes += merged.length;
  run("insert into replay_updates (take_id, seq, at, blob, by) values (?, ?, ?, ?, ?)", c.take, c.seq, c.bufLast, merged, by);
  run("update replay_takes set updates = ?, bytes = ? where id = ?", c.updates, c.bytes, c.take);
  if (c.bytes > maxBytes()) stopCapture(c, `Stopped keeping the grid at ${Math.round(maxBytes() / 1048576)} MB of changes`, c.bufLast);
}

/** who is pointing where now: people's pointers (world x/y) and the card or section each agent aims at */
function cursorsNow(boardId: string): CursorSample["who"] {
  const out: CursorSample["who"] = [];
  for (const s of getBoard(boardId).awareness.getStates().values()) {
    const st = s as { user?: { name?: string; color?: string; agent?: boolean }; cursor?: { x?: number; y?: number } | null; crew?: { target?: { id?: string } | null } };
    const n = st.user?.name;
    if (!n) continue;
    if (st.cursor && typeof st.cursor.x === "number" && typeof st.cursor.y === "number") out.push({ n, ...(st.user?.color ? { c: st.user.color } : {}), x: Math.round(st.cursor.x), y: Math.round(st.cursor.y), ...(st.user?.agent ? { a: 1 as const } : {}) });
    else if (st.crew?.target?.id) out.push({ n, a: 1, t: st.crew.target.id });
  }
  return out;
}

function sampleCursors(c: Capture) {
  try {
    const who = cursorsNow(c.board);
    const key = JSON.stringify(who);
    if (key === c.lastCursors) return;
    c.lastCursors = key;
    run("insert into replay_cursors (take_id, at, json) values (?, ?, ?)", c.take, Date.now(), key);
  } catch {
    /* the board closed */
  }
}

function startCapture(session: string, boardId: string, section: string | null, by?: string): string | null {
  for (const c of captures.values()) if (c.session === session && c.board === boardId) return c.take;
  if (!listBoards().some((b) => b.id === boardId)) return null;
  const board = getBoard(boardId);
  const at = Date.now();
  const base = Y.encodeStateAsUpdate(board.doc);
  const take = `tk_${randomBytes(6).toString("hex")}`;
  const span = maxSpanMs();
  run("insert into replay_takes (id, session_id, board_id, section_id, started_at, base_blob, started_by) values (?, ?, ?, ?, ?, ?, ?)", take, session, boardId, section, at, base, by ?? null);
  const c: Capture = {
    take,
    session,
    board: boardId,
    started: at,
    buf: [],
    bufBy: new Set(),
    bufLast: at,
    flushTimer: null,
    spanTimer: setTimeout(() => stopCapture(c, `Stopped keeping the grid at ${spanWords(span)}`), span),
    cursorTimer: setInterval(() => sampleCursors(c), CURSOR_MS),
    lastCursors: "",
    seq: 0,
    bytes: 0,
    updates: 0,
  };
  c.spanTimer.unref?.();
  c.cursorTimer.unref?.();
  captures.set(take, c);
  if (!byBoard.has(boardId)) byBoard.set(boardId, new Set());
  byBoard.get(boardId)!.add(c);
  sampleCursors(c);
  return take;
}

function stopCapture(c: Capture, truncated?: string, at = Date.now()) {
  if (!captures.has(c.take)) return;
  captures.delete(c.take);
  byBoard.get(c.board)?.delete(c);
  flush(c);
  clearTimeout(c.spanTimer);
  clearInterval(c.cursorTimer);
  run("update replay_takes set ended_at = ?, truncated = coalesce(?, truncated) where id = ?", Math.max(at, c.started), truncated ?? null, c.take);
}

function stopSession(session: string) {
  for (const c of [...captures.values()]) if (c.session === session) stopCapture(c);
}

/** the section of a grid's own huddle card */
function huddleSection(boardId: string, huddleId: string): string | null {
  try {
    const o = boardMaps(getBoard(boardId).doc).objects.get(huddleId);
    return o?.sectionId ?? null;
  } catch {
    return null;
  }
}

/** where a recording session is on grids now: a grid huddle's board; a channel huddle's places */
function gridsOf(s: HuddleSession, e?: { board?: string; section?: string }): Array<{ board: string; section: string | null }> {
  if (s.home !== "chat") return [{ board: s.board_id, section: huddleSection(s.board_id, s.huddle_id) }];
  const out = new Map<string, string | null>();
  for (const p of s.places ?? []) if (!out.has(p.board)) out.set(p.board, p.section || null);
  // a placement made before anyone joined is in huddle_places, logged at the start (the event's latest place covers the moment between)
  if (e?.board && e.board !== "chat") out.set(e.board, e.section ?? out.get(e.board) ?? null);
  return [...out].map(([board, section]) => ({ board, section }));
}

const isRecording = (s: HuddleSession) => (s.recordings ?? []).some((r) => r.stoppedAt === null);

onHuddleSession((e) => {
  try {
    if (e.type === "recording-off" || e.type === "end") return stopSession(e.session);
    const s = readSession(e.session);
    if (!s || s.ended_at || !isRecording(s)) return;
    for (const g of gridsOf(s, e)) startCapture(s.id, g.board, g.section, e.by);
  } catch (err) {
    console.error("replay: a session event couldn't be kept", err);
  }
});

/** takes left open (a restart mid-recording): closed at their last kept change, saying why. The recording itself stopped with the server. */
export function recoverOpenTakes(): number {
  const open = all<{ id: string; started_at: number }>("select id, started_at from replay_takes where ended_at is null").filter((t) => !captures.has(t.id));
  for (const t of open) {
    const last = one<{ at: number | null }>("select max(at) as at from replay_updates where take_id = ?", t.id)?.at;
    run("update replay_takes set ended_at = ?, truncated = coalesce(truncated, ?) where id = ?", last ?? t.started_at, "The server restarted while this was recording: the grid was kept until then", t.id);
  }
  return open.length;
}
recoverOpenTakes();

/** tests: forget the takes being kept, as a restart would (rows stay open) */
export function _forgetCaptures() {
  for (const c of captures.values()) {
    if (c.flushTimer) clearTimeout(c.flushTimer);
    clearTimeout(c.spanTimer);
    clearInterval(c.cursorTimer);
  }
  captures.clear();
  byBoard.clear();
}

/** the takes being kept now (tests, status) */
export function liveTakes(): string[] {
  return [...captures.keys()];
}

/** flush every take's pending burst now (tests) */
export function _flushAll() {
  for (const c of captures.values()) flush(c);
}

// ---------- reading ----------

interface TakeRow {
  id: string;
  session_id: string;
  board_id: string;
  section_id: string | null;
  started_at: number;
  ended_at: number | null;
  base_blob: Uint8Array;
  updates: number;
  bytes: number;
  truncated: string | null;
  started_by: string | null;
}

const takeRow = (id: string) => one<TakeRow>("select * from replay_takes where id = ?", id);

/** a take's frames (no access check) */
export function readTake(id: string): TakeFrames | null {
  const t = takeRow(id);
  if (!t) return null;
  const live = captures.get(id);
  if (live) flush(live);
  const updates = all<{ at: number; blob: Uint8Array }>("select at, blob from replay_updates where take_id = ? order by seq", id).map((u) => ({ at: u.at, update: new Uint8Array(u.blob) }));
  const cursors = all<{ at: number; json: string }>("select at, json from replay_cursors where take_id = ? order by at, rowid", id).map((c) => ({ at: c.at, who: JSON.parse(c.json) as CursorSample["who"] }));
  return {
    head: { id: t.id, board: t.board_id, section: t.section_id, from: t.started_at, to: t.ended_at, updates: updates.length, truncated: t.truncated },
    base: new Uint8Array(t.base_blob),
    updates,
    cursors,
  };
}

const boardName = (id: string) => listBoards().find((b) => b.id === id)?.name ?? id;
function sectionName(boardId: string, section: string | null): string | null {
  if (!section) return null;
  try {
    return boardMaps(getBoard(boardId).doc).sections.get(section)?.name ?? null;
  } catch {
    return null;
  }
}

function sessionName(s: HuddleSession): { name: string; channel?: { id: string; name: string; kind: string } } {
  if (s.home === "chat") {
    const ch = s.channel ? getChannel(s.channel) : undefined;
    if (!ch) return { name: "Huddle" };
    const name = ch.kind === "open" || ch.kind === "private" ? `Huddle in #${ch.name}` : `Huddle with ${(ch.members ?? []).map((m) => m.name).join(", ") || "you"}`;
    return { name, channel: { id: ch.id, name: ch.name, kind: ch.kind } };
  }
  try {
    const o = boardMaps(getBoard(s.board_id).doc).objects.get(s.huddle_id);
    return { name: o?.name ?? "Huddle" };
  } catch {
    return { name: "Huddle" };
  }
}

/** the session's timeline for this person, or null when they may not see it */
export function timelineFor(user: UserInfo, sessionId: string): ReplayTimeline | null {
  const s = sessionFor(user, sessionId);
  if (!s) return null;
  const { name, channel } = sessionName(s);
  const takes = all<TakeRow>("select * from replay_takes where session_id = ? order by started_at", s.id);
  const seen = takes.filter((t) => canSeeBoard(user, t.board_id));
  const hidden = takes.length - seen.length;
  const end = s.ended_at ?? Date.now();
  // what was posted in the channel while it went on (sessionFor checked the person can read it)
  const messages: ReplayTimeline["messages"] = [];
  if (s.home === "chat" && s.channel) {
    for (const r of all<{ id: string }>("select id from chat_messages where channel_id = ? and created_at >= ? and created_at <= ? and deleted_at is null order by created_at limit 300", s.channel, s.started_at, end)) {
      const m = getMessage(r.id);
      if (!m || m.type === "system") continue;
      messages.push({ id: m.id, createdAt: m.createdAt, text: m.text, type: m.type, files: m.files, author: m.author.name, ...(m.author.kind === "agent" ? { agent: true } : {}) });
    }
  }
  const changes: ReplayTimeline["changes"] = [];
  for (const t of seen) for (const u of all<{ at: number }>("select at from replay_updates where take_id = ? order by seq", t.id)) changes.push({ take: t.id, at: u.at });
  return {
    session: { id: s.id, huddleId: s.huddle_id, home: s.home ?? "board", name, startedAt: s.started_at, endedAt: s.ended_at, ...(channel ? { channel } : {}), ...(s.home !== "chat" ? { board: s.board_id } : {}) },
    people: s.people,
    agents: s.agents ?? [],
    lines: s.lines,
    media: s.media.map((m) => ({ ...m, offset: m.startedAt - s.started_at })),
    recordings: s.recordings ?? [],
    places: (s.places ?? []).filter((p) => canSeeBoard(user, p.board)).map((p) => ({ ...p, boardName: boardName(p.board), sectionName: sectionName(p.board, p.section) })),
    events: (s.events ?? []).filter((e) => !e.board || canSeeBoard(user, e.board)),
    messages,
    takes: seen.map((t) => ({ id: t.id, board: t.board_id, boardName: boardName(t.board_id), section: t.section_id, sectionName: sectionName(t.board_id, t.section_id), from: t.started_at, to: t.ended_at, updates: t.updates, bytes: t.bytes + t.base_blob.length, truncated: t.truncated })),
    ...(hidden ? { gridHidden: `This session was also kept on ${hidden === 1 ? "a grid" : `${hidden} grids`} you can't open, so ${hidden === 1 ? "that grid isn't" : "those grids aren't"} shown: you get the conversation without it.` } : {}),
    changes,
  };
}

/** a take for this person: 404 when they can't see its session, 403 when they can but not its grid */
export function takeFor(user: UserInfo, takeId: string): TakeFrames {
  const t = takeRow(takeId);
  if (!t || !sessionFor(user, t.session_id)) throw new HttpError(404, "no such take");
  if (!canSeeBoard(user, t.board_id)) throw new HttpError(403, "This was kept on a grid you can't open: the conversation is yours to replay, the grid isn't");
  return readTake(takeId)!;
}

// ---------- what changed on the grid, in words (the agents' timeline) ----------

interface Shot {
  name: string;
  kind: string;
  section: string;
  x: number;
  y: number;
  w: number;
  h: number;
  float: boolean;
  text?: string;
  cells?: string;
}

function shots(doc: Y.Doc): Map<string, Shot> {
  const m = boardMaps(doc);
  const out = new Map<string, Shot>();
  for (const o of m.objects.values() as Iterable<ObjectDoc>) {
    const kind = o.kind === "panel" ? o.panel : o.kind === "media" ? o.media : o.kind;
    const size = "w" in o ? { w: o.w, h: o.h } : { w: 0, h: 0 };
    out.set(o.id, {
      name: o.name,
      kind,
      section: o.sectionId,
      x: o.x,
      y: o.y,
      ...size,
      float: o.float,
      ...(o.kind === "note" ? { text: noteTextOf(doc, o) } : {}),
      ...(o.kind === "table" ? { cells: JSON.stringify(tableCellsOf(doc, o.id)) } : {}),
    });
  }
  return out;
}

const kindWord = (k: string) => (k === "note" ? "a note" : k === "table" ? "a table" : k === "image" ? "a picture" : k === "video" ? "a video" : k === "file" ? "a file" : `a ${k} card`);
const clip = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** each change to a take's grid, said: what was added, removed, moved, resized, renamed or written, and by whom when known */
export function takeChanges(frames: TakeFrames, by: Array<string | null> = []): Array<{ at: number; text: string }> {
  const d = new Y.Doc();
  Y.applyUpdate(d, frames.base);
  const secName = (id: string) => boardMaps(d).sections.get(id)?.name ?? "a section";
  let prev = shots(d);
  const out: Array<{ at: number; text: string }> = [];
  frames.updates.forEach((u, i) => {
    Y.applyUpdate(d, u.update);
    const next = shots(d);
    const said: string[] = [];
    for (const [id, n] of next) {
      const p = prev.get(id);
      if (!p) {
        said.push(`added ${kindWord(n.kind)} “${n.name}” in ${secName(n.section)}${n.text ? `: “${clip(n.text)}”` : ""}`);
        continue;
      }
      if (p.section !== n.section) said.push(`moved “${n.name}” to ${secName(n.section)}`);
      else if (p.x !== n.x || p.y !== n.y || p.float !== n.float) said.push(`moved “${n.name}”`);
      if (p.w !== n.w || p.h !== n.h) said.push(`resized “${n.name}” to ${Math.round(n.w)} × ${Math.round(n.h)}`);
      if (p.name !== n.name) said.push(`renamed “${p.name}” to “${n.name}”`);
      if ((p.text ?? "") !== (n.text ?? "")) said.push(`edited the note “${n.name}”: now “${clip(n.text ?? "")}”`);
      if ((p.cells ?? "") !== (n.cells ?? "")) said.push(`edited the table “${n.name}”`);
    }
    for (const [id, p] of prev) if (!next.has(id)) said.push(`removed ${kindWord(p.kind)} “${p.name}”`);
    prev = next;
    if (said.length) out.push({ at: u.at, text: `${by[i] ? `${by[i]} ` : ""}${[...new Set(said)].join("; ")}` });
  });
  d.destroy();
  return out;
}

/** the timeline as text an agent can read: who said what when, what changed on the grid when, what was posted */
export function timelineText(user: UserInfo, sessionId: string): string {
  const t = timelineFor(user, sessionId);
  if (!t) return `No session ${sessionId} that ${user.name} can see.`;
  const t0 = t.session.startedAt;
  const off = (at: number) => {
    const s = Math.max(0, Math.round((at - t0) / 1000));
    return `+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const utc = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
  const rows: Array<{ at: number; text: string }> = [];
  for (const l of t.lines) rows.push({ at: l.at, text: l.source === "system" ? `(${l.text})` : `${l.speaker}${l.source === "agent" ? " (agent)" : ""}: ${l.text}` });
  for (const m of t.messages) if (m.type !== "huddle") rows.push({ at: m.createdAt, text: `posted in the channel by ${m.author}${m.agent ? " (agent)" : ""}: ${clip(m.text, 200)}${m.files.length ? ` [files: ${m.files.map((f) => f.name).join(", ")}]` : ""}` });
  for (const k of t.takes) {
    const frames = readTake(k.id);
    if (!frames) continue;
    const by = all<{ by: string | null }>("select by from replay_updates where take_id = ? order by seq", k.id).map((r) => r.by);
    for (const c of takeChanges(frames, by)) rows.push({ at: c.at, text: `grid ${k.boardName}${k.sectionName ? ` › ${k.sectionName}` : ""}: ${c.text}` });
  }
  rows.sort((a, b) => a.at - b.at);
  const head = [
    `${t.session.name} · ${utc(t0)} UTC${t.session.endedAt ? ` · ${spanWords(t.session.endedAt - t0)}` : " (live)"} · ${t.people.join(", ") || "nobody"}${t.agents.length ? ` · agents: ${t.agents.join(", ")}` : ""}`,
    ...t.recordings.map((r) => `Recorded ${off(r.startedAt)}–${r.stoppedAt ? off(r.stoppedAt) : "end"} (pressed by ${r.by}).`),
    ...t.takes.map((k) => `Kept the grid ${k.boardName}${k.sectionName ? ` › ${k.sectionName}` : ""} ${off(k.from)}–${k.to ? off(k.to) : "now"}: ${k.updates} changes.${k.truncated ? ` ${k.truncated}.` : ""}`),
    ...(t.gridHidden ? [t.gridHidden] : []),
    ...(t.media.length ? [`Recordings: ${t.media.map((m) => `${m.person}${m.kind === "screen" ? "'s screen" : ""} from ${off(m.startedAt)}`).join(", ")}.`] : []),
  ];
  return `${head.join("\n")}\n\n${rows.map((r) => `[${off(r.at)}] ${r.text}`).join("\n") || "(nothing said or changed)"}`;
}

// ---------- the clock card ----------

export function userById(id: string): UserInfo | null {
  return one<UserInfo>("select id, email, name, color, role from users where id = ?", id) ?? null;
}

/**
 * Put a session's clock card on a grid (a board write, like any card). The section: the one given, else
 * where the session was on this grid, else the grid's first. A card for this session already in that
 * section is the answer (asked twice, added once).
 */
export function addReplayCard(boardId: string, by: { userId: string; actor: string; person?: boolean }, p: { session: string; section?: string; x?: number; y?: number }): PanelDoc {
  const user = userById(by.userId);
  if (!user) throw new HttpError(403, "A replay belongs to the people who can see the session: this caller isn't one");
  const s = sessionFor(user, p.session);
  if (!s) throw new HttpError(404, "no such session");
  if (!listBoards().some((b) => b.id === boardId) || !canSeeBoard(user, boardId)) throw new HttpError(404, "No such grid");
  if (!canWrite(user.id, boardId)) throw new HttpError(403, "View only: you can't put a card on that grid");
  const ch = s.home === "chat" && s.channel ? getChannel(s.channel) : undefined;
  const name = s.home === "chat" ? (ch?.kind === "open" ? `Replay · #${ch.name} huddle` : "Replay · huddle") : `Replay · ${sessionName(s).name}`;
  return editBoard(boardId, "agent", (doc) => {
    const m = boardMaps(doc);
    const placed = (s.places ?? []).find((x) => x.board === boardId)?.section ?? (s.home !== "chat" && s.board_id === boardId ? huddleSection(boardId, s.huddle_id) : null);
    const leaf = [...m.sections.values()].filter((x) => ![...m.sections.values()].some((k) => k.parent === x.id));
    const sec = (p.section && m.sections.get(p.section)) || (placed && m.sections.get(placed)) || leaf[0];
    if (!sec) throw new HttpError(400, "This grid has no section to put the clock in");
    const had = [...m.objects.values()].find((o) => o.kind === "panel" && o.panel === "replay" && o.sessionId === s.id && o.sectionId === sec.id) as PanelDoc | undefined;
    if (had) return had;
    const float = typeof p.x === "number" && typeof p.y === "number";
    const panel: PanelDoc = {
      id: uid("pnl"),
      kind: "panel",
      panel: "replay",
      sessionId: s.id,
      sectionId: sec.id,
      name,
      x: float ? Math.round(p.x!) : 0,
      y: float ? Math.round(p.y!) : 0,
      float,
      bornAt: Date.now(),
      w: REPLAY_CARD.w,
      h: REPLAY_CARD.h,
      ports: [],
      createdBy: by.actor,
    };
    m.objects.set(panel.id, panel);
    logActivity(doc, { who: by.actor, role: by.person ? "human" : "agent", text: `put the clock of a recorded huddle on “${sec.name}”`, objectId: panel.id });
    return panel;
  });
}

/**
 * A file someone can see (a chat upload in a channel they read, or a grid's file) onto a section of a grid
 * they can edit, as a file card: the grid gets its own record of the same bytes (files.ts shareFileWith),
 * so a huddle can be held over it.
 */
export function placeFile(boardId: string, by: { userId: string; actor: string; person?: boolean }, p: { file: string; section?: string }): { id: string; file: string; section: string } {
  const user = userById(by.userId);
  if (!user) throw new HttpError(403, "only a person's own files can be put on a grid this way");
  const f = one<{ id: string; board_id: string | null; name: string; mime: string }>("select id, board_id, name, mime from files where id = ? and archived_at is null", p.file);
  if (!f) throw new HttpError(404, "no such file");
  if (f.board_id === "chat" ? !canSeeChatFile(user, f.id) : f.board_id ? !canSeeBoard(user, f.board_id) : false) throw new HttpError(404, "no such file");
  if (!canWrite(user.id, boardId)) throw new HttpError(403, "View only: you can't put a card on that grid");
  const fileId = shareFileWith(f.id, boardId, user.id);
  const cad = isCad(f.name);
  return editBoard(boardId, "agent", (doc) => {
    const m = boardMaps(doc);
    const sec = (p.section && m.sections.get(p.section)) || [...m.sections.values()].find((x) => ![...m.sections.values()].some((k) => k.parent === x.id));
    if (!sec) throw new HttpError(400, "This grid has no section to put it in");
    const id = uid("pnl");
    const panel: PanelDoc = { id, kind: "panel", panel: "file", sectionId: sec.id, name: f.name, x: 0, y: 0, float: false, bornAt: Date.now(), w: cad ? 460 : 420, h: cad ? 380 : 340, fileId, mime: f.mime, ports: [], createdBy: by.actor };
    m.objects.set(id, panel);
    logActivity(doc, { who: by.actor, role: by.person ? "human" : "agent", text: `brought ${f.name} from ChatForm`, objectId: id });
    return { id, file: fileId, section: sec.id };
  });
}

// ---------- routes ----------

export function replayRoutes(r: Router) {
  r.get("/api/replay/takes/:id", (req, res) => {
    const frames = takeFor(requireUser(req), req.params.id);
    const body = Buffer.from(encodeTake(frames));
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length), "cache-control": frames.head.to ? "private, max-age=3600" : "no-store" });
    res.end(body);
    return undefined;
  });
  r.get("/api/replay/:session", (req) => {
    const t = timelineFor(requireUser(req), req.params.session);
    if (!t) throw new HttpError(404, "no such session");
    return t;
  });

  // attaching from elsewhere into a chat message: copied into Foundation's archive as the person's own chat upload, with where it came from
  r.get("/api/chat/attach/vision", async (req) => {
    requireUser(req);
    return visionArchiveListing();
  });
  r.post("/api/chat/attach/vision", async (req) => {
    const u = requireUser(req);
    const b = await readJson<{ asset?: string }>(req);
    if (!b.asset) throw new HttpError(400, "which asset?");
    let got: Awaited<ReturnType<typeof visionArchiveAsset>>;
    try {
      got = await visionArchiveAsset(String(b.asset));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const file = await storeFile(got.body, { name: got.name, mime: got.mime, boardId: "chat", userId: u.id, about: got.about });
    return { file: { ...file, url: `/files/${file.id}` } };
  });
  r.post("/api/chat/attach/place", async (req) => {
    const u = requireUser(req);
    const b = await readJson<{ place?: string; path?: string }>(req);
    if (!b.place || !b.path) throw new HttpError(400, "which file?");
    const file = await bringFromPlace(u, String(b.place), String(b.path), "chat");
    return { file: { ...file, url: `/files/${file.id}` } };
  });
}

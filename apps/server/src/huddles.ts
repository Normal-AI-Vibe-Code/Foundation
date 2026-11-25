/**
 * Huddles — video rooms. Media goes browser to browser (a WebRTC mesh: fine
 * for the handful of people a huddle holds, and nothing paid or third-party
 * carries it); this module is only the signalling relay, the roster, and the
 * archive.
 *
 * A room has a **home**:
 *  - a grid (`board/huddle`): the huddle card on a board, as it always was.
 *    Access is the board's.
 *  - a ChatForm channel (`chat/huddle`, ChatForm H1, 2026-11-18): started from
 *    a channel (any kind), it posts one `huddle` message (the card) and keeps
 *    the card and the channel's huddle state in step. Access is the channel's
 *    membership (canSeeChannel), never a board's. **Taking it to a grid** puts
 *    a huddle card for the *same* room on a section (`home: "chat"`, same id):
 *    the card is a view, the call never moves, nobody renegotiates. The server
 *    mirrors the room's state into that board's `huddles` map; when the channel
 *    isn't open the mirror is `locked` (no names).
 *
 * Every time people gather is a **session** (Granola's meeting): a start and an
 * end, who was there, a transcript (each browser transcribes its own mic, so
 * every line knows who said it; typed and agent lines sit alongside), the
 * recordings people made (ordinary uploaded files: archived, never deleted),
 * and an event log (placed on a grid, recording on/off, opt-outs) that the
 * replay builds its timeline from (onHuddleSession, readSession).
 *
 * In a room: one screen share at a time (the server arbitrates), agents seated
 * by a person (they listen to the transcript, answer when addressed; every
 * client speaks the answer aloud), and "don't record me" per person.
 *
 * Socket: /huddle/:board/:huddle?send=1|0 (cookie or ticket, like /sync);
 * a channel's room is /huddle/chat/:huddle.
 */

import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { boardMaps, huddleStateOf, logActivity, setHuddleState, type ChatHuddleState, type ChatMessage, type HuddleLine, type HuddleState, type HuddleWire, type PanelDoc } from "@foundation/protocol";
import type { UserInfo } from "@foundation/protocol";
import { all, db, indexDoc, one, run } from "./db.ts";
import { editBoard, getBoard, listBoards } from "./boards.ts";
import { HttpError, readJson, type Router } from "./http.ts";
import { requirePerson, requireUser } from "./auth.ts";
import { canSeeBoard, requireBoard } from "./members.ts";
import { canWrite } from "./roles.ts";
import { canSeeChannel, getChannel, getMessage, personParty, postMessage, setChannelHuddle, updateMessage } from "./chat.ts";
import { requireFileVisible } from "./files.ts";

/** the reserved board id a channel's rooms signal on */
export const CHAT_HOME = "chat";

db.exec(`
create table if not exists huddle_sessions (
  id text primary key,
  huddle_id text not null,
  board_id text not null,
  started_at integer not null,
  ended_at integer,
  people_json text not null default '[]',
  channel text
);
create index if not exists huddle_sessions_huddle on huddle_sessions(huddle_id, started_at);

create table if not exists huddle_lines (
  id text primary key,
  session_id text not null,
  huddle_id text not null,
  at integer not null,
  speaker text not null,
  user_id text,
  text text not null,
  source text not null
);
create index if not exists huddle_lines_session on huddle_lines(session_id, at);

-- recordings: each participant's own camera + mic, uploaded as a file (archived, never deleted)
create table if not exists huddle_media (
  file_id text primary key,
  session_id text not null,
  huddle_id text not null,
  person text not null,
  started_at integer not null,
  ended_at integer not null
);

-- a channel's huddle (ChatForm): one live per channel; its card is a chat message
create table if not exists huddle_rooms (
  id text primary key,
  channel_id text not null,
  started_by text not null,
  started_name text not null,
  card_message text,
  created_at integer not null,
  ended_at integer,
  session_id text,
  request_id text
);
create index if not exists huddle_rooms_channel on huddle_rooms(channel_id, created_at);

-- where a channel's huddle was taken: one card per board
create table if not exists huddle_places (
  huddle_id text not null,
  board_id text not null,
  section_id text not null,
  placed_at integer not null,
  placed_by text not null,
  session_id text,
  request_id text,
  primary key (huddle_id, board_id)
);

-- what happened in a session, in order: start, placed, recording-on/off, optout/optin, share-on/off, agent-in/out, end
create table if not exists huddle_events (
  session_id text not null,
  at integer not null,
  type text not null,
  by text,
  board_id text,
  section_id text
);
create index if not exists huddle_events_session on huddle_events(session_id, at);
`);
// home: null on a grid's sessions, 'chat' on a channel's (added after the table shipped)
try {
  db.exec("alter table huddle_sessions add column home text");
} catch {
  /* already there */
}
// kind: null (a camera) or 'screen' (a shared screen, recorded by the person sharing it)
try {
  db.exec("alter table huddle_media add column kind text");
} catch {
  /* already there */
}

/** STUN finds a route between browsers on different networks; set FOUNDATION_ICE_SERVERS (JSON) to add TURN. */
function iceServers(): unknown[] {
  try {
    if (process.env.FOUNDATION_ICE_SERVERS) return JSON.parse(process.env.FOUNDATION_ICE_SERVERS);
  } catch {
    /* fall through */
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

/** a channel's huddle ends this long after its last person leaves (a reload doesn't end the call) */
const endGraceMs = () => {
  const v = Number(process.env.FOUNDATION_HUDDLE_END_GRACE_MS ?? "5000");
  return Number.isFinite(v) && v >= 0 ? v : 5000;
};
/** a channel's huddle nobody joined ends after this */
const noShowMs = () => {
  const v = Number(process.env.FOUNDATION_HUDDLE_NOSHOW_MS ?? "90000");
  return Number.isFinite(v) && v > 0 ? v : 90000;
};

interface Conn {
  id: string;
  ws: WebSocket;
  user: UserInfo;
  sending: boolean;
  muted?: boolean;
  camOff?: boolean;
  noRec?: boolean;
}

interface Seat {
  name: string;
  by: string;
  byId: string;
  state: "listening" | "thinking" | "talking";
}

interface Room {
  key: string;
  boardId: string;
  huddleId: string;
  home: "board" | "chat";
  channelId?: string;
  conns: Map<string, Conn>;
  sessionId: string | null;
  recording: { by: string; since: number } | null;
  share: { conn: string; by: string; stream?: string } | null;
  agents: Map<string, Seat>;
  turn: { name: string; ctrl: AbortController } | null;
  turnTimes: number[];
  endTimer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
}

const rooms = new Map<string, Room>();

export interface HuddleSession {
  id: string;
  huddle_id: string;
  board_id: string;
  started_at: number;
  ended_at: number | null;
  people: string[];
  channel: string | null;
  lines: HuddleLine[];
  media: Array<{ fileId: string; person: string; startedAt: number; endedAt: number; url: string; kind?: "screen" }>;
  /** "chat": a channel's huddle (board_id is "chat", channel its chat channel); "board": a grid's */
  home?: "chat" | "board";
  /** the grids it was taken to during this session, in order */
  places?: Array<{ board: string; section: string; at: number; by: string }>;
  /** when recording was on: each stretch, by who pressed it (stoppedAt null: still on, or the session ended first) */
  recordings?: Array<{ by: string; startedAt: number; stoppedAt: number | null }>;
  /** people who said "don't record me" at some point in it */
  optedOut?: string[];
  /** agents seated in it */
  agents?: string[];
  /** a channel huddle's card (the chat message id) */
  card?: string | null;
  events?: Array<{ at: number; type: string; by: string | null; board: string | null; section: string | null }>;
}

// ---------- the hooks the replay builds on ----------

export interface HuddleSessionEvent {
  type: "start" | "end" | "placed" | "recording-on" | "recording-off";
  session: string;
  huddleId: string;
  home: "chat" | "board";
  /** a channel huddle's chat channel */
  channel?: string;
  /** the grid: a grid huddle's own board; a channel huddle's when placed (start/end/recording: the latest place, if any) */
  board?: string;
  section?: string;
  by?: string;
  at: number;
}
const sessionListeners = new Set<(e: HuddleSessionEvent) => void>();
/** every session's start, end, placement and recording on/off, as it happens; returns an unsubscribe */
export function onHuddleSession(fn: (e: HuddleSessionEvent) => void): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}
function fire(e: HuddleSessionEvent) {
  for (const fn of sessionListeners) {
    try {
      fn(e);
    } catch (err) {
      console.error("huddles: a session listener failed", err);
    }
  }
}

function logEvent(sessionId: string, type: string, by?: string | null, board?: string | null, section?: string | null, at = Date.now()) {
  run("insert into huddle_events (session_id, at, type, by, board_id, section_id) values (?, ?, ?, ?, ?, ?)", sessionId, at, type, by ?? null, board ?? null, section ?? null);
}

// ---------- rows ----------

interface RoomRow {
  id: string;
  channel_id: string;
  started_by: string;
  started_name: string;
  card_message: string | null;
  created_at: number;
  ended_at: number | null;
  session_id: string | null;
  request_id: string | null;
}
const roomRow = (id: string) => one<RoomRow>("select * from huddle_rooms where id = ?", id);
const placesOf = (huddleId: string) => all<{ board_id: string; section_id: string; placed_at: number; placed_by: string }>("select * from huddle_places where huddle_id = ? order by placed_at", huddleId);
const latestPlace = (huddleId: string) => placesOf(huddleId).at(-1);

function huddlePanel(boardId: string, huddleId: string): PanelDoc | null {
  const o = boardMaps(getBoard(boardId).doc).objects.get(huddleId);
  return o && o.kind === "panel" && o.panel === "huddle" ? o : null;
}

/** does a room with this home exist (a grid's card, or a channel's huddle) */
function roomExists(boardId: string, huddleId: string): boolean {
  return boardId === CHAT_HOME ? Boolean(roomRow(huddleId)) : Boolean(huddlePanel(boardId, huddleId));
}

function send(ws: WebSocket, msg: HuddleWire) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: HuddleWire, except?: string) {
  for (const c of room.conns.values()) if (c.id !== except) send(c.ws, msg);
}

/** the people in it now: one name per person, however many tabs they have open */
function peopleIn(room: Room): string[] {
  return [...new Set([...room.conns.values()].filter((c) => c.sending).map((c) => c.user.name))];
}

function newSession(room: Room, people: string[], channel: string | null): string {
  const id = `hs_${randomBytes(6).toString("hex")}`;
  const at = Date.now();
  run("insert into huddle_sessions (id, huddle_id, board_id, started_at, people_json, channel, home) values (?, ?, ?, ?, ?, ?, ?)", id, room.huddleId, room.boardId, at, JSON.stringify(people), channel, room.home === "chat" ? "chat" : null);
  room.sessionId = id;
  logEvent(id, "start", people[0], room.home === "board" ? room.boardId : null, null, at);
  const place = room.home === "chat" ? latestPlace(room.huddleId) : undefined;
  fire({ type: "start", session: id, huddleId: room.huddleId, home: room.home, ...(room.channelId ? { channel: room.channelId } : {}), board: room.home === "board" ? room.boardId : place?.board_id, ...(place ? { section: place.section_id } : {}), by: people[0], at });
  return id;
}

function unionPeople(sessionId: string, people: string[]) {
  const row = one<{ people_json: string }>("select people_json from huddle_sessions where id = ?", sessionId);
  const was: string[] = row ? JSON.parse(row.people_json) : [];
  const union = [...new Set([...was, ...people])];
  if (union.length !== was.length) run("update huddle_sessions set people_json = ? where id = ?", JSON.stringify(union), sessionId);
  return union;
}

/**
 * Keep the huddle's live state and the session row in step with who is
 * sending. On a grid the state goes in the board's `huddles` map (schema 6),
 * never on the card: the card is the person's to move, and a whole-card write
 * from a move would otherwise overwrite who's in it.
 */
function settle(room: Room) {
  if (room.home === "chat") return settleChat(room);
  const people = peopleIn(room);
  const panel = huddlePanel(room.boardId, room.huddleId);
  if (!panel) return;
  const prev: HuddleState = huddleStateOf(getBoard(room.boardId).doc, room.huddleId) ?? { people: [] };
  let next: HuddleState = { ...prev, people };
  if (people.length && !room.sessionId) {
    // people gathered: a new session starts
    newSession(room, people, panel.channel ?? null);
    next = { ...next, liveSince: Date.now() };
    editBoard(room.boardId, "huddle", (doc) => logActivity(doc, { who: people[0], role: "human", text: `went live in ${panel.name}`, objectId: panel.id }));
  } else if (people.length && room.sessionId) {
    // everyone who was ever there in this session
    unionPeople(room.sessionId, people);
  } else if (!people.length && room.sessionId) {
    endSession(room);
    next = { people: [], recording: null, lastEndedAt: Date.now() };
  }
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    editBoard(room.boardId, "huddle", (doc) => {
      const cur = boardMaps(doc).objects.get(room.huddleId);
      if (cur && cur.kind === "panel") setHuddleState(doc, cur.id, next);
    });
  }
}

function endSession(room: Room) {
  if (!room.sessionId) return;
  const id = room.sessionId;
  room.sessionId = null;
  const at = Date.now();
  if (room.recording) logEvent(id, "recording-off", room.recording.by, null, null, at);
  room.recording = null;
  run("update huddle_sessions set ended_at = ? where id = ?", at, id);
  logEvent(id, "end", null, null, null, at);
  const place = room.home === "chat" ? latestPlace(room.huddleId) : undefined;
  fire({ type: "end", session: id, huddleId: room.huddleId, home: room.home, ...(room.channelId ? { channel: room.channelId } : {}), board: room.home === "board" ? room.boardId : place?.board_id, ...(place ? { section: place.section_id } : {}), at });
  indexSession(id);
}

/** what was said is searchable from ⌘K, like any card (a channel's: under board "chat", which ⌘K never shows; the Huddles tab searches them per person) */
function indexSession(sessionId: string) {
  const s = readSession(sessionId);
  if (!s) return;
  const name = s.home === "chat" ? "Huddle" : (huddlePanel(s.board_id, s.huddle_id)?.name ?? "Huddle");
  const when = new Date(s.started_at).toISOString().slice(0, 16).replace("T", " ");
  indexDoc("huddle", `${s.huddle_id}/${s.id}`, s.board_id, `${name} · ${when} UTC`, `${s.people.join(", ")}\n${s.lines.map((l) => `${l.speaker}: ${l.text}`).join("\n")}`);
}

// ---------- a channel's room: the card, the channel's state, the grids it's on ----------

/** what a grid shows of a channel's huddle: everything when the channel is open; otherwise that it's live and recording, no names */
function mirrorState(room: Room, people: string[], ended: boolean): HuddleState {
  const ch = room.channelId ? getChannel(room.channelId) : undefined;
  const open = ch?.kind === "open";
  const row = roomRow(room.huddleId);
  const liveSince = room.sessionId ? (one<{ started_at: number }>("select started_at from huddle_sessions where id = ?", room.sessionId)?.started_at ?? row?.created_at) : undefined;
  const state: HuddleState = ended
    ? { people: [], recording: null, lastEndedAt: row?.ended_at ?? Date.now() }
    : { people: open ? people : [], ...(liveSince ? { liveSince } : {}), recording: room.recording ? { by: open ? room.recording.by : "", since: room.recording.since } : null };
  return open ? state : { ...state, locked: true };
}

function syncChat(room: Room, ended = false) {
  const row = roomRow(room.huddleId);
  if (!row) return;
  const people = peopleIn(room);
  const session = room.sessionId ?? row.session_id;
  const everyone = session ? (JSON.parse(one<{ people_json: string }>("select people_json from huddle_sessions where id = ?", session)?.people_json ?? "[]") as string[]) : people;
  const place = latestPlace(room.huddleId);
  // the card: who was ever there, and once it ends, its session
  if (row.card_message) {
    const card = getMessage(row.card_message);
    if (card?.huddle) {
      const recorded = Boolean(session && one("select 1 from huddle_events where session_id = ? and type = 'recording-on'", session));
      const next: NonNullable<ChatMessage["huddle"]> = {
        id: room.huddleId,
        startedAt: card.huddle.startedAt,
        people: everyone,
        ...(session ? { session } : {}),
        ...(recorded ? { recorded: true } : {}),
        ...(place ? { board: place.board_id, section: place.section_id } : {}),
        ...(ended ? { endedAt: row.ended_at ?? Date.now() } : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(card.huddle)) updateMessage(card.id, { huddle: next });
    }
  }
  // the channel: who's in it now
  if (room.channelId && getChannel(room.channelId)) {
    const cur = getChannel(room.channelId)!.huddle ?? null;
    const next: ChatHuddleState | null = ended
      ? null
      : {
          id: room.huddleId,
          board: place?.board_id ?? CHAT_HOME,
          ...(place ? { section: place.section_id } : {}),
          liveSince: cur?.id === room.huddleId ? cur.liveSince : row.created_at,
          people,
          recording: Boolean(room.recording),
          ...(room.agents.size ? { agents: [...room.agents.keys()] } : {}),
        };
    // never clear a newer huddle's state
    if (!(ended && cur && cur.id !== room.huddleId) && JSON.stringify(cur) !== JSON.stringify(next)) setChannelHuddle(room.channelId, next);
  }
  // every grid it's on
  for (const p of placesOf(room.huddleId)) {
    const st = mirrorState(room, people, ended);
    const doc = getBoard(p.board_id).doc;
    if (!huddlePanel(p.board_id, room.huddleId)) continue;
    if (JSON.stringify(huddleStateOf(doc, room.huddleId)) === JSON.stringify(st)) continue;
    editBoard(p.board_id, "huddle", (d) => setHuddleState(d, room.huddleId, st));
  }
}

function settleChat(room: Room) {
  if (room.ended) return;
  const people = peopleIn(room);
  if (people.length) {
    if (room.endTimer) {
      clearTimeout(room.endTimer);
      room.endTimer = null;
    }
    if (!room.sessionId) {
      const id = newSession(room, people, room.channelId ?? null);
      run("update huddle_rooms set session_id = ? where id = ?", id, room.huddleId);
      // taken to a grid before anyone arrived: the session knows
      for (const p of placesOf(room.huddleId)) {
        run("update huddle_places set session_id = coalesce(session_id, ?) where huddle_id = ? and board_id = ?", id, room.huddleId, p.board_id);
        logEvent(id, "placed", p.placed_by, p.board_id, p.section_id);
      }
    } else unionPeople(room.sessionId, people);
  } else if (room.sessionId && !room.endTimer) {
    // the last person left: it ends after a moment unless someone comes back
    room.endTimer = setTimeout(() => {
      room.endTimer = null;
      if (!peopleIn(room).length) endChatRoom(room);
    }, endGraceMs());
    room.endTimer.unref?.();
  }
  syncChat(room);
}

/** a channel's huddle is over: the session ends, the card says so, the channel's state clears, the grids show it ended */
function endChatRoom(room: Room) {
  if (room.ended) return;
  room.ended = true;
  room.turn?.ctrl.abort();
  const session = room.sessionId;
  endSession(room);
  run("update huddle_rooms set ended_at = ?, session_id = coalesce(?, session_id) where id = ?", Date.now(), session, room.huddleId);
  syncChat(room, true);
  broadcast(room, { t: "ended", session: session ?? roomRow(room.huddleId)?.session_id ?? null });
  for (const c of room.conns.values()) c.ws.close(4410, "this huddle has ended");
  rooms.delete(room.key);
}

function chatRoom(huddleId: string): Room | null {
  const row = roomRow(huddleId);
  if (!row || row.ended_at) return null;
  const key = `${CHAT_HOME}/${huddleId}`;
  let room = rooms.get(key);
  if (!room) {
    room = blankRoom(key, CHAT_HOME, huddleId, "chat");
    room.channelId = row.channel_id;
    room.sessionId = row.session_id && !one("select 1 from huddle_sessions where id = ? and ended_at is not null", row.session_id) ? row.session_id : null;
    rooms.set(key, room);
  }
  return room;
}

function blankRoom(key: string, boardId: string, huddleId: string, home: Room["home"]): Room {
  return { key, boardId, huddleId, home, conns: new Map(), sessionId: null, recording: null, share: null, agents: new Map(), turn: null, turnTimes: [], endTimer: null, ended: false };
}

// ---------- the socket ----------

/**
 * A socket into a room. `person`: the opener is a person (not an agent's
 * bearer); a channel's room takes only people (it sends a camera, and
 * listening in is a member's). The caller (sockets.ts) has checked the board
 * can be seen; a channel's room checks the channel here.
 */
export function attachHuddle(boardId: string, huddleId: string, ws: WebSocket, user: UserInfo, sending: boolean, person = true) {
  let room: Room | null = null;
  // a grid's card that is a view of a channel's huddle: the channel's room
  const panel = boardId === CHAT_HOME ? null : huddlePanel(boardId, huddleId);
  if (boardId === CHAT_HOME || panel?.home === "chat") {
    const row = roomRow(huddleId);
    if (!row) return ws.close(4404, "no such huddle");
    const ch = getChannel(row.channel_id);
    if (!ch || !canSeeChannel(user, ch)) return ws.close(4403, "this huddle belongs to a conversation you're not in");
    if (!person || user.id === "agent") return ws.close(4403, "a huddle's seats are people's: an agent is invited by a person");
    if (row.ended_at) return ws.close(4410, "this huddle has ended");
    room = chatRoom(huddleId);
    if (!room) return ws.close(4410, "this huddle has ended");
  } else {
    if (!panel) return ws.close(4404, "no such huddle");
    const key = `${boardId}/${huddleId}`;
    room = rooms.get(key) ?? null;
    if (!room) {
      // a session left open by a crash or restart closes before a new one opens
      const open = one<{ id: string }>("select id from huddle_sessions where huddle_id = ? and board_id = ? and ended_at is null order by started_at desc limit 1", huddleId, boardId);
      room = blankRoom(key, boardId, huddleId, "board");
      room.sessionId = open?.id ?? null;
      rooms.set(key, room);
    }
  }
  const conn: Conn = { id: `c_${randomBytes(5).toString("hex")}`, ws, user, sending };
  send(ws, {
    t: "welcome",
    you: conn.id,
    peers: [...room.conns.values()].map((c) => ({ id: c.id, name: c.user.name, color: c.user.color, sending: c.sending, ...(c.noRec ? { noRec: true } : {}) })),
    ice: iceServers(),
  });
  if (room.share) send(ws, { t: "sharing", id: room.share.conn, by: room.share.by, ...(room.share.stream ? { stream: room.share.stream } : {}) });
  if (room.agents.size) send(ws, agentsWire(room));
  if (room.home === "chat" && room.recording) send(ws, { t: "recording", on: true, by: room.recording.by });
  room.conns.set(conn.id, conn);
  broadcast(room, { t: "peer-joined", id: conn.id, name: user.name, color: user.color, sending }, conn.id);
  const r = room;
  settle(r);

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === "signal" && typeof msg.to === "string") {
      const to = r.conns.get(msg.to);
      if (to) send(to.ws, { t: "signal", from: conn.id, to: to.id, data: msg.data });
    } else if (msg.t === "state") {
      conn.sending = Boolean(msg.sending);
      conn.muted = Boolean(msg.muted);
      conn.camOff = Boolean(msg.camOff);
      broadcast(r, { t: "peer-state", id: conn.id, sending: conn.sending, muted: conn.muted, camOff: conn.camOff, ...(conn.noRec ? { noRec: true } : {}) }, conn.id);
      settle(r);
    } else if (msg.t === "caption" && typeof msg.text === "string" && conn.sending) {
      // interim words, for live captions only — never stored
      broadcast(r, { t: "caption", from: conn.id, name: user.name, text: msg.text.slice(0, 400) }, conn.id);
    } else if (msg.t === "line" && typeof msg.text === "string") {
      const source = msg.source === "speech" ? "speech" : "typed";
      try {
        addLine(r.boardId, r.huddleId, user, msg.text, source);
      } catch {
        /* an empty line */
      }
    } else if (msg.t === "recording" && conn.sending) {
      setRecording(r, Boolean(msg.on), user.name);
    } else if (msg.t === "share" && conn.sending) {
      setShare(r, conn, Boolean(msg.on), typeof msg.stream === "string" ? msg.stream.slice(0, 100) : undefined);
    } else if (msg.t === "optout" && conn.sending) {
      conn.noRec = Boolean(msg.on);
      if (r.sessionId) logEvent(r.sessionId, conn.noRec ? "optout" : "optin", user.name);
      broadcast(r, { t: "peer-state", id: conn.id, sending: conn.sending, muted: conn.muted, camOff: conn.camOff, noRec: conn.noRec });
    } else if (msg.t === "agent-stop") {
      stopAgents(r, user.name);
    }
  });

  ws.on("close", () => {
    r.conns.delete(conn.id);
    if (r.share?.conn === conn.id) setShare(r, conn, false);
    broadcast(r, { t: "peer-left", id: conn.id });
    settle(r);
    if (!r.conns.size && r.home === "board") rooms.delete(r.key);
  });
}

function setRecording(room: Room, on: boolean, by: string) {
  const was = room.recording;
  room.recording = on ? (was ?? { by, since: Date.now() }) : null;
  if (room.home === "board") {
    editBoard(room.boardId, "huddle", (doc) => {
      const cur = boardMaps(doc).objects.get(room.huddleId);
      if (!cur || cur.kind !== "panel") return;
      const h: HuddleState = huddleStateOf(doc, cur.id) ?? { people: [] };
      setHuddleState(doc, cur.id, { ...h, recording: on ? { by, since: Date.now() } : null });
      logActivity(doc, { who: by, role: "human", text: on ? `started recording ${cur.name}` : `stopped recording ${cur.name}`, objectId: cur.id });
    });
  }
  broadcast(room, { t: "recording", on, by });
  if (room.sessionId && Boolean(was) !== on) {
    logEvent(room.sessionId, on ? "recording-on" : "recording-off", by);
    const place = room.home === "chat" ? latestPlace(room.huddleId) : undefined;
    fire({ type: on ? "recording-on" : "recording-off", session: room.sessionId, huddleId: room.huddleId, home: room.home, ...(room.channelId ? { channel: room.channelId } : {}), board: room.home === "board" ? room.boardId : place?.board_id, ...(place ? { section: place.section_id } : {}), by, at: Date.now() });
  }
  if (room.sessionId) addSystemLine(room, on ? `${by} started recording` : `${by} stopped recording`);
  if (room.home === "chat") syncChat(room);
}

/** one share at a time: a second asks while one is on and is told who has it */
function setShare(room: Room, conn: Conn, on: boolean, stream?: string) {
  if (on) {
    if (room.share && room.share.conn !== conn.id) {
      send(conn.ws, { t: "sharing", id: room.share.conn, by: room.share.by, ...(room.share.stream ? { stream: room.share.stream } : {}) });
      return;
    }
    room.share = { conn: conn.id, by: conn.user.name, ...(stream ? { stream } : {}) };
    if (room.sessionId) logEvent(room.sessionId, "share-on", conn.user.name);
    broadcast(room, { t: "sharing", id: conn.id, by: conn.user.name, ...(stream ? { stream } : {}) });
  } else if (room.share?.conn === conn.id) {
    room.share = null;
    if (room.sessionId) logEvent(room.sessionId, "share-off", conn.user.name);
    broadcast(room, { t: "sharing", id: null, by: null });
  }
}

function addSystemLine(room: Room, text: string) {
  const line: HuddleLine = { id: `hl_${randomBytes(6).toString("hex")}`, at: Date.now(), speaker: "Foundation", text, source: "system" };
  run("insert into huddle_lines (id, session_id, huddle_id, at, speaker, text, source) values (?, ?, ?, ?, ?, ?, ?)", line.id, room.sessionId, room.huddleId, line.at, line.speaker, line.text, line.source);
  broadcast(room, { t: "line", line });
}

/**
 * A line of transcript. It joins the session that's live now, or — typed after
 * everyone left — the most recent one, so notes can be added to the archive.
 * A person's line may start an agent's turn (see maybeAgentTurn).
 */
export function addLine(boardId: string, huddleId: string, user: Pick<UserInfo, "id" | "name">, text: string, source: "speech" | "typed"): HuddleLine {
  const clean = text.trim().slice(0, 4000);
  if (!clean) throw new Error("say something");
  if (!roomExists(boardId, huddleId)) throw new Error(`no huddle ${huddleId} on ${boardId}`);
  const room = rooms.get(`${boardId}/${huddleId}`);
  let sessionId = room?.sessionId ?? null;
  if (!sessionId) {
    const last = one<{ id: string }>("select id from huddle_sessions where huddle_id = ? and board_id = ? order by started_at desc limit 1", huddleId, boardId);
    if (!last) throw new Error("this huddle hasn't met yet — join it first");
    sessionId = last.id;
  }
  const line: HuddleLine = { id: `hl_${randomBytes(6).toString("hex")}`, at: Date.now(), speaker: user.name, text: clean, source };
  run("insert into huddle_lines (id, session_id, huddle_id, at, speaker, user_id, text, source) values (?, ?, ?, ?, ?, ?, ?, ?)", line.id, sessionId, huddleId, line.at, line.speaker, user.id, line.text, line.source);
  if (room) broadcast(room, { t: "line", line });
  if (!room?.sessionId) indexSession(sessionId);
  else maybeAgentTurn(room, line);
  return line;
}

/**
 * A participant's recording, uploaded as a file, joins the session it was made
 * in. A channel huddle's recording is a chat upload (board "chat") by the
 * person themselves; it is linked to the huddle's card, so it opens for exactly
 * the people who can read the channel (chat.ts canSeeChatFile) — never by a
 * grid it was taken to.
 */
export function attachRecording(boardId: string, huddleId: string, p: { fileId: string; person: string; sessionId?: string; startedAt: number; endedAt: number; userId?: string; kind?: "camera" | "screen" }) {
  if (!roomExists(boardId, huddleId)) throw new Error(`no huddle ${huddleId} on ${boardId}`);
  const f = one<{ id: string; board_id: string | null; uploaded_by: string | null }>("select id, board_id, uploaded_by from files where id = ?", p.fileId);
  if (!f) throw new Error("upload the recording first");
  if (boardId === CHAT_HOME && (f.board_id !== CHAT_HOME || (p.userId && f.uploaded_by !== p.userId))) throw new Error("a channel huddle's recording is your own upload to chat (POST /api/files?board=chat)");
  const sessionId =
    p.sessionId && one("select id from huddle_sessions where id = ? and huddle_id = ?", p.sessionId, huddleId)
      ? p.sessionId
      : one<{ id: string }>("select id from huddle_sessions where huddle_id = ? and board_id = ? and started_at <= ? order by started_at desc limit 1", huddleId, boardId, p.startedAt)?.id;
  if (!sessionId) throw new Error("no session for that recording");
  run("insert or ignore into huddle_media (file_id, session_id, huddle_id, person, started_at, ended_at, kind) values (?, ?, ?, ?, ?, ?, ?)", p.fileId, sessionId, huddleId, p.person, p.startedAt, p.endedAt, p.kind === "screen" ? "screen" : null);
  if (boardId === CHAT_HOME) {
    const row = roomRow(huddleId);
    if (row?.card_message) run("insert or ignore into chat_files (file_id, message_id, channel_id) values (?, ?, ?)", p.fileId, row.card_message, row.channel_id);
  }
  return { sessionId };
}

/** a session as stored, with no access check (server code; people go through sessionFor) */
export function readSession(id: string): HuddleSession | null {
  const s = one<{ id: string; huddle_id: string; board_id: string; started_at: number; ended_at: number | null; people_json: string; channel: string | null; home: string | null }>("select * from huddle_sessions where id = ?", id);
  if (!s) return null;
  const lines = all<HuddleLine>("select id, at, speaker, text, source from huddle_lines where session_id = ? order by at, rowid", id);
  const media = all<{ file_id: string; person: string; started_at: number; ended_at: number; kind: string | null }>("select * from huddle_media where session_id = ? order by started_at", id).map((m) => ({
    fileId: m.file_id,
    person: m.person,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    url: `/files/${m.file_id}`,
    ...(m.kind === "screen" ? { kind: "screen" as const } : {}),
  }));
  const events = all<{ at: number; type: string; by: string | null; board_id: string | null; section_id: string | null }>("select at, type, by, board_id, section_id from huddle_events where session_id = ? order by at, rowid", id).map((e) => ({ at: e.at, type: e.type, by: e.by, board: e.board_id, section: e.section_id }));
  const recordings: NonNullable<HuddleSession["recordings"]> = [];
  for (const e of events) {
    if (e.type === "recording-on") recordings.push({ by: e.by ?? "", startedAt: e.at, stoppedAt: null });
    else if (e.type === "recording-off") {
      const open = recordings.findLast((r) => r.stoppedAt === null);
      if (open) open.stoppedAt = e.at;
    }
  }
  const { people_json, home, ...rest } = s;
  return {
    ...rest,
    people: JSON.parse(people_json),
    lines,
    media,
    home: home === "chat" ? "chat" : "board",
    places: events.filter((e) => e.type === "placed" && e.board).map((e) => ({ board: e.board!, section: e.section ?? "", at: e.at, by: e.by ?? "" })),
    recordings,
    optedOut: [...new Set(events.filter((e) => e.type === "optout" && e.by).map((e) => e.by!))],
    agents: [...new Set(events.filter((e) => e.type === "agent-in" && e.by).map((e) => e.by!))],
    card: home === "chat" ? (roomRow(s.huddle_id)?.card_message ?? null) : null,
    events,
  };
}

/** may this person see a session: a channel's, if they can read the channel; a grid's, if they can see the board */
function maySeeSession(user: UserInfo, s: Pick<HuddleSession, "home" | "channel" | "board_id">): boolean {
  if (s.home === "chat") {
    const ch = s.channel ? getChannel(s.channel) : undefined;
    return Boolean(ch && canSeeChannel(user, ch));
  }
  return canSeeBoard(user, s.board_id);
}

/** a session for this person, or null when there's none or they may not see it */
export function sessionFor(user: UserInfo, id: string): HuddleSession | null {
  const s = readSession(id);
  return s && maySeeSession(user, s) ? s : null;
}

/** A huddle's archive: every session, newest first. */
export function huddleArchive(boardId: string, huddleId: string, limit = 20): HuddleSession[] {
  return all<{ id: string }>("select id from huddle_sessions where huddle_id = ? and board_id = ? order by started_at desc limit ?", huddleId, boardId, limit)
    .map((r) => readSession(r.id))
    .filter((s): s is HuddleSession => Boolean(s));
}

/** Plain-text transcript for agents and Slack: speaker and time per line. */
export function transcriptText(s: HuddleSession): string {
  const t = (at: number) => new Date(at).toISOString().slice(11, 16);
  const head = `Huddle ${new Date(s.started_at).toISOString().slice(0, 16).replace("T", " ")} UTC${s.ended_at ? ` – ${t(s.ended_at)}` : " (live)"} · ${s.people.join(", ") || "nobody"}`;
  const body = s.lines.map((l) => `[${t(l.at)}] ${l.speaker}${l.source === "agent" ? " (agent)" : ""}: ${l.text}`).join("\n");
  const media = s.media.length ? `\nRecordings: ${s.media.map((m) => `${m.person} (${m.url})`).join(", ")}` : "";
  return `${head}\n${body || "(nothing transcribed)"}${media}`;
}

/** who's in a huddle now (tests, tools) */
export function huddleRoster(boardId: string, huddleId: string) {
  const room = rooms.get(`${boardId}/${huddleId}`);
  return room ? [...room.conns.values()].map((c) => ({ id: c.id, name: c.user.name, sending: c.sending, ...(c.noRec ? { noRec: true } : {}) })) : [];
}

export interface NewHuddle {
  /** the card's id, made by the client, so a retried invite finds the same card */
  id: string;
  sectionId: string;
  name: string;
  channel: string;
  x: number;
  y: number;
}

/**
 * The huddle a channel is invited to, made here when it's new, so the invite
 * names a card the server already holds (the client used to add the card,
 * wait 400 ms for it to sync, then ask). A second call with the same id finds
 * the same card. The caller has checked the person can write the board.
 */
export function huddleForInvite(boardId: string, by: Pick<UserInfo, "name">, h: NewHuddle): PanelDoc {
  if (!/^[\w-]{4,64}$/.test(h.id)) throw new Error("a huddle needs an id");
  return editBoard(boardId, "system", (doc) => {
    const m = boardMaps(doc);
    const had = m.objects.get(h.id);
    if (had) {
      if (had.kind !== "panel" || had.panel !== "huddle") throw new Error("that id is taken by another card");
      return had;
    }
    if (!m.sections.get(h.sectionId)) throw new Error("no such section");
    const panel: PanelDoc = {
      id: h.id,
      kind: "panel",
      panel: "huddle",
      sectionId: h.sectionId,
      name: h.name.slice(0, 120) || "Huddle",
      channel: h.channel,
      x: Math.round(h.x),
      y: Math.round(h.y),
      float: true,
      bornAt: Date.now(),
      w: 560,
      h: 420,
      ports: [],
      createdBy: by.name,
    };
    m.objects.set(panel.id, panel);
    logActivity(doc, { who: by.name, role: "human", text: `opened “${panel.name}” and invited its channel`, objectId: panel.id });
    return panel;
  });
}

// ---------- a channel's huddle: start, take to a grid ----------

export interface ChannelHuddle {
  huddle: ChatHuddleState;
  message: ChatMessage | null;
  /** the socket path to open (with ?send=1 to join) */
  socket: string;
}

/**
 * Start a channel's huddle, or return the one going on. A person who can post
 * in the channel (a member; anyone but a viewer account in an open channel):
 * it posts ONE `huddle` message, the card, as them, and sets the channel's
 * huddle state. Nobody is in it until their socket sends.
 */
export function startChannelHuddle(user: UserInfo, channelId: string, requestId?: string): ChannelHuddle {
  const ch = getChannel(channelId);
  if (!ch || !canSeeChannel(user, ch)) throw new HttpError(404, "no such channel");
  if (ch.archivedAt) throw new HttpError(409, "this channel is archived");
  const live = one<RoomRow>("select * from huddle_rooms where channel_id = ? and ended_at is null order by created_at desc limit 1", channelId);
  if (live) {
    const room = chatRoom(live.id);
    if (room) syncChat(room);
    return { huddle: getChannel(channelId)!.huddle ?? { id: live.id, board: CHAT_HOME, liveSince: live.created_at, people: [], recording: false }, message: live.card_message ? (getMessage(live.card_message) ?? null) : null, socket: `/huddle/${CHAT_HOME}/${live.id}` };
  }
  const id = `hd_${randomBytes(6).toString("hex")}`;
  const at = Date.now();
  run("insert into huddle_rooms (id, channel_id, started_by, started_name, created_at, request_id) values (?, ?, ?, ?, ?, ?)", id, channelId, user.id, user.name, at, requestId ?? null);
  let message: ChatMessage;
  try {
    // posting checks the person may write here (and joins an open channel)
    message = postMessage(channelId, personParty(user), { type: "huddle", text: `${user.name} started a huddle`, huddle: { id, startedAt: at, people: [] }, ...(requestId ? { requestId: `huddle:${requestId}` } : {}) });
  } catch (e) {
    run("delete from huddle_rooms where id = ?", id);
    throw e;
  }
  run("update huddle_rooms set card_message = ? where id = ?", message.id, id);
  const state: ChatHuddleState = { id, board: CHAT_HOME, liveSince: at, people: [], recording: false };
  setChannelHuddle(channelId, state);
  // nobody came: it ends on its own
  const t = setTimeout(() => {
    const room = chatRoom(id);
    if (room && !room.sessionId && !peopleIn(room).length) endChatRoom(room);
  }, noShowMs());
  t.unref?.();
  return { huddle: state, message, socket: `/huddle/${CHAT_HOME}/${id}` };
}

/**
 * Take a channel's huddle to a grid: a huddle card for the same room on that
 * section (once per board), a `link` line in the channel, and the grid named on
 * the channel's state and the card. The call doesn't move: everyone stays
 * connected on /huddle/chat/:id. The card's name says whose huddle it is; on a
 * grid, a channel that isn't open shows no one's name but the starter's.
 */
export function placeChannelHuddle(user: UserInfo, huddleId: string, p: { board: string; section: string; x?: number; y?: number; requestId?: string }) {
  const row = roomRow(huddleId);
  const ch = row ? getChannel(row.channel_id) : undefined;
  if (!row || !ch || !canSeeChannel(user, ch)) throw new HttpError(404, "no such huddle");
  if (row.ended_at) throw new HttpError(409, "this huddle has ended");
  if (!p.board || !listBoards().some((b) => b.id === p.board) || !canSeeBoard(user, p.board)) throw new HttpError(404, "No such grid");
  if (!canWrite(user.id, p.board)) throw new HttpError(403, "View only: you can't put a card on that grid");
  const had = one<{ board_id: string; section_id: string }>("select board_id, section_id from huddle_places where huddle_id = ? and board_id = ?", huddleId, p.board);
  const doc = getBoard(p.board).doc;
  const sec = boardMaps(doc).sections.get(had?.section_id ?? p.section);
  if (!sec) throw new HttpError(404, "no such section");
  const boardName = listBoards().find((b) => b.id === p.board)?.name ?? p.board;
  const name = ch.kind === "open" ? `Huddle · #${ch.name}` : `${row.started_name}'s huddle`;
  const card = editBoard(p.board, "huddle", (d) => {
    const m = boardMaps(d);
    const was = m.objects.get(huddleId);
    if (was) return was as PanelDoc;
    const float = typeof p.x === "number" && typeof p.y === "number";
    const panel: PanelDoc = {
      id: huddleId,
      kind: "panel",
      panel: "huddle",
      home: "chat",
      channel: ch.id,
      sectionId: sec.id,
      name,
      x: float ? Math.round(p.x!) : 0,
      y: float ? Math.round(p.y!) : 0,
      float,
      bornAt: Date.now(),
      w: 560,
      h: 420,
      ports: [],
      createdBy: user.name,
    };
    m.objects.set(panel.id, panel);
    logActivity(d, { who: user.name, role: "human", text: ch.kind === "open" ? `brought the huddle from #${ch.name} here` : `brought ${row.started_name}'s huddle here`, objectId: panel.id });
    return panel;
  });
  let message: ChatMessage | null = null;
  if (!had) {
    const room = chatRoom(huddleId);
    const at = Date.now();
    run("insert or ignore into huddle_places (huddle_id, board_id, section_id, placed_at, placed_by, session_id, request_id) values (?, ?, ?, ?, ?, ?, ?)", huddleId, p.board, sec.id, at, user.name, room?.sessionId ?? null, p.requestId ?? null);
    if (room?.sessionId) {
      logEvent(room.sessionId, "placed", user.name, p.board, sec.id, at);
      fire({ type: "placed", session: room.sessionId, huddleId, home: "chat", channel: ch.id, board: p.board, section: sec.id, by: user.name, at });
    }
    const label = `${boardName} › ${sec.name}`;
    message = postMessage(ch.id, personParty(user), { type: "link", text: `${user.name} took the huddle to ${label}`, place: { board: p.board, boardName, section: sec.id, object: huddleId, label }, ...(p.requestId ? { requestId: `huddle-place:${p.requestId}` } : {}) });
    if (room) syncChat(room);
  }
  return { card, board: p.board, section: sec.id, message };
}

// ---------- agents in the room ----------

const AGENT_TURNS_PER_MIN = 6;
const AGENT_GAP_MS = 1500;

function agentsWire(room: Room): HuddleWire {
  return { t: "agents", agents: [...room.agents.values()].map(({ name, by, state }) => ({ name, by, state })) };
}

function setSeat(room: Room, name: string, state: Seat["state"]) {
  const s = room.agents.get(name);
  if (!s || s.state === state) return;
  s.state = state;
  broadcast(room, agentsWire(room));
}

/** seat an agent (or, `remove`, stand it up). A person in the room's audience only. */
export function seatAgent(user: UserInfo, boardId: string, huddleId: string, name: string, remove = false) {
  const clean = name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40);
  if (!clean) throw new HttpError(400, "name the agent");
  const room = boardId === CHAT_HOME ? chatRoom(huddleId) : rooms.get(`${boardId}/${huddleId}`);
  if (!room || room.ended) throw new HttpError(409, "the huddle isn't live: start it first");
  const key = [...room.agents.keys()].find((k) => k.toLowerCase() === clean.toLowerCase());
  if (remove) {
    if (key) {
      if (room.turn?.name === key) room.turn.ctrl.abort();
      room.agents.delete(key);
      if (room.sessionId) logEvent(room.sessionId, "agent-out", key);
      if (room.sessionId) addSystemLine(room, `${user.name} let ${key} go`);
    }
  } else if (!key) {
    if (room.agents.size >= 3) throw new HttpError(409, "three agents at most in a huddle");
    room.agents.set(clean, { name: clean, by: user.name, byId: user.id, state: "listening" });
    if (room.sessionId) logEvent(room.sessionId, "agent-in", clean);
    if (room.sessionId) addSystemLine(room, `${user.name} invited ${clean}`);
  }
  broadcast(room, agentsWire(room));
  if (room.home === "chat") syncChat(room);
  return { agents: [...room.agents.values()].map(({ name: n, by, state }) => ({ name: n, by, state })) };
}

function stopAgents(room: Room, by: string) {
  if (!room.turn && ![...room.agents.values()].some((s) => s.state !== "listening")) {
    broadcast(room, { t: "agent-hush" });
    return;
  }
  room.turn?.ctrl.abort();
  room.turn = null;
  for (const s of room.agents.values()) s.state = "listening";
  broadcast(room, { t: "agent-hush" });
  broadcast(room, agentsWire(room));
  if (room.sessionId) addSystemLine(room, `${by} stopped the agent`);
}

/**
 * Who a line is for: an agent named in it ("Wren, what's the clearance?"),
 * or — when exactly one agent sits with exactly one person — that agent,
 * whatever is said. Never an agent's own line, never a system line.
 */
export function addressedAgent(agentNames: string[], peopleNow: number, line: Pick<HuddleLine, "text" | "source">): string | null {
  if (line.source !== "speech" && line.source !== "typed") return null;
  for (const n of agentNames) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])@?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu");
    if (re.test(line.text)) return n;
  }
  return agentNames.length === 1 && peopleNow === 1 ? agentNames[0] : null;
}

export interface HuddleAgentAsk {
  agent: string;
  /** the person who seated it (it works for them) */
  user: UserInfo;
  huddleId: string;
  channel?: string;
  board?: string;
  /** the transcript so far, oldest first (the last few dozen lines) */
  lines: HuddleLine[];
  /** the line that addressed it */
  line: HuddleLine;
  signal: AbortSignal;
}
/** an answerer: what the agent says aloud, in a sentence or three (plain text) */
export type HuddleAgentVoice = (ask: HuddleAgentAsk) => Promise<string>;
let voice: HuddleAgentVoice | null = null;
/** the agents-in-chat module (or a test) supplies how an agent answers in a huddle; returns an undo */
export function setHuddleAgentVoice(fn: HuddleAgentVoice | null): () => void {
  voice = fn;
  return () => {
    if (voice === fn) voice = null;
  };
}

function maybeAgentTurn(room: Room, line: HuddleLine) {
  if (!room.agents.size || room.turn || !room.sessionId) return;
  const name = addressedAgent([...room.agents.keys()], peopleIn(room).length, line);
  if (!name) return;
  const now = Date.now();
  room.turnTimes = room.turnTimes.filter((t) => now - t < 60_000);
  if (room.turnTimes.length >= AGENT_TURNS_PER_MIN || (room.turnTimes.length && now - room.turnTimes.at(-1)! < AGENT_GAP_MS)) return;
  room.turnTimes.push(now);
  const seat = room.agents.get(name)!;
  const ctrl = new AbortController();
  room.turn = { name, ctrl };
  setSeat(room, name, "thinking");
  const sessionId = room.sessionId;
  const user = one<UserInfo>("select id, email, name, color, role from users where id = ?", seat.byId) ?? { id: seat.byId, email: "", name: seat.by, color: "", role: "member" };
  const lines = all<HuddleLine>("select id, at, speaker, text, source from huddle_lines where session_id = ? order by at desc, rowid desc limit 40", sessionId).reverse();
  const place = room.home === "chat" ? latestPlace(room.huddleId) : undefined;
  const ask: HuddleAgentAsk = { agent: name, user, huddleId: room.huddleId, ...(room.channelId ? { channel: room.channelId } : {}), board: room.home === "board" ? room.boardId : place?.board_id, lines, line, signal: ctrl.signal };
  const timeout = setTimeout(() => ctrl.abort(), 90_000);
  timeout.unref?.();
  void answer(ask)
    .then((text) => {
      if (ctrl.signal.aborted || room.turn?.ctrl !== ctrl || !room.agents.has(name)) return;
      const said = text.replace(/\s+/g, " ").trim().slice(0, 1200);
      if (!said) return;
      const l: HuddleLine = { id: `hl_${randomBytes(6).toString("hex")}`, at: Date.now(), speaker: name, text: said, source: "agent" };
      run("insert into huddle_lines (id, session_id, huddle_id, at, speaker, text, source) values (?, ?, ?, ?, ?, ?, ?)", l.id, sessionId, room.huddleId, l.at, l.speaker, l.text, l.source);
      broadcast(room, { t: "line", line: l });
      setSeat(room, name, "talking");
      broadcast(room, { t: "agent-says", name, text: said, id: l.id });
      // back to listening once it has had time to be said (about 2.6 words a second)
      const t = setTimeout(() => setSeat(room, name, "listening"), Math.min(30_000, 800 + (said.split(" ").length / 2.6) * 1000));
      t.unref?.();
    })
    .catch((e) => {
      if (!ctrl.signal.aborted && room.sessionId) addSystemLine(room, `${name} couldn't answer: ${(e as Error).message.slice(0, 160)}`);
    })
    .finally(() => {
      clearTimeout(timeout);
      if (room.turn?.ctrl === ctrl) room.turn = null;
      const s = room.agents.get(name);
      if (s?.state === "thinking") setSeat(room, name, "listening");
    });
}

/**
 * How an agent answers: a registered voice (setHuddleAgentVoice); else the
 * agents-in-chat module's `huddleReply` if it exports one; else, under the
 * scripted runtime (tests), a fixed reply; else a short turn of the board
 * agent (agent.ts runAgent) with the transcript as its ask, told to answer in
 * speech and change nothing. Whatever it says goes to the room and its
 * transcript only.
 */
async function answer(ask: HuddleAgentAsk): Promise<string> {
  if (voice) return voice(ask);
  try {
    const spec = "./chatagents.ts";
    const mod = (await import(spec)) as { huddleReply?: HuddleAgentVoice };
    if (typeof mod.huddleReply === "function") return mod.huddleReply(ask);
  } catch {
    /* not there (yet) */
  }
  if (process.env.FOUNDATION_AGENT_SCRIPT === "1") return `${ask.agent} here. I heard ${ask.line.speaker}: “${ask.line.text.slice(0, 160)}”.`;
  const { runAgent } = await import("./agent.ts");
  const said: string[] = [];
  const transcript = ask.lines.map((l) => `${l.speaker}${l.source === "agent" ? " (agent)" : ""}: ${l.text}`).join("\n");
  const prompt = `You are ${ask.agent}, seated in a live video huddle by ${ask.user.name}. Everything you write is spoken aloud to the people in the call, so answer in one to three short spoken sentences: no markdown, no lists, no links. Don't use tools and don't change anything; just answer.\n\n<huddle_transcript>\n${transcript}\n</huddle_transcript>\n\n${ask.line.speaker} just said to you: “${ask.line.text}”`;
  let failed = "";
  await runAgent({
    boardId: ask.board ?? "company",
    user: ask.user,
    prompt,
    session: `huddle_${ask.huddleId}`,
    as: ask.agent,
    signal: ask.signal,
    emit: (e) => {
      if (e.type === "text") said.push(e.text);
      else if (e.type === "error") failed = e.message;
    },
  });
  if (!said.length && failed) throw new Error(failed);
  return said.join("");
}

// ---------- where the rooms are, for a person ----------

export interface LiveHuddleRow {
  huddle: ChatHuddleState;
  channel: { id: string; name: string; kind: string; members?: Array<{ id: string; name: string; kind: string }> };
  card: string | null;
  startedBy: string;
}

/** the channel huddles going on now that this person may join */
export function liveHuddlesFor(user: UserInfo): LiveHuddleRow[] {
  const out: LiveHuddleRow[] = [];
  for (const r of all<RoomRow>("select * from huddle_rooms where ended_at is null order by created_at desc limit 200")) {
    const ch = getChannel(r.channel_id);
    if (!ch || !canSeeChannel(user, ch) || !ch.huddle || ch.huddle.id !== r.id) continue;
    out.push({ huddle: ch.huddle, channel: { id: ch.id, name: ch.name, kind: ch.kind, ...(ch.members ? { members: ch.members.map((m) => ({ id: m.id, name: m.name, kind: m.kind })) } : {}) }, card: r.card_message, startedBy: r.started_name });
  }
  return out;
}

export interface SessionRow {
  id: string;
  huddleId: string;
  home: "chat" | "board";
  startedAt: number;
  endedAt: number | null;
  people: string[];
  lines: number;
  recordings: number;
  /** a channel huddle's channel; a grid huddle's board and card name */
  channel?: { id: string; name: string; kind: string; members?: Array<{ id: string; name: string }> };
  board?: string;
  name?: string;
  places: Array<{ board: string; section: string; at: number }>;
  /** the words that matched a search */
  snippet?: string;
}

/** the sessions this person may see, newest first; `q` searches who was there and what was said */
export function sessionsFor(user: UserInfo, opts: { q?: string; limit?: number } = {}): SessionRow[] {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const q = (opts.q ?? "").trim().toLowerCase();
  const rows = q
    ? all<{ id: string }>(
        `select distinct s.id, s.started_at from huddle_sessions s left join huddle_lines l on l.session_id = s.id
          where lower(s.people_json) like ? or lower(l.text) like ? order by s.started_at desc limit 600`,
        `%${q}%`,
        `%${q}%`,
      )
    : all<{ id: string }>("select id from huddle_sessions order by started_at desc limit 600");
  const out: SessionRow[] = [];
  for (const { id } of rows) {
    if (out.length >= limit) break;
    const s = readSession(id);
    if (!s || !maySeeSession(user, s)) continue;
    const ch = s.home === "chat" && s.channel ? getChannel(s.channel) : undefined;
    const hit = q ? s.lines.find((l) => l.text.toLowerCase().includes(q)) : undefined;
    out.push({
      id: s.id,
      huddleId: s.huddle_id,
      home: s.home ?? "board",
      startedAt: s.started_at,
      endedAt: s.ended_at,
      people: s.people,
      lines: s.lines.filter((l) => l.source !== "system").length,
      recordings: s.media.length,
      ...(ch ? { channel: { id: ch.id, name: ch.name, kind: ch.kind, ...(ch.members ? { members: ch.members.map((m) => ({ id: m.id, name: m.name })) } : {}) } } : {}),
      ...(s.home === "board" ? { board: s.board_id, name: huddlePanel(s.board_id, s.huddle_id)?.name ?? "Huddle" } : {}),
      places: (s.places ?? []).map(({ board, section, at }) => ({ board, section, at })),
      ...(hit ? { snippet: `${hit.speaker}: ${hit.text.slice(0, 200)}` } : {}),
    });
  }
  return out;
}

// ---------- access for routes ----------

/** the room a route names, checked for this person: a channel's by membership, a grid's by the board */
function huddleAccess(user: UserInfo, boardId: string, huddleId: string): { home: "chat"; row: RoomRow; boardId: typeof CHAT_HOME } | { home: "board"; panel: PanelDoc; boardId: string } {
  if (boardId !== CHAT_HOME) {
    requireBoard(user, boardId);
    const panel = huddlePanel(boardId, huddleId);
    if (!panel) throw new HttpError(404, "no such huddle");
    if (panel.home !== "chat") return { home: "board", panel, boardId };
  }
  const row = roomRow(huddleId);
  const ch = row ? getChannel(row.channel_id) : undefined;
  if (!row || !ch) throw new HttpError(404, "no such huddle");
  // a grid's view of a private conversation's huddle: say it's private, nothing more; on its own path, it isn't there
  if (!canSeeChannel(user, ch)) throw new HttpError(boardId === CHAT_HOME ? 404 : 403, boardId === CHAT_HOME ? "no such huddle" : "This huddle belongs to a private conversation");
  return { home: "chat", row, boardId: CHAT_HOME };
}

/**
 * The routes: a grid huddle's (as before: `?board=` or the body's `board`,
 * default "company"), a channel's (board "chat", or any grid card that is its
 * view), and ChatForm's: start in a channel, take to a grid, seat an agent,
 * the live list and the archive.
 */
export function huddleRoutes(r: Router) {
  r.post("/api/chat/channels/:id/huddle", async (req) => {
    const u = requirePerson(req, "Joining a huddle (it sends your camera)");
    const b = await readJson<{ request_id?: string }>(req);
    return startChannelHuddle(u, req.params.id, typeof b.request_id === "string" ? b.request_id.slice(0, 120) : undefined);
  });
  r.get("/api/huddles/live", (req) => ({ live: liveHuddlesFor(requireUser(req)) }));
  r.get("/api/huddles/sessions", (req) => {
    const u = requireUser(req);
    return { sessions: sessionsFor(u, { q: req.query.get("q") ?? "", limit: Number(req.query.get("limit") ?? 50) || 50 }) };
  });
  r.get("/api/huddles/sessions/:sid", (req) => {
    const s = sessionFor(requireUser(req), req.params.sid);
    if (!s) throw new HttpError(404, "no such session");
    const ch = s.home === "chat" && s.channel ? getChannel(s.channel) : undefined;
    return { session: s, ...(ch ? { channel: { id: ch.id, name: ch.name, kind: ch.kind, ...(ch.members ? { members: ch.members.map((m) => ({ id: m.id, name: m.name, kind: m.kind })) } : {}) } } : {}) };
  });
  r.get("/api/huddles/:id", (req) => {
    const u = requireUser(req);
    const a = huddleAccess(u, req.query.get("board") ?? "company", req.params.id);
    if (a.home === "board") {
      const panel = a.panel;
      return { huddle: { id: panel.id, name: panel.name, channel: panel.channel ?? null, state: huddleStateOf(getBoard(a.boardId).doc, panel.id) ?? { people: [] } }, sessions: huddleArchive(a.boardId, panel.id) };
    }
    const ch = getChannel(a.row.channel_id)!;
    const room = rooms.get(`${CHAT_HOME}/${a.row.id}`);
    return {
      huddle: {
        id: a.row.id,
        name: ch.kind === "open" ? `Huddle · #${ch.name}` : `${a.row.started_name}'s huddle`,
        home: "chat",
        channel: ch.id,
        channelKind: ch.kind,
        card: a.row.card_message,
        endedAt: a.row.ended_at,
        state: ch.huddle?.id === a.row.id ? ch.huddle : null,
        places: placesOf(a.row.id).map((p) => ({ board: p.board_id, section: p.section_id, at: p.placed_at, by: p.placed_by })),
        agents: room ? [...room.agents.values()].map(({ name, by, state }) => ({ name, by, state })) : [],
      },
      sessions: huddleArchive(CHAT_HOME, a.row.id),
    };
  });
  r.post("/api/huddles/:id/lines", async (req) => {
    const u = requireUser(req);
    const b = await readJson<{ board?: string; text?: string }>(req);
    const a = huddleAccess(u, b.board ?? "company", req.params.id);
    try {
      return { line: addLine(a.boardId, req.params.id, u, b.text ?? "", "typed") };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  r.post("/api/huddles/:id/recordings", async (req) => {
    const u = requireUser(req);
    const b = await readJson<{ board?: string; fileId?: string; sessionId?: string; startedAt?: number; endedAt?: number; kind?: string }>(req);
    if (!b.fileId) throw new HttpError(400, "fileId required");
    const a = huddleAccess(u, b.board ?? "company", req.params.id);
    if (a.boardId !== CHAT_HOME) requireFileVisible(u.id, b.fileId); // a grid huddle's recording is a file its uploader can see (a channel's: attachRecording's own rule)
    try {
      return attachRecording(a.boardId, req.params.id, { fileId: b.fileId, person: u.name, userId: u.id, sessionId: b.sessionId, startedAt: b.startedAt ?? Date.now(), endedAt: b.endedAt ?? Date.now(), kind: b.kind === "screen" ? "screen" : "camera" });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  r.post("/api/huddles/:id/place", async (req) => {
    const u = requirePerson(req, "Taking a huddle to a grid");
    const b = await readJson<{ board?: string; section?: string; x?: number; y?: number; request_id?: string }>(req);
    return placeChannelHuddle(u, req.params.id, { board: String(b.board ?? ""), section: String(b.section ?? ""), x: b.x, y: b.y, requestId: typeof b.request_id === "string" ? b.request_id.slice(0, 120) : undefined });
  });
  r.post("/api/huddles/:id/agents", async (req) => {
    const u = requirePerson(req, "Inviting an agent into a huddle");
    const b = await readJson<{ board?: string; name?: string; remove?: boolean; stop?: boolean }>(req);
    const a = huddleAccess(u, b.board ?? CHAT_HOME, req.params.id);
    if (b.stop) {
      const room = a.boardId === CHAT_HOME ? chatRoom(req.params.id) : rooms.get(`${a.boardId}/${req.params.id}`);
      if (room) stopAgents(room, u.name);
      return { stopped: true };
    }
    return seatAgent(u, a.boardId, req.params.id, String(b.name ?? ""), Boolean(b.remove));
  });
}

// a channel's huddle left live by a restart: people reconnect within a couple of minutes, or it ends
{
  const stale = all<{ id: string }>("select id from huddle_rooms where ended_at is null");
  if (stale.length) {
    const t = setTimeout(() => {
      for (const { id } of stale) {
        const room = chatRoom(id);
        if (room && !peopleIn(room).length) endChatRoom(room);
      }
    }, 120_000);
    t.unref?.();
  }
}

/**
 * Huddles — video portals on the board. A huddle is a panel; people who join
 * it send their camera and mic, everyone else with the portal on screen
 * watches. Media goes browser to browser (a WebRTC mesh: fine for the handful
 * of people a huddle holds, and nothing paid or third-party carries it); this
 * module is only the signalling relay, the roster, and the archive.
 *
 * Every time people gather in a huddle is a **session** (Granola's meeting):
 * it has a start and an end, the people who were there, a transcript (each
 * participant's browser transcribes its own mic, so every line knows who said
 * it; typed lines sit alongside), and the recordings people chose to make.
 * Recordings are ordinary uploaded files — archived, never deleted.
 *
 * Socket: /huddle/:board/:huddle?send=1|0 (cookie auth, like /sync).
 */

import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { boardMaps, huddleStateOf, logActivity, setHuddleState, type HuddleLine, type HuddleState, type HuddleWire, type PanelDoc } from "@foundation/protocol";
import type { UserInfo } from "@foundation/protocol";
import { all, db, indexDoc, one, run } from "./db.ts";
import { editBoard, getBoard } from "./boards.ts";

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
`);

/** STUN finds a route between browsers on different networks; set FOUNDATION_ICE_SERVERS (JSON) to add TURN. */
function iceServers(): unknown[] {
  try {
    if (process.env.FOUNDATION_ICE_SERVERS) return JSON.parse(process.env.FOUNDATION_ICE_SERVERS);
  } catch {
    /* fall through */
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

interface Conn {
  id: string;
  ws: WebSocket;
  user: UserInfo;
  sending: boolean;
  muted?: boolean;
  camOff?: boolean;
}

interface Room {
  key: string;
  boardId: string;
  huddleId: string;
  conns: Map<string, Conn>;
  sessionId: string | null;
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
  media: Array<{ fileId: string; person: string; startedAt: number; endedAt: number; url: string }>;
}

function huddlePanel(boardId: string, huddleId: string): PanelDoc | null {
  const o = boardMaps(getBoard(boardId).doc).objects.get(huddleId);
  return o && o.kind === "panel" && o.panel === "huddle" ? o : null;
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

/**
 * Keep the huddle's live state and the session row in step with who is
 * sending. The state goes in the board's `huddles` map (schema 6), never on
 * the card: the card is the person's to move, and a whole-card write from a
 * move would otherwise overwrite who's in it.
 */
function settle(room: Room) {
  const people = peopleIn(room);
  const panel = huddlePanel(room.boardId, room.huddleId);
  if (!panel) return;
  const prev: HuddleState = huddleStateOf(getBoard(room.boardId).doc, room.huddleId) ?? { people: [] };
  let next: HuddleState = { ...prev, people };
  if (people.length && !room.sessionId) {
    // people gathered: a new session starts
    const id = `hs_${randomBytes(6).toString("hex")}`;
    run("insert into huddle_sessions (id, huddle_id, board_id, started_at, people_json, channel) values (?, ?, ?, ?, ?, ?)", id, room.huddleId, room.boardId, Date.now(), JSON.stringify(people), panel.channel ?? null);
    room.sessionId = id;
    next = { ...next, liveSince: Date.now() };
    editBoard(room.boardId, "huddle", (doc) => logActivity(doc, { who: people[0], role: "human", text: `went live in ${panel.name}`, objectId: panel.id }));
  } else if (people.length && room.sessionId) {
    // everyone who was ever there in this session
    const row = one<{ people_json: string }>("select people_json from huddle_sessions where id = ?", room.sessionId);
    const was: string[] = row ? JSON.parse(row.people_json) : [];
    const union = [...new Set([...was, ...people])];
    if (union.length !== was.length) run("update huddle_sessions set people_json = ? where id = ?", JSON.stringify(union), room.sessionId);
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
  run("update huddle_sessions set ended_at = ? where id = ?", Date.now(), id);
  indexSession(id);
}

/** what was said is searchable from ⌘K, like any card */
function indexSession(sessionId: string) {
  const s = readSession(sessionId);
  if (!s) return;
  const panel = huddlePanel(s.board_id, s.huddle_id);
  const when = new Date(s.started_at).toISOString().slice(0, 16).replace("T", " ");
  indexDoc("huddle", `${s.huddle_id}/${s.id}`, s.board_id, `${panel?.name ?? "Huddle"} · ${when} UTC`, `${s.people.join(", ")}\n${s.lines.map((l) => `${l.speaker}: ${l.text}`).join("\n")}`);
}

export function attachHuddle(boardId: string, huddleId: string, ws: WebSocket, user: UserInfo, sending: boolean) {
  if (!huddlePanel(boardId, huddleId)) {
    ws.close(4404, "no such huddle");
    return;
  }
  const key = `${boardId}/${huddleId}`;
  let room = rooms.get(key);
  if (!room) {
    // a session left open by a crash or restart closes before a new one opens
    const open = one<{ id: string }>("select id from huddle_sessions where huddle_id = ? and board_id = ? and ended_at is null order by started_at desc limit 1", huddleId, boardId);
    room = { key, boardId, huddleId, conns: new Map(), sessionId: open?.id ?? null };
    rooms.set(key, room);
  }
  const conn: Conn = { id: `c_${randomBytes(5).toString("hex")}`, ws, user, sending };
  send(ws, {
    t: "welcome",
    you: conn.id,
    peers: [...room.conns.values()].map((c) => ({ id: c.id, name: c.user.name, color: c.user.color, sending: c.sending })),
    ice: iceServers(),
  });
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
      broadcast(r, { t: "peer-state", id: conn.id, sending: conn.sending, muted: conn.muted, camOff: conn.camOff }, conn.id);
      settle(r);
    } else if (msg.t === "caption" && typeof msg.text === "string" && conn.sending) {
      // interim words, for live captions only — never stored
      broadcast(r, { t: "caption", from: conn.id, name: user.name, text: msg.text.slice(0, 400) }, conn.id);
    } else if (msg.t === "line" && typeof msg.text === "string") {
      const source = msg.source === "speech" ? "speech" : "typed";
      addLine(boardId, huddleId, user, msg.text, source);
    } else if (msg.t === "recording" && conn.sending) {
      setRecording(r, Boolean(msg.on), user.name);
    }
  });

  ws.on("close", () => {
    r.conns.delete(conn.id);
    broadcast(r, { t: "peer-left", id: conn.id });
    settle(r);
    if (!r.conns.size) rooms.delete(r.key);
  });
}

function setRecording(room: Room, on: boolean, by: string) {
  editBoard(room.boardId, "huddle", (doc) => {
    const cur = boardMaps(doc).objects.get(room.huddleId);
    if (!cur || cur.kind !== "panel") return;
    const h: HuddleState = huddleStateOf(doc, cur.id) ?? { people: [] };
    setHuddleState(doc, cur.id, { ...h, recording: on ? { by, since: Date.now() } : null });
    logActivity(doc, { who: by, role: "human", text: on ? `started recording ${cur.name}` : `stopped recording ${cur.name}`, objectId: cur.id });
  });
  broadcast(room, { t: "recording", on, by });
  if (room.sessionId) addSystemLine(room, on ? `${by} started recording` : `${by} stopped recording`);
}

function addSystemLine(room: Room, text: string) {
  const line: HuddleLine = { id: `hl_${randomBytes(6).toString("hex")}`, at: Date.now(), speaker: "Foundation", text, source: "system" };
  run("insert into huddle_lines (id, session_id, huddle_id, at, speaker, text, source) values (?, ?, ?, ?, ?, ?, ?)", line.id, room.sessionId, room.huddleId, line.at, line.speaker, line.text, line.source);
  broadcast(room, { t: "line", line });
}

/**
 * A line of transcript. It joins the session that's live now, or — typed after
 * everyone left — the most recent one, so notes can be added to the archive.
 */
export function addLine(boardId: string, huddleId: string, user: Pick<UserInfo, "id" | "name">, text: string, source: "speech" | "typed"): HuddleLine {
  const clean = text.trim().slice(0, 4000);
  if (!clean) throw new Error("say something");
  if (!huddlePanel(boardId, huddleId)) throw new Error(`no huddle ${huddleId} on ${boardId}`);
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
  return line;
}

/** A participant's recording, uploaded as a file, joins the session it was made in. */
export function attachRecording(boardId: string, huddleId: string, p: { fileId: string; person: string; sessionId?: string; startedAt: number; endedAt: number }) {
  if (!huddlePanel(boardId, huddleId)) throw new Error(`no huddle ${huddleId} on ${boardId}`);
  if (!one("select id from files where id = ?", p.fileId)) throw new Error("upload the recording first");
  const sessionId =
    p.sessionId && one("select id from huddle_sessions where id = ? and huddle_id = ?", p.sessionId, huddleId)
      ? p.sessionId
      : one<{ id: string }>("select id from huddle_sessions where huddle_id = ? and board_id = ? and started_at <= ? order by started_at desc limit 1", huddleId, boardId, p.startedAt)?.id;
  if (!sessionId) throw new Error("no session for that recording");
  run("insert or ignore into huddle_media (file_id, session_id, huddle_id, person, started_at, ended_at) values (?, ?, ?, ?, ?, ?)", p.fileId, sessionId, huddleId, p.person, p.startedAt, p.endedAt);
  return { sessionId };
}

function readSession(id: string): HuddleSession | null {
  const s = one<{ id: string; huddle_id: string; board_id: string; started_at: number; ended_at: number | null; people_json: string; channel: string | null }>("select * from huddle_sessions where id = ?", id);
  if (!s) return null;
  const lines = all<HuddleLine>("select id, at, speaker, text, source from huddle_lines where session_id = ? order by at", id);
  const media = all<{ file_id: string; person: string; started_at: number; ended_at: number }>("select * from huddle_media where session_id = ? order by started_at", id).map((m) => ({
    fileId: m.file_id,
    person: m.person,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    url: `/files/${m.file_id}`,
  }));
  const { people_json, ...rest } = s;
  return { ...rest, people: JSON.parse(people_json), lines, media };
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
  const body = s.lines.map((l) => `[${t(l.at)}] ${l.speaker}: ${l.text}`).join("\n");
  const media = s.media.length ? `\nRecordings: ${s.media.map((m) => `${m.person} (${m.url})`).join(", ")}` : "";
  return `${head}\n${body || "(nothing transcribed)"}${media}`;
}

/** who's in a huddle now (tests, tools) */
export function huddleRoster(boardId: string, huddleId: string) {
  const room = rooms.get(`${boardId}/${huddleId}`);
  return room ? [...room.conns.values()].map((c) => ({ id: c.id, name: c.user.name, sending: c.sending })) : [];
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

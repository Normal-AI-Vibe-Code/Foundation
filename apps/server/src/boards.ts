/**
 * Boards: one Y.Doc per board, held in memory while anyone (person or agent)
 * is on it, persisted as an append-only update log in SQLite and compacted
 * into a single snapshot row when the log grows. This is flowform-server's
 * room model (Yjs CRDT + durable log), in TypeScript.
 *
 * Wire protocol at /sync/:boardId is the standard y-protocols one (sync step
 * 1/2 + updates, awareness for cursors and presence), so any Yjs provider
 * speaks it.
 */

import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { WebSocket } from "ws";
import { appendSection, boardMaps, describeBoard, logActivity, noteTextOf, tableCellsOf, uid, type ObjectDoc, type PanelDoc } from "@foundation/protocol";
import { all, db, indexDoc, one, run, unindexDoc } from "./db.ts";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const COMPACT_AFTER = 500;

export interface Board {
  id: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>;
  pendingIndex: ReturnType<typeof setTimeout> | null;
}

const boards = new Map<string, Board>();
const boardListeners = new Set<(boardId: string, doc: Y.Doc) => void>();

export function onBoardChange(fn: (boardId: string, doc: Y.Doc) => void) {
  boardListeners.add(fn);
}

const updateListeners = new Set<(boardId: string, update: Uint8Array, at: number, origin: unknown) => void>();
/** every change applied to a board's document (not its loading from disk; not awareness), with when and its origin; returns an unsubscribe (replay.ts keeps a recorded session's) */
export function onBoardUpdate(fn: (boardId: string, update: Uint8Array, at: number, origin: unknown) => void): () => void {
  updateListeners.add(fn);
  return () => updateListeners.delete(fn);
}

const openListeners = new Set<(board: Board) => void>();
/** a board is loaded into memory (each time: closeBoards forgets them) */
export function onBoardOpen(fn: (board: Board) => void) {
  openListeners.add(fn);
}

/**
 * what a space's canvas is: the grid, a deck of slides (a grid whose sections are the slides), a web page,
 * or an app opened as a tab of its own (T3, Vision, anything that was a card or a tool and was expanded)
 */
export type SpaceKind = "grid" | "deck" | "page" | "app";
export const SPACE_KINDS: SpaceKind[] = ["grid", "deck", "page", "app"];
/** a space with no grid to look at: its canvas is a page */
export const isPageKind = (k: SpaceKind) => k === "page" || k === "app";
/** the look a grid pins for itself; anything else is paper, which follows the orb */
export type SpaceTheme = "day" | "night";
export const cleanTheme = (v: unknown): SpaceTheme | null => (v === "day" || v === "night" ? v : null);
/** the apps Foundation itself knows how to open as a tab (their address is minted when they open) */
export const BUILT_IN_APPS = ["t3"] as const;

export interface BoardRow {
  id: string;
  name: string;
  updated_at: number;
  kind: SpaceKind;
  /** its project folder, "/"-separated ("Fans/Rim drive"); null when loose */
  folder: string | null;
  /** a page space's address */
  url: string | null;
  /** the grid this one sits inside (a grid of grids); null at the top */
  parent: string | null;
  /** the look it pins ('day' | 'night'); null: paper, following the orb */
  theme: SpaceTheme | null;
  /** an app space's built-in app ('t3'); null for an app at its url, and for everything else */
  app: string | null;
}

export function listBoards(): BoardRow[] {
  return all<Omit<BoardRow, "kind"> & { kind: string | null }>("select id, name, updated_at, kind, folder, url, parent, theme, app from boards order by updated_at desc").map((b) => ({
    ...b,
    kind: SPACE_KINDS.includes(b.kind as SpaceKind) ? (b.kind as SpaceKind) : "grid",
    theme: cleanTheme(b.theme),
    app: b.app ?? null,
  }));
}

export function ensureBoardRow(id: string, name: string) {
  if (!one("select id from boards where id = ?", id)) {
    run("insert into boards (id, name, created_at, updated_at) values (?, ?, ?, ?)", id, name, Date.now(), Date.now());
  }
}

/** a folder path as stored: trimmed parts joined by "/", at most four deep; null for none */
export function cleanFolder(folder: unknown): string | null {
  if (typeof folder !== "string") return null;
  const parts = folder
    .split("/")
    .map((p) => p.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 4);
  return parts.length ? parts.join("/") : null;
}

/** a page space's address: http(s) only */
export function cleanPageUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** make a space's row; the id comes from its name and never lands on one that exists */
export function createBoardRow(name: string, opts: { kind?: SpaceKind; folder?: string | null; url?: string | null; app?: string | null } = {}): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "space";
  let id = base;
  for (let n = 2; one("select id from boards where id = ?", id); n++) id = `${base}-${n}`;
  const now = Date.now();
  run("insert into boards (id, name, created_at, updated_at, kind, folder, url, app) values (?, ?, ?, ?, ?, ?, ?, ?)", id, name, now, now, opts.kind ?? "grid", opts.folder ?? null, opts.url ?? null, opts.app ?? null);
  return id;
}

/** rename a space, move it to a folder (null: out of any), or point a page space somewhere else */
export function updateBoardRow(id: string, patch: { name?: string; folder?: string | null; url?: string; theme?: SpaceTheme | null }) {
  if (patch.theme !== undefined) run("update boards set theme = ? where id = ?", patch.theme, id);
  if (patch.name !== undefined) {
    run("update boards set name = ? where id = ?", patch.name, id);
    // the section that stands for it in its parent grid wears its name
    const parent = one<{ parent: string | null }>("select parent from boards where id = ?", id)?.parent;
    if (parent) linkChildGrid(parent, id, patch.name);
    renameLeftovers(id, patch.name);
  }
  if (patch.folder !== undefined) run("update boards set folder = ? where id = ?", patch.folder, id);
  if (patch.url !== undefined) run("update boards set url = ? where id = ?", patch.url, id);
}

export function getBoard(id: string): Board {
  const existing = boards.get(id);
  if (existing) return existing;

  ensureBoardRow(id, id === "company" ? "Form Industries" : id);
  const doc = new Y.Doc({ gc: true });
  const rows = all<{ update_blob: Uint8Array }>("select update_blob from board_updates where board_id = ? order by seq", id);
  for (const r of rows) Y.applyUpdate(doc, r.update_blob, "load");

  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const board: Board = { id, doc, awareness, conns: new Map(), pendingIndex: null };

  let sinceCompact = rows.length;
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "load") return;
    run("insert into board_updates (board_id, update_blob, at) values (?, ?, ?)", id, update, Date.now());
    run("update boards set updated_at = ? where id = ?", Date.now(), id);
    if (++sinceCompact >= COMPACT_AFTER) {
      compact(board);
      sinceCompact = 1;
    }
    // broadcast to every socket except the one that sent it
    const msg = encoding.createEncoder();
    encoding.writeVarUint(msg, MSG_SYNC);
    syncProtocol.writeUpdate(msg, update);
    const data = encoding.toUint8Array(msg);
    for (const ws of board.conns.keys()) if (ws !== origin) send(ws, data);
    scheduleIndex(board);
    for (const fn of boardListeners) fn(id, doc);
    for (const fn of updateListeners) fn(id, update, Date.now(), origin);
  });

  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = added.concat(updated, removed);
    if (origin && board.conns.has(origin as WebSocket)) {
      const ids = board.conns.get(origin as WebSocket)!;
      for (const c of added) ids.add(c);
      for (const c of removed) ids.delete(c);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    const data = encoding.toUint8Array(enc);
    for (const ws of board.conns.keys()) send(ws, data);
  });

  boards.set(id, board);
  guardServerMaps(board);
  for (const fn of openListeners) fn(board);
  // the board's lineage: a device's offline copy only merges into the board it came from
  if (!boardMaps(doc).meta.get("epoch")) doc.transact(() => boardMaps(doc).meta.set("epoch", `ep_${randomUUID()}`), "system");
  scheduleIndex(board);
  return board;
}

/** which board this is, across deletes and re-creations (see getBoard) */
export function boardEpoch(id: string): string {
  return String(boardMaps(getBoard(id).doc).meta.get("epoch"));
}

function compact(board: Board) {
  const snapshot = Y.encodeStateAsUpdate(board.doc);
  const last = one<{ seq: number }>("select max(seq) as seq from board_updates where board_id = ?", board.id);
  run("delete from board_updates where board_id = ? and seq <= ?", board.id, last?.seq ?? 0);
  run("insert into board_updates (board_id, update_blob, at) values (?, ?, ?)", board.id, snapshot, Date.now());
}

/** Board text goes into the search index a beat after edits settle. */
function scheduleIndex(board: Board) {
  if (board.pendingIndex) clearTimeout(board.pendingIndex);
  board.pendingIndex = setTimeout(() => {
    board.pendingIndex = null;
    indexBoard(board);
  }, 800);
}

const indexedRefs = new Map<string, Set<string>>();

function indexBoard(board: Board) {
  const m = boardMaps(board.doc);
  const seen = new Set<string>();
  const sectionName = (id: string) => m.sections.get(id)?.name ?? "";
  for (const o of m.objects.values()) {
    const ref = o.id;
    seen.add(ref);
    indexDoc("board", ref, board.id, o.name, objectText(o, o.kind === "note" ? noteTextOf(board.doc, o) : undefined, o.kind === "table" ? tableCellsOf(board.doc, o.id) : undefined) + " " + sectionName(o.sectionId));
  }
  // only what this board indexed: a card moved to another grid keeps its id, and that grid's entry stays
  for (const ref of indexedRefs.get(board.id) ?? []) if (!seen.has(ref)) unindexDoc("board", ref, board.id);
  indexedRefs.set(board.id, seen);
}

function objectText(o: ObjectDoc, note: string | undefined, cells?: Record<string, string>): string {
  switch (o.kind) {
    case "note":
      return note ?? "";
    case "table":
      return Object.values(cells ?? {}).join(" ");
    case "panel":
      return [o.panel, o.url, o.repo, o.text, o.assignee, o.connector].filter(Boolean).join(" ");
    default:
      return o.kind;
  }
}

function send(ws: WebSocket, data: Uint8Array) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(data);
  } catch {
    ws.close();
  }
}

/** who each sync socket belongs to, so a role change can make them reconnect */
const socketUser = new WeakMap<WebSocket, string>();
/** and their name, for the activity log */

/** the person behind a sync socket (a change's transaction origin), if it is one */
export function socketUserId(origin: unknown): string | undefined {
  return origin && typeof origin === "object" ? socketUser.get(origin as WebSocket) : undefined;
}

/** `readOnly`: a viewer — they get the board and send presence, but their updates are dropped */
export function attachConnection(boardId: string, ws: WebSocket, readOnly = false, userId?: string) {
  const board = getBoard(boardId);
  if (userId) socketUser.set(ws, userId);
  board.conns.set(ws, new Set());
  ws.binaryType = "arraybuffer";

  ws.on("message", (raw: ArrayBuffer | Buffer) => {
    const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      if (readOnly) {
        // a viewer may ask for the board (step 1); anything that would change it is dropped
        if (decoding.readVarUint(dec) !== syncProtocol.messageYjsSyncStep1) return;
        syncProtocol.readSyncStep1(dec, enc, board.doc);
      } else syncProtocol.readSyncMessage(dec, enc, board.doc, ws);
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(board.awareness, decoding.readVarUint8Array(dec), ws);
    }
  });

  ws.on("close", () => {
    const ids = board.conns.get(ws);
    board.conns.delete(ws);
    if (ids?.size) awarenessProtocol.removeAwarenessStates(board.awareness, [...ids], null);
  });

  // sync step 1 from the server, then the current awareness
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, board.doc);
  send(ws, encoding.toUint8Array(enc));
  const states = board.awareness.getStates();
  if (states.size) {
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, MSG_AWARENESS);
    encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(board.awareness, [...states.keys()]));
    send(ws, encoding.toUint8Array(aw));
  }
}

/**
 * Maps only the server writes (`huddles`: who's in a portal; `machineAsks`: commands agents asked
 * to run). A person's sync socket can still send a change to them (the Yjs wire has no per-map
 * permissions), so a change that came from a socket is put back the way the server left it, and
 * everyone, the sender included, gets the correction. Without this, someone with edit rights could
 * make a fake ask appear on a machine card or rewrite who is in a huddle.
 */
export const SERVER_MAPS = ["huddles", "machineAsks", "slack", "characters", "agents", "collections", "desktopLeave", "uploaders", "local", "localWatch"] as const;
function guardServerMaps(board: Board) {
  for (const name of SERVER_MAPS) {
    const map = board.doc.getMap<unknown>(name);
    const kept = new Map<string, unknown>();
    for (const [k, v] of map.entries()) kept.set(k, structuredClone(v));
    map.observe((e) => {
      const fromSocket = e.transaction.origin && board.conns.has(e.transaction.origin as WebSocket);
      if (!fromSocket) {
        for (const k of e.keysChanged) {
          if (map.has(k)) kept.set(k, structuredClone(map.get(k)));
          else kept.delete(k);
        }
        return;
      }
      board.doc.transact(() => {
        for (const k of e.keysChanged) {
          if (kept.has(k)) map.set(k, structuredClone(kept.get(k)));
          else map.delete(k);
        }
      }, "server-map-guard");
    });
  }
}

/** Who is on a board right now (from awareness). */
export function presence(boardId: string) {
  const board = boards.get(boardId);
  if (!board) return [];
  return [...board.awareness.getStates().values()]
    .map((s) => (s as { user?: { name: string; color: string; email?: string } }).user)
    .filter(Boolean);
}

/** the grids open on this server right now (loaded, whether or not anyone is on them) */
export function liveBoardIds(): string[] {
  return [...boards.keys()];
}

/**
 * Who is on a grid right now, from its awareness (whereabouts.ts): the people by the account each sync socket signed
 * in as (a window's own claim to a name is shown, but who it is comes from the socket), and the agents by their crew
 * presence. An agent's presence is the server's own (crew.ts bridges it in; no socket owns it): one a person's window
 * sends, claiming to be an agent, is not counted as one. A presence no socket owns and that isn't an agent's is left out.
 */
export function whoIsOn(boardId: string): {
  people: Array<{ id: string; name: string; color: string }>;
  agents: Array<{ id: string; name?: string; hue: number; via?: string; status?: string; doing?: string; askerName?: string }>;
} {
  const board = boards.get(boardId);
  if (!board) return { people: [], agents: [] };
  const states = board.awareness.getStates();
  const people: Array<{ id: string; name: string; color: string }> = [];
  const owned = new Set<number>();
  for (const ids of board.conns.values()) for (const c of ids) owned.add(c);
  for (const [ws, ids] of board.conns) {
    const id = socketUser.get(ws);
    if (!id) continue;
    for (const c of ids) {
      const st = states.get(c) as { user?: { name?: string; color?: string; agent?: boolean } } | undefined;
      if (!st?.user || st.user.agent) continue;
      people.push({ id, name: String(st.user.name ?? ""), color: String(st.user.color ?? "") });
      break;
    }
  }
  const agents: ReturnType<typeof whoIsOn>["agents"] = [];
  for (const [clientId, st] of states) {
    if (owned.has(clientId)) continue;
    const s = st as { user?: { name?: string }; crew?: { id?: string; hue?: number; via?: string; status?: string; doing?: string; askerName?: string } } | undefined;
    if (!s?.crew?.id) continue;
    agents.push({ id: s.crew.id, name: s.user?.name, hue: Number(s.crew.hue ?? 0), via: s.crew.via, status: s.crew.status, doing: s.crew.doing, askerName: s.crew.askerName });
  }
  return { people, agents };
}

/** Run an edit against a board as an agent or service (origin tags the change). */
export function editBoard<T>(boardId: string, origin: string, fn: (doc: Y.Doc) => T): T {
  const board = getBoard(boardId);
  let out!: T;
  board.doc.transact(() => {
    out = fn(board.doc);
  }, origin);
  return out;
}

export function boardDigest(boardId: string) {
  return describeBoard(getBoard(boardId).doc);
}

const closedListeners = new Set<() => void>();
/** told when closeBoards runs (tests, shutdown) */
export function onBoardsClosed(fn: () => void) {
  closedListeners.add(fn);
}

/** release every board's timers (tests, shutdown) */
export function closeBoards() {
  for (const fn of closedListeners) fn();
  for (const b of boards.values()) {
    if (b.pendingIndex) clearTimeout(b.pendingIndex);
    b.awareness.destroy();
    b.doc.destroy();
  }
  boards.clear();
}

/** a person's role on a board changed: close their sockets, and the client reconnects under the new role */
export function dropConnections(boardId: string, userId: string) {
  const board = boards.get(boardId);
  if (!board) return 0;
  let n = 0;
  for (const ws of board.conns.keys()) {
    if (socketUser.get(ws) !== userId) continue;
    ws.close(4001, "role changed");
    n++;
  }
  return n;
}

/**
 * What a sync socket may do. `said` is the epoch the client says it holds
 * (empty: it holds no board yet; missing: a build from before epochs).
 * A copy of a board the server has since made again is refused, so it can't
 * pour the old board into the new one; a client that doesn't say can read.
 */
export function syncAccess(said: string | null, epoch: string, writer: boolean): "refuse" | "read" | "write" {
  if (said && said !== epoch) return "refuse";
  if (said === null || !writer) return "read";
  return "write";
}

// ---------- grids of grids (2026-11-15) ----------

/** the card that stands for a child grid on its parent, and the section that holds it */
function childLink(doc: Y.Doc, childId: string) {
  const m = boardMaps(doc);
  const card = [...m.objects.values()].find((o) => o.kind === "panel" && o.panel === "grid" && o.board === childId) as PanelDoc | undefined;
  return { m, card, section: card ? m.sections.get(card.sectionId) : undefined };
}

/**
 * A child grid shows on its parent as a section of its own that stands for it (the section hosts a "grid"
 * card: its name, what's in it, a press opens it). Made once, renamed with the child; the server keeps it,
 * so two people filing the same grid don't each make one.
 */
function linkChildGrid(parentId: string, childId: string, name: string) {
  editBoard(parentId, "system", (doc) => {
    const { m, card, section } = childLink(doc, childId);
    if (card) {
      if (card.name !== name) m.objects.set(card.id, { ...card, name });
      if (section && section.host === card.id && section.name !== name) m.sections.set(section.id, { ...section, name });
      return;
    }
    const sec = appendSection(doc, name);
    const panel: PanelDoc = { id: uid("pnl"), kind: "panel", panel: "grid", sectionId: sec.id, name, x: 0, y: 0, float: false, bornAt: Date.now(), w: 720, h: 520, ports: [], board: childId };
    m.objects.set(panel.id, panel);
    m.sections.set(sec.id, { ...sec, host: panel.id });
  });
}

// A grid that left the grid it was in (to the top, or into another) leaves its card behind there: the
// old grid keeps a preview of it and a link to where it went (2026-11-17, Josh: "still maintain a preview
// in the Grid it used to be in, and maintain a link to the new location"). Which grids hold such a
// card is written down, so a rename reaches them too. A person takes one away like any card.
db.exec("create table if not exists grid_leftovers (board_id text not null, child_id text not null, at integer not null, primary key (board_id, child_id))");

/** the grids that keep a card for a grid that was once inside them */
export function leftoverLinks(childId: string): string[] {
  return all<{ board_id: string }>("select board_id from grid_leftovers where child_id = ?", childId).map((r) => r.board_id);
}

/** a card left for a grid that moved went to another grid with its section (subgrids.ts): the note of it follows */
export function moveLeftover(fromBoard: string, toBoard: string, childId: string) {
  run("delete from grid_leftovers where board_id = ? and child_id = ?", fromBoard, childId);
  run("insert or replace into grid_leftovers (board_id, child_id, at) values (?, ?, ?)", toBoard, childId, Date.now());
}

/** the child left: its card stays on the grid it was in, and that grid's log says where it went */
function leaveLink(oldParentId: string, childId: string, name: string, where: string) {
  const kept = editBoard(oldParentId, "system", (doc) => {
    const { card } = childLink(doc, childId);
    if (!card) return false;
    logActivity(doc, { who: "Foundation", role: "system", text: `“${name}” moved out of this grid: now ${where}. Its card here still shows it and opens it`, objectId: card.id });
    return true;
  });
  if (kept) run("insert or replace into grid_leftovers (board_id, child_id, at) values (?, ?, ?)", oldParentId, childId, Date.now());
}

/** rename the cards left behind for a grid, and forget the ones a person has since removed */
function renameLeftovers(childId: string, name: string) {
  for (const boardId of leftoverLinks(childId)) {
    if (!one("select id from boards where id = ?", boardId)) continue;
    const there = editBoard(boardId, "system", (doc) => {
      const { m, card, section } = childLink(doc, childId);
      if (!card) return false;
      if (card.name !== name) m.objects.set(card.id, { ...card, name });
      if (section && section.host === card.id && section.name !== name) m.sections.set(section.id, { ...section, name });
      return true;
    });
    if (!there) run("delete from grid_leftovers where board_id = ? and child_id = ?", boardId, childId);
  }
}

/**
 * Put a grid inside another (or, with null, back at the top). Refused when it would make a loop.
 * The parent grid gets a section that stands for the child. The grid it left keeps its card: a
 * preview of the grid and a link to where it is now (the card asks where the grid is, so it says
 * "now at the top of All Grids" or "now inside Motors" by itself).
 */
export function setBoardParent(id: string, parent: string | null): { ok: true } | { error: string } {
  const rows = new Map(listBoards().map((b) => [b.id, b]));
  const me = rows.get(id);
  if (!me) return { error: "No such grid" };
  if (parent !== null) {
    const p = rows.get(parent);
    if (!p) return { error: "No such grid to put it in" };
    if (isPageKind(p.kind)) return { error: p.kind === "app" ? "An app can't hold grids" : "A web page can't hold grids" };
    for (let at: string | null = parent, n = 0; at && n < 64; at = rows.get(at)?.parent ?? null, n++) {
      if (at === id) return { error: parent === id ? "A grid can't go inside itself" : `${p.name} is inside ${me.name} already` };
    }
  }
  if (me.parent === parent) return { ok: true };
  run("update boards set parent = ? where id = ?", parent, id);
  if (me.parent && rows.has(me.parent)) leaveLink(me.parent, id, me.name, parent ? `inside ${rows.get(parent)!.name}` : "at the top of All Grids");
  if (parent) {
    // back where a card for it was left: that card is its link again
    run("delete from grid_leftovers where board_id = ? and child_id = ?", parent, id);
    linkChildGrid(parent, id, me.name);
  }
  return { ok: true };
}

/** a section of `parentId` became the grid `childId` (subgrids.ts writes the card that stands for it): the row says so */
export function adoptChildGrid(childId: string, parentId: string) {
  run("update boards set parent = ? where id = ?", parentId, childId);
}

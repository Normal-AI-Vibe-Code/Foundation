/**
 * The server's sockets — board sync (/sync/:board), huddles
 * (/huddle/:board/:id), a machine's shared terminal
 * (/machines/:board/:panel/tty) and its desktop (/machines/:board/:panel/vnc)
 * — and how a socket proves who opens it.
 *
 * A browser on the server's own site sends its session cookie with the
 * upgrade, and a program (an agent, a test) can send an Authorization header.
 * A browser can't put a header on a WebSocket, though, and the desktop app
 * talking to a hosted server holds a bearer, not a cookie (the cookie is
 * SameSite and the app's page is another site). So, like T3's
 * websocket-ticket, it first asks `POST /api/ws-ticket { path }` with its
 * bearer and opens `path?ticket=…`. A ticket:
 *
 *  - is not the session: 32 random bytes, only its sha256 kept;
 *  - lives 30 seconds and is deleted as it is read (one socket, once);
 *  - opens only the socket path it was issued for (that kind, that board,
 *    that huddle or machine), and only if its session is still live;
 *  - is never read by an HTTP route, so it can't stand in for the session.
 *
 * What the socket may then do is decided as for any other: a viewer's sync
 * socket is read-only, a viewer watches a terminal.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { UserInfo } from "@foundation/protocol";
import type { WebSocketServer } from "ws";
import { hashToken, isPerson, isServiceToken, requireUser, tokenFrom, userFromRequest, userFromSessionHash } from "./auth.ts";
import { attachHostTerminal, HOST_TERM_PATH, spendHostTerminalKey } from "./hostterm.ts";
import { attachHostBrowser, HOST_BROWSER_PATH, spendHostBrowser } from "./hostbrowser.ts";
import { one, run } from "./db.ts";
import { CLOSE_TOO_OLD, clientTooOld } from "./clientversion.ts";
import { HttpError, type Req } from "./http.ts";
import { attachConnection, boardEpoch, syncAccess } from "./boards.ts";
import { attachHuddle } from "./huddles.ts";
import { attachChat, CHAT_SOCKET_PATH, chatSocketIsPerson } from "./chatsock.ts";
import { attachTerminal } from "./machines.ts";
import { attachDesktop } from "./machinedesktop.ts";
import { portTarget, relayUpgrade } from "./machineshare.ts";
import { canSeeBoard } from "./members.ts";
import { canWrite } from "./roles.ts";
import { cookieOriginRefusal } from "./origins.ts";

export const TICKET_TTL_MS = 30_000;
/** tests move the clock */
export const ticketClock = { now: () => Date.now() };

const ID = "[A-Za-z0-9_-]{1,64}";
const SYNC = new RegExp(`^/sync/(${ID})$`);
const HUDDLE = new RegExp(`^/huddle/(${ID})/(${ID})$`);
const TTY = new RegExp(`^/machines/(${ID})/(${ID})/tty$`);
const VNC = new RegExp(`^/machines/(${ID})/(${ID})/vnc$`);

/** the board a socket path belongs to, or null if it isn't one of ours */
export function socketBoard(path: string): string | null {
  // ChatForm's one socket: the reserved board "chat" (open to everyone signed in); chat.ts decides what each event reaches
  if (path === CHAT_SOCKET_PATH) return "chat";
  return (SYNC.exec(path) ?? HUDDLE.exec(path) ?? TTY.exec(path) ?? VNC.exec(path))?.[1] ?? null;
}

/** `POST /api/ws-ticket { path }`: a one-time ticket for that one socket */
export function issueTicket(req: Req, path: unknown): { ticket: string; expiresIn: number } {
  const user = requireUser(req);
  if (typeof path !== "string") throw new HttpError(400, "path (the socket's path, e.g. /sync/company) required");
  const board = socketBoard(path);
  if (!board) throw new HttpError(400, "not a socket path");
  // a restricted board answers like a missing one
  if (!canSeeBoard(user, board)) throw new HttpError(404, "no such board");
  const token = tokenFrom(req);
  // the service token has no session to bind a ticket to: it can send its header on the socket itself
  if (!token || isServiceToken(token)) throw new HttpError(400, "tickets are for sign-in sessions; send Authorization on the socket");
  const now = ticketClock.now();
  run("delete from ws_tickets where expires_at <= ?", now);
  const ticket = randomBytes(32).toString("base64url");
  // the ticket records whether a person asked for it (their browser's cookie, or their app's sign-in bearer) or an
  // agent did: a machine's terminal and desktop take input from a person only
  const person = isPerson(req) ? 1 : 0;
  run(
    "insert into ws_tickets (ticket_hash, session_hash, user_id, path, created_at, expires_at, person) values (?, ?, ?, ?, ?, ?, ?)",
    hashToken(ticket),
    hashToken(token),
    user.id,
    path,
    now,
    now + TICKET_TTL_MS,
    person,
  );
  return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
}

/** who opens a socket, and whether they are a person (not an agent, an MCP client or the service token) */
export interface SocketWho {
  user: UserInfo;
  person: boolean;
}

/**
 * Spend a ticket on the socket at `path`. It's deleted whatever the outcome,
 * so a ticket tried on the wrong path is gone too. The person is whoever its
 * session is now (a session signed out since gets nothing). A ticket made
 * before tickets recorded who asked is not a person's.
 */
export function spendTicket(ticket: string, path: string): SocketWho | null {
  const row = one<{ session_hash: string; user_id: string; path: string; expires_at: number; person: number | null }>(
    "delete from ws_tickets where ticket_hash = ? returning session_hash, user_id, path, expires_at, person",
    hashToken(ticket),
  );
  if (!row || row.expires_at <= ticketClock.now() || row.path !== path) return null;
  const found = userFromSessionHash(row.session_hash);
  if (!found || found.id !== row.user_id) return null;
  const { kind, ...user } = found;
  return { user, person: row.person === 1 && kind !== "agent" };
}

/** who opens this socket: a ticket in the URL if there is one (and only it), else the cookie or Authorization */
export function socketWho(req: IncomingMessage, url: URL): SocketWho | null {
  const ticket = url.searchParams.get("ticket");
  if (ticket !== null) return spendTicket(ticket, url.pathname);
  const user = userFromRequest(req as Req);
  return user ? { user, person: isPerson(req as Req) } : null;
}

export function socketUser(req: IncomingMessage, url: URL): UserInfo | null {
  return socketWho(req, url)?.user ?? null;
}

/** may this socket type into a machine's terminal or move its desktop's pointer: a person, who can edit the board */
export const machineInput = (who: SocketWho, boardId: string) => who.person && canWrite(who.user.id, boardId);

/** the server's upgrade handler: every socket goes through socketUser, then its board's rules */
export function handleUpgrade(wss: WebSocketServer, rawReq: IncomingMessage, socket: Duplex, head: Buffer) {
  const req = rawReq as Req;
  const url = new URL(req.url ?? "/", "http://local");
  req.query = url.searchParams;
  // the built-in terminal: its one-time key (minted for a person, an admin, by POST /api/host-terminal) is the
  // only way in; no cookie, bearer or ticket opens it (hostterm.ts)
  const ht = HOST_TERM_PATH.exec(url.pathname);
  if (ht) {
    const who = spendHostTerminalKey(ht[1], req.query.get("key"));
    if (!who) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachHostTerminal(ht[1], ws, who));
    return;
  }
  // the built-in browser: the same rule, its own key (POST /api/host-browser; hostbrowser.ts)
  const hb = HOST_BROWSER_PATH.exec(url.pathname);
  if (hb) {
    const who = spendHostBrowser(hb[1], req.query.get("key"));
    if (!who) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachHostBrowser(hb[1], ws, who.user, who.page));
    return;
  }
  // a socket signed in by the cookie is opened by one of our own pages (cross-site WebSocket hijacking: origins.ts)
  if (cookieOriginRefusal(req, { upgrade: true, ticket: url.searchParams.has("ticket") })) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const who = socketWho(req, url);
  const user = who?.user ?? null;
  // ChatForm (chatsock.ts): a person's socket speaks as that person, anything else as an agent
  if (url.pathname === CHAT_SOCKET_PATH) {
    if (!who) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachChat(ws, who.user, who.person));
    return;
  }
  // a machine's web port, relayed (machineshare.ts): its app's own sockets, for anyone who can see the board
  if (url.pathname.startsWith("/m/")) {
    const t = portTarget(url.pathname);
    if (!t || !user || !canSeeBoard(user, t.board)) {
      socket.write(`HTTP/1.1 ${t ? 401 : 404} ${t ? "Unauthorized" : "Not Found"}\r\n\r\n`);
      socket.destroy();
      return;
    }
    relayUpgrade(req, socket, head, t, url.search);
    return;
  }
  const hm = HUDDLE.exec(url.pathname);
  // a channel's huddle seats people only (huddles.ts decides)
  const huddlePerson = Boolean(who?.person);
  if (hm && user && canSeeBoard(user, hm[1])) {
    wss.handleUpgrade(req, socket, head, (ws) => attachHuddle(hm[1], hm[2], ws, user, req.query.get("send") === "1", huddlePerson));
    return;
  }
  // a machine card's shared terminal: a person who can edit types; viewers, agents and the service token watch
  // (an agent runs a command with machine_run, which a person presses)
  const tm = TTY.exec(url.pathname);
  if (tm && user && canSeeBoard(user, tm[1])) {
    const canType = machineInput(who!, tm[1]);
    wss.handleUpgrade(req, socket, head, (ws) => void attachTerminal(tm[1], tm[2], ws, user, canType));
    return;
  }
  // a machine's desktop (VNC, relayed): a person who can edit gets the pointer and keys; viewers, agents and the
  // service token the view-only screen (agents act through the desktop tools, where a person let them)
  const vm = VNC.exec(url.pathname);
  if (vm && user && canSeeBoard(user, vm[1])) {
    const canType = machineInput(who!, vm[1]);
    wss.handleUpgrade(req, socket, head, (ws) => void attachDesktop(vm[1], vm[2], ws, user, canType));
    return;
  }
  const m = SYNC.exec(url.pathname);
  if (!m || !user || !canSeeBoard(user, m[1])) {
    const known = Boolean(m || hm || tm || vm);
    socket.write(`HTTP/1.1 ${known ? 401 : 404} ${known ? "Unauthorized" : "Not Found"}\r\n\r\n`);
    socket.destroy();
    return;
  }
  // the board a client holds must be this board: a copy from before a reset is refused, and a client
  // that doesn't say (a build from before epochs) can read but not write until it reloads
  const access = syncAccess(req.query.get("epoch"), boardEpoch(m[1]), canWrite(user.id, m[1]));
  // a client older than this server's minimum doesn't sync a board it might misread (clientversion.ts)
  const tooOld = clientTooOld(req.query.get("client"), req.headers.origin);
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (tooOld) return ws.close(CLOSE_TOO_OLD, "update Foundation");
    if (access === "refuse") return ws.close(4002, "this board was reset");
    attachConnection(m[1], ws, access === "read", user.id);
  });
}

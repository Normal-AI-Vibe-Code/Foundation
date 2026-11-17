/**
 * Invariant: session tokens are stored hashed and never travel in URLs.
 *
 * The desktop app on a hosted server holds a bearer (its cookie can't reach
 * another site), and a browser can't put a header on a WebSocket. So it
 * trades the bearer for a one-time ticket and puts that in the socket URL
 * (sockets.ts, like T3's websocket-ticket). These checks run the server's
 * own upgrade handler on a real port with real sockets: a ticket opens one
 * socket, once, for 30 seconds, on the path it was issued for, while its
 * session lives; it is never the session and never works as one; a viewer's
 * ticketed socket still can't write. Also: the app's bearer counts as a
 * person (it may start a machine) while an agent's bearer doesn't, and no
 * client code puts the bearer anywhere but an Authorization header.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_SERVICE_TOKEN = "s".repeat(40);

const { one, run } = await import("../src/db.ts");
const auth = await import("../src/auth.ts");
const { handleUpgrade, issueTicket, ticketClock, TICKET_TTL_MS } = await import("../src/sockets.ts");
const { boardEpoch, closeBoards, getBoard } = await import("../src/boards.ts");
const { setBoardRole } = await import("../src/roles.ts");
const { setMember } = await import("../src/members.ts");
const { boardMaps, appendSection } = await import("@foundation/protocol");

const boss = auth.upsertUser("boss@formindustries.com", "Boss");
const ada = auth.upsertUser("ada@formindustries.com", "Ada");
const vic = auth.upsertUser("vic@formindustries.com", "Vic");
setBoardRole(boss, "tk", vic.id, "viewer");
for (const id of ["tk", "other"]) {
  const doc = getBoard(id).doc;
  if (boardMaps(doc).sections.size === 0) doc.transact(() => appendSection(doc, "Main"));
}

// what the server saw: every upgrade URL, to check no session token is ever in one
const seen: string[] = [];
let server: Server;
let base = "";
before(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    seen.push(req.url ?? "");
    handleUpgrade(wss, req, socket, head);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  closeBoards();
});

type FakeReq = Parameters<typeof issueTicket>[0];
const reqWith = (headers: Record<string, string>, url = "/api/ws-ticket") =>
  ({ headers, url, query: new URL(url, "http://local").searchParams, params: {} }) as unknown as FakeReq;
const bearer = (token: string) => reqWith({ authorization: `Bearer ${token}` });

/** every raw session token minted here, for the URL check */
const sessionsMinted: string[] = [];

/** an app's sign-in: the bearer it's given at /auth/dev or /auth/flowform/poll with `bearer` */
function appSession(userId: string) {
  const res = { setHeader() { throw new Error("an app sign-in sets no cookie"); } };
  const out = auth.signIn(res as never, userId, true);
  assert.ok(out.session);
  sessionsMinted.push(out.session);
  return out.session;
}

/** open a socket; resolves with it once open, or with the HTTP status it was refused with */
function open(path: string): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((done) => {
    const ws = new WebSocket(base + path);
    ws.binaryType = "arraybuffer";
    ws.once("open", () => done({ ws }));
    ws.once("unexpected-response", (_req, res) => done({ status: res.statusCode }));
    ws.once("error", () => done({ status: -1 }));
  });
}

/** a sync client: answers step 1, and can send an update then wait until the server has handled it */
function syncClient(ws: WebSocket) {
  const doc = new Y.Doc();
  const waiters: Array<() => void> = [];
  ws.on("message", (raw: ArrayBuffer) => {
    const dec = decoding.createDecoder(new Uint8Array(raw));
    if (decoding.readVarUint(dec) !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    const kind = syncProtocol.readSyncMessage(dec, enc, doc, null);
    if (kind === syncProtocol.messageYjsSyncStep2) waiters.shift()?.();
  });
  const roundTrip = () =>
    new Promise<void>((done) => {
      waiters.push(done);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, doc);
      ws.send(encoding.toUint8Array(enc));
    });
  return {
    doc,
    roundTrip,
    async addSection(name: string) {
      const before = Y.encodeStateVector(doc);
      appendSection(doc, name);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc, before));
      ws.send(encoding.toUint8Array(enc));
      await roundTrip(); // processed in order: when this answers, the update has been handled
    },
  };
}

const sections = (id: string) => [...boardMaps(getBoard(id).doc).sections.values()].map((s) => s.name);
const syncPath = (board: string) => `/sync/${board}`;
const withTicket = (path: string, ticket: string, more = "") => `${path}?epoch=${encodeURIComponent(boardEpoch(path.split("/")[2]))}${more}&ticket=${encodeURIComponent(ticket)}`;

test("a ticket opens its one sync socket, and the person's writes land", async () => {
  const session = appSession(ada.id);
  const { ticket, expiresIn } = issueTicket(bearer(session), syncPath("tk"));
  assert.equal(expiresIn, 30);
  assert.notEqual(ticket, session);
  // stored hashed, never the session's hash
  const row = one<{ ticket_hash: string; session_hash: string }>("select ticket_hash, session_hash from ws_tickets");
  assert.equal(row?.ticket_hash, auth.hashToken(ticket));
  assert.equal(row?.session_hash, auth.hashToken(session));
  assert.equal(one("select 1 from ws_tickets where ticket_hash = ?", ticket), undefined, "the ticket itself isn't stored");

  const { ws } = await open(withTicket(syncPath("tk"), ticket));
  assert.ok(ws, "the socket opened");
  const c = syncClient(ws);
  await c.roundTrip();
  assert.ok(boardMaps(c.doc).sections.size >= 1, "the board arrived");
  await c.addSection("From the app");
  assert.ok(sections("tk").includes("From the app"), "Ada's write landed");
  ws.close();
  assert.equal((one<{ n: number }>("select count(*) n from ws_tickets where ticket_hash = ?", auth.hashToken(ticket)))?.n, 0, "spent: gone from the table");
});

test("a ticket is single use: the second socket is refused", async () => {
  const { ticket } = issueTicket(bearer(appSession(ada.id)), syncPath("tk"));
  const first = await open(withTicket(syncPath("tk"), ticket));
  assert.ok(first.ws);
  first.ws.close();
  assert.equal((await open(withTicket(syncPath("tk"), ticket))).status, 401);
});

test("a ticket expires after 30 seconds", async () => {
  const { ticket } = issueTicket(bearer(appSession(ada.id)), syncPath("tk"));
  const real = ticketClock.now;
  const t0 = Date.now();
  ticketClock.now = () => t0 + TICKET_TTL_MS + 1;
  try {
    assert.equal((await open(withTicket(syncPath("tk"), ticket))).status, 401);
  } finally {
    ticketClock.now = real;
  }
});

test("a ticket opens only its own path: another board, a huddle or a terminal is refused, and the try burns it", async () => {
  const session = appSession(ada.id);
  const t1 = issueTicket(bearer(session), syncPath("tk")).ticket;
  assert.equal((await open(withTicket(syncPath("other"), t1))).status, 401, "wrong board");
  assert.equal((await open(withTicket(syncPath("tk"), t1))).status, 401, "burned by the wrong-board try");
  const t2 = issueTicket(bearer(session), syncPath("tk")).ticket;
  assert.equal((await open(`/huddle/tk/h1?ticket=${t2}`)).status, 401, "a sync ticket isn't a huddle ticket");
  const t3 = issueTicket(bearer(session), syncPath("tk")).ticket;
  assert.equal((await open(`/machines/tk/m1/tty?ticket=${t3}`)).status, 401, "nor a terminal's");
  // a ticket in the URL is the only credential looked at: a good cookie beside a bad ticket doesn't open it
  const cookie = auth.createSession(ada.id);
  sessionsMinted.push(cookie);
  const refused = await new Promise<number>((done) => {
    const ws = new WebSocket(`${base}${syncPath("tk")}?epoch=&ticket=nope`, { headers: { cookie: `foundation_session=${cookie}` } });
    ws.once("open", () => (ws.close(), done(101)));
    ws.once("unexpected-response", (_q, res) => done(res.statusCode ?? 0));
  });
  assert.equal(refused, 401);
});

test("tickets are issued only for a socket of a board you can see, and only to a signed-in session", () => {
  const session = appSession(ada.id);
  assert.throws(() => issueTicket(bearer(session), "/api/boards"), /not a socket path/);
  assert.throws(() => issueTicket(bearer(session), "/sync/tk/../other"), /not a socket path/);
  assert.throws(() => issueTicket(bearer("not-a-session"), syncPath("tk")), /sign in first/);
  assert.throws(() => issueTicket(reqWith({}), syncPath("tk")), /sign in first/);
  // a members-only board answers like a missing one
  setMember("secret", boss.id, "owner");
  assert.throws(() => issueTicket(bearer(session), syncPath("secret")), /no such board/);
  // the service token has no session to bind to: it sends its header on the socket
  assert.throws(() => issueTicket(bearer(process.env.FOUNDATION_SERVICE_TOKEN!), syncPath("tk")), /send Authorization on the socket/);
  // huddle and terminal paths are tickets too
  assert.ok(issueTicket(bearer(session), "/huddle/tk/h1").ticket);
  assert.ok(issueTicket(bearer(session), "/machines/tk/m1/tty").ticket);
});

test("a ticket dies with its session: signed out before it's used, it opens nothing", async () => {
  const session = appSession(ada.id);
  const { ticket } = issueTicket(bearer(session), syncPath("tk"));
  auth.revokeSession(session);
  assert.equal((await open(withTicket(syncPath("tk"), ticket))).status, 401);
});

test("a viewer's ticketed socket gets the board, but its writes are dropped", async () => {
  const { ticket } = issueTicket(bearer(appSession(vic.id)), syncPath("tk"));
  const { ws } = await open(withTicket(syncPath("tk"), ticket));
  assert.ok(ws, "a viewer may open the socket");
  const c = syncClient(ws);
  await c.roundTrip();
  assert.ok(boardMaps(c.doc).sections.size >= 1, "the viewer is sent the board");
  await c.addSection("Smuggled in by a viewer");
  assert.ok(!sections("tk").includes("Smuggled in by a viewer"), "the viewer's update changed nothing");
  ws.close();
});

test("a ticket is never a session: not as a bearer, not as a cookie, not in an HTTP URL", () => {
  const session = appSession(ada.id);
  const { ticket } = issueTicket(bearer(session), syncPath("tk"));
  assert.equal(auth.userFromRequest(bearer(ticket)), null);
  assert.equal(auth.userFromRequest(reqWith({ cookie: `foundation_session=${ticket}` })), null);
  assert.equal(auth.userFromRequest(reqWith({}, `/api/me?ticket=${ticket}`)), null);
  // nor does a session in a URL count for anything
  assert.equal(auth.userFromRequest(reqWith({}, `/api/me?token=${session}&session=${session}`)), null);
});

test("no session token ever appears in a socket URL the server saw", () => {
  assert.ok(sessionsMinted.length >= 6 && seen.length >= 8, "sessions were minted and sockets opened above");
  // every URL carries only a ticket (and the epoch, and whether a huddle sends)
  for (const url of seen) {
    const q = new URL(url, "http://local").searchParams;
    for (const k of q.keys()) assert.ok(["epoch", "ticket", "send"].includes(k), `unexpected query key ${k} in ${url}`);
    const t = q.get("ticket");
    if (t) assert.equal(one("select 1 from sessions where token = ?", auth.hashToken(t)), undefined, "a ticket is never a session");
  }
  for (const s of sessionsMinted) for (const url of seen) assert.ok(!url.includes(s), "a session token travelled in a URL");
});

test("the app's bearer is a person (it may start a machine); an agent's bearer, the service token and a bearer beside a cookie are not", () => {
  const app = appSession(ada.id);
  assert.equal(auth.requirePerson(bearer(app), "Starting a machine").id, ada.id);
  const agent = auth.createSession(ada.id, 3600_000, "agent");
  assert.throws(() => auth.requirePerson(bearer(agent), "Starting a machine"), /needs a person/);
  assert.throws(() => auth.requirePerson(reqWith({ cookie: `foundation_session=${agent}` }), "Starting a machine"), /needs a person/, "an agent's token in a cookie is still an agent");
  assert.throws(() => auth.requirePerson(bearer(process.env.FOUNDATION_SERVICE_TOKEN!)), /needs a person/);
  const browser = auth.createSession(ada.id);
  assert.throws(() => auth.requirePerson(reqWith({ authorization: `Bearer ${browser}`, cookie: `foundation_session=${browser}` })), /needs a person/);
  assert.equal(auth.requirePerson(reqWith({ cookie: `foundation_session=${browser}` })).id, ada.id);
  assert.equal(one<{ kind: string }>("select kind from sessions where token = ?", auth.hashToken(app))?.kind, "app");
});

test("client code puts the bearer only in an Authorization header, never in a URL", () => {
  const src = resolve(import.meta.dirname, "../../client/src");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(src);
  let uses = 0;
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!/bearerToken\(\)/.test(line) || /^\s*(export )?function bearerToken/.test(line)) return;
        uses++;
        assert.match(line, /authorization: `Bearer \$\{|const t = bearerToken\(\)/i, `${f}:${i + 1} uses the bearer outside an Authorization header`);
      });
  }
  assert.ok(uses >= 1, "the client reads its bearer somewhere");
  // and nothing builds a URL with a session or token parameter
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /[?&](session|token|access_token|bearer)=\$\{/, `${f} puts a credential in a URL`);
});

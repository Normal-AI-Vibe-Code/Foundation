/**
 * Which server this is, and serving the office network: a person's switch, off by default (docs/server.md).
 *
 * - **What this server is** (`GET /api/server`): its name, version, kind (this computer only, open to the
 *   network, or hosted) and how one signs in, to anyone; since when it's up, its addresses and how many
 *   people are connected, to someone signed in; where its data is, to an admin.
 * - **On your network.** Off, the server listens on 127.0.0.1 only and answers only to its loopback names:
 *   exactly as before. An admin, in person, at this computer, turns it on: the server also listens on each of
 *   this computer's private LAN addresses (10/8, 172.16/12, 192.168/16; not virtual adapters, never every
 *   interface), at the same port, and answers to those addresses and this computer's name (`JOSH-PC`,
 *   `JOSH-PC.local`), each with the port, and nothing else (DNS rebinding stays fenced: origins.ts). It
 *   takes effect at once (extra listeners open or close; the loopback one is never touched), is kept across
 *   restarts, and is recorded in the audit log. `FOUNDATION_NETWORK=1|0` fixes it from the environment.
 * - **The page.** Asked by a network name, the server serves the built client (`apps/client/dist`, or
 *   FOUNDATION_PAGE_DIR) at `/`, same origin, so a teammate opens `http://192.168.1.20:4410` with nothing
 *   installed and the sign-in cookie works with no CORS. Only that folder, only GET/HEAD; hashed assets are
 *   immutable, pages are no-cache. Not on loopback names: there a machine's relayed page (`/m/…`) shares the
 *   server's origin, so that origin is never trusted for a cookie; for the same reason `/m/` is refused on a
 *   network name (a machine's page would share the Foundation page's origin there).
 * - **Invitations.** Google sign-in through Flowform returns only to a loopback address (flowform.ts), so it
 *   can't finish on another computer. An admin at this computer invites a teammate by name and work email
 *   (on the allowlist; never an admin): a one-time link (256 random bits, in the address's #fragment, which
 *   no browser sends) and a short code to type with the email, both stored hashed, for 15 minutes, once, and
 *   only from a private-network address that isn't this computer, rate-limited. Redeeming (a POST) signs that
 *   browser in as that person, with their own role (a member, for someone new). An admin sees who is signed
 *   in from where and signs a row out (its sockets dropped with it).
 * - **This computer only.** Whatever the switch, some doors open only to a request from this computer (a
 *   loopback peer, by a loopback name, with no proxy's forwarding headers): the built-in terminal and
 *   browser, Places, machines and jobs, T3's own agents, a bridge's credentials, apps, agent tokens, the plan's
 *   GitHub sync, spending credits, and this server's own settings, invitations and sign-outs (LOCAL_ONLY).
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { UserInfo } from "@foundation/protocol";
import { config } from "./config.ts";
import { all, one, run, db } from "./db.ts";
import { HttpError, json, readJson, type Req, type Router } from "./http.ts";
import { createSession, fromLoopback, hashToken, isAllowed, isPerson, isServiceToken, requirePerson, tokenFrom, upsertUser, userFromRequest, userFromSessionHash } from "./auth.ts";
import { DESKTOP_PAGE_ORIGINS, isNetworkHost, originAllowedFor, setNetworkNames } from "./origins.ts";
import { audit } from "./audit.ts";
import { SERVER_VERSION } from "./clientversion.ts";
import { childOptions, spawnChild } from "./child.ts";

db.exec(`
create table if not exists server_settings (
  key text primary key,
  value text not null,
  updated_at integer not null,
  updated_by text
);
-- invitations to sign in from another computer on the network: only hashes of the link and the short code
create table if not exists network_invites (
  id text primary key,
  link_hash text not null unique,
  short_hash text not null,
  email text not null,
  name text not null,
  made_by text not null,
  created_at integer not null,
  expires_at integer not null,
  used_at integer,
  used_from text
);
-- sessions signed in from another computer: who, from where, on what, since when (the session itself is in sessions, hashed)
create table if not exists network_sessions (
  id text primary key,
  session_hash text not null unique,
  user_id text not null,
  addr text not null,
  ua text not null,
  via text not null,
  created_at integer not null
);
`);

export const startedAt = Date.now();
/** tests move it */
export const networkClock = { now: () => Date.now() };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------- where a request comes from ----------

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * A request from this computer: a loopback peer, with no proxy's forwarding headers (fromLoopback), naming the
 * server by a loopback name. A reverse proxy on this computer forwards other people's requests from loopback:
 * it says so in X-Forwarded-For (never trusted for anything else), or names the public host; a proxy that does
 * neither is declared with FOUNDATION_BEHIND_PROXY=1, and then nothing is "this computer".
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  if (process.env.FOUNDATION_BEHIND_PROXY === "1") return false;
  return fromLoopback(req as Req) && LOOPBACK_HOST.test(String(req.headers.host ?? ""));
}

const bare = (addr: string) => addr.replace(/^::ffff:/i, "");

/** a private-network IPv4 address a server may listen on: 10/8, 172.16/12, 192.168/16 */
export function isLanV4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** a peer on a private network that isn't this computer's loopback: RFC 1918, link-local, IPv6 unique-local or link-local */
export function isPrivatePeer(addr: string): boolean {
  const a = bare(addr).toLowerCase();
  if (isLanV4(a) || /^169\.254\./.test(a)) return true;
  return /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

// ---------- the switch ----------

const VIRTUAL = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|docker|vboxnet|veth|virbr|^br-|utun|Loopback/i;

/** this computer's private LAN addresses (or FOUNDATION_LAN_ADDRESSES, the ones a person chose), with their adapter */
export function lanAddresses(): Array<{ address: string; iface: string }> {
  const chosen = (process.env.FOUNDATION_LAN_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Array<{ address: string; iface: string }> = [];
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family !== "IPv4" || n.internal || !isLanV4(n.address)) continue;
      if (chosen.length ? !chosen.includes(n.address) : VIRTUAL.test(iface)) continue;
      if (!out.some((o) => o.address === n.address)) out.push({ address: n.address, iface });
    }
  }
  return out;
}

/** this computer's name as teammates may type it, when it is a plain one */
export function machineName(): string | null {
  const h = hostname().trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(h) ? h : null;
}

/** the server itself listens beyond loopback (FOUNDATION_HOST): a rack or hand-made setup, outside the switch */
const boundWide = () => !/^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(config.host);

function setting(key: string): string | null {
  return one<{ value: string }>("select value from server_settings where key = ?", key)?.value ?? null;
}
function setSetting(key: string, value: string, by: string) {
  run("insert into server_settings (key, value, updated_at, updated_by) values (?, ?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by", key, value, networkClock.now(), by);
}

/** whether the switch is on, and who decides: the environment (FOUNDATION_NETWORK) or a person's press */
export function networkSwitch(): { on: boolean; setBy: "switch" | "environment"; at: number | null; by: string | null } {
  const env = process.env.FOUNDATION_NETWORK;
  if (env === "1" || env === "0") return { on: env === "1", setBy: "environment", at: null, by: null };
  const row = one<{ value: string; updated_at: number; updated_by: string | null }>("select value, updated_at, updated_by from server_settings where key = 'network'");
  return { on: row?.value === "1", setBy: "switch", at: row?.updated_at ?? null, by: row?.updated_by ?? null };
}

interface Listening {
  address: string;
  iface: string;
  ok: boolean;
  /** it answered a request at that address from this computer: proof of the bind, not of the firewall */
  answers?: boolean;
  error?: string;
}

let base: Server | null = null;
const lan = new Map<string, Server>();
/** sockets that came in on a network listener: dropped when the switch goes off */
const lanSockets = new Set<Socket>();
let listening: Listening[] = [];

/** the names and page origins the open listeners give (origins.ts takes them) */
function publishNames() {
  const port = config.port;
  const hosts: string[] = [];
  for (const l of listening) if (l.ok) hosts.push(`${l.address}:${port}`);
  const name = machineName();
  if (name && hosts.length) hosts.push(`${name}:${port}`, `${name}.local:${port}`);
  setNetworkNames(hosts, hosts.map((h) => `http://${h}`));
}

/** the addresses teammates can type */
export function networkUrls(): Array<{ url: string; label: string }> {
  const port = config.port;
  const ok = listening.filter((l) => l.ok);
  const out = ok.map((l) => ({ url: `http://${l.address}:${port}`, label: l.iface }));
  const name = machineName();
  if (name && ok.length) out.push({ url: `http://${name.toUpperCase()}.local:${port}`, label: "this computer's name" }, { url: `http://${name.toUpperCase()}:${port}`, label: "this computer's name (Windows)" });
  return out;
}

function listenOn(address: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((done) => {
    const s = createServer();
    // the same doors as the loopback listener: every request and socket goes through index.ts's handlers
    s.on("request", (req, res) => base!.emit("request", req, res));
    s.on("upgrade", (req, sock, head) => base!.emit("upgrade", req, sock, head));
    s.on("connection", (sock: Socket) => {
      lanSockets.add(sock);
      sock.on("close", () => lanSockets.delete(sock));
    });
    s.once("error", (e: NodeJS.ErrnoException) => done({ ok: false, error: e.code === "EADDRINUSE" || e.code === "EACCES" ? `${address}:${config.port} is taken, or Windows has reserved that port (${e.code})` : e.message }));
    s.listen(config.port, address, () => {
      lan.set(address, s);
      done({ ok: true });
    });
  });
}

async function selfProbe(address: string): Promise<boolean> {
  try {
    const r = await fetch(`http://${address}:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function openListeners() {
  if (!base || boundWide()) return;
  const found = lanAddresses();
  const next: Listening[] = [];
  for (const a of found) {
    if (lan.has(a.address)) {
      next.push({ ...a, ok: true });
      continue;
    }
    const r = await listenOn(a.address);
    next.push({ ...a, ok: r.ok, error: r.error });
  }
  listening = next;
  publishNames();
  for (const l of listening) if (l.ok) l.answers = await selfProbe(l.address);
  const ok = listening.filter((l) => l.ok);
  if (ok.length) console.log(`  on your network     ${networkUrls().map((u) => u.url).join("  ")}`);
  else console.log(`  on your network     no private network address to listen on${found.length ? ` (${listening.map((l) => l.error).join("; ")})` : ""}`);
}

async function closeListeners() {
  const servers = [...lan.values()];
  lan.clear();
  listening = [];
  publishNames();
  for (const s of lanSockets) s.destroy();
  lanSockets.clear();
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
}

/** index.ts hands over the server once it listens on loopback: the switch's listeners open now if it is on */
export function attachNetwork(server: Server) {
  base = server;
  if (networkSwitch().on) void openListeners();
}

/** the network is open: listeners up (the switch) */
export const networkActive = () => listening.some((l) => l.ok);

// ---------- who is connected, and from where ----------

/** live sockets by the session that opened them, for dropping them with the session; and every socket's person, for "connected now" */
const bySession = new Map<string, Set<Duplex>>();
const people = new Map<Duplex, string>();
const lastSeen = new Map<string, number>();

function sessionHashOf(req: IncomingMessage): string | null {
  const t = tokenFrom(req as Req);
  if (t && !isServiceToken(t)) return hashToken(t);
  const ticket = new URL(req.url ?? "/", "http://local").searchParams.get("ticket");
  if (ticket) return one<{ session_hash: string }>("select session_hash from ws_tickets where ticket_hash = ?", hashToken(ticket))?.session_hash ?? null;
  return null;
}

function track(hash: string, sock: Duplex) {
  let set = bySession.get(hash);
  if (!set) bySession.set(hash, (set = new Set()));
  if (set.has(sock)) return;
  set.add(sock);
  sock.once("close", () => {
    set!.delete(sock);
    if (!set!.size) bySession.delete(hash);
  });
}

/** how many people have a socket open now (agents and the service token aren't people here) */
export function connectedPeople(): number {
  return new Set(people.values()).size;
}

// ---------- the page ----------

export function pageDir(): string {
  return process.env.FOUNDATION_PAGE_DIR ? resolve(process.env.FOUNDATION_PAGE_DIR) : join(config.root, "apps", "client", "dist");
}
const pageBuilt = () => existsSync(join(pageDir(), "index.html"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** the server's own paths: never the page's, even on a network name */
const SERVER_PATH = /^\/(api|auth|files|mcp|m|sync|huddle|machines|host)(\/|$)|^\/chat$/;

/** the file under the page folder a path names, or null: nothing outside it, no dot-segments, no backslashes, no NUL, no symlink out */
export function pageFile(pathname: string, dir = pageDir()): string | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!p.startsWith("/") || /[\\\0]/.test(p) || p.split("/").some((s) => s === ".." || s === ".")) return null;
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return null;
  }
  const full = resolve(root, `.${p}`);
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

const NO_PAGE = (cmd: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foundation</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 16px;background:Canvas;color:CanvasText}code{font-size:14px}</style>
<h1>Foundation’s page isn’t built here yet</h1>
<p>This is a Foundation server, and it is up. The page people open in a browser hasn’t been built on it.</p>
<p>On the server’s computer, in the Foundation checkout, run <code>${cmd}</code> (or press <b>Build the page</b> in the server panel there), then reload this page.</p>
<p>Or open the Foundation desktop app and point its <b>Server</b> line at this address.</p>`;

/** serve the built client, asked by a network name: true when this answered */
function servePage(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const spa = pathname === "/" || !extname(pathname);
  if (spa && !pageBuilt()) {
    const body = NO_PAGE("npm run build");
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }
  const file = pageFile(spa ? "/index.html" : pathname);
  if (!file) return false;
  const ext = extname(file).toLowerCase();
  const hashed = /^\/assets\//.test(pathname) && /[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(pathname);
  const headers: Record<string, string | number> = {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "content-length": statSync(file).size,
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  };
  // the shell may be framed by nothing; desktop.html only by the app's own page (apps/client/csp.ts)
  if (ext === ".html") headers["content-security-policy"] = `frame-ancestors ${/desktop\.html$/.test(file) ? "'self'" : "'none'"}`;
  res.writeHead(200, headers);
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}

// ---------- building the page (a person's press, at this computer, from a checkout) ----------

let build: { state: "idle" | "building" | "done" | "failed"; at: number | null; error: string | null } = { state: "idle", at: null, error: null };
const viteBin = () => join(config.root, "node_modules", "vite", "bin", "vite.js");
const clientDir = () => join(config.root, "apps", "client");
/** this server runs from a checkout that can build the page (not the desktop app's carried copy) */
export const canBuildPage = () => !process.env.FOUNDATION_PAGE_DIR && existsSync(join(clientDir(), "package.json")) && existsSync(viteBin());

function buildPage(by: UserInfo) {
  if (!canBuildPage()) throw new HttpError(409, "This server doesn't run from a Foundation checkout, so it can't build the page here. Run `npm run build` in a checkout.");
  if (build.state === "building") return build;
  build = { state: "building", at: networkClock.now(), error: null };
  // Foundation's own client, built by the vite this checkout installed (no download, no shell). A person pressed it
  const child = spawnChild(process.execPath, [viteBin(), "build"], childOptions({ extras: [] }, { cwd: clientDir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
  let tail = "";
  const keep = (d: Buffer) => (tail = (tail + d.toString("utf8")).slice(-2000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("error", (e) => (build = { state: "failed", at: networkClock.now(), error: e.message }));
  child.on("close", (code) => {
    build = code === 0 ? { state: "done", at: networkClock.now(), error: null } : { state: "failed", at: networkClock.now(), error: tail.trim().split("\n").slice(-6).join("\n") || `vite exited with ${code}` };
    audit({ actor_kind: "person", actor_id: by.id, actor_name: by.name, door: "route", action: "server.page.build", target: "apps/client/dist", decision: "allowed", approved_by: by.id, result: code === 0 ? "ok" : "error" });
  });
  return build;
}

// ---------- this computer only ----------

/** [method (null: any), path, what] — doors that open only to a request from this computer (isLocalRequest) */
export const LOCAL_ONLY: Array<[string | null, RegExp, string]> = [
  [null, /^\/api\/host-terminal$/, "The built-in terminal"],
  [null, /^\/api\/host-browser$/, "The built-in browser"],
  [null, /^\/api\/places(\/|$)/, "Folders on this computer (Places)"],
  [null, /^\/api\/chat\/attach\/place$/, "Attaching from a folder on this computer"],
  [null, /^\/api\/server\/(network|invites|sessions|page)(\/|$)/, "This server's settings"],
  ["POST", /^\/api\/chat\/bridges\/[^/]+$/, "A bridge's credentials"],
  ["POST", /^\/api\/chat\/bridges\/[^/]+\/(keys|check)$/, "A bridge's credentials"],
  ["POST", /^\/api\/chat\/slack\/(token|check)$/, "The Slack app's token"],
  [null, /^\/api\/t3host\/(start|stop|agents|local|open)(\/|$)/, "T3 on this computer"],
  ["POST", /^\/api\/boards\/[^/]+\/(machines|clusters)\//, "Machines on this computer"],
  ["POST", /^\/api\/boards\/[^/]+\/clusters$/, "Machines on this computer"],
  ["GET", /^\/api\/boards\/[^/]+\/clusters\/[^/]+\/kubeconfig$/, "A cluster's kubeconfig"],
  ["POST", /^\/api\/boards\/[^/]+\/collections\/[^/]+\/machine$/, "Machines on this computer"],
  ["POST", /^\/api\/jobs\/[^/]+\/run$/, "Running a job"],
  ["POST", /^\/api\/apps(\/probe)?$/, "Saving or probing an app"],
  ["POST", /^\/api\/boards\/[^/]+\/apps\/[^/]+\/asks\//, "Allowing an app's tool"],
  ["POST", /^\/api\/agent\/token$/, "Making an agent token"],
  ["POST", /^\/api\/plan\/sync$/, "Syncing the plan with GitHub"],
  ["POST", /^\/api\/boards\/[^/]+\/characters\/[^/]+\/stages\//, "Spending credits on a character"],
];

/** why this request is refused for not coming from this computer, or null */
export function localOnlyRefusal(req: IncomingMessage, pathname: string): string | null {
  const method = String(req.method ?? "GET").toUpperCase();
  const hit = LOCAL_ONLY.find(([m, re]) => (m === null || m === method) && re.test(pathname));
  if (!hit || isLocalRequest(req)) return null;
  return `This works only at the computer this server runs on (${hit[2]}).`;
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const HOST_SOCKET = /^\/host\/(terminal|browser)\//;
const MACHINE_INPUT = /^\/machines\/[^/]+\/[^/]+\/(tty|vnc)$/;

/**
 * Every request passes here first (index.ts), after the Host check: it notes which session a network
 * connection belongs to (to drop it on sign-out), serves the page on network names, refuses `/m/` and
 * the Google doors there, and refuses this-computer-only doors to anyone else. True: it answered.
 */
export function networkFront(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const peer = req.socket?.remoteAddress ?? "";
  // only connections from elsewhere are noted: they are what an admin signs out
  if (!LOOPBACK_PEERS.has(peer)) {
    const hash = sessionHashOf(req);
    if (hash) {
      track(hash, req.socket);
      lastSeen.set(hash, networkClock.now());
    }
  }
  if (isNetworkHost(req)) {
    if (pathname.startsWith("/m/")) {
      json(res, { error: "A machine's port opens at the computer this server runs on. Over the network it would share the Foundation page's address, so it's kept off." }, 403);
      return true;
    }
    if (/^\/auth\/(google\/start|flowform\/start|flowform\/begin)$/.test(pathname)) {
      json(res, { error: "Google sign-in finishes only at the computer this server runs on (Flowform returns to a loopback address). From another computer, ask an admin there for an invitation." }, 403);
      return true;
    }
    if (!SERVER_PATH.test(pathname) && servePage(req, res, pathname)) return true;
  }
  const away = localOnlyRefusal(req, pathname);
  if (away) {
    const u = userFromRequest(req as Req);
    audit({ actor_kind: "person", actor_id: u?.id ?? null, actor_name: u?.name ?? null, door: "route", action: `${req.method ?? "?"} ${pathname}`, target: bare(peer).slice(0, 60), decision: "refused", reason: "this computer only" });
    json(res, { error: away }, 403);
    return true;
  }
  return false;
}

/** sockets: the same fences (index.ts calls this before handleUpgrade); true: refused and closed */
export function networkUpgradeRefusal(req: IncomingMessage, socket: Duplex): boolean {
  const path = new URL(req.url ?? "/", "http://local").pathname;
  const refuse = () => {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return true;
  };
  if (isNetworkHost(req) && path.startsWith("/m/")) return refuse();
  if ((HOST_SOCKET.test(path) || MACHINE_INPUT.test(path)) && !isLocalRequest(req)) return refuse();
  const hash = sessionHashOf(req);
  if (hash) {
    track(hash, socket);
    lastSeen.set(hash, networkClock.now());
    const who = userFromSessionHash(hash);
    if (who && who.kind !== "agent") {
      people.set(socket, who.id);
      socket.once("close", () => people.delete(socket));
    }
  }
  return false;
}

// ---------- invitations ----------

export const INVITE_TTL_MS = 15 * 60_000;
/** an invite's session lasts a week: long enough to try it in the office, short enough to forget */
const INVITE_SESSION_MS = 7 * 864e5;
const SHORT_ALPHABET = "ABCDEFGHJKMNPQRTUVWXY346789";
const normShort = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const shortHash = (email: string, short: string) => sha(`${email.trim().toLowerCase()}:${normShort(short)}`);

function shortCode(): string {
  let c = "";
  for (let i = 0; i < 10; i++) c += SHORT_ALPHABET[randomInt(SHORT_ALPHABET.length)];
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

/** an admin, in person, at this computer (the front door has already checked the computer) */
function requireAdminHere(req: Req, what: string): UserInfo {
  const u = requirePerson(req, what);
  if (u.role !== "admin") throw new HttpError(403, `${what} is for an admin.`);
  if (!isLocalRequest(req)) throw new HttpError(403, `${what} works only at the computer this server runs on.`);
  return u;
}

export function mintInvite(by: UserInfo, body: { email?: unknown; name?: unknown }) {
  if (!networkActive()) throw new HttpError(409, "Turn on “On your network” first: an invitation is opened at one of its addresses.");
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim().slice(0, 80);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Their work email, please.");
  if (!isAllowed(email)) throw new HttpError(403, `${email} isn't on Foundation's allowlist (FOUNDATION_ALLOWLIST), so it can't be invited.`);
  const existing = one<{ role: string }>("select role from users where email = ?", email);
  if (config.adminEmails.includes(email) || existing?.role === "admin") throw new HttpError(403, "An admin signs in with Google, at this computer or on a hosted server: an invitation never makes an admin.");
  const link = randomBytes(32).toString("base64url");
  const short = shortCode();
  const id = `inv_${randomBytes(8).toString("hex")}`;
  const now = networkClock.now();
  run("delete from network_invites where expires_at <= ? or used_at is not null and used_at < ?", now, now - 864e5);
  run(
    "insert into network_invites (id, link_hash, short_hash, email, name, made_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    sha(link),
    shortHash(email, short),
    email,
    name || email.split("@")[0],
    by.id,
    now,
    now + INVITE_TTL_MS,
  );
  audit({ actor_kind: "person", actor_id: by.id, actor_name: by.name, door: "route", action: "invite.mint", target: email, decision: "allowed", approved_by: by.id, result: "ok" });
  return {
    id,
    email,
    name: name || email.split("@")[0],
    code: short,
    links: networkUrls().map((u) => ({ url: `${u.url}/#/join/${link}`, label: u.label })),
    expiresAt: now + INVITE_TTL_MS,
  };
}

/** failed redemptions per address, and in all, in the last 15 minutes */
const FAIL_WINDOW = 15 * 60_000;
const failures = new Map<string, number[]>();
let allFailures: number[] = [];
export const PER_ADDRESS_TRIES = 8;
export const ALL_TRIES = 40;
function recent(list: number[]) {
  const since = networkClock.now() - FAIL_WINDOW;
  return list.filter((t) => t > since);
}
function limited(addr: string): boolean {
  allFailures = recent(allFailures);
  return recent(failures.get(addr) ?? []).length >= PER_ADDRESS_TRIES || allFailures.length >= ALL_TRIES;
}
function failed(addr: string) {
  failures.set(addr, [...recent(failures.get(addr) ?? []), networkClock.now()]);
  allFailures.push(networkClock.now());
}
/** tests start clean */
export function resetInviteLimits() {
  failures.clear();
  allFailures = [];
}

/** a person on another computer exchanges an invitation for a session (POST /auth/invite) */
export function redeemInvite(req: Req, res: ServerResponse, body: { code?: unknown; email?: unknown; short?: unknown; bearer?: unknown }) {
  const peer = bare(req.socket?.remoteAddress ?? "");
  const refuse = (status: number, msg: string, why: string, count = false): never => {
    if (count) failed(peer);
    audit({ actor_kind: "person", door: "route", action: "invite.redeem", target: peer.slice(0, 60), decision: "refused", reason: why });
    throw new HttpError(status, msg);
  };
  if (!networkActive() || !isNetworkHost(req)) refuse(403, "Invitations are opened at this server's network address, while it is open to the network.", "not on the network");
  if (req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["x-real-ip"] || !isPrivatePeer(peer)) refuse(403, "An invitation works only from another computer on this network.", "not a private-network peer");
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowedFor(String(origin), req)) refuse(403, `A page at ${String(origin).slice(0, 80)} can't sign anyone in to Foundation.`, "foreign origin");
  if (limited(peer)) refuse(429, "Too many tries. Wait a few minutes, then ask for a new invitation.", "rate limited");
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const short = typeof body.short === "string" ? body.short : "";
  let where: { col: "link_hash" | "short_hash"; hash: string } | null = null;
  if (code && /^[A-Za-z0-9_-]{40,64}$/.test(code)) where = { col: "link_hash", hash: sha(code) };
  else if (email && normShort(short).length === 10) where = { col: "short_hash", hash: shortHash(email, short) };
  if (!where) refuse(400, "Paste the invitation link, or type your email and the code you were given.", "malformed", true);
  const now = networkClock.now();
  const candidates = all<{ id: string; link_hash: string; short_hash: string }>(`select id, link_hash, short_hash from network_invites where ${where!.col} = ?`, where!.hash);
  const match = candidates.find((c) => sameHash(where!.col === "link_hash" ? c.link_hash : c.short_hash, where!.hash));
  // spent in one statement: a second redemption (or a race) finds it used
  const row = match ? one<{ id: string; email: string; name: string; made_by: string }>("update network_invites set used_at = ?, used_from = ? where id = ? and used_at is null and expires_at > ? returning id, email, name, made_by", now, peer, match.id, now) : undefined;
  if (!row) refuse(400, "That invitation has expired or was already used. Ask for a new one.", match ? "expired or used" : "no such invitation", true);
  const user = upsertUser(row!.email, row!.name);
  if (user.role === "admin") refuse(403, "An invitation never signs in an admin.", "admin");
  const bearer = body.bearer === true;
  const token = createSession(user.id, INVITE_SESSION_MS, bearer ? "app" : "browser");
  const id = `ns_${randomBytes(8).toString("hex")}`;
  run("insert into network_sessions (id, session_hash, user_id, addr, ua, via, created_at) values (?, ?, ?, ?, ?, ?, ?)", id, hashToken(token), user.id, peer, deviceOf(String(req.headers["user-agent"] ?? "")), bearer ? "invite (app)" : "invite", now);
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "route", action: "invite.redeem", target: peer.slice(0, 60), decision: "allowed", approved_by: row!.made_by, result: "ok" });
  if (bearer) return { user, session: token };
  // plain http on the LAN: never Secure (the browser would drop it); HttpOnly, SameSite=Lax, this host only
  res.setHeader("set-cookie", `foundation_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${INVITE_SESSION_MS / 1000}`);
  return { user };
}

/** a browser as a person would name it, from its user-agent: "Edge on Windows" */
export function deviceOf(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Foundation|Tauri/i.test(ua) ? "the Foundation app" : ua ? "a browser" : "unknown";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** who is signed in from another computer: person, device, address, since, sockets open now */
export function networkSessions() {
  const now = networkClock.now();
  run("delete from network_sessions where session_hash not in (select token from sessions where expires_at > ?)", now);
  return all<{ id: string; session_hash: string; user_id: string; name: string; email: string; addr: string; ua: string; via: string; created_at: number }>(
    "select n.id, n.session_hash, n.user_id, u.name, u.email, n.addr, n.ua, n.via, n.created_at from network_sessions n join users u on u.id = n.user_id order by n.created_at desc",
  ).map(({ session_hash, ...r }) => ({ ...r, live: bySession.get(session_hash)?.size ?? 0, seen: lastSeen.get(session_hash) ?? null }));
}

/** sign one out: the session goes, its sockets and connections close now */
export function revokeNetworkSession(by: UserInfo, id: string) {
  const row = one<{ session_hash: string; user_id: string; addr: string }>("select session_hash, user_id, addr from network_sessions where id = ?", id);
  if (!row) throw new HttpError(404, "No such sign-in (it may have ended already).");
  run("delete from sessions where token = ?", row.session_hash);
  run("delete from ws_tickets where session_hash = ?", row.session_hash);
  run("delete from network_sessions where id = ?", id);
  for (const s of bySession.get(row.session_hash) ?? []) s.destroy();
  bySession.delete(row.session_hash);
  audit({ actor_kind: "person", actor_id: by.id, actor_name: by.name, for_person: row.user_id, door: "route", action: "network.sign_out", target: row.addr, decision: "allowed", approved_by: by.id, result: "ok" });
  return { ok: true };
}

// ---------- what this server is ----------

const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** local: only this computer; network: open to the office network; hosted: it has a public address of its own */
export function serverKind(): "local" | "network" | "hosted" {
  const pub = config.publicUrl.replace(/\/$/, "");
  if (!LOOPBACK_URL.test(pub)) {
    try {
      const h = new URL(pub).hostname;
      return isLanV4(h) || h.endsWith(".local") ? "network" : "hosted";
    } catch {
      return "hosted";
    }
  }
  return networkActive() || boundWide() ? "network" : "local";
}

/** where the asker is, seen from here */
function whereYouAre(req: IncomingMessage): "this-computer" | "network" | "elsewhere" {
  if (isLocalRequest(req)) return "this-computer";
  const peer = req.socket?.remoteAddress ?? "";
  return isPrivatePeer(peer) && !req.headers["x-forwarded-for"] ? "network" : "elsewhere";
}

/** the sign-in doors this request can use (auth/config and /api/server say the same) */
export function signInDoors(req: IncomingMessage) {
  const net = isNetworkHost(req);
  return {
    google: Boolean(config.google.clientId) && !net,
    flowform: !net,
    devLogin: config.devLogin && !net,
    invite: net && networkActive(),
  };
}

/** `GET /api/server`: safe for anyone; more for someone signed in; the data folder for an admin */
export function serverInfo(req: Req) {
  const doors = signInDoors(req);
  const out: Record<string, unknown> = {
    name: "Foundation",
    version: SERVER_VERSION,
    kind: serverKind(),
    you: whereYouAre(req),
    serves: ["grids", "files", "chat"],
    signIn: { google: doors.google || doors.flowform, invite: doors.invite, email: doors.devLogin },
    secure: config.publicUrl.startsWith("https:") && !isNetworkHost(req),
  };
  const user = userFromRequest(req);
  if (!user) return out;
  const sw = networkSwitch();
  const admin = user.role === "admin";
  const here = isLocalRequest(req);
  Object.assign(out, {
    address: isNetworkHost(req) ? `http://${String(req.headers.host)}` : config.publicUrl,
    startedAt,
    people: connectedPeople(),
    chat: { channels: chatChannels() },
    network: {
      on: sw.on,
      active: networkActive(),
      setBy: boundWide() ? "environment" : sw.setBy,
      wide: boundWide(),
      urls: networkUrls(),
      listening: listening.map(({ address, iface, ok, answers, error }) => ({ address, iface, ok, answers: answers ?? null, error: error ?? null })),
      page: { built: pageBuilt(), canBuild: canBuildPage(), build: admin ? build : undefined },
    },
    canManage: admin && here && isPerson(req),
  });
  if (admin) Object.assign(out, { data: config.dataDir });
  return out;
}

function chatChannels(): number {
  try {
    return one<{ n: number }>("select count(*) as n from chat_channels where archived_at is null")?.n ?? 0;
  } catch {
    return one<{ n: number }>("select count(*) as n from chat_channels")?.n ?? 0;
  }
}

// ---------- routes ----------

export function networkRoutes(r: Router) {
  r.get("/api/server", (req) => serverInfo(req));
  // the switch: an admin, in person, at this computer; at once, and recorded
  r.post("/api/server/network", async (req) => {
    const u = requireAdminHere(req, "Opening this server to the network");
    if (boundWide() || networkSwitch().setBy === "environment") throw new HttpError(409, "This server's listening is set by its environment (FOUNDATION_HOST or FOUNDATION_NETWORK), not by the switch.");
    const { on } = await readJson<{ on?: boolean }>(req);
    if (typeof on !== "boolean") throw new HttpError(400, "on: true or false");
    setSetting("network", on ? "1" : "0", u.id);
    if (on) await openListeners();
    else await closeListeners();
    audit({ actor_kind: "person", actor_id: u.id, actor_name: u.name, door: "route", action: on ? "server.network.on" : "server.network.off", target: on ? listening.filter((l) => l.ok).map((l) => l.address).join(", ") || "no address" : "loopback only", decision: "allowed", approved_by: u.id, result: "ok" });
    return serverInfo(req);
  });
  r.get("/api/server/invites", (req) => {
    requireAdminHere(req, "Seeing invitations");
    return { invites: all("select id, email, name, created_at, expires_at from network_invites where used_at is null and expires_at > ? order by created_at desc", networkClock.now()) };
  });
  r.post("/api/server/invites", async (req) => mintInvite(requireAdminHere(req, "Inviting someone on this network"), await readJson(req)));
  r.post("/api/server/invites/:id/cancel", (req) => {
    const u = requireAdminHere(req, "Cancelling an invitation");
    run("delete from network_invites where id = ? and used_at is null", req.params.id);
    audit({ actor_kind: "person", actor_id: u.id, actor_name: u.name, door: "route", action: "invite.cancel", target: req.params.id, decision: "allowed", approved_by: u.id, result: "ok" });
    return { ok: true };
  });
  r.get("/api/server/sessions", (req) => {
    requireAdminHere(req, "Seeing who is signed in from other computers");
    return { sessions: networkSessions() };
  });
  r.post("/api/server/sessions/:id/sign-out", (req) => revokeNetworkSession(requireAdminHere(req, "Signing someone out"), req.params.id));
  r.post("/api/server/page/build", (req) => ({ build: buildPage(requireAdminHere(req, "Building the page")) }));
  // a teammate's browser (or their app, with bearer: true) trades an invitation for a session
  r.post("/auth/invite", async (req, res) => redeemInvite(req, res, await readJson(req)));
}

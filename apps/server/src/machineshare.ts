/**
 * A machine's web port, shared (2026-11-17, Josh: "we should be able to see its web, address … The sharing of
 * the link should be a feature"; asked what a shared link reaches: "Both" a Foundation link and a public one).
 *
 * **A Foundation link**: `/m/<board>/<card>/<port>/…` on this server. A machine's ports are published on
 * 127.0.0.1 only, so only this computer reaches them; the server relays a request for one (HTTP and
 * WebSocket) to the port, for anyone signed in to this Foundation who can see the board. The relay strips
 * the person's cookie and Authorization (the machine's app never sees Foundation's session), points
 * redirects back under the prefix, and in HTML rewrites root-relative `href`, `src` and `action` to stay under
 * it, so most apps work from another computer as they do here. An app that builds root-relative URLs in
 * script may still need to be told its base (X-Forwarded-Prefix is sent).
 *
 * **A public link**: a quick tunnel through Cloudflare (`cloudflared tunnel --url`, free, no account),
 * opened by a person's press (it runs third-party code and opens a port to the internet): anyone with the
 * URL reaches that one port, no sign-in. It is written on the card with who opened it; Stop, the machine
 * stopping or being removed, or this server ending closes it. cloudflared must be on this computer.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { MachineShare } from "@foundation/protocol";
import { HttpError } from "./http.ts";
import { machineHooks, machinePanel, writeMachine } from "./machines.ts";

/** /m/<board>/<card>/<port>/<rest> */
export const PORT_PATH = /^\/m\/([^/]+)\/([^/]+)\/(\d{1,5})(\/.*)?$/;

export interface PortTarget {
  board: string;
  panel: string;
  port: number;
  host: number;
  prefix: string;
  rest: string;
}

/** where a /m/ path goes: the machine's published host port for that container port */
export function portTarget(pathname: string): PortTarget | null {
  const m = PORT_PATH.exec(pathname);
  if (!m) return null;
  const [, board, panel, p, rest] = m;
  const port = Number(p);
  let host: number | undefined;
  try {
    host = machinePanel(board, panel).machine?.ports?.find((x) => x.port === port)?.host;
  } catch {
    return null;
  }
  if (!host) return null;
  return { board, panel, port, host, prefix: `/m/${board}/${panel}/${port}`, rest: rest ?? "" };
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

/** the headers a machine's app gets: never Foundation's session */
export function relayHeaders(h: IncomingMessage["headers"], hostPort: number, prefix: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP.has(k) || k === "cookie" || k === "authorization") continue;
    out[k] = v;
  }
  out.host = `127.0.0.1:${hostPort}`;
  out["accept-encoding"] = "identity"; // HTML is rewritten, so it comes plain
  out["x-forwarded-prefix"] = prefix;
  return out;
}

/** a redirect from the app, pointed back under the prefix */
export function relayLocation(loc: string, hostPort: number, prefix: string): string {
  const abs = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${hostPort}`);
  if (abs.test(loc)) return prefix + (loc.replace(abs, "") || "/");
  if (loc.startsWith("/") && !loc.startsWith("//") && !loc.startsWith(prefix + "/") && loc !== prefix) return prefix + loc;
  return loc;
}

/** root-relative links in HTML kept under the prefix (href="/x" → href="/m/b/p/8080/x"); protocol-relative ones left */
export function relayHtml(html: string, prefix: string): string {
  return html.replace(/\b(href|src|action)=(["'])\/(?!\/)/gi, (_m, attr: string, q: string) => `${attr}=${q}${prefix}/`);
}

/** relays one HTTP request to the machine's port (the caller has checked who asks) */
export function relayHttp(req: IncomingMessage, res: ServerResponse, t: PortTarget, search: string) {
  // /m/b/p/8080 → /m/b/p/8080/, so the app's relative links resolve under it
  if (!t.rest) {
    res.writeHead(308, { location: `${t.prefix}/${search}` });
    return void res.end();
  }
  const up = httpRequest({ host: "127.0.0.1", port: t.host, method: req.method, path: t.rest + search, headers: relayHeaders(req.headers, t.host, t.prefix) }, (r) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
    if (typeof r.headers.location === "string") headers.location = relayLocation(r.headers.location, t.host, t.prefix);
    const html = /text\/html/i.test(String(r.headers["content-type"] ?? "")) && !r.headers["content-encoding"];
    if (!html) {
      res.writeHead(r.statusCode ?? 502, headers);
      return void r.pipe(res);
    }
    const parts: Buffer[] = [];
    r.on("data", (b: Buffer) => parts.push(b));
    r.on("end", () => {
      const body = Buffer.from(relayHtml(Buffer.concat(parts).toString("utf8"), t.prefix), "utf8");
      delete headers["content-length"];
      headers["content-length"] = String(body.length);
      res.writeHead(r.statusCode ?? 502, headers);
      res.end(body);
    });
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Nothing answered on port ${t.port} of this machine (${e.message}). Is the app in it running?`);
  });
  req.pipe(up);
}

/** relays a WebSocket (or any upgrade) to the machine's port, byte for byte after the handshake */
export function relayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, t: PortTarget, search: string) {
  const up: Socket = connect(t.host, "127.0.0.1", () => {
    const h = relayHeaders(req.headers, t.host, t.prefix);
    delete h["accept-encoding"];
    const lines = [`${req.method ?? "GET"} ${t.rest || "/"}${search} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    lines.push("connection: Upgrade", `upgrade: ${req.headers.upgrade ?? "websocket"}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on("error", close);
  socket.on("error", close);
}

/** what a person who isn't signed in here sees at a Foundation link */
export function signInFirst(res: ServerResponse, publicUrl: string) {
  res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Sign in to Foundation</title><body style="font:15px/1.5 system-ui;margin:12vh auto;max-width:34em;padding:0 1em"><h1 style="font-size:20px">This is a machine's page in Foundation</h1><p>Sign in to Foundation in this browser first, then open the link again.</p><p><a href="${publicUrl}">Open Foundation</a></p>`);
}

// ---------- public links (cloudflared quick tunnels) ----------

const tunnels = new Map<string, { child: ChildProcess; share: MachineShare }>();
const key = (board: string, panel: string, port: number) => `${board}/${panel}/${port}`;

/** cloudflared on this computer: on the PATH, or where its installers put it */
export function findCloudflared(env = process.env): string | null {
  // a stand-in for checks (a script that prints a link as cloudflared does): FOUNDATION_CLOUDFLARED
  if (env.FOUNDATION_CLOUDFLARED) return env.FOUNDATION_CLOUDFLARED;
  const where = spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"], { encoding: "utf8", windowsHide: true });
  const found = where.status === 0 ? where.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined;
  if (found) return found;
  const guesses =
    process.platform === "win32"
      ? [join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "cloudflared", "cloudflared.exe"), join(env.ProgramFiles ?? "C:\\Program Files", "cloudflared", "cloudflared.exe"), join(env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "cloudflared.exe")]
      : ["/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared", "/usr/bin/cloudflared"];
  return guesses.find((g) => g && existsSync(g)) ?? null;
}

/** the public URL in cloudflared's own lines */
export function tunnelUrl(text: string): string | null {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)?.[0] ?? null;
}

const sharesOf = (board: string, panel: string) => [...tunnels.entries()].filter(([k]) => k.startsWith(`${board}/${panel}/`)).map(([, v]) => v.share);

/** opens a public link to one port of a running machine (a person's press; the route checks) */
export async function openPublicLink(board: string, panel: string, port: number, person: string): Promise<MachineShare> {
  const m = machinePanel(board, panel).machine;
  if (m?.state !== "running") throw new HttpError(409, `${m?.name ?? "The machine"} isn't running.`);
  const host = m.ports?.find((p) => p.port === port)?.host;
  if (!host) throw new HttpError(404, `Port ${port} isn't published on ${m.name}. Publish it when you start the machine.`);
  const k = key(board, panel, port);
  const have = tunnels.get(k);
  if (have) return have.share;
  const exe = findCloudflared();
  if (!exe) throw new HttpError(409, "Public links go through Cloudflare's free quick tunnels, and cloudflared isn't on this computer. Install it (winget install --id Cloudflare.cloudflared on Windows, brew install cloudflared on a Mac), then press again.");
  const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${host}`];
  // a script stand-in runs under this Node
  const child = /.(m?js)$/i.test(exe) ? spawn(process.execPath, [exe, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((ok, bad) => {
    let seen = "";
    const t = setTimeout(() => bad(new HttpError(504, `cloudflared didn't give a link within 40 s. Its last words: ${seen.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`)), 40_000);
    const read = (b: Buffer) => {
      seen += b.toString("utf8");
      const u = tunnelUrl(seen);
      if (u) {
        clearTimeout(t);
        ok(u);
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(t);
      bad(new HttpError(502, `cloudflared ended (${code}) before giving a link: ${seen.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
    });
  }).catch((e) => {
    child.kill();
    throw e;
  });
  const share: MachineShare = { port, url, by: person, at: Date.now() };
  tunnels.set(k, { child, share });
  child.on("exit", () => {
    if (tunnels.get(k)?.child !== child) return;
    tunnels.delete(k);
    writeShares(board, panel);
  });
  writeMachine(board, panel, { shares: sharesOf(board, panel) }, { who: person, role: "human", text: `opened a public link to port ${port} of ${m.name}` });
  return share;
}

function writeShares(board: string, panel: string) {
  try {
    const s = sharesOf(board, panel);
    writeMachine(board, panel, { shares: s.length ? s : undefined });
  } catch {
    /* the card is gone */
  }
}

/** closes one public link, or every one a machine has (it stopped, or was removed) */
export function closePublicLinks(board: string, panel: string, port?: number, person?: string) {
  let closed = 0;
  for (const [k, v] of tunnels) {
    if (!k.startsWith(`${board}/${panel}/`) || (port !== undefined && v.share.port !== port)) continue;
    tunnels.delete(k);
    v.child.kill();
    closed++;
  }
  if (!closed) return;
  try {
    const name = machinePanel(board, panel).machine?.name ?? "the machine";
    const s = sharesOf(board, panel);
    writeMachine(board, panel, { shares: s.length ? s : undefined }, person ? { who: person, role: "human", text: `closed ${port ? `the public link to port ${port}` : "the public links"} of ${name}` } : undefined);
  } catch {
    /* the card is gone */
  }
}

/** this server is ending: every tunnel goes with it */
export function closeAllPublicLinks() {
  for (const v of tunnels.values()) v.child.kill();
  tunnels.clear();
}

// a machine that stops or is removed takes its public links with it; a card whose links this server no longer
// holds (it restarted) stops showing them
machineHooks.ended.push((board, panel, why) => {
  if (why !== "restarted") closePublicLinks(board, panel);
});
machineHooks.seen.push((board, panel) => {
  try {
    const m = machinePanel(board, panel).machine;
    if (m?.shares?.length && !sharesOf(board, panel).length) writeMachine(board, panel, { shares: undefined });
  } catch {
    /* the card is gone */
  }
});

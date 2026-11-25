/**
 * The built-in browser (the top bar's tools, 2026-11-18): a real browser on the computer Foundation's server runs
 * on, shown in the Browser tool. A framed page fails on every site that refuses framing; this one is the site's
 * own page in Edge or Chrome, so any site works, and an agent can read and use it when a person says so.
 *
 * The server drives a Chromium-family browser that is already installed here (nothing is downloaded) over the
 * Chrome DevTools Protocol, sends the page to the client as pictures (a screencast), and passes the client's
 * pointer and keys back. It is a browser with a person's sign-ins on the server's computer, so its rules are the
 * terminal's (hostterm.ts):
 *  - only a person opens one (`requirePerson`), and only an admin;
 *  - opening is two steps: `POST /api/host-browser` mints a one-time key (30 s, in memory, never stored), and the
 *    socket `/host/browser/<id>?key=…` spends it. A key is good for one socket, once;
 *  - nothing starts until that press: the browser process starts when the first socket attaches and is stopped
 *    when the last one closes (and when the server goes). Every socket shares the one browser and its tabs;
 *  - the protocol travels on the process's own pipes (`--remote-debugging-pipe`: fds 3 and 4, JSON ended by a NUL),
 *    never a TCP port, so nothing else on this computer can drive it;
 *  - its profile is a folder in the server's work folder (`<work>/host-browser`, never `data/`), apart from anyone's own browser, so
 *    sign-ins made here last between runs;
 *  - the address bar and agents open only http:, https: and about:blank. Downloads are refused, and a page's file
 *    chooser is not offered (nothing on this computer's disk is reachable from a page);
 *  - agents (tools.ts: browser_read, browser_navigate, browser_click, browser_type, browser_tabs) work only while
 *    a person has the browser open **and** has turned on "Let agents use this browser" on their socket. That leave
 *    is in memory, for this run of the browser, and they can take it back. An agent's call never starts the browser.
 *
 * A page card (2026-11-19; PanelDoc.via === "browser"): a card on a grid can be a page of this browser. Its ask
 * names the board, the card and the address (`POST /api/host-browser {board, card, url}`: the same person, the same
 * one-time key); its socket gets a tab of its own, kept for that card while the browser runs, and never turns to
 * another card's. While someone looks, the page as it last drew is kept as the card's picture (pagepictures.ts) for
 * the far view and for people who can't open this browser: only while the tab is at the card's own site.
 *
 * The socket, client → server (JSON text):
 *   {t:"size", w, h, dpr}                    the page's box in CSS px (w or h 0: not looking; frames pause)
 *   {t:"tab.new", url?} · {t:"tab.close", tab} · {t:"tab.select", tab}
 *   {t:"nav", url} · {t:"back"} · {t:"forward"} · {t:"reload"} · {t:"stop"}        (the tab this socket looks at)
 *   {t:"mouse", kind:"move"|"down"|"up", x, y, button:0|1|2, buttons, clicks, mods}  x,y in the page's CSS px
 *   {t:"wheel", x, y, dx, dy, mods}
 *   {t:"key", kind:"down"|"up", key, code, vk, text?, mods, repeat?, location?}
 *   {t:"paste", text} · {t:"copy"}           (copy answers {t:"copied", text}: the page's selection)
 *   {t:"dialog", accept, text?}              answer the page's alert / confirm / prompt
 *   {t:"agents", allow}                      give or take back agents' leave
 *   mods: Alt 1 · Ctrl 2 · Meta 4 · Shift 8 (CDP's own bits)
 * Server → client (JSON text, and the page as binary):
 *   {t:"hello", browser, agents}             once the browser is up
 *   {t:"tabs", at, tabs:[{id, url, title, loading, canBack, canForward, agent?}]}   on every change
 *   {t:"view", tab, w, h}                    the CSS size of the frames that follow
 *   <binary>                                 one JPEG: the tab this socket looks at, at w·dpr × h·dpr
 *   {t:"dialog", tab, kind, message, value} · {t:"dialog.done", tab}
 *   {t:"blocked", what:"download"|"file", name?}
 *   {t:"agents", allow, by?} · {t:"agent", who, did, tab}
 *   {t:"copied", text} · {t:"note", text, bad?} · {t:"closed", why}
 *   {t:"seen", at}                           a page card's picture was kept just now
 *   {t:"focus", editing}                     after a press is let go: whether the caret is now in a field
 */

import { childOptions, spawnChild, type ChildProcess, type SpawnOptions } from "./child.ts";
import { workFolder } from "./childenv.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { WebSocket } from "ws";
import { HYPERFORM_URL, type UserInfo } from "@foundation/protocol";
import { requirePerson } from "./auth.ts";
import { config } from "./config.ts";
import { HttpError, type Req } from "./http.ts";
import { computerUseDefault } from "./prefs.ts";
import { pageIdsOk, savePagePicture } from "./pagepictures.ts";

const KEY_TTL_MS = 30_000;
const DIALOG_MS = 30_000;
const SIZE_DEBOUNCE_MS = 120;
/** how long a page is still before its sharp picture is taken (dense screens) */
const SHARP_AFTER_MS = 140;
/** a socket this far behind skips frames until it catches up */
const MAX_BUFFERED = 6_000_000;
const READ_MAX = 12_000;
const MAX_TABS = 24;
/** a page card's picture is kept at most this often while the page keeps drawing */
const PICTURE_EVERY_MS = 4000;
/** a page card's tab nobody has looked at for this long is closed (the browser goes on for the others) */
const CARD_TAB_IDLE_MS = 180_000;

// ---------------------------------------------------------------- the address

/** schemes that are named and refused (anything else that isn't an address is a search) */
const REFUSED = /^(file|chrome|chrome-extension|chrome-untrusted|chrome-search|edge|devtools|javascript|vbscript|data|blob|filesystem|view-source|about|ftp|ws|wss|mailto|tel|ms-[a-z-]+|microsoft-edge):/i;

export type Address = { url: string } | { refused: string };

/**
 * What was typed in the address field, as the address to open: http: and https: as they are, `localhost:1234`
 * (and a bare IP) over http, a domain over https, and plain words as a DuckDuckGo search. Only http:, https: and
 * about:blank ever come out; file:, chrome:, devtools:, javascript:, data: and the like are refused by name.
 */
export function browserAddress(raw: string): Address {
  const t = String(raw ?? "").trim();
  if (!t) return { refused: "There's no address to open." };
  if (t.length > 4000) return { refused: "That address is too long." };
  const checked = (u: string): Address => {
    try {
      const p = new URL(u);
      if (p.protocol === "http:" || p.protocol === "https:") return { url: p.href };
    } catch {
      /* not an address */
    }
    return { refused: `“${t.slice(0, 80)}” isn't an address this browser opens.` };
  };
  if (/^about:blank$/i.test(t)) return { url: "about:blank" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    if (/^https?:\/\//i.test(t)) return checked(t);
    return { refused: `This browser opens http and https pages only, not ${t.slice(0, t.indexOf(":") + 1).toLowerCase()} addresses.` };
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return checked(`http://${t}`);
  if (REFUSED.test(t)) return { refused: `This browser opens http and https pages only, not ${t.slice(0, t.indexOf(":") + 1).toLowerCase()} addresses.` };
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return checked(`http://${t}`);
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(t)) return checked(`https://${t}`);
  return { url: `https://duckduckgo.com/?q=${encodeURIComponent(t)}` };
}

/** the browser's own pages, which it sometimes opens by itself (Edge's sync prompt): never shown as tabs */
const OWN_PAGE = /^(edge|chrome|chrome-extension|chrome-untrusted|chrome-search|devtools):/i;

/** where a page may not take the top of a tab by itself (a page can't normally; this is the belt to that braces) */
const NOT_A_PAGE = /^(file|chrome|chrome-extension|chrome-untrusted|edge|devtools|view-source|filesystem):/i;

// ---------------------------------------------------------------- which browser

export interface FoundBrowser {
  path: string;
  name: string;
}

const LOOKED_FOR = "Microsoft Edge, Google Chrome and Chromium";

/** the places a Chromium-family browser is installed, by platform, in the order tried */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): FoundBrowser[] {
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    const at = (name: string, tail: string[]) => roots.map((r) => ({ name, path: join(r, ...tail) }));
    return [...at("Google Chrome", ["Google", "Chrome", "Application", "chrome.exe"]), ...at("Microsoft Edge", ["Microsoft", "Edge", "Application", "msedge.exe"]), ...at("Chromium", ["Chromium", "Application", "chrome.exe"])];
  }
  if (platform === "darwin") {
    const apps = ["/Applications", join(home, "Applications")];
    const at = (name: string) => apps.map((a) => ({ name, path: `${a}/${name}.app/Contents/MacOS/${name}` }));
    return [...at("Google Chrome"), ...at("Microsoft Edge"), ...at("Chromium")];
  }
  const bins = ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome", "/opt/microsoft/msedge"];
  const at = (name: string, files: string[]) => bins.flatMap((b) => files.map((f) => ({ name, path: `${b}/${f}` })));
  return [...at("Google Chrome", ["google-chrome", "google-chrome-stable", "chrome"]), ...at("Chromium", ["chromium", "chromium-browser"]), ...at("Microsoft Edge", ["microsoft-edge", "microsoft-edge-stable", "msedge"])];
}

/**
 * Where the Browser tool opens: HyperForm (the dock the company's apps are deployed on, and whose sign-in they
 * share), unless `FOUNDATION_BROWSER_HOME` names another address, or turns it off (`about:blank`, `off`, `none`:
 * an empty tab, as before 2026-11-20). `HYPERFORM_URL` moves HyperForm itself, as it does on Today's shelf.
 * Anything that isn't a plain http(s) address falls back to the empty tab: a setting never opens a search.
 */
export function browserHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.FOUNDATION_BROWSER_HOME?.trim();
  if (set && /^(about:blank|off|none|0)$/i.test(set)) return "about:blank";
  const raw = set || env.HYPERFORM_URL?.trim() || HYPERFORM_URL;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "about:blank";
  } catch {
    return "about:blank";
  }
}

/** the browser to drive: `FOUNDATION_BROWSER` if it is set (and there), else the first installed one; null when none */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): FoundBrowser | null {
  const named = env.FOUNDATION_BROWSER?.trim();
  if (named) return exists(named) ? { path: named, name: /edge/i.test(named) ? "Microsoft Edge" : /chromium/i.test(named) ? "Chromium" : /chrome/i.test(named) ? "Google Chrome" : "the browser FOUNDATION_BROWSER names" } : null;
  return browserCandidates(platform, env).find((c) => exists(c.path)) ?? null;
}

/** why there is no browser to start, as a sentence for the person */
export function noBrowserSentence(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.FOUNDATION_BROWSER?.trim();
  if (named) return `FOUNDATION_BROWSER points at ${named}, which isn't there. Point it at ${LOOKED_FOR.replace(" and ", " or ")} on the server's computer, or unset it to use the installed one.`;
  return `No browser was found on the server's computer. Foundation looked for ${LOOKED_FOR} in their usual places; install one, or set FOUNDATION_BROWSER to a Chromium-family browser's program.`;
}

// ---------------------------------------------------------------- the one-time key

/** the card a socket is for: its page, on its board */
export interface CardPage {
  board: string;
  card: string;
  url: string;
}
interface Opened {
  user: UserInfo;
  key: string;
  expires: number;
  page?: CardPage;
}

/** what a page card asks for, checked: ids that are ids, an address the browser opens. Throws a sentence. */
export function cardPageOf(body: { board?: unknown; card?: unknown; url?: unknown } | null | undefined): CardPage | undefined {
  if (!body || (body.board === undefined && body.card === undefined && body.url === undefined)) return undefined;
  if (!pageIdsOk(body.board, body.card)) throw new HttpError(400, "A page card's ask names its board and its card.");
  const a = browserAddress(typeof body.url === "string" ? body.url : "");
  if ("refused" in a) throw new HttpError(400, a.refused);
  if (!/^https?:/i.test(a.url)) throw new HttpError(400, "A page card needs an address.");
  return { board: body.board as string, card: body.card as string, url: a.url };
}
const opened = new Map<string, Opened>();

export const HOST_BROWSER_PATH = /^\/host\/browser\/([A-Za-z0-9_-]{8,64})$/;

/** `POST /api/host-browser`: a person, an admin, asks for the browser (an agent, a viewer or a member is refused) */
export function requestHostBrowser(req: Req, page?: CardPage) {
  const u = requirePerson(req, "Opening the browser");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin can open the browser on the server's computer.");
  const found = findBrowser();
  if (!found) throw new HttpError(503, noBrowserSentence());
  return { ...openHostBrowser(u, page), browser: found.name, running: hostBrowserRunning() };
}

/** a person asked for the browser: a one-time key for its socket. Starts nothing. */
export function openHostBrowser(user: UserInfo, page?: CardPage): { id: string; key: string; expiresIn: number } {
  const now = Date.now();
  for (const [id, o] of opened) if (o.expires <= now) opened.delete(id);
  const id = randomBytes(9).toString("base64url");
  const key = randomBytes(24).toString("base64url");
  opened.set(id, { user, key, expires: now + KEY_TTL_MS, ...(page ? { page } : {}) });
  return { id, key, expiresIn: KEY_TTL_MS / 1000 };
}

/** spend a key on its socket: the person it was minted for, or null (wrong, used, or expired) */
export function spendHostBrowserKey(id: string, key: string | null): UserInfo | null {
  return spendHostBrowser(id, key)?.user ?? null;
}

/** the same, with the page card the key was minted for (if it was for one) */
export function spendHostBrowser(id: string, key: string | null): { user: UserInfo; page?: CardPage } | null {
  const o = opened.get(id);
  opened.delete(id);
  if (!o || !key || o.key !== key || o.expires <= Date.now()) return null;
  return { user: o.user, ...(o.page ? { page: o.page } : {}) };
}

// ---------------------------------------------------------------- the protocol, on the browser's pipes

type CdpEvent = (method: string, params: any, sessionId: string | undefined) => void;

/** the DevTools protocol over `--remote-debugging-pipe`: one JSON message, then a NUL, each way */
class Cdp {
  private seq = 0;
  private waits = new Map<number, { ok: (v: any) => void; no: (e: Error) => void; method: string }>();
  private parts: Buffer[] = [];
  closed = false;

  constructor(
    private to: Writable,
    from: Readable,
    private onEvent: CdpEvent,
  ) {
    from.on("data", (chunk: Buffer) => this.take(chunk));
    from.on("close", () => this.end());
    from.on("error", () => this.end());
    to.on("error", () => this.end());
  }

  private take(chunk: Buffer) {
    let from = 0;
    for (;;) {
      const nul = chunk.indexOf(0, from);
      if (nul < 0) break;
      this.parts.push(chunk.subarray(from, nul));
      const text = (this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts)).toString("utf8");
      this.parts = [];
      from = nul + 1;
      let m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string }; sessionId?: string };
      try {
        m = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof m.id === "number") {
        const w = this.waits.get(m.id);
        this.waits.delete(m.id);
        if (w) m.error ? w.no(new Error(`${w.method}: ${m.error.message ?? "failed"}`)) : w.ok(m.result ?? {});
      } else if (m.method) {
        try {
          this.onEvent(m.method, m.params ?? {}, m.sessionId);
        } catch (e) {
          console.error("  browser            an event failed:", (e as Error).message);
        }
      }
    }
    if (from < chunk.length) this.parts.push(chunk.subarray(from));
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the browser has closed"));
    const id = ++this.seq;
    return new Promise<T>((ok, no) => {
      this.waits.set(id, { ok, no, method });
      this.to.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** send and don't mind the answer (input, acks): a tab that closed under it is not an error */
  fire(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    void this.send(method, params, sessionId).catch(() => {});
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waits.values()) w.no(new Error("the browser has closed"));
    this.waits.clear();
  }
}

// ---------------------------------------------------------------- the browser, its tabs, and who is looking

interface Size {
  w: number;
  h: number;
  dpr: number;
}
interface Tab {
  /** the short id sockets and agents use (t1, t2 …) */
  id: string;
  target: string;
  session: string;
  frame: string;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  casting: boolean;
  /** the last frame, for a socket that turns to this tab while the page is still */
  last?: { jpeg: Buffer; w: number; h: number };
  /** the last screencast picture as it came, to tell a repeat */
  lastData?: string;
  sharpTimer?: NodeJS.Timeout;
  sharpening?: boolean;
  sharpStale?: boolean;
  /** input that arrived while a sharp picture was being taken */
  held?: Array<() => void>;
  sharpTurn?: number;
  /** a picture at the size now is owed (the cast just began, or the size changed) and hasn't come */
  owed?: boolean;
  oweTimer?: NodeJS.Timeout;
  size?: Size;
  dialog?: { kind: string; message: string; value: string; timer: NodeJS.Timeout };
  /** the isolated world browser_read's refs live in */
  readCtx?: number;
  /** the page card this tab is for (a tab a site opened from it is its too, without `home`) */
  card?: CardPage;
  /** the card's own tab, the one its sockets come back to */
  home?: boolean;
  pictureAt?: number;
  pictureTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}
interface Sock {
  ws: WebSocket;
  user: UserInfo;
  tab: string | null;
  size: Size | null;
  looking: boolean;
  sizeTimer?: NodeJS.Timeout;
  /** the size of the frames this socket was last told about */
  view?: string;
  /** a page card's socket: it looks at that card's tab and no other card's */
  page?: CardPage;
}
interface Run {
  /** the Browser tool has been shown its opening page (browserHome) once: closing and opening the pane doesn't send it there again */
  homed?: boolean;
  proc: ChildProcess;
  cdp: Cdp;
  name: string;
  userAgent?: string;
  tabs: Map<string, Tab>;
  bySession: Map<string, Tab>;
  byTarget: Map<string, Tab>;
  adopting: Map<string, Promise<void>>;
  socks: Set<Sock>;
  ready: Promise<void>;
  agentsMay: { by: string; byId: string; at: number } | null;
  agentTab: string | null;
  agentBusy: number;
  agentQueue: Promise<unknown>;
  tabSeq: number;
  tabsTimer?: NodeJS.Timeout;
  watch?: NodeJS.Timeout;
  over: boolean;
}

let run: Run | null = null;
let lastProc: ChildProcess | null = null;
/** a browser on its way out: the next one waits for it (they share the profile folder) */
let leaving: Promise<void> = Promise.resolve();

const profileDir = () => workFolder("host-browser");

const say = (s: Sock, m: unknown) => {
  if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(m));
};
const sayAll = (r: Run, m: unknown) => {
  for (const s of r.socks) say(s, m);
};

function launch(found: FoundBrowser): Run {
  const dir = profileDir();
  mkdirSync(dir, { recursive: true });
  // the tabs of the last run are not brought back (sign-ins are kept: they live elsewhere in the profile)
  rmSync(join(dir, "Default", "Sessions"), { recursive: true, force: true });
  const args = [
    "--remote-debugging-pipe",
    "--headless=new",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // Edge on Windows starts itself again (a "compat layer" relaunch) and the second process has no pipes; this is
    // the switch its own relaunch passes. Chrome doesn't know it and ignores it.
    "--edge-skip-compat-layer-relaunch",
    // its profile is Foundation's own: Edge would otherwise sign a new profile in as this computer's Windows
    // account by itself, and sync that person's passwords and history into it
    "--disable-sync",
    "--disable-features=msImplicitSignin",
    "--mute-audio", // it plays on the server's computer, where nobody is listening
    "--window-size=1280,800",
    "about:blank",
  ];
  // the browser gets the allowlisted environment (child.ts), no extras: none of the server's keys
  const proc = spawnChild(found.path, args, childOptions<SpawnOptions>({ extras: [] }, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true }));
  lastProc = proc;
  const r: Run = {
    proc,
    cdp: null as unknown as Cdp,
    name: found.name,
    tabs: new Map(),
    bySession: new Map(),
    byTarget: new Map(),
    adopting: new Map(),
    socks: new Set(),
    ready: Promise.resolve(),
    agentsMay: null,
    agentTab: null,
    agentBusy: 0,
    agentQueue: Promise.resolve(),
    tabSeq: 0,
    over: false,
  };
  r.cdp = new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable, (method, params, session) => onEvent(r, method, params, session));
  const gone = (why: string) => {
    if (r.over) return;
    r.over = true;
    r.cdp.end();
    if (run === r) run = null;
    for (const t of r.tabs.values()) {
      if (t.dialog) clearTimeout(t.dialog.timer);
      clearTimeout(t.sharpTimer);
    }
    clearTimeout(r.tabsTimer);
    clearInterval(r.watch);
    for (const s of r.socks) {
      say(s, { t: "closed", why });
      s.ws.close();
    }
    r.socks.clear();
  };
  proc.on("exit", () => gone("The browser ended."));
  proc.on("error", (e) => gone(`The browser didn't start: ${e.message}`));
  r.ready = (async () => {
    await r.cdp.send("Target.setDiscoverTargets", { discover: true });
    // nothing a page offers is written to this computer's disk
    await r.cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }).catch(() => {});
    // a person is using it: it says the browser it is, not "HeadlessChrome" (which many sites turn away)
    const v = await r.cdp.send<{ userAgent?: string }>("Browser.getVersion").catch(() => null);
    if (v?.userAgent?.includes("Headless")) r.userAgent = v.userAgent.replace("HeadlessChrome", "Chrome").replace("HeadlessEdg", "Edg");
    for (const t of r.tabs.values()) if (r.userAgent) r.cdp.fire("Emulation.setUserAgentOverride", { userAgent: r.userAgent }, t.session);
    await Promise.all([...r.adopting.values()]);
    if (r.tabs.size === 0) await newTab(r, "about:blank");
  })();
  // a page may rename itself at any time (an inbox's unread count): look now and then while someone is looking
  r.watch = setInterval(() => {
    for (const t of r.tabs.values()) if (t.casting) void refreshHistory(r, t);
  }, 1500);
  r.watch.unref();
  r.ready.catch((e: Error) => {
    gone(`The browser didn't start: ${e.message}`);
    kill(r);
  });
  return r;
}

function kill(r: Run) {
  if (r.proc.exitCode === null && r.proc.signalCode === null) r.proc.kill();
}

/** stop a browser: ask it to close (so the profile is written), then make sure */
function stop(r: Run): Promise<void> {
  if (run === r) run = null;
  const done = new Promise<void>((ok) => {
    if (r.proc.exitCode !== null || r.proc.signalCode !== null) return ok();
    const force = setTimeout(() => kill(r), 3000);
    r.proc.once("exit", () => {
      clearTimeout(force);
      ok();
    });
    if (r.cdp.closed) kill(r);
    else r.cdp.send("Browser.close").catch(() => kill(r));
  });
  leaving = leaving.then(() => done);
  return done;
}

// ---------- tabs

const tabList = (r: Run, s: Sock) => ({
  t: "tabs",
  at: s.tab,
  tabs: [...r.tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, canBack: t.canBack, canForward: t.canForward, ...(r.agentsMay && r.agentTab === t.id ? { agent: true } : {}), ...(t.card ? { card: t.card.card } : {}) })),
});

/** tell every socket the tabs as they are now (once per turn of the loop, however much changed) */
function pushTabs(r: Run) {
  if (r.tabsTimer || r.over) return;
  r.tabsTimer = setTimeout(() => {
    r.tabsTimer = undefined;
    for (const s of r.socks) say(s, tabList(r, s));
  }, 0);
}

function adopt(r: Run, info: { targetId: string; type: string; url: string; title: string; openerId?: string }) {
  // the browser's own pages (edge://…, an extension's) are not tabs
  if (info.type !== "page" || r.byTarget.has(info.targetId) || r.adopting.has(info.targetId) || OWN_PAGE.test(info.url)) return;
  const p = (async () => {
    const { sessionId } = await r.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: info.targetId, flatten: true });
    const tab: Tab = { id: `t${++r.tabSeq}`, target: info.targetId, session: sessionId, frame: info.targetId, url: info.url, title: info.title, loading: false, canBack: false, canForward: false, casting: false };
    r.tabs.set(tab.id, tab);
    r.bySession.set(sessionId, tab);
    r.byTarget.set(info.targetId, tab);
    await r.cdp.send("Page.enable", {}, sessionId);
    if (r.userAgent) r.cdp.fire("Emulation.setUserAgentOverride", { userAgent: r.userAgent }, sessionId);
    // a page's file chooser is not offered: it is caught, and the person is told
    r.cdp.fire("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
    const tree = await r.cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId).catch(() => null);
    if (tree) tab.frame = tree.frameTree.frame.id;
    // a page a site opened (window.open, target=_blank): whoever was looking at the page that opened it now looks here
    const from = info.openerId ? r.byTarget.get(info.openerId) : undefined;
    if (from) {
      if (from.card) tab.card = from.card;
      if (from.size) applySize(r, tab, from.size);
      if (r.agentBusy && r.agentTab === from.id) r.agentTab = tab.id;
      for (const s of r.socks) if (s.tab === from.id) look(r, s, tab.id);
    }
    pushTabs(r);
  })()
    .catch(() => {})
    .finally(() => r.adopting.delete(info.targetId));
  r.adopting.set(info.targetId, p);
}

async function newTab(r: Run, url: string): Promise<Tab> {
  if (r.tabs.size >= MAX_TABS) throw new Error(`That's ${MAX_TABS} tabs: close one first.`);
  const { targetId } = await r.cdp.send<{ targetId: string }>("Target.createTarget", { url });
  // the target's own "created" event adopts it; wait for that
  for (let i = 0; i < 200 && !r.byTarget.has(targetId); i++) {
    await (r.adopting.get(targetId) ?? new Promise((ok) => setTimeout(ok, 10)));
  }
  const tab = r.byTarget.get(targetId);
  if (!tab) throw new Error("the new tab didn't open");
  return tab;
}

function dropTab(r: Run, tab: Tab) {
  if (!r.tabs.has(tab.id)) return;
  const order = [...r.tabs.keys()];
  const next = order[order.indexOf(tab.id) + 1] ?? order[order.indexOf(tab.id) - 1] ?? null;
  r.tabs.delete(tab.id);
  r.bySession.delete(tab.session);
  r.byTarget.delete(tab.target);
  if (tab.dialog) clearTimeout(tab.dialog.timer);
  clearTimeout(tab.sharpTimer);
  clearTimeout(tab.pictureTimer);
  clearTimeout(tab.idleTimer);
  if (r.agentTab === tab.id) r.agentTab = null;
  if (r.over) return;
  // a page card's socket goes back to its card's own tab (a page it opened has closed), or ends with it
  for (const s of [...r.socks]) {
    if (s.tab !== tab.id || !s.page) continue;
    const home = cardTab(r, s.page);
    if (home) look(r, s, home.id);
    else {
      s.tab = null;
      say(s, { t: "closed", why: "This page's tab was closed." });
      s.ws.close();
    }
  }
  if (next) {
    for (const s of r.socks) if (s.tab === tab.id) look(r, s, next);
    pushTabs(r);
    return;
  }
  // the last tab closed: a browser always has one
  for (const s of r.socks) if (s.tab === tab.id) s.tab = null;
  void newTab(r, "about:blank")
    .then((t) => {
      for (const s of r.socks) if (!s.tab) look(r, s, t.id);
    })
    .catch(() => {});
}

const sameCard = (a: CardPage | undefined, b: CardPage | undefined) => Boolean(a && b && a.board === b.board && a.card === b.card);
/** the tab kept for a page card */
const cardTab = (r: Run, page: CardPage): Tab | undefined => [...r.tabs.values()].find((t) => t.home && sameCard(t.card, page));

/**
 * Keep the page as it last drew as its card's picture: not more often than PICTURE_EVERY_MS, not while it loads,
 * and only at the card's own site (a sign-in provider's page the tab passed through is nobody's to keep).
 */
function keepPicture(r: Run, tab: Tab) {
  if (!tab.card || !tab.home || tab.pictureTimer) return;
  const wait = Math.max(0, (tab.pictureAt ?? 0) + PICTURE_EVERY_MS - Date.now());
  tab.pictureTimer = setTimeout(() => {
    tab.pictureTimer = undefined;
    if (r.over || !tab.card || !tab.last || !r.tabs.has(tab.id)) return;
    if (tab.loading) return keepPicture(r, tab);
    if (!sameSite(tab.url, tab.card.url)) return;
    tab.pictureAt = Date.now();
    const at = savePagePicture(tab.card, tab.last.jpeg);
    if (at) for (const s of r.socks) if (s.tab === tab.id) say(s, { t: "seen", at });
  }, Math.max(wait, 600));
  tab.pictureTimer.unref();
}

/** the same site: the same scheme, host and port */
export function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** a socket turns to a tab: frames of it (and only it) follow */
function look(r: Run, s: Sock, tabId: string) {
  const tab = r.tabs.get(tabId);
  if (!tab) return;
  // a page card's socket looks only at its own card's tabs; the Browser tool's looks at any
  if (s.page && !sameCard(tab.card, s.page)) return;
  clearTimeout(tab.idleTimer);
  tab.idleTimer = undefined;
  const was = s.tab ? r.tabs.get(s.tab) : undefined;
  s.tab = tab.id;
  s.view = undefined;
  if (was && was !== tab) syncCast(r, was);
  if (s.size) applySize(r, tab, s.size);
  r.cdp.fire("Page.bringToFront", {}, tab.session);
  syncCast(r, tab);
  if (tab.last && s.looking) sendFrame(s, tab, tab.last);
  if (tab.dialog) say(s, { t: "dialog", tab: tab.id, kind: tab.dialog.kind, message: tab.dialog.message, value: tab.dialog.value });
  pushTabs(r);
}

/** the screencast runs for a tab only while a socket is looking at it */
function syncCast(r: Run, tab: Tab) {
  const watched = [...r.socks].some((s) => s.tab === tab.id && s.looking);
  if (watched && !tab.casting) {
    tab.casting = true;
    r.cdp.fire("Page.startScreencast", { format: "jpeg", quality: 72, everyNthFrame: 1 }, tab.session);
    owe(r, tab);
  } else if (!watched && tab.casting) {
    tab.casting = false;
    tab.lastData = undefined;
    tab.owed = false;
    clearTimeout(tab.oweTimer);
    clearTimeout(tab.sharpTimer);
    r.cdp.fire("Page.stopScreencast", {}, tab.session);
  }
}

/**
 * A still page sends a picture only when it draws. If the one picture the browser sends as a cast begins (or after
 * the size changes) came at the size before, or didn't come, nothing follows and the pane stays empty: seen with
 * a profile that has been used before, where the page is drawn sooner. So a picture at the size now is owed, and
 * while it hasn't come the cast is begun again, which makes the browser send one.
 */
function owe(r: Run, tab: Tab, tries = 0) {
  tab.owed = true;
  clearTimeout(tab.oweTimer);
  if (tries >= 12) return;
  tab.oweTimer = setTimeout(() => {
    tab.oweTimer = undefined;
    if (r.over || !tab.owed || !tab.casting || !r.tabs.has(tab.id)) return;
    if (!tab.sharpening) {
      tab.lastData = undefined;
      r.cdp.fire("Page.stopScreencast", {}, tab.session);
      r.cdp.fire("Page.startScreencast", { format: "jpeg", quality: 72, everyNthFrame: 1 }, tab.session);
    }
    owe(r, tab, tries + 1);
  }, 350);
  tab.oweTimer.unref();
}

function sendFrame(s: Sock, tab: Tab, f: { jpeg: Buffer; w: number; h: number }) {
  if (s.ws.readyState !== s.ws.OPEN || s.ws.bufferedAmount > MAX_BUFFERED) return;
  const view = `${tab.id}:${f.w}x${f.h}`;
  if (s.view !== view) {
    s.view = view;
    say(s, { t: "view", tab: tab.id, w: f.w, h: f.h });
  }
  s.ws.send(f.jpeg, { binary: true });
}

/**
 * The screencast's pictures are one image pixel per CSS pixel, whatever the screen's density, so on a dense screen
 * they are soft. Once the page has been still for a moment, one sharp picture (a screenshot, at the screen's
 * density) follows: moving pages stay quick, still ones are crisp.
 */
function sharpenSoon(r: Run, tab: Tab) {
  clearTimeout(tab.sharpTimer);
  tab.sharpTimer = undefined;
  if (!tab.size || tab.size.dpr <= 1) return;
  const turn = (tab.sharpTurn = (tab.sharpTurn ?? 0) + 1);
  tab.sharpTimer = setTimeout(() => {
    tab.sharpTimer = undefined;
    if (r.over || !tab.casting || !r.tabs.has(tab.id)) return;
    const of = tab.last;
    const size = tab.size;
    if (tab.sharpening || !of || !size) return;
    tab.sharpening = true;
    void r.cdp
      .send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 82, optimizeForSpeed: true }, tab.session)
      .then((shot) => {
        // the box changed while this was taken: the next still moment gets its own
        if (r.over || tab.sharpTurn !== turn || tab.size !== size) return;
        const f = { jpeg: Buffer.from(shot.data, "base64"), w: of.w, h: of.h };
        tab.last = f;
        for (const s of r.socks) if (s.tab === tab.id && s.looking) sendFrame(s, tab, f);
        keepPicture(r, tab);
      })
      .catch(() => {})
      .finally(() => {
        tab.sharpening = false;
        const held = tab.held ?? [];
        tab.held = undefined;
        for (const send of held) send();
        if (tab.sharpStale) {
          tab.sharpStale = false;
          tab.lastData = undefined;
          sharpenSoon(r, tab);
        }
      });
  }, SHARP_AFTER_MS);
}

/**
 * Pointer and keys for a tab. While a sharp picture is being taken the browser has the page at another scale, and
 * a press sent then lands at the wrong place (half way to the corner, at 2×): input waits the moment out, in order.
 * Input also puts the sharp picture off: someone is using the page.
 */
function input(r: Run, tab: Tab, method: string, params: Record<string, unknown>): Promise<void> {
  if (tab.sharpTimer && !tab.sharpening) sharpenSoon(r, tab);
  if (!tab.sharpening && !tab.held?.length) return r.cdp.send(method, params, tab.session).then(() => {});
  return new Promise<void>((ok, no) => {
    (tab.held ??= []).push(() => r.cdp.send(method, params, tab.session).then(() => ok(), no));
  });
}

const clampSize = (m: { w?: unknown; h?: unknown; dpr?: unknown }): Size | null => {
  const w = Math.round(Number(m.w));
  const h = Math.round(Number(m.h));
  const dpr = Number(m.dpr);
  if (!(w >= 80) || !(h >= 80)) return null;
  return { w: Math.min(3840, w), h: Math.min(2400, h), dpr: Math.max(1, Math.min(2, Number.isFinite(dpr) ? Math.round(dpr * 100) / 100 : 1)) };
};

function applySize(r: Run, tab: Tab, size: Size) {
  if (tab.size && tab.size.w === size.w && tab.size.h === size.h && tab.size.dpr === size.dpr) return;
  tab.size = size;
  r.cdp.fire("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: false }, tab.session);
  // the same picture at another density is still a new picture to sharpen
  tab.lastData = undefined;
  if (tab.casting) owe(r, tab);
}

async function refreshHistory(r: Run, tab: Tab) {
  const h = await r.cdp.send<{ currentIndex: number; entries: Array<{ id: number; url: string; title: string }> }>("Page.getNavigationHistory", {}, tab.session).catch(() => null);
  if (!h) return;
  const back = h.currentIndex > 0;
  const fwd = h.currentIndex < h.entries.length - 1;
  // the title is read here: the browser's own "the tab changed" event carries it late, or not until the tab closes
  const at = h.entries[h.currentIndex];
  const title = at && at.url === tab.url ? at.title : tab.title;
  if (back !== tab.canBack || fwd !== tab.canForward || title !== tab.title) {
    tab.canBack = back;
    tab.canForward = fwd;
    tab.title = title;
    pushTabs(r);
  }
}

async function step(r: Run, tab: Tab, by: -1 | 1) {
  const h = await r.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory", {}, tab.session);
  const to = h.entries[h.currentIndex + by];
  if (to) await r.cdp.send("Page.navigateToHistoryEntry", { entryId: to.id }, tab.session);
}

async function navigate(r: Run, tab: Tab, raw: string): Promise<string> {
  const a = browserAddress(raw);
  if ("refused" in a) throw new Error(a.refused);
  tab.loading = true;
  pushTabs(r);
  // the browser shows its own page for an address that fails (no such site, refused); that is the answer
  await r.cdp.send("Page.navigate", { url: a.url }, tab.session);
  return a.url;
}

function answerDialog(r: Run, tab: Tab, accept: boolean, text?: string) {
  if (!tab.dialog) return;
  clearTimeout(tab.dialog.timer);
  tab.dialog = undefined;
  r.cdp.fire("Page.handleJavaScriptDialog", { accept, ...(typeof text === "string" ? { promptText: text.slice(0, 4000) } : {}) }, tab.session);
  sayAll(r, { t: "dialog.done", tab: tab.id });
}

// ---------- what the browser says

function onEvent(r: Run, method: string, p: any, session: string | undefined) {
  if (r.over) return;
  if (!session) {
    if (method === "Target.targetCreated") adopt(r, p.targetInfo);
    else if (method === "Target.targetInfoChanged") {
      const tab = r.byTarget.get(p.targetInfo.targetId);
      if (!tab) return adopt(r, p.targetInfo);
      if (tab.url !== p.targetInfo.url) {
        tab.url = p.targetInfo.url;
        pushTabs(r);
      }
      void refreshHistory(r, tab);
    } else if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
      const tab = r.byTarget.get(p.targetId);
      if (tab) {
        if (method === "Target.targetCrashed") sayAll(r, { t: "note", text: `“${tab.title || tab.url}” crashed and was closed.`, bad: true });
        dropTab(r, tab);
      }
    } else if (method === "Browser.downloadWillBegin") {
      sayAll(r, { t: "blocked", what: "download", name: String(p.suggestedFilename ?? "").slice(0, 200), url: String(p.url ?? "").slice(0, 400) });
    }
    return;
  }
  const tab = r.bySession.get(session);
  if (!tab) return;
  switch (method) {
    case "Page.screencastFrame": {
      r.cdp.fire("Page.screencastFrameAck", { sessionId: p.sessionId }, session);
      const w = Math.round(p.metadata?.deviceWidth ?? tab.size?.w ?? 0);
      const h = Math.round(p.metadata?.deviceHeight ?? tab.size?.h ?? 0);
      // While a sharp picture is being taken the browser redraws the page at another scale, and the screencast
      // shows that for a frame (the page at the wrong size, or tiled): not a picture of the page. Nor is the same
      // picture again, which the redraw afterwards sends.
      if (tab.size && (w !== tab.size.w || h !== tab.size.h)) break;
      // a picture at the size now has come: nothing is owed, whatever is done with this one
      tab.owed = false;
      clearTimeout(tab.oweTimer);
      if (p.data === tab.lastData) break;
      if (tab.sharpening) {
        // the page did change while the sharp picture was being taken: take another when this one is done
        tab.sharpStale = true;
        break;
      }
      tab.lastData = p.data;
      const f = { jpeg: Buffer.from(p.data, "base64"), w, h };
      tab.last = f;
      for (const s of r.socks) if (s.tab === tab.id && s.looking) sendFrame(s, tab, f);
      sharpenSoon(r, tab);
      keepPicture(r, tab);
      break;
    }
    case "Page.frameStartedLoading":
    case "Page.frameStoppedLoading": {
      if (p.frameId !== tab.frame) break;
      const loading = method === "Page.frameStartedLoading";
      if (tab.loading !== loading) {
        tab.loading = loading;
        pushTabs(r);
      }
      if (!loading) void refreshHistory(r, tab);
      break;
    }
    case "Page.domContentEventFired":
    case "Page.loadEventFired": {
      void refreshHistory(r, tab);
      break;
    }
    case "Page.frameNavigated": {
      if (p.frame?.parentId) break;
      tab.frame = p.frame.id;
      tab.readCtx = undefined;
      tab.url = p.frame.url;
      tab.title = "";
      if (NOT_A_PAGE.test(tab.url)) {
        r.cdp.fire("Page.navigate", { url: "about:blank" }, session);
        sayAll(r, { t: "note", text: "That page isn't one this browser opens (http and https only).", bad: true });
      }
      pushTabs(r);
      void refreshHistory(r, tab);
      break;
    }
    case "Page.navigatedWithinDocument": {
      if (p.frameId !== tab.frame) break;
      tab.url = p.url;
      pushTabs(r);
      void refreshHistory(r, tab);
      break;
    }
    case "Page.javascriptDialogOpening": {
      const kind = String(p.type ?? "alert");
      const message = String(p.message ?? "").slice(0, 2000);
      const watched = [...r.socks].some((s) => s.tab === tab.id);
      // leaving a page is the person's (or the agent's) own doing: the page doesn't get to hold them
      if (kind === "beforeunload") {
        r.cdp.fire("Page.handleJavaScriptDialog", { accept: true }, session);
        break;
      }
      // an agent is driving, or nobody is looking at this tab: nobody is there to answer
      if (r.agentBusy || !watched) {
        r.cdp.fire("Page.handleJavaScriptDialog", { accept: false }, session);
        sayAll(r, { t: "note", text: `The page said “${message.slice(0, 160)}”; it was dismissed${r.agentBusy ? " for the agent" : ""}.` });
        break;
      }
      tab.dialog = { kind, message, value: String(p.defaultPrompt ?? ""), timer: setTimeout(() => answerDialog(r, tab, false), DIALOG_MS) };
      for (const s of r.socks) if (s.tab === tab.id) say(s, { t: "dialog", tab: tab.id, kind, message, value: tab.dialog.value });
      break;
    }
    case "Page.javascriptDialogClosed": {
      if (tab.dialog) {
        clearTimeout(tab.dialog.timer);
        tab.dialog = undefined;
        sayAll(r, { t: "dialog.done", tab: tab.id });
      }
      break;
    }
    case "Page.fileChooserOpened": {
      for (const s of r.socks) if (s.tab === tab.id) say(s, { t: "blocked", what: "file" });
      break;
    }
    case "Inspector.targetCrashed": {
      sayAll(r, { t: "note", text: `“${tab.title || tab.url}” crashed. Reload it.`, bad: true });
      break;
    }
  }
}

// ---------- a person's socket

const BUTTONS = ["left", "middle", "right"] as const;
const int = (v: unknown, lo: number, hi: number, d = 0) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);
const num = (v: unknown, lo: number, hi: number) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : 0);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** on a Mac the editing chords are the app's menu, which a headless browser doesn't have: name the command */
const MAC_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

/**
 * A socket that spent its key. The browser starts now if it isn't running, and stops when the last socket closes.
 * The protocol is at the top of this file.
 */
export function attachHostBrowser(_id: string, ws: WebSocket, user: UserInfo, page?: CardPage) {
  const s: Sock = { ws, user, tab: null, size: null, looking: true, ...(page ? { page } : {}) };
  let r: Run | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(s.sizeTimer);
    if (!r) return;
    r.socks.delete(s);
    if (r.over) return;
    const tab = s.tab ? r.tabs.get(s.tab) : undefined;
    if (tab) syncCast(r, tab);
    // a card's tab nobody looks at any more is closed after a while (its picture stays)
    const mine = r;
    for (const t of mine.tabs.values()) {
      if (!t.card || !sameCard(t.card, s.page) || t.idleTimer || [...mine.socks].some((o) => o.tab === t.id)) continue;
      t.idleTimer = setTimeout(() => {
        t.idleTimer = undefined;
        if (!mine.over && mine.tabs.has(t.id) && ![...mine.socks].some((o) => o.tab === t.id)) mine.cdp.fire("Target.closeTarget", { targetId: t.target });
      }, CARD_TAB_IDLE_MS);
      t.idleTimer.unref();
    }
    if (r.socks.size === 0) {
      console.log(`  browser            closed (${user.name} was the last one looking)`);
      void stop(r);
    }
  };
  ws.on("close", close);
  ws.on("error", close);

  const onMessage = (raw: unknown) => {
    if (!r || r.over) return;
    const run = r;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    const tab = s.tab ? run.tabs.get(s.tab) : undefined;
    const fail = (e: Error) => say(s, { t: "note", text: e.message, bad: true });
    switch (m.t) {
      case "size": {
        const size = clampSize(m);
        const looking = size !== null;
        if (looking !== s.looking) {
          s.looking = looking;
          if (tab) {
            syncCast(run, tab);
            if (looking && tab.last) sendFrame(s, tab, tab.last);
          }
        }
        if (!size) break;
        s.size = size;
        clearTimeout(s.sizeTimer);
        s.sizeTimer = setTimeout(() => {
          const now = s.tab ? run.tabs.get(s.tab) : undefined;
          if (now && s.size && !run.over) applySize(run, now, s.size);
        }, SIZE_DEBOUNCE_MS);
        break;
      }
      case "tab.new": {
        if (s.page) break; // a page card is one page: tabs are the Browser tool's
        const a = typeof m.url === "string" && m.url.trim() ? browserAddress(m.url) : { url: "about:blank" };
        if ("refused" in a) return fail(new Error(a.refused));
        void newTab(run, a.url).then((t) => look(run, s, t.id), fail);
        break;
      }
      case "tab.select": {
        if (typeof m.tab === "string") look(run, s, m.tab);
        break;
      }
      case "tab.close": {
        const t = typeof m.tab === "string" ? run.tabs.get(m.tab) : undefined;
        if (s.page && !sameCard(t?.card, s.page)) break;
        if (t) run.cdp.fire("Target.closeTarget", { targetId: t.target });
        break;
      }
      case "nav": {
        if (tab) void navigate(run, tab, str(m.url, 4100)).catch(fail);
        break;
      }
      case "back":
      case "forward": {
        if (tab) void step(run, tab, m.t === "back" ? -1 : 1).catch(fail);
        break;
      }
      case "reload": {
        if (tab) run.cdp.fire("Page.reload", {}, tab.session);
        break;
      }
      case "stop": {
        if (tab) run.cdp.fire("Page.stopLoading", {}, tab.session);
        break;
      }
      case "mouse": {
        if (!tab) break;
        const kind = m.kind === "down" ? "mousePressed" : m.kind === "up" ? "mouseReleased" : "mouseMoved";
        const button = kind === "mouseMoved" && !int(m.buttons, 0, 7) ? "none" : (BUTTONS[int(m.button, 0, 2)] ?? "left");
        const sent = input(run, tab, "Input.dispatchMouseEvent", { type: kind, x: num(m.x, 0, 8000), y: num(m.y, 0, 8000), button, buttons: int(m.buttons, 0, 7), clickCount: kind === "mouseMoved" ? 0 : int(m.clicks, 1, 3, 1), modifiers: int(m.mods, 0, 15) });
        // a press let go: did it land in a field? (a page card at rest takes the keys only then)
        if (kind === "mouseReleased")
          void sent
            .then(() => run.cdp.send<{ result: { value?: boolean } }>("Runtime.evaluate", { expression: EDITING, returnByValue: true }, tab.session))
            .then((v) => say(s, { t: "focus", editing: v.result.value === true }))
            .catch(() => {});
        else void sent.catch(() => {});
        break;
      }
      case "wheel": {
        if (tab) void input(run, tab, "Input.dispatchMouseEvent", { type: "mouseWheel", x: num(m.x, 0, 8000), y: num(m.y, 0, 8000), deltaX: num(m.dx, -4000, 4000), deltaY: num(m.dy, -4000, 4000), modifiers: int(m.mods, 0, 15) }).catch(() => {});
        break;
      }
      case "key": {
        if (!tab) break;
        const text = str(m.text, 8);
        const key = str(m.key, 40);
        const mods = int(m.mods, 0, 15);
        const down = m.kind !== "up";
        const command = process.platform === "darwin" && down && mods & 4 ? (key.toLowerCase() === "z" && mods & 8 ? "redo" : MAC_COMMANDS[key.toLowerCase()]) : undefined;
        void input(run, tab, "Input.dispatchKeyEvent", {
            type: !down ? "keyUp" : text ? "keyDown" : "rawKeyDown",
            key,
            code: str(m.code, 40),
            windowsVirtualKeyCode: int(m.vk, 0, 255),
            nativeVirtualKeyCode: int(m.vk, 0, 255),
            modifiers: mods,
            autoRepeat: m.repeat === true,
            location: int(m.location, 0, 3),
            ...(down && text ? { text, unmodifiedText: text } : {}),
            ...(command ? { commands: [command] } : {}),
          }).catch(() => {});
        break;
      }
      case "paste": {
        const text = str(m.text, 200_000);
        if (tab && text) void input(run, tab, "Input.insertText", { text }).catch(() => {});
        break;
      }
      case "copy": {
        if (!tab) break;
        void run.cdp
          .send<{ result: { value?: string } }>("Runtime.evaluate", { expression: SELECTION, returnByValue: true }, tab.session)
          .then((v) => say(s, { t: "copied", text: String(v.result?.value ?? "").slice(0, 200_000) }))
          .catch(() => {});
        break;
      }
      case "dialog": {
        if (tab) answerDialog(run, tab, m.accept === true, typeof m.text === "string" ? m.text : undefined);
        break;
      }
      case "agents": {
        if (m.allow === true) {
          if (computerUseDefault(user.id) === "never") return fail(new Error("You've set agents' computer use to Never (Settings), so this stays off. Change that first if you mean to let them."));
          run.agentsMay = { by: user.name, byId: user.id, at: Date.now() };
          console.log(`  browser            ${user.name} let agents use it`);
        } else {
          run.agentsMay = null;
          run.agentTab = null;
        }
        sayAll(run, { t: "agents", allow: Boolean(run.agentsMay), ...(run.agentsMay ? { by: run.agentsMay.by } : {}) });
        pushTabs(run);
        break;
      }
    }
  };

  void (async () => {
    // the one before is still closing: it holds the profile folder until it has gone
    await leaving;
    if (closed) return;
    if (!run) {
      const found = findBrowser();
      if (!found) {
        say(s, { t: "closed", why: noBrowserSentence() });
        return ws.close();
      }
      run = launch(found);
      console.log(`  browser            ${user.name} started ${found.name} (headless; profile ${profileDir()})`);
    }
    const mine = run;
    mine.socks.add(s);
    r = mine;
    if (closed) {
      // it closed while we waited: put it back as it was
      closed = false;
      return close();
    }
    try {
      await mine.ready;
    } catch {
      return; // launch's own handler has told every socket and closed them
    }
    if (closed || mine.over) return;
    say(s, { t: "hello", browser: mine.name, agents: Boolean(mine.agentsMay), ...(mine.agentsMay ? { by: mine.agentsMay.by } : {}) });
    // heard from here on: a card's tab is still being made below, and the size its page sends meanwhile must not be lost
    ws.on("message", onMessage);
    if (s.page) {
      // the card's own tab: the one kept for it, or a new one at its address
      const page = s.page;
      let tab = cardTab(mine, page);
      if (!tab) {
        try {
          // the browser starts with one empty tab: the first card takes it rather than leave it lying about
          const empty = [...mine.tabs.values()].find((t) => !t.card && t.url === "about:blank" && ![...mine.socks].some((o) => o.tab === t.id));
          tab = empty ?? (await newTab(mine, "about:blank"));
          tab.card = page;
          tab.home = true;
          await navigate(mine, tab, page.url);
        } catch (e) {
          say(s, { t: "closed", why: (e as Error).message });
          return ws.close();
        }
      }
      if (closed || mine.over) return;
      look(mine, s, tab.id);
    } else {
      const first = [...mine.tabs.values()].find((t) => !t.card) ?? [...mine.tabs.values()][0];
      if (first) look(mine, s, first.id);
      // the tool's first opening of this browser: its empty tab goes to the opening page (HyperForm). A person
      // opened the tool, so this is their press; a tab already somewhere is left where it is
      if (first && !mine.homed) {
        mine.homed = true;
        const home = browserHome();
        if (home !== "about:blank" && !first.card && first.url === "about:blank") void navigate(mine, first, home).catch(() => {});
      }
    }
  })();
}

/** what the page has selected, as text (an input's selection, else the document's) */
/** is the caret in something that takes typing (a field, an editor, or a frame from another site, which can't be looked into)? */
const EDITING = `(() => { let a = document.activeElement; try { while (a && a.tagName === "IFRAME" && a.contentDocument) a = a.contentDocument.activeElement; } catch {} if (!a) return false; if (a.tagName === "IFRAME" || a.isContentEditable) return true; if (a.disabled || a.readOnly) return false; if (a.tagName === "TEXTAREA") return true; if (a.tagName === "INPUT") return !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i.test(a.type); return false; })()`;
const SELECTION = `(() => { const a = document.activeElement; try { if (a && typeof a.selectionStart === "number" && a.selectionEnd > a.selectionStart && a.type !== "password") return a.value.slice(a.selectionStart, a.selectionEnd); } catch {} return String(getSelection() || ""); })()`;

// ---------------------------------------------------------------- agents

/** what an agent is told when it may not use the browser: nothing was started, nothing was done */
export const NO_LEAVE = "The browser isn't open to agents. A person (an admin) must open the Browser tool (or a page card on a grid), start it, and turn on “Let agents use this browser” (“Agents” on the card). Nothing was done; an agent can't start it.";

export interface BrowserAgent {
  /** the agent's display name, as the person watching sees it */
  actor: string;
  /** the person it acts for (ToolCtx.userId): the leave is that person's own, so only their agents may use it */
  userId?: string;
}

/**
 * The page as text, for an agent: headings, paragraphs and list items, with every link, button and field tagged
 * [ref_N]. The elements are kept (in a world of the page's that its own scripts can't reach) so the next call can
 * click or type by ref. A password field's value is never read out. Kept as source text: it runs in the page.
 */
const READ_PAGE = String.raw`(function (max) {
  var refs = [];
  globalThis.__foundationRefs = refs;
  var out = [];
  var line = "";
  function flush() {
    var t = line.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
    line = "";
  }
  function clean(t, n) {
    return String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
  }
  function hidden(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    var s = getComputedStyle(el);
    return s.display === "none" || s.visibility === "hidden";
  }
  function label(el) {
    var t = clean(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("alt"), 120);
    if (!t && el.querySelector) {
      var img = el.querySelector("img[alt], svg[aria-label]");
      if (img) t = clean(img.getAttribute("alt") || img.getAttribute("aria-label"), 120);
    }
    return t;
  }
  function ref(el) {
    refs.push(el);
    return "[ref_" + refs.length + "]";
  }
  function q(t) {
    return '"' + t.replace(/"/g, "'") + '"';
  }
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|CANVAS|VIDEO|AUDIO|OBJECT|EMBED)$/;
  var BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|NAV|ASIDE|UL|OL|LI|TABLE|TR|FORM|FIELDSET|BLOCKQUOTE|PRE|DL|DT|DD|FIGURE|FIGCAPTION|DETAILS|SUMMARY|BR|HR|LABEL)$/;
  var ROLES = /^(button|link|tab|menuitem|checkbox|radio|switch|option|combobox|textbox|searchbox)$/;
  function kids(el) {
    var list = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    for (var i = 0; i < list.length; i++) walk(list[i]);
  }
  function walk(node) {
    if (node.nodeType === 3) {
      line += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    var el = node;
    var tag = String(el.tagName).toUpperCase();
    if (SKIP.test(tag)) return;
    if (tag === "IFRAME") {
      flush();
      out.push("(a framed page: " + clean(el.src, 200) + ")");
      return;
    }
    if (hidden(el)) return;
    var role = el.getAttribute("role") || "";
    if (tag === "A" && el.href) {
      line += " " + ref(el) + " link " + q(label(el)) + " (" + String(el.href).slice(0, 300) + ") ";
      return;
    }
    if (tag === "BUTTON" || (tag === "INPUT" && /^(button|submit|reset|image)$/.test(el.type))) {
      line += " " + ref(el) + " button " + q(label(el)) + (el.disabled ? " (disabled)" : "") + " ";
      return;
    }
    if (tag === "INPUT") {
      if (el.type === "hidden") return;
      var v = el.type === "password" ? (el.value ? "(hidden)" : "") : el.type === "checkbox" || el.type === "radio" ? (el.checked ? "checked" : "not checked") : clean(el.value, 200);
      line += " " + ref(el) + " input " + el.type + (el.name ? " name=" + q(clean(el.name, 60)) : "") + (clean(el.getAttribute("aria-label") || el.placeholder, 80) ? " label=" + q(clean(el.getAttribute("aria-label") || el.placeholder, 80)) : "") + (v ? " value=" + q(v) : "") + (el.disabled ? " (disabled)" : "") + " ";
      return;
    }
    if (tag === "TEXTAREA") {
      line += " " + ref(el) + " textarea" + (el.name ? " name=" + q(clean(el.name, 60)) : "") + (clean(el.getAttribute("aria-label") || el.placeholder, 80) ? " label=" + q(clean(el.getAttribute("aria-label") || el.placeholder, 80)) : "") + (el.value ? " value=" + q(clean(el.value, 200)) : "") + " ";
      return;
    }
    if (tag === "SELECT") {
      var opts = [];
      for (var i = 0; i < el.options.length && i < 30; i++) opts.push((el.options[i].selected ? "*" : "") + clean(el.options[i].text, 40));
      line += " " + ref(el) + " select" + (el.name ? " name=" + q(clean(el.name, 60)) : "") + " options: " + opts.join(" | ") + " ";
      return;
    }
    if (ROLES.test(role)) {
      line += " " + ref(el) + " " + role + " " + q(label(el)) + " ";
      return;
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) {
      line += " " + ref(el) + " editable " + q(clean(el.innerText, 200)) + " ";
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      flush();
      line = "#######".slice(0, +tag[1]) + " ";
      kids(el);
      flush();
      return;
    }
    if (tag === "IMG") {
      var alt = clean(el.alt, 120);
      if (alt) line += " (picture: " + alt + ") ";
      return;
    }
    var block = BLOCK.test(tag);
    if (block) flush();
    if (tag === "LI") line = "- ";
    kids(el);
    if (block || tag === "TD" || tag === "TH") tag === "TD" || tag === "TH" ? (line += " | ") : flush();
  }
  walk(document.body || document.documentElement);
  flush();
  var text = out.join("\n");
  var cut = text.length > max;
  return { url: location.href, title: document.title, text: cut ? text.slice(0, max) : text, cut: cut, refs: refs.length };
})`;

/** the element a ref names, brought into view: where its middle is, and whether a click there would land on it */
const REF_POINT = String.raw`(function (n) {
  var el = (globalThis.__foundationRefs || [])[n - 1];
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  var at = r.width && r.height ? document.elementFromPoint(x, y) : null;
  var hit = !!at && (at === el || el.contains(at) || at.contains(el));
  var name = String(el.getAttribute("aria-label") || el.innerText || el.value || el.name || el.tagName || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!hit) el.click();
  return { x: x, y: y, hit: hit, name: name };
})`;

/** the field a ref names, focused with what it holds selected, so typing replaces it */
const REF_FOCUS = String.raw`(function (n) {
  var el = (globalThis.__foundationRefs || [])[n - 1];
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  var filled = false;
  try {
    if (typeof el.select === "function") { el.select(); filled = !!el.value; }
    else if (el.isContentEditable) { var s = getSelection(); s.selectAllChildren(el); filled = !!el.innerText; }
  } catch (e) {}
  var name = String(el.getAttribute("aria-label") || el.placeholder || el.name || el.tagName || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { ok: document.activeElement === el || el.isContentEditable, filled: filled, name: name, secret: el.type === "password" };
})`;

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** after an agent acts: let the page start whatever it starts, then wait for it to finish loading */
async function settle(r: Run, tab: Tab, ms = 12_000) {
  await sleep(250);
  const t0 = Date.now();
  while (!r.over && r.tabs.has(tab.id) && tab.loading && Date.now() - t0 < ms) await sleep(60);
  await sleep(120);
}

/** the tab an agent acts on: the one it opened or chose, else the one the people are looking at */
function agentTabOf(r: Run): Tab {
  const own = r.agentTab ? r.tabs.get(r.agentTab) : undefined;
  if (own) return own;
  const seen = [...r.socks].map((s) => (s.tab ? r.tabs.get(s.tab) : undefined)).find(Boolean);
  const tab = seen ?? [...r.tabs.values()][0];
  if (!tab) throw new Error("The browser has no tab open.");
  return tab;
}

const stale = (ref: number) => new Error(`ref_${ref} isn't on the page any more (the page changed, or moved on). Call browser_read again and use the refs it gives.`);

async function inWorld<T>(r: Run, tab: Tab, fn: string, arg: number, ref: number): Promise<T> {
  if (tab.readCtx === undefined) throw stale(ref);
  const v = await r.cdp.send<{ result: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: `${fn}(${arg})`, contextId: tab.readCtx, returnByValue: true, userGesture: true }, tab.session).catch(() => null);
  if (!v || v.exceptionDetails || v.result?.value == null) throw stale(ref);
  return v.result.value;
}

const refNumber = (ref: string | number) => {
  const n = Number(String(ref).replace(/^\[?ref_/i, "").replace(/\]$/, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`“${ref}” isn't a ref. Use one browser_read gave, like ref_3.`);
  return n;
};

export type BrowserAction =
  | { kind: "read" }
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: string | number }
  | { kind: "type"; ref: string | number; text: string; submit?: boolean }
  | { kind: "tabs"; open?: string; select?: string; close?: string };

/** may an agent use the browser right now: it runs, a person is looking, and they have said so */
export function agentsMayBrowse(): boolean {
  return Boolean(run && !run.over && run.socks.size > 0 && run.agentsMay);
}

/**
 * An agent uses the browser (tools.ts). Without a person's leave it returns NO_LEAVE (a sentence, not an error)
 * and does nothing: it never starts the browser. One action at a time; each is shown to the people looking.
 */
export function agentBrowser(agent: BrowserAgent, action: BrowserAction): Promise<unknown> {
  if (!agentsMayBrowse()) return Promise.resolve(NO_LEAVE);
  const r = run!;
  // the leave is the person's who gave it: the browser holds their sign-ins, so only agents acting for them use it
  if (agent.userId !== undefined && r.agentsMay && agent.userId !== r.agentsMay.byId)
    return Promise.resolve(`${r.agentsMay.by} let their own agents use the browser, not everyone's. Nothing was done: ask ${r.agentsMay.by}, or open the Browser tool yourself (an admin) and turn on “Let agents use this browser”.`);
  const next = r.agentQueue.then(async () => {
    // the leave may have been taken back, or the browser closed, while this waited its turn
    if (run !== r || !agentsMayBrowse()) return NO_LEAVE;
    r.agentBusy++;
    try {
      return await act(r, agent, action);
    } finally {
      r.agentBusy--;
    }
  });
  r.agentQueue = next.catch(() => {});
  return next;
}

async function act(r: Run, agent: BrowserAgent, action: BrowserAction): Promise<unknown> {
  const tell = (tab: Tab | null, did: string) => {
    sayAll(r, { t: "agent", who: agent.actor, did, tab: tab?.id ?? null });
    pushTabs(r);
  };
  const where = (tab: Tab) => ({ tab: tab.id, url: tab.url, title: tab.title });

  if (action.kind === "tabs") {
    if (action.open !== undefined) {
      const a = browserAddress(action.open);
      if ("refused" in a) throw new Error(a.refused);
      const tab = await newTab(r, a.url);
      r.agentTab = tab.id;
      tell(tab, `opened a tab at ${a.url}`);
      await settle(r, tab);
    }
    if (action.select !== undefined) {
      const tab = r.tabs.get(action.select);
      if (!tab) throw new Error(`There's no tab ${action.select}. browser_tabs lists them.`);
      r.agentTab = tab.id;
      tell(tab, `turned to the tab “${tab.title || tab.url}”`);
    }
    if (action.close !== undefined) {
      const tab = r.tabs.get(action.close);
      if (!tab) throw new Error(`There's no tab ${action.close}. browser_tabs lists them.`);
      tell(tab, `closed the tab “${tab.title || tab.url}”`);
      await r.cdp.send("Target.closeTarget", { targetId: tab.target });
      await sleep(150);
    }
    const mine = agentTabOf(r);
    return { current: mine.id, tabs: [...r.tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, ...(t.card ? { card: t.card.card, board: t.card.board } : {}) })) };
  }

  const tab = agentTabOf(r);
  r.agentTab = tab.id;

  if (action.kind === "read") {
    tell(tab, `read “${tab.title || tab.url}”`);
    return readPage(r, tab);
  }
  if (action.kind === "navigate") {
    const a = browserAddress(action.url);
    if ("refused" in a) throw new Error(a.refused);
    tell(tab, `went to ${a.url}`);
    await navigate(r, tab, a.url);
    await settle(r, tab);
    return { ...where(tab), note: "browser_read reads the page." };
  }
  if (action.kind === "click") {
    const n = refNumber(action.ref);
    const at = await inWorld<{ x: number; y: number; hit: boolean; name: string }>(r, tab, REF_POINT, n, n);
    tell(tab, `pressed “${at.name}”`);
    // a real press where the element is; if something covers it there, the element was pressed directly instead
    if (at.hit) {
      const p = { x: at.x, y: at.y, button: "left", clickCount: 1 };
      await input(r, tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await input(r, tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...p, buttons: 1 });
      await input(r, tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...p, buttons: 0 });
    }
    await settle(r, tab);
    // a link that opened its own tab: the agent is there now
    const now = agentTabOf(r);
    return { pressed: at.name, ...where(now), note: "browser_read reads the page as it is now; the old refs are gone if it changed." };
  }
  // type
  const n = refNumber(action.ref);
  const f = await inWorld<{ ok: boolean; filled: boolean; name: string; secret: boolean }>(r, tab, REF_FOCUS, n, n);
  if (!f.ok) throw new Error(`ref_${n} (“${f.name}”) doesn't take typing. Pick a field from browser_read.`);
  tell(tab, f.secret ? `typed into “${f.name}”` : `typed “${action.text.slice(0, 60)}${action.text.length > 60 ? "…" : ""}” into “${f.name}”`);
  const key = (type: string, k: string, code: string, vk: number, text?: string) => input(r, tab, "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
  if (action.text) await input(r, tab, "Input.insertText", { text: action.text });
  else if (f.filled) {
    await key("rawKeyDown", "Backspace", "Backspace", 8);
    await key("keyUp", "Backspace", "Backspace", 8);
  }
  if (action.submit) {
    await key("keyDown", "Enter", "Enter", 13, "\r");
    await key("keyUp", "Enter", "Enter", 13);
    await settle(r, tab);
  }
  return { typed_into: f.name, ...(action.submit ? { submitted: true } : {}), ...where(agentTabOf(r)) };
}

async function readPage(r: Run, tab: Tab) {
  const world = await r.cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: tab.frame, worldName: "foundation-read" }, tab.session);
  tab.readCtx = world.executionContextId;
  const v = await r.cdp.send<{ result: { value?: { url: string; title: string; text: string; cut: boolean; refs: number } }; exceptionDetails?: { text?: string } }>(
    "Runtime.evaluate",
    { expression: `${READ_PAGE}(${READ_MAX})`, contextId: tab.readCtx, returnByValue: true },
    tab.session,
  );
  const page = v.result?.value;
  if (!page) throw new Error(`The page couldn't be read${v.exceptionDetails?.text ? ` (${v.exceptionDetails.text})` : ""}. It may still be loading: try again.`);
  return {
    tab: tab.id,
    url: page.url,
    title: page.title,
    loading: tab.loading,
    text: page.text + (page.cut ? "\n… (cut here: the page goes on)" : ""),
    note: `${page.refs} things to press or fill are tagged [ref_N]: browser_click and browser_type take a ref. They hold until the page changes.`,
  };
}

// ---------------------------------------------------------------- for the tests, and a server stopping

/** is the browser process running */
export function hostBrowserRunning(): boolean {
  return Boolean(run && !run.over);
}
/** how many sockets are looking */
export function hostBrowserViewers(): number {
  return run?.socks.size ?? 0;
}
/** stop the browser and wait until its process has gone */
export async function stopHostBrowser(): Promise<void> {
  const r = run;
  if (r) {
    for (const s of [...r.socks]) s.ws.close();
    await stop(r);
  }
  await leaving;
}
/** for the tests: is the last browser's process still alive */
export function _browserProcessAlive(): boolean {
  return Boolean(lastProc && lastProc.exitCode === null && lastProc.signalCode === null);
}
/** for the tests: run an expression in the page the first socket is looking at */
export async function _evaluateForTest(expression: string): Promise<unknown> {
  const r = run;
  const s = r ? [...r.socks][0] : undefined;
  const tab = r && s?.tab ? r.tabs.get(s.tab) : undefined;
  if (!r || !tab) throw new Error("no page");
  const v = await r.cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, tab.session);
  return v.result?.value;
}
// a browser outlives nothing: when the server goes, it goes with it (and closing its pipes ends it besides)
process.on("exit", () => {
  if (run) kill(run);
});

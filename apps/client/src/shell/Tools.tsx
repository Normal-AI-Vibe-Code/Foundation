/**
 * The built-in tools (2026-11-17, Josh: "implement the tools we want in the top right, an inbuilt terminal, an
 * inbuilt browser, an inbuilt file-system, an in-built change log, and an in-built T3 server and client pulling
 * from the work we did in Vision"). Their buttons sit at the top bar's right end; each opens in one pane on the
 * right, on the floor like search and the agents (it takes their place, and they take its).
 *
 *  - **Terminal**: a shell on the computer Foundation's server runs on, in the server's folder. An admin's, and
 *    started by their press on the Terminal's button or tab (2026-11-20; before, a second press on Start. The
 *    server mints a one-time key for the socket: apps/server/src/hostterm.ts).
 *    Line-mode: the line is edited here, the shell runs it and answers with its folder as the prompt. What a
 *    command prints arrives without the blank lines a shell pads it with (server: termtidy.ts), and one empty
 *    line stands between a command and the next prompt, the same every time.
 *  - **Browser** (shell/BrowserTool.tsx; 2026-11-18): a real browser, Edge or Chrome on the server's computer,
 *    driven by the server and sent here as pictures, so any site works (a framed page failed on every site that
 *    refuses framing). Tabs, back, forward, reload, the address, open outside, "put it on the grid", and
 *    "Let agents use this browser": then an agent can read the page and press and type in it. An admin's, started
 *    by a press, like the terminal. Anyone else gets a page framed here, as before.
 *  - **Files**: what's on this grid (the archive: drag a file onto the grid, or press to open it), and the
 *    folders on this computer an admin approved.
 *  - **Changes**: what changed, as a release page (settings/ReleasePage.tsx): each release as a cover, a
 *    description, a diagram of what it's made of and its parts as tiles, the full notes under them; then
 *    Foundation's code (the commits of the checkout the server runs from, by day) and this grid's activity.
 *  - **T3**: this computer's agents. T3's server (Foundation's own instance, apart from Vision Code's) and its
 *    client: the page T3 serves is Vision's build of T3's web client (`data-vision-client`), opened here,
 *    signed in by a one-time link minted when a person opens the tool. Start and Stop are a person's presses.
 *
 * Every tool stays mounted while the pane is open, so moving between them keeps a terminal's shell and a page's
 * place; closing the pane ends the shell.
 */

import { ErrorCard } from "../components/ErrorCard";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onLook } from "@foundation/ui";
import type { SearchHit } from "@foundation/protocol";
import { api, wsUrl } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { refreshAvailable, useAvailable } from "../lib/agentsAvailable";
import { HOLDS_KEYS } from "../lib/keysHeld";
import { WIDTHS, setUi, toast, toggleTool, useUi, type ToolId } from "../state/ui";
import { requestSnap } from "../state/store";
import { activeBoard } from "../sync/board";
import { openExternal } from "../utils/media";
import { BrowserTool } from "./BrowserTool";
import { themeFromTokens } from "../panels/MachineView";
import { FloorEdge } from "./FloorEdge";
import { PlacesBrowser } from "./PlacesBrowser";
import { Draggable } from "./SearchPane";
import { Clipboard } from "./Clipboard";
import { glyphOf } from "../lib/hits";
import { useBoardTick } from "./Presence";
import { POSTS, RUNNING } from "../settings/SettingsPage";
import { releaseKind } from "../settings/releases";
import { ReleaseCard, ReleaseKindGlyph } from "../settings/ReleasePage";
import { BrowserGlyph, ChangesGlyph, ExpandGlyph, FilesGlyph, T3Glyph, TerminalGlyph } from "./glyphs";
import { openAppTab } from "../lib/grids";
import { frameAllow, frameFor } from "../panels/frameSandbox";
import { useFrameContext } from "../lib/frames";

export const TOOLS: Array<{ id: ToolId; name: string; tip: string; glyph: ReactNode }> = [
  { id: "terminal", name: "Terminal", tip: "Terminal: a shell on the server's computer (admins)", glyph: <TerminalGlyph /> },
  { id: "browser", name: "Browser", tip: "Browser: a page, here, and onto the grid", glyph: <BrowserGlyph /> },
  { id: "files", name: "Files", tip: "Files: this grid's, and this computer's folders", glyph: <FilesGlyph /> },
  { id: "changes", name: "Changes", tip: "Change log: the code, the releases, this grid", glyph: <ChangesGlyph /> },
  { id: "t3", name: "T3", tip: "T3: this computer's agents, their server and their page", glyph: <T3Glyph /> },
];

/** the top bar's right end: one button per tool */
export function ToolButtons() {
  const ui = useUi();
  const { t3 } = useAvailable();
  return (
    <div className="tool-buttons" role="group" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`top-btn${ui.tool === t.id ? " is-on" : ""}`}
          onClick={() => toggleTool(t.id)}
          aria-pressed={ui.tool === t.id}
          aria-label={ui.tool === t.id ? `Close ${t.name}` : `Open ${t.name}`}
          data-tip={t.tip}
          data-tool-open={t.id}
        >
          {t.glyph}
          {t.id === "t3" && t3 !== "off" && <i className={`tool-btn-dot is-${t3}`} aria-hidden />}
        </button>
      ))}
    </div>
  );
}

/** the pane on the right: mounted while any tool is open; each tool, once shown, stays mounted until the pane closes */
export function ToolPane() {
  const ui = useUi();
  const [seen, setSeen] = useState<ToolId[]>([]);
  useEffect(() => {
    if (!ui.tool) return setSeen([]);
    setSeen((s) => (s.includes(ui.tool!) ? s : [...s, ui.tool!]));
  }, [ui.tool]);
  if (!ui.tool || ui.presenting) return null;
  const at = TOOLS.find((t) => t.id === ui.tool)!;
  return (
    <aside className="tool-pane floor-pane" style={{ width: ui.toolW }} aria-label={at.name} data-tool={ui.tool}>
      <FloorEdge side="left" value={ui.toolW} {...WIDTHS.tool} onChange={(w) => setUi({ toolW: w })} label={at.name} />
      <nav className="tool-tabs" role="tablist" aria-label="Tools">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={ui.tool === t.id} className={`tool-tab${ui.tool === t.id ? " is-on" : ""}`} onClick={() => setUi({ tool: t.id })} data-tool-tab={t.id}>
            {t.glyph}
            <span>{t.name}</span>
          </button>
        ))}
        <button type="button" className="top-btn tool-close" onClick={() => setUi({ tool: null })} aria-label="Close tools pane" data-tip="Close">
          ✕
        </button>
      </nav>
      {seen.map((id) => (
        <div key={id} className="tool-body" hidden={id !== ui.tool} data-tool-body={id}>
          {id === "terminal" ? <TerminalTool shown={id === ui.tool} /> : id === "browser" ? <BrowserTool /> : id === "files" ? <FilesTool /> : id === "changes" ? <ChangesTool /> : <T3Tool shown={id === ui.tool} />}
        </div>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------- terminal

type TermState = "idle" | "opening" | "open" | "closed";

function TerminalTool({ shown }: { shown: boolean }) {
  const role = useUi().role;
  const caps = useCapabilities();
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TermState>("idle");
  const [where, setWhere] = useState<{ shell: string; cwd: string } | null>(null);
  const xt = useRef<{ term: XTerm; fit: FitAddon; ws: WebSocket } | null>(null);

  // on show (and as the pane is resized) the terminal fills its box
  useEffect(() => {
    if (!shown || !xt.current || !host.current) return;
    const fit = () => {
      try {
        xt.current?.fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host.current);
    return () => ro.disconnect();
  }, [shown, state]);

  useEffect(() => () => {
    xt.current?.ws.close();
    xt.current?.term.dispose();
  }, []);

  const start = async () => {
    if (!host.current) return;
    setState("opening");
    let opened: { id: string; key: string; shell: string; cwd: string };
    try {
      opened = await api("/api/host-terminal", { method: "POST", json: {} });
    } catch (e) {
      toast((e as Error).message, "bad");
      setState("idle");
      return;
    }
    setWhere({ shell: opened.shell, cwd: opened.cwd });
    // xterm measures its font on a canvas: it needs the family itself, not a CSS variable
    const font = getComputedStyle(host.current).getPropertyValue("--font-code").trim() || "ui-monospace, monospace";
    const term = new XTerm({ fontFamily: font, fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, convertEol: false, scrollback: 4000, allowTransparency: true, theme: themeFromTokens(host.current) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    try {
      fit.fit();
    } catch {
      /* hidden */
    }
    // the look changed (day and night, or the place in focus: Today's room, a grid's paper): its colours are
    // the tokens resolved by hand, so they are read again, now and as the 1.4 s fade passes its middle and ends
    const offNight = onLook(() => {
      for (const ms of [0, 760, 1500]) setTimeout(() => host.current && (term.options.theme = themeFromTokens(host.current)), ms);
    });
    const ws = new WebSocket(wsUrl(`/host/terminal/${opened.id}?key=${encodeURIComponent(opened.key)}`));
    xt.current = { term, fit, ws };

    // the line is edited here; the shell runs it when Enter sends it
    let line = "";
    let busy = true;
    /** prompts shown so far: every one after the first stands one empty line below what came before it */
    let prompts = 0;
    const history: string[] = [];
    let back = 0;
    /** lines entered before the shell's first prompt: kept, and run one by one as its prompts come */
    const ahead: string[] = [];
    /** what's typed shows once there is a prompt to type at (before that it is kept, and shown with the prompt) */
    const echo = (text: string) => prompts > 0 && term.write(text);
    const replace = (next: string) => {
      echo("\b \b".repeat(line.length));
      line = next;
      echo(line);
    };
    const send = (text: string) => {
      if (!prompts) {
        ahead.push(text);
        line = "";
        return;
      }
      term.write("\r\n");
      if (text.trim()) history.push(text);
      back = 0;
      busy = true;
      ws.send(JSON.stringify({ t: "line", text }));
      line = "";
    };
    term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (data === "\x1b[A" || data === "\x1b[B") {
        if (!history.length) return;
        back = data === "\x1b[A" ? Math.min(history.length, back + 1) : Math.max(0, back - 1);
        return replace(back ? history[history.length - back] : "");
      }
      if (data === "\x03") {
        term.write("^C");
        if (busy && !line) {
          // a command that won't stop: the shell starts again (there is no terminal to send it an interrupt)
          term.write("\r\n\x1b[2mStopping it: the shell starts again.\x1b[0m\r\n");
          prompts = 0;
          ws.send(JSON.stringify({ t: "restart" }));
        } else term.write("\r\n");
        line = "";
        return;
      }
      if (data === "\x0c") return term.clear();
      for (const ch of data.replace(/\r\n/g, "\r")) {
        if (ch === "\r" || ch === "\n") send(line);
        else if (ch === "\x7f" || ch === "\b") {
          if (line) {
            line = line.slice(0, -1);
            echo("\b \b");
          }
        } else if (ch >= " " || ch === "\t") {
          line += ch;
          echo(ch);
        }
      }
    });
    ws.onopen = () => setState("open");
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { t: string; data?: string; cwd?: string; code?: number; err?: boolean };
      if (m.t === "out" && m.data) term.write(m.err ? `\x1b[33m${m.data}\x1b[0m` : m.data);
      else if (m.t === "prompt") {
        busy = false;
        // a line entered before the shell's first prompt is typed at a prompt now, and run; the rest wait their turn
        const next = ahead.shift();
        term.write(`${prompts++ ? "\r\n" : ""}\x1b[2m${m.cwd}\x1b[0m \x1b[1m❯\x1b[0m ${next ?? line}`);
        if (next !== undefined) {
          const typed = line;
          send(next);
          line = typed;
        }
      } else if (m.t === "exit") term.write(`\r\n\x1b[2mThe shell ended (exit ${m.code ?? "?"}).\x1b[0m\r\n`);
    };
    ws.onclose = () => {
      offNight();
      setState("closed");
      term.write("\r\n\x1b[2mDisconnected.\x1b[0m\r\n");
    };
    term.focus();
  };

  // opening the Terminal (its button in the top bar, or its tab in the pane) is the press that starts the shell:
  // the tool is only ever opened by a person, and never restored on load (state/ui.ts keeps `tool` out of what it
  // saves). Once per opening of the pane: if it fails, the button below is how to try again
  const auto = useRef(false);
  useEffect(() => {
    if (!shown || role !== "admin" || !caps.loaded || !caps.local.terminal || auto.current) return;
    auto.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, role, caps.loaded, caps.local.terminal]);

  const again = () => {
    xt.current?.ws.close();
    xt.current?.term.dispose();
    xt.current = null;
    void start();
  };

  if (!caps.local.terminal)
    return (
      <div className="tool-empty" data-hosted-terminal>
        <b>A terminal on the server's computer</b>
        <p>The built-in terminal runs on a local computer and is turned off on a hosted Foundation server.</p>
      </div>
    );

  if (role !== "admin")
    return (
      <div className="tool-empty">
        <b>A terminal on the server's computer</b>
        <p>It runs what's typed on the computer Foundation's server runs on, so only an admin opens one.</p>
      </div>
    );
  return (
    <div className="tool-term">
      {state === "idle" || state === "opening" ? (
        <div className="tool-empty">
          <b>A terminal on the server's computer</b>
          <p>A shell in the server's own folder. It starts when you open the Terminal, and ends when you close this pane. For programs that need a full terminal (an editor, a hidden password), use the computer's own.</p>
          <button className="f-pill is-accent" onClick={() => void start()} disabled={state === "opening"} data-term-start>
            {state === "opening" ? "Starting…" : "Start a shell"}
          </button>
        </div>
      ) : (
        <div className="tool-term-head">
          <span className={`f-dot ${state === "open" ? "is-ok" : "is-warn"}`} />
          <span>
            {where?.shell} · <code>{where?.cwd}</code>
          </span>
          {state === "closed" && (
            <button className="f-pill" onClick={again}>
              Start again
            </button>
          )}
        </div>
      )}
      <div ref={host} className="tool-term-screen" hidden={state === "idle" || state === "opening"} {...{ [HOLDS_KEYS]: "" }} data-term-screen />
    </div>
  );
}

// the browser is its own file: shell/BrowserTool.tsx (a real browser on the server's computer, sent here as pictures)

// ---------------------------------------------------------------- files

interface FileRow {
  id: string;
  name: string;
  mime: string;
  url: string;
  size?: number;
  createdAt?: number;
}

function FilesTool() {
  const [face, setFace] = useState<"grid" | "computer">("grid");
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const board = activeBoard()?.boardId ?? "company";
  useEffect(() => {
    setFiles(null);
    void api<{ files: FileRow[] }>(`/api/files?board=${encodeURIComponent(board)}`)
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, [board]);
  const shown = useMemo(() => (files ?? []).filter((f) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase())), [files, q]);
  const kinds = useMemo(() => {
    const by = new Map<string, FileRow[]>();
    for (const f of shown) {
      const k = /^image\//.test(f.mime) ? "Pictures" : /^video\//.test(f.mime) ? "Video" : /pdf/.test(f.mime) ? "PDFs" : /step|stp|stl|iges|obj|glb|gltf|model/i.test(`${f.mime} ${f.name}`) ? "CAD and 3D" : "Documents and the rest";
      by.set(k, [...(by.get(k) ?? []), f]);
    }
    return [...by.entries()];
  }, [shown]);
  return (
    <div className="tool-files">
      <div className="tool-faces" role="tablist">
        <button role="tab" aria-selected={face === "grid"} className={`agents-tab${face === "grid" ? " is-on" : ""}`} onClick={() => setFace("grid")}>
          This grid
        </button>
        <button role="tab" aria-selected={face === "computer"} className={`agents-tab${face === "computer" ? " is-on" : ""}`} onClick={() => setFace("computer")}>
          This computer
        </button>
        <input className="tool-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name" aria-label="Filter files" />
      </div>
      {face === "computer" ? (
        <PlacesBrowser board={board} filter={q.trim()} />
      ) : (
        <div className="tool-scroll">
          {files === null && <p className="tool-note">Reading this grid's files…</p>}
          {files !== null && shown.length === 0 && <p className="tool-note">{q.trim() ? `No file here is called “${q.trim()}”.` : "No files on this grid yet. Drop some on it, or ⌘U."}</p>}
          {kinds.map(([kind, list]) => (
            <section key={kind} className="tool-group">
              <div className="pane-eyebrow">
                {kind} <span className="tool-count">{list.length}</span>
              </div>
              {list.map((f) => {
                const hit: SearchHit = { source: "file", id: `file:${f.id}`, title: f.name, snippet: f.mime, url: f.url, score: 1 };
                return (
                  <Draggable key={f.id} hit={hit} className="search-row">
                    <span className="search-row-glyph">{glyphOf(hit)}</span>
                    <span className="search-row-main">
                      <span className="search-row-title">{f.name}</span>
                      <span className="search-row-snip">
                        {f.mime}
                        {f.size ? ` · ${sizeWords(f.size)}` : ""}
                      </span>
                    </span>
                  </Draggable>
                );
              })}
            </section>
          ))}
        </div>
      )}
      <Clipboard />
    </div>
  );
}

const sizeWords = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

// ---------------------------------------------------------------- change log

interface Commit {
  hash: string;
  at: string;
  author: string;
  subject: string;
  body: string;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** "Tuesday 17 November" for a commit's day */
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
};

function ChangesTool() {
  const [face, setFace] = useState<"code" | "releases" | "grid">("releases");
  const [log, setLog] = useState<{ available: boolean; branch?: string; commits: Commit[]; why?: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const board = useBoardTick();
  useEffect(() => {
    if (face !== "code" || log) return;
    void api<NonNullable<typeof log>>("/api/changelog?n=80")
      .then(setLog)
      .catch((e: Error) => setLog({ available: false, commits: [], why: e.message }));
  }, [face, log]);
  const activity = face === "grid" ? (board?.activity() ?? []).slice(-80).reverse() : [];
  return (
    <div className="tool-changes">
      <div className="tool-faces" role="tablist">
        {(["releases", "code", "grid"] as const).map((f) => (
          <button key={f} role="tab" aria-selected={face === f} className={`agents-tab${face === f ? " is-on" : ""}`} onClick={() => setFace(f)} data-changes-face={f}>
            {f === "code" ? "Code" : f === "releases" ? "Releases" : "This grid"}
          </button>
        ))}
        {face === "code" && log?.branch && <span className="tool-note is-inline">on {log.branch}</span>}
      </div>
      <div className="tool-scroll">
        {face === "code" &&
          (log === null ? (
            <p className="tool-note">Reading the commits…</p>
          ) : !log.available ? (
            <p className="tool-note">{log.why}</p>
          ) : (
            <ol className="tool-log">
              {log.commits.map((c, i) => {
                const day = dayOf(c.at);
                const first = i === 0 || dayOf(log.commits[i - 1].at) !== day;
                return (
                  <li key={c.hash} className={`tool-log-row${open === c.hash ? " is-open" : ""}`}>
                    {/* the commits of one day stand under its name */}
                    {first && (
                      <div className="tool-day">
                        {day} <span>{log.commits.filter((x) => dayOf(x.at) === day).length}</span>
                      </div>
                    )}
                    <button className="tool-log-head has-kind" onClick={() => setOpen(open === c.hash ? null : c.hash)} aria-expanded={open === c.hash}>
                      <span className="tool-log-kind">
                        <ReleaseKindGlyph kind={releaseKind(c.subject)} size={14} />
                      </span>
                      <span className="tool-log-subject">{c.subject}</span>
                      <span className="tool-log-meta">
                        <code>{c.hash.slice(0, 7)}</code> · {c.author} · {when(c.at)}
                      </span>
                    </button>
                    {open === c.hash && c.body && <pre className="tool-log-body">{c.body}</pre>}
                  </li>
                );
              })}
            </ol>
          ))}
        {face === "releases" && (POSTS.length === 0 ? <p className="tool-note">No release notes yet: they go in docs/blog/&lt;version&gt;.md.</p> : POSTS.map((p) => <ReleaseCard key={p.version} post={p} running={p.version === RUNNING} />))}
        {face === "grid" &&
          (activity.length === 0 ? (
            <p className="tool-note">Nothing has happened on this grid yet.</p>
          ) : (
            <ol className="tool-log">
              {activity.map((a, i) => (
                <li key={`${a.at}:${i}`} className="tool-log-row">
                  <button className="tool-log-head" onClick={() => a.objectId && requestSnap({ kind: "object", id: a.objectId })} disabled={!a.objectId}>
                    <span className="tool-log-subject">{a.text}</span>
                    <span className="tool-log-meta">
                      {a.who}
                      {a.role === "agent" && a.for ? `, for ${a.for}` : ""} · {when(new Date(a.at).toISOString())}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- T3

/** T3 serves on 127.0.0.1; a page on localhost frames it as localhost, so it's the same site and its sign-in cookie holds */
export function t3PageUrl(url: string, here: string = typeof window !== "undefined" ? window.location.hostname : "") {
  return here === "localhost" ? url.replace(/^http:\/\/127\.0\.0\.1:/, "http://localhost:") : url;
}

/** the configured T3 address's origin: the page the server hands over for T3 (/api/t3host/open), not anything typed */
function t3Origin(page: string): string | null {
  try {
    return new URL(page).origin;
  } catch {
    return null;
  }
}

/**
 * T3, in the tools pane or (`full`) as the canvas of its own tab (shell/AppCanvas.tsx). In the pane its page
 * follows the look around it (dark in the room and at night: `color-scheme` on the frame); the pane's ⤢ opens
 * the app as a tab, where it wears its own look.
 */
export function T3Tool({ shown, full = false }: { shown: boolean; full?: boolean }) {
  const ui = useUi();
  const caps = useCapabilities();
  const { t3, host } = useAvailable();
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const viewer = ui.role === "viewer";
  const frameCtx = useFrameContext();
  const t3Frame = page ? frameFor(page, { ...frameCtx, t3: t3Origin(page) }) : null;
  useEffect(() => {
    if (!caps.loaded || !caps.local.t3) return;
    void refreshAvailable();
    const t = setInterval(() => void refreshAvailable(), t3 === "running" ? 8000 : 3000);
    return () => clearInterval(t);
  }, [t3, caps.loaded, caps.local.t3]);
  // T3's own page, once it runs and someone (not a viewer) has the tool open: a link minted for this opening
  useEffect(() => {
    if (!caps.loaded || !caps.local.t3 || !shown || t3 !== "running" || page || viewer) return;
    void api<{ url: string }>("/api/t3host/open", { method: "POST", json: {} })
      .then((r) => setPage(t3PageUrl(r.url)))
      .catch((e: Error) => setFailed(e.message));
  }, [caps.loaded, caps.local.t3, shown, t3, page, viewer]);
  useEffect(() => {
    if (t3 !== "running") setPage(null);
  }, [t3]);
  if (!caps.local.t3)
    return (
      <div className={`tool-t3${full ? " is-full" : ""}`} data-hosted-t3>
        <div className="tool-empty">
          <b>This computer's agents</b>
          <p>Local T3 agents run on a local computer and are turned off on a hosted Foundation server. Connect your own local agent over MCP in Settings → Agents, or use the server's API agent.</p>
        </div>
      </div>
    );
  const press = (what: "start" | "stop") => {
    setBusy(true);
    setFailed(null);
    void api(`/api/t3host/${what}`, { method: "POST" })
      .then(() => refreshAvailable())
      .catch((e: Error) => toast(e.message, "bad"))
      .finally(() => setBusy(false));
  };
  const agents = host?.agents ?? [];
  const ready = agents.filter((a) => a.state === "ready");
  return (
    <div className={`tool-t3${full ? " is-full" : ""}`}>
      <div className="tool-term-head">
        <span className={`f-dot ${t3 === "running" ? "is-ok" : t3 === "error" ? "is-bad" : t3 === "starting" ? "is-live" : ""}`} />
        <span>
          {t3 === "running" ? `T3 ${host?.version ?? ""} is running · ${ready.length} of ${agents.length} agents ready` : t3 === "starting" ? "T3 is starting…" : t3 === "error" ? `T3 failed: ${host?.detail ?? "no reason given"}` : "T3 is off"}
        </span>
        {!viewer && t3 === "running" && (
          <>
            <button className="top-btn" onClick={() => setPage(null)} aria-label="Reload T3's page" data-tip="Reload T3's page">
              ↻
            </button>
            <button className="top-btn" onClick={() => void api<{ url: string }>("/api/t3host/open", { method: "POST", json: {} }).then((r) => openExternal(r.url), (e: Error) => toast(e.message, "bad"))} aria-label="Open T3 outside" data-tip="Open T3 in your browser">
              ↗
            </button>
            <button className="f-pill" disabled={busy} onClick={() => press("stop")} data-t3-stop>
              Stop
            </button>
          </>
        )}
        {!full && (
          <button
            className="top-btn"
            onClick={() =>
              void openAppTab({ app: "t3" }).then((err) => {
                if (err) return toast(err, "bad");
                setUi({ tool: null });
              })
            }
            aria-label="Open T3 as a tab"
            data-tip="Open T3 as a tab of its own: it joins All Grids"
            data-t3-expand
          >
            <ExpandGlyph />
          </button>
        )}
      </div>
      {t3 === "running" && page && t3Frame?.ok ? (
        // T3's own address (from the server, not typed) keeps its origin; still sandboxed, and never Foundation (frameSandbox.ts)
        <iframe key={page} className="tool-frame is-themed" src={t3Frame.url} title="T3" allow={frameAllow(t3Frame)} sandbox={t3Frame.sandbox} data-t3-frame />
      ) : t3 === "running" && page && t3Frame && !t3Frame.ok ? (
        <div className="tool-empty" data-frame-refused>
          <b>T3</b>
          <p>{t3Frame.reason}</p>
        </div>
      ) : (
        <div className="tool-empty">
          <b>This computer's agents</b>
          <p>T3 runs Claude, Codex, Antigravity (Gemini) and more from one place, with their sign-ins and keys, and its page is where their threads, diffs and sign-ins live: Vision's build of it, here beside the grid. It's a program on this computer, so a person starts it.</p>
          {failed && <ErrorCard message={failed} />}
          {viewer ? (
            <p className="tool-note">Viewers can't start T3.</p>
          ) : t3 === "running" ? (
            <p className="tool-note">Opening T3's page…</p>
          ) : (
            <button className="f-pill is-accent" disabled={busy || t3 === "starting"} onClick={() => press("start")} data-t3-start>
              {busy || t3 === "starting" ? "Starting…" : "Start T3"}
            </button>
          )}
          {agents.length > 0 && (
            <ul className="tool-agents">
              {agents.map((a) => (
                <li key={a.id}>
                  <span className={`f-dot ${a.state === "ready" ? "is-ok" : a.state === "off" ? "" : "is-warn"}`} />
                  <b>{a.name}</b> <span className="tool-log-meta">{a.state === "ready" ? (a.account ?? "ready") : a.state === "off" ? "off" : a.state === "sign-in" ? "needs signing in" : a.state === "missing" ? "not installed here" : "error"}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="f-pill" onClick={() => setUi({ agents: true, agentsTab: "add" })}>
            Add an agent to a council
          </button>
        </div>
      )}
    </div>
  );
}

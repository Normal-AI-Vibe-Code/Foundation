/**
 * The built-in tools (2026-11-17, Josh: "implement the tools we want in the top right, an inbuilt terminal, an
 * inbuilt browser, an inbuilt file-system, an in-built change log, and an in-built T3 server and client pulling
 * from the work we did in Vision"). Their buttons sit at the top bar's right end; each opens in one pane on the
 * right, on the floor like search and the agents (it takes their place, and they take its).
 *
 *  - **Terminal**: a shell on the computer Foundation's server runs on, in the server's folder. An admin's, and
 *    only after they press Start (the server mints a one-time key for the socket: apps/server/src/hostterm.ts).
 *    Line-mode: the line is edited here, the shell runs it and answers with its folder as the prompt.
 *  - **Browser**: a page at an address, with back, forward, reload, open outside, and "put it on the grid" (a
 *    live app card, as ⌘L does). Sites that refuse to be framed say so here and open outside.
 *  - **Files**: what's on this grid (the archive: drag a file onto the grid, or press to open it), and the
 *    folders on this computer an admin approved.
 *  - **Changes**: what changed: Foundation's code (the commits of the checkout the server runs from), its
 *    releases (docs/blog), and this grid's activity.
 *  - **T3**: this computer's agents. T3's server (Foundation's own instance, apart from Vision Code's) and its
 *    client: the page T3 serves is Vision's build of T3's web client (`data-vision-client`), opened here,
 *    signed in by a one-time link minted when a person opens the tool. Start and Stop are a person's presses.
 *
 * Every tool stays mounted while the pane is open, so moving between them keeps a terminal's shell and a page's
 * place; closing the pane ends the shell.
 */

import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onNight } from "@foundation/ui";
import type { SearchHit } from "@foundation/protocol";
import { api, wsUrl } from "../lib/api";
import { refreshAvailable, useAvailable } from "../lib/agentsAvailable";
import { HOLDS_KEYS } from "../lib/keysHeld";
import { WIDTHS, setUi, toast, toggleTool, useUi, type ToolId } from "../state/ui";
import { requestSnap } from "../state/store";
import { activeBoard } from "../sync/board";
import { openExternal } from "../utils/media";
import { themeFromTokens } from "../panels/MachineView";
import { FloorEdge } from "./FloorEdge";
import { PlacesBrowser } from "./PlacesBrowser";
import { Draggable } from "./SearchPane";
import { Clipboard } from "./Clipboard";
import { glyphOf } from "../lib/hits";
import { openUrlAsPanel } from "./CommandBar";
import { useBoardTick } from "./Presence";
import { POSTS } from "../settings/SettingsPage";
import { longDate } from "../settings/releases";
import { renderMarkdown } from "../utils/markdown";
import { BrowserGlyph, ChangesGlyph, FilesGlyph, T3Glyph, TerminalGlyph } from "./glyphs";

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
        <button key={t.id} className={`top-btn${ui.tool === t.id ? " is-on" : ""}`} onClick={() => toggleTool(t.id)} aria-pressed={ui.tool === t.id} aria-label={t.name} data-tip={t.tip} data-tool-open={t.id}>
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
        <button className="top-btn tool-close" onClick={() => setUi({ tool: null })} aria-label="Close the tools" data-tip="Close">
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
    const term = new XTerm({ fontFamily: font, fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, convertEol: false, scrollback: 4000, theme: themeFromTokens(host.current) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    try {
      fit.fit();
    } catch {
      /* hidden */
    }
    const offNight = onNight(() => setTimeout(() => host.current && (term.options.theme = themeFromTokens(host.current)), 760));
    const ws = new WebSocket(wsUrl(`/host/terminal/${opened.id}?key=${encodeURIComponent(opened.key)}`));
    xt.current = { term, fit, ws };

    // the line is edited here; the shell runs it when Enter sends it
    let line = "";
    let busy = true;
    const history: string[] = [];
    let back = 0;
    const replace = (next: string) => {
      term.write("\b \b".repeat(line.length));
      line = next;
      term.write(line);
    };
    const send = (text: string) => {
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
            term.write("\b \b");
          }
        } else if (ch >= " " || ch === "\t") {
          line += ch;
          term.write(ch);
        }
      }
    });
    ws.onopen = () => setState("open");
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { t: string; data?: string; cwd?: string; code?: number; err?: boolean };
      if (m.t === "out" && m.data) term.write(m.err ? `\x1b[33m${m.data}\x1b[0m` : m.data);
      else if (m.t === "prompt") {
        busy = false;
        term.write(`\x1b[2m${m.cwd}\x1b[0m \x1b[1m❯\x1b[0m ${line}`);
      } else if (m.t === "exit") term.write(`\r\n\x1b[2mThe shell ended (exit ${m.code ?? "?"}).\x1b[0m\r\n`);
    };
    ws.onclose = () => {
      offNight();
      setState("closed");
      term.write("\r\n\x1b[2mDisconnected.\x1b[0m\r\n");
    };
    term.focus();
  };

  const again = () => {
    xt.current?.ws.close();
    xt.current?.term.dispose();
    xt.current = null;
    void start();
  };

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
          <p>A shell in the server's own folder. Nothing runs until you start it, and it ends when you close this pane. For programs that need a full terminal (an editor, a hidden password), use the computer's own.</p>
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

// ---------------------------------------------------------------- browser

const normal = (raw: string) => {
  const t = raw.trim();
  if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
};

function BrowserTool() {
  const [stack, setStack] = useState<{ list: string[]; at: number }>({ list: [], at: -1 });
  const [text, setText] = useState("");
  const [nonce, setNonce] = useState(0);
  const url = stack.list[stack.at] ?? "";
  const go = (raw: string) => {
    const u = normal(raw);
    if (!u) return;
    setText(u);
    setStack((s) => ({ list: [...s.list.slice(0, s.at + 1), u], at: s.at + 1 }));
  };
  const step = (d: -1 | 1) =>
    setStack((s) => {
      const at = Math.max(0, Math.min(s.list.length - 1, s.at + d));
      setText(s.list[at] ?? "");
      return { ...s, at };
    });
  return (
    <div className="tool-browser">
      <form
        className="tool-addr"
        onSubmit={(e) => {
          e.preventDefault();
          go(text);
        }}
      >
        <button type="button" className="top-btn" disabled={stack.at <= 0} onClick={() => step(-1)} aria-label="Back" data-tip="Back">
          ←
        </button>
        <button type="button" className="top-btn" disabled={stack.at >= stack.list.length - 1} onClick={() => step(1)} aria-label="Forward" data-tip="Forward">
          →
        </button>
        <button type="button" className="top-btn" disabled={!url} onClick={() => setNonce((n) => n + 1)} aria-label="Reload" data-tip="Reload">
          ↻
        </button>
        <input className="tool-addr-field" value={text} onChange={(e) => setText(e.target.value)} placeholder="An address, or words to search" aria-label="Address" data-browser-addr />
        <button type="button" className="top-btn" disabled={!url} onClick={() => void openExternal(url)} aria-label="Open outside" data-tip="Open in your browser">
          ↗
        </button>
        <button type="button" className="f-pill" disabled={!url} onClick={() => void openUrlAsPanel(url, "app").then(() => toast("On the grid, in the section in use", "ok"))} data-tip="A live card on the grid, in the section in use">
          On the grid
        </button>
      </form>
      {url ? (
        <iframe key={`${url}#${nonce}`} className="tool-frame" src={url} title={url} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" data-browser-frame />
      ) : (
        <div className="tool-empty">
          <b>A page, beside the grid</b>
          <p>Type an address or a search. Some sites won't show inside another app (they say so with a blank page); ↗ opens those in your browser. "On the grid" makes the page a live card everyone on the grid sees.</p>
          <span className="tool-chips">
            {["localhost:1430/#/design", "github.com/joshleong/Foundation", "docs.anthropic.com"].map((u) => (
              <button key={u} className="f-pill" onClick={() => go(u)}>
                {u}
              </button>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

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

function ChangesTool() {
  const [face, setFace] = useState<"code" | "releases" | "grid">("code");
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
        {(["code", "releases", "grid"] as const).map((f) => (
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
              {log.commits.map((c) => (
                <li key={c.hash} className={`tool-log-row${open === c.hash ? " is-open" : ""}`}>
                  <button className="tool-log-head" onClick={() => setOpen(open === c.hash ? null : c.hash)} aria-expanded={open === c.hash}>
                    <span className="tool-log-subject">{c.subject}</span>
                    <span className="tool-log-meta">
                      <code>{c.hash.slice(0, 7)}</code> · {c.author} · {when(c.at)}
                    </span>
                  </button>
                  {open === c.hash && c.body && <pre className="tool-log-body">{c.body}</pre>}
                </li>
              ))}
            </ol>
          ))}
        {face === "releases" &&
          POSTS.map((p) => (
            <details key={p.version} className="tool-release" open={p === POSTS[0]}>
              <summary>
                <b>{p.version}</b> {p.title} <span className="tool-log-meta">{longDate(p.date)}</span>
              </summary>
              <div className="note-rendered releases-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.body) }} />
            </details>
          ))}
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

function T3Tool({ shown }: { shown: boolean }) {
  const ui = useUi();
  const { t3, host } = useAvailable();
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const viewer = ui.role === "viewer";
  useEffect(() => {
    void refreshAvailable();
    const t = setInterval(() => void refreshAvailable(), t3 === "running" ? 8000 : 3000);
    return () => clearInterval(t);
  }, [t3]);
  // T3's own page, once it runs and someone (not a viewer) has the tool open: a link minted for this opening
  useEffect(() => {
    if (!shown || t3 !== "running" || page || viewer) return;
    void api<{ url: string }>("/api/t3host/open", { method: "POST", json: {} })
      .then((r) => setPage(t3PageUrl(r.url)))
      .catch((e: Error) => setFailed(e.message));
  }, [shown, t3, page, viewer]);
  useEffect(() => {
    if (t3 !== "running") setPage(null);
  }, [t3]);
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
    <div className="tool-t3">
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
      </div>
      {t3 === "running" && page ? (
        <iframe key={page} className="tool-frame" src={page} title="T3" allow="clipboard-read; clipboard-write; microphone" data-t3-frame />
      ) : (
        <div className="tool-empty">
          <b>This computer's agents</b>
          <p>T3 runs Claude, Codex, Antigravity (Gemini) and more from one place, with their sign-ins and keys, and its page is where their threads, diffs and sign-ins live: Vision's build of it, here beside the grid. It's a program on this computer, so a person starts it.</p>
          {failed && <p className="tool-note is-bad">{failed}</p>}
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

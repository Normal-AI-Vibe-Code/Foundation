/**
 * The Browser tool (2026-11-18): a real browser on the server's computer, shown here.
 *
 * A framed page fails on every site that refuses framing, so for an admin this is the site's own page in Edge or
 * Chrome on the computer Foundation's server runs on (apps/server/src/hostbrowser.ts): the server sends the page
 * as pictures and this pane sends the pointer and the keys back. Nothing runs until Start is pressed (the server
 * mints a one-time key for the socket, as the terminal's does), and it ends when the pane closes. Agents can read
 * and use it only while it is open here and "Agents" is switched on; what they do is shown under the page.
 *
 * Everyone else gets the framed page this tool was before: fine for sites that allow it, with ↗ for the rest.
 *
 * The page holds the keys while the caret is in it (`data-holds-keys`, as a machine's shell does): the app's own
 * shortcuts stand down, and Esc twice or a click anywhere else gives them back.
 */

import "./browser-tool.css";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, wsUrl } from "../lib/api";
import { escEscToLeave, HOLDS_KEYS } from "../lib/keysHeld";
import { toast, useUi } from "../state/ui";
import { openExternal } from "../utils/media";
import { openUrlAsPanel } from "./CommandBar";

export function BrowserTool() {
  return useUi().role === "admin" ? <HostBrowser /> : <FramedBrowser />;
}

// ---------------------------------------------------------------- the real browser (an admin's)

interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  agent?: boolean;
}
type State = "idle" | "opening" | "open" | "closed";
interface PageDialog {
  kind: string;
  message: string;
  value: string;
}

const shownUrl = (u: string) => (u === "about:blank" ? "" : u);
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};
/** CDP's modifier bits */
const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

function HostBrowser() {
  const [state, setState] = useState<State>("idle");
  const [name, setName] = useState("");
  const [why, setWhy] = useState("");
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [at, setAt] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [held, setHeld] = useState(false);
  const [painted, setPainted] = useState(false);
  const [dialog, setDialog] = useState<PageDialog | null>(null);
  const [answer, setAnswer] = useState("");
  const [agents, setAgents] = useState(false);
  const [did, setDid] = useState<{ who: string; did: string; n: number } | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const addr = useRef<HTMLInputElement>(null);
  /** the CSS size of the frames being drawn (what pointer positions are measured in) */
  const view = useRef({ w: 0, h: 0 });
  const frames = useRef({ got: 0, drawn: 0 });
  const editing = useRef(false);
  const atNow = useRef<string | null>(null);
  /** a picture that came before the canvas was on the page */
  const early = useRef<ArrayBuffer | null>(null);
  const sentSize = useRef("");
  const press = useRef({ at: 0, x: 0, y: 0, button: -1, n: 0 });
  const move = useRef<{ raf: number; m: object | null }>({ raf: 0, m: null });

  const tab = tabs.find((t) => t.id === at) ?? null;
  const url = tab ? shownUrl(tab.url) : "";

  const send = (m: object) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(m));
  };

  // the address field shows where the tab is, unless it's being typed in
  useEffect(() => {
    if (!editing.current) setText(url);
  }, [url, at]);

  // what an agent just did stays a few seconds
  useEffect(() => {
    if (!did) return;
    const t = setTimeout(() => setDid(null), 8000);
    return () => clearTimeout(t);
  }, [did]);

  useEffect(
    () => () => {
      ws.current?.close();
      cancelAnimationFrame(move.current.raf);
    },
    [],
  );

  // the page's box is the browser's window: tell the server its size (nothing while the tool is hidden, which pauses the pictures)
  useEffect(() => {
    const el = page.current;
    if (state !== "open" || !el) return;
    const tell = () => {
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      const m = w < 80 || h < 80 ? { t: "size", w: 0, h: 0, dpr: 1 } : { t: "size", w, h, dpr: Math.min(2, window.devicePixelRatio || 1) };
      const key = JSON.stringify(m);
      if (key === sentSize.current) return;
      sentSize.current = key;
      send(m);
    };
    sentSize.current = "";
    tell();
    if (early.current) void draw(early.current);
    early.current = null;
    const ro = new ResizeObserver(tell);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);

  // the wheel is the page's: React's own wheel listener is passive and can't keep the pane from scrolling
  useEffect(() => {
    const el = page.current;
    if (state !== "open" || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = point(e);
      if (!p) return;
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? view.current.h : 1;
      send({ t: "wheel", ...p, dx: e.deltaX * k, dy: e.deltaY * k, mods: modsOf(e) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [state]);

  /** where a pointer is, in the page's own CSS pixels */
  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current;
    if (!c || !view.current.w) return null;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(((e.clientX - r.left) / r.width) * view.current.w * 10) / 10, y: Math.round(((e.clientY - r.top) / r.height) * view.current.h * 10) / 10 };
  };

  const draw = async (data: ArrayBuffer) => {
    const n = ++frames.current.got;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(new Blob([data], { type: "image/jpeg" }));
    } catch {
      return;
    }
    const c = canvas.current;
    if (!c) {
      early.current = data;
      return bmp.close();
    }
    // decoding is not in order: an older picture never paints over a newer one
    if (n < frames.current.drawn) return bmp.close();
    frames.current.drawn = n;
    if (c.width !== bmp.width || c.height !== bmp.height) {
      c.width = bmp.width;
      c.height = bmp.height;
    }
    c.getContext("2d")?.drawImage(bmp, 0, 0);
    bmp.close();
    setPainted(true);
  };

  const start = async () => {
    setState("opening");
    setWhy("");
    let opened: { id: string; key: string; browser: string };
    try {
      opened = await api("/api/host-browser", { method: "POST", json: {} });
    } catch (e) {
      toast((e as Error).message, "bad");
      setWhy((e as Error).message);
      setState("idle");
      return;
    }
    setName(opened.browser);
    setTabs([]);
    setAt(null);
    setDialog(null);
    setDid(null);
    setPainted(false);
    frames.current = { got: 0, drawn: 0 };
    atNow.current = null;
    early.current = null;
    const s = new WebSocket(wsUrl(`/host/browser/${opened.id}?key=${encodeURIComponent(opened.key)}`));
    s.binaryType = "arraybuffer";
    ws.current = s;
    s.onmessage = (ev) => {
      if (ws.current !== s) return;
      if (typeof ev.data !== "string") return void draw(ev.data as ArrayBuffer);
      const m = JSON.parse(ev.data) as Record<string, unknown> & { t: string };
      if (m.t === "hello") {
        setAgents(m.agents === true);
        setState("open");
      } else if (m.t === "tabs") {
        setTabs(m.tabs as TabInfo[]);
        if (atNow.current !== m.at) {
          // another tab: its own address, and no other tab's question
          atNow.current = m.at as string | null;
          editing.current = false;
          setDialog(null);
        }
        setAt(atNow.current);
      } else if (m.t === "view") view.current = { w: Number(m.w), h: Number(m.h) };
      else if (m.t === "dialog") {
        setAnswer(String(m.value ?? ""));
        setDialog({ kind: String(m.kind), message: String(m.message), value: String(m.value ?? "") });
      } else if (m.t === "dialog.done") setDialog(null);
      else if (m.t === "blocked") toast(m.what === "download" ? `Downloads are off in this browser${m.name ? `: “${String(m.name)}” wasn't saved` : ""}. ↗ opens the page in yours.` : "This browser can't pick files from a computer. ↗ opens the page in yours.");
      else if (m.t === "agents") setAgents(m.allow === true);
      else if (m.t === "agent") setDid((d) => ({ who: String(m.who), did: String(m.did), n: (d?.n ?? 0) + 1 }));
      else if (m.t === "copied") {
        if (m.text) void navigator.clipboard?.writeText(String(m.text)).catch(() => {});
      } else if (m.t === "note") toast(String(m.text), m.bad ? "bad" : undefined);
      else if (m.t === "closed") setWhy(String(m.why ?? ""));
    };
    s.onclose = () => {
      if (ws.current !== s) return;
      setState("closed");
      setHeld(false);
      setDialog(null);
    };
  };

  const again = () => {
    const s = ws.current;
    ws.current = null;
    s?.close();
    void start();
  };

  const go = (raw: string) => {
    if (!raw.trim()) return;
    editing.current = false;
    send({ t: "nav", url: raw });
    page.current?.focus({ preventScroll: true });
  };

  // ---------- the pointer

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dialog) return;
    page.current?.focus({ preventScroll: true });
    // a mouse's back and forward buttons are the browser's
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      return send({ t: e.button === 3 ? "back" : "forward" });
    }
    if (e.button > 2) return;
    const p = point(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const was = press.current;
    const again = e.button === was.button && e.timeStamp - was.at < 500 && Math.abs(e.clientX - was.x) < 6 && Math.abs(e.clientY - was.y) < 6;
    press.current = { at: e.timeStamp, x: e.clientX, y: e.clientY, button: e.button, n: again ? Math.min(3, was.n + 1) : 1 };
    send({ t: "mouse", kind: "down", ...p, button: e.button, buttons: e.buttons, clicks: press.current.n, mods: modsOf(e) });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dialog) return;
    const p = point(e);
    if (!p) return;
    // one move a frame is as many as the page can use
    move.current.m = { t: "mouse", kind: "move", ...p, button: e.buttons & 1 ? 0 : e.buttons & 2 ? 2 : e.buttons & 4 ? 1 : 0, buttons: e.buttons, clicks: 0, mods: modsOf(e) };
    if (!move.current.raf)
      move.current.raf = requestAnimationFrame(() => {
        move.current.raf = 0;
        if (move.current.m) send(move.current.m);
        move.current.m = null;
      });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dialog || e.button > 2) return;
    const p = point(e);
    if (!p) return;
    if (move.current.m) {
      send(move.current.m);
      move.current.m = null;
    }
    send({ t: "mouse", kind: "up", ...p, button: e.button, buttons: e.buttons, clicks: press.current.n, mods: modsOf(e) });
  };

  // ---------- the keys

  const leave = useRef(escEscToLeave(() => page.current?.blur()));
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (dialog || e.nativeEvent.isComposing) return;
    leave.current(e);
    const chord = (e.ctrlKey || e.metaKey) && !e.altKey;
    const k = e.key.toLowerCase();
    // paste arrives as its own event, with the clipboard's text: let it
    if (chord && k === "v") return;
    e.preventDefault();
    // the browser's own keys, which a page never sees
    if (chord && k === "l") return void (addr.current?.focus(), addr.current?.select());
    if ((chord && k === "r") || e.key === "F5") return send({ t: "reload" });
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return send({ t: e.key === "ArrowLeft" ? "back" : "forward" });
    // copy and cut: the page's selection comes back for this computer's clipboard
    if (chord && (k === "c" || k === "x")) send({ t: "copy" });
    // AltGr types a character on many keyboards: it is not Ctrl+Alt to the page
    const altGr = e.getModifierState("AltGraph");
    const printable = e.key.length === 1 && (altGr || (!e.ctrlKey && !e.metaKey));
    const typed = printable ? e.key : e.key === "Enter" ? "\r" : "";
    send({ t: "key", kind: "down", key: e.key, code: e.code, vk: e.keyCode, text: typed, mods: altGr ? modsOf(e) & ~3 : modsOf(e), repeat: e.repeat, location: e.location });
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (dialog) return;
    e.preventDefault();
    send({ t: "key", kind: "up", key: e.key, code: e.code, vk: e.keyCode, mods: modsOf(e), location: e.location });
  };

  const settle = (accept: boolean) => {
    send({ t: "dialog", accept, ...(dialog?.kind === "prompt" ? { text: answer } : {}) });
    setDialog(null);
    page.current?.focus({ preventScroll: true });
  };

  if (state === "idle" || state === "opening")
    return (
      <div className="tool-browser btool">
        <div className="tool-empty">
          <b>A browser on the server's computer</b>
          <p>A real browser (Edge or Chrome), run on the computer Foundation's server is on and shown here, so any site works, and what you sign in to stays signed in. Nothing runs until you start it, and it ends when you close this pane.</p>
          {why && <p className="tool-note is-bad">{why}</p>}
          <button className="f-pill is-accent" onClick={() => void start()} disabled={state === "opening"} data-browser-start>
            {state === "opening" ? "Starting…" : "Start the browser"}
          </button>
        </div>
      </div>
    );

  return (
    <div className="tool-browser btool" data-browser-state={state}>
      <div className="btool-tabs" role="tablist" aria-label="Tabs" data-browser-tabs>
        <span className={`f-dot ${state === "open" ? "is-ok" : "is-warn"}`} data-tip={state === "open" ? `${name}, on the server's computer` : "The browser has closed"} />
        {tabs.map((t) => (
          <div key={t.id} role="tab" tabIndex={0} aria-selected={t.id === at} className={`btool-tab${t.id === at ? " is-on" : ""}${t.agent ? " is-agent" : ""}`} onClick={() => send({ t: "tab.select", tab: t.id })} onKeyDown={(e) => e.key === "Enter" && send({ t: "tab.select", tab: t.id })} data-browser-tab={t.id} data-tip={t.agent ? "An agent is working in this tab" : undefined}>
            {t.loading && <i className="f-dot is-live" aria-hidden />}
            <span className="btool-tab-name">{t.title || hostOf(t.url) || "New tab"}</span>
            <button
              type="button"
              className="btool-tab-x"
              aria-label={`Close ${t.title || hostOf(t.url) || "this tab"}`}
              onClick={(e) => {
                e.stopPropagation();
                send({ t: "tab.close", tab: t.id });
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {state === "open" && (
          <button
            type="button"
            className="top-btn btool-tab-new"
            aria-label="New tab"
            data-tip="New tab"
            onClick={() => {
              send({ t: "tab.new" });
              addr.current?.focus();
            }}
            data-browser-newtab
          >
            ＋
          </button>
        )}
        {state === "closed" && (
          <button className="f-pill btool-again" onClick={again} data-browser-again>
            Start again
          </button>
        )}
      </div>
      <form
        className="tool-addr"
        onSubmit={(e) => {
          e.preventDefault();
          go(text);
        }}
      >
        <button type="button" className="top-btn" disabled={state !== "open" || !tab?.canBack} onClick={() => send({ t: "back" })} aria-label="Back" data-tip="Back">
          ←
        </button>
        <button type="button" className="top-btn" disabled={state !== "open" || !tab?.canForward} onClick={() => send({ t: "forward" })} aria-label="Forward" data-tip="Forward">
          →
        </button>
        <button type="button" className="top-btn" disabled={state !== "open" || !tab} onClick={() => send({ t: tab?.loading ? "stop" : "reload" })} aria-label={tab?.loading ? "Stop" : "Reload"} data-tip={tab?.loading ? "Stop loading" : "Reload"} data-browser-reload>
          {tab?.loading ? "✕" : "↻"}
        </button>
        <input
          ref={addr}
          className="tool-addr-field"
          value={text}
          disabled={state !== "open"}
          onChange={(e) => {
            editing.current = true;
            setText(e.target.value);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            editing.current = false;
            setText(url);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            editing.current = false;
            setText(url);
            page.current?.focus({ preventScroll: true });
          }}
          placeholder="An address, or words to search"
          aria-label="Address"
          spellCheck={false}
          autoComplete="off"
          data-browser-addr
        />
        <button type="button" className="top-btn" disabled={!url} onClick={() => void openExternal(url)} aria-label="Open outside" data-tip="Open in your browser">
          ↗
        </button>
        <button type="button" className="f-pill" disabled={!url} onClick={() => void openUrlAsPanel(url, "app").then(() => toast("On the grid, in the section in use", "ok"))} data-tip="A live card on the grid, in the section in use">
          On the grid
        </button>
        <button
          type="button"
          className={`f-pill btool-agents${agents ? " is-agent" : ""}`}
          disabled={state !== "open"}
          aria-pressed={agents}
          onClick={() => send({ t: "agents", allow: !agents })}
          data-tip={agents ? "Agents can read and use this browser while it's open. Press to stop them." : "Let agents use this browser: they can read pages and press and type here, while it's open"}
          data-browser-agents
        >
          <i className={`f-dot${agents ? " is-agent" : ""}`} aria-hidden />
          Agents
        </button>
      </form>
      <div className={`btool-load${state === "open" && tab?.loading ? " is-on" : ""}`} aria-hidden />
      <div
        ref={page}
        className={`btool-page${held ? " has-keys" : ""}`}
        tabIndex={state === "open" ? 0 : -1}
        role="application"
        aria-label={tab?.title ? `The page: ${tab.title}` : "The page"}
        {...{ [HOLDS_KEYS]: "" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={(e) => {
          e.preventDefault();
          const t = e.clipboardData.getData("text/plain");
          if (t && !dialog) send({ t: "paste", text: t });
        }}
        onFocus={(e) => e.target === e.currentTarget && setHeld(true)}
        onBlur={(e) => e.target === e.currentTarget && setHeld(false)}
        data-browser-page
      >
        <canvas ref={canvas} className="btool-canvas" data-browser-canvas data-browser-painted={painted || undefined} />
        {state === "open" && !painted && <p className="tool-note btool-wait">Opening the page…</p>}
        {held && <span className="btool-held">Keys go to this page · Esc Esc to leave</span>}
        {did && (
          <div className="btool-did" role="status" key={did.n} data-browser-agent-did>
            <i className="btool-did-mark" aria-hidden>
              ✦
            </i>
            <span>
              <b>{did.who}</b> {did.did}
            </span>
          </div>
        )}
        {dialog && (
          <div className="btool-veil">
            <form
              className="btool-sheet"
              role="alertdialog"
              aria-label="The page says"
              onSubmit={(e) => {
                e.preventDefault();
                settle(true);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") settle(false);
              }}
              onKeyUp={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onPaste={(e) => e.stopPropagation()}
              data-browser-dialog
            >
              <span className="btool-sheet-from">{hostOf(tab?.url ?? "") || "The page"} says</span>
              <p>{dialog.message || (dialog.kind === "prompt" ? "It asks for an answer." : "(nothing)")}</p>
              {dialog.kind === "prompt" && <input className="tool-addr-field" value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus aria-label="Your answer" />}
              <span className="btool-sheet-presses">
                {dialog.kind !== "alert" && (
                  <button type="button" className="f-pill" onClick={() => settle(false)}>
                    Cancel
                  </button>
                )}
                <button type="submit" className="f-pill is-accent" autoFocus={dialog.kind !== "prompt"}>
                  OK
                </button>
              </span>
            </form>
          </div>
        )}
        {state === "closed" && (
          <div className="btool-veil">
            <div className="btool-sheet" data-browser-closed>
              <p>{why || "The browser has closed."}</p>
              <span className="btool-sheet-presses">
                <button className="f-pill is-accent" onClick={again}>
                  Start again
                </button>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the framed page (everyone else's)

const normal = (raw: string) => {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return "";
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
};

function FramedBrowser() {
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
          <p className="tool-note">An admin gets the full browser here: a real one on the server's computer, where every site works.</p>
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

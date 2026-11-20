/**
 * The built-in browser's socket, as a hook: what the Browser tool and a page card (panels/HostPage.tsx) share.
 * It holds the browser's state (its tabs, the one this socket looks at, a page's question, agents' leave), draws
 * the pictures the server sends onto a canvas, and sends the pointer and the keys back. Nothing runs until
 * `start()` (the server mints a one-time key for the socket). The protocol is at the top of
 * apps/server/src/hostbrowser.ts.
 *
 * With `page` it is a page card's socket: the server gives it a tab of its own for that card.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, wsUrl } from "../lib/api";
import { escEscToLeave } from "../lib/keysHeld";
import { toast } from "../state/ui";

export interface HostBrowserOpts {
  /** a page card's own tab: its board, its card and its address */
  page?: { board: string; card: string; url: string };
  /** measure the page's box in layout pixels (a card under the camera's zoom), not screen pixels */
  layout?: boolean;
  /** the server kept a picture of the page (a page card) */
  onSeen?: (at: number) => void;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  agent?: boolean;
  /** the page card this tab is kept for */
  card?: string;
}
export type BrowserState = "idle" | "opening" | "open" | "closed";
export interface PageDialog {
  kind: string;
  message: string;
  value: string;
}

export const shownUrl = (u: string) => (u === "about:blank" ? "" : u);
export const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};
/** CDP's modifier bits */
export const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export function useHostBrowser(opts: HostBrowserOpts = {}) {
  const [state, setState] = useState<BrowserState>("idle");
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

  const o = useRef(opts);
  o.current = opts;
  const leaving = useRef(false);
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
      // a card is drawn under the camera's zoom: the page is laid out at the card's own size, not its size on screen
      const r = o.current.layout ? { width: el.offsetWidth, height: el.offsetHeight } : el.getBoundingClientRect();
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
      opened = await api("/api/host-browser", { method: "POST", json: o.current.page ?? {} });
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
      else if (m.t === "seen") o.current.onSeen?.(Number(m.at));
    };
    s.onclose = () => {
      if (ws.current !== s) return;
      setState(leaving.current ? "idle" : "closed");
      leaving.current = false;
      setHeld(false);
      setDialog(null);
    };
  };

  /** close it from this side (a card that nobody is near any more): back to idle, not "closed" */
  const stop = () => {
    const s = ws.current;
    if (!s) return;
    leaving.current = true;
    ws.current = null;
    s.close();
    setState("idle");
    setHeld(false);
    setDialog(null);
    setPainted(false);
    leaving.current = false;
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

  return {
    state, name, why, tabs, at, tab, url, text, setText, held, setHeld, painted, dialog, answer, setAnswer, agents, did,
    page, canvas, addr, editing,
    send, start, stop, again, go, settle,
    onPointerDown, onPointerMove, onPointerUp, onKeyDown, onKeyUp,
  };
}

export type HostBrowserHandle = ReturnType<typeof useHostBrowser>;

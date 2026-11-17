/**
 * A machine's shared terminal, wherever it is drawn: on its card (MachineView.tsx) or in a window of its own
 * (machineWindow.tsx). xterm.js on the machine's `/tty` socket (lib/api openSocket: the cookie, or a one-time
 * ticket), coloured from the tokens, reconnecting by itself, with the copy and paste keys a terminal has
 * elsewhere (2026-11-17, Josh: "I'm unable to click in and copy the text that I need"):
 *
 *   - Ctrl+C with text selected copies it (and clears the selection); with nothing selected it is the
 *     shell's interrupt, as it always was. Ctrl+Shift+C always copies. ⌘C on a Mac.
 *   - Ctrl+V and Ctrl+Shift+V paste this computer's clipboard into the shell (bracketed, as xterm does).
 *
 * The tools row (MachineTools.tsx) does the same by press, plus Copy all (the whole scrollback).
 */

import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onNight } from "@foundation/ui";
import { openSocket } from "../lib/api";
import { IS_MAC } from "../lib/keys";
import { clipKey, joinRows } from "./machineWords";

const TOKENS = {
  background: "--color-abyss",
  foreground: "--color-frost",
  cursor: "--color-pulse",
  selectionBackground: "--color-pulse",
  black: "--color-frost",
  brightBlack: "--color-dim",
  red: "--color-bad",
  brightRed: "--color-bad",
  green: "--color-ok",
  brightGreen: "--color-ok",
  yellow: "--color-warn",
  brightYellow: "--color-warn",
  blue: "--color-pulse",
  brightBlue: "--color-pulse",
  magenta: "--color-agent",
  brightMagenta: "--color-agent",
  cyan: "--color-moss",
  brightCyan: "--color-moss",
  white: "--color-mist",
  brightWhite: "--color-frost",
} as const;

/** each token resolved to a colour xterm can paint (night mixes and all), through one probe element */
export function themeFromTokens(el: HTMLElement): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(TOKENS)) {
    probe.style.color = k === "selectionBackground" ? `color-mix(in srgb, var(${v}) 28%, transparent)` : `var(${v})`;
    out[k] = getComputedStyle(probe).color;
  }
  probe.remove();
  out.cursorAccent = out.background;
  return out as ITheme;
}

/** puts text on this computer's clipboard; false when the browser won't (the caller says so) */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // an older webview, or no focus: the textarea way still works on a press
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** this computer's clipboard as text, or null when the browser won't say */
export async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** everything in a terminal's buffer, scrollback and screen */
export function bufferText(term: XTerm): string {
  const b = term.buffer.active;
  const rows: { text: string; wrapped: boolean }[] = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line) rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
  }
  return joinRows(rows);
}

export interface MachineTerminal {
  term: XTerm;
  /** the selection, or "" */
  selection(): string;
  /** the whole buffer */
  all(): string;
  /** sends text to the shell as a paste */
  paste(text: string): void;
  focus(): void;
  dispose(): void;
}

export interface TerminalHooks {
  boardId: string;
  panelId: string;
  canType: boolean;
  fontSize?: number;
  onNote: (note: string | null | ((n: string | null) => string | null)) => void;
  onPeople?: (people: string[]) => void;
  /** copied by a key (Ctrl+C on a selection, Ctrl+Shift+C): how many characters, or 0 when the browser refused */
  onCopied?: (chars: number) => void;
}

/** opens a machine's terminal in `node` and connects it; dispose() undoes all of it */
export function mountTerminal(node: HTMLElement, h: TerminalHooks): MachineTerminal {
  const font = getComputedStyle(node).getPropertyValue("--font-code").trim() || "monospace";
  const term = new XTerm({
    fontFamily: font,
    fontSize: h.fontSize ?? 12,
    lineHeight: 1.15,
    cursorBlink: h.canType,
    disableStdin: !h.canType,
    scrollback: 3000,
    theme: themeFromTokens(node),
    allowTransparency: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(node);

  // copy and paste keys, before xterm turns them into control characters
  term.attachCustomKeyEventHandler((e) => {
    const k = clipKey(e, term.hasSelection(), IS_MAC);
    if (k === "copy") {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) void copyText(sel).then((ok) => h.onCopied?.(ok ? sel.length : 0));
      term.clearSelection();
      return false;
    }
    // Ctrl+V / Ctrl+Shift+V: left to the browser, whose paste event xterm takes (bracketed)
    return k !== "paste";
  });

  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  let done = false; // the shell ended or the machine stopped: don't reconnect
  const sendSize = () => {
    if (h.canType && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
  };
  const refit = () => {
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    sendSize();
  };
  // a dropped socket (the server restarted, the network blinked) comes back on its own; the screen is replayed
  const connect = async () => {
    let s: WebSocket;
    try {
      s = await openSocket(`/machines/${encodeURIComponent(h.boardId)}/${encodeURIComponent(h.panelId)}/tty`);
    } catch {
      if (done || tries >= 6) return h.onNote((n) => n ?? "The terminal closed.");
      h.onNote("Reconnecting…");
      retry = setTimeout(connect, 600 * 2 ** tries++);
      return;
    }
    if (done) return void s.close();
    ws = s;
    s.binaryType = "arraybuffer";
    let fresh = true;
    s.onopen = () => {
      tries = 0;
      h.onNote(null);
      refit();
    };
    s.onmessage = (e) => {
      if (typeof e.data === "string") {
        const c = JSON.parse(e.data) as { t: string; text?: string; people?: string[] };
        if (c.t === "hello" || c.t === "people") h.onPeople?.(c.people ?? []);
        if (c.t === "exit" || c.t === "error") {
          done = true;
          h.onNote(c.text ?? "The terminal closed.");
        }
        return;
      }
      if (fresh) {
        term.reset(); // the server sends the whole screen first
        fresh = false;
      }
      term.write(new Uint8Array(e.data as ArrayBuffer));
    };
    s.onclose = () => {
      if (done || tries >= 6) return h.onNote((n) => n ?? "The terminal closed.");
      h.onNote("Reconnecting…");
      retry = setTimeout(connect, 600 * 2 ** tries++);
    };
  };
  void connect();
  const enc = new TextEncoder();
  const data = term.onData((d) => {
    if (h.canType && ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
  });
  let t: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(refit, 80);
  });
  ro.observe(node);
  const offNight = onNight(() => {
    // the tokens fade over 1.4 s: repaint at the midpoint and at the end
    setTimeout(() => (term.options.theme = themeFromTokens(node)), 700);
    setTimeout(() => (term.options.theme = themeFromTokens(node)), 1500);
  });
  return {
    term,
    selection: () => term.getSelection(),
    all: () => bufferText(term),
    paste: (text) => {
      if (h.canType) term.paste(text);
    },
    focus: () => term.focus(),
    dispose: () => {
      done = true; // a ticket still on its way opens nothing
      clearTimeout(t);
      clearTimeout(retry);
      ro.disconnect();
      offNight();
      data.dispose();
      // this socket is done: its late close mustn't say "closed" over the next one (StrictMode mounts twice)
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        ws.close();
      }
      term.dispose();
    },
  };
}

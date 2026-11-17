/**
 * The page inside a machine card's Desktop view (desktop.html): noVNC, drawing
 * the machine's screen and sending it the pointer and keys.
 *
 * It is a page of its own, in a same-origin frame, for one reason: noVNC
 * measures the pointer and its own size in unscaled pixels, and a card on the
 * board is drawn scaled (the camera's zoom × its section's fit). In a frame
 * the browser does that scaling, so a click lands where it was made at any
 * zoom, with nothing re-sent or corrected.
 *
 * It is told which machine by its address's fragment (#board=…&panel=…&view=1
 * for a viewer): ids only, never a session. It opens the machine's VNC socket
 * the way the terminal opens its own (lib/api openSocket: the cookie, or a
 * one-time ticket), and talks to the card with messages:
 *
 *   frame → card   { type: "foundation:desktop", panel, event }
 *       "connected" { w, h } | "closed" { reason, final } | "keys" { on } | "leave"
 *       "wheel" { dx, dy, mode, x, y }: a ⌘/Ctrl-wheel, which is the grid's zoom, never the machine's
 *       "clip" { text, copied }: the machine copied text (copied: it is on this computer's clipboard too)
 *   card → frame   { type: "foundation:desktop", cmd }
 *       "focus" | "blur" | "paint" { background } | "type" { text }
 *
 * Esc twice asks to leave (lib/keysHeld.ts); a single Esc is the machine's.
 *
 * Copy and paste (2026-11-17, Josh: "I'm unable to click in and copy the text that I need"): what the
 * machine copies (x11vnc sends its selection) goes to this computer's clipboard while the desktop has the
 * keys, and the card says so. Ctrl+V (and Ctrl+Shift+V, a Linux terminal's) hands this computer's clipboard
 * to the machine first, then the key, so the machine pastes what was copied here.
 */

import RFB from "@novnc/novnc/core/rfb.js";
import keysyms from "@novnc/novnc/core/input/keysymdef.js";
import { openSocket } from "../lib/api";
import { escEscToLeave } from "../lib/keysHeld";

const q = new URLSearchParams(window.location.hash.slice(1));
const board = q.get("board") ?? "";
const panel = q.get("panel") ?? "";
const viewOnly = q.get("view") === "1";
const screen = document.getElementById("screen")!;

const say = (event: string, more: Record<string, unknown> = {}) => window.parent.postMessage({ type: "foundation:desktop", panel, event, ...more }, window.location.origin);

let rfb: RFB | null = null;
let tries = 0;
let over = false; // the server said no (no desktop, stopped): don't knock again
let retry: ReturnType<typeof setTimeout> | undefined;

async function connect() {
  let ws: WebSocket;
  try {
    ws = await openSocket(`/machines/${encodeURIComponent(board)}/${encodeURIComponent(panel)}/vnc`);
  } catch {
    return again("Foundation's server isn't answering.");
  }
  let reason = "";
  let code = 0;
  ws.addEventListener("close", (e) => {
    reason = e.reason;
    code = e.code;
  });
  const r = new RFB(screen, ws, { shared: true });
  rfb = r;
  r.viewOnly = viewOnly;
  r.scaleViewport = true;
  r.resizeSession = false;
  r.focusOnClick = true;
  r.background = "transparent";
  r.addEventListener("connect", () => {
    tries = 0;
    everOpen = true;
    const c = screen.querySelector("canvas");
    say("connected", { w: c?.width ?? 0, h: c?.height ?? 0 });
  });
  r.addEventListener("clipboard", (e) => void fromMachine((e as CustomEvent<{ text: string }>).detail.text));
  r.addEventListener("disconnect", () => {
    if (rfb === r) rfb = null;
    // 4004: the server's refusal, in words (no desktop here, the machine stopped)
    if (code === 4004) {
      over = true;
      return say("closed", { reason: reason || "The desktop closed.", final: true });
    }
    again(reason || "The desktop's connection dropped.");
  });
}

let everOpen = false;

function again(reason: string) {
  if (over) return;
  // seven tries and never once open: the server isn't taking this socket at all (it isn't running, or it is a Foundation from before desktops)
  if (tries >= 6) return say("closed", { reason: everOpen ? reason : "Foundation's server didn't open the desktop's connection. It may not be running, or it may be older than this app: restart it, then try again.", final: true });
  say("closed", { reason: "Reconnecting…", final: false });
  retry = setTimeout(() => void connect(), 600 * 2 ** tries++);
}

// where the keys are: the card shows it, and Esc Esc gives them back
window.addEventListener("focus", () => say("keys", { on: true }));
// a press on the screen always gives it the keys, also when this page had the focus already and no focus
// event comes (the card was still in use from an earlier press: the click went in, the keys line never showed)
window.addEventListener(
  "pointerdown",
  () => {
    if (viewOnly) return;
    rfb?.focus();
    setTimeout(() => document.hasFocus() && say("keys", { on: true }), 0);
  },
  true,
);
window.addEventListener("blur", () => say("keys", { on: false }));
const leave = escEscToLeave(() => {
  rfb?.blur();
  say("leave");
});
window.addEventListener("keydown", (e) => void leave(e), true);

// ⌘/Ctrl-wheel is the grid's zoom wherever the pointer is (lib/cardUse.ts): caught before noVNC's canvas sees
// it, and handed to the card, which zooms the grid about the same point
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    say("wheel", { dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, x: e.clientX, y: e.clientY });
  },
  { capture: true, passive: false },
);

// what the machine copied: onto this computer's clipboard while the desktop has the keys (a browser lets a
// focused page write it), and to the card, which offers it again under Copy
let lastFromMachine = "";
async function fromMachine(text: string) {
  if (!text || text === lastFromMachine) return;
  lastFromMachine = text;
  let copied = false;
  if (document.hasFocus()) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      /* not allowed here: the card's Copy does it on a press */
    }
  }
  say("clip", { text, copied });
}

const XK_RETURN = 0xff0d;
const XK_TAB = 0xff09;
/** types text into whatever has the machine's focus, one key at a time (any app, a terminal included) */
function typeText(text: string) {
  if (!rfb || viewOnly) return;
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const cp = ch.codePointAt(0)!;
    const sym = ch === "\n" ? XK_RETURN : ch === "\t" ? XK_TAB : cp < 0x20 ? 0 : keysyms.lookup(cp);
    if (sym) rfb.sendKey(sym, null);
  }
}

// Ctrl+V: this computer's clipboard goes to the machine's first, then the V (the Ctrl is down there already)
window.addEventListener(
  "keydown",
  (e) => {
    if (!rfb || viewOnly || !(e.ctrlKey || e.metaKey) || e.altKey || e.code !== "KeyV" || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = rfb;
    void navigator.clipboard
      .readText()
      .then((t) => {
        if (t) {
          lastFromMachine = t; // the machine will echo it back: not news
          r.clipboardPasteFrom(t);
        }
      })
      .catch(() => {})
      .finally(() => {
        // a beat for the machine to take the new clipboard before the key asks for it
        setTimeout(() => r.sendKey(0x0076, "KeyV"), 60);
      });
  },
  true,
);

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || e.origin !== window.location.origin) return;
  const d = e.data as { type?: string; cmd?: string; background?: string; text?: string };
  if (d?.type !== "foundation:desktop") return;
  if (d.cmd === "focus") {
    window.focus();
    rfb?.focus();
  } else if (d.cmd === "blur") rfb?.blur();
  else if (d.cmd === "paint" && d.background) document.body.style.background = d.background;
  else if (d.cmd === "type" && d.text) {
    lastFromMachine = d.text;
    rfb?.clipboardPasteFrom(d.text);
    typeText(d.text);
    rfb?.focus();
  }
});

window.addEventListener("pagehide", () => {
  over = true;
  clearTimeout(retry);
  rfb?.disconnect();
});

if (board && panel) void connect();
else say("closed", { reason: "No machine was named.", final: true });

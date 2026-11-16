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
 *   card → frame   { type: "foundation:desktop", cmd }
 *       "focus" | "blur" | "paint" { background }
 *
 * Esc twice asks to leave (lib/keysHeld.ts); a single Esc is the machine's.
 */

import RFB from "@novnc/novnc/core/rfb.js";
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
    const c = screen.querySelector("canvas");
    say("connected", { w: c?.width ?? 0, h: c?.height ?? 0 });
  });
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

function again(reason: string) {
  if (over) return;
  if (tries >= 6) return say("closed", { reason, final: true });
  say("closed", { reason: "Reconnecting…", final: false });
  retry = setTimeout(() => void connect(), 600 * 2 ** tries++);
}

// where the keys are: the card shows it, and Esc Esc gives them back
window.addEventListener("focus", () => say("keys", { on: true }));
window.addEventListener("blur", () => say("keys", { on: false }));
const leave = escEscToLeave(() => {
  rfb?.blur();
  say("leave");
});
window.addEventListener("keydown", (e) => void leave(e), true);

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || e.origin !== window.location.origin) return;
  const d = e.data as { type?: string; cmd?: string; background?: string };
  if (d?.type !== "foundation:desktop") return;
  if (d.cmd === "focus") {
    window.focus();
    rfb?.focus();
  } else if (d.cmd === "blur") rfb?.blur();
  else if (d.cmd === "paint" && d.background) document.body.style.background = d.background;
});

window.addEventListener("pagehide", () => {
  over = true;
  clearTimeout(retry);
  rfb?.disconnect();
});

if (board && panel) void connect();
else say("closed", { reason: "No machine was named.", final: true });

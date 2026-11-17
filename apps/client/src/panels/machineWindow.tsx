/**
 * A machine in a window of its own (machine.html; 2026-11-17, Josh: "the ability to full-screen the vm into
 * another tab for direct control without foundation ui shortcuts interfering with it").
 *
 * Opened from the tools row's ⧉ (MachineTools.tsx): a new tab in a browser, a window of the desktop app's
 * own there. Nothing of Foundation's is on this page but a slim head (the machine's name, the Terminal ·
 * Desktop switch, where the keys go) and the same tools row as the card's, so every key is the machine's:
 * there are no app shortcuts here to stand down, no grid to pan, and Esc is the machine's. Full screen
 * (the row's ⛶, or F11) also locks the keyboard where the browser can (Chromium's Keyboard Lock), so keys a
 * browser would keep for itself reach the machine too; holding Esc leaves full screen.
 *
 * Told which machine by its address's fragment, as the desktop's frame is: #board=…&panel=…&show=terminal|
 * desktop&name=…(&view=1 for a viewer). Ids only, never a session: it signs in as the app's page does (the
 * cookie, or the bearer this origin keeps), and the server holds a viewer to watching.
 */

import "@foundation/ui/tokens.css";
import "@xterm/xterm/css/xterm.css";
import "../App.css";
import "./live.css";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initNight } from "@foundation/ui";
import { DesktopScreen, ViewSwitch, type MachineViewName } from "./MachineViewDesktop";
import { MachineTools, pastedWords, copiedWords, useFlash } from "./MachineTools";
import { copyText, mountTerminal, readClipboard, type MachineTerminal } from "./machineTerminal";
import { DesktopGlyph, TerminalGlyph } from "../shell/glyphs";

initNight();

const q = new URLSearchParams(window.location.hash.slice(1));
const board = q.get("board") ?? "";
const panel = q.get("panel") ?? "";
const name = q.get("name") || "Machine";
const viewer = q.get("view") === "1";
const first: MachineViewName = q.get("show") === "desktop" ? "desktop" : "terminal";

/** the window's own full screen, with the keyboard locked to the page where the browser can */
async function full() {
  if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    await (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.();
  } catch {
    /* refused: the window stays as it is */
  }
}

function WindowTerminal() {
  const el = useRef<HTMLDivElement>(null);
  const mt = useRef<MachineTerminal | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  const [hasSel, setHasSel] = useState(false);
  const [flash, say] = useFlash();
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const t = mountTerminal(node, {
      boardId: board,
      panelId: panel,
      canType: !viewer,
      fontSize: 13.5,
      onNote: setNote,
      onPeople: setPeople,
      onCopied: (n) => say(n ? `Copied ${n} character${n === 1 ? "" : "s"}` : "Your browser didn't allow the copy", n ? "ok" : "warn"),
    });
    mt.current = t;
    const sel = t.term.onSelectionChange(() => setHasSel(t.term.hasSelection()));
    t.focus();
    return () => {
      sel.dispose();
      mt.current = null;
      t.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const copy = async (text: string) => {
    if (!text) return say("Nothing to copy yet", "warn");
    say((await copyText(text)) ? copiedWords(text) : "Your browser didn't allow the copy", "ok");
  };
  const paste = async () => {
    const text = await readClipboard();
    if (text === null) return say("Your browser didn't let Foundation read the clipboard: press Ctrl+V in the terminal", "warn");
    if (!text) return say("Your clipboard is empty", "warn");
    mt.current?.paste(text);
    mt.current?.focus();
    say(pastedWords(text));
  };
  return (
    <>
      <div className="machine-term-wrap is-alone">
        <div ref={el} className="machine-term" />
        {viewer && <div className="machine-watching">View only: you're watching</div>}
        {people.length > 1 && (
          <div className="machine-people" data-tip={people.join(", ")}>
            {people.length} here
          </div>
        )}
        {note && <div className="machine-closed">{note}</div>}
      </div>
      <MachineTools view="terminal" canType={!viewer} canCopy={hasSel} flash={flash} onCopy={() => void copy(mt.current?.selection() ?? "")} onCopyAll={() => void copy(mt.current?.all() ?? "")} onPaste={() => void paste()} onFull={() => void full()} />
    </>
  );
}

function MachineWindow() {
  const [view, setView] = useState<MachineViewName>(first);
  useEffect(() => {
    document.title = `${name} · ${view === "desktop" ? "Desktop" : "Terminal"} · Foundation`;
  }, [view]);
  if (!board || !panel)
    return (
      <div className="machine-window">
        <div className="machine-window-none">No machine was named.</div>
      </div>
    );
  return (
    <div className="machine-window">
      <header className="machine-window-head">
        <span className="machine-window-glyph">{view === "desktop" ? <DesktopGlyph /> : <TerminalGlyph />}</span>
        <strong className="machine-window-name">{name}</strong>
        <ViewSwitch view={view} onView={setView} only={["terminal", "desktop"]} />
        <span className="machine-window-keys">{viewer ? "View only: you're watching" : "Every key goes to the machine here · Foundation's shortcuts are off"}</span>
      </header>
      <div className="machine-body machine-window-body is-running">
        {view === "desktop" ? <DesktopScreen key="d" panelId={panel} name={name} viewer={viewer} board={board} alone onKeys={() => {}} onFull={() => void full()} /> : <WindowTerminal key="t" />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <MachineWindow />
  </StrictMode>,
);

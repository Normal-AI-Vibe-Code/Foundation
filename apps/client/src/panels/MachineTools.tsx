/**
 * A machine's tools, the same row under its terminal and under its desktop (2026-11-17, Josh: "quality of
 * life terminal tools for copying out text that are standardized, and the ability to full-screen the vm into
 * another tab for direct control without foundation ui shortcuts interfering with it").
 *
 *   Copy        the terminal's selection; the desktop's last copied text (what the machine copied)
 *   Copy all    the terminal's whole scrollback (the terminal only)
 *   Paste       this computer's clipboard into the shell; on the desktop, typed where the machine's cursor is
 *   Own window  the machine alone in a window (a tab, in a browser) of its own: every key is the machine's
 *
 * Each is a 28 px round icon button with its name on roll-over; what a press did is said for a moment beside
 * them ("Copied 3 lines"). The same row, with the same words, is drawn in the window of its own.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopyAllGlyph, CopyGlyph, FullGlyph, PasteGlyph, PopOutGlyph } from "../shell/glyphs";

export type MachineToolsView = "terminal" | "desktop";

/** the desktop app (Tauri), not a browser tab */
const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const amount = (text: string) => {
  const lines = text.split("\n").length;
  return lines > 1 ? `${lines} lines` : `${text.length} character${text.length === 1 ? "" : "s"}`;
};
/** "Copied 3 lines" / "Copied 42 characters": what went onto the clipboard, in a few words */
export const copiedWords = (text: string) => `Copied ${amount(text)}`;
/** "Pasted 3 lines" */
export const pastedWords = (text: string) => `Pasted ${amount(text)}`;

/** a word that shows for a moment after a press, then goes */
export function useFlash(ms = 1800): [{ text: string; tone: "ok" | "warn" } | null, (text: string, tone?: "ok" | "warn") => void] {
  const [flash, setFlash] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return [
    flash,
    (text, tone = "ok") => {
      setFlash({ text, tone });
      clearTimeout(t.current);
      t.current = setTimeout(() => setFlash(null), tone === "warn" ? ms * 2 : ms);
    },
  ];
}

/** the address of a machine's window of its own */
export function machineWindowUrl(board: string, panel: string, view: MachineToolsView, viewer: boolean, name = ""): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}machine.html`;
  return `${base}#board=${encodeURIComponent(board)}&panel=${encodeURIComponent(panel)}&show=${view}${viewer ? "&view=1" : ""}${name ? `&name=${encodeURIComponent(name)}` : ""}`;
}

/**
 * Opens the machine in a window of its own: a new tab in a browser, a window of the desktop app's own there
 * (named for the machine, so a second press brings the same one forward).
 */
export async function openMachineWindow(board: string, panel: string, view: MachineToolsView, name: string, viewer: boolean): Promise<void> {
  const url = machineWindowUrl(board, panel, view, viewer, name);
  const label = `machine-${panel}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (inDesktop) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const open = await WebviewWindow.getByLabel(label);
      if (open) {
        await open.unminimize().catch(() => {});
        await open.setFocus();
        return;
      }
      const w = new WebviewWindow(label, { url, title: `${name} · Foundation`, width: 1320, height: 860, center: true, focus: true });
      await new Promise<void>((ok, bad) => {
        void w.once("tauri://created", () => ok());
        void w.once("tauri://error", (e) => bad(new Error(String(e.payload))));
      });
      return;
    } catch {
      /* an app from before windows of their own: the browser's way, below */
    }
  }
  window.open(url, label);
}

export interface MachineToolsProps {
  view: MachineToolsView;
  canType: boolean;
  /** whether Copy has anything to take (a selection, something the machine copied); greyed if not */
  canCopy: boolean;
  onCopy: () => void;
  onCopyAll?: () => void;
  onPaste?: () => void;
  /** a window of its own; absent in that window */
  onPopOut?: () => void;
  /** that window's own full screen */
  onFull?: () => void;
  flash?: { text: string; tone: "ok" | "warn" } | null;
  /** between the words and the window button: the agents' leave, the keys line */
  children?: ReactNode;
}

function Tool({ tip, onPress, disabled, children, name }: { tip: string; onPress?: () => void; disabled?: boolean; children: ReactNode; name: string }) {
  return (
    <button
      type="button"
      className="machine-tool"
      data-tip={tip}
      aria-label={tip.split(" · ")[0]}
      data-machine-tool={name}
      disabled={disabled}
      // a press mustn't take the keys from the machine, or start a drag on the grid
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

/** the row of a machine's tools. Also drawn on #/design. */
export function MachineTools({ view, canType, canCopy, onCopy, onCopyAll, onPaste, onPopOut, onFull, flash, children }: MachineToolsProps) {
  const term = view === "terminal";
  return (
    <div className="machine-tools" role="toolbar" aria-label={term ? "Terminal tools" : "Desktop tools"}>
      <span className="machine-tools-group">
        <Tool name="copy" tip={term ? "Copy the selection · Ctrl+C with text selected, or Ctrl+Shift+C" : "Copy what the machine copied last · it reaches your clipboard by itself while the desktop has the keys"} disabled={!canCopy} onPress={onCopy}>
          <CopyGlyph />
        </Tool>
        {term && (
          <Tool name="copy-all" tip="Copy everything in the terminal, its scrollback too" onPress={onCopyAll}>
            <CopyAllGlyph />
          </Tool>
        )}
        {canType && (
          <Tool name="paste" tip={term ? "Paste your clipboard into the shell · Ctrl+V" : "Type your clipboard where the machine's cursor is · Ctrl+V pastes it too"} onPress={onPaste}>
            <PasteGlyph />
          </Tool>
        )}
      </span>
      <span className={`machine-tools-said${flash ? ` is-${flash.tone}` : ""}`} aria-live="polite">
        {flash?.text ?? ""}
      </span>
      {children}
      {(onPopOut || onFull) && (
        <span className="machine-tools-group">
          {onFull && (
            <Tool name="full" tip="Full screen · Esc comes back" onPress={onFull}>
              <FullGlyph />
            </Tool>
          )}
          {onPopOut && (
            <Tool name="window" tip={`Open in a ${inDesktop ? "window" : "tab"} of its own · every key goes to the machine there, none to Foundation`} onPress={onPopOut}>
              <PopOutGlyph />
            </Tool>
          )}
        </span>
      )}
    </div>
  );
}

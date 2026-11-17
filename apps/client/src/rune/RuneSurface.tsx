/**
 * Rune's canvas in the grid's viewport, and the mark that says the board is
 * drawn by it. The canvas sits over the WebGL paper and under the web layers
 * that aren't Rune's yet (wires, cursors, the chrome): see parity.ts.
 */

import { useEffect, useRef } from "react";
import { floorInsets, toast, useUi } from "../state/ui";
import { parityCounts } from "./parity";
import { mountRune, setRuneHost, type RuneHost } from "./host";
import { useEngine, useRuneStatus } from "./engine";
import "./rune.css";

/** the canvas Rune draws on; it restyles it to cover the viewport, and gives it back when it goes */
export function RuneSurface() {
  const ref = useRef<HTMLCanvasElement>(null);
  const host = useRef<RuneHost | null>(null);
  const ui = useUi();
  const f = floorInsets(ui);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Rune's canvas can't be see-through on the web yet (its WebGPU surface is opaque), so it paints the paper
    const h = mountRune(canvas, { transparent: false });
    host.current = h;
    setRuneHost(h);
    return () => {
      host.current = null;
      setRuneHost(null);
      h.dispose();
    };
  }, []);

  // the floor's panes and my role aren't the store's: say when they change
  useEffect(() => host.current?.refresh(), [f.left, f.top, f.right, ui.role]);

  return <canvas ref={ref} id="foundation-rune" className="rune-canvas" aria-label="The board, drawn by Rune" />;
}

/**
 * The mark in the bottom bar: this board is drawn by Rune. Quiet while it
 * works; amber when Rune was asked for and couldn't run (the web renderer is
 * drawing, and the label says why). A press opens Settings → Renderer.
 */
export function RuneMark() {
  const engine = useEngine();
  const status = useRuneStatus();
  // falling back is said once, where it happens
  const told = useRef("");
  useEffect(() => {
    if (status.state === "failed" && status.reason && told.current !== status.reason) {
      told.current = status.reason;
      toast(`Rune couldn't draw this board: the web renderer is. ${status.reason}`, "warn");
    }
  }, [status.state, status.reason]);
  if (engine !== "rune") return null;
  const failed = status.state === "failed";
  const n = parityCounts();
  const tip = failed
    ? `Rune couldn't run here, so the web renderer is drawing. ${status.reason ?? ""}`
    : status.state === "ready"
      ? `This board is drawn by Rune (experimental): ${n.same} parts match the web renderer, ${n.partial + n.missing} don't yet. Press for the list`
      : "Starting the Rune renderer…";
  return (
    // a button, like everything in the bottom bar: the grid takes a press on anything else there for a pan
    <button className={`rune-mark f-glass is-${status.state}`} onClick={() => (window.location.hash = "#/settings/renderer")} data-tip={tip} aria-label={tip}>
      <span className="rune-mark-dot" />
      <span className="rune-mark-word">{failed ? "Rune off" : "Rune"}</span>
    </button>
  );
}

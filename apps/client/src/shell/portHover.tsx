/**
 * The port under the pointer (2026-11-15). There is no "agent layer" to switch on any more: a card's
 * connections show when you point at one of its inputs or outputs. The port says what it is, what is
 * on it right now, and where it goes to (or comes from), card by card; its wires light up across the
 * grid while you look (AgentLayer.tsx reads this).
 */

import { useSyncExternalStore } from "react";
import { getState, inputValue, subscribe, type PanelMeta } from "../state/store";
import type { Port } from "@foundation/protocol";
import { toneOf } from "./ports";

export interface PortRef {
  panel: string;
  port: string;
}

let hover: PortRef | null = null;
const subs = new Set<() => void>();

export function setPortHover(next: PortRef | null) {
  if (hover?.panel === next?.panel && hover?.port === next?.port) return;
  hover = next;
  subs.forEach((f) => f());
}
export const portHover = () => hover;
export function usePortHover(): PortRef | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => hover,
  );
}

/** the pointer handlers a port wears */
export const portHoverProps = (panel: string, port: string) => ({
  onPointerEnter: () => setPortHover({ panel, port }),
  onPointerLeave: () => hover?.panel === panel && hover.port === port && setPortHover(null),
});

/** a value, said in full enough to judge: text as it is, anything else as JSON, cut at 240 characters */
export function sayValue(v: unknown): string {
  if (v === undefined) return "nothing on it yet";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1).replace(/\s*\n\s*/g, " ");
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

const linksOf = () => getState().links;
const panelsOf = () => getState().panels;

/**
 * What a port's label says: its name and type, what's on it now, and each card it's wired to. The
 * wiring is listed only while this port is the one under the pointer (it is the crucial part, and the
 * only part that needs the whole grid's links).
 */
export function PortLabel({ panel, port, hint }: { panel: PanelMeta; port: Port; hint: string }) {
  const on = usePortHover();
  const mine = on?.panel === panel.id && on.port === port.id;
  const value = port.dir === "out" ? panel.outputs?.[port.id] : inputValue(panel.id, port.id);
  return (
    <span className={`port-label${mine ? " is-open" : ""}`}>
      <span className="port-label-head">
        <b>{port.name}</b>
        <i>{port.type ?? "json"}</i>
        <span className="port-dir">{port.dir === "out" ? "output" : "input"}</span>
      </span>
      <span className="port-value">{sayValue(value)}</span>
      {mine && <PortLinks panel={panel.id} port={port} />}
      <span className="port-hint">{hint}</span>
    </span>
  );
}

function PortLinks({ panel, port }: { panel: string; port: Port }) {
  const links = useSyncExternalStore(subscribe, linksOf);
  const panels = useSyncExternalStore(subscribe, panelsOf);
  const out = port.dir === "out";
  const mine = Object.values(links).filter((l) => (out ? l.from.panel === panel && l.from.port === port.id : l.to.panel === panel && l.to.port === port.id));
  if (!mine.length) return <span className="port-link is-none">{out ? "Not wired to anything: nothing receives it" : "Nothing is wired into it"}</span>;
  return (
    <>
      {mine.map((l) => {
        const end = out ? l.to : l.from;
        const other = panels[end.panel];
        const p = other?.ports.find((x) => x.id === end.port);
        return (
          <span key={l.id} className="port-link" style={{ ["--wire-tone" as string]: toneOf(p?.type ?? port.type) }}>
            <span className="port-link-arrow">{out ? "→" : "←"}</span>
            <b>{other?.name ?? "a card that's gone"}</b>
            <span>
              {out ? "into its" : "from its"} {p?.name ?? end.port}
            </span>
            {l.label && <em>{l.label}</em>}
          </span>
        );
      })}
    </>
  );
}

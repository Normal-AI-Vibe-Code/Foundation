/**
 * The port under the pointer (2026-11-15). There is no "agent layer" to switch on any more: a card's
 * connections show when you point at one of its inputs or outputs. The port says what it is, what is
 * on it right now, and where it goes to (or comes from), card by card; its wires light up across the
 * grid while you look (AgentLayer.tsx reads this).
 */

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getState, inputValue, subscribe, type PanelMeta } from "../state/store";
import type { Port } from "@foundation/protocol";
import { toneOf } from "./ports";
import { peek, ValueSample } from "./flowPeek";

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
 * What a port's label says: its name and type, a sample of what's on it now, and each card it's wired to.
 * It opens on the page's top layer (2026-11-24, Josh: "some of the interconnection node roll-overs don't come
 * to the forefront"): drawn inside its card it sat under the next card along, the next section, the wires and
 * a hosted app's frame, and a card's clipping cut it off. It's portalled to the body instead, placed beside
 * its port each frame while it's open (the camera can move under it), at a constant size on screen.
 */
export function PortLabel({ panel, port, hint }: { panel: PanelMeta; port: Port; hint: string }) {
  const on = usePortHover();
  const mine = on?.panel === panel.id && on.port === port.id;
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <span ref={anchor} className="port-label-anchor" aria-hidden>
      {mine && createPortal(<PortCard anchor={anchor} panel={panel} port={port} hint={hint} />, document.body)}
    </span>
  );
}

const GAP = 12;

function PortCard({ anchor, panel, port, hint }: { anchor: React.RefObject<HTMLSpanElement | null>; panel: PanelMeta; port: Port; hint: string }) {
  const card = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState(false);
  const value = port.dir === "out" ? panel.outputs?.[port.id] : inputValue(panel.id, port.id);
  useLayoutEffect(() => {
    let raf = 0;
    let last = "";
    const place = () => {
      const el = card.current;
      const at = anchor.current?.parentElement; // the port pill
      if (el && at) {
        const r = at.getBoundingClientRect();
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        // inputs open to the left of the pill, outputs to the right; flipped when that runs off the window
        let x = port.dir === "out" ? r.right + GAP : r.left - GAP - w;
        if (x + w > innerWidth - 8) x = r.left - GAP - w;
        if (x < 8) x = Math.min(r.right + GAP, innerWidth - 8 - w);
        const y = Math.max(8, Math.min(innerHeight - 8 - h, r.top + r.height / 2 - h / 2));
        const key = `${Math.round(x)},${Math.round(y)}`;
        if (key !== last) {
          last = key;
          el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        }
        if (!placed) setPlaced(true);
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [anchor, port.dir, placed]);
  return (
    <div ref={card} className={`port-card${placed ? " is-placed" : ""}`} data-port-card={`${panel.id}:${port.id}`} style={{ ["--wire-tone" as string]: toneOf(port.type) }} role="tooltip">
      <span className="port-label-head">
        <b>{port.name}</b>
        <i>{port.type ?? "json"}</i>
        <span className="port-dir">{port.dir === "out" ? "output" : "input"}</span>
        <span className="port-peek">{peek(value)}</span>
      </span>
      <ValueSample value={value} />
      <PortLinks panel={panel.id} port={port} />
      <span className="port-hint">{hint}</span>
    </div>
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
      <span className="port-link is-none">press its wire to see what flows, or to disconnect it</span>
    </>
  );
}

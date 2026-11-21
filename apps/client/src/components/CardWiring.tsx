/**
 * A card's inputs and outputs, in full (2026-11-18: the card menu's "Inputs and outputs…", opened in the
 * right pane by shell/DetailPane.tsx). A port's roll-over label says the same things in four lines; this is
 * the whole of it, and it stays open while you work: each input and each output with its type, what is on
 * it now (text as it is, anything else as indented JSON, as long as it is), and every card it is wired to,
 * each a press that frames that card.
 *
 * Live: it reads the store, so a value that changes on the grid changes here.
 */

import { useSyncExternalStore } from "react";
import type { Port } from "@foundation/protocol";
import { getState, inputValue, isPanel, requestSnap, subscribe, type AnyObject, type PanelMeta } from "../state/store";
import { toneOf } from "../shell/ports";

const stateOf = () => getState();

function say(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function Wired({ arrow, name, what, to, tone }: { arrow: string; name: string; what: string; to?: string; tone?: string }) {
  return (
    <button type="button" className="wiring-link" disabled={!to} onClick={() => to && requestSnap({ kind: "object", id: to })} style={{ ["--wire-tone" as string]: tone } as React.CSSProperties}>
      <span className="wiring-arrow">{arrow}</span>
      <b>{name}</b>
      <span>{what}</span>
    </button>
  );
}

function PortRow({ panel, port }: { panel: PanelMeta; port: Port }) {
  const st = useSyncExternalStore(subscribe, stateOf);
  const out = port.dir === "out";
  const value = out ? panel.outputs?.[port.id] : inputValue(panel.id, port.id);
  const text = say(value);
  const links = Object.values(st.links).filter((l) => (out ? l.from.panel === panel.id && l.from.port === port.id : l.to.panel === panel.id && l.to.port === port.id));
  return (
    <li className="wiring-port" data-wiring-port={port.id}>
      <div className="wiring-port-head">
        <i className="wiring-bead" style={{ background: toneOf(port.type) }} />
        <b>{port.name}</b>
        <code style={{ color: toneOf(port.type) }}>{port.type ?? "json"}</code>
      </div>
      {text ? <pre className="detail-code is-small wiring-value">{text}</pre> : <p className="wiring-none">Nothing on it yet.</p>}
      {links.length === 0 ? (
        <p className="wiring-none">{out ? "Not wired to anything: nothing receives it." : "Nothing is wired into it."}</p>
      ) : (
        links.map((l) => {
          const end = out ? l.to : l.from;
          const other = st.panels[end.panel];
          const p = other?.ports.find((x) => x.id === end.port);
          return <Wired key={l.id} arrow={out ? "→" : "←"} name={other?.name ?? "a card that's gone"} what={`${out ? "into its" : "from its"} ${p?.name ?? end.port}${l.label ? ` · ${l.label}` : ""}`} to={other?.id} tone={toneOf(p?.type ?? port.type)} />;
        })
      )}
    </li>
  );
}

export function CardWiring({ id }: { id: string }) {
  const st = useSyncExternalStore(subscribe, stateOf);
  const o = ((st.panels as Record<string, AnyObject | undefined>)[id] ?? st.tables[id] ?? st.maps[id] ?? st.notes[id] ?? st.media[id]) as AnyObject | undefined;
  if (!o) return <p className="wiring-none">This card is gone.</p>;
  if (isPanel(o)) {
    const ins = o.ports.filter((p) => p.dir === "in");
    const outs = o.ports.filter((p) => p.dir === "out");
    return (
      <div className="wiring" data-wiring={id}>
        {(["in", "out"] as const).map((dir) => {
          const list = dir === "in" ? ins : outs;
          return (
            <section key={dir}>
              <div className="pane-eyebrow">
                {dir === "in" ? "Inputs" : "Outputs"} <span className="tool-count">{list.length}</span>
              </div>
              {list.length === 0 ? <p className="wiring-none">{dir === "in" ? "It takes nothing in." : "It sends nothing out."}</p> : <ul className="wiring-ports">{list.map((p) => <PortRow key={p.id} panel={o} port={p} />)}</ul>}
            </section>
          );
        })}
      </div>
    );
  }
  // the sheet's own flow: a map reads a table's rows
  if ("sourceTableId" in o) {
    const src = o.sourceTableId ? st.tables[o.sourceTableId] : null;
    return (
      <div className="wiring" data-wiring={id}>
        <section>
          <div className="pane-eyebrow">Inputs</div>
          {src ? <Wired arrow="←" name={src.name} what={`its ${src.rows} rows, as places`} to={src.id} /> : <p className="wiring-none">No table is wired into it: its map is empty.</p>}
        </section>
        <section>
          <div className="pane-eyebrow">Outputs</div>
          <p className="wiring-none">It sends nothing out.</p>
        </section>
      </div>
    );
  }
  if ("cols" in o) {
    const maps = Object.values(st.maps).filter((m) => m.sourceTableId === o.id);
    return (
      <div className="wiring" data-wiring={id}>
        <section>
          <div className="pane-eyebrow">Inputs</div>
          <p className="wiring-none">What is typed into it, and what its formulas read from other tables.</p>
        </section>
        <section>
          <div className="pane-eyebrow">
            Outputs <span className="tool-count">{maps.length}</span>
          </div>
          {maps.length === 0 ? <p className="wiring-none">Nothing reads its rows yet. Add a map beside it and it draws them.</p> : maps.map((m) => <Wired key={m.id} arrow="→" name={m.name} what={`reads its ${o.rows} rows`} to={m.id} />)}
        </section>
      </div>
    );
  }
  return <p className="wiring-none">Nothing goes in or out of this card.</p>;
}

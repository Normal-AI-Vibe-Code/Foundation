/**
 * A machine card's pipes, said plainly (Josh, 2026-11-15: "piping information
 * into a VM and being clear about its outputs that I can pipe into another
 * application").
 *
 *   In  ← <what's wired in> · <the value, cut short> · when      /foundation/in
 *   Out → <where it goes>   · <the value>            · when      /foundation/out
 *
 * with one line on how to use the two files from the shell. The server writes
 * what arrives on `in` to /foundation/in and reads /foundation/out back onto
 * `out` (machineio.ts); this strip shows both ends and lets a person wire
 * them without leaving the card: an app's port, a note (its text) or a table
 * (its rows). Wires between cards are also dragged on the agent layer, port
 * to port; a note's or a table's wire is listed here (the wire layer draws
 * card-to-card wires only).
 */

import { ErrorCard } from "../components/ErrorCard";
import { useState, useSyncExternalStore } from "react";
import { MACHINE_IN_PATH, MACHINE_IN_PORT, MACHINE_OUT_PATH, MACHINE_OUT_PORT, NOTE_PORT, TABLE_PORT, type LinkDoc, type MachineIo } from "@foundation/protocol";
import { addLink, addNote, addSectionAdjacent, getState, removeLink, subscribe, type PanelMeta } from "../state/store";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { toast } from "../state/ui";
import { ago, useNow } from "./MachineViewBits";
import { Functions } from "./MachineFunctions";
import { InGlyph, OutGlyph } from "../shell/glyphs";

interface End {
  /** the wire */
  link: string;
  /** "Note “Input”", "Chart · data" */
  name: string;
}
interface Choice {
  value: string; // "<object id>|<port>"
  label: string;
}

/** a wire's other end, as a person would say it */
function endName(end: LinkDoc["from"]): string {
  const st = getState();
  const p = st.panels[end.panel];
  if (p) {
    const port = p.ports.find((x) => x.id === end.port);
    return port ? `${p.name} · ${port.name}` : p.name;
  }
  const n = st.notes[end.panel];
  if (n) return `Note “${n.name}”`;
  const t = st.tables[end.panel];
  if (t) return end.port === TABLE_PORT ? `Table “${t.name}”` : `Table “${t.name}” · ${end.port}`;
  return "a card that's gone";
}

/** what could be wired to a machine's in (things that give a value) or out (things that take one) */
function choices(self: string, dir: "in" | "out"): Choice[] {
  const st = getState();
  const out: Choice[] = [];
  for (const n of Object.values(st.notes)) out.push({ value: `${n.id}|${NOTE_PORT}`, label: `Note “${n.name}”` });
  for (const t of Object.values(st.tables)) out.push({ value: `${t.id}|${TABLE_PORT}`, label: `Table “${t.name}”` });
  for (const p of Object.values(st.panels)) {
    if (p.id === self) continue;
    for (const port of p.ports) if (port.dir === (dir === "in" ? "out" : "in")) out.push({ value: `${p.id}|${port.id}`, label: `${p.name} · ${port.name}` });
  }
  return out.slice(0, 60);
}

export function IoStrip({ panel, viewer }: { panel: PanelMeta; viewer: boolean }) {
  const links = useSyncExternalStore(subscribe, () => getState().links);
  // names of notes and tables can change under a wire: read them fresh while the strip is drawn
  useSyncExternalStore(subscribe, () => getState().notes);
  const io = panel.machine?.io;
  const now = useNow(Boolean(io?.inAt || io?.outAt), 5000);
  const inPort = panel.ports.find((p) => p.dir === "in" && p.name === MACHINE_IN_PORT);
  const outPort = panel.ports.find((p) => p.dir === "out" && p.name === MACHINE_OUT_PORT);
  if (!inPort || !outPort) return null; // the server gives a running machine its ports the first time it's seen
  const all = Object.values(links);
  const ins: End[] = all.filter((l) => l.to.panel === panel.id && l.to.port === inPort.id).map((l) => ({ link: l.id, name: endName(l.from) }));
  const outs: End[] = all.filter((l) => l.from.panel === panel.id && l.from.port === outPort.id).map((l) => ({ link: l.id, name: endName(l.to) }));
  const wire = (dir: "in" | "out", value: string) => {
    const [id, port] = value.split("|");
    if (!id || !port) return;
    if (dir === "in") {
      // one source feeds a machine: a new one takes the old one's place
      for (const e of ins) removeLink(e.link);
      addLink({ from: { panel: id, port }, to: { panel: panel.id, port: inPort.id }, label: "in" });
    } else if (!all.some((l) => l.from.panel === panel.id && l.from.port === outPort.id && l.to.panel === id && l.to.port === port)) {
      addLink({ from: { panel: panel.id, port: outPort.id }, to: { panel: id, port }, label: "out" });
    }
  };
  return (
    <IoLines
      ins={ins}
      outs={outs}
      io={io}
      now={now}
      viewer={viewer}
      inChoices={viewer ? [] : choices(panel.id, "in")}
      outChoices={viewer ? [] : choices(panel.id, "out")}
      onWire={wire}
      onUnwire={removeLink}
    />
  );
}

/** the strip itself, from plain values. Also drawn on #/design. */
export function IoLines({
  ins,
  outs,
  io,
  now,
  viewer,
  inChoices = [],
  outChoices = [],
  onWire,
  onUnwire,
}: {
  ins: End[];
  outs: End[];
  io?: MachineIo;
  now: number;
  viewer: boolean;
  inChoices?: Choice[];
  outChoices?: Choice[];
  onWire?: (dir: "in" | "out", value: string) => void;
  onUnwire?: (link: string) => void;
}) {
  const ends = (list: End[], none: string) =>
    list.length ? (
      list.map((e) => (
        <span key={e.link} className="machine-io-end">
          {e.name}
          {!viewer && (
            <button className="machine-io-x" aria-label={`Unwire ${e.name}`} data-tip="Take this wire off" onClick={() => onUnwire?.(e.link)}>
              ×
            </button>
          )}
        </span>
      ))
    ) : (
      <span className="machine-io-none">{none}</span>
    );
  const pick = (dir: "in" | "out", list: Choice[], label: string) =>
    !viewer &&
    list.length > 0 && (
      <select
        className="machine-io-pick"
        value=""
        aria-label={label}
        onChange={(e) => onWire?.(dir, e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <option value="">{label}</option>
        {list.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  return (
    <div className="machine-io">
      <div className="machine-io-row">
        <span className="machine-io-dir">In ←</span>
        <span className="machine-io-ends">
          {ends(ins, "nothing wired")}
          {pick("in", inChoices, ins.length ? "Change…" : "Wire…")}
        </span>
        <span className={`machine-io-value${io?.inAt ? "" : " is-none"}`} data-tip={io?.inPreview}>
          {io?.inAt ? io.inPreview || "(empty)" : ins.length ? "waiting for a value" : ""}
        </span>
        {io?.inAt && <span className="machine-io-when">{ago(io.inAt, now)}</span>}
        <code className="machine-io-path">{MACHINE_IN_PATH}</code>
      </div>
      <div className="machine-io-row">
        <span className="machine-io-dir">Out →</span>
        <span className="machine-io-ends">
          {ends(outs, "nowhere yet")}
          {pick("out", outChoices, outs.length ? "And…" : "Wire…")}
        </span>
        <span className={`machine-io-value${io?.outAt ? "" : " is-none"}`} data-tip={io?.outPreview}>
          {io?.outAt ? io.outPreview || "(empty)" : "nothing written yet"}
        </span>
        {io?.outAt && <span className="machine-io-when">{ago(io.outAt, now)}</span>}
        <code className="machine-io-path">{MACHINE_OUT_PATH}</code>
      </div>
      {io?.error ? (
        <ErrorCard message={io.error} />
      ) : (
        <div className="machine-io-hint">
          In the shell, read what's wired in and write what goes on: <code>tr a-z A-Z &lt;{MACHINE_IN_PATH} &gt;{MACHINE_OUT_PATH}</code>
        </div>
      )}
    </div>
  );
}

/**
 * The card's Ins & outs, a tab of its head beside Terminal and Desktop (2026-11-17, Josh: "the ins and outs should be
 * another top level menu option … I don't see anything coming out"). The two lines, larger, with what came out last in
 * full, what it is (text, or JSON when it parses: the machine decides by what it writes, not a label), and two presses:
 * send Out to a new note in the section to the right (made when there isn't one), and have the machine write a test line.
 */
export function IoView({ panel, viewer }: { panel: PanelMeta; viewer: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const io = panel.machine?.io;
  const outPort = panel.ports.find((p) => p.dir === "out" && p.name === MACHINE_OUT_PORT);
  const links = useSyncExternalStore(subscribe, () => getState().links);
  const outs = outPort ? Object.values(links).filter((l) => l.from.panel === panel.id && l.from.port === outPort.id) : [];
  const kind = io?.outAt ? (looksJson(io.outPreview) ? "JSON" : "text") : null;
  const toTheRight = () => {
    if (!outPort) return;
    const st = getState();
    const home = st.sections[panel.sectionId];
    if (!home) return;
    // the section to the right of the machine's: one that starts where it ends and shares a row, else a new one
    const right = Object.values(st.sections).find((s) => s.c0 === home.c1 + 1 && s.r0 <= home.r1 && s.r1 >= home.r0);
    const where = right?.id ?? addSectionAdjacent(home.id, "right") ?? home.id;
    const note = addNote(where, `## Out of ${panel.name}\n\nWhat ${panel.name} writes to \`${MACHINE_OUT_PATH}\` lands here.`);
    addLink({ from: { panel: panel.id, port: outPort.id }, to: { panel: note.id, port: NOTE_PORT }, label: "out" });
    toast(`Out goes to a note in ${getState().sections[where]?.name ?? "the next section"}`, "ok");
  };
  const tryIt = () => {
    setBusy("try");
    void api(`/api/boards/${encodeURIComponent(activeBoard()?.boardId ?? "")}/machines/${encodeURIComponent(panel.id)}/io/try`, { method: "POST", json: {} })
      .catch((e: Error) => toast(`${panel.name} couldn't write it: ${e.message}`, "bad"))
      .finally(() => setBusy(null));
  };
  return (
    <div className="machine-io-view" data-machine-io-view>
      {/* 2026-11-17: the pipes under a heading of their own, and the machine's functions after them (MachineFunctions.tsx) */}
      <div className="machine-io-head">
        <span className="machine-io-title">
          <InGlyph size={18} />
          <OutGlyph size={18} /> Pipes
        </span>
        <span className="machine-io-what">
          What's wired in is written to <code>{MACHINE_IN_PATH}</code>; what the machine writes to <code>{MACHINE_OUT_PATH}</code> goes out
        </span>
      </div>
      <IoStrip panel={panel} viewer={viewer} />
      {io?.outAt && (
        <div className="machine-io-last" data-machine-io-last>
          <span className="machine-io-dir">Last out</span>
          <span className="machine-io-kind">{kind}</span>
          <pre>{io.outPreview || "(empty)"}</pre>
        </div>
      )}
      {!viewer && (
        <div className="machine-io-acts">
          {outs.length === 0 && (
            <button type="button" className="f-pill is-accent" onClick={toTheRight} disabled={!outPort} data-machine-io-right>
              Out to a new note on the right
            </button>
          )}
          <button type="button" className="f-pill" onClick={tryIt} disabled={busy === "try"} data-machine-io-try data-tip={`The machine writes its name and the time to ${MACHINE_OUT_PATH}`}>
            {busy === "try" ? "Writing…" : "Write a test line"}
          </button>
        </div>
      )}
      {panel.machine && <Functions panelId={panel.id} m={panel.machine} viewer={viewer} />}
    </div>
  );
}

const looksJson = (s?: string) => {
  const t = (s ?? "").trim();
  if (!/^[[{"]/.test(t) && !/^(true|false|null|-?\d)/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return /^[[{]/.test(t);
  }
};

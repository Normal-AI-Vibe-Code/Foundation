/**
 * The agents panel's Council tab (2026-11-17): the long conversation with a council. On the grid the
 * council is only its figures, and a line under the one you roll over; here is where you write to all
 * of them (or the ones you pick), see what you've said, and see how each is answering: what it's doing
 * right now, and a way into its own session where the full reply is.
 *
 * It follows the council that's up (a section's, or the grid's); with none up, it is the grid's.
 */

import { useMemo, useState } from "react";
import { placeOf, useCouncilOpen, useSaid, type CouncilScope } from "../lib/councilOpen";
import { SEAT_STATUS, SayBox, sayToCouncil, useCouncilSeats, type CouncilSeat } from "../characters/Council";
import { ProviderMark } from "../characters/providers";
import { setUi } from "../state/ui";
import { selectSeat } from "../lib/councilOpen";

const GRID: CouncilScope = { kind: "board" };

export function CouncilTalk({ viewer }: { viewer: boolean }) {
  const open = useCouncilOpen();
  const scope = open ?? GRID;
  const { seats, title, sectionId } = useCouncilSeats(scope);
  const said = useSaid();
  return <CouncilTalkView title={title} seats={seats} said={said.filter((s) => s.place === placeOf(scope))} viewer={viewer} onSay={(text, to, all) => sayToCouncil(scope, text, to, all, sectionId ? { id: sectionId, name: title } : null)} onAdd={() => setUi({ agentsTab: "add" })} onAbout={(s) => (selectSeat(s.id, true), setUi({ agentInfo: true }))} />;
}

interface ViewProps {
  title: string;
  seats: CouncilSeat[];
  said: Array<{ id: number; at: number; text: string; to: string[]; all: boolean }>;
  viewer: boolean;
  onSay?: (text: string, to: CouncilSeat[], all: boolean) => void;
  onAdd?: () => void;
  onAbout?: (seat: CouncilSeat) => void;
}

export function CouncilTalkView({ title, seats, said, viewer, onSay, onAdd, onAbout }: ViewProps) {
  // who the next line goes to; none picked: all of them
  const [picked, setPicked] = useState<string[]>([]);
  const to = useMemo(() => (picked.length ? seats.filter((s) => picked.includes(s.id)) : seats), [picked, seats]);
  const toWords = !seats.length ? "Claude, the server's own agent" : to.length === seats.length ? (seats.length === 1 ? seats[0].name : `all ${seats.length}`) : to.map((s) => s.name).join(", ");
  return (
    <div className="council-talk" data-council-talk>
      <div className="council-talk-who">
        <div className="council-talk-title">
          Council <i>· {title}</i>
        </div>
        <div className="council-talk-seats">
          {seats.map((s) => (
            <button key={s.id} type="button" className={`council-talk-seat${picked.includes(s.id) ? " is-on" : ""}${s.offline ? " is-offline" : ""}`} aria-pressed={picked.includes(s.id)} data-tip={s.offline ? `Not connected${s.why ? `: ${s.why}` : ""}` : picked.includes(s.id) ? "Speaking to it · press to speak to all again" : `Speak to ${s.name} only`} onClick={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))}>
              <ProviderMark provider={s.provider} size={20} />
              {s.name}
            </button>
          ))}
          {!viewer && onAdd && (
            <button type="button" className="council-talk-seat" onClick={onAdd} data-council-talk-add>
              ＋ Add an agent
            </button>
          )}
        </div>
      </div>

      <div className="council-talk-log">
        {!said.length && (
          <p className="council-talk-empty">
            {seats.length ? `Write below and ${seats.length === 1 ? seats[0].name : `all ${seats.length}`} will take it. Pick names above to speak to some of them.` : "Nobody is on this council yet. Add an agent, or write below and Claude, the server's own agent, takes it."}
          </p>
        )}
        {said.map((m) => (
          <div key={m.id} className="council-talk-said">
            <small>
              To {m.all && m.to.length > 1 ? `all ${m.to.length}` : m.to.join(", ")} · {new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </small>
            {m.text}
          </div>
        ))}
        {/* how each is answering, live */}
        {said.length > 0 &&
          seats.map((s) => (
            <div key={s.id} className="council-talk-now" data-council-talk-now={s.name}>
              <ProviderMark provider={s.provider} size={20} />
              <span>
                <b>{s.name}</b> {s.offline ? <span className="is-off">isn't connected{s.why ? `: ${s.why}` : ""}</span> : s.status === "working" ? (s.doing || "is working on it") : `is ${SEAT_STATUS[s.status]}`}{" "}
                {onAbout && (
                  <button type="button" className="council-talk-open" onClick={() => onAbout(s)}>
                    Open
                  </button>
                )}
              </span>
            </div>
          ))}
      </div>

      {!viewer && onSay && (
        <div className="council-talk-foot">
          <span className="council-talk-to" data-council-talk-to>
            To {toWords}
          </span>
          <SayBox label={`Say something to ${toWords}`} placeholder="Write to the council…" onSay={(t) => onSay(t, to, to.length === seats.length)} />
        </div>
      )}
    </div>
  );
}

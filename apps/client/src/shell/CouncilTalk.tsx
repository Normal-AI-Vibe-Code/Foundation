/**
 * The agents panel's Council tab (2026-11-17): the long conversation with a council. On the grid the
 * council is only its figures, and a line under the one you roll over; here is where you write to all
 * of them (or the ones you pick), see what you've said, and see how each is answering: what it's doing
 * right now, and a way into its own session where the full reply is.
 *
 * 2026-11-27 (plan council-replies-in-panel): the conversation is the server's (council.ts), so it survives a
 * reload and everyone on the grid sees it. Under each line, each agent's answer, as the reader may have it:
 * an agent whose run read beyond the grid answers its person alone, and others are told so.
 *
 * It follows the council that's up (a section's, or the grid's); with none up, it is the grid's.
 */

import { useMemo, useState } from "react";
import { placeOf, useCouncilLines, useCouncilOpen, useSaid, type CouncilLine, type CouncilReply, type CouncilScope } from "../lib/councilOpen";
import { useActiveBoard } from "./Presence";
import { SayBox, sayToCouncil, useCouncilSeats, type CouncilSeat } from "../characters/Council";
import { ProviderMark } from "../characters/providers";
import { openSession, setUi } from "../state/ui";
import { selectSeat } from "../lib/councilOpen";

const GRID: CouncilScope = { kind: "board" };

export function CouncilTalk({ viewer }: { viewer: boolean }) {
  const open = useCouncilOpen();
  const scope = open ?? GRID;
  const { seats, title, sectionId } = useCouncilSeats(scope);
  const said = useSaid();
  const board = useActiveBoard();
  const place = placeOf(scope);
  const kept = useCouncilLines(board?.boardId ?? null, place);
  // what this window said that the server hasn't answered with yet: shown at once, as sent
  const lines = useMemo(() => {
    const recent = said.filter((s) => s.place === place && !kept.lines.some((l) => l.mine && l.text === s.text && Math.abs(l.at - s.at) < 120_000));
    return [...kept.lines, ...recent.map((s): CouncilLine => ({ id: `local-${s.id}`, place, text: s.text, by: "You", mine: true, at: s.at, all: s.all, replies: s.to.map((name) => ({ name, state: "waiting" })) }))];
  }, [kept.lines, said, place]);
  return <CouncilTalkView title={title} seats={seats} lines={lines} viewer={viewer} onSay={(text, to, all) => sayToCouncil(scope, text, to, all, sectionId ? { id: sectionId, name: title } : null)} onAdd={() => setUi({ agentsTab: "add" })} onAbout={(s) => (selectSeat(s.id, true), setUi({ agentInfo: true }))} onSession={(id, name) => openSession({ id, kind: "agent", title: name })} />;
}

interface ViewProps {
  title: string;
  seats: CouncilSeat[];
  lines: CouncilLine[];
  viewer: boolean;
  onSay?: (text: string, to: CouncilSeat[], all: boolean) => void;
  onAdd?: () => void;
  onAbout?: (seat: CouncilSeat) => void;
  /** open an agent's session (only the line's author gets one) */
  onSession?: (session: string, name: string) => void;
}

/** what a reply says while it has no words of its own */
function replyState(r: CouncilReply, seat: CouncilSeat | undefined): string {
  if (r.state === "elsewhere") return "answers in its own thread";
  if (r.state === "none") return "finished without a word back";
  if (r.state === "waiting") return seat?.offline ? "isn't connected" : "is taking it";
  return seat?.status === "working" && seat.doing ? seat.doing : "is working on it";
}

export function CouncilTalkView({ title, seats, lines, viewer, onSay, onAdd, onAbout, onSession }: ViewProps) {
  const said = lines;
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
          <div key={m.id} className="council-talk-turn" data-council-line={m.id}>
            <div className={`council-talk-said${m.mine ? "" : " is-theirs"}`}>
              <small>
                {m.mine ? "" : `${m.by} · `}To {m.all && m.replies.length > 1 ? `all ${m.replies.length}` : m.replies.map((r) => r.name).join(", ")} · {new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </small>
              {m.text}
            </div>
            {m.replies.map((r, i) => {
              const seat = seats.find((s) => s.name === r.name);
              const words = r.state === "answered" && r.text;
              return (
                <div key={`${r.name}-${i}`} className={`council-talk-reply is-${r.state}${r.withheld ? " is-withheld" : ""}`} data-council-reply={r.name}>
                  <ProviderMark provider={seat?.provider ?? "claude"} size={20} />
                  <div>
                    {seat && onAbout ? (
                      <button type="button" className="council-talk-who-btn" onClick={() => onAbout(seat)} data-tip={`About ${r.name}`}>
                        {r.name}
                      </button>
                    ) : (
                      <b>{r.name}</b>
                    )}{" "}
                    {words ? <p className="council-talk-words">{r.text}</p> : r.withheld ? <span className="council-talk-withheld">{r.withheld}</span> : <span className="council-talk-state">{replyState(r, seat)}</span>}
                    {r.session && onSession && (
                      <button type="button" className="council-talk-open" onClick={() => onSession(r.session!, r.name)}>
                        Session
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
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

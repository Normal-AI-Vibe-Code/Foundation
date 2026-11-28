/**
 * An agent, on the right (2026-11-15): opened by ⓘ on a council. It shows the seat that's selected
 * there (or the first): the character head to toe, whose model it is, the service it's connected to
 * and whether that runs in the cloud or on this computer, what it's doing, what it did here lately,
 * and a box to write to it alone. A floor pane like search and the agents list: it takes their place,
 * and the council moves over to stay in the middle of what's left.
 *
 * 2026-11-25 (Josh): pointing at an agent shows this pane as a sheet over the grid (nothing under the pointer moves);
 * its profile goes small at the top and its last run takes the room, step by step, with whether it worked (RunTrace).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { boardMaps, type ActivityEntry } from "@foundation/protocol";
import { useCouncilLines, useCouncilOpen, useCouncilSelection, selectSeat, type CouncilLine } from "../lib/councilOpen";
import { GRID_PLACE, unpostAgent } from "../lib/posted";
import { FloorEdge } from "../shell/FloorEdge";
import { followCrew, useFollowing } from "../shell/Crew";
import { ago } from "../shell/SidePane";
import { useActiveBoard } from "../shell/Presence";
import { crewAsk, stopSession } from "../state/sessions";
import { getState, subscribe } from "../state/store";
import { WIDTHS, floorInsets, setUi, toast, useUi } from "../state/ui";
import { Avatar } from "./Avatar";
import { SEAT_STATUS, holdPeek, peekAt, tellSeat, useCouncilSeats, usePeek, type CouncilSeat } from "./Council";
import { PROVIDER_NAME, ProviderMark } from "./providers";
import { RunCard } from "./RunCard";
import { RunTrace } from "./RunTrace";
import { chooseAvatar, readyCharacters, useRoster } from "./roster";

const sectionsOf = () => getState().allSections;

/** the last things this agent did on the open grid, newest first */
function useDid(names: string[]): ActivityEntry[] {
  const board = useActiveBoard();
  const [list, setList] = useState<ActivityEntry[]>([]);
  const key = names.join("\n");
  useEffect(() => {
    if (!board) return;
    const arr = boardMaps(board.doc).activity;
    const read = () =>
      setList(
        arr
          .toArray()
          .filter((e) => e.role === "agent" && names.includes(e.who))
          .slice(-6)
          .reverse(),
      );
    read();
    arr.observe(read);
    return () => arr.unobserve(read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, key]);
  return list;
}

export function AgentInfoPane() {
  const ui = useUi();
  const scope = useCouncilOpen();
  const peeking = usePeek();
  const kept = useRef<CouncilSeat | null>(null);
  const sheet = !ui.agentInfo && Boolean(peeking);
  const { seats, sectionId } = useCouncilSeats(ui.agentInfo || peeking ? scope : null);
  const selected = useCouncilSelection();
  // with no council up there is nobody to show: the pane goes
  useEffect(() => {
    if (ui.agentInfo && !scope) setUi({ agentInfo: false });
  }, [ui.agentInfo, scope]);
  if ((!ui.agentInfo && !sheet) || !scope || ui.presenting) return null;
  let seat = sheet ? seats.find((s) => s.id === peeking) : (seats.find((s) => selected.includes(s.id)) ?? seats[0]);
  // an agent here for one ask leaves the council when it's done: its pane keeps it, so how it went can be read
  if (seat) kept.current = seat;
  else if (!sheet && kept.current) seat = { ...kept.current, status: kept.current.status === "working" ? "done" : kept.current.status, crewId: undefined, doing: undefined, plan: null, thought: undefined };
  if (sheet && !seat) return null;
  return (
    <aside
      className={`agents-pane agent-info floor-pane${sheet ? " is-sheet" : ""}`}
      style={sheet ? { width: ui.agentsW, top: floorInsets(ui).top } : { width: ui.agentsW }}
      aria-label={seat ? `About ${seat.name}` : "About the agent"}
      data-agent-info={seat?.name}
      data-agent-sheet={sheet ? "" : undefined}
      onPointerEnter={sheet ? holdPeek : undefined}
      onPointerLeave={sheet ? () => peekAt(null, 300) : undefined}
    >
      {!sheet && <FloorEdge side="left" value={ui.agentsW} {...WIDTHS.agents} onChange={(w) => setUi({ agentsW: w })} label="The agent's pane" />}
      <header className="agents-head">
        {seat ? seat.name : "Nobody here"}
        <span className="agents-head-n">{seat ? SEAT_STATUS[seat.status] : ""}</span>
        {sheet ? (
          <button
            type="button"
            className="top-btn"
            onClick={() => {
              if (seat) selectSeat(seat.id, true);
              peekAt(null);
              setUi({ agentInfo: true });
            }}
            aria-label="Keep this pane open"
            data-tip="Keep it open"
          >
            ⇥
          </button>
        ) : (
          <button type="button" className="top-btn" onClick={() => setUi({ agentInfo: false })} aria-label="Close agent details" data-tip="Close">
            ✕
          </button>
        )}
      </header>
      {seat ? <AgentInfoBody key={seat.id} seat={seat} seats={seats} sectionId={sectionId} viewer={ui.role === "viewer"} /> : <p className="agents-empty">No agents are on this council yet. ＋ on the council adds one.</p>}
    </aside>
  );
}

export function AgentInfoBody({ seat, seats, sectionId, viewer, still, lines }: { seat: CouncilSeat; seats: CouncilSeat[]; sectionId: string | null; viewer: boolean; still?: boolean; lines?: CouncilLine[] }) {
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const roster = useRoster();
  const following = useFollowing();
  const [text, setText] = useState("");
  const did = useDid(useMemo(() => [seat.name, ...(seat.agentName ? [seat.agentName] : [])], [seat.name, seat.agentName]));
  const section = sectionId ? sections[sectionId] : seat.place && seat.place !== GRID_PLACE ? sections[seat.place] : undefined;
  const sec = section ? { id: section.id, name: section.name } : null;
  // a seat with a name of its own wears what was chosen for that name (2026-11-17: two Claudes, two characters)
  const wearName = seat.alias ?? seat.agentName ?? seat.name;
  const ready = readyCharacters(roster);
  // what was said to it on its council and what it said back (council.ts), its last few (plan council-conversation)
  const board = useActiveBoard();
  const place = seat.place && seat.place !== GRID_PLACE ? seat.place : (sectionId ?? "board");
  const kept = useCouncilLines(still ? null : (board?.boardId ?? null), place);
  const talk = useMemo(() => (lines ?? kept.lines).filter((l) => l.replies.some((r) => r.name === seat.name)).slice(-4), [lines, kept.lines, seat.name]);
  return (
    <div className="agents-scroll agent-info-body">
      {/* its profile, small at the top (2026-11-25): the room below is its last run's */}
      <div className="agent-info-who" style={{ ["--crew" as string]: `var(--color-crew-${seat.hue % 6})` }} data-agent-who>
        <div className="agent-info-figure is-small">
          <Avatar character={seat.character} mood={seat.mood} framing="bust" still={still ?? true} />
        </div>
        <div className="agent-info-who-text">
          <b>
            <ProviderMark provider={seat.provider} where={seat.where} size={16} /> {seat.agentName ?? seat.name}
          </b>
          <span>
            {PROVIDER_NAME[seat.provider]}
            {seat.model ? ` · ${seat.model}` : ""}
            {seat.where ? ` · ${seat.where === "local" ? "on this computer" : "in the cloud"}` : ""}
          </span>
        </div>
      </div>

      {seats.length > 1 && (
        <div className="agent-info-others" role="tablist" aria-label="The council's agents">
          {seats.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === seat.id} className={`agent-info-other${s.id === seat.id ? " is-on" : ""}`} style={{ ["--crew" as string]: `var(--color-crew-${s.hue % 6})` }} onClick={() => s.id !== seat.id && selectSeat(s.id, true)}>
              <span className="council-dot" aria-hidden="true" />
              {s.name}
            </button>
          ))}
        </div>
      )}

      {seat.status === "working" && (seat.plan || seat.thought) && (
        <RunCard run={{ status: "working", doing: seat.doing, plan: seat.plan, thought: seat.thought, started: seat.started, hue: seat.hue }} variant="full" />
      )}
      {!viewer && <RunTrace seat={seat} />}

      <details className="agent-info-about">
        <summary>About {seat.name}</summary>
      <dl className="agent-info-facts">
        <dt>Agent</dt>
        <dd>
          {seat.agentName ?? seat.name}
          {seat.alias ? `, seated here as ${seat.alias}` : seat.agentName && seat.agentName !== seat.name ? `, at work as ${seat.name}` : ""}
        </dd>
        <dt>Model by</dt>
        <dd>{PROVIDER_NAME[seat.provider]}</dd>
        {seat.where && (
          <>
            <dt>Runs</dt>
            <dd data-agent-where={seat.where}>{seat.where === "local" ? "On this computer: nothing you ask leaves it" : "In the cloud: what you ask goes to its service"}</dd>
          </>
        )}
        {seat.service && (
          <>
            <dt>Service</dt>
            <dd>{seat.service}</dd>
          </>
        )}
        {seat.model && (
          <>
            <dt>Model</dt>
            <dd className="agent-info-code">{seat.model}</dd>
          </>
        )}
        {seat.tools !== undefined && (
          <>
            <dt>On the grid</dt>
            <dd>{seat.tools ? "Reads and writes it with the grid's tools, under its own cursor" : "Works in a folder of its own; it can't change the grid"}</dd>
          </>
        )}
        <dt>Assigned</dt>
        <dd>{seat.place ? `${seat.place === GRID_PLACE ? "To the whole grid" : `To ${sections[seat.place]?.name ?? "a section"}`}${seat.postedBy ? `, by ${seat.postedBy}` : ""}` : "Not assigned: it's here for one ask"}</dd>
        {seat.character && (
          <>
            <dt>Appears as</dt>
            <dd>
              <select className="agent-info-pick" aria-label={`The character ${wearName} wears`} disabled={viewer} value={roster.avatars[wearName] ?? ""} onChange={(e) => void chooseAvatar(wearName, e.target.value || null).catch((err: Error) => toast(err.message, "bad"))}>
                <option value="">{roster.avatars[wearName] ? "Chosen by its name" : `${seat.character.name} (by its name)`}</option>
                {ready.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.set}
                  </option>
                ))}
              </select>
            </dd>
          </>
        )}
      </dl>
      </details>

      {(seat.task || seat.doing) && (
        <section className="agent-info-now">
          {seat.task && <p className="council-task">“{seat.task}”</p>}
          {/* the run card in full (2026-11-24): every step and the reasoning; an older server's run is its doing line */}
          {!(seat.status === "working" && (seat.plan || seat.thought)) && seat.doing && <p className="council-doing">{seat.doing}</p>}
          {(seat.askerName || seat.leadName) && (
            <p className="council-for">
              {seat.leadName ? `called in by ${seat.leadName}` : ""}
              {seat.leadName && seat.askerName ? " · " : ""}
              {seat.askerName ? `for ${seat.askerName}` : ""}
            </p>
          )}
        </section>
      )}

      <div className="council-acts">
        {seat.status === "working" && seat.crewId && (
          <button type="button" className={`f-pill${following === seat.crewId ? " is-primary" : ""}`} onClick={() => followCrew(following === seat.crewId ? null : seat.crewId!)}>
            {following === seat.crewId ? "Following" : "Follow"}
          </button>
        )}
        {seat.status === "working" && seat.mine && seat.crewId && (
          <button
            type="button"
            className="f-pill"
            onClick={() => {
              const ask = crewAsk(seat.crewId!);
              if (ask) stopSession(ask.session);
            }}
          >
            Stop
          </button>
        )}
        {!viewer && seat.place && seat.agentKey && (
          <button type="button" className="f-pill agent-info-off" onClick={() => void unpostAgent(seat.place!, seat.seatId ?? seat.agentKey!).catch((e: Error) => toast(e.message, "bad"))}>
            Take off this council
          </button>
        )}
      </div>

      {talk.length > 0 && (
        <section className="agent-info-talk" data-agent-talk>
          <h3>Said to it here</h3>
          {talk.map((l) => {
            const r = l.replies.find((x) => x.name === seat.name)!;
            return (
              <div key={l.id} className="agent-info-talk-line">
                <p className="agent-info-talk-said">
                  <span>{l.mine ? "You" : l.by}: {l.text}</span>
                  <time>{ago(l.at)}</time>
                </p>
                <p className={`agent-info-talk-back${r.withheld ? " is-withheld" : r.state !== "answered" ? " is-state" : ""}`}>
                  {r.state === "answered" ? (r.text ?? r.withheld) : r.state === "working" ? "working on it" : r.state === "waiting" ? "takes it up next" : r.state === "elsewhere" ? "answered in its own thread" : "finished without a word back"}
                </p>
              </div>
            );
          })}
        </section>
      )}

      {did.length > 0 && (
        <section className="agent-info-did">
          <h3>Lately, here</h3>
          {did.map((e, i) => (
            <p key={`${e.at}${i}`}>
              <span>{e.text}</span>
              <time>{ago(e.at)}</time>
            </p>
          ))}
        </section>
      )}

      {!viewer && (
        <form
          className="agent-info-say"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            setText("");
            void tellSeat(seat, t, sec).then(
              () => toast(`Sent to ${seat.name}`, "agent"),
              (err: Error) => toast(`${seat.name} couldn't take it: ${err.message}`, "bad"),
            );
          }}
        >
          <textarea
            value={text}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Write to ${seat.name}${sec ? `, in ${sec.name}` : ""}…`}
            aria-label={`Write to ${seat.name}`}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="agent-info-say-foot">
            <span>{seat.where === "local" ? "stays on this computer" : `goes to ${PROVIDER_NAME[seat.provider]}`}</span>
            <button type="submit" className="f-pill is-agent" disabled={!text.trim()}>
              Send
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

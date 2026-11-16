/**
 * An agent, on the right (2026-11-15): opened by ⓘ on a council. It shows the seat that's selected
 * there (or the first): the character head to toe, whose model it is, the service it's connected to
 * and whether that runs in the cloud or on this computer, what it's doing, what it did here lately,
 * and a box to write to it alone. A floor pane like search and the agents list: it takes their place,
 * and the council moves over to stay in the middle of what's left.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { boardMaps, type ActivityEntry } from "@foundation/protocol";
import { useCouncilOpen, useCouncilSelection, selectSeat } from "../lib/councilOpen";
import { GRID_PLACE, unpostAgent } from "../lib/posted";
import { FloorEdge } from "../shell/FloorEdge";
import { followCrew, useFollowing } from "../shell/Crew";
import { ago } from "../shell/SidePane";
import { useActiveBoard } from "../shell/Presence";
import { crewAsk, stopSession } from "../state/sessions";
import { getState, subscribe } from "../state/store";
import { WIDTHS, setUi, toast, useUi } from "../state/ui";
import { Avatar } from "./Avatar";
import { SEAT_STATUS, tellSeat, useCouncilSeats, type CouncilSeat } from "./Council";
import { PROVIDER_NAME, ProviderMark } from "./providers";
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
  const { seats, sectionId } = useCouncilSeats(ui.agentInfo ? scope : null);
  const selected = useCouncilSelection();
  // with no council up there is nobody to show: the pane goes
  useEffect(() => {
    if (ui.agentInfo && !scope) setUi({ agentInfo: false });
  }, [ui.agentInfo, scope]);
  if (!ui.agentInfo || !scope || ui.presenting) return null;
  const seat = seats.find((s) => selected.includes(s.id)) ?? seats[0];
  return (
    <aside className="agents-pane agent-info floor-pane" style={{ width: ui.agentsW }} aria-label={seat ? `About ${seat.name}` : "About the agent"} data-agent-info={seat?.name}>
      <FloorEdge side="left" value={ui.agentsW} {...WIDTHS.agents} onChange={(w) => setUi({ agentsW: w })} label="The agent's pane" />
      <header className="agents-head">
        {seat ? seat.name : "Nobody here"}
        <span className="agents-head-n">{seat ? SEAT_STATUS[seat.status] : ""}</span>
        <button className="top-btn" onClick={() => setUi({ agentInfo: false })} aria-label="Close the agent's pane" data-tip="Close">
          ✕
        </button>
      </header>
      {seat ? <AgentInfoBody key={seat.id} seat={seat} seats={seats} sectionId={sectionId} viewer={ui.role === "viewer"} /> : <p className="agents-empty">No agents are on this council yet. ＋ on the council adds one.</p>}
    </aside>
  );
}

export function AgentInfoBody({ seat, seats, sectionId, viewer, still }: { seat: CouncilSeat; seats: CouncilSeat[]; sectionId: string | null; viewer: boolean; still?: boolean }) {
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const roster = useRoster();
  const following = useFollowing();
  const [text, setText] = useState("");
  const did = useDid(useMemo(() => [seat.name, ...(seat.agentName ? [seat.agentName] : [])], [seat.name, seat.agentName]));
  const section = sectionId ? sections[sectionId] : seat.place && seat.place !== GRID_PLACE ? sections[seat.place] : undefined;
  const sec = section ? { id: section.id, name: section.name } : null;
  const wearName = seat.agentName ?? seat.name;
  const ready = readyCharacters(roster);
  return (
    <div className="agents-scroll agent-info-body">
      <div className="agent-info-figure" style={{ ["--crew" as string]: `var(--color-crew-${seat.hue % 6})` }}>
        <span className="council-plinth" aria-hidden="true" />
        <Avatar character={seat.character} mood={seat.mood} framing="full" still={still} />
        <span className="council-provider">
          <ProviderMark provider={seat.provider} where={seat.where} size={26} />
        </span>
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

      <dl className="agent-info-facts">
        <dt>Agent</dt>
        <dd>
          {seat.agentName ?? seat.name}
          {seat.agentName && seat.agentName !== seat.name ? `, at work as ${seat.name}` : ""}
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

      {(seat.task || seat.doing) && (
        <section className="agent-info-now">
          {seat.task && <p className="council-task">“{seat.task}”</p>}
          {seat.doing && <p className="council-doing">{seat.doing}</p>}
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
          <button type="button" className="f-pill agent-info-off" onClick={() => void unpostAgent(seat.place!, seat.agentKey!).catch((e: Error) => toast(e.message, "bad"))}>
            Take off this council
          </button>
        )}
      </div>

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

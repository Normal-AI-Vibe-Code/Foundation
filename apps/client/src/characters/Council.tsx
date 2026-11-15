/**
 * The council: the agents at work on a section or the whole board, seated
 * along the bottom of the window as characters. Each seat stands on its
 * agent's cursor colour, says what its cursor says, and wears a mood: it
 * waves when it arrives, thinks while it reads, works while it writes, talks
 * when it asks you something, cheers when it's done and holds its head when
 * it fails.
 *
 * A seat shows its character from the chest up; press it and it stands head
 * to toe beside what it's doing, with the ways to act on it (follow, stop,
 * change who it wears). With nobody at work, the bench shows the characters
 * there are and a place to ask for something.
 *
 * The board above stays live: the overlay takes no pointer outside the bench,
 * so the cursors the seats are coloured after can still be watched.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSyncExternalStore } from "react";
import type { Mood } from "@foundation/protocol";
import { closeCouncil, useCouncilOpen, type CouncilScope } from "../lib/councilOpen";
import { useCrew, boardWhere } from "../lib/crewWatch";
import { crewIsIn } from "../lib/sectionCrew";
import { useActiveBoard } from "../shell/Presence";
import { followCrew, useFollowing } from "../shell/Crew";
import { askCrew, crewAsk, stopSession } from "../state/sessions";
import { getState, subscribe } from "../state/store";
import { toast, useUi } from "../state/ui";
import { Avatar, StageContext } from "./Avatar";
import { AvatarStage, type Framing } from "./actor";
import { useMoods } from "./mood";
import { chooseAvatar, readyCharacters, seats as seatCharacters, useRoster, type RosterCharacter } from "./roster";
import "./council.css";

export interface CouncilSeat {
  id: string;
  name: string;
  /** 0–5: the crew colour its cursor has; absent on the bench (no agent wears it yet) */
  hue?: number;
  status?: "working" | "done" | "stopped" | "error";
  doing?: string;
  task?: string;
  askerName?: string;
  leadName?: string;
  mine?: boolean;
  character?: RosterCharacter;
  mood: Mood;
}

interface ViewProps {
  title: string;
  /** agents at work (their seats), or the bench when nobody is */
  seats: CouncilSeat[];
  bench: boolean;
  characters: RosterCharacter[];
  canAsk: boolean;
  following?: string | null;
  onClose?: () => void;
  onAsk?: (text: string) => void;
  onFollow?: (id: string | null) => void;
  onStop?: (id: string) => void;
  onChoose?: (name: string, character: string | null) => void;
  /** design page: sit in the page's flow instead of over the window */
  inline?: boolean;
  /** design page: a seat already standing */
  open?: string;
}

const STATUS: Record<NonNullable<CouncilSeat["status"]>, string> = { working: "at work", done: "done", stopped: "stopped", error: "hit an error" };

export function CouncilView({ title, seats, bench, characters, canAsk, following, onClose, onAsk, onFollow, onStop, onChoose, inline, open }: ViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState<AvatarStage | null>(null);
  const [standing, setStanding] = useState<string | null>(open ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const [text, setText] = useState("");

  // one renderer for every 3D seat; without WebGL the seats keep their stills
  useEffect(() => {
    if (!canvas.current) return;
    let s: AvatarStage | null = null;
    try {
      s = new AvatarStage(canvas.current);
    } catch {
      return;
    }
    setStage(s);
    return () => {
      setStage(null);
      s.dispose();
    };
  }, []);

  useEffect(() => {
    if (standing && !seats.some((s) => s.id === standing)) setStanding(null);
  }, [seats, standing]);

  const mid = (seats.length - 1) / 2;
  const up = seats.find((s) => s.id === standing);

  return (
    <div className={`council${inline ? " is-inline" : ""}${bench ? " is-bench" : ""}`} data-council={seats.length} data-council-bench={bench || undefined}>
      <canvas ref={canvas} className="council-stage" aria-hidden="true" />
      <StageContext.Provider value={stage}>
        <div className="council-bar f-glass">
          <header className="council-head">
            <span className="council-title">
              <span aria-hidden="true">✦</span> Council <i>· {title}</i>
            </span>
            <span className="council-count">{bench ? (characters.length ? "nobody at work · the bench" : "no characters yet") : `${seats.length} at work`}</span>
            {onClose && (
              <button type="button" className="council-close" aria-label="Close the council" data-tip="Close · Esc" onClick={onClose}>
                ×
              </button>
            )}
          </header>

          <div className="council-seats" role="list">
            {seats.map((s, i) => {
              const isUp = s.id === standing;
              const framing: Framing = isUp ? "full" : "bust";
              // a bench character waves when you point at it; an agent's mood is its own
              const mood: Mood = bench && hover === s.id ? "waving" : s.mood;
              return (
                <div
                  key={s.id}
                  role="listitem"
                  className={`council-seat${isUp ? " is-up" : ""}${s.status ? ` is-${s.status}` : ""}${s.hue === undefined ? " is-spare" : ""}`}
                  style={{ ["--crew" as string]: s.hue === undefined ? "var(--color-dim)" : `var(--color-crew-${s.hue % 6})`, ["--i" as string]: i } as CSSProperties}
                  data-council-seat={s.name}
                  data-mood={mood}
                  onPointerEnter={() => setHover(s.id)}
                  onPointerLeave={() => setHover((h) => (h === s.id ? null : h))}
                >
                  {s.doing && !isUp && <div className="council-says">{s.doing}</div>}
                  <button type="button" className="council-figure" aria-pressed={isUp} aria-label={`${s.name}${s.character ? `, as ${s.character.name}` : ""}${s.status ? `: ${STATUS[s.status]}` : ""}`} onClick={() => setStanding(isUp ? null : s.id)}>
                    <span className="council-plinth" aria-hidden="true" />
                    <Avatar character={s.character} mood={mood} framing={framing} turn={isUp ? 0 : (mid - i) * 0.1} />
                  </button>
                  <div className="council-name">
                    <span className="council-dot" aria-hidden="true" />
                    <b>{s.name}</b>
                    {s.character && s.hue !== undefined && <i>as {s.character.name}</i>}
                    {s.hue === undefined && s.character && <i>{s.character.set}</i>}
                  </div>
                </div>
              );
            })}
            {!seats.length && <p className="council-none">No characters are ready yet. Make one on the Character studio board: its sheet, its model, its moods. Then it can sit here.</p>}
          </div>

          {up && (
            <aside className="council-card" data-council-card={up.name}>
              <div className="council-card-name" style={{ ["--crew" as string]: up.hue === undefined ? "var(--color-dim)" : `var(--color-crew-${up.hue % 6})` }}>
                <span className="council-dot" aria-hidden="true" />
                <b>{up.name}</b>
                {up.status && <span className={`council-status is-${up.status}`}>{STATUS[up.status]}</span>}
              </div>
              {up.task && <p className="council-task">“{up.task}”</p>}
              {up.doing && <p className="council-doing">{up.doing}</p>}
              {(up.askerName || up.leadName) && (
                <p className="council-for">
                  {up.leadName ? `called in by ${up.leadName}` : ""}
                  {up.leadName && up.askerName ? " · " : ""}
                  {up.askerName ? `for ${up.askerName}` : ""}
                </p>
              )}
              {up.hue !== undefined && (
                <div className="council-acts">
                  {up.status === "working" && onFollow && (
                    <button type="button" className={`f-pill${following === up.id ? " is-primary" : ""}`} onClick={() => onFollow(following === up.id ? null : up.id)}>
                      {following === up.id ? "Following" : "Follow"}
                    </button>
                  )}
                  {up.status === "working" && up.mine && onStop && (
                    <button type="button" className="f-pill" onClick={() => onStop(up.id)}>
                      Stop
                    </button>
                  )}
                </div>
              )}
              {up.hue !== undefined && onChoose && characters.length > 0 && (
                <div className="council-wear">
                  <div className="council-label">{up.name} appears as</div>
                  <div className="council-wear-list">
                    {characters.map((c) => (
                      <button key={c.id} type="button" className={`council-wear-pick${up.character?.id === c.id ? " is-on" : ""}`} aria-pressed={up.character?.id === c.id} data-tip={`${c.name} · ${c.set}`} onClick={() => onChoose(up.name, c.id)}>
                        <Avatar character={{ ...c, files: { thumb: c.files.thumb } }} mood="idle" framing="bust" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {up.hue === undefined && up.character && <p className="council-doing">{up.character.identity}</p>}
            </aside>
          )}

          {canAsk && onAsk && (
            <form
              className="council-ask"
              onSubmit={(e) => {
                e.preventDefault();
                const t = text.trim();
                if (!t) return;
                onAsk(t);
                setText("");
              }}
            >
              <input className="council-ask-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask the council: what should an agent do ${title === "this board" ? "on this board" : `in ${title}`}?`} aria-label="Ask the council" />
              <button type="submit" className="f-pill is-agent" disabled={!text.trim()}>
                Ask
              </button>
            </form>
          )}
        </div>
      </StageContext.Provider>
    </div>
  );
}

const sectionsOf = () => getState().allSections;

/** the council, wired to the open board: who's at work in its scope, and who each of them wears */
export function Council() {
  const scope = useCouncilOpen();
  const ui = useUi();
  if (!scope || ui.presenting) return null;
  return <CouncilLive scope={scope} />;
}

function CouncilLive({ scope }: { scope: CouncilScope }) {
  const ui = useUi();
  const board = useActiveBoard();
  const all = useCrew();
  const roster = useRoster();
  const following = useFollowing();
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const section = scope.kind === "section" ? sections[scope.id] : undefined;
  const me = board?.user.id;

  // a section that's gone takes its council with it
  useEffect(() => {
    if (scope.kind === "section" && !section) closeCouncil();
  }, [scope, section]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      // Esc in the ask field clears the field first, as everywhere
      if (t?.closest(".council-ask") && (t as HTMLInputElement).value) return;
      closeCouncil();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const crew = useMemo(() => (scope.kind === "section" ? all.filter((p) => crewIsIn(p.crew, scope.id, boardWhere)) : all), [all, scope]);
  const moods = useMoods(crew.map((p) => ({ id: p.crew.id, status: p.crew.status, doing: p.crew.doing, asking: Boolean(p.crew.guide), aiming: Boolean(p.crew.target) })));
  const ready = readyCharacters(roster);
  // seat by everyone on the board, so an agent keeps its character when the scope narrows to a section
  const worn = useMemo(() => seatCharacters(roster, all.map((p) => p.user.name)), [roster, all]);

  const seats: CouncilSeat[] = crew.length
    ? crew.map((p) => ({
        id: p.crew.id,
        name: p.user.name,
        hue: p.crew.hue,
        status: p.crew.status,
        doing: p.crew.doing,
        task: p.crew.task,
        askerName: p.crew.askerName,
        leadName: p.crew.leadName,
        mine: p.crew.asker === me,
        character: worn[p.user.name],
        mood: moods[p.crew.id] ?? "idle",
      }))
    : ready.slice(0, 8).map((c) => ({ id: c.id, name: c.name, character: c, mood: "idle" as Mood }));

  const title = scope.kind === "section" ? (section?.name ?? "a section") : "this board";
  return (
    <CouncilView
      title={title}
      seats={seats}
      bench={!crew.length}
      characters={ready}
      canAsk={ui.role !== "viewer"}
      following={following}
      onClose={closeCouncil}
      onAsk={(text) => {
        askCrew(scope.kind === "section" && section ? `In the “${section.name}” section: ${text}` : text);
        toast(scope.kind === "section" && section ? `An agent is on its way to ${section.name}` : "An agent is on its way", "agent");
      }}
      onFollow={followCrew}
      onStop={(id) => {
        const ask = crewAsk(id);
        if (ask) stopSession(ask.session);
      }}
      onChoose={ui.role === "viewer" ? undefined : (name, character) => void chooseAvatar(name, character).catch((e: Error) => toast(e.message, "bad"))}
    />
  );
}

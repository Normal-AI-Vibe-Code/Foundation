/**
 * The council (2026-11-15): the agents that belong to a section, or to the whole grid, as characters.
 *
 * Who sits on it: the agents a person assigned there (lib/posted.ts: they stay, at work or not), and
 * any agent at work there right now. Not every character there is: only that place's agents. An
 * assigned agent that is working takes the name, the colour and the words of its cursor; at rest it
 * sits idle under its own name. Each wears a small mark of whose model it is at its top right
 * (Claude, ChatGPT, Kimi, DeepSeek…).
 *
 * Where it stands (2026-11-16: "a full interface panel … push down where the tabs are located … not as
 * a floating window on the section, but pushing down the header of the section"): it is a band, part
 * of the interface, never a window over it. The grid's council is a band under the top bar, as wide as
 * the open paper; the grid starts below it. A section's council is a band at the top of its section,
 * inside it, and the section's header and cards move down under it. In both, the agents stand along
 * the band's lower edge, cut off at the chest by it, as if behind a desk.
 *
 * What it's for: talking to them. One line goes to all of them, or to the ones you select by pressing
 * their seats. ＋ assigns another agent; ⓘ opens the selected agent on the right: what service it is,
 * whether it runs in the cloud or on this computer, what it's doing, and a place to write to it alone.
 *
 * A seat materialises: its character's silhouette first, shimmering, then the character itself. The
 * files it needs are fetched as soon as a grid with assigned agents opens (CouncilPreload), so that is
 * usually a blink.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";
import type { Mood } from "@foundation/protocol";
import { closeCouncil, councilSelection, selectSeat, useCouncilOpen, useCouncilSelection, type CouncilScope } from "../lib/councilOpen";
import { useCrew, boardWhere } from "../lib/crewWatch";
import { crewIsIn, sectionOfCrew } from "../lib/sectionCrew";
import { GRID_PLACE, usePosted, type AvailableAgent, type PostedAgent } from "../lib/posted";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { useActiveBoard } from "../shell/Presence";
import type { CrewPeer } from "../shell/Crew";
import { askCrew } from "../state/sessions";
import { getState, subscribe } from "../state/store";
import { TOP_BAR, floorInsets, setUi, toast, useUi } from "../state/ui";
import { goSettings } from "../lib/place";
import { Avatar, StageContext } from "./Avatar";
import { AvatarStage } from "./actor";
import { CouncilGlyph } from "./CouncilGlyph";
import { useMoods } from "./mood";
import { ProviderMark, providerOf, type Provider } from "./providers";
import { characterBytes, seats as seatCharacters, useRoster, type Roster, type RosterCharacter } from "./roster";
import "./council.css";

export interface CouncilSeat {
  id: string;
  /** the name it goes by right now: its cursor's while it works, its own at rest */
  name: string;
  /** the agent it is, when that differs from the name ("Wren" is Claude at work) */
  agentName?: string;
  /** "claude", "t3:<id>" */
  agentKey?: string;
  provider: Provider;
  where?: "cloud" | "local";
  service?: string;
  model?: string;
  tools?: boolean;
  /** where it's assigned (a section id, or the grid); absent for an agent only passing through */
  place?: string;
  postedBy?: string;
  /** 0–5: the crew colour (its cursor's while it works) */
  hue: number;
  status: "idle" | "working" | "done" | "stopped" | "error";
  doing?: string;
  task?: string;
  askerName?: string;
  leadName?: string;
  mine?: boolean;
  /** its cursor's id while it works */
  crewId?: string;
  character?: RosterCharacter;
  mood: Mood;
}

/** the band's height: under the top bar (px on screen), and at the top of a section (px of the grid) */
export const COUNCIL_H = 236;

export const SEAT_STATUS: Record<CouncilSeat["status"], string> = { idle: "at rest", working: "at work", done: "done", stopped: "stopped", error: "hit an error" };
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---------------------------------------------------------------- who sits here

/** the agents of a scope, as seats: the assigned ones (working or at rest), then anyone else at work there */
export function buildSeats(scope: CouncilScope, posted: Record<string, PostedAgent[]>, crew: CrewPeer[], roster: Roster, me: string | undefined, moods: Record<string, Mood>): CouncilSeat[] {
  const inScope = (p: CrewPeer) => scope.kind === "board" || crewIsIn(p.crew, scope.id, boardWhere);
  const live = crew.filter(inScope);
  const taken = new Set<string>();
  const places = scope.kind === "section" ? [scope.id] : [GRID_PLACE, ...Object.keys(posted).filter((p) => p !== GRID_PLACE)];
  const out: CouncilSeat[] = [];
  const fromPeer = (p: CrewPeer): Partial<CouncilSeat> => ({ name: p.user.name, hue: p.crew.hue, status: p.crew.status, doing: p.crew.doing, task: p.crew.task, askerName: p.crew.askerName, leadName: p.crew.leadName, mine: p.crew.asker === me, crewId: p.crew.id, mood: moods[p.crew.id] ?? "idle" });

  for (const place of places) {
    for (const a of posted[place] ?? []) {
      // its cursor, if it's at work: the same agent, in this place when the place is a section
      const peer = live.find((p) => !taken.has(p.crew.id) && (p.crew.via ?? "claude") === a.key && (place === GRID_PLACE || sectionOfCrew(p.crew, boardWhere) === place));
      if (peer) taken.add(peer.crew.id);
      out.push({
        id: `${place}:${a.key}`,
        name: a.name,
        agentName: a.name,
        agentKey: a.key,
        provider: providerOf(a),
        where: a.where,
        service: a.service,
        model: a.model,
        tools: a.tools,
        place,
        postedBy: a.byName,
        hue: hash(`${place}:${a.key}`) % 6,
        status: "idle",
        mood: "idle",
        ...(peer ? fromPeer(peer) : {}),
      });
    }
  }
  for (const p of live) {
    if (taken.has(p.crew.id)) continue;
    const via = p.crew.via ?? "claude";
    out.push({ id: p.crew.id, name: p.user.name, agentName: via === "claude" ? "Claude" : undefined, agentKey: via, provider: via === "claude" ? "claude" : providerOf({ name: p.user.name }), hue: p.crew.hue, status: p.crew.status, mood: "idle", ...fromPeer(p) });
  }
  // who each wears: by its agent's name (what Settings → Avatars assigns), unless another seat already wears that one
  const wearAs: string[] = [];
  for (const s of out) {
    const pick = s.agentName && !wearAs.includes(s.agentName) ? s.agentName : s.name;
    wearAs.push(wearAs.includes(pick) ? `${pick} ${wearAs.length}` : pick);
  }
  const worn = seatCharacters(roster, wearAs);
  return out.map((s, i) => ({ ...s, character: worn[wearAs[i]] }));
}

const sectionsOf = () => getState().allSections;

/** the open council's seats (Council and the agent's pane both read this) */
export function useCouncilSeats(scope: CouncilScope | null): { seats: CouncilSeat[]; title: string; sectionId: string | null } {
  const board = useActiveBoard();
  const crew = useCrew();
  const roster = useRoster();
  const posted = usePosted();
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const moods = useMoods(crew.map((p) => ({ id: p.crew.id, status: p.crew.status, doing: p.crew.doing, asking: Boolean(p.crew.guide), aiming: Boolean(p.crew.target) })));
  const me = board?.user.id;
  const moodKey = JSON.stringify(moods);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seats = useMemo(() => (scope ? buildSeats(scope, posted, crew, roster, me, moods) : []), [scope, posted, crew, roster, me, moodKey]);
  const section = scope?.kind === "section" ? sections[scope.id] : undefined;
  return { seats, title: scope?.kind === "section" ? (section?.name ?? "a section") : "this grid", sectionId: scope?.kind === "section" ? scope.id : null };
}

/**
 * Fetch what the assigned agents' characters need before anyone opens a council: the 3D clips, the mesh
 * avatars and the code that plays them.
 */
export function preloadCouncil(characters: Array<RosterCharacter | undefined>) {
  let mesh = false;
  for (const c of characters) {
    if (!c) continue;
    if (c.form === "model" && c.files.clips) void characterBytes(c.id, "clips", c.files.clips).catch(() => {});
    if (c.form === "mesh" && c.files.mavatar) {
      mesh = true;
      void characterBytes(c.id, "mavatar", c.files.mavatar).catch(() => {});
    }
  }
  if (mesh) void import("mesh-avatar").catch(() => {});
}

/** mounted with the shell: keeps the open grid's council warm (when its agents change, a moment after) */
export function CouncilPreload() {
  const posted = usePosted();
  const roster = useRoster();
  const crew = useCrew();
  useEffect(() => {
    if (!roster.loaded) return;
    const seats = buildSeats({ kind: "board" }, posted, crew, roster, undefined, {});
    if (!seats.length) return;
    const idle = window.setTimeout(() => preloadCouncil(seats.map((s) => s.character)), 600);
    return () => window.clearTimeout(idle);
  }, [posted, roster, crew]);
  return null;
}

// ---------------------------------------------------------------- the view

interface ViewProps {
  title: string;
  seats: CouncilSeat[];
  /** the seats spoken to; none: everyone */
  selected: string[];
  canAsk: boolean;
  /** agents that could be added (asked for when ＋ is pressed); null: not answered yet */
  available?: { agents: AvailableAgent[]; t3: string } | null;
  detailsOpen?: boolean;
  onSelect?: (id: string) => void;
  onClose?: () => void;
  onSay?: (text: string, to: CouncilSeat[]) => void;
  onAddOpen?: () => void;
  onAdd?: (agent: AvailableAgent) => void;
  onDetails?: () => void;
  /** design page: sit in the page's flow instead of over the window */
  inline?: boolean;
  /** design page: the add menu already open */
  adding?: boolean;
}

export function CouncilView({ title, seats, selected, canAsk, available, detailsOpen, onSelect, onClose, onSay, onAddOpen, onAdd, onDetails, inline, adding: addingStart }: ViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState<AvatarStage | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(Boolean(addingStart));

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

  const mid = (seats.length - 1) / 2;
  const working = seats.filter((s) => s.status === "working").length;
  const to = selected.length ? seats.filter((s) => selected.includes(s.id)) : seats;
  const here = new Set(seats.map((s) => s.agentKey));
  const toWords = !seats.length ? "Claude" : selected.length ? to.map((s) => s.name).join(", ") : seats.length === 1 ? seats[0].name : `all ${seats.length}`;

  return (
    <div className={`council${inline ? " is-inline" : ""}`} data-council={seats.length}>
      <canvas ref={canvas} className="council-stage" aria-hidden="true" />
      <StageContext.Provider value={stage}>
        <div className="council-bar f-glass" role="dialog" aria-label={`Council of ${title}`}>
          <header className="council-head">
            <span className="council-title">
              <span aria-hidden="true">
                <CouncilGlyph size={15} />
              </span>
              Council <i>· {title}</i>
            </span>
            <span className="council-count">{seats.length ? `${seats.length} ${seats.length === 1 ? "agent" : "agents"}${working ? ` · ${working} at work` : ""}` : "nobody yet"}</span>
            <span className="council-head-acts">
              {onDetails && seats.length > 0 && (
                <button type="button" className={`council-tool${detailsOpen ? " is-on" : ""}`} aria-pressed={detailsOpen} aria-label="About the agent" data-tip={detailsOpen ? "Put the agent's pane away" : "About the agent: its service, where it runs, and a place to write to it"} data-council-details onClick={onDetails}>
                  ⓘ
                </button>
              )}
              {onClose && (
                <button type="button" className="council-tool" aria-label="Close the council" data-tip="Close" data-kbd="Esc" onClick={onClose}>
                  ×
                </button>
              )}
            </span>
          </header>

          <div className="council-seats" role="list">
            {seats.map((s, i) => {
              const on = selected.includes(s.id);
              return (
                <div
                  key={s.id}
                  role="listitem"
                  className={`council-seat is-${s.status}${on ? " is-selected" : ""}`}
                  style={{ ["--crew" as string]: `var(--color-crew-${s.hue % 6})`, ["--i" as string]: i } as CSSProperties}
                  data-council-seat={s.name}
                  data-council-agent={s.agentKey}
                  data-mood={s.mood}
                >
                  {s.doing && s.status === "working" && <div className="council-says">{s.doing}</div>}
                  <button type="button" className="council-figure" aria-pressed={on} aria-label={`${s.name}${s.character ? `, as ${s.character.name}` : ""}: ${SEAT_STATUS[s.status]}. ${on ? "Selected" : "Press to speak to it alone"}`} onClick={() => onSelect?.(s.id)}>
                    <span className="council-plinth" aria-hidden="true" />
                    <Avatar character={s.character} mood={s.mood} framing="bust" turn={(mid - i) * 0.1} />
                    <span className="council-provider">
                      <ProviderMark provider={s.provider} where={s.where} size={22} />
                    </span>
                  </button>
                  <div className="council-name">
                    <span className="council-dot" aria-hidden="true" />
                    <b>{s.name}</b>
                    {s.agentName && s.agentName !== s.name ? <i>{s.agentName}</i> : s.character ? <i>as {s.character.name}</i> : null}
                  </div>
                </div>
              );
            })}
            {canAsk && onAddOpen && (
              <div className="council-seat council-add" style={{ ["--i" as string]: seats.length } as CSSProperties}>
                <button
                  type="button"
                  className={`council-add-btn${adding ? " is-on" : ""}`}
                  aria-expanded={adding}
                  aria-label="Add an agent to this council"
                  data-tip={adding ? undefined : "Add an agent to this council"}
                  data-council-add
                  onClick={() => {
                    onAddOpen();
                    // the design page shows the old menu's rows as a specimen; live, adding happens in the agents panel
                    if (available !== undefined) setAdding((a) => !a);
                  }}
                >
                  ＋
                </button>
                <div className="council-name">
                  <b>Add an agent</b>
                </div>
                {adding && (
                  <div className="council-add-menu" role="menu" aria-label="Agents you can add" data-council-add-menu>
                    {!available && <p className="council-add-note">Asking which agents there are…</p>}
                    {available?.agents.map((a) => {
                      const has = here.has(a.key);
                      return (
                        <button
                          key={a.key}
                          type="button"
                          role="menuitem"
                          className="council-add-item"
                          disabled={has}
                          data-council-add-agent={a.key}
                          onClick={() => {
                            onAdd?.(a);
                            setAdding(false);
                          }}
                        >
                          <ProviderMark provider={providerOf(a)} size={24} />
                          <span className="council-add-text">
                            <b>{a.name}</b>
                            <span>
                              {a.where === "local" ? "On this computer" : "In the cloud"} · {a.service}
                            </span>
                            {!a.ready && <span className="council-add-why">{a.why}</span>}
                          </span>
                          <span className="council-add-state">{has ? "here" : "Add"}</span>
                        </button>
                      );
                    })}
                    {available && available.t3 !== "running" && (
                      <button type="button" className="council-add-more" onClick={() => goSettings("agents")}>
                        Codex, Kimi, DeepSeek and the rest are this computer's agents: start them in Settings → Agents
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {!seats.length && !canAsk && <p className="council-none">No agents are on this council.</p>}
          </div>

          {canAsk && onSay && (
            <form
              className="council-ask"
              onSubmit={(e) => {
                e.preventDefault();
                const t = text.trim();
                if (!t) return;
                onSay(t, to);
                setText("");
              }}
            >
              <span className="council-to" data-council-to>
                To <b>{toWords}</b>
                {selected.length > 0 && (
                  <button type="button" className="council-to-all" onClick={() => selected.forEach((id) => onSelect?.(id))}>
                    everyone
                  </button>
                )}
              </span>
              <input className="council-ask-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={seats.length ? "Say something to the council…" : `What should an agent do ${title === "this grid" ? "on this grid" : `in ${title}`}?`} aria-label="Say something to the council" />
              <button type="submit" className="f-pill is-agent" disabled={!text.trim()}>
                Send
              </button>
            </form>
          )}
        </div>
      </StageContext.Provider>
    </div>
  );
}

// ---------------------------------------------------------------- wired to the open grid

/** send one line to a seat's agent, in a section: the server's own agent through a session, one of this computer's through its host */
export async function tellSeat(seat: Pick<CouncilSeat, "agentKey" | "name"> | null, text: string, section: { id: string; name: string } | null): Promise<void> {
  const key = seat?.agentKey ?? "claude";
  if (!key.startsWith("t3:")) {
    askCrew(section ? `In the “${section.name}” section: ${text}` : text);
    return;
  }
  const board = activeBoard()?.boardId;
  const sec = section ?? Object.values(getState().sections).find((s) => !s.parent) ?? null;
  if (!board || !sec) throw new Error("There's no section for it to work in.");
  await api("/api/t3host/threads", { method: "POST", json: { board, section: sec.id, agent: key.slice(3), text } });
}

/** the council, wired to the open grid */
export function Council() {
  const scope = useCouncilOpen();
  const ui = useUi();
  if (!scope || ui.presenting) return null;
  return <CouncilLive scope={scope} />;
}

function CouncilLive({ scope }: { scope: CouncilScope }) {
  const ui = useUi();
  const { seats, title, sectionId } = useCouncilSeats(scope);
  const selected = useCouncilSelection();
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const section = sectionId ? sections[sectionId] : undefined;
  const el = useRef<HTMLDivElement>(null);

  // a section that's gone takes its council with it
  useEffect(() => {
    if (scope.kind === "section" && !section) closeCouncil();
  }, [scope, section]);
  // a seat that left is no longer selected
  useEffect(() => {
    for (const id of councilSelection()) if (!seats.some((s) => s.id === id)) selectSeat(id);
  }, [seats]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      // Esc in the field clears the field first, as everywhere
      if (t?.closest(".council-ask") && (t as HTMLInputElement).value) return;
      // Esc closes the council and nothing else: the grid's own Esc (step up a level, reframe) waits for the next press
      e.stopPropagation();
      closeCouncil();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // the grid's band takes its height off the top of the grid (the camera frames below it); a section's
  // marks its card, whose header and cards move down under it (council.css)
  useEffect(() => {
    if (scope.kind !== "board") return;
    setUi({ councilH: COUNCIL_H });
    return () => setUi({ councilH: 0 });
  }, [scope.kind]);
  const [card, setCard] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (scope.kind !== "section") return setCard(null);
    const node = document.querySelector<HTMLElement>(`.section-card[data-section-id="${CSS.escape(scope.id)}"]`);
    setCard(node);
    node?.classList.add("has-council");
    return () => node?.classList.remove("has-council");
  }, [scope, section?.id]);

  const sec = section ? { id: section.id, name: section.name } : null;
  const f = floorInsets(ui);
  const band = (
    <div
      ref={el}
      className={`council-place is-${scope.kind}`}
      style={scope.kind === "board" ? { left: f.left, right: f.right, top: TOP_BAR + ui.strip, height: COUNCIL_H } : { height: COUNCIL_H }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => scope.kind === "section" || e.stopPropagation()}
    >
      <CouncilView
        title={title}
        seats={seats}
        selected={selected}
        canAsk={ui.role !== "viewer"}
        detailsOpen={ui.agentInfo}
        onSelect={selectSeat}
        onClose={closeCouncil}
        onDetails={() => setUi({ agentInfo: !ui.agentInfo })}
        onAddOpen={() => setUi({ agents: true, agentsTab: "add" })}
        onSay={(text, to) => {
          const list: Array<CouncilSeat | null> = to.length ? to : [null];
          for (const s of list) void tellSeat(s, text, sec).catch((e: Error) => toast(`${s?.name ?? "Claude"} couldn't take it: ${e.message}`, "bad"));
          toast(to.length > 1 ? `Sent to ${to.length} agents` : `Sent to ${to[0]?.name ?? "Claude"}`, "agent");
        }}
      />
    </div>
  );
  // a section's band lives inside its section, in the grid's own space; the grid's is the shell's
  if (scope.kind === "section") return card ? createPortal(band, card) : null;
  return band;
}

/**
 * The council: the agents that belong to a section, or to the whole grid, as characters.
 *
 * Who is on it: the agents a person assigned there (lib/posted.ts: they stay, at work or not), and
 * any agent at work there right now. An assigned agent that is working takes the name, the colour and
 * the words of its cursor; at rest it waits under its own name.
 *
 * Where it stands (2026-11-17: "animate up from the top of the section, covering up the section
 * partially above it. Don't make it a solid panel"): it is no panel at all. The agents come up from
 * behind the section's top edge and stand on it, over whatever is above, cut off below the chest by
 * that edge. Beside them stand silhouettes: places an agent could take, drawn from characters of the
 * different kinds. Press one to add an agent; when every place is taken there is always one more.
 * The grid's council stands the same way on the window's bottom edge.
 *
 * Talking: nothing to type into until you roll over an agent. Then a line with a microphone opens
 * under it (above it, for the grid's), and what you write or say goes to that agent alone. At the
 * section's top right: speak to all of them at once, open the agents panel's Council tab (the long
 * conversation with all of them), close.
 *
 * Above each head: whose model it is, whether it runs in the cloud or on this computer, and a pulled
 * plug when it can't be reached (it also looks the part: grey, head down).
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";
import type { Mood } from "@foundation/protocol";
import { closeCouncil, councilSelection, logSaid, selectSeat, useCouncilOpen, type CouncilScope } from "../lib/councilOpen";
import { useCrew, boardWhere } from "../lib/crewWatch";
import { crewIsIn, sectionOfCrew } from "../lib/sectionCrew";
import { GRID_PLACE, usePosted, type PostedAgent } from "../lib/posted";
import { useAvailable } from "../lib/agentsAvailable";
import { listen, type Listening } from "../lib/voice";
import { AllGlyph, CloseGlyph, CloudGlyph, ComputerGlyph, MicGlyph, OfflineGlyph, PanelGlyph, PlusGlyph, SendGlyph } from "../shell/glyphs";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { useActiveBoard } from "../shell/Presence";
import type { CrewPeer } from "../shell/Crew";
import { askCrew } from "../state/sessions";
import { getState, requestSnap, subscribe } from "../state/store";
import { camera, onCamera } from "../state/camera";
import { floorInsets, getUi, setUi, toast, useUi } from "../state/ui";
import { Avatar, StageContext, Still, stillRole } from "./Avatar";
import { AvatarStage } from "./actor";
import { useMoods } from "./mood";
import { ProviderMark, providerOf, type Provider } from "./providers";
import { characterBytes, readyCharacters, seats as seatCharacters, useRoster, type Roster, type RosterCharacter } from "./roster";
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
  /** it can't be reached right now (its service is off, signed out, or gone), and why */
  offline?: boolean;
  why?: string;
}

/** how much of a figure shows above the edge it stands behind (px of the grid for a section's, of the screen for the grid's) */
export const COUNCIL_H = 148;
/** places shown at least: agents first, the rest silhouettes; always one silhouette more than the agents */
export const COUNCIL_PLACES = 4;
/** the room a council takes above its edge: the figures and the marks over their heads */
export const COUNCIL_ROOM = 170;

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

/** can this seat's agent be reached? Unknown until the list of agents has answered; an agent at work is, plainly */
export function reach(s: Pick<CouncilSeat, "agentKey" | "status" | "place">, available: { agents: Array<{ key: string; ready: boolean; why?: string }>; loaded: boolean }): { offline?: boolean; why?: string } {
  if (!available.loaded || s.status === "working" || !s.place) return {};
  const a = available.agents.find((x) => x.key === (s.agentKey ?? "claude"));
  if (!a) return { offline: true, why: "It isn't on this server any more" };
  return a.ready ? {} : { offline: true, why: a.why || "Not connected" };
}

/**
 * The silhouettes beside the agents: characters nobody on this council wears, one kind after another
 * (a drawn person, an animal, a shape…) so the row shows what an agent could look like.
 */
export function ghostsFor(roster: Roster, seats: Array<Pick<CouncilSeat, "character">>, n: number): Array<RosterCharacter | undefined> {
  const worn = new Set(seats.map((s) => s.character?.id));
  const kinds = new Map<string, RosterCharacter[]>();
  for (const ch of readyCharacters(roster)) {
    if (worn.has(ch.id) || !stillRole(ch, "bust")) continue;
    const kind = `${ch.form}:${(ch as { set?: string }).set ?? ""}`;
    kinds.set(kind, [...(kinds.get(kind) ?? []), ch]);
  }
  const lists = [...kinds.values()];
  const out: Array<RosterCharacter | undefined> = [];
  for (let i = 0; out.length < n && lists.some((l) => l.length); i++) {
    const next = lists[i % lists.length].shift();
    if (next) out.push(next);
  }
  while (out.length < n) out.push(undefined);
  return out;
}

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
  const built = useMemo(() => (scope ? buildSeats(scope, posted, crew, roster, me, moods) : []), [scope, posted, crew, roster, me, moodKey]);
  // how each stands with its service: one that can't be reached says so, and looks it
  const available = useAvailable();
  const seats = useMemo(() => built.map((s) => ({ ...s, ...reach(s, available) })), [built, available]);
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

/** one line to say, typed or spoken: the only way to talk on the council (it opens under whoever you roll over) */
export function SayBox({ label, placeholder, onSay, focus }: { label: string; placeholder: string; onSay: (text: string) => void; focus?: boolean }) {
  const [text, setText] = useState("");
  const [hearing, setHearing] = useState<Listening | null>(null);
  useEffect(() => () => hearing?.cancel(), [hearing]);
  const send = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    onSay(t);
    setText("");
  };
  const mic = () => {
    if (hearing) return hearing.stop();
    setHearing(
      listen({
        heard: setText,
        done: (t) => {
          setHearing(null);
          send(t);
        },
        failed: (m) => {
          setHearing(null);
          toast(m, "bad");
        },
      }),
    );
  };
  return (
    <form
      className={`council-say${text || hearing ? " is-held" : ""}`}
      data-council-say
      onSubmit={(e) => {
        e.preventDefault();
        send(text);
      }}
    >
      <input className="council-say-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={hearing ? "Listening…" : placeholder} aria-label={label} autoFocus={focus} />
      <button type="button" className={`council-say-btn${hearing ? " is-live" : ""}`} aria-pressed={Boolean(hearing)} aria-label={hearing ? "Stop listening" : `Talk: ${label}`} data-tip={hearing ? "Stop and send" : "Talk instead"} data-council-mic onClick={mic}>
        <MicGlyph size={14} />
      </button>
      <button type="submit" className="council-say-btn is-send" disabled={!text.trim()} aria-label="Send">
        <SendGlyph size={14} />
      </button>
    </form>
  );
}

/** a figure nobody has filled in: a head and shoulders, when there's no character to trace */
function PlainGhost() {
  return (
    <svg className="council-ghost-plain" viewBox="0 0 100 150" aria-hidden>
      <circle cx="50" cy="44" r="25" />
      <path d="M6 150c0-40 18-66 44-66s44 26 44 66z" />
    </svg>
  );
}

/** above a head: whose model, where it runs, and whether it can be reached */
export function SeatMarks({ seat }: { seat: Pick<CouncilSeat, "provider" | "where" | "offline" | "why" | "status"> }) {
  return (
    <span className="council-marks">
      <ProviderMark provider={seat.provider} size={20} />
      {seat.where && (
        <span className="council-mark" role="img" aria-label={seat.where === "local" ? "Runs on this computer" : "Runs in the cloud"} data-tip={seat.where === "local" ? "Runs on this computer" : "Remote: runs in the cloud"} data-council-where={seat.where}>
          {seat.where === "local" ? <ComputerGlyph size={12} /> : <CloudGlyph size={12} />}
        </span>
      )}
      {seat.offline ? (
        <span className="council-mark is-off" role="img" aria-label={`Not connected: ${seat.why ?? ""}`} data-tip={`Not connected${seat.why ? `: ${seat.why}` : ""}`} data-council-offline>
          <OfflineGlyph size={12} />
        </span>
      ) : (
        <span className={`council-mark is-state is-${seat.status}`} role="img" aria-label={SEAT_STATUS[seat.status]} data-tip={`Connected · ${SEAT_STATUS[seat.status]}`} />
      )}
    </span>
  );
}

interface ViewProps {
  title: string;
  /** a section's stands on the section's top edge, talk opening under; the grid's on the window's bottom edge, talk opening over */
  kind: "section" | "board";
  seats: CouncilSeat[];
  /** silhouettes after the agents (undefined: a plain figure) */
  ghosts: Array<RosterCharacter | undefined>;
  canAsk: boolean;
  onSay?: (text: string, to: CouncilSeat[], all: boolean) => void;
  /** press a silhouette: add an agent */
  onAdd?: () => void;
  /** press an agent: what it is, on the right */
  onAbout?: (seat: CouncilSeat) => void;
  /** the agents panel, on its Council tab */
  onPanel?: () => void;
  panelOpen?: boolean;
  onClose?: () => void;
  /** design page: in the page's flow */
  inline?: boolean;
  /** design page: this seat's line already open */
  hot?: string;
}

export function CouncilView({ title, kind, seats, ghosts, canAsk, onSay, onAdd, onAbout, onPanel, panelOpen, onClose, inline, hot }: ViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState<AvatarStage | null>(null);
  const [all, setAll] = useState(false);

  // one renderer for every 3D figure; without WebGL they keep their stills
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

  const mid = (seats.length + ghosts.length - 1) / 2;
  const where = title === "this grid" ? "on this grid" : `in ${title}`;

  return (
    <div className={`council is-${kind}${inline ? " is-inline" : ""}`} data-council={seats.length} role="group" aria-label={`Council of ${title}`}>
      <canvas ref={canvas} className="council-stage" aria-hidden="true" />
      <StageContext.Provider value={stage}>
        <div className="council-row" role="list">
          {seats.map((s, i) => (
            <div
              key={s.id}
              role="listitem"
              className={`council-seat is-${s.status}${s.offline ? " is-offline" : ""}${hot === s.id ? " is-hot" : ""}`}
              style={{ ["--crew" as string]: `var(--color-crew-${s.hue % 6})`, ["--i" as string]: i } as CSSProperties}
              data-council-seat={s.name}
              data-council-agent={s.agentKey}
              data-mood={s.offline ? "sad" : s.mood}
            >
              <SeatMarks seat={s} />
              <div className="council-crop">
                <button type="button" className="council-figure" aria-label={`${s.name}${s.character ? `, as ${s.character.name}` : ""}: ${s.offline ? `not connected${s.why ? ` (${s.why})` : ""}` : SEAT_STATUS[s.status]}. Press for what it is`} onClick={() => onAbout?.(s)}>
                  <Avatar character={s.character} mood={s.offline ? "sad" : s.mood} framing="bust" turn={(mid - i) * 0.1} still={s.offline} />
                </button>
              </div>
              <div className="council-under">
                <div className="council-name">
                  <span className="council-dot" aria-hidden="true" />
                  <b>{s.name}</b>
                  {s.agentName && s.agentName !== s.name ? <i>{s.agentName}</i> : s.character ? <i>as {s.character.name}</i> : null}
                </div>
                {s.status === "working" && s.doing && <div className="council-says">{s.doing}</div>}
                {s.offline && <div className="council-says is-off">{s.why ?? "Not connected"}</div>}
                {canAsk && onSay && <SayBox label={`Say something to ${s.name}`} placeholder={`To ${s.name}…`} onSay={(t) => onSay(t, [s], false)} />}
              </div>
            </div>
          ))}
          {canAsk &&
            onAdd &&
            ghosts.map((g, k) => {
              const last = k === ghosts.length - 1;
              return (
                <div key={`ghost-${k}`} role="listitem" className={`council-seat council-ghost${last ? " is-add" : ""}`} style={{ ["--i" as string]: seats.length + k } as CSSProperties}>
                  <span className="council-marks">
                    {last && (
                      <span className="council-mark is-plus">
                        <PlusGlyph size={11} />
                      </span>
                    )}
                  </span>
                  <div className="council-crop">
                    <button type="button" className="council-figure" aria-label="Add an agent to this council" data-tip="Add an agent here" data-council-add onClick={onAdd}>
                      {g ? <Still character={g} role={stillRole(g, "bust") ?? "thumb"} /> : <PlainGhost />}
                    </button>
                  </div>
                </div>
              );
            })}
          {!seats.length && !canAsk && <p className="council-none">No agents are on this council.</p>}
        </div>

        <div className="council-tools" data-council-tools>
          {canAsk && onSay && (
            <button type="button" className={`council-tool${all ? " is-on" : ""}`} aria-pressed={all} aria-label={seats.length ? `Speak to all ${seats.length} at once` : "Ask an agent"} data-tip={seats.length > 1 ? `Speak to all ${seats.length} at once` : seats.length ? `Speak to ${seats[0].name}` : `Ask an agent ${where}`} data-council-all onClick={() => setAll((a) => !a)}>
              <AllGlyph />
            </button>
          )}
          {onPanel && (
            <button type="button" className={`council-tool${panelOpen ? " is-on" : ""}`} aria-pressed={panelOpen} aria-label="The agents panel: the conversation with all of them" data-tip="Open the agents panel: the conversation with all of them" data-council-panel onClick={onPanel}>
              <PanelGlyph />
            </button>
          )}
          {onClose && (
            <button type="button" className="council-tool" aria-label="Send the council away" data-tip="Close" data-kbd="Esc" data-council-close onClick={onClose}>
              <CloseGlyph />
            </button>
          )}
          {all && canAsk && onSay && (
            <div className="council-tools-say">
              <SayBox focus label={seats.length ? "Say something to all of them" : "Ask an agent"} placeholder={seats.length > 1 ? `To all ${seats.length}…` : seats.length ? `To ${seats[0].name}…` : `What should an agent do ${where}?`} onSay={(t) => onSay(t, seats, true)} />
            </div>
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

/** say one line to some of a council (none: the server's own agent takes it), and keep it for the panel's Council tab */
export function sayToCouncil(scope: CouncilScope, text: string, to: CouncilSeat[], all: boolean, sec: { id: string; name: string } | null) {
  const list: Array<CouncilSeat | null> = to.length ? to : [null];
  for (const s of list) void tellSeat(s, text, sec).catch((e: Error) => toast(`${s?.name ?? "Claude"} couldn't take it: ${e.message}`, "bad"));
  logSaid(scope, text, to.length ? to.map((s) => s.name) : ["Claude"], all);
  toast(to.length > 1 ? `Sent to ${to.length} agents` : `Sent to ${to[0]?.name ?? "Claude"}`, "agent");
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
  const roster = useRoster();
  const { seats, title, sectionId } = useCouncilSeats(scope);
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const section = sectionId ? sections[sectionId] : undefined;
  const canAsk = ui.role !== "viewer";
  // agents first, silhouettes to fill the row, and always one more to add another
  const ghostN = canAsk ? Math.max(1, COUNCIL_PLACES - seats.length) : 0;
  const ghostKey = seats.map((s) => s.character?.id ?? "").join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ghosts = useMemo(() => ghostsFor(roster, seats, ghostN), [roster, ghostKey, ghostN]);

  // a section that's gone takes its council with it
  useEffect(() => {
    if (scope.kind === "section" && !section) closeCouncil();
  }, [scope, section]);
  // a seat that left is no longer the one the agent's pane shows
  useEffect(() => {
    for (const id of councilSelection()) if (!seats.some((s) => s.id === id)) selectSeat(id);
  }, [seats]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      // Esc in a line clears the line first, as everywhere
      if (t?.closest(".council-say") && (t as HTMLInputElement).value) return;
      // Esc closes the council and nothing else: the grid's own Esc (step up a level, reframe) waits for the next press
      e.stopPropagation();
      closeCouncil();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // a section's council stands on its section's card (which comes forward so the figures cover what's above it)
  const [card, setCard] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (scope.kind !== "section") return setCard(null);
    const node = document.querySelector<HTMLElement>(`.section-card[data-section-id="${CSS.escape(scope.id)}"]`);
    setCard(node);
    node?.classList.add("has-council");
    // they stand above the section: if that's off the top of the paper, the grid moves down to show them
    if (node) {
      const cam = camera;
      const need = floorInsets(getUi()).top + (COUNCIL_ROOM + 12) * cam.scale;
      const top = node.getBoundingClientRect().top;
      if (top < need) requestSnap({ kind: "view", x: cam.x, y: cam.y + (need - top), scale: cam.scale });
    }
    return () => node?.classList.remove("has-council");
  }, [scope, section?.id]);

  // a section wider than the window: its buttons keep to the part of its top edge you can see
  const standEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!card) return;
    const fit = () => {
      const el = standEl.current;
      if (!el) return;
      const over = card.getBoundingClientRect().right - (window.innerWidth - floorInsets(getUi()).right);
      el.style.setProperty("--council-shift", `${Math.max(0, over / (camera.scale || 1))}px`);
    };
    fit();
    const off = onCamera(fit);
    window.addEventListener("resize", fit);
    return () => {
      off();
      window.removeEventListener("resize", fit);
    };
  }, [card, ui.agents, ui.agentInfo, ui.search]);

  const sec = section ? { id: section.id, name: section.name } : null;
  const f = floorInsets(ui);
  const stand = (
    <div ref={standEl} className={`council-place is-${scope.kind}`} style={scope.kind === "board" ? { left: f.left, right: f.right } : undefined} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <CouncilView
        title={title}
        kind={scope.kind}
        seats={seats}
        ghosts={ghosts}
        canAsk={canAsk}
        panelOpen={ui.agents && ui.agentsTab === "council"}
        onClose={closeCouncil}
        onAbout={(s) => {
          selectSeat(s.id, true);
          setUi({ agentInfo: true });
        }}
        onPanel={() => setUi(ui.agents && ui.agentsTab === "council" ? { agents: false } : { agents: true, agentsTab: "council" })}
        onAdd={() => setUi({ agents: true, agentsTab: "add" })}
        onSay={(text, to, all) => sayToCouncil(scope, text, to, all, sec)}
      />
    </div>
  );
  // a section's lives with its section, in the grid's own space; the grid's is the shell's
  if (scope.kind === "section") return card ? createPortal(stand, card) : null;
  return stand;
}

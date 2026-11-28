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
 * Above each head (2026-11-24, Josh: one bar): one opaque bar with its model's mark, its name, whether
 * it runs in the cloud or on this computer, and how it stands (a pulled plug when it can't be reached;
 * it also looks the part: grey, head down). While it works, the same bar says what it's doing, alive,
 * with Follow, and Open and Stop for the one who asked; beside its head, the run card (RunCard.tsx):
 * its plan and its latest reasoning, the same for everyone on the grid.
 *
 * Talking: press an agent and the bar over its head becomes a line with a microphone; what you write
 * or say goes to that agent alone. At the council's right: speak to all of them at once, open the
 * agents panel's Council tab (the long conversation with all of them), close.
 *
 * A seat is as wide as its figure (a mesh avatar's picture, a 3D figure's frame, a still's own
 * proportions): never cut at the sides, only at the edge it stands behind. Beside the agents, one
 * silhouette asleep with the + on it (pressed, it adds an agent): full size on an empty council, and
 * half size peeking out from behind the last agent's right side once there are agents.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";
import type { CrewPlan, Mood } from "@foundation/protocol";
import { closeCouncil, councilOpen, councilSelection, keepLine, logSaid, openCouncil, placeOf, selectSeat, useCouncilLines, useCouncilOpen, answersBySeat, type SeatAnswer, type CouncilScope } from "../lib/councilOpen";
import { useCrew, boardWhere } from "../lib/crewWatch";
import { crewIsIn, sectionOfCrew } from "../lib/sectionCrew";
import { GRID_PLACE, usePosted, type PostedAgent } from "../lib/posted";
import { useAvailable } from "../lib/agentsAvailable";
import { listen, type Listening } from "../lib/voice";
import { AllGlyph, CloseGlyph, CloudGlyph, ComputerGlyph, MicGlyph, OfflineGlyph, PanelGlyph, PlusGlyph, SendGlyph } from "../shell/glyphs";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { useActiveBoard } from "../shell/Presence";
import { followCrew, useFollowing, type CrewPeer } from "../shell/Crew";
import { askCrew, crewAsk, stopSession, titleOf, useSession } from "../state/sessions";
import { getState, requestSnap, subscribe } from "../state/store";
import { camera, onCamera } from "../state/camera";
import { floorInsets, getUi, openSession, setUi, toast, useUi } from "../state/ui";
import { Avatar, StageContext, Still, stillRole } from "./Avatar";
import { AvatarStage } from "./actor";
import { useMoods } from "./mood";
import { ProviderMark, providerOf, type Provider } from "./providers";
import { characterBytes, readyCharacters, seats as seatCharacters, useRoster, type Roster, type RosterCharacter } from "./roster";
import { RunCard } from "./RunCard";
import "./council.css";

export interface CouncilSeat {
  id: string;
  /** the name it goes by right now: its cursor's while it works, its own at rest */
  name: string;
  /** the agent it is, when that differs from the name ("Wren" is Claude at work) */
  agentName?: string;
  /** "claude", "t3:<id>" */
  agentKey?: string;
  /** its seat on the council (posted.ts), when it has one of its own: what takes it off */
  seatId?: string;
  /** the seat's own name ("Zephyr"): what it wears over its head and what its character is chosen by */
  alias?: string;
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
  /** its run's plan, latest reasoning and start, from its cursor (docs/agent-harness.md §2; an older server sends none) */
  plan?: CrewPlan | null;
  thought?: string;
  started?: number;
  /** a person here just sent it something and its agent hasn't joined yet (this window's, optimistic) */
  pending?: boolean;
  /** the session its run is in, when this window knows it (Open and Stop are the asker's) */
  session?: string;
}

/** how much of a figure shows above the edge it stands behind (px of the grid for a section's, of the screen for the grid's) */
export const COUNCIL_H = 148;
export { COUNCIL_PLACES } from "./places";
/** the room a council takes above its edge: the figures and the marks over their heads */
export const COUNCIL_ROOM = 170;

export const SEAT_STATUS: Record<CouncilSeat["status"], string> = { idle: "at rest", working: "at work", done: "done", stopped: "stopped", error: "hit an error" };
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---------------------------------------------------------------- who sits here

/**
 * The agents of a scope, as seats: the ones seated there (working or at rest), then anyone else at work there.
 * 2026-11-17 (Josh: "every section has a different council"): a council is its place's alone. The grid's holds the
 * grid's seats and agents at work outside any section; a section's, its own seats and who works inside it.
 */
export function buildSeats(scope: CouncilScope, posted: Record<string, PostedAgent[]>, crew: CrewPeer[], roster: Roster, me: string | undefined, moods: Record<string, Mood>): CouncilSeat[] {
  // an agent asked from a council is that council's while it works, wherever it works (on the asker's screen); others
  // belong where they work: in a section, that section's council; outside any, the grid's
  const here = scopeKey(scope);
  const inScope = (p: CrewPeer) => {
    const from = askedFrom(p.crew.id);
    if (from) return from === here;
    return scope.kind === "board" ? !sectionOfCrew(p.crew, boardWhere) : crewIsIn(p.crew, scope.id, boardWhere);
  };
  // a seat with a name of its own is found at work by that name, wherever it works
  const named = (p: CrewPeer, alias: string) => p.user.name === alias || p.user.name.startsWith(`${alias} `);
  const live = crew;
  const taken = new Set<string>();
  const places = [scope.kind === "section" ? scope.id : GRID_PLACE];
  const out: CouncilSeat[] = [];
  const fromPeer = (p: CrewPeer): Partial<CouncilSeat> => ({ name: p.user.name, hue: p.crew.hue, status: p.crew.status, doing: p.crew.doing, task: p.crew.task, askerName: p.crew.askerName, leadName: p.crew.leadName, mine: p.crew.asker === me, crewId: p.crew.id, mood: moods[p.crew.id] ?? "idle", plan: p.crew.plan ?? null, thought: p.crew.thought, started: p.crew.started });

  for (const place of places) {
    for (const a of posted[place] ?? []) {
      // its cursor, if it's at work: by its own name; an older seat (no name of its own), the same agent in this place
      const peer = live.find((p) => !taken.has(p.crew.id) && (a.alias ? named(p, a.alias) : (p.crew.via ?? "claude") === a.key && inScope(p)));
      if (peer) taken.add(peer.crew.id);
      out.push({
        id: `${place}:${a.id ?? a.key}`,
        name: a.alias ?? a.name,
        agentName: a.name,
        agentKey: a.key,
        seatId: a.id,
        alias: a.alias,
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
        ...(peer ? { ...fromPeer(peer), name: a.alias ?? peer.user.name } : {}),
      });
    }
  }
  // names seated on other councils of this grid: at work here, they're still theirs, not this council's
  const elsewhere = Object.entries(posted).filter(([p]) => !places.includes(p)).flatMap(([, l]) => l.map((a) => a.alias).filter((x): x is string => !!x));
  for (const p of live) {
    if (taken.has(p.crew.id) || !inScope(p) || elsewhere.some((n) => named(p, n))) continue;
    const via = p.crew.via ?? "claude";
    out.push({ id: p.crew.id, name: p.user.name, agentName: via === "claude" ? "Claude" : undefined, agentKey: via, provider: via === "claude" ? "claude" : providerOf({ name: p.user.name }), hue: p.crew.hue, status: p.crew.status, mood: "idle", ...fromPeer(p) });
  }
  // who each wears: by its agent's name (what Settings → Avatars assigns), unless another seat already wears that one
  const wearAs: string[] = [];
  for (const s of out) {
    // a seat with a name of its own wears what was chosen for that name; an older one, its agent's
    const pick = s.alias ? s.alias : s.agentName && !wearAs.includes(s.agentName) ? s.agentName : s.name;
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
// ---------------------------------------------------------------- what this window knows ahead of the grid

/**
 * A seat a person here just sent something to, before its agent has joined (2026-11-24: the card shows the run is alive
 * from the first moment). Cleared when the seat's agent appears, when the ask fails or ends without it, or after 90 s.
 */
interface Pending {
  at: number;
  session?: string;
}
export const PENDING_MS = 90_000;
let pending: ReadonlyMap<string, Pending> = new Map();
const pendSubs = new Set<() => void>();
const setPending = (next: Map<string, Pending>) => {
  pending = next;
  pendSubs.forEach((f) => f());
};
export function markPending(seatId: string) {
  const next = new Map(pending);
  next.set(seatId, { at: Date.now() });
  setPending(next);
}
function pendingSession(seatId: string, session: string) {
  const p = pending.get(seatId);
  if (!p || p.session === session) return;
  setPending(new Map(pending).set(seatId, { ...p, session }));
}
export function clearPending(seatId: string) {
  if (!pending.has(seatId)) return;
  const next = new Map(pending);
  next.delete(seatId);
  setPending(next);
}
const subPending = (f: () => void) => {
  pendSubs.add(f);
  return () => pendSubs.delete(f);
};
export const usePending = () => useSyncExternalStore(subPending, () => pending);

/**
 * The agent under the pointer (2026-11-25, Josh: "when you have your mouse over the agent … the panel to the right should
 * minimize his profile to the top, and show his chain of reasoning"). Pointing at an agent a moment shows its pane, as a
 * sheet over the grid so nothing under the pointer moves; leaving the agent (and the sheet) puts it away. With the pane
 * already open, pointing at an agent shows that one in it.
 */
let peek: string | null = null;
let peekTimer = 0;
const peekSubs = new Set<() => void>();
export function peekAt(id: string | null, delay = 0) {
  window.clearTimeout(peekTimer);
  const set = () => {
    if (id && getUi().agentInfo) {
      selectSeat(id, true);
      return;
    }
    if (peek === id) return;
    peek = id;
    peekSubs.forEach((f) => f());
  };
  if (delay > 0) peekTimer = window.setTimeout(set, delay);
  else set();
}
/** the pointer came onto the sheet: it stays */
export function holdPeek() {
  window.clearTimeout(peekTimer);
}
export const usePeek = () =>
  useSyncExternalStore(
    (f) => {
      peekSubs.add(f);
      return () => peekSubs.delete(f);
    },
    () => peek,
  );

/** the crew members the open council shows over their heads: the strip above the bottom bar leaves them out (shell/Talk.tsx) */
let onCouncil: ReadonlySet<string> = new Set();
let onCouncilKey = "";
const onSubs = new Set<() => void>();
function showOnCouncil(ids: string[]) {
  const key = [...ids].sort().join("|");
  if (key === onCouncilKey) return;
  onCouncilKey = key;
  onCouncil = new Set(ids);
  onSubs.forEach((f) => f());
}
export function useCrewOnCouncil(): ReadonlySet<string> {
  return useSyncExternalStore(
    (f) => {
      onSubs.add(f);
      return () => onSubs.delete(f);
    },
    () => onCouncil,
  );
}

/** a person's own ask that started on the grid opens the grid's council, once per agent (2026-11-24) */
const seenCrew = new Set<string>();

/** mounted with the shell: keeps the open grid's council warm (when its agents change, a moment after) */
export function CouncilPreload() {
  const posted = usePosted();
  const roster = useRoster();
  const crew = useCrew();
  const board = useActiveBoard();
  const me = board?.user.id;
  useEffect(() => {
    if (!roster.loaded) return;
    const seats = buildSeats({ kind: "board" }, posted, crew, roster, undefined, {});
    if (!seats.length) return;
    const idle = window.setTimeout(() => preloadCouncil(seats.map((s) => s.character)), 600);
    return () => window.clearTimeout(idle);
  }, [posted, roster, crew]);
  // 2026-11-24 (Josh): the work shows over the agent's head, not in a strip over the bar. When a person's own ask starts
  // on the grid (not in a section, nor from a section's council), the grid's council opens by itself; closed again, it
  // stays closed for that agent
  useEffect(() => {
    if (!me) return;
    for (const p of crew) {
      if (seenCrew.has(p.crew.id)) continue;
      seenCrew.add(p.crew.id);
      if (p.crew.asker !== me || p.crew.status !== "working" || p.crew.lead) continue;
      if (councilOpen() || getUi().presenting) continue;
      const from = askedFrom(p.crew.id);
      if (from ? from !== GRID_PLACE : sectionOfCrew(p.crew, boardWhere)) continue;
      openCouncil({ kind: "board" });
    }
  }, [crew, me]);
  return null;
}

// ---------------------------------------------------------------- the view

/** one line to say, typed or spoken: the only way to talk on the council (it takes the place of the bar over a head) */
export function SayBox({ label, placeholder, onSay, focus, onClose }: { label: string; placeholder: string; onSay: (text: string) => void; focus?: boolean; onClose?: () => void }) {
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
      className={`council-say${text || hearing ? " has-words" : ""}`}
      data-council-say
      onSubmit={(e) => {
        e.preventDefault();
        send(text);
      }}
    >
      <input
        className="council-say-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={hearing ? "Listening…" : placeholder}
        aria-label={label}
        autoFocus={focus}
        onKeyDown={(e) => {
          // Esc clears the line first, then puts it away (a line with a ✕)
          if (e.key !== "Escape" || !onClose) return;
          e.preventDefault();
          if (text) setText("");
          else onClose();
        }}
      />
      <button type="button" className={`council-say-btn${hearing ? " is-live" : ""}`} aria-pressed={Boolean(hearing)} aria-label={hearing ? "Stop listening" : `Talk: ${label}`} data-tip={hearing ? "Stop and send" : "Talk instead"} data-council-mic onClick={mic}>
        <MicGlyph size={14} />
      </button>
      {onClose ? (
        text.trim() ? (
          <button type="submit" className="council-say-btn is-send" aria-label="Send">
            <SendGlyph size={14} />
          </button>
        ) : (
          <button type="button" className="council-say-btn" aria-label="Close input" data-tip="Close" data-council-say-close onClick={onClose}>
            <CloseGlyph size={12} />
          </button>
        )
      ) : (
        <button type="submit" className="council-say-btn is-send" disabled={!text.trim()} aria-label="Send">
          <SendGlyph size={14} />
        </button>
      )}
    </form>
  );
}

/** where a silhouette's closed eyes go, as shares of its picture: each eye's centre, and an eye's width */
export interface Eyes {
  left: number;
  right: number;
  y: number;
  w: number;
}
/** the plain figure's: its head is the circle at (50, 44) r 25 of 100 × 150, drawn at 88 % × 92 % from (6 %, 8 %) */
const PLAIN_EYES: Eyes = { left: 0.06 + 0.88 * 0.4, right: 0.06 + 0.88 * 0.6, y: 0.08 + 0.92 * (46 / 150), w: 0.12 };
/** each picture silhouette's eyes, by character: null when its picture can't be read (it then stands as the plain figure) */
const ghostEyes = new Map<string, Eyes | null>();
/** every council showing that silhouette redraws once its eyes are found */
let eyesV = 0;
const eyeSubs = new Set<() => void>();
function setGhostEyes(id: string, eyes: Eyes | null) {
  ghostEyes.set(id, eyes);
  eyesV++;
  eyeSubs.forEach((f) => f());
}
const subEyes = (f: () => void) => {
  eyeSubs.add(f);
  return () => eyeSubs.delete(f);
};

/**
 * Where a picture's head is, from its own alpha (2026-11-24, Josh: the sleeping eyes sit on the head): the opaque bounds
 * of the top 28 % of the figure are the head; the eyes go at its vertical middle, a third in from each side. A picture
 * with no clear ground around the figure (or one that can't be read) has no head to find: null.
 */
export function eyesOf(img: HTMLImageElement): Eyes | null {
  try {
    const k = Math.min(1, 192 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const solid = (x: number, y: number) => d[(y * w + x) * 4 + 3] > 96;
    // a ground that wasn't cut away: every corner solid
    if (solid(0, 0) && solid(w - 1, 0) && solid(0, h - 1) && solid(w - 1, h - 1)) return null;
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < h && top < 0; y++) for (let x = 0; x < w; x++) if (solid(x, y)) { top = y; break; }
    for (let y = h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < w; x++) if (solid(x, y)) { bottom = y; break; }
    if (top < 0 || bottom - top < h * 0.2) return null;
    const headEnd = top + Math.round((bottom - top) * 0.28);
    let l = w;
    let r = -1;
    for (let y = top; y <= headEnd; y++)
      for (let x = 0; x < w; x++)
        if (solid(x, y)) {
          if (x < l) l = x;
          if (x > r) r = x;
        }
    if (r - l < w * 0.08) return null;
    const third = (r - l) / 3;
    return { left: (l + third) / w, right: (r - third) / w, y: (top + headEnd) / 2 / h, w: Math.min(0.14, Math.max(0.05, (r - l) / w / 4.5)) };
  } catch {
    return null;
  }
}

/** asleep (2026-11-24): two closed eyes over a silhouette, in the paper's own ink, so they read as a gap in the figure */
function SleepingEyes({ eyes }: { eyes: Eyes }) {
  return (
    <>
      {[eyes.left, eyes.right].map((x, i) => (
        <svg key={i} className="council-ghost-eye" viewBox="0 0 12 6" style={{ left: `${x * 100}%`, top: `${eyes.y * 100}%`, width: `${eyes.w * 100}%` }} aria-hidden data-council-eye>
          <path d="M1.5 1.5q4.5 4.5 9 0" />
        </svg>
      ))}
    </>
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

/** the width a figure takes for its height: a mesh avatar's picture, a 3D figure's frame, a still's own picture */
const MESH_AR = 896 / 1200;
const MODEL_AR = 0.72;
const PLAIN_AR = 100 / 150;
const NONE_AR = 0.62;
const STILL_AR = 0.75;
/** a still's own width over height, by character, once its picture has loaded */
const stillAr = new Map<string, number>();
export function figureAr(c: RosterCharacter | undefined, still = false): number {
  if (!c) return NONE_AR;
  if (!still && c.form === "mesh" && c.files.mavatar) return MESH_AR;
  if (!still && c.form === "model" && c.files.clips) return MODEL_AR;
  return stillAr.get(c.id) ?? STILL_AR;
}
/** a figure's full height, at full size (148 of it shows above the edge: council.css) */
const FIG_H = 190;
/** the silhouette's size beside agents, as a share of a figure's (council.css .council-ghosts.is-peek) */
const GHOST_PEEK = 0.5;

type BarSeat = Pick<CouncilSeat, "name" | "provider" | "where" | "offline" | "why" | "status" | "doing" | "crewId" | "mine" | "session" | "pending">;

/**
 * Over each head, one bar (2026-11-24, Josh: "one unified bar above the agent's head"): its model's mark, its name in full,
 * where it runs and how it stands. While it works the same bar says what it is doing, alive, with Follow, and Open and
 * Stop for the one who asked. Opaque paper, never glass. Pressed, the line to it is a pill under the bar, with no box
 * around the two (2026-11-26).
 */
export function SeatBar({ seat, onAbout, say, onLeave, answer, onAnswer }: { seat: BarSeat; onAbout?: () => void; say?: React.ReactNode; onLeave?: () => void; answer?: SeatAnswer; onAnswer?: () => void }) {
  const following = useFollowing();
  const ask = seat.crewId ? crewAsk(seat.crewId) : undefined;
  const session = seat.session ?? ask?.session;
  const run = useSession(session ?? null);
  const working = seat.status === "working" && !seat.offline;
  // a run this window follows is stoppable while it streams; one it never loaded (the design page) is shown as it would be
  const live = run.busy || !run.loaded;
  const state = seat.offline ? `not connected${seat.why ? ` (${seat.why})` : ""}` : seat.pending ? "starting" : SEAT_STATUS[seat.status];
  return (
    <div
      className={`council-bar-wrap${say ? " is-saying" : ""}`}
      onBlur={(e) => {
        // the field is put away when focus leaves the bar and its line with nothing in it
        if (!say || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (!e.currentTarget.querySelector("input")?.value) onLeave?.();
      }}
    >
     <div className={`council-bar f-paper${working ? " is-working" : ""}${seat.pending ? " is-pending" : ""}`} data-council-bar>
      <button type="button" className="council-bar-who" onClick={onAbout} aria-label={`${seat.name}: ${state}. Open its details`}>
        <ProviderMark provider={seat.provider} size={18} />
        <b className="council-mark-name" data-council-name data-tip={working && seat.doing ? `${seat.name} · ${seat.doing}` : seat.name}>
          {seat.name}
        </b>
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
          <span className={`council-mark is-state is-${seat.pending ? "working" : seat.status}`} role="img" aria-label={state} data-tip={`Connected · ${state}`} />
        )}
      </button>
      {working && (
        <>
          <span className="council-bar-doing" data-council-doing>
            <span className="council-bar-live" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="council-bar-doing-text">{seat.doing || "working"}</span>
          </span>
          <span className="council-bar-acts">
            {seat.crewId && (
              <button type="button" className={`council-bar-btn${following === seat.crewId ? " is-on" : ""}`} onClick={() => followCrew(following === seat.crewId ? null : seat.crewId!)} data-tip={following === seat.crewId ? "Stop following" : `Follow ${seat.name}: your view rides along until you move`} data-council-follow>
                {following === seat.crewId ? "Following" : "Follow"}
              </button>
            )}
            {seat.mine && session && (
              <button type="button" className="council-bar-btn" onClick={() => openSession({ id: session, kind: "agent", title: titleOf(ask?.prompt ?? seat.name) })} data-tip="Open its session: what it did, step by step" data-council-open-run>
                Open
              </button>
            )}
            {seat.mine && session && live && (
              <button type="button" className="council-bar-btn is-stop" onClick={() => stopSession(session)} data-tip={`Stop ${seat.name}`} data-council-stop>
                Stop
              </button>
            )}
          </span>
        </>
      )}
     </div>
      {/* pressed (2026-11-26, Josh: no box around it): the bar stays as it is, its name and marks where they were, and the
          line to it is a pill of its own right under the bar */}
      {say && <div className="council-bar-say f-paper">{say}</div>}
      {/* what it said back to the last line, while it rests (2026-11-27, plan council-conversation): pressed, the whole conversation */}
      {!say && !working && answer && (
        <button type="button" className={`council-bar-answer f-paper${answer.withheld ? " is-withheld" : ""}`} onClick={onAnswer} data-council-answer={seat.name} data-tip="The whole conversation, in the agents panel">
          {answer.withheld ?? answer.text}
        </button>
      )}
    </div>
  );
}



interface ViewProps {
  title: string;
  /** a section's stands on the section's top edge; the grid's on the window's bottom edge */
  kind: "section" | "board";
  seats: CouncilSeat[];
  /** the one silhouette beside the agents (undefined: a plain figure) */
  ghost?: RosterCharacter;
  canAsk: boolean;
  onSay?: (text: string, to: CouncilSeat[], all: boolean) => void;
  /** press the small silhouette: add an agent */
  onAdd?: () => void;
  /** press an agent, or its card: what it is, on the right */
  onAbout?: (seat: CouncilSeat) => void;
  /** the pointer comes onto an agent, or leaves it: its pane shows a moment later, its trace first */
  onHover?: (seat: CouncilSeat, on: boolean) => void;
  /** the agents panel, on its Council tab */
  onPanel?: () => void;
  panelOpen?: boolean;
  onClose?: () => void;
  /** design page: in the page's flow */
  inline?: boolean;
  /** design page: this seat's line already open */
  hot?: string;
  /** what each seat said back to the last line, by name */
  answers?: Map<string, SeatAnswer>;
}

/** the run a seat's card shows */
const runOf = (s: CouncilSeat) => ({ status: s.offline ? ("idle" as const) : s.pending && s.status !== "working" ? ("pending" as const) : s.status, doing: s.doing, plan: s.plan, thought: s.thought, started: s.started, hue: s.hue });
/** a seat's card takes room beside its figure: a chip or a card, by what there is to show */
const cardRoom = (s: CouncilSeat) => {
  const r = runOf(s);
  if (r.status === "idle") return 0;
  if (r.status === "working" && (r.plan || r.thought)) return 150;
  return 78;
};
/** what of a seat's width doesn't shrink with the council (its card, a bar wider than its figure) and what does (its figure) */
function seatParts(s: CouncilSeat): { fig: number; bar: number; card: number } {
  const card = cardRoom(s);
  return { fig: FIG_H * figureAr(s.character, s.offline), bar: s.status === "working" ? 176 : 58 + s.name.length * 6.6, card: card ? card - 14 : 0 };
}
/** the one scale that fits every seat to the room: figures shrink, cards and bars keep their size (never below 60 %) */
export function fitScale(seats: CouncilSeat[], room: number, extra: { fig: number; fixed: number }): number {
  const parts = seats.map(seatParts);
  let scale = 1;
  for (let k = 0; k < 3; k++) {
    let fixed = extra.fixed;
    let fig = extra.fig;
    for (const p of parts) {
      fixed += p.card;
      // a bar wider than its shrunken figure holds the seat at the bar's width
      if (p.bar > p.fig * scale) fixed += p.bar;
      else fig += p.fig;
    }
    scale = fig > 0 ? Math.max(0.6, Math.min(1, (room - fixed) / fig)) : 1;
  }
  return scale;
}

export function CouncilView({ title, kind, seats, ghost, canAsk, onSay, onAdd, onAbout, onHover, onPanel, panelOpen, onClose, inline, hot, answers }: ViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<AvatarStage | null>(null);
  const [all, setAll] = useState(false);
  // 2026-11-24 (Josh): pressing an agent turns the bar over its head into the line to it
  const [saying, setSaying] = useState<string | null>(hot ?? null);
  // the head's size before it was pressed: the bar grows up and out from there, and nothing beside it moves
  const [headBox, setHeadBox] = useState<{ w: number; h: number } | null>(null);
  // the eyes found on the silhouette's picture (re-render when they are)
  useSyncExternalStore(subEyes, () => eyesV);
  // a still's own proportions, once its picture has loaded (the seat is as wide as its figure needs)
  const [, setMeasured] = useState(0);
  const [avail, setAvail] = useState(0);

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

  // the pictures' own proportions: read when each loads (and any already loaded)
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const take = (img: HTMLImageElement) => {
      if (!img.naturalWidth || !img.naturalHeight || img.closest(".avatar-3d, .avatar-mesh")) return;
      const id = img.closest<HTMLElement>("[data-fig-id]")?.dataset.figId;
      if (!id) return;
      if (img.closest(".council-ghost") && !ghostEyes.has(id)) {
        setGhostEyes(id, eyesOf(img));
      }
      const r = img.naturalWidth / img.naturalHeight;
      if (Math.abs((stillAr.get(id) ?? 0) - r) < 0.004) return;
      stillAr.set(id, r);
      setMeasured((n) => n + 1);
    };
    const onLoad = (e: Event) => e.target instanceof HTMLImageElement && take(e.target);
    el.addEventListener("load", onLoad, true);
    el.querySelectorAll("img").forEach((i) => i.complete && take(i));
    return () => el.removeEventListener("load", onLoad, true);
  });

  // how much paper it has: six seats shrink evenly to fit it, never cropped at the sides
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const ghostSeen = ghost ? ghostEyes.get(ghost.id) : undefined;
  const ghostAr = ghost && ghostSeen ? figureAr(ghost, true) : PLAIN_AR;
  // the grid's leaves the bottom bar its room beside it; the buttons and the council's padding never shrink
  const room = Math.max(0, avail - (kind === "board" && !inline ? 380 : 0));
  const scale = avail ? fitScale(seats, room, { fig: canAsk && onAdd ? FIG_H * ghostAr * (seats.length ? GHOST_PEEK * 0.6 : 1) : 0, fixed: 120 + 32 + 8 }) : 1;

  const mid = (seats.length - 1) / 2;
  const where = title === "this grid" ? "on this grid" : `in ${title}`;

  return (
    <div ref={root} className={`council is-${kind}${inline ? " is-inline" : ""}`} data-council={seats.length} role="group" aria-label={`Council of ${title}`} style={{ ["--council-scale" as string]: scale.toFixed(3) } as CSSProperties}>
      <canvas ref={canvas} className="council-stage" aria-hidden="true" />
      <StageContext.Provider value={stage}>
        <div className="council-row" role="list">
          {seats.map((s, i) => {
            const say = saying === s.id && canAsk && !!onSay;
            const run = runOf(s);
            return (
              <div
                key={s.id}
                role="listitem"
                className={`council-seat is-${s.status}${s.offline ? " is-offline" : ""}${s.pending ? " is-pending" : ""}${say ? " is-saying" : ""}`}
                style={{ ["--crew" as string]: `var(--color-crew-${s.hue % 6})`, ["--i" as string]: i, ["--fig-ar" as string]: figureAr(s.character, s.offline).toFixed(4) } as CSSProperties}
                data-council-seat={s.name}
                data-council-agent={s.agentKey}
                data-mood={s.offline ? "sad" : s.mood}
                onPointerEnter={(e) => e.pointerType !== "touch" && onHover?.(s, true)}
                onPointerLeave={(e) => e.pointerType !== "touch" && onHover?.(s, false)}
              >
                {run.status !== "idle" && (
                  <div className="council-card-slot">
                    <RunCard run={run} variant="seat" onOpen={onAbout ? () => onAbout(s) : undefined} label={`${s.name}'s run: open its details`} />
                  </div>
                )}
                <div className="council-col">
                  <div className="council-head" style={say && headBox ? { minWidth: headBox.w, minHeight: headBox.h } : undefined}>
                    <SeatBar
                      seat={s}
                      answer={answers?.get(s.name)}
                      onAnswer={onPanel}
                      onAbout={onAbout ? () => onAbout(s) : undefined}
                      onLeave={() => setSaying(null)}
                      say={
                        say ? (
                          <SayBox
                            focus={hot !== s.id}
                            label={`Say something to ${s.name}`}
                            placeholder={s.offline ? `${s.why ?? "Not connected"}` : `To ${s.name}${s.agentName && s.agentName !== s.name ? ` (${s.agentName})` : ""}…`}
                            onSay={(t) => {
                              onSay!(t, [s], false);
                              setSaying(null);
                            }}
                            onClose={() => setSaying(null)}
                          />
                        ) : undefined
                      }
                    />
                  </div>
                  <div className="council-crop">
                    <button
                      type="button"
                      className="council-figure"
                      data-fig-id={s.character?.id}
                      aria-label={`${s.name}${s.character ? `, as ${s.character.name}` : ""}: ${s.offline ? `not connected${s.why ? ` (${s.why})` : ""}` : SEAT_STATUS[s.status]}. Press to talk to it`}
                      onClick={(e) => {
                        onAbout?.(s);
                        if (!canAsk || !onSay || saying === s.id) return;
                        const head = e.currentTarget.closest(".council-col")?.querySelector<HTMLElement>(".council-head");
                        setHeadBox(head ? { w: head.offsetWidth, h: head.offsetHeight } : null);
                        // one line open at a time: the line to all of them goes when one agent is pressed
                        setAll(false);
                        setSaying(s.id);
                      }}
                    >
                      <Avatar character={s.character} mood={s.offline ? "sad" : s.mood} framing="bust" turn={(mid - i) * 0.1} still={s.offline} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {canAsk && onAdd && (
            // 2026-11-25 (Josh): one silhouette, asleep, and the + is on it: the silhouette itself adds an agent. Alone on
            // the council it stands full size; beside agents it is much smaller and peeks out from behind the last one's
            // right side, as if around a wall
            <div className={`council-ghosts${seats.length ? " is-peek" : ""}`} role="none" data-council-ghosts={1} data-council-peek={seats.length ? "" : undefined} style={{ ["--fig-ar" as string]: ghostAr.toFixed(4), ["--i" as string]: seats.length } as CSSProperties}>
              <button type="button" className="council-ghost-add" aria-label="Add an agent to this council" data-tip="Add an agent here" data-council-add onClick={onAdd}>
                <span className="council-ghost-fade" role="none">
                  <span className="council-seat council-ghost" role="none">
                    <span className="council-crop">
                      <span className={`council-figure${ghost && !ghostSeen ? " is-reading" : ""}`} data-fig-id={ghost?.id} data-ghost={ghostSeen ? "picture" : "plain"}>
                        {/* a picture whose head can't be found stands as the plain figure, which has eyes */}
                        {ghost && ghostEyes.get(ghost.id) !== null && <Still character={ghost} role={stillRole(ghost, "bust") ?? "thumb"} />}
                        {!ghostSeen && <PlainGhost />}
                        <SleepingEyes eyes={ghostSeen ?? PLAIN_EYES} />
                      </span>
                    </span>
                  </span>
                </span>
                <span className="council-mark is-plus" aria-hidden>
                  <PlusGlyph size={11} />
                </span>
              </button>
            </div>
          )}
          {!seats.length && !canAsk && <p className="council-none">No agents are on this council.</p>}
        </div>

        <div className="council-tools" data-council-tools>
          {canAsk && onSay && (
            <button type="button" className={`council-tool${all ? " is-on" : ""}`} aria-pressed={all} aria-label={seats.length ? `Speak to all ${seats.length} at once` : "Ask an agent"} data-tip={seats.length > 1 ? `Speak to all ${seats.length} at once` : seats.length ? `Speak to ${seats[0].name}` : `Ask an agent ${where}`} data-council-all onClick={() => {
                setAll((a) => !a);
                setSaying(null);
              }}>
              <AllGlyph />
            </button>
          )}
          {onPanel && (
            <button type="button" className={`council-tool${panelOpen ? " is-on" : ""}`} aria-pressed={panelOpen} aria-label={panelOpen ? "Close agents panel" : "Open agents panel"} data-tip="Open the agents panel: the conversation with all of them" data-council-panel onClick={onPanel}>
              <PanelGlyph />
            </button>
          )}
          {onClose && (
            <button type="button" className="council-tool" aria-label="Close council" data-tip="Close" data-kbd="Esc" data-council-close onClick={onClose}>
              <CloseGlyph />
            </button>
          )}
        </div>
        {all && canAsk && onSay && (
          // outside the buttons' own box (2026-11-24): opaque paper over the stage, not under it
          <div className="council-tools-say f-paper">
            <SayBox focus label={seats.length ? "Say something to all of them" : "Ask an agent"} placeholder={seats.length > 1 ? `To all ${seats.length}…` : seats.length ? `To ${seats[0].name}…` : `What should an agent do ${where}?`} onSay={(t) => {
                onSay(t, seats, true);
                setAll(false);
              }} />
          </div>
        )}
      </StageContext.Provider>
    </div>
  );
}

// ---------------------------------------------------------------- who was asked from where

const scopeKey = (s: CouncilScope) => (s.kind === "board" ? GRID_PLACE : s.id);
/** the sessions a council started, and which council: so its agent stays on it while it works */
const launched = new Map<string, string>();
/** the council an agent at work was asked from, if it was asked from one in this window */
function askedFrom(crewId: string): string | undefined {
  const ask = crewAsk(crewId);
  return ask ? launched.get(ask.session) : undefined;
}

/** send one line to a seat's agent, in a section: the server's own agent through a session, one of this computer's through its host. The session, when it's the server's */
export async function tellSeat(seat: Pick<CouncilSeat, "agentKey" | "name" | "alias"> | null, text: string, section: { id: string; name: string } | null, from?: CouncilScope): Promise<string | undefined> {
  const key = seat?.agentKey ?? "claude";
  if (!key.startsWith("t3:")) {
    const session = askCrew(section ? `In the “${section.name}” section: ${text}` : text, seat?.alias, section?.id);
    if (from) launched.set(session, scopeKey(from));
    return session;
  }
  const board = activeBoard()?.boardId;
  const sec = section ?? Object.values(getState().sections).find((s) => !s.parent) ?? null;
  if (!board || !sec) throw new Error("There's no section for it to work in.");
  await api("/api/t3host/threads", { method: "POST", json: { board, section: sec.id, agent: key.slice(3), text, as: seat?.alias } });
  return undefined;
}

/** say one line to some of a council (none: the server's own agent takes it), and keep it for the panel's Council tab */
export function sayToCouncil(scope: CouncilScope, text: string, to: CouncilSeat[], all: boolean, sec: { id: string; name: string } | null) {
  const list: Array<CouncilSeat | null> = to.length ? to : [null];
  const asks = list.map((s) => {
    // its card shows the run starting at once, before the agent has joined (a seat already at work shows its work)
    if (s && !s.crewId && !s.offline) markPending(s.id);
    return tellSeat(s, text, sec, scope).then(
      (session) => {
        if (s && session) pendingSession(s.id, session);
        return { name: s?.name ?? "Claude", ...(session ? { session } : {}) };
      },
      (e: Error) => {
        if (s) clearPending(s.id);
        toast(`${s?.name ?? "Claude"} couldn't take it: ${e.message}`, "bad");
        return { name: s?.name ?? "Claude" };
      },
    );
  });
  logSaid(scope, text, to.length ? to.map((s) => s.name) : ["Claude"], all);
  // the line is kept on the server with the sessions it started, so the conversation outlives this window and reaches the grid
  const board = activeBoard()?.boardId;
  const requestId = `cl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (board) void Promise.all(asks).then((sent) => keepLine(board, scope, text, sent, all, requestId)).catch((e: Error) => toast(`The council's conversation didn't keep that line: ${e.message}`, "bad"));
  toast(to.length > 1 ? `Sent to ${to.length} agents` : `Sent to ${to[0]?.name ?? "Claude"}`, "agent");
}

/** a seat waiting for its agent: it stops waiting when the ask ends without one, or after a while */
function PendingWatch({ id, session, at }: { id: string; session?: string; at: number }) {
  const run = useSession(session ?? null);
  const last = run.turns.at(-1);
  const over = Boolean(session && last && last.status !== "running" && !run.busy);
  useEffect(() => {
    if (over) clearPending(id);
  }, [over, id]);
  useEffect(() => {
    const t = window.setTimeout(() => clearPending(id), Math.max(0, at + PENDING_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [id, at]);
  return null;
}

// ---------------------------------------------------------------- wired to the open grid

/** the council, wired to the open grid */
export function Council() {
  const scope = useCouncilOpen();
  const ui = useUi();
  if (!scope || ui.presenting) return null;
  return <CouncilLive scope={scope} />;
}

/** the one silhouette a grid shows: chosen at random, once per grid for this window */
const ghostPick = new Map<string, number>();

function CouncilLive({ scope }: { scope: CouncilScope }) {
  const ui = useUi();
  const roster = useRoster();
  const board = useActiveBoard();
  const { seats: built, title, sectionId } = useCouncilSeats(scope);
  const waiting = usePending();
  const seats = useMemo(() => built.map((s) => (waiting.has(s.id) && !s.crewId ? { ...s, pending: true } : s)), [built, waiting]);
  // the conversation the server keeps for this council: each seat's answer to the last line rests under its bar
  const kept = useCouncilLines(board?.boardId ?? null, placeOf(scope));
  const answers = useMemo(() => answersBySeat(kept.lines), [kept.lines]);
  const sections = useSyncExternalStore(subscribe, sectionsOf);
  const section = sectionId ? sections[sectionId] : undefined;
  const canAsk = ui.role !== "viewer";
  const ghostKey = seats.map((s) => s.character?.id ?? "").join("|");
  const boardId = board?.boardId ?? "";
  const ghost = useMemo(() => {
    const free = ghostsFor(roster, seats, 64).filter((c): c is RosterCharacter => !!c);
    if (!free.length) return undefined;
    if (!ghostPick.has(boardId)) ghostPick.set(boardId, Math.floor(Math.random() * 1e6));
    return free[ghostPick.get(boardId)! % free.length];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, ghostKey, boardId]);

  // a seat's agent has joined: it isn't waiting any more
  useEffect(() => {
    for (const s of built) if (s.crewId && waiting.has(s.id)) clearPending(s.id);
  }, [built, waiting]);
  // what's over the heads here isn't also in the strip over the bar
  useEffect(() => {
    showOnCouncil(seats.flatMap((s) => (s.crewId ? [s.crewId] : [])));
  }, [seats]);
  useEffect(
    () => () => {
      showOnCouncil([]);
      peekAt(null);
    },
    [],
  );

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
      // Esc in a line clears the line first, as everywhere; in the line over a head, it then puts the line away
      if (t?.closest(".council-say") && ((t as HTMLInputElement).value || t.closest(".council-bar-wrap"))) return;
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

  // the grid's council at the bottom right: how wide it stands, so the bottom bar's room leaves it clear (GridViewport)
  useEffect(() => {
    if (scope.kind !== "board") return;
    const el = standEl.current;
    if (!el) return;
    const measure = () => {
      const row = el.querySelector(".council-row")?.getBoundingClientRect().width ?? 0;
      const tools = el.querySelector(".council-tools")?.getBoundingClientRect().width ?? 0;
      // the figures, the buttons, the gap between them, the council's own right padding, and a gutter before the bar
      setUi({ councilW: Math.ceil(row + tools + 8 + 16 + 16) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const n of el.querySelectorAll(".council-row, .council-tools")) ro.observe(n);
    return () => {
      ro.disconnect();
      setUi({ councilW: 0 });
    };
  }, [scope.kind, seats.length]);

  const sec = section ? { id: section.id, name: section.name } : null;
  const f = floorInsets(ui);
  const stand = (
    <div ref={standEl} className={`council-place is-${scope.kind}`} style={scope.kind === "board" ? { left: f.left, right: f.right, bottom: f.bottom } : undefined} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      {[...waiting].map(([id, p]) => (
        <PendingWatch key={id} id={id} session={p.session} at={p.at} />
      ))}
      <CouncilView
        title={title}
        kind={scope.kind}
        seats={seats}
        ghost={ghost}
        canAsk={canAsk}
        panelOpen={ui.agents && ui.agentsTab === "council"}
        onClose={closeCouncil}
        onAbout={(s) => {
          // a press keeps it: the sheet becomes the pane
          peekAt(null);
          selectSeat(s.id, true);
          setUi({ agentInfo: true });
        }}
        onHover={(s, on) => (on ? peekAt(s.id, 260) : peekAt(null, 420))}
        onPanel={() => setUi(ui.agents && ui.agentsTab === "council" ? { agents: false } : { agents: true, agentsTab: "council" })}
        onAdd={() => setUi({ agents: true, agentsTab: "add" })}
        onSay={(text, to, all) => sayToCouncil(scope, text, to, all, sec)}
        answers={answers}
      />
    </div>
  );
  // a section's lives with its section, in the grid's own space; the grid's is the shell's
  if (scope.kind === "section") return card ? createPortal(stand, card) : null;
  return stand;
}

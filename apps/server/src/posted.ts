/**
 * Agents assigned to a place (2026-11-15). Until now an agent was on a grid only while it worked
 * (its cursor, gone 2.4 s after its run). A council needs to know who *belongs* to a section when
 * nobody is working: so a person assigns agents to a section, or to the whole grid, and they stay
 * until taken off. Assigning starts nothing and spends nothing: it says who answers when the
 * council there is spoken to.
 *
 * Kept in the board's `agents` map (place → PostedAgent[]; a place is a section id, or "*" for the
 * grid), which the server alone writes (boards.ts SERVER_MAPS), so everyone on the grid sees the same
 * council and nobody can forge who's on it over a socket.
 *
 * An agent is named by a key: "claude" is the server's own agent (agent.ts: a Claude Code
 * subscription or API credits); "t3:<id>" is one of this computer's agents (t3host.ts: Claude, Codex,
 * Kimi, DeepSeek… each cloud or local). What each one is (its service, where it runs) is read from
 * those, never taken from the request.
 */

import { GRID_PLACE, boardMaps, logActivity, postedAgentsOf, type PostedAgent, type UserInfo } from "@foundation/protocol";
import { randomBytes } from "node:crypto";
import { runtimes } from "./agent.ts";
import { CREW_NAMES } from "./crew.ts";
import { editBoard, getBoard } from "./boards.ts";
import { HttpError } from "./http.ts";
import { t3Host, type T3Agent } from "./t3host.ts";

export interface AvailableAgent extends Omit<PostedAgent, "by" | "byName" | "at"> {
  /** can take work now */
  ready: boolean;
  /** why not, when it can't */
  why?: string;
}

/** whose model a T3 agent is, from how it's driven and what it was added as */
export function providerOfT3(a: Pick<T3Agent, "driver" | "name" | "added">): string {
  const preset = a.added?.preset?.toLowerCase();
  if (preset === "kimi" || preset === "deepseek" || preset === "claude") return preset;
  const d = `${a.driver} ${a.name}`.toLowerCase();
  if (d.includes("codex") || d.includes("openai") || d.includes("gpt")) return "chatgpt";
  if (d.includes("antigravity") || d.includes("gemini")) return "gemini";
  if (d.includes("grok")) return "grok";
  if (d.includes("cursor")) return "cursor";
  if (d.includes("kimi")) return "kimi";
  if (d.includes("deepseek")) return "deepseek";
  if (d.includes("claude")) return "claude";
  return "agent";
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function t3Service(a: T3Agent): string {
  if (a.added) return a.where === "local" ? `a model server on this computer (${hostOf(a.added.baseUrl)})` : `${hostOf(a.added.baseUrl)}, on your key`;
  return a.account ? `${a.account}, signed in on this computer` : "signed in on this computer";
}

/** every agent that can be assigned: the server's own, then this computer's (when its host runs) */
export function availableAgents(): { agents: AvailableAgent[]; t3: "off" | "starting" | "running" | "error" } {
  const rt = runtimes() as { subscription?: boolean; api?: boolean; script?: boolean; model?: string };
  if (process.env.FOUNDATION_AGENT_SCRIPT === "1") rt.script = true;
  const own = Boolean(rt.subscription || rt.api || rt.script);
  const agents: AvailableAgent[] = [
    {
      key: "claude",
      name: "Claude",
      provider: "claude",
      where: "cloud",
      service: rt.subscription ? "Claude Code on the server, on its Claude subscription" : rt.api ? "the Claude API, on credits" : rt.script ? "a scripted stand-in (tests)" : "not set up on this server",
      model: rt.api && !rt.subscription ? rt.model : undefined,
      tools: true,
      ready: own,
      why: own ? undefined : "Claude Code isn't installed on the server and there's no API key",
    },
  ];
  const host = t3Host();
  for (const a of host.agents) {
    if (!a.enabled) continue;
    agents.push({
      key: `t3:${a.id}`,
      name: a.name,
      provider: providerOfT3(a),
      where: a.where,
      service: t3Service(a),
      model: a.model,
      tools: a.boardTools,
      ready: a.state === "ready",
      why: a.state === "ready" ? undefined : a.state === "sign-in" ? "needs signing in on this computer" : a.state === "missing" ? "not installed on this computer" : (a.message ?? "not ready"),
    });
  }
  return { agents, t3: host.state };
}

function placeName(boardId: string, place: string): string {
  if (place === GRID_PLACE) return "the grid";
  const sec = boardMaps(getBoard(boardId).doc).sections.get(place);
  if (!sec) throw new HttpError(404, "No such section on this grid");
  return sec.name;
}

/** at most this many seats on one council */
export const MAX_SEATS = 6;
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** a name no seat on this grid goes by yet, from the crew's names (winds, birds, stones, stars) */
export function freeAlias(taken: Iterable<string>, seed: string): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const start = hash(seed) % CREW_NAMES.length;
  for (let i = 0; i < CREW_NAMES.length; i++) {
    const n = CREW_NAMES[(start + i * 7) % CREW_NAMES.length];
    if (!used.has(n.toLowerCase())) return n;
  }
  for (let k = 2; ; k++) if (!used.has(`${CREW_NAMES[start]} ${k}`.toLowerCase())) return `${CREW_NAMES[start]} ${k}`;
}

/**
 * Seat an agent on a section's council (or "*": the grid's). 2026-11-17 (Josh: adding Claude a second time "over-rode
 * my first agent … let me spawn another claude session"): every seat is its own, with its own id and its own name from
 * the crew's names, so the same agent can sit twice (each its own sessions, its own character); up to MAX_SEATS.
 */
export function postAgent(boardId: string, place: string, key: string, user: UserInfo): { agents: PostedAgent[]; seat: PostedAgent } {
  const where = placeName(boardId, place);
  const found = availableAgents().agents.find((a) => a.key === key);
  if (!found) throw new HttpError(404, key.startsWith("t3:") ? "That agent isn't on this computer right now. Start this computer's agents in Settings → Agents." : "No such agent");
  return editBoard(boardId, "posted", (doc) => {
    const m = boardMaps(doc);
    const now = postedAgentsOf(doc, place);
    if (now.length >= MAX_SEATS) throw new HttpError(409, `A council holds ${MAX_SEATS} agents at most; take one off first.`);
    const taken: string[] = [];
    for (const list of m.agents.values()) for (const p of Array.isArray(list) ? list : []) taken.push(p.alias ?? p.name);
    const { ready: _ready, why: _why, ...what } = found;
    const seat: PostedAgent = { ...what, by: user.id, byName: user.name, at: Date.now(), id: `seat_${randomBytes(6).toString("hex")}`, alias: freeAlias(taken, `${boardId}:${place}:${key}:${now.length}`) };
    const next = [...now, seat];
    m.agents.set(place, next);
    logActivity(doc, { who: user.name, role: "human", text: `put ${seat.alias} (${found.name}) on the council of ${where}`, objectId: place === GRID_PLACE ? undefined : place });
    return { agents: next, seat };
  });
}

/** take a seat off a council: by its id, or (an older seat, with none) by its agent's key */
export function unpostAgent(boardId: string, place: string, seatOrKey: string, user: UserInfo): PostedAgent[] {
  return editBoard(boardId, "posted", (doc) => {
    const m = boardMaps(doc);
    const now = postedAgentsOf(doc, place);
    const gone = now.find((p) => p.id === seatOrKey) ?? now.find((p) => !p.id && p.key === seatOrKey);
    if (!gone) return now;
    const next = now.filter((p) => p !== gone);
    if (next.length) m.agents.set(place, next);
    else m.agents.delete(place);
    logActivity(doc, { who: user.name, role: "human", text: `took ${gone.alias ?? gone.name} off the council of ${place === GRID_PLACE ? "the grid" : (m.sections.get(place)?.name ?? "a section")}`, objectId: place === GRID_PLACE ? undefined : place });
    return next;
  });
}

/**
 * Seats from before 2026-11-17 have no id and no name of their own (two Claudes on one council were both "Claude",
 * and shared one character). Give each one both, once, at start: idempotent (a seat with an id is left alone). Each
 * keeps the character it wore: the one chosen for its agent's name (a second of the same agent wore "<name> 1", …).
 * `wore(name)` reads that choice, `wear(alias, character)` makes it the seat's own.
 */
export function nameOldSeats(boardId: string, wore: (name: string) => string | undefined, wear: (alias: string, characterId: string) => void): number {
  const m = boardMaps(getBoard(boardId).doc);
  const old = [...m.agents.entries()].some(([, l]) => Array.isArray(l) && l.some((p) => !p.id));
  if (!old) return 0;
  let named = 0;
  editBoard(boardId, "posted", (doc) => {
    const agents = boardMaps(doc).agents;
    const taken: string[] = [];
    for (const l of agents.values()) for (const p of Array.isArray(l) ? l : []) if (p.alias) taken.push(p.alias);
    const worn: string[] = [];
    for (const [place, list] of [...agents.entries()]) {
      if (!Array.isArray(list) || !list.some((p) => !p.id)) continue;
      const next = list.map((p) => {
        // how the council named it for its character before: its agent's name, then "<name> 1", "<name> 2"…
        let was = p.name;
        while (worn.includes(was)) was = `${p.name} ${worn.filter((w) => w === p.name || w.startsWith(`${p.name} `)).length}`;
        worn.push(was);
        if (p.id) return p;
        const alias = freeAlias(taken, `${boardId}:${place}:${p.key}:${p.at}`);
        taken.push(alias);
        const ch = wore(was);
        if (ch) wear(alias, ch);
        named++;
        return { ...p, id: `seat_${randomBytes(6).toString("hex")}`, alias };
      });
      agents.set(place, next);
    }
  });
  return named;
}

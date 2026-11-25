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

import { GRID_PLACE, boardMaps, logActivity, postedAgentsOf, type AgentKind, type PostedAgent, type UserInfo } from "@foundation/protocol";
import { randomBytes } from "node:crypto";
import { runtimes } from "./agent.ts";
import { CLAUDE_KEYS, claudeModels, federationState, kindOfKey, runsSentence } from "./agentkinds.ts";
import { CREW_NAMES } from "./crew.ts";
import { editBoard, getBoard } from "./boards.ts";
import { HttpError } from "./http.ts";
import { t3Host, type T3Agent } from "./t3host.ts";

export interface AvailableAgent extends Omit<PostedAgent, "by" | "byName" | "at"> {
  /** what it is (docs/agent-harness.md §1): always set on what's available */
  kind: AgentKind;
  /** one sentence: where it runs and who pays */
  runs: string;
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

/**
 * every agent that can be assigned: the server's own three kinds of Claude (its Claude Code sign-in, its API
 * key, its federated identity), then this computer's T3 agents (when its host runs). Each says its kind and,
 * in a sentence, where it runs and who pays. The scripted stand-in (tests) answers for all three Claudes.
 */
export function availableAgents(): { agents: AvailableAgent[]; t3: "off" | "starting" | "running" | "error" } {
  const rt = runtimes();
  const script = process.env.FOUNDATION_AGENT_SCRIPT === "1";
  const fed = federationState();
  const agents: AvailableAgent[] = [
    {
      key: CLAUDE_KEYS.account,
      kind: "claude-account",
      name: "Claude",
      provider: "claude",
      where: "cloud",
      service: rt.subscription ? "Claude Code on the server, on its Claude subscription" : script ? "a scripted stand-in (tests)" : "Claude Code isn't set up on the server",
      runs: runsSentence("claude-account"),
      tools: true,
      ready: rt.subscription || script,
      ...(rt.subscription || script ? {} : { why: `Claude Code can't start on the server: ${rt.subscriptionNote ?? "it isn't installed"}` }),
    },
    {
      key: CLAUDE_KEYS.api,
      kind: "claude-api",
      name: "Claude (API key)",
      provider: "claude",
      where: "cloud",
      service: rt.api ? `the Anthropic API, on Foundation's key (${rt.model})` : script ? "a scripted stand-in (tests)" : "the Anthropic API, once an admin adds a key",
      model: rt.model,
      runs: runsSentence("claude-api"),
      tools: true,
      ready: rt.api || script,
      ...(rt.api || script ? {} : { why: "No API key yet: an admin adds one in Settings → Agents." }),
    },
    {
      key: CLAUDE_KEYS.federated,
      kind: "claude-federated",
      name: "Claude (federated)",
      provider: "claude",
      where: "cloud",
      service: fed.configured ? `the Anthropic API, on your organization's workspace (${rt.model})` : script ? "a scripted stand-in (tests)" : "the Anthropic API, once federated identity is set up",
      model: rt.model,
      runs: runsSentence("claude-federated"),
      tools: true,
      ready: fed.configured || script,
      ...(fed.configured || script ? {} : { why: fed.why }),
    },
  ];
  const host = t3Host();
  for (const a of host.agents) {
    if (!a.enabled) continue;
    const service = t3Service(a);
    agents.push({
      key: `t3:${a.id}`,
      kind: "t3",
      name: a.name,
      provider: providerOfT3(a),
      where: a.where,
      service,
      runs: runsSentence("t3", { service }),
      model: a.model,
      tools: a.boardTools,
      ready: a.state === "ready",
      why: a.state === "ready" ? undefined : a.state === "sign-in" ? "needs signing in on this computer" : a.state === "missing" ? "not installed on this computer" : (a.message ?? "not ready"),
    });
  }
  return { agents, t3: host.state };
}

/** a seat's kind as the server knows it: from its key (older seats carry none) */
export function seatKind(seat: Pick<PostedAgent, "key">): AgentKind {
  return kindOfKey(seat.key) ?? "claude-account";
}

/**
 * The seat an ask is for, on this grid: by its id, else by the name it goes by (the client's `as`). Only to
 * learn which seat it is: what it runs as is then the seat's, from the server's own record.
 */
export function findSeat(boardId: string, ref: { seat?: unknown; as?: unknown }): PostedAgent | undefined {
  const id = typeof ref.seat === "string" ? ref.seat : "";
  const alias = typeof ref.as === "string" ? ref.as.trim() : "";
  if (!id && !alias) return undefined;
  const all: PostedAgent[] = [];
  for (const list of boardMaps(getBoard(boardId).doc).agents.values()) if (Array.isArray(list)) all.push(...list);
  return (id ? all.find((p) => p.id === id) : undefined) ?? (alias ? all.find((p) => (p.alias ?? p.name) === alias) : undefined);
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
export function postAgent(boardId: string, place: string, key: string, user: UserInfo, model?: string): { agents: PostedAgent[]; seat: PostedAgent } {
  const where = placeName(boardId, place);
  const found = availableAgents().agents.find((a) => a.key === key);
  if (!found) throw new HttpError(404, key.startsWith("t3:") ? "That agent isn't on this computer right now. Start this computer's agents in Settings → Agents." : "No such agent");
  if (model !== undefined && found.kind !== "claude-api" && found.kind !== "claude-federated") throw new HttpError(400, "Only a Claude on the API (an API key or federated identity) takes a model of its own.");
  return editBoard(boardId, "posted", (doc) => {
    const m = boardMaps(doc);
    const now = postedAgentsOf(doc, place);
    if (now.length >= MAX_SEATS) throw new HttpError(409, `A council holds ${MAX_SEATS} agents at most; take one off first.`);
    const taken: string[] = [];
    for (const list of m.agents.values()) for (const p of Array.isArray(list) ? list : []) taken.push(p.alias ?? p.name);
    // what it is, as the server reads it now; a Claude on the API carries no model of its own, so it follows the default
    const { ready: _ready, why: _why, runs: _runs, ...what } = found;
    if (what.kind === "claude-api" || what.kind === "claude-federated") {
      delete what.model;
      // …unless the person adding it chose one for this seat (seatModel checked it)
      if (model) what.model = model;
    }
    const seat: PostedAgent = { ...what, by: user.id, byName: user.name, at: Date.now(), id: `seat_${randomBytes(6).toString("hex")}`, alias: freeAlias(taken, `${boardId}:${place}:${key}:${now.length}`) };
    const next = [...now, seat];
    m.agents.set(place, next);
    logActivity(doc, { who: user.name, role: "human", text: `put ${seat.alias} (${found.name}) on the council of ${where}`, objectId: place === GRID_PLACE ? undefined : place });
    return { agents: next, seat };
  });
}

const SEAT_MODEL = /^claude-[a-z0-9.-]{2,80}$/;

/**
 * A model a person chose for one claude-api or claude-federated seat: a Claude model id, and one on the list when
 * the list is Anthropic's own (the built-in list may lag behind it, as for the default). Undefined: none chosen.
 */
export async function seatModel(raw: unknown): Promise<string | undefined> {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const model = typeof raw === "string" ? raw.trim() : "";
  if (!SEAT_MODEL.test(model)) throw new HttpError(400, "Name a Claude model id (claude-…), as the model list gives it.");
  const list = await claudeModels();
  if (list.source === "live" && !list.models.some((m) => m.id === model)) throw new HttpError(400, `${model} isn't one of the models this server's Claude can use.`);
  return model;
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

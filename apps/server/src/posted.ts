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
import { runtimes } from "./agent.ts";
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
  if (preset === "kimi" || preset === "deepseek") return preset;
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

/** assign an agent to a section (or "*": the grid). Once per place. */
export function postAgent(boardId: string, place: string, key: string, user: UserInfo): PostedAgent[] {
  const where = placeName(boardId, place);
  const found = availableAgents().agents.find((a) => a.key === key);
  if (!found) throw new HttpError(404, key.startsWith("t3:") ? "That agent isn't on this computer right now. Start this computer's agents in Settings → Agents." : "No such agent");
  return editBoard(boardId, "posted", (doc) => {
    const m = boardMaps(doc);
    const now = postedAgentsOf(doc, place);
    if (now.some((p) => p.key === key)) return now;
    const { ready: _ready, why: _why, ...what } = found;
    const next = [...now, { ...what, by: user.id, byName: user.name, at: Date.now() }];
    m.agents.set(place, next);
    logActivity(doc, { who: user.name, role: "human", text: `put ${found.name} on the council of ${where}`, objectId: place === GRID_PLACE ? undefined : place });
    return next;
  });
}

export function unpostAgent(boardId: string, place: string, key: string, user: UserInfo): PostedAgent[] {
  return editBoard(boardId, "posted", (doc) => {
    const m = boardMaps(doc);
    const now = postedAgentsOf(doc, place);
    const gone = now.find((p) => p.key === key);
    if (!gone) return now;
    const next = now.filter((p) => p.key !== key);
    if (next.length) m.agents.set(place, next);
    else m.agents.delete(place);
    logActivity(doc, { who: user.name, role: "human", text: `took ${gone.name} off the council of ${place === GRID_PLACE ? "the grid" : (m.sections.get(place)?.name ?? "a section")}`, objectId: place === GRID_PLACE ? undefined : place });
    return next;
  });
}

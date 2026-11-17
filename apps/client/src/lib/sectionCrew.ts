/**
 * Which agents are in which section, and which of them work together.
 *
 * An agent of the crew says what it's aiming at (a card or a section; see
 * apps/server/src/crew.ts). The section that holds that target is where the
 * agent is: it joins that section's group when it aims there and leaves it
 * when it aims somewhere else. A section that holds sections also counts the
 * agents in them, so a grid seen from above still shows who's inside.
 *
 * Working together: an agent that called helpers in is their lead, and the
 * lead with its helpers is one team (one person's ask). Agents on different
 * asks in the same section are side by side, not together.
 *
 * Pure: no store, no DOM, so it's tested as it is (test/section-crew.test.ts).
 */

export interface CrewLike {
  id: string;
  /** the agent that called this one in (its crew id) */
  lead?: string;
  target: { id: string; kind: "object" | "section" } | null;
}

export interface CrewWhere {
  /** a card's section (undefined: no such card on this board) */
  sectionOfObject(id: string): string | undefined;
  /** a section's parent section (undefined: it sits on the board, or isn't there) */
  parentOf(id: string): string | undefined;
  hasSection(id: string): boolean;
}

/** the section an agent is in: the one it aims at, or the one that holds the card it aims at (null: nowhere yet) */
export function sectionOfCrew(c: CrewLike, where: CrewWhere): string | null {
  if (!c.target) return null;
  const id = c.target.kind === "section" ? c.target.id : where.sectionOfObject(c.target.id);
  return id && where.hasSection(id) ? id : null;
}

/** a section and every section it sits inside, nearest first (a loop in the data ends the walk) */
export function sectionChain(id: string, where: CrewWhere): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let at: string | undefined = id;
  while (at && !seen.has(at)) {
    seen.add(at);
    out.push(at);
    at = where.parentOf(at);
  }
  return out;
}

/** is this agent in the section, or in a section inside it */
export function crewIsIn<T extends CrewLike>(c: T, sectionId: string, where: CrewWhere): boolean {
  const at = sectionOfCrew(c, where);
  return at !== null && sectionChain(at, where).includes(sectionId);
}

export interface CrewTeam<T> {
  /** the lead's crew id (an agent on its own leads itself) */
  id: string;
  /** the lead first when it's here, then its helpers in the order given */
  members: T[];
  /** two or more on one ask: they share a plan and see each other's work */
  together: boolean;
}

/** the team an agent belongs to: its lead's id, or its own */
export const teamOf = (c: CrewLike) => c.lead ?? c.id;

/** group agents into teams, in the order their first member appears; a lead stands first in its team */
export function crewTeams<T>(crew: T[], of: (x: T) => CrewLike): CrewTeam<T>[] {
  const teams = new Map<string, CrewTeam<T>>();
  for (const x of crew) {
    const c = of(x);
    const id = teamOf(c);
    let t = teams.get(id);
    if (!t) teams.set(id, (t = { id, members: [], together: false }));
    if (c.id === id) t.members.unshift(x);
    else t.members.push(x);
  }
  for (const t of teams.values()) t.together = t.members.length > 1;
  return [...teams.values()];
}

/**
 * How the agents in one place stand to each other, in a few words:
 * "" for none or one, "working together" for one team, "2 teams" when
 * several asks meet here, "3 on their own" when nobody shares an ask.
 */
export function togetherWords<T>(teams: CrewTeam<T>[]): string {
  const n = teams.reduce((a, t) => a + t.members.length, 0);
  if (n < 2) return "";
  if (teams.length === 1) return "working together";
  if (teams.every((t) => !t.together)) return `${n} on their own`;
  return `${teams.length} teams`;
}

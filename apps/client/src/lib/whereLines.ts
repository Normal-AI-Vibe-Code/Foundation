/** who is where, put into words and lists (pure: lib/whereabouts.ts keeps the state) */

import type { WhereAgent, WhereBoard, WherePerson } from "@foundation/protocol";

/** who else is on a grid (not me), and its agents */
export function othersOn(all: Record<string, WhereBoard>, boardId: string, me: string | undefined): { people: WherePerson[]; agents: WhereAgent[] } {
  const w = all[boardId];
  if (!w) return { people: [], agents: [] };
  return { people: w.people.filter((p) => p.id !== me), agents: w.agents };
}

/** the grids a person is on right now */
export function gridsOf(all: Record<string, WhereBoard>, personId: string): string[] {
  return Object.entries(all)
    .filter(([, w]) => w.people.some((p) => p.id === personId))
    .map(([id]) => id);
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** one line for a grid's row: "Ada and Kai are here · Lark is at work" */
export function hereLine(people: WherePerson[], agents: WhereAgent[]): string {
  const parts: string[] = [];
  if (people.length) parts.push(`${list(people.map((p) => p.name))} ${people.length === 1 ? "is" : "are"} here`);
  const working = agents.filter((a) => a.status === "working");
  if (working.length) parts.push(`${list(working.map((a) => (a.doing ? `${a.name} (${a.doing})` : a.name)))} ${working.length === 1 ? "is" : "are"} at work`);
  const resting = agents.filter((a) => a.status !== "working");
  if (resting.length) parts.push(`${list(resting.map((a) => a.name))} ${resting.length === 1 ? "is" : "are"} on it`);
  return parts.join(" · ");
}

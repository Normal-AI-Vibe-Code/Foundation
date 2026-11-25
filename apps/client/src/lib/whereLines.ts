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
    .filter(([, w]) => w.people.some((p) => p.id === personId || p.chatId === personId))
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

const sameName = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Who is where, from two servers at once (2026-11-25): Foundation's own answer (`own`: it reads its grids'
 * presence) and what a chat server of its own relays from other computers (`chat`: each window tells it which grid
 * it has open). A person is listed once per grid: Foundation's entry stands, and the chat server's entry for the
 * same person (the same id, or, as the two servers give one person two ids, the same name) only adds its id there
 * as `chatId`, so a conversation's member can be found by either. Someone only the chat server knows of is added.
 * Agents are Foundation's alone (a chat server has none at work on a grid).
 *
 * `knows` says which grids this person can see: a grid the chat server names that isn't one of them is dropped,
 * so nothing is shown (not even "on a grid") about a grid this person couldn't open.
 */
export function mergeWhere(own: Record<string, WhereBoard>, chat: Record<string, WhereBoard>, knows: (boardId: string) => boolean = () => true): Record<string, WhereBoard> {
  const out: Record<string, WhereBoard> = { ...own };
  for (const [id, theirs] of Object.entries(chat)) {
    if (!knows(id) || !theirs?.people?.length) continue;
    const mine = out[id] ?? { people: [], agents: [] };
    const people = mine.people.map((p) => ({ ...p }));
    for (const t of theirs.people) {
      const had = people.find((p) => p.id === t.id || p.chatId === t.id) ?? people.find((p) => !p.chatId && sameName(p.name, t.name));
      if (!had) people.push({ id: t.id, name: t.name, color: t.color, chatId: t.id });
      else if (had.id !== t.id) had.chatId = t.id;
    }
    out[id] = { people: people.sort((a, b) => a.name.localeCompare(b.name)), agents: mine.agents };
  }
  return out;
}

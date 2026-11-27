/**
 * Who a ping can go to, the pure part (2026-11-27, Josh: "a ping command in the right context menu that we could
 * select someone that we've recently pinged, or someone who is working in that board or has items associated to
 * them"). chat/ping.ts gathers the inputs and sends; chat/PingPicker.tsx draws the list.
 *
 * Four groups, each party once, in the first group they're in:
 *  - **Recent**: whom I pinged last, on any grid (this device's);
 *  - **On this**: who made the card, or whom it's assigned to;
 *  - **Here now**: people and agents on this grid right now;
 *  - **Worked here**: the grid's workers (protocol `workers`), the most recent first.
 * Never me. A person is their user id; an agent is `agent:<name>`, as a chat mention names it.
 */

import { agentWorkerId, type WorkerDoc } from "@foundation/protocol";

export type PingKind = "person" | "agent";

export interface PingWho {
  id: string;
  name: string;
  kind: PingKind;
}

export interface PingRow extends PingWho {
  /** a few words on why they're offered: "pinged 2h ago", "made this", "here now", "worked here yesterday" */
  detail: string;
}

export interface PingGroup {
  id: "recent" | "card" | "here" | "worked";
  title: string;
  rows: PingRow[];
}

export interface RecentPing extends PingWho {
  at: number;
}

export interface PingInputs {
  meId?: string;
  recent: RecentPing[];
  /** names the card carries: who made it (`createdBy`), whom it's for (`assignee`) */
  card?: { createdBy?: string; assignee?: string } | null;
  here: { people: Array<{ id: string; name: string }>; agents: Array<{ name: string; status?: string }> };
  workers: WorkerDoc[];
  /** everyone chat knows, to put an id to a name on a card */
  people?: Array<{ id: string; name: string }>;
  now?: number;
}

export const RECENT_MAX = 12;

/** how long ago, in a word or two */
export function agoWords(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : "a while ago";
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** a name on a card, as a party: a worker or a person chat knows by that name, else nobody */
function partyByName(name: string, i: PingInputs): PingWho | null {
  const w = i.workers.find((x) => same(x.name, name));
  if (w) return { id: w.id, name: w.name, kind: w.kind };
  const p = i.people?.find((x) => same(x.name, name));
  if (p) return { id: p.id, name: p.name, kind: "person" };
  return null;
}

export function pingGroups(i: PingInputs): PingGroup[] {
  const now = i.now ?? Date.now();
  const taken = new Set<string>();
  if (i.meId) taken.add(i.meId);
  const take = (rows: PingRow[]) =>
    rows.filter((r) => {
      if (!r.id || taken.has(r.id)) return false;
      taken.add(r.id);
      return true;
    });

  const recent = take([...i.recent].sort((a, b) => b.at - a.at).slice(0, 6).map((r) => ({ id: r.id, name: r.name, kind: r.kind, detail: `pinged ${agoWords(r.at, now)}` })));

  const cardRows: PingRow[] = [];
  if (i.card?.createdBy) {
    const p = partyByName(i.card.createdBy, i);
    if (p) cardRows.push({ ...p, detail: "made this" });
  }
  if (i.card?.assignee) {
    const p = partyByName(i.card.assignee, i);
    if (p) cardRows.push({ ...p, detail: "assigned this" });
  }
  const card = take(cardRows);

  const here = take([
    ...i.here.people.map((p) => ({ id: p.id, name: p.name, kind: "person" as const, detail: "here now" })),
    ...i.here.agents.map((a) => ({ id: agentWorkerId(a.name), name: a.name, kind: "agent" as const, detail: a.status === "working" ? "working here now" : "here now" })),
  ]);

  const worked = take(
    [...i.workers]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 30)
      .map((w) => ({ id: w.id, name: w.name, kind: w.kind, detail: `worked here ${agoWords(w.lastAt, now)}${w.kind === "agent" && w.for ? ` · for ${w.for}` : ""}` })),
  );

  const groups: PingGroup[] = [
    { id: "recent", title: "Recent", rows: recent },
    { id: "card", title: "On this", rows: card },
    { id: "here", title: "Here now", rows: here },
    { id: "worked", title: "Worked on this grid", rows: worked },
  ];
  return groups.filter((g) => g.rows.length);
}

/** the groups narrowed to a typed filter (by name, any part) */
export function filterGroups(groups: PingGroup[], q: string): PingGroup[] {
  const t = q.trim().toLowerCase().replace(/^@/, "");
  if (!t) return groups;
  return groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.name.toLowerCase().includes(t)) })).filter((g) => g.rows.length);
}

/** the recent list with one more ping: newest first, each party once, `RECENT_MAX` at most */
export function addRecent(list: RecentPing[], who: PingWho, at = Date.now()): RecentPing[] {
  return [{ id: who.id, name: who.name, kind: who.kind, at }, ...list.filter((r) => r.id !== who.id)].slice(0, RECENT_MAX);
}

/** what a ping says: the @handle, then what about */
export function pingText(handle: string, label?: string): string {
  return `@${handle} 👋 ${label ? `pinged you about “${label}”` : "pinged you"}`;
}

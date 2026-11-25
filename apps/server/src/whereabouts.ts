/**
 * Who is where (Josh, 2026-11-21: "show when people are in the boards and collaborating, as well as the agents").
 *
 * Every open grid already knows who is on it: each person's window and each agent at work keep a presence in the
 * grid's awareness (boards.ts, crew.ts). This reads them for every grid at once, so a person can see, outside the
 * grid, who is in which: the side menu's rows and ChatForm's people say so.
 *
 * - **Who.** A person once per grid, however many windows they have on it, known and named by the account their sync
 *   socket signed in as (never by the name a window claims; only the cursor colour is the window's). An agent by its crew presence: its name, colour, what it's
 *   doing and who asked it.
 * - **Who may see it.** Only the grids the asking person can see (members.ts): a restricted grid's people and agents
 *   are never shown to someone outside it.
 * - **When.** `GET /api/whereabouts` for the first look; then, over the chat socket every signed-in window holds, a
 *   `where` event when who is where changes. A cursor moving isn't a change: changes are gathered for a moment and
 *   sent only if the list itself is different.
 */

import type { UserInfo, WhereAgent, WhereBoard, WherePerson } from "@foundation/protocol";
import { liveBoardIds, onBoardOpen, onBoardsClosed, whoIsOn } from "./boards.ts";
import { canSeeBoard } from "./members.ts";
import { one } from "./db.ts";

const accountName = (id: string, claimed: string) => one<{ name: string }>("select name from users where id = ?", id)?.name || claimed;

/** how long changes are gathered before anyone is told (a person arriving opens several sockets in a row) */
export const WHERE_SETTLE_MS = 400;

const STATUSES = new Set<WhereAgent["status"]>(["working", "done", "stopped", "error", "idle"]);

/** who is on one grid (empty lists when nobody is) */
export function whereOn(boardId: string): WhereBoard {
  const { people, agents } = whoIsOn(boardId);
  const seen = new Map<string, WherePerson>();
  for (const p of people) if (!seen.has(p.id)) seen.set(p.id, { id: p.id, name: accountName(p.id, p.name).slice(0, 80), color: p.color });
  return {
    people: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    agents: agents
      .map((a): WhereAgent => ({
        id: a.id,
        name: String(a.name ?? "Agent").slice(0, 80),
        hue: Number.isFinite(a.hue) ? Math.abs(Math.trunc(a.hue)) % 6 : 0,
        via: String(a.via ?? "claude").slice(0, 80),
        status: STATUSES.has(a.status as WhereAgent["status"]) ? (a.status as WhereAgent["status"]) : "working",
        ...(a.doing ? { doing: String(a.doing).slice(0, 160) } : {}),
        ...(a.askerName ? { askerName: String(a.askerName).slice(0, 80) } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** who is on every grid this person can see, leaving out grids nobody is on */
export function whereaboutsFor(user: UserInfo): Record<string, WhereBoard> {
  const out: Record<string, WhereBoard> = {};
  for (const id of liveBoardIds()) {
    if (!canSeeBoard(user, id)) continue;
    const w = whereOn(id);
    if (w.people.length || w.agents.length) out[id] = w;
  }
  return out;
}

/** the whole picture, as a key: equal keys, nothing to tell anyone */
function picture(): string {
  const all: Record<string, WhereBoard> = {};
  for (const id of liveBoardIds()) {
    const w = whereOn(id);
    if (w.people.length || w.agents.length) all[id] = w;
  }
  return JSON.stringify(all);
}

type Tell = (forUser: (user: UserInfo) => Record<string, WhereBoard>) => void;
let tell: Tell | null = null;
let timer: NodeJS.Timeout | null = null;
let last = "{}";

/** chatsock.ts hands over how to reach every window; until then changes are only remembered */
export function setWhereTeller(fn: Tell | null) {
  tell = fn;
}

/** something about who is on a grid may have changed: tell everyone, once it settles, if it did */
export function whereMayHaveChanged() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const now = picture();
    if (now === last) return;
    last = now;
    tell?.(whereaboutsFor);
  }, WHERE_SETTLE_MS);
  timer.unref?.();
}

onBoardOpen((board) => board.awareness.on("change", whereMayHaveChanged));
onBoardsClosed(() => {
  if (timer) clearTimeout(timer);
  timer = null;
  last = "{}";
});

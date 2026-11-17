/**
 * The crew: every agent turn is someone you can see. Each run gets a
 * generated name, a colour and its own presence on the board, a client of
 * the board's awareness like a person's browser, so several agents can work
 * at once and everyone can tell them apart. (Before, every agent on a board
 * shared the server's one presence.)
 *
 * An agent's presence says what it's aiming at (`target`, a card or section
 * id), what it's doing in a few words, who asked, and, when it wants to show
 * the person who asked something, a `guide` for that person's camera. The
 * browsers draw the cursor and glide it to the target; the server only says
 * where. Writes wait a beat after aiming (`travelMs`), so the cursor gets
 * there before the change lands and people can follow the work.
 *
 * Each agent is its own Awareness on its own small Y.Doc (its own clientID),
 * bridged into the board's awareness. The Awareness renews itself every 15 s,
 * so a long turn never times out on anyone's screen, and leaving removes it
 * everywhere: no ghost cursors.
 */

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { boardMaps, findSection } from "@foundation/protocol";
import { getBoard } from "./boards.ts";

/** short, unlike anyone's real name: winds, birds, stones, stars */
export const CREW_NAMES = [
  "Wren", "Kestrel", "Basalt", "Mistral", "Quartz", "Heron", "Cobalt", "Zephyr",
  "Lark", "Garnet", "Sirocco", "Tern", "Flint", "Vega", "Plover", "Onyx",
  "Bora", "Finch", "Jasper", "Altair", "Swift", "Mica", "Petrel", "Rigel",
  "Ibis", "Cinder", "Lyra", "Shale", "Merlin", "Talc", "Gannet", "Deneb",
];

/** a council seat's name, as a cursor may wear it: a word or two of letters, at most 24 (anything else: the crew picks one) */
export function seatName(raw: unknown): string | undefined {
  return typeof raw === "string" && /^\p{L}[\p{L}\p{N} '-]{0,23}$/u.test(raw.trim()) ? raw.trim() : undefined;
}

/** how many hues the browsers know (violet mixes on tokens; DESIGN §2) */
export const CREW_HUES = 6;
/** helpers one ask may call in, and agents one board may hold at once */
export const MAX_HELPERS = 2;
export const MAX_CREW_PER_BOARD = 6;

export interface CrewTarget {
  /** a card or section id */
  id: string;
  kind: "object" | "section";
  /** point_at: a cell of a table ("B3"), drawn as a laser on it */
  cell?: string;
  /** point_at: a port of a panel (its id or name) */
  port?: string;
}

export interface CrewGuide {
  /** the person whose camera it is: always the one who asked */
  to: string;
  target: CrewTarget;
  name: string;
  note?: string;
  nonce: number;
}

export interface CrewState {
  user: { name: string; color: string; agent: true };
  crew: {
    id: string;
    hue: number;
    /** the person who asked */
    asker: string;
    askerName: string;
    /** the agent that called this one in */
    lead?: string;
    leadName?: string;
    task: string;
    /** which agent this is: "claude" (the server's own) or "t3:<id>" (one of this computer's). A council seats it where that agent is assigned */
    via: string;
    doing: string;
    target: CrewTarget | null;
    guide: CrewGuide | null;
    status: "working" | "done" | "stopped" | "error";
    at: number;
  };
  /** the ring the agent layer draws (as before) */
  focus: string | null;
}

export interface CrewMember {
  id: string;
  name: string;
  hue: number;
  boardId: string;
  userId: string;
  userName: string;
  runId: string;
  lead?: CrewMember;
  helpers: number;
  clientId: number;
  awareness: awarenessProtocol.Awareness;
  doc: Y.Doc;
  state: CrewState;
  left: boolean;
  joinedAt: number;
  /** the plan this agent showed (set_plan): a lead's goes to its helpers */
  plan?: { goal: string; steps: Array<{ text: string; status: string }> };
  /** sections this agent made, and cards it wrote (with createdBy, the board's word for it) */
  sections: string[];
  made: Set<string>;
  /** a lead's crew: itself, then each helper it called in (kept after they finish, so later ones see their work) */
  team: CrewMember[];
}

const members = new Map<string, CrewMember>();
let seq = 0;

export function travelMs() {
  const v = Number(process.env.FOUNDATION_CREW_TRAVEL_MS ?? "520");
  return Number.isFinite(v) && v >= 0 ? v : 520;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function crewOn(boardId: string): CrewMember[] {
  return [...members.values()].filter((m) => m.boardId === boardId && !m.left);
}

export function crewMember(id: string | null | undefined): CrewMember | undefined {
  const m = id ? members.get(id) : undefined;
  return m && !m.left ? m : undefined;
}

/** a name nobody else on this board is using right now, picked from the run id */
function pickName(boardId: string, seed: string) {
  const taken = new Set(crewOn(boardId).map((m) => m.name));
  const start = hash(seed) % CREW_NAMES.length;
  for (let i = 0; i < CREW_NAMES.length; i++) {
    const n = CREW_NAMES[(start + i * 7) % CREW_NAMES.length];
    if (!taken.has(n)) return n;
  }
  return `${CREW_NAMES[start]} ${crewOn(boardId).length + 1}`;
}

/** a name an agent brings with it, told apart when it's already on the board */
function ownName(boardId: string, name: string) {
  const taken = new Set(crewOn(boardId).map((m) => m.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
}

function pickHue(boardId: string, seed: string) {
  const taken = new Set(crewOn(boardId).map((m) => m.hue));
  const start = hash(seed + "/hue") % CREW_HUES;
  for (let i = 0; i < CREW_HUES; i++) if (!taken.has((start + i) % CREW_HUES)) return (start + i) % CREW_HUES;
  return start;
}

/** an agent arrives on the board: a name, a colour and a presence everyone sees */
export function joinCrew(opts: { boardId: string; userId: string; userName: string; runId: string; task: string; lead?: CrewMember; /** its own name (a T3 agent: "Kimi"); a second one on the board is "Kimi 2" */ name?: string; /** the agent's key ("t3:<id>"); the server's own when absent */ via?: string }): CrewMember {
  if (opts.lead && opts.lead.left) throw new Error("the agent that called for help has finished");
  if (crewOn(opts.boardId).length >= MAX_CREW_PER_BOARD) throw new Error(`this board already has ${MAX_CREW_PER_BOARD} agents working; wait for one to finish`);
  const board = getBoard(opts.boardId);
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const id = `crew_${(++seq).toString(36)}${hash(opts.runId).toString(36).slice(0, 4)}`;
  const name = opts.name ? ownName(opts.boardId, opts.name) : pickName(opts.boardId, opts.runId);
  const hue = pickHue(opts.boardId, opts.runId);
  const m: CrewMember = {
    id,
    name,
    hue,
    boardId: opts.boardId,
    userId: opts.userId,
    userName: opts.userName,
    runId: opts.runId,
    lead: opts.lead,
    helpers: 0,
    clientId: doc.clientID,
    awareness,
    doc,
    left: false,
    joinedAt: Date.now(),
    sections: [],
    made: new Set(),
    team: [],
    state: {
      user: { name, color: "#6b5bd6", agent: true },
      crew: {
        id,
        hue,
        asker: opts.userId,
        askerName: opts.userName,
        lead: opts.lead?.id,
        leadName: opts.lead?.name,
        task: opts.task.slice(0, 200),
        via: opts.via ?? "claude",
        doing: opts.lead ? `called in by ${opts.lead.name}` : "reading the ask",
        target: null,
        guide: null,
        status: "working",
        at: Date.now(),
      },
      focus: null,
    },
  };
  // bridge: every change to this agent's presence (and its 15 s renewals) reaches the board
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const changed = added.concat(updated, removed);
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
    awarenessProtocol.applyAwarenessUpdate(board.awareness, update, "crew");
  });
  members.set(id, m);
  // one crew per ask: the lead and every helper it calls in
  const root = opts.lead ? (opts.lead.lead ?? opts.lead) : m;
  root.team.push(m);
  publish(m);
  return m;
}

/**
 * What a crew has done on an ask so far, for any agent on it: the ask, the
 * lead's plan, and each agent's state, what it's doing now, and the sections
 * and cards it made. Helpers read it (crew_work, and their brief) so two of
 * them don't make the same thing.
 */
export function crewWork(m: CrewMember) {
  const root = m.lead ?? m;
  const bm = boardMaps(getBoard(m.boardId).doc);
  const sectionName = (id: string) => bm.sections.get(id)?.name ?? null;
  const objects = [...bm.objects.values()];
  return {
    ask: root.state.crew.task,
    asker: root.userName,
    lead: root.name,
    you: m.name,
    plan: root.plan ?? null,
    crew: root.team.map((t) => ({
      name: t.name,
      role: t === root ? "lead" : "helper",
      working: !t.left,
      ...(t === root ? {} : { task: t.state.crew.task }),
      doing: t.state.crew.doing,
      sections: t.sections.map(sectionName).filter(Boolean),
      made: objects
        .filter((o) => o.createdBy === t.name && (t.made.has(o.id) || o.bornAt >= t.joinedAt))
        .map((o) => ({ id: o.id, kind: o.kind === "panel" ? o.panel : o.kind, name: o.name, section: sectionName(o.sectionId) })),
    })),
  };
}

/** crewWork in words, for a helper's brief */
export function describeCrewWork(m: CrewMember): string {
  const w = crewWork(m);
  const lines: string[] = [];
  if (w.plan) lines.push(`${w.lead}'s plan: ${w.plan.goal}${w.plan.steps.length ? ` (${w.plan.steps.map((s) => `${s.text}: ${s.status}`).join("; ")})` : ""}`);
  for (const c of w.crew) {
    if (c.name === m.name) continue;
    const made = c.made.length ? c.made.map((x) => `${x.kind} “${x.name}”${x.section ? ` in “${x.section}”` : ""}`).join(", ") : "nothing yet";
    lines.push(`${c.name} (${c.role}${c.working ? `, now ${c.doing}` : ", finished"}): made ${made}${c.sections.length ? `; sections ${c.sections.map((x) => `“${x}”`).join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

function publish(m: CrewMember) {
  if (m.left) return;
  m.state.crew.at = Date.now();
  m.awareness.setLocalState({ ...m.state, crew: { ...m.state.crew } });
}

/** what the agent is doing now, in a few words */
export function setDoing(m: CrewMember, doing: string) {
  m.state.crew.doing = doing.slice(0, 80);
  publish(m);
}

/** resolve a card id, section id or section name on the board */
export function resolveTarget(boardId: string, ref: string | undefined | null): CrewTarget | null {
  if (!ref) return null;
  const doc = getBoard(boardId).doc;
  const m = boardMaps(doc);
  if (m.objects.has(ref)) return { id: ref, kind: "object" };
  const sec = findSection(doc, ref);
  return sec ? { id: sec.id, kind: "section" } : null;
}

/** aim the cursor at a card or section (null: stay where it is) */
export function aim(m: CrewMember, target: CrewTarget | null, doing?: string) {
  if (target) {
    m.state.crew.target = target;
    m.state.focus = target.kind === "object" ? target.id : null;
  }
  if (doing) m.state.crew.doing = doing.slice(0, 80);
  publish(m);
}

/** aim, then give the cursor time to get there before the change lands */
export async function travel(m: CrewMember, target: CrewTarget | null, doing?: string) {
  const moved = target && (m.state.crew.target?.id !== target.id);
  aim(m, target, doing);
  const ms = travelMs();
  if (moved && ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/** bring the person who asked to a card or section: their browser moves their camera (or asks first) */
export function guide(m: CrewMember, target: CrewTarget, name: string, note?: string) {
  m.state.crew.guide = { to: m.userId, target, name, note: note?.slice(0, 120), nonce: Date.now() + Math.random() };
  aim(m, target, `showing ${m.userName.split(" ")[0]} ${name}`);
}

/** the agent is done: it says so for a moment where it is, then leaves everyone's screen */
export function leaveCrew(m: CrewMember, status: "done" | "stopped" | "error" = "done", lingerMs = 2400) {
  if (m.left) return;
  m.state.crew.status = status;
  m.state.crew.doing = status === "done" ? "done" : status === "stopped" ? "stopped" : "hit a problem";
  m.state.crew.guide = null;
  publish(m);
  const go = () => {
    if (m.left) return;
    m.left = true;
    m.awareness.setLocalState(null); // removal reaches the board through the bridge
    m.awareness.destroy();
    m.doc.destroy();
    members.delete(m.id);
  };
  if (lingerMs > 0) setTimeout(go, lingerMs).unref?.();
  else go();
}

/** may this agent call in another? (only within the person's ask, and a few at most) */
export function canCallHelp(m: CrewMember): string | null {
  if (m.lead) return "a helper can't call in helpers of its own";
  if (m.helpers >= MAX_HELPERS) return `at most ${MAX_HELPERS} helpers per ask`;
  if (crewOn(m.boardId).length >= MAX_CREW_PER_BOARD) return `this board already has ${MAX_CREW_PER_BOARD} agents working`;
  return null;
}

/** the few words a cursor shows for a tool step */
export function describeStep(name: string, input: Record<string, unknown>, boardId?: string): string {
  const q = (k: string) => (typeof input[k] === "string" ? String(input[k]).slice(0, 40) : "");
  /** a card's name, not its id (a real model wires by ids) */
  const named = (k: string) => {
    const ref = q(k);
    if (!boardId || !ref) return ref;
    const o = boardMaps(getBoard(boardId).doc).objects.get(ref) as { name?: string } | undefined;
    return o?.name?.slice(0, 40) || ref;
  };
  switch (name) {
    case "read_board":
      return "reading the board";
    case "search":
      return `searching “${q("query")}”`;
    case "company":
      return input.connector ? `reading ${q("connector")}` : "reading the company";
    case "add_section":
      return `making section “${q("name")}”`;
    case "rename_section":
      return `renaming to “${q("name")}”`;
    case "add_note":
      return `writing “${q("title")}”`;
    case "add_table":
      return `making table “${q("name")}”`;
    case "add_panel":
      return input.panel === "connector" ? `hooking up ${q("name") || q("connector")}` : `opening ${q("name")}`;
    case "connect":
      return `wiring ${named("from_panel")} → ${named("to_panel")}`;
    case "update_card":
      return input.section ? `moving it to ${q("section")}` : "tidying a card";
    case "arrange_section":
      return "arranging the section";
    case "delete_card":
      return "removing a card";
    case "bring_view":
      return "showing you";
    case "call_in_help":
      return "calling in help";
    case "focus":
      return q("note") || "pointing";
    case "set_plan":
      return "planning";
    case "find_images":
      return `finding images of ${q("query")}`;
    case "lay_out":
      return "laying out a page";
    case "write_digest":
      return "writing the daily digest";
    case "crew_work":
      return "checking the crew's work";
    case "machine_run":
      return `asking to run ${q("command")}`;
    case "desktop_screenshot":
      return `looking at ${q("machine")}'s desktop`;
    case "desktop_mouse":
    case "desktop_type":
    case "desktop_key":
      return `using ${q("machine")}'s desktop`;
    default:
      return name.replace(/_/g, " ");
  }
}

/** which card or section a step is about, before it runs (creations aim at their section) */
export function stepTarget(boardId: string, name: string, input: Record<string, unknown>): CrewTarget | null {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  if (name === "connect") return resolveTarget(boardId, s("to_panel"));
  if (name === "bring_view") return null; // the tool aims itself
  if (name === "machine_run" || name.startsWith("desktop_")) {
    // by card id, or by the machine's name
    const ref = s("machine");
    const card = ref ? [...boardMaps(getBoard(boardId).doc).objects.values()].find((o) => o.kind === "panel" && o.panel === "machine" && (o.id === ref || o.machine?.name === ref.toLowerCase() || o.name.toLowerCase() === ref.toLowerCase())) : undefined;
    return card ? { id: card.id, kind: "object" } : null;
  }
  return resolveTarget(boardId, s("id") ?? s("object_id") ?? s("panel") ?? s("section") ?? null);
}

/** for tests */
export function _resetCrew() {
  for (const m of [...members.values()]) leaveCrew(m, "done", 0);
}

/**
 * The agents' work trail (2026-11-26, Josh: "show how the agent council is thinking … T3 agents … understand sections in
 * which they are working on and modifying the data structure and code for … visualized somewhere that you can look at to
 * see what they are working on concurrently"). The shape is agenttrail's (github.com/sodiumsun/agenttrail): a run is a
 * lane of steps, each step a node with what it touched, and lanes that touch the same thing are linked.
 *
 * What it records, per crew member (one of Foundation's own runs, or a T3 thread, crew.ts): every tool call that goes
 * through runTool (tools.ts) with the few words its cursor already shows, the section and card it acted on, whether it
 * worked and how long it took; and, for a T3 thread, the files it writes in its own folder (t3threads.ts), by path and
 * size, never their contents. In memory, for the last hours: the council's full runs stay in `agent_runs`.
 *
 * Who sees what (the invariant "an agent's reasoning is not shared with a grid once its run has read anything beyond
 * that grid", CLAUDE.md): anyone who can see the grid sees the shape (which step, where, ok or not, the files by name),
 * the same as the cursor's line and the timeline's Behind the scenes. A step's arguments and what it answered go only to
 * the person who asked. Once a run has read beyond the grid (crew.ts PRIVATE_READS), others see only that it worked
 * and where it stood: no step words, no file names. Reading never writes a board.
 */

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { relative, sep } from "node:path";
import { boardMaps } from "@foundation/protocol";
import { getBoard } from "./boards.ts";
import { crewOn, describeStep, stepTarget, type CrewMember } from "./crew.ts";

export interface TrailStep {
  /** a tool call, or (the asker's alone, always) a stretch of its reasoning or of what it said */
  kind: "tool" | "thought" | "said";
  at: number;
  /** ms it took; absent while it runs */
  ms?: number;
  tool: string;
  /** the few words the cursor showed (describeStep): the grid's already */
  label: string;
  read: boolean;
  ok?: boolean;
  section: string | null;
  card: string | null;
  /** the asker's alone: the call's arguments (request_id and confirm left out) and a line of what it answered */
  input?: Record<string, unknown>;
  summary?: string;
}

export interface TrailFile {
  path: string;
  change: "added" | "changed" | "removed";
  at: number;
  bytes?: number;
}

interface Trail {
  member: CrewMember;
  steps: TrailStep[];
  files: Map<string, TrailFile>;
  folder?: string;
  thread?: string;
  watcher?: FSWatcher;
  ended?: number;
}

const trails = new Map<string, Trail>();
/** where each agent was asked, by crew id (t3threads.ts registers its threads' sections) */
let homesOf: (boardId: string) => Record<string, string> = () => ({});
export function trailHomesFrom(fn: (boardId: string) => Record<string, string>) {
  homesOf = fn;
}
/** a run's trail stays readable this long after it ends */
const KEEP_MS = () => Number(process.env.FOUNDATION_TRAIL_KEEP_MS ?? String(3 * 3600_000)) || 3 * 3600_000;
const MAX_STEPS = 400;
const MAX_FILES = 300;
const MAX_TRAILS = 200;
/** files no one wants to see: the pass, version control, dependencies, build output */
const IGNORE = /(^|[\\/])(\.foundation-mcp\.json|\.git|node_modules|\.venv|__pycache__|dist|build|target|\.next|\.turbo)([\\/]|$)/;

function trailOf(m: CrewMember): Trail {
  let t = trails.get(m.id);
  if (!t) {
    t = { member: m, steps: [], files: new Map() };
    trails.set(m.id, t);
    prune();
  }
  return t;
}

function prune() {
  const now = Date.now();
  for (const [id, t] of trails) {
    const end = t.ended ?? (t.member.left ? t.member.state.crew.at : undefined);
    if (end && now - end > KEEP_MS()) drop(id, t);
  }
  while (trails.size > MAX_TRAILS) {
    const [id, t] = trails.entries().next().value!;
    drop(id, t);
  }
}

function drop(id: string, t: Trail) {
  t.watcher?.close();
  trails.delete(id);
}

const sectionOfCard = (boardId: string, id: string | null): string | null => {
  if (!id) return null;
  const m = boardMaps(getBoard(boardId).doc);
  if (m.sections.has(id)) return id;
  const o = m.objects.get(id) as { sectionId?: string } | undefined;
  return o?.sectionId ?? null;
};

const clean = (input: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "request_id" || k === "confirm") continue;
    const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
    out[k] = s.length > 600 ? `${s.slice(0, 599)}…` : v;
  }
  return out;
};

export function summaryOf(out: unknown): string {
  if (out == null) return "";
  if (typeof out === "string") return out.replace(/\s+/g, " ").slice(0, 240);
  try {
    const s = JSON.stringify(out, (k, v) => (k === "_image" ? "[picture]" : v));
    return s.length > 240 ? `${s.slice(0, 239)}…` : s;
  } catch {
    return "";
  }
}

/** runTool: a crew member starts a call. Returns the step, to be ended with trailStepEnd */
export function trailStepStart(m: CrewMember, boardId: string, tool: string, input: Record<string, unknown>, read: boolean): TrailStep | null {
  if (m.boardId !== boardId) return null;
  const t = trailOf(m);
  let target: string | null = null;
  try {
    target = stepTarget(boardId, tool, input)?.id ?? null;
  } catch {
    target = null;
  }
  const step: TrailStep = { kind: "tool", at: Date.now(), tool, label: safeLabel(tool, input, boardId), read, section: sectionOfCard(boardId, target), card: target && !boardMaps(getBoard(boardId).doc).sections.has(target) ? target : null, input: clean(input) };
  t.steps.push(step);
  if (t.steps.length > MAX_STEPS) t.steps.splice(0, t.steps.length - MAX_STEPS);
  return step;
}

function safeLabel(tool: string, input: Record<string, unknown>, boardId: string) {
  try {
    return describeStep(tool, input, boardId);
  } catch {
    return tool.replace(/_/g, " ");
  }
}

/** agent.ts: a stretch of reasoning or of its answer, as it streams (one step per stretch). Only its asker ever reads it */
export function trailNote(m: CrewMember, kind: "thought" | "said", text: string) {
  if (!text) return;
  const t = trailOf(m);
  const last = t.steps.at(-1);
  if (last?.kind === kind) {
    last.summary = ((last.summary ?? "") + text).slice(0, 6000);
    last.ms = Date.now() - last.at;
    return;
  }
  if (!text.trim()) return;
  t.steps.push({ kind, at: Date.now(), tool: "", label: kind === "thought" ? "thinking" : "said", read: true, ok: true, section: null, card: null, summary: text.slice(0, 6000) });
  if (t.steps.length > MAX_STEPS) t.steps.splice(0, t.steps.length - MAX_STEPS);
}

/** runTool: the call ended. A card it made counts as where it acted */
export function trailStepEnd(step: TrailStep | null, boardId: string, ok: boolean, out?: unknown) {
  if (!step || step.ms !== undefined) return; // ended once
  step.ms = Date.now() - step.at;
  step.ok = ok;
  step.summary = ok ? summaryOf(out) : summaryOf(out) || "failed";
  if (!step.card && out && typeof out === "object" && typeof (out as { id?: unknown }).id === "string") {
    const id = (out as { id: string }).id;
    const m = boardMaps(getBoard(boardId).doc);
    if (m.objects.has(id)) {
      step.card = id;
      step.section = step.section ?? sectionOfCard(boardId, id);
    } else if (m.sections.has(id)) step.section = id;
  }
}

/** t3threads: a T3 thread's folder is watched for the files it writes (by path and size, never their contents) */
export function watchTrailFolder(m: CrewMember, folder: string, thread: string) {
  const t = trailOf(m);
  t.folder = folder;
  t.thread = thread;
  if (t.watcher) return;
  try {
    t.watcher = watch(folder, { recursive: true, persistent: false }, (_ev, name) => {
      if (!name) return;
      const rel = String(name);
      if (IGNORE.test(rel)) return;
      const full = `${folder}${sep}${rel}`;
      let change: TrailFile["change"] = "changed";
      let bytes: number | undefined;
      if (!existsSync(full)) change = "removed";
      else {
        try {
          const st = statSync(full);
          if (st.isDirectory()) return;
          bytes = st.size;
        } catch {
          return;
        }
        if (!t.files.has(rel) || t.files.get(rel)!.change === "removed") change = "added";
        else change = t.files.get(rel)!.change === "added" ? "added" : "changed";
      }
      t.files.delete(rel); // newest last
      t.files.set(rel.split(sep).join("/"), { path: relative(folder, full).split(sep).join("/"), change, at: Date.now(), bytes });
      if (t.files.size > MAX_FILES) t.files.delete(t.files.keys().next().value!);
    });
    t.watcher.on("error", () => {
      t.watcher?.close();
      t.watcher = undefined;
    });
  } catch {
    t.watcher = undefined;
  }
}

/** the run ended: its folder is no longer watched, its trail is kept a while */
export function trailEnded(m: CrewMember) {
  const t = trails.get(m.id);
  if (!t) return;
  t.ended = Date.now();
  t.watcher?.close();
  t.watcher = undefined;
}

// ---------- reading it ----------

export interface TrailLane {
  crew: string;
  name: string;
  hue: number;
  via: string;
  kind: "t3" | "council";
  askerName: string;
  /** the person reading is the one who asked: they see arguments and answers */
  mine: boolean;
  task: string;
  status: "working" | "done" | "stopped" | "error";
  doing: string;
  started: number;
  ended: number | null;
  private: boolean;
  /** its home section (where it was asked) and every section it read or wrote, with counts */
  home: { id: string; name: string } | null;
  sections: Array<{ id: string; name: string; reads: number; writes: number }>;
  cards: Array<{ id: string; name: string; section: string | null; writes: number }>;
  steps: TrailStep[];
  files: TrailFile[];
  thread: string | null;
  plan: { goal: string; steps: Array<{ text: string; status: string }> } | null;
}

/** every agent at work on this grid, and those that finished in the last hours, newest first */
export function trailLanes(boardId: string, viewer: { id: string; role?: string }): TrailLane[] {
  prune();
  const homes = homesOf(boardId);
  const doc = getBoard(boardId).doc;
  const maps = boardMaps(doc);
  const nameOf = (id: string) => ((maps.sections.get(id) as { name?: string } | undefined)?.name ?? "");
  const cardName = (id: string) => ((maps.objects.get(id) as { name?: string } | undefined)?.name ?? "");
  const byId = new Map<string, Trail>();
  for (const t of trails.values()) if (t.member.boardId === boardId) byId.set(t.member.id, t);
  for (const m of crewOn(boardId)) if (!byId.has(m.id)) byId.set(m.id, { member: m, steps: [], files: new Map() });
  const lanes: TrailLane[] = [];
  for (const t of byId.values()) {
    const m = t.member;
    const c = m.state.crew;
    const mine = m.userId === viewer.id;
    // beyond the grid: others see that it worked and where it stood, not what
    const hidden = Boolean(m.private) && !mine;
    const secs = new Map<string, { reads: number; writes: number }>();
    const cards = new Map<string, { section: string | null; writes: number }>();
    const tools = t.steps.filter((s) => s.kind === "tool");
    for (const s of tools) {
      if (s.section) {
        const e = secs.get(s.section) ?? { reads: 0, writes: 0 };
        if (s.read) e.reads++;
        else e.writes++;
        secs.set(s.section, e);
      }
      if (s.card && !s.read) {
        const e = cards.get(s.card) ?? { section: s.section, writes: 0 };
        e.writes++;
        cards.set(s.card, e);
      }
    }
    const homeId = homes[m.id] ?? (c.target?.kind === "section" ? c.target.id : null) ?? m.sections[0] ?? null;
    const home = homeId && maps.sections.has(homeId) ? { id: homeId, name: nameOf(homeId) } : null;
    if (home && !secs.has(home.id)) secs.set(home.id, { reads: 0, writes: 0 });
    lanes.push({
      crew: m.id,
      name: m.name,
      hue: m.hue,
      via: c.via,
      kind: c.via.startsWith("t3:") ? "t3" : "council",
      askerName: m.userName,
      mine,
      task: c.task,
      status: m.left && c.status === "working" ? "done" : c.status,
      doing: hidden ? (c.status === "working" ? "working" : c.doing) : c.doing,
      started: c.started || m.joinedAt,
      ended: t.ended ?? (m.left || c.status !== "working" ? c.at : null),
      private: Boolean(m.private),
      home,
      sections: [...secs].filter(([id]) => maps.sections.has(id)).map(([id, e]) => ({ id, name: nameOf(id), ...e })),
      cards: hidden ? [] : [...cards].filter(([id]) => maps.objects.has(id)).map(([id, e]) => ({ id, name: cardName(id), ...e })),
      steps: hidden
        ? tools.map((s) => ({ kind: "tool" as const, at: s.at, ms: s.ms, tool: s.read ? "read" : "write", label: s.read ? "reading" : "changing the grid", read: s.read, ok: s.ok, section: s.section, card: null }))
        : mine
          ? t.steps.map((s) => ({ ...s }))
          : tools.map((s) => ({ kind: "tool" as const, at: s.at, ms: s.ms, tool: s.tool, label: s.label, read: s.read, ok: s.ok, section: s.section, card: s.card })),
      files: hidden ? [] : [...t.files.values()].reverse(),
      thread: t.thread ?? null,
      plan: c.plan ? { goal: c.plan.goal, steps: c.plan.steps.map((s) => ({ text: s.text, status: s.status })) } : null,
    });
  }
  return lanes.sort((a, b) => (a.status === "working" ? 0 : 1) - (b.status === "working" ? 0 : 1) || b.started - a.started);
}

/** for an agent: who else is at work on this grid, where, and on what (concurrent_work). Never another run's words */
export function concurrentWork(boardId: string, self: CrewMember | undefined): string {
  const lanes = trailLanes(boardId, { id: "" }).filter((l) => l.status === "working" && l.crew !== self?.id);
  const me = self ? trailLanes(boardId, { id: self.userId }).find((l) => l.crew === self.id) : undefined;
  const lines: string[] = [];
  if (me) {
    lines.push(`You are ${me.name}${me.home ? `, asked in the section “${me.home.name}” (${me.home.id})` : ""}.`);
    if (me.sections.length) lines.push(`Sections you have touched: ${me.sections.map((s) => `“${s.name}” (${s.writes} writes, ${s.reads} reads)`).join(", ")}.`);
  }
  if (!lanes.length) {
    lines.push("No other agent is working on this grid right now.");
    return lines.join("\n");
  }
  lines.push(`${lanes.length} other agent${lanes.length === 1 ? " is" : "s are"} working on this grid now:`);
  for (const l of lanes) {
    const where = l.sections.filter((s) => s.writes > 0).map((s) => `“${s.name}”`);
    const cards = l.cards.slice(0, 6).map((c) => `“${c.name}”`);
    const files = l.files.slice(0, 6).map((f) => f.path);
    lines.push(
      `- ${l.name} (${l.kind === "t3" ? "through T3" : "Foundation's own"}, for ${l.askerName})${l.home ? ` in “${l.home.name}”` : ""}: ${l.doing}.` +
        (where.length ? ` Writing in ${where.join(", ")}.` : "") +
        (cards.length ? ` Cards it changed: ${cards.join(", ")}.` : "") +
        (files.length ? ` Files in its own folder: ${files.join(", ")}.` : ""),
    );
  }
  lines.push("Don't change a card another agent is changing; build beside it, or say what you'd change.");
  return lines.join("\n");
}

/** for tests */
export function _resetTrail() {
  for (const [id, t] of trails) drop(id, t);
}

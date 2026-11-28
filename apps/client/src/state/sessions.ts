/**
 * Agent sessions — the conversations behind the top bar's tabs. A run keeps
 * streaming when its tab isn't showing (switch away and come back), and a
 * session the page doesn't hold yet is replayed from the server's transcript.
 *
 * Also the side pane's lists: this board's sessions and Vision Code's threads.
 */

import { useSyncExternalStore } from "react";
import type { AgentEvent } from "@foundation/protocol";
import { api, followRun, streamAgent } from "../lib/api";
import { activeBoard } from "../sync/board";
import { getState } from "./store";
import { getUi, newSession, newSessionId, renameSession, toast } from "./ui";

export interface Turn {
  /** the server's run, once it has said (reattach and stop by it) */
  runId?: string;
  prompt: string;
  events: AgentEvent[];
  status: "running" | "done" | "error" | "stopped";
  runtime?: string;
  at: number;
}

export interface SessionRun {
  turns: Turn[];
  busy: boolean;
  loaded: boolean;
}

const runs = new Map<string, SessionRun>();
const ctrls = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let version = 0;
const EMPTY: SessionRun = { turns: [], busy: false, loaded: false };

function emit() {
  version++;
  for (const fn of listeners) fn();
}
function patch(id: string, fn: (r: SessionRun) => SessionRun) {
  runs.set(id, fn(runs.get(id) ?? EMPTY));
  emit();
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSession(id: string | null): SessionRun {
  useSyncExternalStore(subscribe, () => version);
  return (id && runs.get(id)) || EMPTY;
}

/** replay a session from the server, once, unless this page is already running it — and pick a running turn back up */
export async function loadSession(id: string) {
  const r = runs.get(id);
  if (r?.loaded || r?.busy) return;
  patch(id, (x) => ({ ...x, loaded: true }));
  let turns: Array<{ id: string; prompt: string; status: string; runtime: string; at: number; events: AgentEvent[] }>;
  try {
    ({ turns } = await api<{ turns: typeof turns }>(`/api/agent/sessions/${encodeURIComponent(id)}`));
  } catch {
    return; /* a new session: nothing to replay */
  }
  if (runs.get(id)?.busy) return;
  const status = (s: string): Turn["status"] => (s === "running" || s === "error" || s === "stopped" ? s : "done");
  patch(id, (x) => ({ ...x, turns: turns.map((t) => ({ runId: t.id, prompt: t.prompt, events: t.events, runtime: t.runtime, at: t.at, status: status(t.status) })) }));
  const last = turns[turns.length - 1];
  if (last?.status === "running") void follow(id, (ctrl, on) => followRun(last.id, on, ctrl.signal), true);
}

/**
 * Follow a stream of the session's last turn into the store. `replay`: the
 * stream starts from the beginning of the turn, so it replaces what's shown.
 */
async function follow(id: string, open: (ctrl: AbortController, on: (e: AgentEvent) => void) => Promise<void>, replay = false) {
  const last = (fn: (t: Turn) => Turn) => patch(id, (x) => ({ ...x, turns: [...x.turns.slice(0, -1), fn(x.turns[x.turns.length - 1])] }));
  const ctrl = new AbortController();
  ctrls.set(id, ctrl);
  patch(id, (x) => ({ ...x, busy: true }));
  if (replay) last((t) => ({ ...t, events: [] }));
  try {
    await open(ctrl, (e) =>
      last((t) => {
        if (e.type === "run") return { ...t, runId: e.id };
        if (e.type === "crew") noteCrew(e.id, id, e.name, e.hue, t.prompt);
        if (e.type === "helper") void followHelper(e.session, e.runId, e.name);
        const prev = t.events[t.events.length - 1];
        // streamed text joins the text before it
        const events = e.type === "text" && prev?.type === "text" ? [...t.events.slice(0, -1), { type: "text" as const, text: prev.text + e.text }] : [...t.events, e];
        return { ...t, events, runtime: e.type === "done" ? e.runtime : t.runtime, status: e.type === "error" ? "error" : t.status };
      }),
    );
    last((t) => ({ ...t, status: t.status === "running" ? (stopped.has(id) ? "stopped" : "done") : t.status }));
  } catch (err) {
    // leaving the page detaches; the run carries on on the server
    if ((err as Error).name !== "AbortError") last((t) => ({ ...t, status: "error", events: [...t.events, { type: "error", message: (err as Error).message }] }));
  } finally {
    stopped.delete(id);
    if (ctrls.get(id) === ctrl) ctrls.delete(id);
    patch(id, (x) => ({ ...x, busy: false }));
    void refreshLists();
  }
}
const stopped = new Set<string>();

/** `as`: a council seat's own name, which its cursor wears while it works; `section`: the section it was asked in */
export async function sendToSession(id: string, prompt: string, runtime?: string, as?: string, section?: string) {
  const text = prompt.trim();
  const r = runs.get(id) ?? EMPTY;
  if (!text || r.busy) return;
  if (r.turns.length === 0) renameSession(id, titleOf(text));
  patch(id, (x) => ({ ...x, loaded: true, turns: [...x.turns, { prompt: text, events: [], status: "running", at: Date.now() }] }));
  await follow(id, (ctrl, on) => streamAgent({ board: activeBoard()?.boardId ?? "company", prompt: text, runtime, session: id, as, ...(section ? { section } : {}) }, on, ctrl.signal));
  // a line said to it while it worked goes on in the same conversation, now that it's free (sendOrWait)
  const next = waiting.get(id)?.shift();
  if (!waiting.get(id)?.length) waiting.delete(id);
  if (next && !stopped.has(id)) void sendToSession(id, next.text, next.runtime, next.as, next.section);
  else if (stopped.has(id)) waiting.delete(id);
  if (next) emit();
}

/** lines said to a session's agent while it was at work, in order: each goes into the same session as the run before it ends */
const waiting = new Map<string, Array<{ text: string; runtime?: string; as?: string; section?: string }>>();

/**
 * Say something to an agent's session: at once if it's free; if it's at work, after its run, in the same session, so
 * the agent takes it up as the next turn of the same conversation instead of a stranger's new ask (plan
 * council-conversation). Claude Code can't hear words in the middle of a turn, so this is as close as it goes.
 */
export function sendOrWait(id: string, text: string, runtime?: string, as?: string, section?: string): "sent" | "waiting" {
  if (!runs.get(id)?.busy) {
    void sendToSession(id, text, runtime, as, section);
    return "sent";
  }
  waiting.set(id, [...(waiting.get(id) ?? []), { text: text.trim(), runtime, as, section }]);
  emit();
  return "waiting";
}
/** how many lines wait for a session's agent to finish */
export const waitingFor = (id: string) => waiting.get(id)?.length ?? 0;

/** said out loud (the talk button, V): into the agent session on screen if it's free, else a new one — sent at once */
export function sayToAgent(text: string) {
  const ui = getUi();
  const showing = ui.sessions.find((t) => t.id === ui.session && t.kind === "agent");
  const id = showing && !runs.get(showing.id)?.busy ? showing.id : newSession().id;
  const pref = localStorage.getItem("foundation-runtime");
  void sendToSession(id, text, pref && pref !== "auto" ? pref : undefined);
}

// ---------- the crew: asks from the voice sheet run without a tab ----------

export interface CrewAsk {
  /** the crew member (its presence on the board) */
  crew: string;
  session: string;
  name: string;
  hue: number;
  prompt: string;
  /** when its agent joined */
  at: number;
}
const crewAsks = new Map<string, CrewAsk>();

function noteCrew(crew: string, session: string, name: string, hue: number, prompt: string) {
  if (crewAsks.get(crew)?.session === session) return;
  crewAsks.set(crew, { crew, session, name, hue, prompt, at: Date.now() });
  emit();
}

/** how long a finished ask stays findable in the sheet after its agent has left */
export const RECENT_ASK_MS = 15 * 60_000;

/**
 * Your asks whose agents have left the board (done, stopped or failed) in
 * the last 15 minutes, newest first, at most three: the sheet lists them under
 * the crew at work, so a finished ask can still be opened (it ran without a tab).
 */
export function useRecentCrewAsks(present: ReadonlySet<string>): Array<CrewAsk & { status: string }> {
  useSyncExternalStore(subscribe, () => version);
  const now = Date.now();
  return [...crewAsks.values()]
    .filter((a) => !present.has(a.crew) && now - a.at < RECENT_ASK_MS && !runs.get(a.session)?.busy)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3)
    .map((a) => ({ ...a, status: runs.get(a.session)?.turns.at(-1)?.status ?? "done" }));
}

/** which session a crew member's work is in (to stop it, or open its tab) */
export function crewAsk(crew: string): CrewAsk | undefined {
  return crewAsks.get(crew);
}

/** a helper a lead called in: follow its run under its own session, so it can be stopped and opened */
async function followHelper(session: string, runId: string, name: string) {
  if (runs.get(session)?.busy) return;
  patch(session, (x) => ({ ...x, loaded: true, turns: [{ runId, prompt: `${name}: called in to help`, events: [], status: "running", at: Date.now() }] }));
  await follow(session, (ctrl, on) => followRun(runId, on, ctrl.signal), true);
}

/**
 * Ask the crew (the bar's Ask pill and the voice sheet, through the council): a new agent, with its own name and cursor,
 * in a session of its own that runs without opening a tab, so the board
 * stays in view while you watch it work. Several can run at once.
 */
export function askCrew(text: string, as?: string, section?: string): string {
  const id = newSessionId();
  const pref = localStorage.getItem("foundation-runtime");
  void sendToSession(id, text, pref && pref !== "auto" ? pref : undefined, as, section).then(() => {
    // no tab shows this run, so a failure says so here, in the agent's name and its own words
    const t = runs.get(id)?.turns.at(-1);
    if (t?.status !== "error") return;
    const err = [...t.events].reverse().find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error" && !/^Claude Code exited/.test(e.message));
    const who = [...crewAsks.values()].find((a) => a.session === id)?.name ?? "The crew";
    toast(`${who} couldn't do it: ${err?.message ?? "the agent stopped with an error"}`, "bad");
  });
  return id;
}

/** Stop ends the run on the server; the stream then closes on its own */
export function stopSession(id: string) {
  const t = (runs.get(id)?.turns ?? []).at(-1);
  stopped.add(id);
  if (t?.runId) void api(`/api/agent/runs/${encodeURIComponent(t.runId)}/stop`, { method: "POST" }).catch(() => ctrls.get(id)?.abort());
  else ctrls.get(id)?.abort();
}

/** The crew-wide stop: every agent of yours on this board, helpers included (the server finds them) */
export async function stopAllCrew(board: string): Promise<number> {
  for (const a of crewAsks.values()) stopped.add(a.session);
  const r = await api<{ stopped: number }>("/api/agent/runs/stop-all", { method: "POST", json: { board } });
  return r.stopped;
}

export function titleOf(prompt: string) {
  const line = prompt.split("\n")[0].trim();
  return line.length > 48 ? `${line.slice(0, 45)}…` : line;
}

// ---------- what a session shows ----------

export interface Plan {
  goal: string;
  steps: Array<{ text: string; status: "pending" | "active" | "done" }>;
}

/** the latest plan the agent set (set_plan), across every turn */
export function planOf(turns: Turn[]): Plan | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const ev = turns[i].events;
    for (let j = ev.length - 1; j >= 0; j--) {
      const e = ev[j];
      if (e.type === "tool" && e.name === "set_plan") {
        const p = e.input as Partial<Plan> | undefined;
        if (p && Array.isArray(p.steps)) return { goal: String(p.goal ?? ""), steps: p.steps.filter((s) => s && typeof s.text === "string") };
      }
    }
  }
  return null;
}

/** tools that only look: what they mention isn't something the session touched */
export const READ_ONLY = new Set(["read_board", "search", "find_images", "company", "read_file", "read_repo", "find_repo", "app_tools", "pipeline_status", "set_plan", "huddle_transcript", "slack_read", "point_at"]);

/** cards and sections a session's tools named — ringed on the grid while it shows */
export function touchedBy(turns: Turn[]): string[] {
  const st = getState();
  const ids = [
    ...Object.keys(st.panels),
    ...Object.keys(st.notes),
    ...Object.keys(st.tables),
    ...Object.keys(st.maps),
    ...Object.keys(st.media),
    ...Object.keys(st.sections),
  ];
  const parts: string[] = [];
  for (const t of turns) {
    // results arrive in call order (Claude Code doesn't name them): pair each with its call
    const open: string[] = [];
    for (const e of t.events) {
      if (e.type === "tool") {
        open.push(e.name);
        if (!READ_ONLY.has(e.name)) parts.push(JSON.stringify(e.input));
      } else if (e.type === "tool_result") {
        const name = e.name || open.shift() || "";
        if (e.name && open.includes(e.name)) open.splice(open.indexOf(e.name), 1);
        if (!READ_ONLY.has(name)) parts.push(e.summary);
      }
    }
  }
  const text = parts.join(" ");
  const named = text ? ids.filter((id) => text.includes(id)) : [];
  // and what its agents actually wrote, from the board's own activity (signed by name): a card a tool
  // changed without naming it still gets its ring
  const wrote = new Set<string>();
  const log = activeBoard()?.activity() ?? [];
  turns.forEach((t, i) => {
    const names = new Set(t.events.flatMap((e) => (e.type === "crew" || e.type === "helper" ? [e.name] : [])));
    if (!names.size) return;
    const until = turns[i + 1]?.at ?? Infinity;
    for (const a of log) if (a.objectId && names.has(a.who) && a.at >= t.at - 1000 && a.at < until) wrote.add(a.objectId);
  });
  const known = new Set(ids);
  return [...new Set([...named, ...[...wrote].filter((id) => known.has(id))])];
}

/** the first board object a step names, so a step can be clicked to frame it */
export function objectIn(text: string): string | null {
  const st = getState();
  const m = text.match(/\b(pnl|note|table|map|media|sec)_[A-Za-z0-9_]+/g) ?? [];
  for (const id of m) if (st.panels[id] || st.notes[id] || st.tables[id] || st.maps[id] || st.media[id] || st.sections[id]) return id;
  return null;
}

export const TOOL_WORDS: Record<string, string> = {
  read_board: "Read the board",
  concurrent_work: "Saw who else is at work",
  search: "Searched",
  set_plan: "Updated the plan",
  find_images: "Found images",
  lay_out: "Laid out a page",
  add_section: "Added a section",
  add_note: "Wrote a note",
  add_panel: "Opened a panel",
  update_card: "Updated a card",
  delete_card: "Removed a card",
  connect: "Wired apps",
  send_to_port: "Sent a value",
  find_repo: "Found the repo",
  read_repo: "Read the repo",
  app_tools: "Listed app tools",
  call_app_tool: "Called an app",
  company: "Read company systems",
  read_file: "Read a file",
  ask_person: "Asked a teammate (Hermes)",
  vision_brief: "Briefed Vision",
  reverse_engineer: "Queued reverse-engineering",
  focus: "Pointed at a card",
  start_design_pipeline: "Started a design pipeline",
  pipeline_status: "Read the pipeline",
  stage_attach: "Attached to a stage",
  stage_choose: "Chose what goes forward",
  stage_check: "Ticked the checklist",
  stage_settings: "Set up the stage",
  stage_request: "Handed off the stage",
  complete_stage: "Completed a stage",
};

// ---------- the side pane's lists ----------

export interface SessionSummary {
  id: string;
  title: string;
  runs: number;
  status: "running" | "done" | "error";
  updatedAt: number;
}
export interface T3Thread {
  id: string;
  title: string;
  project: string;
  status: "running" | "waiting" | "idle" | "error";
  pending: number;
  updatedAt: number;
  url: string | null;
}

/** t3Missing: when Vision Code's threads can't be read, the server's word on where it looked and what to set */
let lists: { sessions: SessionSummary[]; t3: T3Thread[]; t3Available: boolean | null; t3Missing: string | null } = { sessions: [], t3: [], t3Available: null, t3Missing: null };
const listListeners = new Set<() => void>();

export async function refreshLists() {
  const board = activeBoard()?.boardId ?? "company";
  const [s, t] = await Promise.allSettled([
    api<{ sessions: SessionSummary[] }>(`/api/agent/sessions?board=${encodeURIComponent(board)}`),
    api<{ available: boolean; threads: T3Thread[]; missing?: string }>("/api/t3/threads"),
  ]);
  lists = {
    sessions: s.status === "fulfilled" ? s.value.sessions : lists.sessions,
    t3: t.status === "fulfilled" ? t.value.threads : lists.t3,
    // unreachable (offline) isn't "not installed": keep what we last knew
    t3Available: t.status === "fulfilled" ? t.value.available : lists.t3Available,
    t3Missing: t.status === "fulfilled" ? (t.value.missing ?? null) : lists.t3Missing,
  };
  for (const fn of listListeners) fn();
}

export function useLists() {
  return useSyncExternalStore(
    (fn) => {
      listListeners.add(fn);
      return () => listListeners.delete(fn);
    },
    () => lists,
  );
}

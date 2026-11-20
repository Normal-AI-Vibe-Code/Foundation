/**
 * Today's data and the Shiba's conversation, kept outside React so the page
 * stays in step with what the Shiba does: it points at items (point_today), adds
 * and finishes goals (set_goal), and the page refetches when a tool changes
 * something. One conversation per person, resumed across reloads.
 */

import { useSyncExternalStore } from "react";
import type { AgentEvent } from "@foundation/protocol";
import { api, ApiError, streamAgent } from "../lib/api";

export interface FocusItem {
  id: string;
  kind: "ask" | "goal" | "mention" | "stage" | "file" | "changes" | "related";
  title: string;
  why: string;
  board: string;
  boardName: string;
  objectId?: string;
  href: string;
  at: number;
  tone?: "warn" | "bad" | "agent";
}
export interface Goal {
  id: string;
  title: string;
  detail: string;
  status: "active" | "done" | "dropped";
  progress: number;
  dueAt: number | null;
  board: string | null;
  objectId: string | null;
  source: string;
}
/** one of the company's goals: the same for everyone; set by whoever can change the company board */
export interface CompanyGoal {
  id: string;
  title: string;
  detail: string;
  /** who carries it ("" = everyone) */
  owner: string;
  status: "active" | "done" | "dropped";
  progress: number;
  dueAt: number | null;
  board: string;
  objectId: string | null;
}
export interface CompanyApp {
  id: string;
  name: string;
  role: string;
  url: string | null;
  repo?: string | null;
  connector?: string;
  glyph: string;
}
export interface TodayState {
  person: { name: string; email: string; first: string };
  profile: { title: string; team: string; focus: string };
  company: { goals: CompanyGoal[]; canSet: boolean };
  goals: Goal[];
  focus: FocusItem[];
  apps: CompanyApp[];
  sources: { dataroom: { connected: boolean; note: string } };
  at: number;
}

export type Mood = "idle" | "listening" | "thinking" | "speaking";

export interface Exchange {
  id: string;
  ask: string;
  answer: string;
  steps: string[];
  /** each tool it called, to open on the right: its name, what that was in words, what it was given */
  tools?: Array<{ name: string; words: string; input?: unknown }>;
  /** the plan it keeps (set_plan), when it keeps one */
  plan?: { goal: string; steps: Array<{ text: string; status: "pending" | "active" | "done" }> };
  status: "running" | "done" | "error";
  error?: string;
  /** from an earlier visit: shown in the history, never as the room's words */
  restored?: boolean;
}

interface Store {
  today: TodayState | null;
  loadError: string | null;
  exchanges: Exchange[];
  pointed: string[];
  mood: Mood;
  heard: string | null;
  runId: string | null;
}

let s: Store = { today: null, loadError: null, exchanges: [], pointed: [], mood: "idle", heard: null, runId: null };
const subs = new Set<() => void>();
const set = (patch: Partial<Store>) => {
  s = { ...s, ...patch };
  subs.forEach((f) => f());
};

export function useToday() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => s,
  );
}

export async function loadToday() {
  try {
    set({ today: await api<TodayState>("/api/today"), loadError: null });
  } catch (e) {
    set({ loadError: e instanceof ApiError ? e.message : "Foundation's server isn't answering" });
  }
}

export async function saveGoal(g: Partial<Goal> & { id?: string }) {
  await api("/api/today/goals", { method: "POST", json: g });
  await loadToday();
}

export async function saveCompanyGoal(g: Partial<CompanyGoal> & { id?: string }) {
  await api("/api/today/company-goals", { method: "POST", json: { ...g, request_id: `cg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` } });
  await loadToday();
}

// ---------- the conversation ----------

const SESSION_KEY = "foundation.shiba.session";
function sessionId() {
  try {
    const have = localStorage.getItem(SESSION_KEY);
    if (have && /^ses_shiba[a-z0-9]{6,15}$/.test(have)) return have;
    const id = `ses_shiba${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return `ses_shiba${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** start a fresh conversation (the old one stays in the server's history) */
export function newConversation() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private window */
  }
  set({ exchanges: [], pointed: [] });
}

/** the last few exchanges of this conversation, so a reload picks up where it was */
export async function restoreConversation() {
  try {
    const { turns } = await api<{ turns: Array<{ id: string; prompt: string; status: string; events: AgentEvent[] }> }>(`/api/agent/sessions/${sessionId()}`);
    const exchanges = turns.slice(-6).map((t) => ({
      id: t.id,
      ask: t.prompt,
      answer: t.events.filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join(""),
      steps: [],
      tools: t.events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool" && e.name !== "point_today" && e.name !== "set_plan").map((e) => ({ name: e.name, words: stepWords(e.name, e.input), input: e.input })),
      status: (t.status === "error" ? "error" : "done") as Exchange["status"],
      restored: true,
    }));
    if (!s.exchanges.length) set({ exchanges });
  } catch {
    /* nothing yet */
  }
}

/** what a tool step looks like in a few words, as the Shiba works */
export function stepWords(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "today":
      return "reading your day";
    case "point_today":
      return "pointing";
    case "set_goal":
      return i.id ? (i.status === "done" || i.progress === 1 ? "finishing a goal" : "updating a goal") : `adding “${String(i.title ?? "a goal")}”`;
    case "set_profile":
      return "noting your work";
    case "read_board":
      return "reading the board";
    case "search":
      return `searching “${String(i.query ?? "")}”`;
    case "company":
      return "checking the company's apps";
    default:
      return name.replace(/_/g, " ");
  }
}

let ctrl: AbortController | null = null;
let speakTimer: ReturnType<typeof setTimeout> | null = null;
/** when the last words arrived: the shiba glows with the voice of its text */
let lastWords = 0;
export const wordsLevel = () => {
  const since = performance.now() - lastWords;
  const l = s.mood === "speaking" ? Math.max(0, 0.55 * Math.exp(-since / 420)) : 0;
  return { level: l, low: l * 0.8, mid: l, high: l * 0.4 };
};

export function setHeard(text: string | null) {
  set({ heard: text, mood: text === null ? (s.mood === "listening" ? "idle" : s.mood) : "listening" });
}

export async function ask(prompt: string) {
  const text = prompt.trim();
  if (!text) return;
  ctrl?.abort();
  ctrl = new AbortController();
  if (speakTimer) clearTimeout(speakTimer);
  const id = `x${Date.now().toString(36)}`;
  const ex: Exchange = { id, ask: text, answer: "", steps: [], status: "running" };
  set({ exchanges: [...s.exchanges, ex].slice(-12), mood: "thinking", heard: null, pointed: [] });
  const patch = (p: Partial<Exchange>) => set({ exchanges: s.exchanges.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  const cur = () => s.exchanges.find((x) => x.id === id)!;
  let changed = false;
  try {
    await streamAgent(
      { board: "company", prompt: text, session: sessionId(), persona: "shiba" },
      (e) => {
        if (e.type === "run") set({ runId: e.id });
        else if (e.type === "text") {
          lastWords = performance.now();
          // the Shiba speaks in sentences; a run of text after tool steps starts a new thought
          patch({ answer: cur().answer + e.text });
          if (s.mood !== "speaking") set({ mood: "speaking" });
        } else if (e.type === "tool") {
          if (e.name === "point_today") set({ pointed: ((e.input as { ids?: string[] })?.ids ?? []).slice(0, 6) });
          if (e.name === "set_goal" || e.name === "set_profile") changed = true;
          if (e.name === "set_plan") {
            const p = e.input as { goal?: string; steps?: Array<{ text: string; status: "pending" | "active" | "done" }> } | undefined;
            if (p && Array.isArray(p.steps)) patch({ plan: { goal: String(p.goal ?? ""), steps: p.steps.filter((x) => x && typeof x.text === "string") } });
          } else if (e.name !== "point_today") patch({ tools: [...(cur().tools ?? []), { name: e.name, words: stepWords(e.name, e.input), input: e.input }] });
          patch({ steps: [...cur().steps, stepWords(e.name, e.input)] });
          if (s.mood === "idle") set({ mood: "thinking" });
        } else if (e.type === "tool_result") {
          if (changed) void loadToday();
        } else if (e.type === "error") patch({ status: "error", error: e.message });
      },
      ctrl.signal,
    );
    if (cur().status === "running") patch({ status: "done" });
  } catch (e) {
    if (ctrl.signal.aborted) patch({ status: "done" });
    else patch({ status: "error", error: (e as Error).message });
  } finally {
    set({ runId: null });
    if (changed) void loadToday();
    // the words settle, then the Shiba rests
    speakTimer = setTimeout(() => s.mood !== "listening" && set({ mood: "idle" }), cur()?.status === "error" ? 0 : 2400);
    if (s.mood === "thinking") set({ mood: "speaking" });
  }
}

export async function stopAsking() {
  const id = s.runId;
  ctrl?.abort();
  if (id) await api(`/api/agent/runs/${id}/stop`, { method: "POST" }).catch(() => {});
}

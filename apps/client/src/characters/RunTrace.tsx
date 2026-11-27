/**
 * A seat's last run, step by step (2026-11-25, Josh: "one of the agents tried and failed, but there was no trace of what
 * he tried and what happened afterwards"). The agent's pane shows it under a small profile: what was asked, whether it
 * worked, and in order what it thought, which tools it called with what, what each answered, what it said, and the error
 * it ended on.
 *
 * Where it comes from: the run this window is streaming, when it has one (live), else the server's record of this
 * person's last runs under the seat's name (GET /api/agent/seat-runs). Only the asker's own runs: the transcript holds
 * the agent's full reasoning and what it read (docs/agent-harness.md §2), so nobody else is shown it.
 */

import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@foundation/protocol";
import { api } from "../lib/api";
import { crewAsk, planOf, TOOL_WORDS, titleOf, useSession, type Turn } from "../state/sessions";
import { openSession } from "../state/ui";
import { useActiveBoard } from "../shell/Presence";
import { ago } from "../shell/SidePane";
import type { CouncilSeat } from "./Council";
import { openTrail } from "../trail/state";

export interface TraceRun {
  id?: string;
  session?: string | null;
  prompt: string;
  status: "running" | "done" | "error" | "stopped";
  at: number;
  finishedAt?: number | null;
  events: AgentEvent[];
}

export type TraceStep =
  | { kind: "thought"; text: string }
  | { kind: "tool"; name: string; label: string; detail: string; result?: { ok: boolean; summary: string } }
  | { kind: "said"; text: string }
  | { kind: "error"; text: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** a tool call's arguments as one short line: the values that say what it was for */
export function argsLine(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "request_id" || k === "confirm" || v == null) continue;
    if (k === "code" && typeof v === "string") {
      parts.push(`script, ${v.split("\n").length} lines`);
      continue;
    }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}: ${clip(s.replace(/\s+/g, " "), 60)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

/** a run's events as the steps a person reads: results go on the call they answer (in call order) */
export function traceSteps(events: AgentEvent[]): TraceStep[] {
  const out: TraceStep[] = [];
  const open: Array<Extract<TraceStep, { kind: "tool" }>> = [];
  for (const e of events) {
    if (e.type === "thinking") {
      const last = out.at(-1);
      if (last?.kind === "thought") last.text += e.text;
      else if (e.text.trim()) out.push({ kind: "thought", text: e.text });
    } else if (e.type === "text") {
      const last = out.at(-1);
      if (last?.kind === "said") last.text += e.text;
      else if (e.text.trim()) out.push({ kind: "said", text: e.text });
    } else if (e.type === "tool") {
      const step = { kind: "tool" as const, name: e.name, label: TOOL_WORDS[e.name] ?? e.name.replace(/^mcp__\w+__/, "").replace(/_/g, " "), detail: argsLine(e.input) };
      out.push(step);
      open.push(step);
    } else if (e.type === "tool_result") {
      const i = e.name ? open.findIndex((s) => s.name === e.name || s.name.endsWith(`__${e.name}`)) : 0;
      const step = open.splice(i < 0 ? 0 : i, 1)[0];
      if (step) step.result = { ok: e.ok, summary: e.summary };
    } else if (e.type === "error") {
      out.push({ kind: "error", text: e.message });
    }
  }
  return out;
}

/** how a run ended, in a word: a run that called tools that all failed and then said nothing didn't do it either */
export function outcomeOf(run: TraceRun): { word: string; tone: "live" | "good" | "bad" | "quiet" } {
  if (run.status === "running") return { word: "Working", tone: "live" };
  if (run.status === "stopped") return { word: "Stopped", tone: "quiet" };
  if (run.status === "error") return { word: "Failed", tone: "bad" };
  // a plan it set and didn't finish: it says so in its words, but the plan is the plainer sign
  const plan = planOf([{ prompt: run.prompt, events: run.events, status: "done", at: run.at }]);
  if (plan?.steps.length) {
    const done = plan.steps.filter((s) => s.status === "done").length;
    if (done < plan.steps.length) return { word: `Didn't finish: ${done} of ${plan.steps.length} steps`, tone: "bad" };
  }
  const steps = traceSteps(run.events);
  const tools = steps.filter((s): s is Extract<TraceStep, { kind: "tool" }> => s.kind === "tool" && s.name !== "set_plan");
  if (tools.length && tools.every((s) => s.result && !s.result.ok)) return { word: "Didn't get it done", tone: "bad" };
  return { word: "Done", tone: "good" };
}

const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/** this person's last runs of a seat, from the server; fetched again when its work ends */
function useSeatRuns(board: string | undefined, name: string, status: CouncilSeat["status"]): TraceRun[] {
  const [runs, setRuns] = useState<TraceRun[]>([]);
  useEffect(() => {
    if (!board || !name) return;
    let on = true;
    const get = () =>
      api<{ runs: Array<Omit<TraceRun, "status"> & { status: string }> }>(`/api/agent/seat-runs?board=${encodeURIComponent(board)}&name=${encodeURIComponent(name)}`)
        .then((r) => on && setRuns(r.runs.map((x) => ({ ...x, status: x.status === "running" || x.status === "error" || x.status === "stopped" ? x.status : "done" }))))
        .catch(() => {});
    void get();
    // while it works, the record grows (the server saves the transcript as it goes)
    const t = status === "working" ? window.setInterval(get, 4000) : 0;
    return () => {
      on = false;
      window.clearInterval(t);
    };
  }, [board, name, status]);
  return runs;
}

const fromTurn = (t: Turn, session: string): TraceRun => ({ id: t.runId, session, prompt: t.prompt, status: t.status, at: t.at, events: t.events });

export function RunTrace({ seat }: { seat: CouncilSeat }) {
  const board = useActiveBoard();
  const name = seat.alias ?? seat.name;
  const fetched = useSeatRuns(board?.boardId, name, seat.status);
  const liveId = seat.session ?? (seat.crewId ? crewAsk(seat.crewId)?.session : undefined);
  const live = useSession(liveId ?? null);
  const liveTurn = live.turns.at(-1);
  const [shown, setShown] = useState(0);
  // the run this window streams is the freshest record of it; the server's list fills in the rest
  const runs = useMemo(() => {
    const list = [...fetched];
    if (liveTurn && liveId) {
      const mine = fromTurn(liveTurn, liveId);
      const at = list.findIndex((r) => (mine.id && r.id === mine.id) || (r.session === liveId && Math.abs(r.at - mine.at) < 5000));
      if (at >= 0) list[at] = { ...list[at], ...mine, events: mine.events.length >= list[at].events.length ? mine.events : list[at].events };
      else list.unshift(mine);
    }
    return list.sort((a, b) => b.at - a.at);
  }, [fetched, liveTurn, liveId]);
  const run = runs[Math.min(shown, runs.length - 1)];
  return (
    <div className="thinking-module" data-thinking-module={name}>
      <div className="thinking-module-head">
        <span className="thinking-module-title">Thinking</span>
        <button
          type="button"
          className="f-pill thinking-module-open"
          onClick={() => openTrail({ crew: seat.crewId ?? null, name })}
          data-tip={`Open the grid behind this one: ${name}'s chain of thought and steps, where it is working, and every other agent at work beside it`}
          data-thinking-open
        >
          Expand ⤢
        </button>
      </div>
      {run ? (
        <TraceView run={run} runs={runs} shown={shown} onShow={setShown} />
      ) : (
        <section className="run-trace is-empty" data-run-trace="none">
          <h3>Its last run</h3>
          <p>Nothing you asked {name} on this grid yet. What it thinks and does shows here, step by step.</p>
        </section>
      )}
    </div>
  );
}

export function TraceView({ run, runs = [run], shown = 0, onShow }: { run: TraceRun; runs?: TraceRun[]; shown?: number; onShow?: (i: number) => void }) {
  const steps = useMemo(() => traceSteps(run.events), [run.events]);
  const out = outcomeOf(run);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run.status !== "running") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [run.status]);
  const took = (run.finishedAt ?? (run.status === "running" ? now : undefined)) ? (run.finishedAt ?? now) - run.at : undefined;
  return (
    <section className={`run-trace is-${out.tone}`} data-run-trace={out.tone} aria-label="Its last run, step by step">
      <header className="run-trace-head">
        <span className={`run-trace-outcome is-${out.tone}`} data-run-outcome={out.word}>
          {out.tone === "live" && <span className="run-dots" aria-hidden><i /><i /><i /></span>}
          {out.word}
        </span>
        <time className="run-trace-when">
          {ago(run.at)}
          {took !== undefined ? ` · ${dur(took)}` : ""}
        </time>
        {runs.length > 1 && onShow && (
          <span className="run-trace-nav">
            <button type="button" className="run-trace-step-btn" disabled={shown >= runs.length - 1} onClick={() => onShow(shown + 1)} aria-label="An earlier run" data-tip="Earlier run">‹</button>
            <button type="button" className="run-trace-step-btn" disabled={shown <= 0} onClick={() => onShow(shown - 1)} aria-label="A later run" data-tip="Later run">›</button>
          </span>
        )}
      </header>
      <p className="run-trace-ask" title={run.prompt}>“{titleOf(run.prompt.replace(/^In the “[^”]*” section: /, ""))}”</p>
      <ol className="run-trace-steps">
        {steps.length === 0 && <li className="run-trace-step is-quiet">{run.status === "running" ? "Reading the ask…" : "It ended without a step."}</li>}
        {steps.map((s, i) => (
          <TraceStepRow key={i} step={s} last={i === steps.length - 1} live={run.status === "running"} />
        ))}
      </ol>
      {run.session && (
        <button type="button" className="f-pill run-trace-open" onClick={() => openSession({ id: run.session!, kind: "agent", title: titleOf(run.prompt) })} data-run-trace-open>
          Open the whole session
        </button>
      )}
    </section>
  );
}

function TraceStepRow({ step, last, live }: { step: TraceStep; last: boolean; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (step.kind === "thought") {
    const long = step.text.length > 220;
    return (
      <li className="run-trace-step is-thought" data-step="thought">
        <span className="run-trace-mark" aria-hidden />
        <div>
          <b>Thought</b>
          <p>{open || !long ? step.text.trim() : `${step.text.trim().slice(0, 210)}…`}</p>
          {long && (
            <button type="button" className="run-trace-more" onClick={() => setOpen(!open)}>
              {open ? "Less" : "All of it"}
            </button>
          )}
        </div>
      </li>
    );
  }
  if (step.kind === "said") {
    return (
      <li className="run-trace-step is-said" data-step="said">
        <span className="run-trace-mark" aria-hidden />
        <div>
          <b>Said</b>
          <p>{clip(step.text.trim(), open ? 4000 : 400)}</p>
          {step.text.length > 400 && (
            <button type="button" className="run-trace-more" onClick={() => setOpen(!open)}>
              {open ? "Less" : "All of it"}
            </button>
          )}
        </div>
      </li>
    );
  }
  if (step.kind === "error") {
    return (
      <li className="run-trace-step is-error" data-step="error">
        <span className="run-trace-mark" aria-hidden />
        <div>
          <b>Stopped on an error</b>
          <p>{step.text}</p>
        </div>
      </li>
    );
  }
  const state = step.result ? (step.result.ok ? "ok" : "bad") : live && last ? "live" : "none";
  return (
    <li className={`run-trace-step is-tool is-${state}`} data-step="tool" data-tool={step.name}>
      <span className="run-trace-mark" aria-hidden />
      <div>
        <b>{step.label}</b>
        {step.detail && <code className="run-trace-args">{step.detail}</code>}
        {step.result && <p className="run-trace-result">{step.result.ok ? "" : "Failed: "}{clip(step.result.summary, 280)}</p>}
        {state === "live" && <p className="run-trace-result">waiting for it…</p>}
      </div>
    </li>
  );
}

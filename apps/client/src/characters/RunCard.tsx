/**
 * The run card (2026-11-24, Josh): a small paper card at the top left of a working agent's figure that shows the run is
 * alive from the first moment, then its plan (the goal and the steps, the active one breathing, the done ones ticked:
 * Claude Code's todo list) and under it the latest of its reasoning in dim italics. Everyone on the grid sees the same
 * card: it reads the crew member's awareness (`CrewPresence.plan`, `thought`, `started`; docs/agent-harness.md §2).
 *
 * - `pending`: the person pressed send and the agent hasn't joined yet: dots, "Starting".
 * - working, no plan yet (or an older server that never sends one): dots, and what it says it's doing.
 * - done: a ✓ chip for 2.4 s (as the cursor's), then nothing; stopped and an error stay a chip while the seat does.
 *
 * Three sizes of the one card: `seat` (over the figure, at most four steps around the active one), `full` (the agent's
 * pane: every step, the thought in full, how long it has run) and `row` (the agents panel's "at work" rows).
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { CrewPlan } from "@foundation/protocol";
import "./council.css";

export interface RunState {
  status: "pending" | "idle" | "working" | "done" | "stopped" | "error";
  doing?: string;
  plan?: CrewPlan | null;
  thought?: string;
  started?: number;
  /** 0–5: the crew colour */
  hue?: number;
}

/** how long a done run keeps its ✓ (the cursor's) */
export const RUN_DONE_MS = 2400;
const SEAT_STEPS = 3;

/** the steps a card at a seat shows: the active one, the one before it and those after, at most four */
export function visibleSteps(plan: CrewPlan, max: number): { steps: Array<CrewPlan["steps"][number] & { n: number }>; before: number; after: number } {
  const all = plan.steps.map((s, n) => ({ ...s, n }));
  if (all.length <= max) return { steps: all, before: 0, after: 0 };
  const active = all.findIndex((s) => s.status === "active");
  const firstOpen = all.findIndex((s) => s.status !== "done");
  const at = active >= 0 ? active : firstOpen >= 0 ? firstOpen : all.length - 1;
  const start = Math.max(0, Math.min(at - 1, all.length - max));
  return { steps: all.slice(start, start + max), before: start, after: all.length - (start + max) };
}

const since = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function Dots() {
  return (
    <span className="run-dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

export function RunCard({ run, variant, onOpen, label }: { run: RunState; variant: "seat" | "full" | "row"; onOpen?: () => void; label?: string }) {
  // done: the ✓ for 2.4 s, then the card is gone (a seat's; the pane and the panel keep saying "done")
  const [doneGone, setDoneGone] = useState(false);
  useEffect(() => {
    if (run.status !== "done") return setDoneGone(false);
    const t = window.setTimeout(() => setDoneGone(true), RUN_DONE_MS);
    return () => window.clearTimeout(t);
  }, [run.status]);
  // the full card counts how long it has run
  const [, tick] = useState(0);
  useEffect(() => {
    if (variant !== "full" || !run.started || run.status !== "working") return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [variant, run.started, run.status]);

  if (run.status === "idle") return null;
  if (variant === "seat" && run.status === "done" && doneGone) return null;

  const style = run.hue !== undefined ? ({ ["--crew" as string]: `var(--color-crew-${run.hue % 6})` } as CSSProperties) : undefined;
  const Tag = onOpen ? "button" : "div";
  const common = {
    className: `run-card is-${variant} is-${run.status}${run.plan ? " has-plan" : ""}`,
    style,
    "data-run-card": run.status,
    ...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": label ?? "What it's doing: open its details", "data-tip": "Open its details" } : {}),
  };

  // a chip: a run that's over, or one with nothing to show yet
  if (run.status === "done" || run.status === "stopped" || run.status === "error") {
    return (
      <Tag {...common} className={`${common.className} is-chip`}>
        <span className="run-chip-mark" aria-hidden>
          {run.status === "done" ? "✓" : run.status === "stopped" ? "■" : "!"}
        </span>
        <span className="run-chip-text">{run.status === "done" ? "Done" : run.status === "stopped" ? "Stopped" : "Hit a problem"}</span>
      </Tag>
    );
  }
  if (run.status === "pending" || !run.plan) {
    const words = run.status === "pending" ? "Starting" : variant === "seat" ? (run.thought ? "" : "Working") : run.doing || "Working";
    return (
      <Tag {...common} className={`${common.className}${variant === "seat" && !run.thought ? " is-chip" : ""}`}>
        <span className="run-wait">
          <Dots />
          {words && <span className="run-wait-text">{words}</span>}
        </span>
        {run.thought && <p className="run-thought">{run.thought}</p>}
      </Tag>
    );
  }

  const plan = run.plan;
  const shown = variant === "seat" ? visibleSteps(plan, SEAT_STEPS) : { steps: plan.steps.map((s, n) => ({ ...s, n })), before: 0, after: 0 };
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <Tag {...common}>
      <span className="run-head">
        <span className="run-goal">{plan.goal || "The plan"}</span>
        <span className="run-count" aria-label={`${done} of ${plan.steps.length} steps done`}>
          {done}/{plan.steps.length}
        </span>
      </span>
      {variant === "full" && run.started && <span className="run-since">running for {since(run.started)}</span>}
      <ol className="run-steps">
        {shown.before > 0 && <li className="run-more">{shown.before} done before</li>}
        {shown.steps.map((s) => (
          <li key={s.n} className={`run-step is-${s.status}`} data-run-step={s.status}>
            <span className="run-step-mark" aria-hidden>
              {s.status === "done" ? "✓" : ""}
            </span>
            <span className="run-step-text">{s.text}</span>
          </li>
        ))}
        {shown.after > 0 && <li className="run-more">{shown.after} more</li>}
      </ol>
      {run.thought && <p className="run-thought">{run.thought}</p>}
    </Tag>
  );
}

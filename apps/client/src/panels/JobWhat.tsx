/**
 * A job's card before Run (PanelView AgentBody): what will run, from the job itself, never the card's text.
 * Run asks first, with the whole target and goal on screen; the press names their hash (jobs.ts shownHash).
 */

/** what a job will run, from the job itself (never the card's text): the whole target and goal, the program, and the hash a Run names */
export interface JobShown {
  target: string;
  goal: string;
  program: string | null;
  shown: string;
}

/**
 * The whole target and the whole goal of a job, scrollable and never cut, as the card shows them and as
 * its confirmation asks about them. `ask` adds the question and its two buttons.
 */
export function JobWhat({ what, ask }: { what: JobShown; ask?: { onRun(): void; onCancel(): void } }) {
  return (
    <div className={`agent-what${ask ? " is-asking" : ""}`}>
      {ask && <div className="agent-what-ask">{what.program ? `Run ${what.program} on this, with this goal?` : "Run this job?"}</div>}
      <div className="f-eyebrow">Target</div>
      <div className="agent-what-text agent-what-target">{what.target}</div>
      <div className="f-eyebrow">Goal</div>
      <div className="agent-what-text">{what.goal || "(none given)"}</div>
      {ask && (
        <div className="agent-what-actions">
          <button className="f-pill is-agent" onClick={ask.onRun}>
            Run it
          </button>
          <button className="f-pill" onClick={ask.onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}


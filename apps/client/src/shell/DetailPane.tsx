/**
 * What a conversation folded away, opened on the right (lib/detail.ts): code or a command in the
 * code face with Copy, the steps an agent took with what each was given, or its plan as a checklist.
 * A floor pane where search and the agents go; it takes their place and width.
 */

import { useState } from "react";
import { closeDetail, useDetail } from "../lib/detail";
import { WIDTHS, setUi, useUi } from "../state/ui";
import { FloorEdge } from "./FloorEdge";

export function DetailPane() {
  const ui = useUi();
  const d = useDetail();
  const [copied, setCopied] = useState(false);
  if (!ui.detail || !d || ui.presenting) return null;
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  return (
    <aside className="agents-pane detail-pane floor-pane" style={{ width: ui.agentsW }} aria-label={d.title} data-detail={d.kind}>
      <FloorEdge side="left" value={ui.agentsW} {...WIDTHS.agents} onChange={(w) => setUi({ agentsW: w })} label="Detail" />
      <header className="agents-head">
        <span className="detail-title">{d.title}</span>
        {d.kind === "code" && (
          <button className="f-pill detail-copy" onClick={() => copy(d.text)}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        <button className="top-btn" onClick={closeDetail} aria-label="Close" data-tip="Close">
          ✕
        </button>
      </header>
      <div className="agents-scroll detail-body">
        {d.kind === "code" && (
          <>
            <div className="detail-meta">
              {d.lang || "text"} · {d.text.split("\n").length} lines
            </div>
            <pre className="detail-code">
              <code>{d.text}</code>
            </pre>
          </>
        )}
        {d.kind === "steps" && (
          <ol className="detail-steps">
            {d.steps.map((s, i) => (
              <li key={i}>
                <div className="detail-step-head">
                  <b>{s.words}</b>
                  <code>{s.name}</code>
                </div>
                {s.input !== undefined && s.input !== null && Object.keys(s.input as object).length > 0 && <pre className="detail-code is-small">{JSON.stringify(s.input, null, 2)}</pre>}
              </li>
            ))}
          </ol>
        )}
        {d.kind === "plan" && (
          <>
            {d.goal && <p className="detail-goal">{d.goal}</p>}
            <ol className="detail-plan">
              {d.steps.map((s, i) => (
                <li key={i} data-status={s.status}>
                  <span className="detail-box" aria-hidden>
                    {s.status === "done" ? "✓" : ""}
                  </span>
                  {s.text}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}

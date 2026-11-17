/**
 * What the Shiba says, drawn as more than a sentence (2026-11-16): its words as markdown (lists,
 * tables, links, pictures from Foundation's files), its plan as a checklist when it keeps one, and
 * anything long and literal folded to a line that opens on the right (lib/detail.ts): a block of
 * code or a command, and the steps it took to answer. White over the room, like everything on Today.
 */

import { useMemo } from "react";
import { openDetail } from "../lib/detail";
import { renderMarkdown } from "../utils/markdown";
import type { Exchange } from "./model";

import { partsOf } from "./talk";
export { partsOf };

const COMMANDS = new Set(["bash", "sh", "shell", "zsh", "powershell", "ps1", "cmd", "console"]);

export function Folded({ lang, text }: { lang: string; text: string }) {
  const n = text.split("\n").length;
  const command = COMMANDS.has(lang.toLowerCase());
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return (
    <button type="button" className="shiba-fold" data-shiba-fold={command ? "command" : "code"} onClick={() => openDetail({ kind: "code", title: command ? "Command" : lang ? `Code · ${lang}` : "Code", lang, text })}>
      <span className="shiba-fold-mark" aria-hidden>
        {command ? "›_" : "{ }"}
      </span>
      <span className="shiba-fold-first">{first}</span>
      <span className="shiba-fold-n">{n === 1 ? (command ? "command" : "1 line") : `${n} lines`}</span>
      <span className="shiba-fold-open" aria-hidden>
        ↗
      </span>
    </button>
  );
}

export function ShibaTalk({ exchange, large = false }: { exchange: Pick<Exchange, "answer" | "tools" | "plan">; large?: boolean }) {
  const parts = useMemo(() => partsOf(exchange.answer.trim()), [exchange.answer]);
  const plan = exchange.plan;
  const tools = exchange.tools ?? [];
  const done = plan?.steps.filter((s) => s.status === "done").length ?? 0;
  return (
    <div className={`shiba-talk${large ? " is-large" : ""}`}>
      {parts.map((p, i) => (p.kind === "code" ? <Folded key={i} lang={p.lang} text={p.text} /> : <div key={i} className="shiba-prose note-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} />))}
      {plan && plan.steps.length > 0 && (
        <button type="button" className="shiba-plan" data-shiba-plan onClick={() => openDetail({ kind: "plan", title: "The Shiba's plan", goal: plan.goal, steps: plan.steps })}>
          <span className="shiba-plan-head">
            Plan
            <span className="shiba-plan-count">
              {done}/{plan.steps.length}
            </span>
          </span>
          {plan.goal && <span className="shiba-plan-goal">{plan.goal}</span>}
          <span className="shiba-plan-steps">
            {plan.steps.slice(0, 5).map((s, i) => (
              <span key={i} className="shiba-plan-step" data-status={s.status}>
                <span className="shiba-plan-box" aria-hidden>
                  {s.status === "done" ? "✓" : ""}
                </span>
                {s.text}
              </span>
            ))}
            {plan.steps.length > 5 && <span className="shiba-plan-more">and {plan.steps.length - 5} more ↗</span>}
          </span>
        </button>
      )}
      {tools.length > 0 && (
        <button type="button" className="shiba-fold is-steps" data-shiba-fold="steps" onClick={() => openDetail({ kind: "steps", title: "What the Shiba did", steps: tools })}>
          <span className="shiba-fold-mark" aria-hidden>
            ✦
          </span>
          <span className="shiba-fold-first">{tools[tools.length - 1].words}</span>
          <span className="shiba-fold-n">{tools.length === 1 ? "1 step" : `${tools.length} steps`}</span>
          <span className="shiba-fold-open" aria-hidden>
            ↗
          </span>
        </button>
      )}
    </div>
  );
}

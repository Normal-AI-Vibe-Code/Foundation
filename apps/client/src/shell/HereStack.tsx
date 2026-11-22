/**
 * Who is on a grid, on its row in the side menu (2026-11-21, Josh: "show when people are in the boards and
 * collaborating, as well as the agents"): the others with it open, as their faces on their cursor colours, then its
 * agents as the ✦ on their crew colour, a few overlapping, "+n" for the rest. You aren't counted: the open grid
 * already says you're there. The line it says is the row's tip.
 */

import type { WhereBoard } from "@foundation/protocol";
import { useWhereabouts, othersOn, hereLine } from "../lib/whereabouts";
import { initials } from "./Presence";

const SHOWN = 3;

/** `all`: who is where to draw instead of the live list (#/design, which has no server) */
export function HereStack({ boardId, me, all: given }: { boardId: string; me?: string; all?: Record<string, WhereBoard> }) {
  const live = useWhereabouts();
  const all = given ?? live;
  const { people, agents } = othersOn(all, boardId, me);
  const n = people.length + agents.length;
  if (!n) return null;
  const faces = [
    ...people.map((p) => ({ key: `p:${p.id}`, agent: false, label: initials(p.name), color: p.color, working: false })),
    ...agents.map((a) => ({ key: `a:${a.id}`, agent: true, label: "✦", color: `var(--color-crew-${a.hue % 6})`, working: a.status === "working" })),
  ];
  const line = hereLine(people, agents);
  return (
    <span className="here-stack" data-here={boardId} data-here-people={people.length} data-here-agents={agents.length} data-tip={line} aria-label={line} role="img">
      {faces.slice(0, SHOWN).map((f, i) => (
        <span key={f.key} className={`here-face${f.agent ? " is-agent" : ""}${f.working ? " is-working" : ""}`} style={{ background: f.color, zIndex: SHOWN - i }} aria-hidden>
          {f.label}
        </span>
      ))}
      {n > SHOWN && <span className="here-more" aria-hidden>+{n - SHOWN}</span>}
    </span>
  );
}

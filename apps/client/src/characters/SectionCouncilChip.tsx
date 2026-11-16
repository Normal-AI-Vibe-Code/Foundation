/**
 * A section's council, at rest on its header: the council's mark and how many agents belong to the
 * section (and how many of them are at work). A press brings the council up on top of the section.
 */

import { toggleCouncil, useCouncilOpen } from "../lib/councilOpen";
import { useSectionCrew } from "../lib/crewWatch";
import { usePosted } from "../lib/posted";
import { CouncilGlyph } from "./CouncilGlyph";

export function SectionCouncilChip({ sectionId, sectionName }: { sectionId: string; sectionName: string }) {
  const crew = useSectionCrew(sectionId);
  const posted = usePosted()[sectionId] ?? [];
  const open = useCouncilOpen();
  const on = open?.kind === "section" && open.id === sectionId;
  const working = crew.filter((p) => p.crew.status === "working").length;
  // assigned agents, and anyone at work here who isn't one of them
  const keys = new Set(posted.map((p) => p.key));
  const n = posted.length + crew.filter((p) => !keys.has(p.crew.via ?? "claude")).length;
  const tip = working ? `${working} of ${sectionName}'s agents at work · press for its council` : n ? `${n} agent${n === 1 ? "" : "s"} on ${sectionName}'s council · press to talk to them` : `Council of ${sectionName}: add agents and talk to them`;
  return (
    <button type="button" className={`sec-agents-chip${working ? " is-working" : ""}${on ? " is-on" : ""}`} data-tip={tip} aria-label={tip} aria-pressed={on} data-sec-agents={working} data-sec-council={n} onClick={() => toggleCouncil({ kind: "section", id: sectionId })}>
      {working ? <span className="f-dot is-agent is-live" /> : <CouncilGlyph size={13} />}
      {working ? `${working} at work` : n ? `${n} ${n === 1 ? "agent" : "agents"}` : "Council"}
    </button>
  );
}

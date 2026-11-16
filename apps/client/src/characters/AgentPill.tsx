/**
 * An agent, on a card (2026-11-15): a pill with its name and, when the agent wears a character someone
 * assigned (Settings → Avatars, or a council), that character's picture. A picture, never a live avatar:
 * a card says who made it or who is inside it; the council is where agents are alive.
 *
 * Which picture: the one assigned to this very name; else, for one of the server's own crew (Wren,
 * Kestrel…: Claude at work under a cursor's name), the one assigned to Claude. No assignment: the spark.
 */

import { useFileSrc } from "../lib/fileSrc";
import { stillRole } from "./Avatar";
import { characterFilePath, readyCharacters, useRoster } from "./roster";

export function AgentPill({ name, tip, className = "" }: { name: string; tip?: string; className?: string }) {
  const roster = useRoster();
  const id = roster.avatars[name] ?? roster.avatars[name.replace(/\s+\d+$/, "")] ?? roster.avatars.Claude;
  const worn = id ? readyCharacters(roster).find((c) => c.id === id) : undefined;
  const role = worn ? stillRole(worn, "bust") : null;
  const src = useFileSrc(worn && role ? characterFilePath(worn.id, role) : null);
  return (
    <span className={`card-maker${src ? " has-face" : ""} ${className}`} data-tip={tip ?? `${name}, an agent${worn ? `, as ${worn.name}` : ""}`} data-agent-pill={name}>
      {src ? <img className="card-maker-face" src={src} alt="" draggable={false} /> : <span aria-hidden>✦</span>} {name}
    </span>
  );
}

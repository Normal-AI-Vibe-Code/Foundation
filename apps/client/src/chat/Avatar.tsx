/**
 * Who spoke, as a face. A person: their initials on their own colour, round. An agent: the character it
 * wears (Settings → Avatars; the roster) standing behind a violet baseline, chest up, no disc and no ring,
 * or the ✦ on that line when it wears none; under 20 px the ✦ on the agent tint (AgentFigure.tsx). A
 * ghost (someone on the far side of a bridge): their picture when the service gave one, else the
 * service's monogram on the panel well. A presence dot when it's asked for.
 */

import type { ChatParty, ChatService } from "@foundation/protocol";
import { useFileSrc } from "../lib/fileSrc";
import { initials } from "../shell/Presence";
import { stillRole } from "../characters/Avatar";
import { characterFilePath, readyCharacters, useRoster } from "../characters/roster";
import { AgentFigure } from "./AgentFigure";

export const SERVICE_NAME: Record<ChatService, string> = { slack: "Slack", gmail: "Mail", whatsapp: "WhatsApp", instagram: "Instagram", wechat: "WeChat" };
const MONOGRAM: Record<ChatService, string> = { slack: "S", gmail: "M", whatsapp: "W", instagram: "Ig", wechat: "Wc" };

/** an agent's picture: the character assigned to its name, else (one of the server's crew) Claude's */
export function useAgentFace(name: string): string | undefined {
  const roster = useRoster();
  const id = roster.avatars[name] ?? roster.avatars[name.replace(/\s+\d+$/, "")] ?? roster.avatars.Claude;
  const worn = id ? readyCharacters(roster).find((c) => c.id === id) : undefined;
  const role = worn ? stillRole(worn, "bust") : null;
  return useFileSrc(worn && role ? characterFilePath(worn.id, role) : null);
}

export function PartyAvatar({ party, size = 32, online }: { party: ChatParty; size?: number; online?: boolean }) {
  const dot = online !== undefined && <span className={`chat-presence${online ? " is-on" : ""}`} aria-label={online ? "online" : "away"} />;
  const style = { width: size, height: size, fontSize: size >= 28 ? 12 : 10 };
  if (party.kind === "agent") return <AgentFace party={party} size={size} online={online} />;
  if (party.kind === "ghost") return <GhostFace party={party} style={style} dot={dot} />;
  if (party.kind === "system") {
    return (
      <span className="chat-avatar is-system" style={style} aria-hidden>
        ·
      </span>
    );
  }
  return (
    <span className="chat-avatar is-person" style={{ ...style, background: party.color || undefined }} aria-hidden>
      {(size < 24 ? initials(party.name).slice(0, 1) : initials(party.name)) || "?"}
      {dot}
    </span>
  );
}

/** an agent is never a disc (2026-11-20): its figure cut by a baseline, or under 20 px the ✦ on its tint (AgentFigure.tsx) */
function AgentFace({ party, size, online }: { party: ChatParty; size: number; online?: boolean }) {
  return <AgentFigure name={party.name} size={size} online={online} className="chat-avatar-agent" />;
}

function GhostFace({ party, style, dot }: { party: ChatParty; style: React.CSSProperties; dot: React.ReactNode }) {
  const src = useFileSrc(party.avatar ?? null);
  const service = party.service;
  return (
    <span className={`chat-avatar is-ghost${src ? " has-face" : ""}`} style={style} aria-hidden data-service={service}>
      {src ? <img src={src} alt="" draggable={false} referrerPolicy="no-referrer" /> : service ? MONOGRAM[service] : initials(party.name)}
      {src && service && <span className="chat-ghost-bead">{MONOGRAM[service]}</span>}
      {dot}
    </span>
  );
}

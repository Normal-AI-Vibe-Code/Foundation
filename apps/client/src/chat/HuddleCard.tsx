/**
 * A huddle's card in a channel (a message of type `huddle`): who, since when or for how long, and Join.
 * This is the place's own simple card; the huddles builder (H1) replaces this file with the real one —
 * keep the export and its props: `HuddleCard({ message, live, onJoin })`.
 */

import type { ChatHuddleState, ChatMessage } from "@foundation/protocol";

export interface HuddleCardProps {
  message: ChatMessage;
  /** the channel's huddle, when one is going on now (the card's own if its id matches) */
  live?: ChatHuddleState | null;
  onJoin?: (huddleId: string) => void;
}

const mins = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
};

export function HuddleCard({ message, live, onJoin }: HuddleCardProps) {
  const h = message.huddle;
  if (!h) return null;
  const isLive = !h.endedAt && (!live || live.id === h.id);
  const people = live && live.id === h.id ? live.people : h.people;
  const when = isLive ? `Live for ${mins(Date.now() - h.startedAt)}` : h.endedAt ? `${mins(h.endedAt - h.startedAt)} · ended ${new Date(h.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
  return (
    <div className={`chat-huddle${isLive ? " is-live" : ""}`} data-huddle={h.id}>
      <div className="chat-huddle-head">
        <span className={`f-dot${isLive ? " is-ok is-live" : ""}`} />
        <span className="chat-huddle-title">Huddle</span>
        <span className="chat-huddle-when">{when}</span>
        {h.recorded && <span className="chat-huddle-rec">REC</span>}
      </div>
      <div className="chat-huddle-people">{people.length ? people.join(", ") : "Nobody yet"}</div>
      {isLive && (
        <button className="f-pill is-accent" disabled={!onJoin} onClick={() => onJoin?.(h.id)} data-tip={onJoin ? "Join with your microphone" : "Joining from a channel comes with huddles in channels"}>
          Join
        </button>
      )}
    </div>
  );
}

export default HuddleCard;

/**
 * A channel's huddle in ChatForm (H1).
 *
 *  - HuddleCard: the `huddle` message. Live: the faces of who's in it, how long, Join / Listen in, REC.
 *    Ended: who came, how long, a few lines of what was said, its recordings, Replay, and Open on its grid
 *    when it was taken to one. Props are the place's: `{ message, live, onJoin }`, plus `onReplay`.
 *  - startChannelHuddle(channelId): start the channel's huddle (or join the one going on) with your camera.
 *  - ChannelHuddleButton: the head's button (start, or join the live one; green while live).
 *  - ChannelHuddleDock: the call docked above the timeline while you're in it or listening in: the stage,
 *    the transcript beside it, the controls, and Take to a grid….
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChatChannelView, ChatHuddleState, ChatMessage, HuddleLine } from "@foundation/protocol";
import { HuddleRoom, joinHuddle, leaveHuddle, useJoinedRoom, useRoom, type HuddleMeta } from "../lib/huddle";
import { api } from "../lib/api";
import { goChat } from "../lib/place";
import { toast } from "../state/ui";
import { CallControls, CallStage, goToCard, PlacePicker, Portrait } from "../panels/HuddleCall";
import { Transcript } from "../panels/HuddleView";
import { getChat, useChat } from "./model";
import { BringFileToGrid } from "./CadAttachment";
import { AgentFigure } from "./AgentFigure";
import "../panels/huddlecall.css";

export interface HuddleCardProps {
  message: ChatMessage;
  /** the channel's huddle, when one is going on now (the card's own if its id matches) */
  live?: ChatHuddleState | null;
  onJoin?: (huddleId: string) => void;
  /** Replay a recorded session (R1's); without it, the Huddles tab opens the session */
  onReplay?: (sessionId: string) => void;
  /** an ended session's lines and recordings, when the caller has them (the design page); otherwise fetched */
  brief?: SessionBrief;
}

// ---------- starting, joining, listening ----------

const meOf = () => ({ name: getChat().me?.name ?? "me" });
const metaOf = (channelId: string): HuddleMeta => {
  const c = getChat().channels[channelId];
  const name = !c ? "Huddle" : c.kind === "open" || c.kind === "private" ? `Huddle · #${c.name}` : `Huddle · ${(c.members ?? []).filter((m) => m.id !== getChat().me?.id).map((m) => m.name).join(", ") || "you"}`;
  return { name, channel: channelId };
};

/** start the channel's huddle, or join the one going on, with your camera and mic */
export async function startChannelHuddle(channelId: string): Promise<void> {
  try {
    const r = await api<{ huddle: ChatHuddleState }>(`/api/chat/channels/${channelId}/huddle`, { method: "POST", json: { request_id: `${channelId}:${Date.now()}` } });
    await joinChannelHuddle(channelId, r.huddle.id, r.huddle.recording);
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

/** join a channel's live huddle */
export async function joinChannelHuddle(channelId: string, huddleId: string, recording = false) {
  if (listening?.huddleId === huddleId) setListening(null);
  const room = await joinHuddle("chat", huddleId, meOf(), { recording, meta: metaOf(channelId) });
  const v = room.snapshot();
  if (v.status === "error") {
    toast(v.error ?? "Couldn't join", "bad");
    leaveHuddle();
  }
}

// listening in: a receive-only room for one channel's huddle, owned by the dock
let listening: { channel: string; huddleId: string; room: HuddleRoom } | null = null;
const listenSubs = new Set<() => void>();
function setListening(next: { channel: string; huddleId: string } | null) {
  listening?.room.stop();
  listening = next ? { ...next, room: new HuddleRoom("chat", next.huddleId, false, meOf(), metaOf(next.channel)) } : null;
  if (listening) {
    void listening.room.start();
    listening.room.setVoice(true);
  }
  listenSubs.forEach((f) => f());
}
function useListening() {
  return useSyncExternalStore(
    (f) => {
      listenSubs.add(f);
      return () => listenSubs.delete(f);
    },
    () => listening,
  );
}

// ---------- the card ----------

const mins = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
};
const clockOf = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export interface SessionBrief {
  lines: HuddleLine[];
  media: Array<{ fileId: string; person: string; url: string; kind?: "screen" }>;
}
const briefs = new Map<string, Promise<SessionBrief | null>>();
function useSessionBrief(id: string | undefined) {
  const [s, setS] = useState<SessionBrief | null>(null);
  useEffect(() => {
    if (!id) return;
    let on = true;
    if (!briefs.has(id)) briefs.set(id, api<{ session: SessionBrief }>(`/api/huddles/sessions/${id}`).then((r) => r.session).catch(() => null));
    void briefs.get(id)!.then((v) => on && setS(v));
    return () => {
      on = false;
    };
  }, [id]);
  return s;
}

export function HuddleCard({ message, live, onJoin, onReplay, brief: given }: HuddleCardProps) {
  const h = message.huddle;
  const joined = useJoinedRoom();
  const listen = useListening();
  const isLive = Boolean(h && !h.endedAt && (!live || live.id === h.id) && live);
  const now = useNow(isLive);
  const fetched = useSessionBrief(h && h.endedAt && !given ? h.session : undefined);
  const brief = given ?? fetched;
  if (!h) return null;
  const people = isLive && live ? live.people : h.people;
  const inIt = joined?.board === "chat" && joined.huddleId === h.id;
  const listening = listen?.huddleId === h.id;
  const placed = h.board && h.board !== "chat";
  const said = (brief?.lines ?? []).filter((l) => l.source !== "system");
  const replay = () => (h.session ? (onReplay ? onReplay(h.session) : goChat("huddles", h.session)) : undefined);
  return (
    <div className={`hcard${isLive ? " is-live" : ""}`} data-huddle={h.id} data-huddle-state={isLive ? "live" : h.endedAt ? "ended" : "waiting"}>
      <div className="hcard-head">
        <span className={`f-dot${isLive ? " is-ok is-live" : ""}`} />
        <span>Huddle</span>
        <span className="hcard-when">{isLive ? clockOf(now - (live?.liveSince ?? h.startedAt)) : h.endedAt ? `${mins(h.endedAt - h.startedAt)} · ended ${new Date(h.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
        <span className="hcard-gap" />
        {((isLive && live?.recording) || h.recorded) && (
          <span className="huddle-rec" data-tip={isLive ? "Recording now: everyone in it is archived (unless they said don't record me)" : "It was recorded"}>
            <span className="huddle-rec-dot" />
            REC
          </span>
        )}
      </div>
      <div className="hcard-faces">
        <span className="huddle-faces">
          {people.slice(0, 6).map((n) => (
            <Portrait key={n} name={n} size={28} />
          ))}
          {(live?.agents ?? []).map((a) => (
            <span key={a} className="hcard-agent" aria-label={`${a} (agent)`}>
              <AgentFigure name={a} size={28} />
            </span>
          ))}
        </span>
        <span className="hcard-names">{people.length ? people.join(", ") : isLive ? "Starting…" : "Nobody came"}</span>
      </div>
      {!isLive && said.length > 0 && (
        <p className="hcard-excerpt">
          {said.slice(0, 3).map((l) => (
            <span key={l.id}>
              <b>{l.speaker}</b> {l.text.length > 120 ? `${l.text.slice(0, 120)}…` : l.text}
              <br />
            </span>
          ))}
        </p>
      )}
      <div className="hcard-foot">
        {isLive ? (
          <>
            <button className="f-pill is-accent" disabled={inIt} onClick={() => (onJoin ? onJoin(h.id) : void joinChannelHuddle(message.channel, h.id, Boolean(live?.recording)))} data-huddle-join>
              {inIt ? "You're in it" : "Join"}
            </button>
            {!inIt && (
              <button className={`f-pill${listening ? " is-primary" : ""}`} onClick={() => setListening(listening ? null : { channel: message.channel, huddleId: h.id })} data-huddle-listen>
                {listening ? "Listening" : "Listen in"}
              </button>
            )}
          </>
        ) : (
          h.endedAt && (
            <>
              {h.session && (
                <button className="f-pill is-accent" onClick={replay} data-huddle-replay>
                  Replay
                </button>
              )}
              {brief && brief.media.length > 0 && (
                <button className="f-pill" onClick={() => h.session && goChat("huddles", h.session)} data-huddle-recordings>
                  {brief.media.length} {brief.media.length === 1 ? "recording" : "recordings"}
                </button>
              )}
            </>
          )
        )}
        {placed && (
          <button className="f-pill" onClick={() => goToCard(h.board!, h.id)} data-huddle-grid>
            Open on its grid
          </button>
        )}
      </div>
    </div>
  );
}

export default HuddleCard;

// ---------- the channel head's button ----------

export function ChannelHuddleButton({ channel }: { channel: ChatChannelView }) {
  const joined = useJoinedRoom();
  const live = channel.huddle;
  const inIt = Boolean(live && joined?.board === "chat" && joined.huddleId === live.id);
  if (channel.archivedAt || channel.kind === "portal") return null;
  return (
    <button
      className={`chat-head-btn hhead-btn${live ? " is-live" : ""}`}
      data-huddle-start={channel.id}
      data-tip={inIt ? "You're in the huddle" : live ? `Join the huddle${live.people.length ? ` with ${live.people.join(", ")}` : ""}` : "Start a huddle: video, voice and a transcript"}
      aria-label={live ? "Join the huddle" : "Start a huddle"}
      disabled={inIt}
      onClick={() => void (live ? joinChannelHuddle(channel.id, live.id, live.recording) : startChannelHuddle(channel.id))}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 9.5V8a5 5 0 0 1 10 0v1.5" />
        <rect x="2" y="9" width="3" height="4.5" rx="1.2" />
        <rect x="11" y="9" width="3" height="4.5" rx="1.2" />
      </svg>
      {live && <span>{live.people.length || "•"}</span>}
    </button>
  );
}

// ---------- the call, docked above the timeline ----------

export function ChannelHuddleDock({ channel }: { channel: ChatChannelView }) {
  const joined = useJoinedRoom();
  const listen = useListening();
  const chat = useChat();
  const live = channel.huddle;
  const mine = joined?.board === "chat" && (joined.meta.channel === channel.id || joined.huddleId === live?.id) ? joined : null;
  const ear = !mine && listen?.channel === channel.id ? listen.room : null;
  const room = mine ?? ear;
  const view = useRoom(room);
  const [placing, setPlacing] = useState(false);
  const [notes, setNotes] = useState("");
  const now = useNow(Boolean(room));
  // a listened-in huddle that ended: stop listening
  useEffect(() => {
    if (ear && (view.ended || !live || live.id !== ear.huddleId)) setListening(null);
  }, [ear, view.ended, live]);
  if (!room) return null;
  const me = chat.me?.name ?? "me";
  const title = metaOf(channel.id).name ?? "Huddle";
  return (
    <section className="hdock" aria-label="Huddle" data-huddle-dock={room.huddleId}>
      <div className="hdock-head">
        <span className={`f-dot${view.ended ? "" : " is-ok is-live"}`} />
        <span className="hdock-title">{title}</span>
        <span className="hcard-when">{view.ended ? "ended" : live?.id === room.huddleId ? clockOf(now - live.liveSince) : ""}</span>
        {view.recording && (
          <span className="huddle-rec" data-tip={`Recording — started by ${view.recording.by}. ${view.noRec ? "Not you: you said don't record me." : "Everyone in it is archived."}`}>
            <span className="huddle-rec-dot" />
            REC{view.noRec ? " · not you" : ""}
          </span>
        )}
        {live?.board && live.board !== "chat" && (
          <button className="f-pill hdock-head-btn" onClick={() => goToCard(live.board, room.huddleId)}>
            On its grid
          </button>
        )}
        <span className="hcard-gap" />
        {ear && (
          <>
            <button className="f-pill is-accent hdock-head-btn" onClick={() => void joinChannelHuddle(channel.id, ear.huddleId, Boolean(live?.recording))}>
              Join
            </button>
            <button className="f-pill hdock-head-btn" onClick={() => setListening(null)}>
              Stop listening
            </button>
          </>
        )}
      </div>
      <div className="hdock-body">
        <CallStage view={view} inThis={Boolean(mine)} me={me} listen={Boolean(ear)} live={live?.people ?? []} />
        <div className="hdock-notes huddle-notes">
          <div className="huddle-lines wheel-own">{view.lines.length ? <Transcript lines={view.lines} /> : <div className="huddle-empty-note">What's said appears here, by speaker. Type a note any time.</div>}</div>
          {mine && (
            <form
              className="huddle-say"
              onSubmit={(e) => {
                e.preventDefault();
                mine.say(notes);
                setNotes("");
              }}
            >
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Write into the transcript…" aria-label="Write into the transcript" data-huddle-say />
            </form>
          )}
        </div>
      </div>
      {mine && <CallControls room={mine} view={view} agentChoices={chat.agents.map((a) => a.name)} onPlace={() => setPlacing((p) => !p)} extra={live?.board && live.board !== "chat" ? <BringFileToGrid files={(chat.timelines[channel.id]?.messages ?? []).flatMap((m) => m.files).reverse()} board={live.board} section={live.section} /> : undefined} />}
      {placing && mine && <PlacePicker huddleId={mine.huddleId} onClose={() => setPlacing(false)} />}
    </section>
  );
}

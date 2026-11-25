/**
 * ChatForm's Huddles tab (H1): the huddles going on now in your conversations (join one), then every
 * session you may see, newest first: who, when, how long, where (its channel, and the grids it was taken
 * to), a search through who came and what was said, and Replay.
 *
 * `rest` = a session id opens it: its recordings and its transcript side by side. The replay of a
 * session on its grid is R1's: when `panels/ReplayView.tsx` exists and exports `SessionReplay`
 * (`{ sessionId }`), it is drawn above them.
 */

import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from "react";
import type { ChatHuddleState, HuddleLine, UserInfo } from "@foundation/protocol";
import { api } from "../../lib/api";
import { goChat } from "../../lib/place";
import { useGrids } from "../../lib/grids";
import { useJoinedRoom } from "../../lib/huddle";
import { Portrait, goToCard } from "../../panels/HuddleCall";
import { FileVideo, Transcript, day, duration } from "../../panels/HuddleView";
import { joinChannelHuddle } from "../HuddleCard";
import { useChat } from "../model";
import "./huddles.css";

interface ChannelRef {
  id: string;
  name: string;
  kind: string;
  members?: Array<{ id: string; name: string }>;
}
interface LiveRow {
  huddle: ChatHuddleState;
  channel: ChannelRef;
  card: string | null;
  startedBy: string;
}
interface SessionRow {
  id: string;
  huddleId: string;
  home: "chat" | "board";
  startedAt: number;
  endedAt: number | null;
  people: string[];
  lines: number;
  recordings: number;
  channel?: ChannelRef;
  board?: string;
  name?: string;
  places: Array<{ board: string; section: string; at: number }>;
  snippet?: string;
}
interface SessionFull {
  id: string;
  huddle_id: string;
  board_id: string;
  started_at: number;
  ended_at: number | null;
  people: string[];
  lines: HuddleLine[];
  media: Array<{ fileId: string; person: string; startedAt: number; endedAt: number; url: string; kind?: "screen" }>;
  home?: "chat" | "board";
  channel: string | null;
  places?: Array<{ board: string; section: string; at: number; by: string }>;
  recordings?: Array<{ by: string; startedAt: number; stoppedAt: number | null }>;
  optedOut?: string[];
  agents?: string[];
}

// R1's replay, if it's there yet (a glob finds nothing, and builds, when it isn't)
const replayModules = import.meta.glob("../../panels/ReplayView.tsx");
const replayLoader = Object.values(replayModules)[0] as (() => Promise<{ SessionReplay?: ComponentType<{ sessionId: string }> }>) | undefined;
const Nothing: ComponentType<{ sessionId: string }> = () => null;
const SessionReplay = replayLoader ? lazy(() => replayLoader().then((m) => ({ default: m.SessionReplay ?? Nothing }))) : null;

function channelLabel(c: ChannelRef | undefined, meId?: string) {
  if (!c) return "";
  if (c.kind === "open" || c.kind === "private") return `#${c.name}`;
  const others = (c.members ?? []).filter((m) => m.id !== meId).map((m) => m.name);
  return others.join(", ") || c.name || "Just you";
}

export default function HuddlesTab({ user, rest }: { user: UserInfo; rest: string }) {
  const sid = rest.split("/")[0] || "";
  return <div className="htab" data-chat-tab="huddles">{sid ? <SessionDetail id={sid} user={user} /> : <Overview user={user} />}</div>;
}

function Overview({ user }: { user: UserInfo }) {
  const chat = useChat();
  const joined = useJoinedRoom();
  const [live, setLive] = useState<LiveRow[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [q, setQ] = useState("");
  const [why, setWhy] = useState("");
  // the channels' huddles, as the chat socket hears them: refetch when one starts or ends
  const liveKey = useMemo(
    () =>
      Object.values(chat.channels)
        .map((c) => c.huddle?.id ?? "")
        .filter(Boolean)
        .sort()
        .join(),
    [chat.channels],
  );
  useEffect(() => {
    let on = true;
    const load = () =>
      api<{ live: LiveRow[] }>("/api/huddles/live")
        .then((r) => on && setLive(r.live))
        .catch((e: Error) => on && setWhy(e.message));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [liveKey]);
  useEffect(() => {
    let on = true;
    const t = setTimeout(
      () =>
        api<{ sessions: SessionRow[] }>(`/api/huddles/sessions?limit=80${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`)
          .then((r) => on && setSessions(r.sessions))
          .catch((e: Error) => on && setWhy(e.message)),
      q ? 250 : 0,
    );
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [q, liveKey]);

  return (
    <div className="htab-overview">
      <section className="htab-section" aria-label="Live now">
        <h2 className="htab-h">Live now</h2>
        {!live ? (
          <p className="htab-note" role={why ? "alert" : "status"}>{why || "Looking…"}</p>
        ) : !live.length ? (
          <p className="htab-note">No huddles going on in your conversations. Start one from any channel's head.</p>
        ) : (
          <div className="htab-live">
            {live.map((l) => {
              const inIt = joined?.board === "chat" && joined.huddleId === l.huddle.id;
              return (
                <div key={l.huddle.id} className="htab-live-row" data-htab-live={l.huddle.id}>
                  <span className="f-dot is-ok is-live" />
                  <button type="button" className="htab-where" onClick={() => goChat("chat", l.channel.id)}>
                    {channelLabel(l.channel, user.id)}
                  </button>
                  <span className="huddle-faces">
                    {l.huddle.people.map((n) => (
                      <Portrait key={n} name={n} size={24} />
                    ))}
                  </span>
                  <span className="htab-dim">{l.huddle.people.length ? l.huddle.people.join(", ") : `${l.startedBy} is starting it`}</span>
                  {l.huddle.recording && (
                    <span className="huddle-rec">
                      <span className="huddle-rec-dot" />
                      REC
                    </span>
                  )}
                  <span className="hcard-gap" />
                  <button type="button" className="f-pill is-accent" disabled={inIt} onClick={() => void joinChannelHuddle(l.channel.id, l.huddle.id, l.huddle.recording)}>
                    {inIt ? "You're in it" : "Join"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section className="htab-section" aria-label="Sessions">
        <div className="htab-section-head">
          <h2 className="htab-h">Sessions</h2>
          <input className="htab-search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Search who came and what was said" aria-label="Search huddles" data-htab-search />
        </div>
        {!sessions ? (
          <p className="htab-note" role={why ? "alert" : "status"}>{why || "Opening the archive…"}</p>
        ) : !sessions.length ? (
          <p className="htab-note">{q ? "Nothing said matches." : "No sessions yet. Each time people gather in a huddle becomes one: who came, what was said, the recordings."}</p>
        ) : (
          <div className="htab-list" role="list">
            {sessions.map((s) => (
              <SessionLine key={s.id} s={s} meId={user.id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SessionLine({ s, meId }: { s: SessionRow; meId: string }) {
  const grids = useGrids();
  const where = s.home === "chat" ? channelLabel(s.channel, meId) : `${s.name ?? "Huddle"} · ${grids.find((g) => g.id === s.board)?.name ?? s.board}`;
  const peopleText = s.people.join(", ") || "Nobody";
  return (
    <div className="htab-row" role="listitem" data-htab-session={s.id}>
      <button type="button" className="htab-row-main" onClick={() => goChat("huddles", s.id)}>
        <span className="htab-row-when">{day(s.startedAt)}</span>
        <span className="htab-row-where" title={where}>{where}</span>
        <span className="htab-dim">{s.endedAt ? duration(s.endedAt - s.startedAt) : "live now"}</span>
        <span className="htab-row-people" title={peopleText}>{peopleText}</span>
        <span className="htab-dim">
          {s.lines} lines{s.recordings ? ` · ${s.recordings} rec` : ""}
          {s.places.length ? ` · on ${s.places.map((p) => grids.find((g) => g.id === p.board)?.name ?? p.board).join(", ")}` : ""}
        </span>
        {s.snippet && <span className="htab-row-snippet">{s.snippet}</span>}
      </button>
      <button type="button" className="f-pill" onClick={() => goChat("huddles", s.id)} data-htab-replay={s.id}>
        Replay
      </button>
    </div>
  );
}

function SessionDetail({ id, user }: { id: string; user: UserInfo }) {
  const grids = useGrids();
  const [s, setS] = useState<{ session: SessionFull; channel?: ChannelRef } | null>(null);
  const [why, setWhy] = useState("");
  useEffect(() => {
    let on = true;
    setS(null);
    setWhy("");
    api<{ session: SessionFull; channel?: ChannelRef }>(`/api/huddles/sessions/${encodeURIComponent(id)}`)
      .then((r) => on && setS(r))
      .catch((e: Error) => on && setWhy(e.message));
    return () => {
      on = false;
    };
  }, [id]);
  if (!s)
    return (
      <div className="htab-detail">
        <button type="button" className="htab-back" onClick={() => goChat("huddles")}>
          ‹ All huddles
        </button>
        <p className="htab-note" role={why ? "alert" : "status"}>{why ? (why === "no such session" ? "This session isn't one you can see." : why) : "Opening…"}</p>
      </div>
    );
  const x = s.session;
  const gridName = (b: string) => grids.find((g) => g.id === b)?.name ?? b;
  return (
    <div className="htab-detail" data-htab-detail={x.id}>
      <button type="button" className="htab-back" onClick={() => goChat("huddles")}>
        ‹ All huddles
      </button>
      <header className="htab-detail-head">
        <h2 className="htab-h">{s.channel ? `Huddle in ${channelLabel(s.channel, user.id)}` : "Huddle on a grid"}</h2>
        <span className="htab-dim">
          {day(x.started_at)} · {x.ended_at ? duration(x.ended_at - x.started_at) : "live now"} · {x.people.join(", ") || "nobody"}
          {x.agents?.length ? ` · with ${x.agents.join(", ")}` : ""}
        </span>
        <div className="hcard-foot">
          {s.channel && (
            <button type="button" className="f-pill" onClick={() => goChat("chat", s.channel!.id)}>
              Open the conversation
            </button>
          )}
          {(x.places ?? []).map((p) => (
            <button key={`${p.board}${p.at}`} type="button" className="f-pill" onClick={() => goToCard(p.board, x.huddle_id)}>
              Open on {gridName(p.board)}
            </button>
          ))}
          {x.home === "board" && (
            <button type="button" className="f-pill" onClick={() => goToCard(x.board_id, x.huddle_id)}>
              Open on {gridName(x.board_id)}
            </button>
          )}
        </div>
        {(x.optedOut?.length ?? 0) > 0 && <p className="htab-note">Not recorded, at their word: {x.optedOut!.join(", ")}.</p>}
      </header>
      {SessionReplay && (
        <Suspense fallback={<p className="htab-note">Opening the replay…</p>}>
          <SessionReplay sessionId={x.id} />
        </Suspense>
      )}
      <div className="htab-detail-body">
        <section className="htab-recordings" aria-label="Recordings">
          <h3 className="htab-sub">Recordings</h3>
          {x.media.length ? (
            x.media.map((m) => (
              <figure key={m.fileId} className="htab-recording" data-htab-recording={m.fileId}>
                <FileVideo src={m.url} />
                <figcaption>
                  {m.person}
                  {m.kind === "screen" ? "'s screen" : ""} · {duration(m.endedAt - m.startedAt)}
                </figcaption>
              </figure>
            ))
          ) : (
            <p className="htab-note">{x.recordings?.length ? "Recorded, but nothing has arrived yet: each person's device uploads its own when they stop or leave." : "Nobody recorded this one."}</p>
          )}
        </section>
        <section className="htab-transcript" aria-label="Transcript">
          <h3 className="htab-sub">Transcript</h3>
          <div className="huddle-lines wheel-own">{x.lines.length ? <Transcript lines={x.lines} /> : <p className="htab-note">Nothing was transcribed.</p>}</div>
        </section>
      </div>
    </div>
  );
}

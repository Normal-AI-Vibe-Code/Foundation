/**
 * The huddle portal — a video call that lives at a place on the board.
 *
 * Room: the faces of everyone in it, live captions under them, and the call's
 * controls. Anyone with the portal on screen sees who's there (receive-only,
 * sound off until they listen in); Join sends your camera and mic. Notes: the
 * live transcript, speaker by speaker, with a field for typed lines (Granola's
 * notes beside the call). Archive: every past session — who came, what was
 * said, the recordings — with "✦ Summarize" for the agent and "Post to
 * #channel" for the huddle's Slack channel.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { HuddleLine } from "@foundation/protocol";
import type { PanelMeta } from "../state/store";
import { HuddleRoom, joinHuddle, leaveHuddle, roomOfCard, useJoinedRoom, useRoom, type RoomView } from "../lib/huddle";
import { api, ApiError } from "../lib/api";
import { useFileSrc } from "../lib/fileSrc";
import { goChat } from "../lib/place";
import { activeBoard } from "../sync/board";
import { askAgent, toast } from "../state/ui";
import { useOnScreen } from "./PanelView";
import { CallControls, CallStage, MicGlyph, MicOffGlyph } from "./HuddleCall";
import { ReplayHere } from "./ReplayView";

type Tab = "room" | "notes" | "archive";

export function HuddleBody({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(host, 0.25);
  const board = activeBoard();
  const boardId = board?.boardId ?? "company";
  const me = board?.user.name ?? "me";
  // a channel's huddle shown here is the channel's room (board "chat"): the same call, wherever it is shown
  const where = roomOfCard(panel, boardId);
  const fromChat = panel.home === "chat";
  const joined = useJoinedRoom();
  const inThis = joined?.huddleId === where.huddleId && joined.board === where.board;
  const live = panel.huddle?.people ?? [];
  const isLive = live.length > 0 || Boolean(fromChat && panel.huddle?.liveSince && !panel.huddle?.lastEndedAt);
  const [tab, setTab] = useState<Tab>("room");
  const [listen, setListen] = useState(false);
  // a private conversation's huddle: may I? (the server says; a grid viewer who isn't in it sees whose it is, nothing else)
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (!fromChat) return;
    let on = true;
    api(`/api/huddles/${panel.id}?board=${encodeURIComponent(boardId)}`)
      .then(() => on && setLocked(false))
      .catch((e) => on && setLocked(e instanceof ApiError && (e.status === 403 || e.status === 404)));
    return () => {
      on = false;
    };
  }, [fromChat, panel.id, boardId, isLive]);

  // watch while the portal is on screen and someone is in it; nothing streams otherwise
  const [watch, setWatch] = useState<HuddleRoom | null>(null);
  const shouldWatch = onScreen && !inThis && isLive && !locked;
  useEffect(() => {
    if (!shouldWatch) return;
    const r = new HuddleRoom(where.board, where.huddleId, false, { name: me });
    setWatch(r);
    void r.start();
    return () => {
      r.stop();
      setWatch(null);
      setListen(false);
    };
  }, [shouldWatch, where.board, where.huddleId, me]);
  useEffect(() => watch?.setVoice(listen), [watch, listen]);

  const room = inThis ? joined : watch;
  const view = useRoom(room);
  const recording = view.recording ?? (panel.huddle?.recording ? { by: panel.huddle.recording.by } : null);
  const people = live.length ? live : [...new Set(view.peers.filter((p) => p.sending).map((p) => p.name))];

  const join = async () => {
    const r = await joinHuddle(where.board, where.huddleId, { name: me }, { recording: Boolean(panel.huddle?.recording), meta: { name: panel.name, ...(fromChat && panel.channel ? { channel: panel.channel } : {}) } });
    const v = r.snapshot();
    if (v.status === "error") {
      toast(v.error ?? "Couldn't join", "bad");
      leaveHuddle();
    }
  };

  if (locked) {
    return (
      <div ref={host} className="huddle-body">
        <div className="huddle-head">
          <span className={`huddle-status${isLive ? " is-live" : ""}`}>
            <span className={`f-dot${isLive ? " is-ok is-live" : ""}`} />
            {isLive ? "Live" : "Ended"}
          </span>
          {panel.huddle?.recording && (
            <span className="huddle-rec" data-tip="Recording">
              <span className="huddle-rec-dot" />
              REC
            </span>
          )}
        </div>
        <div className="huddle-locked" data-huddle-locked>
          <div className="huddle-portal">
            <div className="huddle-empty-title">{panel.name}</div>
            <div className="huddle-empty-note">A huddle from a private conversation. Only the people in that conversation can see who's in it, join or listen.</div>
          </div>
        </div>
      </div>
    );
  }

  // the tabs sit with the controls: the card's hover bar covers its top edge
  const said = view.lines.filter((l) => l.source !== "system").length;
  const tabs = (
    <div className="huddle-tabs" role="tablist">
      {(["room", "notes", "archive"] as Tab[]).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t} className={`huddle-tab${tab === t ? " is-on" : ""}`} onClick={() => setTab(t)}>
          {t === "room" ? "Room" : t === "notes" ? `Notes${said ? ` ${said}` : ""}` : "Archive"}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={host} className="huddle-body">
      <div className="huddle-head">
        {isLive ? (
          <span className="huddle-status is-live">
            <span className="f-dot is-ok is-live" />
            Live{people.length ? ` · ${people.length}` : ""}
          </span>
        ) : (
          <span className="huddle-status">
            <span className="f-dot" />
            Quiet
          </span>
        )}
        {recording && (
          <span className="huddle-rec" data-tip={`Recording — started by ${recording.by || "someone"}. Everyone in the huddle is archived.`}>
            <span className="huddle-rec-dot" />
            REC
          </span>
        )}
        {fromChat && panel.channel ? (
          <button className="huddle-channel" data-tip="This huddle belongs to a ChatForm conversation" onClick={() => goChat("chat", panel.channel!)}>
            ChatForm
          </button>
        ) : (
          panel.channel && (
            <span className="huddle-channel" data-tip="Opened for a Slack channel — its notes can be posted back there">
              Slack
            </span>
          )
        )}
      </div>

      {tab === "room" ? (
        <CallStage view={view} inThis={inThis} me={me} live={people} listen={listen} onScreen={onScreen} />
      ) : tab === "notes" ? (
        <Notes lines={view.lines} canType={Boolean(room) || Boolean(panel.huddle?.lastEndedAt)} onSay={(t) => (room ? room.say(t) : void api(`/api/huddles/${where.huddleId}/lines`, { method: "POST", json: { board: where.board, text: t } }).catch((e) => toast((e as Error).message, "bad")))} speech={inThis ? view.speech : null} />
      ) : (
        <Archive panel={panel} boardId={boardId} />
      )}

      {inThis && joined ? (
        <CallControls room={joined} view={view} extra={tabs} />
      ) : (
        <div className="huddle-controls">
          {fromChat && !isLive ? (
            <span className="huddle-ctl-note">This huddle has ended. Its recordings and transcript are in the Archive.</span>
          ) : (
            <>
              <button className="f-pill is-accent" onClick={() => void join()}>
                {isLive ? "Join" : "Start the huddle"}
              </button>
              {watch && view.peers.some((p) => p.sending) && (
                <button className={`f-pill${listen ? " is-primary" : ""}`} onClick={() => setListen(!listen)}>
                  {listen ? "Listening" : "Listen in"}
                </button>
              )}
              <span className="huddle-ctl-note">{people.length ? `${people.join(", ")}` : joined ? `You're in another huddle` : "Camera and mic stay off until you join"}</span>
            </>
          )}
          <ReplayHere panel={panel} boardId={boardId} live={isLive} />
          {tabs}
        </div>
      )}
    </div>
  );
}

/** the room's stage, for anything that draws a huddle (kept for older imports) */
export function RoomStage(p: { view: RoomView; inThis: boolean; me: string; live: string[]; listen: boolean; onScreen: boolean }) {
  return <CallStage {...p} />;
}

// ---------- notes (the live transcript) ----------

function Notes({ lines, canType, onSay, speech }: { lines: HuddleLine[]; canType: boolean; onSay(text: string): void; speech: RoomView["speech"] | null }) {
  const list = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className="huddle-notes">
      <div ref={list} className="huddle-lines wheel-own">
        {lines.length === 0 ? (
          <div className="huddle-empty-note">{speech === "on" ? "Listening — what's said appears here, by speaker." : "What's said in the huddle appears here, by speaker. Type a note any time."}</div>
        ) : (
          <Transcript lines={lines} />
        )}
      </div>
      {speech && speech !== "on" && (
        <div className="huddle-speech-note">
          {speech === "test" ? "Transcription is off with the test camera — type notes instead" : speech === "unsupported" ? "This browser can't transcribe — type notes instead (Chrome and Safari can)" : speech === "blocked" ? "Speech recognition is blocked for this site" : "Transcription is paused while you're muted"}
        </div>
      )}
      {canType && (
        <form
          className="huddle-say"
          onSubmit={(e) => {
            e.preventDefault();
            onSay(draft);
            setDraft("");
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a note into the transcript…" />
        </form>
      )}
    </div>
  );
}

export function Transcript({ lines }: { lines: HuddleLine[] }) {
  // consecutive lines from one speaker read as one turn
  const turns = useMemo(() => {
    const out: Array<{ speaker: string; at: number; source: HuddleLine["source"]; texts: string[] }> = [];
    for (const l of lines) {
      const last = out[out.length - 1];
      if (last && last.speaker === l.speaker && last.source === l.source && l.at - last.at < 90_000) last.texts.push(l.text);
      else out.push({ speaker: l.speaker, at: l.at, source: l.source, texts: [l.text] });
    }
    return out;
  }, [lines]);
  return (
    <>
      {turns.map((t, i) =>
        t.source === "system" ? (
          <div key={i} className="huddle-line is-system">
            {t.texts.join(" · ")} <time>{clock(t.at)}</time>
          </div>
        ) : (
          <div key={i} className={`huddle-line${t.source === "agent" ? " is-agent" : ""}`}>
            <div className="huddle-line-head">
              <b>{t.speaker}</b>
              {t.source === "agent" && <i>agent</i>}
              <time>{clock(t.at)}</time>
              {t.source === "typed" && <i>note</i>}
            </div>
            <p>{t.texts.join(" ")}</p>
          </div>
        ),
      )}
    </>
  );
}

// ---------- archive ----------

interface Session {
  id: string;
  started_at: number;
  ended_at: number | null;
  people: string[];
  lines: HuddleLine[];
  media: Array<{ fileId: string; person: string; startedAt: number; endedAt: number; url: string }>;
}

function Archive({ panel, boardId }: { panel: PanelMeta; boardId: string }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const ended = panel.huddle?.lastEndedAt ?? 0;
  useEffect(() => {
    api<{ sessions: Session[] }>(`/api/huddles/${panel.id}?board=${encodeURIComponent(boardId)}`)
      .then((r) => {
        setSessions(r.sessions);
        setOpen((o) => o ?? r.sessions[0]?.id ?? null);
      })
      .catch(() => setSessions([]));
  }, [panel.id, boardId, ended]);
  const post = (s: Session) =>
    api<{ ts: string }>(`/api/slack/channels/${panel.channel}/huddle-notes`, { method: "POST", json: { board: boardId, huddleId: panel.id, sessionId: s.id } })
      .then(() => toast("Posted the huddle's notes to Slack", "ok"))
      .catch((e) => toast((e as Error).message, "bad"));
  if (!sessions) return <div className="huddle-archive"><div className="huddle-empty-note">Opening the archive…</div></div>;
  if (!sessions.length)
    return (
      <div className="huddle-archive">
        <div className="huddle-empty-note">No sessions yet. Each time people gather here becomes a session: who came, what was said, and any recordings.</div>
      </div>
    );
  return (
    <div className="huddle-archive wheel-own">
      {sessions.map((s) => (
        <div key={s.id} className={`huddle-session${open === s.id ? " is-open" : ""}`}>
          <button className="huddle-session-head" onClick={() => setOpen(open === s.id ? null : s.id)}>
            <b>{day(s.started_at)}</b>
            <span>{s.ended_at ? duration(s.ended_at - s.started_at) : "live now"}</span>
            <span className="huddle-session-people">{s.people.join(", ")}</span>
            <span className="huddle-session-count">{s.lines.filter((l) => l.source !== "system").length} lines{s.media.length ? ` · ${s.media.length} rec` : ""}</span>
          </button>
          {open === s.id && (
            <div className="huddle-session-body">
              {s.media.length > 0 && (
                <div className="huddle-recordings">
                  {s.media.map((m) => (
                    <figure key={m.fileId}>
                      <FileVideo src={m.url} />
                      <figcaption>
                        {m.person} · {duration(m.endedAt - m.startedAt)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {s.lines.length ? <Transcript lines={s.lines} /> : <div className="huddle-empty-note">Nothing was transcribed.</div>}
              <div className="huddle-session-foot">
                <button
                  className="f-pill is-agent"
                  onClick={() =>
                    askAgent(`Read the transcript of the huddle "${panel.name}" (huddle_transcript with huddle ${panel.id}) from ${day(s.started_at)} and write a note beside it: what was decided, action items with owners, and open questions.`)
                  }
                >
                  ✦ Summarize
                </button>
                {panel.channel && panel.home !== "chat" && (
                  <button className="f-pill" onClick={() => void post(s)}>
                    Post notes to Slack
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- bits ----------

export function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function day(at: number) {
  return new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function duration(ms: number) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** the mic glyphs, where they always were (the chip imports them from here) */
export const Mic = MicGlyph;
export const MicOff = MicOffGlyph;

/** a recording on the server, loaded with this device's session wherever the server is */
export function FileVideo({ src }: { src: string }) {
  return <video src={useFileSrc(src)} controls preload="metadata" />;
}

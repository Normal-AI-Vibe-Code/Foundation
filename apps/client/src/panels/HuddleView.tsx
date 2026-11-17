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
import { HuddleRoom, joinHuddle, leaveHuddle, useJoinedRoom, useRoom, type RoomView } from "../lib/huddle";
import { api } from "../lib/api";
import { useFileSrc } from "../lib/fileSrc";
import { activeBoard } from "../sync/board";
import { askAgent, toast } from "../state/ui";
import { useOnScreen } from "./PanelView";

type Tab = "room" | "notes" | "archive";

export function HuddleBody({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(host, 0.25);
  const board = activeBoard();
  const boardId = board?.boardId ?? "company";
  const me = board?.user.name ?? "me";
  const joined = useJoinedRoom();
  const inThis = joined?.huddleId === panel.id && joined.board === boardId;
  const live = panel.huddle?.people ?? [];
  const [tab, setTab] = useState<Tab>("room");
  const [listen, setListen] = useState(false);

  // watch while the portal is on screen and someone is in it; nothing streams otherwise
  const [watch, setWatch] = useState<HuddleRoom | null>(null);
  const shouldWatch = onScreen && !inThis && live.length > 0;
  useEffect(() => {
    if (!shouldWatch) return;
    const r = new HuddleRoom(boardId, panel.id, false, { name: me });
    setWatch(r);
    void r.start();
    return () => {
      r.stop();
      setWatch(null);
      setListen(false);
    };
  }, [shouldWatch, boardId, panel.id, me]);

  const room = inThis ? joined : watch;
  const view = useRoom(room);
  const recording = view.recording ?? (panel.huddle?.recording ? { by: panel.huddle.recording.by } : null);

  const join = async () => {
    const r = await joinHuddle(boardId, panel.id, { name: me }, { recording: Boolean(panel.huddle?.recording) });
    const v = r.snapshot();
    if (v.status === "error") {
      toast(v.error ?? "Couldn't join", "bad");
      leaveHuddle();
    }
  };

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
        {live.length ? (
          <span className="huddle-status is-live">
            <span className="f-dot is-ok is-live" />
            Live · {live.length}
          </span>
        ) : (
          <span className="huddle-status">
            <span className="f-dot" />
            Quiet
          </span>
        )}
        {recording && (
          <span className="huddle-rec" data-tip={`Recording — started by ${recording.by}. Everyone in the huddle is archived.`}>
            <span className="huddle-rec-dot" />
            REC
          </span>
        )}
        {panel.channel && (
          <span className="huddle-channel" data-tip="Opened for a Slack channel — its notes can be posted back there">
            Slack
          </span>
        )}
      </div>

      {tab === "room" ? (
        <RoomStage view={view} inThis={inThis} me={me} live={live} listen={listen} onScreen={onScreen} />
      ) : tab === "notes" ? (
        <Notes lines={view.lines} canType={Boolean(room) || Boolean(panel.huddle?.lastEndedAt)} onSay={(t) => (room ? room.say(t) : void api(`/api/huddles/${panel.id}/lines`, { method: "POST", json: { board: boardId, text: t } }).catch((e) => toast((e as Error).message, "bad")))} speech={inThis ? view.speech : null} />
      ) : (
        <Archive panel={panel} boardId={boardId} />
      )}

      <div className="huddle-controls">
        {inThis ? (
          <>
            <button className={`huddle-ctl${view.muted ? " is-off" : ""}`} data-tip={view.muted ? "Unmute" : "Mute"} aria-label={view.muted ? "Unmute" : "Mute"} onClick={() => joined!.setMuted(!view.muted)}>
              {view.muted ? <MicOff /> : <Mic />}
            </button>
            <button className={`huddle-ctl${view.camOff ? " is-off" : ""}`} data-tip={view.camOff ? "Camera on" : "Camera off"} aria-label={view.camOff ? "Camera on" : "Camera off"} onClick={() => joined!.setCamOff(!view.camOff)}>
              {view.camOff ? <CamOff /> : <Cam />}
            </button>
            <button className={`huddle-ctl${recording ? " is-rec" : ""}`} data-tip={recording ? "Stop recording" : "Record everyone — each person's camera and mic go to the archive"} aria-label="Record" onClick={() => joined!.setRecording(!recording)}>
              <span className="huddle-rec-glyph" />
            </button>
            <span className="huddle-ctl-note">{view.uploads ? "Saving recording…" : view.status === "connecting" ? "Connecting…" : view.peers.filter((p) => p.sending).length ? null : "Waiting for others"}</span>
            <button className="f-pill huddle-leave" onClick={leaveHuddle}>
              Leave
            </button>
            {tabs}
          </>
        ) : (
          <>
            <button className="f-pill is-accent" onClick={() => void join()}>
              {live.length ? "Join" : "Start the huddle"}
            </button>
            {watch && view.peers.some((p) => p.sending) && (
              <button className={`f-pill${listen ? " is-primary" : ""}`} onClick={() => setListen(!listen)}>
                {listen ? "Listening" : "Listen in"}
              </button>
            )}
            <span className="huddle-ctl-note">{live.length ? `${live.join(", ")}` : joined ? `You're in another huddle` : "Camera and mic stay off until you join"}</span>
            {tabs}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- room ----------

function RoomStage({ view, inThis, me, live, listen, onScreen }: { view: RoomView; inThis: boolean; me: string; live: string[]; listen: boolean; onScreen: boolean }) {
  const senders = view.peers.filter((p) => p.sending);
  const tiles = [
    ...(inThis && view.local ? [{ id: "self", name: me, stream: view.local, self: true, muted: view.muted, camOff: view.camOff, state: "connected" as const }] : []),
    ...senders.map((p) => ({ id: p.id, name: p.name, stream: p.stream, self: false, muted: p.muted, camOff: p.camOff, state: p.state })),
  ];
  if (!tiles.length) {
    return (
      <div className="huddle-stage is-empty">
        <div className="huddle-portal">
          {live.length ? (
            <>
              <div className="huddle-faces">
                {live.map((n) => (
                  <span key={n} className="huddle-face">
                    {initials(n)}
                  </span>
                ))}
              </div>
              <div className="huddle-empty-title">{onScreen ? "Connecting to the room…" : `${live.join(", ")} ${live.length === 1 ? "is" : "are"} here`}</div>
            </>
          ) : (
            <>
              <div className="huddle-empty-title">Nobody's here yet</div>
              <div className="huddle-empty-note">A huddle is a room on the board. Join and everyone who looks this way sees you; what's said is transcribed into the archive.</div>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={`huddle-stage n-${Math.min(tiles.length, 6)}`}>
      {tiles.map((t) => (
        <div key={t.id} className={`huddle-tile${t.self ? " is-self" : ""}${t.camOff ? " is-cam-off" : ""}`}>
          {t.stream && !t.camOff ? <Video stream={t.stream} muted={t.self || inThis || !listen} /> : <span className="huddle-face is-big">{initials(t.name)}</span>}
          <span className="huddle-name">
            {t.muted && <MicOff />}
            {t.self ? `${t.name} (you)` : t.name}
            {!t.self && t.state !== "connected" && t.state !== "new" && <i> · {t.state}</i>}
          </span>
        </div>
      ))}
      {view.captions.length > 0 && (
        <div className="huddle-captions" aria-live="polite">
          {view.captions.slice(-2).map((c) => (
            <div key={c.id}>
              <b>{c.name}</b> {c.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Video({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    void v.play().catch(() => {});
  }, [stream]);
  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
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

function Transcript({ lines }: { lines: HuddleLine[] }) {
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
          <div key={i} className="huddle-line">
            <div className="huddle-line-head">
              <b>{t.speaker}</b>
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
                {panel.channel && (
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

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function day(at: number) {
  return new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function duration(ms: number) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const svg = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
export function Mic() {
  return (
    <svg {...svg}>
      <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" />
    </svg>
  );
}
export function MicOff() {
  return (
    <svg {...svg}>
      <path d="M10.5 6.5V4.5a2.5 2.5 0 0 0-5 0V8a2.5 2.5 0 0 0 .4 1.4M3.5 8a4.5 4.5 0 0 0 7.6 3.2M8 12.5V14M2.5 2.5l11 11" />
    </svg>
  );
}
function Cam() {
  return (
    <svg {...svg}>
      <rect x="1.5" y="4" width="9" height="8" rx="1.5" />
      <path d="M10.5 7l4-2.2v6.4l-4-2.2" />
    </svg>
  );
}
function CamOff() {
  return (
    <svg {...svg}>
      <path d="M10.5 9.5V12h-7.5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 4M6 4h3a1.5 1.5 0 0 1 1.5 1.5V7l4-2.2v6.4M2 2l12 12" />
    </svg>
  );
}

/** a recording on the server, loaded with this device's session wherever the server is */
function FileVideo({ src }: { src: string }) {
  return <video src={useFileSrc(src)} controls preload="metadata" />;
}

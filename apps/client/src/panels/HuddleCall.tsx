/**
 * The in-call pieces any huddle draws, wherever it is (a grid's card, a channel's dock in ChatForm):
 *
 *  - CallStage: the faces in a grid; a shared screen large with the faces as a strip under it; agents'
 *    seats with their live avatars (mood `talking` while their answer is being said); a person whose
 *    camera is off shows their portrait (the character they wear, if anyone gave their name one in
 *    Settings → Avatars, else their initials on their colour); captions over it.
 *  - CallControls: mute, camera, share screen, record (with "don't record me"), captions, agents'
 *    voices, invite an agent (and Stop), Take to a grid…, Leave.
 *  - PlacePicker: pick a grid and a section, take the call there, then "Go there".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { springs } from "@foundation/ui";
import type { Mood } from "@foundation/protocol";
import { leaveHuddle, type AgentSeat, type HuddleRoom, type RoomView } from "../lib/huddle";
import { applySpeaker, onSpeaker } from "../lib/media";
import { DeviceChip } from "./DeviceChip";
import { api } from "../lib/api";
import { goGrid } from "../lib/place";
import { loadGrids, openGrid, useGrids } from "../lib/grids";
import { activeBoard } from "../sync/board";
import { getState, requestSnap } from "../state/store";
import { toast } from "../state/ui";
import { Avatar } from "../characters/Avatar";
import { readyCharacters, seats, useRoster } from "../characters/roster";
import { initials } from "../shell/Presence";
import "./huddlecall.css";

// ---------- the stage ----------

interface Tile {
  id: string;
  name: string;
  color?: string;
  stream: MediaStream | null;
  self: boolean;
  muted: boolean;
  camOff: boolean;
  noRec: boolean;
  state: RTCPeerConnectionState | "new";
}

export function CallStage({ view, me, inThis, listen, live = [], onScreen = true }: { view: RoomView; me: string; inThis: boolean; listen: boolean; live?: string[]; onScreen?: boolean }) {
  const roster = useRoster();
  const agentNames = useMemo(() => view.agents.map((a) => a.name), [view.agents]);
  const chars = useMemo(() => seats(roster, agentNames), [roster, agentNames]);
  const senders = view.peers.filter((p) => p.sending);
  const tiles: Tile[] = [
    ...(inThis && view.local ? [{ id: "self", name: me, stream: view.local, self: true, muted: view.muted, camOff: view.camOff, noRec: view.noRec, state: "connected" as const }] : []),
    ...senders.map((p) => ({ id: p.id, name: p.name, color: p.color, stream: p.stream, self: false, muted: p.muted, camOff: p.camOff, noRec: p.noRec, state: p.state })),
  ];
  const sharer = view.sharing ? (view.sharing.id === view.you ? { name: me, stream: view.screen, self: true } : { name: view.sharing.by, stream: view.peers.find((p) => p.id === view.sharing!.id)?.screen ?? null, self: false }) : null;

  if (!tiles.length && !view.agents.length) {
    return (
      <div className="huddle-stage is-empty">
        <div className="huddle-portal">
          {live.length ? (
            <>
              <div className="huddle-faces">
                {live.map((n) => (
                  <Portrait key={n} name={n} size={32} />
                ))}
              </div>
              <div className="huddle-empty-title">{onScreen ? "Connecting to the room…" : `${live.join(", ")} ${live.length === 1 ? "is" : "are"} here`}</div>
            </>
          ) : (
            <>
              <div className="huddle-empty-title">Nobody's here yet</div>
              <div className="huddle-empty-note">Join and everyone who looks this way sees you; what's said is transcribed into the archive.</div>
            </>
          )}
        </div>
      </div>
    );
  }

  const faces = (
    <>
      {tiles.map((t) => (
        <div key={t.id} className={`huddle-tile${t.self ? " is-self" : ""}${t.camOff ? " is-cam-off" : ""}`} data-huddle-tile={t.self ? "self" : t.name}>
          {t.stream && !t.camOff ? <CallVideo stream={t.stream} muted={t.self || inThis || !listen} /> : <Portrait name={t.name} color={t.color} size={sharer ? 36 : 64} />}
          <span className="huddle-name">
            {t.muted && <MicOffGlyph />}
            {t.self ? `${t.name} (you)` : t.name}
            {t.noRec && <i> · not recorded</i>}
            {!t.self && t.state !== "connected" && t.state !== "new" && <i> · {t.state}</i>}
          </span>
        </div>
      ))}
      {view.agents.map((a) => (
        <AgentTile key={a.name} seat={a} character={chars[a.name]} talking={view.talking === a.name || a.state === "talking"} />
      ))}
    </>
  );
  const captions = view.captionsOn && view.captions.length > 0 && (
    <div className="huddle-captions" aria-live="polite">
      {view.captions.slice(-2).map((c) => (
        <div key={c.id}>
          <b>{c.name}</b> {c.text}
        </div>
      ))}
    </div>
  );
  if (sharer) {
    return (
      <div className="huddle-stage is-sharing" data-huddle-sharing={sharer.name}>
        <div className="huddle-screen">
          {sharer.stream ? <CallVideo stream={sharer.stream} muted /> : <div className="huddle-empty-note">{sharer.name}'s screen is on its way…</div>}
          <span className="huddle-name">{sharer.self ? "You're sharing your screen" : `${sharer.name}'s screen`}</span>
        </div>
        <div className="huddle-strip">{faces}</div>
        {captions}
      </div>
    );
  }
  const n = tiles.length + view.agents.length;
  return (
    <div className={`huddle-stage n-${Math.min(n, 6)}`}>
      {faces}
      {captions}
    </div>
  );
}

function AgentTile({ seat, character, talking }: { seat: AgentSeat; character: Parameters<typeof Avatar>[0]["character"]; talking: boolean }) {
  const mood: Mood = talking ? "talking" : seat.state === "thinking" ? "thinking" : "idle";
  return (
    <div className={`huddle-tile is-agent${talking ? " is-talking" : ""}`} data-huddle-agent={seat.name} data-mood={mood}>
      <div className="huddle-agent-figure">
        <Avatar character={character} mood={mood} framing="bust" />
      </div>
      <span className="huddle-name">
        <span className="huddle-agent-mark">Agent</span>
        {seat.name}
        {seat.state === "thinking" && <i> · thinking</i>}
      </span>
    </div>
  );
}

/** a person's face when their camera is off: the character they wear, else their initials on their colour */
export function Portrait({ name, color, size = 32 }: { name: string; color?: string; size?: number }) {
  const roster = useRoster();
  const worn = roster.avatars[name] ? readyCharacters(roster).find((c) => c.id === roster.avatars[name]) : undefined;
  if (worn) {
    return (
      <span className="huddle-portrait is-character" style={{ width: size, height: size }} aria-label={name}>
        <Avatar character={worn} mood="idle" framing="bust" still />
      </span>
    );
  }
  return (
    <span className="huddle-face huddle-portrait" style={{ width: size, height: size, fontSize: Math.max(11, size * 0.32), background: color || undefined, color: color ? "var(--color-on-fill)" : undefined }} aria-label={name}>
      {initials(name) || "?"}
    </span>
  );
}

export function CallVideo({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    void v.play().catch(() => {});
    // a camera turned on later arrives as a new track on the same stream: show it
    const again = () => {
      v.srcObject = null;
      v.srcObject = stream;
      void v.play().catch(() => {});
    };
    stream.addEventListener("addtrack", again);
    stream.addEventListener("removetrack", again);
    return () => {
      stream.removeEventListener("addtrack", again);
      stream.removeEventListener("removetrack", again);
    };
  }, [stream]);
  // the sound plays on the speaker chosen in the device chip
  useEffect(() => {
    const v = ref.current;
    if (!v || muted) return;
    applySpeaker(v);
    return onSpeaker(() => ref.current && applySpeaker(ref.current));
  }, [muted]);
  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

// ---------- controls ----------

export function CallControls({ room, view, agentChoices = [], onPlace, extra }: { room: HuddleRoom; view: RoomView; agentChoices?: string[]; onPlace?: () => void; extra?: React.ReactNode }) {
  const [pop, setPop] = useState<"rec" | "agent" | null>(null);
  const [agentName, setAgentName] = useState("");
  const recording = view.recording;
  const toggle = (k: typeof pop) => setPop((p) => (p === k ? null : k));
  const share = () => {
    if (view.screen) return room.stopShare();
    room.startShare().catch((e: Error) => e.name !== "NotAllowedError" && e.name !== "AbortError" && toast(e.message, "bad"));
  };
  const invite = (name: string) => {
    if (!name.trim()) return;
    room
      .inviteAgent(name.trim())
      .then(() => setPop(null))
      .catch((e: Error) => toast(e.message, "bad"));
    setAgentName("");
  };
  const speaking = view.agents.some((a) => a.state !== "listening") || Boolean(view.talking);
  return (
    <div className="huddle-controls huddle-call-controls">
      <button className={`huddle-ctl${view.muted ? " is-off" : ""}`} data-tip={view.muted ? "Unmute" : "Mute"} aria-label={view.muted ? "Unmute" : "Mute"} onClick={() => room.setMuted(!view.muted)}>
        {view.muted ? <MicOffGlyph /> : <MicGlyph />}
      </button>
      <button className={`huddle-ctl${view.camOff ? " is-off" : ""}`} data-tip={view.camOff ? "Camera on" : "Camera off"} aria-label={view.camOff ? "Camera on" : "Camera off"} onClick={() => room.setCamOff(!view.camOff)}>
        {view.camOff ? <CamOffGlyph /> : <CamGlyph />}
      </button>
      <DeviceChip room={room} view={view} />
      <button
        className={`huddle-ctl${view.screen ? " is-on" : ""}`}
        data-tip={view.screen ? "Stop sharing" : view.sharing ? `${view.sharing.by} is sharing` : "Share your screen"}
        aria-label={view.screen ? "Stop sharing" : "Share screen"}
        aria-pressed={Boolean(view.screen)}
        disabled={Boolean(view.sharing && !view.screen)}
        onClick={share}
      >
        <ScreenGlyph />
      </button>
      <div className="huddle-ctl-anchor">
        <button className={`huddle-ctl${recording ? " is-rec" : ""}`} data-tip={recording ? `Recording — started by ${recording.by}` : "Record"} aria-label="Record" onClick={() => toggle("rec")}>
          <span className="huddle-rec-glyph" />
        </button>
        <AnimatePresence>
          {pop === "rec" && (
            <motion.div className="huddle-pop f-glass" role="dialog" aria-label="Recording" initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.98 }} transition={{ type: "spring", ...springs.pop }}>
              <p className="huddle-pop-note">{recording ? `Recording since ${recording.by} pressed it. Everyone sees REC.` : "Each person's camera and mic go to the archive, recorded on their own device."}</p>
              <button className={`f-pill${recording ? "" : " is-accent"}`} onClick={() => (room.setRecording(!recording), setPop(null))}>
                {recording ? "Stop recording" : "Record everyone"}
              </button>
              <label className="huddle-pop-check">
                <input type="checkbox" checked={view.noRec} onChange={(e) => room.setNoRec(e.target.checked)} />
                Don't record me
              </label>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <button className={`huddle-ctl huddle-ctl-text${view.captionsOn ? " is-on" : ""}`} data-tip={view.captionsOn ? "Hide captions" : "Show captions"} aria-label="Captions" aria-pressed={view.captionsOn} onClick={() => room.setCaptions(!view.captionsOn)}>
        CC
      </button>
      <div className="huddle-ctl-anchor">
        <button className={`huddle-ctl${view.agents.length ? " is-agent" : ""}`} data-tip="Invite an agent" aria-label="Invite an agent" onClick={() => toggle("agent")}>
          ✦
        </button>
        <AnimatePresence>
          {pop === "agent" && (
            <motion.div className="huddle-pop f-glass" role="dialog" aria-label="Agents in the huddle" initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.98 }} transition={{ type: "spring", ...springs.pop }}>
              <p className="huddle-pop-note">An agent sits in with its avatar. Say its name and it answers aloud (alone with you, it answers everything). What it says stays in this huddle.</p>
              {view.agents.map((a) => (
                <div key={a.name} className="huddle-pop-row">
                  <span>
                    <b>{a.name}</b> · {a.state}
                  </span>
                  <button className="huddle-link" onClick={() => void room.dismissAgent(a.name).catch((e: Error) => toast(e.message, "bad"))}>
                    Let go
                  </button>
                </div>
              ))}
              <div className="huddle-pop-choices">
                {agentChoices
                  .filter((n) => !view.agents.some((a) => a.name.toLowerCase() === n.toLowerCase()))
                  .slice(0, 6)
                  .map((n) => (
                    <button key={n} className="f-pill is-agent" onClick={() => invite(n)}>
                      ✦ {n}
                    </button>
                  ))}
              </div>
              <form
                className="huddle-say"
                onSubmit={(e) => {
                  e.preventDefault();
                  invite(agentName);
                }}
              >
                <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="An agent's name" aria-label="Agent's name" />
              </form>
              <label className="huddle-pop-check">
                <input type="checkbox" checked={view.voice} onChange={(e) => room.setVoice(e.target.checked)} />
                Speak agents' answers aloud here
              </label>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {speaking && (
        <button className="f-pill huddle-stop" onClick={() => room.stopAgents()} data-tip="Stop the agent talking, for everyone">
          Stop
        </button>
      )}
      <span className="huddle-ctl-note">{view.status === "error" ? view.error : view.uploads ? "Saving recording…" : view.status === "connecting" ? "Connecting…" : view.peers.filter((p) => p.sending).length ? null : "Waiting for others"}</span>
      {extra}
      {onPlace && (
        <button className="f-pill" onClick={onPlace} data-huddle-place>
          Take to a grid…
        </button>
      )}
      <button className="f-pill huddle-leave" onClick={leaveHuddle}>
        Leave
      </button>
    </div>
  );
}

// ---------- take to a grid ----------

interface OutlineSection {
  id: string;
  name: string;
}

/** grids and their sections; Take it there → the place route; then Go there */
export function PlacePicker({ huddleId, onClose }: { huddleId: string; onClose(): void }) {
  const grids = useGrids().filter((g) => (g.kind ?? "grid") === "grid" && g.role !== "viewer");
  const [board, setBoard] = useState<string>(() => activeBoard()?.boardId ?? "");
  const [sections, setSections] = useState<OutlineSection[] | null>(null);
  const [section, setSection] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ board: string; card: string; label: string } | null>(null);
  useEffect(() => void loadGrids(), []);
  useEffect(() => {
    if (!board) return;
    setSections(null);
    setSection("");
    api<{ sections: OutlineSection[] }>(`/api/boards/${encodeURIComponent(board)}/outline`)
      .then((o) => {
        setSections(o.sections);
        setSection(o.sections[0]?.id ?? "");
      })
      .catch(() => setSections([]));
  }, [board]);
  const take = async () => {
    setBusy(true);
    try {
      const r = await api<{ card: { id: string }; board: string; section: string }>(`/api/huddles/${huddleId}/place`, { method: "POST", json: { board, section, request_id: `${huddleId}:${board}` } });
      const g = grids.find((x) => x.id === board);
      const s = sections?.find((x) => x.id === r.section);
      setDone({ board: r.board, card: r.card.id, label: `${g?.name ?? board} › ${s?.name ?? "section"}` });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="huddle-place f-glass" role="dialog" aria-label="Take the huddle to a grid">
      {done ? (
        <>
          <p className="huddle-pop-note">
            The huddle is on <b>{done.label}</b>. Everyone stays in the call; people on the grid can join from its card.
          </p>
          <div className="huddle-place-foot">
            <button className="f-pill is-accent" onClick={() => (goToCard(done.board, done.card), onClose())} data-huddle-go>
              Go there
            </button>
            <button className="f-pill" onClick={onClose}>
              Stay here
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="huddle-pop-head">Take it to a grid</div>
          <label className="huddle-place-field">
            <span>Grid</span>
            <select value={board} onChange={(e) => setBoard(e.target.value)} aria-label="Grid">
              <option value="">Choose a grid</option>
              {grids.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="huddle-place-field">
            <span>Section</span>
            <select value={section} onChange={(e) => setSection(e.target.value)} disabled={!sections?.length} aria-label="Section">
              {!sections ? <option>…</option> : !sections.length ? <option value="">No sections</option> : sections.map((s) => <option key={s.id} value={s.id}>{s.name || "Untitled"}</option>)}
            </select>
          </label>
          <div className="huddle-place-foot">
            <button className="f-pill is-accent" disabled={!board || !section || busy} onClick={() => void take()} data-huddle-take>
              {busy ? "Taking it…" : "Take it there"}
            </button>
            <button className="f-pill" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** open a grid and frame a card on it */
export function goToCard(board: string, card: string) {
  goGrid();
  if (activeBoard()?.boardId === board) {
    if (getState().panels[card]) requestSnap({ kind: "object", id: card });
    return;
  }
  // the shell frames ?focus= once the grid has synced
  const u = new URL(window.location.href);
  u.searchParams.set("focus", card);
  window.history.replaceState(window.history.state, "", u);
  openGrid(board);
}

// ---------- glyphs ----------

const svg = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
export function MicGlyph() {
  return (
    <svg {...svg}>
      <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" />
    </svg>
  );
}
export function MicOffGlyph() {
  return (
    <svg {...svg}>
      <path d="M10.5 6.5V4.5a2.5 2.5 0 0 0-5 0V8a2.5 2.5 0 0 0 .4 1.4M3.5 8a4.5 4.5 0 0 0 7.6 3.2M8 12.5V14M2.5 2.5l11 11" />
    </svg>
  );
}
export function CamGlyph() {
  return (
    <svg {...svg}>
      <rect x="1.5" y="4" width="9" height="8" rx="1.5" />
      <path d="M10.5 7l4-2.2v6.4l-4-2.2" />
    </svg>
  );
}
export function CamOffGlyph() {
  return (
    <svg {...svg}>
      <path d="M10.5 9.5V12h-7.5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 4M6 4h3a1.5 1.5 0 0 1 1.5 1.5V7l4-2.2v6.4M2 2l12 12" />
    </svg>
  );
}
export function ScreenGlyph() {
  return (
    <svg {...svg}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14M8 9V5M6 7l2-2 2 2" />
    </svg>
  );
}

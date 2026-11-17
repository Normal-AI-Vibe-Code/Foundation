/**
 * While you're in a huddle, the call goes with you: a small glass chip in the
 * bottom-right corner (who's talking, mute, back to the portal, leave), so you
 * can roam the board and keep talking. It only exists while you're joined.
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { leaveHuddle, useJoinedRoom, useRoom } from "../lib/huddle";
import { getState, requestSnap } from "../state/store";
import { springs } from "@foundation/ui";
import { Mic, MicOff } from "../panels/HuddleView";

export function HuddlePip() {
  const room = useJoinedRoom();
  const view = useRoom(room);
  const name = room ? (getState().panels[room.huddleId]?.name ?? "Huddle") : "";
  const others = view.peers.filter((p) => p.sending);
  const lead = others.find((p) => p.stream && !p.camOff);
  return (
    <AnimatePresence>
      {room && (
        <motion.div
          className="huddle-pip f-glass"
          initial={{ opacity: 0, y: 16, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.96 }}
          transition={{ type: "spring", ...springs.pop }}
        >
          <button className="huddle-pip-face" data-tip="Back to the huddle" aria-label="Back to the huddle" onClick={() => requestSnap({ kind: "object", id: room.huddleId })}>
            {lead?.stream ? <PipVideo stream={lead.stream} /> : <span>{others.length ? others.length : "…"}</span>}
          </button>
          <div className="huddle-pip-text">
            <b>{name}</b>
            <span>{view.status === "error" ? view.error : others.length ? others.map((p) => p.name).join(", ") : "Waiting for others"}</span>
          </div>
          {view.recording && <span className="huddle-rec-dot" data-tip="Recording" />}
          <button className={`huddle-ctl${view.muted ? " is-off" : ""}`} data-tip={view.muted ? "Unmute" : "Mute"} aria-label={view.muted ? "Unmute" : "Mute"} onClick={() => room.setMuted(!view.muted)}>
            {view.muted ? <MicOff /> : <Mic />}
          </button>
          <button className="f-pill huddle-leave" onClick={leaveHuddle}>
            Leave
          </button>
          {/* the call's sound lives here, not on the portal's tiles, so it carries on wherever you are on the board */}
          {others.map((p) => p.stream && <PeerAudio key={p.id} stream={p.stream} />)}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PeerAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (a.srcObject !== stream) a.srcObject = stream;
    void a.play().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function PipVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  // picture only: the sound plays from PeerAudio
  return <video ref={ref} autoPlay playsInline muted />;
}

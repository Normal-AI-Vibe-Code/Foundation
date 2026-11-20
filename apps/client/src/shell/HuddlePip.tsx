/**
 * While you're in a huddle, the call goes with you: a small glass chip in the
 * bottom-right corner (who's talking, mute, back to the call, leave), so you
 * can roam Foundation and keep talking. It only exists while you're joined,
 * and it carries the call's sound wherever you are.
 *
 * Back: a channel's huddle returns to its channel in ChatForm, unless you're
 * on a grid that holds its card (then the card); a grid's huddle, to its card.
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { leaveHuddle, useJoinedRoom, useRoom } from "../lib/huddle";
import { getState, requestSnap } from "../state/store";
import { springs } from "@foundation/ui";
import { goChat, goGrid, placeOf } from "../lib/place";
import { Mic, MicOff } from "../panels/HuddleView";

export function HuddlePip() {
  const room = useJoinedRoom();
  const view = useRoom(room);
  const name = room ? (room.meta.name ?? getState().panels[room.huddleId]?.name ?? "Huddle") : "";
  const others = view.peers.filter((p) => p.sending);
  const lead = others.find((p) => p.stream && !p.camOff);
  const back = () => {
    if (!room) return;
    const onGrid = placeOf(window.location.hash).kind === "grid";
    if (room.meta.channel && !(onGrid && getState().panels[room.huddleId])) return goChat("chat", room.meta.channel);
    goGrid();
    requestSnap({ kind: "object", id: room.huddleId });
  };
  return (
    <AnimatePresence>
      {room && (
        <motion.div
          className="huddle-pip f-glass"
          data-huddle-pip={room.huddleId}
          initial={{ opacity: 0, y: 16, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.96 }}
          transition={{ type: "spring", ...springs.pop }}
        >
          <button className="huddle-pip-face" data-tip="Back to the huddle" aria-label="Back to the huddle" onClick={back}>
            {lead?.stream ? <PipVideo stream={lead.stream} /> : <span>{others.length ? others.length : "…"}</span>}
          </button>
          <div className="huddle-pip-text">
            <b>{name}</b>
            <span>{view.status === "error" || view.ended ? (view.error ?? "This huddle has ended") : others.length ? others.map((p) => p.name).join(", ") : "Waiting for others"}</span>
          </div>
          {view.recording && <span className="huddle-rec-dot" data-tip={view.noRec ? "Recording — not you" : "Recording"} />}
          <button className={`huddle-ctl${view.muted ? " is-off" : ""}`} data-tip={view.muted ? "Unmute" : "Mute"} aria-label={view.muted ? "Unmute" : "Mute"} onClick={() => room.setMuted(!view.muted)}>
            {view.muted ? <MicOff /> : <Mic />}
          </button>
          <button className="f-pill huddle-leave" onClick={leaveHuddle}>
            Leave
          </button>
          {/* the call's sound lives here, not on the portal's tiles, so it carries on wherever you are */}
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

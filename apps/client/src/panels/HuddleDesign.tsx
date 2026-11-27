/**
 * Huddles on `#/design` (the ChatForm chapter): a channel's huddle card live and ended, the stage with a
 * shared screen's place, an agent's seat talking and people whose cameras are off (their portraits), the
 * controls, and the card a grid shows for a private conversation's huddle. Drawn from fixtures: no call.
 */

import type { ChatMessage } from "@foundation/protocol";
import type { RoomView } from "../lib/huddle";
import { HuddleCard } from "../chat/HuddleCard";
import { CallStage, MicGlyph, CamGlyph, ScreenGlyph } from "./HuddleCall";
import { DeviceRow, HeadsetGlyph } from "./DeviceChip";

const dev = (deviceId: string, label: string): MediaDeviceInfo => ({ deviceId, kind: "audioinput", label, groupId: "", toJSON: () => ({}) });
import "./huddlecall.css";

const NOW = Date.now();
const card = (over: Partial<NonNullable<ChatMessage["huddle"]>>): ChatMessage => ({
  id: `m_h${over.id}`,
  channel: "ch_shroud",
  seq: 1,
  author: { kind: "person", id: "u_ada", name: "Ada Lovelace" },
  type: "huddle",
  text: "",
  root: null,
  createdAt: NOW - 30 * 60_000,
  editedAt: null,
  deletedAt: null,
  files: [],
  reactions: [],
  replyCount: 0,
  lastReplyAt: null,
  pinned: false,
  mentions: [],
  huddle: { id: "h", startedAt: NOW - 30 * 60_000, people: [], ...over },
});

const VIEW: RoomView = {
  status: "live",
  you: "me",
  sending: false,
  local: null,
  muted: false,
  camOff: true,
  mic: { state: "on", label: "Headset Microphone" },
  cam: { state: "none", message: "No camera found." },
  peers: [
    { id: "p1", name: "Ada Lovelace", color: "var(--color-pulse)", sending: true, muted: false, camOff: true, noRec: false, stream: null, screen: null, state: "connected" },
    { id: "p2", name: "Kai Moreno", color: "var(--color-moss)", sending: true, muted: true, camOff: true, noRec: true, stream: null, screen: null, state: "connected" },
  ],
  captions: [{ id: "p1", name: "Ada Lovelace", text: "the lip is the thinnest wall left" }],
  lines: [],
  recording: { by: "Ada Lovelace" },
  recordingSelf: false,
  uploads: 0,
  speech: "off",
  sharing: null,
  screen: null,
  noRec: false,
  agents: [{ name: "Wren", by: "Ada Lovelace", state: "talking" }],
  talking: "Wren",
  voice: true,
  captionsOn: true,
  ended: false,
};

export function HuddleDemo() {
  return (
    <div className="chat-demo-row hdemo">
      <div>
        <p className="chat-demo-cap">A channel's huddle · live</p>
        <HuddleCard message={card({ id: "live", startedAt: NOW - 4 * 60_000 })} live={{ id: "live", board: "chat", liveSince: NOW - 4 * 60_000, people: ["Ada Lovelace", "Kai Moreno"], recording: true, agents: ["Wren"] }} onJoin={() => {}} />
        <p className="chat-demo-cap">Ended · taken to a grid</p>
        <HuddleCard
          message={card({ id: "ended", endedAt: NOW - 4 * 60_000, people: ["Ada Lovelace", "Kai Moreno", "Noa Berg"], recorded: true, board: "b_demo", session: "hs_demo" })}
          onReplay={() => {}}
          brief={{
            lines: [
              { id: "l1", at: NOW - 20 * 60_000, speaker: "Ada Lovelace", text: "The strut needs a 2 mm fillet on the inside corner.", source: "speech" },
              { id: "l2", at: NOW - 19 * 60_000, speaker: "Wren", text: "At 2 mm the stress at the root drops by about a third.", source: "agent" },
            ],
            media: [
              { fileId: "f1", person: "Ada Lovelace", url: "" },
              { fileId: "f2", person: "Kai Moreno", url: "" },
            ],
          }}
        />
      </div>
      <div className="hdemo-stage">
        <p className="chat-demo-cap">In the call · cameras off show portraits, an agent's seat talks, captions over it</p>
        <div className="hdock" style={{ height: 340 }}>
          <div className="hdock-head">
            <span className="f-dot is-ok is-live" />
            <span className="hdock-title">Huddle · #fan-shroud</span>
            <span className="hcard-when">4:12</span>
            <span className="huddle-rec">
              <span className="huddle-rec-dot" />
              REC
            </span>
          </div>
          <div className="hdock-body">
            <CallStage view={VIEW} me="Josh" inThis={false} listen={false} />
          </div>
          <div className="huddle-controls huddle-call-controls">
            <button className="huddle-ctl" aria-label="Mute (design)">
              <MicGlyph />
            </button>
            <button className="huddle-ctl is-off" aria-label="Camera (design)">
              <CamGlyph />
            </button>
            <button className="huddle-ctl huddle-devices is-warn" aria-label="Devices (design)" data-tip="Microphone: Headset Microphone · Camera: none found">
              <HeadsetGlyph />
              <span className="f-dot is-warn" aria-hidden />
            </button>
            <button className="huddle-ctl is-on" aria-label="Share (design)">
              <ScreenGlyph />
            </button>
            <button className="huddle-ctl is-rec" aria-label="Record (design)">
              <span className="huddle-rec-glyph" />
            </button>
            <button className="huddle-ctl huddle-ctl-text is-on" aria-label="Captions (design)">
              CC
            </button>
            <button className="huddle-ctl is-agent" aria-label="Agent (design)">
              ✦
            </button>
            <button className="f-pill huddle-stop">Stop</button>
            <span className="huddle-ctl-note" />
            <button className="f-pill">Take to a grid…</button>
            <button className="f-pill huddle-leave">Leave</button>
          </div>
        </div>
        <p className="chat-demo-cap">The device chip: connected · no camera · no microphone; and its picker</p>
        <div className="huddle-controls" data-design-devices>
          {(["ok", "warn", "bad"] as const).map((t) => (
            <button key={t} className={`huddle-ctl huddle-devices is-${t}`} aria-label={`Devices ${t} (design)`}>
              <HeadsetGlyph />
              <span className={`f-dot is-${t}`} aria-hidden />
            </button>
          ))}
        </div>
        <div className="huddle-pop huddle-device-pop is-specimen f-glass" aria-label="Devices (design)">
          <div className="huddle-pop-head">Devices</div>
          <DeviceRow kind="mic" title="Microphone" state={{ state: "on", label: "Headset Microphone", deviceId: "a" }} list={[dev("a", "Headset Microphone"), dev("b", "Microphone Array (Realtek)")]} onPick={() => {}} onRetry={() => {}}>
            <span className="huddle-level">
              <span style={{ transform: "scaleX(0.45)" }} />
            </span>
          </DeviceRow>
          <DeviceRow kind="cam" title="Camera" state={{ state: "blocked", message: "The camera is blocked for Foundation. Allow it in the browser's site settings, then press Allow." }} list={[]} onPick={() => {}} onRetry={() => {}} />
        </div>
        <p className="chat-demo-cap">On a grid, for someone not in the private conversation</p>
        <div className="huddle-locked" style={{ minHeight: 120 }}>
          <div className="huddle-portal">
            <div className="huddle-empty-title">Ada Lovelace's huddle</div>
            <div className="huddle-empty-note">A huddle from a private conversation. Only the people in that conversation can see who's in it, join or listen.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * `#/design` → Cards → Voice and video notes: the real card parts and the recorder, on fixtures. Nothing
 * here opens a microphone or a camera: the recorder's states are snapshots, the camera a drawn stand-in.
 */

import { VideoNoteStill, VoicePlayer } from "../notes/NoteCards";
import { RecorderPanel } from "../notes/NoteRecorder";
import type { RecSnapshot } from "../notes/recorder";
import { VOICE_CARD, whoWhen } from "../notes/recorder";

const AT = Date.now() - 3 * 3600_000;
const PEAKS = [0.12, 0.3, 0.55, 0.8, 0.62, 0.4, 0.22, 0.5, 0.9, 1, 0.72, 0.46, 0.3, 0.18, 0.08, 0.04, 0.2, 0.44, 0.66, 0.84, 0.7, 0.52, 0.36, 0.6, 0.78, 0.92, 0.64, 0.4, 0.26, 0.14, 0.32, 0.5, 0.7, 0.58, 0.42, 0.3, 0.2, 0.46, 0.62, 0.74, 0.5, 0.34, 0.22, 0.12, 0.06, 0.04, 0.1, 0.06];
const CLIP = { blob: new Blob([], { type: "audio/webm" }), mime: "audio/webm", ms: 42_000, peaks: PEAKS };
const snap = (s: Partial<RecSnapshot>): RecSnapshot => ({ state: "idle", kind: "audio", elapsed: 0, stream: null, clip: null, failure: null, level: 0, ...s });

/** a drawn stand-in for a camera: tokens only */
function FakeCamera() {
  return <div className="note-rec-fake media-note-demo-camera" aria-label="A stand-in for the camera" />;
}

function VoiceCard({ w, at, playing }: { w: number; at?: number; playing?: boolean }) {
  return (
    <div className="frame-card media-card note-card is-voice" style={{ width: w, position: "relative" }}>
      <div className="media-body">
        <div className="note-voice-host" style={{ width: w, height: VOICE_CARD.h }}>
          <VoicePlayer src={undefined} peaks={PEAKS} ms={42_000} caption={whoWhen("Josh Leong", AT)} compact={w < 300} fixture={{ at: at ?? 0, playing }} />
        </div>
      </div>
    </div>
  );
}

export function MediaNotesDemo() {
  const states: Array<[string, RecSnapshot, boolean?]> = [
    ["Ready: nothing is open yet", snap({})],
    ["Asking for the microphone", snap({ state: "asking" })],
    ["Recording a voice note", snap({ state: "recording", elapsed: 12_400, level: 0.55 })],
    ["The last ten seconds", snap({ state: "recording", elapsed: 292_000, level: 0.3 })],
    ["Recording a video note", snap({ state: "recording", kind: "video", elapsed: 8_000 })],
    ["Review: play it, then leave it", snap({ state: "review", clip: CLIP, elapsed: 42_000 })],
    ["Leaving it here", snap({ state: "leaving", clip: CLIP })],
    ["Refused", snap({ state: "failed", failure: { stage: "open", text: "The microphone was refused. Allow it for Foundation in the browser's site settings (the icon left of the address), or in System Settings → Privacy → Microphone on a Mac, then press Record again." } })],
    ["Upload failed: the clip is kept", snap({ state: "failed", clip: CLIP, failure: { stage: "upload", text: "It didn't upload (network error). Your recording is still here: try again." } })],
  ];
  return (
    <div className="media-note-demo">
      <div className="media-note-demo-row">
        <figure>
          <VoiceCard w={320} />
          <figcaption>Voice note at rest · 320 × 100</figcaption>
        </figure>
        <figure>
          <VoiceCard w={320} at={14} playing />
          <figcaption>Playing, 14 s in</figcaption>
        </figure>
        <figure>
          <VoiceCard w={240} at={30} />
          <figcaption>Narrow (240): the who goes first</figcaption>
        </figure>
        <figure>
          <VideoNoteStill w={320} h={206} caption={whoWhen("Josh Leong", AT)} ms={75_000} poster={<div className="media-note-demo-camera" />} />
          <figcaption>Video note at rest: its first frame, never playing by itself</figcaption>
        </figure>
      </div>
      <div className="media-note-demo-row">
        {states.map(([label, s]) => (
          <figure key={label}>
            <RecorderPanel snap={s} sectionName="Review" preview={<FakeCamera />} />
            <figcaption>{label}</figcaption>
          </figure>
        ))}
        <figure>
          <RecorderPanel snap={snap({ state: "review", clip: CLIP })} sectionName="Review" asking={{ discard() {}, keep() {} }} />
          <figcaption>Closing over a clip asks first</figcaption>
        </figure>
        <figure>
          <RecorderPanel snap={snap({})} viewer />
          <figcaption>A viewer (the section's microphone is hidden from them)</figcaption>
        </figure>
      </div>
    </div>
  );
}

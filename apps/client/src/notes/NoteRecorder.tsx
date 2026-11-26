/**
 * The note recorder (2026-11-25): a small popover off a section, to leave a voice or a video note there.
 *
 *   Voice | Video          ✕
 *   ● Record               (the microphone, or camera, opens only now)
 *   ■ Stop   0:12 / 5:00   (a meter, or the camera as it records; the last 10 s count down)
 *   ▶ the clip             Leave it here · Record again · Discard
 *
 * The recording is a `NoteRecording` (recorder.ts); this file draws it, uploads the clip and puts the card
 * down in ONE change that already carries `note` and the shared `/files/<id>` (store.addMediaNote). Failure
 * is a sentence that says what to do; a clip that didn't upload is kept, with Try again.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { addMediaNote, getState } from "../state/store";
import { toast, useUi } from "../state/ui";
import { activeBoard } from "../sync/board";
import { uploadFile } from "../lib/api";
import { onCamera } from "../state/camera";
import { MicGlyph, CameraGlyph } from "../shell/glyphs";
import { closeNoteRecorder, openNoteRecorder, useNoteAsk } from "./open";
import {
  browserEnv,
  capMs,
  clock,
  noteFileName,
  noteName,
  NoteRecording,
  peaksFromBlob,
  timeLeft,
  VOICE_CARD,
  videoCardSize,
  type Clip,
  type NoteKind,
  type RecSnapshot,
} from "./recorder";
import { VIDEO_CAPTION_H, VoicePlayer } from "./NoteCards";
import "./notes.css";

export interface RecorderActions {
  choose(kind: NoteKind): void;
  record(): void;
  stop(): void;
  discard(): void;
  leave(): void;
  close(): void;
}

const NOOP: RecorderActions = { choose() {}, record() {}, stop() {}, discard() {}, leave() {}, close() {} };

/**
 * What the recorder shows for a snapshot: pure, so the design page draws every state from fixtures.
 * `preview` stands in for the live camera (the design page never opens one).
 */
export function RecorderPanel({
  snap,
  actions = NOOP,
  sectionName,
  viewer,
  preview,
  reviewSrc,
  asking,
}: {
  snap: RecSnapshot;
  actions?: RecorderActions;
  sectionName?: string;
  viewer?: boolean;
  preview?: ReactNode;
  /** the clip to play back in review (a blob: URL) */
  reviewSrc?: string;
  /** closing would lose a clip: say so first */
  asking?: { discard(): void; keep(): void };
}) {
  const { state, kind } = snap;
  const picking = state === "idle" || (state === "failed" && snap.failure?.stage === "open");
  const dev = kind === "audio" ? "microphone" : "camera";
  const { left, countdown } = timeLeft(kind, snap.elapsed);
  return (
    <div className={`note-rec is-${state} kind-${kind}`} role="dialog" aria-label={`Leave a voice or video note${sectionName ? ` in ${sectionName}` : ""}`} data-note-recorder={state}>
      <div className="note-rec-head">
        <div className="note-rec-kinds" role="radiogroup" aria-label="Voice or video">
          {(["audio", "video"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={"note-rec-kind" + (kind === k ? " is-on" : "")}
              disabled={!picking && kind !== k}
              onClick={() => actions.choose(k)}
            >
              {k === "audio" ? <MicGlyph size={14} /> : <CameraGlyph size={14} />}
              {k === "audio" ? "Voice" : "Video"}
            </button>
          ))}
        </div>
        <button type="button" className="note-rec-close" aria-label="Close" data-tip="Close" onClick={actions.close}>
          ✕
        </button>
      </div>

      {viewer ? (
        <p className="note-rec-words">View only: you can play the notes here, not leave one. An admin can make you a member.</p>
      ) : asking ? (
        <div className="note-rec-body">
          <p className="note-rec-words">Discard this recording? It hasn't been left here, and it can't be brought back.</p>
          <div className="note-rec-acts">
            <button type="button" className="confirm-btn danger" onClick={asking.discard}>
              Discard
            </button>
            <button type="button" className="confirm-btn" onClick={asking.keep}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="note-rec-body">
          {/* the live camera while it records (and while it starts); a meter for a voice */}
          {kind === "video" && (state === "ready" || state === "recording") && <div className="note-rec-preview">{preview}</div>}
          {kind === "audio" && state === "recording" && <Meter level={snap.level} />}

          {state === "idle" && (
            <>
              <button type="button" className="note-rec-record" onClick={actions.record} data-note-record>
                <span className="note-rec-dot" aria-hidden />
                Record
              </button>
              <p className="note-rec-words is-quiet">
                Up to {clock(capMs(kind))}. The {dev} opens when you press Record and closes when you stop.
              </p>
            </>
          )}
          {state === "asking" && <p className="note-rec-words">Asking for the {dev}… the browser may ask you to allow it.</p>}
          {state === "ready" && <p className="note-rec-words">Starting…</p>}
          {state === "recording" && (
            <div className="note-rec-live">
              <button type="button" className="note-rec-stop" onClick={actions.stop} aria-label="Stop" data-note-stop>
                <span className="note-rec-square" aria-hidden />
                Stop
              </button>
              <span className="note-rec-clock" data-note-clock>
                <span className="note-rec-on" aria-hidden />
                {clock(snap.elapsed)} <span className="is-quiet">/ {clock(capMs(kind))}</span>
              </span>
              {countdown && (
                <span className="note-rec-countdown" role="status">
                  Stops in {Math.ceil(left / 1000)} s
                </span>
              )}
              <button type="button" className="confirm-btn note-rec-discard" onClick={actions.discard}>
                Discard
              </button>
            </div>
          )}
          {(state === "review" || state === "leaving" || (state === "failed" && snap.failure?.stage === "upload")) && snap.clip && (
            <>
              {kind === "audio" ? (
                <div className="note-rec-review">
                  <VoicePlayer src={reviewSrc} peaks={snap.clip.peaks} ms={snap.clip.ms} label="Your voice note" />
                </div>
              ) : (
                <div className="note-rec-preview">
                  {reviewSrc ? <video src={reviewSrc} controls playsInline preload="metadata" /> : preview}
                </div>
              )}
              {state === "leaving" ? (
                <p className="note-rec-words" role="status">
                  Leaving it here…
                </p>
              ) : (
                <div className="note-rec-acts">
                  <button type="button" className="confirm-btn primary" onClick={actions.leave} data-note-leave>
                    {state === "failed" ? "Try again" : "Leave it here"}
                  </button>
                  {state === "review" && (
                    <button type="button" className="confirm-btn" onClick={actions.record}>
                      Record again
                    </button>
                  )}
                  <button type="button" className="confirm-btn" onClick={actions.discard} data-note-discard>
                    Discard
                  </button>
                </div>
              )}
            </>
          )}
          {state === "failed" && snap.failure && (
            <>
              <p className="note-rec-words is-bad" role="alert">
                {snap.failure.text}
              </p>
              {snap.failure.stage !== "upload" && (
                <button type="button" className="note-rec-record" onClick={actions.record}>
                  <span className="note-rec-dot" aria-hidden />
                  Record
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Meter({ level }: { level: number }) {
  const bars = [0.55, 0.85, 1, 0.8, 0.5, 0.7, 0.9];
  return (
    <div className="note-rec-meter" aria-hidden>
      {bars.map((k, i) => (
        <span key={i} style={{ transform: `scaleY(${Math.max(0.08, Math.min(1, level * k * 1.6)).toFixed(3)})` }} />
      ))}
    </div>
  );
}

/** the camera as it records, mirrored (the person sees themselves as in a mirror; the clip is not) */
function LivePreview({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} className="is-mirror" muted playsInline autoPlay data-note-live />;
}

/** the section toolbar's microphone (SectionView): not for a viewer, who can't leave a note */
export function NoteTool({ sectionId }: { sectionId: string }) {
  const viewer = useUi().role === "viewer";
  if (viewer) return null;
  const tip = "Leave a voice or video note";
  return (
    <button className="sec-tool" data-tip={tip} aria-label={tip} data-note-open onClick={() => openNoteRecorder(sectionId)}>
      <MicGlyph size={14} />
    </button>
  );
}

/** the section's recorder, when it is open: SectionView draws one per section */
export function NoteRecorderHost({ sectionId }: { sectionId: string }) {
  const ask = useNoteAsk(sectionId);
  if (!ask) return null;
  return <NoteRecorder key={ask.nonce} sectionId={sectionId} kind={ask.kind} />;
}

function NoteRecorder({ sectionId, kind }: { sectionId: string; kind: NoteKind }) {
  const viewer = useUi().role === "viewer";
  const [rec, setRec] = useState(() => new NoteRecording(browserEnv(), kind));
  const [snap, setSnap] = useState<RecSnapshot>(rec.snap);
  const [asking, setAsking] = useState(false);
  const videoSize = useRef<{ w: number; h: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // whatever is open closes with it: unmount (the section went, the board changed) included
  useEffect(() => {
    // closed by a dev double-mount (StrictMode): a fresh one, which opens nothing until Record
    if (rec.isClosed) {
      setRec(new NoteRecording(browserEnv(), kind));
      return;
    }
    setSnap(rec.snap);
    const off = rec.subscribe(setSnap);
    return () => {
      off();
      rec.close();
    };
  }, [rec, kind]);

  // the camera's own shape, for the card
  useEffect(() => {
    const t = snap.stream?.getVideoTracks()[0];
    const s = t?.getSettings?.();
    if (s?.width && s?.height) videoSize.current = { w: s.width, h: s.height };
  }, [snap.stream]);

  // no meter ran (Safari without an AudioContext): the wave is read from the clip
  useEffect(() => {
    if (snap.state === "review" && snap.clip && snap.kind === "audio" && !snap.clip.peaks) void peaksFromBlob(snap.clip.blob).then((p) => rec.setPeaks(p));
  }, [snap.state, snap.clip, snap.kind, rec]);

  const reviewSrc = useBlobUrl(snap.clip?.blob);

  // anchored to the section's top-right, under its header, on the screen (not scaled with the grid)
  useLayoutEffect(() => {
    const place = () => {
      const el = document.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(sectionId)}"]`);
      const w = box.current?.offsetWidth ?? 320;
      const h = box.current?.offsetHeight ?? 200;
      if (!el) return setAt({ top: 80, left: Math.max(16, window.innerWidth - w - 16) });
      const r = el.getBoundingClientRect();
      const left = Math.min(window.innerWidth - w - 16, Math.max(16, r.right - w - 12));
      const top = Math.min(window.innerHeight - h - 16, Math.max(56, r.top + 44));
      setAt({ top, left });
    };
    place();
    const off = onCamera(place);
    window.addEventListener("resize", place);
    return () => {
      off();
      window.removeEventListener("resize", place);
    };
  }, [sectionId, snap.state]);

  const holds = () => rec.holdsClip || snap.state === "recording" || snap.state === "leaving";
  const close = () => {
    if (snap.state === "leaving") return;
    if (holds()) setAsking(true);
    else closeNoteRecorder();
  };

  // Esc closes (asking first when that would lose a clip); a press outside closes only when nothing would be lost
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (asking) setAsking(false);
      else close();
    };
    const away = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      if ((e.target as Element | null)?.closest?.("[data-note-open]")) return;
      if (!holds() && snap.state !== "asking") closeNoteRecorder();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", away, true);
    };
  });

  const send = async (clip: Clip) => {
    const sync = activeBoard();
    const board = sync?.boardId ?? "company";
    const me = sync?.user;
    const byName = me?.name ?? "Someone";
    const at = Date.now();
    const file = new File([clip.blob], noteFileName(kind, byName, at, clip.mime), { type: clip.mime });
    const up = await uploadFile(file, board);
    const size = kind === "audio" ? { w: VOICE_CARD.w, h: VOICE_CARD.h } : videoNoteSize(videoSize.current);
    addMediaNote(sectionId, {
      media: kind,
      name: noteName(kind, byName),
      ...size,
      note: { by: me?.id ?? "", byName, at, ms: Math.round(clip.ms), fileId: up.id, mime: up.mime || clip.mime, ...(clip.peaks ? { peaks: clip.peaks } : {}) },
    });
    return { fileId: up.id };
  };

  const actions: RecorderActions = {
    choose: (k) => {
      // a new kind is a new recorder: the ask says which
      if (k !== kind) openNoteRecorder(sectionId, k);
    },
    record: () => void rec.record(),
    stop: () => rec.stop(),
    discard: () => rec.discard(),
    leave: () =>
      void rec.leave(send).then((r) => {
        if (!r) return;
        const name = getState().allSections[sectionId]?.name ?? getState().sections[sectionId]?.name;
        toast(`${kind === "audio" ? "Voice" : "Video"} note left${name ? ` in ${name}` : ""}`, "ok");
        closeNoteRecorder();
      }),
    close,
  };

  const sectionName = getState().sections[sectionId]?.name ?? getState().allSections[sectionId]?.name;
  return createPortal(
    <div ref={box} className="note-rec-anchor" style={at ? { top: at.top, left: at.left } : { visibility: "hidden" }} data-note-anchor={sectionId}>
      <RecorderPanel
        snap={snap}
        actions={actions}
        sectionName={sectionName}
        viewer={viewer}
        preview={<LivePreview stream={snap.stream} />}
        reviewSrc={reviewSrc}
        asking={
          asking
            ? {
                discard: () => {
                  setAsking(false);
                  rec.discard();
                  closeNoteRecorder();
                },
                keep: () => setAsking(false),
              }
            : undefined
        }
      />
    </div>,
    document.body,
  );
}

function videoNoteSize(s: { w: number; h: number } | null) {
  const c = videoCardSize(s?.w ?? 0, s?.h ?? 0);
  return { w: c.w, h: c.h + VIDEO_CAPTION_H };
}

function useBlobUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

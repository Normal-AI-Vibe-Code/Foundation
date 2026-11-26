/**
 * Voice and video notes on the grid (2026-11-25, Josh: "you should see video notes that people leave, and
 * audio notes … where you can leave a short video note for someone to play back"). A note is a `media` card
 * with `note` (protocol MediaDoc.note): MediaView hands it here.
 *
 *  - **Voice note** (`media: "audio"`): a player, not a picture. Play/pause, the wave drawn from `peaks` with
 *    what's been played in ink (press or drag on it to go there), elapsed / total in tabular figures, who
 *    and when, and the speed (1× · 1.5× · 2×). 320 × 100 on paper; its width can be pulled from 240 to 560,
 *    its height is its own. A sound file put on the grid as `media: "audio"` plays the same, with an even wave.
 *  - **Video note**: the clip at its own shape over its first frame, a round play button in the middle, who /
 *    when / how long as a quiet caption under it. Never plays by itself; plays with its sound, in place, and
 *    goes full screen like any video.
 *
 * Both have the media "icons" chrome (picked up anywhere, full screen in the corner) and ask before they go:
 * the clip stays in the archive either way.
 */

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { MediaMeta, moveMedia, removeMedia, resizeMedia } from "../state/store";
import { ObjectFrame } from "../components/ObjectFrame";
import { useFileSrc } from "../lib/fileSrc";
import { useCalmAdmit } from "../lib/calm";
import { clock, PEAK_STEPS, VIDEO_CARD, VOICE_CARD, whoWhen } from "./recorder";
import "./notes.css";

/** the one note playing on this screen: starting another stops it */
let playing: HTMLMediaElement | null = null;
function claim(el: HTMLMediaElement) {
  if (playing && playing !== el && !playing.paused) playing.pause();
  playing = el;
}

const SPEEDS = [1, 1.5, 2] as const;
const EVEN = Array.from({ length: PEAK_STEPS }, (_, i) => 0.3 + 0.12 * Math.sin(i * 0.9));
/** how far below the clip the caption sits (a video note's card is the clip and this) */
export const VIDEO_CAPTION_H = 26;

interface PlayerProps {
  /** what the <audio> loads (a server file through useFileSrc, or a blob: while reviewing) */
  src: string | undefined;
  peaks?: number[];
  /** the length the note says (WebM from a recorder may not know its own) */
  ms?: number;
  caption?: string;
  /** narrow: the caption's when goes */
  compact?: boolean;
  /** the design page shows it at a moment of playback */
  fixture?: { at: number; playing?: boolean };
  label?: string;
}

/** the voice player itself: in a card, in the recorder's review, and on the design page */
export function VoicePlayer({ src, peaks, ms, caption, compact, fixture, label = "Voice note" }: PlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(!!fixture?.playing);
  const [t, setT] = useState(fixture ? fixture.at : 0);
  const [dur, setDur] = useState((ms ?? 0) / 1000);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const total = dur > 0 ? dur : (ms ?? 0) / 1000;
  const frac = total > 0 ? Math.min(1, t / total) : 0;
  const wave = peaks?.length ? peaks : EVEN;

  // the elapsed time follows the playback on frames while it plays (timeupdate is 4 a second: too coarse)
  useEffect(() => {
    const a = audio.current;
    if (!a || !on || fixture) return;
    let raf = 0;
    const step = () => {
      setT(a.currentTime);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, fixture]);

  useEffect(() => {
    const a = audio.current;
    if (a) a.playbackRate = speed;
  }, [speed]);

  // gone from the screen: it stops
  useEffect(() => () => audio.current?.pause(), []);

  const toggle = () => {
    const a = audio.current;
    if (!a || fixture) return;
    if (a.paused) {
      claim(a);
      a.muted = false;
      if (total > 0 && a.currentTime >= total - 0.05) a.currentTime = 0;
      void a.play().catch(() => setOn(false));
    } else a.pause();
  };

  const seekTo = (f: number) => {
    const a = audio.current;
    const at = Math.max(0, Math.min(1, f)) * total;
    setT(at);
    if (a && !fixture && total > 0) {
      try {
        a.currentTime = at;
      } catch {
        /* not seekable yet */
      }
    }
  };

  const waveRef = useRef<HTMLDivElement>(null);
  const fracAt = (x: number) => {
    const r = waveRef.current?.getBoundingClientRect();
    return r && r.width ? (x - r.left) / r.width : 0;
  };

  return (
    <div className={"voice-player" + (on ? " is-playing" : "") + (compact ? " is-compact" : "")}>
      <div className="voice-row">
        <button
          type="button"
          className="voice-play"
          aria-label={on ? `Pause ${label}` : `Play ${label}`}
          data-tip={on ? "Pause" : "Play"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {on ? <PauseMark /> : <PlayMark />}
        </button>
        <div
          ref={waveRef}
          className="voice-wave"
          role="slider"
          tabIndex={0}
          aria-label={`${label}: where it plays from`}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(t)}
          aria-valuetext={`${clock(t * 1000)} of ${clock(total * 1000)}`}
          data-voice-wave
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            // the wave is the scrubber, not the card's handle
            e.stopPropagation();
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            seekTo(fracAt(e.clientX));
          }}
          onPointerMove={(e) => {
            if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) seekTo(fracAt(e.clientX));
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              e.stopPropagation();
              seekTo((t + (e.key === "ArrowRight" ? 5 : -5)) / (total || 1));
            } else if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              toggle();
            }
          }}
        >
          <Bars peaks={wave} className="voice-bars" />
          <Bars peaks={wave} className="voice-bars is-played" style={{ clipPath: `inset(0 ${(100 - frac * 100).toFixed(2)}% 0 0)` }} />
        </div>
      </div>
      <div className="voice-meta">
        {caption && <span className="voice-who">{caption}</span>}
        <span className="voice-time" data-voice-time>
          {on || t > 0 ? `${clock(t * 1000)} / ${clock(total * 1000)}` : clock(total * 1000)}
        </span>
        <button
          type="button"
          className="voice-speed"
          aria-label={`Speed ${speed}×`}
          data-tip="Speed"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]);
          }}
        >
          {speed}×
        </button>
      </div>
      {src && !fixture && (
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setOn(true)}
          onPause={() => setOn(false)}
          onEnded={() => {
            setOn(false);
            setT(total);
          }}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDur(d);
            e.currentTarget.playbackRate = speed;
          }}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDur(d);
          }}
        />
      )}
    </div>
  );
}

function Bars({ peaks, className, style }: { peaks: number[]; className: string; style?: CSSProperties }) {
  const n = peaks.length;
  const gap = 1.2;
  const bw = (100 - gap * (n - 1)) / n;
  return (
    <svg className={className} style={style} viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden>
      {peaks.map((p, i) => {
        const h = Math.max(1.6, p * 30);
        return <rect key={i} x={i * (bw + gap)} y={(32 - h) / 2} width={bw} height={h} rx={0.6} />;
      })}
    </svg>
  );
}

function PlayMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}
function PauseMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="4" y="3" width="3" height="10" rx="0.8" fill="currentColor" />
      <rect x="9" y="3" width="3" height="10" rx="0.8" fill="currentColor" />
    </svg>
  );
}

interface CardProps {
  item: MediaMeta;
  pos: { x: number; y: number };
  isActive: boolean;
  getScale(): number;
}

const removeAsk = (item: MediaMeta) => ({ name: item.name || "this note", note: "Its recording stays in the archive." });

/** a voice note (or a sound) on the grid */
export const VoiceNoteCard = memo(function VoiceNoteCard({ item, pos, isActive, getScale }: CardProps) {
  const src = useFileSrc(item.src);
  const n = item.note;
  return (
    <ObjectFrame
      id={item.id}
      title={item.name}
      pos={pos}
      width={item.w}
      float={item.float}
      isActive={isActive}
      getScale={getScale}
      onMove={(x, y) => moveMedia(item.id, x, y)}
      // its width only, within bounds; its height is the player's own
      onResize={(dw) => resizeMedia(item.id, Math.max(VOICE_CARD.minW, Math.min(VOICE_CARD.maxW, item.w + dw)), VOICE_CARD.h)}
      onRemove={() => removeMedia(item.id)}
      confirmRemove={removeAsk(item)}
      chrome="icons"
      bodyClass="media-body"
      cardClass="media-card note-card is-voice"
      data={{ "note-kind": "audio" }}
    >
      <div className="note-voice-host" style={{ width: item.w, height: VOICE_CARD.h }}>
        <VoicePlayer
          src={src}
          peaks={n?.peaks}
          ms={n?.ms}
          caption={n ? whoWhen(n.byName, n.at) : item.name}
          compact={item.w < 300}
          label={item.name || "Voice note"}
        />
      </div>
    </ObjectFrame>
  );
});

/** a video note on the grid: plays in place, with its sound, only when pressed */
export const VideoNoteCard = memo(function VideoNoteCard({ item, pos, isActive, getScale }: CardProps) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [frac, setFrac] = useState(0);
  // its decoder only near the screen, once the camera is calm (as any video: MediaView); pressed, it stays
  const near = useCalmAdmit(useNearScreen(host));
  const [wanted, setWanted] = useState(false);
  const mount = near || wanted;
  const src = useFileSrc(item.src, mount);
  const n = item.note;
  const clipH = Math.max(VIDEO_CARD.min * 0.6, item.h - VIDEO_CAPTION_H);

  useEffect(() => {
    const v = video.current;
    if (!v || !on) return;
    let raf = 0;
    const step = () => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (n?.ms ?? 0) / 1000;
      setFrac(d > 0 ? Math.min(1, v.currentTime / d) : 0);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, n?.ms]);

  useEffect(() => () => video.current?.pause(), []);

  const toggle = () => {
    setWanted(true);
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      claim(v);
      v.muted = false;
      if (v.ended) v.currentTime = 0;
      void v.play().catch(() => setOn(false));
    } else v.pause();
  };

  // pressed before it was near enough to load: it plays as soon as it can
  useEffect(() => {
    const v = video.current;
    if (wanted && v && v.paused && !on && src) {
      claim(v);
      v.muted = false;
      void v.play().catch(() => {});
    }
    // only when the element first arrives after a press (src is what brings it)
  }, [src]); // eslint-disable-line

  return (
    <ObjectFrame
      id={item.id}
      title={item.name}
      pos={pos}
      width={item.w}
      float={item.float}
      isActive={isActive}
      getScale={getScale}
      onMove={(x, y) => moveMedia(item.id, x, y)}
      onResize={(dw, dh) => {
        // the clip keeps its shape
        const w = Math.max(VIDEO_CARD.min, Math.min(VIDEO_CARD.max, item.w + (Math.abs(dw) >= Math.abs(dh) ? dw : (dh * item.w) / clipH)));
        resizeMedia(item.id, Math.round(w), Math.round((w * clipH) / item.w + VIDEO_CAPTION_H));
      }}
      onRemove={() => removeMedia(item.id)}
      confirmRemove={removeAsk(item)}
      chrome="icons"
      onTap={toggle}
      bodyClass="media-body"
      cardClass={"media-card note-card is-video" + (on ? " is-playing" : "")}
      data={{ "note-kind": "video" }}
    >
      <div ref={host} className="media-host note-video-host" style={{ width: item.w, height: clipH }}>
        {mount && src && (
          <video
            ref={video}
            // the first frame stands as its poster (#t: the browser draws that frame without playing)
            src={src.startsWith("blob:") ? src : `${src}#t=0.05`}
            style={{ width: item.w, height: clipH }}
            preload="metadata"
            playsInline
            onPlay={() => setOn(true)}
            onPause={() => setOn(false)}
            onEnded={() => {
              setOn(false);
              setFrac(1);
            }}
          />
        )}
        {!on && (
          <span className="note-video-play" aria-hidden>
            <PlayMark />
          </span>
        )}
        <span className="note-video-progress" style={{ transform: `scaleX(${frac})` }} aria-hidden />
      </div>
      <div className="note-video-caption">
        <span className="voice-who">{n ? whoWhen(n.byName, n.at) : item.name}</span>
        {n && <span className="voice-time">{clock(n.ms)}</span>}
      </div>
    </ObjectFrame>
  );
});

/** a video note at rest, for the design page (no file, no decoder): its first frame is a still */
export function VideoNoteStill({ w, h, caption, ms, poster }: { w: number; h: number; caption: string; ms: number; poster?: React.ReactNode }) {
  return (
    <div className="frame-card media-card note-card is-video" style={{ width: w, position: "relative" }}>
      <div className="media-body">
        <div className="media-host note-video-host" style={{ width: w, height: h - VIDEO_CAPTION_H }}>
          {poster}
          <span className="note-video-play" aria-hidden>
            <PlayMark />
          </span>
        </div>
        <div className="note-video-caption">
          <span className="voice-who">{caption}</span>
          <span className="voice-time">{clock(ms)}</span>
        </div>
      </div>
    </div>
  );
}

function useNearScreen(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "100% 100%" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

import { memo, useEffect, useRef, useState } from "react";
import { isNight, onNight } from "@foundation/ui";
import {
  drawnScale,
  MediaMeta,
  moveMedia,
  removeMedia,
  resizeMedia,
  setMediaFlag,
  subscribe,
} from "../state/store";
import { ObjectFrame } from "./ObjectFrame";
import { useFileSrc } from "../lib/fileSrc";
import { fetchFile } from "../lib/api";
import { camera, onCamera } from "../state/camera";
import { useCalmAdmit } from "../lib/calm";
import { levelsNow, levelsOf, LOD_WIDTHS, nextLevel, pick, type Levels } from "../lib/imageLod";

interface Props {
  item: MediaMeta;
  pos: { x: number; y: number };
  isActive: boolean;
  getScale(): number;
}

export const MediaView = memo(function MediaView({ item, pos, isActive, getScale }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const image = item.media === "image";
  // a picture is drawn from the smallest level that's sharp at its drawn size (lib/imageLod.ts)
  const lod = useImageLevel(image ? item.src : null, item.name, item.w, hostRef);
  // a video only while it's near the screen: off screen it gives back its decoder and its frames
  // a video mounts once the camera is calm near it (lib/calm.ts), and lets go 5 s after it leaves
  const near = useCalmAdmit(useNear(hostRef, !image, 0, 5000));
  // shared media lives on the server (/files/…): loaded from the configured server, with this device's session
  const original = useFileSrc(item.src, image ? lod.original : near);
  const src = image ? (lod.original ? original : lod.url) : near ? original : undefined;
  const shown = useDecoded(image ? src : undefined);
  const [loaded, setLoaded] = useState(false);
  // a drawing on a clear ground can be shown inverted on a dark one (the levels know; else read once)
  const read = useHasAlpha(image && lod.levels === null ? item.src : null, item.name);
  const clear = lod.levels ? lod.levels.alpha : read;
  const night = useNight();

  // keep the <video> element in line with the autoplay/mute flags
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = item.muted;
    if (item.autoplay) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [item.autoplay, item.muted, near]);

  // the chrome is a couple of round icons that slide out from behind the card on hover
  const icons =
    item.media === "image" ? (
      clear && (night || item.invert) ? (
        <button
          className={"frame-icon" + (item.invert ? " is-on" : "")}
          data-tip={item.invert ? "Show as it is on dark" : "Invert on dark"}
          aria-label={item.invert ? "Show as it is on dark" : "Invert on dark"}
          aria-pressed={!!item.invert}
          onClick={() => setMediaFlag(item.id, { invert: !item.invert })}
        >
          <InvertGlyph />
        </button>
      ) : null
    ) : item.media === "video" ? (
      <button
        className={"frame-icon" + (item.muted ? "" : " is-on")}
        data-tip={item.muted ? "Turn sound on" : "Mute"}
        aria-label={item.muted ? "Turn sound on" : "Mute"}
        onClick={() => setMediaFlag(item.id, { muted: !item.muted })}
      >
        {item.muted ? <SoundGlyph off /> : <SoundGlyph />}
      </button>
    ) : null;

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
      onResize={(dw, dh) => resizeMedia(item.id, item.w + dw, item.h + dh)}
      onRemove={() => removeMedia(item.id)}
      chrome="icons"
      icons={icons}
      onTap={item.media === "video" ? () => setMediaFlag(item.id, { autoplay: !item.autoplay }) : undefined}
      bodyClass="media-body"
      cardClass={"media-card" + (clear ? " is-clear" : "")}
    >
      <div ref={hostRef} className="media-host" style={{ width: item.w, height: item.h }}>
        {item.media === "image" ? (
          shown && (
            <img
              src={shown}
              alt={item.name}
              className={(loaded ? "is-loaded" : "") + (item.invert ? " is-inverted" : "")}
              style={{ width: item.w, height: item.h }}
              draggable={false}
              decoding="async"
              onLoad={() => setLoaded(true)}
            />
          )
        ) : near ? (
          <video
            ref={videoRef}
            src={src}
            style={{ width: item.w, height: item.h }}
            muted={item.muted}
            autoPlay={item.autoplay}
            preload="metadata"
            loop
            playsInline
          />
        ) : null}
      </div>
    </ObjectFrame>
  );
});

/**
 * Within a screen of the viewport (images start their levels, videos mount).
 * `enterMs` / `leaveMs`: how long it must stay near before it counts, and far
 * before it stops, so a camera sweeping past doesn't start and drop a video's
 * decoder on the way (that cost a glide a third of its frames).
 */
function useNear(ref: React.RefObject<HTMLElement | null>, on = true, enterMs = 0, leaveMs = 0) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    let timer = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        clearTimeout(timer);
        const v = e.isIntersecting;
        const wait = v ? enterMs : leaveMs;
        if (wait) timer = window.setTimeout(() => setNear(v), wait);
        else setNear(v);
      },
      { rootMargin: "100% 100%" },
    );
    io.observe(el);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [ref, on, enterMs, leaveMs]);
  return near;
}

/**
 * The level a picture card shows (lib/imageLod.ts): its drawn width in device
 * pixels (card width × zoom × its section's fit × the pixel ratio), read as
 * the camera moves and acted on once it settles, so a pinch swaps at most once.
 */
function useImageLevel(src: string | null, name: string, cardW: number, ref: React.RefObject<HTMLElement | null>) {
  const near = useNear(ref, Boolean(src));
  const [levels, setLevels] = useState<Levels | null | undefined>(() => (src ? levelsNow(src) : undefined));
  const [level, setLevel] = useState<number>(LOD_WIDTHS[0]);
  useEffect(() => {
    if (!src || !near || levels !== undefined) return;
    let alive = true;
    void levelsOf(src, name).then((l) => alive && setLevels(l));
    return () => {
      alive = false;
    };
  }, [src, name, near, levels]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    const section = el.closest(".section-content") ? (el.closest<HTMLElement>("[data-section-id]")?.dataset.sectionId ?? null) : null;
    let timer = 0;
    let cur = LOD_WIDTHS[0];
    const want = () => nextLevel(cur, cardW * drawnScale(camera.scale, section) * (window.devicePixelRatio || 1));
    const apply = () => {
      cur = want();
      setLevel(cur);
    };
    apply();
    const off = onCamera(() => {
      clearTimeout(timer);
      if (want() !== cur) timer = window.setTimeout(apply, 160);
    });
    const offFit = section ? subscribe(() => want() !== cur && apply()) : () => {};
    return () => {
      clearTimeout(timer);
      off();
      offFit();
    };
  }, [src, cardW, ref]);
  const chosen = levels === undefined ? null : pick(levels, "", level);
  return {
    levels,
    /** the original is what's needed: past the largest level, or no levels for it */
    original: levels === null || (chosen !== null && chosen.url === ""),
    url: chosen && chosen.url !== "" ? chosen.url : undefined,
  };
}

/**
 * Show a new picture only once it has decoded, so a level swap never blanks
 * the card: the one before stays until the next is ready.
 */
function useDecoded(url: string | undefined) {
  const [shown, setShown] = useState(url);
  useEffect(() => {
    if (!url || url === shown) return;
    if (!shown) {
      setShown(url);
      return;
    }
    let alive = true;
    const img = new Image();
    img.src = url;
    img
      .decode()
      .catch(() => {})
      .then(() => alive && setShown(url));
    return () => {
      alive = false;
    };
  }, [url, shown]);
  return shown;
}

/** the room is dark */
function useNight() {
  const [night, set] = useState(isNight);
  useEffect(() => {
    const off = onNight(set);
    return () => {
      off();
    };
  }, []);
  return night;
}

/**
 * Whether an image has see-through pixels (read once per file, from a 48 px
 * sample). Only formats that can be clear are read; an SVG is assumed clear.
 */
const alphaCache = new Map<string, Promise<boolean>>();
const CAN_BE_CLEAR = /\.(png|gif|webp|avif|svg)(\?|#|$)/i;
function useHasAlpha(src: string | null, name: string): boolean {
  const [clear, setClear] = useState(false);
  useEffect(() => {
    if (!src || !(CAN_BE_CLEAR.test(name) || CAN_BE_CLEAR.test(src) || src.startsWith("blob:") || src.startsWith("data:image/png"))) return;
    let alive = true;
    let p = alphaCache.get(src);
    if (!p) {
      p = readAlpha(src, name).catch(() => false);
      alphaCache.set(src, p);
    }
    void p.then((v) => alive && setClear(v));
    return () => {
      alive = false;
    };
  }, [src, name]);
  return clear;
}
async function readAlpha(src: string, name: string): Promise<boolean> {
  const res = src.startsWith("/files/") ? await fetchFile(src) : await fetch(src);
  if (!res.ok) return false;
  const blob = await res.blob();
  if (blob.type.includes("svg") || /\.svg$/i.test(name)) return true;
  const bmp = await createImageBitmap(blob);
  const n = 48;
  const c = new OffscreenCanvas(n, n);
  const ctx = c.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(bmp, 0, 0, n, n);
  bmp.close();
  const d = ctx.getImageData(0, 0, n, n).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

function InvertGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SoundGlyph({ off }: { off?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5z" />
      {off ? <path d="M11 6l3.5 4M14.5 6L11 10" /> : <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" />}
    </svg>
  );
}

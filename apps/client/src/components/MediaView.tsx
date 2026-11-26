import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
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
import { camera, FAR_ZOOM, onCamera } from "../state/camera";
import { useCalmAdmit } from "../lib/calm";
import { arrivalStep } from "../lib/arrival";
import { aheadScale, cameraCalm, CALM_MS, watchAhead } from "../lib/viewAhead";
import {
  isLocalDataUrl,
  peekCachedImage,
  peekShedImage,
  retainCachedImage,
  viewportDistance,
  type CachedImageEntry,
} from "../lib/imageCache";
import {
  isLodDisabled,
  isSkippableImage,
  levelToTier,
  loadProgressiveImage,
  LOD_WIDTHS,
  nextLevel,
} from "../lib/imageLod";
import "./progressive-image.css";

/** Off-screen grace period before an image card sheds its GPU texture down to its tiny 64/256 tier. */
const VRAM_SHED_MS = 2500;
/** how long a picture goes on easing after its sharp level replaces the stand-in: the focus (--dur-quick) and the longest wait of the wave (lib/arrival.ts) */
const SETTLE_MS = 160 + 6 * 40 + 60;

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
  // a picture is drawn from the smallest server/cached tier that's sharp at its drawn size,
  // reveals from a w=64 micro-preview on cold loads, and sheds VRAM after leaving the viewport
  const prog = useProgressiveMedia(image ? item.src : null, item.name, item.w, hostRef);
  // a video only while it's near the screen: off screen it gives back its decoder and its frames
  // a video mounts once the camera is calm near it (lib/calm.ts), and lets go 5 s after it leaves
  const nearVideo = useCalmAdmit(useNear(hostRef, !image, 0, 5000));
  // shared media lives on the server (/files/…): fallback for ?nolod / SVG / GIF / external non-CORS / videos
  const original = useFileSrc(item.src, image ? prog.fallbackOriginal : nearVideo);
  const desiredUrl = image ? (prog.fallbackOriginal ? original : prog.url) : nearVideo ? original : undefined;
  const shown = useDecoded(image ? desiredUrl : undefined);
  const isShowingPreview = image && Boolean(shown) && prog.isPreview && shown === prog.url;
  const [loaded, setLoaded] = useState(() => Boolean(image && prog.instantSharp));
  // a drawing on a clear ground can be shown inverted on a dark one (headers/worker know; else read once)
  const needAlphaProbe = image && prog.alpha === null && (prog.fallbackOriginal || prog.url !== undefined);
  const read = useHasAlpha(needAlphaProbe ? item.src : null, item.name);
  const clear = prog.alpha !== null ? prog.alpha : read;
  const night = useNight();

  // How it arrives (2026-11-25). A picture that was in memory when its card mounted is simply there. A cold one
  // fades in from its well as the 64 px stand-in, blurred, and the sharp level then comes into focus over it; the
  // focus used to be a pop (the transition went away with the stand-in's class), so the card stays "settling" for
  // the length of it. And it waits a few steps by its distance from the middle of the screen (lib/arrival.ts), so
  // a section's pictures fill as a wave from the centre, not in the order their fetches happen to land
  const [cold] = useState(() => image && !prog.instantSharp);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (cold) setStep(arrivalStep(viewportDistance(hostRef.current)));
  }, [cold]);
  const [settling, setSettling] = useState(false);
  const wasPreview = useRef(false);
  useEffect(() => {
    if (isShowingPreview) {
      wasPreview.current = true;
      return;
    }
    if (!wasPreview.current) return;
    wasPreview.current = false;
    setSettling(true);
    const t = window.setTimeout(() => setSettling(false), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [isShowingPreview]);

  // Keep loaded true once a cached sharp URL is shown immediately
  useEffect(() => {
    if (image && prog.instantSharp && !loaded) setLoaded(true);
  }, [image, prog.instantSharp, loaded]);

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
  }, [item.autoplay, item.muted, nearVideo]);

  // an autoplaying video plays only while it's on screen and the board isn't drawn small (2026-11-24): each playing
  // frame is a repaint, and a studio's clips played on at 12 % a screen away. Paused, it holds its frame: its poster
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !item.autoplay || typeof IntersectionObserver === "undefined") return;
    let onScreen = false;
    let far = camera.scale < FAR_ZOOM;
    const set = () => {
      const want = onScreen && !far;
      if (want === !v.paused) return;
      if (want) void v.play().catch(() => {});
      else v.pause();
    };
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      set();
    });
    io.observe(v);
    const off = onCamera((c) => {
      const f = c.scale < FAR_ZOOM;
      if (f === far) return;
      far = f;
      set();
    });
    return () => {
      io.disconnect();
      off();
    };
  }, [item.autoplay, nearVideo]);

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
              className={
                (loaded || isShowingPreview ? "is-loaded" : "") +
                (isShowingPreview ? " f-img-preview" : "") +
                (settling ? " f-img-settling" : "") +
                (cold ? " f-img-cold" : "") +
                (item.invert ? " is-inverted" : "")
              }
              style={step ? ({ width: item.w, height: item.h, "--arrive-step": step } as CSSProperties) : { width: item.w, height: item.h }}
              draggable={false}
              decoding="async"
              onLoad={() => setLoaded(true)}
            />
          )
        ) : nearVideo ? (
          <video
            ref={videoRef}
            src={desiredUrl}
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
function useNear(ref: React.RefObject<HTMLElement | null>, on = true, enterMs = 0, leaveMs = 0, rootMargin = "100% 100%") {
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
      { rootMargin },
    );
    io.observe(el);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [ref, on, enterMs, leaveMs, rootMargin]);
  return near;
}

/** in the view the camera is heading for (lib/viewAhead.ts) */
function useAhead(ref: React.RefObject<HTMLElement | null>, on: boolean) {
  const [ahead, setAhead] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    return watchAhead(el, setAhead);
  }, [ref, on]);
  return ahead;
}

/**
 * Progressive, cached, viewport-prioritized image loading for grid MediaView cards:
 *  - Reads synchronously from L1 on render 1 (zero flash on remount or board switch).
 *  - Fetches tiny w=64 preview in parallel with the drawn-width target tier on cold load.
 *  - Cancels off-screen fetches immediately so visible cards jump to the front.
 *  - Sheds displayed `<img>` down to tiny cached 64/256 tier 2.5 s after leaving the extended
 *    viewport to free GPU VRAM while keeping high tiers cached in L1/L2 for instant restore.
 */
function useProgressiveMedia(src: string | null, name: string, cardW: number, ref: React.RefObject<HTMLElement | null>) {
  const bypass = Boolean(src) && (isLodDisabled() || isSkippableImage(src!, name) || isLocalDataUrl(src!));
  const watching = Boolean(src) && !bypass;
  // near: within a screen of the view now, or in the view the camera is heading for (lib/viewAhead.ts), so a zoom
  // out starts the cards it is about to show as it begins, not as they arrive
  const nearNow = useNear(ref, watching, 0, 0, "100% 100%");
  const ahead = useAhead(ref, watching);
  const near = nearNow || ahead;
  const visible = useNear(ref, watching, 0, 0, "0px");
  const [shed, setShed] = useState(false);
  const [level, setLevel] = useState<number>(LOD_WIDTHS[0]);
  const [fallbackFailed, setFallbackFailed] = useState(false);

  // Off-screen GPU VRAM shedding after 2.5 s grace period; immediately restored when panning back near
  useEffect(() => {
    if (!src || bypass) return;
    if (near) {
      setShed(false);
      return;
    }
    const t = window.setTimeout(() => setShed(true), VRAM_SHED_MS);
    return () => clearTimeout(t);
  }, [src, bypass, near]);

  // Track drawn width in device pixels with nextLevel hysteresis and calm camera debounce
  useEffect(() => {
    const el = ref.current;
    if (!el || !src || bypass) return;
    const section = el.closest(".section-content") ? (el.closest<HTMLElement>("[data-section-id]")?.dataset.sectionId ?? null) : null;
    let timer = 0;
    let lastUp = 0;
    let cur = LOD_WIDTHS[0];
    // a zoom in loads the level for where it lands (the goal's scale), as it starts; a zoom out keeps the level it
    // has until the camera is calm, so pictures never swap down mid-gesture (each swap is a decode and a new texture)
    const want = () => nextLevel(cur, cardW * drawnScale(aheadScale(), section) * (window.devicePixelRatio || 1));
    const apply = () => {
      const w = want();
      if (w < cur && !cameraCalm()) {
        timer = window.setTimeout(apply, CALM_MS);
        return;
      }
      cur = w;
      lastUp = performance.now();
      setLevel(cur);
    };
    cur = want();
    setLevel(cur);
    const off = onCamera(() => {
      const w = want();
      if (w === cur) return;
      clearTimeout(timer);
      // up: at most one step per 120 ms while the zoom goes on; down: once the camera is calm
      if (w > cur) timer = window.setTimeout(apply, Math.max(0, 120 - (performance.now() - lastUp)));
      else timer = window.setTimeout(apply, CALM_MS);
    });
    const offFit = section ? subscribe(() => want() !== cur && apply()) : () => {};
    return () => {
      clearTimeout(timer);
      off();
      offFit();
    };
  }, [src, cardW, ref, bypass]);

  const targetTier = levelToTier(level);
  const minWidth = targetTier === "orig" ? Infinity : targetTier;

  // Synchronous L1 hit on render 1 (zero flash on remount or pan-back from shed state!)
  const syncEntry = src && !bypass ? peekCachedImage(src, minWidth) : null;
  const [active, setActive] = useState<{ forSrc: string; entry: CachedImageEntry } | null>(() =>
    src && syncEntry ? { forSrc: src, entry: syncEntry } : null,
  );

  useEffect(() => {
    setFallbackFailed(false);
  }, [src]);

  // Load/upgrade target tier when near viewport; pin active L1 entry; cancel on pan-away
  useEffect(() => {
    if (!src || bypass) return;
    let alive = true;
    const ctrl = new AbortController();
    let releasePin: (() => void) | null = null;

    const pinOnly = (entry: CachedImageEntry) => {
      releasePin?.();
      releasePin = retainCachedImage(entry.key);
    };

    const pinAndShow = (entry: CachedImageEntry) => {
      pinOnly(entry);
      setActive({ forSrc: src, entry });
    };

    // If shed off-screen, pin only the tiny shed tier (never overwrite `active` and keep high tier cached in L1/L2)
    if (shed) {
      const full = peekCachedImage(src, minWidth);
      const shedEntry = full ? peekShedImage(src, full.tier) ?? full : null;
      if (shedEntry) pinOnly(shedEntry);
      return () => {
        alive = false;
        ctrl.abort();
        releasePin?.();
      };
    }

    // Pin synchronous L1 hit right away (zero re-fetch when panning back from shed state!)
    const hit = peekCachedImage(src, minWidth);
    if (hit) {
      pinAndShow(hit);
      const alreadyGood =
        targetTier === "orig"
          ? hit.tier === "orig"
          : hit.tier === "orig" ||
            hit.tier >= targetTier ||
            (hit.natural !== null && hit.natural[0] > 0 && hit.natural[0] <= hit.tier);
      if (alreadyGood) {
        return () => {
          alive = false;
          ctrl.abort();
          releasePin?.();
        };
      }
    }

    if (!near) {
      return () => {
        alive = false;
        ctrl.abort();
        releasePin?.();
      };
    }

    void loadProgressiveImage(src, targetTier, {
      name,
      priority: visible ? 0 : 1,
      distance: viewportDistance(ref.current),
      preview: true,
      signal: ctrl.signal,
      onStage: (entry) => {
        if (!alive) return;
        pinAndShow(entry);
      },
    }).then((res) => {
      if (!alive || ctrl.signal.aborted) return;
      if (!res && !hit) {
        // External image without CORS or server error: let <img> load original directly
        setFallbackFailed(true);
      }
    });

    return () => {
      alive = false;
      ctrl.abort();
      releasePin?.();
    };
  }, [src, name, bypass, near, visible, shed, targetTier, minWidth, ref]);

  // Prefer the authoritative synchronous L1 hit when available so shed -> restore paints sharp on frame 1
  const baseEntry = syncEntry ?? (active && active.forSrc === src ? active.entry : null);
  const displayEntry =
    src && !bypass && shed && baseEntry ? (peekShedImage(src, baseEntry.tier) ?? baseEntry) : baseEntry;

  // A 64 px copy is a blurred stand-in only while a cold picture waits for its first real level. Drawn small (its
  // level is 64) or shed off screen, it is the picture: blurring it then was the flicker of a zoom out, and
  // focusing it again the flicker of the zoom back in
  const seenSharp = useRef(false);
  if (displayEntry && (displayEntry.tier !== 64 || targetTier === 64)) seenSharp.current = true;
  const isPreview = displayEntry?.tier === 64 && targetTier !== 64 && !shed && !seenSharp.current;

  return {
    url: displayEntry?.url,
    isPreview,
    instantSharp: Boolean(syncEntry && syncEntry.tier !== 64),
    alpha: baseEntry?.alpha ?? syncEntry?.alpha ?? null,
    fallbackOriginal: bypass || fallbackFailed,
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

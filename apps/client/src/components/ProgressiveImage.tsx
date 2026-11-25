/**
 * Reusable progressive image component backed by `imageCache.ts` and `imageLod.ts`.
 *
 * - Reads synchronously from L1 on frame 1 so remounting, switching channels/boards,
 *   or opening the Lightbox never flashes a blank box.
 * - On cold loads of server images, reveals the tiny `w=64` micro-preview (~20 ms)
 *   with a soft blur while the target tier fetches, then decodes off the main thread
 *   via `img.decode()` before swapping cleanly via `opacity`.
 * - Pins its active L1 entry while mounted so LRU eviction never revokes an active URL.
 */

import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributeReferrerPolicy } from "react";
import {
  isLocalDataUrl,
  isServerImagePath,
  peekCachedImage,
  retainCachedImage,
  snapServerTier,
  supportsServerResize,
  viewportDistance,
  type CachedImageEntry,
  type FetchPriority,
  type ImageTier,
} from "../lib/imageCache";
import { isLodDisabled, isSkippableImage, loadProgressiveImage } from "../lib/imageLod";
import "./progressive-image.css";

export type ProgressivePhase = "well" | "preview" | "sharp" | "error";

export interface ProgressiveImageProps {
  src: string | null | undefined;
  alt: string;
  /** Target tier width (default 512). Pass `"orig"` for full-resolution views such as Lightbox. */
  targetWidth?: 64 | 256 | 512 | 1024 | 2048 | "orig";
  /** Fetch the tiny `w=64` micro-preview in parallel on cold loads (default true). */
  preview?: boolean;
  /** Enable loading (pass viewport visibility when lazy-mounting). Default true. */
  enabled?: boolean;
  /** Scheduler priority: 0 = visible, 1 = near, 2 = background. Default 0. */
  priority?: FetchPriority;
  /** Optional aspect ratio (e.g. `"4 / 3"`) so the well holds space before load. */
  aspectRatio?: string;
  /** `"cover"` / `"contain"` fills the container; omit for natural sizing. */
  fit?: "cover" | "contain";
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
  draggable?: boolean;
  referrerPolicy?: HTMLAttributeReferrerPolicy;
  onLoad?: () => void;
  onError?: () => void;
  onTierChange?: (info: { tier: ImageTier | null; fromCache: boolean; phase: ProgressivePhase }) => void;
}

interface DisplayState {
  forSrc: string;
  url: string;
  tier: ImageTier | null;
  phase: ProgressivePhase;
  instant: boolean;
  cacheKey: string | null;
}

function tierSatisfies(entry: CachedImageEntry, target: ImageTier): boolean {
  if (target === "orig") return entry.tier === "orig";
  if (entry.tier === "orig") return true;
  if (entry.tier >= target) return true;
  if (entry.natural && entry.natural[0] > 0 && entry.natural[0] <= entry.tier) return true;
  return false;
}

function resolveTargetTier(src: string, targetWidth: ProgressiveImageProps["targetWidth"]): ImageTier {
  if (targetWidth === "orig") return "orig";
  if (isLodDisabled() || isSkippableImage(src) || !supportsServerResize(src)) return "orig";
  return snapServerTier(targetWidth ?? 512);
}

function initialDisplay(src: string | null | undefined, targetWidth: ProgressiveImageProps["targetWidth"]): DisplayState | null {
  if (!src) return null;
  if (isLocalDataUrl(src) || !isServerImagePath(src)) {
    return { forSrc: src, url: src, tier: "orig", phase: "sharp", instant: false, cacheKey: null };
  }
  const target = resolveTargetTier(src, targetWidth);
  const minWidth = target === "orig" ? Infinity : target;
  const hit = peekCachedImage(src, minWidth);
  if (!hit) return null;
  const sharp = tierSatisfies(hit, target) || hit.tier !== 64;
  return {
    forSrc: src,
    url: hit.url,
    tier: hit.tier,
    phase: sharp ? "sharp" : "preview",
    instant: true,
    cacheKey: hit.key,
  };
}

export function ProgressiveImage({
  src,
  alt,
  targetWidth = 512,
  preview = true,
  enabled = true,
  priority = 0,
  aspectRatio,
  fit,
  className,
  imgClassName,
  style,
  draggable = false,
  referrerPolicy,
  onLoad,
  onError,
  onTierChange,
}: ProgressiveImageProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<DisplayState | null>(() => initialDisplay(src, targetWidth));
  const [directReady, setDirectReady] = useState(false);

  // Compute synchronous display for the current `src` so switching `src` hits L1 on frame 1
  const syncFallback = src && state?.forSrc !== src ? initialDisplay(src, targetWidth) : null;
  const active = state && state.forSrc === src ? state : syncFallback;

  const isManagedServer = Boolean(src) && !isLocalDataUrl(src!) && isServerImagePath(src!);

  useEffect(() => {
    if (!src) {
      setState(null);
      return;
    }

    if (!isManagedServer) {
      setDirectReady(false);
      setState({ forSrc: src, url: src, tier: "orig", phase: "sharp", instant: false, cacheKey: null });
      onTierChange?.({ tier: "orig", fromCache: false, phase: "sharp" });
      return;
    }

    if (!enabled) return;

    const target = resolveTargetTier(src, targetWidth);
    const minWidth = target === "orig" ? Infinity : target;
    let alive = true;
    const ctrl = new AbortController();
    let releasePin: (() => void) | null = null;
    let currentTierRank = -1;

    const pinAndApply = (entry: CachedImageEntry, isFinal: boolean, fromCache: boolean) => {
      const rank = entry.tier === "orig" ? Infinity : entry.tier;
      if (rank < currentTierRank && !isFinal) return;
      currentTierRank = rank;

      const phase: ProgressivePhase = isFinal || entry.tier !== 64 ? "sharp" : "preview";
      const commit = () => {
        if (!alive) return;
        releasePin?.();
        releasePin = retainCachedImage(entry.key);
        setState({
          forSrc: src,
          url: entry.url,
          tier: entry.tier,
          phase,
          instant: fromCache,
          cacheKey: entry.key,
        });
        onTierChange?.({ tier: entry.tier, fromCache, phase });
        if (phase === "sharp") onLoad?.();
      };

      // Instant L1 hit or first preview paints immediately; upgrades decode off-main-thread before swap
      if (fromCache || phase === "preview") {
        commit();
        return;
      }

      const img = new Image();
      img.src = entry.url;
      img
        .decode()
        .catch(() => {})
        .then(commit);
    };

    // Check L1 synchronously first so we pin it immediately
    const syncHit = peekCachedImage(src, minWidth);
    if (syncHit) {
      const alreadyFull = tierSatisfies(syncHit, target);
      pinAndApply(syncHit, alreadyFull, true);
      if (alreadyFull) {
        return () => {
          alive = false;
          ctrl.abort();
          releasePin?.();
        };
      }
    } else {
      onTierChange?.({ tier: null, fromCache: false, phase: "well" });
    }

    const distance = viewportDistance(hostRef.current);
    void loadProgressiveImage(src, target, {
      name: alt,
      priority,
      distance,
      preview,
      signal: ctrl.signal,
      onStage: (entry, isFinal) => {
        if (!alive) return;
        pinAndApply(entry, isFinal, false);
      },
    }).then((result) => {
      if (!alive || ctrl.signal.aborted) return;
      if (!result && !syncHit) {
        setState({ forSrc: src, url: "", tier: null, phase: "error", instant: false, cacheKey: null });
        onTierChange?.({ tier: null, fromCache: false, phase: "error" });
        onError?.();
      }
    });

    return () => {
      alive = false;
      ctrl.abort();
      releasePin?.();
    };
  }, [src, enabled, targetWidth, preview, priority, isManagedServer]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSharp = active?.phase === "sharp" && (isManagedServer || directReady);
  const isPreview = active?.phase === "preview";
  const fitClass = fit === "cover" ? " f-prog-fit-cover" : fit === "contain" ? " f-prog-fit-contain" : "";
  const layoutClass = fit ? " is-fill" : " is-natural";

  return (
    <span
      ref={hostRef}
      className={`f-prog${layoutClass}${isSharp ? " is-sharp" : ""}${className ? ` ${className}` : ""}`}
      style={aspectRatio ? { ...style, aspectRatio } : style}
      data-prog-phase={active?.phase ?? "well"}
      data-prog-tier={active?.tier ?? ""}
    >
      {active?.url && (
        <img
          src={active.url}
          alt={alt}
          className={`f-prog-img${fitClass}${active.instant ? " is-instant" : isPreview ? " is-preview" : isSharp ? " is-visible" : ""}${imgClassName ? ` ${imgClassName}` : ""}`}
          draggable={draggable}
          decoding="async"
          referrerPolicy={referrerPolicy}
          onLoad={() => {
            if (!isManagedServer) {
              setDirectReady(true);
              onLoad?.();
            }
          }}
          onError={() => onError?.()}
        />
      )}
    </span>
  );
}

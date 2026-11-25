/**
 * Files on the server (`/files/…`) in elements: <img>, <video>, <iframe>, a
 * link.
 *
 * For server images (whenever `opts.width` is given, or in `BEARER` mode for
 * image responses), URLs are backed by the unified two-tier `imageCache.ts`
 * (L1 ref-counted in-memory LRU + L2 persistent Cache Storage). Remounting a
 * card, switching boards/channels, or scrolling ChatForm reads synchronously
 * from L1 with zero flash and never re-fetches or revokes active URLs on
 * unmount.
 *
 * Non-image files (video, audio, PDF) keep the existing behaviour: direct
 * server URL on cookie transport, or temporary fetched blob URL on bearer
 * transport.
 */

import { useEffect, useState, type MouseEvent } from "react";
import { BEARER, fetchFile, SERVER, serverUrl } from "./api";
import {
  isServerImagePath,
  peekCachedImage,
  peekExactImage,
  putCachedImage,
  readL2Image,
  retainCachedImage,
  setImageCacheOrigin,
  snapServerTier,
  supportsServerResize,
  writeL2Image,
  type FetchPriority,
  type ImageTier,
} from "./imageCache";
import { isLodDisabled, isSkippableImage, loadImageTier } from "./imageLod";

if (typeof window !== "undefined") {
  setImageCacheOrigin(() => SERVER || window.location.origin);
}

// a character's pictures are the server's files too (/api/characters/:id/files/:role): with a bearer they need the header like any other
// so is the picture kept of a page card (/api/boards/:id/pages/:panel/picture)
const isServerFile = isServerImagePath;

const MAX_CACHED_BEARER_BYTES = 32 * 1024 * 1024;

function isKnownImageEndpoint(src: string): boolean {
  if (/^\/api\/boards\/[^/]+\/pages\/[^/]+\/picture/.test(src)) return true;
  if (/^\/api\/characters\/[^/]+\/files\/(thumb|front|back|side|portrait|expressions)(\?|$)/.test(src)) return true;
  return false;
}

export interface FileSrcOptions {
  /** Requested target width in pixels — enables server-resized tier + L1/L2 image caching on both cookie and bearer transports. */
  width?: number;
  /** Optional priority override for the image fetch scheduler (0 = visible, 1 = near, 2 = background). */
  priority?: FetchPriority;
}

/**
 * The URL an element should load `src` from. Anything that isn't a server
 * file passes through.
 *
 * - When `opts?.width` is provided for a server file, loads and caches the
 *   requested resized tier via `imageCache.ts` (L1 sync hit -> L2 -> network)
 *   for both cookie and bearer transports.
 * - With `BEARER` and no `opts?.width`, image responses are also cached in
 *   L1/L2 with ref-counting; non-image files (video, audio, PDF) keep
 *   temporary per-mount blob URLs.
 */
export function useFileSrc(src: string | null | undefined, enabled = true, opts?: FileSrcOptions): string | undefined {
  const width = opts?.width;
  const priority = opts?.priority ?? 1;
  const server = Boolean(src) && isServerFile(src!);
  const tiered = server && width !== undefined;
  const viaBearer = BEARER && server && !tiered;

  const targetTier: ImageTier | null = tiered
    ? isLodDisabled() || !supportsServerResize(src!) || isSkippableImage(src!)
      ? "orig"
      : snapServerTier(width!)
    : viaBearer
      ? "orig"
      : null;

  const minWidth = targetTier === null ? undefined : targetTier === "orig" ? Infinity : targetTier;
  const reqKey = src && targetTier !== null ? `${src}|${targetTier}` : "";

  // Synchronous L1 hit on render 1 (zero flash on remount or src change)
  const syncHit = src && targetTier !== null ? peekCachedImage(src, minWidth) : null;
  const syncSatisfied =
    syncHit !== null &&
    (targetTier === "orig"
      ? syncHit.tier === "orig"
      : syncHit.tier === targetTier ||
        syncHit.tier === "orig" ||
        (typeof syncHit.tier === "number" && typeof targetTier === "number" && syncHit.tier >= targetTier));

  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);

  useEffect(() => {
    if (!src || !enabled || targetTier === null) return;

    let alive = true;
    let releasePin: (() => void) | null = null;
    let tempBlobUrl: string | null = null;
    const ctrl = new AbortController();

    const pinEntry = (key: string, url: string) => {
      releasePin?.();
      releasePin = retainCachedImage(key);
      setLoaded({ key: reqKey, url });
    };

    // Pin whatever synchronous placeholder/final L1 hit we rendered with
    const initial = peekCachedImage(src, minWidth);
    if (initial) {
      releasePin = retainCachedImage(initial.key);
      if (
        targetTier === "orig"
          ? initial.tier === "orig"
          : initial.tier === targetTier ||
            initial.tier === "orig" ||
            (typeof initial.tier === "number" && typeof targetTier === "number" && initial.tier >= targetTier)
      ) {
        return () => {
          alive = false;
          ctrl.abort();
          releasePin?.();
        };
      }
    }

    if (tiered) {
      void loadImageTier(src, targetTier, { priority, signal: ctrl.signal }).then((entry) => {
        if (!alive || !entry) return;
        pinEntry(entry.key, entry.url);
      });
    } else if (viaBearer) {
      void (async () => {
        // Check L2 first for known image endpoints (or previously cached /files/:id images)
        const exactL1 = peekExactImage(src, "orig");
        if (exactL1) {
          if (alive) pinEntry(exactL1.key, exactL1.url);
          return;
        }
        const fromL2 = await readL2Image(src, "orig");
        if (fromL2) {
          if (!alive) return;
          const entry = putCachedImage(src, "orig", {
            blob: fromL2.blob,
            bytes: fromL2.bytes,
            width: fromL2.width,
            natural: fromL2.natural,
            alpha: fromL2.alpha,
          });
          pinEntry(entry.key, entry.url);
          return;
        }
        try {
          const res = await fetchFile(src, { signal: ctrl.signal });
          if (!res.ok || !alive) return;
          const ct = (res.headers.get("content-type") ?? "").toLowerCase();
          const blob = await res.blob();
          if (!alive) return;
          const isImg = ct.startsWith("image/") || blob.type.startsWith("image/") || isKnownImageEndpoint(src);
          if (isImg && blob.size <= MAX_CACHED_BEARER_BYTES) {
            const natW = Number(res.headers.get("x-image-natural-width") || 0);
            const natH = Number(res.headers.get("x-image-natural-height") || 0);
            const alphaHdr = res.headers.get("x-image-alpha");
            const natural: [number, number] | null = natW > 0 && natH > 0 ? [natW, natH] : null;
            const alpha = alphaHdr === "1" ? true : alphaHdr === "0" ? false : null;
            const entry = putCachedImage(src, "orig", {
              blob,
              bytes: blob.size,
              width: natW,
              natural,
              alpha,
            });
            void writeL2Image(src, "orig", { blob, width: entry.width, natural, alpha });
            pinEntry(entry.key, entry.url);
          } else {
            // Non-image files (video, audio, PDF): keep existing per-mount blob URL behaviour
            tempBlobUrl = URL.createObjectURL(blob);
            setLoaded({ key: reqKey, url: tempBlobUrl });
          }
        } catch {
          /* aborted or offline */
        }
      })();
    }

    return () => {
      alive = false;
      ctrl.abort();
      releasePin?.();
      if (tempBlobUrl) URL.revokeObjectURL(tempBlobUrl);
    };
  }, [src, enabled, targetTier, tiered, viaBearer, priority, reqKey, minWidth]);

  if (!src) return undefined;
  if (!server) return src;
  if (tiered || viaBearer) {
    if (loaded && loaded.key === reqKey) return loaded.url;
    if (syncHit) return syncHit.url;
    // In cookie mode with a width hint, if we're disabled and not cached, don't start a fetch
    if (!enabled && !syncSatisfied) return undefined;
    return undefined;
  }
  return serverUrl(src);
}

/**
 * Props for a link to a server file (download, or open in a new tab). With a
 * bearer, the click fetches the file with the header and hands over a blob.
 */
export function fileLink(src: string, download?: string): { href: string; onClick?: (e: MouseEvent) => void } {
  const href = isServerFile(src) ? serverUrl(src) : src;
  if (!BEARER || !isServerFile(src)) return { href };
  return {
    href,
    onClick: (e) => {
      e.preventDefault();
      // open the tab now (a popup must come from the click), fill it when the file lands
      const tab = download ? null : window.open("", "_blank");
      void fetchFile(src)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((b) => {
          const url = URL.createObjectURL(b);
          if (tab) tab.location.href = url;
          else {
            const a = document.createElement("a");
            a.href = url;
            a.download = download ?? "";
            a.click();
          }
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        })
        .catch(() => tab?.close());
    },
  };
}

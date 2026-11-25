/**
 * ChatForm's files, on whichever server ChatForm is on (chat/server.ts).
 *
 * On Foundation's own server they are the archive's (`lib/api` `uploadFile`, `lib/fileSrc`, the progressive
 * picture). On a chat server of its own they are **that server's**: an upload goes to its `POST /api/files`, and a
 * picture, a player's source and a download are read from its `/files/<id>`, each with that server's bearer and no
 * cookie. Foundation's session is never sent there, and the chat bearer is never sent to Foundation: everything here
 * takes a server path (`/files/…`) and puts the chat server's own origin in front of it, nothing else.
 *
 * Pictures from a chat server go through the same two-tier cache as every other picture (`lib/imageCache.ts`),
 * keyed by the chat server's full address so they can't meet Foundation's `/files/<id>` of the same name: memory
 * first (a remount paints on its first frame), then the kept copy, then the network. A GIF is always asked for as
 * the file it is (never `?w=`), so it keeps its frames.
 */

import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { ApiError, uploadFile, type UploadedFile } from "../lib/api";
import { fileLink, useFileSrc } from "../lib/fileSrc";
import { peekExactImage, putCachedImage, readL2Image, retainCachedImage, scheduleImageFetch, snapServerTier, withWidthParam, writeL2Image, type CachedImageEntry, type ImageTier } from "../lib/imageCache";
import { ProgressiveImage } from "../components/ProgressiveImage";
import { CHAT_REMOTE, CHAT_SERVER, CHAT_SERVER_NAME, chatAuthHeaders, chatConfig } from "./server";
import { tooBigBefore, uploadFailure, uploadLimitOf } from "./serverLogic";

/** a path this module may ask the chat server for: one of its files, and nothing that could be another address */
const isChatFilePath = (src: string) => src.startsWith("/files/") && !src.startsWith("//");

/** read one of the chat server's files with its bearer (on Foundation's own server: the archive, as ever) */
function fetchRemote(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isChatFilePath(path)) return Promise.reject(new Error("not a chat file"));
  return fetch(`${CHAT_SERVER}${path}`, { ...init, credentials: "omit", headers: { ...chatAuthHeaders(), ...(init.headers ?? {}) } });
}

// ---------------------------------------------------------------- uploads

let limitAsked: Promise<number | null> | null = null;
/** the limit a refusal named ("at most 4 MB"): the next file over it is told before a byte goes */
let limitLearned: number | null = null;
/** the most the chat server takes in one file: what its `/auth/config` says (asked once), else what a refusal has said */
async function remoteLimit(): Promise<number | null> {
  limitAsked ??= chatConfig().then(
    (c) => uploadLimitOf(c),
    () => null,
  );
  return (await limitAsked) ?? limitLearned;
}

/** where a chat upload goes, as a person would say it */
export const CHAT_FILES_WHERE = CHAT_REMOTE ? CHAT_SERVER_NAME : "Foundation's archive";

/**
 * Put a file where ChatForm's messages can carry it: the archive (`board=chat`) on Foundation's server, the chat
 * server's own `POST /api/files?board=chat&name=` on a chat server. A file over the server's limit is refused in
 * words that say the limit.
 */
export async function chatUpload(file: File, onProgress?: (f: number) => void): Promise<UploadedFile> {
  if (!CHAT_REMOTE) {
    try {
      return await uploadFile(file, "chat", onProgress);
    } catch (e) {
      if (e instanceof ApiError && e.status === 413) throw new ApiError(413, uploadFailure(file, 413, { error: e.message }, CHAT_FILES_WHERE));
      throw e;
    }
  }
  const limit = await remoteLimit();
  const before = tooBigBefore(file, limit, CHAT_FILES_WHERE);
  if (before) throw new ApiError(413, before);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${CHAT_SERVER}/api/files?board=chat&name=${encodeURIComponent(file.name || "pasted")}`);
    // the bearer is this device's whole sign-in there: no cookie rides along
    xhr.withCredentials = false;
    for (const [k, v] of Object.entries(chatAuthHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: { file?: UploadedFile; error?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText) as { file?: UploadedFile; error?: string };
      } catch { /* not JSON: a proxy's page (a body too large for it, say) */ }
      if (xhr.status < 300 && body?.file?.id) return resolve(body.file);
      if (xhr.status === 413) limitLearned = uploadLimitOf(body) ?? limitLearned;
      reject(new ApiError(xhr.status, uploadFailure(file, xhr.status, body, CHAT_FILES_WHERE, limit)));
    };
    // a body the server (or what stands in front of it) cuts off mid-send reads as a network error: say the limit if the file is over it
    xhr.onerror = () => reject(new ApiError(0, uploadFailure(file, limit !== null && file.size > limit ? 413 : 0, null, CHAT_FILES_WHERE, limit)));
    xhr.send(file);
  });
}

// ---------------------------------------------------------------- pictures

const keyOf = (path: string) => `${CHAT_SERVER}${path}`;

function hit(path: string, tier: ImageTier): CachedImageEntry | null {
  // the file itself answers for any width
  return peekExactImage(keyOf(path), "orig") ?? (tier === "orig" ? null : peekExactImage(keyOf(path), tier));
}

/** one of the chat server's pictures at a width, through the cache: memory, then the kept copy, then the network */
async function loadRemotePicture(path: string, tier: ImageTier, signal: AbortSignal): Promise<CachedImageEntry | null> {
  const key = keyOf(path);
  const have = hit(path, tier);
  if (have) return have;
  for (const t of tier === "orig" ? (["orig"] as const) : (["orig", tier] as const)) {
    const kept = await readL2Image(key, t);
    if (kept) return putCachedImage(key, t, { blob: kept.blob, bytes: kept.bytes, width: kept.width, natural: kept.natural, alpha: kept.alpha });
  }
  if (signal.aborted) return null;
  try {
    return await scheduleImageFetch(
      key,
      tier,
      async (sig) => {
        const raced = hit(path, tier);
        if (raced) return raced;
        const res = await fetchRemote(tier === "orig" ? path : withWidthParam(path, tier), { signal: sig });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (sig.aborted) return null;
        // these headers are readable only if the chat server exposes them to another origin; without them the
        // answer is kept under the width that was asked for, so a small copy is never taken for the file itself
        const level = res.headers.get("x-image-level");
        const natW = Number(res.headers.get("x-image-natural-width") || 0);
        const natH = Number(res.headers.get("x-image-natural-height") || 0);
        const natural: [number, number] | null = natW > 0 && natH > 0 ? [natW, natH] : null;
        const as: ImageTier = tier === "orig" || level === "original" ? "orig" : level && /^\d+$/.test(level) ? snapServerTier(Number(level)) : tier;
        const entry = putCachedImage(key, as, { blob, bytes: blob.size, width: as === "orig" ? natW : as, natural, alpha: null });
        void writeL2Image(key, as, { blob, width: entry.width, natural, alpha: null });
        return entry;
      },
      { priority: 0, signal },
    );
  } catch {
    return null;
  }
}

interface ChatImageProps {
  /** a server path (`/files/<id>`), or a fixture's own address (the design page) */
  src: string;
  alt: string;
  /** the width to ask for; `"orig"` is the file itself (a GIF, the lightbox) */
  tier: 256 | 512 | "orig";
  fit?: "cover" | "contain";
  style?: CSSProperties;
}

/**
 * A picture in a message. On Foundation's own server (and for a fixture) it is the progressive picture every other
 * surface draws; from a chat server it is fetched with that server's bearer into the same cache and drawn in the
 * same well: the panel colour holds its box, the picture fades in once it has decoded, and one already in memory
 * paints on the first frame.
 */
export function ChatImage({ src, alt, tier, fit, style }: ChatImageProps) {
  if (!CHAT_REMOTE || !isChatFilePath(src)) {
    return <ProgressiveImage src={src} alt={alt} targetWidth={tier} preview={tier !== "orig"} fit={fit} style={style} draggable={false} />;
  }
  return <RemotePicture src={src} alt={alt} tier={tier} fit={fit} style={style} />;
}

function RemotePicture({ src, alt, tier, fit, style }: ChatImageProps) {
  const first = hit(src, tier);
  const [got, setGot] = useState<{ for: string; entry: CachedImageEntry | null; instant: boolean; failed?: boolean } | null>(first ? { for: `${src}|${tier}`, entry: first, instant: true } : null);
  const [shown, setShown] = useState(false);
  const want = `${src}|${tier}`;
  useEffect(() => {
    let alive = true;
    let release: (() => void) | null = null;
    const ctl = new AbortController();
    const now = hit(src, tier);
    if (now) {
      release = retainCachedImage(now.key);
      setGot({ for: want, entry: now, instant: true });
    } else {
      setShown(false);
      void loadRemotePicture(src, tier, ctl.signal).then((entry) => {
        if (!alive) return;
        if (entry) release = retainCachedImage(entry.key);
        setGot({ for: want, entry, instant: false, failed: !entry });
      });
    }
    return () => {
      alive = false;
      ctl.abort();
      release?.();
    };
  }, [src, tier, want]);
  const cur = got && got.for === want ? got : null;
  const sharp = !!cur?.entry && (cur.instant || shown);
  return (
    <span className={`f-prog ${fit ? "is-fill" : "is-natural"}${sharp ? " is-sharp" : ""}`} style={style} data-prog-phase={cur?.failed ? "error" : sharp ? "sharp" : "well"} data-chat-remote-picture>
      {cur?.entry && (
        <img
          src={cur.entry.url}
          alt={alt}
          className={`f-prog-img${fit === "cover" ? " f-prog-fit-cover" : fit === "contain" ? " f-prog-fit-contain" : ""}${cur.instant ? " is-instant" : shown ? " is-visible" : ""}`}
          draggable={false}
          decoding="async"
          onLoad={() => setShown(true)}
        />
      )}
      {cur?.failed && <span className="chat-picture-failed">This picture didn't come from {CHAT_SERVER_NAME}.</span>}
    </span>
  );
}

// ---------------------------------------------------------------- players and downloads

function useRemoteFileSrc(src: string | null | undefined, enabled = true): string | undefined {
  const [url, setUrl] = useState<{ for: string; url: string } | null>(null);
  useEffect(() => {
    if (!src || !enabled || !isChatFilePath(src)) return;
    let alive = true;
    let made: string | null = null;
    const ctl = new AbortController();
    fetchRemote(src, { signal: ctl.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setUrl({ for: src, url: made });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      ctl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [src, enabled]);
  if (!src) return undefined;
  if (!isChatFilePath(src)) return src;
  return url && url.for === src ? url.url : undefined;
}

/** what a player (video, audio) loads a chat file from; CHAT_REMOTE never changes while the page lives, so the hook is one or the other for good */
export const useChatFileSrc: (src: string | null | undefined, enabled?: boolean) => string | undefined = CHAT_REMOTE ? useRemoteFileSrc : (src, enabled = true) => useFileSrc(src, enabled);

/** props for a download link to a chat file: on a chat server the press fetches it with the bearer and hands over the file */
export function chatFileLink(src: string, download: string): { href: string; onClick?: (e: MouseEvent) => void } {
  if (!CHAT_REMOTE || !isChatFilePath(src)) return fileLink(src, download);
  return {
    // the address alone opens nothing (no session rides in it); the press below is the download
    href: `${CHAT_SERVER}${src}`,
    onClick: (e) => {
      e.preventDefault();
      void fetchRemote(src)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((b) => {
          const url = URL.createObjectURL(b);
          const a = document.createElement("a");
          a.href = url;
          a.download = download;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        })
        .catch(() => undefined);
    },
  };
}

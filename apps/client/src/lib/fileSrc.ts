/**
 * Files on the server (`/files/…`) in elements: <img>, <video>, <iframe>, a
 * link. With the cookie transport the element loads the server URL itself.
 * With the bearer transport (api.ts: the server is another site) an element
 * can't send the Authorization header, and the session never goes in a URL,
 * so the file is fetched with the header and shown from a blob: URL.
 */

import { useEffect, useState, type MouseEvent } from "react";
import { BEARER, fetchFile, serverUrl } from "./api";

// a character's pictures are the server's files too (/api/characters/:id/files/:role): with a bearer they need the header like any other
// so is the picture kept of a page card (/api/boards/:id/pages/:panel/picture)
const isServerFile = (src: string) => src.startsWith("/files/") || /^\/api\/characters\/[^/]+\/files\//.test(src) || /^\/api\/boards\/[^/]+\/pages\/[^/]+\/picture/.test(src);

/**
 * The URL an element should load `src` from. Anything that isn't a server
 * file passes through. With a bearer, a server file is fetched once
 * `enabled` (pass whether it's on screen) and is undefined until it lands.
 */
export function useFileSrc(src: string | null | undefined, enabled = true): string | undefined {
  const viaBlob = BEARER && !!src && isServerFile(src);
  const [blob, setBlob] = useState<string>();
  useEffect(() => {
    if (!viaBlob || !enabled || !src) return;
    let alive = true;
    let made: string | undefined;
    fetchFile(src)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setBlob(made);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setBlob(undefined);
    };
  }, [viaBlob, enabled, src]);
  if (!src) return undefined;
  if (viaBlob) return blob;
  return isServerFile(src) ? serverUrl(src) : src;
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

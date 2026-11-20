/**
 * The frame rules' inputs, here in the app (panels/frameSandbox.ts decides): Foundation's own origins and ports
 * (this page, the server it talks to, and in dev the server Vite proxies to), and the saved apps' origins, read
 * once from /api/apps. A frame waits for that list (`ready`), so it is never first loaded with less than it gets.
 */

import { useSyncExternalStore } from "react";
import { api, BUILT_SERVER, SERVER } from "./api";
import { foundationOrigins, type FrameContext } from "../panels/frameSandbox";

declare const __FOUNDATION_PROXY_TARGET__: string | undefined;
/** the server the dev (and preview) client proxies /api to (vite.config.ts) */
const PROXY_TARGET = typeof __FOUNDATION_PROXY_TARGET__ === "string" ? __FOUNDATION_PROXY_TARGET__ : "";

let saved: string[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load() {
  loading ??= api<{ apps: Array<{ url?: string | null }> }>("/api/apps")
    .then((r) => {
      const origins = new Set<string>();
      for (const a of r.apps) {
        try {
          if (a.url && /^https?:\/\//.test(a.url)) origins.add(new URL(a.url).origin);
        } catch {
          /* not an address */
        }
      }
      saved = [...origins];
    })
    .catch(() => {
      saved = [];
    })
    .finally(() => listeners.forEach((l) => l()));
  return loading;
}

/** read the saved apps again (after one is saved or removed) */
export function refreshSavedApps() {
  loading = null;
  return load();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  if (!loading) void load();
  return () => listeners.delete(l);
};

let last: { saved: string[] | null; ctx: FrameContext } | null = null;
function snapshot(): FrameContext & { ready: boolean } {
  if (!last || last.saved !== saved) {
    const own = foundationOrigins(window.location.origin, [SERVER, BUILT_SERVER, PROXY_TARGET]);
    last = { saved, ctx: { ...own, saved: saved ?? [] } };
  }
  return Object.assign(last.ctx, { ready: saved !== null });
}

/** the frame rules' context for this page, and whether the saved apps have been read yet */
export function useFrameContext(): FrameContext & { ready: boolean } {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

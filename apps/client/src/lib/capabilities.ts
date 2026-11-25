/**
 * What the connected Foundation server supports (`/api/capabilities`).
 *
 * A local desktop server has every local-computer feature enabled (`terminal`,
 * `browser`, `machines`, `vms`, `t3`, `vision`, `places`, `localDev`). A hosted
 * Foundation server turns those off unless `FOUNDATION_ALLOW_HOST_TOOLS=1` is
 * set, so the client shows an honest hosted-server notice instead of Start
 * buttons for host tools. Older servers without `/api/capabilities` fall back
 * to `DEFAULT_CAPABILITIES` (all local features enabled, `loaded: true`).
 */

import { useEffect, useState } from "react";
import { api } from "./api";

export type LocalFeature =
  | "terminal"
  | "browser"
  | "machines"
  | "vms"
  | "t3"
  | "vision"
  | "places"
  | "localDev";

export interface ServerCapabilities {
  loaded: boolean;
  hosted: boolean;
  allowHostTools: boolean;
  local: Record<LocalFeature, boolean>;
  chat: boolean;
  images: {
    serverLevels: boolean;
    widths: number[];
  };
}

export const DEFAULT_CAPABILITIES: ServerCapabilities = {
  loaded: false,
  hosted: false,
  allowHostTools: false,
  local: {
    terminal: true,
    browser: true,
    machines: true,
    vms: true,
    t3: true,
    vision: true,
    places: true,
    localDev: true,
  },
  chat: true,
  images: {
    serverLevels: true,
    widths: [64, 256, 512, 1024, 2048],
  },
};

let cached: ServerCapabilities | null = null;
let inFlight: Promise<ServerCapabilities> | null = null;
const listeners = new Set<(c: ServerCapabilities) => void>();

export async function fetchCapabilities(force = false): Promise<ServerCapabilities> {
  if (cached && !force) return cached;
  if (inFlight && !force) return inFlight;
  inFlight = api<Partial<ServerCapabilities>>("/api/capabilities")
    .then((raw): ServerCapabilities => ({
      loaded: true,
      hosted: Boolean(raw.hosted),
      allowHostTools: Boolean(raw.allowHostTools),
      local: {
        ...DEFAULT_CAPABILITIES.local,
        ...(raw.local ?? {}),
      },
      chat: raw.chat ?? true,
      images: {
        serverLevels: raw.images?.serverLevels ?? true,
        widths: Array.isArray(raw.images?.widths) && raw.images!.widths.length > 0 ? raw.images!.widths : DEFAULT_CAPABILITIES.images.widths,
      },
    }))
    .catch((): ServerCapabilities => ({
      ...DEFAULT_CAPABILITIES,
      loaded: true,
    }))
    .then((next) => {
      cached = next;
      inFlight = null;
      for (const fn of listeners) fn(next);
      return next;
    });
  return inFlight;
}

export function useCapabilities(): ServerCapabilities {
  const [caps, setCaps] = useState<ServerCapabilities>(() => cached ?? DEFAULT_CAPABILITIES);
  useEffect(() => {
    listeners.add(setCaps);
    void fetchCapabilities();
    return () => {
      listeners.delete(setCaps);
    };
  }, []);
  return caps;
}

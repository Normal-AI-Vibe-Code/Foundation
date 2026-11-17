/**
 * The agents that could be assigned, kept ready (2026-11-16): the server's own and this computer's,
 * with how each stands. Asked when the shell opens and again whenever something looks at it, so the
 * panel that adds an agent never opens on "looking for agents…": the list is already there.
 */

import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { AvailableAgent } from "./posted";
import type { T3Host } from "../shell/AgentsPane";

export interface Available {
  agents: AvailableAgent[];
  t3: "off" | "starting" | "running" | "error";
  /** this computer's agent host, as it last answered (its agents' sign-in state, its work) */
  host: T3Host | null;
  loaded: boolean;
}

let now: Available = { agents: [], t3: "off", host: null, loaded: false };
const subs = new Set<() => void>();
let asking: Promise<void> | null = null;

export function refreshAvailable(): Promise<void> {
  asking ??= Promise.all([api<{ agents: AvailableAgent[]; t3: Available["t3"] }>("/api/agents/available"), api<T3Host>("/api/t3host").catch(() => null)])
    .then(([a, host]) => {
      now = { agents: a.agents, t3: a.t3, host, loaded: true };
      subs.forEach((f) => f());
    })
    .catch(() => {
      if (!now.loaded) {
        now = { ...now, loaded: true };
        subs.forEach((f) => f());
      }
    })
    .finally(() => {
      asking = null;
    });
  return asking;
}

export function useAvailable(): Available {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      if (!now.loaded) void refreshAvailable();
      return () => subs.delete(f);
    },
    () => now,
  );
}

/**
 * One shared stream of connector changes from the server (FactoryForm's live
 * events, relayed), so a connector card refetches the moment its system
 * changes instead of waiting for its 20 s poll. Read with fetch, not
 * EventSource, so it carries the bearer when the server is another site.
 */

import { eventStream } from "./api";

const listeners = new Map<string, Set<() => void>>();
let started = false;

function ensure() {
  if (started) return;
  started = true;
  eventStream("/api/connectors/events", (data) => {
    try {
      const { id } = JSON.parse(data) as { id: string };
      listeners.get(id)?.forEach((fn) => fn());
    } catch {
      /* keep-alive */
    }
  });
}

export function onConnectorChange(id: string, fn: () => void) {
  ensure();
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(fn);
  return () => {
    listeners.get(id)?.delete(fn);
  };
}

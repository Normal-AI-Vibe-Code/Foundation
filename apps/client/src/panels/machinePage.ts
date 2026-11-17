/**
 * A page opened from a machine's port follows that machine. While it runs and
 * publishes the port, the page is the live frame (at whatever host port the
 * engine gave it this time); otherwise the page says what happened, in the
 * machine card's own words, instead of showing what it last loaded.
 *
 * Pure: no React, no store, so it's tested on its own (test/machine-page.test.ts).
 */

import type { MachineState, PanelDoc } from "@foundation/protocol";

/** the machine card's state pill, word for word */
export const MACHINE_STATE_WORD: Record<MachineState["state"], string> = {
  absent: "Not started",
  pulling: "Pulling",
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  error: "Error",
};

export type MachineTone = "ok" | "warn" | "bad" | "idle";

export function machineTone(state: MachineState["state"]): MachineTone {
  return state === "running" ? "ok" : state === "error" ? "bad" : state === "pulling" || state === "starting" ? "warn" : "idle";
}

/** a published port, as this computer reaches it (the engine binds 127.0.0.1 only) */
export const portUrl = (host: number) => `http://127.0.0.1:${host}`;

export type FromMachine = NonNullable<PanelDoc["fromMachine"]>;

export type MachinePage =
  | { kind: "live"; url: string }
  | {
      kind: "starting" | "stopped" | "error" | "unpublished" | "removed" | "gone";
      /** the state pill: the machine card's word and tone */
      word: string;
      tone: MachineTone;
      breathing: boolean;
      title: string;
      reason: string;
      /** a person may start it again from the page (the card's own Start; never a viewer) */
      canStart: boolean;
      /** there's a machine card to go to */
      canShow: boolean;
    };

/**
 * What a page opened from `from` shows, given the machine card it came from
 * (undefined: the card is gone from the board) and whether the viewer only watches.
 */
export function machinePage(from: FromMachine, card: Pick<PanelDoc, "panel" | "machine"> | undefined, viewer: boolean): MachinePage {
  const m = card?.panel === "machine" ? card.machine : undefined;
  if (!m) {
    return {
      kind: "gone",
      word: "Gone",
      tone: "idle",
      breathing: false,
      title: `Machine gone — ${from.name} isn't on the board any more`,
      reason: `This page was port ${from.port} of it. There's nothing left to load.`,
      canStart: false,
      canShow: false,
    };
  }
  const pill = { word: MACHINE_STATE_WORD[m.state], tone: machineTone(m.state), canShow: true };
  switch (m.state) {
    case "running": {
      const p = m.ports?.find((x) => x.port === from.port);
      if (p) return { kind: "live", url: portUrl(p.host) };
      return { kind: "unpublished", ...pill, breathing: true, title: `${m.name} is running without port ${from.port}`, reason: `It doesn't publish :${from.port} any more, so there's nothing here to show.`, canStart: false };
    }
    case "pulling":
    case "starting":
      return { kind: "starting", ...pill, breathing: true, title: `${m.name} is starting`, reason: m.detail ?? "This page reloads when it's running.", canStart: false };
    case "stopped":
      return { kind: "stopped", ...pill, breathing: false, title: `Machine stopped — ${m.name} isn't running`, reason: m.detail ?? "Its disk is kept: Start runs it again.", canStart: !viewer && Boolean(m.containerId) };
    case "error":
      return { kind: "error", ...pill, breathing: false, title: `Machine stopped — ${m.name} hit an error`, reason: m.detail ?? "The engine said no.", canStart: !viewer && Boolean(m.containerId) };
    case "absent":
      return { kind: "removed", ...pill, breathing: false, title: `Machine gone — ${m.name} was removed`, reason: m.detail ?? "Its disk went with it. Starting the card makes a fresh one.", canStart: false };
  }
}

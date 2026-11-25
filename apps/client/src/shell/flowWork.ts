/**
 * What the card at a wire's far end is doing with what arrives (2026-11-24, Josh: "give loading and generation
 * images when connections are made between nodes that are actually producing live data and processing it").
 * Only real states: the server's own word on a fed table (the board's `flows` map: working while it reads the
 * source, waiting before anything arrived, how many rows passed), a card's status (running, error), a
 * character's stage generating with its progress. Nothing here pretends.
 */

import { boardMaps, type LinkDoc } from "@foundation/protocol";
import { activeBoard } from "../sync/board";
import { getState } from "../state/store";
import { peek } from "./flowPeek";

export interface FlowWork {
  kind: "idle" | "working" | "error" | "ok" | "empty";
  /** what the chip says instead of the value's peek */
  text?: string;
  title?: string;
}

const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** `_tick` is only there so a caller re-reads when the far end's state changes (FlowChip's useFlowTick) */
export function flowWork(l: LinkDoc, value: unknown, _tick?: string): FlowWork {
  const st = getState();
  const doc = activeBoard()?.doc;
  const maps = doc ? boardMaps(doc) : null;
  const flow = maps?.flows.get(l.to.panel);
  const table = st.tables[l.to.panel];
  if (table && flow) {
    if (flow.status === "working") return { kind: "working", text: `reading ${flow.from ?? "its source"}…`, title: `The server is reading ${flow.from ?? "the source"} and will write what passes ${table.name}'s lens` };
    if (flow.status === "waiting") return { kind: "empty", text: `waiting for ${flow.from ?? "data"}`, title: "Wired, and nothing has arrived on it yet" };
    if (flow.status === "error") return { kind: "error", text: flow.error ?? "failed", title: flow.error };
    if (flow.status === "ok")
      return {
        kind: "ok",
        text: `${flow.rows ?? 0} of ${flow.total ?? 0} rows → ${table.name}`,
        title: `Written ${ago(flow.at)} from ${flow.from ?? "the source"} through ${table.name}'s lens`,
      };
  }
  const to = st.panels[l.to.panel];
  const ch = maps?.characters.get(l.to.panel);
  const stage = ch ? Object.entries(ch.stages ?? {}).find(([, s]) => s?.state === "running") : undefined;
  if (ch && stage) return { kind: "working", text: `generating ${stage[0]}${stage[1]?.progress ? ` · ${stage[1].progress}%` : "…"}`, title: `${ch.name} is generating its ${stage[0]}` };
  if (to?.status === "running") return { kind: "working", text: `${to.name} is working…` };
  if (to?.status === "error") return { kind: "error", text: `${to.name} failed` };
  if (value === undefined) {
    if (table) return { kind: "empty", text: "waiting for data", title: "Nothing has arrived on this wire yet" };
    return { kind: "idle" };
  }
  return { kind: "ok", text: peek(value) };
}

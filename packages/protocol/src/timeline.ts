/**
 * The timeline (2026-11-25): what happened on a grid, and when. Every grid has one, and every section has
 * its part of it. Two things are kept, both by the server alone (apps/server/src/timeline.ts):
 *
 *  1. **History**: the board document's changes, each with its time, from the moment keeping began. The
 *     board as it was at any moment is rebuilt from them (the same base-and-timed-changes a Replay take
 *     is: `TakeFrames`, `TakePlayer` in replay.ts).
 *  2. **Events**: one line per thing that happened, in a lane: a card added or removed, a message, a
 *     person on the grid, an agent's run, a tool call or a command behind the scenes, a voice or video
 *     note. A primitive that is added later says what happened to it with a new kind; nothing else changes.
 *
 * A **place** is where something happened: a section's id, or `GRID_PLACE` ("*") for the grid itself (the
 * same word the council's `agents` map uses). A section that hosts a grid card *is* that grid: its
 * timeline is the child grid's own (`board` there), not a filter of this one.
 *
 * The architecture, the invariants and what is not built: docs/timeline.md.
 */

import type { TakeHead } from "./replay.ts";

/** the lanes a timeline is drawn in, top to bottom */
export const TIMELINE_LANES = ["people", "agents", "behind", "changes", "chat", "notes"] as const;
export type TimelineLane = (typeof TIMELINE_LANES)[number];

export const TIMELINE_LANE_NAMES: Record<TimelineLane, string> = {
  people: "People",
  agents: "Agents",
  behind: "Behind the scenes",
  changes: "Changes",
  chat: "Chat",
  notes: "Voice and video",
};

/**
 * What an event is. `lane` is where it is drawn; `span` kinds have an end (`end: null` while they go on).
 * A new primitive adds its kinds here and nowhere else: the server stores the kind as a word, and a
 * reader that doesn't know a kind draws it in Changes with its `text`.
 */
export const TIMELINE_KINDS = {
  // what the grid holds
  "card.add": { lane: "changes", span: false },
  "card.remove": { lane: "changes", span: false },
  "card.move": { lane: "changes", span: false }, // to another section (a nudge inside one is not an event)
  "card.rename": { lane: "changes", span: false },
  "card.edit": { lane: "changes", span: false }, // its words, cells or settings; one per card and person for each stretch of work
  "section.add": { lane: "changes", span: false },
  "section.remove": { lane: "changes", span: false },
  "section.rename": { lane: "changes", span: false },
  "section.move": { lane: "changes", span: false },
  "wire.add": { lane: "changes", span: false },
  "wire.remove": { lane: "changes", span: false },
  // what was said
  "chat.message": { lane: "chat", span: false }, // in a conversation on this place (a chat card), or sent with a link to it
  "chat.ask": { lane: "chat", span: false }, // a person's ask to an agent here
  "chat.answer": { lane: "chat", span: false }, // what the agent said back
  huddle: { lane: "chat", span: true },
  // who was here
  "person.here": { lane: "people", span: true },
  // agents, in the open
  "agent.run": { lane: "agents", span: true },
  "agent.seat": { lane: "agents", span: false }, // put on, or taken off, the place's council
  // agents, behind the scenes: work with no cursor on the grid
  "agent.tool": { lane: "behind", span: false },
  "agent.code": { lane: "behind", span: false }, // a script run in the isolate (run_code)
  terminal: { lane: "behind", span: true }, // a command in a machine or terminal of the place
  prompt: { lane: "behind", span: false }, // the place's standing instructions to its agents, set or changed
  // notes left to be played back
  "note.audio": { lane: "notes", span: false },
  "note.video": { lane: "notes", span: false },
} as const satisfies Record<string, { lane: TimelineLane; span: boolean }>;

export type TimelineKind = keyof typeof TIMELINE_KINDS;

export function timelineLane(kind: string): TimelineLane {
  return (TIMELINE_KINDS as Record<string, { lane: TimelineLane }>)[kind]?.lane ?? "changes";
}

export interface TimelineActor {
  kind: "person" | "agent" | "system";
  /** a person's user id; an agent's seat or crew id when it has one */
  id?: string;
  name: string;
  color?: string;
  /** an agent's: the person it worked for */
  for?: string;
}

/** what an event points at, for the reader to open or play */
export interface TimelineRef {
  type: "chat" | "run" | "file" | "huddle" | "machine";
  id: string;
  /** chat: the conversation; machine: the card */
  within?: string;
}

/** a voice or video note's own facts (also on the card: MediaDoc.note) */
export interface MediaNoteInfo {
  fileId: string;
  mime: string;
  /** how long it runs, ms */
  ms: number;
  /** audio: its loudness, 0..1, in about 48 steps, for the drawn wave */
  peaks?: number[];
}

export interface TimelineEvent {
  id: string;
  board: string;
  /** the section it happened in (the innermost one); null: the grid itself */
  section: string | null;
  at: number;
  /** span kinds: when it ended; null while it goes on */
  end?: number | null;
  /** a TimelineKind, or a later one this reader doesn't know yet */
  kind: TimelineKind | (string & {});
  actor: TimelineActor;
  /** the card it is about, when there is one (it may be gone by now) */
  object?: string;
  /** one plain line everyone who can see the grid may read: "added a note", "ran 3 tools", "left a voice note" */
  text: string;
  ref?: TimelineRef;
  /**
   * More, by kind, only for readers who may have it:
   *  - chat.message / chat.ask / chat.answer: `{ body }` (the words)
   *  - note.audio / note.video: `{ note: MediaNoteInfo }`
   *  - agent.tool: `{ tool, ok }` · agent.code: `{ lines }` · terminal: `{ command?, exit? }`
   *  - card.*: `{ card: "note" | "table" | "media" | "map" | <panel kind>, name }`
   */
  data?: Record<string, unknown>;
  /** set when part of it is held back from this reader, saying why ("Only its members read this conversation") */
  withheld?: string;
}

/** `GET /api/boards/:id/timeline?section=&from=&to=&limit=` */
export interface TimelineSlice {
  board: string;
  /** the section asked for, or null for the whole grid */
  section: string | null;
  from: number;
  to: number;
  /** when keeping began for this grid: nothing is known before it */
  start: number;
  /** the server's clock when it answered */
  now: number;
  /** oldest first */
  events: TimelineEvent[];
  /** changes to the grid in each of `density.length` equal steps from `from` to `to` (the bar's texture) */
  density: number[];
  /** the sections these events name, as they are called now (or were, when last seen) */
  sections: Array<{ id: string; name: string; gone?: boolean }>;
  /** set when there were more events than `limit`: the newest were kept */
  more?: boolean;
}

/**
 * `GET /api/boards/:id/history?from=&to=` answers with a take's wire (replay.ts: "FRT1"): the board as it
 * was at `from` as the base, then the changes up to `to`, thinned to at most a few hundred steps however
 * long the stretch, and the cursors kept for it. Its head says when keeping began.
 */
export interface HistoryHead extends TakeHead {
  /** when keeping began for this grid */
  start: number;
  /** how many kept changes each step stands for, when the stretch was thinned */
  thinned?: number;
}

/** the longest a voice or video note may run, ms: these are short notes, not recordings */
export const MEDIA_NOTE_MAX_MS = { audio: 5 * 60_000, video: 2 * 60_000 } as const;

/**
 * Replay (ChatForm R1): a recorded session's timeline, and its **takes**, the grid's changes kept while it
 * was recorded on a grid. One take is a base (the board document as it was when keeping started) and every
 * change applied to it after, each with its time; the client rebuilds the board at any moment from them.
 *
 * The wire for a take (`GET /api/replay/takes/:id`) is one binary body, little-endian, length-prefixed:
 *
 *   "FRT1"                        4 bytes, the magic
 *   u32 n, n bytes                the head (JSON: TakeHead)
 *   u32 n, n bytes                the base (a Yjs update: Y.encodeStateAsUpdate of the board)
 *   u32 count                     the timed changes, oldest first, then each:
 *     f64 at, u32 n, n bytes        when (ms since 1970), and the change (a Yjs update; bursts merged)
 *   u32 n, n bytes                the cursors (JSON: CursorSample[]), sampled at most 5 times a second
 *
 * TakePlayer rebuilds the document at a time: it keeps a checkpoint every few changes, so scrubbing
 * backwards starts from the nearest one instead of from the base.
 */

import * as Y from "yjs";
import type { ChatMessage } from "./chat.ts";
import type { HuddleLine } from "./index.ts";

export const TAKE_MAGIC = "FRT1";

export interface TakeHead {
  id: string;
  board: string;
  section: string | null;
  from: number;
  to: number | null;
  updates: number;
  /** why keeping the grid stopped before the recording did ("Stopped keeping the grid at 45 min") */
  truncated?: string | null;
}

/** where people and agents pointed at a moment: name, colour, world x/y (a person's pointer), or the card an agent aimed at */
export interface CursorSample {
  at: number;
  who: Array<{ n: string; c?: string; x?: number; y?: number; a?: 1; t?: string }>;
}

export interface TakeFrames {
  head: TakeHead;
  base: Uint8Array;
  updates: Array<{ at: number; update: Uint8Array }>;
  cursors: CursorSample[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeTake(t: TakeFrames): Uint8Array {
  const head = enc.encode(JSON.stringify(t.head));
  const cursors = enc.encode(JSON.stringify(t.cursors));
  let size = 4 + 4 + head.length + 4 + t.base.length + 4 + 4 + cursors.length;
  for (const u of t.updates) size += 12 + u.update.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  out.set(enc.encode(TAKE_MAGIC), 0);
  o = 4;
  const bytes = (b: Uint8Array) => {
    view.setUint32(o, b.length, true);
    out.set(b, o + 4);
    o += 4 + b.length;
  };
  bytes(head);
  bytes(t.base);
  view.setUint32(o, t.updates.length, true);
  o += 4;
  for (const u of t.updates) {
    view.setFloat64(o, u.at, true);
    o += 8;
    bytes(u.update);
  }
  bytes(cursors);
  return out;
}

export function decodeTake(data: Uint8Array): TakeFrames {
  if (data.length < 8 || dec.decode(data.subarray(0, 4)) !== TAKE_MAGIC) throw new Error("not a take");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 4;
  const bytes = () => {
    const n = view.getUint32(o, true);
    const b = data.subarray(o + 4, o + 4 + n);
    if (b.length !== n) throw new Error("a take cut short");
    o += 4 + n;
    return b;
  };
  const head = JSON.parse(dec.decode(bytes())) as TakeHead;
  const base = bytes();
  const count = view.getUint32(o, true);
  o += 4;
  const updates: TakeFrames["updates"] = [];
  for (let i = 0; i < count; i++) {
    const at = view.getFloat64(o, true);
    o += 8;
    updates.push({ at, update: bytes() });
  }
  const cursors = o < data.length ? (JSON.parse(dec.decode(bytes())) as CursorSample[]) : [];
  return { head, base, updates, cursors };
}

/**
 * The board as it was at a time, rebuilt from a take. `docAt(t)` answers with a document holding the base
 * and every change at or before t; going forward it applies only what's new, going back it starts from
 * the nearest checkpoint (one every `every` changes, made once when the player is made).
 */
export class TakePlayer {
  readonly frames: TakeFrames;
  private checkpoints: Array<{ i: number; state: Uint8Array }> = [];
  private doc: Y.Doc;
  private next = 0;
  /** bumps whenever docAt hands back a different state (React's key for "redraw") */
  version = 0;

  constructor(frames: TakeFrames, every = 24) {
    this.frames = frames;
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, frames.base);
    this.checkpoints.push({ i: 0, state: Y.encodeStateAsUpdate(scratch) });
    frames.updates.forEach((u, k) => {
      Y.applyUpdate(scratch, u.update);
      if ((k + 1) % every === 0) this.checkpoints.push({ i: k + 1, state: Y.encodeStateAsUpdate(scratch) });
    });
    scratch.destroy();
    this.doc = this.fresh(0);
  }

  /** how many changes are at or before t */
  indexAt(t: number): number {
    const u = this.frames.updates;
    let lo = 0;
    let hi = u.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (u[mid].at <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private fresh(k: number): Y.Doc {
    let cp = this.checkpoints[0];
    for (const c of this.checkpoints) if (c.i <= k) cp = c;
    const d = new Y.Doc();
    Y.applyUpdate(d, cp.state);
    for (let i = cp.i; i < k; i++) Y.applyUpdate(d, this.frames.updates[i].update);
    this.next = k;
    return d;
  }

  docAt(t: number): Y.Doc {
    const k = this.indexAt(t);
    if (k === this.next) return this.doc;
    if (k > this.next && k - this.next <= 48) {
      for (let i = this.next; i < k; i++) Y.applyUpdate(this.doc, this.frames.updates[i].update);
      this.next = k;
    } else {
      this.doc.destroy();
      this.doc = this.fresh(k);
    }
    this.version++;
    return this.doc;
  }

  /** the cursors at t: the last sample at or before it, when it's at most 2 s old */
  cursorsAt(t: number): CursorSample["who"] {
    const c = this.frames.cursors;
    let lo = 0;
    let hi = c.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].at <= t) lo = mid + 1;
      else hi = mid;
    }
    const s = c[lo - 1];
    return s && t - s.at <= 2000 ? s.who : [];
  }

  destroy() {
    this.doc.destroy();
  }
}

// ---------- the timeline (GET /api/replay/:session) ----------

export interface ReplayTake {
  id: string;
  board: string;
  boardName: string;
  section: string | null;
  sectionName: string | null;
  from: number;
  to: number | null;
  updates: number;
  bytes: number;
  truncated: string | null;
}

export interface ReplayMedia {
  fileId: string;
  person: string;
  startedAt: number;
  endedAt: number;
  url: string;
  kind?: "screen";
  /** ms from the session's start to this recording's first frame */
  offset: number;
}

export interface ReplayTimeline {
  session: {
    id: string;
    huddleId: string;
    home: "chat" | "board";
    name: string;
    startedAt: number;
    endedAt: number | null;
    channel?: { id: string; name: string; kind: string };
    board?: string;
  };
  people: string[];
  agents: string[];
  lines: HuddleLine[];
  media: ReplayMedia[];
  recordings: Array<{ by: string; startedAt: number; stoppedAt: number | null }>;
  places: Array<{ board: string; boardName: string; section: string; sectionName: string | null; at: number; by: string }>;
  events: Array<{ at: number; type: string; by: string | null; board: string | null; section: string | null }>;
  /** what was posted in the channel while it went on (a channel's huddle, for people who can read it) */
  messages: Array<Pick<ChatMessage, "id" | "createdAt" | "text" | "type" | "files"> & { author: string; agent?: boolean }>;
  takes: ReplayTake[];
  /** set when the session was kept on a grid this person can't open: its grid isn't shown, and this says so */
  gridHidden?: string;
  /** the grid changes, as bursts: when, and how many changes (the scrub bar's marks) */
  changes: Array<{ take: string; at: number }>;
}

/** a recorded session's clock card on a grid (`panel: "replay"`): small at rest */
export const REPLAY_CARD = { w: 360, h: 120 } as const;

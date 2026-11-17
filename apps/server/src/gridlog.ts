/**
 * People's grid edits, in the board's activity. Agents' writes go through the
 * tool surface and sign themselves (tools.ts `touch`); a person's edits arrive
 * as Yjs updates on their sync socket, so the server reads who sent them
 * (the socket's person) and what they changed (the sections and cards maps).
 *
 * Only what someone would want to read later is logged: a section or card
 * added, removed, renamed or moved. Typing in a note, a cell, a resize, an
 * app's outputs and the server's own writes are not. And it's coalesced, so
 * a drag of sixty frames or a name typed letter by letter is one line:
 *  - a person's changes on a board gather until they pause (2.5 s; 15 s at
 *    most), then land as one line, or one line each for one or two things;
 *  - within that, add-then-remove is nothing, add-then-rename is the add
 *    with the final name, and rename-rename is one rename;
 *  - a line that repeats the one before it (the same person moving the same
 *    card again within 90 s) replaces it instead of adding another.
 * The activity array stays bounded (400, protocol `logActivity`).
 */

import { boardMaps, logActivity, type ObjectDoc, type SectionDoc } from "@foundation/protocol";
import { onBoardOpen, socketUserId, type Board } from "./boards.ts";
import { one } from "./db.ts";

function settleMs() {
  const v = Number(process.env.FOUNDATION_GRIDLOG_MS ?? "2500");
  return Number.isFinite(v) && v >= 0 ? v : 2500;
}
const MAX_GATHER_MS = 15_000;
/** a repeat of the last line within this long replaces it */
const REPEAT_MS = 90_000;

interface Rec {
  kind: "section" | "card";
  id: string;
  /** what kind of card, in words ("note", "table", "app") */
  word: string;
  name: string;
  /** the name before the first rename in this batch */
  fromName?: string;
  sectionId?: string;
  /** a card moved to another section (its id) */
  toSection?: string;
  added?: boolean;
  removed?: boolean;
  moved?: boolean;
}

interface Batch {
  board: Board;
  userId: string;
  recs: Map<string, Rec>;
  first: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const batches = new Map<string, Batch>();
/** per board: the last line this module wrote, so a repeat can replace it */
const lastLine = new Map<string, { at: number; who: string; key: string; fromName?: string }>();

const PANEL_WORD: Record<string, string> = { link: "page", file: "file", machine: "machine", agent: "agent card", connector: "connector", ask: "ask", stage: "stage", huddle: "huddle", slack: "Slack channel", app: "app" };
function cardWord(o: ObjectDoc): string {
  if (o.kind === "panel") return PANEL_WORD[o.panel] ?? "card";
  if (o.kind === "media") return "image";
  return o.kind;
}

const q = (s: string | undefined) => `“${(s || "untitled").slice(0, 60)}”`;

function batchFor(board: Board, userId: string): Batch {
  const k = `${board.id}\n${userId}`;
  let b = batches.get(k);
  if (!b || b.board !== board) {
    b = { board, userId, recs: new Map(), first: Date.now(), timer: null };
    batches.set(k, b);
  }
  return b;
}

function schedule(b: Batch) {
  if (b.timer) clearTimeout(b.timer);
  const wait = Math.max(0, Math.min(settleMs(), b.first + MAX_GATHER_MS - Date.now()));
  b.timer = setTimeout(() => flush(b), wait);
  b.timer.unref?.();
}

function noteAdd(b: Batch, r: Omit<Rec, "added">) {
  const had = b.recs.get(r.id);
  // removed earlier in this batch and back again (an undo): nothing happened
  if (had?.removed && !had.added) return void b.recs.delete(r.id);
  b.recs.set(r.id, { ...r, added: true });
}

function noteRemove(b: Batch, r: Omit<Rec, "removed">) {
  const had = b.recs.get(r.id);
  if (had?.added) return void b.recs.delete(r.id); // made and unmade in one breath
  b.recs.set(r.id, { kind: r.kind, id: r.id, word: r.word, name: had?.fromName ?? r.name, sectionId: r.sectionId, removed: true });
}

/** `base.sectionId` is where the card was before this change; `toSection` where it is now, when that differs */
function noteChange(b: Batch, base: Omit<Rec, "added" | "removed">, change: { renamedFrom?: string; toSection?: string; moved?: boolean }) {
  const rec = b.recs.get(base.id) ?? { ...base };
  if (rec.removed) return;
  rec.name = base.name;
  rec.word = base.word;
  if (rec.added) {
    // made in this batch: it's an add, wherever and whatever it ended up
    if (change.toSection) rec.sectionId = change.toSection;
  } else {
    if (change.renamedFrom !== undefined && rec.fromName === undefined) rec.fromName = change.renamedFrom;
    if (rec.fromName !== undefined && rec.fromName === rec.name) rec.fromName = undefined; // renamed back
    if (change.toSection) rec.toSection = change.toSection === rec.sectionId ? undefined : change.toSection;
    if (change.moved) rec.moved = true;
  }
  b.recs.set(base.id, rec);
}

function watch(board: Board) {
  const m = boardMaps(board.doc);
  m.sections.observe((ev) => {
    const userId = socketUserId(ev.transaction.origin);
    if (!userId) return; // the server's own writes, an agent's, a load
    const b = batchFor(board, userId);
    for (const [id, ch] of ev.changes.keys) {
      const now = m.sections.get(id);
      const was = ch.oldValue as SectionDoc | undefined;
      if (ch.action === "add" && now) noteAdd(b, { kind: "section", id, word: "section", name: now.name });
      else if (ch.action === "delete" && was) noteRemove(b, { kind: "section", id, word: "section", name: was.name });
      else if (ch.action === "update" && now && was) {
        const renamed = now.name !== was.name;
        // moved: the same span somewhere else (a resize or a split isn't a move)
        const moved = (now.c0 !== was.c0 || now.r0 !== was.r0) && now.c1 - now.c0 === was.c1 - was.c0 && now.r1 - now.r0 === was.r1 - was.r0;
        if (renamed || moved) noteChange(b, { kind: "section", id, word: "section", name: now.name }, { renamedFrom: renamed ? was.name : undefined, moved });
      }
    }
    if (b.recs.size) schedule(b);
  });
  m.objects.observe((ev) => {
    const userId = socketUserId(ev.transaction.origin);
    if (!userId) return;
    const b = batchFor(board, userId);
    for (const [id, ch] of ev.changes.keys) {
      const now = m.objects.get(id);
      const was = ch.oldValue as ObjectDoc | undefined;
      if (ch.action === "add" && now) noteAdd(b, { kind: "card", id, word: cardWord(now), name: now.name, sectionId: now.sectionId });
      else if (ch.action === "delete" && was) noteRemove(b, { kind: "card", id, word: cardWord(was), name: was.name, sectionId: was.sectionId });
      else if (ch.action === "update" && now && was) {
        const renamed = now.name !== was.name;
        const toSection = now.sectionId !== was.sectionId ? now.sectionId : undefined;
        // within its section: dragged (x, y), floated or docked, or reordered in the flow (bornAt)
        const moved = !toSection && (now.x !== was.x || now.y !== was.y || now.float !== was.float || now.bornAt !== was.bornAt);
        if (renamed || toSection || moved) noteChange(b, { kind: "card", id, word: cardWord(now), name: now.name, sectionId: was.sectionId }, { renamedFrom: renamed ? was.name : undefined, toSection, moved });
      }
    }
    if (b.recs.size) schedule(b);
  });
}

/** one rec in words, and the key that says "the same thing again" */
function describe(r: Rec, sectionName: (id?: string) => string | undefined): { text: string; key: string; objectId?: string; fromName?: string } {
  const what = r.kind === "section" ? `the section ${q(r.name)}` : `the ${r.word} ${q(r.name)}`;
  const objectId = r.kind === "card" && !r.removed ? r.id : undefined;
  const inSec = r.kind === "card" && sectionName(r.sectionId) ? ` in ${q(sectionName(r.sectionId))}` : "";
  if (r.added) return { text: r.kind === "section" ? `added a section ${q(r.name)}` : `added a ${r.word} ${q(r.name)}${inSec}`, key: `add:${r.id}`, objectId };
  if (r.removed) return { text: `removed ${what}${r.kind === "card" && sectionName(r.sectionId) ? ` from ${q(sectionName(r.sectionId))}` : ""}`, key: `remove:${r.id}` };
  const parts: string[] = [];
  if (r.fromName !== undefined) parts.push(r.kind === "section" ? `renamed the section ${q(r.fromName)} to ${q(r.name)}` : `renamed the ${r.word} ${q(r.fromName)} to ${q(r.name)}`);
  if (r.toSection) parts.push(`${parts.length ? "moved it" : `moved ${what}`} to ${q(sectionName(r.toSection))}`);
  else if (r.moved && !parts.length) parts.push(`moved ${what}${inSec}`);
  const key = r.fromName !== undefined ? `rename:${r.id}` : r.toSection ? `to:${r.id}:${r.toSection}` : `move:${r.id}`;
  return { text: parts.join(" and "), key, objectId, fromName: r.fromName };
}

/** many things at once: "added 3 cards and moved 2 in “Supply”" */
function summarize(recs: Rec[], sectionName: (id?: string) => string | undefined): string {
  const count = (pred: (r: Rec) => boolean, kind: "section" | "card") => recs.filter((r) => r.kind === kind && pred(r)).length;
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const verbs: Array<[string, (r: Rec) => boolean]> = [
    ["added", (r) => Boolean(r.added)],
    ["removed", (r) => Boolean(r.removed)],
    ["renamed", (r) => !r.added && !r.removed && r.fromName !== undefined],
    ["moved", (r) => !r.added && !r.removed && r.fromName === undefined && Boolean(r.toSection || r.moved)],
  ];
  const parts: string[] = [];
  for (const [verb, pred] of verbs) {
    const s = count(pred, "section");
    const c = count(pred, "card");
    const things = [s && n(s, "section"), c && n(c, "card")].filter(Boolean).join(" and ");
    if (things) parts.push(`${verb} ${things}`);
  }
  const secs = new Set(recs.filter((r) => r.kind === "card").map((r) => r.sectionId));
  const where = secs.size === 1 && !recs.some((r) => r.kind === "section") ? sectionName([...secs][0]) : undefined;
  const text = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return where ? `${text} in ${q(where)}` : text;
}

function flush(b: Batch) {
  const k = `${b.board.id}\n${b.userId}`;
  if (batches.get(k) === b) batches.delete(k);
  if (b.timer) clearTimeout(b.timer);
  b.timer = null;
  const recs = [...b.recs.values()].filter((r) => r.added || r.removed || r.fromName !== undefined || r.toSection || r.moved);
  if (!recs.length || b.board.doc.isDestroyed) return;
  const who = one<{ name: string }>("select name from users where id = ?", b.userId)?.name ?? "Someone";
  const doc = b.board.doc;
  const m = boardMaps(doc);
  const sectionName = (id?: string) => (id ? m.sections.get(id)?.name : undefined);
  const lines: Array<{ text: string; key: string; objectId?: string; fromName?: string }> =
    recs.length <= 2 ? recs.map((r) => describe(r, sectionName)) : [{ text: summarize(recs, sectionName), key: `many:${Date.now()}` }];
  doc.transact(() => {
    for (const line of lines) {
      if (!line.text) continue;
      const last = lastLine.get(b.board.id);
      const arr = m.activity;
      const tail = arr.length ? arr.get(arr.length - 1) : undefined;
      // the same person doing the same thing to the same card again: one line, brought up to date
      if (last && tail && tail.at === last.at && tail.who === who && last.who === who && last.key === line.key && Date.now() - last.at < REPEAT_MS) {
        arr.delete(arr.length - 1, 1);
        if (line.key.startsWith("rename:") && last.fromName !== undefined) {
          line.text = line.text.replace(/^renamed the (.+?) “[^”]*” to/, `renamed the $1 ${q(last.fromName)} to`);
          line.fromName = last.fromName;
        }
      }
      logActivity(doc, { who, role: "human", text: line.text, ...(line.objectId ? { objectId: line.objectId } : {}) });
      const at = arr.get(arr.length - 1).at;
      lastLine.set(b.board.id, { at, who, key: line.key, fromName: line.fromName });
    }
  }, "gridlog");
}

/** write every gathered batch now (tests, shutdown) */
export function flushGridLog() {
  for (const b of [...batches.values()]) flush(b);
}

let started = false;
/** start logging people's grid edits on every board as it loads */
export function startGridLog() {
  if (started) return;
  started = true;
  onBoardOpen(watch);
}

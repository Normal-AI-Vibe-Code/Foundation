/**
 * The daily digest: once a day, a note on the company board that says what
 * changed — on the board itself (who did what, people and agents; sections
 * and cards added and removed) and in the company's systems (each connector's
 * reading compared with the one the last digest saw).
 *
 * Built here, deterministically, from what the server already holds: the
 * board's activity log and Y.Doc, and the connectors. No model, nothing that
 * spends money. It says "no change" and "offline since …" plainly
 * (DESIGN §1.6, honest surfaces).
 *
 * Where: a section named "Daily digest" (made if missing), the newest note
 * first in its flow. One note per local day: asking again the same day brings
 * that day's note up to date. At most 14 notes in the section: the fifteenth
 * day reuses the oldest day's note (rewritten in place, moved to the front),
 * so the digest never deletes a card. A digest note someone moves out of the
 * section is theirs to keep; it's no longer counted or reused.
 *
 * When: a server timer writes at most one per calendar day, at or after
 * FOUNDATION_DIGEST_HOUR (local, default 7); FOUNDATION_DIGEST=0 turns it
 * off. The day written, its window and what it saw live in SQLite
 * (`digest_days`), so a restart neither repeats nor forgets. `write_digest`
 * (tools.ts) writes or updates today's note on request.
 */

import * as Y from "yjs";
import { appendSection, boardMaps, findSection, logActivity, putNote, uid, type ActivityEntry, type NoteDoc } from "@foundation/protocol";
import { editBoard, getBoard } from "./boards.ts";
import { companySnapshot, type ConnectorState } from "./connectors.ts";
import { all, one, run } from "./db.ts";

export const DIGEST_SECTION = "Daily digest";
/** how many digest notes the section keeps */
export const DIGEST_KEEP = 14;
/** who the board's activity says wrote it */
export const DIGEST_WHO = "Foundation";
/** logActivity keeps this many entries (protocol) */
const ACTIVITY_CAP = 400;

// ---------- what a digest compares ----------

/** one connector's reading, as the digest keeps it */
export interface ConnSnap {
  id: string;
  name: string;
  ok: boolean;
  /** the connector's summary; when offline, the reason */
  summary: string;
  metrics: Array<{ label: string; value: string }>;
  /** list items worth naming ("Open alerts: Station 3 low on stock") */
  items: string[];
  /** provenance badge: "prototype", "copy · 58d old" … */
  label?: string;
  /** offline: when a digest first saw it offline */
  offlineSince?: number;
}

/** the board's sections and cards, id → name */
export interface BoardSeen {
  sections: Record<string, string>;
  cards: Record<string, string>;
}

export interface Seen {
  board: BoardSeen;
  connectors: ConnSnap[];
}

export interface DigestFacts {
  now: Date;
  /** the window's start: the last digest, or 24 hours ago for the first */
  since: Date;
  /** what the last digest saw; null for the first digest on a board */
  before: Seen | null;
  board: BoardSeen;
  /** the board's activity in the window, the digest's own lines left out */
  activity: Array<Pick<ActivityEntry, "at" | "who" | "role" | "text">>;
  /** the log is bounded and had already dropped part of the window */
  activityClipped: boolean;
  connectors: ConnSnap[];
}

// ---------- dates (local, without Intl, so the output never depends on a locale) ----------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Fri 7 Nov" */
export function dayLabel(d: Date) {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
/** "Fri 7 Nov 07:00" */
function when(d: Date | number) {
  const t = typeof d === "number" ? new Date(d) : d;
  return `${dayLabel(t)} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
/** the local calendar day, "2026-11-07" */
export function dayKey(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function digestTitle(d: Date) {
  return `What changed · ${dayLabel(d)}`;
}

// ---------- the markdown ----------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** "a, b, c and 2 more" */
function names(xs: string[], max = 5) {
  const shown = xs.slice(0, max).map((x) => clip(x || "untitled", 40));
  return xs.length > max ? `${shown.join(", ")} and ${xs.length - max} more` : shown.join(", ");
}
function listOf(parts: string[]) {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function boardLines(f: DigestFacts): string[] {
  const out: string[] = [];
  const acts = f.activity;
  if (acts.length) {
    // one row per name, most active first; a name is a person, an agent or a service by most of its lines
    const byWho = new Map<string, { n: number; roles: Record<string, number>; texts: string[] }>();
    for (const a of acts) {
      const w = byWho.get(a.who) ?? { n: 0, roles: {}, texts: [] };
      w.n++;
      w.roles[a.role] = (w.roles[a.role] ?? 0) + 1;
      w.texts.push(a.text);
      byWho.set(a.who, w);
    }
    const roleOf = (r: Record<string, number>) => (Object.entries(r).sort((a, b) => b[1] - a[1])[0][0] as ActivityEntry["role"]);
    const rows = [...byWho.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
    const count = (role: string) => rows.filter(([, w]) => roleOf(w.roles) === role).length;
    const who = [
      count("human") && plural(count("human"), "person", "people"),
      count("agent") && plural(count("agent"), "agent"),
      count("system") && plural(count("system"), "service"),
    ].filter(Boolean) as string[];
    out.push(`- ${plural(acts.length, "action")} by ${listOf(who)}`);
    for (const [name, w] of rows.slice(0, 5)) {
      const role = roleOf(w.roles);
      // the most recent two things they did, newest first
      const latest = [...new Set([...w.texts].reverse())].slice(0, 2).map((t) => clip(t, 70));
      out.push(`- **${name}**${role === "agent" ? " (agent)" : role === "system" ? " (service)" : ""} · ${w.n}: ${latest.join("; ")}`);
    }
    if (rows.length > 5) out.push(`- and ${plural(rows.length - 5, "other")}`);
  }
  if (f.activityClipped) out.push(`- The board keeps its last ${ACTIVITY_CAP} actions, so earlier ones in this window aren't counted`);
  if (!f.before) {
    out.push(
      `- ${plural(Object.keys(f.board.sections).length, "section")} and ${plural(Object.keys(f.board.cards).length, "card")} on the board; this is the first digest here, so there's nothing to compare them with yet`,
    );
    return out;
  }
  const b = f.before.board;
  const added = (now: Record<string, string>, was: Record<string, string>) => Object.keys(now).filter((id) => !(id in was)).map((id) => now[id]);
  const gone = (now: Record<string, string>, was: Record<string, string>) => Object.keys(was).filter((id) => !(id in now)).length;
  const secAdded = added(f.board.sections, b.sections);
  const cardAdded = added(f.board.cards, b.cards);
  const secGone = gone(f.board.sections, b.sections);
  const cardGone = gone(f.board.cards, b.cards);
  if (secAdded.length) out.push(`- Sections added (${secAdded.length}): ${names(secAdded)}`);
  if (secGone) out.push(`- Sections removed: ${secGone}`);
  if (cardAdded.length) out.push(`- Cards added (${cardAdded.length}): ${names(cardAdded)}`);
  if (cardGone) out.push(`- Cards removed: ${cardGone}`);
  if (!out.length) out.push("- No change.");
  return out;
}

function connectorLines(now: ConnSnap, before: ConnSnap | null, since: Date): string[] {
  if (!now.ok) {
    if (!before) return [`- Offline: ${now.summary}`];
    if (before.ok) return [`- Offline: ${now.summary}. It was live at the last digest (${when(since)})`];
    return [`- Offline since at least ${when(now.offlineSince ?? since)}: ${now.summary}`];
  }
  if (!before) return [`- Live: ${now.summary}`];
  if (!before.ok) return [`- Back online (it was offline at the last digest): ${now.summary}`];
  const out: string[] = [];
  const was = new Map(before.metrics.map((m) => [m.label, m.value]));
  const moved = now.metrics.filter((m) => was.has(m.label) && was.get(m.label) !== m.value);
  for (const m of moved.slice(0, 4)) out.push(`- ${m.label}: ${was.get(m.label)} → ${m.value}`);
  if (moved.length > 4) out.push(`- and ${plural(moved.length - 4, "more number")} changed`);
  const fresh = now.items.filter((i) => !before.items.includes(i));
  const cleared = before.items.filter((i) => !now.items.includes(i));
  const item = (i: string) => {
    const at = i.indexOf(": ");
    return at > 0 ? `${i.slice(at + 2)} (${i.slice(0, at)})` : i;
  };
  for (const i of fresh.slice(0, 3)) out.push(`- New: ${clip(item(i), 90)}`);
  if (fresh.length > 3) out.push(`- and ${fresh.length - 3} more new`);
  for (const i of cleared.slice(0, 3)) out.push(`- Gone: ${clip(item(i), 90)}`);
  if (cleared.length > 3) out.push(`- and ${cleared.length - 3} more gone`);
  if (!out.length && now.summary !== before.summary) out.push(`- Now: ${now.summary}`);
  if (!out.length) out.push("- No change.");
  return out;
}

/** The digest's markdown, from facts alone (pure: the same facts give the same note). */
export function renderDigest(f: DigestFacts): string {
  const lines: string[] = [`# ${digestTitle(f.now)}`, ""];
  lines.push(f.before ? `*Since ${when(f.since)}, the last digest.*` : "*The first digest on this board: the last 24 hours.*", "");
  lines.push("## On the board", ...boardLines(f), "");
  const was = new Map((f.before?.connectors ?? []).map((c) => [c.id, c]));
  for (const c of f.connectors) {
    lines.push(`## ${c.name}${c.label ? ` · ${c.label}` : ""}`, ...connectorLines(c, was.get(c.id) ?? null, f.since), "");
  }
  lines.push(`*Written by ${DIGEST_WHO} at ${pad(f.now.getHours())}:${pad(f.now.getMinutes())} from the board's activity and each company system's own reading. No model wrote it.*`);
  return lines.join("\n");
}

// ---------- reading the board and the connectors ----------

/** `offlineSince`: when an earlier reading first found it offline, if it still was then */
export function snapOf(s: ConnectorState, offlineSince: number | undefined, at: number): ConnSnap {
  const snap: ConnSnap = {
    id: s.id,
    name: s.name,
    ok: s.ok,
    summary: s.ok ? s.summary : s.summary.replace(/^offline\s*[—–-]\s*/i, ""),
    metrics: s.metrics.map((m) => ({ label: m.label, value: String(m.value) })),
    items: (s.lists ?? []).flatMap((l) => l.items.map((i) => `${l.title}: ${i.text}`)),
  };
  if (s.provenanceLabel) snap.label = s.provenanceLabel;
  if (!s.ok) snap.offlineSince = offlineSince ?? at;
  return snap;
}

/** a digest's own activity lines don't count as something that changed */
const isOwn = (a: ActivityEntry) => a.who === DIGEST_WHO && a.role === "system" && /daily digest/.test(a.text);

function seeBoard(doc: Y.Doc, digestNotes: Set<string>): BoardSeen {
  const m = boardMaps(doc);
  const sections: Record<string, string> = {};
  const cards: Record<string, string> = {};
  for (const s of m.sections.values()) if (s.name.trim().toLowerCase() !== DIGEST_SECTION.toLowerCase()) sections[s.id] = s.name;
  for (const o of m.objects.values()) if (!digestNotes.has(o.id)) cards[o.id] = o.name || o.kind;
  return { sections, cards };
}

export type ConnectorReader = () => Promise<ConnectorState[]>;
const readCompany: ConnectorReader = async () => (await companySnapshot(true)).connectors.map((c) => c.state);

interface DayRow {
  board_id: string;
  day: string;
  note_id: string | null;
  since: number;
  written_at: number;
  base_json: string | null;
  seen_json: string | null;
}

export interface DigestResult {
  id: string;
  day: string;
  title: string;
  /** "added": a new note; "reused": the oldest kept note became today's; "updated": today's note again */
  did: "added" | "reused" | "updated";
  markdown: string;
}

/** the last digest written on a board, if any */
export function lastDigest(boardId: string) {
  return one<{ day: string; written_at: number }>("select day, written_at from digest_days where board_id = ? order by day desc limit 1", boardId) ?? null;
}

/**
 * Write (or bring up to date) today's digest note on a board. `onlyIfNone`:
 * the timer's call, which does nothing when today's is already written.
 */
export async function writeDigest(
  boardId: string,
  opts: { now?: Date; read?: ConnectorReader; by?: string; onlyIfNone?: boolean } = {},
): Promise<DigestResult | null> {
  // the one wait (connectors can take seconds); everything after it is synchronous, so two calls can't interleave
  const states = await (opts.read ?? readCompany)();
  const now = opts.now ?? new Date();
  const at = now.getTime();
  const day = dayKey(now);
  const rows = all<DayRow>("select * from digest_days where board_id = ? order by day desc", boardId);
  const today = rows.find((r) => r.day === day) ?? null;
  if (today && opts.onlyIfNone) return null;
  const prev = rows.find((r) => r.day < day) ?? null;

  const before: Seen | null = today ? (today.base_json ? (JSON.parse(today.base_json) as Seen) : null) : prev?.seen_json ? (JSON.parse(prev.seen_json) as Seen) : null;
  const since = today ? today.since : before && prev ? prev.written_at : at - 864e5;
  const digestNotes = new Set(rows.map((r) => r.note_id).filter((x): x is string => Boolean(x)));

  const doc = getBoard(boardId).doc;
  const log = boardMaps(doc).activity.toArray();
  const activity = log.filter((a) => a.at >= since && a.at <= at && !isOwn(a));
  const activityClipped = log.length >= ACTIVITY_CAP && log[0].at > since;
  // offline since: the earliest reading that found it offline and every reading since did too
  const earlier = today?.seen_json ? (JSON.parse(today.seen_json) as Seen).connectors : [];
  const offlineFrom = (id: string) => {
    const base = before?.connectors.find((c) => c.id === id);
    if (base && !base.ok) return base.offlineSince;
    const sooner = earlier.find((c) => c.id === id);
    return sooner && !sooner.ok ? sooner.offlineSince : undefined;
  };
  const connectors = states.map((s) => snapOf(s, offlineFrom(s.id), at));

  // the note this day will be: today's again, a new one, or (at the cap) the oldest kept one, reused
  let noteId: string;
  let did: DigestResult["did"];
  let reusedDay: string | null = null;
  const m = boardMaps(doc);
  const sec0 = findSection(doc, DIGEST_SECTION);
  const todays = today?.note_id ? m.objects.get(today.note_id) : undefined;
  if (todays?.kind === "note") {
    noteId = todays.id;
    did = "updated";
  } else {
    const kept = rows.filter((r) => r.day !== day && r.note_id && sec0 && m.objects.get(r.note_id)?.kind === "note" && m.objects.get(r.note_id)?.sectionId === sec0.id);
    if (kept.length >= DIGEST_KEEP) {
      const oldest = kept[kept.length - 1];
      noteId = oldest.note_id!;
      reusedDay = oldest.day;
      digestNotes.add(noteId);
      did = "reused";
    } else {
      noteId = uid("note");
      digestNotes.add(noteId);
      did = "added";
    }
  }

  const board = seeBoard(doc, digestNotes);
  const markdown = renderDigest({ now, since: new Date(since), before, board, activity, activityClipped, connectors });
  const title = digestTitle(now);

  editBoard(boardId, "digest", (d) => {
    const maps = boardMaps(d);
    const sec = findSection(d, DIGEST_SECTION) ?? appendSection(d, DIGEST_SECTION);
    if (sec.host) {
      // a hosted app fills its section and would cover the notes: it becomes a card in the flow
      const { host: _host, ...rest } = sec;
      maps.sections.set(sec.id, rest);
    }
    const existing = maps.objects.get(noteId);
    let note: NoteDoc;
    if (did === "updated" && existing?.kind === "note") {
      // today's note again: where people put it, at the size they made it
      note = { ...existing, name: title };
    } else {
      // newest first: the flow runs by bornAt, so this note goes before every card in the section
      const docked = [...maps.objects.values()].filter((o) => o.sectionId === sec.id && o.id !== noteId && !o.float);
      const bornAt = docked.length ? Math.min(...docked.map((o) => o.bornAt)) - 1 : at;
      note = { id: noteId, kind: "note", sectionId: sec.id, name: title, x: 0, y: 0, float: false, bornAt, w: 460, h: noteHeight(markdown) };
    }
    delete note.createdBy; // createdBy names crew agents; this is Foundation's own
    putNote(d, { ...note, text: markdown });
    logActivity(d, {
      who: DIGEST_WHO,
      role: "system",
      text: `${did === "updated" ? "updated" : "wrote"} the daily digest for ${dayLabel(now)}${opts.by ? ` (asked by ${opts.by})` : ""}`,
      objectId: noteId,
    });
  });

  const seen = JSON.stringify({ board, connectors } satisfies Seen);
  if (today) run("update digest_days set note_id = ?, written_at = ?, seen_json = ? where board_id = ? and day = ?", noteId, at, seen, boardId, day);
  else run("insert into digest_days (board_id, day, note_id, since, written_at, base_json, seen_json) values (?, ?, ?, ?, ?, ?, ?)", boardId, day, noteId, since, at, before ? JSON.stringify(before) : null, seen);
  if (reusedDay) run("update digest_days set note_id = null where board_id = ? and day = ?", boardId, reusedDay);
  // only today's row is read again (its baseline for a rerun, what it saw for tomorrow)
  run("update digest_days set base_json = null, seen_json = null where board_id = ? and day < ?", boardId, day);
  return { id: noteId, day, title, did, markdown };
}

/** tall enough for its lines at rest, within reason (the section fits its cards anyway) */
function noteHeight(md: string) {
  return Math.max(280, Math.min(900, 96 + md.split("\n").length * 22));
}

// ---------- the timer ----------

export const digestEnabled = () => process.env.FOUNDATION_DIGEST !== "0";
export function digestHour() {
  const h = Number(process.env.FOUNDATION_DIGEST_HOUR ?? 7);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 7;
}

let inFlight = false;

/**
 * One check of the clock: on the company board, today's digest once it's past
 * the hour and none is written yet. Returns what it wrote, or null.
 */
export async function digestTick(now = new Date(), read?: ConnectorReader, boardId = "company"): Promise<DigestResult | null> {
  if (!digestEnabled() || inFlight) return null;
  if (now.getHours() < digestHour()) return null;
  if (lastDigest(boardId)?.day === dayKey(now)) return null;
  inFlight = true;
  try {
    return await writeDigest(boardId, { now, read, onlyIfNone: true });
  } finally {
    inFlight = false;
  }
}

/** Start the daily timer (index.ts). Returns its stop; does nothing when FOUNDATION_DIGEST=0. */
export function startDigest(): () => void {
  if (!digestEnabled()) {
    console.log("daily digest: off (FOUNDATION_DIGEST=0)");
    return () => {};
  }
  const tick = () =>
    void digestTick().then(
      (r) => r && console.log(`daily digest: wrote ${r.title}`),
      (e) => console.error("daily digest:", (e as Error).message),
    );
  const first = setTimeout(tick, 5000);
  const every = setInterval(tick, 60_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

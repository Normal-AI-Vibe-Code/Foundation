/**
 * Voice and video notes as an agent reads them (2026-11-25; docs/timeline.md §4). A note is a `media` card
 * with `note`: read_board names it for what it is, with who, when, how long and its file, and read_card
 * gives the same facts. Agents can play nothing and record nothing: there is no write tool for notes.
 */

import type { MediaDoc, ObjectDoc } from "@foundation/protocol";

/** 0:42 */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * Who left a note: `leftBy` is the timeline's word for it (timeline.ts noteLeftBy: the person whose session added
 * the card). The card's own `note.byName` is what any editor's window wrote, so without the timeline's word it is
 * said as a claim ("says it is by …"), never as a fact.
 */
function byWords(n: NonNullable<MediaDoc["note"]>, leftBy: string | null | undefined): string {
  if (leftBy) return `by ${leftBy}`;
  const claimed = typeof n.byName === "string" && n.byName.trim() ? n.byName.trim().slice(0, 80) : "";
  return claimed ? `says it is by ${claimed}` : "by someone";
}

const safeMs = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const safeAt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 8.64e15 ? v : 0);

/** `voice note by Josh Leong, 0:42, left 2026-11-25 14:32 UTC, file f_…` — or null for a picture or a video */
export function describeMedia(o: MediaDoc, leftBy?: string | null): string | null {
  const n = o.note;
  if (n && typeof n === "object") {
    const what = o.media === "audio" ? "voice note" : "video note";
    return `${what} "${o.name}" ${byWords(n, leftBy)}, ${clockOf(safeMs(n.ms))} long, left ${when(safeAt(n.at))}, file ${n.fileId}`;
  }
  if (o.media === "audio") {
    const file = /^\/files\/([^/?#]+)/.exec(o.src)?.[1];
    return `sound "${o.name}"${file ? `, file ${file}` : ""}`;
  }
  return null;
}

/** read_board's outline, with each note's line saying what it is (describeBoard names every media card "media") */
export function withMediaNotes(outline: string, objects: Iterable<ObjectDoc>, leftBy: (cardId: string) => string | null = () => null): string {
  let out = outline;
  for (const o of objects) {
    if (o.kind !== "media") continue;
    const said = describeMedia(o, o.note ? leftBy(o.id) : null);
    if (!said) continue;
    out = out.replace(`- media "${o.name}" (${o.id})`, `- ${said} (${o.id})`);
  }
  return out;
}

/** read_card's answer for a media card: its fields, and for a note what it is in words */
export function readMediaCard(o: MediaDoc, leftBy: string | null = null): Record<string, unknown> {
  const said = describeMedia(o, leftBy);
  if (!said || !o.note || typeof o.note !== "object") return { ...o, ...(said ? { is: said } : {}) };
  const n = o.note;
  return {
    ...o,
    kind: o.media === "audio" ? "voice note" : "video note",
    is: said,
    // who left it, as Foundation saw it; the card's own claim only beside it, marked as one
    by: leftBy ?? null,
    ...(leftBy ? {} : { says_by: n.byName ?? null }),
    at: new Date(safeAt(n.at)).toISOString(),
    duration: clockOf(safeMs(n.ms)),
    file: n.fileId,
    mime: n.mime,
    // the wave is for drawing; an agent needs none of it
    note: { ...n, peaks: undefined },
  };
}

/** a note card going to another board: its file there is a new record of the same bytes, and `note` says so */
export function moveNoteFile<T extends { kind: string; note?: MediaDoc["note"] }>(card: T, from: string, to: string): T {
  if (card.kind !== "media" || !card.note || card.note.fileId !== from) return card;
  return { ...card, note: { ...card.note, fileId: to } };
}

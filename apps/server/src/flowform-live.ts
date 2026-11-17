/**
 * Flowform rooms, live: read through a person's Flowform link (flowformlink.ts,
 * read-only MCP) and kept as Foundation boards.
 *
 * The backup importer (flowform-import.ts) reads Flowform's daily backup with
 * Foundation stopped. This reads the live server as one person, with Foundation
 * running, and is safe to repeat: it uses the importer's board ids (`ff-<room>`),
 * card ids (`ff_<card>`) and ledger (`flowform_imports`), so the two converge on
 * one board rather than making two. The ledger's rules hold here too:
 *   - a card edited in Foundation since it came over is left as it is (Foundation's copy wins);
 *   - a card someone removed here stays removed;
 *   - nothing is ever deleted: a card gone from Flowform stays on the board.
 *
 * File bytes: the link can't carry them (Flowform's tools return a card's file id,
 * revision and size but never a URL). When the person bringing the room in has
 * allowed downloads (their Flowform session, kept encrypted: flowformfiles.ts),
 * each image, video and file is fetched into the archive in the background, and
 * the room is read again so its cards become the real thing. Until then, or
 * without it, they arrive as a note naming the file; a card that already holds
 * the real file is never swapped for one.
 *
 * Kept connected: a pulled room remembers who pulled it, and is read again every
 * few minutes while their link holds (`startFlowformSync`), and whenever someone presses Pull.
 */

import { createHash } from "node:crypto";
import { BOARD_SCHEMA, DEFAULT_COL_W, DEFAULT_ROW_H, boardMaps, logActivity, noteTextOf, readTracks, setNoteText, tableCellMap, tableCellsOf, type MediaDoc, type NoteDoc, type ObjectDoc, type PanelDoc, type SearchHit, type SectionDoc, type TableDoc } from "@foundation/protocol";
import { all, db, one, run } from "./db.ts";
import { editBoard, ensureBoardRow } from "./boards.ts";
import { boardRole, setMember, type BoardRole } from "./members.ts";
import { HttpError } from "./http.ts";
import { boardIdFor } from "./flowform-import.ts";
import { flowformCall, linkStatus } from "./flowformlink.ts";
import { canDownload, fileBytes } from "./flowformfiles.ts";
import { storeImportedFile } from "./files.ts";

const ORIGIN = "flowform-live";
const PAD = 160;
/** how often a pulled room is read again */
export const SYNC_MS = 5 * 60_000;

db.exec(`
  create table if not exists flowform_live (
    room_id text primary key, board_id text not null, name text not null,
    pulled_by text not null, pulled_at integer not null, cards integer not null default 0, error text
  );
`);

// ---------- reading Flowform as a person ----------

/** call a Flowform tool and take its JSON answer (structured, else the text) */
async function ask<T>(userId: string, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await flowformCall(userId, tool, args)) as { isError?: boolean; text?: string; structured?: unknown };
  if (r.isError) throw new HttpError(502, `Flowform's ${tool}: ${(r.text ?? "failed").slice(0, 300)}`);
  if (r.structured && typeof r.structured === "object") return r.structured as T;
  try {
    return JSON.parse(r.text ?? "") as T;
  } catch {
    throw new HttpError(502, `Flowform's ${tool} answered something that isn't JSON`);
  }
}

export interface FfRoom {
  room_id: string;
  name: string;
  role: string;
  asset_count: number;
}

export const listRooms = async (userId: string) => (await ask<{ rooms: FfRoom[] }>(userId, "list_rooms")).rooms ?? [];

interface Target {
  kind: "plane" | "grid_canvas";
  board_id: string;
  grid_id?: string;
  canvas_id?: string;
}
interface Surface {
  /** the canvas its cards are stored on: the key the importer's sections use */
  canvas: string;
  name: string;
  target: Target;
}
interface FfCard {
  id: string;
  kind: string;
  name?: string | null;
  rect?: { x: number; y: number; w: number; h: number };
  stack_order?: number;
  structural?: boolean;
  text?: string;
  text_readable?: boolean;
  items?: Array<{ text?: string; done?: boolean; checked?: boolean; due?: string | null }>;
  table?: { rows?: string[][]; columns?: Array<string | null> };
  url?: string;
  media?: { file_id?: string | null; revision_id?: string | null; byte_size?: number | null } | null;
  /** a file card's file is here, not under media (whose fields Flowform leaves null for it) */
  file_id?: string | null;
  revision_id?: string | null;
  autoplay?: boolean;
  mute?: boolean;
}

/** every surface in a room: each board's plane, and every page of every Grid on it */
async function surfaces(userId: string, roomId: string): Promise<Surface[]> {
  const cat = await ask<{
    layout: string;
    planes?: Array<{
      board_id: string;
      name: string | null;
      plane_canvas_id: string;
      surface: Target;
      grids?: Array<{ name: string | null; pages: Array<{ canvas_id: string; coordinate: string; name: string | null; surface: Target }> }>;
    }>;
  }>(userId, "room_catalog_v2", { room_id: roomId });
  if (cat.layout !== "plane") throw new HttpError(409, "This room is still on Flowform's older grid layout, which the link can't read yet");
  const out: Surface[] = [];
  for (const p of cat.planes ?? []) {
    out.push({ canvas: p.plane_canvas_id, name: p.name ?? "", target: p.surface });
    for (const g of p.grids ?? []) {
      for (const pg of g.pages) {
        out.push({ canvas: pg.canvas_id, name: [g.name, pg.name ?? pg.coordinate].filter(Boolean).join(" · "), target: pg.surface });
      }
    }
  }
  return out;
}

async function cardsOn(userId: string, roomId: string, s: Surface): Promise<FfCard[]> {
  const r = await ask<{ primitives?: FfCard[]; truncated?: boolean }>(userId, "read_surface_v2", { room_id: roomId, target: s.target, limit: 1000 });
  return (r.primitives ?? []).filter((c) => !c.structural && c.rect);
}

// ---------- the mapping ----------

/** the Flowform file a card shows: images and videos carry it under `media`, a file card at its top level */
export function fileRef(c: FfCard): { file_id: string; revision_id: string } | null {
  const file_id = c.media?.file_id ?? c.file_id;
  const revision_id = c.media?.revision_id ?? c.revision_id;
  return file_id && revision_id ? { file_id, revision_id } : null;
}

const stable = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
const digest = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex").slice(0, 32);
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

const sizeWords = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** what one Flowform card becomes (null: nothing to draw) */
/** a Flowform file that's in the archive: the card shows it */
export interface HereFile {
  id: string;
  mime: string;
  name: string;
}

export function mapCard(c: FfCard, base: { id: string; sectionId: string; x: number; y: number }, file?: HereFile | null): { doc: ObjectDoc; text?: string; cells?: Record<string, string>; stand_in?: boolean } | null {
  const w = Math.round(c.rect!.w);
  const h = Math.round(c.rect!.h);
  const b = { ...base, name: c.name ?? "", float: true, bornAt: 0 };
  const note = (text: string, stand_in = false) => ({ doc: { ...b, kind: "note", w, h } satisfies NoteDoc as ObjectDoc, text, stand_in });
  switch (c.kind) {
    case "text":
      return c.text_readable === false ? note(`**${c.name || "Text"}** is in Flowform; its text couldn't be read through the link.`, true) : note(c.text ?? "");
    case "todo":
      return note((c.items ?? []).map((it) => `- [${it.done || it.checked ? "x" : " "}] ${it.text ?? ""}${it.due ? ` (due ${it.due})` : ""}`).join("\n"));
    case "table": {
      const rows = c.table?.rows ?? [];
      const labels = (c.table?.columns ?? []).map((l) => l ?? "");
      const header = labels.some(Boolean);
      const all = header ? [labels, ...rows] : rows;
      const cells: Record<string, string> = {};
      all.forEach((row, r) => row.forEach((t, col) => t && (cells[`${col},${r}`] = t)));
      const cols = Math.max(1, ...all.map((r) => r.length));
      return { doc: { ...b, kind: "table", cols, rows: Math.max(1, all.length) } satisfies TableDoc, cells };
    }
    case "iframe":
    case "link_card":
      if (!c.url) return null;
      return { doc: { ...b, kind: "panel", panel: c.kind === "iframe" ? "app" : "link", w, h, url: c.url, name: b.name || c.url, ports: [] } satisfies PanelDoc };
    case "image":
    case "video":
    case "video_note":
    case "file_reference":
    case "model_3d":
    case "model_3d_v2": {
      if (file) {
        const video = c.kind === "video" || c.kind === "video_note" || file.mime.startsWith("video/");
        if (video || file.mime.startsWith("image/"))
          return { doc: { ...b, kind: "media", w, h, src: `/files/${file.id}`, media: video ? "video" : "image", autoplay: c.autoplay === true, muted: c.mute !== false } satisfies MediaDoc };
        return { doc: { ...b, kind: "panel", panel: "file", w, h, fileId: file.id, mime: file.mime, name: b.name || file.name, ports: [] } satisfies PanelDoc };
      }
      const what = { image: "image", video: "video", video_note: "video note", file_reference: "file", model_3d: "3D model", model_3d_v2: "3D model" }[c.kind];
      const size = c.media?.byte_size ? `, ${sizeWords(c.media.byte_size)}` : "";
      const an = `${/^[aeiou]/i.test(what) ? "An" : "A"} ${what}`;
      // a card Flowform names no file for (its video notes) can't be fetched however downloads stand
      if (!fileRef(c)) return note(`**${c.name || an}**\n\n${an} in Flowform. Flowform doesn't give its file to other apps, so it shows here by name.`, true);
      return note(`**${c.name || an}**\n\n${an} in Flowform${size}. Its file isn't here yet: it comes in once you allow Flowform file downloads (Settings → Services).`, true);
    }
    case "grid":
      return note(`**${c.name || "Table"}** is a Flowform table Foundation can't read through the link yet.`, true);
    default:
      return null;
  }
}

// ---------- files ----------

/** the archive id a room's Flowform file gets: the importer's (`ff_` + digest of room and `file:<id>`), so the two share it */
export const fileIdFor = (roomId: string, ffFileId: string) => `ff_${digest([roomId, `file:${ffFileId}`])}`;

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "application/pdf": ".pdf", "application/step": ".step", "model/step": ".step", "model/stl": ".stl", "model/gltf-binary": ".glb", "text/csv": ".csv", "text/plain": ".txt" };
const hereFile = (id: string) => one<HereFile>("select id, mime, name from files where id = ?", id) ?? null;
/** files Flowform didn't give (gone, refused, too big): not asked for again until the server restarts */
const notThere = new Set<string>();

/** bring one Flowform file into the archive as this person; null if Flowform won't give it */
export async function bringFlowformFile(userId: string, boardId: string | null, roomId: string, f: { file_id: string; revision_id: string; name?: string | null }): Promise<HereFile | null> {
  const id = fileIdFor(roomId, f.file_id);
  const here = hereFile(id);
  if (here) return here;
  const got = await fileBytes(userId, f.file_id, f.revision_id);
  if (!got) return null;
  const base = (f.name || got.name || `Flowform file ${f.file_id.slice(0, 8)}`).replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
  const name = /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + (EXT[got.mime] ?? "");
  await storeImportedFile({ id, boardId, name, mime: got.mime, body: got.body, uploadedBy: userId, createdAt: Date.now(), archivedAt: null });
  return hereFile(id);
}

/** fetch a room's missing files one at a time; true if any arrived (so the room is read again) */
async function fetchMissing(userId: string, roomId: string, boardId: string, cards: FfCard[]): Promise<boolean> {
  let arrived = false;
  for (const c of cards) {
    const m = fileRef(c);
    if (!m) continue;
    const id = fileIdFor(roomId, m.file_id);
    if (hereFile(id) || notThere.has(id)) continue;
    try {
      if (await bringFlowformFile(userId, boardId, roomId, { file_id: m.file_id, revision_id: m.revision_id, name: c.name })) arrived = true;
      else notThere.add(id);
    } catch (e) {
      // the session ended, or Flowform is away: stop here, the next read tries again
      if (e instanceof HttpError && (e.status === 409 || e.status === 502)) break;
      notThere.add(id);
    }
  }
  return arrived;
}

// ---------- the ledger (the importer's) ----------

interface LedgerRow {
  foundation_id: string;
  source_hash: string;
  written_hash: string | null;
}
const ledger = (kind: string, id: string) => one<LedgerRow>("select foundation_id, source_hash, written_hash from flowform_imports where kind = ? and flowform_id = ?", kind, id);
function remember(kind: string, id: string, foundationId: string, sourceHash: string, writtenHash: string | null) {
  run(
    `insert into flowform_imports (kind, flowform_id, foundation_id, source_hash, written_hash, imported_at) values (?, ?, ?, ?, ?, ?)
       on conflict (kind, flowform_id) do update set foundation_id = excluded.foundation_id, source_hash = excluded.source_hash,
         written_hash = excluded.written_hash, imported_at = excluded.imported_at`,
    kind, id, foundationId, sourceHash, writtenHash, Date.now(),
  );
}
type Verdict = "create" | "update" | "unchanged" | "kept" | "removed-here";
function decide(prev: LedgerRow | undefined, sourceHash: string, current: unknown | undefined): Verdict {
  if (!prev) return current === undefined ? "create" : "kept";
  if (current === undefined) return "removed-here";
  if (prev.written_hash && digest(current) !== prev.written_hash) return "kept";
  return prev.source_hash === sourceHash ? "unchanged" : "update";
}

// ---------- pulling a room ----------

export interface PullReport {
  room: string;
  board: string;
  name: string;
  sections: number;
  cards: Record<Verdict, number>;
  /** images, videos, files and unreadable tables shown by name only */
  byName: number;
  goneUpstream: number;
  /** files being fetched in the background (the person allowed downloads) */
  filesComing?: number;
}

const ROLE: Record<string, BoardRole> = { owner: "owner", editor: "editor", viewer: "viewer" };
/** one pull per room at a time: a press while the timer runs waits for it */
const pulling = new Map<string, Promise<PullReport>>();

/** read one room as this person and bring it up to date on its board */
export function pullRoom(userId: string, roomId: string): Promise<PullReport> {
  const running = pulling.get(roomId);
  if (running) return running;
  const p = doPull(userId, roomId).finally(() => pulling.delete(roomId));
  pulling.set(roomId, p);
  return p;
}

/** rooms whose files are coming in, in the background (one fetch per room at a time) */
const fetching = new Set<string>();

async function doPull(userId: string, roomId: string): Promise<PullReport> {
  const room = (await listRooms(userId)).find((r) => r.room_id === roomId);
  if (!room) throw new HttpError(404, "You're not in that Flowform room");
  // a viewer in Flowform doesn't write its board here either
  if (room.role === "viewer") throw new HttpError(403, `You can only view “${room.name}” in Flowform, so you can't bring it in. An editor of the room can.`);
  const boardId = boardIdFor(roomId);
  const r: PullReport = { room: roomId, board: boardId, name: room.name, sections: 0, cards: { create: 0, update: 0, unchanged: 0, kept: 0, "removed-here": 0 }, byName: 0, goneUpstream: 0 };

  // read everything before writing anything: a failed read leaves the board as it was
  const read: Array<{ s: Surface; cards: FfCard[] }> = [];
  for (const s of await surfaces(userId, roomId)) {
    const cards = await cardsOn(userId, roomId, s);
    if (cards.length) read.push({ s, cards });
  }

  // who may see it: the default room ("flowform") stays open, as the importer leaves it; any other is
  // restricted to its members, and the person pulling is one (with their Flowform role, never more)
  ensureBoardRow(boardId, room.name);
  if (roomId !== "flowform") {
    const role = ROLE[room.role] ?? "viewer";
    if (boardRole(boardId, userId) !== role) setMember(boardId, userId, role, "flowform");
  }

  const seen = new Set<string>();
  editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    const setMeta = (k: string, v: unknown) => stable(m.meta.get(k)) !== stable(v) && m.meta.set(k, v);
    if (!m.meta.get("schema")) m.meta.set("schema", BOARD_SCHEMA);
    if (!m.meta.get("name")) m.meta.set("name", room.name);
    setMeta("flowformRoom", roomId);
    const offsets = { ...((m.meta.get("flowformCanvases") as Record<string, { section: string; dx: number; dy: number }>) ?? {}) };
    let bornAt = Date.now();

    read.forEach(({ s, cards }, i) => {
      // --- the surface's section (the importer's: one column per canvas) ---
      const key = `${roomId}:canvas:${s.canvas}`;
      const sid = `ffs_${safeId(s.canvas)}`.slice(0, 64);
      const left = (c: FfCard) => c.rect!.x - c.rect!.w / 2;
      const top = (c: FfCard) => c.rect!.y - c.rect!.h / 2;
      const minX = Math.min(...cards.map(left));
      const minY = Math.min(...cards.map(top));
      const spanW = Math.max(...cards.map((c) => c.rect!.x + c.rect!.w / 2)) - minX;
      const spanH = Math.max(...cards.map((c) => c.rect!.y + c.rect!.h / 2)) - minY;
      // an unnamed surface is the room's own plane: it takes the room's name (numbered only when a room has several)
      const unnamed = read.filter((x) => !x.s.name);
      const name = s.name || (unnamed.length > 1 ? `${room.name} ${unnamed.findIndex((x) => x.s === s) + 1}` : room.name);
      const cur = m.sections.get(sid);
      const v = decide(ledger("section", key), digest({ canvas: s.canvas, name }), cur && { name: cur.name });
      if (v === "removed-here") return;
      if (v === "create") {
        const tracks = readTracks(doc);
        const empty = m.sections.size === 0;
        const c = empty ? 0 : tracks.cols.length;
        const width = Math.max(DEFAULT_COL_W, Math.ceil(spanW + PAD * 2));
        const height = Math.max(DEFAULT_ROW_H, Math.ceil(spanH + PAD * 2));
        const cols = empty ? [width] : [...tracks.cols, width];
        const rows = [Math.max(tracks.rows[0] ?? DEFAULT_ROW_H, height), ...tracks.rows.slice(1)];
        m.grid.set("tracks", { cols, rows });
        m.sections.set(sid, { id: sid, name, c0: c, r0: 0, c1: c, r1: rows.length - 1 } satisfies SectionDoc);
        offsets[s.canvas] = { section: sid, dx: PAD - minX, dy: PAD - minY };
      } else if (v === "update") {
        m.sections.set(sid, { ...cur!, name });
      }
      if (v !== "kept") remember("section", key, sid, digest({ canvas: s.canvas, name }), digest({ name }));
      const o = offsets[s.canvas] ?? { section: sid, dx: PAD - minX, dy: PAD - minY };
      offsets[s.canvas] = o;
      r.sections++;

      // --- its cards, lowest first ---
      for (const c of [...cards].sort((a, b) => (a.stack_order ?? 0) - (b.stack_order ?? 0) || (a.id < b.id ? -1 : 1))) {
        const id = `ff_${safeId(c.id)}`.slice(0, 64);
        const ref = fileRef(c);
        const file = ref ? hereFile(fileIdFor(roomId, ref.file_id)) : null;
        const mapped = mapCard(c, { id, sectionId: o.section, x: Math.round(left(c) + o.dx), y: Math.round(top(c) + o.dy) }, file);
        if (!mapped) continue;
        const ck = `${roomId}:${c.id}`;
        seen.add(ck);
        if (mapped.stand_in) r.byName++;
        const shape = (d: ObjectDoc, text?: string, cells?: Record<string, string>) => ({ doc: { ...d, bornAt: 0, text: undefined }, text, cells });
        const want = shape(mapped.doc, mapped.text, mapped.cells);
        const now = m.objects.get(id);
        const nowShape = now && shape(now, now.kind === "note" ? noteTextOf(doc, now) : undefined, now.kind === "table" ? tableCellsOf(doc, id) : undefined);
        let verdict = decide(ledger("object", ck), digest(want), nowShape);
        // never swap a card that holds the real file (the backup import's) for a note naming it
        if (verdict === "update" && mapped.stand_in && now && now.kind !== "note") verdict = "unchanged";
        r.cards[verdict]++;
        if (verdict === "kept" || verdict === "removed-here") continue;
        if (verdict === "create" || verdict === "update") {
          m.objects.set(id, { ...mapped.doc, bornAt: now?.bornAt ?? bornAt++ } as ObjectDoc);
          if (mapped.text !== undefined) setNoteText(doc, id, mapped.text);
          if (mapped.cells) {
            // cell by cell, so a table's map stays the one people are typing in
            const t = tableCellMap(doc, id);
            for (const k of [...t.keys()]) if (!(k in mapped.cells)) t.delete(k);
            for (const [k, val] of Object.entries(mapped.cells)) if (t.get(k) !== val) t.set(k, val);
          }
        }
        const written = m.objects.get(id)!;
        remember("object", ck, id, digest(want), digest(shape(written, written.kind === "note" ? noteTextOf(doc, written) : undefined, written.kind === "table" ? tableCellsOf(doc, id) : undefined)));
      }
    });
    setMeta("flowformCanvases", offsets);

    for (const row of all<{ flowform_id: string }>("select flowform_id from flowform_imports where kind = 'object' and flowform_id like ?", `${roomId}:%`)) {
      if (!seen.has(row.flowform_id)) r.goneUpstream++; // left on the board, never deleted
    }
    const changed = r.cards.create + r.cards.update;
    if (changed) logActivity(doc, { who: "Flowform", role: "system", text: `Brought ${changed} card${changed === 1 ? "" : "s"} up to date from Flowform room “${room.name}”` });
  });

  run(
    `insert into flowform_live (room_id, board_id, name, pulled_by, pulled_at, cards, error) values (?, ?, ?, ?, ?, ?, null)
       on conflict (room_id) do update set board_id = excluded.board_id, name = excluded.name, pulled_by = excluded.pulled_by,
         pulled_at = excluded.pulled_at, cards = excluded.cards, error = null`,
    roomId, boardId, room.name, userId, Date.now(), seen.size,
  );

  // the files, in the background: the board is there already; once some arrive, the room is read again so they show
  const missing = read
    .flatMap((x) => x.cards)
    .filter((c) => {
      const ref = fileRef(c);
      return ref && !hereFile(fileIdFor(roomId, ref.file_id)) && !notThere.has(fileIdFor(roomId, ref.file_id));
    });
  r.filesComing = canDownload(userId) ? missing.length : 0;
  if (r.filesComing && !fetching.has(roomId)) {
    fetching.add(roomId);
    void fetchMissing(userId, roomId, boardId, missing)
      .then((arrived) => (arrived ? pullRoom(userId, roomId) : undefined))
      .catch((e) => console.error(`flowform files for ${roomId}:`, (e as Error).message))
      .finally(() => fetching.delete(roomId));
  }
  return r;
}

/** wait until a room's background files and the read after them are done (tests) */
export async function filesSettled(roomId: string) {
  while (fetching.has(roomId) || pulling.has(roomId)) await new Promise((ok) => setTimeout(ok, 20));
}

export interface LiveRoom {
  room_id: string;
  board_id: string;
  name: string;
  pulled_at: number;
  cards: number;
  error: string | null;
}
/** the rooms brought in so far (the board ids a person can then open, if they may see them) */
export const liveRooms = () => all<LiveRoom>("select room_id, board_id, name, pulled_at, cards, error from flowform_live order by name");

// ---------- kept connected ----------

let timer: NodeJS.Timeout | null = null;

/** read every pulled room again, as whoever pulled it, while their link holds */
export async function syncAll(): Promise<void> {
  for (const row of all<{ room_id: string; pulled_by: string }>("select room_id, pulled_by from flowform_live")) {
    if (!linkStatus(row.pulled_by).connected) continue;
    try {
      await pullRoom(row.pulled_by, row.room_id);
    } catch (e) {
      run("update flowform_live set error = ? where room_id = ?", (e as Error).message.slice(0, 300), row.room_id);
    }
  }
}

export function startFlowformSync(every = SYNC_MS) {
  if (timer) return;
  timer = setInterval(() => void syncAll(), every);
  timer.unref();
}
export function stopFlowformSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------- the person's files, for search and the Flowform browser ----------

/** one result of Flowform's own `search` tool, as production answered on 2026-11-11 */
interface FfSearchHit {
  file_id: string;
  title: string;
  kind: string;
  source: string;
  snippet?: string;
  external_url?: string | null;
  revision_id?: string | null;
  context?: { channel?: string | null; board?: string | null; poster?: string | null; date?: number | null };
  byte_size?: number | null;
}

/** Flowform marks a match with <b>…</b>: as Foundation's «…», with no HTML of theirs left in it */
export const flowformSnippet = (s: string) =>
  s
    .replace(/[«»]/g, '"')
    .replace(/<b>/gi, "«")
    .replace(/<\/b>/gi, "»")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const idOk = (s: string | null | undefined): s is string => typeof s === "string" && /^[\w.-]{1,160}$/.test(s);
/** where a Flowform file's small picture is served from (index.ts), when it has a revision and downloads are allowed */
const thumbPath = (fileId: string, revisionId: string | null | undefined, kind: string, downloads: boolean) =>
  downloads && idOk(fileId) && idOk(revisionId) && (kind === "image" || kind === "video") ? `/files/flowform/${fileId}/${revisionId}/thumb` : undefined;

/**
 * The files Flowform can see for this person that match `q` (its own ranking: uploads, board media, Slack, Figma),
 * as Foundation's search hits. Nothing when the person has no link; a failure is the caller's to catch.
 */
export async function searchFlowformFiles(userId: string, q: string, limit = 12): Promise<SearchHit[]> {
  if (!linkStatus(userId).connected) return [];
  const { results = [] } = await ask<{ results?: FfSearchHit[] }>(userId, "search", { query: q, limit });
  const downloads = canDownload(userId);
  return results
    .filter((h) => h && typeof h.file_id === "string" && typeof h.title === "string")
    .map((h, i) => {
      const where = [h.source, h.context?.channel && `#${h.context.channel}`, h.context?.board].filter(Boolean).join(" · ");
      return {
        source: "flowform" as const,
        id: `flowform:${h.file_id}`,
        title: h.title,
        snippet: h.snippet ? flowformSnippet(h.snippet) : where,
        url: h.external_url && /^https?:\/\//i.test(h.external_url) ? h.external_url : undefined,
        thumb: thumbPath(h.file_id, h.revision_id, h.kind, downloads),
        flowform: { fileId: h.file_id, revisionId: idOk(h.revision_id) ? h.revision_id : undefined, kind: h.kind, bytes: h.byte_size ?? undefined, origin: h.source },
        // under the board's own cards and files, in Flowform's order
        score: 0.9 - i * 0.02,
      };
    });
}

/** a room's files, read for a minute at most per person and room */
const roomFilesKept = new Map<string, { at: number; files: SearchHit[] }>();
const KIND: Record<string, string> = { image: "image", video: "video", video_note: "video", file_reference: "file", model_3d: "model", model_3d_v2: "model" };

/**
 * The files on a room's surfaces (its images, videos, file cards and models), without bringing the room in:
 * what Flowform's own file panel shows for a room. A card Flowform names no file for isn't listed.
 */
export async function roomFiles(userId: string, roomId: string): Promise<SearchHit[]> {
  const k = `${userId}\n${roomId}`;
  const kept = roomFilesKept.get(k);
  if (kept && Date.now() - kept.at < 60_000) return kept.files;
  const downloads = canDownload(userId);
  const seen = new Set<string>();
  const files: SearchHit[] = [];
  for (const s of await surfaces(userId, roomId)) {
    for (const c of await cardsOn(userId, roomId, s)) {
      const ref = fileRef(c);
      const kind = KIND[c.kind];
      if (!ref || !kind || seen.has(ref.file_id)) continue;
      seen.add(ref.file_id);
      const bytes = c.media?.byte_size ?? undefined;
      files.push({
        source: "flowform",
        id: `flowform:${ref.file_id}`,
        title: c.name || `${kind[0].toUpperCase()}${kind.slice(1)} ${ref.file_id.slice(0, 8)}`,
        snippet: [s.name, bytes ? sizeWords(bytes) : ""].filter(Boolean).join(" · "),
        thumb: thumbPath(ref.file_id, ref.revision_id, kind, downloads),
        flowform: { fileId: ref.file_id, revisionId: idOk(ref.revision_id) ? ref.revision_id : undefined, kind, bytes, origin: "flowform" },
        score: 1,
      });
    }
  }
  roomFilesKept.set(k, { at: Date.now(), files });
  if (roomFilesKept.size > 200) roomFilesKept.delete(roomFilesKept.keys().next().value!);
  return files;
}

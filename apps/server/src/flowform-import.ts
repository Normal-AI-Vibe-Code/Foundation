/**
 * Import flowform: rooms → boards, cards → objects, media → files, room
 * members → board members, people → users.
 *
 * The source is flowform-server's own daily data backup (`current.tar.gz`),
 * read-only:
 *   data/flowform.db                         a VACUUM INTO snapshot (users, rooms, room_members, files…)
 *   data/rooms/<room>/snapshot.ydoc          the room's Y.Doc, encode_state_as_update_v2
 *   data/rooms/<room>/updates.log            later v2 updates, each behind a u32 LE length
 * Media bytes live in flowform's media bucket, not in the backup: a
 * local mirror of the bucket (`--media-dir`), or flowform's own presigned
 * `/media/url` for rooms the token's person is a member of.
 *
 * Re-runnable. A ledger (`flowform_imports`) records what each flowform thing
 * became and the hash of what was written; a re-run creates what's new,
 * updates what changed upstream *only if nobody has touched it here since*,
 * leaves what someone removed here removed, and never deletes anything —
 * cards gone from flowform stay on the board, files removed there arrive
 * archived.
 *
 * Mapping (flowform's card shape: one Y.Map per card under `primitives`):
 *   room                → board `ff-<room>`; the default room ("flowform") stays open to everyone
 *   room_members        → board_members (owner / editor / viewer)
 *   canvas              → a section, one column each, named by its canvas title
 *   text (+ sticky)     → note (blocks flattened to markdown-ish text)
 *   todo                → note with "- [x]" lines (due dates kept in the text)
 *   table / grid        → table + cells (column labels become a header row)
 *   image / video / video_note → media, bytes copied into files
 *   file_reference / model_3d / model_3d_v2 → file panel, bytes copied into files
 *   iframe              → app panel;  link_card → link panel
 * Everything else is counted in the report, not drawn (see `unmapped`).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import {
  BOARD_SCHEMA,
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  boardMaps,
  logActivity,
  readTracks,
  type MediaDoc,
  type NoteDoc,
  type ObjectDoc,
  type PanelDoc,
  type SectionDoc,
  type TableDoc,
} from "@foundation/protocol";
import { all, one, run } from "./db.ts";
import { editBoard, ensureBoardRow } from "./boards.ts";
import { storeImportedFile } from "./files.ts";
import { setMember, type BoardRole } from "./members.ts";
import { upsertUser } from "./auth.ts";

const ORIGIN = "flowform-import";
const PAD = 160;

// ---------- sources ----------

/** Where media bytes come from. Returns null when the object isn't there. */
export interface MediaSource {
  name: string;
  get(key: string, bucket?: string | null): Promise<Buffer | null>;
}

/** a local mirror of the media bucket: `aws s3 sync s3://<bucket> <dir>` */
export function dirMedia(root: string): MediaSource {
  return {
    name: `dir:${root}`,
    async get(key, bucket) {
      if (key.split("/").some((s) => s === ".." || s === "")) return null;
      for (const p of [bucket ? join(root, bucket, key) : null, join(root, key)]) {
        if (p && existsSync(p) && statSync(p).isFile()) return readFileSync(p);
      }
      return null;
    },
  };
}

/** flowform's presigned download (`GET /media/url?key=`), as the token's person — only rooms they're in */
export function flowformMedia(baseUrl: string, token: string): MediaSource {
  const base = baseUrl.replace(/\/$/, "");
  return {
    name: `flowform:${base}`,
    async get(key) {
      const res = await fetch(`${base}/media/url?key=${encodeURIComponent(key)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 403 || res.status === 404) return null;
      if (!res.ok) throw new Error(`flowform /media/url answered ${res.status}`);
      const { url } = (await res.json()) as { url: string };
      const obj = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!obj.ok) return null;
      return Buffer.from(await obj.arrayBuffer());
    },
  };
}

/**
 * A backup archive (`current.tar.gz`) or an extracted directory → the
 * directory holding flowform.db and rooms/. An archive is extracted privately
 * (it holds everyone's data) and `close()` removes the extraction.
 */
export function openBackup(path: string): { dir: string; close: () => void } {
  let root = path;
  let close = () => {};
  if (statSync(path).isFile()) {
    const tmp = mkdtempSync(join(tmpdir(), "flowform-backup-")); // mode 0700
    root = tmp;
    close = () => rmSync(tmp, { recursive: true, force: true });
    try {
      execFileSync("tar", ["-xzf", path, "-C", tmp]);
    } catch (e) {
      close();
      throw e;
    }
  }
  for (const d of [root, join(root, "data")]) if (existsSync(join(d, "flowform.db"))) return { dir: d, close };
  close();
  throw new Error(`no flowform.db in ${path} (expected the backup's data/ directory)`);
}

/** apply a room's snapshot, then its log, in the order flowform loads a room */
export function loadRoomDoc(roomDir: string): { doc: Y.Doc; updates: number; skipped: number } {
  const doc = new Y.Doc();
  let updates = 0;
  let skipped = 0;
  const snap = join(roomDir, "snapshot.ydoc");
  if (existsSync(snap)) {
    const bytes = readFileSync(snap);
    if (bytes.length) Y.applyUpdateV2(doc, bytes);
  }
  const logPath = join(roomDir, "updates.log");
  if (existsSync(logPath)) {
    const log = readFileSync(logPath);
    let off = 0;
    while (off + 4 <= log.length) {
      const len = log.readUInt32LE(off);
      if (off + 4 + len > log.length) break; // a torn tail record: flowform stops there too
      try {
        Y.applyUpdateV2(doc, log.subarray(off + 4, off + 4 + len));
        updates++;
      } catch {
        skipped++; // flowform skips undecodable records during replay
      }
      off += 4 + len;
    }
  }
  return { doc, updates, skipped };
}

// ---------- reading the flowform card shape ----------

type FfMap = Y.Map<unknown>;

const num = (m: FfMap, k: string) => (typeof m.get(k) === "number" ? (m.get(k) as number) : undefined);
const str = (m: FfMap, k: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : undefined);
const text = (v: unknown) => (v instanceof Y.Text ? v.toString() : typeof v === "string" ? v : "");

interface Run {
  text: string;
  link?: string;
  code?: boolean;
}
type Block =
  | { type: "p" | "quote"; inlines: Run[] }
  | { type: "ul" | "ol"; items: Run[][] }
  | { type: "code"; text: string };

const runs = (rs: Run[] = []) => rs.map((r) => (r.link ? `[${r.text}](${r.link})` : r.code ? `\`${r.text}\`` : r.text)).join("");

/** flowform's text document (`data`, one JSON string) → plain text; formatting other than links, lists, quotes and code is dropped */
export function textFromData(data: string | undefined): string {
  if (!data) return "";
  let doc: { blocks?: Block[] };
  try {
    doc = JSON.parse(data);
  } catch {
    return data; // not JSON: the client shows it as typed
  }
  const out: string[] = [];
  for (const b of doc.blocks ?? []) {
    if (b.type === "p") out.push(runs(b.inlines));
    else if (b.type === "quote") out.push(`> ${runs(b.inlines)}`);
    else if (b.type === "ul") for (const it of b.items) out.push(`- ${runs(it)}`);
    else if (b.type === "ol") b.items.forEach((it, i) => out.push(`${i + 1}. ${runs(it)}`));
    else if (b.type === "code") out.push("```", b.text, "```");
  }
  return out.join("\n");
}

function todoText(m: FfMap): string {
  const items = m.get("items");
  if (!(items instanceof Y.Map)) return "";
  return [...items.values()]
    .filter((v): v is FfMap => v instanceof Y.Map)
    .map((it) => ({ t: text(it.get("text")), done: it.get("done") === true, order: num(it, "order") ?? 0, due: str(it, "due") }))
    .sort((a, b) => a.order - b.order)
    .map((it) => `- [${it.done ? "x" : " "}] ${it.t}${it.due ? ` (due ${it.due})` : ""}`)
    .join("\n");
}

/** table (schema 2: id-ordered rows/cols, cells "row:col" → {text: Y.Text}) or the retired grid ("r-c") → Foundation cells "c,r" */
function tableCells(m: FfMap): { cols: number; rows: number; cells: Record<string, string>; formulas: number } {
  const cells: Record<string, string> = {};
  let formulas = 0;
  const cm = m.get("cells");
  if (str(m, "kind") === "grid") {
    let rows = num(m, "rows") ?? 0;
    let cols = num(m, "cols") ?? 0;
    if (cm instanceof Y.Map) {
      for (const [k, v] of cm.entries()) {
        const mm = /^(\d+)-(\d+)$/.exec(k);
        if (!mm) continue;
        const [r, c] = [Number(mm[1]), Number(mm[2])];
        const t = v instanceof Y.Map ? text(v.get("text")) : text(v);
        if (t) cells[`${c},${r}`] = t;
        rows = Math.max(rows, r + 1);
        cols = Math.max(cols, c + 1);
      }
    }
    return { cols: Math.max(cols, 1), rows: Math.max(rows, 1), cells, formulas };
  }
  const order = (k: string) => {
    const a = m.get(k);
    return a instanceof Y.Array ? (a.toArray().filter((x) => typeof x === "string") as string[]) : [];
  };
  const rowIds = order("row_order");
  const colIds = order("col_order");
  const labels = m.get("col_labels");
  const labelOf = (id: string) => (labels instanceof Y.Map && typeof labels.get(id) === "string" ? (labels.get(id) as string) : "");
  const header = colIds.some((id) => labelOf(id));
  if (header) colIds.forEach((id, c) => labelOf(id) && (cells[`${c},0`] = labelOf(id)));
  const top = header ? 1 : 0;
  rowIds.forEach((rid, r) =>
    colIds.forEach((cid, c) => {
      const cell = cm instanceof Y.Map ? cm.get(`${rid}:${cid}`) : undefined;
      if (!(cell instanceof Y.Map)) return;
      if (cell.get("formula") != null) formulas++; // flowform's formula refs are row/column ids; the shown text is kept
      const t = text(cell.get("text"));
      if (t) cells[`${c},${r + top}`] = t;
    }),
  );
  return { cols: Math.max(colIds.length, 1), rows: Math.max(rowIds.length + top, 1), cells, formulas };
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/mp4",
  ".pdf": "application/pdf", ".step": "model/step", ".stp": "model/step", ".stl": "model/stl", ".glb": "model/gltf-binary",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
};
const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

// ---------- the flowform database ----------

interface FfFile {
  fileId: string;
  name: string;
  key: string;
  bucket: string | null;
  mime: string;
  createdBy: string | null;
  createdAt: number;
  /** removed from the room, deleted or archived in flowform → arrives archived */
  goneAt: number | null;
}

const ms = (s: unknown) => (typeof s === "number" ? (s < 1e12 ? s * 1000 : s) : null);

class FlowformDb {
  readonly db: DatabaseSync;
  readonly cols = new Map<string, Set<string>>();
  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }
  has(table: string, col?: string) {
    if (!this.cols.has(table)) {
      const rows = this.db.prepare(`select name from pragma_table_info(?)`).all(table) as { name: string }[];
      this.cols.set(table, new Set(rows.map((r) => r.name)));
    }
    const c = this.cols.get(table)!;
    return col ? c.has(col) : c.size > 0;
  }
  all<T>(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).all(...(p as never[])) as T[];
  }
  one<T>(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).get(...(p as never[])) as T | undefined;
  }

  users() {
    const role = this.has("users", "role") ? "role" : "'user'";
    const sys = this.has("users", "system_kind") ? "system_kind" : "null";
    return this.all<{ id: string; email: string; name: string; role: string; sys: string | null; created_at: number }>(
      `select lower(hex(user_id)) as id, email, display_name as name, ${role} as role, ${sys} as sys, created_at from users`,
    );
  }
  rooms() {
    return this.all<{ id: string; name: string; created_by: string | null; created_at: number }>(
      "select room_id as id, name, lower(hex(created_by)) as created_by, created_at from rooms order by created_at",
    );
  }
  members(room: string) {
    return this.all<{ user_id: string; role: string }>("select lower(hex(user_id)) as user_id, room_role as role from room_members where room_id = ?", room);
  }

  /** the source rendition of a file (one revision, or its newest), with its key */
  private sourceOf(fileId: string, revisionId?: string) {
    const bucket = this.has("file_variants", "s3_bucket") ? "v.s3_bucket" : "null";
    return this.one<{ key: string; bucket: string | null; mime: string | null }>(
      `select v.s3_key as key, ${bucket} as bucket, v.mime_type as mime
         from file_revisions r join file_variants v on v.revision_id = r.revision_id
        where r.file_id = ? ${revisionId ? "and r.revision_id = ?" : ""} and v.role = 'source' and v.state = 'ready'
        order by r.revision_number desc, v.rendition_version desc limit 1`,
      ...(revisionId ? [fileId, revisionId] : [fileId]),
    );
  }

  file(room: string, fileId: string, revisionId?: string): FfFile | null {
    if (!this.has("files")) return null;
    const f = this.one<{ name: string; created_by: string | null; created_at: number; deleted_at: number | null; archived_at: number | null }>(
      `select original_name as name, lower(hex(created_by)) as created_by, created_at, deleted_at, ${this.has("files", "archived_at") ? "archived_at" : "null"} as archived_at from files where file_id = ?`,
      fileId,
    );
    const src = f && (this.sourceOf(fileId, revisionId) ?? this.sourceOf(fileId));
    if (!f || !src) return null;
    const rf = this.has("room_files")
      ? this.one<{ display_name: string | null; removed_at: number | null }>("select display_name, removed_at from room_files where room_id = ? and file_id = ?", room, fileId)
      : undefined;
    return {
      fileId,
      name: rf?.display_name || f.name,
      key: src.key,
      bucket: src.bucket,
      mime: src.mime || mimeOf(f.name),
      createdBy: f.created_by,
      createdAt: ms(f.created_at) ?? Date.now(),
      goneAt: ms(rf?.removed_at) ?? ms(f.deleted_at) ?? ms(f.archived_at),
    };
  }

  /** the file a media card displays: its primitive_files edge, or the file whose variant is its key */
  fileForMedia(room: string, primitiveId: string, key: string | undefined): FfFile | null {
    if (this.has("primitive_files")) {
      const pf = this.one<{ file_id: string }>("select file_id from primitive_files where room_id = ? and primitive_id = ?", room, primitiveId);
      if (pf) return this.file(room, pf.file_id);
    }
    if (key && this.has("file_variants")) {
      const v = this.one<{ file_id: string; revision_id: string }>(
        "select r.file_id, r.revision_id from file_variants v join file_revisions r on r.revision_id = v.revision_id where v.s3_key = ?",
        key,
      );
      if (v) return this.file(room, v.file_id, v.revision_id);
    }
    return null;
  }

  /** files shared with the room but not on its canvas */
  roomFiles(room: string): string[] {
    if (!this.has("room_files")) return [];
    return this.all<{ file_id: string }>("select file_id from room_files where room_id = ? order by created_at", room).map((r) => r.file_id);
  }

  /** a legacy media ref's tombstone (`media_refs.deleted_at` / `archived_at`) */
  legacyGoneAt(room: string, primitiveId: string): number | null {
    if (!this.has("media_refs", "deleted_at")) return null;
    const r = this.one<{ deleted_at: number | null; archived_at: number | null }>(
      `select deleted_at, ${this.has("media_refs", "archived_at") ? "archived_at" : "null"} as archived_at from media_refs where room = ? and primitive_id = ?`,
      room, primitiveId,
    );
    return ms(r?.deleted_at) ?? ms(r?.archived_at);
  }

  /** agent action updates (`foundation_board_actions.doc_update`, v2) in commit order */
  actions(room: string): Uint8Array[] {
    if (!this.has("foundation_board_actions")) return [];
    const sql = this.has("foundation_board_action_seq")
      ? `select a.doc_update as u from foundation_board_actions a
           left join foundation_board_action_seq s on s.flowform_user_id = a.flowform_user_id and s.request_id = a.request_id
          where a.room_id = ? order by s.seq is null, s.seq, a.created_at`
      : "select doc_update as u from foundation_board_actions where room_id = ? order by created_at";
    return this.all<{ u: Uint8Array }>(sql, room).map((r) => r.u);
  }

  close() {
    this.db.close();
  }
}

// ---------- the ledger ----------

const stable = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
const digest = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex").slice(0, 32);

interface LedgerRow {
  foundation_id: string;
  source_hash: string;
  written_hash: string | null;
}
const ledger = (kind: string, id: string) =>
  one<LedgerRow>("select foundation_id, source_hash, written_hash from flowform_imports where kind = ? and flowform_id = ?", kind, id);
function remember(kind: string, id: string, foundationId: string, sourceHash: string, writtenHash: string | null) {
  run(
    `insert into flowform_imports (kind, flowform_id, foundation_id, source_hash, written_hash, imported_at) values (?, ?, ?, ?, ?, ?)
       on conflict (kind, flowform_id) do update set foundation_id = excluded.foundation_id, source_hash = excluded.source_hash,
         written_hash = excluded.written_hash, imported_at = excluded.imported_at`,
    kind, id, foundationId, sourceHash, writtenHash, Date.now(),
  );
}

/** what a re-run does with one thing, given the ledger and what's there now */
type Verdict = "create" | "update" | "unchanged" | "kept" | "removed-here";
function decide(prev: LedgerRow | undefined, sourceHash: string, current: unknown | undefined): Verdict {
  if (!prev) return current === undefined ? "create" : "kept"; // something already holds the id: leave it
  if (current === undefined) return "removed-here"; // a person removed it in Foundation: respected
  if (prev.written_hash && digest(current) !== prev.written_hash) return "kept"; // edited here since: theirs wins
  return prev.source_hash === sourceHash ? "unchanged" : "update";
}

// ---------- the import ----------

export interface ImportReport {
  dryRun: boolean;
  source: string;
  media: string;
  users: Record<"created" | "linked" | "unchanged" | "skipped", number>;
  boards: Array<{
    room: string;
    board: string;
    name: string;
    open: boolean;
    updates: number;
    /** agent action rows applied from flowform.db */
    actions: number;
    skippedUpdates: number;
    members: Record<Verdict, number>;
    sections: Record<Verdict, number>;
    objects: Record<Verdict, number>;
    goneUpstream: number;
    files: Record<"imported" | "existing" | "archived" | "missing", number>;
    missingMedia: string[];
    unmapped: Record<string, number>;
  }>;
}

export interface ImportOptions {
  /** the extracted backup directory (see openBackup) */
  dir: string;
  /** what to call the source in the report (default: dir) */
  label?: string;
  media?: MediaSource;
  /** only these room ids */
  rooms?: string[];
  /** flowform's default room (everyone's), imported as an open board */
  defaultRoom?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

const counts = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const VERDICTS = ["create", "update", "unchanged", "kept", "removed-here"] as const;
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
export const boardIdFor = (room: string) => `ff-${safeId(room)}`.slice(0, 64);

export async function importFlowform(opts: ImportOptions): Promise<ImportReport> {
  const log = opts.log ?? (() => {});
  const ff = new FlowformDb(join(opts.dir, "flowform.db"));
  const report: ImportReport = {
    dryRun: Boolean(opts.dryRun),
    source: opts.label ?? opts.dir,
    media: opts.media?.name ?? "none",
    users: counts(["created", "linked", "unchanged", "skipped"] as const),
    boards: [],
  };
  try {
    const userMap = importUsers(ff, report);
    const defaultRoom = opts.defaultRoom ?? "flowform";
    for (const room of ff.rooms()) {
      if (opts.rooms?.length && !opts.rooms.includes(room.id)) continue;
      const roomDir = join(opts.dir, "rooms", room.id);
      log(`room ${room.name} (${room.id})`);
      report.boards.push(await importRoom(ff, room, roomDir, room.id === defaultRoom, userMap, opts.media));
    }
  } finally {
    ff.close();
  }
  return report;
}

/** flowform people → Foundation users, linked by flowform id (then email). No sessions are made. */
function importUsers(ff: FlowformDb, report: ImportReport): Map<string, string> {
  const map = new Map<string, string>();
  for (const u of ff.users()) {
    if (u.sys) {
      report.users.skipped++; // deleted tombstones and system accounts
      continue;
    }
    const linked = one<{ id: string }>("select id from users where flowform_user_id = ?", u.id);
    if (linked) {
      map.set(u.id, linked.id);
      report.users.unchanged++;
      continue;
    }
    const byEmail = one<{ id: string }>("select id from users where email = ?", u.email.toLowerCase().trim());
    const user = upsertUser(u.email, u.name);
    run("update users set flowform_user_id = ? where id = ?", u.id, user.id);
    if (u.role === "admin") run("update users set role = 'admin' where id = ?", user.id);
    map.set(u.id, user.id);
    if (byEmail) report.users.linked++;
    else report.users.created++;
  }
  return map;
}

interface Placed {
  id: string;
  kind: string;
  m: FfMap;
  x: number;
  y: number;
  w: number;
  h: number;
  canvas: string;
  boardId: string;
  stack: number;
}

/** canvas id → its title, from the board structure (canvas nodes carry `name`), else the board's name */
function canvasNames(doc: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, boardName: string | undefined) => {
    if (v instanceof Y.Map) {
      if (v.get("kind") === "canvas" && typeof v.get("canvas") === "string") {
        const name = str(v, "name") || boardName;
        if (name && !out.has(v.get("canvas") as string)) out.set(v.get("canvas") as string, name);
      }
      for (const c of v.values()) walk(c, boardName);
    } else if (v instanceof Y.Array) for (const c of v.toArray()) walk(c, boardName);
  };
  for (const b of doc.getMap("boards").values()) if (b instanceof Y.Map) walk(b, str(b, "name"));
  return out;
}

async function importRoom(
  ff: FlowformDb,
  room: { id: string; name: string },
  roomDir: string,
  open: boolean,
  userMap: Map<string, string>,
  media: MediaSource | undefined,
): Promise<ImportReport["boards"][number]> {
  const boardId = boardIdFor(room.id);
  const r: ImportReport["boards"][number] = {
    room: room.id,
    board: boardId,
    name: room.name,
    open,
    updates: 0,
    actions: 0,
    skippedUpdates: 0,
    members: counts(VERDICTS),
    sections: counts(VERDICTS),
    objects: counts(VERDICTS),
    goneUpstream: 0,
    files: counts(["imported", "existing", "archived", "missing"] as const),
    missingMedia: [],
    unmapped: {},
  };
  const miss = (what: string, n = 1) => (r.unmapped[what] = (r.unmapped[what] ?? 0) + n);

  // --- members first: a restricted board is never briefly open ---
  ensureBoardRow(boardId, room.name);
  if (!open) {
    for (const m of ff.members(room.id)) {
      const userId = userMap.get(m.user_id);
      const role = (["owner", "editor", "viewer"].includes(m.role) ? m.role : "viewer") as BoardRole;
      if (!userId) continue;
      const key = `${room.id}:${m.user_id}`;
      const cur = one<{ role: string }>("select role from board_members where board_id = ? and user_id = ?", boardId, userId)?.role;
      const v = decide(ledger("member", key), digest(role), cur);
      r.members[v]++;
      if (v === "create" || v === "update") setMember(boardId, userId, role, "flowform");
      if (v !== "kept" && v !== "removed-here") remember("member", key, userId, digest(role), digest(role));
    }
  }

  if (!existsSync(roomDir)) {
    miss("room with no document in the backup");
    return r;
  }
  const { doc: src, updates, skipped } = loadRoomDoc(roomDir);
  r.updates = updates;
  r.skippedUpdates = skipped;
  // flowform also replays committed agent actions on room load; a
  // Yjs update already in the doc is a no-op, so every row is applied
  for (const row of ff.actions(room.id)) {
    try {
      Y.applyUpdateV2(src, row);
      r.actions++;
    } catch {
      r.skippedUpdates++;
    }
  }

  // --- read the cards ---
  const placed: Placed[] = [];
  for (const [id, v] of src.getMap("primitives").entries()) {
    if (!(v instanceof Y.Map)) continue;
    const m = v as FfMap;
    const kind = str(m, "kind");
    const [x, y, w, h] = [num(m, "x"), num(m, "y"), num(m, "w"), num(m, "h")];
    if (!kind || x === undefined || y === undefined || w === undefined || h === undefined) {
      miss("unplaceable card (no kind or geometry; flowform skips it too)");
      continue;
    }
    placed.push({ id, kind, m, x, y, w, h, canvas: str(m, "canvas") ?? "", boardId: str(m, "board_id") ?? "", stack: num(m, "stack_order") ?? 0 });
  }
  const groups = src.getMap("groups").size;
  if (groups) miss("group (sections are Foundation's grouping)", groups);
  const arrows = src.getMap("board_connectors").size;
  if (arrows) miss("connector arrow between cards (Foundation wires join app ports)", arrows);
  const flows = src.getMap("dataflow_connections").size;
  if (flows) miss("dataflow wire (project → card)", flows);

  // --- sections: one per canvas ---
  const titles = canvasNames(src);
  const byCanvas = new Map<string, Placed[]>();
  for (const p of placed) byCanvas.set(p.canvas, [...(byCanvas.get(p.canvas) ?? []), p]);

  const sectionOf = new Map<string, { id: string; dx: number; dy: number } | null>();
  editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    // a Y.Map set is a write even when the value is the same: only set what differs
    const setMeta = (k: string, v: unknown) => stable(m.meta.get(k)) !== stable(v) && m.meta.set(k, v);
    if (!m.meta.get("schema")) m.meta.set("schema", BOARD_SCHEMA);
    if (!m.meta.get("name")) m.meta.set("name", room.name);
    setMeta("flowformRoom", room.id);
    const offsets = { ...((m.meta.get("flowformCanvases") as Record<string, { section: string; dx: number; dy: number }>) ?? {}) };
    let i = 0;
    for (const [canvas, cards] of byCanvas) {
      i++;
      const key = `${room.id}:canvas:${canvas}`;
      const id = `ffs_${safeId(canvas)}`.slice(0, 64);
      const minX = Math.min(...cards.map((c) => c.x - c.w / 2));
      const minY = Math.min(...cards.map((c) => c.y - c.h / 2));
      const spanW = Math.max(...cards.map((c) => c.x + c.w / 2)) - minX;
      const spanH = Math.max(...cards.map((c) => c.y + c.h / 2)) - minY;
      const name = titles.get(canvas) || (byCanvas.size > 1 ? `${room.name} ${i}` : room.name);
      const prev = ledger("section", key);
      const cur = m.sections.get(id);
      const v = decide(prev, digest({ canvas, name }), cur && { name: cur.name });
      r.sections[v]++;
      if (v === "removed-here") {
        sectionOf.set(canvas, null);
        continue;
      }
      if (v === "create") {
        // a new column on the right, sized to the canvas
        const tracks = readTracks(doc);
        const empty = m.sections.size === 0;
        const c = empty ? 0 : tracks.cols.length;
        const width = Math.max(DEFAULT_COL_W, Math.ceil(spanW + PAD * 2));
        const height = Math.max(DEFAULT_ROW_H, Math.ceil(spanH + PAD * 2));
        const cols = empty ? [width] : [...tracks.cols, width];
        const rows = [Math.max(tracks.rows[0] ?? DEFAULT_ROW_H, height), ...tracks.rows.slice(1)];
        m.grid.set("tracks", { cols, rows });
        const sec: SectionDoc = { id, name, c0: c, r0: 0, c1: c, r1: rows.length - 1 };
        m.sections.set(id, sec);
        offsets[canvas] = { section: id, dx: PAD - minX, dy: PAD - minY };
      } else if (v === "update") {
        m.sections.set(id, { ...cur!, name });
      }
      if (v !== "kept") remember("section", key, id, digest({ canvas, name }), digest({ name }));
      const o = offsets[canvas] ?? { section: id, dx: PAD - minX, dy: PAD - minY };
      offsets[canvas] = o;
      sectionOf.set(canvas, { id: o.section, dx: o.dx, dy: o.dy });
    }
    setMeta("flowformCanvases", offsets);
  });

  // --- media bytes, then cards ---
  const fileRows = new Map<string, string | null>(); // flowform file key → Foundation file id (null: missing)
  const fetchFile = async (key: string, f: { name: string; mime: string; s3: string; bucket: string | null; by: string | null; at: number; goneAt: number | null }) => {
    if (fileRows.has(key)) return fileRows.get(key)!;
    const id = `ff_${digest([room.id, key])}`;
    if (one("select id from files where id = ?", id)) {
      r.files.existing++;
      fileRows.set(key, id);
      return id;
    }
    const body = media ? await media.get(f.s3, f.bucket).catch(() => null) : null;
    if (!body) {
      r.files.missing++;
      r.missingMedia.push(f.s3);
      fileRows.set(key, null);
      return null;
    }
    await storeImportedFile({
      id,
      boardId,
      name: f.name,
      mime: f.mime,
      body,
      uploadedBy: (f.by && userMap.get(f.by)) || null,
      createdAt: f.at,
      archivedAt: f.goneAt,
    });
    remember("file", `${room.id}:${key}`, id, digest(f.s3), null);
    r.files.imported++;
    if (f.goneAt) r.files.archived++;
    fileRows.set(key, id);
    return id;
  };
  const fromFlowformFile = (f: FfFile) =>
    fetchFile(`file:${f.fileId}`, { name: f.name, mime: f.mime, s3: f.key, bucket: f.bucket, by: f.createdBy, at: f.createdAt, goneAt: f.goneAt });

  const cards: Array<{ p: Placed; doc: ObjectDoc; cells?: Record<string, string> }> = [];
  for (const p of [...placed].sort((a, b) => a.stack - b.stack || (a.id < b.id ? -1 : 1))) {
    const sec = sectionOf.get(p.canvas);
    if (!sec) continue; // its section was removed here
    const base = {
      id: `ff_${safeId(p.id)}`.slice(0, 64),
      sectionId: sec.id,
      name: str(p.m, "name") ?? "",
      x: Math.round(p.x - p.w / 2 + sec.dx),
      y: Math.round(p.y - p.h / 2 + sec.dy),
      float: true,
      bornAt: 0,
    };
    const w = Math.round(p.w);
    const h = Math.round(p.h);
    switch (p.kind) {
      case "text": {
        if (str(p.m, "note_color") || str(p.m, "note_background")) miss("sticky colour");
        cards.push({ p, doc: { ...base, kind: "note", w, h, text: textFromData(str(p.m, "data")) } satisfies NoteDoc });
        break;
      }
      case "todo":
        cards.push({ p, doc: { ...base, kind: "note", w, h, text: todoText(p.m) } satisfies NoteDoc });
        break;
      case "table":
      case "grid": {
        const t = tableCells(p.m);
        if (t.formulas) miss("table formula (its shown text was kept)", t.formulas);
        cards.push({ p, doc: { ...base, kind: "table", cols: t.cols, rows: t.rows } satisfies TableDoc, cells: t.cells });
        break;
      }
      case "image":
      case "video":
      case "video_note": {
        const key = str(p.m, "s3_key");
        const f = ff.fileForMedia(room.id, p.id, key);
        const fileId = f
          ? await fromFlowformFile(f)
          : key
            ? await fetchFile(`key:${key}`, { name: str(p.m, "name") || basename(key), mime: mimeOf(key), s3: key, bucket: null, by: null, at: Date.now(), goneAt: ff.legacyGoneAt(room.id, p.id) })
            : null;
        const video = p.kind !== "image";
        if (fileId) {
          if (num(p.m, "crop_w") !== undefined || num(p.m, "rotation_quarters")) miss("image crop / rotation");
          cards.push({
            p,
            doc: { ...base, kind: "media", w, h, src: `/files/${fileId}`, media: video ? "video" : "image", autoplay: p.m.get("autoplay") === true, muted: p.m.get("mute") !== false } satisfies MediaDoc,
          });
        } else {
          cards.push({ p, doc: placeholder(base, w, h, key ?? "(no media key)") });
        }
        break;
      }
      case "file_reference":
      case "model_3d":
      case "model_3d_v2": {
        const fid = str(p.m, "file_id");
        const f = fid ? ff.file(room.id, fid, str(p.m, "revision_id")) : null;
        const fileId = f ? await fromFlowformFile(f) : null;
        if (!f && fid) {
          r.files.missing++;
          r.missingMedia.push(`file ${fid} (no ready source rendition in flowform.db)`);
        }
        cards.push({
          p,
          doc: fileId
            ? ({ ...base, kind: "panel", panel: "file", w, h, fileId, mime: f!.mime, name: base.name || f!.name, ports: [] } satisfies PanelDoc)
            : placeholder(base, w, h, f?.key ?? `file ${fid}`),
        });
        break;
      }
      case "iframe":
      case "link_card": {
        const url = str(p.m, "url");
        if (!url) {
          miss(`${p.kind} without a url`);
          break;
        }
        cards.push({ p, doc: { ...base, kind: "panel", panel: p.kind === "iframe" ? "app" : "link", w, h, url, name: base.name || url, ports: [] } satisfies PanelDoc });
        break;
      }
      default:
        miss(p.kind);
    }
  }

  // files shared with the room but not on its canvas: carried as the board's files (archived when removed there)
  for (const fid of ff.roomFiles(room.id)) {
    const f = ff.file(room.id, fid);
    if (f) await fromFlowformFile(f);
  }

  // --- write the cards ---
  const seen = new Set<string>();
  editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    let bornAt = Date.now();
    for (const c of cards) {
      const key = `${room.id}:${c.p.id}`;
      seen.add(key);
      const sourceHash = digest({ doc: { ...c.doc, bornAt: 0 }, cells: c.cells });
      const cur = m.objects.get(c.doc.id);
      const v = decide(ledger("object", key), sourceHash, cur && { doc: { ...cur, bornAt: 0 }, cells: m.cells.get(c.doc.id) });
      r.objects[v]++;
      if (v === "kept" || v === "removed-here") continue;
      if (v === "create" || v === "update") {
        const next = { ...c.doc, bornAt: cur?.bornAt ?? bornAt++ } as ObjectDoc;
        m.objects.set(next.id, next);
        if (c.cells) m.cells.set(next.id, c.cells);
      }
      remember("object", key, c.doc.id, sourceHash, digest({ doc: { ...c.doc, bornAt: 0 }, cells: c.cells }));
    }
    for (const row of all<{ flowform_id: string }>("select flowform_id from flowform_imports where kind = 'object' and flowform_id like ?", `${room.id}:%`)) {
      if (!seen.has(row.flowform_id)) r.goneUpstream++; // left on the board: archive, never delete
    }
    const carried = r.objects.create + r.objects.update;
    if (carried) {
      const left = Object.entries(r.unmapped).map(([k, n]) => `${n} ${k}`).join(", ");
      logActivity(doc, { who: "Flowform import", role: "system", text: `Imported ${carried} card${carried === 1 ? "" : "s"} from flowform room "${room.name}"${left ? `. Not carried: ${left}` : ""}` });
    }
  });
  return r;
}

/** a card whose bytes didn't arrive: a note that says so (a re-run replaces it with the file, if nobody edited it) */
function placeholder(base: Omit<NoteDoc, "kind" | "w" | "h" | "text">, w: number, h: number, key: string): NoteDoc {
  const label = base.name || basename(key);
  return {
    ...base,
    name: label,
    kind: "note",
    w,
    h,
    text: `**${label}** hasn't arrived from flowform yet (${key}). Run the import again once the media is reachable.`,
  };
}

/** a short human summary of a report */
export function describeReport(r: ImportReport): string {
  const lines = [
    `${r.dryRun ? "DRY RUN — nothing kept. " : ""}source ${r.source} · media ${r.media}`,
    `people: ${r.users.created} new, ${r.users.linked} linked by email, ${r.users.unchanged} already linked, ${r.users.skipped} system/deleted skipped`,
  ];
  for (const b of r.boards) {
    const v = (c: Record<string, number>) => Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "none";
    lines.push(
      `\n${b.name} → ${b.board}${b.open ? " (open to everyone, flowform's default room)" : ""}`,
      `  doc: snapshot + ${b.updates} logged update${b.updates === 1 ? "" : "s"} + ${b.actions} agent action${b.actions === 1 ? "" : "s"}${b.skippedUpdates ? `, ${b.skippedUpdates} undecodable skipped` : ""}`,
      `  members: ${v(b.members)}`,
      `  sections: ${v(b.sections)}`,
      `  cards: ${v(b.objects)}${b.goneUpstream ? `; ${b.goneUpstream} gone from flowform (left in place)` : ""}`,
      `  files: ${v(b.files)}`,
    );
    if (b.missingMedia.length) lines.push(`  missing media: ${b.missingMedia.slice(0, 8).join(", ")}${b.missingMedia.length > 8 ? ` … ${b.missingMedia.length - 8} more` : ""}`);
    if (Object.keys(b.unmapped).length) lines.push(`  not carried: ${v(b.unmapped)}`);
  }
  return lines.join("\n");
}

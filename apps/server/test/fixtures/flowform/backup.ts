/**
 * A fixture flowform backup, shaped like the backup's data/ directory:
 * flowform.db (just the tables and columns the importer reads, see SCHEMA) and
 * the room documents in data/rooms (Yjs v2 snapshot + update log, written by
 * flowform's own card writers outside this repo); plus a media bucket mirror.
 * Used by test/flowform-import.test.ts and for the CLI evidence run
 * (`tsx test/fixtures/flowform/backup.ts <out>`).
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateSync } from "node:zlib";
import * as Y from "yjs";

const FIX = import.meta.dirname;
export const LAUNCH = "5b0f1c9e-2d43-4f7a-9a51-0c6e1d2f3a4b";
export const NOA = "0a".repeat(16); // owner, flowform admin
export const SAM = "0b".repeat(16); // editor
export const VIC = "0c".repeat(16); // viewer
const GONE = "0d".repeat(16); // a deleted account's tombstone
export const T = 1_790_000_000; // flowform stores unix seconds

/** the slice of flowform.db the importer reads (ids are 16-byte blobs, times unix seconds) */
const SCHEMA = `
create table users (user_id blob primary key, display_name text not null, email text not null unique, created_at integer not null, role text not null default 'user', system_kind text);
create table rooms (room_id text primary key, name text not null, created_by blob references users(user_id), created_at integer not null);
create table room_members (room_id text not null references rooms(room_id), user_id blob not null references users(user_id), room_role text not null, added_at integer not null, primary key (room_id, user_id));
create table files (file_id text primary key, original_name text not null, created_by blob references users(user_id), created_at integer not null, deleted_at integer, archived_at integer);
create table file_revisions (revision_id text primary key, file_id text not null references files(file_id), revision_number integer not null);
create table file_variants (variant_id text primary key, revision_id text not null references file_revisions(revision_id), role text not null, rendition_version integer not null, s3_key text not null unique, s3_bucket text, mime_type text, state text not null);
create table room_files (room_id text not null references rooms(room_id), file_id text not null references files(file_id), display_name text, created_at integer not null, removed_at integer, primary key (room_id, file_id));
create table primitive_files (room_id text not null, primitive_id text not null, file_id text not null, primary key (room_id, primitive_id));
create table media_refs (room text not null, primitive_id text not null, created_at integer not null, deleted_at integer, archived_at integer, primary key (room, primitive_id));
create table foundation_board_actions (flowform_user_id blob not null, request_id text not null, room_id text not null references rooms(room_id), doc_update blob not null, created_at integer not null, primary key (flowform_user_id, request_id));
`;

/** a v2 update adding a text card, made on top of the room's own state (as flowform's agent writes do) */
function agentAction(roomDir: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, readFileSync(join(roomDir, "snapshot.ydoc")));
  const log = readFileSync(join(roomDir, "updates.log"));
  for (let o = 0; o < log.length; o += 4 + log.readUInt32LE(o)) Y.applyUpdateV2(doc, log.subarray(o + 4, o + 4 + log.readUInt32LE(o)));
  const before = Y.encodeStateVector(doc);
  const card = new Y.Map<unknown>();
  doc.getMap("primitives").set("p-agent", card);
  for (const [k, v] of Object.entries({ kind: "text", x: 300, y: 1100, w: 320, h: 160, board_id: "b-main", canvas: "cv-shop", stack_order: 20, data: JSON.stringify({ blocks: [{ type: "p", inlines: [{ text: "Filed by the agent" }] }], align: "left", font_scale: 0.875, line_height: 1.43, color: 2236962 }) })) card.set(k, v);
  return Y.encodeStateAsUpdateV2(doc, before);
}

/** a real (small) PNG — a warm diagonal ramp — so the imported image renders */
export function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      rows.set([Math.round(232 - 60 * t), Math.round(85 + 90 * t), Math.round(61 + 120 * t)], y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

export function makeBackup(out?: string) {
  const dir = out ? join(out, "data") : mkdtempSync(join(tmpdir(), "flowform-backup-"));
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIX, "data", "rooms"), join(dir, "rooms"), { recursive: true });
  const db = new DatabaseSync(join(dir, "flowform.db"));
  db.exec("pragma foreign_keys = on");
  db.exec(SCHEMA);
  const q = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));
  const user = (id: string, name: string, email: string, role: string, sys: string | null = null) =>
    q("insert into users (user_id, display_name, email, created_at, role, system_kind) values (unhex(?), ?, ?, ?, ?, ?)", id, name, email, T, role, sys);
  user(NOA, "Noa Field", "noa@formindustries.com", "admin");
  user(SAM, "Sam Reyes", "sam@formindustries.com", "user");
  user(VIC, "Vic Lund", "vic@partner.example", "viewer");
  user(GONE, "Deleted user", `deleted+${GONE}@system.flowform.local`, "viewer", "deleted");
  q("insert into rooms (room_id, name, created_by, created_at) values (?, ?, unhex(?), ?)", LAUNCH, "Launch room", NOA, T);
  q("insert into rooms (room_id, name, created_by, created_at) values (?, ?, null, ?)", "flowform", "Flowform", T);
  for (const [u, role] of [[NOA, "owner"], [SAM, "editor"], [VIC, "viewer"]]) q("insert into room_members (room_id, user_id, room_role, added_at) values (?, unhex(?), ?, ?)", LAUNCH, u, role, T);
  q("insert into room_members (room_id, user_id, room_role, added_at) values ('flowform', unhex(?), 'editor', ?)", SAM, T);
  const file = (fileId: string, name: string, rev: string, variants: Array<[string, string, string]>, removedAt: number | null = null) => {
    q("insert into files (file_id, original_name, created_by, created_at) values (?, ?, unhex(?), ?)", fileId, name, SAM, T);
    q("insert into file_revisions (revision_id, file_id, revision_number) values (?, ?, 1)", rev, fileId);
    for (const [vid, role, key] of variants) {
      q("insert into file_variants (variant_id, revision_id, role, rendition_version, s3_key, state) values (?, ?, ?, 1, ?, 'ready')", vid, rev, role, key);
    }
    q("insert into room_files (room_id, file_id, created_at, removed_at) values (?, ?, ?, ?)", LAUNCH, fileId, T, removedAt);
  };
  // the image card shows its display rendition; the importer takes the source
  file("file-photo", "hinge.png", "rev-photo", [["var-photo-src", "source", "files/file-photo/var-photo-src.png"], ["var-photo", "display", "files/file-photo/var-photo.png"]]);
  q("insert into primitive_files (room_id, primitive_id, file_id) values (?, 'p-photo', 'file-photo')", LAUNCH);
  file("file-cad", "shroud.step", "rev-cad-2", [["var-cad", "source", "files/file-cad/var-cad.step"]]);
  file("file-lost", "drawing.pdf", "rev-lost", [["var-lost", "source", "files/file-lost/var-lost.pdf"]]);
  // shared with the room, never on the canvas, later removed there → arrives archived
  file("file-notes", "notes.txt", "rev-notes", [["var-notes", "source", "files/file-notes/var-notes.txt"]], T + 60);
  q("insert into media_refs (room, primitive_id, created_at) values (?, 'p-clip', ?)", LAUNCH, T);
  // an agent card committed as an action row (flowform replays these on room load)
  const agentCard = agentAction(join(dir, "rooms", LAUNCH));
  q("insert into foundation_board_actions (flowform_user_id, request_id, room_id, doc_update, created_at) values (unhex(?), 'req-1', ?, ?, ?)", NOA, LAUNCH, agentCard, T + 120);
  db.close();

  const media = out ? join(out, "media") : mkdtempSync(join(tmpdir(), "flowform-media-"));
  const put = (key: string, body: Buffer | string) => {
    mkdirSync(dirname(join(media, key)), { recursive: true });
    writeFileSync(join(media, key), body);
  };
  put("files/file-photo/var-photo-src.png", png(240, 160));
  put("files/file-photo/var-photo.png", "PNG-display-bytes");
  put(`${LAUNCH}/p-clip/clip.mp4`, "MP4-bytes");
  put("files/file-cad/var-cad.step", readFileSync(join(FIX, "..", "shroud.step")));
  put("files/file-notes/var-notes.txt", "launch notes, chamber booked");
  return { dir, media, put };
}

if (process.argv[1] === import.meta.filename) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: tsx test/fixtures/flowform/backup.ts <out-dir>");
  const { dir, media } = makeBackup(out);
  console.log(`backup ${dir}\nmedia  ${media}`);
}

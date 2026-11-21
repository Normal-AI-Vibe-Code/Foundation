/**
 * Files: raw-body upload (the client streams the File as the request body),
 * content-addressed on disk under data/files, searchable, and archived —
 * never deleted (flowform-server's rule: "deleting a room archives its media
 * instead of deleting it").
 *
 * Text-bearing files are indexed: plain text, markdown, CSV, JSON, code, SVG,
 * and STEP/IGES CAD (both are ASCII — the product names, file description
 * and author in the header are what people search for) as they arrive.
 * Documents (PDF, Word, PowerPoint, Excel, OpenDocument) are found by name at
 * once and by what's inside them a moment later: filetext.ts reads them off
 * the request path. The same bytes are stored once (by sha256) whoever
 * uploads them, to whichever board.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { rename, writeFile, readFile, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, extname } from "node:path";
import type { ServerResponse } from "node:http";
import { config } from "./config.ts";
import { all, indexDoc, needsFileReindex, one, run } from "./db.ts";
import { readFileSync } from "node:fs";
import { HttpError, readBody, type Req } from "./http.ts";
import { backfillFileText, documentBody, isDocument, queueFileText, storedText } from "./filetext.ts";
import { canSeeBoard } from "./members.ts";
import type { UserInfo } from "@foundation/protocol";

export interface FileRow {
  id: string;
  board_id: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  uploaded_by: string | null;
  created_at: number;
  archived_at: number | null;
  about?: string | null;
}

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".rb", ".java", ".c", ".h", ".cpp", ".svg", ".log",
]);
const CAD_EXT = new Set([".step", ".stp", ".iges", ".igs"]);

export const CAD_FILE_EXT = [".step", ".stp", ".iges", ".igs", ".stl", ".obj", ".3mf", ".glb", ".gltf", ".f3d", ".sldprt", ".sldasm", ".x_t", ".dxf", ".dwg"];

export function isCad(name: string) {
  return CAD_FILE_EXT.includes(extname(name).toLowerCase());
}

function filePath(sha: string) {
  return join(config.dataDir, "files", sha);
}

// ---------- what a file may be served as ----------
//
// Files are served from the app's own origin, so a file that a browser would run (a page, a script, an SVG or
// any XML document, a stylesheet) would run as the app, with the person's cookie. So: a file is shown in place
// only if it is one of a fixed list of passive types; everything else is a download of opaque bytes. Every
// file answer also carries nosniff and a CSP sandbox, so even a passive type opened on its own can't script.

const OCTET = "application/octet-stream";

/** shown in place (img, video, audio, the browser's PDF viewer, plain text), and the 3D/CAD types the client reads with fetch */
const INLINE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm",
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/ogg", "audio/webm",
  "application/pdf",
  "text/plain",
  "model/stl", "model/x.stl-binary", "model/x.stl-ascii", "application/sla", "application/vnd.ms-pki.stl",
  "model/obj", "model/3mf", "model/gltf-binary", "model/gltf+json", "model/step", "model/step+zip", "model/iges", "application/step", "application/iges",
]);

/** never trusted as itself: a browser could run it as a page, a script or a stylesheet */
export function isActiveType(mime: string): boolean {
  const m = mime.toLowerCase();
  const [type = "", sub = ""] = m.split("/");
  if (type === "multipart" || type === "message") return true; // MHTML and friends render as pages
  if (sub === "html" || sub === "xhtml+xml" || sub === "xml" || sub.endsWith("+xml") || sub === "xsl" || sub === "xslt") return true;
  if (sub.includes("javascript") || sub.includes("ecmascript") || sub === "jscript" || sub === "livescript") return true;
  if (sub === "css") return true;
  if (sub === "x-shockwave-flash" || sub === "futuresplash") return true;
  return false;
}

/** documents and data we know, kept as they are (served as downloads; their names and the search index use them) */
const KNOWN_APPLICATION = new Set([
  "application/json", "application/zip", "application/gzip", "application/x-gzip", "application/x-tar", "application/x-7z-compressed", "application/x-zip-compressed",
  "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint", "application/rtf", "application/yaml", "application/x-yaml", "application/toml",
  "application/dxf", "application/acad", "application/x-step", "application/vnd.sqlite3",
]);

/**
 * The type a new file is stored under: what the uploader said, if it is a known type that isn't active;
 * anything else (unknown, malformed, or something a browser would run) is opaque bytes. The name is kept.
 */
export function storedMime(said: string | null | undefined): string {
  const m = String(said ?? "").split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m) || isActiveType(m)) return OCTET;
  const type = m.split("/")[0];
  if (INLINE_TYPES.has(m) || KNOWN_APPLICATION.has(m)) return m;
  if (type === "image" || type === "video" || type === "audio" || type === "model" || type === "text") return m;
  if (m.startsWith("application/vnd.openxmlformats-officedocument.") || m.startsWith("application/vnd.oasis.opendocument.") || m.startsWith("application/vnd.ms-")) return m;
  return OCTET;
}

/** the headers a file is answered with: its own type in place only for the passive list, else a download */
export function fileHeaders(mime: string, name: string): Record<string, string> {
  const m = String(mime ?? "").split(";")[0].trim().toLowerCase();
  const inline = INLINE_TYPES.has(m) && !isActiveType(m);
  return {
    "content-type": inline ? m : OCTET,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'",
  };
}

export async function uploadFile(req: Req, userId: string): Promise<FileRow> {
  const name = (req.query.get("name") || "untitled").slice(0, 240);
  const boardId = req.query.get("board");
  const mime = storedMime(req.headers["content-type"]);
  const body = await readBody(req);
  if (!body.length) throw new HttpError(400, "empty file");
  return storeFile(body, { name, mime, boardId, userId });
}

/** Large VM media goes straight to the archive, never Buffer.concat (ISOs exceed the regular upload limit). */
export async function uploadVmIso(req: Req, boardId: string, userId: string): Promise<FileRow> {
  const name = (req.query.get("name") ?? "").slice(0, 240);
  if (!/\.iso$/i.test(name)) throw new HttpError(400, "Choose an .iso image");
  const limit = 16 * 1024 ** 3;
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "ISO limit is 16 GB");
  const tmp = join(config.dataDir, "files", `${randomBytes(16).toString("hex")}.part`);
  const hash = createHash("sha256");
  let size = 0;
  // ISO 9660 and UDF both have their recognition sequence near sector 16.
  const head = Buffer.alloc(128 * 1024);
  const meter = new Transform({ transform(chunk: Buffer, _encoding, cb) {
    if (size < head.length) chunk.copy(head, size, 0, Math.min(chunk.length, head.length - size));
    size += chunk.length;
    if (size > limit) return cb(new HttpError(413, "ISO limit is 16 GB"));
    hash.update(chunk); cb(null, chunk);
  } });
  let published = false;
  try {
    await pipeline(req, meter, createWriteStream(tmp, { flags: "wx" }));
    if (size < 32774 || (!head.includes(Buffer.from("CD001"), 32768) && !head.includes(Buffer.from("NSR02"), 32768) && !head.includes(Buffer.from("NSR03"), 32768))) throw new HttpError(400, "This file does not look like an ISO/UDF image");
    const sha = hash.digest("hex");
    const same = one<FileRow>("select * from files where board_id = ? and sha256 = ? and archived_at is null", boardId, sha);
    if (same) return same;
    const dest = filePath(sha);
    if (!existsSync(dest)) { await rename(tmp, dest); published = true; }
    const id = `f_${randomBytes(8).toString("hex")}`;
    run("insert into files (id,board_id,name,mime,size,sha256,uploaded_by,created_at) values (?,?,?,?,?,?,?,?)", id, boardId, name, OCTET, size, sha, userId, Date.now());
    const row = one<FileRow>("select * from files where id = ?", id)!;
    indexDoc("file", id, boardId, name, `${name} OS installation ISO SHA-256 ${sha}`);
    return row;
  } finally {
    // Only unfinished staging bytes are removed. An archived upload is never deleted.
    if (!published) await unlink(tmp).catch(() => {});
  }
}

/**
 * Keep bytes in the archive as a file (content-addressed; the same bytes on
 * the same board are one file, not two). `about` is extra searchable text —
 * where an imported image came from (a Slack channel, its message).
 */
export async function storeFile(body: Buffer, f: { name: string; mime: string; boardId: string | null; userId: string; about?: string }): Promise<FileRow> {
  const { name, boardId, userId } = f;
  // every door into the archive (uploads, places, Slack, Flowform, characters) stores a type that is safe to serve
  const mime = storedMime(f.mime);
  const sha = createHash("sha256").update(body).digest("hex");
  // a chat upload ("chat", ChatForm's reserved board) is its uploader's until a message carries it: the same bytes from someone else are their own file
  const same =
    boardId === "chat"
      ? one<FileRow>("select * from files where sha256 = ? and board_id = 'chat' and uploaded_by is ? and archived_at is null", sha, userId)
      : one<FileRow>("select * from files where sha256 = ? and board_id is ? and archived_at is null", sha, boardId);
  if (same) return same;
  const dest = filePath(sha);
  if (!existsSync(dest)) {
    const tmp = `${dest}.${randomBytes(4).toString("hex")}.part`;
    await writeFile(tmp, body);
    await rename(tmp, dest);
  }
  const id = `f_${randomBytes(8).toString("hex")}`;
  run(
    "insert into files (id, board_id, name, mime, size, sha256, uploaded_by, created_at, about) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, boardId, name, mime, body.length, sha, userId, Date.now(), f.about ?? null,
  );
  const row = one<FileRow>("select * from files where id = ?", id)!;
  indexFile(row, body);
  // a document's inside, after this answers (indexed again when it's read)
  if (isDocument(name, mime)) void queueFileText(row);
  return row;
}

/**
 * The same file, kept for another board: a card carried to another board
 * takes its file with it, so the people on that board can open it (a file
 * answers to the board it belongs to). The bytes are shared (content-addressed);
 * the source board's file stays as it was. Returns the id to use there.
 */
export function shareFileWith(fileId: string, boardId: string, userId: string): string {
  const f = one<FileRow>("select * from files where id = ?", fileId);
  if (!f || !f.board_id || f.board_id === boardId) return fileId;
  const same = one<FileRow>("select * from files where sha256 = ? and board_id = ? and archived_at is null", f.sha256, boardId);
  if (same) return same.id;
  const id = `f_${randomBytes(8).toString("hex")}`;
  run(
    "insert into files (id, board_id, name, mime, size, sha256, uploaded_by, created_at, about) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, boardId, f.name, f.mime, f.size, f.sha256, userId, Date.now(), f.about ?? null,
  );
  const row = one<FileRow>("select * from files where id = ?", id)!;
  const dest = filePath(f.sha256);
  if (existsSync(dest)) indexFile(row, readFileSync(dest));
  return id;
}

/**
 * Store bytes that came from elsewhere (the flowform importer) under a known
 * id. Content-addressed like an upload; an id that already exists is left as
 * it is (its bytes never change), and an archived source stays archived.
 */
export async function storeImportedFile(f: {
  id: string;
  boardId: string | null;
  name: string;
  mime: string;
  body: Buffer;
  uploadedBy: string | null;
  createdAt: number;
  archivedAt: number | null;
}): Promise<{ created: boolean }> {
  if (one("select id from files where id = ?", f.id)) return { created: false };
  const sha = createHash("sha256").update(f.body).digest("hex");
  const dest = filePath(sha);
  if (!existsSync(dest)) {
    const tmp = `${dest}.${randomBytes(4).toString("hex")}.part`;
    await writeFile(tmp, f.body);
    await rename(tmp, dest);
  }
  run(
    "insert into files (id, board_id, name, mime, size, sha256, uploaded_by, created_at, archived_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    f.id, f.boardId, f.name.slice(0, 240), storedMime(f.mime), f.body.length, sha, f.uploadedBy, f.createdAt, f.archivedAt,
  );
  if (!f.archivedAt) {
    const row = one<FileRow>("select * from files where id = ?", f.id)!;
    indexFile(row, f.body);
    if (isDocument(row.name, row.mime)) void queueFileText(row);
  }
  return { created: true };
}

/** put a file into search: a document by its text once read (else its name), anything else as it is */
function indexFile(f: FileRow, body: Buffer) {
  const text = isDocument(f.name, f.mime) ? documentBody(f) : `${extractText(f.name, f.mime, body)}${f.about ? `\n${f.about}` : ""}`;
  indexDoc("file", f.id, f.board_id, f.name, text);
}

function extractText(name: string, mime: string, body: Buffer): string {
  const ext = extname(name).toLowerCase();
  if (CAD_EXT.has(ext)) return cadHeaderText(body.subarray(0, 64 * 1024).toString("latin1"));
  if (TEXT_EXT.has(ext) || mime.startsWith("text/") || mime === "application/json") {
    return body.subarray(0, 2 * 1024 * 1024).toString("utf8");
  }
  return `${name} ${mime}`;
}

/** STEP: FILE_DESCRIPTION / FILE_NAME / PRODUCT('name', ...) entries. IGES: the start section. */
export function cadHeaderText(head: string): string {
  const out: string[] = [];
  // statements end at ");" — values themselves may hold ";" (e.g. the '2;1' implementation level)
  for (const m of head.matchAll(/FILE_(?:NAME|DESCRIPTION)\s*\(([\s\S]*?)\);/g)) out.push(m[1]);
  for (const m of head.matchAll(/PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/g)) out.push(m[1], m[2]);
  if (!out.length) out.push(head.split("\n").filter((l) => /S\s*\d+\s*$/.test(l)).join(" "));
  return out.join(" ").replace(/\s+/g, " ").slice(0, 4000);
}

export function listFiles(boardId?: string | null) {
  // chat uploads are listed by the messages that carry them (chat.ts decides who sees those), never here
  if (boardId === "chat") return [];
  return boardId
    ? all<FileRow>("select * from files where board_id = ? and archived_at is null order by created_at desc limit 500", boardId)
    : all<FileRow>("select * from files where archived_at is null and board_id is not 'chat' order by created_at desc limit 500");
}

export function archiveFile(id: string) {
  run("update files set archived_at = ? where id = ? and archived_at is null", Date.now(), id);
}

/** a stored file's row and bytes, read now (small files: pictures), or null when there's no such file or its bytes are gone */
export function fileBytesSync(id: string): { row: FileRow; body: Buffer } | null {
  const row = one<FileRow>("select * from files where id = ?", id);
  if (!row) return null;
  try {
    return { row, body: readFileSync(filePath(row.sha256)) };
  } catch {
    return null;
  }
}

/** Stream a file with HTTP range support so video scrubs and big CAD files stream. */
export function serveFile(req: Req, res: ServerResponse, id: string) {
  const row = one<FileRow>("select * from files where id = ?", id);
  if (!row) throw new HttpError(404, "no such file");
  const path = filePath(row.sha256);
  const size = statSync(path).size;
  const headers: Record<string, string | number> = {
    ...fileHeaders(row.mime, row.name),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
  };
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  if (req.method === "HEAD") return res.end();
  createReadStream(path).pipe(res);
}

/** ChatForm's uploads live on the reserved board "chat", which is nobody's board: chat.ts says who may see one (its uploader, and readers of a message that carries it) */
let chatFileRule: ((userId: string, fileId: string) => boolean) | null = null;
export function setChatFileRule(fn: (userId: string, fileId: string) => boolean) {
  chatFileRule = fn;
}

/**
 * May this person (or the agent working for them) see this file: it answers to the board it belongs to, so
 * a file on a members-only board is that board's members' (a file on no board is everyone's). Board tools
 * and routes that take a file id ask this before they read, copy or show it.
 */
export function canSeeFile(userId: string, fileId: string): boolean {
  const row = one<{ board_id: string | null }>("select board_id from files where id = ?", fileId);
  if (!row) return false;
  if (!row.board_id) return true;
  if (row.board_id === "chat") return chatFileRule ? chatFileRule(userId, fileId) : false;
  const user = userId === "agent" ? { id: "agent", role: "member" } : one<{ id: string; role: string }>("select id, role from users where id = ?", userId);
  return Boolean(user && canSeeBoard(user as UserInfo, row.board_id));
}

/** the same, as a refusal: a file on a board this person can't see answers like a missing one */
export function requireFileVisible(userId: string, fileId: string) {
  if (!canSeeFile(userId, fileId)) throw new HttpError(404, "no such file");
}

export async function readFileText(id: string, max = 200_000): Promise<string> {
  const row = one<FileRow>("select * from files where id = ?", id);
  if (!row) throw new HttpError(404, "no such file");
  if (isDocument(row.name, row.mime)) {
    // read now if it hasn't been yet (to the front of the queue: someone is waiting)
    const text = storedText(row.sha256) ?? (await queueFileText(row, true));
    return (text || `${row.name}: no text could be read from this document (a scan, or protected)`).slice(0, max);
  }
  const buf = await readFile(filePath(row.sha256));
  return extractText(row.name, row.mime, buf).slice(0, max);
}

/**
 * At boot: after an index rebuild, put every live file back into search; and
 * read, in the background, any document whose inside hasn't been read yet.
 */
export function reindexFilesIfNeeded() {
  if (needsFileReindex) {
    for (const f of all<FileRow>("select * from files where archived_at is null")) {
      try {
        indexFile(f, isDocument(f.name, f.mime) ? Buffer.alloc(0) : readFileSync(filePath(f.sha256)));
      } catch {
        /* missing bytes: leave it out of search */
      }
    }
  }
  // a moment after boot, so the first requests don't wait behind it
  setTimeout(() => {
    const n = backfillFileText();
    if (n) console.log(`  file text          reading ${n} document${n === 1 ? "" : "s"} uploaded before it was searchable`);
  }, 1500).unref();
}

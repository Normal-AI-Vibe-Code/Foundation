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
import { createReadStream, existsSync, statSync } from "node:fs";
import { rename, writeFile, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ServerResponse } from "node:http";
import { config } from "./config.ts";
import { all, indexDoc, needsFileReindex, one, run } from "./db.ts";
import { readFileSync } from "node:fs";
import { HttpError, readBody, type Req } from "./http.ts";
import { backfillFileText, documentBody, isDocument, queueFileText, storedText } from "./filetext.ts";

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

export async function uploadFile(req: Req, userId: string): Promise<FileRow> {
  const name = (req.query.get("name") || "untitled").slice(0, 240);
  const boardId = req.query.get("board");
  const mime = (req.headers["content-type"] || "application/octet-stream").split(";")[0];
  const body = await readBody(req);
  if (!body.length) throw new HttpError(400, "empty file");
  return storeFile(body, { name, mime, boardId, userId });
}

/**
 * Keep bytes in the archive as a file (content-addressed; the same bytes on
 * the same board are one file, not two). `about` is extra searchable text —
 * where an imported image came from (a Slack channel, its message).
 */
export async function storeFile(body: Buffer, f: { name: string; mime: string; boardId: string | null; userId: string; about?: string }): Promise<FileRow> {
  const { name, mime, boardId, userId } = f;
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
    f.id, f.boardId, f.name.slice(0, 240), f.mime, f.body.length, sha, f.uploadedBy, f.createdAt, f.archivedAt,
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
    "content-type": row.mime,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
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
